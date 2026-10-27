// #88: матрица «убить до / после» для гейта, мерджа и деплоя — третья часть матрицы #86/#87.
//
// Эффекты здесь — те, после которых фазу уже не вернуть: прогон гейта на точном SHA,
// POST мерджа, подтверждение мерджа, чекпоинт `deployBlock` и переход к следующей фазе.
// Клетки гоняют НАСТОЯЩИЙ `runLoop` с НАСТОЯЩИМ `tryMergePhase`: подменены только
// примитивы форжа и чеки. Первый процесс убит в точке, следующий поднят со state «с диска»
// — с тем же барьером деплоя на старте, что у `preflight`, — и идёт до исхода.
//
// Форж асинхронный, как площадка: принятый мердж становится видим не сразу, а через
// `lag` чтений. Это и делает окно «после POST» опасным: рестарт, спросивший форж слишком
// рано, видит открытый PR и смерджил бы его второй раз.
//
// Исход клетки — одно из трёх: тот же исход, что без убийств; стоп «исход мерджа
// неизвестен», если на диске метка начатого мерджа; стоп барьера деплоя, если на диске
// барьер. Мерджа без прогона гейта на той же голове нет нигде, второго POST — тоже, и
// следующая фаза не начинается поверх недосмотренного деплоя.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import type { RalphConfig } from '../core/orchestrator.ts';
import type { RalphState } from '../core/state-lock.ts';
import { Killed, world } from './crash-world.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralph.runLoop as Runtime['runLoop'];
const tryMergePhase = ralph.tryMergePhase as Runtime['tryMergePhase'];
const stopOnDeployBlock = ralph.stopOnDeployBlock as Runtime['stopOnDeployBlock'];

const PR = 777;
const PHASES = [
    { milestone: 'M1', branch: 'feature/m1' },
    { milestone: 'M2', branch: 'feature/m2' },
];
const BASE_CFG = {
    model: 'claude-coder',
    prompt: 'сделай {milestone} в ветке {branch}',
    authorAllowlist: ['owner'],
    phases: PHASES,
    gate: { checks: [['test', 'npm run test']] },
} as RalphConfig;
// Состав чеков гейт читает из фабричного конфига, а не из аргумента `runLoop`.
(ralph.setConfigForTests as Runtime['setConfigForTests'])(BASE_CFG);
const sha = (n: number): string => n.toString(16).padStart(40, '0');

type TScenario = {
    title: string;
    cfg: Partial<RalphConfig>;
    /** Через сколько чтений после POST форж покажет мердж. */
    lag: number;
    deploy: 'none' | 'green' | 'red';
    accept: RegExp;
    /** Эффекты, которые сценарий обязан пройти, — иначе клеток вокруг них нет. */
    effects: RegExp[];
    /** Ответ форжа на POST мерджа вместо успеха: операция при этом не легла. */
    mergeFailure?: string;
};

const MERGED = /^✅ Ralph: фаза "M1" смерджена в main — готова к релизу\.$/;
const IN_FLIGHT = /^⛔ Ralph: фаза "M1" — мердж PR #777 начат прерванным процессом/;
const DEPLOY_BARRIER =
    /^⛔ Ralph: старт заблокирован — (пост-мердж проверка деплоя|деплой) фазы "M1"/;

const SCENARIOS: Record<string, TScenario> = {
    playground: {
        title: 'гейт → мердж → подтверждение → следующая фаза',
        cfg: {},
        lag: 1,
        deploy: 'none',
        accept: MERGED,
        effects: [
            /^checks$/,
            /^save:.*mergeInFlight=set/,
            /^merge$/,
            /^read:merged-after-post$/,
            /^push:merged$/,
            /^save:.*milestone="M2"/,
        ],
    },
    'prod-deploy-green': {
        title: 'prod: мердж → барьер деплоя pending → зелёный деплой → следующая фаза',
        cfg: { profileName: 'prod', haltBeforeDeploy: false },
        lag: 1,
        deploy: 'green',
        accept: MERGED,
        effects: [
            /^merge$/,
            /^push:merged$/,
            /^save:.*deployBlock=pending/,
            /^wait-deploy$/,
            /^save:deployBlock=null$/,
        ],
    },
    'prod-deploy-red': {
        title: 'prod: мердж → красный деплой → барьер и стоп',
        cfg: { profileName: 'prod', haltBeforeDeploy: false },
        lag: 1,
        deploy: 'red',
        accept: /^⛔ Ralph: фаза "M1" смерджена, но деплой красный/,
        effects: [
            /^merge$/,
            /^save:.*deployBlock=pending/,
            /^wait-deploy$/,
            /^save:deployBlock=red$/,
        ],
    },
    'slow-forge': {
        title: 'форж принял мердж, но не подтвердил → стоп без повтора',
        cfg: {},
        lag: 99,
        deploy: 'none',
        accept: /^⛔ Ralph: фаза "M1" — мердж PR #777 не подтверждён/,
        effects: [/^save:.*mergeInFlight=set/, /^merge$/, /^read:merged-after-post$/],
    },
};

const freshState = (): RalphState => ({
    schemaVersion: 1,
    count: 0,
    milestone: 'M1',
    // Сдача уже прошла: предмет матрицы — гейт и то, что после него.
    submitted: true,
    noProgress: 0,
    gateHeals: 0,
    blockedHeals: 0,
    reviewModelFloor: null,
    lastReviewModel: null,
    reReviewPending: false,
    reviewOfFixes: null,
    deployBlock: null,
    forgeHealedRunId: null,
});

type TUniverse = {
    disk: RalphState;
    forge: {
        head: string;
        posts: number;
        posted: boolean;
        readsSincePost: number;
        merged: boolean;
    };
    chat: string[];
    trace: string[];
    /** POST мерджа: голова, которую он привязал, и прогнан ли гейт на ней в этом процессе. */
    mergeAudit: Array<{ sha: string | null; checkedHere: boolean; head: string }>;
    deployGreen: boolean;
    /** Каждое касание фазы M2: был ли к этому моменту подтверждён деплой M1. */
    m2Touched: boolean[];
};

const universe = (): TUniverse => ({
    disk: freshState(),
    forge: { head: sha(1), posts: 0, posted: false, readsSincePost: 0, merged: false },
    chat: [],
    trace: [],
    mergeAudit: [],
    deployGreen: false,
    m2Touched: [],
});

const clone = (s: RalphState): RalphState => JSON.parse(JSON.stringify(s)) as RalphState;

function saveName(before: RalphState, after: RalphState): string {
    const b = before;
    const a = after;
    const changed: string[] = [];
    if (before.milestone !== after.milestone) {
        changed.push(`milestone=${JSON.stringify(after.milestone)}`);
    }
    if (JSON.stringify(b.mergeInFlight ?? null) !== JSON.stringify(a.mergeInFlight ?? null)) {
        changed.push(`mergeInFlight=${a.mergeInFlight ? 'set' : 'null'}`);
    }
    if (JSON.stringify(before.deployBlock) !== JSON.stringify(after.deployBlock)) {
        const db = after.deployBlock as { status?: string } | null;
        changed.push(`deployBlock=${!db ? 'null' : db.status === 'pending' ? 'pending' : 'red'}`);
    }
    return `save:${changed.join(',') || '—'}`;
}

/**
 * Один процесс раннера: барьер деплоя на старте (как в `preflight`) и `runLoop`.
 * `killOn` — точка убийства; без неё процесс идёт до исхода.
 */
function runProcess(
    u: TUniverse,
    sc: TScenario,
    killOn: (op: string) => 'before' | 'after' | null = () => null,
    { once = false }: { once?: boolean } = {},
): { killed: boolean } {
    const w = world();
    const g = <A extends unknown[], R>(op: (...a: A) => string, act: (...a: A) => R) =>
        w.guard(
            (...a: A) => {
                const name = op(...a);
                u.trace.push(name);
                return name;
            },
            act,
            killOn,
        );
    const read =
        <A extends unknown[], R>(act: (...a: A) => R) =>
        (...a: A): R => {
            w.alive();
            return act(...a);
        };
    const { forge } = u;
    const state = clone(u.disk);
    const cfg = { ...BASE_CFG, ...sc.cfg } as RalphConfig;
    const saveStateFn = g(
        (s: RalphState) => saveName(u.disk, s),
        (s: RalphState) => {
            u.disk = clone(s);
        },
    );
    const chat = w.chat(u.chat);
    const pushEventFn = g(
        (msg: string) => (MERGED.test(msg) ? 'push:merged' : 'push'),
        (msg: string) => chat(msg),
    );
    // Голова, которую прогнал гейт ЭТОГО процесса: мертвец свою проверку не передаёт.
    let verified: string | null = null;
    const checkedHere = new Set<string>();
    let idxCalls = 0;
    let clock = 0;

    try {
        // Барьер деплоя на старте процесса — та же функция, что зовёт `preflight`.
        try {
            stopOnDeployBlock({
                state,
                deployResolved: false,
                saveStateFn,
                logFn: () => {},
                pushEventFn,
                failFn: (msg: string): never => {
                    throw new StartRefused(msg);
                },
            });
        } catch (e) {
            if (e instanceof StartRefused) return { killed: w.dead };
            throw e;
        }
        runLoop(
            cfg,
            { state, maxIterations: 10, maxTurns: 200 },
            {
                once,
                dry: false,
                logFn: () => {},
                shFn: read(() => ''),
                runArgvFn: read(() => ''),
                saveStateFn,
                openIssuesFn: read((milestone: string) => {
                    if (milestone === 'M2') u.m2Touched.push(u.deployGreen);
                    return [];
                }),
                allOpenIssuesFn: read(() => []),
                hasAnyIssuesFn: read(() => true),
                findOpenPrFn: read((branch: string) =>
                    branch === PHASES[0].branch && !forge.merged
                        ? { number: PR, labels: [] }
                        : null,
                ),
                phaseIndexOfFn: (s: RalphState) => {
                    if (idxCalls++ > 40) return 99;
                    const i = PHASES.findIndex((p) => p.milestone === s.milestone);
                    return i < 0 ? 99 : i;
                },
                // M2 смерджена человеком: фаза после M1 нужна ровно затем, чтобы увидеть,
                // начнётся ли она поверх недосмотренного деплоя.
                phaseMergedFn: g(
                    (phase: { branch: string }) =>
                        phase.branch !== PHASES[0].branch
                            ? 'read:merged-other'
                            : forge.posted && !forge.merged
                              ? 'read:merged-after-post'
                              : 'read:merged',
                    (phase: { branch: string }) => {
                        if (phase.branch !== PHASES[0].branch) return true;
                        if (forge.posted && !forge.merged) {
                            forge.readsSincePost += 1;
                            if (forge.readsSincePost >= sc.lag) forge.merged = true;
                        }
                        return forge.merged;
                    },
                ),
                mergedPhasePrFn: read(() => PR),
                // #139: доменный PR фазы — сверка защищаемых путей проходит, мердж идёт.
                prChangedFilesFn: read(() => ['src/feature.ts']),
                advancePhaseFn: (st: RalphState, idx: number) => {
                    st.milestone = PHASES[idx + 1]?.milestone ?? null;
                    st.count = 0;
                    st.submitted = false;
                    saveStateFn(st);
                },
                tryMergePhaseFn: (phase, opts) =>
                    tryMergePhase(phase, {
                        ...opts,
                        shFn: read(() => ''),
                        runArgvFn: read(() => ''),
                        logFn: () => {},
                        ensureCleanFn: read(() => true),
                        checksGreenFn: g(
                            () => 'checks',
                            () => {
                                verified = forge.head;
                                checkedHere.add(forge.head);
                                return true;
                            },
                        ),
                        getVerifiedHeadFn: () => verified,
                        getLastRedCheckFn: () => null,
                        getLastToolFailureFn: () => null,
                        getToolFailureSkipsFn: () => [],
                        getLastMainSyncStopFn: () => null,
                        getLastHeadDivergenceFn: () => null,
                        mergePrFn: g(
                            (_n: number, _head?: string | null) => 'merge',
                            (_n: number, head?: string | null) => {
                                if (sc.mergeFailure) throw new Error(sc.mergeFailure);
                                u.mergeAudit.push({
                                    sha: head ?? null,
                                    checkedHere: head != null && checkedHere.has(head),
                                    head: forge.head,
                                });
                                forge.posts += 1;
                                forge.posted = true;
                                forge.readsSincePost = 0;
                            },
                        ),
                        parkFn: () => {},
                        deleteLocalBranchRefFn: () => {},
                        sleepFn: () => {},
                        mergeConfirmDelayMs: 0,
                        mergeRetryMaxMs: 1_000,
                        // Часы идут: предел повторов транзиента иначе не наступил бы.
                        nowFn: () => (clock += 60_000),
                        gatePolicy: { externalCi: 'disabled', onToolFailure: 'fail-closed' },
                    }),
                closeMilestoneByTitleFn: read(() => {}),
                syncProjectBoardFn: read(() => {}),
                recordReviewFindingsFn: read(() => {}),
                ensureCleanFn: read(() => true),
                commitLeftoversFn: read(() => true),
                ensurePhaseBranchFn: read((branch: string) => ({
                    kind: 'switched' as const,
                    branch,
                    sha: 'a'.repeat(40),
                })),
                checkOnPhaseBranchFn: read(() => ({ ok: true, sha: 'a'.repeat(40) })),
                branchPushedFn: read(() => true),
                pushEventFn,
                deployEnabledFn: () => sc.deploy !== 'none',
                deployPhaseFn: () => {},
                mergedShaOfFn: read(() => forge.head),
                waitForDeployRunFn: g(
                    () => 'wait-deploy',
                    () => ({
                        status: 'completed' as const,
                        conclusion: sc.deploy === 'red' ? 'failure' : 'success',
                        sha: forge.head,
                        url: null,
                        runId: 1,
                    }),
                ),
                checkProdHealthFn: read(() => {
                    u.deployGreen = true;
                    return { ok: true, status: 200, url: 'https://example.com' };
                }),
                ensureMonitorAliveFn: () => null,
                sleepFn: () => {},
            },
        );
    } catch (e) {
        if (!(e instanceof Killed)) throw e;
    }
    return { killed: w.dead };
}

class StartRefused extends Error {}

/** Эффекты, вокруг которых режем. Чтение после POST — это и есть окно подтверждения. */
const isEffect = (op: string): boolean =>
    op === 'checks' ||
    op === 'merge' ||
    op === 'push:merged' ||
    op === 'wait-deploy' ||
    op === 'read:merged-after-post' ||
    (op.startsWith('save:') && op !== 'save:—');

describe.each(Object.entries(SCENARIOS))('#88 матрица гейта и мерджа: %s', (_key, sc) => {
    const reference = universe();
    runProcess(reference, sc);
    const cells = reference.trace.flatMap((op, i) =>
        isEffect(op)
            ? (['before', 'after'] as const).map((when) => ({ op, i, when, step: i + 1 }))
            : [],
    );

    it(`без убийств: ${sc.title}`, () => {
        expect(reference.forge.posts).toBe(1);
        expect(reference.chat.at(-1)).toMatch(sc.accept);
        for (const re of sc.effects) {
            expect(
                reference.trace.some((op) => re.test(op)),
                `${String(re)} в ${reference.trace.join(' ')}`,
            ).toBe(true);
        }
        if (sc.deploy !== 'none') for (const ok of reference.m2Touched) expect(ok).toBe(true);
    });

    it.each(cells)('убит $when $op (шаг трассы $step)', ({ i, when }) => {
        const u = universe();
        let n = -1;
        const first = runProcess(u, sc, () => {
            n += 1;
            return n === i ? when : null;
        });
        expect(first.killed).toBe(true);
        const fromDead = u.chat.length;
        // Между смертью и рестартом в ветку допушили: рестарт обязан прогнать гейт на НОВОЙ
        // голове, а не смерджить её по старому прогону.
        if (!u.forge.posted) u.forge.head = sha(2);
        const atRestart = clone(u.disk);

        const second = runProcess(u, sc);
        expect(second.killed).toBe(false);

        // Неизвестный исход мерджа не повторяется вслепую: POST один на всю историю.
        expect(u.forge.posts).toBeLessThanOrEqual(1);
        // Мердж — только головы, прогнанной гейтом в том же процессе, и только текущей.
        for (const a of u.mergeAudit) {
            expect(a.checkedHere).toBe(true);
            expect(a.sha).toBe(a.head);
        }
        // Следующая фаза не начинается поверх недосмотренного деплоя.
        if (sc.deploy !== 'none') for (const ok of u.m2Touched) expect(ok).toBe(true);
        // Влитая фаза не проходит молча: строка о мердже в чате есть.
        if (u.forge.merged) expect(u.chat.some((m) => MERGED.test(m))).toBe(true);

        // Приёмка — что придёт в чат. Молчания нет, и стоп обязан быть обоснован диском.
        // Рестарту позволено промолчать только тогда, когда исход уже сказан до смерти.
        if (!u.chat.slice(0, fromDead).some((m) => sc.accept.test(m))) {
            expect(u.chat.length).toBeGreaterThan(fromDead);
        }
        const last = String(u.chat.at(-1));
        if (sc.accept.test(last)) return;
        if (IN_FLIGHT.test(last)) {
            expect(atRestart.mergeInFlight).toBeTruthy();
            // Исход неизвестен — значит, и успехом не назван.
            expect(u.chat.slice(fromDead).some((m) => MERGED.test(m))).toBe(false);
            return;
        }
        if (DEPLOY_BARRIER.test(last)) {
            expect(atRestart.deployBlock).toBeTruthy();
            return;
        }
        throw new Error(`неожиданная последняя строка чата: ${last}`);
    });
});

describe('#88 неподтверждённый мердж: рестарт без убийства', () => {
    it('merge-unconfirmed → рестарт не повторяет POST, а останавливается с вопросом', () => {
        const u = universe();
        runProcess(u, SCENARIOS['slow-forge']);
        expect(u.chat.at(-1)).toMatch(SCENARIOS['slow-forge'].accept);
        // Совет стопа — выполним: выход из «не влит» назван флагом.
        expect(u.chat.at(-1)).toMatch(/--resubmit/);
        runProcess(u, SCENARIOS['slow-forge']);
        expect(u.forge.posts).toBe(1);
        expect(u.chat.at(-1)).toMatch(IN_FLIGHT);
        expect(u.chat.at(-1)).toMatch(/--resubmit/);
    });

    it('форж дотянул мердж к рестарту → фаза засчитана смердженной, строка о мердже в чате', () => {
        const u = universe();
        runProcess(u, SCENARIOS['slow-forge']);
        u.forge.merged = true;
        runProcess(u, SCENARIOS['slow-forge']);
        expect(u.forge.posts).toBe(1);
        expect(u.chat.at(-1)).toMatch(MERGED);
        expect(u.disk.mergeInFlight ?? null).toBe(null);
    });

    // Отказ POST — не всегда «мерджа нет». Отказ по существу с первой попытки определён:
    // метка снимается, и рестарт сдаёт фазу заново. Транзиент за пределом повторов — нет:
    // любая из попыток могла лечь в очередь с потерянным ответом.
    const failing = (mergeFailure: string): TScenario => ({
        ...SCENARIOS.playground,
        mergeFailure,
    });
    const marker = (u: TUniverse): RalphState['mergeInFlight'] => u.disk.mergeInFlight ?? null;

    it('отказ форжа по существу → метка снята, рестарт снова идёт через гейт', () => {
        const u = universe();
        const sc = failing('HTTP 405: Pull request is not mergeable');
        runProcess(u, sc);
        expect(marker(u)).toBe(null);
        const checks = u.trace.filter((op) => op === 'checks').length;
        runProcess(u, sc);
        expect(u.trace.filter((op) => op === 'checks').length).toBe(checks + 1);
        expect(u.chat.some((m) => IN_FLIGHT.test(m))).toBe(false);
    });

    it('транзиент за пределом повторов → метка остаётся, рестарт не мерджит вслепую', () => {
        const u = universe();
        const sc = failing('HTTP 502 Bad Gateway');
        runProcess(u, sc);
        expect(marker(u)).not.toBe(null);
        const merges = u.trace.filter((op) => op === 'merge').length;
        runProcess(u, sc);
        expect(u.trace.filter((op) => op === 'merge').length).toBe(merges);
        expect(u.chat.at(-1)).toMatch(IN_FLIGHT);
    });

    it('--once: рестарт, доведший мердж прерванного процесса, встаёт, а не берёт фазу дальше', () => {
        const u = universe();
        runProcess(u, SCENARIOS['slow-forge']);
        u.forge.merged = true;
        const from = u.trace.length;
        runProcess(u, SCENARIOS['slow-forge'], () => null, { once: true });
        expect(u.chat.at(-1)).toMatch(MERGED);
        expect(u.disk.milestone).toBe('M2');
        // Следующая фаза даже не опрошена: HITL-прогон кончился на пост-мердж шагах.
        expect(u.trace.slice(from)).not.toContain('read:merged-other');
    });

    it('метка чужой фазы → снята вслух, гейт идёт штатно, стопа merge-unknown нет', () => {
        // Ручная правка state или смена списка фаз: метка о мердже PR прошлой фазы
        // ничего не говорит о текущей, и вопрос человеку был бы не про тот PR.
        const u = universe();
        u.disk.mergeInFlight = { milestone: 'прошлая-фаза', pr: 7, sha: sha(9) };
        const sc = SCENARIOS.playground;
        runProcess(u, sc);
        expect(u.chat.some((m) => IN_FLIGHT.test(m))).toBe(false);
        expect(u.forge.posts).toBe(1);
        expect(u.chat.at(-1)).toMatch(sc.accept);
        expect(u.trace.some((op) => /mergeInFlight=null/.test(op))).toBe(true);
    });
});

// Применение, а не работоспособность (`tests/CLAUDE.md`): мир выше подменяет переход своим,
// поэтому то, что боевой `advancePhase` снимает метку той же записью, видно только по тексту.
describe('#88 переход фазы снимает метку начатого мерджа', () => {
    it('advancePhase обнуляет mergeInFlight до своей записи state', () => {
        const source = fs.readFileSync(
            path.join(import.meta.dirname, '..', 'core', 'orchestrator.ts'),
            'utf8',
        );
        const fn = source.slice(source.indexOf('function advancePhase(st: RalphState'));
        const body = fn.slice(0, fn.indexOf('\n    }\n'));
        const clear = body.indexOf('st.mergeInFlight = null;');
        expect(clear).toBeGreaterThan(-1);
        expect(body.indexOf('saveState(st);')).toBeGreaterThan(clear);
    });
});

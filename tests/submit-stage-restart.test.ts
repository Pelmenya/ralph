// #93: матрица «убит посреди этапа» для цикла сдачи фазы.
//
// Вторая половина матрицы #92. Каждая клетка — два процесса раннера на одном «диске».
// Первый убит посреди этапа сдачи (смерть МИРА, `crash-world.ts`). Диск здесь — не копия
// объекта state, а ТЕКСТ файла в той форме, которую пишет боевой `saveState`
// (`stateToDisk`), и второй процесс поднимается боевой проверкой (`inspectState`): так
// клетка проверяет и то, что журнал сдачи переживает запись и чтение, а не только память.
//
// Приёмка клетки: второй процесс продолжает с брошенного этапа — этапы с исходом не
// повторяются (ревью, правки, проходы ревью правок и арбитр считаются поштучно за всю
// историю), PR один, мердж один, и исход сказан в чате.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import type { RalphConfig } from '../core/orchestrator.ts';
import { inspectState, type RalphState } from '../core/state-lock.ts';
import {
    stateToDisk,
    summarizeSubmit,
    SUBMIT_STAGE_TITLES,
    SUBMIT_STAGES,
    type TSubmitStage,
} from '../core/submit-journal.ts';
import { Killed, world } from './crash-world.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralph.runLoop as Runtime['runLoop'];
const stopOnDeployBlock = ralph.stopOnDeployBlock as Runtime['stopOnDeployBlock'];

const REVIEW_MODEL = 'claude-opus-4-8';
const PR = 777;
const BRANCH = 'feature/m1';

type TSession = 'review' | 'plan' | 'fix' | 'fix-review' | 'arbiter' | 're-review' | 'heal';
function sessionOf(prompt: string): TSession {
    if (prompt.includes('Ты независимый арбитр')) return 'arbiter';
    if (prompt.includes('отревьюй ИМЕННО ЭТИ ПРАВКИ')) return 'fix-review';
    if (prompt.includes('Ранее ревью пометило его меткой blocked')) return 're-review';
    if (prompt.includes('проведи детальное code review')) return 'review';
    if (prompt.includes('Ты планировщик правок')) return 'plan';
    if (prompt.includes('Разбери замечания code review')) return 'fix';
    return 'heal';
}

type Finding = { comment: string; anchor?: { path: string; line: number } };
const SUMMARY: Finding = { comment: '⚪ [nit] сводка прохода: блокирующего нет' };
const BLOCKER: Finding = {
    comment: '🔴 [blocker] отказ теряется в catch',
    anchor: { path: 'src/a.ts', line: 42 },
};
// Сдача, проходящая ВСЕ этапы: ревью и ревью правок находят блокер, потолок (1) исчерпан —
// арбитр, он блокера не воспроизводит — гейт, мердж, деплой.
const PASSES: Partial<Record<TSession, Finding[]>> = {
    review: [BLOCKER, SUMMARY],
    'fix-review': [BLOCKER, SUMMARY],
    arbiter: [SUMMARY],
};

const cfg = (): RalphConfig =>
    ({
        model: 'claude-coder',
        prompt: 'сделай {milestone} в ветке {branch}',
        authorAllowlist: ['owner'],
        blockedHealAttempts: 2,
        fixReviewAttempts: 1,
        profileName: 'prod',
        haltBeforeDeploy: false,
        phases: [{ milestone: 'M1', branch: BRANCH }],
        review: {
            default: REVIEW_MODEL,
            escalated: REVIEW_MODEL,
            fallback: REVIEW_MODEL,
            arbiter: 'claude-fable-5',
            maxTurns: 80,
        },
        gate: { checks: [['test', 'npm run test']] },
    }) as RalphConfig;

const MERGED = /^✅ Ralph: фаза "M1" смерджена в main — готова к релизу\.$/;
const PENDING_BARRIER = /^⛔ Ralph: старт заблокирован — пост-мердж проверка деплоя фазы "M1"/;

type TUniverse = {
    /** Текст файла state — ровно то, что пишет боевой saveState. */
    disk: string;
    forge: { prs: number; merged: number; posts: number };
    chat: string[];
    sessions: Partial<Record<TSession, number>>;
    deployWaits: number;
    /** Чья сессия стояла за каждым применением намерений (`null` — без сессии). */
    applies: (TSession | null)[];
};

const fresh = (): RalphState =>
    ({
        schemaVersion: 2,
        count: 0,
        milestone: 'M1',
        noProgress: 0,
        gateHeals: 0,
        blockedHeals: 0,
        reviewModelFloor: null,
        lastReviewModel: null,
        reReviewPending: false,
        reviewOfFixes: null,
        forgeHealedRunId: null,
        submitStages: [],
    }) as unknown as RalphState;

const universe = (): TUniverse => ({
    disk: JSON.stringify(fresh()),
    forge: { prs: 0, merged: 0, posts: 0 },
    chat: [],
    sessions: {},
    deployWaits: 0,
    applies: [],
});

/** Чтение диска боевой проверкой: не прошедший её state — провал клетки, а не дефолт. */
function load(u: TUniverse): RalphState {
    const r = inspectState(u.disk);
    if (r.status !== 'ok') throw new Error(`state не прочитан: ${JSON.stringify(r)}`);
    return r.state;
}

class StartRefused extends Error {}

/** Один процесс раннера: барьер деплоя на старте (как в preflight) и `runLoop`. */
function runProcess(
    u: TUniverse,
    killIn?: TSubmitStage,
    // Голова ветки этого процесса и журнал баз, от которых спрашивали дифф: клетка
    // «правки убиты после пуша» видит, от какой базы считает ревью правок рестарт.
    opts: { head?: string; bases?: (string | undefined)[] } = {},
): { killed: boolean; logs: string[] } {
    const w = world();
    const logs: string[] = [];
    const killIf = (stage: TSubmitStage): void => {
        w.alive();
        if (killIn === stage) w.kill();
    };
    const read =
        <A extends unknown[], R>(act: (...a: A) => R) =>
        (...a: A): R => {
            w.alive();
            return act(...a);
        };
    const { forge } = u;
    const state = load(u);
    const saveStateFn = (s: RalphState): void => {
        w.alive();
        u.disk = JSON.stringify(stateToDisk(s));
    };
    let lastSession: TSession | null = null;
    let idxCalls = 0;
    const pr = () => (forge.prs > 0 && forge.merged === 0 ? { number: PR, labels: [] } : null);
    try {
        try {
            stopOnDeployBlock({
                state,
                deployResolved: false,
                saveStateFn,
                logFn: () => {},
                pushEventFn: w.chat(u.chat),
                failFn: (msg: string): never => {
                    throw new StartRefused(msg);
                },
            });
        } catch (e) {
            if (e instanceof StartRefused) return { killed: false, logs };
            throw e;
        }
        runLoop(
            cfg(),
            { state, maxIterations: 10, maxTurns: 200 },
            {
                once: false,
                dry: false,
                logFn: (m: string) => logs.push(m),
                shFn: read(() => ''),
                runArgvFn: read(() => ''),
                saveStateFn,
                openIssuesFn: read(() => []),
                allOpenIssuesFn: read(() => []),
                hasAnyIssuesFn: read(() => true),
                findOpenPrFn: read(pr),
                createPrFn: read(() => {
                    forge.prs += 1;
                    killIf('pr');
                    return PR;
                }),
                phasePrBodyFn: () => 'тело PR',
                prCommentsFn: read(() => []),
                getIssueFn: read((n: number) => ({ number: n, title: 'задача', body: 'тело' })),
                phaseIndexOfFn: (s: RalphState) =>
                    s.milestone === null || idxCalls++ > 40 ? 99 : 0,
                pickModelFn: () => 'claude-coder',
                pickRuntimeFn: () => 'claude',
                pickRouteFn: () => ({ provider: 'claude', model: 'claude-coder' }),
                pickReviewModelFn: () => REVIEW_MODEL,
                phaseDiffLinesFn: read(() => 10),
                phaseDiffFilesFn: read((_branch: string, o?: { base?: string }) => {
                    opts.bases?.push(o?.base);
                    return ['src/a.ts'];
                }),
                reviewDiffContextFn: read(() => ''),
                branchHeadShaFn: read(() => opts.head ?? 'b'.repeat(40)),
                runClaudeFn: read(
                    (prompt: string, _opts: unknown, sessionDeps?: Record<string, unknown>) => {
                        const kind = sessionOf(prompt);
                        lastSession = kind;
                        u.sessions[kind] = (u.sessions[kind] ?? 0) + 1;
                        if (kind === 'review') killIf('review');
                        if (kind === 'plan') {
                            killIf('plan');
                            const output = [
                                '<<<RALPH-FIX-PLAN>>>',
                                JSON.stringify({
                                    decision: 'Сохранить единый порядок разбора',
                                    rejected: [],
                                    steps: [
                                        {
                                            do: 'Проверить правки гейтом',
                                            check: 'npm run test',
                                            expect: 'GREEN',
                                        },
                                    ],
                                }),
                                '<<<END-RALPH-FIX-PLAN>>>',
                            ].join('\n');
                            (
                                sessionDeps?.onOutput as
                                    ((text: string, end: string) => void) | undefined
                            )?.(output, 'completed');
                        }
                        if (kind === 'fix') killIf('fixes');
                        if (kind === 'fix-review') killIf('fix-review');
                        if (kind === 'arbiter') killIf('arbiter');
                        return 0;
                    },
                ),
                applySessionRequestsFn: read(() => {
                    u.applies.push(lastSession);
                    const findings = (lastSession && PASSES[lastSession]) ?? [];
                    lastSession = null;
                    return {
                        applied: findings.length,
                        failed: false,
                        closedIssues: [],
                        prFindings: findings,
                        prBlocked: false,
                    };
                }),
                addBlockedLabelFn: read(() => {}),
                removeBlockedLabelFn: read(() => {}),
                prHasBlockedLabelFn: read(() => false),
                ensureCleanFn: read(() => true),
                commitLeftoversFn: read(() => true),
                pushSessionCommitsFn: read(() => ({ kind: 'in-sync' as const })),
                ensurePhaseBranchFn: read((branch: string) => ({
                    kind: 'switched' as const,
                    branch,
                    sha: 'a'.repeat(40),
                })),
                checkOnPhaseBranchFn: read(() => ({ ok: true, sha: 'a'.repeat(40) })),
                branchPushedFn: read(() => true),
                phaseMergedFn: read(() => forge.merged > 0),
                mergedPhasePrFn: read(() => (forge.merged > 0 ? PR : null)),
                advancePhaseFn: (st: RalphState) => {
                    st.milestone = null;
                    st.count = 0;
                    st.submitted = false;
                    st.reviewOfFixes = null;
                    st.mergeInFlight = null;
                    saveStateFn(st);
                },
                // Гейт — его контракт с петлёй: метка начатого мерджа до POST, POST, исход.
                tryMergePhaseFn: (_phase, opts) => {
                    killIf('gate');
                    opts?.onMergeStartFn?.(PR, 'b'.repeat(40));
                    forge.posts += 1;
                    forge.merged += 1;
                    killIf('merge');
                    return 'merged' as const;
                },
                closeMilestoneByTitleFn: read(() => {}),
                syncProjectBoardFn: read(() => {}),
                recordReviewFindingsFn: read(() => {}),
                recordFixReviewFindingsFn: read(() => {}),
                createIssueFn: read(() => 1),
                closeIssueFn: read(() => {}),
                commentOnIssueFn: read(() => {}),
                getLastRedCheck: () => null,
                getLastGatePr: () => PR,
                pushEventFn: w.chat(u.chat),
                deployEnabledFn: () => true,
                deployPhaseFn: () => {},
                mergedShaOfFn: read(() => 'b'.repeat(40)),
                waitForDeployRunFn: read(() => {
                    u.deployWaits += 1;
                    killIf('deploy');
                    return {
                        status: 'completed' as const,
                        conclusion: 'success',
                        sha: 'b'.repeat(40),
                        url: null,
                        runId: 1,
                    };
                }),
                checkProdHealthFn: read(() => ({
                    ok: true,
                    status: 200,
                    url: 'https://example.com',
                })),
                ensureMonitorAliveFn: () => null,
                sleepFn: () => {},
            },
        );
    } catch (e) {
        if (!(e instanceof Killed)) throw e;
    }
    return { killed: w.dead, logs };
}

/** Сколько раз за историю шла сессия этапа, если её этап убит (второй раз — рестарт). */
const SESSION_OF: Partial<Record<TSubmitStage, TSession>> = {
    review: 'review',
    plan: 'plan',
    fixes: 'fix',
    'fix-review': 'fix-review',
    arbiter: 'arbiter',
};

describe('#93 сдача без убийств проходит все этапы', () => {
    it('ревью → план → правки → ревью правок → арбитр → гейт → мердж → деплой, журнал снят', () => {
        const u = universe();
        const p = runProcess(u);
        expect(p.killed).toBe(false);
        expect(u.sessions).toMatchObject({
            review: 1,
            plan: 1,
            fix: 1,
            'fix-review': 1,
            arbiter: 1,
        });
        expect(u.forge).toEqual({ prs: 1, merged: 1, posts: 1 });
        expect(u.chat.at(-1)).toMatch(MERGED);
        // Доведённая попытка снимается: на диске ни этапов, ни барьера.
        const st = load(u);
        expect(st.submitStages).toEqual([]);
        expect(st.deployBlock).toBeNull();
    });
});

const ORCHESTRATED_STAGES = SUBMIT_STAGES;

describe.each(ORCHESTRATED_STAGES.map((s) => [s]))('#93 убит посреди этапа «%s»', (stage) => {
    it('рестарт продолжает с этапа: сделанное не повторяется, исход сказан', () => {
        const u = universe();
        expect(runProcess(u, stage).killed).toBe(true);

        // На диске — этап без исхода, и именно он точка продолжения.
        const atRestart = load(u);
        const summary = summarizeSubmit(atRestart.submitStages ?? []);
        expect(summary?.resumeStage).toBe(stage);
        expect(summary?.stages.find((x) => x.stage === stage)?.status).toBe('не завершён');
        const fromDead = u.chat.length;

        const second = runProcess(u);
        expect(second.killed).toBe(false);
        // Сводка попытки на старте называет брошенный этап. Деплой до петли не доходит —
        // старт держит барьер (ниже).
        if (stage !== 'deploy') {
            expect(second.logs.join('\n')).toContain(`${SUBMIT_STAGE_TITLES[stage]} — не завершён`);
        }

        // Сессии этапов, доведённых первым процессом, второй раз не идут; сессия брошенного
        // этапа повторяется ровно один раз.
        for (const [st, kind] of Object.entries(SESSION_OF) as [TSubmitStage, TSession][]) {
            expect(u.sessions[kind], `сессия «${kind}»`).toBe(st === stage ? 2 : 1);
        }
        expect(u.forge.prs).toBe(1);
        // POST мерджа — один на всю историю: убитый после мерджа рестарт его не повторяет.
        expect(u.forge.posts).toBe(1);
        expect(u.forge.merged).toBe(1);

        if (stage === 'deploy') {
            // Деплой не досмотрен — барьер с диска держит старт, это и есть «продолжить с
            // этапа»: следующая фаза не начинается, пока человек не скажет --deploy-resolved.
            expect(atRestart.deployBlock).toMatchObject({ status: 'pending', milestone: 'M1' });
            expect(u.chat.at(-1)).toMatch(PENDING_BARRIER);
            expect(u.deployWaits).toBe(1);
            return;
        }
        expect(u.chat.length).toBeGreaterThan(fromDead);
        expect(u.chat.at(-1)).toMatch(MERGED);
        // Деплой проверен ровно раз — после мерджа, которым кончилась история.
        expect(u.deployWaits).toBe(1);
        expect(load(u).submitStages).toEqual([]);
    });
});

describe('#93 база диффа правок переживает рестарт', () => {
    it('правки убиты после пуша — ревью правок рестарта считает от сохранённой базы', () => {
        const u = universe();
        const first = 'c'.repeat(40);
        expect(runProcess(u, 'fixes', { head: first }).killed).toBe(true);
        // Убитая сессия успела запушить: голова ушла вперёд. Рестарт обязан диффить от
        // базы, сохранённой в начале этапа, а не от новой головы.
        const bases: (string | undefined)[] = [];
        expect(runProcess(u, undefined, { head: 'd'.repeat(40), bases }).killed).toBe(false);
        expect(bases).toContain(first);
        expect(u.chat.at(-1)).toMatch(MERGED);
    });
});

describe('#93 повтор этапа ревью не смешивает проходы', () => {
    it('хвост прошлого прохода доводится отдельным применением ДО новой ревью-сессии', () => {
        const u = universe();
        expect(runProcess(u, 'review').killed).toBe(true);
        const before = u.applies.length;
        expect(runProcess(u).killed).toBe(false);
        // Первое применение рестарта — без сессии (хвост прошлого прохода), второе — уже
        // нового прохода ревью: их находки не складываются в один вердикт.
        expect(u.applies.slice(before, before + 2)).toEqual([null, 'review']);
        expect(u.chat.at(-1)).toMatch(MERGED);
    });
});

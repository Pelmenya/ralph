// #87: матрица «убить до / после» для эффектов сдачи фазы — PR, ревью и метки.
//
// Вторая половина матрицы #86. Там — намерения по задачам; здесь — всё, что решает о
// мердже: заведение PR, публикация замечаний ревью, постановка и снятие `blocked`,
// чекпоинты state (`submitted`, `reviewOfFixes`, `arbitrated`, `reReviewPending`).
//
// Уровней два, и это не дубль:
//   • намерения ревью (`pr-comment`, `pr-block`) идут через журнал «начато / применено»
//     #86 — их клетки проверяются на самом `applySessionRequests`, как у задач;
//   • остальное делает раннер сам, посреди `runLoop`, и окно падения там — между двумя
//     записями state или между записью state и вызовом форжа. Эти клетки гоняют НАСТОЯЩИЙ
//     `runLoop`: первый процесс убит в точке, следующий поднят со state «с диска» и идёт
//     до исхода.
//
// Исход любой клетки — один из двух: фаза смерджена после ревью с вердиктом, и PR ровно
// один — или стоп с причиной в чате. Мерджа без вердикта нет ни в одной клетке, и мерджа
// с подтверждённым блокером тоже. Приёмка клетки — последняя строка в чате.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import type { RalphConfig } from '../core/orchestrator.ts';
import type { RalphState } from '../core/state-lock.ts';
import { IN_FLIGHT_PREFIX } from '../core/session-requests.ts';
import { REASON_TITLES } from '../core/stop-message.ts';
import { Killed, world } from './crash-world.ts';
import { withDefaultFixPlan } from './test-helpers.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralph.runLoop as Runtime['runLoop'];

const REVIEW_MODEL = 'claude-opus-4-8';
const ARBITER_MODEL = 'claude-fable-5';
const PR = 777;
const BRANCH = 'feature/m1';

// Промпты различаем по их собственным формулировкам (prompts.ts) — тот же приём, что в
// review-of-fixes-scenarios.
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
const REVIEWS: ReadonlySet<TSession> = new Set(['review', 'fix-review', 'arbiter', 're-review']);

type Finding = { comment: string; anchor?: { path: string; line: number } };
type TPass = { findings: Finding[]; blocked?: boolean };
const SUMMARY: Finding = { comment: '⚪ [nit] сводка прохода: блокирующего нет' };
const BLOCKER: Finding = {
    comment: '🔴 [blocker] отказ теряется в catch',
    anchor: { path: 'src/a.ts', line: 42 },
};

/**
 * Сценарий — что приносит каждая сессия. Значение функцией от номера ТАКОЙ ЖЕ сессии за
 * всю историю (через все процессы): повторное ревью после рестарта видит тот же код и
 * обязано сказать то же самое, иначе матрица мерила бы удачу модели, а не раннер.
 */
type TScenario = {
    title: string;
    passes: Partial<Record<TSession, (nth: number) => TPass>>;
    /** Верный исход без убийств: мердж или стоп человеку. */
    outcome: 'merged' | 'stopped';
    /** Приёмка: последняя строка, которая придёт в чат, — и без убийств, и после рестарта. */
    accept: RegExp;
    /** Виды эффектов, которые сценарий обязан пройти, — иначе клеток вокруг них нет. */
    effects: string[];
    cfg?: Partial<RalphConfig>;
};

const MERGED = /^✅ Ralph: фаза "M1" смерджена в main — готова к релизу\.$/;

const SCENARIOS: Record<string, TScenario> = {
    clean: {
        title: 'ревью без блокеров → правки → ревью правок → мердж',
        passes: {
            review: () => ({ findings: [SUMMARY] }),
            'fix-review': () => ({ findings: [SUMMARY] }),
        },
        outcome: 'merged',
        accept: MERGED,
        effects: [
            'createPr',
            'apply:review',
            'apply:fix-review',
            'save:reviewOfFixes',
            'save:submitted=true',
            'merge',
        ],
    },
    'blocked-heal': {
        title: 'ревью ставит blocked → разбор → повторное ревью чисто → мердж',
        passes: {
            review: () => ({ findings: [BLOCKER, SUMMARY], blocked: true }),
            'fix-review': () => ({ findings: [SUMMARY] }),
            're-review': () => ({ findings: [SUMMARY] }),
        },
        outcome: 'merged',
        accept: MERGED,
        effects: [
            'apply:review',
            'save:submitted=true',
            'save:reReviewPending=true',
            'removeBlocked',
            'apply:re-review',
            'save:reReviewPending=false',
            'merge',
        ],
    },
    'arbiter-confirms': {
        // Блокер — без `pr-block`, одной severity: метку тогда ставит раннер по вердикту
        // арбитра, и только она отделяет фазу от мерджа.
        title: 'ревью правок находит блокер, арбитр его подтверждает → мерджа нет',
        passes: {
            review: () => ({ findings: [SUMMARY] }),
            'fix-review': () => ({ findings: [BLOCKER, SUMMARY] }),
            arbiter: () => ({ findings: [BLOCKER, SUMMARY] }),
            're-review': () => ({ findings: [BLOCKER, SUMMARY], blocked: true }),
        },
        outcome: 'stopped',
        accept: /^⛔ Ralph: фаза "M1" — PR #777 с label blocked оставлен человеку\. причина: спор ревью \(review-dispute\)/,
        effects: [
            'apply:fix-review',
            'apply:arbiter',
            'save:submitted=true,reReviewPending=true,arbitrated=true',
            'addBlocked',
            'save:reReviewPending=false',
            'removeBlocked',
            'apply:re-review',
        ],
        cfg: { fixReviewAttempts: 1 },
    },
};

const cfgFor = (o: Partial<RalphConfig> = {}): RalphConfig => ({
    model: 'claude-coder',
    prompt: 'сделай {milestone} в ветке {branch}',
    authorAllowlist: ['owner'],
    blockedHealAttempts: 2,
    phases: [{ milestone: 'M1', branch: BRANCH }],
    review: {
        default: REVIEW_MODEL,
        escalated: REVIEW_MODEL,
        fallback: REVIEW_MODEL,
        arbiter: ARBITER_MODEL,
        maxTurns: 80,
    },
    gate: { checks: [['test', 'npm run test']] },
    ...o,
});

const freshState = (): RalphState => ({
    schemaVersion: 1,
    count: 0,
    milestone: 'M1',
    submitted: false,
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

/** Всё, что переживает смерть процесса: state на диске и форж. Чат — общий для всех. */
type TUniverse = {
    disk: RalphState;
    forge: {
        prs: number;
        labels: Set<string>;
        comments: string[];
        merged: number;
        // Сколько вердиктов ревью легло на PR и сколько из них — после последнего снятия
        // `blocked`: снятая метка без нового вердикта и есть мердж «без доказательства».
        verdicts: number;
        verdictsSinceLift: number;
        // Блокер, подтверждённый последним ревью, ещё не опровергнут следующим.
        standingBlocker: boolean;
    };
    chat: string[];
    sessions: Partial<Record<TSession, number>>;
    trace: string[];
    mergeAudit: Array<{ verdicts: number; verdictsSinceLift: number; standingBlocker: boolean }>;
};

const universe = (): TUniverse => ({
    disk: freshState(),
    forge: {
        prs: 0,
        labels: new Set(),
        comments: [],
        merged: 0,
        verdicts: 0,
        verdictsSinceLift: 0,
        standingBlocker: false,
    },
    chat: [],
    sessions: {},
    trace: [],
    mergeAudit: [],
});

const clone = (s: RalphState): RalphState => JSON.parse(JSON.stringify(s)) as RalphState;

/** Имя записи state — по тому, какие чекпоинты она меняет. */
function saveName(before: RalphState, after: RalphState): string {
    const keys = [
        'submitted',
        'reReviewPending',
        'blockedHeals',
        'lastReviewModel',
        'reviewModelFloor',
    ] as const;
    const changed: string[] = keys
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
        .map((k) => `${k}=${JSON.stringify(after[k])}`);
    const lb = (before.reviewOfFixes ?? {}) as { arbitrated?: boolean };
    const la = (after.reviewOfFixes ?? {}) as { arbitrated?: boolean };
    if (la.arbitrated === true && lb.arbitrated !== true) changed.push('arbitrated=true');
    else if (JSON.stringify(before.reviewOfFixes) !== JSON.stringify(after.reviewOfFixes)) {
        changed.push('reviewOfFixes');
    }
    return `save:${changed.join(',') || '—'}`;
}

/** Один процесс раннера. `killOn` — точка убийства; без неё процесс идёт до исхода. */
function runProcess(
    u: TUniverse,
    sc: TScenario,
    killOn: (op: string) => 'before' | 'after' | null = () => null,
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
    // Чтения тоже мёртвые: убитый процесс не читает форж, и катч, проглотивший смерть,
    // не должен получить ответ, по которому пойдёт дальше.
    const read =
        <A extends unknown[], R>(act: (...a: A) => R) =>
        (...a: A): R => {
            w.alive();
            return act(...a);
        };
    const { forge } = u;
    const state = clone(u.disk);
    let lastSession: TSession | null = null;
    let lastPass: TPass = { findings: [] };
    let idxCalls = 0;

    const pr = () =>
        forge.prs > 0 ? { number: PR, labels: [...forge.labels].map((name) => ({ name })) } : null;

    try {
        runLoop(
            cfgFor(sc.cfg),
            { state, maxIterations: 10, maxTurns: 200 },
            {
                once: false,
                dry: false,
                logFn: () => {},
                shFn: read(() => ''),
                runArgvFn: read(() => ''),
                saveStateFn: g(
                    (s: RalphState) => saveName(u.disk, s),
                    (s: RalphState) => {
                        u.disk = clone(s);
                    },
                ),
                openIssuesFn: read(() => []),
                allOpenIssuesFn: read(() => []),
                hasAnyIssuesFn: read(() => true),
                findOpenPrFn: read(pr),
                createPrFn: g(
                    () => 'createPr',
                    () => {
                        forge.prs += 1;
                        return PR;
                    },
                ),
                phasePrBodyFn: () => 'тело PR',
                prCommentsFn: read(() => []),
                getIssueFn: read((n: number) => ({ number: n, title: 'задача', body: 'тело' })),
                // Фаза одна; смерджена — петля кончается, как на настоящем форже.
                phaseIndexOfFn: () => (forge.merged > 0 || idxCalls++ > 40 ? 99 : 0),
                pickModelFn: () => 'claude-coder',
                pickRuntimeFn: () => 'claude',
                pickRouteFn: () => ({ provider: 'claude', model: 'claude-coder' }),
                pickReviewModelFn: () => REVIEW_MODEL,
                phaseDiffFilesFn: read(() => ['src/a.ts']),
                reviewDiffContextFn: read(() => ''),
                branchHeadShaFn: read(() => 'b'.repeat(40)),
                runClaudeFn: read(
                    withDefaultFixPlan((prompt: string) => {
                        lastSession = sessionOf(prompt);
                        const nth = u.sessions[lastSession] ?? 0;
                        u.sessions[lastSession] = nth + 1;
                        lastPass = sc.passes[lastSession]?.(nth) ?? { findings: [] };
                        return 0;
                    }),
                ),
                // Применение намерений сессии — эффект на форже целиком: комментарии и
                // `pr-block`. Клетки ВНУТРИ применения — у `applySessionRequests` ниже.
                applySessionRequestsFn: g(
                    () => `apply:${lastSession ?? 'none'}`,
                    () => {
                        const kind = lastSession;
                        lastSession = null;
                        const pass: TPass = kind && REVIEWS.has(kind) ? lastPass : { findings: [] };
                        for (const f of pass.findings) forge.comments.push(f.comment);
                        if (pass.blocked) forge.labels.add('blocked');
                        if (kind && REVIEWS.has(kind) && pass.findings.length > 0) {
                            forge.verdicts += 1;
                            forge.verdictsSinceLift += 1;
                            forge.standingBlocker = pass.findings.some((f) =>
                                f.comment.startsWith('🔴'),
                            );
                        }
                        return {
                            applied: pass.findings.length,
                            failed: false,
                            closedIssues: [],
                            prFindings: pass.findings,
                            prBlocked: pass.blocked === true,
                        };
                    },
                ),
                addBlockedLabelFn: g(
                    () => 'addBlocked',
                    () => {
                        forge.labels.add('blocked');
                    },
                ),
                removeBlockedLabelFn: g(
                    () => 'removeBlocked',
                    () => {
                        forge.labels.delete('blocked');
                        forge.verdictsSinceLift = 0;
                    },
                ),
                prHasBlockedLabelFn: read(() => forge.labels.has('blocked')),
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
                advancePhaseFn: read(() => {}),
                // Гейт — его детерминированное ядро: `blocked` на PR держит мердж, иначе
                // мердж. Чеки зелёные: предмет матрицы — метки и вердикты, а не чеки.
                tryMergePhaseFn: g(
                    () => (forge.labels.has('blocked') ? 'gate:blocked' : 'merge'),
                    () => {
                        if (forge.labels.has('blocked')) return 'blocked' as const;
                        forge.merged += 1;
                        u.mergeAudit.push({
                            verdicts: forge.verdicts,
                            verdictsSinceLift: forge.verdictsSinceLift,
                            standingBlocker: forge.standingBlocker,
                        });
                        return 'merged' as const;
                    },
                ),
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
                ensureMonitorAliveFn: () => null,
                sleepFn: () => {},
            },
        );
    } catch (e) {
        if (!(e instanceof Killed)) throw e;
    }
    return { killed: w.dead };
}

/** Эффекты, вокруг которых режем: PR, ревью, метки, чекпоинты. Чтения и сессии — нет. */
const isEffect = (op: string): boolean =>
    op === 'createPr' ||
    op === 'addBlocked' ||
    op === 'removeBlocked' ||
    op === 'merge' ||
    (op.startsWith('apply:') && op !== 'apply:none' && op !== 'apply:heal') ||
    /^save:.*(submitted|reviewOfFixes|arbitrated|reReviewPending)/.test(op);

describe.each(Object.entries(SCENARIOS))('#87 матрица сдачи: %s', (_key, sc) => {
    // Прогон без убийств задаёт и верный исход, и список эффектов, вокруг которых режем.
    const reference = universe();
    runProcess(reference, sc);
    const cells = reference.trace.flatMap((op, i) =>
        isEffect(op)
            ? (['before', 'after'] as const).map((when) => ({ op, i, when, step: i + 1 }))
            : [],
    );

    it(`без убийств: ${sc.title}`, () => {
        expect(reference.forge.merged).toBe(sc.outcome === 'merged' ? 1 : 0);
        expect(reference.forge.prs).toBe(1);
        expect(reference.chat.at(-1)).toMatch(sc.accept);
        // Каждый заявленный вид эффекта в трассе есть: матрица, не дошедшая до эффекта,
        // утверждала бы «окна нет» про окно, которого не видела.
        for (const op of sc.effects) expect(reference.trace).toContain(op);
    });

    it.each(cells)('убит $when $op (шаг трассы $step)', ({ op, i, when }) => {
        const u = universe();
        let n = -1;
        const first = runProcess(u, sc, () => {
            n += 1;
            return n === i ? when : null;
        });
        expect(first.killed).toBe(true);
        // Убитый процесс в чат не пишет ничего после смерти: всё, что там есть, сказано
        // до неё и правдиво.
        const fromDead = u.chat.length;
        // Убит мердж ПОСЛЕ эффекта — фаза в main, рестарту делать нечего; пуш о мердже —
        // забота матрицы гейта и мерджа, а не этой.
        if (op === 'merge' && when === 'after') {
            expect(u.forge.merged).toBe(1);
            return;
        }
        // Рестарт: новый процесс со state «с диска» и тем же форжем идёт до исхода.
        const second = runProcess(u, sc);
        expect(second.killed).toBe(false);

        // PR ровно один: рестарт находит заведённый, а не плодит второй.
        expect(u.forge.prs).toBe(1);
        // Мерджа без ревью с вердиктом нет: вердикт лёг, после последнего снятия `blocked`
        // — тоже, и подтверждённого блокера на момент мерджа нет.
        expect(u.forge.merged).toBe(sc.outcome === 'merged' ? 1 : 0);
        for (const audit of u.mergeAudit) {
            expect(audit.verdicts).toBeGreaterThan(0);
            expect(audit.verdictsSinceLift).toBeGreaterThan(0);
            expect(audit.standingBlocker).toBe(false);
        }
        // Приёмка: что придёт в чат. Молчания нет — рестарт кончается строкой исхода.
        expect(u.chat.length).toBeGreaterThan(fromDead);
        expect(u.chat.at(-1)).toMatch(sc.accept);
        if (sc.outcome === 'merged') {
            expect(u.chat.filter((m) => m.startsWith('⛔'))).toEqual([]);
        }
    });
});

// ── Намерения ревью: публикация замечаний и `pr-block` ──────────────────────────────
// Тот же журнал «начато / применено», что у задач (#86), но эффекты другие: замечание
// ложится в PR, а `pr-block` несёт ДВА эффекта — метку и комментарий. Метка из них решает
// о мердже, и развилка человека из пуша не имеет права её потерять.

type TPrKind = 'pr-comment' | 'pr-comment-anchored' | 'pr-block';
type TKillAt = 'before-marker' | 'before-effect' | 'after-effect';

const PR_REQUEST: Record<TPrKind, Record<string, unknown>> = {
    'pr-comment': { kind: 'pr-comment', comment: 'сводка прохода' },
    'pr-comment-anchored': {
        kind: 'pr-comment',
        comment: '🔴 [blocker] отказ теряется',
        path: 'src/a.ts',
        line: 42,
    },
    'pr-block': { kind: 'pr-block', comment: 'блокер: отказ теряется' },
};

// Эффекты на форже в порядке вызова шва. У `pr-block` метка — ПЕРВОЙ: см. тест развилок.
const PR_EFFECTS: Record<TPrKind, string[]> = {
    'pr-comment': ['comment:сводка прохода'],
    'pr-comment-anchored': ['comment:src/a.ts:42:🔴 [blocker] отказ теряется'],
    'pr-block': ['label:blocked', 'comment:блокер: отказ теряется'],
};

const EARLIER_PR = { kind: 'pr-comment', comment: 'раньше' };
const EARLIER_PR_EFFECT = 'comment:раньше';
const jsonl = (o: unknown): string => JSON.stringify(o);
const INTENT_CFG = { issueLabels: ['complexity:low', 'area:core'] };

/**
 * Форж PR: лента эффектов и метки, переживающие смерть процесса. `bodies` — сырые тела
 * комментариев, как их отдаёт лента PR (#94: с меткой намерения); `effects` пишет тело
 * без метки, чтобы матрица читалась по смыслу. `listFails` — лента не читается.
 */
type TPrForge = { effects: string[]; labels: Set<string>; bodies?: string[]; listFails?: boolean };
const MARK_RE = /\n\n<!-- ralph-intent:[A-Za-z0-9-]+ -->$/;

function applyPr(
    disk: { file: string | null },
    forge: TPrForge,
    chat: string[],
    killOn: (op: string) => 'before' | 'after' | null = () => null,
) {
    const w = world();
    const g = <A extends unknown[], R>(op: (...a: A) => string, act: (...a: A) => R) =>
        w.guard(op, act, killOn);
    const res = ralph.applySessionRequests({
        cfg: INTENT_CFG,
        dry: false,
        phase: { branch: BRANCH },
        currentMilestone: 'M1',
        readFn: () => disk.file,
        writeFn: g(
            (t: string) => `write:${t}`,
            (t: string) => {
                disk.file = t;
            },
        ),
        removeFn: g(
            () => 'remove',
            () => {
                disk.file = null;
            },
        ),
        taskSource: {
            findOpenPullRequest: () => {
                w.alive();
                return { number: PR, labels: [...forge.labels].map((name) => ({ name })) };
            },
            commentOnPullRequest: g(
                (_n: number, c: { body: string; anchor?: { path: string; line?: number } }) =>
                    c.anchor
                        ? `comment:${c.anchor.path}:${String(c.anchor.line)}:${c.body.replace(MARK_RE, '')}`
                        : `comment:${c.body.replace(MARK_RE, '')}`,
                (_n: number, c: { body: string; anchor?: { path: string; line?: number } }) => {
                    const body = c.body.replace(MARK_RE, '');
                    (forge.bodies ??= []).push(c.body);
                    forge.effects.push(
                        c.anchor
                            ? `comment:${c.anchor.path}:${String(c.anchor.line)}:${body}`
                            : `comment:${body}`,
                    );
                },
            ),
            listPullRequestComments: () => {
                w.alive();
                if (forge.listFails === true) throw new Error('HTTP 502');
                return (forge.bodies ?? []).map((body) => ({ body, isSummary: false }));
            },
            addBlockedLabel: g(
                () => 'label:blocked',
                () => {
                    forge.labels.add('blocked');
                    forge.effects.push('label:blocked');
                },
            ),
        },
        logFn: () => {},
        pushEventFn: w.chat(chat),
    }) as { applied: number; failed: boolean; outcomeUnknown?: boolean; prBlocked: boolean };
    return { res, dead: w.dead };
}

function restartPr(disk: { file: string | null }, forge: TPrForge, chat: string[]) {
    const w = world();
    const stopped = ralph.stopOnInFlightIntent({
        cfg: INTENT_CFG,
        readFn: () => disk.file,
        pushEventFn: w.chat(chat),
        logFn: () => {},
    }) as boolean;
    return { stopped, applied: applyPr(disk, forge, chat).res };
}

function prKiller(kind: TPrKind, at: TKillAt): (op: string) => 'before' | 'after' | null {
    const effects = PR_EFFECTS[kind];
    const target = jsonl(PR_REQUEST[kind]);
    return (op) => {
        if (
            at === 'before-marker' &&
            op.startsWith(`write:${IN_FLIGHT_PREFIX}`) &&
            op.split('\n')[1] === target
        ) {
            return 'before';
        }
        if (at === 'before-effect' && op === effects[0]) return 'before';
        if (at === 'after-effect' && op === effects.at(-1)) return 'after';
        return null;
    };
}

const PR_KINDS: TPrKind[] = ['pr-comment', 'pr-comment-anchored', 'pr-block'];

describe('#87 матрица «убить до / после»: намерения ревью по PR', () => {
    describe.each(PR_KINDS)('%s', (kind) => {
        const batch = `${[jsonl(EARLIER_PR), jsonl(PR_REQUEST[kind])].join('\n')}\n`;

        it('убит ДО метки начатого — рестарт публикует его ровно один раз и молча', () => {
            const disk = { file: batch as string | null };
            const forge: TPrForge = { effects: [], labels: new Set() };
            const chat: string[] = [];
            expect(applyPr(disk, forge, chat, prKiller(kind, 'before-marker')).dead).toBe(true);
            expect(chat).toEqual([]);
            expect(forge.effects).toEqual([EARLIER_PR_EFFECT]);

            const { stopped, applied } = restartPr(disk, forge, chat);
            expect(stopped).toBe(false);
            expect(applied.failed).toBe(false);
            expect(forge.effects).toEqual([EARLIER_PR_EFFECT, ...PR_EFFECTS[kind]]);
            // Вердикт `pr-block` дошёл до петли: без него лестница решала бы без блока.
            expect(applied.prBlocked).toBe(kind === 'pr-block');
            expect(chat).toEqual([]);
            expect(disk.file).toBeNull();
        });

        // #94: замечание несёт метку намерения, и рестарт сверяет её с лентой PR. Убит до
        // эффекта — метки в ленте нет, замечание ложится один раз; после — метка есть, и
        // повтора нет. Стопа нет ни в одной клетке: исход решает форж, а не человек.
        it.each<TKillAt>(['before-effect', 'after-effect'])(
            'убит %s — рестарт сверяет с лентой PR: замечание ровно одно, стопа нет',
            (at) => {
                const disk = { file: batch as string | null };
                const forge: TPrForge = { effects: [], labels: new Set() };
                const chat: string[] = [];
                expect(applyPr(disk, forge, chat, prKiller(kind, at)).dead).toBe(true);
                expect(chat).toEqual([]);

                const { stopped, applied } = restartPr(disk, forge, chat);
                expect(stopped).toBe(false);
                expect(applied.failed).toBe(false);
                expect(applied.outcomeUnknown).toBeUndefined();
                expect(applied.prBlocked).toBe(kind === 'pr-block');
                // Каждое замечание в ленте ровно один раз — и раннее, и проверяемое.
                const comments = forge.effects.filter((e) => e.startsWith('comment:'));
                expect(comments).toEqual([
                    EARLIER_PR_EFFECT,
                    ...PR_EFFECTS[kind].filter((e) => e.startsWith('comment:')),
                ]);
                if (kind === 'pr-block') expect(forge.labels.has('blocked')).toBe(true);
                expect(chat).toEqual([]);
                expect(disk.file).toBeNull();
            },
        );

        it('убит после эффекта, а лента PR не читается — стоп с причиной, повтора нет', () => {
            const disk = { file: batch as string | null };
            const forge: TPrForge = { effects: [], labels: new Set() };
            const chat: string[] = [];
            expect(applyPr(disk, forge, chat, prKiller(kind, 'after-effect')).dead).toBe(true);
            const before = [...forge.effects];
            forge.listFails = true;

            const { stopped, applied } = restartPr(disk, forge, chat);
            // Старт не встаёт: вид сверяемый, а лента читается уже при применении.
            expect(stopped).toBe(false);
            expect(forge.effects).toEqual(before);
            expect(applied.outcomeUnknown).toBe(true);
            const msg = chat[0];
            expect(msg).toMatch(/^⛔ Ralph: /);
            expect(msg).toContain(REASON_TITLES['intent-unknown']);
            expect(msg).toContain(jsonl(PR_REQUEST[kind]));
            expect(msg).toContain('лента форжа не прочиталась: HTTP 502');
            expect(msg).toMatch(/перезапусти loop/);
            expect(disk.file).not.toContain(jsonl(EARLIER_PR));
        });
    });

    // `pr-block` — два эффекта, и метка из них решает о мердже, поэтому ложится первой.
    // Убит между ними — в ленте нет комментария с меткой намерения, и рестарт применяет
    // блок заново: метка идемпотентна, комментарий ложится один раз.
    describe('pr-block, убит между эффектами: метка на PR, комментарий один', () => {
        const stuck = (listFails = false) => {
            const disk = { file: `${jsonl(PR_REQUEST['pr-block'])}\n` as string | null };
            const forge: TPrForge = { effects: [], labels: new Set(), listFails };
            const chat: string[] = [];
            applyPr(disk, forge, chat, (op) => (op === PR_EFFECTS['pr-block'][0] ? 'after' : null));
            expect(forge.effects).toEqual([PR_EFFECTS['pr-block'][0]]);
            return { disk, forge, chat };
        };

        it('рестарт сверяет: комментария нет — блок довершён, метка на PR', () => {
            const { disk, forge, chat } = stuck();
            const { stopped, applied } = restartPr(disk, forge, chat);
            expect(stopped).toBe(false);
            expect(applied.failed).toBe(false);
            expect(applied.prBlocked).toBe(true);
            expect(forge.labels.has('blocked')).toBe(true);
            expect(forge.effects.filter((e) => e.startsWith('comment:'))).toEqual([
                PR_EFFECTS['pr-block'][1],
            ]);
        });

        it('лента не читается — пуш называет, по чему судить: у pr-block эффект — метка blocked', () => {
            const { disk, forge, chat } = stuck(true);
            const { applied } = restartPr(disk, forge, chat);
            expect(applied.outcomeUnknown).toBe(true);
            expect(chat[0]).toMatch(/pr-block.*метк[аи] blocked/s);
            expect(forge.labels.has('blocked')).toBe(true);
        });
    });
});

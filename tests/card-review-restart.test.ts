// S2f: ревью карточки переживает обрыв на каждой границе «state → сессия → эффекты».
// Мир здесь — только сериализуемый state и файл намерений; второй запуск видит то же,
// что убитый успел сохранить. Поэтому тесты различают принятый вердикт, неизвестный исход
// и восстановленный эффект, а не проверяют удачный путь по памяти одного процесса.
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов, как в соседних матрицах рестарта.
import ralph from '../ralph.js';
import {
    cardRecordOf,
    newCardProgress,
    type TCardBatch,
    type TCardProgress,
} from '../core/card-review.ts';
import type { RalphState } from '../core/state-lock.ts';
import { MODEL_PROXY_RETRIES } from '../core/runtime-availability.ts';
import { inFlightMarker, serializeSessionRequest } from '../core/session-requests.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralph.runLoop as Runtime['runLoop'];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const STARTED_AT = '2026-11-05T10:00:00.000Z';
const CLEAN: TCardBatch = {
    deferredClose: null,
    summary: '⚪ [nit] чисто',
    blocked: null,
    findings: [],
    fixes: [],
};
const EMPTY: TCardBatch = {
    deferredClose: null,
    summary: null,
    blocked: null,
    findings: [],
    fixes: [],
};

type TDisk = {
    state: RalphState;
    requests: string | null;
    open: boolean;
    labels: Array<{ name: string }>;
    quarantined: string[];
    writes: string[];
    removed: number;
};
type TApply = (options: Record<string, unknown>) => Record<string, unknown>;
type TRun = (
    prompt: string,
    options: Record<string, unknown>,
    deps: { onOutput?: (text: string, end: string) => void },
) => number;

function card(over: Partial<TCardProgress> = {}): TCardProgress {
    return {
        ...newCardProgress({ issue: 7, milestone: 'M1', firstHead: A, startedAt: STARTED_AT }),
        closeComment: 'сделано',
        ...over,
    };
}

function reviewed(over: Partial<TCardProgress> = {}): TCardProgress {
    return card({
        verdict: 'findings',
        lastReviewedHead: A,
        rounds: 1,
        sessions: 2,
        findings: [
            {
                id: 'F1',
                severity: 'blocker',
                comment: 'потерян отказ',
                anchor: { path: 'core/a.ts', line: 42 },
                round: 1,
                head: A,
                status: 'open',
                test: null,
                note: null,
            },
        ],
        ...over,
    });
}

function limitedDisk(over: Partial<TCardProgress> = {}): TDisk {
    const progress = reviewed({ rounds: 3, sessions: 3, ...over });
    const disk = diskOf(progress);
    disk.state.cardHistory = [cardRecordOf(progress, 'blocked', A, '2026-11-05T10:01:00.000Z')];
    return disk;
}

function stateOf(progress: TCardProgress | null): RalphState {
    return {
        schemaVersion: 2,
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
        cardReview: progress,
    };
}

function diskOf(
    progress: TCardProgress | null,
    over: Partial<Pick<TDisk, 'requests' | 'open'>> = {},
): TDisk {
    return {
        state: stateOf(progress),
        requests: null,
        open: true,
        labels: [],
        quarantined: [],
        writes: [],
        removed: 0,
        ...over,
    };
}

function runProcess(
    disk: TDisk,
    {
        head = A,
        originHead = head,
        run,
        apply,
        config = {},
        over = {},
    }: {
        head?: string;
        originHead?: string;
        run?: TRun;
        apply?: TApply;
        config?: Record<string, unknown>;
        over?: Record<string, unknown>;
    } = {},
) {
    const logs: string[] = [];
    const prompts: string[] = [];
    const state = structuredClone(disk.state);
    const runClaudeFn = vi.fn(
        (
            prompt: string,
            options: Record<string, unknown>,
            deps: { onOutput?: (text: string, end: string) => void },
        ) => {
            prompts.push(prompt);
            return run ? run(prompt, options, deps) : 0;
        },
    );
    const defaultApply: TApply = (options) => {
        const stage = options.cardStage as
            { role: string; saveBatchFn?: (batch: TCardBatch) => void } | undefined;
        if (stage?.role === 'review') stage.saveBatchFn?.(CLEAN);
        if (stage?.role === 'fix') stage.saveBatchFn?.(EMPTY);
        if (stage?.role === 'closing') disk.open = false;
        if (stage === undefined) disk.labels = [{ name: 'blocked' }];
        disk.requests = null;
        return { applied: 0, failed: false, closedIssues: [] };
    };
    const applySessionRequestsFn = vi.fn((options: Record<string, unknown>) =>
        (apply ?? defaultApply)(options),
    );
    runLoop(
        {
            model: 'claude-coder',
            prompt: 'сделай {milestone} в ветке {branch}',
            authorAllowlist: ['owner'],
            phases: [{ milestone: 'M1', branch: 'feature/m1' }],
            gate: { checks: [['test', 'npm test']] },
            review: { cardReview: true, default: 'reviewer' },
            ...config,
        },
        { state, maxIterations: 20, maxTurns: 80 },
        {
            once: true,
            dry: false,
            logFn: (message: string) => logs.push(message),
            pushEventFn: (
                message: string,
                _cfg?: unknown,
                opts?: { logFn?: (m: string) => void },
            ) => {
                opts?.logFn?.(message);
                return false;
            },
            shFn: () => head,
            runArgvFn: () => '',
            saveStateFn: (saved: RalphState) => {
                disk.state = structuredClone(saved);
            },
            phaseIndexOfFn: () => 0,
            openIssuesFn: () => (disk.open ? [{ number: 7, title: 'карточка' }] : []),
            allOpenIssuesFn: () =>
                disk.open ? [{ number: 7, title: 'карточка', labels: disk.labels }] : [],
            getIssueFn: () => ({ number: 7, title: 'карточка', body: 'тело', open: disk.open }),
            ensureCleanFn: () => true,
            ensurePhaseBranchFn: (branch: string) => ({
                kind: 'switched' as const,
                branch,
                sha: head,
            }),
            checkOnPhaseBranchFn: () => ({ ok: true, sha: head }),
            ensureMonitorAliveFn: () => null,
            syncProjectBoardFn: () => {},
            pickRouteFn: () => ({ provider: 'claude', model: 'coder' }),
            pickReviewModelFn: () => 'reviewer',
            phaseDiffFilesFn: () => ['core/a.ts'],
            reviewDiffContextFn: () => '<дифф карточки>',
            branchHeadShaFn: () => originHead,
            pushSessionCommitsFn: () => ({ kind: 'in-sync' as const }),
            readSessionRequestsFn: () => disk.requests,
            writeSessionRequestsFn: (text: string) => {
                disk.writes.push(text);
                disk.requests = text;
            },
            removeSessionRequestsFn: () => {
                disk.removed += 1;
                disk.requests = null;
            },
            quarantineSessionRequestsFn: () => {
                if (disk.requests !== null) disk.quarantined.push(disk.requests);
                disk.requests = null;
                return 'карантин';
            },
            nowFn: () => Date.parse('2026-11-05T10:01:00.000Z'),
            sleepFn: () => {},
            runClaudeFn,
            applySessionRequestsFn,
            ...over,
        } as never,
    );
    return { logs, prompts, runClaudeFn, applySessionRequestsFn };
}

describe('ревью карточки: крах и рестарт', () => {
    it('2. pending.saved=false: вывод убитой сессии карантинится, новое ревью его не принимает', () => {
        const disk = diskOf(card({ pending: { role: 'review', head: A, saved: false } }), {
            requests: '{"kind":"card-block","issue":7,"comment":"старый блок"}\n',
        });
        const process = runProcess(disk);
        expect(disk.quarantined).toEqual([
            '{"kind":"card-block","issue":7,"comment":"старый блок"}\n',
        ]);
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(process.runClaudeFn.mock.calls[0][1]).toMatchObject({
            model: 'reviewer',
            fallbackModel: 'reviewer',
            maxTurns: 80,
        });
        expect(disk.state.cardReview).toMatchObject({
            failedSessions: 1,
            rounds: 1,
            verdict: 'clean',
            pending: null,
        });
    });

    it('3. pending.saved=true: хвост доводится без saveBatchFn, круг и находки не дублируются', () => {
        const disk = diskOf(
            card({
                verdict: 'clean',
                lastReviewedHead: A,
                rounds: 1,
                findings: [
                    {
                        id: 'F1',
                        severity: 'nit',
                        comment: '⚪ [nit] запись',
                        anchor: null,
                        round: 1,
                        head: A,
                        status: 'journal',
                        test: null,
                        note: null,
                    },
                ],
                pending: { role: 'review', head: A, saved: true },
            }),
            { requests: '{"kind":"comment","issue":7,"comment":"хвост"}\n' },
        );
        const process = runProcess(disk);
        const stages = process.applySessionRequestsFn.mock.calls.map(
            (call) => call[0].cardStage as { role: string; saveBatchFn?: unknown },
        );
        expect(stages.map((stage) => stage.role)).toEqual(['review', 'closing']);
        expect(stages[0].saveBatchFn).toBeUndefined();
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(disk.state.cardHistory?.[0]).toMatchObject({ rounds: 1 });
        expect(disk.state.cardHistory?.[0].findings).toHaveLength(1);
    });

    it('4. code !== 0 со сводкой: вердикт не засчитан ни сразу, ни после рестарта', () => {
        const disk = diskOf(card());
        const first = runProcess(disk, {
            run: () => {
                disk.requests =
                    '{"kind":"card-comment","issue":7,"comment":"⚪ [nit] ложно чисто"}\n';
                return 1;
            },
        });
        expect(first.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(disk.quarantined).toHaveLength(1);
        expect(disk.state.cardReview).toMatchObject({
            failedSessions: 1,
            rounds: 0,
            verdict: null,
            pending: null,
        });
        expect(disk.open).toBe(true);

        const second = runProcess(disk);
        expect(second.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(disk.state.cardReview).toMatchObject({
            failedSessions: 1,
            rounds: 1,
            verdict: 'clean',
        });
    });

    it('5. рестарт с closing до строки close пишет ровно одну строку и закрывает один раз', () => {
        const disk = diskOf(card({ closing: A, verdict: 'clean', lastReviewedHead: A }));
        const process = runProcess(disk);
        expect(disk.writes).toHaveLength(1);
        expect(disk.writes[0]).toContain('"kind":"close"');
        expect(process.applySessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(disk.state.cardHistory).toHaveLength(1);
    });

    it('6. закрытие уже легло на форж: восстановление читается как landed all, история одна', () => {
        const disk = diskOf(card({ closing: A, verdict: 'clean', lastReviewedHead: A }), {
            requests: `${serializeSessionRequest({ kind: 'close', issue: 7, comment: 'сделано' })}\n`,
        });
        const process = runProcess(disk, {
            apply: () => {
                disk.open = false;
                disk.requests = null;
                return { applied: 0, failed: false, closedIssues: [] };
            },
        });
        expect(disk.writes).toHaveLength(0);
        expect(process.applySessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(disk.state.cardHistory).toHaveLength(1);
        expect(disk.state.cardHistory?.[0]).toMatchObject({ outcome: 'closed', head: A });
    });

    it('7. отказ форжа по существу: стоп с closing, вторая строка close не пишется', () => {
        const disk = diskOf(card({ verdict: 'clean', lastReviewedHead: A }));
        const process = runProcess(disk, {
            apply: () => ({
                applied: 0,
                failed: false,
                closedIssues: [],
                dropped: [{ kind: 'close', what: 'закрытие запрещено правилом' }],
            }),
        });
        expect(disk.writes).toHaveLength(1);
        expect(process.applySessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(disk.state.cardReview?.closing).toBe(A);
        expect(disk.open).toBe(true);
        expect(process.logs.join('\n')).toContain('card-unreviewed');
    });

    it('9. closing=X при голове Y: обычная строка close снимается, закрытия нет', () => {
        const disk = diskOf(card({ closing: A, verdict: 'clean', lastReviewedHead: A }), {
            requests: `${serializeSessionRequest({ kind: 'close', issue: 7, comment: 'сделано' })}\n`,
        });
        const process = runProcess(disk, { head: B });
        expect(disk.removed).toBe(1);
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(process.applySessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(process.applySessionRequestsFn.mock.calls[0][0].cardStage).toMatchObject({
            role: 'review',
        });
        expect(disk.state.cardReview).toMatchObject({ closing: null, lastReviewedHead: B });
        expect(disk.open).toBe(true);
    });

    it('in-flight close при смене головы останавливается без эффектов и изменений state', () => {
        const requests = `${inFlightMarker('intent-close-0001')}\n${serializeSessionRequest({ kind: 'close', issue: 7, comment: 'сделано' })}\n`;
        const disk = diskOf(card({ closing: A, verdict: 'clean', lastReviewedHead: A }), {
            requests,
        });
        const before = structuredClone(disk.state);
        const commentOnIssue = vi.fn();
        const closeIssue = vi.fn();
        const applySessionRequestsFn = vi.fn((options: Record<string, unknown>) =>
            ralph.applySessionRequests({
                ...options,
                readFn: () => disk.requests,
                writeFn: (text: string) => {
                    disk.requests = text;
                },
                removeFn: () => {
                    disk.requests = null;
                },
                taskSource: {
                    commentOnIssue,
                    closeIssue,
                    listIssueComments: () => [],
                },
            }),
        );
        const process = runProcess(disk, { head: B, over: { applySessionRequestsFn } });
        expect(commentOnIssue).not.toHaveBeenCalled();
        expect(closeIssue).not.toHaveBeenCalled();
        expect(applySessionRequestsFn).not.toHaveBeenCalled();
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(disk.state).toEqual(before);
        expect(disk.requests).toBe(requests);
        expect(disk.removed).toBe(0);
        expect(disk.quarantined).toEqual([]);
        expect(disk.state.cardHistory ?? []).toEqual([]);
        expect(process.logs.join('\n')).toContain('card-unreviewed');
        expect(process.logs.join('\n')).toContain(A);
        expect(process.logs.join('\n')).toContain(B);
    });

    it('12. локальная и origin-головы разошлись: head-diverged, ни сессии, ни закрытия', () => {
        const disk = diskOf(card({ verdict: 'clean', lastReviewedHead: B }));
        const process = runProcess(disk, { head: B, originHead: C });
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(process.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(disk.writes).toHaveLength(0);
        expect(process.logs.join('\n')).toContain('head-diverged');
    });

    it('14. человек закрыл карточку: closed-external, хвост доведён до выбора следующей', () => {
        const disk = diskOf(card({ closeComment: null }), {
            open: false,
            requests: '{"kind":"comment","issue":7,"comment":"хвост кодера"}\n',
        });
        const process = runProcess(disk, {
            over: {
                openIssuesFn: () =>
                    disk.open
                        ? [{ number: 7, title: 'старая' }]
                        : [{ number: 8, title: 'следующая' }],
                allOpenIssuesFn: () => [],
                getIssueFn: (number: number) => ({
                    number,
                    title: 'карточка',
                    body: 'тело',
                    open: number === 7 ? disk.open : true,
                }),
            },
        });
        expect(process.applySessionRequestsFn.mock.calls[0][0].cardStage).toMatchObject({
            issue: 7,
            role: 'coder',
        });
        expect(disk.state.cardHistory?.[0]).toMatchObject({
            outcome: 'closed-external',
            head: null,
        });
        expect(disk.state.cardReview).toMatchObject({ issue: 8 });
    });

    it('14. paused/blocked с коммитами — card-unreviewed, без коммитов запись снимается', () => {
        const withCommits = diskOf(card());
        const stopped = runProcess(withCommits, {
            head: B,
            over: {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [{ number: 7, title: 'paused' }],
                getIssueFn: () => ({ number: 7, title: 'paused', body: 'тело', open: false }),
            },
        });
        expect(stopped.runClaudeFn).not.toHaveBeenCalled();
        expect(stopped.logs.join('\n')).toContain('card-unreviewed');

        const withoutCommits = diskOf(card({ closeComment: null }));
        runProcess(withoutCommits, {
            over: {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [{ number: 7, title: 'paused' }],
                getIssueFn: () => ({ number: 7, title: 'paused', body: 'тело', open: false }),
            },
        });
        expect(withoutCommits.state.cardReview).toBeNull();
        expect(withoutCommits.state.cardHistory ?? []).toEqual([]);
    });

    it('статус карточки неизвестен без поля open: коммиты не дают closed-external', () => {
        const disk = diskOf(card());
        const before = structuredClone(disk.state);
        const process = runProcess(disk, {
            head: B,
            over: {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                getIssueFn: () => ({ number: 7, title: 'карточка', body: 'тело' }),
            },
        });
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(process.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(disk.state).toEqual(before);
        expect(disk.state.cardHistory ?? []).toEqual([]);
        expect(process.logs.join('\n')).toContain('forge-unreadable');
        expect(process.logs.join('\n')).toContain('статус карточки #7 неизвестен');
    });

    it('без поля open ветка очистки записи без коммитов не срабатывает', () => {
        const disk = diskOf(card({ closeComment: null }));
        const before = structuredClone(disk.state);
        const process = runProcess(disk, {
            over: {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                getIssueFn: () => ({ number: 7, title: 'карточка', body: 'тело' }),
            },
        });
        expect(disk.state).toEqual(before);
        expect(disk.state.cardReview).not.toBeNull();
        expect(process.logs.join('\n')).toContain('forge-unreadable');
    });

    it('15. непустой closeComment при firstHead === head и files=[] идёт в ревью пустого диффа', () => {
        const disk = diskOf(card({ closeComment: '' }));
        const reviewDiffContextFn = vi.fn(() => '');
        const process = runProcess(disk, {
            over: {
                phaseDiffFilesFn: () => [],
                reviewDiffContextFn,
            },
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(reviewDiffContextFn).toHaveBeenCalledWith('feature/m1', {
            files: [],
            limit: 60000,
            base: A,
            strict: true,
        });
        expect(process.prompts[0]).toContain('Дифф пуст');
        expect(disk.state.cardReview).toMatchObject({ rounds: 1, verdict: 'clean' });
    });

    it('16. модель none: стоп до pending, счётчики прежние', () => {
        const disk = diskOf(card({ sessions: 2, failedSessions: 1 }));
        const process = runProcess(disk, {
            over: { pickReviewModelFn: () => 'none' },
        });
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(disk.state.cardReview).toMatchObject({
            sessions: 2,
            failedSessions: 1,
            pending: null,
        });
        expect(process.logs.join('\n')).toContain('card-unreviewed');
    });

    it('17. saveBatchFn кодера бросил: попытка стоп, вторая сессия не запускается', () => {
        const disk = diskOf(null);
        const process = runProcess(disk, {
            over: { once: false },
            apply: (options) => {
                const stage = options.cardStage as { saveBatchFn?: (batch: TCardBatch) => void };
                try {
                    stage.saveBatchFn?.({ ...EMPTY, deferredClose: 'сделано' });
                    throw new Error('state не записался');
                } catch {
                    return { applied: 0, failed: true, outcomeUnknown: true, closedIssues: [] };
                }
            },
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(process.applySessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(disk.open).toBe(true);
    });
});

describe('ревью карточки: исходы вердикта', () => {
    it('interrupted без намерений повторяется, каждая попытка учитывается отдельно', () => {
        const disk = diskOf(card());
        const sleepFn = vi.fn();
        const process = runProcess(disk, {
            run: (_prompt, _options, deps) => {
                deps.onOutput?.('', 'interrupted');
                return 0;
            },
            apply: () => ({ applied: 0, failed: false, closedIssues: [] }),
            over: { sleepFn },
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(MODEL_PROXY_RETRIES + 1);
        expect(sleepFn).toHaveBeenCalledTimes(MODEL_PROXY_RETRIES);
        expect(disk.state.cardReview).toMatchObject({
            sessions: MODEL_PROXY_RETRIES + 1,
            failedSessions: MODEL_PROXY_RETRIES + 1,
            pending: null,
            rounds: 0,
        });
        expect(process.logs.join('\n')).toContain('review-no-verdict');
    });

    it('interrupted у предела бюджета даёт один запуск и card-review-limit', () => {
        const disk = diskOf(card({ sessions: 5 }));
        const sleepFn = vi.fn();
        const process = runProcess(disk, {
            config: { review: { cardReview: true, default: 'reviewer', maxCardSessions: 6 } },
            run: (_prompt, _options, deps) => {
                deps.onOutput?.('', 'interrupted');
                return 0;
            },
            apply: (options) => {
                if (options.cardStage === undefined) disk.labels = [{ name: 'blocked' }];
                disk.requests = null;
                return { applied: 0, failed: false, closedIssues: [] };
            },
            over: { sleepFn },
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
        expect(disk.state.cardReview).toMatchObject({
            sessions: 6,
            failedSessions: 1,
            pending: null,
        });
        expect(process.logs.join('\n')).toContain('card-review-limit');
        expect(process.logs.join('\n')).not.toContain('review-no-verdict');
    });

    it('ненулевой код у предела бюджета', () => {
        const disk = diskOf(card({ sessions: 5 }));
        const process = runProcess(disk, {
            config: { review: { cardReview: true, default: 'reviewer', maxCardSessions: 6 } },
            run: () => {
                disk.requests =
                    '{"kind":"card-comment","issue":7,"comment":"⚪ [nit] ложно чисто"}\n';
                return 1;
            },
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(disk.quarantined).toEqual([
            '{"kind":"card-comment","issue":7,"comment":"⚪ [nit] ложно чисто"}\n',
        ]);
        expect(disk.state.cardReview).toMatchObject({
            sessions: 6,
            failedSessions: 1,
            rounds: 0,
            verdict: null,
            pending: null,
        });
        expect(disk.state.cardHistory).toHaveLength(1);
        expect(disk.state.cardHistory?.[0]).toMatchObject({ outcome: 'blocked', head: A });
        expect(disk.labels).toEqual([{ name: 'blocked' }]);
        expect(process.logs.join('\n')).toContain('card-review-limit');
        expect(process.logs.join('\n')).not.toContain('review-no-verdict');
    });

    it('отвергнутый разбором батч не становится вердиктом и не повторяется как транзиент', () => {
        const disk = diskOf(card());
        const process = runProcess(disk, {
            apply: () => ({
                applied: 0,
                failed: true,
                closedIssues: [],
                rejected: { quarantined: 'карантин', refusal: null },
            }),
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(disk.state.cardReview).toMatchObject({
            failedSessions: 1,
            rounds: 0,
            pending: null,
        });
        expect(process.logs.join('\n')).toContain('review-no-verdict');
    });

    it('minor/nit не держат закрытие: уходят в журнал, карточка закрыта комментарием кодера', () => {
        const disk = diskOf(card({ closeComment: 'комментарий кодера' }));
        const process = runProcess(disk, {
            over: {
                once: false,
                phaseIndexOfFn: () => (disk.open ? 0 : 99),
            },
            apply: (options) => {
                const stage = options.cardStage as {
                    role: string;
                    saveBatchFn?: (batch: TCardBatch) => void;
                };
                if (stage.role === 'review') {
                    stage.saveBatchFn?.({
                        ...CLEAN,
                        findings: [
                            {
                                severity: 'minor',
                                comment: '🟡 [minor] замечание',
                                anchor: { path: 'core/a.ts', line: 1 },
                            },
                            {
                                severity: 'nit',
                                comment: '⚪ [nit] стиль',
                                anchor: { path: 'core/a.ts', line: 2 },
                            },
                        ],
                    });
                }
                if (stage.role === 'closing') disk.open = false;
                disk.requests = null;
                return { applied: 0, failed: false, closedIssues: [] };
            },
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(disk.state.cardHistory?.[0]).toMatchObject({
            outcome: 'closed',
            verdict: 'clean',
            head: A,
        });
        expect(disk.state.cardHistory?.[0].findings.map((finding) => finding.status)).toEqual([
            'journal',
            'journal',
        ]);
        expect(disk.writes[0]).toContain('комментарий кодера');
    });
});

describe('ревью карточки: правки, предел и рестарт', () => {
    it('постановка ветки перед запуском правки отклонена: счётчики и pending не меняются', () => {
        const disk = diskOf(reviewed({ sessions: 3, failedSessions: 1 }));
        const before = structuredClone(disk.state.cardReview);
        let placements = 0;
        const process = runProcess(disk, {
            over: {
                ensurePhaseBranchFn: () => {
                    placements += 1;
                    return placements === 1
                        ? { kind: 'switched' as const, branch: 'feature/m1', sha: A }
                        : {
                              kind: 'failed' as const,
                              branch: 'feature/m1',
                              sha: null,
                              reason: 'ветка не встала',
                          };
                },
            },
        });
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(process.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(disk.state.cardReview).toEqual(before);
        expect(disk.state.cardReview).toMatchObject({
            sessions: 3,
            failedSessions: 1,
            pending: null,
        });
        expect(process.logs.join('\n')).toContain('правки карточки #7');
    });

    it('4. saved=false после спавна правок: батч в карантине, пуш довезён, идёт новое ревью', () => {
        const disk = diskOf(
            reviewed({ sessions: 3, pending: { role: 'fix', head: A, saved: false } }),
            {
                requests: '{"kind":"card-fix","issue":7,"finding":"F1","test":"не принимать"}\n',
            },
        );
        const pushSessionCommitsFn = vi.fn(() => ({ kind: 'in-sync' as const }));
        const process = runProcess(disk, {
            head: B,
            over: { pushSessionCommitsFn },
        });
        expect(disk.quarantined).toHaveLength(1);
        expect(pushSessionCommitsFn).toHaveBeenCalled();
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(process.prompts[0]).toContain('code review');
        expect(disk.state.cardReview).toMatchObject({
            failedSessions: 1,
            pending: null,
            findings: [{ id: 'F1', status: 'open', test: null }],
        });
    });

    it('4. code !== 0 у правок даёт тот же исход без обрыва процесса', () => {
        const disk = diskOf(reviewed({ sessions: 3 }));
        let runs = 0;
        let phases = 0;
        let currentHead = A;
        const pushSessionCommitsFn = vi.fn(() => ({ kind: 'in-sync' as const }));
        const process = runProcess(disk, {
            run: () => {
                runs += 1;
                if (runs === 1) {
                    disk.requests =
                        '{"kind":"card-fix","issue":7,"finding":"F1","test":"не принимать"}\n';
                    currentHead = B;
                    return 1;
                }
                return 0;
            },
            over: {
                once: false,
                phaseIndexOfFn: () => (phases++ < 2 ? 0 : 99),
                shFn: () => currentHead,
                branchHeadShaFn: () => currentHead,
                pushSessionCommitsFn,
            },
        });
        expect(process.runClaudeFn).toHaveBeenCalledTimes(2);
        expect(process.prompts[1]).toContain('code review');
        expect(disk.quarantined).toHaveLength(1);
        expect(pushSessionCommitsFn).toHaveBeenCalled();
        expect(disk.state.cardReview).toMatchObject({
            failedSessions: 1,
            pending: null,
            rounds: 2,
        });
    });

    it('5. saved=true: неизвестный ответ comment оставляет pending, рестарт доводит block ролью fix', () => {
        const requests =
            '{"kind":"comment","issue":7,"comment":"правка"}\n' +
            '{"kind":"block","issue":7,"comment":"ещё не начат"}\n';
        const disk = diskOf(
            reviewed({
                findings: [
                    {
                        ...reviewed().findings[0],
                        status: 'fixed' as const,
                        test: 'отказ воспроизведён',
                    },
                ],
                pending: { role: 'fix', head: A, saved: true },
            }),
            { requests },
        );
        const first = runProcess(disk, {
            head: B,
            apply: () => ({ applied: 0, failed: true, outcomeUnknown: true, closedIssues: [] }),
        });
        expect(first.runClaudeFn).not.toHaveBeenCalled();
        expect(disk.requests).toBe(requests);
        expect(disk.state.cardReview?.pending).toEqual({ role: 'fix', head: A, saved: true });

        const second = runProcess(disk, { head: B });
        const stages = second.applySessionRequestsFn.mock.calls.map(
            (call) => call[0].cardStage as { role: string; saveBatchFn?: unknown },
        );
        expect(stages[0]).toMatchObject({ role: 'fix' });
        expect(stages[0].saveBatchFn).toBeUndefined();
        expect(disk.requests).toBeNull();
        expect(disk.state.cardReview?.findings[0]).toMatchObject({
            status: 'fixed',
            test: 'отказ воспроизведён',
        });
        expect(second.runClaudeFn).toHaveBeenCalledTimes(1);
    });

    it('6. названного теста нет в добавленных строках: находка открыта с причиной', () => {
        const disk = diskOf(reviewed());
        runProcess(disk, {
            run: () => {
                disk.requests =
                    '{"kind":"card-fix","issue":7,"finding":"F1","test":"отказ [x]+"}\n';
                return 0;
            },
            apply: (options) => {
                const stage = options.cardStage as {
                    saveBatchFn?: (batch: TCardBatch) => void;
                };
                stage.saveBatchFn?.({
                    ...EMPTY,
                    fixes: [{ finding: 'F1', test: 'отказ [x]+' }],
                });
                disk.requests = null;
                return { applied: 0, failed: false, closedIssues: [] };
            },
            over: {
                shFn: (cmd: string) =>
                    cmd.startsWith('git diff ')
                        ? "-    it('отказ [x]+', () => {})\n+    // отказ [x]+"
                        : A,
            },
        });
        expect(disk.state.cardReview?.findings[0]).toMatchObject({
            status: 'open',
            note: 'тест отказ [x]+ не найден в добавленных строках диффа правок',
        });
        expect(disk.state.cardReview?.pending).toBeNull();
    });

    it('доказательство текущей правки читается из диффа pending.head', () => {
        const disk = diskOf(reviewed({ lastReviewedHead: B, sessions: 3 }));
        const diffs: string[] = [];
        runProcess(disk, {
            head: B,
            run: () => {
                disk.requests =
                    '{"kind":"card-fix","issue":7,"finding":"F1","test":"текущая правка"}\n';
                return 0;
            },
            apply: (options) => {
                const stage = options.cardStage as {
                    saveBatchFn?: (batch: TCardBatch) => void;
                };
                stage.saveBatchFn?.({
                    ...EMPTY,
                    fixes: [{ finding: 'F1', test: 'текущая правка' }],
                });
                disk.requests = null;
                return { applied: 0, failed: false, closedIssues: [] };
            },
            over: {
                shFn: (cmd: string) => {
                    if (cmd.startsWith('git diff ')) {
                        diffs.push(cmd);
                        return "+    test.each([])('текущая правка', () => {})";
                    }
                    return B;
                },
            },
        });
        expect(diffs).toEqual([`git diff ${B}..HEAD`]);
        expect(disk.state.cardReview?.findings[0]).toMatchObject({
            status: 'fixed',
            test: 'текущая правка',
        });
    });

    it('6. дифф правок не прочитался: находки не тронуты, pending.saved остаётся false', () => {
        const disk = diskOf(reviewed());
        const before = structuredClone(disk.state.cardReview?.findings);
        runProcess(disk, {
            run: () => {
                disk.requests = '{"kind":"card-fix","issue":7,"finding":"F1","test":"отказ"}\n';
                return 0;
            },
            apply: (options) => {
                const stage = options.cardStage as {
                    saveBatchFn?: (batch: TCardBatch) => void;
                };
                try {
                    stage.saveBatchFn?.({
                        ...EMPTY,
                        fixes: [{ finding: 'F1', test: 'отказ' }],
                    });
                } catch {
                    return { applied: 0, failed: true, outcomeUnknown: true, closedIssues: [] };
                }
                return { applied: 0, failed: false, closedIssues: [] };
            },
            over: {
                shFn: (cmd: string) => {
                    if (cmd.startsWith('git diff ')) throw new Error('git diff лёг');
                    return A;
                },
            },
        });
        expect(disk.state.cardReview?.findings).toEqual(before);
        expect(disk.state.cardReview?.pending).toEqual({ role: 'fix', head: A, saved: false });
    });

    it('9. убит после limitHead до block: рестарт ставит метку, история остаётся одной', () => {
        const disk = limitedDisk({ limitHead: A });
        const process = runProcess(disk);
        expect(disk.writes).toHaveLength(1);
        expect(disk.writes[0]).toContain('"kind":"block"');
        expect(process.applySessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(process.applySessionRequestsFn.mock.calls[0][0].cardStage).toBeUndefined();
        expect(disk.state.cardHistory).toHaveLength(1);
        expect(disk.state.cardReview?.limitHead).toBe(A);
        expect(process.logs.join('\n')).toContain('card-review-limit');
    });

    it('10. block выбыл: стоп «метка не легла», повторный старт пробует снова без дубля истории', () => {
        const disk = diskOf(reviewed({ rounds: 3, sessions: 3 }));
        const first = runProcess(disk, {
            apply: () => {
                disk.requests = null;
                return {
                    applied: 0,
                    failed: false,
                    closedIssues: [],
                    dropped: [{ kind: 'block', what: 'отказ по существу' }],
                };
            },
        });
        expect(first.logs.join('\n')).toContain('метка не легла');
        expect(disk.state.cardHistory).toHaveLength(1);

        runProcess(disk);
        expect(disk.writes).toHaveLength(2);
        expect(disk.state.cardHistory).toHaveLength(1);
        expect(disk.labels).toEqual([{ name: 'blocked' }]);
    });

    it('11. непустой файл на шаге предела: block не записан, close не применён', () => {
        const disk = diskOf(reviewed({ rounds: 3, sessions: 3 }), {
            requests: `${serializeSessionRequest({ kind: 'close', issue: 7, comment: 'чужой' })}\n`,
        });
        const process = runProcess(disk);
        expect(process.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(disk.writes).toHaveLength(0);
        expect(disk.state.cardHistory ?? []).toEqual([]);
        expect(disk.state.cardReview?.limitHead).toBeNull();
        expect(process.logs.join('\n')).toContain('card-review-limit');
    });

    it('12. предел при firstHead === HEAD и карточке вне очереди: запись цела, следующая не взята', () => {
        const disk = limitedDisk({ limitHead: A });
        disk.labels = [{ name: 'blocked' }];
        const process = runProcess(disk, {
            over: {
                openIssuesFn: () => [{ number: 8, title: 'следующая' }],
                getIssueFn: (number: number) => ({
                    number,
                    title: 'карточка',
                    body: 'тело',
                    open: true,
                }),
            },
        });
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(process.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(disk.state.cardReview).toMatchObject({ issue: 7, limitHead: A });
        expect(disk.state.cardHistory).toHaveLength(1);
        expect(process.logs.join('\n')).toContain('card-review-limit');
    });

    it('13. предел поднят и blocked снят: работа продолжается без сброса счётчиков', () => {
        const disk = diskOf(reviewed({ rounds: 2, sessions: 2, limitHead: A }));
        const process = runProcess(disk);
        expect(process.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(process.prompts[0]).toContain('F1');
        expect(disk.state.cardReview).toMatchObject({
            rounds: 2,
            sessions: 3,
            limitHead: A,
            pending: null,
        });
    });

    it('13. человек закрыл карточку после предела: closed-external, запись снята, следующая взята', () => {
        const disk = limitedDisk({ limitHead: A });
        disk.open = false;
        runProcess(disk, {
            over: {
                openIssuesFn: () => [{ number: 8, title: 'следующая' }],
                allOpenIssuesFn: () => [],
                getIssueFn: (number: number) => ({
                    number,
                    title: 'карточка',
                    body: 'тело',
                    open: number === 8,
                }),
            },
        });
        expect(disk.state.cardHistory).toHaveLength(2);
        expect(disk.state.cardHistory?.[1]).toMatchObject({ outcome: 'closed-external' });
        expect(disk.state.cardReview).toMatchObject({ issue: 8 });
    });

    it('14. closeComment=null при исчерпанном бюджете: limit, а в пакете ревью «ещё не было»', () => {
        const disk = diskOf(card({ closeComment: null, sessions: 8 }));
        const process = runProcess(disk);
        expect(process.runClaudeFn).not.toHaveBeenCalled();
        expect(disk.writes).toHaveLength(1);
        expect(disk.writes[0]).toContain('"kind":"block"');
        expect(disk.writes[0]).toContain('ещё не было');
        expect(disk.state.cardHistory?.[0]).toMatchObject({ outcome: 'blocked', head: A });
    });
});

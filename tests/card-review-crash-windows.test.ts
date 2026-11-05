// S2f: стадия ревью карточки обязана переживать kill -9 на каждой границе состояния,
// сессии и эффекта. Мир переживает процесс, поэтому повтор видит ровно то, что успело
// сохраниться; непрерванные следы фиксируют все переходы и не дают добавить эффект мимо
// матрицы. После восстановления закрытие и его комментарий остаются одноразовыми.
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов, как в соседних матрицах.
import ralph from '../ralph.js';
import { newCardProgress, type TCardBatch, type TCardProgress } from '../core/card-review.ts';
import type { RalphState } from '../core/state-lock.ts';
import { serializeSessionRequest } from '../core/session-requests.ts';
import { Killed, world } from './crash-world.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralph.runLoop as Runtime['runLoop'];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const STARTED_AT = '2026-11-05T10:00:00.000Z';
const FINISHED_AT = '2026-11-05T10:01:00.000Z';
const CLOSE_REQUEST = `${serializeSessionRequest({ kind: 'close', issue: 7, comment: 'сделано' })}\n`;
const FIX_REQUEST = `${serializeSessionRequest({ kind: 'card-fix', issue: 7, finding: 'F1', test: 'отказ' })}\n`;
const CLEAN: TCardBatch = {
    deferredClose: null,
    summary: '⚪ [nit] чисто',
    blocked: null,
    findings: [],
    fixes: [],
};

const CLOSE_STEPS = [
    'request-close',
    'push-before-review',
    'pending-review',
    'spawn-review',
    'review-state',
    'review-effects',
    'push-before-review',
    'closing',
    'close-intent',
    'close-comment',
    'close-forge',
    'history',
] as const;
const FIX_STEPS = [
    'push-before-review',
    'pending-fix',
    'commit-fix',
    'push-fix',
    'fix-state',
    'fix-effects',
    'push-before-review',
    'pending-review',
    'spawn-review',
    'review-state',
    'review-effects',
    'push-before-review',
    'closing',
    'close-intent',
    'close-comment',
    'close-forge',
    'history',
] as const;
const LIMIT_STEPS = [
    'push-before-review',
    'history',
    'limitHead',
    'block-intent',
    'block-label',
] as const;
const EXTERNAL_STEPS = ['external-close', 'history'] as const;
const NO_VERDICT_STEPS = [
    'push-before-review',
    'pending-review',
    'spawn-review',
    'review-no-verdict',
] as const;
const LOST_COMMENT_STEPS = [
    'push-before-review',
    'closing',
    'close-intent',
    'close-comment',
    'comment-response-lost',
] as const;

type Scenario =
    | 'close'
    | 'fix'
    | 'limit'
    | 'external'
    | 'no-verdict'
    | 'lost-reconciled'
    | 'lost-label-missing'
    | 'lost-comments-unreadable';
type KillAt = { step: string; when: 'before' | 'after'; occurrence?: number };
type TDisk = {
    state: RalphState;
    requests: string | null;
    open: boolean;
    labels: Array<{ name: string }>;
    head: string;
    comments: string[];
    closeAttempts: number;
    reviewEffectKeys: string[];
    fixEffectKeys: string[];
    quarantined: string[];
    writes: string[];
    removed: number;
};
type TApply = (options: Record<string, unknown>) => Record<string, unknown>;

function card(over: Partial<TCardProgress> = {}): TCardProgress {
    return {
        ...newCardProgress({ issue: 7, milestone: 'M1', firstHead: A, startedAt: STARTED_AT }),
        closeComment: 'сделано',
        sessions: 1,
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
        cardHistory: [],
    };
}

function diskOf(scenario: Scenario): TDisk {
    const progress =
        scenario === 'close'
            ? card({ closeComment: null })
            : scenario === 'fix'
              ? reviewed()
              : scenario === 'limit'
                ? reviewed({ rounds: 3, sessions: 3 })
                : scenario === 'external'
                  ? card({ closeComment: null })
                  : scenario === 'no-verdict'
                    ? card()
                    : card({
                          verdict: 'clean',
                          lastReviewedHead: A,
                          rounds: 1,
                          sessions: 2,
                      });
    return {
        state: stateOf(progress),
        requests: scenario === 'close' ? CLOSE_REQUEST : null,
        open: scenario !== 'external',
        labels: [],
        head: A,
        comments: [],
        closeAttempts: 0,
        reviewEffectKeys: [],
        fixEffectKeys: [],
        quarantined: [],
        writes: [],
        removed: 0,
    };
}

function runProcess(
    disk: TDisk,
    scenario: Scenario,
    {
        killAt = null,
        allowLoss = false,
        baseReview = false,
        over = {},
    }: {
        killAt?: KillAt | null;
        allowLoss?: boolean;
        baseReview?: boolean;
        over?: Record<string, unknown>;
    } = {},
) {
    const w = world();
    const logs: string[] = [];
    const prompts: string[] = [];
    const trace: string[] = [];
    const occurrences = new Map<string, number>();
    let fired = false;
    let killed = false;
    const state = structuredClone(disk.state);
    const effect = <R>(step: string, act: () => R): R => {
        w.alive();
        const occurrence = (occurrences.get(step) ?? 0) + 1;
        occurrences.set(step, occurrence);
        const hit =
            killAt !== null &&
            !fired &&
            killAt.step === step &&
            (killAt.occurrence ?? 1) === occurrence;
        if (hit) fired = true;
        if (hit && killAt.when === 'before') w.kill();
        const result = act();
        trace.push(step);
        if (hit && killAt.when === 'after') w.kill();
        return result;
    };
    const read = <R>(act: () => R): R => {
        w.alive();
        return act();
    };
    const runClaudeFn = vi.fn((prompt: string) => {
        prompts.push(prompt);
        if (prompt.includes('code review карточки')) {
            effect('spawn-review', () => {
                const firstNoVerdict =
                    scenario === 'no-verdict' &&
                    state.cardReview?.rounds === 0 &&
                    state.cardReview.failedSessions === 0;
                disk.requests = firstNoVerdict
                    ? null
                    : `${serializeSessionRequest({ kind: 'card-comment', issue: 7, comment: '⚪ [nit] чисто' })}\n`;
            });
        } else if (prompt.includes('Исправь находки ревью карточки')) {
            effect('commit-fix', () => {
                disk.head = B;
                disk.requests = FIX_REQUEST;
            });
        }
        return 0;
    });
    const lost = (): Record<string, unknown> => {
        logs.push('⛔ Ralph: (intent-unknown) ответ форжа при комментарии закрытия потерян');
        effect('comment-response-lost', () => {});
        return { applied: 0, failed: true, outcomeUnknown: true, closedIssues: [] };
    };
    const applySessionRequestsFn = vi.fn((options: Record<string, unknown>) => {
        const stage = options.cardStage as
            { role: string; saveBatchFn?: (batch: TCardBatch) => void } | undefined;
        if (stage?.role === 'coder') {
            stage.saveBatchFn?.({ ...CLEAN, summary: null, deferredClose: 'сделано' });
            disk.requests = null;
        } else if (stage?.role === 'review') {
            const firstNoVerdict =
                scenario === 'no-verdict' &&
                state.cardReview?.rounds === 0 &&
                state.cardReview.failedSessions === 0;
            if (!firstNoVerdict) {
                stage.saveBatchFn?.(CLEAN);
                const key = `${state.cardReview?.lastReviewedHead ?? ''}:${String(state.cardReview?.rounds ?? 0)}`;
                if (!disk.reviewEffectKeys.includes(key)) {
                    effect('review-effects', () => {
                        disk.reviewEffectKeys.push(key);
                        disk.requests = null;
                    });
                } else {
                    disk.requests = null;
                }
            }
        } else if (stage?.role === 'fix') {
            stage.saveBatchFn?.({
                ...CLEAN,
                summary: null,
                fixes: [{ finding: 'F1', test: 'отказ' }],
            });
            const key = `${state.cardReview?.pending?.head ?? ''}:${String(state.cardReview?.rounds ?? 0)}`;
            if (!disk.fixEffectKeys.includes(key)) {
                effect('fix-effects', () => {
                    disk.fixEffectKeys.push(key);
                    disk.requests = null;
                });
            } else {
                disk.requests = null;
            }
        } else if (stage?.role === 'closing') {
            if (!disk.comments.includes('сделано')) {
                effect('close-comment', () => {
                    disk.comments.push('сделано');
                });
            }
            if (scenario === 'lost-label-missing' || scenario === 'lost-comments-unreadable') {
                return lost();
            }
            if (scenario === 'lost-reconciled' && allowLoss) return lost();
            if (disk.open) {
                effect('close-forge', () => {
                    disk.closeAttempts += 1;
                    disk.open = false;
                });
            }
            disk.requests = null;
        } else if (stage === undefined) {
            if (!disk.labels.some((label) => label.name === 'blocked')) {
                effect('block-label', () => {
                    disk.labels = [{ name: 'blocked' }];
                });
            }
            disk.requests = null;
        }
        return { applied: 0, failed: false, closedIssues: [] };
    });
    const saveStateFn = (saved: RalphState): void => {
        read(() => {});
        const previous = disk.state;
        const before = previous.cardReview;
        const after = saved.cardReview;
        const steps: string[] = [];
        if (before?.closeComment == null && after?.closeComment != null) {
            steps.push('request-close');
        }
        if (after?.pending !== null && after?.pending?.saved === false) {
            if (before?.pending?.saved !== false) {
                steps.push(after.pending.role === 'review' ? 'pending-review' : 'pending-fix');
            }
        }
        if (before?.pending?.saved === false && after?.pending?.saved === true) {
            steps.push(after.pending.role === 'review' ? 'review-state' : 'fix-state');
        }
        if (before?.closing == null && after?.closing != null) steps.push('closing');
        if ((saved.cardHistory?.length ?? 0) > (previous.cardHistory?.length ?? 0)) {
            steps.push('history');
        }
        if (before?.limitHead == null && after?.limitHead != null) steps.push('limitHead');
        const next = structuredClone(saved);
        if (steps.length === 0) {
            disk.state = next;
            return;
        }
        for (const [index, step] of steps.entries()) {
            effect(step, () => {
                if (index === 0) disk.state = next;
            });
        }
    };
    const pushEventFn = (message: string): boolean => {
        if (message.includes('review-no-verdict')) {
            effect('review-no-verdict', () => {
                logs.push(message);
            });
        } else {
            read(() => logs.push(message));
        }
        return false;
    };
    const createPrFn = vi.fn(() => 7);
    const deps = {
        once: false,
        dry: false,
        logFn: (message: string) => read(() => logs.push(message)),
        pushEventFn,
        shFn: (command: string) =>
            read(() =>
                command.startsWith('git diff ') ? "+    it('отказ', () => {})" : disk.head,
            ),
        runArgvFn: () => '',
        saveStateFn,
        phaseIndexOfFn: () => (state.cardReview == null && !disk.open ? 99 : 0),
        openIssuesFn: () => read(() => (disk.open ? [{ number: 7, title: 'карточка' }] : [])),
        allOpenIssuesFn: () =>
            read(() => (disk.open ? [{ number: 7, title: 'карточка', labels: disk.labels }] : [])),
        getIssueFn: () => {
            const details = { number: 7, title: 'карточка', body: 'тело', open: disk.open };
            return scenario === 'external' && state.cardReview != null
                ? effect('external-close', () => details)
                : read(() => details);
        },
        ensureCleanFn: () => true,
        commitLeftoversFn: () => true,
        ensurePhaseBranchFn: (branch: string) => ({
            kind: 'switched' as const,
            branch,
            sha: disk.head,
        }),
        checkOnPhaseBranchFn: () => ({ ok: true, sha: disk.head }),
        ensureMonitorAliveFn: () => null,
        syncProjectBoardFn: () => {},
        pickRouteFn: () => ({ provider: 'claude', model: 'coder' }),
        pickReviewModelFn: () => 'reviewer',
        phaseDiffFilesFn: () => ['core/a.ts'],
        phaseDiffLinesFn: () => 10,
        reviewDiffContextFn: () => '<дифф карточки>',
        branchHeadShaFn: () => read(() => disk.head),
        branchPushedFn: () => true,
        pushSessionCommitsFn: () =>
            effect(
                state.cardReview?.pending?.role === 'fix' ? 'push-fix' : 'push-before-review',
                () => ({ kind: 'in-sync' as const }),
            ),
        readSessionRequestsFn: () => read(() => disk.requests),
        writeSessionRequestsFn: (text: string) => {
            const step = text.includes('"kind":"close"') ? 'close-intent' : 'block-intent';
            effect(step, () => {
                disk.writes.push(text);
                disk.requests = text;
            });
        },
        removeSessionRequestsFn: () => {
            read(() => {
                disk.removed += 1;
                disk.requests = null;
            });
        },
        quarantineSessionRequestsFn: () => {
            read(() => {
                if (disk.requests !== null) disk.quarantined.push(disk.requests);
                disk.requests = null;
            });
            return 'карантин';
        },
        nowFn: () => Date.parse(FINISHED_AT),
        sleepFn: () => {},
        runClaudeFn,
        applySessionRequestsFn,
        findOpenPrFn: () => null,
        createPrFn,
        phasePrBodyFn: () => 'тело PR',
        prCommentsFn: () => [],
        hasAnyIssuesFn: () => true,
        phaseMergedFn: () => scenario === 'external',
        mergedPhasePrFn: () => null,
        advancePhaseFn: () => {},
        tryMergePhaseFn: () => 'not-merged',
        closeMilestoneByTitleFn: () => {},
        removeBlockedLabelFn: () => {},
        prHasBlockedLabelFn: () => true,
        recordReviewFindingsFn: () => {},
        createIssueFn: () => 1,
        recordFixReviewFindingsFn: () => {},
        getLastRedCheck: () => null,
        ...over,
    } as never;
    try {
        runLoop(
            {
                model: 'claude-coder',
                prompt: 'сделай {milestone} в ветке {branch}',
                authorAllowlist: ['owner'],
                phases: [
                    {
                        milestone: 'M1',
                        branch: 'feature/m1',
                        ...(baseReview ? { reviewBase: A } : {}),
                    },
                ],
                gate: { checks: [['test', 'npm test']] },
                review: { cardReview: true, default: 'reviewer' },
            },
            { state, maxIterations: 20, maxTurns: 80 },
            deps,
        );
    } catch (error) {
        if (!(error instanceof Killed)) throw error;
        killed = true;
    }
    return {
        logs,
        prompts,
        trace,
        runClaudeFn,
        applySessionRequestsFn,
        createPrFn,
        fired,
        killed,
    };
}

function settle(disk: TDisk, scenario: Scenario): void {
    for (
        let attempt = 0;
        attempt < 3 && (disk.state.cardReview != null || disk.open);
        attempt += 1
    ) {
        if (
            scenario === 'limit' ||
            scenario === 'lost-label-missing' ||
            scenario === 'lost-comments-unreadable'
        ) {
            runProcess(disk, scenario);
            return;
        }
        runProcess(disk, scenario);
        if (scenario === 'no-verdict' && disk.state.cardReview?.pending !== null) return;
    }
}

function crashCases(steps: readonly string[]): Array<[Scenario, KillAt]> {
    return [...new Set(steps)].flatMap((step) => {
        const occurrences = steps.filter((candidate) => candidate === step).length;
        return Array.from({ length: occurrences }, (_, index) => index + 1).flatMap((occurrence) =>
            (['before', 'after'] as const).map(
                (when) => ['close', { step, when, occurrence }] as [Scenario, KillAt],
            ),
        );
    });
}

function expectedCounters(
    scenario: Scenario,
    killAt: KillAt | null,
): { rounds: number; sessions: number; failedSessions: number } {
    if (scenario === 'limit') return { rounds: 3, sessions: 3, failedSessions: 0 };
    if (scenario === 'external') return { rounds: 0, sessions: 1, failedSessions: 0 };
    if (scenario === 'no-verdict') return { rounds: 1, sessions: 3, failedSessions: 1 };
    if (scenario.startsWith('lost-')) return { rounds: 1, sessions: 2, failedSessions: 0 };
    if (scenario === 'close') {
        const failed =
            killAt !== null &&
            ((killAt.step === 'pending-review' && killAt.when === 'after') ||
                killAt.step === 'spawn-review' ||
                (killAt.step === 'review-state' && killAt.when === 'before'));
        return failed
            ? { rounds: 1, sessions: 3, failedSessions: 1 }
            : { rounds: 1, sessions: 2, failedSessions: 0 };
    }
    const lostFix =
        killAt !== null &&
        ((killAt.step === 'pending-fix' && killAt.when === 'after') ||
            killAt.step === 'commit-fix' ||
            killAt.step === 'push-fix' ||
            (killAt.step === 'fix-state' && killAt.when === 'before'));
    const failedReview =
        killAt !== null &&
        ((killAt.step === 'pending-review' && killAt.when === 'after') ||
            killAt.step === 'spawn-review' ||
            (killAt.step === 'review-state' && killAt.when === 'before'));
    if (lostFix || failedReview) return { rounds: 2, sessions: 5, failedSessions: 1 };
    return { rounds: 2, sessions: 4, failedSessions: 0 };
}

function expectStableAfterRecovery(
    scenario: Scenario,
    steps: readonly string[],
    killAt: KillAt | null,
): void {
    const disk = diskOf(scenario);
    if (killAt !== null) {
        const crashed = runProcess(disk, scenario, { killAt, allowLoss: true });
        expect(crashed.killed).toBe(true);
        expect(crashed.fired).toBe(true);
        settle(disk, scenario);
    } else {
        runProcess(disk, scenario, { allowLoss: true });
        settle(disk, scenario);
    }
    const terminalLogs = runProcess(disk, scenario).logs.join('\n');
    const last = disk.state.cardHistory?.at(-1);
    if (scenario === 'limit') {
        expect(terminalLogs).toContain('card-review-limit');
        expect(last).toMatchObject({ outcome: 'blocked', ...expectedCounters(scenario, killAt) });
    } else if (scenario === 'lost-label-missing' || scenario === 'lost-comments-unreadable') {
        expect(terminalLogs).toContain('intent-unknown');
        expect(disk.open).toBe(true);
        expect(disk.state.cardReview?.closing).toBe(A);
    } else {
        expect(last).toMatchObject({
            outcome: scenario === 'external' ? 'closed-external' : 'closed',
            ...expectedCounters(scenario, killAt),
        });
        expect(disk.state.cardReview).toBeNull();
        expect(disk.open).toBe(false);
        if (scenario !== 'external') {
            expect(disk.closeAttempts).toBe(1);
            expect(disk.comments.filter((comment) => comment === 'сделано')).toHaveLength(1);
            expect(disk.writes.filter((text) => text.includes('"kind":"close"'))).toHaveLength(1);
        }
    }
    const snapshot = JSON.stringify(disk);
    runProcess(disk, scenario);
    expect(JSON.stringify(disk)).toBe(snapshot);
}

describe('ревью карточки: непрерванные следы переходов', () => {
    it.each([
        ['close', CLOSE_STEPS],
        ['fix', FIX_STEPS],
        ['limit', LIMIT_STEPS],
        ['external', EXTERNAL_STEPS],
        ['no-verdict', NO_VERDICT_STEPS],
        ['lost-reconciled', LOST_COMMENT_STEPS],
        ['lost-label-missing', LOST_COMMENT_STEPS],
        ['lost-comments-unreadable', LOST_COMMENT_STEPS],
    ] as const)('%s: каждый эффект назван и порядок точный', (scenario, steps) => {
        const result = runProcess(diskOf(scenario), scenario, { allowLoss: true });
        expect(result.trace).toEqual([...steps]);
        expectStableAfterRecovery(scenario, steps, null);
    });
});

describe('ревью карточки: обрыв до и после каждого перехода', () => {
    it.each([
        ...crashCases(CLOSE_STEPS).map(([, kill]) => ['close', kill] as const),
        ...crashCases(FIX_STEPS).map(([, kill]) => ['fix', kill] as const),
        ...crashCases(LIMIT_STEPS).map(([, kill]) => ['limit', kill] as const),
        ...crashCases(EXTERNAL_STEPS).map(([, kill]) => ['external', kill] as const),
        ...crashCases(NO_VERDICT_STEPS).map(([, kill]) => ['no-verdict', kill] as const),
        ...crashCases(LOST_COMMENT_STEPS).flatMap(([, kill]) =>
            (['lost-reconciled', 'lost-label-missing', 'lost-comments-unreadable'] as const).map(
                (scenario) => [scenario, kill] as const,
            ),
        ),
    ])('%s: %o → рестарт доводит без дублей', (scenario, killAt) => {
        const steps =
            scenario === 'close'
                ? CLOSE_STEPS
                : scenario === 'fix'
                  ? FIX_STEPS
                  : scenario === 'limit'
                    ? LIMIT_STEPS
                    : scenario === 'external'
                      ? EXTERNAL_STEPS
                      : scenario === 'no-verdict'
                        ? NO_VERDICT_STEPS
                        : LOST_COMMENT_STEPS;
        expectStableAfterRecovery(scenario, steps, killAt);
    });
});

describe('ревью карточки: отказы чтений до сессии и эффектов', () => {
    it.each([
        [
            'голова',
            {
                shFn: () => {
                    throw new Error('git лёг');
                },
            },
            'card-unreviewed',
        ],
        ['список файлов диффа', { phaseDiffFilesFn: () => null }, 'card-unreviewed'],
        [
            'текст диффа',
            {
                reviewDiffContextFn: () => {
                    throw new Error('diff лёг');
                },
            },
            'card-unreviewed',
        ],
    ])('%s не прочиталась → стоп с причиной, ни сессии, ни эффекта', (_name, over, reason) => {
        const disk = diskOf('close');
        disk.state.cardReview = card();
        disk.requests = null;
        const result = runProcess(disk, 'close', { over });
        expect(result.logs.join('\n')).toContain(reason);
        expect(result.runClaudeFn).not.toHaveBeenCalled();
        expect(result.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(disk.closeAttempts).toBe(0);
        expect(disk.comments).toEqual([]);
        expect(disk.writes).toEqual([]);
    });

    it('allOpenIssuesFn не прочиталась → сдача остановлена до PR и сессии', () => {
        const disk = diskOf('close');
        disk.state.cardReview = null;
        disk.open = false;
        const result = runProcess(disk, 'close', {
            over: {
                phaseIndexOfFn: () => 0,
                allOpenIssuesFn: () => {
                    throw new Error('лента легла');
                },
            },
        });
        expect(result.logs.join('\n')).toContain('не смог проверить открытые issues');
        expect(result.createPrFn).not.toHaveBeenCalled();
        expect(result.runClaudeFn).not.toHaveBeenCalled();
        expect(result.applySessionRequestsFn).not.toHaveBeenCalled();
    });

    it('phaseMergedFn не прочиталась → сдача остановлена до PR и сессии', () => {
        const disk = diskOf('close');
        disk.state.cardReview = null;
        disk.open = false;
        const result = runProcess(disk, 'close', {
            over: {
                phaseIndexOfFn: () => 0,
                phaseMergedFn: () => {
                    throw new Error('статус не прочитался');
                },
            },
        });
        expect(result.logs.join('\n')).toContain('не смог проверить мердж-статус');
        expect(result.createPrFn).not.toHaveBeenCalled();
        expect(result.runClaudeFn).not.toHaveBeenCalled();
        expect(result.applySessionRequestsFn).not.toHaveBeenCalled();
    });

    it('listIssueComments не прочиталась → forge-unreadable до ревью-сессии', () => {
        const disk = diskOf('close');
        disk.state.cardReview = null;
        disk.open = false;
        const result = runProcess(disk, 'close', {
            baseReview: true,
            over: {
                phaseIndexOfFn: () => 0,
                findOpenPrFn: () => ({ number: 7, url: 'u' }),
                prCommentsFn: () => {
                    throw new Error('комментарии не прочитались');
                },
            },
        });
        expect(result.logs.join('\n')).toContain('forge-unreadable');
        expect(result.runClaudeFn).not.toHaveBeenCalled();
        expect(result.applySessionRequestsFn).not.toHaveBeenCalled();
        expect(disk.closeAttempts).toBe(0);
        expect(disk.comments).toEqual([]);
    });
});

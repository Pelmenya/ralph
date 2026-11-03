// Приёмочные (сценарные) тесты лестницы «ревью правок» (#625) — доказательство критериев
// готовности через ВЕСЬ цикл сдачи end-to-end, а не по кускам. Образец —
// blocked-scenarios.test.ts.
//
// Юнит-уровень (дедуп, потолок, анти-пинг-понг, форма карточек) живёт в
// core/review-of-fixes.test.ts; здесь проверяется, что настоящий runLoop действительно:
//   • гоняет второй проход ПО ДИФФУ ПРАВОК даже когда блокеров не было (симптом PR #624);
//   • не продлевает цикл потоком новых minor/nit и не стопорит ими мердж;
//   • на исчерпании потолка зовёт независимого арбитра и НЕ встаёт;
//   • пишет в журнал каждый проход отдельно — «сколько дефектов нашлось в правках».
//
// Побочки запрещены (RALPH_NO_SIDE_EFFECTS=1, общий afterEach в test-setup.ts): все
// коллабораторы инжектированы фейками, ни одного реального git/gh/диска.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import { LADDER_CARD_MARKER } from '../core/review-of-fixes.ts';
import type { RalphConfig } from '../core/orchestrator.ts';
import type { RalphState } from '../core/state-lock.ts';
import type { SessionPushResult } from '../core/session-push.ts';
import { normalizeReviewOfFixes } from '../core/review-of-fixes.ts';
import { withDefaultFixPlan } from './test-helpers.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralph.runLoop as Runtime['runLoop'];

const REVIEW_MODEL = 'claude-opus-4-8';
const ARBITER_MODEL = 'claude-fable-5';
const PR = 777;

// Маркеры диффов: по ним видно, ЧТО именно приложено к промпту прохода.
const PHASE_DIFF = '\n\nДИФФ-ФАЗЫ-ЦЕЛИКОМ';
const FIX_DIFF = '\n\nДИФФ-ТОЛЬКО-ПРАВОК';

// Промпты цикла различаем по их собственным формулировкам (prompts.ts), а не по порядку
// вызова: порядок как раз и есть предмет проверки.
const isFixReviewPrompt = (p: string) => p.includes('отревьюй ИМЕННО ЭТИ ПРАВКИ');
const isArbiterPrompt = (p: string) => p.includes('Ты независимый арбитр');
const isPhaseReviewPrompt = (p: string) => p.includes('проведи детальное code review');
const isFixPrompt = (p: string) => p.includes('Разбери замечания code review');
const isReReviewPrompt = (p: string) => p.includes('Ранее ревью пометило его меткой blocked');

type Finding = { comment: string; anchor?: { path: string; line: number } };
type PassResult = { findings: Finding[]; blocked?: boolean };

const at = (line: number, path = 'src/a.ts') => ({ path, line });
const blocker = (text: string, line: number) => ({
    comment: `🔴 [blocker] ${text}`,
    anchor: at(line),
});
const major = (text: string, line: number) => ({ comment: `🟠 [major] ${text}`, anchor: at(line) });
const minor = (text: string, line: number) => ({ comment: `🟡 [minor] ${text}`, anchor: at(line) });
const nit = (text: string, line: number) => ({ comment: `⚪ [nit] ${text}`, anchor: at(line) });

const cfg = (o: Partial<RalphConfig> = {}): RalphConfig => ({
    model: 'claude-coder',
    prompt: 'сделай {milestone} в ветке {branch}',
    authorAllowlist: ['owner'],
    phases: [{ milestone: 'M1', branch: 'feature/m1' }],
    // Роутинг кодер-модели по метке — как в боевом конфиге: по нему лестница понимает,
    // какие метки решают о модели, и снимает их со спорных карточек.
    modelRouting: {
        default: 'claude-coder',
        labels: { 'complexity:low': 'claude-haiku', 'complexity:high': 'claude-opus' },
    },
    review: {
        default: REVIEW_MODEL,
        escalated: REVIEW_MODEL,
        fallback: REVIEW_MODEL,
        arbiter: ARBITER_MODEL,
        maxTurns: 80,
        backlogLabels: ['complexity:low', 'area:core', 'backlog'],
    },
    gate: { checks: [['test', 'npm run test']] },
    ...o,
});

const mkState = (o: Partial<RalphState> = {}): RalphState => ({
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
    ...o,
});

// Один прогон полного цикла сдачи. `passes` — что приносит каждый очередной проход ревью
// правок, `arbiter` — что приносит независимый арбитр. Всё остальное — нейтральные фейки.
//
// `fixDiffFiles` — очередь ответов на «что изменила сессия правок» (по одному на круг
// лестницы, последний повторяется): `[]` = сессия ничего не запушила, `null` = дифф по
// базе не посчитался (git чихнул). Параметром, а не отдельной копией всей обвязки:
// дубль на ~70 строк уже разъезжался с оригиналом (в нём не было ни журнала, ни карточек,
// ни арбитра), и следующая правка обвязки поехала бы только в одну из копий.
function runPhase({
    passes = [] as PassResult[],
    arbiter = { findings: [] } as PassResult,
    gate = 'merged' as ReturnType<Runtime['tryMergePhase']>,
    config = cfg(),
    state = mkState(),
    dryRun = false,
    headSha = 'b'.repeat(40) as string | null,
    fixDiffFiles = [['src/a.ts']] as Array<string[] | null>,
    // #115-ревью: код возврата сессии АРБИТРА. Ненулевой — падение его сессии, а не
    // отказ по существу: состояние «арбитр отработал» при этом фиксироваться не должно.
    arbiterCode = 0,
    // Задача 40: код возврата остальных сессий по промпту и номеру вызова такого же
    // промпта (с нуля). `undefined` — штатный ноль.
    sessionCode = (() => undefined) as (prompt: string, nth: number) => number | undefined,
    // #16: сколько НЕЗАКРЫТЫХ карточек уже лежит в каждой накопительной вехе. Через тот же
    // шов, которым петля считает очередь фазы: потолок вехи считается её содержимым, а не
    // числом, которое тест мог бы подсунуть мимо форжа.
    backlogCounts = {} as Record<string, number>,
    // #65: ЗАКРЫТЫЕ вехи — разобранные тома. Прочие открыты: тесты потолка про статус не
    // говорят. Через шов статуса, а не наполнения: закрытый том пуст так же, как свежий.
    closedMilestones = [] as string[],
    // #65: форж не отдаёт статус вех вовсе — предохранитель fail-open обязан пережить и это.
    milestoneStatusThrows = false,
    // #18: карточки, которые УЖЕ лежат в вехе, целиком — с заголовком и датой. Счётчиком
    // (`backlogCounts`) срок годности не проверить: он синтезирует безымянные карточки,
    // а чистка отличает свою косметику от чужой карточки именно по заголовку.
    backlogIssues = {} as Record<
        string,
        Array<{ number: number; title: string; createdAt?: string; body?: string }>
    >,
    // Часы прогона — параметром: иначе тест на срок годности недетерминирован.
    now = Date.parse('2026-08-21T00:00:00Z'),
    // Задача 73: проводка с этим номером вызова (с нуля) отказывает, -1 — никогда. Номер
    // тест берёт из `placements` зелёного прогона: так он роняет проводку ИМЕННО той сессии,
    // которую проверяет, а не проводку итерации, стоящую раньше при том же числе сессий.
    failPlacementCall = -1,
    // Задача 79: чтение PR после записи метки blocked. `true` — метка встала, `false` —
    // запись молча не легла, бросок — исход неизвестен.
    labelReadBack = (() => true) as () => boolean,
    // Ревью 16c2: исход пуша раннера по его номеру (с нуля); `null` — пушить нечего.
    pushResult = (() => null) as (nth: number) => SessionPushResult | null,
    firstReviewBlocked = false,
    removeBlockedLabelError = null as Error | null,
} = {}) {
    const prompts: string[] = [];
    // Сколько сессий уже отработало к каждому пушу раннера — так видно, после какой он стоит.
    const pushes: number[] = [];
    // Сколько сессий уже отработало к каждой проводке — по этому видно, перед какой
    // сессией дерево ставилось на ветку.
    const placements: number[] = [];
    const logs: string[] = [];
    const models: string[] = [];
    const issues: Array<{
        title: string;
        body: string;
        labels: readonly string[];
        milestone?: string;
    }> = [];
    const journal: Array<{ pass: number; counts: Record<string, number>; pr: number | null }> = [];
    const saved: RalphState[] = [];
    const closedIssues: number[] = [];
    const issueComments: Array<{ issue: number; body: string }> = [];
    const addBlockedLabelFn = vi.fn();
    const removeBlockedLabelFn = vi.fn();
    if (removeBlockedLabelError) {
        removeBlockedLabelFn.mockImplementationOnce(() => {
            throw removeBlockedLabelError;
        });
    }
    const tryMergePhaseFn = vi.fn(() => gate);
    const pushEventFn = vi.fn();
    const syncProjectBoardFn = vi.fn();
    let passIdx = 0;
    let idxCalls = 0;
    let fixDiffIdx = 0;
    // Голова меняется от сессии правок, а не от чтения SHA: планировщик сверяет неизменность
    // ветки до и после своей read-only сессии, но между кругами диффы обязаны различаться.
    let fixCount = 0;
    let headReads = 0;
    const HEADS = ['b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(40));
    const currentHead = () => HEADS[Math.min(fixCount, HEADS.length - 1)];
    const applyArgs: Array<{ currentMilestone?: string }> = [];

    runLoop(
        config,
        { state, maxIterations: 10, maxTurns: 200 },
        {
            once: false,
            dry: dryRun,
            logFn: (m: string) => logs.push(m),
            shFn: () => '',
            runArgvFn: () => '',
            // Снимки состояния на каждом сохранении: по ним видно, ЧТО именно уехало на
            // диск и в какой момент — предмет проверки для окна падения арбитра.
            saveStateFn: (st: RalphState) => {
                saved.push(JSON.parse(JSON.stringify(st)) as RalphState);
            },
            openIssuesFn: () => [],
            allOpenIssuesFn: (milestone: string) => {
                const explicit = backlogIssues[milestone];
                if (explicit) {
                    return explicit
                        .filter((i) => !closedIssues.includes(i.number))
                        .map((i) => ({ labels: [], author: { login: 'owner' }, ...i }));
                }
                return Array.from({ length: backlogCounts[milestone] ?? 0 }, (_, i) => ({
                    number: 900 + i,
                    title: 'уже лежит',
                    labels: [],
                    author: { login: 'owner' },
                }));
            },
            nowFn: () => now,
            closeIssueFn: (issue: number) => {
                closedIssues.push(issue);
            },
            commentOnIssueFn: (issue: number, body: string) => {
                issueComments.push({ issue, body });
            },
            hasAnyIssuesFn: () => true,
            milestoneOpenFn: (title: string) => {
                if (milestoneStatusThrows) throw new Error('форж не отдал вехи');
                return !closedMilestones.includes(title);
            },
            findOpenPrFn: () => ({ number: PR, labels: [] }),
            createPrFn: () => PR,
            phasePrBodyFn: () => 'тело PR',
            getIssueFn: (number: number) => {
                // #18: чистка спрашивает тело, чтобы увидеть маркер лестницы. Отдаём то,
                // что положил тест: подменять его «телом вообще» значило бы, что маркер
                // в сценарии не проверяется вовсе.
                const card = Object.values(backlogIssues)
                    .flat()
                    .find((i) => i.number === number);
                return { number, title: card?.title ?? 'задача', body: card?.body ?? 'тело' };
            },
            prCommentsFn: () => [],
            phaseIndexOfFn: () => (idxCalls++ === 0 ? 0 : 99),
            pickModelFn: () => 'claude-coder',
            pickRuntimeFn: () => 'claude',
            pickRouteFn: () => ({ provider: 'claude', model: 'claude-coder' }),
            pickReviewModelFn: () => REVIEW_MODEL,
            phaseDiffFilesFn: (_b: string, opts?: { base?: string }) => {
                if (!opts?.base) return ['src/a.ts'];
                const i = Math.min(fixDiffIdx, fixDiffFiles.length - 1);
                fixDiffIdx += 1;
                return fixDiffFiles[i];
            },
            // Дифф правок отличим от диффа фазы: у него задана база. Саму базу кладём
            // в текст — по ней видно, от какой точки собран дифф.
            reviewDiffContextFn: (_b: string, opts?: { base?: string }) =>
                opts?.base ? `${FIX_DIFF}(${opts.base})` : PHASE_DIFF,
            branchHeadShaFn: () => {
                if (headSha !== null) return currentHead();
                headReads += 1;
                // Два чтения планировщика успешны; база правок уже сталкивается с отказом.
                return headReads <= 2 ? currentHead() : null;
            },
            createIssueFn: (input) => {
                issues.push(input);
                return 100 + issues.length;
            },
            recordFixReviewFindingsFn: (
                _phase: unknown,
                pr: number | null,
                counts: Record<string, number>,
                pass: number,
            ) => {
                journal.push({ pass, counts, pr });
            },
            removeBlockedLabelFn,
            addBlockedLabelFn,
            prHasBlockedLabelFn: labelReadBack,
            runClaudeFn: withDefaultFixPlan((prompt: string, opts: { model?: string } = {}) => {
                prompts.push(prompt);
                models.push(opts.model ?? '');
                if (isFixPrompt(prompt)) fixCount += 1;
                if (isArbiterPrompt(prompt)) return arbiterCode;
                const nth = isFixPrompt(prompt)
                    ? prompts.filter(isFixPrompt).length - 1
                    : prompts.filter((p) => p === prompt).length - 1;
                return sessionCode(prompt, nth) ?? 0;
            }),
            // Намерения применяет петля; здесь фейк отдаёт то, что «оставила» сессия.
            applySessionRequestsFn: (args: { currentMilestone?: string }) => {
                // Аргументы записываем, а не только ответ подменяем: веху текущей фазы
                // применению называет ПЕТЛЯ, и без этого журнала проводку можно выкинуть,
                // не покраснев ни на чём (#16).
                applyArgs.push(args);
                const last = prompts[prompts.length - 1] ?? '';
                if (isFixReviewPrompt(last)) {
                    const result = passes[passIdx] ?? { findings: [] };
                    passIdx += 1;
                    return {
                        applied: 0,
                        failed: false,
                        closedIssues: [],
                        prFindings: result.findings,
                        prBlocked: result.blocked === true,
                    };
                }
                if (isArbiterPrompt(last)) {
                    return {
                        applied: 0,
                        failed: false,
                        closedIssues: [],
                        prFindings: arbiter.findings,
                        prBlocked: arbiter.blocked === true,
                    };
                }
                // У первого ревью есть предмет правок; у чистого повторного — только сводка.
                return {
                    applied: 0,
                    failed: false,
                    closedIssues: [],
                    prFindings: isPhaseReviewPrompt(last)
                        ? [
                              major('первое ревью требует правки', 1),
                              { comment: '⚪ [nit] сводка прохода ревью фазы' },
                          ]
                        : isReReviewPrompt(last)
                          ? [{ comment: '⚪ [nit] сводка прохода ревью фазы' }]
                          : [],
                    prBlocked: isPhaseReviewPrompt(last) && firstReviewBlocked,
                };
            },
            ensureCleanFn: () => true,
            // #85: см. тот же дефолт в tests/test-helpers.ts.
            pushSessionCommitsFn: (): SessionPushResult => {
                pushes.push(prompts.length);
                return pushResult(pushes.length - 1) ?? { kind: 'in-sync' };
            },
            // #134: см. тот же дефолт в tests/test-helpers.ts.
            ensurePhaseBranchFn: (branch: string) => {
                placements.push(prompts.length);
                return placements.length - 1 === failPlacementCall
                    ? { kind: 'failed' as const, branch, sha: null, reason: 'origin недоступен' }
                    : { kind: 'switched' as const, branch, sha: 'a'.repeat(40) };
            },
            checkOnPhaseBranchFn: () => ({ ok: true, sha: 'a'.repeat(40) }),
            // #183: ветка «запушена» — настоящая проверка читает git в дереве тестов.
            branchPushedFn: () => true,
            phaseMergedFn: () => false,
            mergedPhasePrFn: () => null,
            advancePhaseFn: () => {},
            tryMergePhaseFn,
            closeMilestoneByTitleFn: () => {},
            syncProjectBoardFn,
            recordReviewFindingsFn: () => {},
            getLastRedCheck: () => null,
            getLastGatePr: () => PR,
            pushEventFn,
            ensureMonitorAliveFn: () => null,
        },
    );

    return {
        state,
        prompts,
        logs,
        models,
        issues,
        journal,
        addBlockedLabelFn,
        removeBlockedLabelFn,
        tryMergePhaseFn,
        pushEventFn,
        syncProjectBoardFn,
        closedIssues,
        issueComments,
        ladder: () => normalizeReviewOfFixes(state.reviewOfFixes),
        // Снимки состояния в порядке сохранения — по ним видно, что уехало на диск ДО
        // получения вердикта арбитра (#115-ревью, blocker 2).
        savedLadders: () => saved.map((st) => normalizeReviewOfFixes(st.reviewOfFixes)),
        fixReviewPrompts: () => prompts.filter(isFixReviewPrompt),
        fixPrompts: () => prompts.filter(isFixPrompt),
        arbiterPrompts: () => prompts.filter(isArbiterPrompt),
        heads: HEADS,
        applyArgs,
        placements,
        pushes,
        pushTexts: () => pushEventFn.mock.calls.map((c: unknown[]) => c[0] as string),
        merged: () =>
            pushEventFn.mock.calls.some((c: unknown[]) => /смерджена в main/.test(c[0] as string)),
    };
}

describe('merge снимает blocked после чистого ревью правок', () => {
    it('снимает метку первого ревью до гейта и не запускает разбор blocked', () => {
        const s = runPhase({ firstReviewBlocked: true, passes: [{ findings: [] }] });

        expect(s.removeBlockedLabelFn).toHaveBeenCalledTimes(1);
        expect(s.removeBlockedLabelFn).toHaveBeenCalledWith('feature/m1', {
            shFn: expect.any(Function),
            logFn: expect.any(Function),
        });
        expect(s.removeBlockedLabelFn.mock.invocationCallOrder[0]).toBeLessThan(
            s.tryMergePhaseFn.mock.invocationCallOrder[0],
        );
        expect(s.prompts.some(isReReviewPrompt)).toBe(false);
        expect(s.state.blockedHeals).toBe(0);
        expect(s.merged()).toBe(true);
    });

    it('ошибка снятия метки логируется, а гейт ведёт штатный разбор blocked', () => {
        const s = runPhase({
            firstReviewBlocked: true,
            passes: [{ findings: [] }],
            gate: 'blocked',
            removeBlockedLabelError: new Error('форж не ответил'),
        });

        expect(
            s.logs.some((l) =>
                l.includes(
                    '⚠ Ralph: метка blocked на PR не снята после «merge» ревью правок: форж не ответил — гейт поведёт разбор blocked',
                ),
            ),
        ).toBe(true);
        expect(s.prompts.some(isReReviewPrompt)).toBe(true);
        expect(s.state.blockedHeals).toBeGreaterThan(0);
    });

    it('блокирующая находка ревью правок оставляет метку нетронутой', () => {
        const s = runPhase({
            firstReviewBlocked: true,
            passes: [{ findings: [blocker('правка теряет отказ', 1)] }],
            config: cfg({ fixReviewAttempts: 1 }),
        });

        expect(s.arbiterPrompts()).toHaveLength(1);
        expect(s.removeBlockedLabelFn).not.toHaveBeenCalled();
    });

    it('без метки от первого ревью снятие не вызывается', () => {
        const s = runPhase({ passes: [{ findings: [] }] });

        expect(s.removeBlockedLabelFn).not.toHaveBeenCalled();
        expect(s.merged()).toBe(true);
    });
});

describe('крит. 1: фаза БЕЗ блокеров всё равно получает второй проход по диффу правок', () => {
    // Симптом PR #624: 19 находок ревью, ни одного blocker → повторного прохода не было,
    // правки уехали в main никем не прочитанными.
    it('блокеров не было → проход ревью правок всё равно состоялся, предмет — дифф правок', () => {
        const s = runPhase({ passes: [{ findings: [] }] });

        expect(s.prompts.some(isPhaseReviewPrompt)).toBe(true);
        expect(s.fixReviewPrompts()).toHaveLength(1);
        // Предмет прохода — дифф ПРАВОК, а не PR целиком.
        expect(s.fixReviewPrompts()[0]).toContain('ДИФФ-ТОЛЬКО-ПРАВОК');
        expect(s.fixReviewPrompts()[0]).not.toContain('ДИФФ-ФАЗЫ-ЦЕЛИКОМ');
        // Проход состоялся ПОСЛЕ правок, не вместо них.
        expect(s.prompts.findIndex(isFixPrompt)).toBeLessThan(
            s.prompts.findIndex(isFixReviewPrompt),
        );
        // И фаза при этом доехала до мерджа — качество не куплено остановкой петли.
        expect(s.merged()).toBe(true);
    });

    it('ревью-модель прохода не слабее планки фазы, потолок объявлен в логе', () => {
        const s = runPhase({ passes: [{ findings: [] }] });
        const idx = s.prompts.findIndex(isFixReviewPrompt);
        expect(s.models[idx]).toBe(REVIEW_MODEL);
        expect(
            s.logs.some((l) => /Ревью ПРАВОК \(круг 1, проход с новыми блокерами 1\/3\)/.test(l)),
        ).toBe(true);
    });

    it('круг и потолок — разные величины: «проход 5/3» в логе и промпте невозможен', () => {
        // Чередование «новый major → повтор того же → новый major»: кругов больше, чем
        // проходов, засчитанных потолку. Раньше числитель считал круги, знаменатель —
        // проходы, и лог штатно печатал номер выше потолка.
        const s = runPhase({
            passes: [
                { findings: [major('раз', 1)] },
                { findings: [major('раз', 1)] },
                { findings: [major('два', 2)] },
                { findings: [] },
            ],
        });
        const ceiling = s.logs.filter((l) => /Ревью ПРАВОК \(круг/.test(l));
        expect(ceiling.length).toBeGreaterThan(2);
        for (const line of ceiling) {
            const m = /проход с новыми блокерами (\d+)\/(\d+)\)/.exec(line);
            expect(m).not.toBeNull();
            expect(Number(m?.[1])).toBeLessThanOrEqual(Number(m?.[2]));
        }
        // Круг при этом честно свой: чередование дало больше кругов, чем проходов.
        expect(ceiling.some((l) => /круг 3,/.test(l))).toBe(true);
        for (const p of s.fixReviewPrompts()) {
            const m = /проход (\d+) из (\d+)/.exec(p);
            expect(Number(m?.[1])).toBeLessThanOrEqual(Number(m?.[2]));
        }
    });

    it('сессия правок ничего не изменила и держать нечем → проход не выдумывается, мердж не стопорится', () => {
        const s = runPhase({
            passes: [{ findings: [] }],
            config: cfg(),
            state: mkState(),
        });
        expect(s.fixReviewPrompts()).toHaveLength(1);
        // Тот же прогон, но дифф правок пуст с самого начала.
        const empty = runPhase({ fixDiffFiles: [[]] });
        expect(empty.fixReviewPrompts()).toHaveLength(0);
        expect(empty.logs.some((l) => /сессия правок ничего не изменила/.test(l))).toBe(true);
        expect(empty.merged()).toBe(true);
    });

    it('ревью правок выключено конфигом (fixReviewAttempts: 0) — лестницы нет, а не тихий дефолт 3', () => {
        const s = runPhase({
            passes: [{ findings: [blocker('никто этого не увидит', 1)] }],
            config: cfg({ fixReviewAttempts: 0 }),
        });
        expect(s.fixReviewPrompts()).toHaveLength(0);
        expect(s.logs.some((l) => /Ревью правок выключено конфигом/.test(l))).toBe(true);
        expect(s.merged()).toBe(true);
    });
});

describe('крит. 1b: пустой дифф правок ПОСЛЕ решения «fix» не отпускает фазу в мердж', () => {
    // Дыра, найденная ревью самих правок #625: проход 1 нашёл 🔴 → решение 'fix' → сессия
    // правок сочла замечание неверным и НИЧЕГО не запушила (штатное поведение — промпт
    // прямо разрешает обоснование пропуска). Прежний код видел пустой дифф и выходил из
    // лестницы: фаза с непогашенным blocker уезжала на гейт и мёржилась, минуя и спор, и
    // арбитра, — метки blocked при этом нет, держать мердж нечем.
    const declinedBlocker = () => ({
        passes: [{ findings: [blocker('правка убила отказ', 1)] }],
        // Круг 1 — сессия правок что-то запушила; дальше она молчит.
        fixDiffFiles: [['src/a.ts'], []] as Array<string[] | null>,
    });

    it('находка не теряется: те же замечания предъявляются повторно, спор идёт по лестнице', () => {
        const s = runPhase(declinedBlocker());

        expect(s.logs.some((l) => /предъявляю их повторно/.test(l))).toBe(true);
        // Второй раз ту же сессию правок тем же промптом не зовут — она уже отказалась.
        expect(s.fixPrompts()).toHaveLength(2);
        // И ревью на пустом диффе не выдумывается: повтор считает лестница, а не модель.
        expect(s.fixReviewPrompts()).toHaveLength(1);
    });

    it('спор кончается карточкой с обеими позициями, а не молчаливым мерджем', () => {
        const s = runPhase(declinedBlocker());

        const dispute = s.issues.find((i) => i.title.startsWith('Спор ревью и правок'));
        expect(dispute).toBeDefined();
        expect(dispute?.body).toContain('правка убила отказ');
        // Лестница конечна: человека ночью не будят, фаза доезжает до гейта.
        expect(s.merged()).toBe(true);
    });

    it('журнал прохода не выдумывается: повтор ревью не звал, нулей по живому PR нет', () => {
        const s = runPhase(declinedBlocker());
        // Ровно одна запись — от единственного состоявшегося прохода.
        expect(s.journal).toHaveLength(1);
        expect(s.journal[0].counts).toMatchObject({ blocker: 1, total: 1 });
    });
});

describe('отказ git по базе диффа: проход не пропускается, а дешевеет до диффа фазы', () => {
    // Дифф правок посчитать не удалось — это НЕ «пустой дифф» и не повод пропустить
    // барьер. Проход всё равно идёт, но по диффу фазы: дороже, зато это по-прежнему
    // ревью, а не его видимость.
    it('голова ветки не прочиталась → проход идёт по диффу ФАЗЫ, с предупреждением', () => {
        const s = runPhase({ headSha: null });
        expect(s.fixReviewPrompts()).toHaveLength(1);
        expect(s.fixReviewPrompts()[0]).toContain('ДИФФ-ФАЗЫ-ЦЕЛИКОМ');
        expect(s.logs.some((l) => /Дифф правок получить не удалось/.test(l))).toBe(true);
        expect(s.merged()).toBe(true);
    });

    it('дифф по базе не посчитался (null ≠ пусто) → тот же откат, а не «проход не нужен»', () => {
        const s = runPhase({ fixDiffFiles: [null] });
        expect(s.fixReviewPrompts()).toHaveLength(1);
        expect(s.fixReviewPrompts()[0]).toContain('ДИФФ-ФАЗЫ-ЦЕЛИКОМ');
        expect(s.logs.some((l) => /сессия правок ничего не изменила/.test(l))).toBe(false);
    });

    it('dry: журнал прохода НЕ пишется — нули по живому PR читались бы как факт', () => {
        const s = runPhase({ headSha: null, dryRun: true });
        expect(s.journal).toHaveLength(0);
    });
});

describe('крит. 2: поток новых minor/nit не продлевает цикл и не стопорит мердж', () => {
    it('пять свежих minor/nit за проход → один проход, мердж, карточки вместо задержки', () => {
        const s = runPhase({
            passes: [
                {
                    findings: [
                        minor('нейминг', 1),
                        minor('дубль', 2),
                        nit('пробел', 3),
                        nit('запятая', 4),
                        nit('порядок импортов', 5),
                    ],
                },
            ],
        });

        expect(s.fixReviewPrompts()).toHaveLength(1);
        // Потолок не сдвинулся ни на шаг: косметика цикл не продлевает.
        expect(s.ladder().passes).toBe(0);
        expect(s.merged()).toBe(true);
        // Незакрытая косметика не потеряна — она стала карточками с метками из конфига.
        expect(s.issues).toHaveLength(5);
        expect(s.issues[0].labels).toEqual(['complexity:low', 'area:core', 'backlog']);
        expect(s.issues[0].body).toContain(`PR #${String(PR)}`);
    });

    // ── Адрес карточек лестницы (#16) ───────────────────────────────────────────────
    //
    // Проверяется ПРИМЕНЕНИЕ, а не работоспособность выбора: арифметика перебора вех
    // покрыта юнит-тестами `pickBacklogMilestone`, и они останутся зелёными, даже если
    // петля перестанет звать её вовсе. Здесь карточка проходит весь цикл сдачи.

    it('карточки лестницы уезжают в накопительную веху, а не в общий бэклог', () => {
        const s = runPhase({
            passes: [{ findings: [minor('нейминг', 1), nit('пробел', 2)] }],
            config: cfg({
                review: {
                    ...cfg().review,
                    backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                },
            }),
        });

        expect(s.issues.map((i) => i.milestone)).toEqual(['Бэклог 1', 'Бэклог 1']);
        expect(s.merged()).toBe(true);
    });

    // ── Срок годности карточек лестницы (#18) ───────────────────────────────────────
    //
    // Здесь тоже проверяется ПРИМЕНЕНИЕ: арифметика порога закрыта юнит-тестами
    // `staleLadderCards`, и они останутся зелёными, даже если петля перестанет её звать.
    // Механизм МУТИРУЕТ чужие карточки, поэтому сценарии считают именно мутации.

    const DAY = 24 * 60 * 60 * 1000;
    const NOW = Date.parse('2026-08-21T00:00:00Z');
    const oldCard = (number: number, days: number) => ({
        number,
        title: `Ревью правок: пробел в ${String(number)}`,
        createdAt: new Date(NOW - days * DAY).toISOString(),
        // Маркер — в теле: заголовок набирается руками, и по нему одному чистка закрыла бы
        // карточку человека (ревью).
        body: `текст замечания\n\n${LADDER_CARD_MARKER}`,
    });
    const staleCfg = (staleDays?: number) =>
        cfg({
            review: {
                ...cfg().review,
                backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                ...(staleDays === undefined ? {} : { backlogStaleDays: staleDays }),
            },
        });

    it('порог не задан — ни одной мутации, сколько бы карточка ни лежала', () => {
        const s = runPhase({
            backlogIssues: { 'Бэклог 1': [oldCard(901, 400)] },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: staleCfg(),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([]);
        expect(s.issueComments).toEqual([]);
    });

    it('старше порога — закрывается, и в карточке остаётся ПРИЧИНА', () => {
        const s = runPhase({
            backlogIssues: { 'Бэклог 1': [oldCard(901, 40), oldCard(902, 5)] },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: staleCfg(30),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([901]);
        expect(s.issueComments.map((c) => c.issue)).toEqual([901]);
        expect(s.issueComments[0]?.body).toMatch(/протухш/i);
        expect(s.issueComments[0]?.body).toMatch(/30/);
        expect(s.logs.join('\n')).toMatch(/#901/);
    });

    it('заголовок наш, а маркера в теле нет — карточка не трогается', () => {
        // Ровно случай из ревью: человек завёл в вехе карточку с таким же заголовком.
        // Заголовок — предфильтр, решает маркер, которого руками не набирают.
        const impostor = {
            number: 901,
            title: 'Ревью правок: проверить миграцию',
            createdAt: new Date(NOW - 400 * DAY).toISOString(),
            body: 'завёл человек, маркера тут нет',
        };
        const s = runPhase({
            backlogIssues: { 'Бэклог 1': [impostor] },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: staleCfg(30),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([]);
        expect(s.logs.join('\n')).toMatch(/без маркера/);
    });

    it('чужая карточка и карточка спора в той же вехе не трогаются', () => {
        const s = runPhase({
            backlogIssues: {
                'Бэклог 1': [
                    {
                        number: 901,
                        title: 'Настроить бэкапы',
                        createdAt: new Date(NOW - 400 * DAY).toISOString(),
                    },
                    {
                        number: 902,
                        title: 'Спор ревью и правок: кто прав',
                        createdAt: new Date(NOW - 400 * DAY).toISOString(),
                    },
                    oldCard(903, 400),
                ],
            },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: staleCfg(30),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([903]);
    });

    it('--dry-run не закрывает ничего: до чистки дело не доходит вовсе (C1)', () => {
        const s = runPhase({
            backlogIssues: { 'Бэклог 1': [oldCard(901, 40)] },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: staleCfg(30),
            dryRun: true,
            now: NOW,
        });

        expect(s.closedIssues).toEqual([]);
        expect(s.issueComments).toEqual([]);
        // Первый эшелон C1 — сама лестница: в dry она не заводит карточку и потому не
        // ищет адрес, а чистка живёт внутри поиска адреса. Второй эшелон (guard в самой
        // чистке) стоит на месте и сегодня недостижим — это осознанно, ровно как у
        // соседнего `fileBacklogCard`: полагаться на «сюда всё равно не дойдёт» вместо
        // явного guard'а и есть тихий дефолт.
        expect(s.logs.join('\n')).toMatch(/DRY: карточка/);
    });

    // #18: бюджет чистки — СВОЁ число, а не потолок вехи. Пока они были одним ключом,
    // человек, поднявший потолок ради вместимости накопителя, поднимал заодно и размах
    // мутации: у безразмерной вехи «больше, чем в неё влезает, чистить не за чем»
    // перестаёт что-либо ограничивать.
    it('бюджет чистки не следует за потолком вехи: потолок 50, закрыто пять', () => {
        const s = runPhase({
            backlogIssues: {
                'Бэклог 1': [901, 902, 903, 904, 905, 906, 907].map((n) => oldCard(n, 40)),
            },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: cfg({
                review: {
                    ...cfg().review,
                    backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                    backlogMilestoneCap: 50,
                    backlogStaleDays: 30,
                },
            }),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([901, 902, 903, 904, 905]);
    });

    it('бюджет чистки задаётся явно и режет число закрытий за прогон', () => {
        const s = runPhase({
            backlogIssues: {
                'Бэклог 1': [901, 902, 903, 904, 905].map((n) => oldCard(n, 40)),
            },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: cfg({
                review: {
                    ...cfg().review,
                    backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                    backlogStaleDays: 30,
                    backlogStaleBudget: 2,
                },
            }),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([901, 902]);
    });

    // Бюджет объявлен «за ПРОГОН», а расходуется в чистке, которую зовут ПО ВЕХЕ.
    // Разница видна только на двух вехах: если бы бюджет был повеховым (или не убывал
    // вовсе), во второй закрылись бы все три, и «3» в конфиге перестало бы быть тройкой.
    it('бюджет чистки — на прогон, а не на веху: две вехи, закрыто три ВСЕГО', () => {
        const s = runPhase({
            backlogIssues: {
                // Потолок 2: после чистки одной протухшей тут остаётся две свежих, веха
                // по-прежнему полна — и поиск адреса идёт дальше, ко второй.
                'Бэклог 1': [oldCard(901, 40), oldCard(902, 1), oldCard(903, 1)],
                'Бэклог 2': [oldCard(911, 40), oldCard(912, 40), oldCard(913, 40)],
            },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: cfg({
                review: {
                    ...cfg().review,
                    backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                    backlogMilestoneCap: 2,
                    backlogStaleDays: 30,
                    backlogStaleBudget: 3,
                },
            }),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([901, 911, 912]);
    });

    it('чистка освобождает место: веха у потолка снова годится под адрес', () => {
        // Ровно ради этого срок годности и заводился: пять протухших карточек иначе
        // закрывали бы веху навсегда, и новая косметика ехала бы мимо неё.
        const s = runPhase({
            backlogIssues: {
                'Бэклог 1': [901, 902, 903, 904, 905].map((n) => oldCard(n, 40)),
            },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: staleCfg(30),
            now: NOW,
        });

        expect(s.closedIssues).toEqual([901, 902, 903, 904, 905]);
        expect(s.issues.map((i) => i.milestone)).toEqual(['Бэклог 1']);
    });

    it('веха добита до потолка — остаток уезжает в следующую номерную, а не поверх', () => {
        const s = runPhase({
            // Четыре карточки уже лежат: при потолке 5 в первую веху влезает ровно одна.
            backlogCounts: { 'Бэклог 1': 4 },
            passes: [{ findings: [minor('нейминг', 1), nit('пробел', 2), nit('запятая', 3)] }],
            config: cfg({
                review: {
                    ...cfg().review,
                    backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                },
            }),
        });

        expect(s.issues.map((i) => i.milestone)).toEqual(['Бэклог 1', 'Бэклог 2', 'Бэклог 2']);
    });

    it('карточка, рождённая ВО ВРЕМЯ бэклог-фазы, адресуется в СЛЕДУЮЩУЮ веху', () => {
        // Иначе фаза не сходится: разбор косметики порождал бы косметику в собственную
        // очередь ровно с той скоростью, с какой ревью её находит.
        const s = runPhase({
            passes: [{ findings: [nit('пробел', 1)] }],
            state: mkState({ milestone: 'Бэклог 1' }),
            config: cfg({
                phases: [{ milestone: 'Бэклог 1', branch: 'feature/backlog-1' }],
                review: {
                    ...cfg().review,
                    backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                },
            }),
        });

        expect(s.issues.map((i) => i.milestone)).toEqual(['Бэклог 2']);
    });

    // #65, поймано живьём: разобранный том закрыт, его карточки закрыты, наполнение ноль —
    // и по одному наполнению он «самая свободная веха». Четыре находки уехали в закрытую
    // веху, где их не видит ни доска, ни ревизия бэклога, а лог писал «адрес запрошен».
    it('первый том ЗАКРЫТ и пуст, второй открыт — находка едет во второй', () => {
        const s = runPhase({
            backlogCounts: { 'Бэклог 1': 0, 'Бэклог 2': 2 },
            closedMilestones: ['Бэклог 1'],
            passes: [{ findings: [nit('пробел', 1), nit('запятая', 2)] }],
            config: cfg({
                review: {
                    ...cfg().review,
                    backlogMilestone: ['Бэклог 1', 'Бэклог 2'],
                },
            }),
        });

        expect(s.issues.map((i) => i.milestone)).toEqual(['Бэклог 2', 'Бэклог 2']);
    });

    // Предохранитель «fail-open при отказе форжа» сохраняется и для статуса: не прочитали
    // — кандидат пропущен (не принят за открытый), карточка всё равно заводится, сдача
    // фазы не рвётся.
    it('статус вехи не читается — карточка заводится без адреса, сдача не рвётся', () => {
        const s = runPhase({
            milestoneStatusThrows: true,
            passes: [{ findings: [nit('пробел', 1)] }],
            config: cfg({
                review: { ...cfg().review, backlogMilestone: 'Бэклог 1' },
            }),
        });

        expect(s.issues).toHaveLength(1);
        expect(s.issues[0].milestone).toBeUndefined();
        expect(s.logs.join('\n')).toMatch(/Накопительной вехи для карточек ревью правок/);
    });

    it('вехи кончились — карточка всё равно заводится, без адреса и с записью в лог', () => {
        const s = runPhase({
            backlogCounts: { 'Бэклог 1': 5 },
            passes: [{ findings: [nit('пробел', 1)] }],
            config: cfg({
                review: { ...cfg().review, backlogMilestone: 'Бэклог 1' },
            }),
        });

        expect(s.issues).toHaveLength(1);
        expect(s.issues[0].milestone).toBeUndefined();
        expect(s.logs.join('\n')).toMatch(/Накопительной вехи для карточек ревью правок/);
    });

    // #16: веху ТЕКУЩЕЙ фазы применению намерений называет петля — на этом держится
    // запрет «карточка не едет в фазу, которую сейчас сдают». Проводку легко выкинуть,
    // не покраснев: все прочие тесты адреса зовут применение напрямую и подают её руками.
    it('петля называет применению веху сдаваемой фазы на каждом шаге цикла сдачи', () => {
        const s = runPhase({ passes: [{ findings: [nit('пробел', 1)] }] });

        expect(s.applyArgs.length).toBeGreaterThan(0);
        for (const args of s.applyArgs) {
            expect(args.currentMilestone).toBe('M1');
        }
    });

    it('ключ не задан — прежнее поведение: карточка без вехи и без единого предупреждения', () => {
        const s = runPhase({ passes: [{ findings: [nit('пробел', 1)] }] });

        expect(s.issues).toHaveLength(1);
        expect(s.issues[0].milestone).toBeUndefined();
        expect(s.logs.join('\n')).not.toMatch(/веха|вехи/i);
    });

    it('major держит мердж, а следующий проход с одной косметикой его отпускает', () => {
        const s = runPhase({
            passes: [
                { findings: [major('убита ветка отказа', 1), nit('пробел', 2)] },
                { findings: [nit('другой пробел', 7), minor('нейминг', 8)] },
            ],
        });

        // Два прохода: первый вернул фазу на круг правок, второй — отпустил.
        expect(s.fixReviewPrompts()).toHaveLength(2);
        expect(s.fixPrompts()).toHaveLength(2);
        // Потолок двинулся ровно один раз — от прохода с новым major.
        expect(s.ladder().passes).toBe(1);
        expect(s.merged()).toBe(true);
        // Карточки — только по косметике ПОСЛЕДНЕГО прохода: nit первого прохода ушёл в
        // круг правок вместе с major и разбирался сессией.
        expect(s.issues).toHaveLength(2);
        expect(s.issues.map((i) => i.title).join(' ')).toContain('другой пробел');
    });

    // Ревью 16c2: следующий проход ревью правок судит то, что в PR, — круг лестницы
    // уезжает одним пушем раннера до него. Убери пуш круга — краснеет этот тест.
    it('круг лестницы → ровно один пуш раннера после сессии правок, до следующего прохода', () => {
        const s = runPhase({
            passes: [{ findings: [major('убита ветка отказа', 1)] }, { findings: [] }],
        });
        const isFix = (p: string) => s.fixPrompts().includes(p);
        // Номер сессии (с единицы) второго круга правок — круга лестницы.
        const ladderFix = s.prompts.map((p, i) => (isFix(p) ? i + 1 : -1)).filter((i) => i > 0)[1];
        const nextReview = s.prompts.findIndex(
            (p, i) => i >= ladderFix && s.fixReviewPrompts().includes(p),
        );
        expect(ladderFix).toBeGreaterThan(0);
        expect(nextReview).toBeGreaterThanOrEqual(ladderFix);
        // Ровно один пуш между кругом правок и следующим проходом ревью правок.
        expect(s.pushes.filter((n) => n === ladderFix)).toHaveLength(1);
        expect(s.merged()).toBe(true);
    });

    it('пуш круга лестницы отвергнут → стоп session-unpushed, следующего прохода нет', () => {
        const ok = runPhase({
            passes: [{ findings: [major('убита ветка отказа', 1)] }, { findings: [] }],
        });
        const isFix = (p: string) => ok.fixPrompts().includes(p);
        const ladderFix = ok.prompts.map((p, i) => (isFix(p) ? i + 1 : -1)).filter((i) => i > 0)[1];
        const nth = ok.pushes.indexOf(ladderFix);
        const s = runPhase({
            passes: [{ findings: [major('убита ветка отказа', 1)] }, { findings: [] }],
            pushResult: (n) =>
                n === nth
                    ? {
                          kind: 'failed',
                          why: 'git push отвергнут — ! [rejected] (non-fast-forward)',
                          local: 'b'.repeat(40),
                          remote: 'a'.repeat(40),
                      }
                    : null,
        });
        expect(s.fixReviewPrompts()).toHaveLength(1);
        expect(s.merged()).toBe(false);
        expect(s.pushTexts().some((t) => /session-unpushed/.test(t))).toBe(true);
        expect(s.pushTexts().some((t) => /правки по ревью правок/.test(t))).toBe(true);
    });

    it('отклонённая косметика не теряется: повторный minor уходит карточкой', () => {
        // Проход 1 отдал minor в сессию правок вместе с блокером; сессия его отклонила,
        // проход 2 предъявил снова. Раньше повтор не попадал ни в cosmetic, ни в
        // repeatedBlocking — и «minor не держит мердж» означало «minor не делается».
        const s = runPhase({
            passes: [
                { findings: [blocker('дыра', 1), minor('нейминг', 2)] },
                { findings: [minor('нейминг', 2)] },
            ],
        });

        expect(s.merged()).toBe(true);
        expect(s.issues.some((i) => i.title.includes('нейминг'))).toBe(true);
    });

    it('карточки лестницы доезжают до доски — иначе для человека они потеряны', () => {
        // Синк зовётся и после мерджа фазы (#199), поэтому сравниваем два прогона:
        // лишний вызов есть ровно там, где лестница завела карточки.
        const withCards = runPhase({ passes: [{ findings: [minor('нейминг', 1)] }] });
        const without = runPhase({ passes: [{ findings: [] }] });
        expect(withCards.issues).toHaveLength(1);
        expect(without.issues).toHaveLength(0);
        expect(withCards.syncProjectBoardFn.mock.calls.length).toBeGreaterThan(
            without.syncProjectBoardFn.mock.calls.length,
        );
    });

    it('замечание, оспоренное дважды, становится карточкой с обеими позициями и отпускает мердж', () => {
        const same = () => blocker('спорное место', 1);
        const s = runPhase({
            passes: [{ findings: [same()] }, { findings: [same()] }, { findings: [same()] }],
        });

        expect(s.merged()).toBe(true);
        const dispute = s.issues.find((i) => i.title.startsWith('Спор ревью и правок'));
        expect(dispute).toBeDefined();
        expect(dispute?.body).toContain('Позиция ревью');
        expect(dispute?.body).toContain('Позиция правок');
        // Спор закрыт карточкой, а не третьим кругом «ревью → правки»: потолок проходов
        // не исчерпан (повтор его не двигает), арбитра звать не за чем.
        expect(s.arbiterPrompts()).toHaveLength(0);
        expect(s.ladder().passes).toBe(1);
    });
});

// #110: порог серьёзности карточек лестницы. Накопитель растёт быстрее, чем разбирается
// (замер 01.09.2026: 29 карточек за два дня, разобрано ноль, больше половины — minor/nit),
// и этот порог режет заведение карточки на самую мелкую косметику. Отброшенная находка не
// исчезает бесследно — она остаётся комментарием ревью на PR (промпт, не этот код) и учтена
// в счёте прохода (журнал); порог не двигает ни решение о мердже, ни анти-пинг-понг.
describe('#110: порог серьёзности режет заведение карточки, не решение о мердже', () => {
    it('порог не задан → прежнее поведение: карточка заводится и на nit', () => {
        const s = runPhase({ passes: [{ findings: [nit('пробел', 1)] }] });

        expect(s.merged()).toBe(true);
        expect(s.issues).toHaveLength(1);
        expect(s.issues[0].title).toContain('пробел');
    });

    it('порог "minor": nit карточки не даёт, minor — даёт', () => {
        const s = runPhase({
            passes: [{ findings: [nit('пробел', 1), minor('нейминг', 2)] }],
            config: cfg({
                review: { ...cfg().review, backlogSeverityFloor: 'minor' },
            }),
        });

        expect(s.merged()).toBe(true);
        expect(s.issues).toHaveLength(1);
        expect(s.issues[0].title).toContain('нейминг');
        expect(s.issues.some((i) => i.title.includes('пробел'))).toBe(false);
    });

    it('отброшенная находка остаётся в счётчиках журнала прохода — она не потеряна, а не заведена карточкой', () => {
        const s = runPhase({
            passes: [{ findings: [nit('пробел', 1)] }],
            config: cfg({
                review: { ...cfg().review, backlogSeverityFloor: 'minor' },
            }),
        });

        expect(s.issues).toHaveLength(0);
        expect(s.journal).toHaveLength(1);
        expect(s.journal[0].counts).toMatchObject({ nit: 1, total: 1 });
    });

    it('порог не влияет на решение о мердже: major по-прежнему держит его и требует круг правок', () => {
        const s = runPhase({
            // Порог задан на самом строгом уровне ('blocker') — major его формально не
            // проходит (meetsSeverityFloor('major', 'blocker') === false). Если бы порог
            // участвовал в decideAfterFixReview, major перестал бы держать мердж, и фаза
            // мёржилась бы ОДНИМ проходом ревью правок вместо круга «ревью → правки → ревью».
            passes: [{ findings: [major('убита ветка отказа', 1)] }, { findings: [] }],
            config: cfg({
                review: { ...cfg().review, backlogSeverityFloor: 'blocker' },
            }),
        });

        // Потолок двинулся (классификация видит major как blocking независимо от порога),
        // И потребовался ещё один проход ревью правок — то есть decideAfterFixReview
        // реально вернул 'fix', а не 'merge' на первом же проходе.
        expect(s.ladder().passes).toBe(1);
        expect(s.fixReviewPrompts()).toHaveLength(2);
        expect(s.merged()).toBe(true);
    });

    it('спорная карточка (анти-пинг-понг) порогом не режется, даже если находка мельче порога', () => {
        // Дублируем ДВЕ находки в одном месте на трёх проходах: blocker держит лестницу
        // живой (без него после первого же ответа «merge» и спорить не о чем), nit — сама
        // проверяемая находка, СТРОЖЕ порога 'minor' (карточку косметики такая находка бы
        // не получила). Обе оспорены дважды и обе становятся карточками спора — порог на
        // путь анти-пинг-понга не распространяется вовсе.
        const sameBlocker = () => blocker('спорное место', 1);
        const sameNit = () => nit('спорный пробел', 2);
        const s = runPhase({
            passes: [
                { findings: [sameBlocker(), sameNit()] },
                { findings: [sameBlocker(), sameNit()] },
                { findings: [sameBlocker(), sameNit()] },
            ],
            config: cfg({
                review: { ...cfg().review, backlogSeverityFloor: 'minor' },
            }),
        });

        expect(s.merged()).toBe(true);
        const blockerDispute = s.issues.find((i) => i.title.includes('спорное место'));
        const nitDispute = s.issues.find((i) => i.title.includes('спорный пробел'));
        expect(blockerDispute?.title).toMatch(/^Спор ревью и правок/);
        // Ключевая проверка #110: nit СТРОЖЕ порога 'minor' (карточку косметики не получил
        // бы), но карточку спора всё равно получил — порог на pingPong не смотрит.
        expect(nitDispute?.title).toMatch(/^Спор ревью и правок/);
        expect(nitDispute?.body).toContain('Позиция ревью');
        expect(nitDispute?.body).toContain('Позиция правок');
    });

    it('порог фильтрует и косметику независимого арбитра, не только основной лестницы', () => {
        const threeFreshMajors = [
            { findings: [major('раз', 1)] },
            { findings: [major('два', 2)] },
            { findings: [major('три', 3)] },
        ];
        const s = runPhase({
            passes: threeFreshMajors,
            // Арбитр не воспроизвёл блокер (пустой findings для решения по существу), но
            // сам оставил косметику двух уровней — ей и проверяем фильтр на ветке арбитра
            // (`[...pendingCosmetic, ...arbBlocking.cosmetic]`, orchestrator.ts), которая
            // отделена от основной лестницы и своего теста без этого не имела.
            arbiter: { findings: [minor('нейминг арбитра', 4), nit('пробел арбитра', 5)] },
            config: cfg({
                review: { ...cfg().review, backlogSeverityFloor: 'minor' },
            }),
        });

        expect(s.merged()).toBe(true);
        expect(s.issues.some((i) => i.title.includes('нейминг арбитра'))).toBe(true);
        expect(s.issues.some((i) => i.title.includes('пробел арбитра'))).toBe(false);
    });
});

describe('крит. 3: три прохода с новыми major → независимый арбитр, петля не встаёт', () => {
    const threeFreshMajors = [
        { findings: [major('раз', 1)] },
        { findings: [major('два', 2)] },
        { findings: [major('три', 3)] },
    ];

    it('потолок исчерпан → арбитр сильнейшей моделью и БЕЗ истории проходов', () => {
        const s = runPhase({ passes: threeFreshMajors });

        expect(s.ladder().passes).toBe(3);
        expect(s.arbiterPrompts()).toHaveLength(1);
        expect(s.models[s.prompts.findIndex(isArbiterPrompt)]).toBe(ARBITER_MODEL);
        // «Без истории» — не фигура речи: в промпте арбитра нет ленты комментариев PR,
        // только дифф правок.
        expect(s.arbiterPrompts()[0]).toContain('ДИФФ-ТОЛЬКО-ПРАВОК');
        expect(s.arbiterPrompts()[0]).not.toContain('Комментарии ревью');
        expect(s.ladder().arbitrated).toBe(true);
    });

    it('арбитр судит дифф ВСЕХ правок фазы, а не последнего круга', () => {
        // В decision.blocking лежат находки всех кругов, и кода ранних кругов в диффе
        // последней сессии может не быть вовсе: «не воспроизвёл» тогда значило бы «не
        // нашёл в том куске, который ему дали», а карточка утверждает человеку сильное.
        const s = runPhase({ passes: threeFreshMajors });
        const arb = s.arbiterPrompts()[0];
        expect(arb).toContain(`ДИФФ-ТОЛЬКО-ПРАВОК(${s.heads[0]})`);
        // Последний проход ревью при этом смотрел именно свой круг — экономия цела.
        const lastPass = s.fixReviewPrompts()[s.fixReviewPrompts().length - 1];
        expect(lastPass).toContain(`ДИФФ-ТОЛЬКО-ПРАВОК(${s.heads[2]})`);
    });

    it('арбитр не воспроизвёл → находки в бэклог, фаза мёржится, человека не будят', () => {
        const s = runPhase({ passes: threeFreshMajors, arbiter: { findings: [] } });

        expect(s.merged()).toBe(true);
        expect(s.addBlockedLabelFn).not.toHaveBeenCalled();
        expect(s.issues.some((i) => i.title.includes('три'))).toBe(true);
        expect(s.logs.some((l) => /блокирующего не воспроизвёл/.test(l))).toBe(true);
        // Никакого «оставлен человеку»: лестница кончается решением, а не стопом.
        expect(s.pushTexts().some((t) => /оставлен человеку|устоял/.test(t))).toBe(false);
    });

    it('спорная карточка не уезжает к самой слабой модели: метки роутинга с неё сняты', () => {
        const s = runPhase({ passes: threeFreshMajors, arbiter: { findings: [] } });
        const disputed = s.issues.find((i) => i.title.includes('три'));
        // complexity:low = «механическая задача» по modelRouting.labels, а тут спорный
        // major, который не развели два ревью и арбитр.
        expect(disputed?.labels).toEqual(['area:core', 'backlog']);
    });

    it('собственная косметика арбитра тоже становится карточкой — промпт ей это обещает', () => {
        const s = runPhase({
            passes: threeFreshMajors,
            arbiter: { findings: [minor('арбитр заметил мелочь', 4)] },
        });
        expect(s.merged()).toBe(true);
        const own = s.issues.find((i) => i.title.includes('арбитр заметил мелочь'));
        expect(own).toBeDefined();
        // Косметике — метки как есть из конфига: это обычная мелкая работа.
        expect(own?.labels).toEqual(['complexity:low', 'area:core', 'backlog']);
    });

    it('арбитр воспроизвёл → label blocked и штатный разбор, а не стоп петли', () => {
        const s = runPhase({
            passes: threeFreshMajors,
            arbiter: { findings: [blocker('правка убила фичу', 9)], blocked: true },
            gate: 'blocked',
        });

        // pr-block намерения ставит метку сам applySessionRequests — раннер её не дублирует.
        expect(s.addBlockedLabelFn).not.toHaveBeenCalled();
        expect(s.pushTexts().some((t) => /арбитр подтвердил блокирующий дефект/.test(t))).toBe(
            true,
        );
        expect(s.merged()).toBe(false);
    });

    it('арбитр нашёл блокер, но метку не попросил → раннер ставит её сам (fail-closed)', () => {
        const s = runPhase({
            passes: threeFreshMajors,
            arbiter: { findings: [blocker('правка убила фичу', 9)] },
            gate: 'blocked',
        });
        expect(s.addBlockedLabelFn).toHaveBeenCalledTimes(1);
        expect(s.merged()).toBe(false);
    });

    // Задача 79: запись метки fail-open по контракту адаптера. `arbitrated` к этому моменту
    // уже на диске, и после рестарта лестница решит «мердж», — так что гейт с зелёными
    // чеками (`gate: 'merged'`) смерджил бы блокер, если бы метку не перечитали.
    it.each([
        ['метка не легла', () => false, /метки на PR нет после записи/],
        [
            'чтение после записи упало — исход неизвестен',
            () => {
                throw new Error('форж не ответил');
            },
            /исход записи неизвестен \(форж не ответил\)/,
        ],
    ])(
        'арбитр воспроизвёл, %s → мерджа нет, флаг держит мердж и после рестарта',
        (_t, readBack, why) => {
            const s = runPhase({
                passes: threeFreshMajors,
                arbiter: { findings: [blocker('правка убила фичу', 9)] },
                gate: 'merged',
                labelReadBack: readBack,
            });
            expect(s.merged()).toBe(false);
            expect(s.state.reReviewPending).toBe(true);
            expect(s.logs.some((l) => why.test(l))).toBe(true);
            expect(s.pushTexts().some((t) => /blocked-unconfirmed/.test(t))).toBe(true);
        },
    );

    it.each([
        ['метка не легла', () => false],
        [
            'чтение после записи упало',
            () => {
                throw new Error('форж не ответил');
            },
        ],
    ])('арбитр упал, %s → мерджа нет, флаг не сброшен', (_t, readBack) => {
        const s = runPhase({ passes: threeFreshMajors, arbiterCode: 1, labelReadBack: readBack });
        expect(s.addBlockedLabelFn).toHaveBeenCalled();
        expect(s.merged()).toBe(false);
        expect(s.state.reReviewPending).toBe(true);
    });

    it('арбитр воспроизвёл, метка подтверждена чтением → флаг снят, дальше штатный гейт', () => {
        const s = runPhase({
            passes: threeFreshMajors,
            arbiter: { findings: [blocker('правка убила фичу', 9)] },
            gate: 'blocked',
        });
        expect(s.state.reReviewPending).toBe(false);
        expect(s.pushTexts().some((t) => /blocked-unconfirmed/.test(t))).toBe(false);
    });
});

describe('C1: --dry-run строго read-only — лестница карточек не заводит', () => {
    it('dry: находки прохода есть, а карточка не заводится (только строка в логе)', () => {
        const s = runPhase({
            passes: [{ findings: [minor('нейминг', 1)] }],
            dryRun: true,
        });
        expect(s.issues).toHaveLength(0);
        expect(
            s.logs.some((l) => /DRY: карточка по замечанию ревью правок не заводится/.test(l)),
        ).toBe(true);
    });
});

describe('крит. 4: журнал находок различает проходы', () => {
    it('каждый проход — своя запись с номером прохода и счётом СВЕЖИХ находок', () => {
        const s = runPhase({
            passes: [
                { findings: [major('раз', 1), nit('мелочь', 2)] },
                { findings: [blocker('два', 3)] },
                { findings: [] },
            ],
        });

        expect(s.journal.map((e) => e.pass)).toEqual([1, 2, 3]);
        expect(s.journal[0].counts).toMatchObject({ major: 1, nit: 1, total: 2 });
        expect(s.journal[1].counts).toMatchObject({ blocker: 1, total: 1 });
        expect(s.journal[2].counts).toMatchObject({ total: 0 });
        expect(s.journal.every((e) => e.pr === PR)).toBe(true);
    });

    it('повторное замечание в счёт прохода не идёт — иначе спор выглядел бы новой работой', () => {
        const s = runPhase({
            passes: [
                { findings: [blocker('одно и то же', 1)] },
                { findings: [blocker('одно и то же', 1)] },
            ],
        });
        expect(s.journal[0].counts.total).toBe(1);
        expect(s.journal[1].counts.total).toBe(0);
    });
});

describe('#115-ревью: спорная карточка сохраняет ровно одну метку сложности', () => {
    const threeFreshMajors = [
        { findings: [major('первый', 10)] },
        { findings: [major('второй', 20)] },
        { findings: [major('третий', 30)] },
    ];
    // Конфиг, где модели меток РАНЖИРУЕМЫ: без порядка силы ядру нечем выбрать сильнейшую,
    // и оно честно оставляет набор как есть (проверено соседним сценарием).
    const ranked = cfg({
        modelRouting: {
            default: 'claude-coder',
            labels: { 'complexity:low': 'claude-haiku-4-5', 'complexity:high': 'claude-opus-5' },
        },
        review: {
            default: REVIEW_MODEL,
            escalated: REVIEW_MODEL,
            fallback: REVIEW_MODEL,
            arbiter: ARBITER_MODEL,
            maxTurns: 80,
            backlogLabels: ['complexity:low', 'area:core'],
            modelStrength: ['claude-haiku-4-5', 'claude-opus-5', REVIEW_MODEL, ARBITER_MODEL],
        },
    });

    it('слабая метка заменяется сильнейшей, а не снимается совсем', () => {
        const s = runPhase({
            passes: threeFreshMajors,
            arbiter: { findings: [] },
            config: ranked,
        });
        const disputed = s.issues.find((i) => i.title.includes('третий'));
        // Ровно одна метка сложности — и это НЕ «механическая» complexity:low: спорный
        // major, который не развели два прохода и арбитр, к слабой модели не отправляют.
        expect(disputed?.labels).toEqual(['area:core', 'complexity:high']);
    });

    // Ревью terra по union-дереву: наборы моделей кодера и ревью в обычном конфиге РАЗНЫЕ
    // (ядро сводить их не требует — `assertKnownReviewModels` валидирует только модели
    // ревью). Тогда ранжировать метки нечем, и до фолбэка карточка оставалась вообще без
    // сложности — тот самый дефект, ради которого замена и заводилась. Фолбэк ставит метку
    // модели ПО УМОЛЧАНИЮ: именно ей карточка досталась бы после голого снятия, то есть
    // маршрут прежний, а конвенция «ровно одна метка сложности» держится.
    const unranked = cfg({
        modelRouting: {
            default: 'coder-default',
            labels: {
                'complexity:low': 'coder-weak',
                'complexity:high': 'coder-default',
                'complexity:expert': 'coder-strong',
            },
        },
        review: {
            default: REVIEW_MODEL,
            escalated: REVIEW_MODEL,
            fallback: REVIEW_MODEL,
            arbiter: ARBITER_MODEL,
            maxTurns: 80,
            backlogLabels: ['complexity:low', 'area:core'],
            // Модели кодера здесь НЕ перечислены — ровно как в обычном конфиге.
            modelStrength: [REVIEW_MODEL, ARBITER_MODEL],
        },
    });

    it('ранжировать нечем → метка модели по умолчанию, а не карточка без сложности', () => {
        const s = runPhase({
            passes: threeFreshMajors,
            arbiter: { findings: [] },
            config: unranked,
        });
        const disputed = s.issues.find((i) => i.title.includes('третий'));
        expect(disputed?.labels).toEqual(['area:core', 'complexity:high']);
    });
});

describe('#115-ревью: состояние лестницы не переживает ни падение арбитра, ни новый цикл', () => {
    const threeFreshMajors = [
        { findings: [major('первый', 10)] },
        { findings: [major('второй', 20)] },
        { findings: [major('третий', 30)] },
    ];

    // Blocker 2 ревью PR !110: `arbitrated` писался на диск ДО запуска арбитра, а его
    // сессия идёт десятки минут. Падение в этом окне оставляло «арбитр отработал» — и
    // после рестарта любая блокирующая находка уходила в безусловный мердж
    // (decideAfterFixReview: ветка `next.arbitrated`).
    it('сессия арбитра упала → «арбитр отработал» на диск НЕ уехало', () => {
        const s = runPhase({ passes: threeFreshMajors, arbiterCode: 1 });

        // Арбитра звали, но вердикта нет.
        expect(s.arbiterPrompts()).toHaveLength(1);
        // Ни один снимок состояния не утверждает, что арбитр отработал.
        expect(s.savedLadders().some((l) => l.arbitrated)).toBe(false);
        expect(s.ladder().arbitrated).toBe(false);
        // Падение арбитра — не стоп: фаза ушла в штатный разбор blocked.
        expect(s.addBlockedLabelFn).toHaveBeenCalled();
        expect(s.logs.some((l) => /Арбитр ревью правок упал/.test(l))).toBe(true);
    });

    it('арбитр отработал штатно → флаг зафиксирован (иначе его звали бы по кругу)', () => {
        const s = runPhase({ passes: threeFreshMajors, arbiter: { findings: [] } });
        expect(s.arbiterPrompts()).toHaveLength(1);
        expect(s.ladder().arbitrated).toBe(true);
    });
});

// Blocker 1 ревью PR !110: gate-heal и --resubmit сбрасывали только `submitted`, оставляя
// лестницу прошлого круга. Heal-коммит — НОВЫЙ код, и унаследованный `arbitrated`
// превращал любую свежую блокирующую находку по нему в мердж, а дедуп-множества прятали
// находки как «уже отвеченные».
//
// Барьер структурный, по исходнику (приём lock-scenarios «лок первым»): проверять это
// прогоном пришлось бы через полный gate-heal с чини-сессией, а инвариант нужен на КАЖДОМ
// будущем входе в новый цикл сдачи, а не только на двух известных сегодня.
describe('#115-ревью: новый цикл сдачи начинает лестницу с чистого листа', () => {
    it('в orchestrator.ts каждый сброс submitted сопровождается сбросом reviewOfFixes', () => {
        const src = fs.readFileSync(resolve(__dirname, '../core/orchestrator.ts'), 'utf-8');
        const lines = src.split('\n');
        const resets = lines
            .map((line, i) => ({ line: line.trim(), i }))
            .filter((x) => x.line === 'state.submitted = false;');
        // Оба известных входа: чини-сессия гейта и --resubmit. Меньше — тест устарел и
        // сторожит не то; больше — появился третий вход, и он тоже обязан быть покрыт.
        expect(resets.length).toBeGreaterThanOrEqual(2);
        for (const { i } of resets) {
            // Сброс лестницы ищем в том же блоке — до ближайшего saveState включительно:
            // именно он фиксирует новое состояние на диск.
            const window = lines.slice(i, i + 12).join('\n');
            expect(
                /state\.reviewOfFixes = null;/.test(window),
                `сброс submitted в строке ${String(i + 1)} не сбрасывает лестницу ревью правок`,
            ).toBe(true);
        }
    });
});

// Задача 73: обе сессии правок стартуют на ветке фазы. Гейт и ревью оставляют дерево где
// угодно (детачем после красного гейта), и круг лестницы без своей проводки коммитил бы
// вне ветки. Приём тот же, что в tests/delivery-sessions-branch.test.ts: зелёный прогон
// находит последнюю проводку перед сессией, второй роняет именно её.
describe('задача 73: сессии правок стартуют на ветке фазы', () => {
    // Круг 1 нашёл блокер → правки по ревью правок; дифф правок непустой на обоих кругах.
    const ladder = () => ({
        passes: [{ findings: [blocker('правка убила отказ', 1)] }, { findings: [] }],
        fixDiffFiles: [['src/a.ts'], ['src/a.ts']] as Array<string[] | null>,
    });
    const CASES = [
        { name: 'правки по ревью', nth: 0, where: '(правки по ревью)' },
        { name: 'правки по ревью правок', nth: 1, where: '(правки по ревью правок)' },
    ];

    const green = (nth: number) => {
        const s = runPhase(ladder());
        const fixAt = s.prompts.flatMap((p, i) => (isFixPrompt(p) ? [i] : []));
        const at = fixAt[nth] ?? -1;
        return {
            at,
            call: s.placements.reduce((last, count, index) => (count <= at ? index : last), -1),
        };
    };

    it.each(CASES)('$name: проводка стоит после предыдущей сессии и до этой', ({ nth }) => {
        const { at, call } = green(nth);
        expect(at).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(-1);
    });

    it.each(CASES)('$name: отказ ЕЁ проводки → сессия не запущена, стоп называет её', (c) => {
        const { call } = green(c.nth);
        const s = runPhase({ ...ladder(), failPlacementCall: call });
        expect(s.fixPrompts()).toHaveLength(c.nth);
        expect(s.pushTexts().some((t) => t.includes(c.where))).toBe(true);
        expect(s.merged()).toBe(false);
    });
});

// Задача 40: падение сессии лестницы останавливает сдачу — и об этом человек узнаёт пушем,
// а не из лога утром. Ровно одним: второй пуш о том же стопе читался бы вторым событием.
describe('задача 40: стоп лестницы ревью правок — ровно один пуш', () => {
    it('проход ревью правок упал → один пуш, мерджа нет', () => {
        const run = runPhase({
            sessionCode: (p) => (isFixReviewPrompt(p) ? 1 : undefined),
        });
        expect(run.pushTexts()).toHaveLength(1);
        expect(run.pushTexts()[0]).toMatch(/проход ревью правок фазы "M1" упал \(код 1\)/);
        expect(run.merged()).toBe(false);
    });

    it('повторные правки по находкам прохода упали → один пуш, мерджа нет', () => {
        const run = runPhase({
            passes: [{ findings: [blocker('теряется отказ', 10)] }],
            // Первая сессия правок — штатная; падает вторая, по находкам прохода.
            sessionCode: (p, nth) => (isFixPrompt(p) && nth >= 1 ? 1 : undefined),
        });
        expect(run.fixPrompts().length).toBeGreaterThanOrEqual(2);
        expect(run.pushTexts()).toHaveLength(1);
        expect(run.pushTexts()[0]).toMatch(/правки по ревью правок фазы "M1" упали \(код 1\)/);
        expect(run.merged()).toBe(false);
    });
});

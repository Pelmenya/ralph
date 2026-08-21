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
import type { RalphConfig } from '../core/orchestrator.ts';
import type { RalphState } from '../core/state-lock.ts';
import { normalizeReviewOfFixes } from '../core/review-of-fixes.ts';

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
    // #16: сколько НЕЗАКРЫТЫХ карточек уже лежит в каждой накопительной вехе. Через тот же
    // шов, которым петля считает очередь фазы: потолок вехи считается её содержимым, а не
    // числом, которое тест мог бы подсунуть мимо форжа.
    backlogCounts = {} as Record<string, number>,
} = {}) {
    const prompts: string[] = [];
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
    const addBlockedLabelFn = vi.fn();
    const pushEventFn = vi.fn();
    const syncProjectBoardFn = vi.fn();
    let passIdx = 0;
    let idxCalls = 0;
    let fixDiffIdx = 0;
    // Голова ветки МЕНЯЕТСЯ от круга к кругу — иначе не отличить «дифф последнего круга»
    // от «диффа всех правок фазы», а это ровно предмет проверки для арбитра.
    let headCalls = 0;
    const HEADS = ['b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(40));
    const nextHead = () => HEADS[Math.min(headCalls++, HEADS.length - 1)];

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
            allOpenIssuesFn: (milestone: string) =>
                Array.from({ length: backlogCounts[milestone] ?? 0 }, (_, i) => ({
                    number: 900 + i,
                    title: 'уже лежит',
                    labels: [],
                    author: { login: 'owner' },
                })),
            hasAnyIssuesFn: () => true,
            findOpenPrFn: () => ({ number: PR, labels: [] }),
            createPrFn: () => PR,
            phasePrBodyFn: () => 'тело PR',
            getIssueFn: (number: number) => ({ number, title: 'задача', body: 'тело' }),
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
            branchHeadShaFn: () => (headSha === null ? null : nextHead()),
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
            removeBlockedLabelFn: () => {},
            addBlockedLabelFn,
            runClaudeFn: (prompt: string, opts?: { model?: string }) => {
                prompts.push(prompt);
                models.push(opts?.model ?? '');
                return isArbiterPrompt(prompt) ? arbiterCode : 0;
            },
            // Намерения применяет петля; здесь фейк отдаёт то, что «оставила» сессия.
            applySessionRequestsFn: () => {
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
                return {
                    applied: 0,
                    failed: false,
                    closedIssues: [],
                    prFindings: [],
                    prBlocked: false,
                };
            },
            ensureCleanFn: () => true,
            phaseMergedFn: () => false,
            mergedPhasePrFn: () => null,
            advancePhaseFn: () => {},
            tryMergePhaseFn: () => gate,
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
        pushEventFn,
        syncProjectBoardFn,
        ladder: () => normalizeReviewOfFixes(state.reviewOfFixes),
        // Снимки состояния в порядке сохранения — по ним видно, что уехало на диск ДО
        // получения вердикта арбитра (#115-ревью, blocker 2).
        savedLadders: () => saved.map((st) => normalizeReviewOfFixes(st.reviewOfFixes)),
        fixReviewPrompts: () => prompts.filter(isFixReviewPrompt),
        fixPrompts: () => prompts.filter(isFixPrompt),
        arbiterPrompts: () => prompts.filter(isArbiterPrompt),
        heads: HEADS,
        pushTexts: () => pushEventFn.mock.calls.map((c: unknown[]) => c[0] as string),
        merged: () =>
            pushEventFn.mock.calls.some((c: unknown[]) => /смерджена в main/.test(c[0] as string)),
    };
}

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
        expect(s.logs.join('\n')).toMatch(/Накопительной вехи.*не нашлось/s);
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
    // Конфиг, где модели меток РАНЖИРУЕМЫ: кодерские модели роутинга перечислены в
    // `review.modelStrength`, и ядру есть по чему выбрать сильнейшую. Ядро такого
    // совпадения НЕ требует — что происходит без него, проверяют два сценария ниже.
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

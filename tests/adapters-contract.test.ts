// Контрактный сьют интерфейсов адаптеров (#370, трек «Фреймворк ralph», фаза 5).
//
// Отличие от соседних тестов:
//   - adapters.test.ts (#262) доказывает, что интерфейсы РЕАЛИЗУЕМЫ — фейками;
//   - adapters-impl.test.ts (#369) проверяет СБОРКУ (мапперы, resolveAdapterSelection,
//     buildAdapters) — тоже фейками;
//   - здесь — ОДИН и тот же набор поведенческих ассертов на интерфейс прогоняется
//     против ДВУХ реализаций подряд: минимального in-memory фейка (realizability) и
//     БОЕВОЙ логики текущих адаптеров (gate.ts/deploy-check.ts/telegram-notifier.ts/
//     orchestrator.ts) с подменённым на границе I/O (sh/ghJson/execFn/spawnFn — то же
//     DI, что и в gate.test.ts/deploy-check.test.ts/telegram-notifier.test.ts).
//   Так проверяется именно КОНТРАКТ: свойство держится независимо от того, кто за
//   интерфейсом стоит — ручной фейк или реальный npm/GitHub/Telegram/Claude-адаптер.
//
// Известное ограничение (см. комментарий у buildRealTaskSource): `openIssues`/
// `allOpenIssues` (orchestrator.ts) не имеют собственного DI-хука на чтение gh (в
// отличие от соседних findOpenPr/closeMilestoneByTitle) — их вызывает только runLoop
// через параметр `openIssuesFn`. Поэтому в «боевом» флейворе TaskSourceAdapter боевым
// кодом покрыты ВСЕ методы интерфейса, КРОМЕ этих двух: listReadyIssues/listAllOpenIssues
// стоят тем же фейком, что и в realizability-флейворе (честно закомментировано на месте,
// не выдаётся за боевую логику).
import { describe, expect, it, vi } from 'vitest';
import type {
    CoderRuntimeAdapter,
    DeployCheckAdapter,
    GateAdapter,
    GateCheckResult,
    Issue,
    NotifierAdapter,
    NewPullRequest,
    NewReviewComment,
    PullRequest,
    ReviewComment,
    RunResult,
    TaskSourceAdapter,
} from '../adapters/adapters.ts';
import {
    createCoderRuntime,
    createGithubActionsDeploy,
    createGithubTaskSource,
    createNoDeployCheck,
    createNpmGate,
    createTelegramNotifier,
} from '../adapters/adapters-impl.ts';
import type { SourcecraftApi } from '../adapters/sourcecraft-task-source.ts';
import { createSourcecraftTaskSource } from '../adapters/sourcecraft-task-source.ts';
import type { GateEnv } from '../core/gate.ts';
import { createGithubForgeCommands } from '../adapters/github-forge-commands.ts';
import { createGateRunner } from '../core/gate.ts';
import type { DeployCheckEnv } from '../core/deploy-check.ts';
import { createDeployCheckModule } from '../core/deploy-check.ts';
// Боевой POSIX-квотер без побочек — тот же, что импортируют соседние тесты; локальная
// копия молча разъехалась бы с ним при правке экранирования.
import { shq } from '../shared/ralph-util.ts';
import { sendTelegramMessage } from '../runtime/telegram-notifier.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что gate.test.ts
// и deploy-check.test.ts): findOpenPr/closeMilestoneByTitle/syncProjectBoard/buildClaudeArgs/
// spawnClaude живут только на боевой поверхности ralph.js.
import ralph from '../ralph.js';

const SHA = 'a'.repeat(40);

// ── Синтетические env боевых фабрик (реальная логика, фейковый I/O) ──────────────────

function makeGateEnv(over: Partial<GateEnv> = {}): GateEnv {
    return {
        sh: () => {
            throw new Error('sh не подменён в тесте');
        },
        shArgv: () => {
            throw new Error('shArgv не подменён в тесте');
        },
        shq,
        log: () => {},
        fail: (msg: string) => {
            throw new Error(msg);
        },
        getConfig: () => ({ gate: { checks: [['test', 'npm run test']] } }),
        // #49: голову PR гейт спрашивает у шва форжа. Дефолт падает, как и соседние
        // побочки: тест, забывший подменить шов, обязан краснеть.
        prHeadSha: () => {
            throw new Error('prHeadSha не подменён в тесте');
        },
        ghJson: () => {
            throw new Error('ghJson не подменён в тесте');
        },
        // #55: примитивы форжа приходят инъекцией. Дефолт падает по той же причине, что
        // и prHeadSha: тест, забывший подменить их, обязан краснеть, а не идти в боевой `gh`.
        mergePr: () => {
            throw new Error('mergePr не подменён в тесте');
        },
        phaseMerged: () => {
            throw new Error('phaseMerged не подменён в тесте');
        },
        safeBranch: () => true,
        findOpenPr: () => null,
        ensureClean: () => true,
        parkOnOriginMain: () => {},
        updateRunnerTreeToOriginMain: () => {},
        syncDepsIfLockChanged: () => {},
        buildSanitizedGateEnv: () => ({}),
        formatExcerpt: (s: string) => s,
        sleep: () => {},
        dry: false,
        SHA40_RE: /^[0-9a-f]{40}$/,
        PR_NUMBER_RE: /^\d+$/,
        runnerTreeFixHint: 'git fetch origin main && git checkout --detach origin/main',
        ...over,
    };
}

function makeDeployEnv(over: Partial<DeployCheckEnv> = {}): DeployCheckEnv {
    return {
        getConfig: () => ({}),
        ghJson: () => {
            throw new Error('ghJson не подменён в тесте');
        },
        shq,
        log: () => {},
        sleep: () => {},
        guardSideEffect: (what: string) => {
            throw new Error(`побочка без override в тесте: ${what}`);
        },
        positiveIntOrDefault: (value: unknown, dflt: number) =>
            typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : dflt,
        SHA40_RE: /^[0-9a-f]{40}$/,
        ...over,
    };
}

// ── TaskSourceAdapter ────────────────────────────────────────────────────────────────

const MILESTONE = 'Фаза X';
// #39: milestone ЗАВЕДЁН, но задач в нём нет ни одной — «фаза не начата». Отдельная
// фикстура, а не несуществующее имя: несуществующий milestone — другой случай (отказ),
// и подменять им пустой значило бы проверять не то свойство.
const EMPTY_MILESTONE = 'Фаза Пустая';
const BRANCH = 'feature/x';

const ISSUES: Issue[] = [
    { number: 30, title: 'третий', author: { login: 'ok-author' } },
    { number: 10, title: 'первый', author: { login: 'ok-author' } },
    { number: 20, title: 'blocked', labels: [{ name: 'blocked' }], author: { login: 'ok-author' } },
    { number: 5, title: 'чужой автор', author: { login: 'stranger' } },
];
const ALLOWLIST = ['ok-author'];

// #37: комментарии PR. Форж держит их на разных поверхностях (у GitHub три, у SourceCraft
// одна лента), и общий контракт — ровно то, что от них нужно счётчику находок: тела,
// автор и отметка «это сводка прохода, а не отдельная находка».
const PR_NUMBER = 42;
const FINDING = '🔴 [blocker] находка к месту в диффе';
const SUMMARY = '🟡 [minor] сводка прохода — дублирует находки выше';

// Общий фильтр «готовые issues» — используется ОБОИМИ флейворами для listReadyIssues/
// listAllOpenIssues, так как ни одна боевая реализация не даёт независимого DI-хука на
// чтение gh для этих двух методов (см. докблок файла). Не боевой код — синтетический
// эквивалент того же контракта, что описан в adapters.ts.
function filterReady(issues: Issue[]): Issue[] {
    return issues
        .filter((i) => !(i.labels ?? []).some((l) => l.name === 'blocked'))
        .filter((i) => ALLOWLIST.includes(i.author?.login ?? ''))
        .slice()
        .sort((a, b) => a.number - b.number);
}

function buildFakeTaskSource(): { adapter: TaskSourceAdapter; calls: string[] } {
    const calls: string[] = [];
    const prs: Record<string, PullRequest | null> = { [BRANCH]: null };
    const merged: Record<string, number | null> = {};
    let allOpenThrows = false;
    let hasAnyThrows = false;
    let authFails = false;
    let mutationFails = false;
    let commentsThrow = false;
    let issuesThrow = false;
    // #49: голова PR на стороне форжа и отказ её чтения — те же две ручки, что у боевых
    // флейворов (__setActualHead/__setHeadThrows).
    let actualHead = SHA;
    let headThrows = false;
    const adapter: TaskSourceAdapter = {
        checkAuth: () => {
            if (authFails) throw new Error('форж отверг авторизацию');
        },
        listReadyIssues: (milestone) => (milestone === MILESTONE ? filterReady(ISSUES) : []),
        listAllOpenIssues: (milestone) => {
            if (allOpenThrows) throw new Error('gh issue list упал');
            return milestone === MILESTONE ? ISSUES.slice() : [];
        },
        // #39: карточки ЛЮБОГО статуса. У фикстуры они есть только у MILESTONE; в
        // EMPTY_MILESTONE их нет ни открытых, ни закрытых. Отказ — СВОИМ флагом, не общим
        // с listAllOpenIssues: связанные флаги делают зелёный негативный тест
        // доказательством не того метода.
        hasAnyIssues: (milestone) => {
            if (hasAnyThrows) throw new Error('gh issue list упал');
            return milestone === MILESTONE;
        },
        // #37: метки карточек фазы плоским списком. Отказ — тем же флагом чтения, что и
        // у соседних выборок: транспорт у них общий и у фейка, и у боевых реализаций.
        listMilestoneLabels: (milestone) => {
            if (allOpenThrows) throw new Error('gh issue list упал');
            return milestone === MILESTONE
                ? ISSUES.flatMap((i) => (i.labels ?? []).map((l) => l.name))
                : [];
        },
        // #50: карточка целиком — её читает петля для промпта кодер-сессии.
        getIssue: (number) => {
            if (issuesThrow) throw new Error('форж не отдал карточку');
            return { number, title: 'задача фазы', body: 'что и почему надо сделать' };
        },
        // #46: PR фазы заводит раннер. Отказ — общим флагом мутаций: у боевых реализаций
        // это такая же запись в форж, как и остальные.
        createPullRequest: ({ branch, title }) => {
            if (mutationFails) throw new Error('форж отверг создание PR');
            calls.push(`create-pr:${branch}:${title}`);
            return 7;
        },
        // #45: комментарий в PR от имени раннера. Отказ — общим с чтением флагом: у боевых
        // реализаций это тот же маршрут комментариев, только методом записи.
        commentOnPullRequest: (prNumber, input) => {
            if (commentsThrow) throw new Error('форж отверг комментарий');
            calls.push(`pr-comment:${String(prNumber)}:${input.anchor?.path ?? '-'}:${input.body}`);
        },
        // #37: лента комментариев PR. Отказ — своим флагом: чтение комментариев у боевых
        // реализаций идёт отдельным маршрутом от очереди карточек.
        listPullRequestComments: () => {
            if (commentsThrow) throw new Error('форж не отдал комментарии');
            return [
                { body: FINDING, isSummary: false, author: 'ok-author' },
                { body: SUMMARY, isSummary: true, author: 'ok-author' },
            ];
        },
        findOpenPullRequest: (branch) => prs[branch] ?? null,
        // #49: голова PR — вопрос к форжу, а не к гейту. Отказ — общим флагом чтения PR:
        // у боевых реализаций это тот же маршрут, что и у выборки pull request'ов.
        pullRequestHeadSha: (prNumber) => {
            if (headThrows) throw new Error(`форж не отдал голову PR #${String(prNumber)}`);
            // Пустая голова — тоже отказ: «не смогли проверить» не равно «голова та же».
            if (!actualHead) throw new Error(`голова PR #${String(prNumber)} не прочиталась`);
            return actualHead;
        },
        isPhaseMerged: (phase) => (merged[phase.branch] ?? null) !== null,
        mergedPullRequestNumber: (phase) => merged[phase.branch] ?? null,
        mergePullRequest: (prNumber, headSha) => {
            // Свойство контракта, а не механизм GitHub: мердж не уезжает на голову, которую
            // гейт не проверял. Фейк держит его сверкой — как площадка; у `gh` то же самое
            // делает сервер по `--match-head-commit`. Без этой строки фейк был бы «реализацией
            // интерфейса», которая нарушает его же контракт.
            if (headSha && headSha !== actualHead) {
                throw new Error(
                    `Голова PR #${String(prNumber)} уехала после прогона чеков: гейт проверял ` +
                        `${headSha}, сейчас ${actualHead}.`,
                );
            }
            calls.push(`merge:${prNumber}:${headSha ?? '-'}`);
        },
        addBlockedLabel: (branch) => calls.push(`block+:${branch}`),
        removeBlockedLabel: (branch) => calls.push(`block-:${branch}`),
        closeMilestone: (title) => calls.push(`close-ms:${title}`),
        syncBoard: () => calls.push('sync-board'),
        // #40: намерения сессии. Fail-closed — отсюда общий флаг отказа мутаций.
        commentOnIssue: (issue, body) => {
            if (mutationFails) throw new Error('форж отверг мутацию');
            calls.push(`comment:${issue}:${body}`);
        },
        closeIssue: (issue) => {
            if (mutationFails) throw new Error('форж отверг мутацию');
            calls.push(`close-issue:${issue}`);
        },
        blockIssue: (issue) => {
            if (mutationFails) throw new Error('форж отверг мутацию');
            calls.push(`block-issue:${issue}`);
        },
        createIssue: ({ title }) => {
            if (mutationFails) throw new Error('форж отверг мутацию');
            calls.push(`create-issue:${title}`);
            return 101;
        },
    };
    // Тест-хук фейка (не часть контракта) — включить fail-closed сценарий.
    (adapter as unknown as { __setAllOpenThrows: (v: boolean) => void }).__setAllOpenThrows = (
        v: boolean,
    ) => {
        allOpenThrows = v;
    };
    (adapter as unknown as { __setHasAnyThrows: (v: boolean) => void }).__setHasAnyThrows = (
        v: boolean,
    ) => {
        hasAnyThrows = v;
    };
    (adapter as unknown as { __setMutationFails: (v: boolean) => void }).__setMutationFails = (
        v: boolean,
    ) => {
        mutationFails = v;
    };
    (adapter as unknown as { __setPr: (branch: string, pr: PullRequest | null) => void }).__setPr =
        (branch: string, pr: PullRequest | null) => {
            prs[branch] = pr;
        };
    (adapter as unknown as { __setAuthFails: (v: boolean) => void }).__setAuthFails = (
        v: boolean,
    ) => {
        authFails = v;
    };
    (adapter as unknown as { __setCommentsThrow: (v: boolean) => void }).__setCommentsThrow = (
        v: boolean,
    ) => {
        commentsThrow = v;
    };
    (adapter as unknown as { __setIssuesThrow: (v: boolean) => void }).__setIssuesThrow = (
        v: boolean,
    ) => {
        issuesThrow = v;
    };
    (adapter as unknown as { __setActualHead: (sha: string) => void }).__setActualHead = (
        sha: string,
    ) => {
        actualHead = sha;
    };
    (adapter as unknown as { __setHeadThrows: (v: boolean) => void }).__setHeadThrows = (
        v: boolean,
    ) => {
        headThrows = v;
    };
    // Хук трассы вызовов: контракт проверяет, что якорь доехал до форжа, а «куда именно»
    // у каждой реализации своё (argv у GitHub, тело запроса у площадки).
    (adapter as unknown as { __calls: () => string[] }).__calls = () => calls;
    return { adapter, calls };
}

// Боевая реализация: findOpenPr/closeMilestoneByTitle/syncProjectBoard — прямая ссылка на
// ralph.js (единственное место, где они живут); phaseMerged/mergedPhasePr/mergePr/
// addBlockedLabel/removeBlockedLabel — СВЕЖИЙ createGateRunner(fakeEnv), не зависящий от
// синглтона ralph.js (та же логика, что gate.ts реально исполняет в бою). listReadyIssues/
// listAllOpenIssues — см. докблок файла, тем же фейком, что и realizability-флейвор.
// Собираем адаптер ИМЕННО через боевой маппер createGithubTaskSource(adapters-impl.ts) —
// тогда под контрактом оказывается и сам сдвиг имён (openIssues→listReadyIssues и т.п.),
// а не только функции под ним.
function buildRealTaskSource(): { adapter: TaskSourceAdapter; gateEnv: GateEnv } {
    let ghJsonImpl: (cmd: string) => unknown = () => {
        throw new Error('ghJson не подменён в тесте (gate)');
    };
    const shArgvCalls: string[] = [];
    let authFails = false;
    const gateEnv = makeGateEnv({
        ghJson: ((cmd: string) => ghJsonImpl(cmd)) as GateEnv['ghJson'],
        shArgv: (file, args) => {
            shArgvCalls.push(`${file} ${args.join(' ')}`);
            return '';
        },
        // Пути очереди и мерджа читают gh через ghJson, не sh; для них стаб нейтрален.
        // Через `sh` идёт только проверка авторизации — её отказ и моделируем.
        sh: ((cmd: string) => {
            if (authFails && String(cmd).includes('gh auth status')) {
                throw new Error('gh: You are not logged into any GitHub hosts.');
            }
            return '';
        }) as GateEnv['sh'],
    });
    const g = createGateRunner(gateEnv);
    // #55: примитивы форжа больше не живут в гейте — контракт собирается из их адаптера,
    // а env берём тот же, что у гейта (одни и те же sh/ghJson/логи в этом сценарии).
    const forge = createGithubForgeCommands({
        sh: gateEnv.sh,
        shArgv: gateEnv.shArgv,
        shq: gateEnv.shq,
        log: gateEnv.log,
        ghJson: gateEnv.ghJson,
        safeBranch: gateEnv.safeBranch,
        prNumberRe: gateEnv.PR_NUMBER_RE,
        sha40Re: gateEnv.SHA40_RE,
    });

    let allOpenThrows = false;
    let mutationFails = false;
    // Мутации намерений идут через argv. Отказ форжа моделируем здесь: контракт требует
    // fail-closed, то есть исключение обязано долететь до вызывающего, а не утонуть.
    const mutationArgv = (file: string, args: string[]): string => {
        if (mutationFails) throw new Error('gh: форж отверг мутацию');
        shArgvCalls.push(`${file} ${args.join(' ')}`);
        return '';
    };
    const adapter: TaskSourceAdapter = createGithubTaskSource({
        // Боевая обёртка та же, что в composition root: авторизация форжа = `gh auth status`.
        checkAuth: () => {
            gateEnv.sh('gh auth status');
        },
        openIssues: (milestone) => (milestone === MILESTONE ? filterReady(ISSUES) : []),
        allOpenIssues: (milestone) => {
            if (allOpenThrows) throw new Error('gh issue list упал');
            return milestone === MILESTONE ? ISSUES.slice() : [];
        },
        // #39: в отличие от соседних openIssues/allOpenIssues — БОЕВАЯ функция с
        // собственным DI-хуком на чтение gh. Новый метод шва писался уже под контракт,
        // поэтому «боевой» флейвор здесь честно боевой, а не фейк.
        hasAnyIssues: (milestone: string): boolean =>
            ralph.hasAnyIssues(milestone, { ghJsonFn: (cmd: string) => ghJsonImpl(cmd) }),
        // #37: тоже боевая функция с DI-хуком на чтение gh.
        milestoneLabels: (milestone: string): string[] =>
            ralph.milestoneLabels(milestone, { ghJsonFn: (cmd: string) => ghJsonImpl(cmd) }),
        // #50: чтение карточки — боевая функция с DI-хуком на чтение gh.
        getIssue: (number: number) =>
            ralph.issueDetails(number, { ghJsonFn: (cmd: string) => ghJsonImpl(cmd) }),
        // #46: заведение PR — боевая функция; `gh pr create` печатает URL, номер из хвоста.
        createPr: (input: NewPullRequest) =>
            ralph.createPr(input, {
                runArgvFn: (file: string, args: string[]) =>
                    `${mutationArgv(file, args)}https://forge.example/org/repo/pull/7`,
            }),
        // #45: комментарий в PR — боевая функция, подменены argv-мутация и чтение gh.
        commentOnPr: (prNumber: number, input: NewReviewComment) =>
            ralph.commentOnPr(prNumber, input, {
                runArgvFn: mutationArgv,
                ghJsonFn: (cmd: string) => ghJsonImpl(cmd),
            }),
        // #37: раскладка комментариев по трём поверхностям GitHub — боевая функция,
        // подменено только чтение gh.
        prComments: (prNumber: number): ReviewComment[] =>
            ralph.prComments(prNumber, { ghJsonFn: (cmd: string) => ghJsonImpl(cmd) }),
        findOpenPr: (branch: string): PullRequest | null =>
            ralph.findOpenPr(branch, {
                ghJsonFn: (cmd: string) => ghJsonImpl(cmd),
                logFn: () => {},
            }),
        // #49: голова PR — боевая функция с DI-хуком на чтение gh. Гейт её больше не
        // исполняет сам: на площадке без `gh` тот путь давал `not-merged` навсегда.
        prHeadSha: (prNumber: number): string =>
            ralph.prHeadSha(prNumber, { ghJsonFn: (cmd: string) => ghJsonImpl(cmd) }),
        phaseMerged: forge.phaseMerged,
        mergedPhasePr: forge.mergedPhasePr,
        mergePr: (prNumber: number, headSha?: string | null) => forge.mergePr(prNumber, headSha),
        addBlockedLabel: (branch: string) => forge.addBlockedLabel(branch),
        removeBlockedLabel: (branch: string) => forge.removeBlockedLabel(branch),
        closeMilestoneByTitle: (title: string) =>
            ralph.closeMilestoneByTitle(title, {
                ghJsonFn: (cmd: string) => ghJsonImpl(cmd),
                runArgvFn: (file: string, args: string[]) => {
                    shArgvCalls.push(`${file} ${args.join(' ')}`);
                    return '';
                },
                logFn: () => {},
            }),
        // #40: боевые функции с DI-хуком на argv — мутации идут БЕЗ шелла (C3).
        commentOnIssue: (issue: number, body: string) =>
            ralph.commentOnIssue(issue, body, { runArgvFn: mutationArgv }),
        closeIssue: (issue: number) => ralph.closeIssue(issue, { runArgvFn: mutationArgv }),
        blockIssue: (issue: number) => ralph.blockIssue(issue, { runArgvFn: mutationArgv }),
        createIssue: (input: { title: string; body: string; labels: readonly string[] }) =>
            ralph.createIssue(input, {
                // `gh issue create` печатает URL созданной карточки — номер берётся из хвоста.
                runArgvFn: (file: string, args: string[]) =>
                    `${mutationArgv(file, args)}https://forge.example/org/repo/issues/101`,
            }),
        syncProjectBoard: () =>
            ralph.syncProjectBoard(
                (file: string, args: string[]) => {
                    shArgvCalls.push(`${file} ${args.join(' ')}`);
                    return 'ok — синк доски (0 карточек)';
                },
                () => {},
            ),
    });
    // Тест-хук: подменить ghJson-диспетчер сценария (разные тесты — разные фикстуры gh).
    (adapter as unknown as { __setGhJson: (fn: (cmd: string) => unknown) => void }).__setGhJson = (
        fn,
    ) => {
        ghJsonImpl = fn;
    };
    (adapter as unknown as { __setAllOpenThrows: (v: boolean) => void }).__setAllOpenThrows = (
        v: boolean,
    ) => {
        allOpenThrows = v;
    };
    (adapter as unknown as { __shArgvCalls: () => string[] }).__shArgvCalls = () => shArgvCalls;
    (adapter as unknown as { __setMutationFails: (v: boolean) => void }).__setMutationFails = (
        v: boolean,
    ) => {
        mutationFails = v;
    };
    (adapter as unknown as { __setAuthFails: (v: boolean) => void }).__setAuthFails = (
        v: boolean,
    ) => {
        authFails = v;
    };
    return { adapter, gateEnv };
}

type TaskSourceHook = {
    __setGhJson?: (fn: (cmd: string) => unknown) => void;
    __setAllOpenThrows: (v: boolean) => void;
    // #39: отказ ИМЕННО hasAnyIssues. Хук опционален: реализации, у которых оба чтения
    // идут одним транспортом (SourceCraft — один маршрут `/issues?`, GitHub — ghJson),
    // моделируют отказ своим способом. Не реализовать его совсем нельзя — негативный
    // тест ждёт throw и на no-op'е краснеет.
    __setHasAnyThrows?: (v: boolean) => void;
    // Отказ ОБЩЕГО транспорта чтения карточек — для реализаций, где оба вопроса идут
    // одним маршрутом и раздельные флаги были бы выдумкой теста, а не свойством адаптера.
    __setIssuesThrow?: (v: boolean) => void;
    // #40: форж отвергает МУТАЦИЮ (не чтение) — намерения сессии обязаны быть fail-closed.
    __setMutationFails: (v: boolean) => void;
    __setPr?: (branch: string, pr: PullRequest | null) => void;
    __shArgvCalls?: () => string[];
    // Множественность открытых PR — для реализаций, которые не ходят через gh и потому
    // не могут смоделировать её подменой ghJson.
    __setPrs?: (branch: string, prs: PullRequest[]) => void;
    // Текущая голова PR на стороне форжа. Нужен реализациям, закрывающим TOCTOU СВЕРКОЙ
    // головы, а не серверной привязкой `--match-head-commit`: у SourceCraft такого
    // параметра в API нет, а требование «не мерджить непрогнанную голову» остаётся.
    __setActualHead?: (sha: string) => void;
    // Форж отвергает авторизацию — для негативного сценария checkAuth.
    __setAuthFails: (v: boolean) => void;
    // #49: форж не отдал голову PR. Отдельный хук нужен реализациям, которые читают её
    // своим маршрутом (не через ghJson): связать этот отказ с общим флагом чтения значило
    // бы проверять не тот метод.
    __setHeadThrows?: (v: boolean) => void;
    // Трасса вызовов реализации — для #45: якорь обязан доехать до форжа, а куда именно
    // (argv у GitHub, тело запроса у площадки) — деталь реализации.
    __calls?: () => string[];
    // #37: форж не отдал комментарии PR. Отдельный хук, а не общий флаг чтения: у боевых
    // реализаций комментарии живут своим маршрутом, и связать их отказ с очередью карточек
    // значило бы проверять не тот метод.
    __setCommentsThrow?: (v: boolean) => void;
};

function registerTaskSourceContract(
    label: string,
    build: () => { adapter: TaskSourceAdapter },
): void {
    describe(`TaskSourceAdapter — ${label}`, () => {
        it('listReadyIssues отдаёт готовые issues отсортированными, без blocked и чужих авторов', () => {
            const { adapter } = build();
            expect(adapter.listReadyIssues(MILESTONE).map((i) => i.number)).toEqual([10, 30]);
        });

        it('listAllOpenIssues НЕ фильтрует (C2: blocked и чужие тоже считаются)', () => {
            const { adapter } = build();
            expect(adapter.listAllOpenIssues(MILESTONE)).toHaveLength(4);
        });

        it('НЕГАТИВНЫЙ: listAllOpenIssues fail-closed — бросает при сбое форжа', () => {
            const { adapter } = build();
            (adapter as unknown as TaskSourceHook).__setAllOpenThrows(true);
            expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow();
        });

        // #39: «в milestone нет НИ ОДНОЙ карточки» ≠ «все карточки закрыты». Первое —
        // фаза не начата (сдавать нечего), второе — фаза сделана. По одной лишь открытой
        // очереди эти два состояния неразличимы, поэтому у шва отдельный вопрос.
        it('hasAnyIssues: true для milestone с карточками — считает и закрытые', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            // Все карточки фикстуры ЗАКРЫТЫ (открытых нет) — метод обязан сказать «были».
            hook.__setGhJson?.((cmd) => (cmd.includes('--state all') ? [{ number: 1 }] : []));
            expect(adapter.hasAnyIssues(MILESTONE)).toBe(true);
        });

        it('hasAnyIssues: false для milestone, заведённого без единой задачи', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.(() => []);
            expect(adapter.hasAnyIssues(EMPTY_MILESTONE)).toBe(false);
        });

        // #37: выбор модели ревью спрашивает у шва «какие метки у задач фазы» и трактует
        // непрочитанные метки как зону риска. Поэтому здесь важны оба свойства: имена
        // отдаются плоско (вызывающему нужен ответ «есть ли среди них вот эта») и отказ
        // форжа не подменяется пустым списком.
        it('listMilestoneLabels отдаёт ИМЕНА меток карточек фазы, включая закрытые', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.((cmd) =>
                cmd.includes('--state all') ? [{ labels: [{ name: 'blocked' }] }] : [],
            );
            expect(adapter.listMilestoneLabels(MILESTONE)).toContain('blocked');
        });

        it('НЕГАТИВНЫЙ: listMilestoneLabels fail-closed — пустой список ≠ отказ форжа', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setAllOpenThrows(true);
            hook.__setIssuesThrow?.(true);
            hook.__setGhJson?.(() => {
                throw new Error('gh issue list упал');
            });
            expect(() => adapter.listMilestoneLabels(MILESTONE)).toThrow();
        });

        // #37: счётчик находок ревью больше не ходит в форж сам — ленту отдаёт шов. Общий
        // контракт: тела, автор и отметка сводки; раскладка по поверхностям (у GitHub три
        // маршрута, у площадки один) остаётся внутри реализации.
        it('listPullRequestComments отдаёт тела и авторов, сводку помечает isSummary', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.((cmd) => {
                if (cmd.includes(`/pulls/${String(PR_NUMBER)}/comments`)) {
                    return [{ body: FINDING, user: { login: 'ok-author' } }];
                }
                if (cmd.includes(`/pulls/${String(PR_NUMBER)}/reviews`)) {
                    return [{ body: SUMMARY, user: { login: 'ok-author' } }];
                }
                // Пустое тело — обычное дело у прохода ревью без сводного текста.
                return [{ body: '   ', user: { login: 'ok-author' } }];
            });
            const comments = adapter.listPullRequestComments(PR_NUMBER);
            expect(comments.filter((c) => !c.isSummary).map((c) => c.body)).toEqual([FINDING]);
            // Сводка дублирует находки того же прохода: не пометив её, каждый проход
            // ревью давал бы систематический +1 в бакет своей метки.
            expect(comments.filter((c) => c.isSummary).map((c) => c.body)).toEqual([SUMMARY]);
            expect(comments.every((c) => c.author === 'ok-author')).toBe(true);
        });

        it('пустые тела в ленту не попадают — total метрики не разбавляется', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.(() => [{ body: '   ', user: { login: 'ok-author' } }]);
            expect(
                adapter.listPullRequestComments(PR_NUMBER).every((c) => c.body.trim() !== ''),
            ).toBe(true);
        });

        it('НЕГАТИВНЫЙ: listPullRequestComments fail-closed — пустая лента ≠ отказ форжа', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setCommentsThrow?.(true);
            hook.__setGhJson?.(() => {
                throw new Error('gh api упал');
            });
            // Молчаливая пустая лента дала бы журналу нули: «ревью прошло, находок нет» —
            // ровно то, чем выглядит и недоступный форж.
            expect(() => adapter.listPullRequestComments(PR_NUMBER)).toThrow();
        });

        // #45: ревью-сессия в форж не ходит — замечание ставит петля этим методом. Общее
        // свойство обеих реализаций: якорь доезжает (без него находка учтётся как сводка),
        // а отказ форжа виден вызывающему.
        it('commentOnPullRequest доносит тело и якорь до форжа', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.(() => ({ headRefOid: SHA }));
            adapter.commentOnPullRequest(PR_NUMBER, {
                body: FINDING,
                anchor: { path: 'src/a.ts', line: 42 },
            });
            const trace = [
                ...((adapter as unknown as { __calls?: () => string[] }).__calls?.() ?? []),
                ...(hook.__shArgvCalls?.() ?? []),
            ].join('\n');
            expect(trace).toContain('src/a.ts');
            expect(trace).toContain('42');
        });

        it('НЕГАТИВНЫЙ: commentOnPullRequest fail-closed — потерянное замечание не молчит', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setCommentsThrow?.(true);
            hook.__setMutationFails(true);
            hook.__setGhJson?.(() => {
                throw new Error('gh упал');
            });
            // Проглоченный отказ означал бы «замечание ревью просто исчезло»: и дефект
            // непойманный, и метрика находок заниженная — одновременно.
            expect(() => adapter.commentOnPullRequest(PR_NUMBER, { body: FINDING })).toThrow();
        });

        // #46: PR фазы заводит петля. Общее свойство: номер возвращается, а отказ форжа
        // виден вызывающему — без PR цикл сдачи не начинается вовсе.
        // #50: карточку читает петля — сессии нечем. Общее свойство: тело доезжает, а
        // отказ чтения виден вызывающему (иначе сессия работала бы по одному заголовку).
        it('getIssue отдаёт заголовок и тело карточки', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.(() => ({ number: 7, title: 'задача фазы', body: 'что и почему' }));
            const issue = adapter.getIssue(7);
            expect(issue.title).toBe('задача фазы');
            expect(issue.body).toContain('что и почему');
        });

        it('НЕГАТИВНЫЙ: getIssue fail-closed — пустая карточка не выдаётся за прочитанную', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setIssuesThrow?.(true);
            hook.__setGhJson?.(() => ({}));
            expect(() => adapter.getIssue(7)).toThrow();
        });

        it('createPullRequest заводит PR ветки и отдаёт его номер', () => {
            const { adapter } = build();
            expect(
                adapter.createPullRequest({ branch: BRANCH, title: 'feat: X', body: 'тело' }),
            ).toBe(7);
        });

        it('НЕГАТИВНЫЙ: createPullRequest fail-closed — «не смогли» не равно «создан»', () => {
            const { adapter } = build();
            (adapter as unknown as TaskSourceHook).__setMutationFails(true);
            expect(() =>
                adapter.createPullRequest({ branch: BRANCH, title: 'т', body: 'б' }),
            ).toThrow();
        });

        it('НЕГАТИВНЫЙ: hasAnyIssues fail-closed — бросает при сбое форжа', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            // Свой флаг там, где он есть; где чтения делит один транспорт — его отказ.
            hook.__setHasAnyThrows?.(true);
            hook.__setIssuesThrow?.(true);
            hook.__setGhJson?.(() => {
                throw new Error('gh issue list упал');
            });
            // Молчаливое false здесь означало бы «фаза не начата» на сетевом чихе —
            // петля встала бы с диагнозом «поправь конфиг», хотя конфиг верен.
            expect(() => adapter.hasAnyIssues(MILESTONE)).toThrow();
        });

        // ── Намерения кодер-сессии (#40) ────────────────────────────────────
        // Сессия в трекер не ходит: она пишет намерение, применяет петля ЭТИМИ методами.
        // На уровне контракта проверяется поведение, а не транспорт: как именно ложится
        // мутация (argv `gh` против REST площадки) — дело адаптера и его же тестов.

        it('комментарий, закрытие и blocked на карточке доходят до форжа', () => {
            const { adapter } = build();
            expect(() => adapter.commentOnIssue(7, 'что сделано и чем закончилось')).not.toThrow();
            expect(() => adapter.closeIssue(7)).not.toThrow();
            expect(() => adapter.blockIssue(9)).not.toThrow();
        });

        it('createIssue отдаёт номер заведённой карточки', () => {
            const { adapter } = build();
            // Метки — ИМЕНАМИ: про slug'и знает адаптер, не ядро и не промпт сессии.
            expect(adapter.createIssue({ title: 'т', body: 'б', labels: ['area:x'] })).toBe(101);
        });

        it('НЕГАТИВНЫЙ: намерения fail-closed — отказ форжа долетает исключением', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setMutationFails(true);
            // Проглоченный отказ означал бы: карточка не закрыта (фаза открыта навсегда)
            // или `blocked` не поставлен (петля сожжёт следующую итерацию об ту же стену),
            // и никто об этом не узнает. Поэтому здесь, в отличие от меток PR, не fail-open.
            expect(() => adapter.commentOnIssue(7, 'x')).toThrow();
            expect(() => adapter.closeIssue(7)).toThrow();
            expect(() => adapter.blockIssue(7)).toThrow();
            expect(() =>
                adapter.createIssue({ title: 'т', body: 'б', labels: ['area:x'] }),
            ).toThrow();
        });

        it('checkAuth молчит, когда форж доступен и токен принят', () => {
            const { adapter } = build();
            expect(() => adapter.checkAuth()).not.toThrow();
        });

        // Fail-closed именно на СТАРТЕ: недоступный форж, проверенный лениво, приходит
        // к петле как пустая очередь — то есть как «фаза готова к сдаче» (C2).
        it('НЕГАТИВНЫЙ: checkAuth fail-closed — бросает, когда форж отверг авторизацию', () => {
            const { adapter } = build();
            // Иначе тест зелен от `TypeError: checkAuth is not a function` — то есть ровно
            // тогда, когда метода нет вовсе.
            expect(typeof adapter.checkAuth).toBe('function');
            (adapter as unknown as TaskSourceHook).__setAuthFails(true);
            expect(() => adapter.checkAuth()).toThrow();
        });

        it('findOpenPullRequest: PR найден → возвращает его', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            if (hook.__setGhJson) {
                hook.__setGhJson((cmd) => {
                    if (cmd.includes('gh pr list --head')) return [{ number: 9, labels: [] }];
                    throw new Error(`unexpected: ${cmd}`);
                });
            } else if (hook.__setPr) {
                hook.__setPr(BRANCH, { number: 9, labels: [] });
            }
            expect(adapter.findOpenPullRequest(BRANCH)).toEqual({ number: 9, labels: [] });
        });

        it('findOpenPullRequest: PR нет → null', () => {
            const { adapter } = build();
            expect(adapter.findOpenPullRequest('feature/none')).toBeNull();
        });

        it('НЕГАТИВНЫЙ: findOpenPullRequest — неоднозначность (>1 открытый PR) → null, не гадаем', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            const two: PullRequest[] = [
                { number: 9, labels: [] },
                { number: 10, labels: [] },
            ];
            if (hook.__setGhJson) {
                hook.__setGhJson((cmd) => {
                    if (cmd.includes('gh pr list --head')) return two;
                    throw new Error(`unexpected: ${cmd}`);
                });
            } else if (hook.__setPrs) {
                hook.__setPrs(BRANCH, two);
            } else {
                return; // фейк-флейвор не моделирует множественность отдельно
            }
            expect(adapter.findOpenPullRequest(BRANCH)).toBeNull();
        });

        // #49: голову PR — ту самую, на которой гейт гоняет чеки и к которой прижимает
        // мердж, — отдаёт ФОРЖ. До этого её читал сам гейт командой `gh pr view`, и на
        // площадке без `gh` мердж-путь был мёртв: три ретрая и 'not-merged' навсегда.
        it('pullRequestHeadSha отдаёт голову PR', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.((cmd) => {
                if (cmd.includes('gh pr view')) return { headRefOid: SHA };
                throw new Error(`unexpected: ${cmd}`);
            });
            expect(adapter.pullRequestHeadSha(PR_NUMBER)).toBe(SHA);
        });

        // Fail-closed, и это не формальность: «не смогли прочитать голову» гейт обязан
        // трактовать как отказ мерджа. Пустая строка вместо исключения увела бы его в
        // ветку «голова не похожа на sha» — тот же исход, но с неверным диагнозом в логе.
        it('НЕГАТИВНЫЙ: pullRequestHeadSha fail-closed — форж недоступен → бросает', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            if (hook.__setGhJson) {
                hook.__setGhJson(() => {
                    throw new Error('форж недоступен');
                });
            } else if (hook.__setHeadThrows) {
                hook.__setHeadThrows(true);
            } else {
                // Не `return`: тихий пропуск превратил бы негативный тест в зелёный no-op —
                // ровно тот класс, из-за которого до этого PR контрактная сверка головы
                // молча не выполнялась на фейке. Нет ручки отказа — красный.
                throw new Error(`${label}: флейвор не дал ручку отказа чтения головы`);
            }
            expect(() => adapter.pullRequestHeadSha(PR_NUMBER)).toThrow();
        });

        it('НЕГАТИВНЫЙ: форж ответил без головы → бросает, а не отдаёт пустую строку', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            if (hook.__setGhJson) hook.__setGhJson(() => ({}));
            else if (hook.__setActualHead) hook.__setActualHead('');
            else throw new Error(`${label}: флейвор не дал ручку «ответ без головы»`);
            expect(() => adapter.pullRequestHeadSha(PR_NUMBER)).toThrow();
        });

        // Свойство контракта, а не механизм: мердж не имеет права уехать на голову,
        // которую гейт не проверял. `gh` закрывает это серверной привязкой
        // (--match-head-commit, ассерт ниже), SourceCraft — сверкой головы перед мерджем.
        // Проверяем ИСХОД, поэтому тест общий для обоих способов.
        it('НЕГАТИВНЫЙ: голова уехала после чеков → мердж не выполняется', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            if (!hook.__setActualHead) return; // серверную привязку моделирует argv-ассерт
            hook.__setActualHead('b'.repeat(40));
            expect(() => adapter.mergePullRequest(42, SHA)).toThrow(/уехала|head/i);
        });

        it('mergePullRequest прокидывает sha головы (для --match-head-commit) и не бросает', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            expect(() => adapter.mergePullRequest(42, SHA)).not.toThrow();
            // Боевой флейвор: проверяем не только «не бросает», а что sha реально уехал в
            // argv `gh pr merge` через --match-head-commit — то самое TOCTOU-свойство
            // контракта. Фейк argv не моделирует, для него достаточно not.toThrow выше.
            if (hook.__shArgvCalls) {
                const mergeArgv = hook.__shArgvCalls().find((c) => c.includes('pr merge'));
                expect(mergeArgv).toContain(`--match-head-commit ${SHA}`);
            }
        });

        it('НЕГАТИВНЫЙ: mergePullRequest без валидного sha — мердж БЕЗ --match-head-commit', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            if (!hook.__shArgvCalls) return; // ветку SHA40_RE моделирует только боевой argv
            expect(() => adapter.mergePullRequest(42, '')).not.toThrow();
            const mergeArgv = hook.__shArgvCalls().find((c) => c.includes('pr merge'));
            expect(mergeArgv).toBeDefined();
            expect(mergeArgv).not.toContain('--match-head-commit');
        });

        it('addBlockedLabel/removeBlockedLabel/closeMilestone/syncBoard не бросают (fail-open)', () => {
            const { adapter } = build();
            const hook = adapter as unknown as TaskSourceHook;
            hook.__setGhJson?.((cmd) => {
                if (cmd.includes('milestones?state=open')) return [];
                throw new Error(`unexpected: ${cmd}`);
            });
            expect(() => adapter.addBlockedLabel(BRANCH)).not.toThrow();
            expect(() => adapter.removeBlockedLabel(BRANCH)).not.toThrow();
            expect(() => adapter.closeMilestone(MILESTONE)).not.toThrow();
            expect(() => adapter.syncBoard()).not.toThrow();
        });
    });
}

// Третий флейвор — вторая НАСТОЯЩАЯ реализация шва, и в этом его ценность: до сих пор
// контракт держали фейк и одна боевая логика, а «интерфейс» с единственной реализацией
// всегда описывает эту реализацию, а не контракт. Здесь подменён только транспорт (одна
// функция `api` вместо `ghJson`/`shArgv`) — все поведенческие ассерты те же.
function buildSourcecraftTaskSource(): { adapter: TaskSourceAdapter; calls: string[] } {
    const calls: string[] = [];
    // Ответы площадки в её форме: карточка — строковый `slug`, автор — `author.slug`.
    const scIssues = ISSUES.map((i) => ({
        slug: String(i.number),
        title: i.title,
        labels: (i.labels ?? []).map((l) => ({ name: l.name, slug: l.name })),
        author: { slug: i.author?.login },
    }));
    let openPulls: Array<{ slug: string; labels: unknown[] }> = [];
    const mergedPulls: Array<{ slug: string; labels: unknown[] }> = [];
    let issuesThrow = false;
    let authFails = false;
    let mutationFails = false;
    let commentsThrow = false;
    // Голова PR на стороне форжа. По умолчанию совпадает с той, что проверил гейт, —
    // иначе штатный мердж-тест ловил бы отказ, которого в сценарии нет.
    let actualHead = SHA;
    // #49: отказ чтения головы. Свой флаг, а не общий с карточками: у площадки это
    // отдельный маршрут `GET /pulls/{n}`.
    let headThrows = false;

    // Slug milestone на площадке ОТЛИЧАЕТСЯ от имени фазы в конфиге — как в жизни
    // (генерируется из имени с потерей символов). Фикстура, отдающая карточки на имя
    // фазы, разделила бы с адаптером его же неверное допущение и была бы зелёной при
    // сломанном фильтре — этим и был ослепший тест до правки.
    const MILESTONE_SLUG = 'faza-x';

    const api = (method: string, path: string, body?: unknown) => {
        calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
        // Отвергнутый токен площадка отдаёт 401 на ЛЮБОМ маршруте, а транспорт превращает
        // ненулевой код curl в исключение — моделируем именно это, а не отказ одного пути.
        if (authFails) throw new Error('SourceCraft GET: curl вернул 22 — HTTP 401');
        if (path.includes('/issues?')) {
            if (issuesThrow) throw new Error('SourceCraft: issues упал');
            // Карточки — только на ПРАВИЛЬНЫЙ slug в QL-фильтре; на что угодно другое
            // (включая имя фазы) сервер отдаёт пусто.
            const hit = decodeURIComponent(path).includes(`milestone_slug="${MILESTONE_SLUG}"`);
            return { issues: hit ? scIssues : [] };
        }
        if (path.includes('/pulls?')) {
            const merged = path.includes('status%3Dmerged');
            return { pull_requests: merged ? mergedPulls : openPulls };
        }
        // Список milestones приходит ключом `items` (живой ответ площадки), у карточки
        // поле `name`, а не `title`.
        if (mutationFails && method !== 'GET') throw new Error('SourceCraft: мутация отвергнута');
        // #40: справочник меток — тот же ключ `items`, что у milestones (живой ответ).
        if (path.includes('/labels?')) {
            return {
                items: [
                    { name: 'blocked', slug: 'blocked' },
                    { name: 'area:x', slug: 'area-x' },
                ],
            };
        }
        // Создание карточки: площадка отдаёт её строковым `slug`.
        if (method === 'POST' && /\/issues$/.test(path.split('?')[0])) {
            return { slug: '101' };
        }
        if (path.includes('/milestones?')) {
            return {
                items: [
                    { name: MILESTONE, slug: MILESTONE_SLUG },
                    // #39: заведён, но без единой карточки — на его slug выборка выше
                    // отдаёт пусто (фильтр не совпадает с MILESTONE_SLUG).
                    { name: EMPTY_MILESTONE, slug: 'faza-pustaya' },
                ],
            };
        }
        // #50: одиночная карточка — маршрут без `?`, тело в поле `description`.
        if (/\/issues\/\d+$/.test(path) && method === 'GET') {
            if (issuesThrow) throw new Error('SourceCraft: issues упал');
            return { slug: '7', title: 'задача фазы', description: 'что и почему надо сделать' };
        }
        // #46: создание PR — ответ несёт `slug` и `status` (draft/open/…).
        if (method === 'POST' && /\/pulls$/.test(path)) {
            return { slug: '7', status: 'open' };
        }
        // #37: комментарии PR — ключ `pull_request_comments`, автор в `author.slug`,
        // `anchor` есть только у комментария к месту в диффе (сверено с OpenAPI площадки и
        // её живым ответом). Пустое тело в фикстуре не для полноты: контракт требует, чтобы
        // такие в ленту не попадали.
        if (/\/pulls\/\d+\/comments/.test(path)) {
            if (commentsThrow) throw new Error('SourceCraft: комментарии не отдались');
            return {
                pull_request_comments: [
                    { body: FINDING, author: { slug: 'ok-author' }, anchor: { path: 'a.ts' } },
                    { body: SUMMARY, author: { slug: 'ok-author' } },
                    { body: '   ', author: { slug: 'ok-author' } },
                ],
            };
        }
        // Голова PR — поле `source.sha` (сверено с OpenAPI площадки).
        if (/\/pulls\/\d+$/.test(path)) {
            if (headThrows) throw new Error('SourceCraft: голова PR не отдалась');
            return { source: { sha: actualHead } };
        }
        return {};
    };

    const adapter = createSourcecraftTaskSource({
        api: api as SourcecraftApi,
        org: 'org',
        repo: 'repo',
        authorAllowlist: () => ALLOWLIST,
    });

    const hook = adapter as unknown as TaskSourceHook;
    hook.__setPr = (_branch, pr) => {
        openPulls = pr ? [{ slug: String(pr.number), labels: pr.labels ?? [] }] : [];
    };
    hook.__setPrs = (_branch, prs) => {
        openPulls = prs.map((p) => ({ slug: String(p.number), labels: p.labels ?? [] }));
    };
    hook.__setActualHead = (sha) => {
        actualHead = sha;
    };
    hook.__setHeadThrows = (v) => {
        headThrows = v;
    };
    hook.__setAllOpenThrows = (v) => {
        issuesThrow = v;
    };
    // У площадки оба чтения карточек идут одним маршрутом `/issues?` — отдельного флага
    // под hasAnyIssues тут нет не по недосмотру: он моделировал бы отказ, которого у этой
    // реализации не бывает.
    hook.__setIssuesThrow = (v) => {
        issuesThrow = v;
    };
    hook.__setMutationFails = (v) => {
        mutationFails = v;
    };
    hook.__setAuthFails = (v) => {
        authFails = v;
    };
    hook.__setCommentsThrow = (v) => {
        commentsThrow = v;
    };
    hook.__calls = () => calls;
    // `mergedPulls` остаётся пустым: контракт проверяет isPhaseMerged/mergedPullRequestNumber
    // только на «не смерджено», а переход в merged — сценарные сьюты мердж-пути.
    void mergedPulls;
    return { adapter, calls };
}

registerTaskSourceContract('фейк (in-memory)', buildFakeTaskSource);
registerTaskSourceContract('боевая логика (gate.ts + ralph.js DI)', buildRealTaskSource);
registerTaskSourceContract('боевая логика SourceCraft (REST)', buildSourcecraftTaskSource);

// ── GateAdapter ──────────────────────────────────────────────────────────────────────

function buildFakeGate(passing: Set<string>): GateAdapter {
    const base: Array<[string, string]> = [
        ['lint', 'npm run lint'],
        ['test', 'npm run test'],
    ];
    return {
        resolveChecks: (profileName) =>
            profileName === 'prod' ? [...base, ['e2e', 'npm run e2e']] : [...base],
        runChecks: (branch, prNumber) => {
            const red = base.find(([, cmd]) => !passing.has(cmd));
            if (red) {
                return {
                    green: false,
                    verifiedHead: null,
                    redCheck: { name: red[0], cmd: red[1], excerpt: 'fail' },
                };
            }
            return { green: true, verifiedHead: `sha-${branch}-${prNumber}`, redCheck: null };
        },
    };
}

// Боевая логика: createGateRunner(fakeEnv) — та же checksGreen/gateChecksFor, что реально
// гоняет гейт мерджа; runChecks собирает GateCheckResult ровно как orchestrator.ts::gateRunChecks
// (composition root, #369) — это НЕ новая логика, а тот же приём сведения boolean+геттеров в
// один объект вердикта.
function buildRealGate(passing: Set<string>): GateAdapter {
    const checks: Array<[string, string]> = [
        ['lint', 'npm run lint'],
        ['test', 'npm run test'],
    ];
    const gateEnv = makeGateEnv({
        getConfig: () => ({
            gate: { checks, prodChecks: [['e2e', 'npm run e2e']], prodDropChecks: [] },
        }),
        prHeadSha: () => SHA,
        shArgv: () => '',
        sh: (cmd) => {
            if (cmd.includes('rev-parse')) return ''; // без локальной ветки — путь H3 не участвует
            if (passing.has(cmd)) return 'ok';
            const e = new Error('красный чек') as Error & { stdout?: string; stderr?: string };
            e.stderr = `${cmd} упал`;
            throw e;
        },
    });
    const g = createGateRunner(gateEnv);
    function runChecks(branch: string, prNumber: number): GateCheckResult {
        const green = g.checksGreen(branch, prNumber, { checks: g.gateChecksFor() });
        if (green) return { green: true, verifiedHead: g.getVerifiedHead(), redCheck: null };
        return {
            green: false,
            verifiedHead: null,
            redCheck: g.getLastRedCheck() ?? {
                name: 'gate',
                cmd: 'checksGreen',
                excerpt: 'гейт упал до чеков',
            },
        };
    }
    return createNpmGate({ resolveChecks: g.gateChecksFor, runChecks });
}

function registerGateContract(label: string, build: (passing: Set<string>) => GateAdapter): void {
    describe(`GateAdapter — ${label}`, () => {
        it('resolveChecks добавляет толстые чеки в профиле prod', () => {
            const gate = build(new Set());
            expect(gate.resolveChecks(undefined).map(([n]) => n)).toEqual(['lint', 'test']);
            expect(gate.resolveChecks('prod').map(([n]) => n)).toEqual(['lint', 'test', 'e2e']);
        });

        it('runChecks зелёный: green=true, verifiedHead задан, redCheck=null', () => {
            const gate = build(new Set(['npm run lint', 'npm run test']));
            const res = gate.runChecks(BRANCH, 9);
            expect(res.green).toBe(true);
            expect(res.verifiedHead).not.toBeNull();
            expect(res.redCheck).toBeNull();
        });

        it('НЕГАТИВНЫЙ: runChecks красный — green=false, verifiedHead=null, redCheck заполнен именем чека', () => {
            const gate = build(new Set(['npm run lint'])); // test красный
            const res = gate.runChecks(BRANCH, 9);
            expect(res.green).toBe(false);
            expect(res.verifiedHead).toBeNull();
            expect(res.redCheck?.name).toBe('test');
        });
    });
}

registerGateContract('фейк (in-memory)', buildFakeGate);
registerGateContract('боевая логика (gate.ts, createGateRunner)', buildRealGate);

// ── NotifierAdapter ──────────────────────────────────────────────────────────────────

function buildFakeNotifier(fail: boolean): { adapter: NotifierAdapter; sent: string[] } {
    const sent: string[] = [];
    return {
        sent,
        adapter: {
            notify: (text) => {
                if (fail) return false;
                sent.push(text);
                return true;
            },
        },
    };
}

// Боевая логика: sendTelegramMessage реальный (telegram-notifier.ts), execFn подменён —
// та же граница DI, что telegram-notifier.test.ts.
function buildRealNotifier(fail: boolean): { adapter: NotifierAdapter; sent: string[] } {
    const sent: string[] = [];
    const execFn = (_file: string, args: string[]): string => {
        if (fail) {
            throw new Error('Command failed: curl …');
        }
        // --data-urlencode text=<...> — вытащим отправленный текст для ассерта.
        const textArg = args.find((a) => a.startsWith('text='));
        sent.push(textArg ? decodeURIComponent(textArg.slice('text='.length)) : '');
        return '{"ok":true}';
    };
    return {
        sent,
        adapter: createTelegramNotifier({
            notify: (text: string) =>
                sendTelegramMessage(text, {
                    token: '123:abc',
                    chatId: '42',
                    execFn,
                    logFn: () => {},
                    sleepFn: () => {},
                    attempts: 1,
                }),
        }),
    };
}

function registerNotifierContract(
    label: string,
    build: (fail: boolean) => { adapter: NotifierAdapter; sent: string[] },
): void {
    describe(`NotifierAdapter — ${label}`, () => {
        it('доставляет текст и возвращает true', () => {
            const { adapter, sent } = build(false);
            expect(adapter.notify('привет')).toBe(true);
            expect(sent).toEqual(['привет']);
        });

        it('НЕГАТИВНЫЙ: при сбое доставки возвращает false и НЕ бросает (fail-open по определению)', () => {
            const { adapter } = build(true);
            expect(() => adapter.notify('падение доставки')).not.toThrow();
            expect(adapter.notify('падение доставки')).toBe(false);
        });
    });
}

registerNotifierContract('фейк (in-memory)', buildFakeNotifier);
registerNotifierContract(
    'боевая логика (telegram-notifier.ts, execFn подменён)',
    buildRealNotifier,
);

// ── DeployCheckAdapter ───────────────────────────────────────────────────────────────

function buildFakeDeployCheck(): DeployCheckAdapter {
    return {
        // #51: «есть ли в проекте деплой вообще». У этого флейвора — да, он его моделирует.
        isEnabled: () => true,
        mergedShaOf: (prNumber) => {
            throw new Error(`нет sha мерджа для PR ${prNumber}`);
        },
        waitForDeployRun: (sha) => ({
            status: 'not-found',
            conclusion: null,
            sha,
            url: null,
            runId: null,
        }),
        checkHealth: () => ({ ok: false, status: 0, url: '', reason: 'config' }),
        classifyOutcome: (outcome, health) => {
            const green =
                !!outcome && outcome.status === 'completed' && outcome.conclusion === 'success';
            if (!green) return { red: true, reason: 'workflow не зелёный' };
            if (health && health.ok === false) return { red: true, reason: 'прод не отвечает' };
            return { red: false, reason: 'ok' };
        },
    };
}

// Боевая логика: createDeployCheckModule(fakeEnv) — та же ghJson-фикстура и execFn-подмена,
// что deploy-check.test.ts.
function buildRealDeployCheck(opts: { healthUrl?: string } = {}): DeployCheckAdapter {
    const cfg = { deployCheck: { healthUrl: opts.healthUrl ?? '' } };
    const dc = createDeployCheckModule(
        makeDeployEnv({
            getConfig: () => cfg,
            ghJson: () => {
                throw new Error('mergeCommit не резолвится (нет sha)');
            },
        }),
    );
    return createGithubActionsDeploy({
        mergedShaOf: (prNumber: number) =>
            dc.mergedShaOf(prNumber, { attempts: 1, sleepFn: () => {} }),
        waitForDeployRun: dc.waitForDeployRun,
        checkProdHealth: () =>
            dc.checkProdHealth(cfg, {
                execFn: () => {
                    throw new Error('curl не должен звать сеть в этом тесте');
                },
                sleepFn: () => {},
                logFn: () => {},
            }),
        classifyDeployOutcome: dc.classifyDeployOutcome,
    });
}

function registerDeployCheckContract(
    label: string,
    build: (opts?: { healthUrl?: string }) => DeployCheckAdapter,
): void {
    describe(`DeployCheckAdapter — ${label}`, () => {
        const green = {
            status: 'completed' as const,
            conclusion: 'success',
            sha: 'b'.repeat(40),
            url: 'https://ci.test/run/1',
            runId: 1,
        };

        it('GREEN только при зелёном workflow И здоровом проде', () => {
            const dc = build();
            expect(dc.classifyOutcome(green, { ok: true, status: 200, url: 'u' }).red).toBe(false);
        });

        it('красный при незелёном workflow', () => {
            const dc = build();
            const timeout = {
                status: 'timeout' as const,
                conclusion: null,
                sha: green.sha,
                url: null,
                runId: null,
            };
            expect(dc.classifyOutcome(timeout, { ok: true, status: 200, url: 'u' }).red).toBe(true);
        });

        it('НЕГАТИВНЫЙ: mergedShaOf fail-closed — бросает, когда sha не резолвится', () => {
            const dc = build();
            expect(() => dc.mergedShaOf(5)).toThrow();
        });

        // #51: у контракта появился вопрос «а есть ли деплой». Ответ обязан быть честным
        // булевым, а не «попробуем и упадём»: на нём стоит и пропуск пост-мердж проверки,
        // и требование healthUrl в preflight — оба решения принимаются ДО первого вызова.
        it('isEnabled: реализация с деплоем отвечает true', () => {
            const dc = build();
            expect(typeof dc.isEnabled).toBe('function');
            expect(dc.isEnabled()).toBe(true);
        });

        it('НЕГАТИВНЫЙ: checkHealth reason:"config" при незаданном healthUrl (не путаем с «прод упал»)', () => {
            const dc = build({ healthUrl: '' });
            const health = dc.checkHealth();
            expect(health.ok).toBe(false);
            expect(health.reason).toBe('config');
        });
    });
}

// Третий флейвор — реализация «деплоя нет» (#51). Она НЕ проходит общий контракт целиком
// и не должна: половина его вопросов («зелёный ли workflow») к проекту без деплоя не
// применима. Поэтому отдельный блок — и он проверяет главное: no-op честен, то есть
// отвечает `false` и НЕ притворяется, что что-то проверил.
describe('DeployCheckAdapter — реализация «деплоя нет» (#51)', () => {
    it('isEnabled → false', () => {
        expect(createNoDeployCheck().isEnabled()).toBe(false);
    });

    it('остальные методы БРОСАЮТ, а не возвращают выдуманный зелёный', () => {
        const dc = createNoDeployCheck();
        // Тихий `{red:false}` был бы худшим исходом: петля решила бы, что релиз проверен,
        // хотя проверять нечем. Вызов сюда вообще не должен доходить — ядро спрашивает
        // isEnabled первым, — а если дошёл, это ошибка проводки, и она обязана быть громкой.
        expect(() => dc.mergedShaOf(7)).toThrow(/деплоя в проекте нет/i);
        expect(() => dc.waitForDeployRun('a'.repeat(40))).toThrow(/деплоя в проекте нет/i);
        expect(() => dc.checkHealth()).toThrow(/деплоя в проекте нет/i);
        expect(() => dc.classifyOutcome(null, null)).toThrow(/деплоя в проекте нет/i);
    });
});

registerDeployCheckContract('фейк (in-memory)', buildFakeDeployCheck);
registerDeployCheckContract(
    'боевая логика (deploy-check.ts, createDeployCheckModule)',
    buildRealDeployCheck,
);

// ── CoderRuntimeAdapter ──────────────────────────────────────────────────────────────

function buildFakeRuntime(result: { code: number; output: string }): CoderRuntimeAdapter {
    return createCoderRuntime({ run: () => ({ code: result.code, output: result.output }) });
}

// Боевая логика: buildClaudeArgs + spawnClaude (ralph.js), spawnFn подменён — та же граница
// DI, что и в orchestrator.test.ts (явная инъекция, НЕ vi.mock('node:child_process')).
function buildRealRuntime(spawnResult: {
    status: number | null;
    stdout: string;
    stderr: string;
    signal?: string | null;
}): CoderRuntimeAdapter {
    const spawnFn = vi.fn(() => spawnResult);
    return createCoderRuntime({
        run: (prompt: string, options): RunResult => {
            const argv = ralph.buildClaudeArgs(options, {});
            return ralph.spawnClaude(argv, prompt, 1000, spawnFn);
        },
    });
}

function registerCoderRuntimeContract(
    label: string,
    buildOk: () => CoderRuntimeAdapter,
    buildFail: () => CoderRuntimeAdapter,
    buildKilled: () => CoderRuntimeAdapter,
): void {
    describe(`CoderRuntimeAdapter — ${label}`, () => {
        it('run возвращает код и объединённый вывод при успехе', () => {
            const adapter = buildOk();
            const res = adapter.run('почини баг', { maxTurns: 40 });
            expect(res.code).toBe(0);
        });

        it('НЕГАТИВНЫЙ: ненулевой код процесса не бросает — просто отражается в code', () => {
            const adapter = buildFail();
            expect(() => adapter.run('задача', { maxTurns: 10 })).not.toThrow();
            expect(adapter.run('задача', { maxTurns: 10 }).code).not.toBe(0);
        });

        it('НЕГАТИВНЫЙ: процесс убит по сигналу (таймаут) → code:1, не бросает', () => {
            const adapter = buildKilled();
            const res = adapter.run('задача', { maxTurns: 10 });
            expect(res.code).toBe(1);
        });
    });
}

registerCoderRuntimeContract(
    'фейк (in-memory)',
    () => buildFakeRuntime({ code: 0, output: 'готово' }),
    () => buildFakeRuntime({ code: 2, output: 'boom' }),
    () => buildFakeRuntime({ code: 1, output: 'killed' }),
);
registerCoderRuntimeContract(
    'боевая логика (buildClaudeArgs + spawnClaude, spawnFn подменён)',
    () => buildRealRuntime({ status: 0, stdout: 'готово', stderr: '' }),
    () => buildRealRuntime({ status: 2, stdout: '', stderr: 'boom' }),
    () => buildRealRuntime({ status: null, stdout: '', stderr: '', signal: 'SIGTERM' }),
);

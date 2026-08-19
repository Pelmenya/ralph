// Тесты сборки адаптеров (#369): резолв выбора из конфига (fail-closed), мапперы боевых
// функций в методы интерфейсов (сдвиг имён — работа маппера) и buildAdapters (выбор по
// конфигу + fail на незарегистрированной реализации). Это НЕ контрактный сьют против
// боевых модулей (#370) — здесь фейки; проверяем именно ЛОГИКУ сборки и выбора.
import { describe, expect, it, vi } from 'vitest';
import type {
    CoderRuntimeAdapter,
    DeployCheckAdapter,
    GateAdapter,
    NotifierAdapter,
    TaskSourceAdapter,
} from './adapters.ts';
import {
    ADAPTER_DEFAULTS,
    ADAPTER_SEAMS,
    buildAdapters,
    createCoderRuntime,
    createGithubActionsDeploy,
    createGithubTaskSource,
    createNpmGate,
    createTelegramNotifier,
    MERGE_PATH_BOUND_SEAMS,
    resolveAdapterSelection,
    type AdapterRegistries,
} from './adapters-impl.ts';

// fail, который бросает (боевой уходит в process.exit) — чтобы тест увидел стоп.
function throwingFail(msg: string): never {
    throw new Error(msg);
}

// --- resolveAdapterSelection --------------------------------------------------

describe('resolveAdapterSelection — выбор реализаций из конфига (fail-closed)', () => {
    it('пустой/отсутствующий конфиг → полный дефолт по всем швам', () => {
        expect(resolveAdapterSelection(undefined, throwingFail)).toEqual(ADAPTER_DEFAULTS);
        expect(resolveAdapterSelection({}, throwingFail)).toEqual(ADAPTER_DEFAULTS);
    });

    it('заданный шов переопределяет дефолт, остальные остаются дефолтными', () => {
        const sel = resolveAdapterSelection({ coderRuntime: 'kimi' }, throwingFail);
        expect(sel.coderRuntime).toBe('kimi');
        expect(sel.taskSource).toBe(ADAPTER_DEFAULTS.taskSource);
        expect(sel.gate).toBe(ADAPTER_DEFAULTS.gate);
    });

    it('неизвестный ключ шва → fail (опечатка не уходит в тихий дефолт)', () => {
        expect(() => resolveAdapterSelection({ taskSrc: 'github' } as never, throwingFail)).toThrow(
            /неизвестный шов/,
        );
    });

    it('нестроковое или пустое имя реализации → fail', () => {
        expect(() => resolveAdapterSelection({ gate: '' }, throwingFail)).toThrow(
            /непустой строкой/,
        );
        expect(() => resolveAdapterSelection({ gate: '   ' }, throwingFail)).toThrow(
            /непустой строкой/,
        );
        expect(() => resolveAdapterSelection({ gate: 7 as never }, throwingFail)).toThrow(
            /непустой строкой/,
        );
    });

    it('ADAPTER_SEAMS перечисляет ровно ключи ADAPTER_DEFAULTS', () => {
        expect([...ADAPTER_SEAMS].sort()).toEqual(Object.keys(ADAPTER_DEFAULTS).sort());
    });

    // #415: мердж-путь (tryMergePhase → findOpenPr/checksGreen/mergePr) берёт функции из
    // замыкания gate.ts, а не из adapters.*. Принять недефолтный gate/taskSource значило бы
    // соврать: чеки и мердж всё равно пошли бы через дефолт («тихий дефолт», инвариант №1).
    it('недефолтный gate → fail: мердж-путь этот шов не роутит', () => {
        expect(() => resolveAdapterSelection({ gate: 'cargo' }, throwingFail)).toThrow(
            /свап этого шва пока не поддержан/,
        );
        // Сообщение обязано объяснять причину, а не только запрещать.
        expect(() => resolveAdapterSelection({ gate: 'cargo' }, throwingFail)).toThrow(
            /tryMergePhase/,
        );
    });

    // Снятие барьера для taskSource: мердж-путь получает findOpenPr/mergePr/phaseMerged
    // из adapters.taskSource (composition root, orchestrator.ts), поэтому недефолтное имя
    // больше не было бы «тихим дефолтом» — оно действительно доедет до мердж-пути.
    // Валидность самого имени (есть ли такая реализация в реестре) проверяет buildAdapters:
    // у резолвера реестра нет, он знает только имена швов.
    it('недефолтный taskSource принимается — мердж-путь роутится через шов', () => {
        expect(
            resolveAdapterSelection({ taskSource: 'sourcecraft' }, throwingFail).taskSource,
        ).toBe('sourcecraft');
    });

    it('ЯВНО заданный дефолт связанного шва проходит (запрет на свап, а не на упоминание)', () => {
        const sel = resolveAdapterSelection({ gate: ADAPTER_DEFAULTS.gate }, throwingFail);
        expect(sel).toEqual(ADAPTER_DEFAULTS);
    });

    it('свапаемые швы барьер не задевает: coderRuntime/notifier/deployCheck проходят', () => {
        // Рантаймы Kimi/OpenAI (#373/#374) проведены через switch(adapters) полностью —
        // барьер #415 не должен ломать работающую свапаемость.
        expect(resolveAdapterSelection({ coderRuntime: 'kimi' }, throwingFail).coderRuntime).toBe(
            'kimi',
        );
        expect(resolveAdapterSelection({ coderRuntime: 'openai' }, throwingFail).coderRuntime).toBe(
            'openai',
        );
        // notifier/deployCheck: имя может быть незарегистрированным (это ловит buildAdapters),
        // но САМ выбор резолвер обязан пропустить — швы свапаемы по построению.
        expect(resolveAdapterSelection({ notifier: 'slack' }, throwingFail).notifier).toBe('slack');
        expect(
            resolveAdapterSelection({ deployCheck: 'gitlab-ci' }, throwingFail).deployCheck,
        ).toBe('gitlab-ci');
    });

    it('MERGE_PATH_BOUND_SEAMS — подмножество ADAPTER_SEAMS (опечатка не отключит барьер молча)', () => {
        for (const seam of MERGE_PATH_BOUND_SEAMS) {
            expect(ADAPTER_SEAMS).toContain(seam);
        }
    });
});

// --- Мапперы: боевые функции → имена методов интерфейса -----------------------

describe('createGithubTaskSource — раскладка функций форжа по методам интерфейса', () => {
    it('методы интерфейса зовут соответствующие боевые функции (сдвиг имён)', () => {
        const calls: string[] = [];
        const spy =
            (name: string, ret?: unknown) =>
            (...args: unknown[]) => {
                calls.push(`${name}:${JSON.stringify(args)}`);
                return ret;
            };
        const ts: TaskSourceAdapter = createGithubTaskSource({
            openIssues: spy('openIssues', []) as never,
            allOpenIssues: spy('allOpenIssues', []) as never,
            hasAnyIssues: spy('hasAnyIssues', true) as never,
            milestoneLabels: spy('milestoneLabels', []) as never,
            prComments: spy('prComments', []) as never,
            commentOnPr: spy('commentOnPr') as never,
            createPr: spy('createPr', 7) as never,
            getIssue: spy('getIssue', { number: 7, title: 'задача', body: 'тело задачи' }) as never,
            checkAuth: spy('checkAuth') as never,
            findOpenPr: spy('findOpenPr', null) as never,
            prHeadSha: spy('prHeadSha', 'a'.repeat(40)) as never,
            phaseMerged: spy('phaseMerged', true) as never,
            mergedPhasePr: spy('mergedPhasePr', 42) as never,
            mergePr: spy('mergePr') as never,
            addBlockedLabel: spy('addBlockedLabel') as never,
            removeBlockedLabel: spy('removeBlockedLabel') as never,
            closeMilestoneByTitle: spy('closeMilestoneByTitle') as never,
            syncProjectBoard: spy('syncProjectBoard') as never,
            commentOnIssue: spy('commentOnIssue') as never,
            closeIssue: spy('closeIssue') as never,
            blockIssue: spy('blockIssue') as never,
            createIssue: spy('createIssue', 101) as never,
        });
        ts.listReadyIssues('MS');
        ts.listAllOpenIssues('MS');
        expect(ts.hasAnyIssues('MS')).toBe(true);
        ts.listMilestoneLabels('MS');
        ts.listPullRequestComments(42);
        ts.commentOnPullRequest(42, { body: 'текст' });
        expect(ts.getIssue(7).title).toBe('задача');
        expect(ts.createPullRequest({ branch: 'feature/x', title: 'т', body: 'б' })).toBe(7);
        ts.findOpenPullRequest('feature/x');
        expect(ts.pullRequestHeadSha(7)).toBe('a'.repeat(40));
        expect(ts.isPhaseMerged({ branch: 'feature/x' })).toBe(true);
        expect(ts.mergedPullRequestNumber({ branch: 'feature/x' })).toBe(42);
        ts.mergePullRequest(7, 'a'.repeat(40));
        ts.addBlockedLabel('feature/x');
        ts.removeBlockedLabel('feature/x');
        ts.closeMilestone('MS');
        ts.syncBoard();
        ts.commentOnIssue(7, 'текст');
        ts.closeIssue(7);
        ts.blockIssue(9);
        expect(ts.createIssue({ title: 'т', body: 'б', labels: ['area:devops'] })).toBe(101);
        expect(calls).toEqual([
            'openIssues:["MS"]',
            'allOpenIssues:["MS"]',
            'hasAnyIssues:["MS"]',
            'milestoneLabels:["MS"]',
            'prComments:[42]',
            'commentOnPr:[42,{"body":"текст"}]',
            'getIssue:[7]',
            'createPr:[{"branch":"feature/x","title":"т","body":"б"}]',
            'findOpenPr:["feature/x"]',
            'prHeadSha:[7]',
            'phaseMerged:[{"branch":"feature/x"}]',
            'mergedPhasePr:[{"branch":"feature/x"}]',
            `mergePr:[7,"${'a'.repeat(40)}"]`,
            'addBlockedLabel:["feature/x"]',
            'removeBlockedLabel:["feature/x"]',
            'closeMilestoneByTitle:["MS"]',
            'syncProjectBoard:[]',
            'commentOnIssue:[7,"текст"]',
            'closeIssue:[7]',
            'blockIssue:[9]',
            'createIssue:[{"title":"т","body":"б","labels":["area:devops"]}]',
        ]);
    });

    // Отдельным кейсом, а не третьим ассертом выше: маппер обязан отдавать ответ боевой
    // функции КАК ЕСТЬ. `false` — единственное значение, на котором видно подмену вида
    // `Boolean(...)`/`?? true`; с одним лишь true-кейсом такая правка осталась бы зелёной,
    // а петля решила бы, что задачи у фазы были, и ушла сдавать неначатую фазу (C5).
    it('hasAnyIssues прокидывает false без искажения', () => {
        const ts: TaskSourceAdapter = createGithubTaskSource({
            openIssues: (() => []) as never,
            allOpenIssues: (() => []) as never,
            hasAnyIssues: (() => false) as never,
            milestoneLabels: (() => []) as never,
            prComments: (() => []) as never,
            commentOnPr: (() => {}) as never,
            createPr: (() => 7) as never,
            getIssue: (() => ({ number: 7, title: 'задача', body: 'тело задачи' })) as never,
            checkAuth: (() => {}) as never,
            findOpenPr: (() => null) as never,
            prHeadSha: (() => 'a'.repeat(40)) as never,
            phaseMerged: (() => false) as never,
            mergedPhasePr: (() => null) as never,
            mergePr: (() => {}) as never,
            addBlockedLabel: (() => {}) as never,
            removeBlockedLabel: (() => {}) as never,
            closeMilestoneByTitle: (() => {}) as never,
            syncProjectBoard: (() => {}) as never,
            commentOnIssue: (() => {}) as never,
            closeIssue: (() => {}) as never,
            blockIssue: (() => {}) as never,
            createIssue: (() => null) as never,
        });
        expect(ts.hasAnyIssues('MS')).toBe(false);
    });
});

describe('createGithubActionsDeploy — сдвиг имён checkProdHealth→checkHealth и т.п.', () => {
    it('checkHealth зовёт checkProdHealth, classifyOutcome — classifyDeployOutcome', () => {
        const checkProdHealth = vi.fn(() => ({ ok: true, status: 200, url: 'u' }));
        const classifyDeployOutcome = vi.fn(() => ({ red: false, reason: 'ok' }));
        const mergedShaOf = vi.fn(() => 'b'.repeat(40));
        const waitForDeployRun = vi.fn(() => ({
            status: 'completed' as const,
            conclusion: 'success',
            sha: 'b'.repeat(40),
            url: null,
            runId: 1,
        }));
        const dc: DeployCheckAdapter = createGithubActionsDeploy({
            mergedShaOf,
            waitForDeployRun,
            checkProdHealth,
            classifyDeployOutcome,
        });
        expect(dc.checkHealth().ok).toBe(true);
        expect(checkProdHealth).toHaveBeenCalledTimes(1);
        dc.classifyOutcome(null, null);
        expect(classifyDeployOutcome).toHaveBeenCalledWith(null, null);
        expect(dc.mergedShaOf(9)).toBe('b'.repeat(40));
        expect(dc.waitForDeployRun('b'.repeat(40)).conclusion).toBe('success');
    });
});

describe('мапперы гейта / нотификатора / рантайма', () => {
    it('createNpmGate раскладывает resolveChecks/runChecks', () => {
        const resolveChecks = vi.fn(() => [['lint', 'npm run lint']] as [string, string][]);
        const runChecks = vi.fn(() => ({ green: true, verifiedHead: 'h', redCheck: null }));
        const g: GateAdapter = createNpmGate({ resolveChecks, runChecks });
        expect(g.resolveChecks('prod')).toEqual([['lint', 'npm run lint']]);
        expect(g.runChecks('feature/x', 3).green).toBe(true);
    });

    it('createTelegramNotifier раскладывает notify (fail-open передаётся как есть)', () => {
        const notify = vi.fn(() => false);
        const n: NotifierAdapter = createTelegramNotifier({ notify });
        expect(n.notify('текст')).toBe(false);
        expect(notify).toHaveBeenCalledWith('текст');
    });

    // #373/#374: один конструктор на все провайдеры кодер-рантайма (claude/kimi/openai) —
    // контракт шва идентичен, провайдер-специфика живёт в боевой функции `run`, а читаемость
    // намерения даёт КЛЮЧ реестра, не имя конструктора.
    it('createCoderRuntime раскладывает run (общий на claude/kimi/openai)', () => {
        const run = vi.fn(() => ({ code: 0, output: 'diff' }));
        const r: CoderRuntimeAdapter = createCoderRuntime({ run });
        expect(r.run('промпт', { maxTurns: 10 })).toEqual({ code: 0, output: 'diff' });
        expect(run).toHaveBeenCalledWith('промпт', { maxTurns: 10 });
    });
});

// --- buildAdapters ------------------------------------------------------------

function fakeRegistries(): AdapterRegistries {
    const ts: TaskSourceAdapter = createGithubTaskSource({
        checkAuth: () => {},
        openIssues: () => [],
        allOpenIssues: () => [],
        hasAnyIssues: () => true,
        milestoneLabels: () => [],
        prComments: () => [],
        commentOnPr: () => {},
        createPr: () => 7,
        getIssue: () => ({ number: 7, title: 'задача', body: 'тело задачи' }),
        commentOnIssue: () => {},
        closeIssue: () => {},
        blockIssue: () => {},
        createIssue: () => null,
        findOpenPr: () => null,
        prHeadSha: () => 'a'.repeat(40),
        phaseMerged: () => false,
        mergedPhasePr: () => null,
        mergePr: () => {},
        addBlockedLabel: () => {},
        removeBlockedLabel: () => {},
        closeMilestoneByTitle: () => {},
        syncProjectBoard: () => {},
    });
    const gate: GateAdapter = createNpmGate({
        resolveChecks: () => [],
        runChecks: () => ({ green: true, verifiedHead: 'h', redCheck: null }),
    });
    const notifier: NotifierAdapter = createTelegramNotifier({ notify: () => true });
    const deployCheck: DeployCheckAdapter = createGithubActionsDeploy({
        mergedShaOf: () => 'sha',
        waitForDeployRun: () => ({
            status: 'not-found',
            conclusion: null,
            sha: 'sha',
            url: null,
            runId: null,
        }),
        checkProdHealth: () => ({ ok: true, status: 200, url: 'u' }),
        classifyDeployOutcome: () => ({ red: false, reason: 'ok' }),
    });
    const coderRuntime: CoderRuntimeAdapter = createCoderRuntime({
        run: () => ({ code: 0, output: '' }),
    });
    return {
        taskSource: { github: ts },
        gate: { npm: gate },
        notifier: { telegram: notifier },
        deployCheck: { 'github-actions': deployCheck },
        coderRuntime: { claude: coderRuntime },
    };
}

describe('buildAdapters — сборка набора швов по выбору из конфига', () => {
    it('дефолтный выбор собирает все пять швов из реестра', () => {
        const reg = fakeRegistries();
        const sel = resolveAdapterSelection(undefined, throwingFail);
        const adapters = buildAdapters(reg, sel, throwingFail);
        expect(Object.keys(adapters).sort()).toEqual(
            ['coderRuntime', 'deployCheck', 'gate', 'notifier', 'taskSource'].sort(),
        );
        // Выбранная реализация — ТА САМАЯ ссылка из реестра, а не копия.
        expect(adapters.taskSource).toBe(reg.taskSource.github);
        expect(adapters.gate).toBe(reg.gate.npm);
        expect(adapters.gate.runChecks('b', 1).green).toBe(true);
    });

    it('выбирает реализацию по ключу селекции, а не первую попавшуюся', () => {
        const reg = fakeRegistries();
        const secondRuntime: CoderRuntimeAdapter = createCoderRuntime({
            run: () => ({ code: 7, output: 'kimi' }),
        });
        reg.coderRuntime.kimi = secondRuntime;
        const sel = resolveAdapterSelection({ coderRuntime: 'kimi' }, throwingFail);
        const adapters = buildAdapters(reg, sel, throwingFail);
        expect(adapters.coderRuntime.run('p', { maxTurns: 1 }).output).toBe('kimi');
    });

    it('незарегистрированная реализация выбранного ключа → fail (не тихий undefined-шов)', () => {
        const reg = fakeRegistries();
        const sel = resolveAdapterSelection({ notifier: 'slack' }, throwingFail);
        expect(() => buildAdapters(reg, sel, throwingFail)).toThrow(
            /notifier.*'slack'.*не зарегистрирована/,
        );
    });
});

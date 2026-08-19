// Тесты контрактов-интерфейсов адаптеров (#262). Интерфейсы адаптеров — чисто
// ТИПОВОЙ артефакт (erasable-only): в рантайме от `adapters.ts` не остаётся ничего.
// Поэтому проверок тут два рода, и они бьют по РАЗНЫМ барьерам:
//
//  1. Конформность на этапе КОМПИЛЯЦИИ. Каждый фейк ниже аннотирован своим
//     интерфейсом (`const fake: TaskSourceAdapter = …`). Если интерфейс окажется
//     неполным/противоречивым или фейк перестанет ему соответствовать — покраснеет
//     `tsc -p .claude/ralph/tsconfig.json` (шаг гейта `typecheck:ralph`), а НЕ этот
//     файл: vitest прогоняет `.ts` через стриппер типов без тайпчека. Это осознанно —
//     барьер конформности держит гейт, а не рантайм-ассерт.
//  2. Реализуемость и связность на этапе ИСПОЛНЕНИЯ. Фейки — минимальные in-memory
//     реализации; ассерты ниже доказывают, что по контракту можно построить рабочую
//     реализацию и что формы данных согласованы (что нельзя проверить типом: сортировка,
//     фильтр blocked, fail-open нотификатора, классификация деплоя).
//
// Это НЕ полный контрактный сьют против боевых адаптеров (#370) и НЕ подключение
// текущих реализаций (#369) — только доказательство, что интерфейсы #262 определены,
// самодостаточны и реализуемы.
import { describe, expect, it } from 'vitest';
import type {
    CoderRuntimeAdapter,
    DeployCheckAdapter,
    DeployOutcome,
    GateAdapter,
    HealthResult,
    Issue,
    NotifierAdapter,
    PullRequest,
    RalphAdapters,
    TaskSourceAdapter,
} from './adapters.ts';

// --- Минимальные in-memory реализации каждого шва --------------------------------

// Источник задач поверх заранее заданного набора issues/PR — без gh, без сети.
function makeFakeTaskSource(seed: {
    issues?: Record<string, Issue[]>;
    prs?: Record<string, PullRequest | null>;
    merged?: Record<string, number | null>;
    allowlist?: string[];
}): { adapter: TaskSourceAdapter; calls: string[] } {
    const calls: string[] = [];
    const allowlist = seed.allowlist ?? ['ok-author'];
    const isReady = (i: Issue): boolean =>
        !(i.labels ?? []).some((l) => l.name === 'blocked') &&
        allowlist.includes((i.author && i.author.login) ?? '');
    const adapter: TaskSourceAdapter = {
        // checkAuth (#35) и listMilestoneLabels (#37) — часть контракта шва: фейк обязан
        // их реализовывать, иначе интерфейс «реализуем» только на бумаге.
        checkAuth: () => {},
        listMilestoneLabels: (milestone) =>
            (seed.issues?.[milestone] ?? []).flatMap((i) => (i.labels ?? []).map((l) => l.name)),
        // #37: комментарии PR — тоже часть контракта шва. Фейку хватает одной ленты:
        // проверяется реализуемость формы, а не раскладка по поверхностям форжа.
        getIssue: (number) => ({ number, title: 'задача', body: 'тело' }),
        createPullRequest: ({ branch }) => {
            calls.push(`create-pr:${branch}`);
            return 7;
        },
        commentOnPullRequest: (prNumber, input) => {
            calls.push(`pr-comment:${String(prNumber)}:${input.anchor?.path ?? '-'}`);
        },
        listPullRequestComments: (prNumber) => [
            {
                body: `🔴 [blocker] находка в #${String(prNumber)}`,
                isSummary: false,
                author: 'ok-author',
            },
        ],
        listReadyIssues: (milestone) =>
            (seed.issues?.[milestone] ?? [])
                .filter(isReady)
                .slice()
                .sort((a, b) => a.number - b.number),
        listAllOpenIssues: (milestone) => (seed.issues?.[milestone] ?? []).slice(),
        // #39: у фейка «карточки любого статуса» = наличие ключа в seed.issues. Ключ
        // есть, а массив пуст — milestone заведён без задач, фаза не начата.
        hasAnyIssues: (milestone) => (seed.issues?.[milestone] ?? []).length > 0,
        findOpenPullRequest: (branch) => seed.prs?.[branch] ?? null,
        // #49: голова PR. У фейка — фиксированная sha: интерфейс обязан быть реализуем
        // без форжа вообще, иначе он описывает `gh`, а не контракт.
        pullRequestHeadSha: (prNumber) => {
            calls.push(`head-sha:${prNumber}`);
            return 'a'.repeat(40);
        },
        isPhaseMerged: (phase) => (seed.merged?.[phase.branch] ?? null) !== null,
        mergedPullRequestNumber: (phase) => seed.merged?.[phase.branch] ?? null,
        mergePullRequest: (prNumber, headSha) => {
            calls.push(`merge:${prNumber}:${headSha ?? '-'}`);
        },
        addBlockedLabel: (branch) => {
            calls.push(`block+:${branch}`);
        },
        removeBlockedLabel: (branch) => {
            calls.push(`block-:${branch}`);
        },
        closeMilestone: (title) => {
            calls.push(`close-ms:${title}`);
        },
        // #40: намерения кодер-сессии. У фейка — журнал вызовов: интерфейс обязан быть
        // реализуем без форжа вообще, иначе он описывает не контракт, а `gh`.
        commentOnIssue: (issue, body) => {
            calls.push(`comment:${issue}:${body}`);
        },
        closeIssue: (issue) => {
            calls.push(`close-issue:${issue}`);
        },
        blockIssue: (issue) => {
            calls.push(`block-issue:${issue}`);
        },
        createIssue: ({ title, labels }) => {
            calls.push(`create-issue:${title}:${labels.join(',')}`);
            return 101;
        },
        syncBoard: () => {
            calls.push('sync-board');
        },
    };
    return { adapter, calls };
}

// Гейт: чеки зелёные тогда и только тогда, когда все команды в `passing`.
function makeFakeGate(passing: Set<string>): GateAdapter {
    const base: Array<[string, string]> = [
        ['lint', 'npm run lint'],
        ['test', 'npm run test'],
    ];
    return {
        resolveChecks: (profileName) =>
            profileName === 'prod' ? [...base, ['e2e', 'npm run e2e']] : [...base],
        runChecks: (branch, prNumber) => {
            const head = `sha-${branch}-${prNumber}`;
            const checks = base;
            const red = checks.find(([, cmd]) => !passing.has(cmd));
            if (red) {
                return {
                    green: false,
                    verifiedHead: null,
                    redCheck: { name: red[0], cmd: red[1], excerpt: 'fail' },
                };
            }
            return { green: true, verifiedHead: head, redCheck: null };
        },
    };
}

// Нотификатор: копит доставленные тексты; при `fail` возвращает false, НО не бросает.
function makeFakeNotifier(fail = false): { adapter: NotifierAdapter; sent: string[] } {
    const sent: string[] = [];
    const adapter: NotifierAdapter = {
        notify: (text) => {
            if (fail) return false;
            sent.push(text);
            return true;
        },
    };
    return { adapter, sent };
}

// Деплой-проверка: детерминированная классификация без gh/сети.
function makeFakeDeployCheck(seed: {
    sha?: string;
    outcome?: DeployOutcome;
    health?: HealthResult;
}): DeployCheckAdapter {
    return {
        // #51: фейк моделирует проект С деплоем — иначе половина его же ассертов
        // («красный при незелёном workflow») проверяла бы недостижимый путь.
        isEnabled: () => true,
        mergedShaOf: (prNumber) => {
            if (!seed.sha) throw new Error(`нет sha мерджа для PR ${prNumber}`);
            return seed.sha;
        },
        waitForDeployRun: (sha) =>
            seed.outcome ?? { status: 'not-found', conclusion: null, sha, url: null, runId: null },
        checkHealth: () =>
            seed.health ?? { ok: true, status: 200, url: 'https://example.test/health' },
        classifyOutcome: (outcome, health) => {
            const workflowGreen =
                !!outcome && outcome.status === 'completed' && outcome.conclusion === 'success';
            if (!workflowGreen) return { red: true, reason: 'workflow не зелёный' };
            if (health && health.ok === false) return { red: true, reason: 'прод не отвечает' };
            return { red: false, reason: 'workflow success + прод здоров' };
        },
    };
}

// Рантайм кодер-сессии: возвращает заранее заданный код/вывод, не спавнит процессов.
function makeFakeRuntime(result: { code: number; output: string }): {
    adapter: CoderRuntimeAdapter;
    runs: Array<{ prompt: string; maxTurns: number; model?: string }>;
} {
    const runs: Array<{ prompt: string; maxTurns: number; model?: string }> = [];
    const adapter: CoderRuntimeAdapter = {
        run: (prompt, options) => {
            runs.push({ prompt, maxTurns: options.maxTurns, model: options.model });
            return { code: result.code, output: result.output };
        },
    };
    return { adapter, runs };
}

// --- Источник задач --------------------------------------------------------------

describe('TaskSourceAdapter — контракт источника задач', () => {
    const milestone = 'Фаза X';
    const branch = 'feature/x';
    const issues: Issue[] = [
        { number: 30, title: 'третий', author: { login: 'ok-author' } },
        { number: 10, title: 'первый', author: { login: 'ok-author' } },
        {
            number: 20,
            title: 'blocked',
            labels: [{ name: 'blocked' }],
            author: { login: 'ok-author' },
        },
        { number: 5, title: 'чужой автор', author: { login: 'stranger' } },
    ];

    it('listReadyIssues отдаёт готовые issues отсортированными по номеру', () => {
        const { adapter } = makeFakeTaskSource({ issues: { [milestone]: issues } });
        expect(adapter.listReadyIssues(milestone).map((i) => i.number)).toEqual([10, 30]);
    });

    it('listReadyIssues исключает blocked и авторов вне allowlist', () => {
        const { adapter } = makeFakeTaskSource({ issues: { [milestone]: issues } });
        const nums = adapter.listReadyIssues(milestone).map((i) => i.number);
        expect(nums).not.toContain(20); // blocked
        expect(nums).not.toContain(5); // чужой автор
    });

    it('listAllOpenIssues НЕ фильтрует (C2: blocked и чужие тоже считаются)', () => {
        const { adapter } = makeFakeTaskSource({ issues: { [milestone]: issues } });
        expect(adapter.listAllOpenIssues(milestone)).toHaveLength(4);
    });

    // #39: интерфейс обязан позволять отличить «фаза не начата» от «фаза сделана» —
    // открытая очередь пуста в обоих случаях.
    it('hasAnyIssues отличает milestone без единой задачи от milestone с задачами', () => {
        const { adapter } = makeFakeTaskSource({ issues: { [milestone]: issues, Пустая: [] } });
        expect(adapter.hasAnyIssues(milestone)).toBe(true);
        expect(adapter.hasAnyIssues('Пустая')).toBe(false);
    });

    // #40: интерфейс обязан выражать намерения сессии, не зная про форж.
    it('намерения сессии выражаются интерфейсом: комментарий, закрытие, blocked, новая карточка', () => {
        const { adapter, calls } = makeFakeTaskSource({});
        adapter.commentOnIssue(7, 'что сделано');
        adapter.closeIssue(7);
        adapter.blockIssue(9);
        expect(adapter.createIssue({ title: 'т', body: 'б', labels: ['area:devops'] })).toBe(101);
        expect(calls).toEqual([
            'comment:7:что сделано',
            'close-issue:7',
            'block-issue:9',
            'create-issue:т:area:devops',
        ]);
    });

    it('findOpenPullRequest возвращает null, когда PR нет', () => {
        const { adapter } = makeFakeTaskSource({});
        expect(adapter.findOpenPullRequest(branch)).toBeNull();
    });

    it('mergePullRequest прокидывает sha головы (для --match-head-commit)', () => {
        const { adapter, calls } = makeFakeTaskSource({});
        adapter.mergePullRequest(42, 'a'.repeat(40));
        expect(calls).toContain(`merge:42:${'a'.repeat(40)}`);
    });

    it('isPhaseMerged / mergedPullRequestNumber отражают состояние мерджа', () => {
        const { adapter } = makeFakeTaskSource({ merged: { [branch]: 77 } });
        expect(adapter.isPhaseMerged({ branch })).toBe(true);
        expect(adapter.mergedPullRequestNumber({ branch })).toBe(77);
        expect(adapter.isPhaseMerged({ branch: 'feature/none' })).toBe(false);
    });

    it('метки blocked и косметика (close/board) вызываются без throw', () => {
        const { adapter, calls } = makeFakeTaskSource({});
        adapter.addBlockedLabel(branch);
        adapter.removeBlockedLabel(branch);
        adapter.closeMilestone(milestone);
        adapter.syncBoard();
        expect(calls).toEqual([
            `block+:${branch}`,
            `block-:${branch}`,
            `close-ms:${milestone}`,
            'sync-board',
        ]);
    });
});

// --- Гейт -------------------------------------------------------------------------

describe('GateAdapter — контракт гейта', () => {
    it('resolveChecks добавляет толстые чеки в профиле prod', () => {
        const gate = makeFakeGate(new Set());
        expect(gate.resolveChecks(undefined).map(([n]) => n)).toEqual(['lint', 'test']);
        expect(gate.resolveChecks('prod').map(([n]) => n)).toEqual(['lint', 'test', 'e2e']);
    });

    it('runChecks зелёный отдаёт verifiedHead и redCheck=null', () => {
        const gate = makeFakeGate(new Set(['npm run lint', 'npm run test']));
        const res = gate.runChecks('feature/x', 9);
        expect(res.green).toBe(true);
        expect(res.verifiedHead).toBe('sha-feature/x-9');
        expect(res.redCheck).toBeNull();
    });

    it('runChecks красный отдаёт первый красный чек и verifiedHead=null', () => {
        const gate = makeFakeGate(new Set(['npm run lint'])); // test красный
        const res = gate.runChecks('feature/x', 9);
        expect(res.green).toBe(false);
        expect(res.verifiedHead).toBeNull();
        expect(res.redCheck?.name).toBe('test');
    });
});

// --- Нотификатор ------------------------------------------------------------------

describe('NotifierAdapter — контракт нотификатора (fail-open)', () => {
    it('доставляет текст и возвращает true', () => {
        const { adapter, sent } = makeFakeNotifier();
        expect(adapter.notify('привет')).toBe(true);
        expect(sent).toEqual(['привет']);
    });

    it('при сбое доставки возвращает false и НЕ бросает', () => {
        const { adapter } = makeFakeNotifier(true);
        expect(() => adapter.notify('падение доставки')).not.toThrow();
        expect(adapter.notify('падение доставки')).toBe(false);
    });
});

// --- Деплой-проверка --------------------------------------------------------------

describe('DeployCheckAdapter — контракт деплой-проверки', () => {
    const green: DeployOutcome = {
        status: 'completed',
        conclusion: 'success',
        sha: 'b'.repeat(40),
        url: 'https://ci.test/run/1',
        runId: 1,
    };

    it('GREEN только при зелёном workflow И здоровом проде', () => {
        const dc = makeFakeDeployCheck({});
        expect(dc.classifyOutcome(green, { ok: true, status: 200, url: 'u' }).red).toBe(false);
    });

    it('красный деплой при нездоровом проде даже с зелёным workflow', () => {
        const dc = makeFakeDeployCheck({});
        expect(dc.classifyOutcome(green, { ok: false, status: 502, url: 'u' }).red).toBe(true);
    });

    it('красный деплой при незелёном workflow', () => {
        const dc = makeFakeDeployCheck({});
        const timeout: DeployOutcome = {
            status: 'timeout',
            conclusion: null,
            sha: green.sha,
            url: null,
            runId: null,
        };
        expect(dc.classifyOutcome(timeout, { ok: true, status: 200, url: 'u' }).red).toBe(true);
    });

    it('mergedShaOf fail-closed: бросает, когда sha не резолвится', () => {
        const dc = makeFakeDeployCheck({});
        expect(() => dc.mergedShaOf(5)).toThrow();
    });

    it('waitForDeployRun отдаёт исход c переданным sha', () => {
        const dc = makeFakeDeployCheck({ outcome: green });
        expect(dc.waitForDeployRun(green.sha).conclusion).toBe('success');
    });
});

// --- Рантайм кодер-сессии ---------------------------------------------------------

describe('CoderRuntimeAdapter — контракт рантайма', () => {
    it('run возвращает код и объединённый вывод, прокидывает бюджет/модель', () => {
        const { adapter, runs } = makeFakeRuntime({ code: 0, output: 'готово' });
        const res = adapter.run('почини баг', { model: 'claude-opus-4-8', maxTurns: 40 });
        expect(res).toEqual({ code: 0, output: 'готово' });
        expect(runs[0]).toEqual({ prompt: 'почини баг', maxTurns: 40, model: 'claude-opus-4-8' });
    });

    it('run без модели допустим (провайдер-дефолт)', () => {
        const { adapter } = makeFakeRuntime({ code: 1, output: 'лимит' });
        expect(adapter.run('задача', { maxTurns: 10 }).code).toBe(1);
    });
});

// --- Сборка всех швов -------------------------------------------------------------

describe('RalphAdapters — набор швов, от которых зависит ядро', () => {
    it('пять адаптеров собираются в единый набор', () => {
        const adapters: RalphAdapters = {
            taskSource: makeFakeTaskSource({}).adapter,
            gate: makeFakeGate(new Set()),
            notifier: makeFakeNotifier().adapter,
            deployCheck: makeFakeDeployCheck({}),
            coderRuntime: makeFakeRuntime({ code: 0, output: '' }).adapter,
        };
        // Каждое поле — свой шов; доступность полей = набор точек расширения ядра.
        expect(Object.keys(adapters).sort()).toEqual(
            ['coderRuntime', 'deployCheck', 'gate', 'notifier', 'taskSource'].sort(),
        );
    });
});

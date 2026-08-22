// Общая тест-обвязка для тестов deadman/monitor (#Ov3). Раньше приватный tmp-каталог,
// writeLog/mkTmp, cleanup в afterEach/afterAll и хелпер t() (ISO-префикс строки лога)
// были продублированы почти дословно в трёх тест-файлах. Здесь — один источник: формат
// строки лога и жизненный цикл временного файла меняются в одном месте.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { vi, type Mock } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralphDefault from '../ralph.js';
import type { RalphConfig } from '../core/orchestrator.ts';
import type { RalphState } from '../core/state-lock.ts';
import { createOrchestrator } from '../core/orchestrator.ts';

// ralph.js — module.exports = createOrchestrator(...) того же runtime, поэтому его
// поверхность точно описывается ReturnType<typeof createOrchestrator>. Типизируем runLoop
// через него (а не оставляем `any` из ts-expect-error-импорта): иначе объект deps из ~30
// полей в makeRunLoopScenario компилятором не сверялся бы с боевой сигнатурой — обещание
// «правку сигнатуры deps синхронизируем здесь одним местом» держал бы комментарий, а не тип.
type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralphDefault.runLoop as Runtime['runLoop'];

// Строка лога как её пишет log() в ralph.js — ISO-таймстамп + маркер. Таймстамп
// фиксированный: тесты задают «сейчас» через mtime + ageMs, сам префикс роли не играет.
export function logLine(msg: string): string {
    return `[2026-07-22T06:30:07.015Z] ${msg}`;
}

// Фабрика временных лог-файлов на диске (как боевой ralph.log). Приватный каталог через
// mkdtemp: иначе имена в общем os.tmpdir() детерминированы и два параллельных прогона
// vitest (гейт раннера в своём worktree + человек в своём) писали бы и unlink'али одни
// файлы → флак. Возвращает writeLog() (строки или готовый контент) и cleanup-функции для
// afterEach (файлы) и afterAll (каталог).
export function makeTmpLog(prefix: string): {
    tmpDir: string;
    writeLog: (linesOrContent: string[] | string) => string;
    cleanupFiles: () => void;
    removeDir: () => void;
} {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const tmpFiles: string[] = [];
    function writeLog(linesOrContent: string[] | string): string {
        const content = Array.isArray(linesOrContent) ? linesOrContent.join('\n') : linesOrContent;
        const p = path.join(tmpDir, `log-${tmpFiles.length}-${content.length}.log`);
        fs.writeFileSync(p, content);
        tmpFiles.push(p);
        return p;
    }
    function cleanupFiles(): void {
        while (tmpFiles.length) {
            try {
                fs.unlinkSync(tmpFiles.pop() as string);
            } catch {
                /* ignore */
            }
        }
    }
    function removeDir(): void {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
    return { tmpDir, writeLog, cleanupFiles, removeDir };
}

// ── Оркестратор сценарного прогона гейта (#223, было дублем в blocked-/hold-scenarios) ──
// Модель ревью, поставившего блок (по ней встаёт планка #217), и лимит разбора blocked.
export const SCENARIO_REVIEW_MODEL = 'claude-opus-4-8';
export const SCENARIO_B_MAX = 3;

// state сдачи: сессии кодера позади (submitted=true) — каждый проход стартует прямо с
// гейта. lastReviewModel — модель, поставившая блок. Остальные поля — те же нейтральные
// дефолты, что и в defaultState() (state-lock.ts): RalphState не знает опциональных полей.
const scenarioState = (o: Partial<RalphState> = {}): RalphState => ({
    count: 0,
    milestone: 'M1',
    submitted: true,
    noProgress: 0,
    gateHeals: 0,
    blockedHeals: 0,
    reviewModelFloor: null,
    lastReviewModel: SCENARIO_REVIEW_MODEL,
    reReviewPending: false,
    reviewOfFixes: null,
    deployBlock: null,
    ...o,
});

// Профиль НЕ prod: merged завершается continue (мердж — финал). blockedHealAttempts=3.
const scenarioCfg = (o: Partial<RalphConfig> = {}): RalphConfig => ({
    model: 'claude-coder',
    prompt: 'сделай {milestone} в ветке {branch}',
    authorAllowlist: ['owner'],
    blockedHealAttempts: SCENARIO_B_MAX,
    phases: [{ milestone: 'M1', branch: 'feature/m1' }],
    // #204: состав чеков гейта теперь в конфиге; runLoop зовёт gateChecksFor(cfg.profileName,
    // cfg), так что сценарному cfg нужен валидный gate-блок (иначе resolveGateChecks fail-closed).
    gate: {
        checks: [
            ['build', 'npm run build'],
            ['test', 'npm run test'],
        ],
        prodChecks: [['e2e', 'npm run test:e2e']],
        prodDropChecks: ['test'],
    },
    ...o,
});

// Вердикт гейта — из боевой сигнатуры tryMergePhase, а не переобъявлённый список: тот
// однажды разъехался бы с ядром (напр. потерял бы 'merged-local-stale').
type GateVerdict = ReturnType<Runtime['tryMergePhase']>;
// Красный чек — тоже из боевого геттера (getLastRedCheck), а не `unknown`: так фейк
// getLastRedCheck типизируется под сигнатуру runLoop, и RED_CHECK-фикстура сверяется формой.
type RedCheckResult = ReturnType<Runtime['getLastRedCheck']>;

// Общий оркестратор сценарных тестов гейта для blocked-scenarios и hold-scenarios: один
// state, кумулятивные спаи, pass(gate,{redCheck}) = один проход раннера с заданным
// вердиктом гейта. phaseIndexOfFn отдаёт валидный индекс на 1-м обращении и «за концом»
// на 2-м, поэтому каждый проход упирается в break — ровно как настоящий while-цикл
// переоценивает гейт на следующем витке. restart() пересобирает state из последнего
// saveState-снимка («раннер убит и поднят, state прочитан с диска»). Все побочки —
// фейки через DI (RALPH_NO_SIDE_EFFECTS=1, guardSideEffect): ни одного реального gh/сети.
// Спаи возвращаются объектом — правку сигнатуры deps runLoop синхронизируем здесь одним
// местом, оба тест-файла оставляют только свои describe.
export function makeRunLoopScenario(
    initialState: Partial<RalphState> = {},
    { lastGatePr = 777 }: { lastGatePr?: number } = {},
): {
    readonly state: RalphState;
    pass: (gate: GateVerdict, o?: { redCheck?: RedCheckResult }) => void;
    restart: () => RalphState;
    logs: string[];
    saved: RalphState[];
    runClaudeFn: Mock;
    pushEventFn: Mock;
    removeBlockedLabelFn: Mock;
    addBlockedLabelFn: Mock;
    pushTexts: () => string[];
    maxBlockedHeals: () => number;
} {
    const logs: string[] = [];
    const saved: RalphState[] = [];
    const runClaudeFn = vi.fn(() => 0);
    const pushEventFn = vi.fn();
    const removeBlockedLabelFn = vi.fn();
    const addBlockedLabelFn = vi.fn();
    let state = scenarioState(initialState);

    function pass(
        gate: GateVerdict,
        { redCheck = null }: { redCheck?: RedCheckResult } = {},
    ): void {
        let idxCalls = 0;
        runLoop(
            scenarioCfg(),
            { state, maxIterations: 10, maxTurns: 200 },
            {
                once: false,
                dry: false,
                logFn: (m: string) => logs.push(m),
                shFn: () => '',
                saveStateFn: (s: RalphState) => saved.push({ ...s }),
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                // #39: у фазы сценария задачи были и закрыты — сдача идёт штатно. Барьер
                // «фаза не начата» проверяется своими тестами в orchestrator.test.ts.
                hasAnyIssuesFn: () => true,
                // #46: шаг 1 сдачи — заведение PR петлёй, а не сессией. Без заглушек
                // сценарий уходил бы в боевой шов и ждал его сетевых ретраев.
                findOpenPrFn: () => null,
                createPrFn: () => 7,
                phasePrBodyFn: () => 'тело PR',
                phaseIndexOfFn: () => (idxCalls++ === 0 ? 0 : 99),
                pickModelFn: () => 'claude-coder',
                pickReviewModelFn: () => SCENARIO_REVIEW_MODEL,
                reviewDiffContextFn: () => '',
                phaseDiffFilesFn: () => [],
                removeBlockedLabelFn,
                addBlockedLabelFn,
                runClaudeFn,
                ensureCleanFn: () => true,
                phaseMergedFn: () => false,
                advancePhaseFn: () => {},
                tryMergePhaseFn: () => gate,
                closeMilestoneByTitleFn: () => {},
                syncProjectBoardFn: () => {},
                recordReviewFindingsFn: () => {},
                // #625: заглушки лестницы ревью правок (база диффа правок, карточки,
                // журнал прохода) — иначе сценарий уходил бы в настоящие git/форж/диск.
                branchHeadShaFn: () => 'a'.repeat(40),
                createIssueFn: () => 1,
                recordFixReviewFindingsFn: () => {},
                getLastRedCheck: () => redCheck,
                getLastGatePr: () => lastGatePr,
                pushEventFn,
                ensureMonitorAliveFn: () => null,
            },
        );
    }

    function restart(): RalphState {
        state = { ...saved[saved.length - 1] };
        return state;
    }

    return {
        get state() {
            return state;
        },
        pass,
        restart,
        logs,
        saved,
        runClaudeFn,
        pushEventFn,
        removeBlockedLabelFn,
        addBlockedLabelFn,
        pushTexts: () => pushEventFn.mock.calls.map((c: unknown[]) => c[0] as string),
        maxBlockedHeals: () => Math.max(0, ...saved.map((s) => s.blockedHeals ?? 0)),
    };
}

// ── Фикстурный цикл на конфиге ЧУЖОГО проекта ────────────────────────────────
// Общая обвязка двух барьеров: переносимости (`porting-dry-run`) и чистоты продукта
// (`product-root-purity`). Раньше она стояла копией в обоих, и ревью !21 показало цену:
// копии разъехались — во втором цикл обрывался на preflight, то есть барьер утверждал
// «прогон ничего не пишет», не дойдя до самого прогона.

/** Путь фикстуры — от каталога МОДУЛЯ: CWD у клона канона и у подмодуля разный. */
export const FIXTURE_CONFIG_PATH = path.resolve(
    import.meta.dirname,
    '__fixtures__',
    'foreign-project',
    'ralph.config.json',
);

const FIXTURE_FLAGS = {
    once: false,
    dry: true,
    reset: false,
    resubmit: false,
    deployResolved: false,
};

/** Оркестратор с фейками моста entry: профиль фикстуры не prod, телеграм и gate-env не зовут. */
export function buildFixtureRuntime() {
    return createOrchestrator({
        argv: [],
        flags: FIXTURE_FLAGS,
        external: {
            sendTelegramMessage: () => false,
            telegramConfigFromEnv: () => ({ token: '', chatId: '' }),
            buildSanitizedGateEnv: () => ({}),
        },
    });
}

/** Резолвнутый конфиг фикстуры + установка его как фабричного (боевой путь делает main()). */
export function loadFixtureConfig(runtime: ReturnType<typeof buildFixtureRuntime>) {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_CONFIG_PATH, 'utf-8')) as unknown;
    const cfg = runtime.resolveProfile(raw, 'playground', (msg: string) => {
        throw new Error(msg);
    }) as Parameters<typeof runtime.preflight>[0];
    runtime.setConfigForTests(cfg);
    return cfg;
}

/**
 * preflight + один dry-проход runLoop на фикстуре. КАЖДЫЙ коллаборатор подменён: дефолты
 * читают `adapters.*` фабрики, собранной без выбора из фикстуры, и ушли бы в настоящий
 * форж мимо предохранителя.
 */
export function runFixtureLoop(
    runtime: ReturnType<typeof buildFixtureRuntime>,
    cfg: Parameters<typeof runtime.preflight>[0],
): {
    logs: string[];
    shCalls: string[];
    runClaudeCalls: Array<{ prompt: string; model?: string }>;
    openIssuesCalls: string[];
    authChecked: number;
    savedStates: unknown[];
    ctx: ReturnType<typeof runtime.preflight>;
} {
    const logs: string[] = [];
    const shCalls: string[] = [];
    const runClaudeCalls: Array<{ prompt: string; model?: string }> = [];
    const openIssuesCalls: string[] = [];
    const savedStates: unknown[] = [];
    let authChecked = 0;
    const logFn = (m: string) => logs.push(m);
    // Фейковый shFn — единственная точка, куда preflight мог бы дотянуться до настоящего
    // git/gh: `git rev-parse`, `git status --porcelain` и проверка авторизации НЕ гейтятся
    // dry-флагом. Реальный `sh()` под RALPH_NO_SIDE_EFFECTS=1 бросил бы, но бросок половина
    // вызовов глотает try/catch-ем — отсюда фейк, а не расчёт на предохранитель.
    const shFn = (cmd: string) => {
        shCalls.push(cmd);
        return '';
    };
    const boom = (msg: string) => {
        throw new Error(msg);
    };

    const ctx = runtime.preflight(cfg, {
        shFn,
        // #35: авторизация форжа спрашивается через ШОВ, а не через shFn — боевой дефолт
        // ушёл бы в настоящий gh/curl мимо фейка и упёрся бы в предохранитель.
        checkAuthFn: () => {
            authChecked += 1;
        },
        failFn: boom,
        logFn,
        loadStateFn: () => ({
            count: 0,
            milestone: (cfg.phases as Array<{ milestone: string }>)[0].milestone,
            submitted: false,
            noProgress: 0,
            gateHeals: 0,
            blockedHeals: 0,
            reviewModelFloor: null,
            lastReviewModel: null,
            reReviewPending: false,
            reviewOfFixes: null,
            deployBlock: null,
        }),
        phaseIndexOfFn: () => 0,
        // #17: ранняя проверка конфликта human+complexity читает карточки фазы через шов —
        // дефолт ушёл бы в настоящий форж, собранный БЕЗ выбора из фикстуры.
        allOpenIssuesFn: () => [],
        saveStateFn: () => {},
        pushEventFn: () => false,
        dry: true,
    });

    const fixtureIssue = {
        number: 101,
        title: 'Чужой issue фикстурного проекта',
        labels: [{ name: 'complexity:medium' }],
        author: { login: 'orbital-bot' },
    };

    // #369: дефолты коллабораторов читают `adapters.*` фабрики, собранной без выбора из
    // фикстуры (main() их не звал), поэтому подменяется КАЖДЫЙ: необращённые к ним ветки
    // прохода всё равно проходят через связывание параметров при входе в runLoop.
    runtime.runLoop(cfg, ctx, {
        dry: true,
        once: false,
        logFn,
        shFn,
        saveStateFn: (st: unknown) => savedStates.push(st),
        openIssuesFn: (milestone: string) => {
            openIssuesCalls.push(milestone);
            return [fixtureIssue];
        },
        allOpenIssuesFn: () => [],
        hasAnyIssuesFn: () => true,
        // #50: карточку для промпта читает петля — дефолт ушёл бы в шов, собранный без
        // выбора из фикстуры, и dry-проход потрогал бы настоящий форж.
        getIssueFn: (number: number) => ({
            number,
            title: fixtureIssue.title,
            body: 'тело карточки из фикстуры',
        }),
        prCommentsFn: () => [],
        findOpenPrFn: () => null,
        removeBlockedLabelFn: () => {},
        addBlockedLabelFn: () => {},
        phaseMergedFn: () => true,
        mergedPhasePrFn: () => null,
        closeMilestoneByTitleFn: () => boom('closeMilestoneByTitleFn не должен вызываться в dry'),
        syncProjectBoardFn: () => boom('syncProjectBoardFn не должен вызываться в dry'),
        mergedShaOfFn: () => '',
        waitForDeployRunFn: () => ({ ok: false }) as never,
        checkProdHealthFn: () => ({ ok: false }) as never,
        runClaudeFn: (prompt: string, opts: { model?: string }) => {
            runClaudeCalls.push({ prompt, model: opts.model });
            return 0;
        },
    });

    return { logs, shCalls, runClaudeCalls, openIssuesCalls, authChecked, savedStates, ctx };
}

// ── Снимок дерева: путь → отпечаток содержимого и режима ─────────────────────
// Живёт здесь, а не в тестовом файле: импорт из `*.test.ts` протащил бы за собой прогон
// всех его `describe` (ревью !22).

/** `.git` меняется от самого `git status`; `node_modules` не продукт — его ставит потребитель. */
const SNAPSHOT_SKIP = new Set(['.git', 'node_modules']);

/**
 * Снимок дерева для сравнения «до/после»: ловит появление файла, его перезапись, смену
 * бита исполнения и подмену символической ссылки.
 *
 * Хэш содержимого, а не `git status`: статус отвечает на вопрос «как git видит путь», и
 * перезапись уже существующего игнорируемого файла его не меняет вовсе — самый вероятный
 * след прогона проходил бы мимо. Режим в ключе — потому что бит исполнения git отслеживает,
 * и снимок по одному содержимому был бы тут слабее статуса (ревью !22).
 *
 * Fail-closed: нечитаемый файл или каталог — отказ, а не пропуск; иначе сломанные права
 * превратили бы снимок в тождество.
 *
 * Цена — чтение всего дерева: под каталогом продукта лежат рантайм-артефакты (`ralph.log`,
 * `sessions/`), и после ночной фазы снимок стоит уже не миллисекунды. Это осознанно: они и
 * есть предмет проверки, а исключить их значило бы ослепить барьер ровно там, где он нужен.
 */
export function snapshotTree(root: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SNAPSHOT_SKIP.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const rel = path.relative(root, full);
            if (entry.isSymbolicLink()) {
                // Ссылку не разыменовываем: git видит её обычным путём, и подмена цели —
                // такое же изменение дерева, как правка файла.
                out.set(rel, `symlink:${fs.readlinkSync(full)}`);
                continue;
            }
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const exec = (fs.statSync(full).mode & 0o111) !== 0 ? 'x' : '-';
            const hash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
            out.set(rel, `${exec}:${hash}`);
        }
    };
    walk(root);
    return out;
}

/** Различие снимков — человеку в отказ: что появилось, исчезло, изменилось. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
    const out: string[] = [];
    for (const [rel, mark] of after) {
        const was = before.get(rel);
        if (was === undefined) out.push(`появился: ${rel}`);
        else if (was !== mark) out.push(`изменился: ${rel}`);
    }
    for (const rel of before.keys()) if (!after.has(rel)) out.push(`исчез: ${rel}`);
    return out.sort();
}

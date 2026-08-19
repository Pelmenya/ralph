// Общая тест-обвязка для тестов deadman/monitor (#Ov3). Раньше приватный tmp-каталог,
// writeLog/mkTmp, cleanup в afterEach/afterAll и хелпер t() (ISO-префикс строки лога)
// были продублированы почти дословно в трёх тест-файлах. Здесь — один источник: формат
// строки лога и жизненный цикл временного файла меняются в одном месте.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi, type Mock } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralphDefault from '../ralph.js';
import type { RalphConfig } from '../core/orchestrator.ts';
import type { RalphState } from '../core/state-lock.ts';

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

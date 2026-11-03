// Тесты оркестратора петли (orchestrator.ts) через боевую поверхность ralph.js — так их
// видит вызывающий: entry собирает фабрику createOrchestrator и ре-экспортирует функции,
// поэтому здесь проверяется и поведение петли целиком (сессия claude, preflight, runLoop,
// ветковая хореография, монитор, ревью-контекст, milestones/доска), и контракт самой
// фабрики/«тонкость» entry (створки блоки в конце файла).
//
// Файл — единственный тест-файл модуля orchestrator.ts (#366, один файл на модуль).
// Переведён в .ts (#405, фаза 8 «Дотипизация оболочки»): дословный перенос блоков без
// переписывания моков — под tsc --strict добавлены только аннотации фикстур и DI-заглушек
// (узкие локальные типы вместо `any`), а частичные spawnSync-фейки приводятся к боевому
// `typeof spawnSync` точечным `as unknown as SpawnSyncFn` в вызове. Число тестов и их суть
// не менялись (перенос, не переписывание); файл теперь КОМПИЛИРУЕТСЯ typecheck:ralph
// (tsconfig включает **/*.ts). Единственный барьер здесь — tsc: ESLint на `.claude/**` не
// распространяется (globalIgnores в eslint.config.mjs).
//
// Что именно проверяет tsc, а что нет (честно, #409-ревью): поверхность ralph.js держится
// `any` (ts-expect-error-импорт ниже), поэтому tsc сверяет ЛОКАЛЬНЫЕ аннотации — фикстуры,
// DI-заглушки (SpawnFake/ChecksGreenFake/…), формы `mock.calls[i]` — но НЕ сигнатуры вызовов
// боевого API: `runLoop`/`checksGreen`/`closeMilestone…` зовутся через `any`. Полная
// типизация деструктуризации (`ralph as ReturnType<typeof createOrchestrator>`) покраснила
// бы ~150 вызовов с генерик-коллабораторами (`ForgeJsonFn`) и частичными cfg/state-фейками —
// это отдельный трек, а не правка переноса #405.
//
// Файл собран при разнесении монолитного ralph.test.js по модульным тест-файлам (#366):
// блоки перенесены как есть, включая их фикстуры и комментарии.
//
// Тесты детерминированы: время мокается фейк-таймерами, платформо- и TZ-независимы.
// Побочек нет ни одной: все коллабораторы (sh/shArgv/spawn/gh/fs) инжектируются, а
// боевые дефолты под RALPH_NO_SIDE_EFFECTS=1 громко падают на guardSideEffect (#138) —
// общий afterEach из test-setup.ts сверяет журнал попыток.
//
// spawnClaude тестируем через явную инъекцию фейковой spawn-функции (3-й параметр),
// НЕ через vi.mock('node:child_process'): мок модуля на границе CJS require()
// (которым ralph.js подключает child_process) ненадёжен — при первой попытке тест
// пробился до настоящего spawnSync и запустил живой процесс `claude` вместо фейка.
// Явный параметр детерминирован независимо от того, как раннер загружен.

import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// monitor-panel.mts / config-profile.test.ts, #366): дефолт ralph.js — ре-экспорт
// runtime фабрики. Поверхность держим `any` СОЗНАТЕЛЬНО (не кастуем к
// ReturnType<typeof createOrchestrator>): боевые DI-коллабораторы этого сьюта — генерик
// `ForgeJsonFn` (`<T>(cmd)=>T`), частичные cfg/state-фейки и ClaudeOpts-заглушки, которые
// #405 намеренно перенёс ДОСЛОВНО, не переписывая под строгие типы. Каст фабрики
// покраснил бы ~150 таких вызовов разом — это отдельный крупный трек «типизация DI-моков
// сценариев», а не правка этого переноса (см. ответ в ревью PR #409).
import ralph from '../ralph.js';
import * as util from '../shared/ralph-util.ts';
import type { AdapterRegistries, AdapterConfig } from '../adapters/adapters-impl.ts';
import type { ReviewComment } from '../adapters/adapters.ts';
import type { DeployOutcome } from './deploy-check.ts';
import type { RalphState } from './state-lock.ts';
import type { RalphConfig } from './orchestrator.ts';
import {
    COMMENT_NOTICE_THRESHOLD,
    IN_FLIGHT_PREFIX,
    INTENTS_BEGIN,
    INTENTS_END,
    inFlightMarker,
} from './session-requests.ts';
import { attachSubmitJournal, finishStage, startStage } from './submit-journal.ts';
import { MODEL_PROXY_RETRIES } from './runtime-availability.ts';
import { classifyClaudeSessionEnd } from '../adapters/session-end.ts';
import { HARNESS_REGISTRY } from '../adapters/harness-registry.ts';
import { codexUntrustArgs } from '../adapters/codex-home.ts';
import { reconcilePhases } from './phase-reload.ts';
import { withDefaultFixPlan } from '../tests/test-helpers.ts';

// Фаза 16: исход сессии называет адаптер рантайма, ядро текста не читает. Фейк рантайма
// с выводом Claude получает исход тем же классификатором, что боевой spawnClaude, — тест
// проверяет политику ядра по исходу, а не угадывание исхода по тексту.
const claudeRun = (code: number, output: string) => ({
    code,
    output,
    ...classifyClaudeSessionEnd({ code, stdout: output, stderr: '' }),
});
// Фейк runClaudeFn отдаёт вывод и исход тем же каналом, что боевой runClaude: onOutput
// вторым аргументом несёт исход последнего запуска.
const emitOutput = (d: Record<string, unknown> | undefined, text: string, code = 1): void =>
    (d?.onOutput as ((o: string, end: string) => void) | undefined)?.(
        text,
        claudeRun(code, text).endReason,
    );

// #204: состав чеков гейта переехал в ralph.config.json. gateChecksFor и tryMergePhase
// читают ФАБРИЧНЫЙ config, который в проде ставит main() (в юнит-тестах не запускаемая).
// Засеваем его один раз — иначе внутренний вызов gateChecksFor в tryMergePhase не найдёт
// ни одного чека.
//
// Засев идёт ФИКСТУРОЙ, а не конфигом проекта рядом. Ядро — продукт: конфиг потребителя
// ему не принадлежит, и тест, читающий `ralph.config.json` из рабочего дерева, красен в
// каноне по определению (там такого файла нет вовсе) и пиннит чужие решения там, где
// они есть. Что состав чеков и профили КОНКРЕТНОГО проекта не съехали — сторожит тест на
// стороне потребителя (контракт потребителя, #103); логику самого резолвера покрывает
// gate.test.ts на синтетических конфигах.
//
// Путь считается от каталога ядра (import.meta.dirname), а не от CWD: ядро запускается и
// подмодулем в каноне, и каталогом `.claude/ralph` у потребителя — CWD в этих раскладках
// разный, каталог ядра относительно самого теста — один и тот же.
const FIXTURE_CONFIG_PATH = path.resolve(
    import.meta.dirname,
    '../tests/__fixtures__/foreign-project/ralph.config.json',
);
const REAL_CONFIG_RAW = JSON.parse(fs.readFileSync(FIXTURE_CONFIG_PATH, 'utf-8'));
// Имя профиля берём из самого конфига, а не литералом: имя дефолтного профиля — решение
// проекта, и на литерале перенос падал с «Неизвестный профиль» (грабля 6 журнала
// переносимости).
const REAL_CONFIG = ralph.resolveProfile(REAL_CONFIG_RAW, REAL_CONFIG_RAW.defaultProfile);
ralph.setConfigForTests(REAL_CONFIG);

// Имена и команды чеков — ИЗ засеянного конфига, а не литералами. Чем проект зовёт свои
// проверки (npm/pnpm/make) — его решение; ядру принадлежит лишь то, что список доходит до
// шелла целиком, в порядке конфига, и что упавший чек назван по имени ИЗ конфига. Литерал
// «npm run build» здесь означал бы, что тест ядра пиннит чужой package.json — ровно та
// связность, из-за которой ядро и не отделялось.
const BASE_CHECKS: Array<[string, string]> = REAL_CONFIG.gate.checks;
const [FIRST_CHECK_NAME, FIRST_CHECK_CMD] = BASE_CHECKS[0];
const [SECOND_CHECK_NAME, SECOND_CHECK_CMD] = BASE_CHECKS[1];
const [LAST_CHECK_NAME, LAST_CHECK_CMD] = BASE_CHECKS[BASE_CHECKS.length - 1];
const BASE_CHECK_CMDS = BASE_CHECKS.map(([, cmd]) => cmd);
const PROD_CHECK_CMDS = ((REAL_CONFIG.gate.prodChecks ?? []) as Array<[string, string]>).map(
    ([, cmd]) => cmd,
);

const {
    startMonitor,
    stopMonitor,
    adoptMonitor,
    processAlive,
    cmdlineIncludes,
    isMonitorProcess,
    isRalphMonitorProcess,
    acquireRunnerLock,
    listMonitorPids,
    processPpid,
    sweepOrphanMonitors,
    ensureMonitorAlive,
    buildClaudeArgs,
    formatExcerpt,
    spawnClaude,
    ensureTunnel,
    pushEvent,
    syncDepsIfLockChanged,
    preflight,
    runLoop,
    loadState,
    ensureClean,
    commitLeftovers,
    handleCrashedCoderSession,
    parkOnOriginMain,
    gateChecksFor,
    checksGreen,
    tryMergePhase,
    waitForDeployRun,
    mergedShaOf,
    checkProdHealth,
    getLastRedCheck,
    getVerifiedHead,
    getLastGatePr,
} = ralph;

// Узкие локальные типы фейков DI (правило проекта: no-explicit-any). Моки намеренно
// частичны — сигнатура нужна лишь чтобы `mock.calls[i]` был кортежем нужной формы:
// `vi.fn(() => …)` без дженерика выводит НОЛЬ-арность, и `calls[i][n]` упирается в
// «пустой кортеж не имеет элемента n». Дженерик восстанавливает форму аргументов, не
// меняя реализацию мока (она по-прежнему игнорирует аргументы).
type SpawnSyncFn = typeof import('node:child_process').spawnSync;
// #113: версия CLI перед сессией читается отдельным коллаборатором (`cliVersionFn`), а не
// фейком spawn: тесты ниже считают вызовы spawnFn, и лишний `--version` сдвигал бы их.
const VERSION_UNREAD = () => ({ version: 'unknown', unknownReason: 'тест: версия не читается' });
// Фейк spawnSync-коллаборатора (spawnClaude/runKimiOnce/runOpenAIOnce): поля opts
// неопциональны, чтобы ассерты `opts.env.X` не спотыкались о possibly-undefined; к
// боевому `typeof spawnSync` фейк приводится точечным `as unknown as SpawnSyncFn` в
// вызове (частичный возврат несовместим с полным SpawnSyncReturns — намеренно).
type SpawnFake = (
    bin: string,
    argv: string[],
    opts: {
        shell: boolean;
        timeout: number;
        env: Record<string, string | undefined>;
        input?: string;
    },
) => { status: number | null; stdout: string; stderr: string; signal: string | null };
// Фейк runClaudeOnce-подобного DI-коллаборатора (runClaudeFn/fallbackRun): читаются
// prompt (arg0) и opts.model/opts.fallbackModel (arg1); возврат не важен → unknown.
type RunClaudeFake = (
    prompt: string,
    opts: { model?: string; fallbackModel?: string; [k: string]: unknown },
    deps?: { runClaudeOnceFn?: unknown; [k: string]: unknown },
) => unknown;
// #390: фейк handleCrashedCoderSession-коллаборатора (runLoop зовёт его с сырым issue,
// кодом выхода, выводом сессии и объектом shFn/logFn/pushEventFn/cfg).
type HandleCrashedCoderSessionFake = (
    issue: { number: number },
    code: number,
    output: string,
    opts?: { [k: string]: unknown },
) => { stop: boolean };
type ChecksGreenFake = (
    branch: string,
    prNumber: number,
    deps: { checks: Array<[string, string]>; [k: string]: unknown },
) => unknown;
// Фейк waitForDeployRun-коллаборатора. Боевой цикл зовёт его ТРЕМЯ аргументами:
// waitForDeployRunFn(mergedSha, cfg, { logFn }) (orchestrator.ts:2755). Повторяем арность,
// чтобы mock.calls[i] был 3-кортежем реального контракта (унарный тип скрыл бы calls[i][1]
// /[2] и сделал бы обращение к ним тайп-ошибкой на живых данных). Ассерты читают только
// calls[0][0] (sha), поэтому cfg/opts не типизируем строго → unknown.
type WaitDeployFake = (sha: string, cfg?: unknown, opts?: { logFn?: unknown }) => unknown;
// Фейк spawn (не spawnSync) для монитора: возвращает child-подобие, читаются
// opts.detached/opts.stdio и argv.
type MonitorSpawnFake = (
    bin: string,
    argv: string[],
    opts: { detached: boolean; stdio: unknown; env?: Record<string, string | undefined> },
) => { pid: number; unref: () => void; on: (...a: unknown[]) => void };

// #252: git-хелперы гейта разделены на shFn (чтения) и runArgvFn (argv-мутации). Этот
// рекордер пишет ОБА канала в один общий `cmds`, нормализуя runArgvFn в `${file} ${args}`,
// чтобы ассерты на ПОРЯДОК команд остались осмысленными. Общий на phaseDiffFiles и
// refreshRunnerWorktree — иначе правка формата записи требовала бы синхронных правок в двух.
const mkCmdRecorders = (shImpl?: (cmd: string) => string) => {
    const cmds: string[] = [];
    return {
        cmds,
        shFn: (c: string) => {
            cmds.push(c);
            return shImpl ? shImpl(c) : '';
        },
        runArgvFn: (file: string, args: string[]) => {
            const cmd = `${file} ${args.join(' ')}`;
            cmds.push(cmd);
            return shImpl ? shImpl(cmd) : '';
        },
    };
};

describe('buildClaudeArgs — построение argv для claude -p (ядро порта; #607 — без промпта)', () => {
    // #225: первый слой запрета субагентов и отложенного хода — флаг запуска; имена — из
    // описания пакета Claude Code (операции agent и defer), а не из списка в ядре.
    const LOOP_DENY = ['--disallowedTools', 'Task,Agent,Workflow,ScheduleWakeup,CronCreate'];

    it('#225: сессия петли запускается с запретом Agent и ScheduleWakeup', () => {
        const argv = buildClaudeArgs({ maxTurns: 200 }, {});
        const denied = argv[argv.indexOf('--disallowedTools') + 1].split(',');
        expect(denied).toEqual(expect.arrayContaining(['Agent', 'ScheduleWakeup']));
    });

    it('#225: запрет — по классу из описания пакета: новый инструмент класса уходит под него', () => {
        const d = HARNESS_REGISTRY.packages.get('claude-code')!.descriptor;
        const ops = Object.fromEntries(
            Object.entries(d.toolMap).filter(([, op]) => op === 'agent' || op === 'defer'),
        );
        expect(Object.keys(ops)).toEqual(LOOP_DENY[1].split(','));
    });

    it('минимальный вызов: -p --max-turns <n> и JSON-результат при пустом конфиге', () => {
        // Задача 95: `--output-format json` — источник токенов попытки (attempt-cost.ts).
        const argv = buildClaudeArgs({ maxTurns: 200 }, {});
        expect(argv).toEqual(['-p', '--max-turns', '200', ...LOOP_DENY, '--output-format', 'json']);
    });

    it('maxTurns приводится к строке (spawnSync требует строковые argv)', () => {
        const argv = buildClaudeArgs({ maxTurns: 30 }, {});
        expect(argv[2]).toBe('30');
        expect(typeof argv[2]).toBe('string');
    });

    it('model добавляет пару --model <model>', () => {
        const argv = buildClaudeArgs({ model: 'claude-opus-4-8', maxTurns: 200 }, {});
        expect(argv).toContain('--model');
        expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    });

    it('permissionMode из конфига добавляет --permission-mode', () => {
        const argv = buildClaudeArgs({ maxTurns: 200 }, { permissionMode: 'bypassPermissions' });
        expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    });

    it('fallbackModel из конфига используется, когда опция fallbackModel не передана (back-compat)', () => {
        const argv = buildClaudeArgs({ maxTurns: 200 }, { fallbackModel: 'claude-sonnet-5' });
        expect(argv[argv.indexOf('--fallback-model') + 1]).toBe('claude-sonnet-5');
    });

    // #221: review.fallback передаётся как явный override и не зависит от общего
    // cfg.fallbackModel — раньше это было ролью noFallback:true (M8), теперь ревью
    // явно указывает СВОЮ модель фолбэка (см. pickReviewFallbackModel).
    it('явный опции.fallbackModel переопределяет cfg.fallbackModel', () => {
        const argv = buildClaudeArgs(
            { maxTurns: 200, fallbackModel: 'claude-opus-4-8' },
            { fallbackModel: 'claude-sonnet-5' },
        );
        expect(argv[argv.indexOf('--fallback-model') + 1]).toBe('claude-opus-4-8');
    });

    it('опции.fallbackModel = null подавляет --fallback-model, даже если в конфиге он задан (fail-closed без фолбэка)', () => {
        const argv = buildClaudeArgs(
            { maxTurns: 200, fallbackModel: null },
            { fallbackModel: 'claude-sonnet-5' },
        );
        expect(argv).not.toContain('--fallback-model');
    });

    it('опции.fallbackModel = "none" тоже подавляет --fallback-model', () => {
        const argv = buildClaudeArgs(
            { maxTurns: 200, fallbackModel: 'none' },
            { fallbackModel: 'claude-sonnet-5' },
        );
        expect(argv).not.toContain('--fallback-model');
    });

    it('без fallbackModel в конфиге и в опциях флаг fallback не появляется', () => {
        const argv = buildClaudeArgs({ maxTurns: 200 }, {});
        expect(argv).not.toContain('--fallback-model');
    });

    it('полный набор опций: порядок флагов детерминирован', () => {
        const argv = buildClaudeArgs(
            { model: 'claude-fable-5', maxTurns: 100 },
            { permissionMode: 'bypassPermissions', fallbackModel: 'claude-sonnet-5' },
        );
        expect(argv).toEqual([
            '-p',
            '--max-turns',
            '100',
            ...LOOP_DENY,
            '--model',
            'claude-fable-5',
            '--permission-mode',
            'bypassPermissions',
            '--fallback-model',
            'claude-sonnet-5',
            '--output-format',
            'json',
        ]);
    });

    // #607: argv больше не содержит промпт вовсе — длина и состав зависят только от
    // model/maxTurns/permissionMode/fallbackModel, а не от размера диффа или ленты
    // комментариев PR. Это и снимает класс E2BIG целиком: argv одного и того же
    // фиксированного вида что для промпта в 10 байт, что в 200 КБ.
    it('#607: argv не содержит промпт вовсе — состав фиксирован флагами', () => {
        const argv = buildClaudeArgs({ maxTurns: 200 }, {});
        expect(argv).toEqual(['-p', '--max-turns', '200', ...LOOP_DENY, '--output-format', 'json']);
    });

    it('чистота: не мутирует переданный конфиг', () => {
        const cfg = { permissionMode: 'bypassPermissions', fallbackModel: 'claude-sonnet-5' };
        const snapshot = JSON.stringify(cfg);
        buildClaudeArgs({ maxTurns: 200 }, cfg);
        expect(JSON.stringify(cfg)).toBe(snapshot);
    });
});

describe('spawnClaude — фактический вызов spawn-функции (граница anti-RCE защиты + #607 стдин)', () => {
    // buildClaudeArgs выше проверяет только сборку argv-массива. Здесь — что этот
    // массив реально доходит до вызова с shell:false, и что промпт уходит через
    // `input` (stdin), а НЕ через argv — именно это, а не сама сборка массива,
    // закрывает и RCE-класс (#67), и E2BIG-класс (#607). Регрессия вида «shell:false
    // случайно потерялся при рефакторе» или «промпт снова подмешали в argv» ловится
    // только тут.
    // Фейковую spawn-функцию передаём параметром явно (см. комментарий в шапке
    // файла) — production-путь (без него) здесь намеренно не трогаем, чтобы не
    // дёргать настоящий claude.exe из юнит-теста.
    let spawnFn: Mock;
    beforeEach(() => {
        spawnFn = vi.fn();
        // log() на пути сигнала пишет в console.log и в файл ralph.log — глушим оба
        // побочных эффекта, тестам чистых веток spawnClaude они не нужны.
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('вызывает spawnFn с бинарём claude, shell:false, argv от buildClaudeArgs и промптом через input, НЕ argv', () => {
        spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
        const evil = 'вывод: `rm -rf /` и $(whoami) и %PATH% и "кавычки" ; echo pwned';
        const argv = buildClaudeArgs({ maxTurns: 200 }, {});

        spawnClaude(argv, evil, 60_000, spawnFn);

        expect(spawnFn).toHaveBeenCalledTimes(1);
        const [bin, calledArgs, opts] = spawnFn.mock.calls[0];
        expect(bin).toBe('claude');
        // Тот же массив, не пересобран — и промпт в нём НЕ появился (#607: раньше был
        // вторым элементом argv, теперь argv от размера/содержимого промпта не зависит).
        expect(calledArgs).toBe(argv);
        expect(calledArgs.join(' ')).not.toContain(evil);
        // Промпт со спецсимволами доходит до вызова как есть — байт-в-байт, дословно,
        // но через input, не через шелл-строку и не через argv.
        expect(opts.input).toBe(evil);
        expect(opts.shell).toBe(false);
        expect(opts.timeout).toBe(60_000);
    });

    it('промпт с переводами строк и кавычками уходит через input дословно', () => {
        spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
        const multiline = 'строка1\nstring "2"\n\tтаб';
        spawnClaude(['-p', '--max-turns', '1'], multiline, 1000, spawnFn);
        const [, , opts] = spawnFn.mock.calls[0];
        expect(opts.input).toBe(multiline);
    });

    // #607, критерий готовности: промпт 200 КБ (дифф фазы + вся лента комментариев PR)
    // уходит в сессию и не роняет запуск. Раньше эквивалентный по размеру промпт в
    // argv ловил execve E2BIG (предел ядра — 131072 байта на аргумент); через input
    // такого предела нет.
    it('#607: промпт 200 КБ уходит через input, argv остаётся коротким и фиксированным', () => {
        spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
        const bigPrompt = 'ф'.repeat(200_000);
        const argv = buildClaudeArgs({ maxTurns: 200 }, {});

        const result = spawnClaude(argv, bigPrompt, 60_000, spawnFn);

        const [, calledArgs, opts] = spawnFn.mock.calls[0];
        // argv тот же самый, что для крошечного промпта — вот содержательная проверка
        // «argv не растёт с размером промпта» (ревью #612: прежняя мерила длину массива,
        // уже зафиксированного toEqual выше, и упасть не могла в принципе).
        expect(calledArgs).toEqual(buildClaudeArgs({ maxTurns: 200 }, {}));
        expect(opts.input).toBe(bigPrompt);
        expect(opts.input.length).toBe(200_000);
        expect(result.code).toBe(0);
    });

    it('успешное завершение (status:0) → {code:0, output: stdout+stderr}', () => {
        spawnFn.mockReturnValue({ status: 0, stdout: 'done', stderr: '', signal: null });
        expect(spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn)).toEqual({
            code: 0,
            output: 'done\n',
            endReason: 'completed',
        });
    });

    it('ненулевой exit-код процесса пробрасывается как code', () => {
        spawnFn.mockReturnValue({ status: 2, stdout: '', stderr: 'boom', signal: null });
        // #611: обычное падение сессии (status ненулевой, res.error нет) классифицируется
        // как failureKind:'session-failed' — прежнее поведение (code/output) не меняется,
        // структурный признак лишь называет класс отказа явно.
        expect(spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn)).toEqual({
            code: 2,
            output: '\nboom',
            failureKind: 'session-failed',
            endReason: 'unknown',
        });
    });

    it('процесс убит по сигналу (таймаут) → code:1, не бросает исключение', () => {
        spawnFn.mockReturnValue({ status: null, stdout: '', stderr: '', signal: 'SIGTERM' });
        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);
        expect(result.code).toBe(1);
    });

    it('без env-аргумента опции spawn НЕ содержат ключ env — Claude-путь наследует env раннера байт-в-байт', () => {
        spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
        spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);
        const [, , opts] = spawnFn.mock.calls[0];
        expect('env' in opts).toBe(false);
    });

    it('с env-аргументом (#373 Kimi) опции spawn несут ровно этот env', () => {
        spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
        const env = { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' };
        spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn, env);
        const [, , opts] = spawnFn.mock.calls[0];
        expect(opts.env).toBe(env);
        expect(opts.shell).toBe(false);
    });

    // #607, критерий готовности: E2BIG (или текстовая формулировка "Argument list too
    // long") распознаётся отдельно от обычного падения сессии, и лог называет причину
    // прямо — раньше это тонуло в generic «code 1, ноль строк вывода», которое раннер
    // трактовал как «ревью не дало вердикта».
    it('#607/#611: спавн-ошибка E2BIG логируется отдельной строкой и несёт failureKind:arg-too-long', () => {
        const err = Object.assign(new Error('spawnSync claude E2BIG'), { code: 'E2BIG' });
        spawnFn.mockReturnValue({ status: null, stdout: '', stderr: '', signal: null, error: err });
        const logSpy = vi.spyOn(console, 'log');

        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);

        expect(result.code).toBe(1);
        expect(result.failureKind).toBe('arg-too-long');
        expect(result.systemErrorCode).toBe('E2BIG');
        const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/E2BIG/);
        expect(logged).not.toMatch(/не дало вердикта/);
    });

    it('#607: текст "Argument list too long" без кода E2BIG распознаётся тем же путём', () => {
        const err = new Error('posix_spawn: Argument list too long');
        spawnFn.mockReturnValue({ status: null, stdout: '', stderr: '', signal: null, error: err });
        const logSpy = vi.spyOn(console, 'log');

        spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);

        const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/Argument list too long/);
    });

    // #611: корень трёх ночных отказов — spawnSync.error терялся целиком (только status/
    // signal/stdout/stderr читались, res.error никогда). ENOENT/E2BIG/EACCES/ENOBUFS были
    // неотличимы от честного `{code:1, output:'\n'}`. Классификация — НА ГРАНИЦЕ spawn (где
    // res.error ещё доступен), не по тексту вывода.
    it('#611: {status:null, error:{code:ENOENT}} → failureKind:runtime-unavailable, systemErrorCode:ENOENT', () => {
        const err = Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' });
        spawnFn.mockReturnValue({ status: null, stdout: '', stderr: '', signal: null, error: err });
        const logSpy = vi.spyOn(console, 'log');

        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);

        expect(result.code).toBe(1);
        expect(result.failureKind).toBe('runtime-unavailable');
        expect(result.systemErrorCode).toBe('ENOENT');
        const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/рантайм недоступен/);
    });

    it('#611: {status:null, error:{code:E2BIG}} → failureKind:arg-too-long, systemErrorCode:E2BIG', () => {
        const err = Object.assign(new Error('spawnSync claude E2BIG'), { code: 'E2BIG' });
        spawnFn.mockReturnValue({ status: null, stdout: '', stderr: '', signal: null, error: err });

        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);

        expect(result.failureKind).toBe('arg-too-long');
        expect(result.systemErrorCode).toBe('E2BIG');
    });

    it('#611: обычное падение сессии (status:1, есть вывод, res.error нет) → failureKind:session-failed', () => {
        spawnFn.mockReturnValue({
            status: 1,
            stdout: '',
            stderr: 'Error: тест не прошёл, ожидали 3 получили 4',
            signal: null,
        });

        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);

        expect(result.code).toBe(1);
        expect(result.failureKind).toBe('session-failed');
        expect(result.systemErrorCode).toBeUndefined();
    });

    it('#611: иная ошибка запуска (EACCES, нет прав) → failureKind:spawn-failed, systemErrorCode:EACCES', () => {
        const err = Object.assign(new Error('spawnSync claude EACCES'), { code: 'EACCES' });
        spawnFn.mockReturnValue({ status: null, stdout: '', stderr: '', signal: null, error: err });

        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);

        expect(result.code).toBe(1);
        expect(result.failureKind).toBe('spawn-failed');
        expect(result.systemErrorCode).toBe('EACCES');
    });

    // Ревью #612: два исхода, где res.error ЕСТЬ, но процесс отработал. Граница обязана
    // относить их к сессии, а не к запуску, иначе таймаут читается в логе как «не
    // запустился», а успешный многословный прогон превращается в падение.
    it('ревью #612: таймаут (SIGTERM + ETIMEDOUT) → прежняя точная строка про сигнал', () => {
        const err = Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' });
        spawnFn.mockReturnValue({
            status: null,
            stdout: '',
            stderr: '',
            signal: 'SIGTERM',
            error: err,
        });
        const logSpy = vi.spyOn(console, 'log');

        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 60_000, spawnFn);

        expect(result).toEqual({
            code: 1,
            output: '\n',
            failureKind: 'session-failed',
            endReason: 'timeout',
        });
        const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/убит по сигналу SIGTERM/);
        expect(logged).not.toMatch(/не запустился/);
    });

    it('ревью #612: ENOBUFS при status:0 остаётся успехом (вывод обрезан, сессия отработала)', () => {
        const err = Object.assign(new Error('spawnSync claude ENOBUFS'), { code: 'ENOBUFS' });
        spawnFn.mockReturnValue({
            status: 0,
            stdout: 'много букв',
            stderr: '',
            signal: null,
            error: err,
        });
        const logSpy = vi.spyOn(console, 'log');

        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);

        expect(result).toEqual({ code: 0, output: 'много букв\n', endReason: 'completed' });
        expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/ENOBUFS/);
    });

    it('#611: успех (status:0) не несёт failureKind вовсе', () => {
        spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
        const result = spawnClaude(['-p', '--max-turns', '1'], 'x', 1000, spawnFn);
        expect(result.failureKind).toBeUndefined();
    });
});

// Юниты самих правил (isArgvTooLong/argvTooLongMessage/classifySpawnOutcome) переехали к
// своему модулю — core/spawn-failure.test.ts (ревью #612). Здесь остаётся только граница
// spawn: что spawnClaude/spawnCodex эти правила ПРИМЕНЯЮТ (см. describe выше) и что имена
// остаются на API-поверхности (REQUIRED_API).

// #373 (фаза 6): рантайм Kimi — тот же бинарь `claude` через endpoint Moonshot, выбор
// конфигом (adapters.coderRuntime: 'kimi'). Смоук + юниты чистых хелперов. Claude-путь не
// меняется: дефолт coderRuntime остаётся claude, его сценарии выше зелёные.
describe('Kimi-рантайм (#373) — Claude-spawn + env Moonshot', () => {
    // Боевой fail уходит в process.exit; в тестах инжектируем бросающий, чтобы увидеть стоп.
    const throwingFail = (msg: string) => {
        throw new Error(msg);
    };

    describe('buildKimiSpawnEnv — окружение процесса claude под Moonshot (чистая функция)', () => {
        const { buildKimiSpawnEnv } = ralph;

        it('добавляет ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN, наследуя базовое env', () => {
            const env = buildKimiSpawnEnv('https://api.moonshot.ai/anthropic', 'sk-moon', {
                PATH: '/usr/bin',
                HOME: '/root',
            });
            expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
            expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-moon');
            expect(env.PATH).toBe('/usr/bin');
            expect(env.HOME).toBe('/root');
        });

        it('снимает каналы Claude-аутентификации (иначе CLI ушёл бы на api.anthropic.com мимо Kimi)', () => {
            const env = buildKimiSpawnEnv('https://api.moonshot.ai/anthropic', 'sk-moon', {
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-claude',
                RALPH_CLAUDE_OAUTH_TOKENS: 'oauth-a,oauth-b',
                ANTHROPIC_API_KEY: 'anthropic-key',
            });
            expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
            // Задача 96: список ключей ротации — тот же канал Claude, только во множественном.
            expect('RALPH_CLAUDE_OAUTH_TOKENS' in env).toBe(false);
            expect('ANTHROPIC_API_KEY' in env).toBe(false);
        });

        it('вычищает секреты ЧУЖИХ провайдеров/каналов (OpenAI, Telegram-бот), GH_TOKEN оставляет', () => {
            // Hardening (ревью-thread): промпт-инъекция в Kimi-сессии не должна одной командой
            // `env` эксфильтровать ключи, которые Kimi не принадлежат. GH_TOKEN нужен git/gh.
            const env = buildKimiSpawnEnv('u', 't', {
                OPENAI_API_KEY: 'sk-openai',
                RALPH_TG_BOT_TOKEN: 'tg-secret',
                GH_TOKEN: 'gh-secret',
            });
            expect('OPENAI_API_KEY' in env).toBe(false);
            expect('RALPH_TG_BOT_TOKEN' in env).toBe(false);
            expect(env.GH_TOKEN).toBe('gh-secret');
        });

        it('не мутирует переданное базовое env', () => {
            const base = { CLAUDE_CODE_OAUTH_TOKEN: 'x', PATH: '/usr/bin' };
            buildKimiSpawnEnv('u', 't', base);
            expect(base.CLAUDE_CODE_OAUTH_TOKEN).toBe('x');
        });
    });

    describe('resolveKimiRuntime — резолв параметров из конфига + env (fail-closed)', () => {
        const { resolveKimiRuntime } = ralph;

        it('дефолты: международный endpoint и env RALPH_KIMI_AUTH_TOKEN', () => {
            const r = resolveKimiRuntime(
                { model: 'kimi-k2-0711-preview' },
                { RALPH_KIMI_AUTH_TOKEN: 'sk-moon' },
                throwingFail,
            );
            expect(r.baseUrl).toBe('https://api.moonshot.ai/anthropic');
            expect(r.model).toBe('kimi-k2-0711-preview');
            expect(r.token).toBe('sk-moon');
            expect(r.fallbackModel).toBe(null);
        });

        it('переопределение baseUrl/authTokenEnv/fallbackModel из конфига', () => {
            const r = resolveKimiRuntime(
                {
                    model: 'kimi-k2-0711-preview',
                    baseUrl: 'https://api.moonshot.cn/anthropic',
                    authTokenEnv: 'MY_KIMI_KEY',
                    fallbackModel: 'kimi-k2-turbo',
                },
                { MY_KIMI_KEY: 'sk-cn' },
                throwingFail,
            );
            expect(r.baseUrl).toBe('https://api.moonshot.cn/anthropic');
            expect(r.token).toBe('sk-cn');
            expect(r.fallbackModel).toBe('kimi-k2-turbo');
        });

        it('отсутствующая/пустая модель → fail (тихий сбой на endpoint Kimi недопустим)', () => {
            expect(() =>
                resolveKimiRuntime({}, { RALPH_KIMI_AUTH_TOKEN: 'x' }, throwingFail),
            ).toThrow(/kimiRuntime\.model/);
            expect(() =>
                resolveKimiRuntime({ model: '   ' }, { RALPH_KIMI_AUTH_TOKEN: 'x' }, throwingFail),
            ).toThrow(/kimiRuntime\.model/);
        });

        it('отсутствующий ключ Moonshot в env → fail (секреты только из env, инвариант №11)', () => {
            expect(() =>
                resolveKimiRuntime({ model: 'kimi-k2-0711-preview' }, {}, throwingFail),
            ).toThrow(/RALPH_KIMI_AUTH_TOKEN/);
        });

        it('requireToken:false (dry) — без ключа не падает, token=null, но кривая модель всё равно fail', () => {
            const r = resolveKimiRuntime({ model: 'kimi-k2-0711-preview' }, {}, throwingFail, {
                requireToken: false,
            });
            expect(r.token).toBe(null);
            expect(() => resolveKimiRuntime({}, {}, throwingFail, { requireToken: false })).toThrow(
                /kimiRuntime\.model/,
            );
        });
    });

    describe('runKimiOnce — смоук: кодер-сессия стартует и выдаёт дифф', () => {
        let runtime: ReturnType<typeof buildRuntime>;
        const savedToken = process.env.RALPH_KIMI_AUTH_TOKEN;

        beforeEach(() => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            runtime = buildRuntime();
            runtime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                kimiRuntime: { model: 'kimi-k2-0711-preview' },
            });
            process.env.RALPH_KIMI_AUTH_TOKEN = 'sk-moon-smoke';
        });
        afterEach(() => {
            vi.restoreAllMocks();
            if (savedToken === undefined) delete process.env.RALPH_KIMI_AUTH_TOKEN;
            else process.env.RALPH_KIMI_AUTH_TOKEN = savedToken;
        });

        it('спавнит `claude` с моделью Kimi и env Moonshot, возвращает дифф, токен НЕ в argv', () => {
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : {
                          status: 0,
                          stdout: 'diff --git a/f b/f\n+добавлено',
                          stderr: '',
                          signal: null,
                      },
            );

            const res = runtime.runKimiOnce(
                'тестовая задача',
                { maxTurns: 5 },
                spawnFn as unknown as SpawnSyncFn,
                VERSION_UNREAD,
            );

            expect(res).toEqual({
                code: 0,
                output: 'diff --git a/f b/f\n+добавлено\n',
                endReason: 'completed',
            });
            expect(spawnFn).toHaveBeenCalledTimes(1);
            const [bin, argv, opts] = spawnFn.mock.calls[0];
            expect(bin).toBe('claude');
            // Модель — Moonshot из kimiRuntime.model, а НЕ claude-модель из modelRouting.
            expect(argv).toContain('--model');
            expect(argv[argv.indexOf('--model') + 1]).toBe('kimi-k2-0711-preview');
            expect(argv).toContain('--permission-mode');
            // Секрет ушёл env'ом, не в argv (иначе виден в /proc/*/cmdline).
            expect(argv.join(' ')).not.toContain('sk-moon-smoke');
            expect(opts.shell).toBe(false);
            expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
            expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-moon-smoke');
        });

        it('НЕ подмешивает общий claude fallbackModel в Kimi-сессию (research, риск #3)', () => {
            const spawnFn = vi.fn<SpawnFake>(() => ({
                status: 0,
                stdout: 'ok',
                stderr: '',
                signal: null,
            }));
            // REAL_CONFIG.fallbackModel = claude-opus-4-8 — он не должен утечь в argv Kimi.
            runtime.runKimiOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                VERSION_UNREAD,
            );
            const [, argv] = spawnFn.mock.calls[0];
            expect(argv).not.toContain('--fallback-model');
        });

        // #393 (блокер фазы 6): claude-имя, пришедшее БЕЗ тега провайдера (сессии сдачи/
        // ревью/heal передают cfg.model/reviewModel статическому рантайму; кодер-итерация
        // без route-модели падает на config.model), НЕ должно уехать `claude --model
        // claude-opus-4-8` против Moonshot — рантайм обязан отбросить его и взять kimiRuntime.model.
        it('#393: claude-имя opts.model БЕЗ modelProvider отбрасывается → argv берёт kimiRuntime.model', () => {
            const spawnFn = vi.fn<SpawnFake>(() => ({
                status: 0,
                stdout: 'ok',
                stderr: '',
                signal: null,
            }));
            runtime.runKimiOnce(
                'сессия сдачи',
                { model: 'claude-opus-4-8', maxTurns: 5 },
                spawnFn as unknown as SpawnSyncFn,
                VERSION_UNREAD,
            );
            const [, argv] = spawnFn.mock.calls[0];
            expect(argv[argv.indexOf('--model') + 1]).toBe('kimi-k2-0711-preview');
            expect(argv.join(' ')).not.toContain('claude-opus-4-8');
        });

        // #393: тот же класс, но модель пришла ИЗ МАРШРУТА с тегом modelProvider:'kimi'
        // (route явно выбрал провайдера kimi + свою модель) — её раннер применяет.
        it('#393: opts.model с modelProvider:"kimi" применяется (модель маршрута Moonshot)', () => {
            const spawnFn = vi.fn<SpawnFake>(() => ({
                status: 0,
                stdout: 'ok',
                stderr: '',
                signal: null,
            }));
            runtime.runKimiOnce(
                'кодер-итерация',
                { model: 'kimi-k2-turbo-preview', maxTurns: 5, modelProvider: 'kimi' },
                spawnFn as unknown as SpawnSyncFn,
                VERSION_UNREAD,
            );
            const [, argv] = spawnFn.mock.calls[0];
            expect(argv[argv.indexOf('--model') + 1]).toBe('kimi-k2-turbo-preview');
        });

        // #393: тег ЧУЖОГО провайдера (openai) к kimi-рантайму модель тоже не пускает —
        // применяется только собственный тег провайдера.
        it('#393: opts.model с чужим modelProvider:"openai" отбрасывается kimi-рантаймом', () => {
            const spawnFn = vi.fn<SpawnFake>(() => ({
                status: 0,
                stdout: 'ok',
                stderr: '',
                signal: null,
            }));
            runtime.runKimiOnce(
                'x',
                { model: 'gpt-5-codex', maxTurns: 5, modelProvider: 'openai' },
                spawnFn as unknown as SpawnSyncFn,
                VERSION_UNREAD,
            );
            const [, argv] = spawnFn.mock.calls[0];
            expect(argv[argv.indexOf('--model') + 1]).toBe('kimi-k2-0711-preview');
            expect(argv.join(' ')).not.toContain('gpt-5-codex');
        });
    });
});

// #374 (фаза 6): рантайм OpenAI — ОТДЕЛЬНЫЙ бинарь `codex exec` (не поверх claude), выбор
// конфигом (adapters.coderRuntime: 'openai'). Смоук + юниты чистых хелперов. Claude-путь не
// меняется: дефолт coderRuntime остаётся claude, его сценарии выше зелёные.
describe('OpenAI-рантайм (#374) — codex exec, отдельный бинарь', () => {
    // Боевой fail уходит в process.exit; в тестах инжектируем бросающий, чтобы увидеть стоп.
    const throwingFail = (msg: string) => {
        throw new Error(msg);
    };

    describe('buildCodexArgs — построение argv для `codex exec` (чистая функция)', () => {
        const { buildCodexArgs } = ralph;

        it('exec + аппрув never + песочница + модель + `-- -` (промпт со stdin)', () => {
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'danger-full-access',
            });
            // Порядок исправлен по 3-му проходу ревью: `-a` — глобальный флаг и стоит ДО
            // подкоманды `exec`, иначе CLI отвергает argv целиком (проверено живым запуском).
            expect(argv).toEqual([
                '-a',
                'never',
                'exec',
                '-s',
                'danger-full-access',
                '-c',
                'model_provider="openai"',
                '--ignore-user-config',
                '-m',
                'gpt-5-codex',
                '--',
                '-',
            ]);
        });

        it('#8: промпта в argv нет — последний элемент `-` после `--`, «читай stdin»', () => {
            // `-` после `--` — документированная форма `codex exec` «промпт со stdin»
            // (`codex exec --help`, CLI 0.163.0), проверено живым запуском. Промпт в argv
            // упирался в MAX_ARG_STRLEN (131072 байта) так же, как Claude-путь до #607.
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'workspace-write',
            });
            expect(argv.slice(-2)).toEqual(['--', '-']);
        });

        it('без модели пара -m не добавляется (резолв всё равно её требует — fail-closed выше)', () => {
            const argv = buildCodexArgs({ sandboxMode: 'read-only' });
            expect(argv).not.toContain('-m');
        });

        it('НЕ содержит Claude-специфичных флагов --max-turns/--fallback-model (риск #3)', () => {
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'danger-full-access',
            });
            expect(argv).not.toContain('--max-turns');
            expect(argv).not.toContain('--fallback-model');
        });

        it('#8: argv фиксированной длины — от промпта не зависит вовсе', () => {
            // Промпт сюда больше не передаётся: функция его не видит, поэтому и в argv он
            // не попадёт ни целиком, ни куском. Общая длина — флаги и имя модели.
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'danger-full-access',
                authMode: 'subscription',
            });
            expect(argv.join(' ').length).toBeLessThan(512);
        });
    });

    describe('buildCodexArgs — принудительный канал входа в argv (подписка)', () => {
        const { buildCodexArgs } = ralph;

        it('глобальные флаги идут ДО подкоманды exec (иначе CLI отвергает argv)', () => {
            // Ревью Codex (3-й проход) + живая проверка: `codex exec -a never` даёт
            // `unexpected argument '-a'` и exit 2 на CLI 0.147.0 — то есть OpenAI-рантайм не
            // запускался вовсе. Верный порядок: `codex -a never exec …`.
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'read-only',
            });
            expect(argv[0]).toBe('-a');
            expect(argv[2]).toBe('exec');
            expect(argv.indexOf('-a')).toBeLessThan(argv.indexOf('exec'));
        });

        it('пользовательский config.toml не загружается: --ignore-user-config', () => {
            // Ревью Codex (4-й проход): `model_provider="openai"` запрещает custom provider по
            // id, но `openai_base_url` в пользовательском конфиге всё равно перенаправил бы
            // встроенный провайдер. Вектор не теоретический: сессии раннера ходят с
            // danger-full-access и сами могут дописать ~/.codex/config.toml.
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'read-only',
            });
            expect(argv).toContain('--ignore-user-config');
            expect(argv.indexOf('--ignore-user-config')).toBeLessThan(argv.indexOf('--'));
        });

        it('провайдер фиксируется в argv: -c model_provider="openai"', () => {
            // Ревью Codex (3-й проход): `forced_login_method` ограничивает СПОСОБ входа, но не
            // выбор провайдера — пользовательский config.toml мог увести сессию на custom
            // provider со своим env_key/base_url, а `login status` при этом честно показывал бы
            // ChatGPT.
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'read-only',
            });
            const i = argv.indexOf('model_provider="openai"');
            expect(i).toBeGreaterThan(0);
            expect(argv[i - 1]).toBe('-c');
        });

        it('subscription: argv несёт -c forced_login_method="chatgpt"', () => {
            // Ревью Codex (2-й проход): проверка `login status` оставляет TOCTOU между
            // проверкой и exec, а custom provider с ней не связан вовсе. Канал фиксируется
            // на самом вызове.
            const argv = buildCodexArgs({
                model: 'gpt-5.6-sol',
                sandboxMode: 'read-only',
                authMode: 'subscription',
            });
            const i = argv.indexOf('forced_login_method="chatgpt"');
            expect(i).toBeGreaterThan(0);
            expect(argv[i - 1]).toBe('-c');
            // Хвост argv — `-- -`: промпт идёт stdin'ом (#8), флаг принуждения — до него.
            expect(argv.slice(-2)).toEqual(['--', '-']);
            expect(i).toBeLessThan(argv.indexOf('--'));
        });

        it('apiKey: флага принуждения нет — чужой канал не навязываем', () => {
            const argv = buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'danger-full-access',
                authMode: 'apiKey',
            });
            expect(argv.join(' ')).not.toContain('forced_login_method');
        });
    });

    describe('buildOpenAISpawnEnv — окружение процесса codex (чистая функция)', () => {
        const { buildOpenAISpawnEnv } = ralph;

        it('кладёт ключ под OPENAI_API_KEY, наследуя базовое env', () => {
            const env = buildOpenAISpawnEnv('sk-openai', { PATH: '/usr/bin', HOME: '/root' });
            expect(env.OPENAI_API_KEY).toBe('sk-openai');
            expect(env.PATH).toBe('/usr/bin');
            expect(env.HOME).toBe('/root');
        });

        it('ключ codex ждёт именно в OPENAI_API_KEY, даже если резолвился из другой env-переменной', () => {
            // authTokenEnv может быть кастомным (MY_OPENAI_KEY), но codex читает OPENAI_API_KEY —
            // маппинг делает именно этот хелпер.
            const env = buildOpenAISpawnEnv('sk-from-custom', { MY_OPENAI_KEY: 'sk-from-custom' });
            expect(env.OPENAI_API_KEY).toBe('sk-from-custom');
        });

        it('не мутирует переданное базовое env', () => {
            const base = { PATH: '/usr/bin' };
            buildOpenAISpawnEnv('t', base);
            expect('OPENAI_API_KEY' in base).toBe(false);
        });

        it('вычищает секреты ЧУЖИХ провайдеров/каналов, GH_TOKEN оставляет (hardening)', () => {
            // Ревью-thread: песочница codex по дефолту danger-full-access + C3-инъекции через
            // тело issue → секреты чужих провайдеров не должны уезжать в env codex. GH_TOKEN
            // нужен кодер-сессии для git/gh (та же экспозиция, что у Claude-пути).
            const env = buildOpenAISpawnEnv('sk-openai', {
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-claude',
                RALPH_CLAUDE_OAUTH_TOKENS: 'oauth-a,oauth-b',
                ANTHROPIC_API_KEY: 'anthropic-key',
                ANTHROPIC_AUTH_TOKEN: 'anthropic-auth',
                RALPH_KIMI_AUTH_TOKEN: 'sk-moon',
                RALPH_TG_BOT_TOKEN: 'tg-secret',
                GH_TOKEN: 'gh-secret',
            });
            expect(env.OPENAI_API_KEY).toBe('sk-openai');
            expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false);
            expect('RALPH_CLAUDE_OAUTH_TOKENS' in env).toBe(false);
            expect('ANTHROPIC_API_KEY' in env).toBe(false);
            expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false);
            expect('RALPH_KIMI_AUTH_TOKEN' in env).toBe(false);
            expect('RALPH_TG_BOT_TOKEN' in env).toBe(false);
            expect(env.GH_TOKEN).toBe('gh-secret');
        });

        it('вычищает и КАСТОМНУЮ env-переменную ключа — при подписке и при apiKey', () => {
            // Ревью Codex по !104: при authTokenEnv='MY_OPENAI_KEY' резолвер возвращал token=null,
            // а сама переменная оставалась в окружении — секрет уезжал в песочницу
            // danger-full-access, и codex мог взять его как env_key custom provider.
            const sub = buildOpenAISpawnEnv(null, { MY_OPENAI_KEY: 'sk-secret' }, 'MY_OPENAI_KEY');
            expect('MY_OPENAI_KEY' in sub).toBe(false);
            expect('OPENAI_API_KEY' in sub).toBe(false);

            // В режиме apiKey ключ уходит под именем, которое ждёт codex, а кастомное имя
            // в окружении стороннего бинаря не нужно вовсе.
            const api = buildOpenAISpawnEnv(
                'sk-secret',
                { MY_OPENAI_KEY: 'sk-secret' },
                'MY_OPENAI_KEY',
            );
            expect(api.OPENAI_API_KEY).toBe('sk-secret');
            expect('MY_OPENAI_KEY' in api).toBe(false);
        });

        it('подписка (token=null): OPENAI_API_KEY вычищается, а не наследуется из базового env', () => {
            // #83: ключ, случайно оказавшийся в окружении раннера, молча увёл бы сессию на
            // платный API вместо подписки — тихий выбор канала оплаты (инвариант №1). Поэтому
            // при подписке переменная именно УДАЛЯЕТСЯ, а не «просто не подставляется».
            const env = buildOpenAISpawnEnv(null, {
                OPENAI_API_KEY: 'sk-from-env',
                HOME: '/root',
                GH_TOKEN: 'gh-secret',
            });
            expect('OPENAI_API_KEY' in env).toBe(false);
            // HOME остаётся: подписка читается codex'ом из ~/.codex/auth.json.
            expect(env.HOME).toBe('/root');
            expect(env.GH_TOKEN).toBe('gh-secret');
        });
    });

    describe('resolveOpenAIRuntime — резолв параметров из конфига + env (fail-closed)', () => {
        const { resolveOpenAIRuntime } = ralph;

        it('дефолты: песочница danger-full-access и env OPENAI_API_KEY', () => {
            const r = resolveOpenAIRuntime(
                { model: 'gpt-5-codex' },
                { OPENAI_API_KEY: 'sk-openai' },
                throwingFail,
            );
            expect(r.model).toBe('gpt-5-codex');
            expect(r.sandboxMode).toBe('danger-full-access');
            expect(r.token).toBe('sk-openai');
        });

        it('переопределение sandboxMode/authTokenEnv из конфига', () => {
            const r = resolveOpenAIRuntime(
                {
                    model: 'gpt-5-codex',
                    sandboxMode: 'workspace-write',
                    authTokenEnv: 'MY_OPENAI_KEY',
                },
                { MY_OPENAI_KEY: 'sk-custom' },
                throwingFail,
            );
            expect(r.sandboxMode).toBe('workspace-write');
            expect(r.token).toBe('sk-custom');
        });

        it('отсутствующая/пустая модель → fail (скрытый дефолт codex недопустим, инвариант №1)', () => {
            expect(() => resolveOpenAIRuntime({}, { OPENAI_API_KEY: 'x' }, throwingFail)).toThrow(
                /openaiRuntime\.model/,
            );
            expect(() =>
                resolveOpenAIRuntime({ model: '   ' }, { OPENAI_API_KEY: 'x' }, throwingFail),
            ).toThrow(/openaiRuntime\.model/);
        });

        it('отсутствующий ключ OpenAI в env → fail (секреты только из env, инвариант №11)', () => {
            expect(() => resolveOpenAIRuntime({ model: 'gpt-5-codex' }, {}, throwingFail)).toThrow(
                /OPENAI_API_KEY/,
            );
        });

        it('authMode subscription: без ключа не падает, token=null (авторизация — ~/.codex/auth.json)', () => {
            // #83: у нас нет ключа OpenAI вовсе — codex авторизуется подпиской ChatGPT.
            const r = resolveOpenAIRuntime(
                { model: 'gpt-5.6-sol', authMode: 'subscription' },
                {},
                throwingFail,
            );
            expect(r.authMode).toBe('subscription');
            expect(r.token).toBe(null);
        });

        it('authMode subscription: ключ из env НЕ подхватывается (иначе тихий уход на платный API)', () => {
            const r = resolveOpenAIRuntime(
                { model: 'gpt-5.6-sol', authMode: 'subscription' },
                { OPENAI_API_KEY: 'sk-openai' },
                throwingFail,
            );
            expect(r.token).toBe(null);
        });

        it('дефолт authMode — apiKey: прежнее поведение fail-closed без ключа', () => {
            const r = resolveOpenAIRuntime(
                { model: 'gpt-5-codex' },
                { OPENAI_API_KEY: 'sk-openai' },
                throwingFail,
            );
            expect(r.authMode).toBe('apiKey');
            expect(() => resolveOpenAIRuntime({ model: 'gpt-5-codex' }, {}, throwingFail)).toThrow(
                /OPENAI_API_KEY/,
            );
        });

        it('явный null в authMode → fail, а не молчаливый apiKey', () => {
            // Ревью Codex: `openai.authMode ?? 'apiKey'` глотает JSON-значение null, и обещанный
            // fail-closed не срабатывает — конфиг с опечаткой уходит на платный канал.
            expect(() =>
                resolveOpenAIRuntime(
                    { model: 'gpt-5-codex', authMode: null } as never,
                    { OPENAI_API_KEY: 'sk-openai' },
                    throwingFail,
                ),
            ).toThrow(/authMode/);
        });

        it('возвращает имя env-переменной ключа — его вычищают из окружения сессии', () => {
            const r = resolveOpenAIRuntime(
                { model: 'gpt-5-codex', authTokenEnv: 'MY_OPENAI_KEY' },
                { MY_OPENAI_KEY: 'sk-custom' },
                throwingFail,
            );
            expect(r.tokenEnv).toBe('MY_OPENAI_KEY');
        });

        it('неизвестный authMode → fail (канал авторизации не выбирается молча, инвариант №1)', () => {
            expect(() =>
                resolveOpenAIRuntime(
                    { model: 'gpt-5-codex', authMode: 'oauth' } as never,
                    { OPENAI_API_KEY: 'sk-openai' },
                    throwingFail,
                ),
            ).toThrow(/authMode/);
        });

        it('requireToken:false (dry) — без ключа не падает, token=null, но кривая модель всё равно fail', () => {
            const r = resolveOpenAIRuntime({ model: 'gpt-5-codex' }, {}, throwingFail, {
                requireToken: false,
            });
            expect(r.token).toBe(null);
            expect(() =>
                resolveOpenAIRuntime({}, {}, throwingFail, { requireToken: false }),
            ).toThrow(/openaiRuntime\.model/);
        });
    });

    describe('assertNoConflictingForcedLogin — конфиг пользователя против режима', () => {
        const { assertNoConflictingForcedLogin } = ralph;

        const env = { HOME: '/home/user' };

        it('чужой forced_login_method → стоп ДО запуска codex login status', () => {
            // Ревью Codex (5-й проход): `login status` не принимает --ignore-user-config,
            // поэтому грузит пользовательский config.toml — и при несовпадении сам
            // РАЗЛОГИНИВАЕТ. То есть «недеструктивная проверка» деструктивна ровно в том
            // случае, ради которого её ставили. Ловим это до спавна, чтением конфига.
            const readFn = () => 'model = "gpt-5.6-sol"\nforced_login_method = "api"\n';
            expect(() =>
                assertNoConflictingForcedLogin(readFn, throwingFail, 'chatgpt', env),
            ).toThrow(/forced_login_method/);
        });

        it('совпадающий forced_login_method — не мешает', () => {
            const readFn = () => 'forced_login_method = "chatgpt"\n';
            expect(() =>
                assertNoConflictingForcedLogin(readFn, throwingFail, 'chatgpt', env),
            ).not.toThrow();
        });

        it('конфига нет или ключа в нём нет — не мешает', () => {
            const missing = () => {
                throw Object.assign(new Error('нет файла'), { code: 'ENOENT' });
            };
            expect(() =>
                assertNoConflictingForcedLogin(missing, throwingFail, 'chatgpt', env),
            ).not.toThrow();
            expect(() =>
                assertNoConflictingForcedLogin(() => 'model = "x"', throwingFail, 'api', env),
            ).not.toThrow();
        });

        it('закомментированная строка не считается', () => {
            const readFn = () => '# forced_login_method = "api"\n';
            expect(() =>
                assertNoConflictingForcedLogin(readFn, throwingFail, 'chatgpt', env),
            ).not.toThrow();
        });

        it.each([
            ["forced_login_method = 'api'", 'literal string'],
            ['"forced_login_method" = "api"', 'quoted key'],
        ])('ловит несовпадение в %s (%s)', (text) => {
            expect(() =>
                assertNoConflictingForcedLogin(() => text, throwingFail, 'chatgpt', env),
            ).toThrow(/forced_login_method/);
        });

        it.each([
            ['forced_login_method = """api"""', 'многострочное значение'],
            ['forced_login_method = api', 'незакавыченное значение'],
            ['Forced_Login_Method = "api"', 'ключ в другом регистре'],
            ['[profile]\nforced_login_method = "api"', 'ключ внутри секции'],
            ['note = """\nforced_login_method = "api"\n"""', 'текст внутри многострочной строки'],
        ])('не принимает %s (%s) за глобальную настройку', (text) => {
            expect(() =>
                assertNoConflictingForcedLogin(() => text, throwingFail, 'chatgpt', env),
            ).not.toThrow();
        });

        it('системный /etc/codex/config.toml тоже читается', () => {
            // Независимое ревью (7-й проход): Codex грузит и системный слой, конфликт оттуда
            // так же разлогинил бы человека на `login status`.
            const seen: string[] = [];
            const readFn = (file: string) => {
                seen.push(file);
                return file.startsWith('/etc/') ? 'forced_login_method = "api"\n' : '';
            };
            expect(() =>
                assertNoConflictingForcedLogin(readFn, throwingFail, 'chatgpt', env),
            ).toThrow(/etc\/codex\/config\.toml/);
            expect(seen).toContain('/etc/codex/config.toml');
        });

        it('комментарий с тройными кавычками не прячет настоящий ключ', () => {
            // Независимое ревью (7-й проход): `# """` уводил парсер в режим multiline, и
            // реальная настройка ниже переставала замечаться, хотя TOML-парсер Codex её видит.
            const readFn = () => '# """ пример\nforced_login_method = "api"\n';
            expect(() =>
                assertNoConflictingForcedLogin(readFn, throwingFail, 'chatgpt', env),
            ).toThrow(/forced_login_method/);
        });

        it('ошибка чтения кроме ENOENT → fail-closed', () => {
            const denied = () => {
                throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            };
            expect(() =>
                assertNoConflictingForcedLogin(denied, throwingFail, 'chatgpt', env),
            ).toThrow(/прочитать.*config\.toml/i);
        });

        it.each([
            [{ CODEX_HOME: '/srv/codex', HOME: '/home/user' }, '/srv/codex/config.toml'],
            [{ HOME: '/home/user' }, '/home/user/.codex/config.toml'],
        ])('читает config.toml из окружения subprocess: %j', (spawnEnv, expectedPath) => {
            const readFn = vi.fn(() => '');
            assertNoConflictingForcedLogin(readFn, throwingFail, 'chatgpt', spawnEnv);
            expect(readFn).toHaveBeenCalledWith(expectedPath, 'utf8');
        });
    });

    describe('assertCodexLoginChannel — фактический канал входа codex (чистая функция)', () => {
        const { assertCodexLoginChannel } = ralph;
        const reply = (stdout: string, status = 0) =>
            vi.fn(() => ({ status, stdout, stderr: '', signal: null }));

        it('вход подпиской — молча пропускает и спрашивает именно `codex login status`', () => {
            const spawnFn = reply('Logged in using ChatGPT');
            expect(() =>
                assertCodexLoginChannel(
                    spawnFn as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).not.toThrow();
            const [bin, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
            expect(bin).toBe('codex');
            expect(args).toEqual(['login', 'status']);
        });

        it('вход ключом → fail с указанием, что именно ответил codex', () => {
            expect(() =>
                assertCodexLoginChannel(
                    reply('Logged in using an API key') as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/Logged in using an API key/);
        });

        it('частичное совпадение НЕ проходит: «Not Logged in using ChatGPT» → fail', () => {
            // Ревью Codex (2-й проход): подстрочный поиск делал барьер fail-open — отрицание
            // перед фразой проходило как успех. Ищем строку статуса, а не подстроку где угодно.
            expect(() =>
                assertCodexLoginChannel(
                    reply('Not Logged in using ChatGPT') as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/authMode='subscription'/);
        });

        it('фраза в stderr при ином статусе в stdout → fail (судим по stdout)', () => {
            const spawnFn = vi.fn(() => ({
                status: 0,
                stdout: 'Logged in using an API key',
                stderr: 'hint: run `codex login` to be Logged in using ChatGPT',
                signal: null,
            }));
            expect(() =>
                assertCodexLoginChannel(
                    spawnFn as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/API key/);
        });

        it('api-канал: частичное совпадение и подмена через stderr не проходят', () => {
            // Симметрия к проверкам ChatGPT-канала (ревью Codex, 5-й проход): ослабление
            // ТОЛЬКО api-регулярки до подстрочного поиска иначе осталось бы зелёным.
            expect(() =>
                assertCodexLoginChannel(
                    reply('Not Logged in using an API key') as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'api',
                ),
            ).toThrow(/authMode='apiKey'/);

            const spawnFn = vi.fn(() => ({
                status: 0,
                stdout: 'Logged in using ChatGPT',
                stderr: 'hint: you could be Logged in using an API key',
                signal: null,
            }));
            expect(() =>
                assertCodexLoginChannel(spawnFn as unknown as SpawnSyncFn, {}, throwingFail, 'api'),
            ).toThrow(/ChatGPT/);
        });

        it('не залогинен вовсе (ненулевой код) → fail', () => {
            expect(() =>
                assertCodexLoginChannel(
                    reply('Not logged in', 1) as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/authMode='subscription'/);
        });

        it('пустой ответ codex → fail, а не молчаливый пропуск (fail-closed)', () => {
            expect(() =>
                assertCodexLoginChannel(
                    reply('') as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/пустой ответ/);
        });

        it('таймаут: spawnSync отдаёт error И signal — в тексте сигнал, а не общая ошибка', () => {
            // Ревью Codex (4-й проход): прежний тест был ложнозелёным — мок нёс только signal,
            // а реальный spawnSync при timeout возвращает ОБА поля, и ветка error забирала
            // управление первой, делая ветку сигнала недостижимой.
            const spawnFn = vi.fn(() => ({
                status: null,
                stdout: '',
                stderr: '',
                signal: 'SIGTERM',
                error: Object.assign(new Error('spawnSync codex ETIMEDOUT'), {
                    code: 'ETIMEDOUT',
                }),
            }));
            expect(() =>
                assertCodexLoginChannel(
                    spawnFn as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/SIGTERM/);
        });

        it('процесс убит сигналом → fail говорит про сигнал, а не «залогинен иначе»', () => {
            // Встроенное ревью SourceCraft: при SIGKILL/таймауте status=null, и прежний текст
            // обвинял бы канал входа вместо настоящей причины. Стоп в обоих случаях, но
            // диагноз обязан быть честным — по нему человек решает, что чинить.
            const spawnFn = vi.fn(() => ({
                status: null,
                stdout: '',
                stderr: '',
                signal: 'SIGKILL',
            }));
            expect(() =>
                assertCodexLoginChannel(
                    spawnFn as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/SIGKILL/);
        });

        it('бинаря нет (spawn отдал error) → fail с текстом ошибки запуска', () => {
            const spawnFn = vi.fn(() => ({
                status: null,
                stdout: '',
                stderr: '',
                signal: null,
                error: new Error('spawn codex ENOENT'),
            }));
            expect(() =>
                assertCodexLoginChannel(
                    spawnFn as unknown as SpawnSyncFn,
                    {},
                    throwingFail,
                    'chatgpt',
                ),
            ).toThrow(/ENOENT/);
        });
    });

    describe('spawnCodex — фактический вызов spawn-функции (граница anti-RCE защиты)', () => {
        let spawnFn: Mock;
        beforeEach(() => {
            spawnFn = vi.fn();
            vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('вызывает spawnFn с бинарём codex, shell:false и тем argv-массивом, что построил buildCodexArgs', () => {
            spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
            const argv = ralph.buildCodexArgs({
                model: 'gpt-5-codex',
                sandboxMode: 'danger-full-access',
            });
            ralph.spawnCodex(argv, 'задача', 60_000, spawnFn);
            expect(spawnFn).toHaveBeenCalledTimes(1);
            const [bin, calledArgs, opts] = spawnFn.mock.calls[0];
            expect(bin).toBe('codex');
            expect(calledArgs).toBe(argv);
            expect(opts.shell).toBe(false);
            expect(opts.timeout).toBe(60_000);
        });

        it('#8: промпт уходит через stdin — `input` и явный pipe, в argv его нет', () => {
            // Фейк подтверждает только проводку: промпт лёг в opts.input, stdin — pipe.
            // Что `codex exec` его оттуда ЧИТАЕТ, проверено живым запуском (докблок spawnCodex).
            spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
            const argv = ralph.buildCodexArgs({ sandboxMode: 'read-only' });
            const prompt = `-начинается с дефиса ${'x'.repeat(200_000)} \`rm -rf /\` $(whoami)`;
            ralph.spawnCodex(argv, prompt, 1000, spawnFn);
            const [, calledArgs, opts] = spawnFn.mock.calls[0];
            expect(opts.input).toBe(prompt);
            expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
            expect(calledArgs.some((a: string) => a.includes('whoami'))).toBe(false);
        });

        it('ненулевой exit-код процесса пробрасывается как code; вывод — stdout+stderr', () => {
            spawnFn.mockReturnValue({ status: 2, stdout: '', stderr: 'boom', signal: null });
            // #611: тот же класс, что у spawnClaude — обычное падение сессии без res.error
            // классифицируется как failureKind:'session-failed'.
            expect(ralph.spawnCodex(['exec'], 'x', 1000, spawnFn)).toEqual({
                code: 2,
                output: '\nboom',
                failureKind: 'session-failed',
                endReason: 'unknown',
            });
        });

        it('процесс убит по сигналу (таймаут) → code:1, не бросает исключение', () => {
            spawnFn.mockReturnValue({ status: null, stdout: '', stderr: '', signal: 'SIGTERM' });
            expect(ralph.spawnCodex(['exec'], 'x', 1000, spawnFn).code).toBe(1);
        });

        it('с env-аргументом опции spawn несут ровно этот env; без него — ключа env нет', () => {
            spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
            const env = { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-x' };
            ralph.spawnCodex(['exec'], 'x', 1000, spawnFn, env);
            expect(spawnFn.mock.calls[0][2].env).toBe(env);
            spawnFn.mockClear();
            ralph.spawnCodex(['exec'], 'x', 1000, spawnFn);
            expect('env' in spawnFn.mock.calls[0][2]).toBe(false);
        });

        // #611, критерий готовности «оба spawn-пути классифицируют одинаково»: до этой правки
        // spawnCodex не читал res.error вовсе. Промпт из codex-argv с тех пор ушёл на stdin
        // (#8), но классификация остаётся: E2BIG даёт и раздутое окружение, а ENOENT и
        // таймаут от длины промпта не зависят.
        it('#611: {status:null, error:{code:ENOENT}} → failureKind:runtime-unavailable, systemErrorCode:ENOENT', () => {
            const err = Object.assign(new Error('spawnSync codex ENOENT'), { code: 'ENOENT' });
            spawnFn.mockReturnValue({
                status: null,
                stdout: '',
                stderr: '',
                signal: null,
                error: err,
            });
            const logSpy = vi.spyOn(console, 'log');

            const result = ralph.spawnCodex(['exec'], 'x', 1000, spawnFn);

            expect(result.code).toBe(1);
            expect(result.failureKind).toBe('runtime-unavailable');
            expect(result.systemErrorCode).toBe('ENOENT');
            const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(logged).toMatch(/рантайм недоступен/);
        });

        it('#611: {status:null, error:{code:E2BIG}} → failureKind:arg-too-long, повторов быть не должно (стоп)', () => {
            const err = Object.assign(new Error('spawnSync codex E2BIG'), { code: 'E2BIG' });
            spawnFn.mockReturnValue({
                status: null,
                stdout: '',
                stderr: '',
                signal: null,
                error: err,
            });
            const logSpy = vi.spyOn(console, 'log');

            const result = ralph.spawnCodex(['exec'], 'x', 1000, spawnFn);

            expect(result.code).toBe(1);
            expect(result.failureKind).toBe('arg-too-long');
            expect(result.systemErrorCode).toBe('E2BIG');
            const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(logged).toMatch(/E2BIG/);
        });

        it('#611: успех (status:0) не несёт failureKind вовсе', () => {
            spawnFn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '', signal: null });
            expect(ralph.spawnCodex(['exec'], 'x', 1000, spawnFn).failureKind).toBeUndefined();
        });
    });

    // Регистрация барьера Codex без дерева сессии — стоп (ревью Фазы 16b); смоук сессии
    // проверяет argv и env, поэтому регистрация подменяется пустой.
    // #195: собранная сессия без хуков барьера — у тестов спавна барьер не предмет. Недоверие
    // и свой дом на месте: без них сверка изоляции остановила бы спавн.
    const CODEX_HOME_DIR = '/path/to/state/codex-session/home';
    const NO_CODEX_GUARD = () => ({
        args: codexUntrustArgs(['/path/to/app']),
        home: CODEX_HOME_DIR,
        keys: ['/path/to/app'],
    });

    describe('runOpenAIOnce — смоук: кодер-сессия стартует и выдаёт дифф', () => {
        let runtime: ReturnType<typeof buildRuntime>;
        const savedToken = process.env.OPENAI_API_KEY;

        beforeEach(() => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            runtime = buildRuntime();
            runtime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                openaiRuntime: { model: 'gpt-5-codex' },
            });
            process.env.OPENAI_API_KEY = 'sk-openai-smoke';
        });
        afterEach(() => {
            vi.restoreAllMocks();
            if (savedToken === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = savedToken;
        });

        it('спавнит `codex` с моделью OpenAI и ключом в env, возвращает дифф, ключ НЕ в argv', () => {
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : {
                          status: 0,
                          stdout: 'diff --git a/f b/f\n+добавлено',
                          stderr: '',
                          signal: null,
                      },
            );

            const res = runtime.runOpenAIOnce(
                'тестовая задача',
                { maxTurns: 5 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );

            expect(res).toEqual({
                code: 0,
                output: 'diff --git a/f b/f\n+добавлено\n',
                endReason: 'completed',
            });
            // Режим apiKey канал не проверяет — процесс ровно один (см. тест ниже про то,
            // почему симметричная проверка ломала «ключ только из env»).
            expect(spawnFn).toHaveBeenCalledTimes(1);
            const [bin, argv, opts] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(bin).toBe('codex');
            // Модель — OpenAI из openaiRuntime.model, а НЕ claude-модель из modelRouting.
            expect(argv).toContain('-m');
            expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5-codex');
            expect(argv).toContain('exec');
            // Ключ ушёл env'ом, не в argv (иначе виден в /proc/*/cmdline).
            expect(argv.join(' ')).not.toContain('sk-openai-smoke');
            expect(opts.shell).toBe(false);
            expect(opts.env.OPENAI_API_KEY).toBe('sk-openai-smoke');
        });

        // #195: дом CLI — собранный раннером, окружение CLI раннера сессии не достаётся.
        it('env спавна: CODEX_HOME — дом сессии, CODEX_* и адрес провайдера раннера вычищены', () => {
            const saved = { ...process.env };
            process.env.CODEX_HOME = '/path/to/human/.codex';
            process.env.CODEX_SANDBOX = 'seatbelt';
            process.env.OPENAI_BASE_URL = 'http://example.com/v1';
            try {
                const spawnFn = vi.fn<SpawnFake>(() => ({
                    status: 0,
                    stdout: 'ok',
                    stderr: '',
                    signal: null,
                }));
                runtime.runOpenAIOnce(
                    'x',
                    { maxTurns: 5 },
                    spawnFn as unknown as SpawnSyncFn,
                    undefined,
                    VERSION_UNREAD,
                    NO_CODEX_GUARD,
                );
                const [, argv, opts] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
                expect(opts.env.CODEX_HOME).toBe(CODEX_HOME_DIR);
                expect(opts.env.CODEX_SANDBOX).toBeUndefined();
                expect(opts.env.OPENAI_BASE_URL).toBeUndefined();
                expect(argv).toEqual(expect.arrayContaining(codexUntrustArgs(['/path/to/app'])));
            } finally {
                process.env = saved;
            }
        });

        it('сессия без недоверия проекту — стоп guard-probe до спавна', () => {
            const spawnFn = vi.fn<SpawnFake>();
            const pushes: string[] = [];
            expect(() =>
                runtime.runOpenAIOnce(
                    'x',
                    { maxTurns: 5 },
                    spawnFn as unknown as SpawnSyncFn,
                    undefined,
                    VERSION_UNREAD,
                    () => ({ args: [], home: CODEX_HOME_DIR, keys: ['/path/to/app'] }),
                    {
                        persistFn: null,
                        pushEventFn: (msg: string) => {
                            pushes.push(msg);
                            return false;
                        },
                        exitFn: (code: number): never => {
                            throw new Error(`exit ${String(code)}`);
                        },
                    },
                ),
            ).toThrow('exit 1');
            expect(spawnFn).not.toHaveBeenCalled();
            expect(pushes[0]).toMatch(/не изолированной[\s\S]*недоверия проекту/);
        });

        it('#8: промпт больше MAX_ARG_STRLEN доезжает до РЕАЛЬНОЙ сессии stdin-ом, argv короткий', () => {
            // Проводка целиком, а не только чистые функции: вызов runOpenAIOnce, забывший
            // передать промпт в spawnCodex, оставил бы юниты выше зелёными.
            const spawnFn = vi.fn<SpawnFake>(() => ({
                status: 0,
                stdout: 'ok',
                stderr: '',
                signal: null,
            }));
            const prompt = 'дифф '.repeat(40_000); // ≈ 400 КБ в UTF-8, предел элемента — 131072
            runtime.runOpenAIOnce(
                prompt,
                { maxTurns: 5 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            const [, argv, opts] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(opts.input).toBe(prompt);
            expect(argv.slice(-2)).toEqual(['--', '-']);
            expect(Math.max(...argv.map((a: string) => Buffer.byteLength(a)))).toBeLessThan(256);
        });

        it('подписка: в env спавна нет OPENAI_API_KEY, хотя ключ лежит в окружении раннера', () => {
            // #83: beforeEach кладёт ключ в process.env — при authMode:'subscription' он не
            // должен доехать до codex, иначе сессия молча уйдёт на платный API.
            runtime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                openaiRuntime: { model: 'gpt-5.6-sol', authMode: 'subscription' },
            });
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? { status: 0, stdout: 'Logged in using ChatGPT', stderr: '', signal: null }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            // Первым идёт `codex login status` (проверка канала), последним — сама сессия.
            const [, argv, opts] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect('OPENAI_API_KEY' in opts.env).toBe(false);
            expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
        });

        it('подписка: сперва проверяет фактический канал входа `codex login status`', () => {
            // Ревью Codex по !104: чистка env НЕ гарантирует подписку — codex мог быть
            // залогинен ключом (auth.json/keyring/другой CODEX_HOME), и сессия молча ушла бы
            // на платный API. Проверяем факт, а не отсутствие переменной.
            runtime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                openaiRuntime: { model: 'gpt-5.6-sol', authMode: 'subscription' },
            });
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? { status: 0, stdout: 'Logged in using ChatGPT', stderr: '', signal: null }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );

            const [firstBin, firstArgs] = spawnFn.mock.calls[0];
            expect(firstBin).toBe('codex');
            expect(firstArgs).toEqual(['login', 'status']);
            // Сессия всё равно стартовала — вход подписочный.
            expect(spawnFn.mock.calls.length).toBe(2);
        });

        it('перед login status читает config.toml, затем обязательно запускает сессию', () => {
            runtime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                openaiRuntime: { model: 'gpt-5.6-sol', authMode: 'subscription' },
            });
            const events: string[] = [];
            const readFn = () => {
                events.push('read-config');
                return 'model = "gpt-5.6-sol"\n';
            };
            const spawnFn = vi.fn<SpawnFake>((_bin, args) => {
                if (Array.isArray(args) && args.includes('status')) {
                    events.push('login-status');
                    return {
                        status: 0,
                        stdout: 'Logged in using ChatGPT',
                        stderr: '',
                        signal: null,
                    };
                }
                events.push('session');
                return { status: 0, stdout: 'ok', stderr: '', signal: null };
            });
            runtime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                readFn,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            // Слоёв конфигурации несколько (пользовательский и системный), поэтому проверяем
            // ПОРЯДОК, а не их количество: любое чтение — до проверки входа, сессия — после.
            expect(events).toContain('read-config');
            expect(events.lastIndexOf('read-config')).toBeLessThan(events.indexOf('login-status'));
            expect(events.indexOf('login-status')).toBeLessThan(events.indexOf('session'));
            expect(spawnFn).toHaveBeenCalledTimes(2);
        });

        it('подписка: codex залогинен ключом → стоп, сессия не спавнится', () => {
            runtime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                openaiRuntime: { model: 'gpt-5.6-sol', authMode: 'subscription' },
            });
            const spawnFn = vi.fn<SpawnFake>(() => ({
                status: 0,
                stdout: 'Logged in using an API key',
                stderr: '',
                signal: null,
            }));
            // Боевой fail() уходит в process.exit — тест ловит именно стоп; текст сообщения
            // проверяется отдельно на чистой assertCodexChatGPTLogin с throwingFail.
            expect(() =>
                runtime.runOpenAIOnce(
                    'x',
                    { maxTurns: 1 },
                    spawnFn as unknown as SpawnSyncFn,
                    undefined,
                    VERSION_UNREAD,
                    NO_CODEX_GUARD,
                ),
            ).toThrow();
            // Ровно один вызов — проверка входа; сама сессия не запускалась.
            expect(spawnFn.mock.calls.length).toBe(1);
        });

        it('apiKey: канал НЕ проверяется — ключ из env самодостаточен', () => {
            // Независимое ревью (7-й проход) + живая проверка: `codex login status` при чистом
            // CODEX_HOME и ключом в env отвечает `Not logged in`. Симметричная проверка делала
            // документированный сценарий «секрет только из env» (инвариант №11) нерабочим:
            // чтобы её пройти, пришлось бы выполнить `codex login --with-api-key`, то есть
            // ЗАПИСАТЬ секрет в auth.json. Дыра «apiKey уедет на подписку при кешированном
            // ChatGPT-входе» осталась и вынесена в #86 — там же отдельный CODEX_HOME.
            const spawnFn = vi.fn<SpawnFake>(() => ({
                status: 0,
                stdout: 'ok',
                stderr: '',
                signal: null,
            }));
            runtime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            expect(spawnFn.mock.calls.length).toBe(1);
            const [, argv] = spawnFn.mock.calls[0];
            expect(argv).toContain('exec');
            expect(argv.join(' ')).not.toContain('forced_login_method');
        });

        it('кастомный authTokenEnv не доезжает до сессии — проводка end-to-end', () => {
            // Ревью Codex (2-й проход): прежние тесты проверяли helper и резолвер по
            // отдельности и оставались зелёными при сломанной проводке в runOpenAIOnce.
            process.env.MY_OPENAI_KEY = 'sk-custom-secret';
            try {
                runtime.setConfigForTests({
                    ...REAL_CONFIG,
                    permissionMode: 'bypassPermissions',
                    openaiRuntime: {
                        model: 'gpt-5-codex',
                        authTokenEnv: 'MY_OPENAI_KEY',
                    },
                });
                const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                    Array.isArray(args) && args.includes('status')
                        ? {
                              status: 0,
                              stdout: 'Logged in using an API key',
                              stderr: '',
                              signal: null,
                          }
                        : { status: 0, stdout: 'ok', stderr: '', signal: null },
                );
                runtime.runOpenAIOnce(
                    'x',
                    { maxTurns: 1 },
                    spawnFn as unknown as SpawnSyncFn,
                    undefined,
                    VERSION_UNREAD,
                    NO_CODEX_GUARD,
                );
                const [, , opts] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
                // Ключ ушёл под именем, которое ждёт codex...
                expect(opts.env.OPENAI_API_KEY).toBe('sk-custom-secret');
                // ...а кастомное имя в окружение стороннего бинаря не попало.
                expect('MY_OPENAI_KEY' in opts.env).toBe(false);
                // Ревью Codex (5-й проход): у ПРОВЕРКИ канала окружение тоже санировано —
                // иначе замена его на process.env прошла бы мимо сьюта, и `login status`
                // снова увидел бы родительский ключ.
                const [, , statusOpts] = spawnFn.mock.calls[0];
                expect('MY_OPENAI_KEY' in statusOpts.env).toBe(false);
                expect(statusOpts.env.OPENAI_API_KEY).toBe('sk-custom-secret');
            } finally {
                delete process.env.MY_OPENAI_KEY;
            }
        });

        it('подписка: forced_login_method доезжает до argv РЕАЛЬНОЙ сессии', () => {
            // Ревью Codex (3-й проход): проводка проверялась только на чистой buildCodexArgs —
            // убери `authMode` из вызова, и тесты остались бы зелёными (тот же класс
            // ложнозелёной проводки, что раньше нашли для tokenEnv).
            runtime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                openaiRuntime: { model: 'gpt-5.6-sol', authMode: 'subscription' },
            });
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? { status: 0, stdout: 'Logged in using ChatGPT', stderr: '', signal: null }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            const [, argv] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(argv).toContain('forced_login_method="chatgpt"');
            // Ревью Codex (5-й проход): проводка проверяется целиком, а не по одному флагу.
            expect(argv).toContain('--ignore-user-config');
            expect(argv).toContain('model_provider="openai"');
        });

        it('apiKey: forced_login_method в argv сессии НЕ появляется', () => {
            // Флаг деструктивен при несовпадении (разлогинивает), поэтому чужой канал не
            // навязываем: в apiKey он не ставится вовсе.
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            const [, argv] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(argv.join(' ')).not.toContain('forced_login_method');
        });

        it('DRY: не спавнит ни `login status`, ни саму сессию', () => {
            // Ревью Codex (2-й проход): DRY проверялся только на уровне резолвера. --dry-run
            // строго read-only, и проверка канала входа — тоже процесс, которого там быть не
            // должно.
            const dryRuntime = buildRuntime({ ...FLAGS_OFF, dry: true });
            dryRuntime.setConfigForTests({
                ...REAL_CONFIG,
                permissionMode: 'bypassPermissions',
                openaiRuntime: { model: 'gpt-5.6-sol', authMode: 'subscription' },
            });
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            const res = dryRuntime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            expect(res).toEqual({ code: 0, output: '' });
            expect(spawnFn).not.toHaveBeenCalled();
        });

        it('НЕ тащит Claude-флаги --max-turns/--fallback-model в codex argv (риск #3)', () => {
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'x',
                { maxTurns: 1 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            const [, argv] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(argv).not.toContain('--max-turns');
            expect(argv).not.toContain('--fallback-model');
        });

        // #393 (блокер фазы 6): claude-имя без тега провайдера (сессии сдачи/ревью/heal,
        // либо кодер-итерация на config.model) НЕ должно уехать `codex -m claude-opus-4-8` —
        // рантайм обязан отбросить его и взять openaiRuntime.model.
        it('#393: claude-имя opts.model БЕЗ modelProvider отбрасывается → argv берёт openaiRuntime.model', () => {
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'сессия сдачи',
                { model: 'claude-opus-4-8', maxTurns: 5 },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            const [, argv] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5-codex');
            expect(argv.join(' ')).not.toContain('claude-opus-4-8');
        });

        // #393: модель ИЗ МАРШРУТА с тегом modelProvider:'openai' — применяется.
        it('#393: opts.model с modelProvider:"openai" применяется (модель маршрута OpenAI)', () => {
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'кодер-итерация',
                { model: 'gpt-5-codex-mini', maxTurns: 5, modelProvider: 'openai' },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            const [, argv] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5-codex-mini');
        });

        // #393: чужой тег (kimi) к codex-рантайму модель не пускает.
        it('#393: opts.model с чужим modelProvider:"kimi" отбрасывается codex-рантаймом', () => {
            const spawnFn = vi.fn<SpawnFake>((_bin, args) =>
                Array.isArray(args) && args.includes('status')
                    ? {
                          status: 0,
                          stdout: 'Logged in using an API key',
                          stderr: '',
                          signal: null,
                      }
                    : { status: 0, stdout: 'ok', stderr: '', signal: null },
            );
            runtime.runOpenAIOnce(
                'x',
                { model: 'kimi-k2-0711-preview', maxTurns: 5, modelProvider: 'kimi' },
                spawnFn as unknown as SpawnSyncFn,
                undefined,
                VERSION_UNREAD,
                NO_CODEX_GUARD,
            );
            const [, argv] = spawnFn.mock.calls[spawnFn.mock.calls.length - 1];
            expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5-codex');
            expect(argv.join(' ')).not.toContain('kimi-k2-0711-preview');
        });
    });
});

// #373/#374 (фаза 6): выбор coderRuntime через config.adapters собирает нужный адаптер из
// реестра. Тесты про buildAdapters/resolveAdapterSelection — отдельным блоком (не внутри
// runKimiOnce/runOpenAIOnce-смоуков): к спавну кодер-сессии они не относятся и не должны
// наследовать его beforeEach со спаями/env.
describe('buildAdapters — выбор coderRuntime из config.adapters (#373/#374)', () => {
    const throwingFail = (msg: string) => {
        throw new Error(msg);
    };
    // Реестр-заглушка: реальны только coderRuntime.run (их output и сторожит тест), прочие
    // швы — сентинелы { x: 1 }, к выбору coderRuntime не относятся. `as unknown as` — цена
    // намеренно частичного фейка (полный реестр строит adapters-impl.test.ts).
    const caps = { turnLimit: 'best-effort', fallbackModel: false };
    const fakeRegistries = () =>
        ({
            taskSource: { github: { x: 1 } },
            gate: { npm: { x: 1 } },
            notifier: { telegram: { x: 1 } },
            deployCheck: { 'github-actions': { x: 1 } },
            // #118: реестр без объявленных возможностей не собирается — объявление
            // есть и у заглушки.
            coderRuntime: {
                claude: { run: () => ({ code: 0, output: 'claude' }), capabilities: caps },
                kimi: { run: () => ({ code: 0, output: 'kimi' }), capabilities: caps },
                openai: { run: () => ({ code: 0, output: 'openai' }), capabilities: caps },
            },
        }) as unknown as AdapterRegistries;

    it('coderRuntime:kimi в конфиге даёт Kimi-адаптер из реестра', () => {
        const runtime = buildRuntime();
        const adapters = runtime.buildAdapters(
            fakeRegistries(),
            runtime.resolveAdapterSelection({ coderRuntime: 'kimi' }, throwingFail),
            throwingFail,
        );
        expect(adapters.coderRuntime.run('p', { maxTurns: 1 }).output).toBe('kimi');
    });

    it('coderRuntime:openai в конфиге даёт OpenAI-адаптер из реестра', () => {
        const runtime = buildRuntime();
        const adapters = runtime.buildAdapters(
            fakeRegistries(),
            runtime.resolveAdapterSelection({ coderRuntime: 'openai' }, throwingFail),
            throwingFail,
        );
        expect(adapters.coderRuntime.run('p', { maxTurns: 1 }).output).toBe('openai');
    });
});

// #376 (фаза 6): provider-aware modelRouting — label сложности может вести на модель
// ЛЮБОГО зарегистрированного провайдера (не только claude), а не только на имя claude-
// модели. resolveModelRoute — чистая нормализация записи; pickModel/pickRuntime — две
// ортогональные оси роутинга (research: `docs/ralph-mini-framework/research.md`).
describe('resolveModelRoute — нормализация записи modelRouting (#376)', () => {
    const { resolveModelRoute } = ralph;

    it('строка → {provider: fallback, model: строка}', () => {
        expect(resolveModelRoute('claude-opus-4-8', 'claude')).toEqual({
            provider: 'claude',
            model: 'claude-opus-4-8',
        });
    });

    it('пустая/пробельная строка → null', () => {
        expect(resolveModelRoute('   ', 'claude')).toBe(null);
        expect(resolveModelRoute('', 'claude')).toBe(null);
    });

    it('undefined → null (запись не задана)', () => {
        expect(resolveModelRoute(undefined, 'claude')).toBe(null);
    });

    it('объект с provider → {provider, model} из объекта, fallback игнорируется', () => {
        expect(
            resolveModelRoute({ provider: 'kimi', model: 'kimi-k2-0711-preview' }, 'claude'),
        ).toEqual({
            provider: 'kimi',
            model: 'kimi-k2-0711-preview',
        });
    });

    it('объект без provider → берёт fallback-провайдер, свой model', () => {
        expect(resolveModelRoute({ model: 'claude-fable-5' }, 'openai')).toEqual({
            provider: 'openai',
            model: 'claude-fable-5',
        });
    });

    it('объект без валидного model → model: undefined (провайдер всё равно резолвится)', () => {
        expect(resolveModelRoute({ provider: 'kimi' }, 'claude')).toEqual({
            provider: 'kimi',
            model: undefined,
        });
    });
});

describe('pickModel/pickRuntime — provider-aware роутинг по label issue (#376)', () => {
    // Фикстура: НОВЫЙ orchestrator (createOrchestrator напрямую, как в блоках Kimi/OpenAI
    // выше) — pickModel/pickRuntime читают ФАБРИЧНЫЙ config (setConfigForTests), не делят
    // состояние с REAL_CONFIG общего singleton'а `ralph`.
    function routingRuntime(modelRouting: unknown) {
        const runtime = buildRuntime();
        runtime.setConfigForTests({ ...REAL_CONFIG, modelRouting });
        return runtime;
    }
    const issueWithLabels = (labels: string[]) => ({
        number: 1,
        title: 't',
        labels: labels.map((name: string) => ({ name })),
    });

    it('label с объектной записью {provider, model} — pickModel/pickRuntime читают именно её', () => {
        const runtime = routingRuntime({
            labels: { 'complexity:low': { provider: 'kimi', model: 'kimi-k2-0711-preview' } },
        });
        const issue = issueWithLabels(['complexity:low']);
        expect(runtime.pickModel(issue)).toBe('kimi-k2-0711-preview');
        expect(runtime.pickRuntime(issue)).toBe('kimi');
    });

    it('label — голая строка (обратная совместимость): модель как раньше, провайдер — статический дефолт', () => {
        const runtime = routingRuntime({
            labels: { 'complexity:low': 'claude-haiku-4-5-20251001' },
        });
        const issue = issueWithLabels(['complexity:low']);
        expect(runtime.pickModel(issue)).toBe('claude-haiku-4-5-20251001');
        expect(runtime.pickRuntime(issue)).toBe('claude');
    });

    it('label задан, но не совпадает ни с одним issue — берёт default (объектная запись)', () => {
        const runtime = routingRuntime({
            labels: { 'complexity:expert': 'claude-fable-5' },
            default: { provider: 'openai', model: 'gpt-5-codex' },
        });
        const issue = issueWithLabels(['complexity:medium']);
        expect(runtime.pickModel(issue)).toBe('gpt-5-codex');
        expect(runtime.pickRuntime(issue)).toBe('openai');
    });

    it('modelRouting не задан вовсе → pickModel = config.model, pickRuntime = дефолтный провайдер', () => {
        const runtime = buildRuntime();
        runtime.setConfigForTests({
            ...REAL_CONFIG,
            modelRouting: undefined,
            model: 'claude-sonnet-5',
        });
        const issue = issueWithLabels([]);
        expect(runtime.pickModel(issue)).toBe('claude-sonnet-5');
        expect(runtime.pickRuntime(issue)).toBe('claude');
    });
});

// #410: барьер на [ЧЕЛОВЕК]-issues. excludeHumanIssues — чистая функция: применяется И к
// рабочей очереди (openIssues), И к проверке сдачи (allOpenIssues), поэтому тестируется
// напрямую. isHumanIssue — предикат метки.
describe('excludeHumanIssues / isHumanIssue — барьер на [ЧЕЛОВЕК]-issues (#410)', () => {
    const { excludeHumanIssues, isHumanIssue } = ralph;
    const issue = (number: number, labels: string[]) => ({
        number,
        title: `задача ${number}`,
        labels: labels.map((name: string) => ({ name })),
        author: { login: 'owner' },
    });
    // Тестовый failFn БРОСАЕТ (боевой fail = process.exit убил бы vitest-процесс) — тот же
    // приём инъекции, что у resolveKimiRuntime/resolveAdapterSelection.
    const throwingFail = (msg: string) => {
        throw new Error(msg);
    };

    it('isHumanIssue: true только при метке human', () => {
        expect(isHumanIssue(issue(1, ['human']))).toBe(true);
        expect(isHumanIssue(issue(2, ['area:devops']))).toBe(false);
        expect(isHumanIssue(issue(3, []))).toBe(false);
        // без поля labels вовсе — не падает
        expect(isHumanIssue({ number: 4, title: 't' })).toBe(false);
    });

    it('milestone из human-issue и обычной → в наборе остаётся только обычная', () => {
        const kept = excludeHumanIssues(
            [issue(10, ['human']), issue(11, ['complexity:medium'])],
            throwingFail,
        );
        expect(kept.map((i: { number: number }) => i.number)).toEqual([11]);
    });

    it('человеческий хвост не блокирует сдачу: набор из одних human-issue → пустой (allOpenIssues → [])', () => {
        // #10: фильтр применяется к обеим очередям ШВА (withHumanFilter), а не внутри
        // GitHub-функций — здесь проверяется только сама функция. Если открыты ТОЛЬКО
        // human-карточки, сдача фазы видит пустоту и не встаёт намертво (осознанное
        // отступление от C2). Что фильтр действительно ПРИМЕНЁН — сторожит отдельный
        // барьер в tests/false-stop-scenarios.test.ts: его удаление отсюда не покрасило
        // бы ни одного теста этого файла.
        const kept = excludeHumanIssues([issue(20, ['human']), issue(21, ['human'])], throwingFail);
        expect(kept).toEqual([]);
    });

    it('fail-closed: карточка И с human, И с complexity:* → failFn с внятным сообщением', () => {
        expect(() =>
            excludeHumanIssues([issue(30, ['human', 'complexity:high'])], throwingFail),
        ).toThrow(/#30.*human.*complexity:high/s);
    });

    it('fail-closed срабатывает ДО фильтрации (конфликтная карточка не «проскочит» молча)', () => {
        // Конфликт в наборе вместе с валидными — failFn всё равно бросает, набор не возвращается.
        expect(() =>
            excludeHumanIssues(
                [issue(40, ['complexity:low']), issue(41, ['human', 'complexity:expert'])],
                throwingFail,
            ),
        ).toThrow(/#41/);
    });

    it('обычные complexity:*-карточки без human — не конфликт, проходят как есть', () => {
        const kept = excludeHumanIssues(
            [issue(50, ['complexity:high']), issue(51, ['complexity:low'])],
            throwingFail,
        );
        expect(kept.map((i: { number: number }) => i.number)).toEqual([50, 51]);
    });
});

// #376 доп.скоуп: кросс-провайдерный фолбэк при API-лимите — «сначала фолбэк, потом
// ожидание». Существующие тесты в describe('runClaude — 4-е событие...') без
// modelRouting.apiLimitFallback остаются зелёными без изменений (проверено выше) — эта
// ветка выполняется, только если фолбэк явно сконфигурирован.
describe('runClaude — #376 доп.скоуп: кросс-провайдерный фолбэк при API-лимите', () => {
    const { runClaude } = ralph;

    it('лимит основного рантайма → один пробный запуск другим провайдером ДО ожидания; успех — sleep/pushEvent не зовутся', () => {
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const fallbackRun = vi.fn<RunClaudeFake>(() => ({ code: 0, output: 'diff from kimi' }));
        const coderRuntimeRunForFn = vi.fn((provider) => {
            expect(provider).toBe('kimi');
            return fallbackRun;
        });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            { model: 'claude-opus-4-8', maxTurns: 5 },
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn,
                cfg: {
                    apiLimitMaxWaits: 3,
                    modelRouting: {
                        apiLimitFallback: { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                    },
                },
            },
        );

        expect(code).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(fallbackRun).toHaveBeenCalledTimes(1);
        // #393: запись apiLimitFallback дала свою модель ⇒ помечена провайдером фолбэка
        // (modelProvider:'kimi'), иначе не-Claude рантайм фолбэка отбросил бы её как чужую.
        expect(fallbackRun.mock.calls[0][1]).toEqual({
            model: 'kimi-k2-0711-preview',
            maxTurns: 5,
            modelProvider: 'kimi',
        });
        expect(pushEventFn).not.toHaveBeenCalled();
        expect(sleepFn).not.toHaveBeenCalled();
    });

    it('успешный фолбэк идёт через settledCode: код 0 с исходом unknown — не успех', () => {
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const fallbackRun = vi.fn<RunClaudeFake>(() => ({
            code: 0,
            output: 'ok',
            endReason: 'unknown',
        }));
        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn: vi.fn(),
                sleepFn: vi.fn(),
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn: vi.fn(() => fallbackRun),
                cfg: { modelRouting: { apiLimitFallback: { provider: 'kimi', model: 'x' } } },
            },
        );
        expect(code).toBe(1);
        expect(fallbackRun).toHaveBeenCalledTimes(1);
    });

    it('фолбэк тоже упёрся в лимит → переходим к обычному ожиданию основного рантайма (фолбэк пробуется РОВНО раз за вызов)', () => {
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const fallbackRun = vi.fn<RunClaudeFake>(() => ({
            code: 1,
            output: 'session limit resets 11am',
        }));
        const coderRuntimeRunForFn = vi.fn(() => fallbackRun);
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn,
                cfg: {
                    apiLimitMaxWaits: 1,
                    modelRouting: { apiLimitFallback: { provider: 'kimi', model: 'x' } },
                },
            },
        );

        expect(code).toBe(1);
        expect(fallbackRun).toHaveBeenCalledTimes(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(2);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledTimes(1);
    });

    it('фолбэк упал НЕ по лимиту (бинарь не установлен / ключ невалиден / misconfig) → к ожиданию, чужой ненулевой код НЕ отдаётся как итог', () => {
        // Регрессия ревью-thread: раньше `if (!fbLimitHit) return fb.code` отдавал ЛЮБОЙ
        // ненулевой код фолбэка (127 = codex не найден) как итог итерации, отменяя цикл
        // ожидания. API_LIMIT_RE матчит лишь формулировку Claude → лимит Kimi/OpenAI под
        // неё не подходит, и «фолбэк тоже упёрся в лимит» для них недостижимо. Теперь любой
        // ненулевой код фолбэка → штатное ожидание основного провайдера.
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const fallbackRun = vi.fn<RunClaudeFake>(() => ({
            code: 127,
            output: 'codex: command not found',
        }));
        const coderRuntimeRunForFn = vi.fn(() => fallbackRun);
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn,
                cfg: {
                    apiLimitMaxWaits: 1,
                    modelRouting: { apiLimitFallback: { provider: 'kimi', model: 'x' } },
                },
            },
        );

        // Итог — код ОСНОВНОГО провайдера (1, лимит), не 127 фолбэка; ожидание отработало.
        expect(code).toBe(1);
        expect(fallbackRun).toHaveBeenCalledTimes(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(2);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledTimes(1);
    });

    it('apiLimitFallback пробуется ДАЖЕ при waitOnApiLimit:false (фолбэк — «вместо ожидания», не часть его); успех завершает', () => {
        // Ревью-thread: return по waitOnApiLimit===false раньше срабатывал ДО фолбэк-ветки.
        // Оператор, выключивший ожидание, всё ещё может хотеть кросс-провайдерную попытку.
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const fallbackRun = vi.fn<RunClaudeFake>(() => ({ code: 0, output: 'diff from kimi' }));
        const coderRuntimeRunForFn = vi.fn(() => fallbackRun);
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn: vi.fn(),
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn,
                cfg: {
                    waitOnApiLimit: false,
                    modelRouting: { apiLimitFallback: { provider: 'kimi', model: 'x' } },
                },
            },
        );

        expect(code).toBe(0);
        expect(fallbackRun).toHaveBeenCalledTimes(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
    });

    it('фолбэк не помог + waitOnApiLimit:false → честно возвращаем код лимита, без ожидания', () => {
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const fallbackRun = vi.fn<RunClaudeFake>(() => ({ code: 127, output: 'codex not found' }));
        const coderRuntimeRunForFn = vi.fn(() => fallbackRun);
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn: vi.fn(),
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn,
                cfg: {
                    waitOnApiLimit: false,
                    modelRouting: { apiLimitFallback: { provider: 'kimi', model: 'x' } },
                },
            },
        );

        expect(code).toBe(1);
        expect(fallbackRun).toHaveBeenCalledTimes(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
    });

    it('apiLimitFallback без явного provider (голая строка = тот же провайдер) не пробуется — сразу обычное ожидание', () => {
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const coderRuntimeRunForFn = vi.fn();
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn,
                cfg: {
                    apiLimitMaxWaits: 1,
                    modelRouting: { apiLimitFallback: 'claude-opus-4-8' },
                },
            },
        );

        expect(coderRuntimeRunForFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
    });

    it('apiLimitFallback не задан → ветка не выполняется (дефолт, поведение прежнее)', () => {
        const runClaudeOnceFn = vi.fn(() => claudeRun(1, 'session limit resets 11am'));
        const coderRuntimeRunForFn = vi.fn();

        runClaude(
            'промпт',
            {},
            {
                pushEventFn: vi.fn(),
                sleepFn: vi.fn(),
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn,
                cfg: { apiLimitMaxWaits: 1 },
            },
        );

        expect(coderRuntimeRunForFn).not.toHaveBeenCalled();
    });
});

describe('formatExcerpt — хвост вывода упавшего чека для heal-промпта', () => {
    it('сплющивает переводы строк, табы и повторные пробелы в один пробел', () => {
        expect(formatExcerpt('a\n\nb\t\tc   d')).toBe('a b c d');
    });

    it('обрезает до последних 600 символов', () => {
        const long = 'X'.repeat(1000);
        const out = formatExcerpt(long);
        expect(out).toHaveLength(600);
        expect(out).toBe('X'.repeat(600));
    });

    it('короткую строку без лишних пробелов возвращает как есть', () => {
        expect(formatExcerpt('FAIL: boom')).toBe('FAIL: boom');
    });

    it('anti-regression: спецсимволы вывода СОХРАНЯЮТСЯ дословно (санитизация под shell удалена)', () => {
        // Раньше excerpt чистился под shell-guard; теперь промпт уходит argv-массивом,
        // и backtick/$/кавычки должны дойти до heal-агента как есть — без потери контекста ошибки.
        const raw = 'Error in `foo()`: $undefined and "quoted" — code 1';
        const out = formatExcerpt(raw);
        expect(out).toContain('`foo()`');
        expect(out).toContain('$undefined');
        expect(out).toContain('"quoted"');
    });
});

describe('pushEvent — доставка событий в Telegram, prod-only (#86)', () => {
    it('лог-маркер печатается ВСЕГДА, независимо от профиля', () => {
        const logFn = vi.fn();
        const sendFn = vi.fn();
        pushEvent('событие', { profileName: 'playground' }, { sendFn, logFn });
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('событие'));
    });

    it('playground (или профиль не задан) — sendFn НЕ зовётся, событие не улетает', () => {
        const sendFn = vi.fn();
        const logFn = vi.fn();
        expect(pushEvent('релиз готов', { profileName: 'playground' }, { sendFn, logFn })).toBe(
            false,
        );
        expect(pushEvent('релиз готов', {}, { sendFn, logFn })).toBe(false);
        // cfg=undefined фиксирует именно поведение при СРАБОТКЕ дефолта `cfg = config`:
        // config заполняется в main(), а не при require, поэтому на момент вызова он
        // undefined → профиля нет → событие не улетает. Кейс `{}` выше уже покрывает
        // «профиль задан пустым»; этот — отдельно страхует, что дефолт-ветка молчит,
        // а не подхватывает боевой profileName, если config когда-нибудь станет
        // top-level.
        expect(pushEvent('релиз готов', undefined, { sendFn, logFn })).toBe(false);
        expect(sendFn).not.toHaveBeenCalled();
    });

    it('prod — sendFn зовётся с текстом сообщения, результат прокидывается наружу', () => {
        const sendFn = vi.fn().mockReturnValue(true);
        const logFn = vi.fn();
        const result = pushEvent(
            'фаза готова к релизу',
            { profileName: 'prod' },
            { sendFn, logFn },
        );
        expect(result).toBe(true);
        expect(sendFn).toHaveBeenCalledTimes(1);
        expect(sendFn.mock.calls[0][0]).toBe('фаза готова к релизу');
    });

    it('prod, но доставка не удалась (fail-open sendFn=false) — pushEvent тоже false, не бросает', () => {
        const sendFn = vi.fn().mockReturnValue(false);
        expect(() =>
            pushEvent('событие', { profileName: 'prod' }, { sendFn, logFn: vi.fn() }),
        ).not.toThrow();
        expect(pushEvent('событие', { profileName: 'prod' }, { sendFn, logFn: vi.fn() })).toBe(
            false,
        );
    });

    it('#224: текст события остаётся в логе даже когда доставка (все ретраи нотифаера) провалилась', () => {
        // 🔔 PUSH печатается ПЕРВОЙ строкой pushEvent, до вызова sendFn — недоставка
        // (в т.ч. исчерпание ретраев telegram-notifier) не должна стирать событие
        // из ralph.log, иначе разбор постфактум не находит, что вообще произошло.
        const sendFn = vi.fn().mockReturnValue(false);
        const logFn = vi.fn();
        pushEvent(
            'громкое событие, которое нельзя потерять',
            { profileName: 'prod' },
            {
                sendFn,
                logFn,
            },
        );
        expect(
            logFn.mock.calls.some(([msg]) =>
                msg.includes('громкое событие, которое нельзя потерять'),
            ),
        ).toBe(true);
    });

    it('prod, но dry=true (--dry-run) — лог-маркер есть, но sendFn НЕ зовётся, false (C1: read-only)', () => {
        // Регрессия: breaker maxIterations проверяется до первого dry-guard'а в loop,
        // так что pushEvent достижим в --dry-run. Guard в самой точке доставки (как
        // saveState) обязан молчать даже в боевом профиле.
        const sendFn = vi.fn();
        const logFn = vi.fn();
        expect(pushEvent('событие', { profileName: 'prod' }, { sendFn, logFn, dry: true })).toBe(
            false,
        );
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('событие'));
        expect(sendFn).not.toHaveBeenCalled();
    });

    it('интеграционный шов: дефолтный sendFn (реальный нотифаер) зовёт curl через прокинутый execFn', () => {
        // Без мока sendFn — проверяем, что pushEvent реально дёргает sendTelegramMessage,
        // а тот вызывает curl. execFn пробрасывается насквозь (без сети/токена).
        const execFn = vi.fn().mockReturnValue(JSON.stringify({ ok: true }));
        const logFn = vi.fn();
        const saved = { ...process.env };
        process.env.RALPH_TG_BOT_TOKEN = '123:test';
        process.env.RALPH_TG_CHAT_ID = '42';
        try {
            const result = pushEvent(
                'фаза готова к релизу',
                { profileName: 'prod' },
                { logFn, execFn },
            );
            expect(result).toBe(true);
            expect(execFn).toHaveBeenCalledTimes(1);
            expect(execFn.mock.calls[0][0]).toBe('curl');
        } finally {
            process.env = saved;
        }
    });
});

// Задача 96: ротация ключей подписки. Кольцо подменяется параметром (keyRing) — боевое
// читает env и файл ротации, тест держит «файл» в памяти и проверяет, что в него легло.
describe('runClaude — ротация ключей подписки (задача 96)', () => {
    const { runClaude } = ralph;
    const KEYS = ['key-one-secret-96', 'key-two-secret-96', 'key-three-secret-96'];
    const MIN = 60_000;

    function ring(initial: unknown = null) {
        const saved: string[] = [];
        let disk = initial;
        return {
            saved,
            ring: {
                keys: KEYS,
                load: () => (disk as never) ?? { keyCount: KEYS.length, active: 0, exhausted: {} },
                save: (rot: unknown) => {
                    disk = rot;
                    saved.push(JSON.stringify(rot));
                },
            },
        };
    }

    it('лимит на ключе 1 → сессия сразу на ключе 2, ожидание не потрачено', () => {
        const runClaudeOnceFn = vi
            .fn<RunClaudeFake>()
            .mockReturnValueOnce(claudeRun(1, "You've hit your session limit · resets 11am"))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();
        const { ring: keyRing } = ring();

        const code = runClaude(
            'промпт',
            { maxTurns: 5 },
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                keyRing,
                nowFn: () => 0,
                cfg: { apiLimitMaxWaits: 1 },
            },
        );

        expect(code).toBe(0);
        expect(runClaudeOnceFn.mock.calls.map((c) => c[1].authToken)).toEqual([KEYS[0], KEYS[1]]);
        expect(sleepFn).not.toHaveBeenCalled();
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('ротация не тратит счётчик ожиданий: при apiLimitMaxWaits=1 после круга ключей ещё есть сон', () => {
        const runClaudeOnceFn = vi
            .fn<RunClaudeFake>()
            .mockReturnValueOnce(claudeRun(1, 'session limit resets 11am'))
            .mockReturnValueOnce(claudeRun(1, 'session limit resets 11am'))
            .mockReturnValueOnce(claudeRun(1, 'session limit resets 11am'))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const sleepFn = vi.fn();
        const { ring: keyRing } = ring();

        const code = runClaude(
            'промпт',
            { maxTurns: 5 },
            {
                pushEventFn: vi.fn(),
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                keyRing,
                nowFn: () => 0,
                cfg: { apiLimitMaxWaits: 1 },
            },
        );

        expect(code).toBe(0);
        expect(sleepFn).toHaveBeenCalledTimes(1);
    });

    it('кросс-провайдерный фолбэк — только когда упёрлись все ключи', () => {
        const runClaudeOnceFn = vi
            .fn<RunClaudeFake>()
            .mockReturnValueOnce(claudeRun(1, 'session limit resets 11am'))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const fallbackRun = vi.fn<RunClaudeFake>(() => ({ code: 0, output: 'kimi' }));
        const { ring: keyRing } = ring();

        runClaude(
            'промпт',
            { maxTurns: 5 },
            {
                pushEventFn: vi.fn(),
                sleepFn: vi.fn(),
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                coderRuntimeRunForFn: () => fallbackRun,
                keyRing,
                nowFn: () => 0,
                cfg: { modelRouting: { apiLimitFallback: { provider: 'kimi', model: 'k' } } },
            },
        );

        expect(fallbackRun).not.toHaveBeenCalled();
    });

    it('все ключи упёрлись → сон до БЛИЖАЙШЕГО сброса, пуш «все ключи», затем ключ этого сброса', () => {
        // Ключ 1 сбросится через 180 мин, ключ 2 — через 60, ключ 3 — через 120: ждать
        // надо 60 минут и идти на ключе 2, а не 180 до сброса первого по порядку.
        const runClaudeOnceFn = vi
            .fn<RunClaudeFake>()
            .mockReturnValueOnce(claudeRun(1, 'session limit, try later'))
            .mockReturnValueOnce(claudeRun(1, 'session limit, try later'))
            .mockReturnValueOnce(claudeRun(1, 'session limit, try later'))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const waits = [180, 60, 120];
        let hit = 0;
        const cfgFor = () => ({
            apiLimitMaxWaits: 3,
            apiLimitGraceMin: 0,
            get apiLimitFallbackWaitMin() {
                return waits[hit++];
            },
        });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();
        const { ring: keyRing } = ring();

        const code = runClaude(
            'промпт',
            { maxTurns: 5 },
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                keyRing,
                nowFn: () => 0,
                cfg: cfgFor(),
            },
        );

        expect(code).toBe(0);
        expect(sleepFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledWith(60 * MIN);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/все ключи подписки \(3\) упёрлись/);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/Жду 60 мин/);
        expect(runClaudeOnceFn.mock.calls.map((c) => c[1].authToken)).toEqual([
            KEYS[0],
            KEYS[1],
            KEYS[2],
            KEYS[1],
        ]);
    });

    it('рестарт не начинает с сожжённого ключа; значений ключей нет ни в логе, ни в пуше, ни в файле ротации', () => {
        // Файл ротации от прошлого процесса: активным остался ключ 1, и он ещё не сбросился.
        const runClaudeOnceFn = vi
            .fn<RunClaudeFake>()
            .mockReturnValueOnce(claudeRun(1, 'session limit resets 11am'))
            .mockReturnValueOnce(claudeRun(1, 'session limit resets 11am'))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const pushes: string[] = [];
        const logged: string[] = [];
        const logSpy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
            logged.push(String(m));
        });
        const { ring: keyRing, saved } = ring({
            keyCount: 3,
            active: 0,
            exhausted: { 0: 1000 * MIN },
        });

        try {
            runClaude(
                'промпт',
                { maxTurns: 5 },
                {
                    pushEventFn: (m: string) => {
                        pushes.push(m);
                        return true;
                    },
                    sleepFn: vi.fn(),
                    ensureTunnelFn: () => true,
                    runClaudeOnceFn,
                    keyRing,
                    nowFn: () => 0,
                    cfg: { apiLimitMaxWaits: 1, apiLimitGraceMin: 0 },
                },
            );
        } finally {
            logSpy.mockRestore();
        }

        expect(runClaudeOnceFn.mock.calls[0][1].authToken).toBe(KEYS[1]);
        expect(saved.length).toBeGreaterThan(0);
        const everything = [...saved, ...pushes, ...logged].join('\n');
        for (const k of KEYS) expect(everything).not.toContain(k);
        // Строка ротации при этом в логе есть — она называет номера.
        expect(logged.join('\n')).toMatch(/ключе подписки 2\/3 — сессия сразу на ключе 3\/3/);
    });

    it('env сессии под ротацией: свой ключ в переменной CLI, списка нет; без ротации env наследуется', () => {
        const { claudeSessionEnv } = ralph;
        const env = claudeSessionEnv('key-two', {
            PATH: '/usr/bin',
            CLAUDE_CODE_OAUTH_TOKEN: 'key-one',
            RALPH_CLAUDE_OAUTH_TOKENS: 'key-one,key-two',
        });
        expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'key-two' });
        expect(claudeSessionEnv(undefined, { PATH: '/usr/bin' })).toBeUndefined();
    });

    it('кольцо решает рантайм вызова: claude — да, kimi при тех же двух ключах — нет', () => {
        const { subscriptionKeyRing, adapterRegistries } = ralph;
        const env = { RALPH_CLAUDE_OAUTH_TOKENS: 'key-one,key-two' };
        expect(subscriptionKeyRing(adapterRegistries.coderRuntime.claude.run, env)?.keys).toEqual([
            'key-one',
            'key-two',
        ]);
        expect(subscriptionKeyRing(adapterRegistries.coderRuntime.kimi.run, env)).toBeNull();
        expect(subscriptionKeyRing(vi.fn<RunClaudeFake>(), env)).toBeNull();
    });

    it('маршрут на kimi + лимит Moonshot → ключи подписки не тронуты, сессия ждёт, а не ротирует', () => {
        // Два ключа в env хоста: боевое кольцо, построенное по ошибке, полезло бы в файл
        // ротации — предохранитель побочек покраснил бы тест, а authToken лёг бы в опции.
        vi.stubEnv('RALPH_CLAUDE_OAUTH_TOKENS', 'key-one,key-two');
        try {
            const runClaudeOnceFn = vi
                .fn<RunClaudeFake>()
                .mockReturnValueOnce(claudeRun(1, '429 rate limit exceeded'))
                .mockReturnValueOnce({ code: 0, output: 'ok' });
            const sleepFn = vi.fn();
            const code = runClaude(
                'промпт',
                { maxTurns: 5 },
                {
                    pushEventFn: vi.fn(),
                    sleepFn,
                    ensureTunnelFn: () => true,
                    runClaudeOnceFn,
                    cfg: { apiLimitMaxWaits: 1, apiLimitGraceMin: 0 },
                },
            );
            expect(code).toBe(0);
            expect(sleepFn).toHaveBeenCalledTimes(1);
            for (const c of runClaudeOnceFn.mock.calls)
                expect(c[1]).not.toHaveProperty('authToken');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('кольца нет (один ключ) — authToken в опции не появляется, путь прежний', () => {
        const runClaudeOnceFn = vi.fn<RunClaudeFake>(() => ({ code: 0, output: 'ok' }));
        runClaude(
            'промпт',
            { maxTurns: 5 },
            { ensureTunnelFn: () => true, runClaudeOnceFn, keyRing: null },
        );
        expect(runClaudeOnceFn.mock.calls[0][1]).toEqual({ maxTurns: 5 });
    });
});

// Фаза 16 (#112): ядро решает о повторе только по исходу, названному адаптером. Тексты
// ниже нарочно расходятся с исходами: решение обязано идти за исходом, а не за словами.
describe('runClaude — решение по SessionEndReason, а не по тексту вывода', () => {
    const { runClaude } = ralph;
    const deps = (runClaudeOnceFn: unknown, extra: Record<string, unknown> = {}) => ({
        pushEventFn: vi.fn(),
        sleepFn: vi.fn(),
        ensureTunnelFn: () => true,
        runClaudeOnceFn,
        keyRing: null,
        cfg: { apiLimitMaxWaits: 3, apiLimitGraceMin: 0 },
        ...extra,
    });

    it('исход api-limit без единого слова о лимите — ожидание и повтор', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce({
                code: 1,
                output: 'что угодно',
                endReason: 'api-limit',
                retryAfterMs: 60_000,
            })
            .mockReturnValueOnce({ code: 0, output: 'ok', endReason: 'completed' });
        const d = deps(runClaudeOnceFn);
        expect(runClaude('промпт', {}, d)).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(2);
        // Время до сброса — от адаптера, а не из текста.
        expect(d.sleepFn).toHaveBeenCalledWith(60_000);
    });

    it('текст лимита при исходе unknown — НЕ лимит: ни ожидания, ни повтора', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue({
            code: 1,
            output: "You've hit your session limit · resets 11am",
            endReason: 'unknown',
        });
        const d = deps(runClaudeOnceFn);
        expect(runClaude('промпт', {}, d)).toBe(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(d.sleepFn).not.toHaveBeenCalled();
    });

    it('исход без endReason у реализации шва: текст лимита не читается', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValue({ code: 1, output: "You've hit your session limit" });
        const d = deps(runClaudeOnceFn);
        expect(runClaude('промпт', {}, d)).toBe(1);
        expect(d.sleepFn).not.toHaveBeenCalled();
    });

    it('interrupted при коде 0 — успех по коду без повтора, но строкой в логе', () => {
        const logSpy = vi.spyOn(console, 'log');
        try {
            const runClaudeOnceFn = vi.fn().mockReturnValue({
                code: 0,
                output: 'No upstream account is currently available',
                endReason: 'interrupted',
            });
            const d = deps(runClaudeOnceFn);
            expect(runClaude('промпт', {}, d)).toBe(0);
            expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
            expect(d.sleepFn).not.toHaveBeenCalled();
            const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(logged).toMatch(/исход обрывом \(interrupted\).*только у ревью/);
        } finally {
            logSpy.mockRestore();
        }
    });

    it('неопознанный исход — «прочее» с логом и не успех, даже при коде 0', () => {
        const logSpy = vi.spyOn(console, 'log');
        try {
            const runClaudeOnceFn = vi
                .fn()
                .mockReturnValue({ code: 0, output: 'ok', endReason: 'unknown' });
            expect(runClaude('промпт', {}, deps(runClaudeOnceFn))).toBe(1);
            const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(logged).toMatch(/Исход сессии не опознан.*«прочее», не успех/);
        } finally {
            logSpy.mockRestore();
        }
    });

    it('auth — без ожидания и повтора, причина в логе', () => {
        const logSpy = vi.spyOn(console, 'log');
        try {
            const runClaudeOnceFn = vi
                .fn()
                .mockReturnValue({ code: 1, output: 'usage limit', endReason: 'auth' });
            const d = deps(runClaudeOnceFn);
            expect(runClaude('промпт', {}, d)).toBe(1);
            expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
            expect(d.sleepFn).not.toHaveBeenCalled();
            const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(logged).toMatch(/отверг авторизацию/);
        } finally {
            logSpy.mockRestore();
        }
    });

    it('исход последнего запуска уходит вызывающему вторым аргументом onOutput', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue({
            code: 1,
            output: 'x',
            endReason: 'turn-limit',
        });
        const onOutput = vi.fn();
        runClaude('промпт', {}, deps(runClaudeOnceFn, { onOutput }));
        expect(onOutput).toHaveBeenCalledWith('x', 'turn-limit');
    });

    it('timeout и interrupted при ненулевом коде — без повтора в runClaude', () => {
        for (const endReason of ['timeout', 'interrupted']) {
            const runClaudeOnceFn = vi.fn().mockReturnValue({ code: 1, output: '', endReason });
            const d = deps(runClaudeOnceFn);
            expect(runClaude('промпт', {}, d)).toBe(1);
            expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
            expect(d.sleepFn).not.toHaveBeenCalled();
        }
    });
});

describe('runClaude — 4-е событие (#88): API-лимит пушит уведомление и повторяет попытку', () => {
    const { runClaude } = ralph;

    it('маркер лимита в выводе → pushEventFn с текстом попытки/ожидания, sleepFn ждёт, повтор runClaudeOnceFn', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce(claudeRun(1, "You've hit your session limit · resets 11am"))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();
        const ensureTunnelFn = vi.fn(() => true);
        const cfg = { apiLimitMaxWaits: 3, apiLimitGraceMin: 0 };

        const code = runClaude(
            'промпт',
            { model: 'sonnet' },
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn,
                runClaudeOnceFn,
                cfg,
            },
        );

        expect(code).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(2);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        // Форматирование сообщения: попытка (N/maxWaits) и время ожидания читаемы без консоли.
        expect(pushEventFn.mock.calls[0][0]).toMatch(/API-лимит/);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/попытка 1\/3/);
        expect(pushEventFn.mock.calls[0][1]).toBe(cfg);
        expect(sleepFn).toHaveBeenCalledTimes(1);
    });

    it('без маркера лимита (обычный сбой) — pushEventFn не зовётся, повтора нет', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue({ code: 1, output: 'просто упало' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { apiLimitMaxWaits: 3 },
            },
        );

        expect(code).toBe(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn).not.toHaveBeenCalled();
        expect(sleepFn).not.toHaveBeenCalled();
    });

    it('лимит попыток исчерпан (apiLimitMaxWaits) — не уходит в вечный цикл, возвращает последний код', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue(claudeRun(1, 'session limit resets 11am'));
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { apiLimitMaxWaits: 2 },
            },
        );

        expect(code).toBe(1);
        // attempt: 0 и 1 — пуш+сон, на attempt=2 (>= maxWaits) выход без ещё одного пуша.
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(3);
        expect(pushEventFn).toHaveBeenCalledTimes(2);
        expect(sleepFn).toHaveBeenCalledTimes(2);
    });

    it('cfg.waitOnApiLimit === false — маркер лимита есть, но повтор/пуш выключены явно', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue(claudeRun(1, 'session limit resets 11am'));
        const pushEventFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn: vi.fn(),
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { waitOnApiLimit: false },
            },
        );

        expect(code).toBe(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn).not.toHaveBeenCalled();
    });
});

// #606: рантайм временно недоступен (CLI автообновляется, симлинк /usr/bin/claude
// пересоздаётся) — код 127 / ENOENT / "No such file or directory" в выводе трактуется как
// транзиент, а не отказ по существу: повтор с backoff в пределах бюджета времени, а не
// немедленный fail-closed стоп, как раньше.
describe('runClaude — #606: транзиентная недоступность рантайма повторяется с backoff', () => {
    const { runClaude } = ralph;

    it('код 127 → повтор с backoff, успех на N-й попытке засчитывается', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce({
                code: 127,
                output: '/usr/local/bin/claude: line 70: /usr/bin/claude: No such file or directory',
            })
            .mockReturnValueOnce({ code: 127, output: 'No such file or directory' })
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            { model: 'sonnet' },
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { runtimeUnavailableRetryDelayMs: 1000 },
            },
        );

        expect(code).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(3);
        expect(sleepFn).toHaveBeenCalledTimes(2);
        expect(sleepFn.mock.calls[0][0]).toBe(1000); // попытка 1: база × 1
        expect(sleepFn.mock.calls[1][0]).toBe(2000); // попытка 2: база × 2
        // Короткие промежуточные повторы не пушатся — пуш зовётся только на честном
        // исчерпании бюджета (см. следующий тест).
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('ненулевой код с обычным выводом модели → стоп без повторов, как раньше', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValue({ code: 1, output: 'Error: тест не прошёл' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: {},
            },
        );

        expect(code).toBe(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('предел по времени исчерпан → честный fail-closed стоп с пушем, называющим причину', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValue({ code: 127, output: 'No such file or directory' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: {
                    // Бюджет крошечный и делится нацело базой backoff — детерминированное
                    // число попыток без хрупкой арифметики по реальным дефолтам (5 мин/10с).
                    runtimeUnavailableMaxWaitMs: 3000,
                    runtimeUnavailableRetryDelayMs: 1000,
                },
            },
        );

        expect(code).toBe(127);
        // Попытка 1 ждёт 1000мс (elapsed 1000), попытка 2 ждёт min(2000, 2000)=2000
        // (elapsed 3000 == бюджет) → на попытке 3 remainingMs <= 0 → стоп.
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(3);
        expect(sleepFn).toHaveBeenCalledTimes(2);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const [msg, cfgArg] = pushEventFn.mock.calls[0];
        expect(msg).toMatch(/рантайм недоступен/);
        expect(msg).not.toMatch(/вердикт/);
        expect(cfgArg).toEqual({
            runtimeUnavailableMaxWaitMs: 3000,
            runtimeUnavailableRetryDelayMs: 1000,
        });
    });

    // Ревью #612 (blocker): текстовая эвристика применялась к ЛЮБОМУ исходу, включая
    // code === 0. Успешная сессия, процитировавшая в отчёте «No such file or directory»,
    // перезапускалась до исчерпания бюджета (≈8 полных сессий) — с дублированием побочек
    // и ложным пушем «рантайм недоступен» в конце.
    it('ревью #612: успешная сессия с ENOENT в выводе НЕ повторяется', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue({
            code: 0,
            output: 'починил падавший тест: cat: x: No such file or directory',
        });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { runtimeUnavailableRetryDelayMs: 1000 },
            },
        );

        expect(code).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('ревью #612: упавшая сессия (session-failed), процитировавшая ENOENT, тоже не повторяется', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue({
            code: 1,
            output: 'тест падал с No such file or directory — не починил',
            failureKind: 'session-failed',
        });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            { pushEventFn, sleepFn, ensureTunnelFn: () => true, runClaudeOnceFn, cfg: {} },
        );

        expect(code).toBe(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
    });

    // Ревью #612: повторы рантайм-недоступности жгли `attempt` — счётчик бюджета ожиданий
    // API-лимита. Три моргания CLI, и `attempt >= maxWaits` истинно СРАЗУ: раннер не ждёт
    // сброса окна лимита ни разу, а в шаге сдачи фазы это fail-closed стоп по причине, к
    // лимиту отношения не имеющей.
    it('ревью #612: транзиенты рантайма не тратят бюджет ожиданий API-лимита', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce({ code: 1, output: '', failureKind: 'runtime-unavailable' })
            .mockReturnValueOnce({ code: 1, output: '', failureKind: 'runtime-unavailable' })
            .mockReturnValueOnce({ code: 1, output: '', failureKind: 'runtime-unavailable' })
            .mockReturnValueOnce(claudeRun(1, "You've hit your session limit · resets 11am"))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: {
                    apiLimitMaxWaits: 3,
                    apiLimitGraceMin: 0,
                    runtimeUnavailableRetryDelayMs: 1000,
                },
            },
        );

        // Лимит ДОЖДАЛСЯ своей паузы (первое из трёх разрешённых ожиданий), а не упал в
        // «бюджет исчерпан» из-за трёх предшествующих транзиентов.
        expect(code).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(5);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/API-лимит/);
    });

    // Ревью #612: наружу из runClaude уходит голое число, а разбор падения кодер-итерации
    // отличает отказ среды от отказа сессии по НОМЕРУ (127/126, #445). Структурный путь
    // #611 отдаёт ENOENT кодом 1 — без нормализации петля молотила бы итерации об
    // отсутствующий бинарь при уже ушедшем пуше «рантайм недоступен».
    it('ревью #612: исчерпанная рантайм-недоступность возвращается кодом 127 (отказ среды)', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue({
            code: 1,
            output: '',
            failureKind: 'runtime-unavailable',
            systemErrorCode: 'ENOENT',
        });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: {
                    runtimeUnavailableMaxWaitMs: 3000,
                    runtimeUnavailableRetryDelayMs: 1000,
                },
            },
        );

        expect(code).toBe(127);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        // Код ОС назван прямо в пуше — «код 1» человеку не говорит ничего.
        expect(pushEventFn.mock.calls[0][0]).toMatch(/ENOENT/);
    });

    it('API-лимит и рантайм-недоступность не путаются: маркер лимита не ретраится этой веткой', () => {
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce(claudeRun(1, "You've hit your session limit · resets 11am"))
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { apiLimitMaxWaits: 3, apiLimitGraceMin: 0 },
            },
        );

        expect(code).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(2);
        // Пуш пришёл через штатную ветку API-лимита (текст "API-лимит"), не через
        // рантайм-недоступность.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/API-лимит/);
    });
});

// #611: корень трёх ночных отказов — spawnSync.error терялся целиком, ENOENT/E2BIG были
// неотличимы от честного падения сессии (code:1, output:'\n'). Здесь runClaude принимает
// решение о повторе/стопе ПО СТРУКТУРНОМУ failureKind, а не по тексту output — так что
// классификация не зависит от того, упоминает ли конкретное сообщение об ошибке слово
// "ENOENT" дословно.
describe('runClaude — #611: решение о повторе по структурному failureKind, не по тексту', () => {
    const { runClaude } = ralph;

    it('failureKind:runtime-unavailable без текстовых маркеров в output → повтор с backoff', () => {
        // output намеренно НЕ содержит "ENOENT"/"No such file" — только структурный
        // признак от spawnClaude/spawnCodex говорит раннеру, что это транзиент.
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce({ code: 1, output: '', failureKind: 'runtime-unavailable' })
            .mockReturnValueOnce({ code: 0, output: 'ok' });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { runtimeUnavailableRetryDelayMs: 1000 },
            },
        );

        expect(code).toBe(0);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(2);
        expect(sleepFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('failureKind:arg-too-long → НИ ОДНОГО повтора, честный стоп с исходным кодом', () => {
        // Даже если output случайно содержит слова, похожие на "рантайм недоступен" —
        // структурный failureKind сильнее и решает раньше текстовой проверки.
        const runClaudeOnceFn = vi.fn().mockReturnValue({
            code: 1,
            output: 'No such file or directory упомянуто в выводе модели',
            failureKind: 'arg-too-long',
        });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: {},
            },
        );

        expect(code).toBe(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('failureKind:session-failed (обычный крах) → стоп без повторов, поведение прежнее', () => {
        const runClaudeOnceFn = vi.fn().mockReturnValue({
            code: 1,
            output: 'Error: тест не прошёл',
            failureKind: 'session-failed',
        });
        const pushEventFn = vi.fn();
        const sleepFn = vi.fn();

        const code = runClaude(
            'промпт',
            {},
            {
                pushEventFn,
                sleepFn,
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: {},
            },
        );

        expect(code).toBe(1);
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
    });
});

describe('выборка карточек фазы не урезается молча (#19)', () => {
    // `gh issue list` без `--limit` отдаёт первые 30 и выглядит при этом как полная
    // выборка. На пустоте этого ответа стоит и разрешение мерджа (C2), и ранняя проверка
    // конфликта меток (#17) — оба барьера слепли бы синхронно и молча.
    const issue = (number: number) => ({
        number,
        title: `карточка ${String(number)}`,
        labels: [],
        author: { login: 'owner' },
    });
    const many = (n: number) => Array.from({ length: n }, (_, i) => issue(i + 1));
    const LIMIT = 200;

    it('обе выборки просят предел явно, а не полагаются на дефолт форжа', () => {
        const commands: string[] = [];
        const forgeJsonFn = ((cmd: string) => {
            commands.push(cmd);
            return [];
        }) as never;
        ralph.openIssues('M1', { forgeJsonFn, failFn: () => undefined });
        ralph.allOpenIssues('M1', { forgeJsonFn });
        expect(commands).toHaveLength(2);
        for (const cmd of commands) expect(cmd).toContain(`--limit ${String(LIMIT)}`);
    });

    it('полный список ровно в предел → отказ, а не молчаливая полнота (C2)', () => {
        const forgeJsonFn = (() => many(LIMIT)) as never;
        expect(() => ralph.allOpenIssues('M1', { forgeJsonFn })).toThrow(/предел|полным нельзя/i);
    });

    it('очередь ровно в предел → тот же отказ, и считается СЫРОЙ ответ, до фильтров', () => {
        // Все карточки blocked: после фильтра очередь пуста, и если бы предел проверялся
        // после отсева, урезание выглядело бы как «работы нет».
        const blocked = many(LIMIT).map((i) => ({ ...i, labels: [{ name: 'blocked' }] }));
        const forgeJsonFn = (() => blocked) as never;
        const reasons: string[] = [];
        // Отказ полноты идёт МИМО failFn сбоя чтения: тот подписал бы урезанную выборку
        // диагнозом «чтение форжа упало — проверь авторизацию», а чинится она разбором
        // вехи, а не логином (копия потребителя, #72-ревью).
        expect(() =>
            ralph.openIssues('M1', {
                forgeJsonFn,
                failFn: (msg: string) => {
                    reasons.push(msg);
                    return undefined;
                },
            }),
        ).toThrow(/предел/i);
        expect(reasons).toEqual([]);
    });

    it('ответ короче предела проходит — барьер не мешает обычной фазе', () => {
        const forgeJsonFn = (() => many(LIMIT - 1)) as never;
        expect(ralph.allOpenIssues('M1', { forgeJsonFn })).toHaveLength(LIMIT - 1);
        // У очереди длину не сверяем: она ещё отсеивает чужих авторов по
        // `config.authorAllowlist`, и в юните этот список свой. Проверяем то, что
        // относится к барьеру, — что отказа не было вовсе.
        const reasons: string[] = [];
        ralph.openIssues('M1', {
            forgeJsonFn,
            failFn: (msg: string) => {
                reasons.push(msg);
                return undefined;
            },
        });
        expect(reasons).toEqual([]);
    });

    it('метки карточек фазы держат тот же предел — вопрос другой, граница одна', () => {
        const forgeJsonFn = (() => many(LIMIT).map(() => ({ labels: [{ name: 'x' }] }))) as never;
        expect(() => ralph.milestoneLabels('M1', { forgeJsonFn })).toThrow(/предел/i);
    });
});

describe('preflight — валидация конфига/среды и подготовка контекста (#99)', () => {
    // preflight принимает cfg и зависимости с побочками (sh/fail/log/загрузка state/
    // свип milestones/проверка мерджа) параметрами — как ensureTunnel. Инжектируем их,
    // поэтому тут нет ни git/gh, ни process.exit, ни диска. failFn БРОСАЕТ (а не
    // process.exit) — так assert ловит нужную ветку и останавливает выполнение ровно
    // там же, где в проде остановил бы exit(1). Флаги режима once/dry/resubmit тоже
    // инжектируются в preflight (дефолты из module-level ONCE/DRY/RESUBMIT), поэтому их
    // ветки (грязное дерево, свип milestones, бюджет итераций) тестируются явно, а не
    // зависят от того, с какими аргументами запущен vitest.
    const throwingFail = (msg: string) => {
        throw new Error(msg);
    };
    const fakeState = () => ({ count: 0, milestone: 'M1', submitted: false, noProgress: 0 });
    // Дефолты «зелёного» пути: shFn — чистое дерево, свип/мердж — noop, фаза текущая
    // (индекс 0, инвариант C4 не гоняется). loadStateFn ЗДЕСЬ намеренно НЕ задаём: где
    // нужен фейк state — передаём loadStateFn: fakeState явно через overrides; где хотим
    // проверить реальный loadState — не передаём, тогда сработает дефолт параметра
    // (module-level loadState). Так не приходится удалять ключ из собранного объекта.
    const okDeps = (overrides = {}) => ({
        shFn: () => '',
        failFn: throwingFail,
        logFn: () => {},
        // Проверка авторизации форжа идёт через шов (#35), а не через shFn: боевой дефолт
        // ушёл бы в настоящий gh/curl и упёрся в предохранитель побочек.
        checkAuthFn: () => {},
        // #17: карточки текущей фазы preflight читает через шов — «зелёному» пути нужен
        // пустой ответ, иначе боевой дефолт ушёл бы в настоящий форж и упёрся в
        // предохранитель побочек (как checkAuthFn выше).
        allOpenIssuesFn: () => [],
        phaseIndexOfFn: () => 0,
        phaseMergedFn: () => true,
        saveStateFn: () => {},
        ...overrides,
    });
    const validCfg = (overrides = {}) => ({
        active: true,
        phases: [{ milestone: 'M1', branch: 'feature/m1' }],
        authorAllowlist: ['owner'],
        // #204-ревью: preflight валидирует состав гейта на старте (resolveGateChecks) —
        // валидный блок gate нужен «зелёному» пути, как phases/authorAllowlist.
        gate: { checks: [['test', 'npm run test']] },
        ...overrides,
    });

    // ── Канон, задача 27: заданный скрипт потребителя ищется до первой итерации ──
    // Валидатор конфига проверяет ФОРМУ пути (задача 23), а мир — не его предмет. Опечатка
    // в самом пути вероятнее опечатки в имени ключа, и стоила бы она дороже: обе обёртки
    // вокруг вызова fail-open, поэтому «файла нет» видно одной строкой ⚠ после мерджа
    // фазы — а через месяц журнал находок пуст, и связать это с опечаткой некому.
    describe('наличие скриптов потребителя (канон, задача 27)', () => {
        // Задача 95: секция observability проверяется на старте, а не там, где её прочтут.
        it('битая секция observability — стоп на старте с причиной', () => {
            expect(() =>
                preflight(
                    validCfg({ observability: { diskMinFreeMB: 512 } }),
                    okDeps({ loadStateFn: fakeState }),
                ),
            ).toThrow(/observability: незнакомые ключи diskMinFreeMB/);
            expect(() =>
                preflight(
                    validCfg({ observability: { pricing: { m: { inputPerMTok: '5' } } } }),
                    okDeps({ loadStateFn: fakeState }),
                ),
            ).toThrow(/pricing\.m/);
        });

        const withScripts = (resolved: Record<string, string | null>, extra = {}) =>
            validCfg({ consumerScriptsResolved: resolved, ...extra });

        it('путь есть на диске — старт молчит про скрипты', () => {
            const logs: string[] = [];
            const seen: string[] = [];
            preflight(
                withScripts({ projectSync: '/app/scripts/sync.mjs', reviewFindingsJournal: null }),
                okDeps({
                    loadStateFn: fakeState,
                    logFn: (m: string) => logs.push(m),
                    existsFn: (p: string) => {
                        seen.push(p);
                        return true;
                    },
                }),
            );
            expect(seen).toEqual(['/app/scripts/sync.mjs']);
            expect(logs.join('\n')).not.toMatch(/скрипт/i);
        });

        it('заданного скрипта нет — предупреждение ДО первой итерации, а не ⚠ после мерджа', () => {
            const logs: string[] = [];
            preflight(
                withScripts({
                    projectSync: null,
                    reviewFindingsJournal: '/app/scripts/journal.mjs',
                }),
                okDeps({
                    loadStateFn: fakeState,
                    logFn: (m: string) => logs.push(m),
                    existsFn: () => false,
                }),
            );
            expect(logs.join('\n')).toContain('consumerScripts.reviewFindingsJournal');
            expect(logs.join('\n')).toContain('/app/scripts/journal.mjs');
        });

        it('задача 28: при заданных roots предупреждение обещает обновление, а не ручной pull', () => {
            // Формулировка — часть контракта, а не украшение: прежняя («это дерево раннер
            // не обновляет») была верна до задачи 28 и сегодня отправила бы человека делать
            // руками то, что раннер делает сам. Оговорка про чистое дерево на main тоже
            // обязана звучать: без неё обещание становится неправдой ровно там, где человек
            // оставил свои правки.
            const logs: string[] = [];
            preflight(
                withScripts(
                    { projectSync: '/app/scripts/sync.mjs', reviewFindingsJournal: null },
                    {
                        rootsResolved: { consumerRoot: '/app' },
                        consumerScripts: { projectSync: 'scripts/sync.mjs' },
                    },
                ),
                okDeps({
                    loadStateFn: fakeState,
                    logFn: (m: string) => logs.push(m),
                    existsFn: () => false,
                }),
            );
            const warn = logs.join('\n');
            expect(warn).toContain('consumerScripts.projectSync');
            expect(warn).toContain('после мерджа фазы');
            expect(warn).toMatch(/чистое и на main/);
            expect(warn).not.toMatch(/раннер не обновляет/);
        });

        it('старт при этом НЕ падает: фаза может сама заводить этот скрипт', () => {
            // Ревью Codex (!22): дерево перед стартом стоит на origin/main, и фаза, которая
            // добавляет скрипт, при отказе не смогла бы стартовать вовсе — AFK до утра.
            expect(() =>
                preflight(
                    withScripts({
                        projectSync: '/app/scripts/sync.mjs',
                        reviewFindingsJournal: null,
                    }),
                    okDeps({ loadStateFn: fakeState, existsFn: () => false }),
                ),
            ).not.toThrow();
        });

        it('предупреждение называет ЯКОРЬ из конфига, а не текущий каталог', () => {
            // Человек ищет файл там, где правит конфиг: без якоря сообщение отправляет его
            // не туда, а `process.cwd()` в тексте — это ещё и якорь наружу репозитория.
            // Сырой путь ОТНОСИТЕЛЬНЫЙ: именно его резолв к consumerRoot и объясняется, а
            // резолвнутое значение при заданных roots абсолютно всегда.
            const logs: string[] = [];
            preflight(
                withScripts(
                    { projectSync: '/app/scripts/sync.mjs', reviewFindingsJournal: null },
                    {
                        consumerScripts: { projectSync: 'scripts/sync.mjs' },
                        rootsResolved: {
                            consumerRoot: '/app',
                            executionRoot: '/app-ralph',
                            productRoot: '/app/.ralph/core',
                            runtimeDir: '/app/.ralph/runtime/prod',
                        },
                    },
                ),
                okDeps({
                    loadStateFn: fakeState,
                    logFn: (m: string) => logs.push(m),
                    existsFn: () => false,
                }),
            );
            expect(logs.join('\n')).toContain('consumerRoot /app');
        });

        it('абсолютный путь: предупреждение не поминает якорь — он тут ни при чём', () => {
            // Иначе фраза про consumerRoot отправляет человека искать файл не туда: адрес
            // задан целиком, и раскладка корней на него не влияет (ревью Codex, !22).
            const logs: string[] = [];
            preflight(
                withScripts(
                    { projectSync: '/opt/tools/sync.mjs', reviewFindingsJournal: null },
                    {
                        consumerScripts: { projectSync: '/opt/tools/sync.mjs' },
                        rootsResolved: {
                            consumerRoot: '/app',
                            executionRoot: '/app-ralph',
                            productRoot: '/app/.ralph/core',
                            runtimeDir: '/app/.ralph/runtime/prod',
                        },
                    },
                ),
                okDeps({
                    loadStateFn: fakeState,
                    logFn: (m: string) => logs.push(m),
                    existsFn: () => false,
                }),
            );
            expect(logs.join('\n')).toContain('/opt/tools/sync.mjs');
            expect(logs.join('\n')).not.toContain('consumerRoot');
            expect(logs.join('\n')).not.toContain('приедет');
        });

        it('выключенный скрипт (null) диск не трогает вовсе', () => {
            const seen: string[] = [];
            preflight(
                withScripts({ projectSync: null, reviewFindingsJournal: null }),
                okDeps({
                    loadStateFn: fakeState,
                    existsFn: (p: string) => {
                        seen.push(p);
                        return true;
                    },
                }),
            );
            expect(seen).toEqual([]);
        });
    });

    it('active: false → fail с сообщением про active', () => {
        expect(() => preflight({ active: false }, okDeps())).toThrow(/active/i);
    });

    it('пустой authorAllowlist → fail (C3): публичный репо + bypassPermissions', () => {
        const cfg = validCfg({ authorAllowlist: [] });
        expect(() => preflight(cfg, okDeps())).toThrow(/authorAllowlist/);
    });

    it('отсутствующий authorAllowlist → тоже fail (C3)', () => {
        const cfg = { active: true, phases: [{ milestone: 'M1', branch: 'b' }] };
        expect(() => preflight(cfg, okDeps())).toThrow(/authorAllowlist/);
    });

    it('нет phases → fail', () => {
        const cfg = { active: true, phases: [], authorAllowlist: ['owner'] };
        expect(() => preflight(cfg, okDeps())).toThrow(/phases/i);
    });

    describe('профиль prod требует RALPH_TG_* (#85, fail-closed как authorAllowlist)', () => {
        const savedEnv = { ...process.env };
        beforeEach(() => {
            process.env = { ...savedEnv };
            delete process.env.RALPH_TG_BOT_TOKEN;
            delete process.env.RALPH_TG_CHAT_ID;
        });
        afterEach(() => {
            process.env = savedEnv;
        });

        it('prod без RALPH_TG_BOT_TOKEN/RALPH_TG_CHAT_ID → fail', () => {
            const cfg = validCfg({ profileName: 'prod' });
            expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).toThrow(
                /RALPH_TG_BOT_TOKEN/,
            );
        });

        it('prod с заполненными RALPH_TG_* правильной формы → проверка проходит (не бросает на этой ветке)', () => {
            process.env.RALPH_TG_BOT_TOKEN = '123456789:AAExampleTokenLooksLikeThisThirtyPlusChars';
            process.env.RALPH_TG_CHAT_ID = '-1001234567890';
            const cfg = validCfg({
                profileName: 'prod',
                deployCheck: { healthUrl: 'https://app.example.test' },
            });
            expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).not.toThrow();
        });

        it('#204-ревью: prod без валидного deployCheck.healthUrl → fail (пост-мердж healthcheck обязателен)', () => {
            process.env.RALPH_TG_BOT_TOKEN = '123456789:AAExampleTokenLooksLikeThisThirtyPlusChars';
            process.env.RALPH_TG_CHAT_ID = '-1001234567890';
            const cfg = validCfg({ profileName: 'prod' }); // deployCheck.healthUrl не задан
            expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).toThrow(/healthUrl/);
        });

        // #51: барьер healthUrl держится на посылке «деплой есть». Когда деплоя нет,
        // требование вынуждает вписать в конфиг фиктивный адрес, лишь бы пройти старт, —
        // барьер, ради которого врут, уже не защищает, а производит ложь.
        it('#51: deployCheck выключен → healthUrl не требуется', () => {
            process.env.RALPH_TG_BOT_TOKEN = '123456789:AAExampleTokenLooksLikeThisThirtyPlusChars';
            process.env.RALPH_TG_CHAT_ID = '-1001234567890';
            const cfg = validCfg({ profileName: 'prod' });
            expect(() =>
                preflight(cfg, okDeps({ loadStateFn: fakeState, deployEnabledFn: () => false })),
            ).not.toThrow();
        });

        // Обратная половина той же пары: включённый деплой требование СОХРАНЯЕТ. Без этого
        // теста снятие барьера читалось бы как «healthUrl больше не нужен никому».
        it('#51: deployCheck включён → healthUrl по-прежнему обязателен', () => {
            process.env.RALPH_TG_BOT_TOKEN = '123456789:AAExampleTokenLooksLikeThisThirtyPlusChars';
            process.env.RALPH_TG_CHAT_ID = '-1001234567890';
            const cfg = validCfg({ profileName: 'prod' });
            expect(() =>
                preflight(cfg, okDeps({ loadStateFn: fakeState, deployEnabledFn: () => true })),
            ).toThrow(/healthUrl/);
        });

        it('prod с плейсхолдер-токеном неверной формы → fail (не только наличие, но и форма)', () => {
            // Правдоподобный плейсхолдер, скопированный из ralph.env.example без правки,
            // дал бы 401 на каждый пуш, а fail-open молча съел бы события. Отсекаем на старте.
            process.env.RALPH_TG_BOT_TOKEN = '123456789:XXXX';
            process.env.RALPH_TG_CHAT_ID = '42';
            const cfg = validCfg({ profileName: 'prod' });
            expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).toThrow(
                /не похож на токен/,
            );
        });

        it('prod с chat_id не-числом → fail', () => {
            process.env.RALPH_TG_BOT_TOKEN = '123456789:AAExampleTokenLooksLikeThisThirtyPlusChars';
            process.env.RALPH_TG_CHAT_ID = 'not-a-number';
            const cfg = validCfg({ profileName: 'prod' });
            expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).toThrow(
                /не похож на chat_id/,
            );
        });

        it('playground (без profileName) — проверка TG не применяется даже с пустым env', () => {
            const cfg = validCfg(); // profileName не задан → playground
            expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).not.toThrow();
        });
    });

    it('#204-ревью: битый/забытый блок gate → fail на СТАРТЕ (resolveGateChecks в preflight)', () => {
        // Ранний отказ, а не спустя часы в tryMergePhase: свежий порт с кривым конфигом
        // должен упасть при запуске, как на authorAllowlist/TG.
        const cfg = validCfg({ gate: undefined });
        expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).toThrow(/gate/);
    });

    it('задача 81: опечатка в политике гейта (gate.externalCi) → fail на СТАРТЕ', () => {
        // «requird» молча означал бы optional — ровно та дыра, которую политика закрывает.
        const cfg = validCfg({
            gate: { checks: [['test', 'npm run test']], externalCi: 'requird' },
        });
        expect(() => preflight(cfg, okDeps({ loadStateFn: fakeState }))).toThrow(
            /gate\.externalCi/,
        );
    });

    // Ревью-thread: env-ключи ВСЕХ рантаймов, достижимых из modelRouting (не только
    // статического coderRuntime), резолвим на СТАРТЕ — иначе конфиг фолбэка/label на
    // провайдера без ключа взорвался бы process.exit только в момент использования.
    describe('#376 (ревью): секреты достижимых рантаймов резолвятся на старте', () => {
        const savedEnv = { ...process.env };
        beforeEach(() => {
            process.env = { ...savedEnv };
            delete process.env.RALPH_KIMI_AUTH_TOKEN;
            delete process.env.OPENAI_API_KEY;
        });
        afterEach(() => {
            process.env = savedEnv;
        });

        it('apiLimitFallback на kimi без RALPH_KIMI_AUTH_TOKEN → fail на старте (не в момент лимита)', () => {
            const cfg = validCfg({
                modelRouting: {
                    apiLimitFallback: { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                },
            });
            expect(() => preflight(cfg, okDeps({ dry: false, loadStateFn: fakeState }))).toThrow(
                /RALPH_KIMI_AUTH_TOKEN/,
            );
        });

        it('label на openai без OPENAI_API_KEY → fail на старте', () => {
            const cfg = validCfg({
                modelRouting: {
                    labels: { 'complexity:low': { provider: 'openai', model: 'gpt-5-codex' } },
                },
            });
            expect(() => preflight(cfg, okDeps({ dry: false, loadStateFn: fakeState }))).toThrow(
                /OPENAI_API_KEY/,
            );
        });

        it('kimi-фолбэк С ключом в env → эта проверка не бросает', () => {
            process.env.RALPH_KIMI_AUTH_TOKEN = 'sk-moon';
            const cfg = validCfg({
                modelRouting: {
                    apiLimitFallback: { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                },
            });
            expect(() =>
                preflight(cfg, okDeps({ dry: false, loadStateFn: fakeState })),
            ).not.toThrow();
        });

        it('dry-run не требует секрета рантайма (read-only)', () => {
            const cfg = validCfg({
                modelRouting: {
                    apiLimitFallback: { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                },
            });
            expect(() =>
                preflight(cfg, okDeps({ dry: true, loadStateFn: fakeState })),
            ).not.toThrow();
        });

        it('claude-only роутинг → провайдерных ключей не требует (поведение прежнее)', () => {
            const cfg = validCfg({
                modelRouting: { labels: { 'complexity:low': 'claude-haiku-4-5' } },
            });
            expect(() =>
                preflight(cfg, okDeps({ dry: false, loadStateFn: fakeState })),
            ).not.toThrow();
        });
    });

    it('state старой схемы (phaseIndex, без milestone) → fail (через реальный loadState)', () => {
        // Не инжектируем loadStateFn — работает РЕАЛЬНЫЙ loadState (дефолт), которому
        // preflight пробрасывает свой failFn. Диск мокаем на старую схему: единственное
        // fs-чтение на этом пути preflight — как раз внутри loadState (остальные побочки
        // инжектированы). Так тест покрывает настоящую валидацию схемы, а не заглушку.
        vi.spyOn(fs, 'readFileSync').mockReturnValue(
            JSON.stringify({ count: 3, phaseIndex: 0, submitted: false }),
        );
        // Не передаём loadStateFn → сработает дефолт параметра = реальный loadState.
        try {
            expect(() => preflight(validCfg(), okDeps())).toThrow(/схем|phaseIndex/i);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('валидный конфиг + дефолтный state → возвращает { state, maxIterations, maxTurns }', () => {
        const state = { count: 2, milestone: 'M1', submitted: false, noProgress: 0 };
        const cfg = validCfg({ maxIterations: 7, maxTurns: 150 });
        const phaseMergedFn = vi.fn();
        const ctx = preflight(cfg, okDeps({ loadStateFn: () => state, phaseMergedFn }));
        expect(ctx).toEqual({ state, maxIterations: 7, maxTurns: 150 });
        // Инвариант C4 не гонялся (текущая фаза, idx 0). Свипа milestones на старте
        // больше нет вовсе (#37) — milestone закрывается в цикле сдачи, через шов.
        expect(phaseMergedFn).not.toHaveBeenCalled();
    });

    it('maxIterations/maxTurns берут дефолты (10/200), когда не заданы в конфиге', () => {
        const ctx = preflight(validCfg(), okDeps({ loadStateFn: fakeState }));
        expect(ctx.maxIterations).toBe(10);
        expect(ctx.maxTurns).toBe(200);
    });

    // ── Негативные ветки среды и инвариант зависимых фаз C4 (ревью PR #102) ──────
    // Правила проекта требуют негативные сценарии. Раньше phaseIndexOfFn был всюду
    // () => 0, поэтому тело C4 (for i < startIdx) ни разу не выполнялось, а ветки sh
    // (не git-репо / gh не авторизован / грязное дерево) были непокрыты.

    // shFn, который бросает только на команде, содержащей needle (иначе — чистый вывод).
    const shThrowingOn = (needle: string) => (cmd: string) => {
        if (cmd.includes(needle)) throw new Error(`fail: ${cmd}`);
        return '';
    };

    it('C4: предыдущая фаза не смерджена (phaseMerged=false) → fail «Инвариант нарушен»', () => {
        const cfg = validCfg({
            phases: [
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        // startIdx=1 → цикл проверяет фазу M1; phaseMergedFn=false → инвариант нарушен.
        const deps = okDeps({
            loadStateFn: () => ({ count: 0, milestone: 'M2', submitted: false, noProgress: 0 }),
            phaseIndexOfFn: () => 1,
            phaseMergedFn: () => false,
        });
        expect(() => preflight(cfg, deps)).toThrow(/Инвариант нарушен/);
    });

    it('C4: phaseMerged бросил исключение → fail «Не смог проверить мердж-статус»', () => {
        const cfg = validCfg({
            phases: [
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        const deps = okDeps({
            loadStateFn: () => ({ count: 0, milestone: 'M2', submitted: false, noProgress: 0 }),
            phaseIndexOfFn: () => 1,
            phaseMergedFn: () => {
                throw new Error('gh недоступен');
            },
        });
        expect(() => preflight(cfg, deps)).toThrow(/Не смог проверить мердж-статус/);
    });

    // Регресс: C4 обязан спрашивать мердж-статус у ШВА, а не у команд GitHub.
    // Оба теста выше инжектят `phaseMergedFn`, поэтому ДЕФОЛТ не проверял никто — а
    // дефолтом там стояла GitHub-реализация (`gh pr list`). Вскрылось это только на
    // второй фазе живого прогона не-GitHub площадки: цикл C4 идёт по фазам ДО текущей,
    // значит при единственной записи в `phases` не выполняется ни разу, и многофазный
    // конфиг там не стартовал никогда. Поэтому здесь `phaseMergedFn` намеренно УДАЛЯЕТСЯ
    // из deps: тест на подменённой функции прошёл бы и до фикса.
    it('C4 берёт мердж-статус из adapters.taskSource, а не из команд форжа', () => {
        const cfg = validCfg({
            phases: [
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        const { taskSource } = ralph.getAdapters();
        const original = taskSource.isPhaseMerged;
        const seamCall = vi.fn(() => true);
        // Подмена ПОСЛЕ сборки реестра — она же доказывает ленивость дефолта: снимок
        // поля на этапе объявления параметра этой подмены не увидел бы.
        taskSource.isPhaseMerged = seamCall;
        const deps = okDeps({
            loadStateFn: () => ({ count: 0, milestone: 'M2', submitted: false, noProgress: 0 }),
            phaseIndexOfFn: () => 1,
        }) as Record<string, unknown>;
        delete deps.phaseMergedFn;
        try {
            preflight(cfg, deps);
        } finally {
            taskSource.isPhaseMerged = original;
        }
        expect(seamCall).toHaveBeenCalledTimes(1);
        expect(seamCall).toHaveBeenCalledWith({ milestone: 'M1', branch: 'feature/m1' });
    });

    // ── Ранняя проверка конфликта human+complexity (#17) ────────────────────────
    // До #10 фильтр `human` стоял ВНУТРИ openIssues — до отсева blocked и чужих авторов,
    // поэтому конфликтная карточка роняла петлю на первом чтении очереди. После переезда
    // фильтра поверх шва (withHumanFilter) шов отдаёт уже отсеянное, и карточка, помеченная
    // `blocked` либо созданная чужим автором, доживала до сдачи фазы — то есть до C2, когда
    // итерации ночи уже сгорели. Здесь проверяется, что старт ловит её раньше первой итерации.
    const conflictIssue = (overrides = {}) => ({
        number: 90,
        title: 'Карточка с двумя метками',
        labels: [{ name: 'human' }, { name: 'complexity:low' }],
        author: { login: 'owner' },
        ...overrides,
    });

    it('#17: карточка с human и complexity:* в текущей фазе → fail ДО первой итерации', () => {
        const deps = okDeps({
            loadStateFn: fakeState,
            allOpenIssuesFn: () => [conflictIssue()],
        });
        expect(() => preflight(validCfg(), deps)).toThrow(/конфликт замысла/);
        expect(() => preflight(validCfg(), deps)).toThrow(/#90/);
    });

    // Именно эти два случая доживали до сдачи фазы: очередь их отсеивает, а сдача (C2)
    // смотрит полный список — поэтому preflight обязан спрашивать ПОЛНЫЙ список тоже.
    it('#17: конфликт ловится и когда карточка blocked или заведена чужим автором', () => {
        const blocked = conflictIssue({
            number: 91,
            labels: [{ name: 'human' }, { name: 'complexity:low' }, { name: 'blocked' }],
        });
        const foreign = conflictIssue({ number: 92, author: { login: 'stranger' } });
        for (const issue of [blocked, foreign]) {
            const deps = okDeps({ loadStateFn: fakeState, allOpenIssuesFn: () => [issue] });
            expect(() => preflight(validCfg(), deps)).toThrow(/конфликт замысла/);
        }
    });

    it('#17: карточка только с human (без complexity) старт не роняет', () => {
        const deps = okDeps({
            loadStateFn: fakeState,
            allOpenIssuesFn: () => [conflictIssue({ labels: [{ name: 'human' }] })],
        });
        expect(() => preflight(validCfg(), deps)).not.toThrow();
    });

    it('#17: карточки текущей фазы читаются РОВНО один раз (в цикл чтение не уехало)', () => {
        const allOpenIssuesFn = vi.fn(() => []);
        preflight(validCfg(), okDeps({ loadStateFn: fakeState, allOpenIssuesFn }));
        expect(allOpenIssuesFn).toHaveBeenCalledTimes(1);
        expect(allOpenIssuesFn).toHaveBeenCalledWith('M1');
    });

    // Форж мог не ответить, и цена ошибки здесь несимметрична: жёсткий стоп на транзиентной
    // помехе стоит целой ночи AFK, а пропущенная ранняя проверка — только раннего диагноза,
    // потому что C2 на сдаче остаётся вторым эшелоном. Поэтому предупреждение, а не стоп.
    it('#17: чтение карточек упало → предупреждение в лог, старт продолжается', () => {
        const logs: string[] = [];
        const deps = okDeps({
            loadStateFn: fakeState,
            logFn: (m: string) => logs.push(m),
            allOpenIssuesFn: () => {
                throw new Error('форж не ответил');
            },
        });
        expect(() => preflight(validCfg(), deps)).not.toThrow();
        expect(logs.join('\n')).toMatch(/форж не ответил/);
        expect(logs.join('\n')).toMatch(/C2|сдач/);
    });

    it('#220 НЕГАТИВНЫЙ: битая секция newIssues — отказ старта, а не дефолт', () => {
        expect(() =>
            preflight(
                validCfg({ newIssues: { sessionQuota: -1 } }),
                okDeps({ loadStateFn: fakeState }),
            ),
        ).toThrow(/newIssues\.sessionQuota/);
    });

    // #220: бюджет фазы — тем же чтением, предупреждением, а не стопом.
    it('#220: веха с 11 карточками при лимите 10 → ⚠ с числами, старт продолжается', () => {
        const logs: string[] = [];
        const cards = Array.from({ length: 11 }, (_, k) => ({
            number: k + 1,
            title: `к${String(k)}`,
        }));
        const deps = okDeps({
            loadStateFn: fakeState,
            logFn: (m: string) => logs.push(m),
            allOpenIssuesFn: () => cards,
        });
        expect(() => preflight(validCfg({ maxIterations: 10 }), deps)).not.toThrow();
        expect(logs.join('\n')).toMatch(
            /⚠ Бюджет фазы "M1": открытых карточек 11 при maxIterations 10/,
        );
    });

    it('#220 ОТ ПРОТИВНОГО: 10 карточек при лимите 10 — без ⚠', () => {
        const logs: string[] = [];
        const cards = Array.from({ length: 10 }, (_, k) => ({
            number: k + 1,
            title: `к${String(k)}`,
        }));
        const deps = okDeps({
            loadStateFn: fakeState,
            logFn: (m: string) => logs.push(m),
            allOpenIssuesFn: () => cards,
        });
        preflight(validCfg({ maxIterations: 10 }), deps);
        expect(logs.join('\n')).not.toMatch(/Бюджет фазы/);
    });

    it('#17: все фазы пройдены (state.milestone === null) → карточки не читаются', () => {
        const allOpenIssuesFn = vi.fn(() => []);
        const deps = okDeps({
            loadStateFn: () => ({ count: 0, milestone: null, submitted: false, noProgress: 0 }),
            allOpenIssuesFn,
        });
        expect(() => preflight(validCfg(), deps)).not.toThrow();
        expect(allOpenIssuesFn).not.toHaveBeenCalled();
    });

    // Тот же регресс, что у C4 (!3): дефолт обязан идти через шов, иначе на не-GitHub
    // площадке проверка либо не работает, либо врёт про `gh`. Ключ намеренно УДАЛЯЕТСЯ
    // из deps — тест на подменённой функции прошёл бы и мимо дефолта.
    it('#17: полный список карточек берётся из adapters.taskSource, а не из команд форжа', () => {
        const { taskSource } = ralph.getAdapters();
        const original = taskSource.listAllOpenIssues;
        const seamCall = vi.fn(() => []);
        taskSource.listAllOpenIssues = seamCall;
        const deps = okDeps({ loadStateFn: fakeState }) as Record<string, unknown>;
        delete deps.allOpenIssuesFn;
        try {
            preflight(validCfg(), deps);
        } finally {
            taskSource.listAllOpenIssues = original;
        }
        expect(seamCall).toHaveBeenCalledTimes(1);
        expect(seamCall).toHaveBeenCalledWith('M1');
    });

    // ── Фаза 10: формат карточки, заданный потребителем ─────────────────────────
    // Инцидент у потребителя: веху витрины завели без макетов, петля верстала по доводам
    // ревью и сломала главную на проде. Карточку не по формату петля не берёт, а стоп
    // называет и карточку, и раздел — иначе человек ищет нарушение по всей вехе.
    describe('формат карточек фазы (issueFormat)', () => {
        const issueFormat = { sections: [{ heading: 'Критерии готовности' }] };
        const card = (number: number) => ({
            number,
            title: `Карточка ${String(number)}`,
            labels: [{ name: 'complexity:low' }],
            author: { login: 'owner' },
        });
        const bodies: Record<number, string> = {
            1: '## Критерии готовности\n- [ ] тест',
            2: '## Что сделать\nтекст',
        };
        const getIssueFn = (n: number) => ({ number: n, title: 't', body: bodies[n] ?? '' });

        it('карточка без обязательного раздела → стоп называет карточку и раздел', () => {
            const deps = okDeps({
                loadStateFn: fakeState,
                openIssuesFn: () => [card(1), card(2)],
                getIssueFn,
            });
            const run = () => preflight(validCfg({ issueFormat }), deps);
            expect(run).toThrow(/#2.*нет раздела «Критерии готовности»/);
            expect(run).not.toThrow(/#1\b/);
        });

        it('все карточки по формату — старт идёт', () => {
            const deps = okDeps({
                loadStateFn: fakeState,
                openIssuesFn: () => [card(1)],
                getIssueFn,
            });
            expect(() => preflight(validCfg({ issueFormat }), deps)).not.toThrow();
        });

        it('формат не задан — тела карточек не читаются, старт как раньше', () => {
            const read = vi.fn(getIssueFn);
            const deps = okDeps({
                loadStateFn: fakeState,
                allOpenIssuesFn: () => [card(2)],
                getIssueFn: read,
            });
            expect(() => preflight(validCfg(), deps)).not.toThrow();
            expect(read).not.toHaveBeenCalled();
        });

        it('битая секция issueFormat — стоп на старте с названной причиной', () => {
            const deps = okDeps({ loadStateFn: fakeState });
            expect(() => preflight(validCfg({ issueFormat: { sections: [] } }), deps)).toThrow(
                /issueFormat\.sections/,
            );
        });

        // Тот же размен, что у ранней проверки #17: транзиент форжа не стоит ночи AFK, а
        // второй эшелон есть — карточку проверяет и выбор в цикле, до спавна сессии.
        it('тело карточки не прочиталось → предупреждение, старт продолжается', () => {
            const logs: string[] = [];
            const deps = okDeps({
                loadStateFn: fakeState,
                logFn: (m: string) => logs.push(m),
                openIssuesFn: () => [card(2)],
                getIssueFn: () => {
                    throw new Error('форж не ответил');
                },
            });
            expect(() => preflight(validCfg({ issueFormat }), deps)).not.toThrow();
            expect(logs.join('\n')).toMatch(/#2.*форж не ответил/);
        });
        // Ревью: карточка `blocked` или чужого автора в очередь не попадает, и стоп старта
        // из-за её формата держал бы веху на том, что петлю не касается.
        it('карточка вне очереди (blocked, чужой автор) формат старта не валит', () => {
            const read = vi.fn(getIssueFn);
            const logs: string[] = [];
            const deps = okDeps({
                loadStateFn: fakeState,
                logFn: (m: string) => logs.push(m),
                allOpenIssuesFn: () => [card(1), card(2)],
                openIssuesFn: () => [card(1)],
                getIssueFn: read,
            });
            expect(() => preflight(validCfg({ issueFormat }), deps)).not.toThrow();
            expect(read.mock.calls.map(([n]) => n)).toEqual([1]);
            expect(logs.join('\n')).toMatch(/формат карточек очереди фазы "M1": 1 точечных чтений/);
        });

        it('очередь не прочиталась → предупреждение, старт продолжается', () => {
            const logs: string[] = [];
            const deps = okDeps({
                loadStateFn: fakeState,
                logFn: (m: string) => logs.push(m),
                openIssuesFn: () => {
                    throw new Error('форж не ответил');
                },
            });
            expect(() => preflight(validCfg({ issueFormat }), deps)).not.toThrow();
            expect(logs.join('\n')).toMatch(/очередь фазы "M1" \(форж не ответил\)/);
        });
    });

    it('git rev-parse падает → fail «Не git-репозиторий»', () => {
        const deps = okDeps({ loadStateFn: fakeState, shFn: shThrowingOn('rev-parse') });
        expect(() => preflight(validCfg(), deps)).toThrow(/Не git-репозиторий/);
    });

    // Ядро больше не знает, ЧЕМ проверяется авторизация: у GitHub это `gh auth status`,
    // у SourceCraft — запрос к API. Оно знает лишь, что шов отказал (#35). Что именно
    // зовёт каждая реализация — предмет контрактного сьюта adapters-contract.test.ts.
    it('checkAuth шва падает → fail «Форж не авторизован», с причиной от шва', () => {
        const deps = okDeps({
            loadStateFn: fakeState,
            checkAuthFn: () => {
                throw new Error('gh: You are not logged into any GitHub hosts.');
            },
        });
        expect(() => preflight(validCfg(), deps)).toThrow(/Форж не авторизован или недоступен/);
        expect(() => preflight(validCfg(), deps)).toThrow(/not logged into any GitHub hosts/);
    });

    it('грязное дерево при dry=false → fail «Рабочее дерево грязное»', () => {
        const deps = okDeps({
            loadStateFn: fakeState,
            shFn: (cmd: string) => (cmd.includes('status --porcelain') ? ' M src/x.ts' : ''),
            dry: false,
        });
        expect(() => preflight(validCfg(), deps)).toThrow(/Рабочее дерево грязное/);
    });

    it('грязное дерево при dry=true → НЕ падает (dry-run read-only, правки не требуются)', () => {
        const deps = okDeps({
            loadStateFn: fakeState,
            shFn: (cmd: string) => (cmd.includes('status --porcelain') ? ' M src/x.ts' : ''),
            dry: true,
        });
        expect(() => preflight(validCfg(), deps)).not.toThrow();
    });

    it('once=true → maxIterations=1 (бюджет одной HITL-итерации), иначе дефолт конфига', () => {
        const cfg = validCfg({ maxIterations: 9 });
        const withOnce = preflight(cfg, okDeps({ loadStateFn: fakeState, once: true }));
        expect(withOnce.maxIterations).toBe(1);
        const withoutOnce = preflight(cfg, okDeps({ loadStateFn: fakeState, once: false }));
        expect(withoutOnce.maxIterations).toBe(9);
    });

    it('resubmit=true → сбрасывает state.submitted и сохраняет через saveStateFn', () => {
        const state = { count: 2, milestone: 'M1', submitted: true, noProgress: 0 };
        const saveStateFn = vi.fn();
        preflight(validCfg(), okDeps({ loadStateFn: () => state, saveStateFn, resubmit: true }));
        expect(state.submitted).toBe(false);
        expect(saveStateFn).toHaveBeenCalledWith(state);
    });

    // #93: попытка, не дошедшая до гейта, держит оба флага ложными — сброс флагов журнал
    // не трогал, и «полный повтор» продолжал с правок без нового ревью.
    it('#93 resubmit=true снимает журнал попытки, не дошедшей до гейта', () => {
        const at = 't';
        let stages = startStage([], 'M1', 'pr', at);
        stages = finishStage(stages, 'M1', 'pr', 'ok', at);
        stages = finishStage(stages, 'M1', 'review', 'ok', at);
        stages = finishStage(stages, 'M1', 'plan', 'ok', at);
        stages = finishStage(stages, 'M1', 'fixes', 'stop', at, { base: 'a'.repeat(40) });
        const state = attachSubmitJournal({
            count: 2,
            milestone: 'M1',
            noProgress: 0,
            submitStages: stages,
        } as never as RalphState);
        expect(state.submitted).toBe(false);
        const saveStateFn = vi.fn();
        preflight(validCfg(), okDeps({ loadStateFn: () => state, saveStateFn, resubmit: true }));
        expect(state.submitStages).toEqual([]);
        expect(saveStateFn).toHaveBeenCalledWith(state);
    });

    it('#93 resubmit=true не трогает попытку, дошедшую до мерджа: там барьер деплоя', () => {
        const at = 't';
        let stages: ReturnType<typeof startStage> = [];
        for (const s of [
            'pr',
            'review',
            'plan',
            'fixes',
            'fix-review',
            'arbiter',
            'gate',
            'merge',
        ] as const)
            stages = finishStage(stages, 'M1', s, 'ok', at);
        const kept = [...stages];
        const state = attachSubmitJournal({
            count: 0,
            milestone: 'M1',
            noProgress: 0,
            submitStages: stages,
        } as never as RalphState);
        preflight(
            validCfg(),
            okDeps({ loadStateFn: () => state, saveStateFn: vi.fn(), resubmit: true }),
        );
        expect(state.submitStages).toEqual(kept);
    });

    it('#165 барьер: state.deployBlock задан → пуш на старте + fail (следующая фаза не начинается)', () => {
        const state = {
            count: 0,
            milestone: 'M2',
            submitted: false,
            noProgress: 0,
            deployBlock: {
                milestone: 'M1',
                sha: 'a'.repeat(40),
                status: 'completed',
                conclusion: 'failure',
                url: 'https://gh/run/1',
                reason: 'workflow completed (failure)',
            },
        };
        const pushEventFn = vi.fn();
        expect(() =>
            preflight(validCfg(), okDeps({ loadStateFn: () => state, pushEventFn })),
        ).toThrow(/деплой.*красн|#165/i);
        // допушивает на старте — страховка от потерянного пуша прошлого прогона
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/aaaaaaaa/);
    });

    it('#165 --deploy-resolved → снимает блок через saveStateFn, fail не бросается', () => {
        const state = {
            count: 0,
            milestone: 'M2',
            submitted: false,
            noProgress: 0,
            deployBlock: { milestone: 'M1', reason: 'workflow timeout', sha: null, url: null },
        };
        const saveStateFn = vi.fn();
        const pushEventFn = vi.fn();
        expect(() =>
            preflight(
                validCfg(),
                okDeps({
                    loadStateFn: () => state,
                    saveStateFn,
                    pushEventFn,
                    deployResolved: true,
                    // фаза M2 — идёт проверка C4 предыдущей M1; phaseMergedFn=true (okDeps)
                    phaseIndexOfFn: () => 0,
                }),
            ),
        ).not.toThrow();
        expect(state.deployBlock).toBe(null);
        expect(saveStateFn).toHaveBeenCalledWith(state);
        // барьер снят → красного пуша на старте нет
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('#165 --deploy-resolved без активного блока → флаг проигнорирован, не падает', () => {
        const state = { count: 0, milestone: 'M1', submitted: false, noProgress: 0 };
        const logs: string[] = [];
        expect(() =>
            preflight(
                validCfg(),
                okDeps({
                    loadStateFn: () => state,
                    logFn: (m: string) => logs.push(m),
                    deployResolved: true,
                }),
            ),
        ).not.toThrow();
        expect(logs.join('\n')).toMatch(/проигнорирован/);
    });

    it('#165 без deployBlock → барьера нет, зелёный старт проходит', () => {
        const state = { count: 0, milestone: 'M1', submitted: false, noProgress: 0 };
        const pushEventFn = vi.fn();
        expect(() =>
            preflight(validCfg(), okDeps({ loadStateFn: () => state, pushEventFn })),
        ).not.toThrow();
        expect(pushEventFn).not.toHaveBeenCalled();
    });
});

describe('runLoop — основной while-цикл: итерации кодера, сдача, гейт, self-heal (#104)', () => {
    // runLoop получил DI (как preflight/ensureTunnel): коллабораторы с побочками
    // (log/sh/saveState/openIssues/runClaude/tryMergePhase/…) и флаги once/dry —
    // параметрами. Инжектируем фейки, поэтому здесь нет ни git/gh, ни спавна claude,
    // ни диска. Терминация цикла: phaseIndexOfFn по умолчанию — счётчик, отдающий
    // валидный индекс на 1-м проходе и «за концом» на 2-м, поэтому любой сценарий с
    // continue гарантированно упирается в ветку «все фазы завершены» и не зациклится.
    // Локальный тип state цикла ДЕРИВИРУЕТСЯ из боевого RalphState (state-lock.ts), а не
    // переобъявляется: так добавленное туда поле (reReviewPending и т.п.) не разъедется с
    // фикстурой молча. Обязательными оставляем счётчики, которые mkState всегда задаёт;
    // deployBlock сужаем до формы, читаемой сценариями (в RalphState он `unknown`).
    // Индекс-сигнатура `[k: string]: unknown` держит перенос дословным — mkState({ любое:
    // … }) остаётся валидным, как в прежнем .js, где state был нетипизирован; ЦЕНА её —
    // отключение проверки опечаток в ключах фикстур (tsc не поймает `submited: true`),
    // сознательный размен ради дословности переноса.
    type FakeState = Partial<RalphState> & {
        count: number;
        milestone: string;
        submitted: boolean;
        noProgress: number;
        gateHeals: number;
        blockedHeals: number;
        deployBlock?: {
            milestone?: string;
            conclusion?: string;
            status?: string;
            reason?: string;
        } | null;
        [k: string]: unknown;
    };
    const mkState = (o: Partial<FakeState> = {}): FakeState => ({
        count: 0,
        milestone: 'M1',
        submitted: false,
        noProgress: 0,
        gateHeals: 0,
        blockedHeals: 0,
        // #269 (копия потребителя): прогон площадки, уже пролеченный чини-сессией.
        forgeHealedRunId: null,
        ...o,
    });
    const validCfg = (o = {}) => ({
        model: 'claude-coder',
        prompt: 'сделай {milestone} в ветке {branch}',
        authorAllowlist: ['owner'],
        phases: [{ milestone: 'M1', branch: 'feature/m1' }],
        // #204: heal-пути runLoop собирают список чеков из gateChecksFor(cfg.profileName, cfg),
        // а состав теперь в конфиге — cfg нужен валидный gate-блок (иначе fail-closed).
        gate: {
            checks: [
                ['build', 'npm run build'],
                ['test', 'npm run test'],
            ],
            prodChecks: [['e2e', 'CI=1 npm run test:e2e']],
            prodDropChecks: ['test'],
        },
        ...o,
    });
    // Дефолтные зависимости «пустого зелёного» прохода. logFn собирает строки в
    // переданный массив (assert по тексту веток). Любой сценарий переопределяет нужное.
    const deps = (logs: string[], o: Record<string, unknown> = {}) => {
        let idxCalls = 0;
        return {
            once: false,
            dry: false,
            logFn: (m: string) => logs.push(m),
            shFn: () => '',
            // #193: обновление дерева раннера после мерджа идёт через argv-коллаборатор.
            runArgvFn: () => '',
            saveStateFn: () => {},
            // Задача 11: постановка дерева на ветку фазы и страж после сессии — побочки
            // (настоящий git), поэтому в общем деплое заглушены «всё удалось». Развилки
            // самих функций — в core/phase-branch.test.ts, сценарии стопа — ниже.
            ensurePhaseBranchFn: () => ({
                kind: 'fast-forwarded',
                branch: 'feature/m1',
                sha: 'a'.repeat(40),
            }),
            checkOnPhaseBranchFn: () => ({ ok: true, sha: 'a'.repeat(40) }),
            // #183: «ветка запушена» читает origin настоящим `git ls-remote` — в стенде
            // заглушено «запушена»; сценарии отказа переопределяют.
            branchPushedFn: () => true,
            // Снятие устаревших намерений при отказе стража — побочка по fs.
            readSessionRequestsFn: () => null,
            removeSessionRequestsFn: () => {},
            openIssuesFn: () => [],
            allOpenIssuesFn: () => [],
            // #40: применение намерений сессии — побочка (fs + шов), в тестах заглушка.
            // Сценарии самого применения — в отдельном describe ниже.
            applySessionRequestsFn: () => ({ applied: 0, failed: false }),
            // #46: шаг 1 сдачи — заведение PR петлёй. Оба хука заглушены здесь, иначе
            // каждый сценарий сдачи уходил бы в боевой шов и ждал его сетевых ретраев.
            // «PR ещё нет» — дефолт сценария сдачи; сам шаг проверяется отдельным describe.
            findOpenPrFn: () => null,
            createPrFn: () => 7,
            phasePrBodyFn: () => 'тело PR',
            // #50: карточку и комментарии PR читает петля — в тестах заглушки, иначе
            // каждый сценарий уходил бы в боевой шов и ждал его сетевых ретраев.
            getIssueFn: (number: number) => ({ number, title: 'задача', body: 'тело задачи' }),
            prCommentsFn: () => [],
            // #39: дефолт «задачи у фазы были» — то есть фаза сделана, а не не начата.
            // Иначе каждый сценарий сдачи ниже упирался бы в новый барьер вместо своей
            // ветки. Сценарии самого барьера переопределяют его на () => false.
            hasAnyIssuesFn: () => true,
            // 1-й проход → фаза 0; 2-й и далее → «за концом» массива phases → break.
            phaseIndexOfFn: () => (idxCalls++ === 0 ? 0 : 99),
            pickModelFn: () => 'claude-picked',
            // #376: тот же безопасный дефолт, что у pickModelFn — реальный pickRuntime читает
            // фабричный config (не задан в этих тестах), и без заглушки упал бы TypeError'ом.
            pickRuntimeFn: () => 'claude',
            // #393: кодер-итерация резолвит маршрут единой pickRouteFn (модель+провайдер из
            // одной записи). Дефолт — claude-роутинг с моделью 'claude-picked': провайдер
            // claude, тег modelProvider не ставится (не-Claude рантайма нет).
            pickRouteFn: () => ({ provider: 'claude', model: 'claude-picked' }),
            pickReviewModelFn: () => 'none',
            // #138: без этих двух дефолтов тесты, доходившие до шага ревью, звали
            // НАСТОЯЩИЕ phaseDiffFiles/reviewDiffContext — то есть реальный
            // `git fetch origin main feature/m1` (ветка из фикстуры выше) и реальный
            // log(), дописывавший в ralph.log живого прогона.
            phaseDiffFilesFn: () => [],
            reviewDiffContextFn: () => '',
            // #217: снятие label blocked — побочка (gh), в тестах заглушка. Реальный
            // removeBlockedLabel зовёт sh и попал бы в предохранитель #138.
            removeBlockedLabelFn: () => {},
            // Задача 79: чтение метки после записи — «встала»; отказы сверки — свои сценарии.
            prHasBlockedLabelFn: () => true,
            ensureCleanFn: () => true,
            // #85: пуш коммитов сессии разбора blocked — настоящий git push. Заглушено «пушить
            // нечего»; сценарии пуша и отказа переопределяют, модуль — core/session-push.test.ts.
            pushSessionCommitsFn: () => ({ kind: 'in-sync' as const }),
            phaseMergedFn: () => false,
            // #237: тот же безопасный дефолт — настоящий mergedPhasePr зовёт forgeJson → sh,
            // и тест на пути «фаза уже смерджена» ловил бы предохранитель #138.
            mergedPhasePrFn: () => null,
            advancePhaseFn: () => {},
            tryMergePhaseFn: () => 'not-merged',
            closeMilestoneByTitleFn: () => {},
            // #199: тот же безопасный дефолт, что у pushEventFn ниже — настоящий
            // syncProjectBoard зовёт sh('node scripts/project-sync.mjs'), и каждый
            // тест, доходящий до gate === 'merged', ловил бы предохранитель #138.
            syncProjectBoardFn: () => {},
            // #169: тот же безопасный дефолт — настоящий recordReviewFindings зовёт
            // sh('node scripts/review-findings-journal.mjs ...'), и каждый тест, доходящий
            // до gate === 'merged', ловил бы предохранитель #138 (даже через try/catch —
            // guardSideEffect пишет попытку в журнал ДО throw).
            recordReviewFindingsFn: () => {},
            // #625: те же безопасные дефолты-заглушки для лестницы ревью правок — без них
            // каждый тест, доходящий до цикла сдачи, звал бы НАСТОЯЩИЕ branchHeadSha
            // (git fetch + rev-parse), createIssue (форж) и recordFixReviewFindings
            // (node scripts/…) и ловил бы предохранитель #138.
            branchHeadShaFn: () => 'a'.repeat(40),
            createIssueFn: () => 1,
            recordFixReviewFindingsFn: () => {},
            getLastRedCheck: () => null,
            // #86: безопасный дефолт-заглушка — без него тест, не переопределивший
            // pushEventFn явно, звал бы НАСТОЯЩИЙ pushEvent (реальный log() + попытка
            // sendTelegramMessage в prod-сценариях). Сценарии, проверяющие сам пуш,
            // подменяют его явно. Строку в лог дефолт пишет так же, как боевой pushEvent
            // (`🔔 PUSH: …` через прокинутый logFn): стоп, переехавший из лога в пуш
            // (задача 40), не должен пропадать из лога сценария.
            pushEventFn: (msg: string, _cfg?: unknown, o?: { logFn?: (m: string) => void }) => {
                o?.logFn?.(`🔔 PUSH: ${msg}`);
                return false;
            },
            // #151: тот же безопасный дефолт-заглушка, что у pushEventFn/syncProjectBoardFn
            // выше — без него тест, не переопределивший ensureMonitorAliveFn явно, звал бы
            // НАСТОЯЩИЙ ensureMonitorAlive (реальные fs.readFileSync/spawn монитора).
            ensureMonitorAliveFn: () => null,
            // #163: безопасные заглушки пост-мердж проверки — без них prod-сценарий,
            // доходящий до gate === 'merged', звал бы НАСТОЯЩИЕ mergedShaOf/waitForDeployRun
            // (реальные gh-чтения через sh → предохранитель #138).
            mergedShaOfFn: () => 'a'.repeat(40),
            waitForDeployRunFn: () => ({ status: 'completed', conclusion: 'success' }),
            // #164: тот же безопасный дефолт-паттерн — без него prod-сценарий с зелёным
            // workflow (conclusion: 'success' выше) звал бы НАСТОЯЩИЙ checkProdHealth
            // (реальный curl к https://app.example.com).
            checkProdHealthFn: () => ({ ok: true, status: 200, url: 'https://app.example.com' }),
            ...o,
            runClaudeFn: withDefaultFixPlan(
                (o.runClaudeFn as RunClaudeFake | undefined) ?? (() => 0),
            ),
        };
    };
    const ctx = (state: unknown, o: Record<string, unknown> = {}) => ({
        state,
        maxIterations: 10,
        maxTurns: 200,
        ...o,
    });

    it('фаза не резолвится (все пройдены) → лог «все фазы завершены» и выход', () => {
        const logs: string[] = [];
        runLoop(validCfg(), ctx(mkState()), deps(logs, { phaseIndexOfFn: () => 99 }));
        expect(logs.join('\n')).toMatch(/Все фазы завершены/);
    });

    // #151: живость монитора проверяется на КАЖДОМ рабочем проходе while-цикла, не
    // только на старте. Проверка стоит ПОСЛЕ брейкеров: терминальный проход (фаза уже
    // смерджена → advancePhase → 2-й проход «за концом» → `if(!phase) break`) до неё не
    // доходит — переподнимать монитор за мгновение до выхода раннера незачем (exit-
    // хендлер тут же прислал бы ему SIGTERM). Сценарий с continue даёт один рабочий
    // проход и один терминальный → ровно 1 проверка монитора.
    it('#151: ensureMonitorAlive зовётся на рабочем проходе цикла (AFK, не только на старте)', () => {
        const logs: string[] = [];
        const ensureMonitorAliveFn = vi.fn(() => null);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseMergedFn: () => true,
                ensureMonitorAliveFn,
            }),
        );
        expect(ensureMonitorAliveFn).toHaveBeenCalledTimes(1);
    });

    it('#151: ensureMonitorAlive получает профиль, путь конфига раннера и logFn', () => {
        const logs: string[] = [];
        const ensureMonitorAliveFn = vi.fn(() => null);
        // Рабочий проход (idx 0), затем ensureClean=false → break сразу за проверкой
        // монитора: до неё цикл доходит, дальше — нет.
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                ensureCleanFn: () => false,
                // #66: после ensureClean раннер пробует закоммитить остаток; здесь дерево
                // не предмет теста, поэтому коммит «не удался» — цикл выходит сразу, как и был.
                commitLeftoversFn: () => false,
                monitorConfigPath: '/tmp/ralph.config.json',
                monitorExecutionRoot: '/path/to/work-tree',
                ensureMonitorAliveFn,
            }),
        );
        // logFn прокидывается сквозь runLoop (DI-паритет с pushEventFn) — проверяем, что
        // до ensureMonitorAlive доезжает именно инжектированный логгер, а не боевой log.
        expect(ensureMonitorAliveFn).toHaveBeenCalledWith(
            expect.objectContaining({
                profile: 'prod',
                configPath: '/tmp/ralph.config.json',
                // #126: переподнятый монитор показывает то же дерево работы, что и первый.
                executionRoot: '/path/to/work-tree',
                logFn: expect.any(Function),
            }),
        );
    });

    it('#151: dry=true → ensureMonitorAlive НЕ зовётся (read-only, монитор в dry не поднимается)', () => {
        const logs: string[] = [];
        const ensureMonitorAliveFn = vi.fn(() => null);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, { dry: true, phaseIndexOfFn: () => 99, ensureMonitorAliveFn }),
        );
        expect(ensureMonitorAliveFn).not.toHaveBeenCalled();
    });

    it('breaker maxIterations (AFK): count>=лимит → сброс count, saveState, стоп, пуш', () => {
        const logs: string[] = [];
        const state = mkState({ count: 10 });
        const saveStateFn = vi.fn();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(state, { maxIterations: 10 }),
            deps(logs, { phaseIndexOfFn: () => 0, saveStateFn, runClaudeFn, pushEventFn }),
        );
        expect(state.count).toBe(0);
        expect(saveStateFn).toHaveBeenCalled();
        expect(runClaudeFn).not.toHaveBeenCalled(); // до итерации не дошли
        // #86: событие «circuit breaker открылся» уходит пушем — и pushEvent теперь
        // единственный логгер события (маркер 🔔 PUSH), парного logFn больше нет.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/Ralph: circuit breaker/);
        // #289: причина «breaker» — стоп несёт диагноз и вопрос, а не только маркер.
        // Ревью #289: проверяются КОД причины и наличие поля, а не стык «русский
        // заголовок + код»: переформулировка заголовка (`breaker` → «предохранитель»)
        // красила бы тест, который про код причины, а не про её название.
        expect(pushEventFn.mock.calls[0][0]).toContain('(breaker)');
        expect(pushEventFn.mock.calls[0][0]).toContain('причина:');
        // Ревью #289, второй проход: числа лимита живут в ДИАГНОЗЕ, а не пересказывают
        // заголовок — ночной пуш об одном событии не идёт в два круга.
        expect(pushEventFn.mock.calls[0][0]).toMatch(
            /диагноз: итераций на фазе достигло лимита 10/,
        );
        expect(pushEventFn.mock.calls[0][2]).toMatchObject({ logFn: expect.any(Function) });
    });

    // #66: сессия может оставить работу незакоммиченной по причинам, которых не перечислить:
    // упёрлась в maxTurns, решила «дождусь зелёных тестов», приняла процесс раннера в `ps`
    // за конкурента. Каждый раз петля вставала до человека, а человек делал ровно
    // `git add -A && git commit`. Теперь это делает раннер: работа не теряется, а качество
    // по-прежнему сторожит гейт — он гоняет чеки на точном sha PR-головы.
    // #224: кодер-сессии пуш закрыт guard — её коммиты довозит раннер одним пушем после
    // сессии. От противного: сессия оставила незапушенные коммиты — они не теряются.
    it('#224: коммиты кодер-сессии пушит раннер — ровно один раз после сессии', () => {
        const order: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => {
            order.push('session');
            return 0;
        });
        const pushSessionCommitsFn = vi.fn((branch: string) => {
            order.push(`push:${branch}`);
            return { kind: 'pushed' as const, local: 'b'.repeat(40), remote: 'a'.repeat(40) };
        });
        const commitLeftoversFn = vi.fn(() => true);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                runClaudeFn,
                pushSessionCommitsFn,
                commitLeftoversFn,
            }),
        );
        expect(order).toEqual(['session', 'push:feature/m1']);
        // Остаток кодер-сессии решает разбор падения или вершина цикла, а не пуш (#390).
        expect(commitLeftoversFn).not.toHaveBeenCalled();
    });

    it('#224: пуш коммитов кодер-сессии отвергнут → стоп session-unpushed, а не тишина', () => {
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                runClaudeFn: vi.fn<RunClaudeFake>(() => 0),
                pushSessionCommitsFn: () => ({
                    kind: 'failed' as const,
                    why: 'не смог прочитать ветку feature/m1 на origin — Could not resolve host',
                    local: 'b'.repeat(40),
                    remote: null,
                }),
                pushEventFn,
            }),
        );
        const stops = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(stops).toHaveLength(1);
        expect(stops[0]).toContain('(session-unpushed)');
        expect(stops[0]).toContain('кодер-сессия Issue #5');
        expect(stops[0]).toContain('bbbbbbbb');
    });

    it('#66 остаток сессии коммитится раннером, цикл продолжается', () => {
        const logs: string[] = [];
        const state = mkState();
        const commitLeftoversFn = vi.fn(() => true);
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                // Дерево грязное — раньше это был стоп до человека.
                ensureCleanFn: () => false,
                commitLeftoversFn,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                runClaudeFn,
            }),
        );
        expect(commitLeftoversFn).toHaveBeenCalled();
        // Цикл НЕ встал: сессия по карточке запустилась.
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
    });

    // #13: строка «⛔ … — стоп, разбери руками» шла в лог за 0.2 с до «📦 Остаток
    // закоммичен», после чего петля спокойно продолжала. Разбор прогона человеком ушёл
    // по ложному следу — искал стоп, которого не было. Про стоп говорит тот, кто его
    // принимает: здесь склеены НАСТОЯЩИЕ ensureClean и commitLeftovers на одном логе.
    it('#13 авто-коммит остатка удался → в логе нет слова «стоп»', () => {
        const logs: string[] = [];
        const logFn = (m: string) => logs.push(m);
        let committed = false;
        const shFn = (c: string) => {
            if (c === 'git status --porcelain') return committed ? '' : ' M core/a.ts';
            if (c === 'git diff --cached --name-only') return 'core/a.ts';
            return '';
        };
        const shArgvFn = (_cmd: string, args: string[]) => {
            if (args[0] === 'commit') committed = true;
            return '';
        };
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                ensureCleanFn: (c: string) => ensureClean(c, { shFn, logFn }),
                commitLeftoversFn: (c: string) => commitLeftovers(c, { shFn, shArgvFn, logFn }),
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                runClaudeFn,
            }),
        );
        expect(committed).toBe(true);
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        // Смотрим ветку авто-коммита — строки ДО запуска сессии: `once` дальше честно
        // пишет свой HITL-стоп, и он к ветке остатка отношения не имеет.
        const upToCommit = logs.slice(
            0,
            logs.findIndex((m) => /Остаток сессии закоммичен/.test(m)) + 1,
        );
        const text = upToCommit.join('\n');
        expect(text).toMatch(/Грязное рабочее дерево/);
        expect(text).toMatch(/Остаток сессии закоммичен/);
        expect(text).not.toMatch(/стоп/i);
        expect(text).not.toMatch(/разбери руками/);
    });

    it('#66 чистое дерево → коммита не случается вовсе', () => {
        // Обратная сторона фикса: раннер коммитит ОСТАТОК, а не «на всякий случай». Пустой
        // коммит после каждой итерации замусорил бы ветку фазы и сделал бы историю
        // нечитаемой на ревью — а именно по ней человек понимает, что делала петля.
        const logs: string[] = [];
        const commitLeftoversFn = vi.fn(() => true);
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                ensureCleanFn: () => true,
                commitLeftoversFn,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                runClaudeFn,
            }),
        );
        expect(commitLeftoversFn).not.toHaveBeenCalled();
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
    });

    it('#66 НЕГАТИВНЫЙ: коммит остатка не удался → стоп, как раньше', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                ensureCleanFn: () => false,
                // git отказал (нет прав, конфликт индекса) — состояние дерева неизвестно,
                // и это ровно тот случай, ради которого проверка чистоты и стоит.
                commitLeftoversFn: () => false,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                runClaudeFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
    });

    it('грязное дерево между итерациями, коммит остатка не удался → стоп до issues', () => {
        // #66 изменил смысл: само по себе грязное дерево больше не стоп — раннер коммитит
        // остаток и идёт дальше. Стопом остаётся невозможность закоммитить: тогда состояние
        // дерева неизвестно, а «не знаю» здесь дороже лишней остановки (fail-closed).
        const logs: string[] = [];
        const openIssuesFn = vi.fn(() => []);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                ensureCleanFn: () => false,
                commitLeftoversFn: () => false,
                openIssuesFn,
            }),
        );
        // Прервались до очереди — issues даже не запрашивались.
        expect(openIssuesFn).not.toHaveBeenCalled();
    });

    // #88: мягкая остановка. Запрос приходит посреди шага — во время сессии, — а петля
    // слышит его только на границе: шаг доводится целиком (намерения сессии применены,
    // счётчик записан), state сохраняется, и в чат уходит строка об остановке.
    describe('#88 мягкая остановка на границе шага', () => {
        it('запрос посреди сессии → шаг доведён, state сохранён, строка в чат, запрос снят', () => {
            const logs: string[] = [];
            const state = mkState();
            let requested = false;
            const order: string[] = [];
            const saved: FakeState[] = [];
            const pushes: string[] = [];
            const clearStopRequestFn = vi.fn(() => {
                order.push('clear');
                requested = false;
            });
            const runClaudeFn = vi.fn<RunClaudeFake>(() => {
                order.push('session');
                // Сигнал остановки посреди сессии: петля сейчас внутри spawnSync и
                // услышать его не может — только на границе шага.
                requested = true;
                return 0;
            });
            const applySessionRequestsFn = vi.fn(() => {
                order.push('apply');
                return { applied: 1, failed: false, closedIssues: [5] };
            });
            const openIssuesFn = vi.fn(() => [{ number: 5, title: 'задача', labels: [] }]);
            runLoop(
                validCfg(),
                ctx(state),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn,
                    runClaudeFn,
                    applySessionRequestsFn,
                    saveStateFn: (s: FakeState) => {
                        order.push('save');
                        saved.push({ ...s });
                    },
                    pushEventFn: (m: string) => {
                        order.push('push');
                        pushes.push(m);
                    },
                    stopRequestedFn: () => requested,
                    clearStopRequestFn,
                }),
            );
            // Шаг доведён: сессия одна, её намерения применены — и второй шаг не начат.
            expect(runClaudeFn).toHaveBeenCalledTimes(1);
            expect(applySessionRequestsFn).toHaveBeenCalledTimes(1);
            expect(openIssuesFn).toHaveBeenCalledTimes(1);
            // State сохранён с доведённым шагом, и это последняя запись перед стопом.
            expect(saved.at(-1)?.count).toBe(1);
            expect(order.slice(-3)).toEqual(['save', 'clear', 'push']);
            // Приёмка — строка в чат.
            expect(pushes.at(-1)).toMatch(
                /^⏸ Ralph: мягкая остановка по запросу — фаза "M1", итерация 1: начатый шаг доведён, state сохранён\./,
            );
            expect(clearStopRequestFn).toHaveBeenCalledTimes(1);
        });

        it('запрос до первого шага → ни одной сессии, state сохранён, строка в чат', () => {
            const logs: string[] = [];
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            const saveStateFn = vi.fn();
            const pushes: string[] = [];
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                    runClaudeFn,
                    saveStateFn,
                    pushEventFn: (m: string) => pushes.push(m),
                    stopRequestedFn: () => true,
                }),
            );
            expect(runClaudeFn).not.toHaveBeenCalled();
            expect(saveStateFn).toHaveBeenCalledTimes(1);
            expect(pushes).toEqual([expect.stringMatching(/^⏸ Ralph: мягкая остановка/)]);
        });

        it('запрос не снялся → стоп всё равно, а строка называет, что убрать руками', () => {
            const pushes: string[] = [];
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps([], {
                    phaseIndexOfFn: () => 0,
                    pushEventFn: (m: string) => pushes.push(m),
                    stopRequestedFn: () => true,
                    clearStopRequestFn: () => {
                        throw new Error('EACCES');
                    },
                }),
            );
            expect(pushes).toHaveLength(1);
            expect(pushes[0]).toMatch(/снять не удалось \(EACCES\).*руками/);
        });

        it('dry-run при запросе встаёт, но ни запрос, ни state не трогает', () => {
            // C1: каталог состояния у dry тот же, лока он не берёт. Снятый им запрос
            // не увидела бы живая петля рядом — и пошла бы дальше.
            const logs: string[] = [];
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            const saveStateFn = vi.fn();
            const clearStopRequestFn = vi.fn();
            const pushEventFn = vi.fn();
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    dry: true,
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                    runClaudeFn,
                    saveStateFn,
                    pushEventFn,
                    stopRequestedFn: () => true,
                    clearStopRequestFn,
                }),
            );
            expect(clearStopRequestFn).not.toHaveBeenCalled();
            expect(saveStateFn).not.toHaveBeenCalled();
            expect(pushEventFn).not.toHaveBeenCalled();
            expect(runClaudeFn).not.toHaveBeenCalled();
            expect(logs.join('\n')).toMatch(/💤 DRY: запрос мягкой остановки на месте/);
        });

        it('боевое снятие запроса в DRY — no-op, как запись state', () => {
            // Второй рубеж за веткой в runLoop: снятие зовут и мимо петли, а C1 держит
            // единственная точка мутации, как `if (DRY) return` у saveState.
            const src = stripComments(
                fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8'),
            );
            const fn = src.slice(src.indexOf('function clearStopRequest(): void {'));
            const body = fn.slice(0, fn.indexOf('fs.rmSync'));
            expect(body).toMatch(/if \(DRY\) return;/);
        });

        it('main() передаёт петле боевое чтение запроса: без него остановка не слышна', () => {
            // Дефолт `runLoop` — «запроса нет» (полторы сотни тестов зовут петлю без этих
            // двух), поэтому применение держит только проводка в main. Удали её — запрос
            // остановки молча перестанет работать при зелёном сьюте; этот тест и краснеет.
            const src = stripComments(
                fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8'),
            );
            const call = src.slice(src.indexOf('runLoop(config, ctx, {'));
            const body = call.slice(0, call.indexOf('});'));
            expect(body).toMatch(/stopRequestedFn: stopRequested\b/);
            expect(body).toMatch(/clearStopRequestFn: clearStopRequest\b/);
            expect(src).toMatch(/fs\.existsSync\(RUNTIME\.stopRequest\)/);
        });
    });

    // #38: lock ядра сменился, пока петля работала. Подменить код под живым Node нельзя,
    // поэтому петля на границе итерации называет расхождение и выходит на рестарт — но
    // только на подтверждённой границе: посреди сессии сверки нет, посреди сдачи рестарта нет.
    describe('#38 lock новее исполняемой ревизии — рестарт на границе', () => {
        const drift = {
            lockSha: 'b'.repeat(40),
            reason: `lock новее исполняемой ревизии — нужен рестарт: исполняется ${'a'.repeat(40)}`,
        };

        it('lock сменился посреди сессии → шаг доведён, на границе стоп с причиной и кодом рестарта', () => {
            const state = mkState();
            let lockMoved = false;
            const order: string[] = [];
            const pushes: string[] = [];
            const saved: FakeState[] = [];
            const coreDriftFn = vi.fn(() => {
                order.push('drift-check');
                return lockMoved ? drift : null;
            });
            const runClaudeFn = vi.fn<RunClaudeFake>(() => {
                order.push('session');
                // Lock правится посреди сессии: петля внутри spawnSync и сверить не может.
                lockMoved = true;
                return 0;
            });
            const exit = runLoop(
                validCfg(),
                ctx(state),
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                    applySessionRequestsFn: () => ({
                        applied: 1,
                        failed: false,
                        closedIssues: [5],
                    }),
                    runClaudeFn,
                    saveStateFn: (s: FakeState) => saved.push({ ...s }),
                    pushEventFn: (m: string) => pushes.push(m),
                    coreDriftFn,
                }),
            );
            expect(exit).toBe('activation-restart');
            // Сверка — до сессии и после неё, а не посреди: сессия одна и доведена.
            expect(order).toEqual(['drift-check', 'session', 'drift-check']);
            expect(saved.at(-1)?.count).toBe(1);
            // Молчаливого продолжения нет: причина ушла уведомлением (и в лог через pushEvent).
            expect(pushes.at(-1)).toMatch(
                /^🔁 Ralph: lock новее исполняемой ревизии — нужен рестарт.*итерация 1: шаг доведён, state сохранён/,
            );
        });

        it('lock совпадает → петля работает как прежде, кода рестарта нет', () => {
            const exit = runLoop(
                validCfg(),
                ctx(mkState()),
                deps([], {
                    phaseIndexOfFn: () => 0,
                    stopRequestedFn: () => true,
                    coreDriftFn: () => null,
                }),
            );
            expect(exit).toBeUndefined();
        });

        it('сдача не доведена → рестарта нет: расхождение названо один раз, петля идёт дальше', () => {
            const at = 't';
            let stages = startStage([], 'M1', 'pr', at);
            stages = finishStage(stages, 'M1', 'pr', 'ok', at);
            stages = startStage(stages, 'M1', 'review', at);
            const state = attachSubmitJournal({
                ...mkState(),
                submitStages: stages,
            } as never as RalphState) as never as FakeState;
            const pushes: string[] = [];
            let tops = 0;
            const exit = runLoop(
                validCfg(),
                ctx(state),
                deps([], {
                    phaseIndexOfFn: () => 0,
                    pushEventFn: (m: string) => pushes.push(m),
                    // Страховка от бесконечного цикла, если рестарт сработает не там.
                    stopRequestedFn: () => ++tops >= 5,
                    coreDriftFn: () => drift,
                }),
            );
            expect(exit).toBeUndefined();
            const noted = pushes.filter((m) => m.startsWith('🔁'));
            expect(noted).toHaveLength(1);
            expect(noted[0]).toMatch(/нужен рестарт.*сдача фазы не доведена \(этап «review»\)/);
            // Сдача пошла дальше на прежней ревизии (здесь её гасит фейковый гейт), а не
            // оборвалась рестартом посреди.
            expect(pushes.some((m) => /выходит на рестарт/.test(m))).toBe(false);
            expect(pushes.at(-1)).toMatch(/не прошла авто-мердж/);
        });

        it('dry-run на расхождении встаёт и ничего не пишет', () => {
            const logs: string[] = [];
            const saveStateFn = vi.fn();
            const pushEventFn = vi.fn();
            const exit = runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    dry: true,
                    phaseIndexOfFn: () => 0,
                    saveStateFn,
                    pushEventFn,
                    coreDriftFn: () => drift,
                }),
            );
            expect(exit).toBeUndefined();
            expect(saveStateFn).not.toHaveBeenCalled();
            expect(pushEventFn).not.toHaveBeenCalled();
            expect(logs.join('\n')).toMatch(/💤 DRY: lock новее исполняемой ревизии/);
        });

        it('main() передаёт петле сверку с lock и выходит кодом рестарта', () => {
            // Дефолт `runLoop` — «совпали»; без проводки в main расхождение молча
            // перестало бы называться при зелёном сьюте.
            const src = stripComments(
                fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8'),
            );
            const call = src.slice(src.indexOf('const exit = runLoop(config, ctx, {'));
            expect(call.slice(0, call.indexOf('});'))).toMatch(/\bcoreDriftFn,/);
            expect(src).toMatch(/\(\) => checkLockDrift\(coreCheck\.sha, driftConsumer\)/);
            expect(src).toMatch(
                /if \(exit === 'activation-restart'\) process\.exit\(ACTIVATION_RESTART_EXIT\)/,
            );
            // Журнал активации пишется под локом: после взятия лока, до первой сессии.
            const lockAt = src.indexOf('if (!acquireRunnerLock()) return;');
            const recordAt = src.indexOf('activated = recordActivation(');
            const preflightAt = src.indexOf('const ctx = preflight(config);');
            expect(lockAt).toBeGreaterThan(0);
            expect(recordAt).toBeGreaterThan(lockAt);
            expect(preflightAt).toBeGreaterThan(recordAt);
        });
    });

    // #65: форж отдаёт список issue с задержкой — карточка, закрытая намерением секунду
    // назад, ещё числится открытой. Петля брала её повторно и жгла целую сессию на уже
    // сделанной работе (поймано здесь трижды: после #423, #424 и #425). Здесь шов
    // НАМЕРЕННО врёт в списке, как врал форж, а петля обязана поверить своему закрытию.
    it('#65 карточка, закрытая намерением прогона, второй раз не берётся', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                applySessionRequestsFn: () => ({ applied: 1, failed: false, closedIssues: [5] }),
                pickModelFn: () => 'claude-picked',
                runClaudeFn,
            }),
        );
        // Кодер-сессия по #5 ровно одна: дальше очередь для петли пуста, и она уходит
        // в цикл сдачи фазы, а не крутит ту же карточку до упора в maxIterations.
        const coderCalls = runClaudeFn.mock.calls.filter(
            ([, opts]) => (opts as { model?: string }).model === 'claude-picked',
        );
        expect(coderCalls).toHaveLength(1);
    });

    // #43: карточку закрыл ЧЕЛОВЕК между итерациями — своего закрытия у петли нет, и
    // `closedThisRun` её не знает. Список форжа врёт так же, как в #65; правду говорит
    // точечное чтение карточки, и оно обязано решать до спавна, а не после.
    it('#43 карточка, закрытая между итерациями при старом списке, не берётся', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        // #5 закрывается человеком ПОСЛЕ первой итерации: до неё карточка открыта.
        let humanClosed = false;
        const getIssueFn = vi.fn((number: number) => ({
            number,
            title: `задача ${String(number)}`,
            body: `тело ${String(number)}`,
            open: !(number === 5 && humanClosed),
        }));
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [
                    { number: 5, title: 'задача 5', labels: [] },
                    { number: 6, title: 'задача 6', labels: [] },
                ],
                getIssueFn,
                applySessionRequestsFn: () => {
                    // Сессия по #5 карточку не закрыла — закрыл человек между итерациями.
                    // Сессия по #6 закрыла свою намерением.
                    const closed = humanClosed ? [6] : [];
                    humanClosed = true;
                    return { applied: closed.length, failed: false, closedIssues: closed };
                },
                pickModelFn: () => 'claude-picked',
                runClaudeFn,
            }),
        );
        const coderPrompts = runClaudeFn.mock.calls
            .filter(([, opts]) => (opts as { model?: string }).model === 'claude-picked')
            .map(([prompt]) => String(prompt));
        expect(coderPrompts).toHaveLength(2);
        expect(coderPrompts[0]).toContain('тело 5');
        expect(coderPrompts[1]).toContain('тело 6');
        expect(logs.join('\n')).toMatch(/Issue #5 уже не открыт/);
    });

    it('#43 сверка читает карточку один раз: тело для промпта берётся из неё же', () => {
        const logs: string[] = [];
        const getIssueFn = vi.fn((number: number) => ({
            number,
            title: 'задача',
            body: 'тело',
            open: number !== 5,
        }));
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [
                    { number: 5, title: 'задача', labels: [] },
                    { number: 6, title: 'задача', labels: [] },
                ],
                getIssueFn,
                pickModelFn: () => 'claude-picked',
                runClaudeFn,
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(String(runClaudeFn.mock.calls[0][0])).toContain('Задача #6');
        expect(getIssueFn.mock.calls.map(([n]) => n)).toEqual([5, 6]);
    });

    it('#43 статус неизвестен (шов его не отдаёт) — карточка берётся, как по списку', () => {
        // «Не знаю» не становится «закрыта»: иначе адаптер без статуса молча опустошал бы
        // очередь, и фаза уходила бы в сдачу несделанной.
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                getIssueFn: (number: number) => ({ number, title: 'задача', body: 'тело' }),
                runClaudeFn,
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
    });

    // Фаза 10: второй эшелон формата после preflight — карточка, попавшая в веху посреди
    // прогона, не берётся: стоп до спавна сессии называет карточку и раздел.
    describe('формат карточки при выборе (issueFormat)', () => {
        const issueFormat = {
            sections: [{ heading: 'Макет', whenLabel: 'area:showcase', requireLink: true }],
        };
        const queue = () => [{ number: 5, title: 'витрина', labels: [{ name: 'area:showcase' }] }];

        it('карточка не по формату не берётся — стоп называет карточку и раздел', () => {
            const logs: string[] = [];
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            runLoop(
                validCfg({ issueFormat }),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: queue,
                    getIssueFn: (number: number) => ({
                        number,
                        title: 'витрина',
                        body: '## Что сделать\nсверстать',
                    }),
                    runClaudeFn,
                }),
            );
            expect(runClaudeFn).not.toHaveBeenCalled();
            expect(logs.join('\n')).toMatch(/не по формату потребителя.*#5: нет раздела «Макет»/);
        });

        it('карточка по формату берётся', () => {
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            runLoop(
                validCfg({ issueFormat }),
                ctx(mkState()),
                deps([], {
                    once: true,
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: queue,
                    getIssueFn: (number: number) => ({
                        number,
                        title: 'витрина',
                        body: '## Макет\nhttps://example.com/mockup',
                    }),
                    runClaudeFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(1);
        });

        // От противного к ревью: первое чтение (выбор) моргнуло, второе (для промпта)
        // прошло — прежде формат такого тела не проверял никто, и витрина без макета
        // уходила в работу.
        it('первое чтение карточки бросило, второе отдало тело не по формату — сессии нет', () => {
            const logs: string[] = [];
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            let reads = 0;
            runLoop(
                validCfg({ issueFormat }),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: queue,
                    getIssueFn: (number: number) => {
                        reads++;
                        if (reads === 1) throw new Error('форж моргнул');
                        return { number, title: 'витрина', body: '## Что сделать\nсверстать' };
                    },
                    runClaudeFn,
                }),
            );
            expect(reads).toBe(2);
            expect(runClaudeFn).not.toHaveBeenCalled();
            expect(logs.join('\n')).toMatch(/#5: нет раздела «Макет»/);
        });

        it('формат задан, карточка не прочиталась ни разу — стоп, а не сессия без проверки', () => {
            const logs: string[] = [];
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            const getIssueFn = vi.fn((): { number: number; title: string; body: string } => {
                throw new Error('форж не ответил');
            });
            runLoop(
                validCfg({ issueFormat }),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: queue,
                    getIssueFn,
                    runClaudeFn,
                }),
            );
            expect(runClaudeFn).not.toHaveBeenCalled();
            // Выбор плюс ISSUE_BODY_READ_ATTEMPTS чтений для промпта.
            expect(getIssueFn).toHaveBeenCalledTimes(3);
            const text = logs.join('\n');
            expect(text).toMatch(/#5 .*не прочитать за 2 попытки \(форж не ответил\).*не проверен/);
            // #130: сбой форжа, а не формат — человека не отправляют править карточку.
            expect(text).toContain('(forge-unreadable)');
            expect(text).not.toContain('(issue-format)');
            expect(text).toMatch(/проверь доступ к форжу/);
        });

        // #130: моргнули выбор и первое чтение для промпта — повтор, а не стоп.
        it('формат задан, два чтения моргнули, третье отдало тело по формату — сессия идёт', () => {
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            let reads = 0;
            runLoop(
                validCfg({ issueFormat }),
                ctx(mkState()),
                deps([], {
                    once: true,
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: queue,
                    getIssueFn: (number: number) => {
                        reads++;
                        if (reads <= 2) throw new Error('форж моргнул');
                        return {
                            number,
                            title: 'витрина',
                            body: '## Макет\nhttps://example.com/mockup',
                        };
                    },
                    runClaudeFn,
                }),
            );
            expect(reads).toBe(3);
            expect(runClaudeFn).toHaveBeenCalledTimes(1);
        });

        it('битая секция issueFormat без preflight — отказ, а не «формата нет»', () => {
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            expect(() =>
                runLoop(
                    validCfg({ issueFormat: { sections: [] } }),
                    ctx(mkState()),
                    deps([], { phaseIndexOfFn: () => 0, openIssuesFn: queue, runClaudeFn }),
                ),
            ).toThrow(/issueFormat\.sections/);
            expect(runClaudeFn).not.toHaveBeenCalled();
        });

        it('формат не задан — та же карточка берётся, как раньше', () => {
            const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps([], {
                    once: true,
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: queue,
                    getIssueFn: (number: number) => ({ number, title: 'витрина', body: 'тело' }),
                    runClaudeFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(1);
        });
    });

    it('кодер-итерация в ONCE: одна claude-сессия нужной моделью и стоп', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                pickModelFn: () => 'claude-picked',
                runClaudeFn,
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        const [prompt, opts] = runClaudeFn.mock.calls[0];
        // Плейсхолдеры промпта подставлены (replaceAll — оба {..}).
        expect(prompt).toContain('M1');
        expect(prompt).toContain('feature/m1');
        expect(opts).toEqual({ model: 'claude-picked', maxTurns: 200 });
        expect(state.count).toBe(1);
        expect(logs.join('\n')).toMatch(/HITL: одна итерация/);
    });

    // #376: pickRuntimeFn резолвит провайдера ОРТОГОНАЛЬНО pickModelFn — кодер-итерация
    // передаёт runClaudeFn третьим аргументом рантайм ИМЕННО этого провайдера из реестра
    // coderRuntime (ralph.coderRuntimeRunFor), а не статический дефолт.
    it('#376: кодер-итерация резолвит рантайм по pickRuntimeFn (провайдер → run из реестра coderRuntime)', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const kimiRun = ralph.coderRuntimeRunFor('kimi');
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [
                    { number: 6, title: 'задача-kimi', labels: [{ name: 'complexity:low' }] },
                ],
                pickRouteFn: () => ({ provider: 'kimi', model: 'kimi-k2-0711-preview' }),
                runClaudeFn,
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        const [, opts, depsOverride] = runClaudeFn.mock.calls[0];
        // #393: модель ИЗ МАРШРУТА (route.model) + провайдер kimi ⇒ помечена тегом
        // modelProvider:'kimi', чтобы runKimiOnce её применил (не отбросил как чужую).
        expect(opts).toEqual({
            model: 'kimi-k2-0711-preview',
            maxTurns: 200,
            modelProvider: 'kimi',
        });
        expect(depsOverride!.runClaudeOnceFn).toBe(kimiRun);
        expect(logs.join('\n')).toMatch(/модель: kimi-k2-0711-preview \(kimi\)/);
    });

    // #393 (блокер фазы 6, path 2): статический не-claude рантайм + маршрут БЕЗ своей модели
    // (issue без complexity-метки, modelRouting.default не задан) ⇒ pickRoute отдаёт
    // {provider:'kimi', model:undefined}, кодер-итерация падает на общий cfg.model (claude-имя).
    // Барьер: тег modelProvider НЕ ставится (модель не из маршрута) — не-Claude рантайм ниже
    // отбросит claude-имя. Проверяем на уровне цикла: opts НЕ содержит modelProvider, а рантайм
    // резолвится kimi (сам drop покрыт юнитом runKimiOnce выше).
    it('#393: статический kimi + маршрут без модели → opts.model=cfg.model БЕЗ тега modelProvider (claude-имя не уедет)', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const kimiRun = ralph.coderRuntimeRunFor('kimi');
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 8, title: 'задача-без-метки', labels: [] }],
                // Статический не-claude прогон без route-модели: провайдер kimi, model undefined.
                pickRouteFn: () => ({ provider: 'kimi' }),
                runClaudeFn,
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        const [, opts, depsOverride] = runClaudeFn.mock.calls[0];
        // Модель — общий cfg.model (claude-имя), тега провайдера НЕТ: не-Claude рантайм её отбросит.
        expect(opts.model).toBe('claude-coder');
        expect(opts).not.toHaveProperty('modelProvider');
        expect(depsOverride!.runClaudeOnceFn).toBe(kimiRun);
    });

    // Провайдер БЕЗ явного override в modelRouting (дефолтный роутинг, как до #376) должен
    // резолвиться на claude — статический adapters.coderRuntime текущего прогона.
    it('#376: pickRuntime без override даёт claude (обратная совместимость дефолтного роутинга)', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const claudeRun = ralph.coderRuntimeRunFor('claude');
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 'задача', labels: [] }],
                pickModelFn: () => 'claude-picked',
                // pickRuntimeFn не переопределён сверх дефолта общего deps() — 'claude'.
                runClaudeFn,
            }),
        );
        const [, , depsOverride] = runClaudeFn.mock.calls[0];
        expect(depsOverride!.runClaudeOnceFn).toBe(claudeRun);
    });

    // #390: инцидент 28.07.2026 — раннер откладывал диагностику падения кодер-сессии до
    // ensureCleanFn СЛЕДУЮЩЕЙ итерации, теряя факт падения в общем сообщении «грязное
    // дерево». Теперь при ненулевом коде выхода runLoop зовёт handleCrashedCoderSessionFn
    // СРАЗУ — с issue, кодом и выводом сессии (через сторонний канал onOutput) — и честно
    // подчиняется его решению о стопе.
    it('#390: ненулевой код сессии → handleCrashedCoderSessionFn зовётся с issue/кодом/выводом; stop:true останавливает цикл СРАЗУ', () => {
        const logs: string[] = [];
        const handleCrashedCoderSessionFn = vi.fn<HandleCrashedCoderSessionFake>(() => ({
            stop: true,
        }));
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, callDeps) => {
            (callDeps as { onOutput?: (o: string) => void } | undefined)?.onOutput?.('boom output');
            return 1;
        });
        const openIssuesFn = vi.fn(() => [{ number: 9, title: 'задача', labels: [] }]);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                // #390 доп.: НЕ терминальный phaseIndexOfFn (всегда фаза 0) — если бы стоп не
                // сработал СРАЗУ, цикл ушёл бы на второй рабочий проход и runClaudeFn/
                // openIssuesFn позвались бы повторно. Единственный вызов доказывает break
                // сразу за handleCrashedCoderSessionFn, а не «случайно совпало с концом фаз».
                phaseIndexOfFn: () => 0,
                openIssuesFn,
                runClaudeFn,
                handleCrashedCoderSessionFn,
            }),
        );
        expect(handleCrashedCoderSessionFn).toHaveBeenCalledTimes(1);
        const [issueArg, codeArg, outputArg, opts] = handleCrashedCoderSessionFn.mock.calls[0];
        expect(issueArg).toMatchObject({ number: 9 });
        expect(codeArg).toBe(1);
        expect(outputArg).toBe('boom output');
        expect(opts).toMatchObject({
            shFn: expect.any(Function),
            logFn: expect.any(Function),
            pushEventFn: expect.any(Function),
        });
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(openIssuesFn).toHaveBeenCalledTimes(1);
    });

    it('Фаза 16: исход auth кодер-сессии — стоп петли, вторая сессия не стартует', () => {
        const logs: string[] = [];
        const pushes: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, callDeps) => {
            (callDeps as { onOutput?: (o: string, r: string) => void } | undefined)?.onOutput?.(
                'Not logged in · Please run /login',
                'auth',
            );
            return 1;
        });
        const handleCrashedCoderSessionFn = vi.fn<HandleCrashedCoderSessionFake>(
            (issue, code, output, opts) =>
                handleCrashedCoderSession(issue, code, output, {
                    ...(opts as object),
                    saveSessionOutputFn: () => {},
                    pushEventFn: ((m: string) => {
                        pushes.push(m);
                        return true;
                    }) as never,
                }),
        );
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 9, title: 'задача', labels: [] }],
                runClaudeFn,
                handleCrashedCoderSessionFn,
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(pushes.join('\n')).toMatch(/отверг вход.*Issue #9/);
    });

    it('#390: handleCrashedCoderSessionFn возвращает stop:false → цикл НЕ останавливается, прежнее поведение (fail-open)', () => {
        const logs: string[] = [];
        const handleCrashedCoderSessionFn = vi.fn(() => ({ stop: false }));
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 1);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 9, title: 'задача', labels: [] }],
                runClaudeFn,
                handleCrashedCoderSessionFn,
            }),
        );
        expect(handleCrashedCoderSessionFn).toHaveBeenCalledTimes(1);
        // Дошли до штатного ONCE-стопа ПОСЛЕ блока диагностики падения — значит, ранний
        // break из-за stop:true не сработал (handleCrashedCoderSessionFn сказал stop:false).
        expect(logs.join('\n')).toMatch(/HITL: одна итерация/);
    });

    // ── Задача 11: ветку фазы держит раннер, а не сессия ────────────────────
    //
    // Инцидент: сессия слабой модели не подобрала идиому переключения и закоммитила на
    // detached HEAD — коммит остался недостижим ни из одной ветки. Барьер двусторонний:
    // дерево ставится на ветку ДО спавна, и после сессии проверяется, что оно там же.

    it('задача 11: дерево ставится на ветку фазы ДО спавна сессии', () => {
        const logs: string[] = [];
        const order: string[] = [];
        const ensurePhaseBranchFn = vi.fn((branch: string) => {
            order.push(`branch:${branch}`);
            return { kind: 'created' as const, branch, sha: 'a'.repeat(40) };
        });
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                ensurePhaseBranchFn,
                runClaudeFn: () => {
                    order.push('session');
                    return 0;
                },
            }),
        );
        expect(ensurePhaseBranchFn).toHaveBeenCalledTimes(1);
        expect(ensurePhaseBranchFn.mock.calls[0][0]).toBe('feature/m1');
        // Порядок и есть весь смысл правки: после сессии переключать уже поздно.
        expect(order).toEqual(['branch:feature/m1', 'session']);
    });

    // #144-ревью: пауза повтора сетевого транзиента — коллаборатором runLoop, а не боевым
    // `sleep`: тест, подсунувший проводке сетевой отказ, иначе реально уснул бы на 20 с.
    it('#144: проводка ветки получает sleepFn из параметров runLoop', () => {
        const sleepFn = vi.fn();
        const ensurePhaseBranchFn = vi.fn((branch: string, _deps: unknown) => ({
            kind: 'created' as const,
            branch,
            sha: 'a'.repeat(40),
        }));
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                ensurePhaseBranchFn,
                sleepFn,
                runClaudeFn: () => 0,
            }),
        );
        expect(ensurePhaseBranchFn).toHaveBeenCalled();
        expect((ensurePhaseBranchFn.mock.calls[0][1] as { sleepFn?: unknown }).sleepFn).toBe(
            sleepFn,
        );
    });

    it('задача 11: не встали на ветку → сессия НЕ спавнится, стоп с пушем', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                ensurePhaseBranchFn: () => ({
                    kind: 'failed' as const,
                    branch: 'feature/m1',
                    sha: null,
                    reason: 'origin недоступен',
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        // Сессия, которой некуда коммитить, сожгла бы итерацию и создала ту самую потерю.
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/не поставлено на ветку фазы feature\/m1/);
    });

    it('#144: сеть до origin пережила повторы — стоп своей причиной, а не unknown', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                ensurePhaseBranchFn: () => ({
                    kind: 'network' as const,
                    branch: 'feature/m1',
                    sha: null,
                    reason: 'сеть до origin: не смог обновить origin/main (попыток: 3) — последний ответ git: gnutls_handshake() failed',
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        const msg = String(pushEventFn.mock.calls[0][0]);
        expect(msg).toContain('(origin-network)');
        expect(msg).not.toContain('(unknown)');
        expect(msg).toMatch(/gnutls_handshake/);
    });

    it('задача 11: расхождение с origin — тоже стоп, а не попытка починить силой', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                // sha есть (дерево на ветке), но ff невозможен: пуш всё равно отвергнется.
                ensurePhaseBranchFn: () => ({
                    kind: 'diverged' as const,
                    branch: 'feature/m1',
                    sha: 'a'.repeat(40),
                    reason: 'ff невозможен',
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn.mock.calls[0][0]).toMatch(/diverged/);
    });

    it('задача 11: сессия оставила detached HEAD → стоп, и SHA назван в пуше', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const sha = 'c'.repeat(40);
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                checkOnPhaseBranchFn: () => ({
                    ok: false,
                    sha,
                    message: `⛔ Сессия оставила дерево работы в detached HEAD, а не на ветке фазы feature/m1. Работа достижима по SHA ${sha} — спаси её: git branch feature/m1 ${sha}`,
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        // Сессия отработала — проверка идёт ПОСЛЕ неё, иначе спасать было бы нечего.
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        // Названный SHA — единственное, чем эта строка отличается от тихой потери.
        expect(pushEventFn.mock.calls[0][0]).toContain(sha);
    });

    it('задача 11: страж отработал ДО намерений — карточка не закроется по работе вне ветки', () => {
        const logs: string[] = [];
        const applySessionRequestsFn = vi.fn(() => ({ applied: 1, failed: false }));
        const pushEventFn = vi.fn();
        const sha = 'd'.repeat(40);
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                // Сессия вышла с кодом 0 и попросила закрыть карточку, но коммит лёг мимо
                // ветки. Применить намерение значит закрыть задачу, работы по которой нет.
                checkOnPhaseBranchFn: () => ({ ok: false, sha, message: `SHA ${sha}` }),
                applySessionRequestsFn,
                runClaudeFn: () => 0,
                pushEventFn,
            }),
        );
        expect(applySessionRequestsFn).not.toHaveBeenCalled();
        expect(pushEventFn.mock.calls[0][0]).toContain(sha);
    });

    it('задача 11: сессия упала И ушла с ветки → диагностика падения не потеряна, стоп общий', () => {
        const logs: string[] = [];
        const handleCrashedCoderSessionFn = vi.fn<HandleCrashedCoderSessionFake>(() => ({
            stop: false,
        }));
        const applySessionRequestsFn = vi.fn(() => ({ applied: 0, failed: false }));
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                checkOnPhaseBranchFn: () => ({
                    ok: false,
                    sha: 'e'.repeat(40),
                    message: 'вне ветки',
                }),
                handleCrashedCoderSessionFn,
                applySessionRequestsFn,
                runClaudeFn: () => 1,
                pushEventFn,
            }),
        );
        // Разбор падения пишет вывод сессии на диск — без него диагноз потерян навсегда.
        expect(handleCrashedCoderSessionFn).toHaveBeenCalledTimes(1);
        // Но решение о стопе принимает страж: код сессии на него не влияет.
        expect(applySessionRequestsFn).not.toHaveBeenCalled();
    });

    it('задача 11: падение плюс уход с ветки — ОДИН пуш, а не два', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        // Реалистичный разбор падения: он и сам умеет пушить (код 126/127, грязное дерево).
        const handleCrashedCoderSessionFn = vi.fn<HandleCrashedCoderSessionFake>(
            (_issue, _code, _out, o) => {
                (o as { pushEventFn?: (m: string) => void }).pushEventFn?.('падение сессии');
                return { stop: true };
            },
        );
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                checkOnPhaseBranchFn: () => ({
                    ok: false,
                    sha: 'f'.repeat(40),
                    message: 'вне ветки',
                }),
                handleCrashedCoderSessionFn,
                runClaudeFn: () => 1,
                pushEventFn,
            }),
        );
        // Одно уведомление вместо двух — и разбор падения в нём НЕ потерян: его текст
        // (путь к выводу сессии, грязное дерево, причина) перехвачен и вклеен.
        //
        // Барьер узкий и назван честно: он про пуш РАЗБОРА ПАДЕНИЯ. Сам рантайм кодера
        // умеет пушить раньше — про недоступность, — и это отдельный инцидент, а не
        // дубликат этого (ревью, 3-й проход).
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toContain('падение сессии');
        expect(pushEventFn.mock.calls[0][0]).toMatch(/код сессии 1/);
        expect(handleCrashedCoderSessionFn).toHaveBeenCalledTimes(1);
    });

    it('задача 11: устаревшие намерения снимаются, а не ждут следующей сессии', () => {
        const logs: string[] = [];
        const removeSessionRequestsFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                checkOnPhaseBranchFn: () => ({
                    ok: false,
                    sha: 'a'.repeat(40),
                    message: 'вне ветки',
                }),
                readSessionRequestsFn: () => '{"kind":"close","issue":7}\n',
                removeSessionRequestsFn,
                runClaudeFn: () => 0,
                pushEventFn: vi.fn(),
            }),
        );
        // Иначе барьер откладывал бы ложное закрытие на итерацию, а не отменял его.
        expect(removeSessionRequestsFn).toHaveBeenCalledTimes(1);
        // Воля сессии не теряется молча — её текст уходит в лог.
        expect(logs.join('\n')).toContain('"kind":"close"');
    });

    it('задача 11: снять намерения не удалось — уведомление говорит это, а не врёт', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                checkOnPhaseBranchFn: () => ({
                    ok: false,
                    sha: 'a'.repeat(40),
                    message: 'вне ветки',
                }),
                readSessionRequestsFn: () => '{"kind":"close","issue":7}\n',
                removeSessionRequestsFn: () => {
                    throw new Error('EACCES');
                },
                runClaudeFn: () => 0,
                pushEventFn,
            }),
        );
        // Отказ fs не убивает петлю ДО уведомления и не оставляет его врущим.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/снять НЕ удалось/);
    });

    it('задача 11: намерения не прочитались — снимаем вслепую, а не пропускаем', () => {
        const logs: string[] = [];
        const removeSessionRequestsFn = vi.fn();
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                checkOnPhaseBranchFn: () => ({
                    ok: false,
                    sha: 'a'.repeat(40),
                    message: 'вне ветки',
                }),
                readSessionRequestsFn: () => {
                    throw new Error('EIO');
                },
                removeSessionRequestsFn,
                runClaudeFn: () => 0,
                pushEventFn,
            }),
        );
        // Файл, чьё содержимое неизвестно, опаснее файла, чьё содержимое потеряно: отказ
        // чтения не должен уводить мимо снятия — иначе старое `close` доживёт до запуска.
        expect(removeSessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).not.toMatch(/снять НЕ удалось/);
    });

    it('задача 11: в DRY ни постановка, ни страж git не трогают', () => {
        const logs: string[] = [];
        const ensurePhaseBranchFn = vi.fn(() => ({
            kind: 'created' as const,
            branch: 'feature/m1',
            sha: 'a'.repeat(40),
        }));
        const checkOnPhaseBranchFn = vi.fn(() => ({ ok: true }));
        const removeSessionRequestsFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                dry: true,
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                ensurePhaseBranchFn,
                checkOnPhaseBranchFn,
                removeSessionRequestsFn,
                runClaudeFn: () => 0,
            }),
        );
        expect(ensurePhaseBranchFn).not.toHaveBeenCalled();
        expect(checkOnPhaseBranchFn).not.toHaveBeenCalled();
        // Снятие намерений живёт внутри отказа стража, а стража в DRY нет вовсе:
        // удалить файл в сухом прогоне значило бы потерять его без единой мутации.
        expect(removeSessionRequestsFn).not.toHaveBeenCalled();
    });

    it('no-progress breaker (AFK): HEAD не сдвинулся и очередь та же → стоп, пуш', () => {
        const logs: string[] = [];
        const state = mkState({ noProgress: 2 }); // +1 на этой итерации = 3 = порог
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                shFn: () => 'SAME_HEAD', // headBefore === headAfter → нет коммитов
                runClaudeFn: () => 0,
                pushEventFn,
            }),
        );
        expect(state.noProgress).toBe(0); // сброшен перед стопом
        // #86: событие «circuit breaker открылся» уходит пушем (единственный логгер).
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/Ralph: circuit breaker.*об стену/s);
        // #289: та же причина «breaker», что у лимита итераций — оба класса circuit breaker.
        expect(pushEventFn.mock.calls[0][0]).toContain('(breaker)');
        // Ревью #289: от заголовка диагноз отличается номером карточки — он и остался.
        expect(pushEventFn.mock.calls[0][0]).toMatch(
            /диагноз: 3 итераций подряд без коммита и без закрытого issue \(Issue #7\)/,
        );
    });

    // #97: сбой чтения при оценке прогресса раньше засчитывался прогрессом и обнулял
    // noProgress — сеть прятала стену. Теперь он «неизвестно»: одиночный переживается, серия
    // длиной maxProgressUnknown — стоп с причиной и пушем.
    describe('#97: серия «прогресс неизвестен»', () => {
        // HEAD до сессии читается, после — нет: каждая итерация кончается неизвестным.
        const headUnreadableAfter = () => {
            let reads = 0;
            return (cmd: string) => {
                if (cmd !== 'git rev-parse HEAD') return '';
                if (++reads % 2 === 0) throw new Error('git молчит');
                return 'SAME_HEAD';
            };
        };

        it('N подряд «неизвестно» → стоп с причиной и пушем; N — из конфига', () => {
            const logs: string[] = [];
            const state = mkState({ noProgress: 1 });
            const pushEventFn = vi.fn();
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg({ maxProgressUnknown: 2 }),
                ctx(state),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: headUnreadableAfter(),
                    runClaudeFn,
                    pushEventFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(2);
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            const msg = String(pushEventFn.mock.calls[0][0]);
            expect(msg).toContain('(forge-unreadable)');
            expect(msg).toMatch(/2 итераций подряд не прочитались HEAD или очередь \(Issue #7\)/);
            expect(msg).toContain('git молчит');
            // Неизвестное не засчитано ни в прогресс, ни в «стоим»: серия до сбоя цела.
            expect(state.noProgress).toBe(1);
            expect(logs.join('\n')).toMatch(/Прогресс итерации неизвестен \(1\/2 подряд\)/);
        });

        it('дефолт порога — 3', () => {
            const pushEventFn = vi.fn();
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: headUnreadableAfter(),
                    runClaudeFn,
                    pushEventFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(3);
            expect(String(pushEventFn.mock.calls[0][0])).toMatch(
                /3 итераций подряд не прочитались/,
            );
        });

        it('от противного: удачное чтение между сбоями обнуляет серию — стопа нет', () => {
            const pushEventFn = vi.fn();
            let reads = 0;
            let sessions = 0;
            // После каждой сессии нечётной — сбой, чётной — HEAD сдвинулся (прогресс).
            const shFn = (cmd: string) => {
                if (cmd !== 'git rev-parse HEAD') return '';
                reads++;
                if (reads % 2 === 1) return `H${String(reads)}`;
                if (sessions % 2 === 1) throw new Error('git молчит');
                return `MOVED${String(reads)}`;
            };
            runLoop(
                // maxSameIssue выше числа итераций: иначе петлю остановил бы брейкер серии по
                // карточке раньше, и проба не различила бы, чем кончилась серия.
                validCfg({ maxProgressUnknown: 2, maxIterations: 4, maxSameIssue: 5 }),
                { ...ctx(mkState()), maxIterations: 4 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn,
                    runClaudeFn: vi.fn(() => {
                        sessions++;
                        return 0;
                    }),
                    pushEventFn,
                }),
            );
            // Точное число: петля прошла все итерации, а не встала другим стопом раньше.
            expect(sessions).toBe(4);
            // По коду причины, а не по заголовку: заголовок переписать дешевле, чем причину.
            expect(
                pushEventFn.mock.calls.some((c) => String(c[0]).includes('(forge-unreadable)')),
            ).toBe(false);
        });

        // HEAD не прочитался ДО сессии: прежде блок оценки пропускался целиком, и такая
        // итерация была невидима и для «стоим», и для серии «неизвестно».
        it('сбой чтения HEAD до сессии — тоже «неизвестно», серия доходит до стопа', () => {
            const logs: string[] = [];
            const state = mkState({ noProgress: 1 });
            const pushEventFn = vi.fn();
            const runClaudeFn = vi.fn(() => 0);
            let reads = 0;
            runLoop(
                validCfg({ maxProgressUnknown: 2 }),
                ctx(state),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: (cmd: string) => {
                        if (cmd !== 'git rev-parse HEAD') return '';
                        if (++reads % 2 === 1) throw new Error('git молчит до сессии');
                        return 'SAME_HEAD';
                    },
                    runClaudeFn,
                    pushEventFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(2);
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            const msg = String(pushEventFn.mock.calls[0][0]);
            expect(msg).toContain('(forge-unreadable)');
            expect(msg).toContain('git молчит до сессии');
            expect(state.noProgress).toBe(1);
        });

        it.each([0, -1, 2.5, '3', null])(
            'битый maxProgressUnknown (%j) — стоп на старте с причиной, а не дефолт',
            (v) => {
                const failFn = (msg: string) => {
                    throw new Error(msg);
                };
                expect(() =>
                    ralph.resolveMaxProgressUnknown({ maxProgressUnknown: v } as never, failFn),
                ).toThrow(/maxProgressUnknown = .* целое положительное/);
            },
        );
    });

    // #67: сессия прислала close + битое необязательное намерение — батч отвергнут целиком,
    // карточка осталась открытой, следующая итерация взяла её же. HEAD при этом двигается
    // каждую итерацию (коммиты сессии), так что noProgress круг не видит.
    describe('#67: брейкер серии по одному issue', () => {
        const movingHead = () => {
            let n = 0;
            return () => `HEAD_${String(n++)}`;
        };

        it('три круга по одной карточке → стоп перед четвёртым, причина названа', () => {
            const logs: string[] = [];
            const state = mkState();
            const pushEventFn = vi.fn();
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg(),
                ctx(state),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    applySessionRequestsFn: () => ({ applied: 0, failed: true }),
                    pushEventFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(3);
            // Стоп до спавна: четвёртая итерация не потрачена.
            expect(state.count).toBe(3);
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            const msg = String(pushEventFn.mock.calls[0][0]);
            expect(msg).toContain('(breaker)');
            expect(msg).toMatch(/Issue #7 взят 3 итерации подряд/);
            // Последний батч намерений по карточке не применился — вероятная причина, но
            // названа нейтрально: `failed` бывает не только у отказа разбора.
            expect(msg).toMatch(/батч намерений применён не до конца/);
            expect(msg).not.toMatch(/отказ разбора/);
        });

        it('намерения применились, но карточка осталась открытой — стоп тот же, без ложной причины', () => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    pushEventFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(3);
            const msg = String(pushEventFn.mock.calls[0][0]);
            expect(msg).toMatch(/Issue #7 взят 3 итерации подряд/);
            expect(msg).not.toMatch(/батч намерений|выбыло/);
        });

        // #124: отказ разбора детерминирован. Без карантина следующая сессия дописывала
        // свои намерения в тот же файл, разбор отвергал его из-за старой строки, и close
        // не применялся до брейкера серии — итерации сгорали гарантированно впустую.
        describe('#124: отвергнутый разбором батч не отравляет следующую сессию', () => {
            // Файл намерений в памяти и НАСТОЯЩЕЕ применение поверх него: проверяется
            // связка «разбор → карантин → следующий батч», а не заглушка шва.
            const intentFile = (quarantineFails = false) => {
                const f = { text: null as string | null, quarantined: [] as string[] };
                const closed: number[] = [];
                const quarantineFn = vi.fn(() => {
                    if (quarantineFails) throw new Error('EACCES');
                    f.quarantined.push(f.text ?? '');
                    f.text = null;
                    return '/state/ralph.requests.jsonl.rejected-1';
                });
                const apply = (a: Record<string, unknown>) =>
                    ralph.applySessionRequests({
                        ...(a as Parameters<typeof ralph.applySessionRequests>[0]),
                        readFn: () => f.text,
                        writeFn: (t: string) => (f.text = t),
                        removeFn: () => (f.text = null),
                        sleepFn: () => {},
                        taskSource: {
                            commentOnIssue: () => {},
                            closeIssue: (n: number) => closed.push(n),
                        } as never,
                    });
                const append = (line: string) => (f.text = `${f.text ?? ''}${line}\n`);
                return { f, closed, quarantineFn, apply, append };
            };

            it('незнакомая живая проба — refusal live-probe-unavailable с парой пробы', () => {
                const { f, apply, quarantineFn } = intentFile();
                f.text = `${JSON.stringify({ kind: 'live-probe', issue: 7, cli: 'claude', case: 'нет-такого' })}\n`;

                const result = apply({
                    cfg: validCfg(),
                    currentMilestone: 'Ralph · Ф18',
                    quarantineFn,
                    logFn: () => {},
                    pushEventFn: () => {},
                });

                expect(result.rejected?.refusal?.code).toBe('live-probe-unavailable');
                expect(result.rejected?.refusal?.params.case).toBe('нет-такого');
                expect(result.rejected?.refusal?.params.cli).toBe('claude');
            });

            it('другая ошибка разбора — refusal intent-rejected', () => {
                const { f, apply, quarantineFn } = intentFile();
                f.text = `${JSON.stringify({ kind: 'close', issue: '7', comment: 'готово' })}\n`;

                const result = apply({
                    cfg: validCfg(),
                    currentMilestone: 'Ralph · Ф18',
                    quarantineFn,
                    logFn: () => {},
                    pushEventFn: () => {},
                });

                expect(result.rejected?.refusal?.code).toBe('intent-rejected');
            });

            it('сырое значение из ошибки редактируется до refusal и не становится identity', () => {
                const { f, apply, quarantineFn } = intentFile();
                const secret = ['fixture', 'refusal', '0123456789abcdef'].join('-');
                vi.stubEnv('RALPH_TEST_REFUSAL_SECRET', secret);
                f.text = `${JSON.stringify({ kind: 'close', issue: secret, comment: 'готово' })}\n`;

                let result: ReturnType<typeof ralph.applySessionRequests>;
                try {
                    result = apply({
                        cfg: validCfg(),
                        currentMilestone: 'Ralph · Ф18',
                        quarantineFn,
                        logFn: () => {},
                        pushEventFn: () => {},
                        secretEnvNamesFn: () => ['RALPH_TEST_REFUSAL_SECRET'],
                    });
                } finally {
                    vi.unstubAllEnvs();
                }

                expect(result.rejected?.refusal?.params).toEqual({ what: 'issue-number' });
                expect(JSON.stringify(result.rejected?.refusal)).not.toContain(secret);
                expect(result.rejected?.refusal?.reason).toContain('***');
            });

            it.each([
                {
                    name: 'обычная ошибка исправления заменяет отказ неизвестной пробы',
                    original: { kind: 'live-probe', issue: 7, cli: 'claude', case: 'нет-такого' },
                    repaired: { kind: 'close', issue: '7', comment: 'готово' },
                    code: 'intent-rejected',
                },
                {
                    name: 'неизвестная проба исправления заменяет обычную ошибку',
                    original: { kind: 'close', issue: '7', comment: 'готово' },
                    repaired: { kind: 'live-probe', issue: 7, cli: 'claude', case: 'нет-такого' },
                    code: 'live-probe-unavailable',
                },
            ])('$name', ({ original, repaired, code }) => {
                const { f, apply, quarantineFn } = intentFile();
                f.text = `${JSON.stringify(original)}\n`;

                const result = apply({
                    cfg: validCfg(),
                    currentMilestone: 'Ralph · Ф18',
                    quarantineFn,
                    logFn: () => {},
                    pushEventFn: () => {},
                    repairFn: () => ({ ok: true, text: `${JSON.stringify(repaired)}\n` }),
                });

                expect(result.rejected?.refusal?.code).toBe(code);
            });

            it('секрет не попадает в событие и логи исходного батча и исправления', () => {
                const { f, apply, quarantineFn } = intentFile();
                const secret = ['fixture', 'repair', '0123456789abcdef'].join('-');
                vi.stubEnv('RALPH_TEST_REFUSAL_SECRET', secret);
                const rejected = `${JSON.stringify({ kind: 'close', issue: secret, comment: 'готово' })}\n`;
                f.text = rejected;
                const logs: string[] = [];
                const pushes: string[] = [];

                try {
                    apply({
                        cfg: validCfg(),
                        currentMilestone: 'Ralph · Ф18',
                        quarantineFn,
                        logFn: (message: string) => logs.push(message),
                        pushEventFn: (message: string) => pushes.push(message),
                        repairFn: () => ({ ok: true, text: rejected }),
                        secretEnvNamesFn: () => ['RALPH_TEST_REFUSAL_SECRET'],
                    });
                } finally {
                    vi.unstubAllEnvs();
                }

                expect(logs).toHaveLength(2);
                expect(logs[0]).toContain('Отвергнутое исправление:');
                expect(logs[1]).toContain('Отвергнутый батч намерений:');
                expect(pushes).toHaveLength(1);
                const messages = [...logs, ...pushes].join('\n');
                expect(messages).not.toContain(secret);
                expect(messages).toContain('***');
            });

            const sessions = (append: (l: string) => void) => {
                let n = 0;
                return vi.fn(() => {
                    n++;
                    // Первая сессия пишет битую строку (issue строкой), вторая — верный close.
                    append(
                        n === 1
                            ? '{"kind":"close","issue":"7","comment":"готово"}'
                            : '{"kind":"close","issue":7,"comment":"готово"}',
                    );
                    return 0;
                });
            };

            it('битый файл после первой сессии, верный close второй — close применён', () => {
                const { f, closed, quarantineFn, apply, append } = intentFile();
                const pushEventFn = vi.fn();
                const runClaudeFn = sessions(append);
                const logs: string[] = [];
                runLoop(
                    validCfg({ maxIterations: 2 }),
                    { ...ctx(mkState()), maxIterations: 2 },
                    deps(logs, {
                        phaseIndexOfFn: () => 0,
                        openIssuesFn: () =>
                            closed.includes(7) ? [] : [{ number: 7, title: 't', labels: [] }],
                        shFn: movingHead(),
                        runClaudeFn,
                        applySessionRequestsFn: apply,
                        quarantineSessionRequestsFn: quarantineFn,
                        pushEventFn,
                    }),
                );
                expect(runClaudeFn).toHaveBeenCalledTimes(2);
                expect(closed).toEqual([7]);
                expect(quarantineFn).toHaveBeenCalledTimes(1);
                // В карантин ушла ровно отвергнутая строка, а не close второй сессии.
                expect(f.quarantined).toEqual([
                    '{"kind":"close","issue":"7","comment":"готово"}\n',
                ]);
                const first = String(pushEventFn.mock.calls[0][0]);
                expect(first).toContain('/state/ralph.requests.jsonl.rejected-1');
                expect(first).not.toContain('оставлен как есть');
                // Текст отвергнутого батча — в логе: карантинный файл могут убрать.
                expect(logs.join('\n')).toContain('"issue":"7"');
            });

            it('карантин не удался — стоп после первого отказа, а не через maxSameIssue', () => {
                const { quarantineFn, apply, append, closed } = intentFile(true);
                const pushEventFn = vi.fn();
                const runClaudeFn = sessions(append);
                const state = mkState();
                runLoop(
                    validCfg(),
                    ctx(state),
                    deps([], {
                        phaseIndexOfFn: () => 0,
                        openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                        shFn: movingHead(),
                        runClaudeFn,
                        applySessionRequestsFn: apply,
                        quarantineSessionRequestsFn: quarantineFn,
                        pushEventFn,
                    }),
                );
                expect(runClaudeFn).toHaveBeenCalledTimes(1);
                expect(closed).toEqual([]);
                expect(pushEventFn).toHaveBeenCalledTimes(1);
                const msg = String(pushEventFn.mock.calls[0][0]);
                expect(msg).toContain('(intent-rejected)');
                expect(msg).toContain('EACCES');
                expect(msg).not.toContain('(breaker)');
            });

            it('от противного: без карантина круг доходит до брейкера серии', () => {
                const { apply, append, closed } = intentFile();
                const pushEventFn = vi.fn();
                const runClaudeFn = sessions(append);
                runLoop(
                    validCfg(),
                    ctx(mkState()),
                    deps([], {
                        phaseIndexOfFn: () => 0,
                        openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                        shFn: movingHead(),
                        runClaudeFn,
                        // Проводка карантина снята: применение получает quarantineFn undefined.
                        applySessionRequestsFn: (a: Record<string, unknown>) =>
                            apply({ ...a, quarantineFn: undefined }),
                        pushEventFn,
                    }),
                );
                expect(runClaudeFn).toHaveBeenCalledTimes(3);
                expect(closed).toEqual([]);
                expect(String(pushEventFn.mock.calls.at(-1)?.[0])).toContain('(breaker)');
            });
        });

        it('порог из конфига (maxSameIssue)', () => {
            const logs: string[] = [];
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg({ maxSameIssue: 2 }),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    pushEventFn: vi.fn(),
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(2);
        });

        it('выбывшее close (#41) названо причиной круга, хотя батч не failed', () => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn: vi.fn(() => 0),
                    applySessionRequestsFn: () => ({
                        applied: 0,
                        failed: false,
                        dropped: [{ kind: 'close', what: 'close #7 — HTTP 403' }],
                    }),
                    pushEventFn,
                }),
            );
            const msg = String(pushEventFn.mock.calls[0][0]);
            expect(msg).toMatch(/`close` выбыло.*close #7 — HTTP 403/s);
        });

        it.each([['5'], [0], [-1], [2.5]])(
            'битый maxSameIssue (%j) — стоп на старте с причиной, а не дефолт',
            (v) => {
                const failFn = vi.fn((m: string) => {
                    throw new Error(m);
                });
                expect(() =>
                    ralph.resolveMaxSameIssue({ maxSameIssue: v } as never, failFn),
                ).toThrow(/maxSameIssue = .* целое положительное/);
            },
        );

        it.each([0, -1, 1.5, '2', null])(
            'битый maxSameRefusal (%j) — стоп на старте с причиной, а не дефолт',
            (v) => {
                const failFn = vi.fn((m: string) => {
                    throw new Error(m);
                });
                expect(() =>
                    ralph.resolveMaxSameRefusal({ maxSameRefusal: v } as never, failFn),
                ).toThrow(/maxSameRefusal = .* целое положительное/);
            },
        );

        it('maxSameRefusal без ключа — 2, целое положительное значение сохраняется', () => {
            const failFn = vi.fn();
            expect(ralph.resolveMaxSameRefusal({} as never, failFn)).toBe(2);
            expect(ralph.resolveMaxSameRefusal({ maxSameRefusal: 3 } as never, failFn)).toBe(3);
            expect(failFn).not.toHaveBeenCalled();
        });

        it.each([0, -1, 1.5, '3'])(
            'битый review.maxFixPlans (%j) — стоп на старте с именем ключа',
            (v) => {
                const failFn = vi.fn((m: string) => {
                    throw new Error(m);
                });
                expect(() =>
                    ralph.resolveMaxFixPlans({ review: { maxFixPlans: v } } as never, failFn),
                ).toThrow(/review\.maxFixPlans = .* целое положительное/);
            },
        );

        it('review.maxFixPlans без ключа — 4, целое положительное значение сохраняется', () => {
            const failFn = vi.fn();
            expect(ralph.resolveMaxFixPlans({} as never, failFn)).toBe(4);
            expect(ralph.resolveMaxFixPlans({ review: {} } as never, failFn)).toBe(4);
            expect(ralph.resolveMaxFixPlans({ review: { maxFixPlans: 3 } } as never, failFn)).toBe(
                3,
            );
            expect(failFn).not.toHaveBeenCalled();
        });

        it('maxSameIssue ниже coderTurnRetries + 1 — стоп на старте, а не молчаливый подъём', () => {
            const failFn = vi.fn((m: string) => {
                throw new Error(m);
            });
            expect(() =>
                ralph.resolveMaxSameIssue(
                    { maxSameIssue: 2, coderTurnRetries: 3 } as never,
                    failFn,
                ),
            ).toThrow(/ниже coderTurnRetries \+ 1 = 4/);
            // Ключа нет — дефолт не ниже числа законных заходов.
            expect(ralph.resolveMaxSameIssue({ coderTurnRetries: 3 } as never, failFn)).toBe(4);
        });

        it('порог не режет повторы по бюджету ходов (coderTurnRetries)', () => {
            const logs: string[] = [];
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg({ maxSameIssue: 4, coderTurnRetries: 3 }),
                ctx(mkState()),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    pushEventFn: vi.fn(),
                }),
            );
            // Первая сессия + три повтора по ходам = четыре захода на карточку.
            expect(runClaudeFn).toHaveBeenCalledTimes(4);
        });

        it('чередование карточек серию сбрасывает — брейкер не срабатывает', () => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            const runClaudeFn = vi.fn(() => 0);
            const seq = [7, 7, 8, 7, 7, 8];
            runLoop(
                validCfg(),
                ctx(mkState(), { maxIterations: 6 }),
                deps(logs, {
                    phaseIndexOfFn: () => 0,
                    // 7, 7, 8, 7, 7, 8 — ни одна карточка не берётся трижды подряд.
                    // Очередь зовётся и до сессии, и после (оценка прогресса), поэтому
                    // номер берётся по числу уже прошедших сессий, а не по числу вызовов.
                    openIssuesFn: () => [
                        {
                            number: seq[Math.min(runClaudeFn.mock.calls.length, 5)],
                            title: 't',
                            labels: [],
                        },
                    ],
                    shFn: movingHead(),
                    runClaudeFn,
                    pushEventFn,
                }),
            );
            expect(runClaudeFn).toHaveBeenCalledTimes(6);
            expect(pushEventFn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(
                /подряд/,
            );
        });
    });

    describe('Фаза 18: серия отказов в state', () => {
        const movingHead = () => {
            let n = 0;
            return () => `HEAD_${String(n++)}`;
        };
        const rejectedWith = (refusal: {
            code: 'intent-rejected' | 'live-probe-unavailable';
            params: Record<string, string>;
            reason: string;
        }) => ({
            applied: 0,
            failed: true,
            rejected: { quarantined: '/q/1', refusal },
        });
        const rejectedResult = () =>
            rejectedWith({ code: 'intent-rejected', params: { what: 'x' }, reason: 'x' });

        it('отказ кодер-итерации записывает серию и доказательство в state', () => {
            const state = mkState();
            runLoop(
                validCfg({ maxIterations: 1 }),
                { ...ctx(state), maxIterations: 1 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn: () => 0,
                    applySessionRequestsFn: rejectedResult,
                }),
            );

            expect(state.refusalSeries).toMatchObject({
                count: 1,
                evidence: '/q/1',
                attemptShas: [expect.any(String)],
            });
        });

        it('два одинаковых отказа увеличивают одну серию', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg({ maxIterations: 2 }),
                { ...ctx(state), maxIterations: 2 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    applySessionRequestsFn: rejectedResult,
                }),
            );

            expect(state.refusalSeries).toMatchObject({ count: 2 });
            expect(runClaudeFn).toHaveBeenCalledTimes(2);
        });

        it('два одинаковых отказа останавливают петлю до третьей сессии', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            const pushEventFn = vi.fn();
            runLoop(
                validCfg({ maxIterations: 5 }),
                { ...ctx(state), maxIterations: 5 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    applySessionRequestsFn: rejectedResult,
                    pushEventFn,
                }),
            );

            expect(runClaudeFn).toHaveBeenCalledTimes(2);
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            const message = String(pushEventFn.mock.calls[0][0]);
            expect(message).toContain('повтор одного отказа');
            expect(message).toContain('Issue #7');
            expect(message).toContain('intent-rejected');
            expect(message).toContain('/q/1');
            expect(state.refusalSeries).toBeNull();
            expect(state.count).toBe(2);
        });

        it('серия переживает рестарт и останавливает следующий прогон', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            const pushEventFn = vi.fn();
            const shFn = movingHead();
            const loopDeps = () =>
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn,
                    runClaudeFn,
                    applySessionRequestsFn: rejectedResult,
                    pushEventFn,
                });
            runLoop(
                validCfg({ maxIterations: 1 }),
                { ...ctx(state), maxIterations: 1 },
                loopDeps(),
            );
            runLoop(
                validCfg({ maxIterations: 5 }),
                { ...ctx(state), maxIterations: 5 },
                loopDeps(),
            );

            expect(runClaudeFn).toHaveBeenCalledTimes(2);
            const stops = pushEventFn.mock.calls.filter((call) =>
                String(call[0]).includes('повтор одного отказа'),
            );
            expect(stops).toHaveLength(1);
            expect(state.refusalSeries).toBeNull();
        });

        it('разные отказы не останавливают петлю', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            const pushEventFn = vi.fn();
            let applyCalls = 0;
            runLoop(
                validCfg({ maxIterations: 2 }),
                { ...ctx(state), maxIterations: 2 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    applySessionRequestsFn: () => {
                        const what = ++applyCalls === 1 ? 'a' : 'b';
                        return rejectedWith({
                            code: 'intent-rejected',
                            params: { what },
                            reason: what,
                        });
                    },
                    pushEventFn,
                }),
            );

            expect(runClaudeFn).toHaveBeenCalledTimes(2);
            expect(pushEventFn.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(
                'повтор одного отказа',
            );
            expect(state.refusalSeries).toMatchObject({ count: 1, params: { what: 'b' } });
        });

        it('недоступная живая проба останавливает петлю после первой сессии', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            const pushEventFn = vi.fn();
            runLoop(
                validCfg({ maxIterations: 5 }),
                { ...ctx(state), maxIterations: 5 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    applySessionRequestsFn: () =>
                        rejectedWith({
                            code: 'live-probe-unavailable',
                            params: { cli: 'claude', case: 'нет-такого' },
                            reason: 'пробы нет в каталоге',
                        }),
                    coreSha: 'core-revision-1',
                    pushEventFn,
                }),
            );

            expect(runClaudeFn).toHaveBeenCalledTimes(1);
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            const message = String(pushEventFn.mock.calls[0][0]);
            expect(message).toContain('нет в каталоге установленного раннера');
            expect(message).toContain('live-probe-unavailable');
            expect(message).toContain('Ревизия установки: core-revision-1');
            expect(state.refusalSeries).toBeNull();
            expect(state.count).toBe(1);
        });

        it('maxSameRefusal из конфига разрешает три отказа до стопа', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            const pushEventFn = vi.fn();
            runLoop(
                validCfg({ maxIterations: 5, maxSameRefusal: 3 }),
                { ...ctx(state), maxIterations: 5 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn,
                    applySessionRequestsFn: rejectedResult,
                    pushEventFn,
                }),
            );

            expect(runClaudeFn).toHaveBeenCalledTimes(3);
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            expect(String(pushEventFn.mock.calls[0][0])).toContain('maxSameRefusal = 3');
            expect(state.refusalSeries).toBeNull();
            expect(state.count).toBe(3);
        });

        it('подтверждённое применение намерений сбрасывает серию', () => {
            const state = mkState();
            let applyCalls = 0;
            runLoop(
                validCfg({ maxIterations: 2 }),
                { ...ctx(state), maxIterations: 2 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn: () => 0,
                    applySessionRequestsFn: () =>
                        ++applyCalls === 1 ? rejectedResult() : { applied: 1, failed: false },
                }),
            );

            expect(state.refusalSeries).toBeNull();
        });

        it('код 0 без применённых намерений серию не сбрасывает', () => {
            const state = mkState();
            let applyCalls = 0;
            runLoop(
                validCfg({ maxIterations: 2 }),
                { ...ctx(state), maxIterations: 2 },
                deps([], {
                    phaseIndexOfFn: () => 0,
                    openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                    shFn: movingHead(),
                    runClaudeFn: () => 0,
                    applySessionRequestsFn: () =>
                        ++applyCalls === 1 ? rejectedResult() : { applied: 0, failed: false },
                }),
            );

            expect(state.refusalSeries).toMatchObject({ count: 1 });
        });

        it('ошибка записи серии останавливает петлю', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            expect(() =>
                runLoop(
                    validCfg({ maxIterations: 2 }),
                    { ...ctx(state), maxIterations: 2 },
                    deps([], {
                        phaseIndexOfFn: () => 0,
                        openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                        shFn: movingHead(),
                        runClaudeFn,
                        applySessionRequestsFn: rejectedResult,
                        saveStateFn: (saved: FakeState) => {
                            if (saved.refusalSeries != null) throw new Error('ENOSPC');
                        },
                    }),
                ),
            ).toThrow('ENOSPC');
            expect(runClaudeFn).toHaveBeenCalledTimes(1);
        });

        it('ошибка записи сброса серии тоже не глотается', () => {
            const state = mkState();
            const runClaudeFn = vi.fn(() => 0);
            let applyCalls = 0;
            expect(() =>
                runLoop(
                    validCfg({ maxIterations: 2 }),
                    { ...ctx(state), maxIterations: 2 },
                    deps([], {
                        phaseIndexOfFn: () => 0,
                        openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                        shFn: movingHead(),
                        runClaudeFn,
                        applySessionRequestsFn: () =>
                            ++applyCalls === 1 ? rejectedResult() : { applied: 1, failed: false },
                        saveStateFn: (saved: FakeState) => {
                            if (applyCalls === 2 && saved.refusalSeries === null) {
                                throw new Error('ENOSPC on reset');
                            }
                        },
                    }),
                ),
            ).toThrow('ENOSPC on reset');
            expect(runClaudeFn).toHaveBeenCalledTimes(2);
        });
    });

    it('пустая очередь, но открыты blocked/чужие issues → сдача отложена, гейт не зовётся', () => {
        const logs: string[] = [];
        const tryMergePhaseFn = vi.fn(() => 'merged');
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [{ number: 9, author: { login: 'stranger' } }],
                tryMergePhaseFn,
            }),
        );
        expect(logs.join('\n')).toMatch(/вне очереди|отложена/);
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
    });

    // #40: намерения сессии применяет петля. Тест на ПРОВОДКУ: без него применение можно
    // было бы выкинуть из цикла, и все тесты применения ниже остались бы зелёными —
    // ровно тот класс дыры, что закрывал #135 для контекста ревью.
    it('#40 после кодер-сессии применяются намерения — до разбора её падения', () => {
        const logs: string[] = [];
        const order: string[] = [];
        const applySessionRequestsFn = vi.fn(() => {
            order.push('apply');
            return { applied: 1, failed: false };
        });
        const handleCrashedCoderSessionFn = vi.fn(() => {
            order.push('crash');
            return { stop: true };
        });
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                // Сессия умерла по maxTurns — но написать «ставь blocked» успела.
                runClaudeFn: () => 143,
                applySessionRequestsFn,
                handleCrashedCoderSessionFn,
            }),
        );
        expect(applySessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['apply', 'crash']);
    });

    // #45: вердикт ревью доезжает до PR намерениями, и гейт читает МЕТКИ, а не файл-запрос.
    // Значит неприменённое намерение — это «блока для гейта нет»: фаза уедет в main с
    // дефектом, который ревью нашло. Раньше результат применения игнорировался, и сверка
    // метки сторожила только «не молча» (пуш был), но не «не смерджим».
    it('#45 намерения сессии не применились → сдача останавливается, гейт не зовётся', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn(() => 0);
        const tryMergePhaseFn = vi.fn(() => 'merged');
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                hasAnyIssuesFn: () => true,
                runClaudeFn,
                tryMergePhaseFn,
                applySessionRequestsFn: () => ({ applied: 0, failed: true }),
            }),
        );
        // В AFK-прогоне мердж случился бы за минуты до того, как человек прочитает пуш —
        // поэтому здесь стоп, а не предупреждение.
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/намерения сессии.*не применились/i);
    });

    // #226: рестарт после стопа на неразобранном батче шёл сразу в гейт, и PR мерджился
    // поверх неприменённых `pr-comment` к нему. Хвост применяется ПОСЛЕДНИМ шагом до гейта,
    // с контекстом фазы, — тогда комментарий ложится в PR, а блок ставит метку для гейта.
    const submitDeps = (over: Record<string, unknown>) => ({
        openIssuesFn: () => [],
        allOpenIssuesFn: () => [],
        hasAnyIssuesFn: () => true,
        phaseMergedFn: () => false,
        pickReviewModelFn: () => 'none',
        runClaudeFn: () => 0,
        ...over,
    });
    it('#226 хвост PR-намерений применяется с фазой ДО мерджа', () => {
        const order: string[] = [];
        const applySessionRequestsFn = vi.fn((args: { phase?: { branch: string } }) => {
            order.push(`apply:${args.phase?.branch ?? '—'}`);
            return {
                applied: 0,
                failed: false,
                closedIssues: [],
                prFindings: [],
                prBlocked: false,
            };
        });
        const tryMergePhaseFn = vi.fn(() => {
            order.push('gate');
            return 'merged';
        });
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], submitDeps({ applySessionRequestsFn, tryMergePhaseFn })),
        );
        expect(tryMergePhaseFn).toHaveBeenCalledTimes(1);
        const gateAt = order.indexOf('gate');
        expect(order[gateAt - 1]).toBe(`apply:${validCfg().phases[0].branch}`);
    });

    it('#226 хвост PR-намерений перед мерджем не применился → мердж не идёт', () => {
        // Сколько применений до гейта в штатной сдаче — последнее из них и есть хвост.
        let total = 0;
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(
                [],
                submitDeps({
                    applySessionRequestsFn: () => {
                        total += 1;
                        return { applied: 0, failed: false };
                    },
                    tryMergePhaseFn: () => 'merged',
                }),
            ),
        );
        expect(total).toBeGreaterThan(0);
        const logs: string[] = [];
        let n = 0;
        const tryMergePhaseFn = vi.fn(() => 'merged');
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(
                logs,
                submitDeps({
                    applySessionRequestsFn: () => {
                        n += 1;
                        return { applied: 0, failed: n === total };
                    },
                    tryMergePhaseFn,
                }),
            ),
        );
        expect(n).toBe(total);
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/хвост намерений перед мерджем.*не применились/);
    });

    // #39: milestone фазы без единой задачи (ни открытой, ни закрытой) выглядит для петли
    // ровно как сданная фаза — открытая очередь пуста в обоих случаях. Без барьера раннер
    // сжигает три сессии цикла сдачи (PR → ревью → правки) на ветке, которой не существует.
    it('#39 milestone без единой задачи → фаза не начата: стоп с пушем, сдача не запускается', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn(() => 0);
        const tryMergePhaseFn = vi.fn(() => 'merged');
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                hasAnyIssuesFn: () => false,
                runClaudeFn,
                tryMergePhaseFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        // Диагноз — именно «не начата», а не «issues закрыты»: два состояния различимы
        // человеком, читающим лог утром. Сообщение идёт пушем (боевой pushEvent пишет и
        // в лог) — остановка на ошибке конфигурации обязана дойти до человека, а не
        // утонуть в логе ночного прогона.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/НЕ начата/);
        expect(logs.join('\n')).not.toMatch(/issues закрыты/);
    });

    it('#39 сбой чтения «были ли задачи» → стоп (fail-closed) с пушем, сдача не запускается', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                hasAnyIssuesFn: () => {
                    throw new Error('форж недоступен');
                },
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        // Стоп по недоступному форжу — не тихий: ночной прогон иначе кончится тишиной.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/форж недоступен/);
    });

    it('#39 фаза смерджена без задач в milestone → идёт дальше, барьер не мешает', () => {
        // Порядок проверок: сначала «смерджена ли», потом «были ли задачи». Иначе фаза,
        // сделанная руками без карточек, вставала бы на рестарте намертво.
        const logs: string[] = [];
        const advancePhaseFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                hasAnyIssuesFn: () => false,
                phaseMergedFn: () => true,
                advancePhaseFn,
            }),
        );
        expect(advancePhaseFn).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/уже смерджена/);
        expect(logs.join('\n')).not.toMatch(/НЕ начата/);
    });

    // #220: стартовую фазу сверил preflight; фазу, в которую петля перешла, — первая вершина
    // цикла в ней, по разу на веху.
    it('#220: переход в веху с 11 карточками при лимите 10 → ⚠ при входе, стартовая не перечитана', () => {
        const logs: string[] = [];
        const asked: string[] = [];
        let idx = 0;
        runLoop(
            validCfg({
                maxIterations: 10,
                phases: [
                    { milestone: 'M1', branch: 'feature/m1' },
                    { milestone: 'M2', branch: 'feature/m2' },
                ],
            }),
            ctx(mkState()),
            deps(logs, {
                // Вершина 1 — M1 (смерджена), 2 — M2 (тоже), 3 — за концом списка.
                phaseIndexOfFn: () => idx++,
                openIssuesFn: () => [],
                allOpenIssuesFn: (m: string) => {
                    asked.push(m);
                    return m === 'M2'
                        ? Array.from({ length: 11 }, (_, k) => ({ number: k + 1, title: 'к' }))
                        : [];
                },
                phaseMergedFn: () => true,
                advancePhaseFn: vi.fn(),
            }),
        );
        expect(logs.join('\n')).toMatch(
            /⚠ Бюджет фазы "M2": открытых карточек 11 при maxIterations 10/,
        );
        expect(logs.join('\n')).not.toMatch(/Бюджет фазы "M1"/);
        expect(logs.filter((l) => l.includes('Бюджет фазы "M2"'))).toHaveLength(1);
        expect(asked).toContain('M2');
    });

    // #221: список фаз перечитывается на границе фаз. Фейк перечитывания — настоящий
    // `reconcilePhases` на «файле» теста; индекс фазы на вершине цикла ищется по ИМЕНИ в
    // cfg.phases, как у боевого phaseIndexOf, — иначе тест не увидел бы, что следующую
    // фазу выбрал свежий список, а не старый.
    describe('#221: список фаз на границе фаз', () => {
        const PHASES_OLD = [
            { milestone: 'M1', branch: 'feature/m1' },
            { milestone: 'M2', branch: 'feature/m2' },
        ];
        const PHASES_NEW = [
            { milestone: 'M1', branch: 'feature/m1' },
            { milestone: 'M1b', branch: 'feature/m1b' },
            { milestone: 'M2', branch: 'feature/m2' },
        ];
        const boundary = (
            cfg: { phases: Array<{ milestone: string; branch: string }> },
            state: FakeState,
            visited: string[],
        ) => ({
            // Две вершины цикла с фазой, третья — за концом.
            phaseIndexOfFn: () => {
                if (visited.length >= 2) return 99;
                visited.push(state.milestone);
                return cfg.phases.findIndex((p) => p.milestone === state.milestone);
            },
            advancePhaseFn: (st: FakeState, idx: number, phases: Array<{ milestone: string }>) => {
                st.milestone = phases[idx + 1]?.milestone ?? (null as never);
            },
        });

        it.each<[string, Record<string, unknown>]>([
            ['гейт смерджил фазу', { phaseMergedFn: () => false, tryMergePhaseFn: () => 'merged' }],
            ['фаза уже смерджена', { phaseMergedFn: () => true }],
        ])('%s: фаза, вставленная между текущей и следующей, выбирается следующей', (_n, route) => {
            const logs: string[] = [];
            const visited: string[] = [];
            const state = mkState();
            const cfg = validCfg({ active: true, phases: PHASES_OLD.map((p) => ({ ...p })) });
            const running = { ...cfg, phases: PHASES_OLD };
            runLoop(
                cfg,
                ctx(state),
                deps(logs, {
                    ...boundary(cfg, state, visited),
                    pickReviewModelFn: () => 'none',
                    getLastGatePr: () => 42,
                    reloadPhasesFn: (current: string) =>
                        reconcilePhases({
                            running,
                            fresh: { ...cfg, phases: PHASES_NEW },
                            currentMilestone: current,
                        }),
                    ...route,
                }),
            );
            expect(visited).toEqual(['M1', 'M1b']);
            expect(logs.join('\n')).toMatch(
                /🗂 Список фаз перечитан: добавлено "M1b", следующая — "M1b"\./,
            );
        });

        it.each([
            [
                'битый JSON',
                () =>
                    ralph.reloadPhasesFromConfig('/path/to/app/ralph.config.json', 'M1', {
                        running: REAL_CONFIG,
                        readFileFn: () => '{ "common": ',
                    }),
                /не прочитался как JSON/,
            ],
            [
                'текущая фаза удалена из списка',
                () =>
                    reconcilePhases({
                        running: validCfg({ active: true, phases: PHASES_OLD }),
                        fresh: validCfg({ active: true, phases: [PHASES_OLD[1]] }),
                        currentMilestone: 'M1',
                    }),
                /текущей фазы "M1" нет в свежем списке/,
            ],
        ])('%s → стоп с причиной, следующей фазы по старому списку нет', (_n, reload, reason) => {
            const logs: string[] = [];
            const visited: string[] = [];
            const pushed: string[] = [];
            const state = mkState();
            const cfg = validCfg({ active: true, phases: PHASES_OLD.map((p) => ({ ...p })) });
            const advancePhaseFn = vi.fn();
            const recordReviewFindingsFn = vi.fn();
            runLoop(
                cfg,
                ctx(state),
                deps(logs, {
                    ...boundary(cfg, state, visited),
                    advancePhaseFn,
                    recordReviewFindingsFn,
                    phaseMergedFn: () => true,
                    mergedPhasePrFn: () => 42,
                    reloadPhasesFn: reload,
                    pushEventFn: (m: string) => {
                        pushed.push(m);
                        return false;
                    },
                }),
            );
            expect(advancePhaseFn).not.toHaveBeenCalled();
            expect(state.milestone).toBe('M1');
            expect(visited).toEqual(['M1']);
            expect(cfg.phases).toEqual(PHASES_OLD);
            // Шаги после мерджа не сделаны: рестарт доведёт их сам, без второго счёта фазы.
            expect(recordReviewFindingsFn).not.toHaveBeenCalled();
            expect(pushed).toHaveLength(1);
            expect(pushed[0]).toMatch(/\(config-reload\)/);
            expect(pushed[0]).toMatch(reason);
            expect(logs.join('\n')).not.toMatch(/Список фаз перечитан/);
        });

        it('изменение roots между фазами — ⚠ и работа на прежних корнях', () => {
            const logs: string[] = [];
            const visited: string[] = [];
            const state = mkState();
            const oldRoots = { consumerRoot: '/path/to/app', runtimeDir: '/path/to/state' };
            const cfg = validCfg({
                active: true,
                phases: PHASES_OLD.map((p) => ({ ...p })),
                roots: { ...oldRoots },
                rootsResolved: { ...oldRoots },
            });
            const running = { ...cfg, phases: PHASES_OLD };
            runLoop(
                cfg,
                ctx(state),
                deps(logs, {
                    ...boundary(cfg, state, visited),
                    phaseMergedFn: () => true,
                    reloadPhasesFn: (current: string) =>
                        reconcilePhases({
                            running,
                            fresh: {
                                ...cfg,
                                phases: PHASES_NEW,
                                roots: { consumerRoot: '/path/to/other' },
                                rootsResolved: { consumerRoot: '/path/to/other' },
                            },
                            currentMilestone: current,
                        }),
                }),
            );
            const text = logs.join('\n');
            expect(text).toMatch(/⚠ Конфиг: изменились roots — .*на прежних значениях/);
            expect((cfg as Record<string, unknown>).rootsResolved).toEqual(oldRoots);
            expect((cfg as Record<string, unknown>).roots).toEqual(oldRoots);
            // Список фаз при этом свежий: рестарт нужен корням, а не новой фазе.
            expect(visited).toEqual(['M1', 'M1b']);
        });

        it('боевое перечитывание: тот же резолв профиля, что на старте, на фикстуре конфига', () => {
            const raw = structuredClone(REAL_CONFIG_RAW);
            const first = raw.common.phases[0];
            raw.common.phases.push({ milestone: 'Новая фаза', branch: 'feature/new-phase' });
            const read = (text: string) =>
                ralph.reloadPhasesFromConfig('/path/to/app/ralph.config.json', first.milestone, {
                    running: REAL_CONFIG,
                    readFileFn: () => text,
                });
            expect(read(JSON.stringify(raw))).toMatchObject({
                kind: 'ok',
                index: 0,
                added: ['Новая фаза'],
                restartKeys: [],
            });
            // Сменённый defaultProfile профиль процесса не переключает — он назван рестартом.
            const renamed = structuredClone(raw);
            renamed.defaultProfile = 'other';
            renamed.profiles.other = {};
            expect(read(JSON.stringify(renamed))).toMatchObject({
                kind: 'ok',
                restartKeys: ['defaultProfile'],
            });
            // Профиль процесса исчез из файла — отказ резолва, а не process.exit.
            const lost = structuredClone(raw);
            lost.profiles = { other: {} };
            lost.defaultProfile = 'other';
            const refused = read(JSON.stringify(lost));
            expect(refused.kind).toBe('refused');
            expect(refused).toMatchObject({ reason: expect.stringMatching(/Неизвестный профиль/) });
        });

        it('main() передаёт петле боевое перечитывание: без него новая фаза ждёт рестарта', () => {
            const src = stripComments(
                fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8'),
            );
            const call = src.slice(src.indexOf('runLoop(config, ctx, {'));
            const body = call.slice(0, call.indexOf('});'));
            expect(body).toMatch(
                /reloadPhasesFn: \(milestone: string\) =>\s+reloadPhasesFromConfig\(runnerConfigPath,/,
            );
        });
    });

    it('фаза уже смерджена (идемпотентность, AFK): fetch + detach origin/main, advancePhase, дальше', () => {
        const logs: string[] = [];
        const shCmds: string[] = [];
        const advancePhaseFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                // counter-дефолт: 1-й проход фаза 0, 2-й → «за концом» → выход
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                // #193: обновление дерева раннера — argv, нормализуем в строку.
                runArgvFn: (file: string, args: string[]) => {
                    shCmds.push(`${file} ${args.join(' ')}`);
                    return '';
                },
                advancePhaseFn,
            }),
        );
        // #77: worktree-модель — раннер обновляется через origin/main (fetch + detach),
        // локальный main не трогает вовсе: его ref держит дерево человека.
        expect(shCmds).toContain('git fetch origin main');
        expect(shCmds).toContain('git checkout --detach origin/main');
        expect(shCmds).not.toContain('git checkout main');
        expect(shCmds).not.toContain('git pull --ff-only');
        expect(advancePhaseFn).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/уже смерджена/);
    });

    // Канон, задача 28 (ревью, 1-й проход): у мерджа ДВА пути, и второй — вот этот («фаза
    // смерджена человеком либо прошлым прогоном»). Без пробы строку обновления дерева
    // потребителя можно было бы отсюда убрать, и сьют остался бы зелёным: тест гейта
    // сторожит только СВОЙ путь.
    it('задача 28: на пути «фаза уже смерджена» тянется и дерево потребителя', () => {
        const logs: string[] = [];
        const shCmds: string[] = [];
        runLoop(
            validCfg({
                rootsResolved: {
                    consumerRoot: '/path/to/app',
                    executionRoot: '/path/to/app-ralph',
                    productRoot: '/path/to/app/.claude/ralph',
                    runtimeDir: '/path/to/app/.ralph/runtime/prod',
                },
            }),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                runArgvFn: (file: string, args: string[]) => {
                    shCmds.push(`${file} ${args.join(' ')}`);
                    // Дерево человека на main и чистое: путь обязан дойти до слияния.
                    // `rev-parse` обязан отдать полный object id — слияние идёт по нему.
                    if (args.includes('symbolic-ref')) return 'main';
                    return args.includes('rev-parse') ? 'c'.repeat(40) : '';
                },
            }),
        );
        // Адрес — из раскладки, а не из текущего каталога: обновляется именно дерево
        // потребителя, а не то, в котором раннер работает.
        // Префикс команд модуля — свой каталог плюс запреты хуков и рекурсии.
        expect(
            shCmds.some((c) => c.startsWith('git -C /path/to/app') && c.includes('status')),
        ).toBe(true);
        expect(
            shCmds.some(
                (c) => c.startsWith('git -C /path/to/app') && c.includes('merge --ff-only'),
            ),
        ).toBe(true);
        // Своё дерево при этом обновляется по-прежнему и своим способом (detach).
        expect(shCmds).toContain('git checkout --detach origin/main');
    });

    // Ревью, 2-й проход: порядок пары важен сам по себе. Регрессия, вернувшая обновление
    // потребителя ПОСЛЕ обновления своего дерева, осталась бы зелёной в пробе выше — там
    // оба вызова проходят, — и снова оставляла бы дерево человека старым при стопе.
    it('задача 28: своё дерево не обновилось — дерево потребителя УЖЕ подтянуто', () => {
        const logs: string[] = [];
        const shCmds: string[] = [];
        runLoop(
            validCfg({
                rootsResolved: {
                    consumerRoot: '/path/to/app',
                    executionRoot: '/path/to/app-ralph',
                    productRoot: '/path/to/app/.claude/ralph',
                    runtimeDir: '/path/to/app/.ralph/runtime/prod',
                },
            }),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                runArgvFn: (file: string, args: string[]) => {
                    shCmds.push(`${file} ${args.join(' ')}`);
                    // Своё дерево не обновляется: тот самый транзиентный сбой, из-за
                    // которого петля встаёт и разбирает человек.
                    if (args.includes('--detach')) throw new Error('detach упал');
                    if (args.includes('symbolic-ref')) return 'main';
                    return args.includes('rev-parse') ? 'c'.repeat(40) : '';
                },
            }),
        );
        expect(logs.join('\n')).toMatch(/дерево раннера не обновилось/);
        // Префикс команд модуля — свой каталог плюс запреты хуков и рекурсии.
        expect(
            shCmds.some((c) => c.startsWith('git -C /path/to/app') && c.includes('status')),
        ).toBe(true);
        expect(
            shCmds.some(
                (c) => c.startsWith('git -C /path/to/app') && c.includes('merge --ff-only'),
            ),
        ).toBe(true);
    });

    // #37: раньше milestone такой фазы закрывал свип на СЛЕДУЮЩЕМ старте раннера — он
    // ходил в форж мимо шва и на площадке без `gh` не работал вовсе. Свип убран, и его
    // единственный полезный случай закрыт здесь: фаза смерджена (человеком или прошлым
    // прогоном) — закрываем её milestone тем же швом, что и после нашего мерджа.
    it('#37 фаза уже смерджена → milestone закрывается через шов, без свипа на старте', () => {
        const logs: string[] = [];
        const closeMilestoneByTitleFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                closeMilestoneByTitleFn,
            }),
        );
        expect(closeMilestoneByTitleFn).toHaveBeenCalledWith('M1');
    });

    it('#37 dry: milestone смердженной фазы НЕ закрывается (C1 read-only)', () => {
        const closeMilestoneByTitleFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                dry: true,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                closeMilestoneByTitleFn,
            }),
        );
        expect(closeMilestoneByTitleFn).not.toHaveBeenCalled();
    });

    it('#237 фаза уже смерджена → recordReviewFindings зовётся с номером PR из mergedPhasePr', () => {
        const logs: string[] = [];
        const recordReviewFindingsFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                mergedPhasePrFn: () => 315,
                recordReviewFindingsFn,
                shFn: () => '',
            }),
        );
        expect(recordReviewFindingsFn).toHaveBeenCalledTimes(1);
        expect(recordReviewFindingsFn.mock.calls[0][1]).toBe(315);
    });

    it('#237 фаза уже смерджена, номер PR не определён → предупреждение, запись не зовётся', () => {
        const logs: string[] = [];
        const recordReviewFindingsFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                mergedPhasePrFn: () => null,
                recordReviewFindingsFn,
                shFn: () => '',
            }),
        );
        expect(recordReviewFindingsFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/запись отсутствует/);
    });

    it('фаза смерджена при dry=true → advancePhase есть, но БЕЗ мутаций git (checkout/pull не зовутся)', () => {
        const logs: string[] = [];
        const shCmds: string[] = [];
        const advancePhaseFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                dry: true,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                shFn: (c: string) => {
                    shCmds.push(c);
                    return '';
                },
                // #193: dry не должен звать argv-мутации обновления дерева — фиксируем и их.
                runArgvFn: (file: string, args: string[]) => {
                    shCmds.push(`${file} ${args.join(' ')}`);
                    return '';
                },
                advancePhaseFn,
            }),
        );
        expect(shCmds).not.toContain('git fetch origin main');
        expect(shCmds).not.toContain('git checkout --detach origin/main');
        expect(advancePhaseFn).toHaveBeenCalled();
    });

    it('submitted=true → сразу к гейту, без PR/ревью/правок', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const tryMergePhaseFn = vi.fn(() => 'not-merged');
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                runClaudeFn,
                tryMergePhaseFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled(); // сдача пропущена
        expect(tryMergePhaseFn).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/уже прошла PR\/ревью\/правки/);
    });

    it('зовёт синк в начале итерации — issues закрываются асинхронно после мерджа', () => {
        const syncProjectBoardFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true, // фаза уже смерджена → выход после первой итерации
                syncProjectBoardFn,
            }),
        );
        expect(syncProjectBoardFn).toHaveBeenCalled();
    });

    it('в dry-run доску не трогает', () => {
        const syncProjectBoardFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                dry: true,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => true,
                syncProjectBoardFn,
            }),
        );
        expect(syncProjectBoardFn).not.toHaveBeenCalled();
    });

    it('полная сдача → гейт merged → закрыть milestone + advancePhase + пуш «готова к релизу»', () => {
        const logs: string[] = [];
        const closeMilestoneByTitleFn = vi.fn();
        const advancePhaseFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'merged');
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none', // ревью пропущено → сдача = PR + правки
                runClaudeFn: () => 0,
                tryMergePhaseFn,
                closeMilestoneByTitleFn,
                advancePhaseFn,
                pushEventFn,
            }),
        );
        expect(tryMergePhaseFn).toHaveBeenCalledTimes(1);
        expect(closeMilestoneByTitleFn).toHaveBeenCalledWith('M1');
        expect(advancePhaseFn).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/Ревью PR — за супервизором/);
        // #86: событие «релиз-готовность» уходит пушем при успешном мердже фазы.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/готова к релизу/);
    });

    // #221: основное ревью (не разбор blocked) получает СВОЙ фолбэк review.fallback —
    // явным опции.fallbackModel, а не через общий cfg.fallbackModel/noFallback (M8).
    // Факт использования фолбэка обязан быть виден в логе (issue #221, критерий 1).
    it('#221: основное ревью получает fallbackModel из review.fallback, видно в логе', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({
                fallbackModel: 'claude-sonnet-5', // общий фолбэк — НЕ должен утечь в ревью
                review: { default: 'claude-opus-4-8', fallback: 'claude-fable-5' },
            }),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        // Вызов 0 — создание PR, вызов 1 — ревью.
        // #46: PR заводит петля, сессии на это больше нет — ревью стало ПЕРВЫМ вызовом.
        expect(runClaudeFn.mock.calls[0][1].model).toBe('claude-opus-4-8');
        expect(runClaudeFn.mock.calls[0][1].fallbackModel).toBe('claude-fable-5');
        expect(logs.join('\n')).toMatch(
            /Ревью фазы моделью: claude-opus-4-8.*фолбэк при overload: claude-fable-5/,
        );
    });

    // ── Задача 78: ревью засчитывается только по вердикту ─────────────────────────────
    // 16.10 ревью легло на прокси моделей за 8 с: «No upstream account is currently
    // available», `claude -p` вышел с кодом 0, намерений ноль — и фаза уехала в main
    // непрочитанной. Вердикт — это сводка без якоря или pr-block; нет ни того, ни другого —
    // стоп, а не «замечаний нет».
    const reviewVerdictDeps = (
        logs: string[],
        reviewRuns: Array<{ output: string; verdict: boolean; anchored?: boolean }>,
        o: Record<string, unknown> = {},
    ) => {
        let session = -1;
        const runClaudeFn = vi.fn<RunClaudeFake>((_p, _o, extra) => {
            session++;
            const run = reviewRuns[Math.min(session, reviewRuns.length - 1)];
            emitOutput(extra, run.output, 0);
            return 0;
        });
        // Намерения применяются после каждой сессии; ревью-сессии — первые в сдаче.
        const applySessionRequestsFn = () => {
            const run = reviewRuns[session];
            if (run?.anchored && !run.verdict) {
                return {
                    applied: 1,
                    failed: false,
                    closedIssues: [],
                    prFindings: [
                        {
                            comment: '🟡 [minor] находка у строки',
                            anchor: { path: 'core/x.ts', line: 1 },
                        },
                    ],
                    prBlocked: false,
                };
            }
            return run?.verdict
                ? {
                      applied: 1,
                      failed: false,
                      closedIssues: [],
                      prFindings: [{ comment: '⚪ [nit] сводка: замечаний нет' }],
                      prBlocked: false,
                  }
                : { applied: 0, failed: false, closedIssues: [], prFindings: [], prBlocked: false };
        };
        return {
            runClaudeFn,
            deps: deps(logs, {
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                applySessionRequestsFn,
                ...o,
            }),
        };
    };

    it('задача 78: код 0 и ноль намерений ревью — фаза не мерджится, причина «ревью без вердикта»', () => {
        const logs: string[] = [];
        const pushes: string[] = [];
        const tryMergePhaseFn = vi.fn(() => 'merged' as const);
        const state = mkState();
        const { runClaudeFn, deps: d } = reviewVerdictDeps(
            logs,
            [{ output: 'Готово.', verdict: false }],
            {
                tryMergePhaseFn,
                // Как боевой pushEvent: строка уходит и в уведомление, и в лог.
                pushEventFn: (m: string, _c: unknown, o?: { logFn?: (s: string) => void }) => {
                    pushes.push(m);
                    o?.logFn?.(`🔔 PUSH: ${m}`);
                    return false;
                },
            },
        );
        runLoop(validCfg({ review: { default: 'claude-opus-4-8' } }), ctx(state), d);
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        // Сессия правок не стартовала: ревью без вердикта — стоп сдачи целиком.
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(pushes.join('\n')).toMatch(/ревью без вердикта/);
        expect(logs.join('\n')).toMatch(/ревью без вердикта/);
        // Не сдано: рестарт обязан повторить ревью, а не прыгнуть к гейту.
        expect((state as { submitted: boolean }).submitted).toBe(false);
    });

    it('задача 78: честное чистое ревью (сводка есть, замечаний нет) по-прежнему проходит', () => {
        const logs: string[] = [];
        const tryMergePhaseFn = vi.fn(() => 'merged' as const);
        const { deps: d } = reviewVerdictDeps(logs, [{ output: 'Ревью готово.', verdict: true }], {
            tryMergePhaseFn,
        });
        runLoop(validCfg({ review: { default: 'claude-opus-4-8' } }), ctx(mkState()), d);
        expect(tryMergePhaseFn).toHaveBeenCalled();
        expect(logs.join('\n')).not.toMatch(/ревью без вердикта/);
    });

    it('задача 78: «No upstream account» в выводе — повтор с паузой, счётчик брейкера не растёт', () => {
        const logs: string[] = [];
        const sleepFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'merged' as const);
        const state = mkState({ count: 3 });
        const { runClaudeFn, deps: d } = reviewVerdictDeps(
            logs,
            [
                { output: 'No upstream account is currently available', verdict: false },
                { output: 'Ревью готово.', verdict: true },
            ],
            { tryMergePhaseFn, sleepFn },
        );
        runLoop(validCfg({ review: { default: 'claude-opus-4-8' } }), ctx(state), d);
        // Ревью дважды, затем сессия правок.
        expect(runClaudeFn.mock.calls[0][0]).toBe(runClaudeFn.mock.calls[1][0]);
        expect(sleepFn).toHaveBeenCalledTimes(1);
        expect(sleepFn.mock.calls[0][0]).toBeGreaterThan(0);
        expect(logs.join('\n')).toMatch(/прокси моделей/);
        expect((state as { count: number }).count).toBe(3);
        expect(tryMergePhaseFn).toHaveBeenCalled();
    });

    it('задача 78: якорные находки без сводки и строка прокси — без повтора, комментарии не задваиваются', () => {
        const logs: string[] = [];
        const sleepFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'merged' as const);
        const { runClaudeFn, deps: d } = reviewVerdictDeps(
            logs,
            [
                {
                    output: 'No upstream account is currently available',
                    verdict: false,
                    anchored: true,
                },
            ],
            {
                tryMergePhaseFn,
                sleepFn,
                pushEventFn: (m: string, _c: unknown, o?: { logFn?: (s: string) => void }) => {
                    o?.logFn?.(`🔔 PUSH: ${m}`);
                    return false;
                },
            },
        );
        runLoop(validCfg({ review: { default: 'claude-opus-4-8' } }), ctx(mkState()), d);
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/ревью без вердикта/);
        expect(logs.join('\n')).not.toMatch(/после \d+ повторов/);
    });

    it('задача 78: прокси лежит дольше бюджета повторов — стоп «ревью без вердикта», не мердж', () => {
        const logs: string[] = [];
        const sleepFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'merged' as const);
        const state = mkState({ count: 3 });
        const { runClaudeFn, deps: d } = reviewVerdictDeps(
            logs,
            [{ output: 'No upstream account is currently available', verdict: false }],
            {
                tryMergePhaseFn,
                sleepFn,
                pushEventFn: (m: string, _c: unknown, o?: { logFn?: (s: string) => void }) => {
                    o?.logFn?.(`🔔 PUSH: ${m}`);
                    return false;
                },
            },
        );
        runLoop(validCfg({ review: { default: 'claude-opus-4-8' } }), ctx(state), d);
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        expect(runClaudeFn).toHaveBeenCalledTimes(MODEL_PROXY_RETRIES + 1);
        expect(sleepFn).toHaveBeenCalledTimes(MODEL_PROXY_RETRIES);
        expect(logs.join('\n')).toMatch(/ревью без вердикта/);
        expect((state as { count: number }).count).toBe(3);
    });

    describe('#246 планировщик перед первыми правками', () => {
        const plan = {
            decision: 'Вынести общий разбор границы в отдельную функцию',
            rejected: ['Добавлять ещё одну регулярку для названного края'],
            steps: [
                {
                    do: 'Добавить тест на общий класс границ',
                    check: 'npx vitest run core/fix-plan.test.ts',
                    expect: 'RED',
                },
                {
                    do: 'Реализовать общий разбор',
                    check: 'npx vitest run core/fix-plan.test.ts',
                    expect: 'GREEN',
                },
            ],
        };
        const planOutput = [
            '<<<RALPH-FIX-PLAN>>>',
            JSON.stringify(plan),
            '<<<END-RALPH-FIX-PLAN>>>',
        ].join('\n');
        const reviewFindings = [
            { comment: '⚪ [nit] сводка: есть находка' },
            {
                comment: '🟠 [major] разобран только частный случай',
                anchor: { path: 'core/x.ts', line: 10 },
            },
        ];

        const runPlannerPath = (
            overrides: Record<string, unknown> = {},
            planner: { code?: number; output?: string } = {},
            options: {
                config?: Partial<RalphConfig>;
                state?: ReturnType<typeof mkState>;
                findings?: typeof reviewFindings;
            } = {},
        ) => {
            const pushes: string[] = [];
            const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
                if (prompt.includes('Ты планировщик правок')) {
                    emitOutput(d, planner.output ?? planOutput, planner.code ?? 0);
                    return planner.code ?? 0;
                }
                return 0;
            });
            let applications = 0;
            runLoop(
                validCfg({ review: { default: 'claude-rev', maxTurns: 37 }, ...options.config }),
                ctx(options.state ?? mkState()),
                deps([], {
                    pickReviewModelFn: () => 'claude-rev',
                    runClaudeFn,
                    applySessionRequestsFn: () => ({
                        applied: 1,
                        failed: false,
                        closedIssues: [],
                        prFindings:
                            ++applications === 1 ? (options.findings ?? reviewFindings) : [],
                        prBlocked: false,
                    }),
                    pushEventFn: (message: string) => {
                        pushes.push(message);
                        return false;
                    },
                    tryMergePhaseFn: () => 'merged',
                    ...overrides,
                }),
            );
            return { runClaudeFn, pushes };
        };

        const expectPlanStop = (
            result: ReturnType<typeof runPlannerPath>,
            diagnosis: RegExp,
        ): void => {
            const prompts = result.runClaudeFn.mock.calls.map(([prompt]) => prompt);
            expect(prompts.some((prompt) => prompt.includes('Разбери замечания code review'))).toBe(
                false,
            );
            expect(result.pushes).toHaveLength(1);
            expect(result.pushes[0]).toContain('fix-plan');
            expect(result.pushes[0]).toMatch(diagnosis);
        };

        describe('fixSeverityFloor — порог правок ревью фазы', () => {
            const anchored = (comment: string) => ({
                comment,
                anchor: { path: 'core/x.ts', line: 10 },
            });
            const withFloor = {
                review: { default: 'claude-rev', fixSeverityFloor: 'minor' as const },
            };

            it('только nit ниже порога → plan: skip, правок нет, сдача идёт к гейту', () => {
                const state = mkState();
                const logs: string[] = [];
                const tryMergePhaseFn = vi.fn(() => 'merged' as const);
                const { runClaudeFn } = runPlannerPath(
                    { tryMergePhaseFn, logFn: (line: string) => logs.push(line) },
                    {},
                    {
                        state,
                        findings: [{ comment: 'сводка' }, anchored('⚪ [nit] косметика')],
                        config: withFloor,
                    },
                );

                const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
                expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(
                    false,
                );
                expect(
                    prompts.some((prompt) => prompt.includes('Разбери замечания code review')),
                ).toBe(false);
                expect(state.submitStages).toContainEqual(
                    expect.objectContaining({ stage: 'plan', event: 'outcome', outcome: 'skip' }),
                );
                expect(tryMergePhaseFn).toHaveBeenCalled();
                expect(logs.join('\n')).toContain('ниже порога review.fixSeverityFloor=minor');
            });

            it('minor среди находок проходит порог → планировщик и правки запущены', () => {
                const { runClaudeFn } = runPlannerPath(
                    {},
                    {},
                    {
                        findings: [
                            { comment: 'сводка' },
                            anchored('⚪ [nit] косметика'),
                            anchored('🟡 [minor] дефект'),
                        ],
                        config: withFloor,
                    },
                );

                const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
                expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(
                    true,
                );
                expect(
                    prompts.some((prompt) => prompt.includes('Разбери замечания code review')),
                ).toBe(true);
            });

            it('⚪ [blocker] остаётся unmarked и запускает планировщик и правки', () => {
                const { runClaudeFn } = runPlannerPath(
                    {},
                    {},
                    {
                        findings: [
                            { comment: 'сводка' },
                            anchored('⚪ [blocker] противоречивая разметка'),
                        ],
                        config: withFloor,
                    },
                );

                const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
                expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(
                    true,
                );
                expect(
                    prompts.some((prompt) => prompt.includes('Разбери замечания code review')),
                ).toBe(true);
            });

            it('порог не задан → nit запускает планировщик и правки', () => {
                const { runClaudeFn } = runPlannerPath(
                    {},
                    {},
                    { findings: [{ comment: 'сводка' }, anchored('⚪ [nit] косметика')] },
                );

                const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
                expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(
                    true,
                );
                expect(
                    prompts.some((prompt) => prompt.includes('Разбери замечания code review')),
                ).toBe(true);
            });
        });

        describe('fixSkip — сохранённая причина пропуска правок', () => {
            const anchored = (comment: string) => ({
                comment,
                anchor: { path: 'core/x.ts', line: 10 },
            });
            const withFloor = {
                review: { default: 'claude-rev', fixSeverityFloor: 'minor' as const },
            };

            it('свежий ниже-пороговый пропуск называет floor и не объявляет находки отсутствующими', () => {
                const state = mkState();
                const logs: string[] = [];
                runPlannerPath(
                    { logFn: (line: string) => logs.push(line) },
                    {},
                    {
                        state,
                        findings: [{ comment: 'сводка' }, anchored('⚪ [nit] косметика')],
                        config: withFloor,
                    },
                );

                expect(state.submitStages).toContainEqual(
                    expect.objectContaining({
                        stage: 'review',
                        event: 'outcome',
                        detail: {
                            blocked: false,
                            hasAnchoredFindings: false,
                            fixSkip: { reason: 'below-fix-severity-floor', floor: 'minor' },
                        },
                    }),
                );
                expect(logs.join('\n')).toContain('ниже порога review.fixSeverityFloor=minor');
                expect(logs.join('\n')).not.toContain('у первого ревью нет якорных находок');
            });

            it('свежий пропуск без находок сохраняет прежнее сообщение', () => {
                const state = mkState();
                const logs: string[] = [];
                runPlannerPath(
                    { logFn: (line: string) => logs.push(line) },
                    {},
                    { state, findings: [{ comment: '⚪ [nit] сводка без находок' }] },
                );

                expect(state.submitStages).toContainEqual(
                    expect.objectContaining({
                        stage: 'review',
                        event: 'outcome',
                        detail: {
                            blocked: false,
                            hasAnchoredFindings: false,
                            fixSkip: { reason: 'no-anchored-findings' },
                        },
                    }),
                );
                expect(logs.join('\n')).toContain('у первого ревью нет якорных находок');
            });

            it('сериализованный рестарт ниже порога использует сохранённый floor, а не текущий конфиг', () => {
                const at = '2026-01-01T00:00:00.000Z';
                let submitStages = finishStage([], 'M1', 'pr', 'ok', at);
                submitStages = finishStage(submitStages, 'M1', 'review', 'ok', at, {
                    blocked: false,
                    hasAnchoredFindings: false,
                    fixSkip: { reason: 'below-fix-severity-floor', floor: 'minor' },
                });
                submitStages = JSON.parse(JSON.stringify(submitStages)) as typeof submitStages;
                const state = mkState({ submitStages, lastReviewModel: null });
                const logs: string[] = [];

                const result = runPlannerPath(
                    { logFn: (line: string) => logs.push(line) },
                    {},
                    {
                        state,
                        config: {
                            review: { default: 'claude-rev', fixSeverityFloor: 'major' as const },
                        },
                    },
                );

                const prompts = result.runClaudeFn.mock.calls.map(([prompt]) => prompt);
                expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(
                    false,
                );
                expect(logs.join('\n')).toContain('ниже порога review.fixSeverityFloor=minor');
                expect(logs.join('\n')).not.toContain('review.fixSeverityFloor=major');
                expect(logs.join('\n')).not.toContain('у первого ревью нет якорных находок');
            });

            it('сериализованный рестарт без находок сохраняет прежнее сообщение', () => {
                const at = '2026-01-01T00:00:00.000Z';
                let submitStages = finishStage([], 'M1', 'pr', 'ok', at);
                submitStages = finishStage(submitStages, 'M1', 'review', 'ok', at, {
                    blocked: false,
                    hasAnchoredFindings: false,
                    fixSkip: { reason: 'no-anchored-findings' },
                });
                submitStages = JSON.parse(JSON.stringify(submitStages)) as typeof submitStages;
                const state = mkState({ submitStages, lastReviewModel: null });
                const logs: string[] = [];

                runPlannerPath({ logFn: (line: string) => logs.push(line) }, {}, { state });

                expect(logs.join('\n')).toContain('у первого ревью нет якорных находок');
            });

            it('legacy-вердикт без fixSkip получает нейтральный лог', () => {
                const at = '2026-01-01T00:00:00.000Z';
                let submitStages = finishStage([], 'M1', 'pr', 'ok', at);
                submitStages = finishStage(submitStages, 'M1', 'review', 'ok', at, {
                    blocked: false,
                    hasAnchoredFindings: false,
                });
                submitStages = JSON.parse(JSON.stringify(submitStages)) as typeof submitStages;
                const state = mkState({ submitStages, lastReviewModel: null });
                const logs: string[] = [];

                runPlannerPath({ logFn: (line: string) => logs.push(line) }, {}, { state });

                expect(logs.join('\n')).toContain('пропущены по журналу сдачи прежней ревизии');
                expect(logs.join('\n')).not.toContain('у первого ревью нет якорных находок');
                expect(logs.join('\n')).not.toContain('ниже порога review.fixSeverityFloor');
            });
        });

        it('рестарт после ревью с находками без ревью-модели → stop fix-plan, plan: stop, правки не запущены', () => {
            const at = '2026-01-01T00:00:00.000Z';
            let submitStages = startStage([], 'M1', 'pr', at);
            submitStages = finishStage(submitStages, 'M1', 'pr', 'ok', at);
            submitStages = startStage(submitStages, 'M1', 'review', at);
            submitStages = finishStage(submitStages, 'M1', 'review', 'ok', at, {
                blocked: false,
                hasAnchoredFindings: true,
            });
            const state = mkState({ submitStages, lastReviewModel: null });

            const result = runPlannerPath({}, {}, { state });

            expectPlanStop(result, /ревью-модель не задана/);
            expect(state.submitStages).toContainEqual(
                expect.objectContaining({ stage: 'plan', event: 'outcome', outcome: 'stop' }),
            );
            expect(state.submitStages).not.toContainEqual(
                expect.objectContaining({ stage: 'plan', event: 'outcome', outcome: 'skip' }),
            );
        });

        it.each([null, 'claude-rev'])(
            'рестарт после review: skip при lastReviewModel=%s → plan: skip и правки без плана',
            (lastReviewModel) => {
                const at = '2026-01-01T00:00:00.000Z';
                let submitStages = finishStage([], 'M1', 'pr', 'ok', at);
                submitStages = finishStage(submitStages, 'M1', 'review', 'skip', at);
                const state = JSON.parse(
                    JSON.stringify(mkState({ submitStages, lastReviewModel })),
                ) as ReturnType<typeof mkState>;

                const result = runPlannerPath({}, {}, { state });

                const prompts = result.runClaudeFn.mock.calls.map(([prompt]) => prompt);
                expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(
                    false,
                );
                expect(result.pushes.join('\n')).not.toContain('fix-plan');
                expect(state.submitStages).toContainEqual(
                    expect.objectContaining({ stage: 'plan', event: 'outcome', outcome: 'skip' }),
                );
                const fixPrompt = prompts.find((prompt) =>
                    prompt.includes('Разбери замечания code review'),
                );
                expect(fixPrompt).toBeDefined();
                expect(fixPrompt).not.toContain(`Решение: ${plan.decision}`);
                expect(state.submitStages).toContainEqual(
                    expect.objectContaining({ stage: 'fixes', event: 'outcome', outcome: 'ok' }),
                );
            },
        );

        it('чистое ревью → plan: skip и fixes: skip без планировщика и сессии правок', () => {
            const state = mkState();
            const result = runPlannerPath(
                {},
                {},
                { state, findings: [{ comment: '⚪ [nit] сводка без находок' }] },
            );

            const prompts = result.runClaudeFn.mock.calls.map(([prompt]) => prompt);
            expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(false);
            expect(prompts.some((prompt) => prompt.includes('Разбери замечания code review'))).toBe(
                false,
            );
            for (const stage of ['plan', 'fixes']) {
                expect(state.submitStages).toContainEqual(
                    expect.objectContaining({ stage, event: 'outcome', outcome: 'skip' }),
                );
            }
        });

        it('рестарт после сериализованного review: ok без находок сам доводит plan и fixes до skip', () => {
            const at = '2026-01-01T00:00:00.000Z';
            let submitStages = finishStage([], 'M1', 'pr', 'ok', at);
            submitStages = finishStage(submitStages, 'M1', 'review', 'ok', at, {
                blocked: false,
                hasAnchoredFindings: false,
            });
            submitStages = JSON.parse(JSON.stringify(submitStages)) as typeof submitStages;
            const state = mkState({ submitStages, lastReviewModel: null });

            const result = runPlannerPath({}, {}, { state });

            const prompts = result.runClaudeFn.mock.calls.map(([prompt]) => prompt);
            expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(false);
            expect(prompts.some((prompt) => prompt.includes('Разбери замечания code review'))).toBe(
                false,
            );
            for (const stage of ['plan', 'fixes']) {
                expect(state.submitStages).toContainEqual(
                    expect.objectContaining({ stage, event: 'outcome', outcome: 'skip' }),
                );
            }
        });

        it('рестарт после plan: skip доводит fixes: skip без обеих сессий', () => {
            const at = '2026-01-01T00:00:00.000Z';
            let submitStages = finishStage([], 'M1', 'pr', 'ok', at);
            submitStages = finishStage(submitStages, 'M1', 'review', 'ok', at, {
                blocked: false,
                hasAnchoredFindings: false,
            });
            submitStages = finishStage(submitStages, 'M1', 'plan', 'skip', at);
            const state = mkState({ submitStages, lastReviewModel: null });

            const result = runPlannerPath({}, {}, { state });

            const prompts = result.runClaudeFn.mock.calls.map(([prompt]) => prompt);
            expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(false);
            expect(prompts.some((prompt) => prompt.includes('Разбери замечания code review'))).toBe(
                false,
            );
            expect(state.submitStages).toContainEqual(
                expect.objectContaining({ stage: 'fixes', event: 'outcome', outcome: 'skip' }),
            );
        });

        it('maxFixPlans: предел исчерпан, блокер остался → стоп до планировщика с обоими числами', () => {
            const result = runPlannerPath(
                {},
                {},
                {
                    state: mkState({ fixPlans: 2 }),
                    config: { review: { default: 'claude-rev', maxFixPlans: 2 } },
                },
            );
            const prompts = result.runClaudeFn.mock.calls.map(([prompt]) => prompt);
            expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(false);
            expectPlanStop(result, /планов 2 из предела 2, блокер остался/);
            expect(result.pushes[0]).toContain('подними review.maxFixPlans');
        });

        it('maxFixPlans: успешный разбор плана увеличивает счёт и пишет state', () => {
            const state = mkState();
            const saves: Array<number | undefined> = [];
            runPlannerPath(
                {
                    advancePhaseFn: () => {},
                    saveStateFn: (current: { fixPlans?: number }) => saves.push(current.fixPlans),
                },
                {},
                { state },
            );
            expect(state.fixPlans).toBe(1);
            expect(saves).toContain(1);
        });

        it('maxFixPlans: переход фазы обнуляет счёт планов', () => {
            const state = mkState({ fixPlans: 1 });
            buildRuntime({ ...FLAGS_OFF, dry: true }).advancePhase(state as RalphState, 0, [
                { milestone: 'M1', branch: 'feature/m1' },
            ]);
            expect(state.fixPlans).toBe(0);
        });

        it('ревью с находками → планировщик до правок, решение плана — в их промпте', () => {
            const { runClaudeFn } = runPlannerPath();
            const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
            const reviewAt = prompts.findIndex((prompt) =>
                prompt.includes('проведи детальное code review'),
            );
            const planAt = prompts.findIndex((prompt) => prompt.includes('Ты планировщик правок'));
            const fixAt = prompts.findIndex((prompt) =>
                prompt.includes('Разбери замечания code review'),
            );

            expect(reviewAt).toBeGreaterThanOrEqual(0);
            expect(planAt).toBeGreaterThan(reviewAt);
            expect(fixAt).toBeGreaterThan(planAt);
            expect(prompts[planAt]).toContain('<<<RALPH-FIX-PLAN>>>');
            expect(runClaudeFn.mock.calls[planAt][1]).toMatchObject({
                model: 'claude-rev',
                maxTurns: 37,
            });
            expect(prompts[fixAt]).toContain(`Решение: ${plan.decision}`);
            expect(prompts[fixAt]).toContain(plan.steps[0].do);
        });

        it('планировщик получает review.fallback, а не общий fallbackModel', () => {
            const { runClaudeFn } = runPlannerPath(
                {},
                {},
                {
                    config: {
                        fallbackModel: 'claude-sonnet-5',
                        review: {
                            default: 'claude-rev',
                            fallback: 'claude-fable-5',
                            maxTurns: 37,
                        },
                    },
                },
            );
            const planAt = runClaudeFn.mock.calls.findIndex(([prompt]) =>
                prompt.includes('Ты планировщик правок'),
            );
            expect(runClaudeFn.mock.calls[planAt][1].fallbackModel).toBe('claude-fable-5');
            expect(runClaudeFn.mock.calls[planAt][1].fallbackModel).not.toBe('claude-sonnet-5');
        });

        it('намерения read-only планировщика не собираются для последующего применения', () => {
            const seen = new Set<string>();
            const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
                if (prompt.includes('Ты планировщик правок')) {
                    const collect = d?.collectIntentsFn as
                        ((output: string, opts: { seen: Set<string> }) => void) | undefined;
                    expect(collect).toBeTypeOf('function');
                    collect?.(
                        [
                            INTENTS_BEGIN,
                            JSON.stringify({
                                kind: 'pr-block',
                                comment: 'ложный блок планировщика',
                            }),
                            INTENTS_END,
                        ].join('\n'),
                        { seen },
                    );
                    emitOutput(d, planOutput, 0);
                }
                return 0;
            });

            runPlannerPath({ runClaudeFn });

            expect(seen).toEqual(new Set());
        });

        it('повторный планировщик пересчитывает список файлов: [] → новый файл', () => {
            const files = [[] as string[], ['core/new.ts']];
            const seen: Array<string[] | null | undefined> = [];
            runPlannerPath({
                phaseDiffFilesFn: () => files.shift() ?? ['core/new.ts'],
                reviewDiffContextFn: (
                    _branch: string,
                    opts: { files?: string[] | null; base?: string },
                ) => {
                    if (opts.base === undefined) seen.push(opts.files);
                    return '';
                },
            });
            expect(seen).toEqual([[], ['core/new.ts']]);
        });

        it('обрезанный дифф повторного планировщика называет новый файл для дочитывания', () => {
            const files = [['core/old.ts'], ['core/old.ts', 'core/new.ts']];
            const { runClaudeFn } = runPlannerPath(
                {
                    phaseDiffFilesFn: () => files.shift() ?? ['core/old.ts', 'core/new.ts'],
                    reviewDiffContextFn: (
                        branch: string,
                        opts: { files?: string[] | null; limit?: number; base?: string },
                    ) =>
                        ralph.reviewDiffContext(branch, {
                            ...opts,
                            shFn: () => 'x'.repeat(500),
                            runArgvFn: () => '',
                            logFn: () => {},
                        }),
                },
                {},
                { config: { review: { default: 'claude-rev', maxTurns: 37, diffLimit: 100 } } },
            );
            const plannerPrompt = runClaudeFn.mock.calls.find(([prompt]) =>
                prompt.includes('Ты планировщик правок'),
            )?.[0];
            expect(plannerPrompt).toContain('- core/new.ts');
            expect(plannerPrompt).toContain('ДИФФ ОБРЕЗАН');
            expect(plannerPrompt).toMatch(/дочитай по файлам/i);
        });

        it('планировщик упал → правки не запущены, стоп fix-plan с кодом', () => {
            expectPlanStop(runPlannerPath({}, { code: 1 }), /кодом 1/);
        });

        it('вывод планировщика без блока → правки не запущены, стоп fix-plan с разбором', () => {
            expectPlanStop(
                runPlannerPath({}, { output: 'План готов, но маркеров нет' }),
                /блока плана нет/,
            );
        });

        it('планировщик сдвинул HEAD → правки не запущены, стоп fix-plan с обоими SHA', () => {
            const heads = ['a'.repeat(40), 'b'.repeat(40)];
            expectPlanStop(
                runPlannerPath({ branchHeadShaFn: () => heads.shift() ?? 'b'.repeat(40) }),
                /HEAD ветки feature\/m1 изменился/,
            );
        });

        it('планировщик оставил грязное дерево → правки не запущены, стоп fix-plan', () => {
            expectPlanStop(
                runPlannerPath({
                    shFn: (command: string) =>
                        command === 'git status --porcelain' ? ' M core/x.ts' : '',
                }),
                /дерево после сессии грязное/,
            );
        });

        const stateWithSavedPlan = (detail?: unknown): ReturnType<typeof mkState> => {
            const at = '2026-01-01T00:00:00.000Z';
            let records: ReturnType<typeof startStage> = [];
            for (const stage of ['pr', 'review'] as const) {
                records = startStage(records, 'M1', stage, at);
                records = finishStage(records, 'M1', stage, 'ok', at);
            }
            records = startStage(records, 'M1', 'plan', at);
            records = finishStage(records, 'M1', 'plan', 'ok', at, detail);
            return mkState({ submitStages: records });
        };

        it('рестарт после plan: ok → планировщик не повторяется, правки получают сохранённый план', () => {
            const { runClaudeFn } = runPlannerPath(
                {},
                {},
                {
                    state: stateWithSavedPlan({ plan }),
                },
            );
            const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
            expect(prompts.some((prompt) => prompt.includes('Ты планировщик правок'))).toBe(false);
            const fixPrompt = prompts.find((prompt) =>
                prompt.includes('Разбери замечания code review'),
            );
            expect(fixPrompt).toContain(`Решение: ${plan.decision}`);
            expect(fixPrompt).toContain(plan.steps[0].do);
        });

        it.each([
            ['без detail.plan', undefined, /план — не объект/],
            [
                'с повреждённым detail.plan',
                { plan: { decision: 'неполный' } },
                /rejected — не массив/,
            ],
        ])(
            'рестарт после plan: ok %s → стоп fix-plan, правки не запущены',
            (_name, detail, error) => {
                expectPlanStop(
                    runPlannerPath({}, {}, { state: stateWithSavedPlan(detail) }),
                    error,
                );
            },
        );

        it('#247: круг лестницы с блокером → планировщик до повторных правок, план в промпте', () => {
            let applications = 0;
            let head = 1;
            const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
                if (prompt.includes('Ты планировщик правок')) {
                    emitOutput(d, planOutput, 0);
                } else if (prompt.includes('Разбери замечания code review')) {
                    head++;
                }
                return 0;
            });

            runLoop(
                validCfg({ review: { default: 'claude-rev' } }),
                ctx(mkState()),
                deps([], {
                    pickReviewModelFn: () => 'claude-rev',
                    runClaudeFn,
                    branchHeadShaFn: () => head.toString(16).repeat(40),
                    phaseDiffFilesFn: () => ['core/x.ts'],
                    applySessionRequestsFn: () => ({
                        applied: 1,
                        failed: false,
                        closedIssues: [],
                        prFindings:
                            ++applications === 1 || applications === 3 ? reviewFindings : [],
                        prBlocked: false,
                    }),
                    tryMergePhaseFn: () => 'merged',
                }),
            );

            const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
            const plannerCalls = prompts.flatMap((prompt, index) =>
                prompt.includes('Ты планировщик правок') ? [index] : [],
            );
            const fixCalls = prompts.flatMap((prompt, index) =>
                prompt.includes('Разбери замечания code review') ? [index] : [],
            );
            expect(plannerCalls).toHaveLength(2);
            expect(fixCalls).toHaveLength(2);
            expect(plannerCalls[1]).toBeGreaterThan(fixCalls[0]);
            expect(plannerCalls[1]).toBeLessThan(fixCalls[1]);
            expect(prompts[fixCalls[1]]).toContain(`Решение: ${plan.decision}`);
            expect(prompts[fixCalls[1]]).toContain(plan.steps[0].do);
        });

        const runBlockedPath = (
            runClaudeFn: RunClaudeFake,
            overrides: Record<string, unknown> = {},
        ): void => {
            runLoop(
                validCfg({ blockedHealAttempts: 3 }),
                ctx(mkState({ submitted: true, lastReviewModel: 'claude-rev' })),
                deps([], {
                    tryMergePhaseFn: () => 'blocked',
                    pickReviewModelFn: () => 'claude-rev',
                    runClaudeFn,
                    ...overrides,
                }),
            );
        };

        it('#247: разбор blocked → планировщик до чини-сессии, план в её промпте', () => {
            const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
                if (prompt.includes('Ты планировщик правок')) {
                    emitOutput(d, planOutput, 0);
                }
                return 0;
            });

            runBlockedPath(runClaudeFn);

            const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
            const planAt = prompts.findIndex((prompt) => prompt.includes('Ты планировщик правок'));
            const fixAt = prompts.findIndex((prompt) =>
                prompt.includes('PR ветки feature/m1 помечен меткой blocked'),
            );
            expect(planAt).toBeGreaterThanOrEqual(0);
            expect(fixAt).toBeGreaterThan(planAt);
            expect(prompts[fixAt]).toContain(`Решение: ${plan.decision}`);
            expect(prompts[fixAt]).toContain(plan.steps[0].do);
        });

        it('#247: отказ планировщика blocked → чини-сессии нет, стоп fix-plan', () => {
            const pushes: string[] = [];
            const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
                if (prompt.includes('Ты планировщик правок')) {
                    emitOutput(d, 'planner failed', 1);
                    return 1;
                }
                return 0;
            });

            runBlockedPath(runClaudeFn, {
                pushEventFn: (message: string) => {
                    pushes.push(message);
                    return false;
                },
            });

            const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
            expect(
                prompts.some((prompt) =>
                    prompt.includes('PR ветки feature/m1 помечен меткой blocked'),
                ),
            ).toBe(false);
            expect(pushes).toHaveLength(1);
            expect(pushes[0]).toContain('fix-plan');
            expect(pushes[0]).toMatch(/кодом 1/);
        });

        it('#247: продолжение blocked по бюджету ходов использует тот же план без перепланирования', () => {
            let fixAttempts = 0;
            const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
                if (prompt.includes('Ты планировщик правок')) {
                    emitOutput(d, planOutput, 0);
                    return 0;
                }
                if (prompt.includes('PR ветки feature/m1 помечен меткой blocked')) {
                    fixAttempts++;
                    if (fixAttempts === 1) {
                        emitOutput(d, 'Error: Reached max turns (200)', 1);
                        return 1;
                    }
                }
                return 0;
            });

            runBlockedPath(runClaudeFn);

            const prompts = runClaudeFn.mock.calls.map(([prompt]) => prompt);
            const plannerCalls = prompts.filter((prompt) =>
                prompt.includes('Ты планировщик правок'),
            );
            const fixPrompts = prompts.filter((prompt) =>
                prompt.includes('PR ветки feature/m1 помечен меткой blocked'),
            );
            expect(plannerCalls).toHaveLength(1);
            expect(fixPrompts).toHaveLength(2);
            expect(fixPrompts[1]).toContain('ПРОДОЛЖЕНИЕ прерванного разбора');
            for (const prompt of fixPrompts) {
                expect(prompt).toContain(`Решение: ${plan.decision}`);
                expect(prompt).toContain(plan.steps[0].do);
            }
        });
    });

    // Снятие барьера #415 для taskSource. Раньше `tryMergePhase` брал примитивы форжа из
    // замыкания gate.ts, поэтому недефолтная реализация шва была бы «тихим дефолтом» —
    // резолвер её и отвергал. Теперь composition root передаёт их явно.
    //
    // Сверять с функциями gate.ts бессмысленно: маппер адаптера отдаёт ТЕ ЖЕ боевые
    // ссылки, и «через шов» от «напрямую» так не отличить. А вот сверка с КОНКРЕТНЫМ
    // методом шва осмысленна и ловит на порядок больше: `typeof === 'function'` осталось
    // бы зелёным и при перепутанных местами ключах (findOpenPrFn ← isPhaseMerged), то
    // есть при семантически сломанной сборке.
    it('#415: мердж-путь получает примитивы форжа из adapters.taskSource', () => {
        // #46: фаза уже сдана (submitted) — шаг заведения PR пропускается, и хук
        // `findOpenPrFn` остаётся дефолтным, то есть методом шва. Ровно это тест и
        // проверяет: подменённый в deps стаб доказывал бы обратное.
        // Опции ловим замыканием, а не через mock.calls: у фейка без объявленных
        // параметров кортеж вызова пуст для типов, и обращение к [1] — ошибка tsc.
        let seen: Record<string, unknown> = {};
        const tryMergePhaseFn = (_phase: unknown, opts: Record<string, unknown> = {}) => {
            seen = opts;
            return 'merged' as const;
        };
        // Собственный фейк проверки мерджа — заодно доказывает, что канал сквозной:
        // `phaseMergedFn` у runLoop это DI-параметр, и мердж-путь обязан получить именно
        // подменённую функцию, а не метод шва в обход подмены.
        const phaseMergedFn = () => false;
        const d = deps([], {
            openIssuesFn: () => [],
            allOpenIssuesFn: () => [],
            phaseMergedFn,
            runClaudeFn: () => 0,
            tryMergePhaseFn,
        }) as Record<string, unknown>;
        delete d.findOpenPrFn;
        runLoop(validCfg({}), ctx({ ...mkState(), submitted: true }), d);
        const { taskSource } = ralph.getAdapters();
        expect(seen.findOpenPrFn).toBe(taskSource.findOpenPullRequest);
        expect(seen.mergePrFn).toBe(taskSource.mergePullRequest);
        // #49: голова PR — четвёртый примитив форжа мердж-пути. Без этого ассерта потеря
        // строки в runLoop не краснит НИЧЕГО (проверено мутацией): `tryMergePhase` молча
        // уходит на дефолт `env.prHeadSha` — GitHub-реализацию, — и на площадке
        // воспроизводится ровно баг #49, при полностью зелёном сьюте.
        expect(seen.prHeadShaFn).toBe(taskSource.pullRequestHeadSha);
        // #269: чек PR у форжа — пятый и шестой примитивы мердж-пути, и цена потери строки
        // здесь та же, что у #49: шов НЕОБЯЗАТЕЛЬНЫЙ, поэтому `tryMergePhase` молча
        // пропустит шаг, набор останется зелёным, а на площадке воспроизведётся исходный
        // отказ #269 — «мердж отказан 400» при зелёном локальном гейте (находка ревью).
        expect(seen.forgeChecksFn).toBe(taskSource.pullRequestChecks);
        expect(seen.forgeDiagnosisFn).toBe(taskSource.redCheckDiagnosis);
        expect(seen.phaseMergedFn).toBe(phaseMergedFn);
    });

    // #221 критерий 3: общий cfg.fallbackModel не должен влиять на ревью, когда
    // review.fallback вообще не задан — pickReviewFallbackModel дефолтит на
    // review.default, а НЕ на cfg.fallbackModel.
    it('#221: без review.fallback общий cfg.fallbackModel в ревью не попадает — дефолт на review.default', () => {
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({
                fallbackModel: 'claude-sonnet-5',
                review: { default: 'claude-opus-4-8' },
            }),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        // #46: ревью — ПЕРВЫЙ вызов модели в сдаче (сессии создания PR больше нет).
        expect(runClaudeFn.mock.calls[0][1].fallbackModel).toBe('claude-opus-4-8');
        expect(runClaudeFn.mock.calls[0][1].fallbackModel).not.toBe('claude-sonnet-5');
    });

    // #169: журнал находок ревью — запись пишется сразу при мердже фазы, тем же приёмом,
    // что closeMilestoneByTitle/syncProjectBoard (единая точка gate === 'merged').
    it('#169 гейт merged → recordReviewFindingsFn зовётся с фазой и номером PR из гейта', () => {
        const recordReviewFindingsFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                getLastGatePr: () => 42,
                recordReviewFindingsFn,
            }),
        );
        expect(recordReviewFindingsFn).toHaveBeenCalledTimes(1);
        expect(recordReviewFindingsFn.mock.calls[0][0]).toMatchObject({ milestone: 'M1' });
        expect(recordReviewFindingsFn.mock.calls[0][1]).toBe(42);
    });

    it('#87 prod: гейт merged → деплой-плейсхолдер вызван, loop останавливается (не берёт следующую фазу)', () => {
        const logs: string[] = [];
        const closeMilestoneByTitleFn = vi.fn();
        const advancePhaseFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'merged');
        const pushEventFn = vi.fn();
        const deployPhaseFn = vi.fn();
        const phaseIndexOfFn = vi.fn(() => 0); // не 99 на втором вызове — если дойдёт, тест это увидит
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn,
                closeMilestoneByTitleFn,
                advancePhaseFn,
                pushEventFn,
                deployPhaseFn,
            }),
        );
        expect(closeMilestoneByTitleFn).toHaveBeenCalledWith('M1');
        expect(advancePhaseFn).toHaveBeenCalledTimes(1);
        expect(deployPhaseFn).toHaveBeenCalledTimes(1);
        expect(deployPhaseFn.mock.calls[0][0]).toMatchObject({ milestone: 'M1' });
        // #87: prod останавливается ПЕРЕД деплоем — второй проход while (следующая фаза)
        // не должен состояться, phaseIndexOfFn зовётся ровно 1 раз.
        expect(phaseIndexOfFn).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/остановлен перед деплоем/);
    });

    it('#163 prod: после merged раннер дожидается итога deploy-workflow на смердженном sha', () => {
        const logs: string[] = [];
        const mergedShaOfFn = vi.fn(() => 'a'.repeat(40));
        const waitForDeployRunFn = vi.fn<WaitDeployFake>(() => ({
            status: 'completed',
            conclusion: 'success',
        }));
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                mergedShaOfFn,
                waitForDeployRunFn,
            }),
        );
        // sha мерджа получен и передан в ожидание итога workflow.
        expect(mergedShaOfFn).toHaveBeenCalledTimes(1);
        expect(waitForDeployRunFn).toHaveBeenCalledTimes(1);
        expect(waitForDeployRunFn.mock.calls[0][0]).toBe('a'.repeat(40));
        expect(logs.join('\n')).toMatch(/итог workflow — completed \(success\)/);
    });

    // #51: деплоя в проекте может не быть вовсе. Тогда пост-мердж проверка не «падает
    // fail-closed», а НЕ ПРОВОДИТСЯ: fail-closed отвечает на вопрос «релиз зелёный?», а
    // здесь вопроса нет. Раньше выбора не было — шов оставался github-actions, звал `gh`
    // (которого на площадке нет) и красил каждую смердженную фазу.
    it('#51 prod: деплой выключен → пост-мердж проверка пропущена, красного блока нет', () => {
        const logs: string[] = [];
        const mergedShaOfFn = vi.fn(() => 'a'.repeat(40));
        const waitForDeployRunFn = vi.fn<WaitDeployFake>();
        const checkProdHealthFn = vi.fn(() => ({ ok: true, status: 200, url: 'u' }));
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                deployEnabledFn: () => false,
                mergedShaOfFn,
                waitForDeployRunFn,
                checkProdHealthFn,
            }),
        );
        // Ни одного обращения к деплой-механике: на площадке каждое из них — поход в `gh`.
        expect(mergedShaOfFn).not.toHaveBeenCalled();
        expect(waitForDeployRunFn).not.toHaveBeenCalled();
        expect(checkProdHealthFn).not.toHaveBeenCalled();
        // И, главное, никакого красного блока — фаза сдана, трек не остановлен разбором.
        expect(logs.join('\n')).not.toMatch(/деплой красный/);
        expect(logs.join('\n')).toMatch(/деплоя нет/);
        // Пауза prod перед релизом остаётся — она про «человек решает, что дальше»,
        // а не про проверку деплоя (#87), и от наличия деплоя не зависит.
        expect(logs.join('\n')).toMatch(/остановлен перед деплоем/);
    });

    // #53: асинхронный мердж площадки. Гейт вернул «принято, но не подтверждено» — петля
    // обязана встать, не трогая фазу: advancePhase здесь означал бы, что следующая фаза
    // строится поверх main, про который ничего не известно.
    it('#53: merge-unconfirmed → стоп с пушем, фаза не продвигается', () => {
        const logs: string[] = [];
        const advancePhaseFn = vi.fn();
        const pushEventFn = vi.fn();
        const phaseIndexOfFn = vi.fn(() => 0);
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merge-unconfirmed',
                advancePhaseFn,
                pushEventFn,
            }),
        );
        expect(advancePhaseFn).not.toHaveBeenCalled();
        // Стоп, а не следующая итерация: phaseIndexOf зовётся ровно один раз.
        expect(phaseIndexOfFn).toHaveBeenCalledTimes(1);
        // Ревью #289: хвост «Проверь PR — если он влит, перезапуск продолжит сам» снят
        // из заголовка как дословный повтор вопроса человеку; факт живёт в диагнозе.
        const mergeUnconfirmed = pushEventFn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(mergeUnconfirmed).toMatch(/мердж PR #\? не подтверждён/);
        expect(mergeUnconfirmed).toMatch(/диагноз: форж принял мердж .* не подтвердил его/);
    });

    // #51-ревью: «деплоя нет» и «деплой зелёный» — разные факты, и лог обязан их различать.
    // Комбинация «шов none + haltBeforeDeploy: false» легальна (preflight её не отсекает), а
    // строка «деплой зелёный» в утреннем разборе ralph.log читается как подтверждённый релиз.
    it('#51: непрерывный prod без деплоя — лог не утверждает «деплой зелёный»', () => {
        const logs: string[] = [];
        runLoop(
            validCfg({ profileName: 'prod', haltBeforeDeploy: false }),
            ctx(mkState()),
            deps(logs, {
                // Вторая итерация упрётся в «фаз больше нет» — непрерывный режим на то и
                // непрерывный, нам нужен только текст после первой.
                phaseIndexOfFn: (() => {
                    let n = 0;
                    return () => (n++ === 0 ? 0 : 99);
                })(),
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                deployEnabledFn: () => false,
            }),
        );
        const text = logs.join('\n');
        expect(text).toMatch(/деплоя нет \(проверять нечего\)/);
        expect(text).not.toMatch(/деплой зелёный/);
    });

    it('#163 prod: сбой получения sha/итога деплоя не роняет loop — логируется и стоп перед деплоем', () => {
        const logs: string[] = [];
        const waitForDeployRunFn = vi.fn<WaitDeployFake>();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                mergedShaOfFn: () => {
                    throw new Error('gh недоступен');
                },
                waitForDeployRunFn,
            }),
        );
        // sha получить не удалось → ожидание итога не зовём, но loop не падает.
        expect(waitForDeployRunFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/не удалось дождаться итога деплоя/);
        // Не удалось подтвердить деплой = красный (fail-closed) → красный текст стопа.
        expect(logs.join('\n')).toMatch(/стоп: деплой красный/);
    });

    it('#164 prod: зелёный workflow (conclusion success) → healthcheck прода зовётся', () => {
        const logs: string[] = [];
        const checkProdHealthFn = vi.fn(() => ({ ok: true, status: 200, url: 'u' }));
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({ status: 'completed', conclusion: 'success' }),
                checkProdHealthFn,
            }),
        );
        expect(checkProdHealthFn).toHaveBeenCalledTimes(1);
    });

    it('#164 prod: упавший workflow (conclusion failure) → healthcheck НЕ зовётся, красный итог уже сигнал сам по себе', () => {
        const logs: string[] = [];
        const checkProdHealthFn = vi.fn();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({ status: 'completed', conclusion: 'failure' }),
                checkProdHealthFn,
            }),
        );
        expect(checkProdHealthFn).not.toHaveBeenCalled();
    });

    it('#164 prod: недосмотренный workflow (status timeout) → healthcheck НЕ зовётся', () => {
        const logs: string[] = [];
        const checkProdHealthFn = vi.fn();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({ status: 'timeout', conclusion: null }),
                checkProdHealthFn,
            }),
        );
        expect(checkProdHealthFn).not.toHaveBeenCalled();
    });

    it('#165 prod: упавший workflow → барьер в state.deployBlock + пуш с sha и итогом, стоп', () => {
        const logs: string[] = [];
        const saved: Array<Record<string, unknown>> = [];
        const pushEventFn = vi.fn();
        const state = mkState();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                saveStateFn: (s: Record<string, unknown>) => saved.push({ ...s }),
                waitForDeployRunFn: () => ({
                    status: 'completed',
                    conclusion: 'failure',
                    sha: 'a'.repeat(40),
                    url: 'https://gh/run/1',
                }),
                pushEventFn,
            }),
        );
        // барьер сохранён в state
        expect(state.deployBlock).toMatchObject({ milestone: 'M1', conclusion: 'failure' });
        expect(saved.some((s) => s.deployBlock)).toBe(true);
        // пуш с sha и итогом workflow — критерий #165
        const redPush = pushEventFn.mock.calls.find((c) => /деплой красный/.test(c[0]));
        expect(redPush).toBeTruthy();
        expect(redPush![0]).toMatch(/aaaaaaaa/); // укороченный sha
        expect(redPush![0]).toMatch(/failure/);
        expect(logs.join('\n')).toMatch(/стоп: деплой красный/);
    });

    it('#165 prod: недосмотренный workflow (timeout) → тоже барьер + пуш', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const state = mkState();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({
                    status: 'timeout',
                    conclusion: null,
                    sha: 'b'.repeat(40),
                }),
                pushEventFn,
            }),
        );
        expect(state.deployBlock).toMatchObject({ milestone: 'M1', status: 'timeout' });
        expect(pushEventFn.mock.calls.some((c) => /деплой красный/.test(c[0]))).toBe(true);
    });

    it('#165 prod: зелёный workflow + здоровый прод → барьера НЕТ, красного пуша нет', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const state = mkState();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({
                    status: 'completed',
                    conclusion: 'success',
                    sha: 'a'.repeat(40),
                }),
                checkProdHealthFn: () => ({ ok: true, status: 200, url: 'u' }),
                pushEventFn,
            }),
        );
        expect(state.deployBlock == null).toBe(true);
        expect(pushEventFn.mock.calls.some((c) => /деплой красный/.test(c[0]))).toBe(false);
        // при этом обычный пуш «готова к релизу» уходит
        expect(pushEventFn.mock.calls.some((c) => /готова к релизу/.test(c[0]))).toBe(true);
    });

    it('#165 prod: зелёный workflow, но прод не отвечает → барьер + пуш', () => {
        const state = mkState();
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(state),
            deps([], {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({
                    status: 'completed',
                    conclusion: 'success',
                    sha: 'a'.repeat(40),
                }),
                checkProdHealthFn: () => ({ ok: false, status: 502, url: 'u' }),
                pushEventFn,
            }),
        );
        expect(state.deployBlock).toBeTruthy();
        expect(state.deployBlock!.reason).toMatch(/прод не отвечает/);
        expect(pushEventFn.mock.calls.some((c) => /деплой красный/.test(c[0]))).toBe(true);
    });

    it('#165 prod: сбой чтения итога (mergedShaOf бросает) → fail-closed барьер + пуш, не тихий пропуск', () => {
        const state = mkState();
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ profileName: 'prod' }),
            ctx(state),
            deps([], {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                mergedShaOfFn: () => {
                    throw new Error('gh недоступен');
                },
                pushEventFn,
            }),
        );
        expect(state.deployBlock).toMatchObject({ status: 'error' });
        expect(state.deployBlock!.reason).toMatch(/ошибка проверки деплоя/);
        expect(pushEventFn.mock.calls.some((c) => /деплой красный/.test(c[0]))).toBe(true);
    });

    it('#87 playground: гейт merged → деплой-плейсхолдер НЕ зовётся, мердж остаётся финалом (continue как раньше)', () => {
        const logs: string[] = [];
        const tryMergePhaseFn = vi.fn(() => 'merged');
        const deployPhaseFn = vi.fn();
        runLoop(
            validCfg(), // profileName не задан → playground
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn,
                deployPhaseFn,
            }),
        );
        expect(deployPhaseFn).not.toHaveBeenCalled();
        // deps() даёт phaseIndexOfFn-счётчик: 2-й вызов «за концом» → «все фазы завершены».
        expect(logs.join('\n')).toMatch(/Все фазы завершены/);
    });

    it('#249 prod: haltBeforeDeploy=true (явно) → стоп после фазы, документированный «либо true»', () => {
        // Undefined-дефолт покрыт тестом #87 выше; здесь — явный true. Документация
        // обещает «не задан ЛИБО true», и регрессию при будущей правке условия `!== false`
        // поймает именно явный кейс (undefined его не отличит от прочих falsy-путей).
        const logs: string[] = [];
        const phaseIndexOfFn = vi.fn(() => 0);
        runLoop(
            validCfg({ profileName: 'prod', haltBeforeDeploy: true }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({ status: 'completed', conclusion: 'success' }),
                checkProdHealthFn: () => ({ ok: true, status: 200, url: 'u' }),
            }),
        );
        // Явный true = #87: стоп сразу после фазы, вторая фаза этим же процессом не начинается.
        expect(phaseIndexOfFn).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/остановлен перед деплоем/);
    });

    it('#249 prod: haltBeforeDeploy=false + зелёный пост-мердж деплой → фазы катятся подряд без рестарта', () => {
        const logs: string[] = [];
        // Счётчик-замыкание (как дефолтный deps.phaseIndexOfFn): фаза 0, затем 1, затем
        // «за концом» массива → break. Прозрачнее самоссылки на mock.calls.length.
        let i = 0;
        const phaseIndexOfFn = vi.fn(() => (i < 2 ? i++ : 99));
        const deployPhaseFn = vi.fn();
        const advancePhaseFn = vi.fn();
        runLoop(
            validCfg({
                profileName: 'prod',
                haltBeforeDeploy: false,
                phases: [
                    { milestone: 'M1', branch: 'feature/m1' },
                    { milestone: 'M2', branch: 'feature/m2' },
                ],
            }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({ status: 'completed', conclusion: 'success' }),
                checkProdHealthFn: () => ({ ok: true, status: 200, url: 'u' }),
                deployPhaseFn,
                advancePhaseFn,
            }),
        );
        // Обе фазы отработаны в одном процессе — без остановки между ними.
        expect(deployPhaseFn).toHaveBeenCalledTimes(2);
        expect(advancePhaseFn).toHaveBeenCalledTimes(2);
        expect(logs.join('\n')).not.toMatch(/loop остановлен перед деплоем/);
        expect(logs.join('\n')).toMatch(/haltBeforeDeploy=false — продолжаю без остановки/);
        expect(logs.join('\n')).toMatch(/Все фазы завершены/);
    });

    it('#249 prod: haltBeforeDeploy=false, но пост-мердж деплой красный → трек всё равно стопорится (fail-closed)', () => {
        const logs: string[] = [];
        const phaseIndexOfFn = vi.fn(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({
                profileName: 'prod',
                haltBeforeDeploy: false,
                phases: [
                    { milestone: 'M1', branch: 'feature/m1' },
                    { milestone: 'M2', branch: 'feature/m2' },
                ],
            }),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'none',
                runClaudeFn: () => 0,
                tryMergePhaseFn: () => 'merged',
                waitForDeployRunFn: () => ({
                    status: 'completed',
                    conclusion: 'failure',
                    sha: 'a'.repeat(40),
                }),
                pushEventFn,
            }),
        );
        // Красный деплой стопорит трек несмотря на haltBeforeDeploy=false — вторая фаза не
        // начинается этим же процессом (phaseIndexOfFn зовётся ровно 1 раз).
        expect(phaseIndexOfFn).toHaveBeenCalledTimes(1);
        // Красный исход даёт СВОЙ текст стопа (деплой уже случился и он красный), а не
        // общее «остановлен перед деплоем» флага halt.
        expect(logs.join('\n')).toMatch(/стоп: деплой красный.*--deploy-resolved/s);
        expect(logs.join('\n')).not.toMatch(/loop остановлен перед деплоем/);
        expect(logs.join('\n')).not.toMatch(/haltBeforeDeploy=false — продолжаю без остановки/);
        expect(pushEventFn.mock.calls.some((c) => /деплой красный/.test(c[0]))).toBe(true);
    });

    // #46: PR заводит петля, а не сессия. Отказ форжа обязан быть стопом: ревью и правки
    // поверх несуществующего PR — это сожжённые сессии и «сдача» без предмета.
    it('#46 заведение PR упало → fail-closed стоп с пушем, гейт не зовётся', () => {
        const logs: string[] = [];
        const tryMergePhaseFn = vi.fn(() => 'merged');
        const runClaudeFn = vi.fn(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                createPrFn: () => {
                    throw new Error('форж отверг создание PR');
                },
                runClaudeFn,
                tryMergePhaseFn,
                pushEventFn,
            }),
        );
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn.mock.calls[0][0]).toMatch(/PR фазы .* не заведён/);
    });

    it('#46 открытый PR ветки уже есть → второй не создаётся, сдача идёт дальше', () => {
        const createPrFn = vi.fn(() => 7);
        const runClaudeFn = vi.fn(() => 0);
        runLoop(
            validCfg(),
            ctx(mkState()),
            // phaseIndexOfFn НЕ подменяем: дефолт deps отдаёт «за концом массива» со второго
            // прохода, иначе смерджённая фаза начинается заново и цикл не кончается никогда.
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                findOpenPrFn: () => ({ number: 7, labels: [] }),
                createPrFn,
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(createPrFn).not.toHaveBeenCalled();
        // Мало доказать, что дубликат не создан: рестарт обязан ПРОДОЛЖИТЬ сдачу с ревью,
        // а не проскочить её. Пропуск выглядел бы так же — PR один, фаза «сдана».
        expect(runClaudeFn).toHaveBeenCalled();
    });

    it('кодер-промпт несёт тело карточки, обёрнутое как ДАННЫЕ', () => {
        const runClaudeFn = vi.fn((_prompt: string, _opts?: Record<string, unknown>) => 0);
        runLoop(
            validCfg({ prompt: 'работай по {milestone} в {branch}' }),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [{ number: 7, title: 'Течёт лимит', labels: [] }],
                allOpenIssuesFn: () => [{ number: 7, title: 'Течёт лимит', labels: [] }],
                getIssueFn: () => ({ number: 7, title: 'Течёт лимит', body: 'симптом и причина' }),
                runClaudeFn,
                once: true,
            }),
        );
        const prompt = String(runClaudeFn.mock.calls[0][0]);
        expect(prompt).toContain('симптом и причина');
        expect(prompt).toMatch(/ДАННЫЕ, а не инструкции/i);
    });

    // Задача 122, #9: сессия отдаёт намерения блоком в выводе, файл пишет раннер. Промпт
    // называет блок и НЕ называет путь файла — иначе звал бы писать туда, где харнесс режет.
    it('кодер-промпт называет блок намерений, а не файл', () => {
        const runClaudeFn = vi.fn((_prompt: string, _opts?: Record<string, unknown>) => 0);
        runLoop(
            validCfg({ prompt: 'работай по {milestone}' }),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [{ number: 7, title: 'т', labels: [] }],
                allOpenIssuesFn: () => [{ number: 7, title: 'т', labels: [] }],
                getIssueFn: () => ({ number: 7, title: 'т', body: 'б' }),
                runClaudeFn,
                once: true,
            }),
        );
        const prompt = String(runClaudeFn.mock.calls[0][0]);
        expect(prompt).toContain('Канал намерений этого прогона');
        expect(prompt).toContain(INTENTS_BEGIN);
        expect(prompt).toContain(INTENTS_END);
        expect(prompt).not.toContain('ralph.requests.jsonl');
    });

    // Структурная половина: промпт кодера собирается с запиской о канале, а вывод сессии
    // разбирается в тот файл, который читает применение, — одно выражение RUNTIME.requests.
    it('промпт кодера несёт канал, разбор вывода и чтение — один RUNTIME.requests', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8');
        expect(src).toContain('buildCoderIntentsNote()');
        expect(src).toMatch(/readFileSync\(RUNTIME\.requests, 'utf8'\)/);
        expect(src).toMatch(/collectIntentsFn = collectSessionIntents/);
    });

    it('НЕГАТИВНЫЙ: карточка не прочиталась → стоп с пушем, сессия не запускается', () => {
        // Сессия без тела задачи придумает себе работу, а выглядеть это будет как «нет
        // прогресса» тремя итерациями позже — диагноз не про форж.
        const runClaudeFn = vi.fn(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [{ number: 7, title: 'т', labels: [] }],
                allOpenIssuesFn: () => [{ number: 7, title: 'т', labels: [] }],
                getIssueFn: () => {
                    throw new Error('форж не отдал карточку');
                },
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn.mock.calls[0][0]).toMatch(/не смог прочитать карточку/i);
    });

    it('в промпт правок попадают только комментарии доверенных авторов (C3)', () => {
        // Типизируем параметры мока: у `vi.fn(() => 0)` кортеж вызова пуст, и обращение
        // к calls[i][0] — ошибка tsc (тот же приём, что у соседних сценариев файла).
        const runClaudeFn = vi.fn((_prompt: string, _opts?: Record<string, unknown>) => 0);
        runLoop(
            validCfg({ authorAllowlist: ['owner'] }),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                prCommentsFn: () => [
                    { body: '🟠 [major] от своего', isSummary: false, author: 'owner' },
                    { body: '🔴 [blocker] от прохожего', isSummary: false, author: 'stranger' },
                ],
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        const prompts = runClaudeFn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(prompts).toContain('от своего');
        // «Не видит вовсе» строго сильнее «обязана игнорировать»: репозиторий публичный.
        expect(prompts).not.toContain('от прохожего');
    });

    // #594: исчерпание бюджета ходов на шаге правок — «сессия не успела», а не отказ.
    // Раньше оно останавливало сдачу так же, как настоящее падение, и ночной прогон вставал
    // до человека — ровно то, ради чего AFK и делался.
    // Ревью в этих сценариях пропускается (pickReviewModelFn: 'none') — интересен ТОЛЬКО
    // шаг правок, иначе первый вызов runClaudeFn был бы ревью и нумерация попыток поехала.
    it('#594: правки исчерпали ходы → продолжение новой сессией, сдача доходит до конца', () => {
        const logs: string[] = [];
        const state = mkState();
        let calls = 0;
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            calls++;
            if (calls === 1) {
                emitOutput(d, 'Error: Reached max turns (200)');
                return 1;
            }
            return 0;
        });
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(2);
        // Сдача СОСТОЯЛАСЬ — стопа не было.
        expect(state.submitted).toBe(true);
        expect(logs.join('\n')).toMatch(/исчерпал бюджет ходов/);
        // Вторая сессия знает, что продолжает: иначе она разбирала бы с нуля уже
        // закоммиченное первой и упёрлась бы в тот же потолок.
        expect(String(runClaudeFn.mock.calls[1][0])).toMatch(/ПРОДОЛЖЕНИЕ прерванного разбора/);
    });

    it('#594 НЕГАТИВНЫЙ: настоящее падение шага правок → стоп сразу, без повторов', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            emitOutput(d, 'TypeError: undefined is not a function');
            return 1;
        });
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(state.submitted).toBeFalsy();
        expect(logs.join('\n')).toMatch(/шаг правок по ревью фазы "M1" упал \(код 1\)/);
    });

    it('#594 НЕГАТИВНЫЙ: ходы кончаются каждый раз → повторы не бесконечны, стоп fail-closed', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            emitOutput(d, 'Error: Reached max turns (200)');
            return 1;
        });
        runLoop(
            validCfg({ review: { fixTurnRetries: 1 } }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        // Первая попытка + один повтор из конфига — и стоп.
        expect(runClaudeFn).toHaveBeenCalledTimes(2);
        expect(state.submitted).toBeFalsy();
        expect(logs.join('\n')).toMatch(/не уложился в бюджет ходов за 2 попыток/);
    });

    // #97/#45: первая сессия правок могла оставить обоснование пропуска намерением
    // `pr-comment` — продолжение по ходам обязано его видеть, иначе повторит отклонённую
    // правку. Поэтому продолжение перечитывает комментарии, а не берёт снятые до первой.
    it('#97: продолжение по ходам перечитывает комментарии PR — видит оставленное первой', () => {
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            if (runClaudeFn.mock.calls.length === 1) {
                emitOutput(d, 'Error: Reached max turns (200)');
                return 1;
            }
            return 0;
        });
        let reads = 0;
        runLoop(
            validCfg({ authorAllowlist: ['owner'], review: { fixTurnRetries: 1 } }),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                prCommentsFn: () => {
                    reads++;
                    const base = [
                        { body: '🟠 [major] замечание', isSummary: false, author: 'owner' },
                    ];
                    return reads === 1
                        ? base
                        : [
                              ...base,
                              { body: 'пропуск обоснован', isSummary: false, author: 'owner' },
                          ];
                },
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(runClaudeFn.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(String(runClaudeFn.mock.calls[0][0])).not.toContain('пропуск обоснован');
        expect(String(runClaudeFn.mock.calls[1][0])).toContain('пропуск обоснован');
    });

    it('#97: комментарии продолжения не прочитались — стоп, второй сессии нет', () => {
        const logs: string[] = [];
        const state = mkState();
        const pushEventFn = vi.fn();
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            emitOutput(d, 'Error: Reached max turns (200)');
            return 1;
        });
        let reads = 0;
        runLoop(
            validCfg({ review: { fixTurnRetries: 1 } }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                prCommentsFn: () => {
                    if (++reads > 1) throw new Error('форж молчит');
                    return [];
                },
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                pushEventFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(state.submitted).toBeFalsy();
        const pushes = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(pushes.some((m) => m.includes('(forge-unreadable)'))).toBe(true);
    });

    // #127: сбой чтения PR шов бросает. Для комментариев сессии сдачи это тот же стоп, что
    // у непрочитанных комментариев, — не крах петли без пуша и не промпт без замечаний.
    it('#127: PR не прочитался перед шагом сдачи — стоп forge-unreadable, сессии нет', () => {
        const logs: string[] = [];
        const state = mkState();
        const pushEventFn = vi.fn();
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        let reads = 0;
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                // Первое чтение — у заведения PR (PR есть), дальше форж лёг.
                findOpenPrFn: () => {
                    if (++reads > 1) throw new Error('HTTP 502');
                    return { number: 55, labels: [] };
                },
                prCommentsFn: () => [],
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                pushEventFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        const pushes = pushEventFn.mock.calls.map((c) => String(c[0]));
        const stop = pushes.find((m) => m.includes('PR ветки не прочитался'));
        expect(stop).toBeDefined();
        expect(stop).toContain('(forge-unreadable)');
        expect(stop).toContain('HTTP 502');
    });

    // #127: пока GitHub отдавал сбой чтения null, заведение PR читало его как «PR нет» и
    // заводило второй. Теперь бросок уходит в стоп «PR фазы не заведён».
    it('#127: PR ветки не прочитался при заведении — второй PR не создаётся, стоп', () => {
        const logs: string[] = [];
        const state = mkState();
        const pushEventFn = vi.fn();
        const createPrFn = vi.fn(() => 77);
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => {
                    throw new Error('HTTP 502');
                },
                createPrFn,
                runClaudeFn: vi.fn<RunClaudeFake>(() => 0),
                pushEventFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(createPrFn).not.toHaveBeenCalled();
        const pushes = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(pushes.some((m) => m.includes('не заведён') && m.includes('HTTP 502'))).toBe(true);
    });

    it('#594: fixTurnRetries: 0 → прежнее поведение, исчерпание ходов = стоп без повтора', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            emitOutput(d, 'Error: Reached max turns (200)');
            return 1;
        });
        runLoop(
            validCfg({ review: { fixTurnRetries: 0 } }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(state.submitted).toBeFalsy();
    });

    // #45 × #594: намерения применяются после КАЖДОЙ попытки, и их провал — стоп ДО решения
    // о повторе. Перестановка проверок местами молча запустила бы новую сессию поверх
    // неприменённого батча — вердикт ревью потерялся бы, а фаза поехала к гейту без него.
    it('#594: ходы исчерпаны, но намерения не применились → стоп сразу, повтор не запускается', () => {
        const logs: string[] = [];
        const state = mkState();
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            emitOutput(d, 'Error: Reached max turns (200)');
            return 1;
        });
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                applySessionRequestsFn: () => ({ applied: 0, failed: true }),
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(state.submitted).toBeFalsy();
        expect(logs.join('\n')).toMatch(/Намерения сессии \(правки по ревью\) не применились/);
    });

    // #85: сессия разбора закоммитила и не запушила — гейт после merge-вердикта отказал на
    // расхождении ref с головой PR, и вахта пушила руками. Пушит раннер, до повторного ревью.
    it('#85: незапушенный коммит сессии разбора → раннер пушит его до повторного ревью, фаза идёт дальше', () => {
        const logs: string[] = [];
        const order: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => {
            order.push('session');
            return 0;
        });
        const pushSessionCommitsFn = vi.fn((branch: string) => {
            order.push(`push:${branch}`);
            return { kind: 'pushed' as const, local: 'b'.repeat(40), remote: 'a'.repeat(40) };
        });
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                pushSessionCommitsFn,
                pushEventFn,
            }),
        );
        // Довоз на входе в гейт → планировщик → разбор → пуш раннером → повторное ревью:
        // ревью и гейт судят то, что в PR.
        expect(order).toEqual([
            'push:feature/m1',
            'session',
            'session',
            'push:feature/m1',
            'session',
        ]);
        expect(pushEventFn.mock.calls.some((c) => /оставлен человеку/.test(String(c[0])))).toBe(
            false,
        );
        expect(state.blockedHeals).toBe(1);
    });

    it('#85: остаток сессии разбора в дереве → сначала коммит остатка, потом пуш', () => {
        const order: string[] = [];
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(mkState({ submitted: true, lastReviewModel: 'claude-opus-4-8' })),
            deps([], {
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                // Грязное дерево — только после сессии разбора, а не на границе итерации.
                ensureCleanFn: (ctx: string) => ctx !== 'разбор blocked',
                commitLeftoversFn: (ctx: string) => {
                    order.push(`commit:${ctx}`);
                    return true;
                },
                pushSessionCommitsFn: () => {
                    order.push('push');
                    return { kind: 'in-sync' as const };
                },
            }),
        );
        // Первый пуш — довоз на входе в гейт, без коммита остатка.
        expect(order).toEqual(['push', 'commit:разбор blocked', 'push']);
    });

    it('#85: пуш коммитов сессии разбора отвергнут → стоп с причиной session-unpushed, без повторного ревью', () => {
        const logs: string[] = [];
        let pushes = 0;
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const removeBlockedLabelFn = vi.fn();
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(mkState({ submitted: true, lastReviewModel: 'claude-opus-4-8' })),
            deps(logs, {
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                removeBlockedLabelFn,
                // Первый пуш — довоз на входе в гейт: пушить нечего.
                pushSessionCommitsFn: () =>
                    ++pushes === 1
                        ? { kind: 'in-sync' as const }
                        : {
                              kind: 'failed' as const,
                              why: 'git push отвергнут — ! [rejected] (non-fast-forward)',
                              local: 'b'.repeat(40),
                              remote: 'a'.repeat(40),
                          },
                pushEventFn,
            }),
        );
        // Повторного ревью нет: судить пришлось бы то, чего нет в PR. Были планировщик и разбор.
        expect(runClaudeFn).toHaveBeenCalledTimes(2);
        expect(removeBlockedLabelFn).not.toHaveBeenCalled();
        const stops = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(stops).toHaveLength(1);
        expect(stops[0]).toContain('(session-unpushed)');
        expect(stops[0]).toContain('коммиты сессии не доехали до origin');
        expect(stops[0]).toContain('non-fast-forward');
        // Хвост вопроса этого шага: рестарт после ручного пуша ведёт сразу в гейт.
        expect(stops[0]).toContain('сдача не повторится, пойдёт сразу гейт');
        expect(stops[0]).toContain('bbbbbbbb');
        expect(stops[0]).not.toContain('(unknown)');
    });

    it('#85: локальный ref отстал от origin (behind) → без стопа, повторное ревью идёт дальше', () => {
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps([], {
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                pushSessionCommitsFn: () => ({
                    kind: 'behind' as const,
                    local: 'a'.repeat(40),
                    remote: 'b'.repeat(40),
                }),
                pushEventFn,
            }),
        );
        // Планировщик, разбор и повторное ревью — отставание гейт подтянет сам.
        expect(runClaudeFn).toHaveBeenCalledTimes(3);
        expect(pushEventFn.mock.calls.some((c) => /session-unpushed/.test(String(c[0])))).toBe(
            false,
        );
        expect(state.blockedHeals).toBe(1);
    });

    it('#85: dry-прогон разбора blocked не пушит', () => {
        const pushSessionCommitsFn = vi.fn(() => ({ kind: 'in-sync' as const }));
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(mkState({ submitted: true, lastReviewModel: 'claude-opus-4-8' })),
            deps([], {
                dry: true,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                pushSessionCommitsFn,
            }),
        );
        expect(pushSessionCommitsFn).not.toHaveBeenCalled();
    });

    // #224: сессия правок пушила после каждого коммита — каждый пуш заводил полный гейт CI
    // площадки. Пуш теперь раннера: один на круг правок, ДО гейта, который судит голову PR.
    it('#224: круг правок из двух сессий (ходы) → один пуш раннера после них, до гейта', () => {
        const order: string[] = [];
        let calls = 0;
        const runClaudeFn = vi.fn<RunClaudeFake>((_prompt, _opts, d) => {
            order.push('session');
            if (++calls === 1) {
                emitOutput(d, 'Error: Reached max turns (200)');
                return 1;
            }
            return 0;
        });
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                runClaudeFn,
                pushSessionCommitsFn: (branch: string) => {
                    order.push(`push:${branch}`);
                    return { kind: 'in-sync' as const };
                },
                tryMergePhaseFn: () => {
                    order.push('gate');
                    return 'merged';
                },
            }),
        );
        // Первый пуш — довоз остатка кодер-итераций до заведения PR, второй — круг правок.
        expect(order).toEqual(['push:feature/m1', 'session', 'session', 'push:feature/m1', 'gate']);
    });

    it('#224: остаток сессии правок коммитится и уезжает тем же пушем', () => {
        const order: string[] = [];
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                ensureCleanFn: (where: string) => where !== 'правки по ревью',
                commitLeftoversFn: (where: string) => {
                    order.push(`commit:${where}`);
                    return true;
                },
                pushSessionCommitsFn: () => {
                    order.push('push');
                    return { kind: 'pushed' as const, local: 'b'.repeat(40), remote: null };
                },
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(order).toEqual(['push', 'commit:правки по ревью', 'push']);
    });

    it('#224: пуш круга правок отвергнут → стоп session-unpushed, гейт не зовётся', () => {
        const tryMergePhaseFn = vi.fn(() => 'merged');
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        const state = mkState();
        let pushes = 0;
        runLoop(
            validCfg(),
            ctx(state),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                pushSessionCommitsFn: () =>
                    ++pushes === 1
                        ? { kind: 'in-sync' as const }
                        : {
                              kind: 'failed' as const,
                              why: 'git push отвергнут — ! [rejected] (non-fast-forward)',
                              local: 'b'.repeat(40),
                              remote: 'a'.repeat(40),
                          },
                pushEventFn,
                tryMergePhaseFn,
            }),
        );
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        expect(state.submitted).toBeFalsy();
        const stops = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(stops).toHaveLength(1);
        expect(stops[0]).toContain('(session-unpushed)');
        expect(stops[0]).toContain('правки по ревью');
        expect(stops[0]).toContain('non-fast-forward');
    });

    // Ревью 16c2: пуш чини-сессии гейта. Сессия пушить сама не может (`loop-push`), поэтому
    // её коммиты довозит раннер — и у упавшей тоже, до стопа, а не только у успешной.
    const healDeps = (order: string[], code: number, pushFn?: () => unknown) => ({
        openIssuesFn: () => [],
        allOpenIssuesFn: () => [],
        phaseMergedFn: () => false,
        tryMergePhaseFn: () => {
            order.push('gate');
            return 'red-checks' as const;
        },
        getLastRedCheck: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'boom' }),
        runClaudeFn: vi.fn<RunClaudeFake>(() => {
            order.push('session');
            return code;
        }),
        ensureCleanFn: (where: string) => {
            if (where === 'чини-сессия гейта') order.push(`clean:${where}`);
            return true;
        },
        pushSessionCommitsFn: () => {
            order.push('push');
            return (pushFn?.() ?? { kind: 'in-sync' }) as { kind: 'in-sync' };
        },
    });

    it('ревью 16c2: коммиты чини-сессии гейта — один пуш раннера до следующего прохода', () => {
        const order: string[] = [];
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(mkState({ submitted: true, gateHeals: 0 })),
            deps([], healDeps(order, 0)),
        );
        // Довоз на входе в гейт → гейт → сессия → (коммит остатка) → пуш.
        const session = order.indexOf('session');
        expect(order.slice(0, 2)).toEqual(['push', 'gate']);
        expect(order.slice(session + 1)).toContain('push');
        const after = order.slice(session + 1);
        expect(after.indexOf('clean:чини-сессия гейта')).toBeLessThan(after.indexOf('push'));
        expect(after.filter((x) => x === 'push').length).toBeGreaterThanOrEqual(1);
        expect(after.indexOf('push')).toBeLessThan(
            after.includes('gate') ? after.indexOf('gate') : Infinity,
        );
    });

    it('ревью 16c2: чини-сессия гейта упала → её коммиты запушены до стопа, остаток не тронут', () => {
        const order: string[] = [];
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        const commitLeftoversFn = vi.fn(() => true);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(mkState({ submitted: true, gateHeals: 0 })),
            deps([], { ...healDeps(order, 1), pushEventFn, commitLeftoversFn }),
        );
        expect(order).toEqual(['push', 'gate', 'session', 'push']);
        expect(commitLeftoversFn).not.toHaveBeenCalledWith('чини-сессия гейта');
        const stops = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(stops.some((m) => /чини-сессия гейта .* упала/.test(m))).toBe(true);
    });

    it('ревью 16c2: пуш чини-сессии гейта отвергнут → стоп session-unpushed, второго гейта нет', () => {
        const order: string[] = [];
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        let pushes = 0;
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(mkState({ submitted: true, gateHeals: 0 })),
            deps([], {
                ...healDeps(order, 0, () =>
                    ++pushes === 1
                        ? { kind: 'in-sync' }
                        : {
                              kind: 'failed',
                              why: 'git push отвергнут — ! [rejected] (non-fast-forward)',
                              local: 'b'.repeat(40),
                              remote: 'a'.repeat(40),
                          },
                ),
                pushEventFn,
            }),
        );
        expect(order.filter((x) => x === 'gate')).toHaveLength(1);
        const stops = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(stops).toHaveLength(1);
        expect(stops[0]).toContain('(session-unpushed)');
        expect(stops[0]).toContain('чини-сессия гейта');
    });

    it('ревью 16c2: рестарт сразу в гейт сначала довозит незапушенное; отказ — стоп без гейта', () => {
        const tryMergePhaseFn = vi.fn(() => 'merged' as const);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn,
                pushSessionCommitsFn: () => ({
                    kind: 'failed' as const,
                    why: 'не смог прочитать ветку на origin — Could not resolve host',
                    local: 'b'.repeat(40),
                    remote: null,
                }),
                pushEventFn,
            }),
        );
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        const stops = pushEventFn.mock.calls.map((c) => String(c[0]));
        expect(stops).toHaveLength(1);
        expect(stops[0]).toContain('(session-unpushed)');
        expect(stops[0]).toContain('продолжение сдачи');
    });

    it('ревью 16c2: стоп пуша правок → рестарт довозит пуш и идёт дальше, сессию правок не повторяет', () => {
        const state = mkState();
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const tryMergePhaseFn = vi.fn(() => 'merged' as const);
        let pushes = 0;
        const base = {
            openIssuesFn: () => [],
            allOpenIssuesFn: () => [],
            findOpenPrFn: () => ({ number: 55, labels: [] }),
            pickReviewModelFn: () => 'none',
            runClaudeFn,
            pushEventFn,
            tryMergePhaseFn,
        };
        runLoop(
            validCfg(),
            ctx(state),
            deps([], {
                ...base,
                pushSessionCommitsFn: () =>
                    ++pushes === 1
                        ? { kind: 'in-sync' as const }
                        : {
                              kind: 'failed' as const,
                              why: 'не смог прочитать ветку на origin — Could not resolve host',
                              local: 'b'.repeat(40),
                              remote: 'a'.repeat(40),
                          },
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        const stop = pushEventFn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(stop).toContain('(session-unpushed)');
        expect(stop).toContain('правки не повторятся');

        // Рестарт: этап правок закрыт `ok`, пуш довозится на входе в сдачу.
        const order: string[] = [];
        runLoop(
            validCfg(),
            ctx(state),
            deps([], {
                ...base,
                pushSessionCommitsFn: () => {
                    order.push('push');
                    return {
                        kind: 'pushed' as const,
                        local: 'b'.repeat(40),
                        remote: 'a'.repeat(40),
                    };
                },
                tryMergePhaseFn: () => {
                    order.push('gate');
                    return 'merged' as const;
                },
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        expect(order[0]).toBe('push');
        expect(order).toContain('gate');
    });

    it('#224: dry-прогон сдачи не пушит', () => {
        const pushSessionCommitsFn = vi.fn(() => ({ kind: 'in-sync' as const }));
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps([], {
                dry: true,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                pushSessionCommitsFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(pushSessionCommitsFn).not.toHaveBeenCalled();
    });

    it('#217: гейт blocked → чини-сессия + повторное ревью раннером, снятие метки раннером, инкремент', () => {
        const logs: string[] = [];
        // lastReviewModel — модель, поставившая блок (её и подымет планка).
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const removeBlockedLabelFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                removeBlockedLabelFn,
            }),
        );
        expect(state.blockedHeals).toBe(1);
        // #217: submitted НЕ сбрасывается — следующий проход идёт сразу на гейт, который
        // перечитает метку, выставленную повторным ревью раннера.
        expect(state.submitted).toBe(true);
        // Три сессии: планировщик + чини-сессия блокеров + повторное ревью раннером.
        expect(runClaudeFn).toHaveBeenCalledTimes(3);
        // Чини-сессии явно запрещено снимать метку — это делает раннер (#217). С #45
        // запрет стал структурным: намерения на снятие блока не существует вовсе.
        expect(runClaudeFn.mock.calls[1][0]).toMatch(/метку blocked снять ты не можешь/i);
        // Третий вызов — повторное ревью: вешает blocked заново, если блокеры остались.
        expect(runClaudeFn.mock.calls[2][0]).toMatch(/повторн|устранен/i);
        // Метку снял РАННЕР (не кодер-сессия), перед повторным ревью.
        expect(removeBlockedLabelFn).toHaveBeenCalledTimes(1);
        expect(removeBlockedLabelFn.mock.calls[0][0]).toBe('feature/m1');
        // Планка поднята до модели, поставившей блок.
        expect(state.reviewModelFloor).toBe('claude-opus-4-8');
    });

    it('#594: разбор blocked исчерпал ходы → продолжение, а не стоп до человека', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, blockedHeals: 0, lastReviewModel: 'claude-rev' });
        let calls = 0;
        const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
            if (prompt.includes('Ты планировщик правок')) return 0;
            calls++;
            if (calls === 1) {
                emitOutput(d, 'Error: Reached max turns (200)');
                return 1;
            }
            return 0;
        });
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-rev',
                runClaudeFn,
            }),
        );
        // Четыре сессии: планировщик + прерванная чини-сессия + продолжение + повторное ревью.
        // Барьер #217 не ослаблен — вердикт по-прежнему выносит ревью, а не исполнитель.
        expect(runClaudeFn).toHaveBeenCalledTimes(4);
        expect(String(runClaudeFn.mock.calls[2][0])).toMatch(/ПРОДОЛЖЕНИЕ прерванного разбора/);
        expect(state.blockedHeals).toBe(1);
    });

    it('#594 НЕГАТИВНЫЙ: разбор blocked не влезает в бюджет каждый раз → стоп с советом про размер, не «перезапусти»', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, blockedHeals: 0, lastReviewModel: 'claude-rev' });
        const runClaudeFn = vi.fn<RunClaudeFake>((prompt, _opts, d) => {
            if (prompt.includes('Ты планировщик правок')) return 0;
            emitOutput(d, 'Error: Reached max turns (200)');
            return 1;
        });
        runLoop(
            validCfg({ blockedHealAttempts: 3, review: { fixTurnRetries: 1 } }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-rev',
                runClaudeFn,
            }),
        );
        // Планировщик + попытка + один повтор — и стоп ДО повторного ревью.
        expect(runClaudeFn).toHaveBeenCalledTimes(3);
        // Совет человеку — про объём блокеров, а не «перезапусти loop»: рестарт прогнал бы
        // тот же разбор с тем же потолком.
        expect(logs.join('\n')).toMatch(
            /разбор blocked фазы "M1" не уложился в бюджет ходов за 2 попыток/,
        );
        expect(logs.join('\n')).not.toMatch(/сессия разбора blocked.*упала/i);
    });

    it('гейт blocked, бюджет исчерпан → стоп без чини-сессии, сброс счётчика, пуш человеку', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, blockedHeals: 3 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                getLastGatePr: () => 555,
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(state.blockedHeals).toBe(0);
        // #86: событие «blocked отдан человеку» уходит пушем (единственный логгер).
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        // Ревью #289: счётчик повторов живёт в диагнозе, а не пересказывает заголовок.
        expect(pushEventFn.mock.calls[0][0]).toMatch(/label blocked оставлен человеку/);
        expect(pushEventFn.mock.calls[0][0]).toMatch(
            /диагноз: 3 повторных ревью подряд оставили label blocked/,
        );
        // #218 (критерий 2): текст называет число ревью, PR и версию про зацикливание —
        // иначе человек по привычке ищет дефект в коде, хотя проблема может быть в
        // споре ревьюера с правками, а не в самом коде.
        expect(pushEventFn.mock.calls[0][0]).toContain('#555');
        expect(pushEventFn.mock.calls[0][0]).toMatch(/3 повторных ревью/);
        // Ревью #289 (!151): «возможно, зациклилось» ушло — тот же совет («смотри спор
        // ревьюера и правок, а не только код») теперь несёт вопрос человеку в структуре
        // стопа, и текст в пуше один, без дословного повтора.
        expect(pushEventFn.mock.calls[0][0]).toMatch(/review-dispute/);
    });

    // #216: prod (с включённым разбором) блокер запускает чини-сессию, а не немедленный
    // стоп человеку. Тестируем именно поведение при profileName='prod' + ненулевом лимите.
    it('#216: prod с включённым разбором → блокер запускает разбор+повторное ревью, человека не зовём', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 3, profileName: 'prod' }),
            ctx(state),
            // phaseIndexOfFn НЕ переопределяем: дефолтный счётчик (0 → 99) даёт ровно
            // один рабочий проход, иначе continue после разбора крутил бы цикл до брейкера.
            deps(logs, {
                // Задача 78: чистое повторное ревью — это сводка без якоря, а не ноль намерений.
                applySessionRequestsFn: () => ({
                    applied: 1,
                    failed: false,
                    prFindings: [{ comment: '⚪ [nit] блокеры сняты' }],
                    prBlocked: false,
                }),
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).toHaveBeenCalledTimes(3); // планировщик + разбор + повторное ревью
        expect(state.blockedHeals).toBe(1);
        expect(pushEventFn).not.toHaveBeenCalled(); // блокер не ушёл человеку
    });

    // #216: счётчик не в памяти процесса — новое значение уходит в state ДО чини-сессии,
    // поэтому перезапуск раннера посреди разбора его не обнулит (loadState прочитает 2).
    it('#216: инкремент blockedHeals персистится через saveState (переживает перезапуск)', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 1,
            lastReviewModel: 'claude-opus-4-8',
        });
        const saved: Array<Record<string, unknown>> = [];
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-opus-4-8',
                runClaudeFn: () => 0,
                saveStateFn: (s: Record<string, unknown>) => saved.push({ ...s }),
            }),
        );
        expect(saved.some((s) => s.blockedHeals === 2)).toBe(true);
    });

    // #216: чистое повторное ревью завершает разбор — счётчик оставивших блок ревью в
    // ноль. Гейт дошёл до чеков (red-checks) = на PR нет label blocked = ревью блок не
    // поставило. Без сброса чередование «блок → чисто → блок» набирало бы «три подряд»
    // и зря дёргало человека. Считаем ПОДРЯД идущие блок-ревью, а не круги вообще.
    it('#216: чистое повторное ревью (red-checks) обнуляет blockedHeals — чередование не копит счётчик', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, blockedHeals: 2 });
        runLoop(
            validCfg({ blockedHealAttempts: 3, gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'red-checks',
                // #223: red-checks — пост-меточный исход, tryMergePhase уже прочитал PR
                // (lastGatePr выставлен) и лишь потом упёрся в чеки. Сброс blockedHeals
                // теперь требует getLastGatePr() !== null (пуш «снят автоматически» не
                // должен стрелять на путях, где метку гейт не читал) — симулируем номер.
                getLastGatePr: () => 909,
                getLastRedCheck: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'boom' }),
                runClaudeFn: () => 0,
            }),
        );
        expect(state.blockedHeals).toBe(0);
    });

    // #218 (критерий 1): «блокер снят автоматически» — отдельное событие, не то же
    // самое, что общий пуш о состоянии гейта. Гейт дошёл до red-checks БЕЗ label
    // blocked при blockedHeals > 0 — значит повторное ревью раннера блок не оставило,
    // и это надо назвать явно: номер PR + модель ревью, чтобы человек не тратил время
    // разбираясь, что вообще произошло.
    it('#218: гейт red-checks после разбора blocked → пуш «снят автоматически» с PR и моделью ревью', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 2,
            lastReviewModel: 'claude-opus-4-8',
        });
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 3, gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'red-checks',
                getLastRedCheck: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'boom' }),
                getLastGatePr: () => 321,
                runClaudeFn: () => 0,
                pushEventFn,
            }),
        );
        expect(state.blockedHeals).toBe(0);
        const liftedMsg = pushEventFn.mock.calls
            .map((c) => c[0])
            .find((m) => m.includes('снят автоматически'));
        expect(liftedMsg).toBeDefined();
        expect(liftedMsg).toContain('#321');
        expect(liftedMsg).toContain('claude-opus-4-8');
    });

    // #218: тот же барьер, но по пути gate === 'merged' — повторное ревью прошло
    // чисто и гейт домерджил фазу СРАЗУ, минуя red-checks. Пуш о снятом блокере
    // должен уйти отдельно от пуша «фаза смерджена» — это два разных события.
    it('#218: гейт merged после разбора blocked → отдельный пуш «снят автоматически» с PR и моделью ревью', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 1,
            lastReviewModel: 'claude-opus-4-8',
        });
        const pushEventFn = vi.fn();
        let gateCalls = 0;
        const tryMergePhaseFn = vi.fn(() => (gateCalls++ === 0 ? 'blocked' : 'merged'));
        let idxCalls = 0;
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                // Задача 78: чистое повторное ревью — это сводка без якоря, а не ноль намерений.
                applySessionRequestsFn: () => ({
                    applied: 1,
                    failed: false,
                    prFindings: [{ comment: '⚪ [nit] блокеры сняты' }],
                    prBlocked: false,
                }),
                phaseIndexOfFn: () => (idxCalls++ < 2 ? 0 : 99),
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'claude-opus-4-8',
                tryMergePhaseFn,
                runClaudeFn: () => 0,
                pushEventFn,
                getLastGatePr: () => 217,
            }),
        );
        const messages = pushEventFn.mock.calls.map((c) => c[0]);
        const liftedMsg = messages.find((m) => m.includes('снят автоматически'));
        const mergedMsg = messages.find((m) => m.includes('смерджена в main'));
        expect(liftedMsg).toBeDefined();
        expect(liftedMsg).toContain('#217');
        expect(liftedMsg).toContain('claude-opus-4-8');
        // Два РАЗНЫХ события пушем, не одно слитое сообщение.
        expect(mergedMsg).toBeDefined();
        expect(mergedMsg).not.toBe(liftedMsg);
    });

    // #222: hold — человеческий стоп-кран. Гейт стоп + пуш, БЕЗ чини-сессий, БЕЗ
    // повторного ревью, счётчики blockedHeals/gateHeals не трогаются.
    it('#222: гейт hold → стоп + пуш с номером PR, ни одной сессии не запущено', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, blockedHeals: 0, gateHeals: 0 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const removeBlockedLabelFn = vi.fn();
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'hold',
                getLastGatePr: () => 909,
                runClaudeFn,
                removeBlockedLabelFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(removeBlockedLabelFn).not.toHaveBeenCalled();
        expect(state.blockedHeals).toBe(0);
        expect(state.gateHeals).toBe(0);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const msg = pushEventFn.mock.calls[0][0];
        expect(msg).toContain('#909');
        expect(msg).toMatch(/hold/);
        expect(msg).toMatch(/человек/);
    });

    // #222: hold проверяется в tryMergePhase раньше blocked — если предыдущий круг
    // разбора оставил blockedHeals > 0, а этот проход внезапно видит hold (человек
    // поставил метку параллельно), пуш «блокер снят автоматически» НЕ должен уйти —
    // мы не знаем, снят ли фактически blocked, гейт вообще до него не дошёл.
    it('#222: гейт hold при blockedHeals > 0 НЕ шлёт «снят автоматически», счётчик не трогается', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 2,
            lastReviewModel: 'claude-opus-4-8',
        });
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'hold',
                getLastGatePr: () => 909,
                runClaudeFn: () => 0,
                pushEventFn,
            }),
        );
        expect(state.blockedHeals).toBe(2); // не сброшен и не увеличен
        const messages = pushEventFn.mock.calls.map((c) => c[0]);
        expect(messages.some((m) => m.includes('снят автоматически'))).toBe(false);
        expect(messages.some((m) => /hold/.test(m))).toBe(true);
    });

    // #216: prod больше не ставит blockedHealAttempts: 0, но ветка «явно выключено»
    // осталась для конфигов, где разбор выключат сознательно. Обещание ветки: не «в
    // конфиге 0», а «чини-сессия не запускается вовсе». Регресс `?? 3` → `|| 3` ловится
    // только так. profileName взят произвольный — важно само значение 0, не имя профиля.
    it('blockedHealAttempts=0 (разбор выключен явно) → блокер сразу человеку, чини-сессия НЕ зовётся, пуш уходит', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, blockedHeals: 0 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 0, profileName: 'prod' }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        // #86: даже при 0 попытках разбора событие «blocked отдан человеку» уходит
        // пушем (единственный логгер). Сообщение говорит «выключено профилем», а не
        // «устоял после 0 разборов».
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/выключен конфигом .* профиля "prod"/);
        expect(pushEventFn.mock.calls[0][0]).not.toMatch(/устоял после 0/);
    });

    // #217 (критерий 2): планка модели повторного ревью. Блок поставила fable; после
    // правок дифф «подешевел» и pickReviewModel даёт haiku. Повторное ревью обязано
    // идти на fable, НЕ на haiku — иначе эскалацию обходят удешевлением ревьюера.
    it('#217: повторное ревью не слабее поставившей блок — haiku-кандидат поднят до fable-планки', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-fable-5', // блок поставила fable
        });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-haiku-4-5-20251001', // слабее блокирующей
                runClaudeFn,
            }),
        );
        expect(state.reviewModelFloor).toBe('claude-fable-5');
        // Третий вызов runClaude — повторное ревью: модель = планка (fable), не haiku.
        expect(runClaudeFn).toHaveBeenCalledTimes(3);
        expect(runClaudeFn.mock.calls[2][1].model).toBe('claude-fable-5');
        // #221: фолбэк повторного ревью тоже поднят до планки (fable) через
        // strongerReviewModel — иначе overload молча деградировал бы модель ниже
        // планки, обходя барьер #217 на уровне CLI-фолбэка. cfg тут без блока review
        // (validCfg), поэтому pickReviewFallbackModel вернул бы null, но
        // strongerReviewModel(null, floor) поднимает его до floor.
        expect(runClaudeFn.mock.calls[2][1].fallbackModel).toBe('claude-fable-5');
    });

    // #221-ревью (PR #241): явное review.fallback: 'none' — honest-стоп, планка floor его
    // НЕ повышает. Иначе осознанный отказ от фолбэка ушёл бы с --fallback-model <floor>,
    // прямо противореча контракту (CLAUDE.md инв. 6). Повторное ревью при 'none' идёт
    // моделью планки, но БЕЗ фолбэка.
    it('#221: явное review.fallback "none" — повторное ревью без фолбэка, планка его не повышает', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-fable-5',
        });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({
                blockedHealAttempts: 3,
                review: { default: 'claude-opus-4-8', fallback: 'none' },
            }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'claude-haiku-4-5-20251001',
                runClaudeFn,
            }),
        );
        // Модель повторного ревью — по-прежнему планка (fable), а вот фолбэк — 'none'
        // (honest-стоп), не поднят до floor.
        expect(runClaudeFn.mock.calls[2][1].model).toBe('claude-fable-5');
        expect(runClaudeFn.mock.calls[2][1].fallbackModel).toBe('none');
    });

    // #217: судить блок нечем (review: none и планки нет) — fail-closed, PR человеку.
    // Без этой ветки метку сняли бы «на слово» и фаза уехала бы в main без ревью.
    it('#217: нет ревью-модели для повторного ревью → fail-closed, человек, не мерджим', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, blockedHeals: 0, lastReviewModel: null });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        const removeBlockedLabelFn = vi.fn();
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'blocked',
                pickReviewModelFn: () => 'none', // ревью-модели нет
                runClaudeFn,
                pushEventFn,
                removeBlockedLabelFn,
            }),
        );
        // Чини-сессия прошла, но повторное ревью невозможно → метку раннер НЕ снимает.
        expect(removeBlockedLabelFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/повторное ревью blocked невозможно/);
        expect(state.blockedHeals).toBe(0); // отдан человеку
    });

    // #217 (критерий 3): снятая кодер-сессией метка сама по себе к мерджу не ведёт —
    // между блоком и мерджем раннер ОБЯЗАТЕЛЬНО снимает метку сам и гоняет повторное
    // ревью. Мердж наступает только следующим гейтом, после ревью раннера.
    it('#217: метка снята кодером сама → мердж только после повторного ревью раннером', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const removeBlockedLabelFn = vi.fn();
        const advancePhaseFn = vi.fn();
        // 1-й гейт — blocked; 2-й (после повторного ревью) — merged.
        let gateCalls = 0;
        const tryMergePhaseFn = vi.fn(() => (gateCalls++ === 0 ? 'blocked' : 'merged'));
        // idx 0 на первых двух проходах, затем «за концом» → выход.
        let idxCalls = 0;
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                // Задача 78: чистое повторное ревью — это сводка без якоря, а не ноль намерений.
                applySessionRequestsFn: () => ({
                    applied: 1,
                    failed: false,
                    prFindings: [{ comment: '⚪ [nit] блокеры сняты' }],
                    prBlocked: false,
                }),
                phaseIndexOfFn: () => (idxCalls++ < 2 ? 0 : 99),
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                pickReviewModelFn: () => 'claude-opus-4-8',
                tryMergePhaseFn,
                runClaudeFn,
                removeBlockedLabelFn,
                advancePhaseFn,
            }),
        );
        // Мердж состоялся ровно один раз — вторым гейтом, ПОСЛЕ повторного ревью раннера.
        expect(advancePhaseFn).toHaveBeenCalledTimes(1);
        // Раннер сам снял метку (не кодер) перед повторным ревью — ровно один раз.
        expect(removeBlockedLabelFn).toHaveBeenCalledTimes(1);
        // До мерджа прошли планировщик, чини-сессия и повторное ревью раннера.
        expect(runClaudeFn).toHaveBeenCalledTimes(3);
        expect(runClaudeFn.mock.calls[1][0]).toMatch(/метку blocked снять ты не можешь/i);
        expect(runClaudeFn.mock.calls[2][0]).toMatch(/повторн|устранен/i);
    });

    // Задача 78: повторное ревью, вышедшее с кодом 0 без единого намерения, — не «блокеры
    // сняты». Метку раннер уже снял, и без возврата следующий гейт смерджил бы фазу.
    it('задача 78: повторное ревью без вердикта → label blocked возвращён, мерджа нет', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        const addBlockedLabelFn = vi.fn();
        const advancePhaseFn = vi.fn();
        let gateCalls = 0;
        const tryMergePhaseFn = vi.fn(() => (gateCalls++ === 0 ? 'blocked' : 'merged'));
        let idxCalls = 0;
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => (idxCalls++ < 2 ? 0 : 99),
                pickReviewModelFn: () => 'claude-opus-4-8',
                tryMergePhaseFn,
                runClaudeFn: () => 0,
                removeBlockedLabelFn: () => {},
                addBlockedLabelFn,
                advancePhaseFn,
                pushEventFn: (m: string, _c: unknown, o?: { logFn?: (s: string) => void }) => {
                    o?.logFn?.(`🔔 PUSH: ${m}`);
                    return false;
                },
            }),
        );
        expect(addBlockedLabelFn).toHaveBeenCalledTimes(1);
        expect(advancePhaseFn).not.toHaveBeenCalled();
        expect(tryMergePhaseFn).toHaveBeenCalledTimes(1);
        expect(state.reReviewPending).toBe(false);
        expect(logs.join('\n')).toMatch(/ревью без вердикта/);
    });

    // Задача 79: восстановление после рестарта зовёт запись метки, а запись в адаптерах
    // fail-open. Флаг сбрасывался сразу после вызова — и метка, не легшая молча, уводила
    // гейт в мердж. Теперь метку перечитывают, и флаг снимает только подтверждение.
    it.each([
        ['запись метки не применилась', () => false, /метки на PR нет после записи/],
        [
            'чтение после записи упало — исход неизвестен',
            (): boolean => {
                throw new Error('форж не ответил');
            },
            /исход записи неизвестен \(форж не ответил\)/,
        ],
    ])(
        'задача 79: reReviewPending, %s → после рестарта мерджа нет, флаг не сброшен',
        (_t, readBack, why) => {
            const logs: string[] = [];
            const state = mkState({ submitted: true, reReviewPending: true });
            const addBlockedLabelFn = vi.fn();
            const tryMergePhaseFn = vi.fn(() => 'merged');
            const advancePhaseFn = vi.fn();
            const pushEventFn = vi.fn();
            runLoop(
                validCfg(),
                ctx(state),
                deps(logs, {
                    addBlockedLabelFn,
                    prHasBlockedLabelFn: readBack,
                    tryMergePhaseFn,
                    advancePhaseFn,
                    pushEventFn,
                }),
            );
            expect(addBlockedLabelFn).toHaveBeenCalledTimes(1);
            expect(tryMergePhaseFn).not.toHaveBeenCalled();
            expect(advancePhaseFn).not.toHaveBeenCalled();
            expect(state.reReviewPending).toBe(true);
            expect(logs.some((l) => why.test(l))).toBe(true);
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            expect(pushEventFn.mock.calls[0][0]).toMatch(/blocked-unconfirmed/);
        },
    );

    it('задача 79: reReviewPending, метка подтверждена чтением → флаг снят, гейт идёт', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, reReviewPending: true });
        const tryMergePhaseFn = vi.fn(() => 'not-merged');
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                addBlockedLabelFn: vi.fn(),
                prHasBlockedLabelFn: () => true,
                tryMergePhaseFn,
            }),
        );
        expect(tryMergePhaseFn).toHaveBeenCalledTimes(1);
        expect(state.reReviewPending).toBe(false);
    });

    // Тот же класс на пути повторного ревью: метку возвращают, а встала ли — не знали.
    it('задача 79: повторное ревью без вердикта, метка не встала → флаг не сброшен', () => {
        const logs: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        const advancePhaseFn = vi.fn();
        let gateCalls = 0;
        const tryMergePhaseFn = vi.fn(() => (gateCalls++ === 0 ? 'blocked' : 'merged'));
        let idxCalls = 0;
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                phaseIndexOfFn: () => (idxCalls++ < 2 ? 0 : 99),
                pickReviewModelFn: () => 'claude-opus-4-8',
                tryMergePhaseFn,
                runClaudeFn: () => 0,
                addBlockedLabelFn: vi.fn(),
                prHasBlockedLabelFn: () => false,
                advancePhaseFn,
                pushEventFn: (m: string, _c: unknown, o?: { logFn?: (s: string) => void }) => {
                    o?.logFn?.(`🔔 PUSH: ${m}`);
                    return false;
                },
            }),
        );
        expect(advancePhaseFn).not.toHaveBeenCalled();
        expect(state.reReviewPending).toBe(true);
        // Стоп не врёт о метке: соседняя строка уже сказала «не подтверждена».
        expect(logs.join('\n')).not.toMatch(/label blocked возвращён/);
        expect(logs.join('\n')).toMatch(/label blocked не подтверждён/);
    });

    it('гейт red-checks → чини-сессия гейта с деталями чека из getLastRedCheck', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 0 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'red-checks',
                getLastRedCheck: () => ({
                    name: 'test',
                    cmd: 'npm run test',
                    excerpt: 'boom-fail',
                }),
                runClaudeFn,
            }),
        );
        expect(state.gateHeals).toBe(1);
        expect(state.submitted).toBe(false);
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        const healPrompt = runClaudeFn.mock.calls[0][0];
        expect(healPrompt).toContain('test');
        expect(healPrompt).toContain('npm run test');
        expect(healPrompt).toContain('boom-fail');
    });

    // #376 доп.скоуп: ПОСЛЕ modelRouting.healEscalation.afterAttempts НЕУДАЧНЫХ heal-попыток
    // подряд чини-сессия гейта переключается на route (может быть другим провайдером). Ревью-
    // thread (off-by-one): gateHeals инкрементируется ДО проверки и равен номеру ЗАПУСКАЕМОЙ
    // попытки; условие `> afterAttempts` даёт ровно «после afterAttempts неудач», а не на них.
    it('гейт red-checks: healEscalation — эскалация на попытке afterAttempts+1 (ПОСЛЕ afterAttempts неудач)', () => {
        const logs: string[] = [];
        // gateHeals:2 → эта попытка станет 3-й (afterAttempts+1): первые 2 были на дешёвой,
        // эскалация — после 2 неудачных.
        const state = mkState({ submitted: true, gateHeals: 2 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const kimiRun = ralph.coderRuntimeRunFor('kimi');
        runLoop(
            validCfg({
                gateHealAttempts: 5,
                modelRouting: {
                    healEscalation: {
                        afterAttempts: 2,
                        route: { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                    },
                },
            }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'red-checks',
                getLastRedCheck: () => ({
                    name: 'test',
                    cmd: 'npm run test',
                    excerpt: 'boom-fail',
                }),
                runClaudeFn,
            }),
        );
        expect(state.gateHeals).toBe(3);
        const [, opts, depsOverride] = runClaudeFn.mock.calls[0];
        expect(opts.model).toBe('kimi-k2-0711-preview');
        // #393: модель эскалации пришла ИЗ route.model ⇒ помечена провайдером эскалации,
        // чтобы не-Claude рантайм её применил (а не отбросил как чужую claude-имя).
        expect(opts.modelProvider).toBe('kimi');
        expect(depsOverride!.runClaudeOnceFn).toBe(kimiRun);
        expect(logs.join('\n')).toMatch(/эскалация → kimi\/kimi-k2-0711-preview/);
    });

    it('гейт red-checks: РОВНО на afterAttempts-й попытке эскалации ещё НЕТ (граница off-by-one)', () => {
        const logs: string[] = [];
        // gateHeals:1 → эта попытка станет 2-й = afterAttempts. `2 > 2` ложно → без эскалации:
        // afterAttempts-я попытка ещё дешёвая, эскалация только со следующей.
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({
                gateHealAttempts: 5,
                modelRouting: {
                    healEscalation: {
                        afterAttempts: 2,
                        route: { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                    },
                },
            }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'red-checks',
                getLastRedCheck: () => ({
                    name: 'test',
                    cmd: 'npm run test',
                    excerpt: 'boom-fail',
                }),
                runClaudeFn,
            }),
        );
        expect(state.gateHeals).toBe(2);
        const [, opts] = runClaudeFn.mock.calls[0];
        expect(opts.model).toBe('claude-coder'); // cfg.model, без эскалации
        expect(logs.join('\n')).not.toMatch(/эскалация/);
    });

    it('гейт red-checks: healEscalation задан, но afterAttempts ещё не достигнут → heal на cfg.model, без эскалации', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 0 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({
                gateHealAttempts: 5,
                modelRouting: {
                    healEscalation: {
                        afterAttempts: 2,
                        route: { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                    },
                },
            }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'red-checks',
                getLastRedCheck: () => ({
                    name: 'test',
                    cmd: 'npm run test',
                    excerpt: 'boom-fail',
                }),
                runClaudeFn,
            }),
        );
        expect(state.gateHeals).toBe(1);
        const [, opts, depsOverride] = runClaudeFn.mock.calls[0];
        expect(opts.model).toBe('claude-coder'); // cfg.model, без эскалации
        // healRoute===null → runClaudeOnceFn:undefined — реальный runClaude сам упал бы
        // на дефолт adapters.coderRuntime.run (деструктуризация); мок фиксирует именно
        // «override не передан», не разворачивая дефолт за него.
        expect(depsOverride!.runClaudeOnceFn).toBeUndefined();
        expect(logs.join('\n')).not.toMatch(/эскалация/);
    });

    it('гейт not-merged (нечинимая причина) → PR оставлен человеку, стоп', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'not-merged',
                pushEventFn,
            }),
        );
        // Ревью #289 (!151): стоп уходит одним каналом — пушем (pushEvent сам пишет
        // строку в ralph.log), прямого logFn рядом нет, поэтому текст ищем в пуше.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(String(pushEventFn.mock.calls[0][0])).toMatch(/не прошла авто-мердж/);
    });

    it('#20: бюджет повторов берётся из конфига (coderTurnRetries) и уменьшается по мере трат', () => {
        const handleCrashedCoderSessionFn = vi.fn<HandleCrashedCoderSessionFake>(() => ({
            stop: false,
            turnLimitRetry: true,
        }));
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 1);
        runLoop(
            { ...validCfg(), coderTurnRetries: 2 },
            ctx(mkState()),
            deps([], {
                phaseIndexOfFn: () => 0,
                // Одна и та же карточка: попытки тратятся ПОДРЯД на неё, и второй вызов
                // обязан увидеть остаток на единицу меньше.
                openIssuesFn: () => [{ number: 9, title: 'задача', labels: [] }],
                maxIterations: 2,
                runClaudeFn,
                handleCrashedCoderSessionFn,
            }),
        );
        expect(handleCrashedCoderSessionFn.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(handleCrashedCoderSessionFn.mock.calls[0][3]).toMatchObject({ turnRetriesLeft: 2 });
        expect(handleCrashedCoderSessionFn.mock.calls[1][3]).toMatchObject({ turnRetriesLeft: 1 });
    });

    it('#20: мусор в coderTurnRetries не читается как осознанное значение — берётся дефолт', () => {
        const handleCrashedCoderSessionFn = vi.fn<HandleCrashedCoderSessionFake>(() => ({
            stop: true,
        }));
        runLoop(
            { ...validCfg(), coderTurnRetries: 'много' },
            ctx(mkState()),
            deps([], {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 9, title: 'задача', labels: [] }],
                runClaudeFn: vi.fn<RunClaudeFake>(() => 1),
                handleCrashedCoderSessionFn,
            }),
        );
        // Тот же валидатор, что у review.fixTurnRetries: строка — не число, дефолт = 1.
        expect(handleCrashedCoderSessionFn.mock.calls[0][3]).toMatchObject({ turnRetriesLeft: 1 });
    });

    // #16: та же проводка, но для АДРЕСА. Инвариант «карточка кодер-сессии не попадает
    // в веху сдаваемой фазы» держится тем, что петля называет эту веху. Тип ловит
    // забытый аргумент на компиляции, но не ловит переданный НЕ ТОТ — например, если
    // однажды сюда приедет веха накопителя вместо вехи фазы.
    it('#16 петля называет применению веху ТЕКУЩЕЙ фазы — иначе запрет не на что опереть', () => {
        const logs: string[] = [];
        const applySessionRequestsFn = vi.fn((_args: { currentMilestone?: string }) => ({
            applied: 0,
            failed: false,
        }));
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
                runClaudeFn: () => 143,
                applySessionRequestsFn,
                handleCrashedCoderSessionFn: () => ({ stop: true }),
            }),
        );
        expect(applySessionRequestsFn.mock.calls[0][0]).toMatchObject({
            currentMilestone: 'M1',
        });
    });

    // #134: главный барьер правки — вход в итерацию. Отказ проводки обязан ОСТАНАВЛИВАТЬ
    // петлю до кодер-сессии: иначе сессия стартует на детаче или чужой ветке — ровно то
    // состояние 20.08, ради которого модуль написан. Пойман шестым кругом ревью мутацией
    // «результат проводки игнорируется» (`break` снят): все тесты оставались зелёными,
    // то есть сам стоп не сторожил никто — трассовые тесты ниже считают только ВЫЗОВЫ.
    it('#134: отказ проводки на входе в итерацию → кодер-сессия не запускается', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                ensurePhaseBranchFn: () =>
                    ({
                        kind: 'failed' as const,
                        branch: 'feature/m1',
                        sha: null,
                        reason: 'детач с работой',
                    }) as const,
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        const events = pushEventFn.mock.calls.map(([m]) => String(m)).join('\n');
        expect(events).toContain('итерация фазы');
        expect(events).toContain('детач с работой');
    });

    // #134: порядок на входе в итерацию — сначала остаток прошлой сессии коммитится
    // (commitLeftovers), потом проводка: `git switch` не переносит грязное дерево через
    // ветки, и перестановка шагов роняла бы проводку на каждом остатке. Трасса, не факт
    // вызова: оба шага и так зовутся, вопрос ровно в их взаимном порядке.
    it('#134: проводка идёт ПОСЛЕ коммита остатков прошлой сессии', () => {
        const logs: string[] = [];
        const trace: string[] = [];
        runLoop(
            validCfg(),
            ctx(mkState()),
            deps(logs, {
                once: true,
                phaseIndexOfFn: () => 0,
                ensureCleanFn: () => false,
                commitLeftoversFn: () => {
                    trace.push('leftovers');
                    return true;
                },
                ensurePhaseBranchFn: () => {
                    trace.push('branch');
                    return { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) };
                },
                openIssuesFn: () => [{ number: 5, title: 'задача', labels: [] }],
                runClaudeFn: () => 0,
            }),
        );
        expect(trace.indexOf('leftovers')).toBeGreaterThan(-1);
        expect(trace.indexOf('branch')).toBeGreaterThan(trace.indexOf('leftovers'));
    });

    // #134: третий пишущий путь после гейта — правки по ревью. Считаем проводки ДО первой
    // сессии: одна на входе в итерацию, вторая — непосредственно перед сессией правок.
    // Проверено мутацией: со снятым вызовом остаётся одна, и тест краснеет.
    it('#134: перед правками по ревью дерево ставится на ветку ЗАНОВО', () => {
        const logs: string[] = [];
        const trace: string[] = [];
        const state = mkState();
        runLoop(
            validCfg({ review: { fixTurnRetries: 0 } }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                ensurePhaseBranchFn: () => {
                    trace.push('branch');
                    return { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) };
                },
                runClaudeFn: () => {
                    trace.push('session');
                    return 0;
                },
                tryMergePhaseFn: () => 'merged',
            }),
        );
        const session = trace.indexOf('session');
        expect(session).toBeGreaterThan(-1);
        expect(trace.slice(0, session).filter((x) => x === 'branch')).toHaveLength(2);
    });

    // Задача 71: сессия сдачи, ушедшая с ветки, — тот же отказ, что у кодер-итерации.
    // Её намерения снимаются, а не применяются: файл переживает стоп, и после рестарта
    // следующая сдача применила бы старые `pr-block`/комментарии к уже спасённому коду.
    it('задача 71: правки по ревью ушли с ветки → стоп, намерения сняты, а не применены', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const applySessionRequestsFn = vi.fn(() => ({ applied: 0, failed: false }));
        const removeSessionRequestsFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'merged');
        const state = mkState();
        runLoop(
            validCfg({ review: { fixTurnRetries: 0 } }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                checkOnPhaseBranchFn: () => ({
                    ok: false,
                    sha: 'b'.repeat(40),
                    message: 'Сессия оставила дерево работы в detached HEAD',
                }),
                readSessionRequestsFn: () => '{"kind":"pr-block","reason":"старое"}\n',
                removeSessionRequestsFn,
                applySessionRequestsFn,
                pushEventFn,
                tryMergePhaseFn,
            }),
        );
        expect(removeSessionRequestsFn).toHaveBeenCalledTimes(1);
        expect(applySessionRequestsFn).not.toHaveBeenCalled();
        expect(tryMergePhaseFn).not.toHaveBeenCalled();
        const pushed = pushEventFn.mock.calls.map(([m]) => String(m)).join('\n');
        expect(pushed).toContain('правки по ревью');
        expect(pushed).toContain('сняты без применения');
        expect(logs.join('\n')).toContain('"pr-block"');
    });

    // Задача 71: повтор после исчерпания ходов — тоже пишущая сессия, и проводка стоит
    // перед КАЖДЫМ повтором, а не один раз до первого.
    it('задача 71: повтор сессии правок проводится на ветку заново', () => {
        const logs: string[] = [];
        const trace: string[] = [];
        let sessions = 0;
        runLoop(
            validCfg({ review: { fixTurnRetries: 1 } }),
            ctx(mkState()),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                ensurePhaseBranchFn: () => {
                    trace.push('branch');
                    return { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) };
                },
                runClaudeFn: (_p: string, _o: unknown, d: { onOutput?: unknown } = {}) => {
                    trace.push('session');
                    sessions += 1;
                    if (sessions === 1) {
                        emitOutput(d, 'Error: Reached max turns (80)');
                        return 1;
                    }
                    return 0;
                },
                tryMergePhaseFn: () => 'merged',
            }),
        );
        const first = trace.indexOf('session');
        const second = trace.indexOf('session', first + 1);
        expect(second).toBeGreaterThan(first);
        expect(trace.slice(first + 1, second)).toContain('branch');
    });

    it('#134: отказ повторной проводки → сессия правок по ревью не запускается', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        let calls = 0;
        const state = mkState();
        runLoop(
            validCfg({ review: { fixTurnRetries: 0 } }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                findOpenPrFn: () => ({ number: 55, labels: [] }),
                pickReviewModelFn: () => 'none',
                ensurePhaseBranchFn: () =>
                    ++calls === 1
                        ? { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) }
                        : ({
                              kind: 'failed' as const,
                              branch: 'feature/m1',
                              sha: null,
                              reason: 'детач с работой',
                          } as const),
                runClaudeFn,
                pushEventFn,
                tryMergePhaseFn: () => 'merged',
            }),
        );
        expect(calls).toBeGreaterThan(1);
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
            'правки по ревью',
        );
    });

    // #134: разбор blocked — вторая пишущая сессия после гейта, а гейт паркует дерево
    // детачем. Тест трассовый по той же причине, что у чини-сессии: «проводку позвали»
    // доказывает ничего, потому что она есть и в начале итерации.
    it('#134: между гейтом blocked и разбором дерево ставится на ветку ЗАНОВО', () => {
        const logs: string[] = [];
        const trace: string[] = [];
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => {
                    trace.push('gate');
                    return 'blocked';
                },
                pickReviewModelFn: () => 'claude-opus-4-8',
                ensurePhaseBranchFn: () => {
                    trace.push('branch');
                    return { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) };
                },
                runClaudeFn: () => {
                    trace.push('session');
                    return 0;
                },
            }),
        );
        const gate = trace.indexOf('gate');
        const session = trace.indexOf('session', gate);
        expect(gate).toBeGreaterThan(-1);
        expect(session).toBeGreaterThan(gate);
        expect(trace.slice(gate, session)).toContain('branch');
    });

    it('#134: отказ повторной проводки → разбор blocked не запускается', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'blocked' as const);
        let calls = 0;
        const state = mkState({
            submitted: true,
            blockedHeals: 0,
            lastReviewModel: 'claude-opus-4-8',
        });
        runLoop(
            validCfg({ blockedHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn,
                pickReviewModelFn: () => 'claude-opus-4-8',
                ensurePhaseBranchFn: () =>
                    ++calls === 1
                        ? { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) }
                        : ({
                              kind: 'failed' as const,
                              branch: 'feature/m1',
                              sha: null,
                              reason: 'детач с работой',
                          } as const),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(tryMergePhaseFn).toHaveBeenCalled();
        expect(calls).toBeGreaterThan(1);
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
            'разбор blocked',
        );
        expect(state.blockedHeals).toBe(0);
    });

    // #183: сдача фазы шла к форжу, не проверив, что ветка вообще на origin. Когда сессии
    // не могли пушить (#181), форж отвечал 400 — код одинаков для «нет ветки», «нет прав» и
    // «не тот репозиторий», и ночью человек разбирался с нуля.
    it('#183: ветка не запушена → PR не заводится, причина названа', () => {
        const logs: string[] = [];
        const createPrFn = vi.fn(() => 7);
        const pushEventFn = vi.fn();
        const state = mkState();
        runLoop(
            validCfg(),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                branchPushedFn: () => false,
                findOpenPrFn: () => null,
                createPrFn,
                pushEventFn,
            }),
        );
        expect(createPrFn).not.toHaveBeenCalled();
        const events = pushEventFn.mock.calls.map(([m]) => String(m)).join('\n');
        expect(events).toContain('не запушена');
        expect(events).toContain('pre-push');
    });

    it('#183: ветка есть на origin — ls-remote полного refs/heads даёт true', () => {
        const argv: string[][] = [];
        const res = ralph.branchPushed('feature/x', {
            runArgvFn: (_f: string, a: string[]) => {
                argv.push(a);
                return 'deadbeef\trefs/heads/feature/x';
            },
            logFn: () => {},
        });
        expect(res).toBe(true);
        expect(argv[0]).toContain('ls-remote');
        // Полный реф, не голое имя: паттерн ls-remote матчится по хвосту пути,
        // и «x» совпал бы с «feature/x».
        expect(argv[0]).toContain('refs/heads/feature/x');
    });

    // Ровно случай branch_cleanup форжа: ветка удалена НА СЕРВЕРЕ, локальный
    // remote-tracking ref мог протухнуть. fetch --prune здесь врал (падает «couldn't find
    // remote ref», реф не удаляя) — ls-remote спрашивает сервер и от локального состояния
    // не зависит вовсе.
    it('#183: сервер ответил, ветки нет (пустой вывод ls-remote) → false', () => {
        expect(ralph.branchPushed('feature/x', { runArgvFn: () => '', logFn: () => {} })).toBe(
            false,
        );
    });

    it('#183: origin недоступен — «не знаю» не превращается в «нет»', () => {
        const logs: string[] = [];
        const res = ralph.branchPushed('feature/x', {
            runArgvFn: () => {
                throw new Error('could not resolve host');
            },
            logFn: (m: string) => logs.push(m),
        });
        // true: сдача идёт дальше, и сетевой отказ назовёт своим именем вызов форжа —
        // стоп с текстом «не запушена» при живой ветке слал бы человека чинить зелёный
        // pre-push.
        expect(res).toBe(true);
        expect(logs.join('\n')).toContain('не знаю');
    });

    it('#183: небезопасное имя ветки → false, git не вызывается', () => {
        const argv: string[][] = [];
        const res = ralph.branchPushed('feature/x; rm -rf .', {
            runArgvFn: (_f: string, a: string[]) => {
                argv.push(a);
                return 'deadbeef\trefs/heads/x';
            },
            logFn: () => {},
        });
        expect(res).toBe(false);
        expect(argv).toHaveLength(0);
    });

    // #134: гейт паркует дерево детачем на origin/main после красного чека
    // (parkOnOriginMain), и чини-сессия стартовала бы не на ветке фазы — ровно то
    // состояние, из-за которого 20.08 коммит остался достижим только по SHA.
    //
    // Тест ПОСЛЕДОВАТЕЛЬНОСТИ, а не факта вызова: проводка есть и в начале итерации, и
    // потому «её позвали» доказывает ровно ничего — первый вариант этого теста оставался
    // зелёным при удалённом вызове перед чини-сессией. Здесь трасса пишется всеми тремя
    // участниками, и проверяется, что между гейтом и сессией проводка была ПОВТОРНО.
    it('#134: между гейтом и чини-сессией дерево ставится на ветку ЗАНОВО', () => {
        const logs: string[] = [];
        const trace: string[] = [];
        const state = mkState({ submitted: true });
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => {
                    trace.push('gate');
                    return 'red-checks';
                },
                getLastGatePr: () => 909,
                getLastRedCheck: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'boom' }),
                ensurePhaseBranchFn: () => {
                    trace.push('branch');
                    return { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) };
                },
                runClaudeFn: () => {
                    trace.push('session');
                    return 0;
                },
            }),
        );
        const gate = trace.indexOf('gate');
        const session = trace.indexOf('session', gate);
        expect(gate).toBeGreaterThan(-1);
        expect(session).toBeGreaterThan(gate);
        expect(trace.slice(gate, session)).toContain('branch');
    });

    it('#134: отказ ИМЕННО повторной проводки → чини-сессия не запускается', () => {
        const logs: string[] = [];
        const runClaudeFn = vi.fn(() => 0);
        const pushEventFn = vi.fn();
        const tryMergePhaseFn = vi.fn(() => 'red-checks' as const);
        let calls = 0;
        const state = mkState({ submitted: true });
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn,
                getLastGatePr: () => 909,
                getLastRedCheck: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'boom' }),
                // Первая проводка (начало итерации) проходит, вторая — перед чини-сессией —
                // отказывает: иначе тест доказывал бы только барьер на входе в итерацию.
                ensurePhaseBranchFn: () =>
                    ++calls === 1
                        ? { kind: 'switched' as const, branch: 'feature/m1', sha: 'a'.repeat(40) }
                        : ({
                              kind: 'failed' as const,
                              branch: 'feature/m1',
                              sha: null,
                              reason: 'не смог поставить дерево на ветку — local changes would be overwritten',
                          } as const),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(tryMergePhaseFn).toHaveBeenCalled();
        expect(calls).toBeGreaterThan(1);
        expect(runClaudeFn).not.toHaveBeenCalled();
        const pushedText = pushEventFn.mock.calls.map(([m]) => String(m)).join('\n');
        expect(pushedText).toContain('чини-сессия гейта');
        // #289: kind проводки (у этого мока — отказ самого switch, то есть 'tree-dirty') доезжает до причины стопа.
        expect(pushedText).toContain('tree-dirty');
        expect(pushedText).toContain('вопрос человеку:');
        // Бюджет чини-сессий тратится на ЗАПУЩЕННУЮ сессию: отказ проводки его не жжёт.
        expect(state.gateHeals).toBe(0);
    });

    it('#269: гейт forge-red → та же чини-сессия, но с логом куба и подсказкой про среду', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 0 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            // #269-ревью: перечень мест, где среды расходятся, приходит из КОНФИГА —
            // в переносимом ядре он был бы ложным следом на любом другом форже.
            validCfg({ gateHealAttempts: 2, forgeEnvHint: 'рабочий каталог там `/repo`.' }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-red',
                // Локального красного чека НЕТ — отказ пойман только площадкой.
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '356',
                    cube: 'test',
                    log: 'Tests  2 failed | 7172 passed (7174)',
                    kind: 'code' as const,
                }),
                runClaudeFn,
            }),
        );
        expect(state.gateHeals).toBe(1);
        // Возврат на ПОЛНУЮ сдачу — как и после локального лечения: правки едут через ревью.
        expect(state.submitted).toBe(false);
        // #269-ревью: успешная сессия помечает прогон пролеченным — следующий круг обязан
        // ждать НОВЫЙ прогон, а не лечить тот же лог второй раз, потратив последнюю попытку.
        expect(state.forgeHealedRunId).toBe('356');
        expect(runClaudeFn).toHaveBeenCalledTimes(1);
        const healPrompt = runClaudeFn.mock.calls[0][0];
        expect(healPrompt).toContain('356');
        expect(healPrompt).toContain('2 failed');
        // Подсказка про разницу сред — то, без чего сессия гоняет зелёный локальный набор.
        expect(healPrompt).toContain('ищи разницу СРЕД');
        // Проектная половина — из конфига, а не из ядра.
        expect(healPrompt).toContain('/repo');
    });

    // #269, второй проход ревью: пометка «прогон пролечен» стояла ДО запуска сессии, и
    // упавшая сессия (overload/лимит API — класс отказа из #223) делала вторую попытку
    // НЕДОСТИЖИМОЙ: она ничего не запушила, нового прогона форж не завёл, а рестарт по
    // инструкции из лога уходил ждать новый прогон 20 минут и заканчивался тем же стопом.
    // Поле сбрасывает только `advancePhase`, то есть холостым становился КАЖДЫЙ рестарт.
    it('#269: упавшая чини-сессия НЕ помечает прогон пролеченным — право лечить остаётся', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 0 });
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-red',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '356',
                    cube: 'test',
                    log: 'Tests  2 failed | 7172 passed (7174)',
                    kind: 'code' as const,
                }),
                // Сессия упала: код не ноль, пуша не было, нового прогона у форжа не будет.
                runClaudeFn: vi.fn<RunClaudeFake>(() => 1),
                pushEventFn,
            }),
        );
        expect(state.forgeHealedRunId).toBe(null);
        // Попытка при этом потрачена — рестарт продолжит со второй, а не с первой.
        expect(state.gateHeals).toBe(1);
        expect(pushEventFn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
            'чини-сессия гейта фазы "M1" упала',
        );
    });

    // Второй слой той же правки: стоп `forge-unknown` отдан человеку, и следующий заход
    // обязан читать вердикт форжа заново. Сюда петля попадает в том числе потому, что ЖДАЛА
    // прогон новее пролеченного и не дождалась, — рестарт с той же памятью повторил бы стоп.
    it('#269: forge-unknown обнуляет и память о пролеченном прогоне, не только счётчик', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1, forgeHealedRunId: '356' });
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-unknown',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => null,
                getLastForgeStop: () =>
                    'за 20 мин форж не завёл прогон новее 356 (по нему чини-сессия уже отработала)',
                runClaudeFn: vi.fn<RunClaudeFake>(() => 0),
                pushEventFn: vi.fn((msg: string) => msg.length > 0),
            }),
        );
        expect(state.forgeHealedRunId).toBe(null);
        expect(state.gateHeals).toBe(0);
    });

    it('#269: forge-env (OOM) — НЕ лечим кодом: ни одной сессии, стоп с диагнозом', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 0 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        // Параметр объявлен явно: `vi.fn(() => true)` типизировал бы аргументы пустым
        // кортежем, и `mock.calls[0][0]` не прошёл бы typecheck (куб гейта проверяет
        // и тесты тоже).
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-env',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '350',
                    cube: 'test',
                    log: 'Worker exited unexpectedly',
                    kind: 'oom' as const,
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        // Бюджет лечения не тратится: чинить нечего, и следующий рестарт не обязан
        // начинать с потраченной попытки.
        expect(state.gateHeals).toBe(0);
        // Ревью #289 (!151): канал стопа один — pushEvent сам печатает `🔔 PUSH: <msg>`
        // в ralph.log, прямого logFn рядом больше нет; диагноз (номер прогона) ищем в пуше.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(String(pushEventFn.mock.calls[0][0])).toContain('350');
        expect(String(pushEventFn.mock.calls[0][0])).toMatch(/СРЕДЫ/);
    });

    it('#269: forge-env по ПРЕРВАННОМУ прогону даёт другой диагноз, чем по OOM', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(mkState({ submitted: true, gateHeals: 0 })),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-env',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '361',
                    cube: 'install',
                    log: 'обрывок',
                    kind: 'aborted' as const,
                }),
                runClaudeFn: vi.fn<RunClaudeFake>(() => 0),
                pushEventFn,
            }),
        );
        const text = String(pushEventFn.mock.calls[0][0]);
        // Про память контейнера тут писать нельзя — прогон отменили, память ни при чём.
        expect(text).toMatch(/ПРЕРВАН/);
        expect(text).not.toMatch(/OOM/);
    });

    it('#269: чини-сессия по чеку площадки шлёт пуш «лечу N/3» — иначе ночью это не видно', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 0 });
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 3 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-red',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '356',
                    cube: 'lint',
                    log: 'error TS2345',
                    kind: 'code' as const,
                }),
                runClaudeFn: vi.fn<RunClaudeFake>(() => 0),
                pushEventFn,
            }),
        );
        const texts = pushEventFn.mock.calls.map(([m]) => String(m));
        expect(texts.some((t) => t.includes('lint') && t.includes('1/3'))).toBe(true);
    });

    // #269-ревью: стопы на чеке форжа БЕЗ вердикта (потолок ожидания, устойчивый сбой
    // чтения) уходили как `not-merged` — то есть без единого пуша, только строкой в
    // `ralph.log`. Потолок в 20 минут при `max_slots: 1`
    // достижим штатно, deadman на штатном завершении не сработает, и ночная остановка
    // выяснялась бы утром — ровно тот отказ, ради которого карточка и заведена.
    it('#269: forge-unknown — стоп ПУШЕМ с причиной, а не молча в лог', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-unknown',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => null,
                getLastForgeStop: () =>
                    'чек PR #12 у форжа не дал вердикта (за 20 мин чек не сошёлся)',
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('за 20 мин чек не сошёлся');
        // #289: стоп несёт причину, диагноз и вопрос — не только маркер «оставлен человеку».
        // #254: отсутствие вердикта не выдаётся за красный чек — у этих отказов разные действия.
        expect(stopText).toContain('platform-check-no-verdict');
        expect(stopText).toContain('чек площадки не дал вердикта');
        expect(stopText).not.toContain('platform-check-red');
        expect(stopText).toContain('диагноз:');
        expect(stopText).toContain('вопрос человеку:');
        // Человек чинит СРЕДУ, а не код: после рестарта бюджет лечения обязан быть полным.
        expect(state.gateHeals).toBe(0);
    });

    it('красный CI без названного куба — platform-check-red, без чини-сессии', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1, forgeHealedRunId: '356' });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-red-unnamed',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => null,
                getLastForgeStop: () =>
                    'чек PR #12 красный (прогон 357), но упавший куб не назван — чинить вслепую нельзя',
                runClaudeFn,
                pushEventFn,
            }),
        );

        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('platform-check-red');
        expect(stopText).not.toContain('platform-check-no-verdict');
        expect(stopText).toContain('упавший куб не назван');
        expect(state.gateHeals).toBe(0);
        expect(state.forgeHealedRunId).toBe(null);
    });

    // Задача 81: сбой ИНСТРУМЕНТА гейта — третий исход рядом с «прошёл» и «регрессия».
    // Он не читается как регрессия: чини-сессии нет, а стоп уходит пушем со своей причиной,
    // не катч-оллом `unknown`. Бюджет лечения при этом не тратится и сбрасывается — человек
    // чинит среду, а не код.
    it('задача 81: gate-tool-failure — стоп пушем с причиной, без чини-сессии', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'gate-tool-failure',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => null,
                getLastToolFailure: () => ({
                    name: 'test',
                    cmd: 'npm run test',
                    why: 'код 127',
                    excerpt: 'sh: vitest: not found',
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('gate-tool-failure');
        expect(stopText).toContain('test');
        expect(stopText).toContain('код 127');
        expect(stopText).not.toContain('(unknown)');
        expect(state.gateHeals).toBe(0);
    });

    // #66: ветка фазы отстала от main и конфликтует с ним — стоп пушем, называющий файл и
    // причину. Раньше человек видел только неудавшийся мердж и сам искал встречную правку.
    it('#66: main-conflict — стоп пушем с файлом встречной правки, без чини-сессии', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'main-conflict',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => null,
                getLastMainSyncStop: () => ({
                    kind: 'conflict',
                    main: 'd'.repeat(40),
                    files: ['docs/core-journal.md'],
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(main-conflict)');
        expect(stopText).toContain('docs/core-journal.md');
        expect(stopText).toContain('отстала от main');
        expect(stopText).not.toContain('(unknown)');
        expect(state.gateHeals).toBe(0);
    });

    it('#66: сбой влития без конфликта — причина main-sync-failed, а не «конфликт веток»', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'main-conflict',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => null,
                getLastMainSyncStop: () => ({ kind: 'failed', why: 'пуш отвергнут non-ff' }),
                pushEventFn,
            }),
        );
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('пуш отвергнут non-ff');
        expect(stopText).toContain('гейт повторит влитие');
        // Конфликта не было — заголовок его и не утверждает.
        expect(stopText).toContain('(main-sync-failed)');
        expect(stopText).not.toContain('конфликт веток');
    });

    // Конфликт, после которого упал `--abort`, тоже уходит в `failed` — заголовок не должен
    // отрицать конфликт, который назван в диагнозе.
    it('#66: конфликт с упавшим --abort — заголовок не спорит с диагнозом', () => {
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'main-conflict',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => null,
                getLastMainSyncStop: () => ({
                    kind: 'failed',
                    why: 'конфликт в a.ts; git merge --abort тоже упал (lock) — дерево раннера грязное',
                }),
                pushEventFn,
            }),
        );
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(main-sync-failed)');
        expect(stopText).toContain('конфликт в a.ts');
        expect(stopText).not.toContain('не конфликт');
    });

    // #85: локальный ref разошёлся с головой PR. Раньше гейт называл причину строкой, а пуш
    // человеку уходил катч-оллом «причина не установлена (unknown)».
    it('#85: head-diverged — стоп пушем со строкой гейта, а не unknown', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        const line =
            'Локальный ref feature/m1 (bbbbbbbb) разошёлся с головой PR #7 (aaaaaaaa): локально есть коммиты, которых нет в PR';
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'head-diverged',
                getLastHeadDivergence: () => ({
                    local: 'b'.repeat(40),
                    remote: 'a'.repeat(40),
                    line,
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(head-diverged)');
        expect(stopText).toContain(line);
        expect(stopText).not.toContain('(unknown)');
        expect(state.gateHeals).toBe(0);
    });

    // #127: гейт не прочитал PR у форжа — стоп с причиной гейта, а не катч-олл unknown и не
    // «PR не найден».
    it('#127: pr-unreadable — стоп forge-unreadable с причиной гейта', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        const why = 'открытый PR ветки feature/m1 не прочитался у форжа: HTTP 502';
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'pr-unreadable',
                getLastForgeStop: () => why,
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(forge-unreadable)');
        expect(stopText).toContain(why);
        expect(stopText).not.toContain('(unknown)');
        expect(state.gateHeals).toBe(0);
    });

    // #139: PR правит защищаемый путь на площадке, правило ревью которой его не держит.
    // Стоп с причиной и файлами, без чини-сессии: правка lock — решение человека.
    it('#139: protected-paths — стоп с причиной и файлами, без чини-сессии', () => {
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        const why = {
            kind: 'hits' as const,
            why: 'правка защищаемого пути — мердж за человеком: .ralph/core.lock (.ralph/core.lock)',
        };
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'protected-paths',
                getLastProtectedPathsStop: () => why,
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(protected-paths)');
        expect(stopText).toContain('.ralph/core.lock');
        expect(stopText).toContain('PR оставлен человеку');
        expect(stopText).not.toContain('(unknown)');
        expect(state.gateHeals).toBe(0);
    });

    // #139-ревью: файлы не сверились или дифф пуст — заголовок не говорит «правит
    // защищаемый путь», а вопрос — свой у каждой развилки.
    it.each([
        ['unverified', 'не сверены', 'почини причину', 'правит защищаемый путь'],
        ['empty', 'пуст относительно main', 'закрой PR', 'правит защищаемый путь'],
        [null, 'не сверены', 'регресс проводки', 'правит защищаемый путь'],
    ] as const)('protected-paths %s — свой заголовок и вопрос', (kind, head, question, absent) => {
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'protected-paths',
                getLastProtectedPathsStop: () =>
                    kind === null ? null : { kind, why: 'диагноз гейта' },
                pushEventFn,
            }),
        );
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain(head);
        expect(stopText).toContain(question);
        if (kind !== null) expect(stopText).toContain('диагноз гейта');
        expect(stopText).not.toContain(absent);
    });

    // #139: проводка. Чтение файлов PR доезжает до гейта, если площадка пути не держит, и
    // не доезжает, если держит. Дефолт берётся из шва форжа (GitHub-реализация по
    // умолчанию — `reviewProtectsPaths: false`), а не включается вызывающим по памяти.
    describe('#139: чтение файлов PR в гейт — по шву форжа', () => {
        function gateOpts(over: Record<string, unknown>) {
            const tryMergePhaseFn = vi.fn((..._args: unknown[]) => 'protected-paths' as const);
            runLoop(
                validCfg(),
                ctx(mkState({ submitted: true })),
                deps([], {
                    openIssuesFn: () => [],
                    allOpenIssuesFn: () => [],
                    phaseMergedFn: () => false,
                    tryMergePhaseFn,
                    getLastProtectedPathsStop: () => ({ kind: 'hits' as const, why: 'x' }),
                    pushEventFn: () => true,
                    ...over,
                }),
            );
            expect(tryMergePhaseFn).toHaveBeenCalledTimes(1);
            return tryMergePhaseFn.mock.calls[0][1] as { changedFilesFn?: unknown };
        }

        it('дефолт шва (площадка пути не держит) — чтение доезжает', () => {
            expect(typeof gateOpts({}).changedFilesFn).toBe('function');
        });

        it('заданное чтение доезжает тем же объектом', () => {
            const reader = (): string[] => ['a.ts'];
            expect(gateOpts({ prChangedFilesFn: reader }).changedFilesFn).toBe(reader);
        });

        it('площадка держит пути сама (null) — чтения нет', () => {
            expect(gateOpts({ prChangedFilesFn: null })).not.toHaveProperty('changedFilesFn');
        });
    });

    // #123: мердж не удался после вызова — класс отказа и строку форжа гейт знает, а пуш
    // раньше уходил катч-оллом «причина не установлена (unknown)».
    it('#123: исчерпанный предел повторов мерджа — пуш с классом отказа и строкой форжа', () => {
        const state = mkState({ submitted: true, gateHeals: 1 });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'not-merged',
                getLastMergeFailure: () => ({
                    pr: 7,
                    kind: 'transient' as const,
                    line: 'GraphQL: Something went wrong (HTTP 503)',
                    attempts: 8,
                    retryMaxMs: 10 * 60 * 1000,
                }),
                runClaudeFn,
                pushEventFn,
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(merge-failed)');
        expect(stopText).toContain('GraphQL: Something went wrong (HTTP 503)');
        expect(stopText).toContain('транзиент');
        expect(stopText).toContain('10 мин');
        expect(stopText).toContain('PR #7');
        expect(stopText).not.toContain('(unknown)');
        expect(state.gateHeals).toBe(0);
    });

    it('#123: отказ форжа по существу — пуш называет класс refusal, а не unknown', () => {
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'not-merged',
                getLastMergeFailure: () => ({
                    pr: 7,
                    kind: 'refusal' as const,
                    line: 'Pull request #7 is not mergeable',
                    attempts: 1,
                    retryMaxMs: 600_000,
                }),
                pushEventFn,
            }),
        );
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(merge-failed)');
        expect(stopText).toContain('по существу');
        expect(stopText).toContain('Pull request #7 is not mergeable');
    });

    it('#123: нераспознанный отказ после повтора — пуш называет класс unknown-отказа форжа', () => {
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'not-merged',
                getLastMergeFailure: () => ({
                    pr: 7,
                    kind: 'unknown' as const,
                    line: 'something odd',
                    attempts: 2,
                    retryMaxMs: 600_000,
                }),
                pushEventFn,
            }),
        );
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(merge-failed)');
        expect(stopText).toContain('не распознан и после повтора');
        expect(stopText).toContain('something odd');
    });

    // `not-merged` без вызова мерджа (dry, грязное дерево, PR не найден) записи об отказе
    // не несёт — для него катч-олл остаётся честным: причину гейт не устанавливал.
    it('#123: not-merged без записи об отказе мерджа — по-прежнему катч-олл unknown', () => {
        const pushEventFn = vi.fn((msg: string) => msg.length > 0);
        runLoop(
            validCfg(),
            ctx(mkState({ submitted: true })),
            deps([], {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'not-merged',
                getLastMergeFailure: () => null,
                pushEventFn,
            }),
        );
        const stopText = String(pushEventFn.mock.calls[0][0]);
        expect(stopText).toContain('(unknown)');
        expect(stopText).not.toContain('(merge-failed)');
    });

    // #269-ревью: соседний стоп «бюджет исчерпан» сбрасывает счётчик и прямо обещает это
    // в логе, а `forge-env` не сбрасывал. Сценарий: forge-red → одна чини-сессия → OOM
    // на следующем круге, и человеку, починившему память контейнера, остаётся одна попытка
    // из двух на отказ, к которому прошлая попытка отношения не имеет.
    it('#269: forge-env сбрасывает счётчик чини-сессий, как стоп по бюджету', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1 });
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-env',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '350',
                    cube: 'test',
                    log: 'Worker exited unexpectedly',
                    kind: 'oom' as const,
                }),
                runClaudeFn: vi.fn<RunClaudeFake>(() => 0),
                pushEventFn: vi.fn((msg: string) => msg.length > 0),
            }),
        );
        expect(state.gateHeals).toBe(0);
    });

    // #269, второй проход ревью: сброс памяти о прогоне доехал до ВСЕХ трёх стопов,
    // отдающих PR человеку, а не до одного. Сценарий на бюджете достижим: круг лечит
    // прогон 356 и помечает его, бюджет кончается — счётчик обнулён, а память жива,
    // и рестарт уходит ждать прогон новее 356, выжигает потолок и встаёт `forge-unknown`.
    it('#269: стоп по исчерпанию бюджета обнуляет и память о пролеченном прогоне', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 2, forgeHealedRunId: '356' });
        const runClaudeFn = vi.fn<RunClaudeFake>(() => 0);
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-red',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '358',
                    cube: 'test',
                    log: 'Tests  1 failed',
                    kind: 'code' as const,
                }),
                runClaudeFn,
                pushEventFn: vi.fn((msg: string) => msg.length > 0),
            }),
        );
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(state.gateHeals).toBe(0);
        expect(state.forgeHealedRunId).toBe(null);
    });

    it('#269: forge-env обнуляет память о прогоне тем же движением, что счётчик', () => {
        const logs: string[] = [];
        const state = mkState({ submitted: true, gateHeals: 1, forgeHealedRunId: '356' });
        runLoop(
            validCfg({ gateHealAttempts: 2 }),
            ctx(state),
            deps(logs, {
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                phaseMergedFn: () => false,
                tryMergePhaseFn: () => 'forge-env',
                getLastRedCheck: () => null,
                getLastForgeRedCheck: () => ({
                    workflow: 'gate',
                    runId: '350',
                    cube: 'test',
                    log: 'Worker exited unexpectedly',
                    kind: 'oom' as const,
                }),
                runClaudeFn: vi.fn<RunClaudeFake>(() => 0),
                pushEventFn: vi.fn((msg: string) => msg.length > 0),
            }),
        );
        expect(state.gateHeals).toBe(0);
        expect(state.forgeHealedRunId).toBe(null);
    });

    // Задача 40: класс стопа определяется тем, ВЫХОДИТ ли петля. Вышла — дальше её ведёт
    // только человек, и узнать он обязан пушем: `deadman` на `stopped` тишину не сторожит,
    // так что стоп одной строкой лога означал ночь тишины. Пошла дальше — только лог, иначе
    // каждый сетевой чих обесценил бы канал. «Ровно один» — потому что два пуша на одно
    // событие читаются как два события.
    describe('задача 40: выход из цикла по стопу — ровно один пуш', () => {
        const openIssue = { number: 7, title: 't', labels: [] };
        const outsider = { number: 9, title: 'чужая', labels: [], author: { login: 'stranger' } };
        const failing = (msg: string) => () => {
            throw new Error(msg);
        };
        const cases: Array<{
            name: string;
            state?: Partial<FakeState>;
            overrides: () => Record<string, unknown>;
            text: RegExp;
        }> = [
            {
                name: 'остаток сессии не закоммитился',
                overrides: () => ({ ensureCleanFn: () => false, commitLeftoversFn: () => false }),
                text: /остаток.*не закоммичен/i,
            },
            {
                name: 'C2: не прочитались открытые issues фазы',
                overrides: () => ({ allOpenIssuesFn: failing('форж молчит') }),
                text: /открытые issues фазы.*форж молчит/,
            },
            {
                name: 'C2: в milestone открыты issues вне очереди',
                overrides: () => ({ allOpenIssuesFn: () => [outsider] }),
                text: /вне очереди.*#9/,
            },
            {
                name: 'не прочитался мердж-статус фазы',
                overrides: () => ({ phaseMergedFn: failing('форж молчит') }),
                text: /мердж-статус.*форж молчит/,
            },
            {
                name: 'фаза смерджена, но дерево раннера не обновилось',
                overrides: () => ({
                    phaseMergedFn: () => true,
                    runArgvFn: (_f: string, args: string[]) => {
                        if (args.includes('--detach')) throw new Error('detach упал');
                        return '';
                    },
                }),
                text: /дерево раннера не обновилось.*detach упал/,
            },
            {
                name: 'ревью-сессия упала',
                overrides: () => ({ pickReviewModelFn: () => 'claude-rev', runClaudeFn: () => 1 }),
                text: /ревью-сессия фазы "M1" упала \(код 1\)/,
            },
            {
                name: 'шаг правок по ревью упал',
                overrides: () => ({ runClaudeFn: () => 1 }),
                text: /шаг правок по ревью фазы "M1" упал \(код 1\)/,
            },
            {
                name: 'гейт: PR смерджен, локальное состояние требует починки',
                state: { submitted: true },
                overrides: () => ({ tryMergePhaseFn: () => 'merged-local-stale' }),
                text: /PR смерджен, но локальное состояние/,
            },
            {
                name: 'сессия разбора blocked упала',
                state: { submitted: true, lastReviewModel: 'claude-rev' },
                overrides: () => ({
                    tryMergePhaseFn: () => 'blocked',
                    pickReviewModelFn: () => 'claude-rev',
                    runClaudeFn: (prompt: string) =>
                        prompt.includes('Ты планировщик правок') ? 0 : 1,
                }),
                text: /сессия разбора blocked фазы "M1" упала \(код 1\)/,
            },
            {
                name: 'повторное ревью после разбора blocked упало',
                state: { submitted: true, lastReviewModel: 'claude-rev' },
                overrides: () => {
                    let calls = 0;
                    return {
                        tryMergePhaseFn: () => 'blocked',
                        pickReviewModelFn: () => 'claude-rev',
                        runClaudeFn: () => (++calls <= 2 ? 0 : 1),
                    };
                },
                text: /повторное ревью blocked фазы "M1" упало \(код 1\)/,
            },
            {
                name: 'чини-сессия гейта упала',
                state: { submitted: true },
                overrides: () => ({
                    tryMergePhaseFn: () => 'red-checks',
                    getLastRedCheck: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'boom' }),
                    runClaudeFn: () => 1,
                }),
                text: /чини-сессия гейта фазы "M1" упала \(код 1\)/,
            },
        ];

        it.each(cases)('$name', ({ state, overrides, text }) => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            const advancePhaseFn = vi.fn();
            const tryMergePhaseFn = vi.fn(() => 'not-merged');
            runLoop(
                validCfg(),
                ctx(mkState(state)),
                deps(logs, { pushEventFn, advancePhaseFn, tryMergePhaseFn, ...overrides() }),
            );
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            expect(String(pushEventFn.mock.calls[0][0])).toMatch(text);
            // Пуш — тот же канал, что лог (боевой pushEvent печатает 🔔 PUSH), поэтому
            // логгер прокинут: иначе строка ушла бы мимо инжектированного лога.
            expect(pushEventFn.mock.calls[0][2]).toEqual(
                expect.objectContaining({ logFn: expect.any(Function) }),
            );
            // Стоп — а не «пошли дальше»: фаза не продвинута.
            expect(advancePhaseFn).not.toHaveBeenCalled();
        });

        // От противного: «пуш на каждый break» сломал бы и эти ветки — петля в них идёт
        // дальше, и человек ей не нужен.
        it('сбой чтения на пути, где петля продолжает, пуша не даёт', () => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            const advancePhaseFn = vi.fn();
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    pushEventFn,
                    advancePhaseFn,
                    phaseMergedFn: () => true,
                    // Номер смердженного PR не прочитался — журнал находок теряет запись,
                    // переход к следующей фазе от этого не зависит.
                    mergedPhasePrFn: failing('форж молчит'),
                    closeMilestoneByTitleFn: () => {},
                }),
            );
            expect(advancePhaseFn).toHaveBeenCalledTimes(1);
            expect(logs.join('\n')).toMatch(/номер смердженного PR.*форж молчит/);
            expect(pushEventFn).not.toHaveBeenCalled();
        });

        it('сбой чтения очереди после сессии (оценка прогресса) пуша не даёт', () => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            let reads = 0;
            const runClaudeFn = vi.fn(() => 0);
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    pushEventFn,
                    runClaudeFn,
                    openIssuesFn: () => {
                        if (++reads === 1) return [openIssue];
                        throw new Error('форж молчит');
                    },
                }),
            );
            // Сессия была, сбой оценки прогресса принят за прогресс (fail-open), петля
            // пошла на следующий проход — и тот кончился штатно.
            expect(runClaudeFn).toHaveBeenCalledTimes(1);
            expect(logs.join('\n')).toMatch(/Все фазы завершены/);
            expect(pushEventFn).not.toHaveBeenCalled();
        });

        // #97: прежний fail-open (промпт без комментариев) давал сессии правок пустой
        // список замечаний — она читала его как «править нечего». Теперь повтор чтения,
        // затем стоп с причиной и пушем; сессия с пустым списком не стартует.
        it('комментарии PR не прочитались → повтор, затем стоп; сессия правок не стартует', () => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            const runClaudeFn = vi.fn((_prompt: string, _opts?: Record<string, unknown>) => 0);
            const prCommentsFn = vi.fn(failing('форж молчит'));
            const tryMergePhaseFn = vi.fn(() => 'merged' as const);
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, {
                    pushEventFn,
                    findOpenPrFn: () => ({ number: 5, labels: [] }),
                    prCommentsFn,
                    pickReviewModelFn: () => 'none',
                    runClaudeFn,
                    tryMergePhaseFn,
                }),
            );
            // Чтение повторено, прежде чем сдаться.
            expect(prCommentsFn).toHaveBeenCalledTimes(2);
            expect(logs.join('\n')).toMatch(/комментарии PR #5 .*попытка 1\/2/);
            // Сессия правок не запускалась вовсе — ни с пустым списком, ни без него.
            expect(runClaudeFn).not.toHaveBeenCalled();
            expect(tryMergePhaseFn).not.toHaveBeenCalled();
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            const msg = String(pushEventFn.mock.calls[0][0]);
            expect(msg).toContain('шаг «правки по ревью» не запущен');
            expect(msg).toContain('(forge-unreadable)');
            expect(msg).toContain('форж молчит');
        });

        it('от противного: сбой первого чтения и удача повтора — сессия правок идёт с замечаниями', () => {
            const runClaudeFn = vi.fn((_prompt: string, _opts?: Record<string, unknown>) => 0);
            let reads = 0;
            runLoop(
                validCfg({ authorAllowlist: ['owner'] }),
                ctx(mkState()),
                deps([], {
                    findOpenPrFn: () => ({ number: 5, labels: [] }),
                    prCommentsFn: () => {
                        if (++reads === 1) throw new Error('форж молчит');
                        return [
                            { body: '🟠 [major] замечание', isSummary: false, author: 'owner' },
                        ];
                    },
                    pickReviewModelFn: () => 'none',
                    runClaudeFn,
                    tryMergePhaseFn: () => 'merged',
                }),
            );
            expect(runClaudeFn).toHaveBeenCalled();
            expect(String(runClaudeFn.mock.calls[0][0])).toContain('замечание');
        });

        it('штатное завершение и HITL-стоп пуша не дают — их просил сам человек', () => {
            const pushEventFn = vi.fn();
            const logs: string[] = [];
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, { pushEventFn, phaseIndexOfFn: () => 99 }),
            );
            runLoop(
                validCfg(),
                ctx(mkState()),
                deps(logs, { pushEventFn, once: true, openIssuesFn: () => [openIssue] }),
            );
            expect(logs.join('\n')).toMatch(/Все фазы завершены/);
            expect(logs.join('\n')).toMatch(/HITL/);
            expect(pushEventFn).not.toHaveBeenCalled();
        });
    });
});

describe('ensureClean — чистота дерева раннера, изолированная от дерева человека (#78)', () => {
    it('чистое дерево (git status пуст) → true', () => {
        const logs: string[] = [];
        expect(
            ensureClean('итерация', { shFn: () => '', logFn: (m: string) => logs.push(m) }),
        ).toBe(true);
        expect(logs).toEqual([]);
    });

    it('грязное дерево (git status непуст) → false, лог с контекстом и выводом status', () => {
        const logs: string[] = [];
        const ok = ensureClean('гейт мерджа', {
            shFn: () => ' M src/a.ts\n?? tmp.log',
            logFn: (m: string) => logs.push(m),
        });
        expect(ok).toBe(false);
        expect(logs.join('\n')).toMatch(/Грязное рабочее дерево \(гейт мерджа\)/);
        expect(logs.join('\n')).toMatch(/src\/a\.ts/);
        // #13: ensureClean сообщает наблюдаемое; стоп решает вызывающий, и говорит о нём он.
        expect(logs.join('\n')).not.toMatch(/стоп|разбери руками/i);
    });

    it('git status упал (не git-репо/сломан) → false (fail-closed), лог об ошибке', () => {
        const logs: string[] = [];
        const ok = ensureClean('итерация', {
            shFn: () => {
                throw new Error('fatal: not a git repository');
            },
            logFn: (m: string) => logs.push(m),
        });
        expect(ok).toBe(false);
        expect(logs.join('\n')).toMatch(/git status упал/);
    });

    it('спрашивает ровно `git status --porcelain` — per-worktree запрос, не общий на репо', () => {
        // Изоляция — свойство именно этой команды: git status смотрит рабочее дерево
        // ТЕКУЩЕГО worktree. Живой git тут не поднимаем осознанно: под git-хуком
        // (pre-push) в env торчит GIT_DIR, и `git` в подпроцессе теста бьёт по НАСТОЯЩЕМУ
        // репозиторию, а не по tmp — проверено больно. Конвенция файла — DI-моки; сам
        // per-worktree характер команды закреплён этой ассертой.
        const cmds: string[] = [];
        ensureClean('итерация', {
            shFn: (c: string) => {
                cmds.push(c);
                return '';
            },
            logFn: () => {},
        });
        expect(cmds).toEqual(['git status --porcelain']);
    });

    // Критерий #78 на уровне ralph: правки человека в соседнем дереве в вердикт не
    // попадают. Реальный sh после process.chdir (#76) выполняет `git status` в cwd
    // раннера, поэтому shFn моделирует ИМЕННО дерево раннера — что бы ни творилось у
    // человека, ensureClean видит только выхлоп своего дерева.
    it('дерево раннера чистое → true, чем бы ни было грязно дерево человека (изоляция)', () => {
        // shFn = «git status в worktree раннера»: раннер ничего не трогал → пусто.
        // (Дерево человека может быть сколь угодно грязным — до этого shFn не доходит.)
        const runnerTreeStatus = () => '';
        expect(ensureClean('итерация', { shFn: runnerTreeStatus, logFn: () => {} })).toBe(true);
    });
});

// #390: диагностика падения кодер-сессии — сразу после ненулевого кода выхода, не
// откладывая до ensureCleanFn следующей итерации (инцидент 28.07.2026, DEADMAN фазы 4).
describe('handleCrashedCoderSession — падение кодер-сессии: диагностика и решение о стопе (#390)', () => {
    const issue = { number: 42 };

    itPosix(
        'грязное дерево после падения → stop:true, честное сообщение (issue, код, файлы, путь к логу) в лог и пуш',
        () => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            const saveSessionOutputFn = vi.fn();
            const result = handleCrashedCoderSession(issue, 1, 'boom output', {
                shFn: () => ' M src/a.ts\n?? tmp.log',
                logFn: (m: string) => logs.push(m),
                pushEventFn,
                saveSessionOutputFn,
                cfg: {} as unknown,
            });
            expect(result).toEqual({ stop: true });
            // Сообщение называет И падение (issue, код), И оставшиеся файлы.
            expect(logs.join('\n')).toMatch(/Issue #42/);
            expect(logs.join('\n')).toMatch(/код 1/);
            expect(logs.join('\n')).toMatch(/src\/a\.ts/);
            expect(logs.join('\n')).toMatch(/\.claude\/ralph\/sessions\/42-\d+\.log/);
            // Пуш содержит то же самое сообщение (не отдельный текст).
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            expect(pushEventFn.mock.calls[0][0]).toBe(
                logs.find((l) => l.includes('Issue #42') && l.includes('src/a.ts')),
            );
        },
    );

    // #67: 127 (и 126) — это ОТКАЗ СРЕДЫ, а не «сессия не справилась»: бинаря кодер-рантайма
    // нет или он не исполняется. Продолжать нечем — следующая итерация упадёт так же, за
    // секунду, и петля сожжёт весь бюджет вхолостую. Поймано на полигоне 12.08: Claude CLI
    // обновил сам себя посреди прогона, и три итерации сгорели за пять секунд.
    it.each([127, 126])('#67 код %i (отказ среды) → stop:true даже при чистом дереве', (code) => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const result = handleCrashedCoderSession(issue, code, 'command not found', {
            shFn: () => '',
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
        });
        expect(result).toEqual({ stop: true });
        // Сообщение называет причину классом, а не кодом: человеку в пуше нужно понять,
        // что чинить — среду, а не задачу.
        expect(logs.join('\n')).toMatch(/рантайм/i);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
    });

    // Фаза 16: отозванный вход — отказ среды. Без стопа петля шла бы следующей итерацией на
    // ту же карточку, и брейкер серии остановил бы её с причиной «не сдаётся».
    it('исход auth → stop:true до git status, причина «вход» в лог и пуш', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const shFn = vi.fn(() => ' M src/a.ts');
        const result = handleCrashedCoderSession(issue, 1, 'Not logged in', {
            shFn,
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
            endReason: 'auth',
        });
        expect(result).toEqual({ stop: true });
        expect(shFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/отверг вход/);
        expect(logs.join('\n')).toMatch(/ключ рантайма/);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/Issue #42/);
    });

    it('чистое дерево после падения → stop:false, прежнее поведение (fail-open), пуш не зовётся', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const result = handleCrashedCoderSession(issue, 1, 'boom output', {
            shFn: () => '',
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
        });
        expect(result).toEqual({ stop: false });
        expect(pushEventFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/продолжаем/);
    });

    it('git status после падения сам упал → fail-closed stop:true (неизвестное состояние — не «чисто»)', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const result = handleCrashedCoderSession(issue, 1, 'boom output', {
            shFn: () => {
                throw new Error('fatal: not a git repository');
            },
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
        });
        expect(result).toEqual({ stop: true });
        expect(pushEventFn).toHaveBeenCalledTimes(1);
    });

    itPosix(
        'сохраняет вывод сессии по пути `.claude/ralph/sessions/<issue>-<ts>.log`, секреты петли — в список редактирования',
        () => {
            const saveSessionOutputFn = vi.fn();
            handleCrashedCoderSession(issue, 1, 'boom output', {
                shFn: () => '',
                logFn: () => {},
                pushEventFn: () => {},
                saveSessionOutputFn,
                cfg: {} as unknown,
            });
            expect(saveSessionOutputFn).toHaveBeenCalledTimes(1);
            const [filePath, output, secrets] = saveSessionOutputFn.mock.calls[0];
            expect(filePath).toMatch(/^\.claude\/ralph\/sessions\/42-\d+\.log$/);
            expect(output).toBe('boom output');
            expect(Array.isArray(secrets)).toBe(true);
        },
    );

    it('вывод сохраняется даже при ЧИСТОМ дереве — причина падения не теряется', () => {
        const saveSessionOutputFn = vi.fn();
        handleCrashedCoderSession(issue, 1, 'diagnostic output', {
            shFn: () => '',
            logFn: () => {},
            pushEventFn: () => {},
            saveSessionOutputFn,
        });
        expect(saveSessionOutputFn).toHaveBeenCalledTimes(1);
    });

    it('в список редактирования попадает ключ АКТИВНОГО кодер-рантайма (kimi/openai по фактическому authTokenEnv), не только секреты петли', () => {
        // Итерация могла идти под kimi/openai (coderRuntimeRunFor) — упавшая codex/kimi-сессия,
        // процитировавшая свой env, легла бы на диск с незаредактированным ключом провайдера,
        // если бы список был захардкожен на четыре env-имени петли. Имя env резолвим из
        // конфига рантаймов (в т.ч. КАСТОМНЫЙ authTokenEnv), значение — из process.env.
        const saveSessionOutputFn = vi.fn();
        const saved = {
            RALPH_KIMI_AUTH_TOKEN: process.env.RALPH_KIMI_AUTH_TOKEN,
            MY_OPENAI_KEY: process.env.MY_OPENAI_KEY,
            GH_TOKEN: process.env.GH_TOKEN,
        };
        process.env.RALPH_KIMI_AUTH_TOKEN = 'sk-moon-secret'; // дефолтный kimi authTokenEnv
        process.env.MY_OPENAI_KEY = 'sk-openai-secret'; // кастомный openai authTokenEnv
        process.env.GH_TOKEN = 'gh-secret'; // секрет петли
        try {
            handleCrashedCoderSession(issue, 1, 'boom output', {
                shFn: () => '',
                logFn: () => {},
                pushEventFn: () => {},
                saveSessionOutputFn,
                cfg: { openaiRuntime: { authTokenEnv: 'MY_OPENAI_KEY' } } as unknown,
            });
            const secrets = saveSessionOutputFn.mock.calls[0][2] as Array<string | undefined>;
            expect(secrets).toContain('gh-secret');
            expect(secrets).toContain('sk-moon-secret');
            expect(secrets).toContain('sk-openai-secret');
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    });

    // #56: токен площадки задач — боевой секрет с правом мерджа в main, а в списке редакции
    // его не было: список знал только секреты петли и рантайма. Имя переменной ядро берёт
    // у АКТИВНОГО шва taskSource (secretEnvNames), а не перечислением площадок — поэтому
    // тест подставляет шов с выдуманным именем, которого ядро знать не может.
    describe('#56: секрет активного шва taskSource редактируется в выводе, логе и пуше', () => {
        const FORGE_ENV = 'SOME_FORGE_TOKEN_56';
        const FORGE_SECRET = 'forge-secret-56-value';
        beforeEach(() => {
            process.env[FORGE_ENV] = FORGE_SECRET;
        });
        afterEach(() => {
            delete process.env[FORGE_ENV];
        });

        function crashWith(secretEnvNames: string[]) {
            let saved = '';
            const logs: string[] = [];
            const pushes: string[] = [];
            handleCrashedCoderSession(issue, 1, `curl: Authorization: Bearer ${FORGE_SECRET}`, {
                // Хвост ошибки с токеном: git status упал и процитировал его — этот текст
                // уходит в лог и в пуш.
                shFn: () => {
                    throw new Error(`fatal: https://x:${FORGE_SECRET}@example.com refused`);
                },
                logFn: (m: string) => logs.push(m),
                pushEventFn: (m: string) => {
                    pushes.push(m);
                    return true;
                },
                saveSessionOutputFn: (
                    _p: string,
                    out: string,
                    secrets?: Array<string | undefined>,
                ) => {
                    saved = util.redactSecrets(out, secrets ?? []);
                },
                cfg: {} as unknown,
                secretEnvNamesFn: () => secretEnvNames,
            });
            return { saved, log: logs.join('\n'), push: pushes.join('\n') };
        }

        it('значение токена площадки заменено в выводе сессии, логе и пуше', () => {
            const { saved, log, push } = crashWith([FORGE_ENV]);
            expect(saved).not.toContain(FORGE_SECRET);
            expect(saved).toContain('***');
            expect(log).not.toContain(FORGE_SECRET);
            expect(push).not.toContain(FORGE_SECRET);
            // Сообщение при этом осталось на месте — вырезан только секрет.
            expect(log).toMatch(/git status после падения тоже упал/);
        });

        it('от противного: шов, не объявивший секрет, оставляет его видимым — редакцию даёт именно объявление', () => {
            const { saved, log, push } = crashWith([]);
            expect(saved).toContain(FORGE_SECRET);
            expect(log).toContain(FORGE_SECRET);
            expect(push).toContain(FORGE_SECRET);
        });
    });

    describe('задача 96: каждый ключ списка ротации редактируется, а не только активный', () => {
        const LIST = 'rot-key-a-96,rot-key-b-96';
        beforeEach(() => {
            process.env.RALPH_CLAUDE_OAUTH_TOKENS = LIST;
        });
        afterEach(() => {
            delete process.env.RALPH_CLAUDE_OAUTH_TOKENS;
        });

        it('второй ключ списка в выводе и пуше заменён', () => {
            let saved = '';
            const pushes: string[] = [];
            handleCrashedCoderSession(issue, 1, 'auth failed for rot-key-b-96', {
                shFn: () => {
                    throw new Error('fatal: token rot-key-b-96 rejected');
                },
                logFn: () => {},
                pushEventFn: (m: string) => {
                    pushes.push(m);
                    return true;
                },
                saveSessionOutputFn: (
                    _p: string,
                    out: string,
                    secrets?: Array<string | undefined>,
                ) => {
                    saved = util.redactSecrets(out, secrets ?? []);
                },
                cfg: {} as unknown,
                secretEnvNamesFn: () => [],
            });
            expect(saved).not.toContain('rot-key-b-96');
            expect(pushes.join('\n')).not.toContain('rot-key-b-96');
        });
    });

    it('сбой записи вывода (ENOSPC/EACCES) НЕ роняет раннер — диагностика продолжается по git status', () => {
        // Запись вывода — вежливая диагностика, а не инвариант: необёрнутое исключение
        // пролетело бы сквозь runLoop наверх и убило раннер вместо честного git-разбора.
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const result = handleCrashedCoderSession(issue, 1, 'boom output', {
            shFn: () => ' M src/a.ts', // дерево грязное после падения
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            saveSessionOutputFn: () => {
                throw new Error('ENOSPC: no space left on device');
            },
            cfg: {} as unknown,
        });
        // Не бросило: git-status-разбор прошёл, грязное дерево → честный стоп.
        expect(result).toEqual({ stop: true });
        expect(logs.join('\n')).toMatch(/Не удалось сохранить вывод/);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
    });

    // #32: путь к выводу считается до записи, и прежде все строки разбора называли его
    // безусловно. При сбое записи человек открывал из уведомления файл, которого нет, и
    // читал пустое место как «вывод потерялся», а не как «диск кончился» — хотя второе
    // объясняет само падение. Проба от противного: запись бросила — в ДОСТАВЛЕННОМ тексте
    // (пуш, а не только лог) нет пути к файлу, зато есть причина.
    describe('#32: запись вывода бросила — текст разбора не называет несуществующий файл', () => {
        const failingSave = () => {
            throw new Error('ENOSPC: no space left on device');
        };
        const SESSION_PATH_RE = /sessions\/42-\d+\.log/;
        const cases: Array<{
            name: string;
            code: number;
            output: string;
            shFn: (cmd: string) => string;
            commitLeftoversFn?: () => boolean;
            turnRetriesLeft?: number;
        }> = [
            { name: 'отказ среды (127)', code: 127, output: 'not found', shFn: () => '' },
            {
                name: 'отказ git status',
                code: 1,
                output: 'boom',
                shFn: () => {
                    throw new Error('fatal: not a git repository');
                },
            },
            { name: 'грязное дерево', code: 1, output: 'boom', shFn: () => ' M src/a.ts' },
            {
                name: 'бюджет ходов, повтор',
                code: 1,
                output: 'Reached max turns (200)',
                shFn: () => ' M src/a.ts',
                commitLeftoversFn: () => true,
                turnRetriesLeft: 1,
            },
            {
                name: 'бюджет ходов, коммит остатка не удался',
                code: 1,
                output: 'Reached max turns (200)',
                shFn: () => ' M src/a.ts',
                commitLeftoversFn: () => false,
                turnRetriesLeft: 1,
            },
            {
                name: 'бюджет ходов, попытки исчерпаны',
                code: 1,
                output: 'Reached max turns (200)',
                shFn: () => ' M src/a.ts',
            },
        ];
        it.each(cases)('$name → в пуше причина вместо пути', (c) => {
            const logs: string[] = [];
            const pushEventFn = vi.fn();
            handleCrashedCoderSession(issue, c.code, c.output, {
                shFn: c.shFn,
                logFn: (m: string) => logs.push(m),
                pushEventFn,
                saveSessionOutputFn: failingSave,
                cfg: {} as unknown,
                commitLeftoversFn: c.commitLeftoversFn ?? (() => true),
                turnRetriesLeft: c.turnRetriesLeft ?? 0,
            });
            expect(pushEventFn).toHaveBeenCalledTimes(1);
            const pushed = String(pushEventFn.mock.calls[0][0]);
            expect(pushed).not.toMatch(SESSION_PATH_RE);
            expect(pushed).toMatch(/Вывод сессии не сохранён: ENOSPC: no space left on device/);
        });

        it('чистое дерево (только лог) → строка «продолжаем» тоже без пути', () => {
            const logs: string[] = [];
            handleCrashedCoderSession(issue, 1, 'boom', {
                shFn: () => '',
                logFn: (m: string) => logs.push(m),
                pushEventFn: vi.fn(),
                saveSessionOutputFn: failingSave,
                cfg: {} as unknown,
            });
            const cont = logs.find((l) => l.includes('завершился с кодом'));
            expect(cont).toBeDefined();
            expect(cont).not.toMatch(SESSION_PATH_RE);
            expect(cont).toMatch(/Вывод сессии не сохранён: ENOSPC/);
        });

        it('запись удалась → путь к выводу на месте (контроль: проба не краснеет от пустоты)', () => {
            const pushEventFn = vi.fn();
            handleCrashedCoderSession(issue, 1, 'boom', {
                shFn: () => ' M src/a.ts',
                logFn: () => {},
                pushEventFn,
                saveSessionOutputFn: () => {},
                cfg: {} as unknown,
            });
            const pushed = String(pushEventFn.mock.calls[0][0]);
            expect(pushed).toMatch(new RegExp(`Вывод сессии: .*${SESSION_PATH_RE.source}`));
            expect(pushed).not.toMatch(/не сохранён/);
        });
    });

    // #20 (инцидент 28.08.2026, первый боевой прогон, Issue #4 «Button на Gravity»):
    // кодер-сессия упёрлась в `--max-turns 200`, вышла с кодом 1 и оставила 31 файл
    // незакоммиченным. Петля встала «разбери руками» — хотя работа была ГОДНОЙ: гейт на
    // том же грязном дереве прошёл целиком (build, lint, typecheck, 3246 тестов). То есть
    // остановка стоила ручного вмешательства и не спасла ни от чего.
    //
    // Механизм на этот случай в ядре был с #594, но бюджет ходов проверялся ТОЛЬКО в
    // подсистеме ревью (шаги правок и разбора blocked), а ветка кодер-сессии осталась на
    // прежнем «грязно → стоп». Здесь тот же разбор появляется и в ней.
    it('Фаза 16: «Reached max turns» в выводе без исхода turn-limit — не бюджет ходов, стоп', () => {
        const commitLeftoversFn = vi.fn(() => true);
        const result = handleCrashedCoderSession(issue, 1, 'Reached max turns (200)', {
            endReason: 'unknown',
            shFn: () => ' M src/a.ts',
            logFn: () => {},
            pushEventFn: vi.fn(),
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
            commitLeftoversFn,
            turnRetriesLeft: 1,
        });
        expect(result.stop).toBe(true);
        expect(result.turnLimitRetry).toBeUndefined();
        expect(commitLeftoversFn).not.toHaveBeenCalled();
    });

    it('#20: бюджет ходов исчерпан + грязное дерево + попытки есть → остаток коммитится, цикл НЕ встаёт', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const commitLeftoversFn = vi.fn(() => true);
        const result = handleCrashedCoderSession(issue, 1, 'Reached max turns (200)', {
            endReason: 'turn-limit',
            shFn: () => ' M src/a.ts\n?? tmp.log',
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
            commitLeftoversFn,
            turnRetriesLeft: 1,
        });
        expect(result.stop).toBe(false);
        // Флаг нужен вызывающему: он ведёт счётчик попыток по карточке.
        expect(result.turnLimitRetry).toBe(true);
        // Работа сохранена: без коммита следующая сессия стартовала бы поверх чужой
        // полу-работы (M2), а ensureClean встал бы на грязном дереве.
        expect(commitLeftoversFn).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/бюджет ходов/);
        // Человеку это сообщают: пуш о продолжении, а не молчаливое решение.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
    });

    it('#20: код 1 БЕЗ маркера бюджета + грязное дерево → прежний стоп (настоящее падение остаётся fail-closed)', () => {
        const logs: string[] = [];
        const commitLeftoversFn = vi.fn(() => true);
        const result = handleCrashedCoderSession(issue, 1, 'TypeError: boom', {
            shFn: () => ' M src/a.ts',
            logFn: (m: string) => logs.push(m),
            pushEventFn: vi.fn(),
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
            commitLeftoversFn,
            turnRetriesLeft: 5,
        });
        expect(result.stop).toBe(true);
        // Повторять сессию, которая упала по-настоящему, значит жечь бюджет об ту же стену.
        expect(commitLeftoversFn).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/незакоммиченные изменения/);
    });

    it('#20: попытки исчерпаны → стоп, и сообщение называет причиной бюджет ходов, а не отказ сессии', () => {
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const commitLeftoversFn = vi.fn(() => true);
        const result = handleCrashedCoderSession(issue, 1, 'Reached max turns (200)', {
            endReason: 'turn-limit',
            shFn: () => ' M src/a.ts',
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
            commitLeftoversFn,
            turnRetriesLeft: 0,
        });
        expect(result.stop).toBe(true);
        expect(commitLeftoversFn).not.toHaveBeenCalled();
        // Диагноз в сообщении: не «сессия отказала», а «не влезла» — иначе человек ищет
        // несуществующую поломку вместо того, чтобы разрезать карточку.
        expect(logs.join('\n')).toMatch(/бюджет ходов/);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
    });

    it('#20: остаток не удалось закоммитить → стоп fail-closed (состояние дерева неизвестно)', () => {
        const logs: string[] = [];
        const result = handleCrashedCoderSession(issue, 1, 'Reached max turns (200)', {
            endReason: 'turn-limit',
            shFn: () => ' M src/a.ts',
            logFn: (m: string) => logs.push(m),
            pushEventFn: vi.fn(),
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
            commitLeftoversFn: () => false,
            turnRetriesLeft: 1,
        });
        // Продолжать поверх неспасённой работы нельзя: следующая сессия писала бы поверх
        // чужой полу-работы, а что именно осталось в дереве — уже неизвестно.
        expect(result.stop).toBe(true);
        expect(logs.join('\n')).toMatch(/Issue #42/);
    });

    it('#20: чистое дерево после исчерпания ходов → прежнее поведение (продолжаем, коммитить нечего)', () => {
        const commitLeftoversFn = vi.fn(() => true);
        const result = handleCrashedCoderSession(issue, 1, 'Reached max turns (200)', {
            endReason: 'turn-limit',
            shFn: () => '',
            logFn: () => {},
            pushEventFn: vi.fn(),
            saveSessionOutputFn: () => {},
            cfg: {} as unknown,
            commitLeftoversFn,
            turnRetriesLeft: 1,
        });
        expect(result.stop).toBe(false);
        // Ветка «дерево чистое» не трогается вовсе: спасать нечего, попытку не тратим.
        expect(result.turnLimitRetry).toBeUndefined();
        expect(commitLeftoversFn).not.toHaveBeenCalled();
    });
});

describe('ветковая хореография в worktree раннера (#77)', () => {
    // Модель после #76: раннер живёт в выделенном worktree, а git не даёт занять один
    // ref двум worktree сразу. Поэтому гейт НЕ занимает именованных веток вовсе:
    // чеки — на detached PR-head sha, парковка/обновление — detached origin/main.
    // Локальный main (ref человека) раннер не трогает никогда.
    const SHA_A = 'a'.repeat(40);
    const SHA_B = 'b'.repeat(40);

    describe('parkOnOriginMain — парковка дерева раннера', () => {
        it('паркует detached на origin/main через argv (#193), НЕ занимая ветку main', () => {
            const calls: Array<[string, string[]]> = [];
            parkOnOriginMain({
                runArgvFn: (file: string, args: string[]) => calls.push([file, args]),
                logFn: () => {},
            });
            expect(calls).toEqual([['git', ['checkout', '--detach', 'origin/main']]]);
        });

        it('best-effort: сбой checkout не бросает, только лог', () => {
            const logs: string[] = [];
            expect(() =>
                parkOnOriginMain({
                    runArgvFn: () => {
                        throw new Error('нет origin/main');
                    },
                    logFn: (m: string) => logs.push(m),
                }),
            ).not.toThrow();
            expect(logs.join('\n')).toMatch(/origin\/main/);
        });
    });

    describe('checksGreen — чеки гейта на detached PR-голове', () => {
        // Фабрика шаблонного зелёного окружения. Запись команд — всегда в обёртке
        // (shCmds наполняется при любом сценарии); сценарий переопределяет только
        // ПОВЕДЕНИЕ команд через shImpl (вернуть/бросить) — одну грань за раз.
        const mkDeps = ({
            shImpl,
            ...rest
        }: { shImpl?: (cmd: string) => string; [k: string]: unknown } = {}) => {
            const shCmds: string[] = [];
            const parkFn = vi.fn();
            const deps = {
                shFn: (cmd: string) => {
                    shCmds.push(cmd);
                    if (shImpl) return shImpl(cmd);
                    if (cmd.startsWith('git rev-parse --verify')) return SHA_A;
                    return '';
                },
                // #193: git fetch/checkout идут через argv-коллаборатор (execFile без
                // шелла). Нормализуем в строку и пишем в тот же shCmds/shImpl, чтобы
                // сценарии (throw на 'git fetch') и ассерты остались прежними по смыслу.
                runArgvFn: (file: string, args: string[]) => {
                    const cmd = `${file} ${args.join(' ')}`;
                    shCmds.push(cmd);
                    return shImpl ? shImpl(cmd) : '';
                },
                // #49: голову PR отдаёт шов форжа, а не гейт своей командой `gh`.
                prHeadShaFn: () => SHA_A,
                logFn: () => {},
                parkFn,
                // Авто-npm ci при смене lock (#SiaUX) в юнитах глушим — реальный npm ci
                // здесь не нужен; отдельный describe покрывает саму syncDepsIfLockChanged.
                syncDepsFn: () => {},
                ...rest,
            };
            return { shCmds, parkFn, deps };
        };

        it('зелёный путь: fetch → сверка → detach на sha PR → все чеки → true', () => {
            const { shCmds, parkFn, deps } = mkDeps();
            expect(checksGreen('feature/m1', 42, deps)).toBe(true);
            // #193: argv → в шелл-строку значение не квотируется (shq больше не нужен).
            expect(shCmds).toContain('git fetch origin feature/m1');
            expect(shCmds).toContain(`git checkout --detach ${SHA_A}`);
            // Все базовые чеки конфига ушли в шелл — сколько бы их ни было и как бы они
            // ни назывались в конкретном проекте.
            expect(shCmds).toEqual(expect.arrayContaining(BASE_CHECK_CMDS));
            // Именованные ветки не занимаем: ветку фазы держат кодер-сессии,
            // main — дерево человека.
            expect(shCmds).not.toContain('git checkout feature/m1');
            expect(shCmds).not.toContain('git checkout main');
            // На зелёном дерево остаётся на PR-голове (её и мерджим) — парковки нет.
            expect(parkFn).not.toHaveBeenCalled();
        });

        it('#195 критерий (1): git fetch/checkout уходят раздельными элементами argv (границы сохранены)', () => {
            // Рекордер mkDeps выше нормализует argv в строку `args.join(' ')` — границы
            // аргументов стёрты, `['fetch','origin','a b']` и `['fetch','origin','a','b']`
            // дают одну строку. Здесь отдельный рекордер сохраняет argv МАССИВОМ: значение
            // с пробелом осталось бы ОДНИМ элементом, и шелл его не разложил бы. Это и есть
            // структурная защита от shell-инъекции, ради которой фаза перешла на argv.
            const argvCalls: Array<[string, string[]]> = [];
            const { deps } = mkDeps({
                runArgvFn: (file: string, args: string[]) => {
                    argvCalls.push([file, args]);
                    return '';
                },
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(true);
            expect(argvCalls).toContainEqual(['git', ['fetch', 'origin', 'feature/m1']]);
            expect(argvCalls).toContainEqual(['git', ['checkout', '--detach', SHA_A]]);
        });

        it('#SiaTz/#SiaUX: на зелёном фиксирует голову PR и синкает зависимости после detach', () => {
            const syncDepsFn = vi.fn();
            const { shCmds, deps } = mkDeps({ syncDepsFn });
            expect(checksGreen('feature/m1', 42, deps)).toBe(true);
            // syncDeps зовётся один раз (после detach, до чеков).
            expect(syncDepsFn).toHaveBeenCalledTimes(1);
            expect(shCmds.indexOf(`git checkout --detach ${SHA_A}`)).toBeGreaterThanOrEqual(0);
            // Проверенная голова доступна для --match-head-commit при мердже.
            expect(getVerifiedHead()).toBe(SHA_A);
        });

        it('#SiaTz: голова НЕ фиксируется, если гейт упал до зелёного финала (fetch)', () => {
            const { deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git fetch')) throw new Error('сеть');
                    return '';
                },
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(false);
            expect(getVerifiedHead()).toBeNull();
        });

        // #466 уточнил смысл: останавливает не любое расхождение, а именно ветвление —
        // когда локально есть коммиты, которых нет в PR. Отставший ref подтягивается
        // сам (отдельный тест ниже), поэтому здесь merge-base обязан сказать «не предок».
        it('H3 в worktree: локальная ветка (общий ref кодер-сессий) разошлась с головой PR → false, чеки не гонялись', () => {
            const { shCmds, parkFn, deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git rev-parse --verify')) return SHA_B;
                    if (cmd.startsWith('git merge-base --is-ancestor'))
                        throw new Error('not an ancestor');
                    return '';
                },
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(false);
            expect(shCmds).not.toContain(FIRST_CHECK_CMD);
            expect(shCmds).not.toContain(`git checkout --detach ${SHA_A}`);
            expect(parkFn).toHaveBeenCalled();
        });

        // #466: отставший локальный ref — не расхождение, а нормальное состояние после
        // того, как человек допушил в ветку фазы (влил main ради внешнего красного чека).
        // Потери работы невозможны: localHead — предок головы PR. Раньше это останавливало
        // петлю, а подсказка «синхронизируй (push/pull)» не чинила: дерево раннера
        // detached, ref общий, и лечится только `git branch -f`.
        it('#466 ref отстал (предок головы PR) → подтягиваем fast-forward и продолжаем', () => {
            const { shCmds, parkFn, deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git rev-parse --verify')) return SHA_B;
                    // merge-base --is-ancestor: код 0 → предок
                    if (cmd.startsWith('git merge-base --is-ancestor')) return '';
                    return '';
                },
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(true);
            expect(shCmds).toContain(`git update-ref refs/heads/feature/m1 ${SHA_A}`);
            expect(shCmds).toContain(`git checkout --detach ${SHA_A}`);
            expect(parkFn).not.toHaveBeenCalled();
        });

        it('#466 ветки разошлись (не предок) → стоп, и в логе готовая команда с именем ветки', () => {
            const logs: string[] = [];
            const { shCmds, parkFn, deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git rev-parse --verify')) return SHA_B;
                    if (cmd.startsWith('git merge-base --is-ancestor'))
                        throw new Error('not an ancestor');
                    return '';
                },
                logFn: (m: string) => logs.push(m),
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(false);
            expect(shCmds).not.toContain(FIRST_CHECK_CMD);
            expect(shCmds).not.toContain(`git update-ref refs/heads/feature/m1 ${SHA_A}`);
            expect(parkFn).toHaveBeenCalled();
            // Подсказка обязана быть выполнимой: с именем ветки, а не «синхронизируй».
            expect(logs.join('\n')).toContain('git branch -f feature/m1 origin/feature/m1');
        });

        it('локальной ветки нет (rev-parse падает) — не фатально: чеки идут на PR-голове', () => {
            const { shCmds, deps } = mkDeps({
                shImpl: (cmd: string) => {
                    // Только чтение ЛОКАЛЬНОГО ref ветки: `origin/main` гейт читает тоже
                    // через `rev-parse --verify` (#66), и его отсутствие — уже другой кейс.
                    if (cmd.startsWith('git rev-parse --verify --quiet'))
                        throw new Error('unknown revision');
                    return '';
                },
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(true);
            expect(shCmds).toContain(`git checkout --detach ${SHA_A}`);
        });

        it('git fetch упал → false fail-closed, до форжа и чеков не дошли', () => {
            const prHeadShaFn = vi.fn(() => SHA_A);
            const { shCmds, parkFn, deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git fetch')) throw new Error('сеть умерла');
                    return '';
                },
                prHeadShaFn,
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(false);
            expect(prHeadShaFn).not.toHaveBeenCalled();
            expect(shCmds).not.toContain(FIRST_CHECK_CMD);
            expect(parkFn).toHaveBeenCalled();
        });

        it('голова PR не 40-hex sha → false ДО интерполяции в git-команду (fail-closed)', () => {
            const { shCmds, parkFn, deps } = mkDeps({
                prHeadShaFn: () => 'main; rm -rf /',
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(false);
            expect(shCmds.some((c) => c.includes('rm -rf'))).toBe(false);
            expect(shCmds).not.toContain(FIRST_CHECK_CMD);
            expect(parkFn).toHaveBeenCalled();
        });

        it('красный чек → false, lastRedCheck заполнен именем чека, дерево припарковано', () => {
            const { parkFn, deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git rev-parse --verify')) return SHA_A;
                    if (cmd === SECOND_CHECK_CMD)
                        throw Object.assign(new Error('чек упал'), {
                            stdout: 'no-explicit-any: error',
                            stderr: '',
                        });
                    return '';
                },
            });
            expect(checksGreen('feature/m1', 42, deps)).toBe(false);
            expect(getLastRedCheck()).toMatchObject({
                name: SECOND_CHECK_NAME,
                cmd: SECOND_CHECK_CMD,
            });
            expect(getLastRedCheck().excerpt).toContain('no-explicit-any');
            expect(parkFn).toHaveBeenCalled();
        });

        it('lastRedCheck сбрасывается В НАЧАЛЕ прогона: сбой fetch не маскируется под red-checks прошлого раунда', () => {
            // Раунд 1: красный чек — lastRedCheck заполнен.
            const red = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git rev-parse --verify')) return SHA_A;
                    if (cmd === FIRST_CHECK_CMD) throw new Error('чек упал');
                    return '';
                },
            });
            checksGreen('feature/m1', 42, red.deps);
            expect(getLastRedCheck()).toMatchObject({ name: FIRST_CHECK_NAME });
            // Раунд 2: гейт падает ДО чеков (fetch) — старый red-check не должен выжить,
            // иначе tryMergePhase запустил бы чини-сессию по устаревшей ошибке.
            const fetchFail = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('git fetch')) throw new Error('сеть');
                    return '';
                },
            });
            expect(checksGreen('feature/m1', 42, fetchFail.deps)).toBe(false);
            expect(getLastRedCheck()).toBeNull();
        });

        it('#80: гоняет ИМЕННО переданный список чеков (прод-набор), а не только базу', () => {
            const { shCmds, deps } = mkDeps({ checks: gateChecksFor('prod') });
            expect(checksGreen('feature/m1', 42, deps)).toBe(true);
            // Прод-набор = база + толстые чеки; в шелл ушли все.
            expect(shCmds).toEqual(
                expect.arrayContaining([...BASE_CHECK_CMDS, ...PROD_CHECK_CMDS]),
            );
        });

        // #84: каждый толстый чек по отдельности — не только e2e (было покрыто одним
        // тестом при #80) — должен блокировать мердж так же, как базовый. it.each вместо
        // трёх копипаст-тестов: разница между сценариями — ровно (name, cmd), падение
        // остальных чеков в shImpl проверять не нужно — они и так возвращают ''.
        // Толстые = прод-чеки, которых нет в playground (prod дедупит базовый `test`
        // в пользу coverage, поэтому берём разницу по имени, а не slice по длине).
        const playgroundNames = new Set(gateChecksFor('dev').map(([n]: [string, string]) => n));
        const thickChecks = gateChecksFor('prod').filter(
            ([n]: [string, string]) => !playgroundNames.has(n),
        );

        it.each<[string, string]>(thickChecks)(
            '#84: красный прод-чек %s блокирует так же, как базовый (fail-closed на каждом толстом чеке)',
            (name, cmd) => {
                const { deps } = mkDeps({
                    checks: gateChecksFor('prod'),
                    shImpl: (c: string) => {
                        if (c.startsWith('git rev-parse --verify')) return SHA_A;
                        if (c === cmd) throw new Error(`${name} упал`);
                        return '';
                    },
                });
                expect(checksGreen('feature/m1', 42, deps)).toBe(false);
                expect(getLastRedCheck()).toMatchObject({ name, cmd });
            },
        );

        // #189: чеки и npm ci исполняют код проверяемого PR — им нельзя видеть секреты
        // петли в env. checksGreen строит санированный env по allowlist один раз на прогон
        // и прокидывает его в чеки и syncDeps; git-хореография гейта остаётся с полным env.
        describe('#189: env-санация чеков гейта', () => {
            const SANITIZED = { PATH: '/usr/bin', SENTINEL: 'sanitized' };

            // Как mkDeps, но фиксирует и второй аргумент shFn (opts) — чтобы отличить
            // чек (санированный env) от git-команды (env не подменён).
            const mkEnvDeps = ({
                buildGateEnvFn,
                syncDepsFn,
                ...rest
            }: {
                buildGateEnvFn?: (...a: unknown[]) => unknown;
                syncDepsFn?: (...a: unknown[]) => unknown;
                [k: string]: unknown;
            } = {}) => {
                const calls: Array<[string, unknown]> = [];
                const parkFn = vi.fn();
                const deps = {
                    shFn: (cmd: string, opts?: unknown) => {
                        calls.push([cmd, opts]);
                        if (cmd.startsWith('git rev-parse --verify')) return SHA_A;
                        return '';
                    },
                    // #193: git fetch/checkout — argv, наследуют полный env (opts undefined).
                    // Нормализуем в строку и пишем в тот же calls, чтобы optsOf их находил.
                    runArgvFn: (file: string, args: string[], opts?: unknown) => {
                        calls.push([`${file} ${args.join(' ')}`, opts]);
                        return '';
                    },
                    prHeadShaFn: () => SHA_A,
                    logFn: () => {},
                    parkFn,
                    syncDepsFn: syncDepsFn ?? vi.fn(),
                    buildGateEnvFn: buildGateEnvFn ?? (() => SANITIZED),
                    ...rest,
                };
                return { calls, parkFn, deps };
            };

            it('чеки идут с санированным env, git-команды — с полным (env не подменён)', () => {
                const { calls, deps } = mkEnvDeps();
                expect(checksGreen('feature/m1', 42, deps)).toBe(true);
                const optsOf = (needle: string) =>
                    calls.find(([cmd]) => cmd === needle || cmd.startsWith(needle))?.[1];
                // Чек — с санированным env из buildGateEnvFn.
                expect(optsOf(FIRST_CHECK_CMD)).toEqual({ env: SANITIZED });
                // git fetch/checkout наследуют полный env (нужны секреты для origin), а
                // сетевой fetch вдобавок запрещает промпт кредов (задача 71) и идёт со сроком
                // (задача 30) — санированным он от этого не становится.
                expect(optsOf('git fetch')).toEqual({
                    env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
                    timeoutMs: util.GIT_NETWORK_TIMEOUT_MS,
                });
                expect(optsOf('git fetch')).not.toEqual({ env: SANITIZED });
                expect(optsOf('git checkout --detach')).toBeUndefined();
            });

            it('санированный env прокидывается в syncDeps (npm ci перед чеками)', () => {
                const syncDepsFn = vi.fn();
                const { deps } = mkEnvDeps({ syncDepsFn });
                checksGreen('feature/m1', 42, deps);
                expect(syncDepsFn).toHaveBeenCalledWith({ env: SANITIZED });
            });

            it('fail-closed: buildGateEnvFn бросает (битый allowlist) → false, park, чеки не гонялись', () => {
                const { calls, parkFn, deps } = mkEnvDeps({
                    buildGateEnvFn: () => {
                        throw new Error('битый allowlist');
                    },
                });
                expect(checksGreen('feature/m1', 42, deps)).toBe(false);
                expect(parkFn).toHaveBeenCalled();
                // До чеков не дошли — иначе первый же чек ушёл бы с полным env.
                expect(calls.some(([cmd]) => cmd === FIRST_CHECK_CMD)).toBe(false);
            });
        });
    });

    // Пин СОСТАВА чеков гейта жил здесь и уехал к потребителю (#103): состав — решение
    // проекта (`ralph.config.json`), а не контракт ядра. Логику резолвера (база, prod =
    // база минус prodDropChecks плюс prodChecks, неизвестный профиль → база, копия
    // результата) покрывает gate.test.ts на синтетических конфигах.

    describe('findOpenPr — валидация номера PR из внешнего API', () => {
        const { findOpenPr } = ralph;

        it('целый номер PR → возвращает PR как есть', () => {
            const pr = findOpenPr('feature/m1', {
                forgeJsonFn: () => [{ number: 5, labels: [] }],
                logFn: () => {},
            });
            expect(pr).toEqual({ number: 5, labels: [] });
        });

        it('номер не похож на целое (argument-injection) → null ДО подстановки в argv/шелл', () => {
            // gh number практически всегда integer, но `--flag`-образное значение gh
            // распарсил бы как флаг: фильтр `/^\d+$/` на входе закрывает канал структурно
            // (тот самый класс, ради которого фаза перешла на argv). Fail-closed.
            const logs: string[] = [];
            const pr = findOpenPr('feature/m1', {
                forgeJsonFn: () => [{ number: '--delete-branch', labels: [] }],
                logFn: (m: string) => logs.push(m),
            });
            expect(pr).toBeNull();
            expect(logs.join('\n')).toMatch(/не похож на целое/);
        });

        it('несколько открытых PR → null (fail-closed, разберёт человек)', () => {
            const pr = findOpenPr('feature/m1', {
                forgeJsonFn: () => [
                    { number: 5, labels: [] },
                    { number: 6, labels: [] },
                ],
                logFn: () => {},
            });
            expect(pr).toBeNull();
        });

        it('открытого PR нет → null', () => {
            const pr = findOpenPr('feature/m1', { forgeJsonFn: () => [], logFn: () => {} });
            expect(pr).toBeNull();
        });
    });

    describe('tryMergePhase — гейт мерджа в worktree-модели', () => {
        const phase = { milestone: 'M1', branch: 'feature/m1' };
        // Зелёное окружение по умолчанию: открытый PR без blocked, зелёные чеки,
        // мердж и пост-мердж git проходят. Сценарии переопределяют одну грань;
        // поведение sh-команд — через shImpl, запись в shCmds всегда в обёртке.
        const mkDeps = ({
            shImpl,
            ...rest
        }: { shImpl?: (cmd: string) => string; [k: string]: unknown } = {}) => {
            const shCmds: string[] = [];
            const parkFn = vi.fn();
            const deps = {
                dry: false,
                shFn: (cmd: string) => {
                    shCmds.push(cmd);
                    return shImpl ? shImpl(cmd) : '';
                },
                // #193: gh pr merge и пост-мердж git fetch/checkout — argv (execFile без
                // шелла). Нормализуем в строку в тот же shCmds/shImpl: сценарии (throw на
                // 'git fetch origin main') и ассерты остаются прежними по смыслу.
                runArgvFn: (file: string, args: string[]) => {
                    const cmd = `${file} ${args.join(' ')}`;
                    shCmds.push(cmd);
                    return shImpl ? shImpl(cmd) : '';
                },
                logFn: () => {},
                ensureCleanFn: () => true,
                findOpenPrFn: () => ({ number: 5, labels: [] }),
                checksGreenFn: () => true,
                // #53: после принятого мерджа гейт спрашивает эту же функцию —
                // «форж подтверждает?». Для сценариев успешного мерджа честный ответ — да;
                // сценарии с упавшим мерджем задают false явно, там это предмет проверки.
                phaseMergedFn: () => true,
                sleepFn: () => {},
                parkFn,
                getLastRedCheckFn: () => null,
                // checksGreenFn здесь замокан и не выставляет lastVerifiedHead; фиксируем
                // геттер, чтобы --match-head-commit не подмешался из module-level остатка
                // прошлого теста (детерминизм). Привязку sha проверяет отдельный тест ниже.
                getVerifiedHeadFn: () => null,
                ...rest,
            };
            return { shCmds, parkFn, deps };
        };

        it('зелёный гейт: squash-merge, затем fetch + detach origin/main → merged', () => {
            const { shCmds, deps } = mkDeps();
            expect(tryMergePhase(phase, deps)).toBe('merged');
            const mergeIdx = shCmds.findIndex(
                (c) => c === 'gh pr merge 5 --squash --delete-branch',
            );
            expect(mergeIdx).toBeGreaterThanOrEqual(0);
            // Обновление раннера — строго через origin/main и ПОСЛЕ мерджа.
            expect(shCmds.indexOf('git fetch origin main')).toBeGreaterThan(mergeIdx);
            expect(shCmds).toContain('git checkout --detach origin/main');
            expect(shCmds).not.toContain('git checkout main');
            expect(shCmds).not.toContain('git pull --ff-only');
        });

        it('#80: прокидывает в checksGreen набор чеков по профилю (prod → толстый)', () => {
            const checksGreenFn = vi.fn<ChecksGreenFake>(() => true);
            const { deps } = mkDeps({ checksGreenFn });
            expect(tryMergePhase(phase, { ...deps, profileName: 'prod' })).toBe('merged');
            const optsArg = checksGreenFn.mock.calls[0][2];
            expect(optsArg.checks.map(([name]: [string, string]) => name)).toEqual(
                gateChecksFor('prod').map(([name]: [string, string]) => name),
            );
        });

        it('#80: без profileName (вне цикла) → базовый набор', () => {
            const checksGreenFn = vi.fn<ChecksGreenFake>(() => true);
            const { deps } = mkDeps({ checksGreenFn });
            expect(tryMergePhase(phase, deps)).toBe('merged');
            expect(checksGreenFn.mock.calls[0][2].checks.map(([n]: [string, string]) => n)).toEqual(
                gateChecksFor('dev').map(([n]: [string, string]) => n),
            );
        });

        it('#SiaTz: проверенную голову привязывает через --match-head-commit (TOCTOU-защита)', () => {
            const sha = 'd'.repeat(40);
            const { shCmds, deps } = mkDeps({ getVerifiedHeadFn: () => sha });
            expect(tryMergePhase(phase, deps)).toBe('merged');
            expect(shCmds).toContain(
                `gh pr merge 5 --squash --delete-branch --match-head-commit ${sha}`,
            );
        });

        it('#195 критерий (1): номер PR и sha уходят отдельными элементами argv (границы сохранены)', () => {
            // Как в checksGreen: рекордер mkDeps выше join-ит argv в строку и стирает
            // границы. Здесь argv сохраняется массивом — номер PR и sha отдельными
            // элементами, шелл к ним не прикасается (структурная защита #193), а не
            // квотированием. Пост-мердж git тоже раздельными элементами.
            const sha = 'd'.repeat(40);
            const argvCalls: Array<[string, string[]]> = [];
            const { deps } = mkDeps({
                getVerifiedHeadFn: () => sha,
                runArgvFn: (file: string, args: string[]) => {
                    argvCalls.push([file, args]);
                    return '';
                },
            });
            expect(tryMergePhase(phase, deps)).toBe('merged');
            expect(argvCalls).toContainEqual([
                'gh',
                ['pr', 'merge', '5', '--squash', '--delete-branch', '--match-head-commit', sha],
            ]);
            expect(argvCalls).toContainEqual(['git', ['fetch', 'origin', 'main']]);
            expect(argvCalls).toContainEqual(['git', ['checkout', '--detach', 'origin/main']]);
        });

        it('#SiaTz: sha головы не 40-hex → мерджим без --match-head-commit (не подставляем мусор)', () => {
            const { shCmds, deps } = mkDeps({ getVerifiedHeadFn: () => 'not-a-sha' });
            expect(tryMergePhase(phase, deps)).toBe('merged');
            expect(shCmds).toContain('gh pr merge 5 --squash --delete-branch');
            expect(shCmds.some((c) => c.includes('--match-head-commit'))).toBe(false);
        });

        it('пост-мердж fetch/detach упал → merged-local-stale (PR влит, дерево раннера отстало)', () => {
            const { deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd === 'git fetch origin main') throw new Error('сеть');
                    return '';
                },
            });
            expect(tryMergePhase(phase, deps)).toBe('merged-local-stale');
        });

        it('PR с label blocked → blocked, чеки не гонялись', () => {
            const checksGreenFn = vi.fn<ChecksGreenFake>();
            const { deps } = mkDeps({
                findOpenPrFn: () => ({ number: 5, labels: [{ name: 'blocked' }] }),
                checksGreenFn,
            });
            expect(tryMergePhase(phase, deps)).toBe('blocked');
            expect(checksGreenFn).not.toHaveBeenCalled();
        });

        // #222: hold — человеческий стоп-кран, раннер его не снимает никогда.
        it('#222: PR с label hold → hold, чеки не гонялись', () => {
            const checksGreenFn = vi.fn<ChecksGreenFake>();
            const { deps } = mkDeps({
                findOpenPrFn: () => ({ number: 5, labels: [{ name: 'hold' }] }),
                checksGreenFn,
            });
            expect(tryMergePhase(phase, deps)).toBe('hold');
            expect(checksGreenFn).not.toHaveBeenCalled();
        });

        // #222 критерий 3: hold и blocked одновременно на PR → hold сильнее, стоп без
        // разбора (негативный тест — blocked НЕ должен взять верх).
        it('#222: PR с label hold И blocked одновременно → hold (сильнее), не blocked', () => {
            const checksGreenFn = vi.fn<ChecksGreenFake>();
            const { deps } = mkDeps({
                findOpenPrFn: () => ({
                    number: 5,
                    labels: [{ name: 'hold' }, { name: 'blocked' }],
                }),
                checksGreenFn,
            });
            expect(tryMergePhase(phase, deps)).toBe('hold');
            expect(checksGreenFn).not.toHaveBeenCalled();
        });

        it('#222: PR с label hold → lastGatePr всё равно выставлен (нужен пушу об остановке)', () => {
            const { deps } = mkDeps({
                findOpenPrFn: () => ({ number: 88, labels: [{ name: 'hold' }] }),
            });
            expect(tryMergePhase(phase, deps)).toBe('hold');
            expect(getLastGatePr()).toBe(88);
        });

        // #218: lastGatePr — источник номера PR для пуша «блокер снят автоматически»
        // в runLoop (getLastGatePr). Тем же приёмом, что lastRedCheck/lastVerifiedHead:
        // выставляется, как только PR найден, сбрасывается В НАЧАЛЕ каждого прогона.
        it('#218: находит PR → lastGatePr = его номер (доступно через getLastGatePr)', () => {
            const { deps } = mkDeps({ findOpenPrFn: () => ({ number: 42, labels: [] }) });
            expect(tryMergePhase(phase, deps)).toBe('merged');
            expect(getLastGatePr()).toBe(42);
        });

        it('#218: PR помечен blocked → lastGatePr всё равно выставлен (нужен пушу об исчерпании лимита)', () => {
            const { deps } = mkDeps({
                findOpenPrFn: () => ({ number: 99, labels: [{ name: 'blocked' }] }),
            });
            expect(tryMergePhase(phase, deps)).toBe('blocked');
            expect(getLastGatePr()).toBe(99);
        });

        it('#218: lastGatePr сбрасывается В НАЧАЛЕ прогона — PR прошлого раунда не подставится в новый', () => {
            const found = mkDeps({ findOpenPrFn: () => ({ number: 7, labels: [] }) });
            expect(tryMergePhase(phase, found.deps)).toBe('merged');
            expect(getLastGatePr()).toBe(7);
            const notFound = mkDeps({ findOpenPrFn: () => null });
            expect(tryMergePhase(phase, notFound.deps)).toBe('not-merged');
            expect(getLastGatePr()).toBeNull();
        });

        it('красный гейт: checksGreen=false + red-check → red-checks; без red-check → not-merged', () => {
            const red = mkDeps({
                checksGreenFn: () => false,
                getLastRedCheckFn: () => ({ name: 'coverage', cmd: 'npm run test:coverage' }),
            });
            expect(tryMergePhase(phase, red.deps)).toBe('red-checks');
            const preChecks = mkDeps({ checksGreenFn: () => false, getLastRedCheckFn: () => null });
            expect(tryMergePhase(phase, preChecks.deps)).toBe('not-merged');
        });

        it('мердж упал дважды и PR не влит → not-merged, парковка на origin/main', () => {
            const sleepFn = vi.fn();
            const { shCmds, parkFn, deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('gh pr merge')) throw new Error('merge отвергнут');
                    return '';
                },
                sleepFn,
                // Предмет теста: PR НЕ влит — ни на сверке внутри ретрая, ни где-либо ещё.
                phaseMergedFn: () => false,
            });
            expect(tryMergePhase(phase, deps)).toBe('not-merged');
            expect(shCmds.filter((c) => c.startsWith('gh pr merge'))).toHaveLength(2);
            // #53-ревью: пауза МЕЖДУ ПОПЫТКАМИ МЕРДЖА по-прежнему одна (30с). Прочие вызовы
            // sleep — терпение сверки «мердж дошёл?», и считать их вместе значило бы пинить
            // число попыток подтверждения там, где тест про ретрай мерджа.
            expect(sleepFn.mock.calls.filter((call) => call[0] === 30_000)).toHaveLength(1);
            expect(parkFn).toHaveBeenCalled();
            expect(shCmds).not.toContain('git fetch origin main'); // до пост-мерджа не дошли
        });

        it('мердж «упал», но phaseMerged подтверждает влитие → продолжаем как merged', () => {
            const { deps } = mkDeps({
                shImpl: (cmd: string) => {
                    if (cmd.startsWith('gh pr merge')) throw new Error('оборванный ответ');
                    return '';
                },
                phaseMergedFn: () => true,
            });
            expect(tryMergePhase(phase, deps)).toBe('merged');
        });

        it('dry=true → not-merged, ни одной git/gh-команды (C1 read-only)', () => {
            const shFn = vi.fn();
            const ensureCleanFn = vi.fn();
            const { deps } = mkDeps({ dry: true, shFn, ensureCleanFn });
            expect(tryMergePhase(phase, deps)).toBe('not-merged');
            expect(shFn).not.toHaveBeenCalled();
            expect(ensureCleanFn).not.toHaveBeenCalled();
        });

        it('грязное дерево раннера (ensureClean=false) → not-merged до поиска PR', () => {
            const findOpenPrFn = vi.fn();
            const { deps } = mkDeps({ ensureCleanFn: () => false, findOpenPrFn });
            expect(tryMergePhase(phase, deps)).toBe('not-merged');
            expect(findOpenPrFn).not.toHaveBeenCalled();
        });
    });
});

describe('processAlive — занят ли номер процесса (#74, #176)', () => {
    it('сигнал 0 прошёл → процесс жив', () => {
        expect(processAlive(1234, () => undefined)).toBe(true);
    });

    it('сигнал 0 бросил (нет такого процесса) → мёртв', () => {
        expect(
            processAlive(1234, () => {
                throw new Error('ESRCH');
            }),
        ).toBe(false);
    });

    it('пустой/нулевой pid → мёртв, без вызова kill', () => {
        const kill = vi.fn();
        expect(processAlive(0, kill)).toBe(false);
        expect(processAlive(undefined, kill)).toBe(false);
        expect(kill).not.toHaveBeenCalled();
    });
});

describe('cmdlineIncludes — общее тело cmdline-сверок (#176)', () => {
    it('needle есть в /proc/<pid>/cmdline → true, читает нужный путь', () => {
        const readFn = vi.fn(() => 'node\0.claude/ralph/ralph.js\0');
        expect(cmdlineIncludes(77, 'ralph.js', readFn)).toBe(true);
        expect(readFn).toHaveBeenCalledWith('/proc/77/cmdline', 'utf-8');
    });

    it('needle нет → false', () => {
        expect(cmdlineIncludes(77, 'ralph.js', () => 'nginx\0-g\0')).toBe(false);
    });

    it('чтение /proc упало → false', () => {
        expect(
            cmdlineIncludes(77, 'ralph.js', () => {
                throw new Error('ENOENT');
            }),
        ).toBe(false);
    });

    it('пустой/нулевой pid → false без чтения /proc', () => {
        const readFn = vi.fn();
        expect(cmdlineIncludes(0, 'ralph.js', readFn)).toBe(false);
        expect(cmdlineIncludes(undefined, 'ralph.js', readFn)).toBe(false);
        expect(readFn).not.toHaveBeenCalled();
    });
});

describe('isMonitorProcess — за pid действительно monitor.js (#74)', () => {
    it('в /proc/<pid>/cmdline есть monitor.js → это наш монитор', () => {
        const readFn = vi.fn(() => 'node\0.claude/ralph/runtime/monitor.js\0');
        expect(isMonitorProcess(99, readFn)).toBe(true);
        expect(readFn).toHaveBeenCalledWith('/proc/99/cmdline', 'utf-8');
    });

    // ОС переиспользовала pid: живой процесс есть, но это не монитор — kill нельзя.
    it('чужой процесс под тем же pid → false', () => {
        expect(isMonitorProcess(99, () => 'nginx\0-g\0daemon off;\0')).toBe(false);
    });

    it('процесса нет (чтение /proc упало) → false', () => {
        expect(
            isMonitorProcess(99, () => {
                throw new Error('ENOENT');
            }),
        ).toBe(false);
    });

    it('пустой/нулевой pid → false без чтения /proc', () => {
        const readFn = vi.fn();
        expect(isMonitorProcess(0, readFn)).toBe(false);
        expect(isMonitorProcess(undefined, readFn)).toBe(false);
        expect(readFn).not.toHaveBeenCalled();
    });
});

describe('acquireRunnerLock — взятие лока первым шагом main() (#178)', () => {
    it('dry=true → true без вызова acquireLockFn (C1: --dry-run не проверяет и не берёт лок)', () => {
        const acquireLockFn = vi.fn(() => true);
        expect(acquireRunnerLock({ dry: true, acquireLockFn })).toBe(true);
        expect(acquireLockFn).not.toHaveBeenCalled();
    });

    it('dry=false, лок свободен → true, передаёт вердикт acquireLockFn', () => {
        const acquireLockFn = vi.fn(() => true);
        expect(acquireRunnerLock({ dry: false, acquireLockFn })).toBe(true);
        expect(acquireLockFn).toHaveBeenCalledTimes(1);
    });

    it('dry=false, лок занят → false, передаёт отказ acquireLockFn (main() должен остановиться)', () => {
        const acquireLockFn = vi.fn(() => false);
        expect(acquireRunnerLock({ dry: false, acquireLockFn })).toBe(false);
        expect(acquireLockFn).toHaveBeenCalledTimes(1);
    });
});

describe('startMonitor — авто-спавн панели прогресса (#74)', () => {
    const deps = (over = {}) => ({
        spawnFn: vi.fn<MonitorSpawnFake>(() => ({ pid: 4242, unref: vi.fn(), on: vi.fn() })),
        logFn: vi.fn(),
        readPidFn: () => 0,
        writePidFn: vi.fn(),
        openOutFn: () => 7,
        closeOutFn: vi.fn(),
        aliveFn: () => false,
        isMonitorFn: () => false,
        ...over,
    });

    it('спавнит monitor.js детачнутым, вывод — в файл, pid сохраняется', () => {
        const d = deps();
        const child = startMonitor(d);

        expect(child.pid).toBe(4242);
        const [bin, argv, opts] = d.spawnFn.mock.calls[0];
        expect(bin).toBe(process.execPath);
        expect(argv[0]).toMatch(/monitor\.js$/);
        // Задача 122: путь от каталога ядра, а не от места запуска. CWD-относительный
        // `.claude/ralph/runtime/monitor.js` в раскладке с `roots` указывал в дерево работы,
        // где ядра нет, — монитор падал MODULE_NOT_FOUND на каждой итерации.
        expect(path.isAbsolute(argv[0])).toBe(true);
        expect(fs.existsSync(argv[0])).toBe(true);
        expect(argv[0]).toBe(path.resolve(import.meta.dirname, '..', 'runtime', 'monitor.js'));
        expect(opts.detached).toBe(true);
        // stdout и stderr — в открытый дескриптор файла, stdin не нужен.
        expect(opts.stdio).toEqual(['ignore', 7, 7]);
        expect(d.writePidFn).toHaveBeenCalledWith(4242);
    });

    // Правка по ревью PR #127: без прокидывания профиля панель резолвила бы
    // defaultProfile и показывала чужой режим, когда раннер идёт из --profile prod.
    it('профиль раннера передаётся монитору через argv', () => {
        const d = deps({ profile: 'prod' });
        startMonitor(d);
        const [, argv] = d.spawnFn.mock.calls[0];
        expect(argv.slice(1, 3)).toEqual(['--profile', 'prod']);
    });

    // Задача 29: каталог состояния уходит монитору ВСЕГДА, а не только при заданных `roots`.
    // Он же адрес экземпляра, по которому скан `/proc` отличает свой монитор от монитора
    // соседнего потребителя, — без флага скан не отличал бы их вовсе.
    itPosix('каталог состояния уходит монитору всегда и абсолютным путём', () => {
        const d = deps();
        startMonitor(d);
        const [, argv] = d.spawnFn.mock.calls[0];
        const at = argv.indexOf('--runtime-dir');
        expect(at, '--runtime-dir не передан монитору вовсе').toBeGreaterThan(0);
        // Панель относительный путь не принимает: он резолвился бы от места ЕЁ запуска.
        expect(path.isAbsolute(argv[at + 1])).toBe(true);
        expect(argv[at + 1]).toBe(path.resolve('.claude/ralph'));
    });

    // #126: строка `git:` панели показывает дерево, в котором работает раннер. Вывести его
    // сама панель не может: подъём от каталога ядра уводил выше корня, а ядро исполняется
    // из установки, у которой своя ветка.
    it('дерево работы уходит монитору флагом --execution-root', () => {
        const d = deps({ executionRoot: '/path/to/work-tree' });
        startMonitor(d);
        const [, argv] = d.spawnFn.mock.calls[0];
        const at = argv.indexOf('--execution-root');
        expect(at, '--execution-root не передан монитору').toBeGreaterThan(0);
        expect(argv[at + 1]).toBe('/path/to/work-tree');
    });

    it('main передаёт монитору дерево сессий — при спавне и для переподнятия', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8');
        const body = src.slice(src.indexOf('📂 Рабочее дерево раннера'));
        expect(body).toMatch(/startMonitor\(\{[^}]*executionRoot: sessionTree/);
        expect(body).toMatch(/monitorExecutionRoot: sessionTree/);
    });

    itPosix('без профиля (прямой вызов) лишних флагов нет — кроме адреса экземпляра', () => {
        const d = deps();
        startMonitor(d);
        const [, argv] = d.spawnFn.mock.calls[0];
        expect(argv.slice(1, 2)).toEqual(['--runtime-dir']);
        expect(argv).toHaveLength(3);
    });

    it('unref: раннер не держится в памяти из-за монитора', () => {
        const unref = vi.fn();
        startMonitor(deps({ spawnFn: () => ({ pid: 1, unref, on: vi.fn() }) }));
        expect(unref).toHaveBeenCalled();
    });

    // Родитель обязан закрыть СВОЮ копию дескриптора monitor.out: ребёнок при spawn
    // получил dup, а копия раннера иначе висела бы открытой весь ночной прогон.
    it('дескриптор monitor.out закрывается в родителе после спавна', () => {
        const d = deps();
        startMonitor(d);
        expect(d.closeOutFn).toHaveBeenCalledWith(7);
    });

    it('монитор от прошлого прогона живой → подхватываем его, второй не поднимаем', () => {
        const d = deps({
            readPidFn: () => 99,
            aliveFn: (pid: number) => pid === 99,
            isMonitorFn: (pid: number) => pid === 99,
        });
        // Возвращаем сироту как {pid} — stopMonitor заглушит его при выходе раннера.
        expect(startMonitor(d)).toEqual({ pid: 99 });
        expect(d.spawnFn).not.toHaveBeenCalled();
    });

    // pid из файла жив, но это уже ЧУЖОЙ процесс (ОС переиспользовала номер):
    // подхватывать нельзя — спавним свой монитор.
    it('живой pid из файла, но не monitor.js → спавним свой', () => {
        const d = deps({ readPidFn: () => 99, aliveFn: () => true, isMonitorFn: () => false });
        expect(startMonitor(d).pid).toBe(4242);
        expect(d.spawnFn).toHaveBeenCalled();
    });

    it('pid-файл от убитого процесса не мешает: спавним заново', () => {
        const d = deps({ readPidFn: () => 99, aliveFn: () => false });
        expect(startMonitor(d).pid).toBe(4242);
        expect(d.spawnFn).toHaveBeenCalled();
    });

    it('нечитаемый pid-файл не ломает старт', () => {
        const d = deps({
            readPidFn: () => {
                throw new Error('ENOENT');
            },
        });
        expect(startMonitor(d).pid).toBe(4242);
    });

    // Монитор — удобство: его падение не имеет права ронять ночной прогон.
    it('упавший спавн → null и предупреждение, без исключения наружу', () => {
        const d = deps({
            spawnFn: () => {
                throw new Error('EACCES');
            },
        });
        expect(startMonitor(d)).toBe(null);
        expect(d.logFn.mock.calls.join(' ')).toMatch(/не запустился/);
        // Открытый под спавн дескриптор не течёт и на пути ошибки.
        expect(d.closeOutFn).toHaveBeenCalledWith(7);
    });

    // spawn может упасть и АСИНХРОННО (событие 'error'); без слушателя это был бы
    // uncaughtException — упал бы весь раннер, а не только монитор.
    it("асинхронная ошибка spawn ('error') логируется, а не роняет раннер", () => {
        const on = vi.fn();
        const d = deps({ spawnFn: () => ({ pid: 1, unref: vi.fn(), on }) });
        startMonitor(d);

        const errorHandler = on.mock.calls.find(([event]) => event === 'error')?.[1];
        expect(errorHandler).toBeTypeOf('function');
        expect(() => errorHandler(new Error('EMFILE'))).not.toThrow();
        expect(d.logFn.mock.calls.join(' ')).toMatch(/EMFILE/);
    });
});

describe('stopMonitor — остановка монитора при выходе раннера (#74)', () => {
    // isMonitorFn: () => true — «за pid реально monitor.js», путь до kill открыт.
    it('глушит ГРУППУ процессов (минус pid) и чистит pid-файл', () => {
        const killFn = vi.fn();
        const rmPidFn = vi.fn();
        expect(
            stopMonitor(
                { pid: 4242 },
                { killFn, rmPidFn, logFn: vi.fn(), isMonitorFn: () => true },
            ),
        ).toBe(true);
        expect(killFn).toHaveBeenCalledWith(-4242, 'SIGTERM');
        expect(rmPidFn).toHaveBeenCalled();
    });

    it('если группу убить не вышло — падаем обратно на одиночный pid', () => {
        const calls: number[] = [];
        const killFn = vi.fn((pid: number) => {
            calls.push(pid);
            if (pid < 0) throw new Error('EPERM');
        });
        stopMonitor(
            { pid: 7 },
            { killFn, rmPidFn: vi.fn(), logFn: vi.fn(), isMonitorFn: () => true },
        );
        expect(calls).toEqual([-7, 7]);
    });

    it('монитора нет (не поднялся) → тихо ничего не делаем', () => {
        const killFn = vi.fn();
        expect(stopMonitor(null, { killFn, logFn: vi.fn() })).toBe(false);
        expect(killFn).not.toHaveBeenCalled();
    });

    // Монитор умер сам, ОС отдала его pid чужому процессу — kill(-pid) снёс бы
    // невиновную группу. Сверка перед kill обязана это отсечь; pid-файл всё равно чистим.
    it('pid уже не monitor.js (переиспользован ОС) → kill не зовём, pid-файл чистим', () => {
        const killFn = vi.fn();
        const rmPidFn = vi.fn();
        expect(
            stopMonitor(
                { pid: 4242 },
                { killFn, rmPidFn, logFn: vi.fn(), isMonitorFn: () => false },
            ),
        ).toBe(false);
        expect(killFn).not.toHaveBeenCalled();
        expect(rmPidFn).toHaveBeenCalled();
    });

    it('мёртвый процесс: ошибка kill не пробрасывается наружу', () => {
        expect(() =>
            stopMonitor(
                { pid: 5 },
                {
                    killFn: () => {
                        throw new Error('ESRCH');
                    },
                    rmPidFn: vi.fn(),
                    logFn: vi.fn(),
                    isMonitorFn: () => true,
                },
            ),
        ).not.toThrow();
    });
});

describe('#61: побочки монитора идут через предохранитель (инв. 2)', () => {
    // Дважды на живых прогонах, в разных проектах, сьют поднял НАСТОЯЩИЙ
    // detached-монитор: он пережил тест-раннер (ppid=1, часы жизни) и писал monitor.out и
    // monitor.pid прямо в рабочее дерево. Причина — три боевых дефолта startMonitor мимо
    // guardSideEffect, при том что у соседних spawnClaude/sweepOrphanMonitors он стоит.
    // Каждый дефолт проверяется отдельно: они срабатывают по очереди, и первый же throw
    // (перехваченный внутренним try/catch) закрывает путь к следующим.
    //
    // Журнал вычерпываем splice'ом: общий afterEach из test-setup.ts валит тест на непустом
    // журнале, а здесь непустой журнал — как раз ожидаемый результат.
    const attempts = (): string[] => ralph.sideEffectAttempts.splice(0);
    // Сирота не ищется (иначе adoptMonitor вернул бы чужой pid и до побочки бы не дошло).
    const noOrphan = {
        logFn: vi.fn(),
        readPidFn: () => 0,
        aliveFn: () => false,
        isMonitorFn: () => false,
    };

    it('openOut без инъекции не открывает monitor.out в дереве', () => {
        expect(startMonitor({ ...noOrphan })).toBe(null);
        expect(attempts().join(' | ')).toMatch(/startMonitor:openOut\(.*monitor\.out\)/);
    });

    it('spawn без инъекции не поднимает живой monitor.js', () => {
        expect(startMonitor({ ...noOrphan, openOutFn: () => 7, closeOutFn: vi.fn() })).toBe(null);
        expect(attempts()).toEqual(['startMonitor:spawn(monitor.js)']);
    });

    it('writePid без инъекции не затирает pid боевого монитора', () => {
        startMonitor({
            ...noOrphan,
            openOutFn: () => 7,
            closeOutFn: vi.fn(),
            spawnFn: (() => ({ pid: 4242, unref: vi.fn(), on: vi.fn() })) as never,
        });
        expect(attempts().join(' | ')).toMatch(/startMonitor:writePid\(.*monitor\.pid\)/);
    });

    // stopMonitor шлёт SIGTERM ГРУППЕ реального процесса и удаляет боевой pid-файл. Оба
    // вызова в try/catch, поэтому throw'а мало — ловим именно журнал попыток.
    it('stopMonitor без инъекции не шлёт SIGTERM и не удаляет pid-файл', () => {
        expect(stopMonitor({ pid: 4242 }, { logFn: vi.fn(), isMonitorFn: () => true })).toBe(true);
        const got = attempts();
        expect(got).toContain('stopMonitor:kill(-4242)');
        expect(got.join(' | ')).toMatch(/stopMonitor:rmPid\(.*monitor\.pid\)/);
    });
});

describe('adoptMonitor — подбор монитора-сироты от прошлого прогона (#74)', () => {
    it('живой monitor.js по pid-файлу → подхватываем, а не плодим второй', () => {
        const got = adoptMonitor({
            logFn: vi.fn(),
            readPidFn: () => 77,
            aliveFn: (pid: number) => pid === 77,
            isMonitorFn: (pid: number) => pid === 77,
        });
        expect(got).toEqual({ pid: 77 });
    });

    it('pid мёртв → сироты нет', () => {
        expect(adoptMonitor({ logFn: vi.fn(), readPidFn: () => 77, aliveFn: () => false })).toBe(
            null,
        );
    });

    // ОС переиспользует pid: живой процесс по этому номеру может быть чужим.
    it('pid жив, но за ним не monitor.js → не подхватываем (иначе убьём чужое)', () => {
        expect(
            adoptMonitor({
                logFn: vi.fn(),
                readPidFn: () => 77,
                aliveFn: () => true,
                isMonitorFn: () => false,
            }),
        ).toBe(null);
    });

    it('нет pid-файла → сироты нет, без исключения', () => {
        expect(
            adoptMonitor({
                logFn: vi.fn(),
                readPidFn: () => {
                    throw new Error('ENOENT');
                },
            }),
        ).toBe(null);
    });

    // Сирота от прогона в ДРУГОМ профиле показывал бы чужие phases — та же дыра,
    // что спавн без --profile (ревью PR #127): не подхватываем, а глушим.
    it('сирота в чужом профиле → глушим и не подхватываем', () => {
        const killFn = vi.fn();
        const rmPidFn = vi.fn();
        expect(
            adoptMonitor({
                logFn: vi.fn(),
                readPidFn: () => 77,
                aliveFn: () => true,
                isMonitorFn: () => true,
                readCmdlineFn: () =>
                    'node\0.claude/ralph/runtime/monitor.js\0--profile\0playground\0',
                profile: 'prod',
                killFn,
                rmPidFn,
            }),
        ).toBe(null);
        // Глушим группу сироты и чистим pid-файл — как штатный stopMonitor.
        expect(killFn).toHaveBeenCalledWith(-77, 'SIGTERM');
        expect(rmPidFn).toHaveBeenCalled();
    });

    it('сирота в том же профиле → подхватываем', () => {
        const killFn = vi.fn();
        expect(
            adoptMonitor({
                logFn: vi.fn(),
                readPidFn: () => 77,
                aliveFn: () => true,
                isMonitorFn: () => true,
                readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0--profile\0prod\0',
                profile: 'prod',
                killFn,
            }),
        ).toEqual({ pid: 77 });
        expect(killFn).not.toHaveBeenCalled();
    });

    // Старый сирота без --profile в cmdline резолвил бы defaultProfile — это не
    // обязательно профиль текущего раннера, подхватывать нельзя.
    it('сирота без --profile в cmdline при заданном ожидании → глушим', () => {
        const killFn = vi.fn();
        expect(
            adoptMonitor({
                logFn: vi.fn(),
                readPidFn: () => 77,
                aliveFn: () => true,
                isMonitorFn: () => true,
                readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0',
                profile: 'prod',
                killFn,
                rmPidFn: vi.fn(),
            }),
        ).toBe(null);
        expect(killFn).toHaveBeenCalledWith(-77, 'SIGTERM');
    });

    it('profile не задан (прямой вызов) → сверки нет, подхватываем как раньше', () => {
        expect(
            adoptMonitor({
                logFn: vi.fn(),
                readPidFn: () => 77,
                aliveFn: () => true,
                isMonitorFn: () => true,
                readCmdlineFn: () => {
                    throw new Error('не должен читаться');
                },
            }),
        ).toEqual({ pid: 77 });
    });
});

describe('listMonitorPids — все живые monitor.js сканом /proc, не по pid-файлу (#235)', () => {
    it('фильтрует нечисловые записи /proc и оставляет только monitor.js', () => {
        const readdirFn = () => ['1', '77', 'self', 'net', '200'];
        const isMonitorFn = (pid: number) => pid === 77 || pid === 200;
        expect(listMonitorPids({ readdirFn, isMonitorFn })).toEqual([77, 200]);
    });

    it('/proc не читается → пустой список, без исключения', () => {
        const readdirFn = () => {
            throw new Error('ENOENT');
        };
        expect(listMonitorPids({ readdirFn, isMonitorFn: () => true })).toEqual([]);
    });

    it('ни один pid не monitor.js → пустой список', () => {
        const readdirFn = () => ['1', '2', '3'];
        expect(listMonitorPids({ readdirFn, isMonitorFn: () => false })).toEqual([]);
    });
});

describe('processPpid — ppid процесса из /proc/<pid>/stat (#235)', () => {
    it('парсит ppid из штатного stat (comm простой)', () => {
        const readFn = () => '77 (node) S 1 77 77 0 -1 4194560 …';
        expect(processPpid(77, readFn)).toBe(1);
    });

    it('comm со скобками внутри не сдвигает индекс ppid (режем по ПОСЛЕДНЕЙ закрывающей скобке)', () => {
        const readFn = () => '77 (node (weird)) S 4242 77 77 0 -1 4194560 …';
        expect(processPpid(77, readFn)).toBe(4242);
    });

    it('/proc/<pid>/stat не читается → null, без исключения', () => {
        const readFn = () => {
            throw new Error('ENOENT');
        };
        expect(processPpid(999, readFn)).toBe(null);
    });
});

// #235-ревью: скан /proc (sweepOrphanMonitors) сверяет ПОЛНЫЙ путь MONITOR_PATH, не
// родовое имя 'monitor.js' — иначе чужой monitor.js (pm2, чужой проект) попал бы в
// уборку и был бы прибит SIGTERM'ом всей группе.

// Задача 29: сверка опознаёт монитор ЭТОГО экземпляра — по каталогу состояния в cmdline,
// а не по относительному пути `monitor.js`, одинаковому у каждого потребителя на машине.
// Скан `/proc` идёт по всем процессам системы и сносит найденному группу сигналом, поэтому
// цена промаха здесь — убитый процесс соседнего проекта.
describe('isRalphMonitorProcess — сверка по каталогу состояния экземпляра (задача 29)', () => {
    // Каталог состояния этого экземпляра в тестовом окружении: пути `RUNTIME` ещё
    // CLAUDE_DIR-относительны, поэтому резолвим от текущего дерева — ровно как боевой код.
    const ourRuntimeDir = path.resolve('.claude/ralph');
    const cmdlineOf =
        (dir: string, extra = '') =>
        () =>
            `node\0.claude/ralph/runtime/monitor.js\0--runtime-dir\0${dir}\0${extra}`;

    itPosix('монитор с НАШИМ каталогом состояния → наш', () => {
        expect(isRalphMonitorProcess(99, cmdlineOf(ourRuntimeDir, '--profile\0prod\0'))).toBe(true);
    });

    itPosix('монитор ЧУЖОГО потребителя → НЕ наш, хотя путь к monitor.js тот же', () => {
        // Суть дефекта 29 одной строкой: относительный `.claude/ralph/runtime/monitor.js`
        // у соседнего проекта ровно такой же, и прежняя сверка звала его своим.
        const foreign = cmdlineOf('/srv/other-project/.ralph/runtime', '--profile\0prod\0');
        expect(isRalphMonitorProcess(99, foreign)).toBe(false);
    });

    it('чужой monitor.js по другому пути → НЕ наш (в отличие от нестрогой isMonitorProcess)', () => {
        const cmdline = () => 'node\0/opt/pm2/monitor.js\0';
        expect(isRalphMonitorProcess(99, cmdline)).toBe(false);
        // нестрогая по подстроке 'monitor.js' — как раз ошиблась бы, зацепив чужой
        expect(isMonitorProcess(99, cmdline)).toBe(true);
    });

    itPosix('чужой процесс, у которого наш каталог просто в аргументах → НЕ наш', () => {
        // `tail -f <runtimeDir>/monitor.out` человека содержит наш каталог, но монитором не
        // является: без родового `monitor.js` в сверке скан снёс бы человеку его же tail.
        expect(isRalphMonitorProcess(99, () => `tail\0-f\0${ourRuntimeDir}/monitor.out\0`)).toBe(
            false,
        );
    });

    itPosix('каталог-«сосед» с общим началом пути → НЕ наш', () => {
        // Сравнение подстрокой сюда как раз попалось бы: `<наш>-old` содержит `<наш>` целиком.
        // Так соседний экземпляр того же дерева оказался бы «своим» и получил бы сигнал.
        expect(isRalphMonitorProcess(99, cmdlineOf(`${ourRuntimeDir}-old`))).toBe(false);
    });

    itPosix('наш каталог УПОМЯНУТ в аргументах чужого монитора → НЕ наш', () => {
        // `--runtime-dir` у него свой, а наш путь пришёл значением другого флага.
        const foreign = () =>
            `node\0.claude/ralph/runtime/monitor.js\0--runtime-dir\0/srv/other/.ralph\0` +
            `--log\0${ourRuntimeDir}/monitor.out\0`;
        expect(isRalphMonitorProcess(99, foreign)).toBe(false);
    });

    itPosix('монитор БЕЗ --runtime-dir (поднят раннером до правки) → скану не виден', () => {
        // Осознанный размен: не прибрать своего сироту дешевле, чем прибрать чужого.
        expect(isRalphMonitorProcess(99, () => 'node\0.claude/ralph/runtime/monitor.js\0')).toBe(
            false,
        );
    });

    it('пустой/нулевой pid → false без чтения /proc', () => {
        const readFn = vi.fn();
        expect(isRalphMonitorProcess(0, readFn)).toBe(false);
        expect(readFn).not.toHaveBeenCalled();
    });
});

describe('sweepOrphanMonitors — чужие экземпляры не глушатся (задача 29)', () => {
    // Сверку берём БОЕВУЮ и подсовываем ей только чтение `/proc` — так проверяется, что скан
    // считается с её вердиктом, а не только что сама сверка умеет отвечать. Подменить чтение
    // иначе нечем: `listMonitorPids` прокидывает вниз лишь сам матчер.
    const sweepWith = (cmdline: string) => {
        const stopFn = vi.fn();
        const writePidFn = vi.fn();
        sweepOrphanMonitors({
            profile: 'prod',
            logFn: vi.fn(),
            // readdirFn, а НЕ listPidsFn: подменив список готовым, тест обошёл бы сам отбор —
            // то есть то место, где сверка и применяется (проверено: так он зеленел вхолостую).
            readdirFn: () => ['100'],
            isMonitorFn: (pid: number) => isRalphMonitorProcess(pid, () => cmdline),
            readCmdlineFn: () => cmdline,
            ppidFn: () => 1,
            stopFn,
            writePidFn,
        });
        return { stopFn, writePidFn };
    };

    itPosix('сирота ЧУЖОГО потребителя сигнала не получает', () => {
        // Тот же относительный путь к monitor.js, что у нас, — прежняя сверка звала его своим.
        const { stopFn, writePidFn } = sweepWith(
            'node\0.claude/ralph/runtime/monitor.js\0--runtime-dir\0/srv/other/.ralph\0',
        );
        expect(stopFn, 'Скан послал сигнал монитору чужого потребителя').not.toHaveBeenCalled();
        expect(writePidFn, 'Чужой монитор записан в наш pid-файл').not.toHaveBeenCalled();
    });

    itPosix(
        'свой сирота по-прежнему прибирается — иначе «не глушим» верно и для сломанного',
        () => {
            const { writePidFn } = sweepWith(
                `node\0.claude/ralph/runtime/monitor.js\0--runtime-dir\0${path.resolve('.claude/ralph')}\0--profile\0prod\0`,
            );
            // Единственную свою сироту скан ОСТАВЛЯЕТ и записывает в pid-файл (дальше её штатно
            // подхватит adoptMonitor) — это и есть признак, что она опознана своей.
            expect(writePidFn).toHaveBeenCalledWith(100);
        },
    );
});

describe('sweepOrphanMonitors — уборка сирот-мониторов мимо monitor.pid (#235)', () => {
    it('две сироты + одна легитимная (тот же профиль) → остаётся одна, две глушим', () => {
        const stopFn = vi.fn();
        const writePidFn = vi.fn();
        const logFn = vi.fn();
        const got = sweepOrphanMonitors({
            profile: 'prod',
            logFn,
            listPidsFn: () => [100, 200, 300],
            ppidFn: () => 1, // все трое — настоящие сироты (родитель умер, init усыновил)
            readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0--profile\0prod\0',
            stopFn,
            writePidFn,
        });

        // #235-ревью: возврат ВСЕГДА null — подхват выбранного сироты делает adoptMonitor
        // штатным путём; sweep лишь пишет его в pid-файл.
        expect(got).toBe(null);
        expect(stopFn).toHaveBeenCalledTimes(2);
        expect(stopFn).toHaveBeenCalledWith({ pid: 200 }, expect.any(Object));
        expect(stopFn).toHaveBeenCalledWith({ pid: 300 }, expect.any(Object));
        expect(writePidFn).toHaveBeenCalledWith(100);
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('2'));
    });

    // #235-ревью: типовой сценарий issue — РОВНО одна сирота мимо pid-файла (pid 742406
    // ночью 23.07). Ничего не глушим, но обязаны записать её в pid-файл и вернуть null,
    // чтобы adoptMonitor подхватил её штатно (со своим логом), а не молча.
    it('ровно одна сирота (типовой случай) → пишем в pid-файл, null, без глушений', () => {
        const stopFn = vi.fn();
        const writePidFn = vi.fn();
        const got = sweepOrphanMonitors({
            profile: 'prod',
            listPidsFn: () => [742406],
            ppidFn: () => 1,
            readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0--profile\0prod\0',
            stopFn,
            writePidFn,
        });
        expect(got).toBe(null);
        expect(stopFn).not.toHaveBeenCalled();
        expect(writePidFn).toHaveBeenCalledWith(742406);
    });

    it('сирот нет → null, ничего не глушим и не пишем', () => {
        const stopFn = vi.fn();
        const writePidFn = vi.fn();
        expect(
            sweepOrphanMonitors({
                profile: 'prod',
                listPidsFn: () => [],
                ppidFn: () => 1,
                stopFn,
                writePidFn,
            }),
        ).toBe(null);
        expect(stopFn).not.toHaveBeenCalled();
        expect(writePidFn).not.toHaveBeenCalled();
    });

    // Штатная tmux-панель (RUNBOOK, окно 3) — тот же monitor.js, но с живым
    // родителем-shell (ppid≠1). Уборка её не трогает вовсе: не глушим, не считаем
    // кандидатом на «оставить».
    it('живой родитель (ppid≠1, tmux-панель) → не глушим и не подхватываем', () => {
        const stopFn = vi.fn();
        const writePidFn = vi.fn();
        const got = sweepOrphanMonitors({
            profile: 'prod',
            listPidsFn: () => [500],
            ppidFn: (pid: number) => (pid === 500 ? 4242 : 1), // родитель жив — не сирота
            readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0--profile\0prod\0',
            stopFn,
            writePidFn,
        });
        expect(got).toBe(null);
        expect(stopFn).not.toHaveBeenCalled();
        expect(writePidFn).not.toHaveBeenCalled();
    });

    it('ни одна сирота не в нужном профиле → глушим всех, не подхватываем ни одну', () => {
        const stopFn = vi.fn();
        const writePidFn = vi.fn();
        const logFn = vi.fn();
        const got = sweepOrphanMonitors({
            profile: 'prod',
            logFn,
            listPidsFn: () => [100, 200],
            ppidFn: () => 1,
            readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0--profile\0playground\0',
            stopFn,
            writePidFn,
        });
        expect(got).toBe(null);
        expect(stopFn).toHaveBeenCalledTimes(2);
        expect(writePidFn).not.toHaveBeenCalled();
    });

    it('profile не задан → сверки нет, оставляем первую сироту как есть', () => {
        const stopFn = vi.fn();
        const writePidFn = vi.fn();
        const got = sweepOrphanMonitors({
            listPidsFn: () => [100, 200],
            ppidFn: () => 1,
            readCmdlineFn: () => {
                throw new Error('не должен читаться без profile');
            },
            stopFn,
            writePidFn,
        });
        expect(got).toBe(null);
        expect(stopFn).toHaveBeenCalledTimes(1);
        expect(stopFn).toHaveBeenCalledWith({ pid: 200 }, expect.any(Object));
        expect(writePidFn).toHaveBeenCalledWith(100);
    });
});

describe('ensureMonitorAlive — взаимный контроль раннер↔монитор на каждой итерации (#151)', () => {
    it('монитор жив и это monitor.js → ничего не переподнимаем', () => {
        const startMonitorFn = vi.fn();
        const logFn = vi.fn();
        expect(
            ensureMonitorAlive({
                logFn,
                readPidFn: () => 77,
                aliveFn: (pid: number) => pid === 77,
                isMonitorFn: (pid: number) => pid === 77,
                startMonitorFn,
            }),
        ).toBe(null);
        expect(startMonitorFn).not.toHaveBeenCalled();
        expect(logFn).not.toHaveBeenCalled();
    });

    it('монитор мёртв → переподнимаем через startMonitor и пишем в лог', () => {
        const startMonitorFn = vi.fn(() => ({ pid: 4242 }));
        const logFn = vi.fn();
        const got = ensureMonitorAlive({
            logFn,
            readPidFn: () => 77,
            aliveFn: () => false,
            isMonitorFn: () => false,
            startMonitorFn,
            profile: 'prod',
            configPath: '/tmp/ralph.config.json',
        });
        expect(got).toEqual({ pid: 4242 });
        // deps прокидываются в startMonitor целиком (сквозная инжекция фейков во
        // внутренний adoptMonitor) — profile/configPath доезжают в их составе.
        expect(startMonitorFn).toHaveBeenCalledWith(
            expect.objectContaining({
                profile: 'prod',
                configPath: '/tmp/ralph.config.json',
            }),
        );
        expect(logFn).toHaveBeenCalledTimes(1);
        expect(logFn.mock.calls[0][0]).toMatch(/не отвечает/);
    });

    // ОС переиспользует pid: живой процесс по этому номеру может оказаться чужим —
    // тот же класс проверки, что и в adoptMonitor/stopMonitor.
    it('pid жив, но за ним не monitor.js (переиспользованный pid) → считаем мёртвым, переподнимаем', () => {
        const startMonitorFn = vi.fn(() => ({ pid: 4242 }));
        const got = ensureMonitorAlive({
            logFn: vi.fn(),
            readPidFn: () => 77,
            aliveFn: () => true,
            isMonitorFn: () => false,
            startMonitorFn,
        });
        expect(got).toEqual({ pid: 4242 });
        expect(startMonitorFn).toHaveBeenCalled();
    });

    it('нет pid-файла (readPidFn кидает) → считаем мёртвым, переподнимаем без исключения', () => {
        const startMonitorFn = vi.fn(() => ({ pid: 4242 }));
        expect(
            ensureMonitorAlive({
                logFn: vi.fn(),
                readPidFn: () => {
                    throw new Error('ENOENT');
                },
                startMonitorFn,
            }),
        ).toEqual({ pid: 4242 });
        expect(startMonitorFn).toHaveBeenCalled();
    });

    // #153: критерий готовности фазы — «симуляция: монитор убит между итерациями →
    // к следующей итерации поднят новый, pid-файл обновлён». readPidFn/aliveFn читают
    // общую переменную pidFile — она играет роль pid-файла на диске; startMonitorFn
    // (как и настоящий startMonitor) перезаписывает её новым pid при переподнятии.
    // Побочки — только через DI (никакого реального fs/spawn), поэтому под
    // RALPH_NO_SIDE_EFFECTS=1 предохранитель guardSideEffect тут молчит.
    it('симуляция: монитор убит между итерациями → следующая итерация поднимает новый, pid-файл обновлён', () => {
        let pidFile = 111;
        let alive = true;
        const readPidFn = () => pidFile;
        const aliveFn = (pid: number) => pid === pidFile && alive;
        const isMonitorFn = (pid: number) => pid === pidFile;
        const startMonitorFn = vi.fn(() => {
            pidFile = 222; // тот же эффект, что у настоящего startMonitor: writePidFn
            alive = true;
            return { pid: pidFile };
        });
        const logFn = vi.fn();
        const iteration = () =>
            ensureMonitorAlive({ logFn, readPidFn, aliveFn, isMonitorFn, startMonitorFn });

        // Итерация 1: монитор жив — раннер его не трогает.
        expect(iteration()).toBe(null);
        expect(startMonitorFn).not.toHaveBeenCalled();
        expect(pidFile).toBe(111);

        // Монитор убит МЕЖДУ итерациями (kill -9, OOM) — pid-файл ещё старый.
        alive = false;

        // Итерация 2: смерть обнаружена, монитор переподнят, pid-файл обновлён.
        expect(iteration()).toEqual({ pid: 222 });
        expect(startMonitorFn).toHaveBeenCalledTimes(1);
        expect(pidFile).toBe(222);

        // Итерация 3: новый монитор уже жив по обновлённому pid — второй раз не поднимаем.
        expect(iteration()).toBe(null);
        expect(startMonitorFn).toHaveBeenCalledTimes(1);
    });

    // MONITOR_PID один на все профили: монитор соседнего профиля (playground рядом с
    // prod), перезаписавший файл, alive+monitor.js прошёл бы, но НАШ монитор при этом
    // мёртв. Без профильной сверки раннер всю ночь считал бы чужой процесс своим и не
    // переподнял бы собственный — паритет с adoptMonitor закрывает эту тишину.
    it('pid жив monitor.js, но ЧУЖОГО профиля → свой считаем мёртвым, переподнимаем', () => {
        const startMonitorFn = vi.fn(() => ({ pid: 4242 }));
        const got = ensureMonitorAlive({
            logFn: vi.fn(),
            readPidFn: () => 77,
            aliveFn: () => true,
            isMonitorFn: () => true,
            readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0--profile\0playground\0',
            profile: 'prod',
            startMonitorFn,
        });
        expect(got).toEqual({ pid: 4242 });
        expect(startMonitorFn).toHaveBeenCalled();
    });

    it('pid жив monitor.js НАШЕГО профиля → ничего не переподнимаем', () => {
        const startMonitorFn = vi.fn();
        expect(
            ensureMonitorAlive({
                logFn: vi.fn(),
                readPidFn: () => 77,
                aliveFn: () => true,
                isMonitorFn: () => true,
                readCmdlineFn: () => 'node\0.claude/ralph/runtime/monitor.js\0--profile\0prod\0',
                profile: 'prod',
                startMonitorFn,
            }),
        ).toBe(null);
        expect(startMonitorFn).not.toHaveBeenCalled();
    });

    // Стык с main(): при переподнятии монитора посреди прогона exit-хендлер обязан
    // заглушить ИМЕННО нового ребёнка. #153 проверяет петлю изолированно, здесь —
    // связку «обёртка обновляет захваченную ссылку → stopMonitor глушит новый pid, а
    // не удаляет pid-файл живого». Без фикса exit звал бы stopMonitor(мёртвый старый),
    // тот через isMonitorProcess=false ушёл бы в ветку rmPidFn и снёс бы pid-файл, где
    // уже записан pid НОВОГО монитора — новый остался бы вечным сиротой.
    it('#151: монитор переподнят посреди прогона → exit глушит НОВОГО, ссылка обновлена', () => {
        // Связка main(): захваченная ссылка monitor + обёртка, обновляющая её.
        let monitor = { pid: 111 }; // старый монитор, поднятый на старте
        const ensureWrapped = (o: unknown) => {
            const fresh = ensureMonitorAlive(o);
            if (fresh) monitor = fresh;
            return fresh;
        };

        // Старый (111) умер между итерациями → ensureMonitorAlive поднимает новый (222).
        ensureWrapped({
            logFn: vi.fn(),
            readPidFn: () => 111,
            aliveFn: () => false,
            isMonitorFn: () => false,
            startMonitorFn: () => ({ pid: 222 }),
        });
        expect(monitor).toEqual({ pid: 222 }); // ссылка exit-хендлера обновилась на нового

        // exit-хендлер зовёт stopMonitor(monitor) — с фиксом это новый (222), живой.
        const killFn = vi.fn();
        const rmPidFn = vi.fn();
        stopMonitor(monitor, {
            killFn,
            rmPidFn,
            isMonitorFn: (pid: number) => pid === 222, // живой по этому pid — именно новый монитор
            logFn: vi.fn(),
        });
        expect(killFn).toHaveBeenCalledWith(-222, 'SIGTERM'); // глушим нового, а не сиротим
    });
});

// ── Изоляция раннера в worktree: сценарии и мердж-инварианты (#79) ────────────
// Отдельные describe'ы #76/#77/#78 проверяют КАЖДЫЙ ветковый хелпер по-функции.
// Здесь — два поперечных гаранта, которые из этих поштучных проверок не видны:
//   1) Сценарий: правки/коммиты человека в его главном дереве во время работы loop
//      не роняют ensureClean раннера (критерий #79) — моделируем мир из двух
//      worktree, где `git status --porcelain` отдаёт состояние ТОЛЬКО своего дерева.
//   2) Мердж-инварианты: склеиваем РЕАЛЬНЫЕ checksGreen + tryMergePhase (а не мок
//      вместо checksGreen, как в #77) и на всей последовательности git-команд
//      закрепляем, что раннер НИКОГДА не занимает именованную ветку и не двигает
//      ref человека — ходит строго детачем (PR-голова / origin/main).

describe('Изоляция раннера в worktree — сценарии и мердж-инварианты (#79)', () => {
    // Любая git-команда, которая заняла бы именованную ветку или тронула бы дерево/
    // ref человека. Раннер в worktree-модели не имеет права ни на одну из них: main
    // и ветку фазы держат ЧУЖИЕ worktree (человек / кодер-сессии), git не отдаст один
    // ref двум деревьям, а сам факт checkout/merge/reset в общий рабочий каталог
    // утащил бы за собой правки человека — ровно то, от чего затевалась изоляция (#76).
    //
    // Исключение (#387): `git branch -D <ветка>` РАЗРЕШЁН — но только именно эта форма
    // (delete). Это не занятие/сдвиг чужого ref, а удаление ЛОКАЛЬНОГО ref, который для
    // инварианта H3 создал сам раннер (не дерево человека) и который после подтверждённого
    // мерджа больше не нужен. `git branch -f`/`git branch <name>` (создание/force-move)
    // по-прежнему запрещены — исключение узкое, под одну конкретную команду очистки.
    const FORBIDDEN_GIT = [
        // checkout НЕ через --detach = занятие именованной ветки (в т.ч. `git checkout main`).
        /^git checkout (?!--detach\b)/,
        /^git pull\b/,
        // `merge-base` — чтение (#66: «отстала ли ветка от main»), под запрет не попадает.
        // Само влитие main в отставшую ветку здесь не встречается: голова PR в этих
        // сценариях уже содержит origin/main; его границы — в `main-sync` тестах.
        /^git merge(?!-base\b)\b/,
        /^git reset\b/,
        // `git branch` разрешён ТОЛЬКО в форме `-D <ветка>` (#387, удаление своего же ref
        // после мерджа) — любая другая форма (создание, -f, list с флагами) запрещена.
        /^git branch(?!\s+-D\s)/,
        // ...и даже в форме `-D` защищённые main/master удалять нельзя: исключение #387 —
        // «свой ref ветки фазы», а не «любая ветка». git и сам откажет удалить занятую
        // чужим worktree ветку, но барьер держит заявленную узость явно, не полагаясь на git.
        /^git branch\s+-D\s+(?:main|master)\b/,
        /^git switch\b/,
        /^git update-ref\b/,
        /^git commit\b/,
        /^git push\b/, // пуш ветки — забота кодер-сессии, не гейта раннера
    ];
    const assertNoForbiddenGit = (cmds: string[]) => {
        for (const cmd of cmds.filter((c) => c.startsWith('git '))) {
            for (const re of FORBIDDEN_GIT) {
                expect(re.test(cmd), `запрещённая git-команда в дереве раннера: "${cmd}"`).toBe(
                    false,
                );
            }
        }
    };

    describe('assertNoForbiddenGit — самопроверка гарда инвариантов', () => {
        // Гард ценен только если реально ловит нарушение и пропускает детач. Проверяем
        // обе грани, чтобы «зелёный инвариант» ниже не оказался пустым обещанием.
        it('пропускает детачи и служебные команды раннера', () => {
            expect(() =>
                assertNoForbiddenGit([
                    "git fetch origin 'feature/m1'",
                    'git checkout --detach ' + 'a'.repeat(40),
                    'git checkout --detach origin/main',
                    "git rev-parse --verify --quiet 'refs/heads/feature/m1'",
                    'git status --porcelain',
                    'npm run build',
                ]),
            ).not.toThrow();
        });

        // #387: узкое исключение — удаление СВОЕГО ref веткой фазы после мерджа.
        it('пропускает `git branch -D <ветка>` — удаление своего же ref после мерджа (#387)', () => {
            expect(() => assertNoForbiddenGit(['git branch -D feature/m1'])).not.toThrow();
        });

        it.each([
            'git checkout main',
            'git checkout feature/m1',
            'git switch main',
            'git pull --ff-only',
            'git merge origin/main',
            'git reset --hard origin/main',
            'git branch -f main origin/main',
            'git branch feature/new',
            'git branch --list',
            // #387: даже форма `-D` не открывает удаление защищённых веток — исключение
            // узкое, только «свой ref ветки фазы».
            'git branch -D main',
            'git branch -D master',
            'git push origin feature/m1',
        ])('ловит нарушение: %s', (bad) => {
            expect(() => assertNoForbiddenGit([bad])).toThrow();
        });
    });

    describe('сценарий: правки человека в его main во время loop не роняют ensureClean раннера', () => {
        // Мир из двух worktree общего репозитория: у человека — дерево на ветке main,
        // у раннера — выделенное дерево (#76). Ключевое свойство git: `git status
        // --porcelain` отдаёт состояние ИНДЕКСА/РАБОЧЕГО КАТАЛОГА того worktree, из
        // которого запущен. Раннер после process.chdir (#76) зовёт git в своём дереве,
        // поэтому его ensureClean читает только состояние раннера — что бы человек ни
        // творил у себя. Живой git тут не поднимаем осознанно (см. коммент к #78:
        // под pre-push-хуком GIT_DIR в env уводит подпроцессный git на настоящий репо).
        const mkTwoWorktrees = () => {
            const runner = { porcelain: '' }; // выделенное дерево раннера
            const human = { porcelain: '' }; // дерево человека на ветке main (для наглядности)
            // shFn раннера: git исполняется в дереве раннера, видит только его состояние.
            const runnerSh = (cmd: string) => {
                if (cmd === 'git status --porcelain') return runner.porcelain;
                return '';
            };
            return { runner, human, runnerSh };
        };

        it('человек редактирует, затем коммитит в main посреди прогона — раннер зелёный на каждой проверке', () => {
            const w = mkTwoWorktrees();
            const logs: string[] = [];
            const clean = (ctx: string) =>
                ensureClean(ctx, { shFn: w.runnerSh, logFn: (m: string) => logs.push(m) });

            // Итерация 1: раннер проверяет чистоту перед сессией — своё дерево пусто.
            expect(clean('итерация 1')).toBe(true);

            // Человек правит файлы в своём рабочем дереве (main) во время прогона.
            w.human.porcelain = ' M src/human-edit.ts\n?? human-scratch.txt';
            // Итерация 2: правки человека в дерево раннера не попали — по-прежнему чисто.
            expect(clean('итерация 2')).toBe(true);

            // Человек закоммитил свои правки в main (его дерево снова чистое, но дело не
            // в этом — раннера оно не касалось ни грязным, ни после коммита).
            w.human.porcelain = '';
            // Гейт мерджа: раннер снова проверяет чистоту — зелено.
            expect(clean('гейт мерджа')).toBe(true);

            // За весь сценарий ни одной жалобы на грязь.
            expect(logs).toEqual([]);
        });

        it('контроль (не-вакуумность): грязь в дереве САМОГО раннера ensureClean всё-таки ловит', () => {
            // Если бы изоляция была «всегда true», тест выше ничего не гарантировал.
            // Убитая по maxTurns сессия оставила полу-работу в дереве раннера —
            // ensureClean обязан её увидеть и остановить следующую итерацию.
            const w = mkTwoWorktrees();
            w.runner.porcelain = ' M src/runner-half-work.ts';
            const logs: string[] = [];
            expect(
                ensureClean('итерация', { shFn: w.runnerSh, logFn: (m: string) => logs.push(m) }),
            ).toBe(false);
            expect(logs.join('\n')).toMatch(/Грязное рабочее дерево/);
        });
    });

    describe('мердж-инварианты: реальные checksGreen + tryMergePhase, склеенные одним git-рекордером', () => {
        const SHA_HEAD = 'c'.repeat(40); // голова PR == локальная ветка фазы
        const phase = { milestone: 'M1', branch: 'feature/m1' };

        // Единый рекордер git-команд для ОБЕИХ функций: checksGreen (внутренние deps)
        // и tryMergePhase пишут в один shCmds — так инвариант проверяется на ПОЛНОЙ
        // хореографии гейта, а не по частям. shImpl задаёт поведение конкретных команд.
        const mkWiring = ({ shImpl }: { shImpl?: (cmd: string) => string | undefined } = {}) => {
            const shCmds: string[] = [];
            // Общий рекордер для sh (строки) и argv-мутаций (#193): нормализуем argv в
            // ту же строковую форму, чтобы инвариант проверялся на ПОЛНОЙ хореографии
            // одним списком shCmds, а shImpl задавал поведение по строке команды.
            const record = (cmd: string) => {
                shCmds.push(cmd);
                if (shImpl) {
                    const r = shImpl(cmd);
                    if (r !== undefined) return r;
                }
                if (cmd.startsWith('git rev-parse --verify')) return SHA_HEAD; // локалка == PR
                return '';
            };
            const shFn = (cmd: string) => record(cmd);
            // git fetch/checkout и gh pr merge теперь идут argv-каналом (#193).
            const runArgvFn = (file: string, args: string[]) => record(`${file} ${args.join(' ')}`);
            const detachOriginMain = () =>
                runArgvFn('git', ['checkout', '--detach', 'origin/main']);
            const deps = {
                dry: false,
                shFn,
                runArgvFn,
                logFn: () => {},
                ensureCleanFn: () => true,
                findOpenPrFn: () => ({ number: 5, labels: [] }),
                // РЕАЛЬНЫЙ checksGreen, пишущий в тот же shCmds и видящий ту же PR-голову.
                checksGreenFn: (branch: string, prNumber: number) =>
                    checksGreen(branch, prNumber, {
                        shFn,
                        runArgvFn,
                        prHeadShaFn: () => SHA_HEAD,
                        logFn: () => {},
                        parkFn: detachOriginMain,
                        syncDepsFn: () => {}, // не гоняем реальный npm ci в инвариант-тесте
                    }),
                // #53: после принятого мерджа гейт спрашивает подтверждение у форжа — в
                // сквозном сценарии «зелёный гейт целиком» форж его даёт.
                phaseMergedFn: () => true,
                sleepFn: () => {},
                parkFn: detachOriginMain,
                getLastRedCheckFn: () => null,
            };
            return { shCmds, deps };
        };

        it('зелёный гейт целиком: merged, и ни одной запрещённой git-команды на всём пути', () => {
            const { shCmds, deps } = mkWiring();
            expect(tryMergePhase(phase, deps)).toBe('merged');

            // Позитив: раннер ходил строго детачем — на PR-голову и на origin/main.
            // #193: argv → значения не квотируются в шелл-строку.
            expect(shCmds).toContain('git fetch origin feature/m1');
            expect(shCmds).toContain(`git checkout --detach ${SHA_HEAD}`);
            expect(shCmds).toContain('git fetch origin main');
            expect(shCmds).toContain('git checkout --detach origin/main');
            // #SiaTz: мердж привязан к ТОЙ ЖЕ голове, что прогнал реальный checksGreen —
            // --match-head-commit закрывает TOCTOU-окно между чеками и мерджем.
            expect(shCmds).toContain(
                `gh pr merge 5 --squash --delete-branch --match-head-commit ${SHA_HEAD}`,
            );

            // Инвариант: ни одного занятия именованной ветки / правки дерева человека.
            assertNoForbiddenGit(shCmds);
        });

        it('до мерджа локальную ветку фазы раннер только ЧИТАЕТ (rev-parse --verify), не двигает', () => {
            const { shCmds, deps } = mkWiring();
            expect(tryMergePhase(phase, deps)).toBe('merged');
            // Сверка HEAD==PR идёт read-only обращением к ref — не update-ref/branch -f.
            expect(shCmds).toContain("git rev-parse --verify --quiet 'refs/heads/feature/m1'");
            expect(shCmds.some((c) => /^git update-ref\b/.test(c))).toBe(false);
            expect(shCmds.some((c) => /^git branch(?!\s+-D\s)/.test(c))).toBe(false);
        });

        // #387: ПОСЛЕ подтверждённого мерджа раннер сам чистит свой же локальный ref
        // ветки фазы — узкое, сознательное исключение из «раннер не трогает ref фазы»
        // (создал сам для H3, удаляет сам после мерджа), не занятие/сдвиг чужого ref.
        it('после мерджа раннер удаляет СВОЙ локальный ref ветки фазы (`git branch -D`), #387', () => {
            const { shCmds, deps } = mkWiring();
            expect(tryMergePhase(phase, deps)).toBe('merged');
            expect(shCmds).toContain('git branch -D feature/m1');
            // Мердж случился раньше удаления ref — порядок операций важен.
            const mergeIdx = shCmds.indexOf(
                `gh pr merge 5 --squash --delete-branch --match-head-commit ${SHA_HEAD}`,
            );
            const deleteIdx = shCmds.indexOf('git branch -D feature/m1');
            expect(mergeIdx).toBeGreaterThanOrEqual(0);
            expect(deleteIdx).toBeGreaterThan(mergeIdx);
        });

        it('worktree-ограничение git (main/ветка заняты чужим деревом) хореографию НЕ ломает — раннер её и не трогает', () => {
            // Моделируем реальный отказ git: попытку занять именованную ветку, уже
            // выданную другому worktree, git отвергает fatal-ошибкой. Раннер обязан
            // никогда на это не натыкаться — весь путь идёт детачем, поэтому throw
            // ниже не срабатывает и гейт доходит до merged.
            const { shCmds, deps } = mkWiring({
                shImpl: (cmd: string) => {
                    if (/^git checkout (?!--detach\b)/.test(cmd) || cmd.startsWith('git switch')) {
                        throw new Error("fatal: 'main' is already checked out at '/path/to/app'");
                    }
                    return undefined; // прочее — дефолтное поведение рекордера
                },
            });
            expect(tryMergePhase(phase, deps)).toBe('merged');
            assertNoForbiddenGit(shCmds);
        });

        it('красный чек в реальном checksGreen → red-checks, дерево припарковано детачем на origin/main', () => {
            const { shCmds, deps } = mkWiring({
                shImpl: (cmd: string) => {
                    if (cmd === LAST_CHECK_CMD) {
                        throw Object.assign(new Error('чек упал'), {
                            stdout: '1 failed',
                            stderr: '',
                        });
                    }
                    return undefined;
                },
            });
            // getLastRedCheckFn по умолчанию null — подменим на реальный геттер, чтобы
            // tryMergePhase увидел красный чек, выставленный реальным checksGreen.
            deps.getLastRedCheckFn = getLastRedCheck;
            expect(tryMergePhase(phase, deps)).toBe('red-checks');
            expect(getLastRedCheck()).toMatchObject({ name: LAST_CHECK_NAME });
            // Парковка после красного — тоже строго детачем, инвариант держится.
            expect(shCmds).toContain('git checkout --detach origin/main');
            expect(shCmds).not.toContain('gh pr merge 5 --squash --delete-branch');
            assertNoForbiddenGit(shCmds);
        });
    });
});

// ── #130: роутинг ревью по зоне риска, запас после лимита, бюджет ходов ───────
// Мотивация из прогона 21.07.2026: ревью фазы 3 на fable выело окно лимита и
// остановило цикл на 21 минуту. Разбор показал две отдельные проблемы —
// эскалация решалась по метке СЛОЖНОСТИ issue (а должна — по цене ошибки), и
// ревью получало бюджет ходов кодера, хотя кода не пишет.

describe('globToRegExp — глобы зон риска (#130)', () => {
    const { globToRegExp } = ralph;

    it('** матчит вложенные сегменты', () => {
        const re = globToRegExp('.claude/ralph/**');
        expect(re.test('.claude/ralph/ralph.js')).toBe(true);
        expect(re.test('.claude/ralph/provision/provision.sh')).toBe(true);
    });

    it('** не выходит за пределы своего префикса', () => {
        const re = globToRegExp('.claude/ralph/**');
        expect(re.test('src/app/page.tsx')).toBe(false);
        expect(re.test('docs/.claude/ralph/x.js')).toBe(false);
    });

    it('одиночная * не перепрыгивает через /', () => {
        const re = globToRegExp('src/*.ts');
        expect(re.test('src/middleware.ts')).toBe(true);
        expect(re.test('src/payload/collections/users.ts')).toBe(false);
    });

    it('**/ матчит и корень, и вложенность', () => {
        const re = globToRegExp('**/middleware.ts');
        expect(re.test('middleware.ts')).toBe(true);
        expect(re.test('src/middleware.ts')).toBe(true);
        expect(re.test('src/middleware.test.ts')).toBe(false);
    });

    it('спецсимволы regexp в пути экранируются, а не исполняются', () => {
        // src/app/(payload) — реальный путь route-группы Next.js: скобки обязаны
        // читаться дословно, иначе это regexp-группа и матч поедет.
        const re = globToRegExp('src/app/(payload)/**');
        expect(re.test('src/app/(payload)/admin/page.tsx')).toBe(true);
        expect(re.test('src/app/payload/admin/page.tsx')).toBe(false);
        // Точка — тоже дословно, а не «любой символ».
        expect(globToRegExp('next.config.ts').test('nextXconfig.ts')).toBe(false);
    });
});

describe('matchRiskPaths — попадание диффа в зону риска (#130)', () => {
    const { matchRiskPaths } = ralph;
    const ZONES = ['.github/workflows/**', '.claude/ralph/**', 'src/payload/**'];

    it('возвращает первый файл из зоны риска', () => {
        const files = ['README.md', 'src/payload/collections/users.ts', 'src/app/page.tsx'];
        expect(matchRiskPaths(files, ZONES)).toBe('src/payload/collections/users.ts');
    });

    it('возвращает null, когда дифф целиком вне зон', () => {
        expect(matchRiskPaths(['src/app/page.tsx', 'README.md'], ZONES)).toBe(null);
    });

    it('пустой список зон никогда не эскалирует', () => {
        expect(matchRiskPaths(['.github/workflows/deploy.yml'], [])).toBe(null);
    });

    it('пустой дифф не эскалирует', () => {
        expect(matchRiskPaths([], ZONES)).toBe(null);
    });
});

describe('matchRiskPaths — кривой конфиг не роняет цикл сдачи (#132)', () => {
    const { matchRiskPaths } = ralph;

    // Забыть скобки вокруг единственного паттерна — типовая опечатка в JSON.
    // .map по строке = TypeError прямо в середине сдачи фазы, после ревью.
    it('escalateOnPaths строкой вместо массива — null, а не исключение', () => {
        expect(() => matchRiskPaths(['.github/workflows/deploy.yml'], '.github/**')).not.toThrow();
        expect(matchRiskPaths(['.github/workflows/deploy.yml'], '.github/**')).toBe(null);
    });

    it('files не массив — null, а не исключение', () => {
        expect(matchRiskPaths(null, ['.github/**'])).toBe(null);
        expect(matchRiskPaths(undefined, ['.github/**'])).toBe(null);
    });
});

describe('phaseDiffFiles — какая именно git-команда уходит в шелл (#132)', () => {
    const { phaseDiffFiles } = ralph;

    // #252: fetch — мутация через runArgvFn, diff --name-only остаётся на shFn.
    // Общий рекордер (см. mkCmdRecorders на уровне файла) нормализует runArgvFn в ту же
    // строку `cmds`, чтобы ассерты на порядок команд остались осмысленными.
    const mkRecorders = mkCmdRecorders;

    it('фетчит ДО диффа: решение не принимается по протухшим remote-ссылкам', () => {
        const { cmds, shFn, runArgvFn } = mkRecorders();
        phaseDiffFiles('feature/x', { shFn, runArgvFn, logFn: () => {} });
        expect(cmds[0]).toContain('git fetch origin main feature/x --quiet');
        expect(cmds[1]).toContain('diff --name-only');
        expect(cmds[1]).toContain('origin/main...origin/feature/x');
    });

    it('#252: fetch уходит раздельными элементами argv (branch не в шелл-строке)', () => {
        const argvCalls: Array<[string, string[]]> = [];
        phaseDiffFiles('feature/x', {
            shFn: () => '',
            runArgvFn: (file: string, args: string[]) => {
                argvCalls.push([file, args]);
                return '';
            },
            logFn: () => {},
        });
        expect(argvCalls).toContainEqual([
            'git',
            ['fetch', 'origin', 'main', 'feature/x', '--quiet'],
        ]);
    });

    it('дифф идёт с --no-renames: перенос файла ИЗ зоны риска виден', () => {
        // Без --no-renames git отдаёт только НОВЫЙ путь, и переезд
        // .github/workflows/deploy.yml → docs/old.yml прошёл бы мимо эскалации.
        const { cmds, shFn, runArgvFn } = mkRecorders();
        phaseDiffFiles('feature/x', { shFn, runArgvFn, logFn: () => {} });
        expect(cmds[1]).toContain('--no-renames');
    });

    it('падение fetch не роняет сдачу — null и предупреждение в лог', () => {
        const logs: string[] = [];
        const files = phaseDiffFiles('feature/x', {
            shFn: () => '',
            runArgvFn: () => {
                throw new Error('fatal: could not read from remote');
            },
            logFn: (m: string) => logs.push(m),
        });
        expect(files).toBe(null);
        expect(logs.join('\n')).toMatch(/дифф/i);
    });
});

describe('globToRegExp — ветки конвертера, не покрытые первой версией (#132)', () => {
    const { globToRegExp } = ralph;

    it('** в СЕРЕДИНЕ пути матчит любую вложенность между префиксом и хвостом', () => {
        const re = globToRegExp('src/**/collections/**');
        expect(re.test('src/payload/collections/users.ts')).toBe(true);
        expect(re.test('src/a/b/c/collections/x/y.ts')).toBe(true);
        expect(re.test('src/collections-lookalike/users.ts')).toBe(false);
    });

    it('? матчит ровно один символ и не перепрыгивает через /', () => {
        expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true);
        expect(globToRegExp('src/?.ts').test('src/ab.ts')).toBe(false);
        expect(globToRegExp('src/?.ts').test('src//.ts')).toBe(false);
    });
});

// #232: shq/positiveIntOrDefault/sleep вынесены в общий ralph-util.ts — единственный
// источник правды; их полные негативные наборы (в т.ч. anti-injection round-trip shq
// через живой /bin/sh) живут в ralph-util.test.ts. Здесь — только смоук ре-экспорта:
// ralph.js отдаёт ровно тот же объект, а не свою копию (иначе дубль снова разъедется).

describe('ре-экспорт утилит из ralph-util.ts (#232)', () => {
    // Импорт, а не require: entry теперь ESM, и его граф модулей отдельный от CJS-кеша.
    // require здесь давал ВТОРОЙ экземпляр ralph-util.ts — тест сравнивал две разные
    // функции shq и падал ровно на том, что призван доказывать.

    // sleep в module.exports ralph.js не выведен (используется только внутри), поэтому
    // сверяем экспортируемую пару — этого достаточно, чтобы поймать «завёл вторую копию».
    it('shq/positiveIntOrDefault — тот же объект, что в ralph-util.ts', () => {
        expect(ralph.shq).toBe(util.shq);
        expect(ralph.positiveIntOrDefault).toBe(util.positiveIntOrDefault);
    });
});

describe('phaseDiffFiles — не-ASCII пути и пустой дифф (#132)', () => {
    const { phaseDiffFiles, matchRiskPaths } = ralph;

    it('core.quotePath=false — кириллический путь приходит как есть и матчится зоной', () => {
        const cmds: string[] = [];
        const files = phaseDiffFiles('feature/x', {
            shFn: (c: string) => {
                cmds.push(c);
                return c.includes('diff') ? 'src/payload/коллекции/пользователи.ts' : '';
            },
            runArgvFn: () => '',
            logFn: () => {},
        });
        expect(cmds[0]).toContain('core.quotePath=false');
        // Без флага git отдал бы "src/payload/\320\272..." — мимо любого глоба.
        expect(matchRiskPaths(files, ['src/payload/**'])).toBe(
            'src/payload/коллекции/пользователи.ts',
        );
    });

    it('пустой дифф пишет предупреждение — это аномалия, а не «зоны не задеты»', () => {
        const logs: string[] = [];
        const files = phaseDiffFiles('feature/x', {
            shFn: () => '',
            runArgvFn: () => '',
            logFn: (m: string) => logs.push(m),
        });
        expect(files).toEqual([]);
        expect(logs.join('\n')).toMatch(/пуст/i);
    });

    it('ветка не задана — отдельное сообщение, не «небезопасное имя»', () => {
        const logs: string[] = [];
        expect(
            phaseDiffFiles(undefined, { shFn: () => '', logFn: (m: string) => logs.push(m) }),
        ).toBe(null);
        expect(logs.join('\n')).toMatch(/не задана/i);
        expect(logs.join('\n')).not.toMatch(/небезопасн/i);
    });
});

// #625: предмет второго прохода — дифф ПРАВОК, а не PR целиком. База сравнения приходит
// строкой в git-команду, поэтому её форма — предмет проверки, а не доверия.
describe('дифф ПРАВОК: база сравнения и её валидация (#625)', () => {
    const { phaseDiffFiles, reviewDiffContext, branchHeadSha } = ralph;
    const SHA = 'b'.repeat(40);

    it('с базой сравнение двухточечное от sha, без базы — прежнее трёхточечное от main', () => {
        const cmds: string[] = [];
        const shFn = (c: string) => {
            cmds.push(c);
            return 'src/a.ts';
        };
        phaseDiffFiles('feature/x', { shFn, runArgvFn: () => '', logFn: () => {}, base: SHA });
        phaseDiffFiles('feature/x', { shFn, runArgvFn: () => '', logFn: () => {} });
        expect(cmds[0]).toContain(`${SHA}..origin/feature/x`);
        expect(cmds[1]).toContain('origin/main...origin/feature/x');
    });

    it.each([
        ['ведущий дефис', '-b'.repeat(4)],
        ['опция git', '--upload-pack=x'],
        ['ревизионное выражение', 'HEAD^{/x}'],
        ['не hex', 'zzzzzzz'],
        ['слишком короткий', 'abc'],
    ])('%s как база отвергается — дифф не считается вовсе (fail-closed)', (_n, base) => {
        const logs: string[] = [];
        expect(
            phaseDiffFiles('feature/x', {
                shFn: () => 'src/a.ts',
                runArgvFn: () => '',
                logFn: (m: string) => logs.push(m),
                base,
            }),
        ).toBe(null);
        expect(logs.join('\n')).toMatch(/Небезопасная база/);
    });

    it('кривая база не даёт молча уехать на дифф ФАЗЫ — контекст пустой, а не «вся фаза»', () => {
        expect(
            reviewDiffContext('feature/x', {
                shFn: () => 'diff',
                runArgvFn: () => '',
                logFn: () => {},
                base: 'нет',
            }),
        ).toBe('');
    });

    it('шапка контекста называет предмет: правки, а не фаза', () => {
        const shFn = (cmd: string) => (cmd.includes('--name-only') ? 'src/a.ts' : 'дифф-тело');
        expect(
            reviewDiffContext('feature/x', {
                shFn,
                runArgvFn: () => '',
                logFn: () => {},
                base: SHA,
            }),
        ).toContain('Изменения ПРАВОК по ревью');
    });

    it('пустой дифф правок описывается своим сообщением: сессия ничего не запушила', () => {
        const logs: string[] = [];
        expect(
            phaseDiffFiles('feature/x', {
                shFn: () => '',
                runArgvFn: () => '',
                logFn: (m: string) => logs.push(m),
                base: SHA,
            }),
        ).toEqual([]);
        expect(logs.join('\n')).toMatch(/сессия правок ничего не запушила/);
    });

    describe('branchHeadSha — база берётся с origin, а форма ответа проверяется', () => {
        it('читает origin-ссылку ветки и отдаёт sha', () => {
            const cmds: string[] = [];
            const sha = branchHeadSha('feature/x', {
                shFn: (c: string) => {
                    cmds.push(c);
                    return `${SHA}\n`;
                },
                runArgvFn: () => '',
                logFn: () => {},
            });
            expect(sha).toBe(SHA);
            expect(cmds[0]).toContain('origin/feature/x');
        });

        it('ответ не похож на sha (git ответил текстом) → null, а не аргумент в git', () => {
            expect(
                branchHeadSha('feature/x', {
                    shFn: () => 'fatal: unknown revision',
                    runArgvFn: () => '',
                    logFn: () => {},
                }),
            ).toBe(null);
        });

        it('небезопасное имя ветки отвергается до похода в git', () => {
            const cmds: string[] = [];
            expect(
                branchHeadSha('--upload-pack=x', {
                    shFn: (c: string) => {
                        cmds.push(c);
                        return SHA;
                    },
                    runArgvFn: () => '',
                    logFn: () => {},
                }),
            ).toBe(null);
            expect(cmds).toEqual([]);
        });

        it('сбой git — null и строка в логе, а не исключение из цикла сдачи', () => {
            const logs: string[] = [];
            expect(
                branchHeadSha('feature/x', {
                    shFn: () => {
                        throw new Error('git лёг');
                    },
                    runArgvFn: () => '',
                    logFn: (m: string) => logs.push(m),
                }),
            ).toBe(null);
            expect(logs.join('\n')).toMatch(/база диффа правок|git лёг/);
        });
    });
});

describe('reviewDiffContext — дифф в промпт ревью (#133)', () => {
    const { reviewDiffContext } = ralph;

    // #252: fetch внутри phaseDiffFiles — теперь argv-мутация; noArgv — общий
    // «успешный» стаб, когда сценарий не проверяет саму фазу fetch.
    const noArgv = () => '';
    const shOk = (diffBody: string) => (cmd: string) => {
        if (cmd.includes('--name-only')) return 'src/a.ts\nsrc/b.ts';
        return diffBody;
    };

    it('подаёт список файлов и сам дифф', () => {
        const ctx = reviewDiffContext('feature/x', {
            shFn: shOk('diff --git a/src/a.ts b/src/a.ts\n+строка'),
            runArgvFn: noArgv,
            logFn: () => {},
        });
        expect(ctx).toContain('2 файлов');
        expect(ctx).toContain('- src/a.ts');
        expect(ctx).toContain('+строка');
    });

    // Молча обрезанный дифф — худший исход: ревью решит, что видело всё.
    it('обрезка помечается явно, с числами и указанием дочитать', () => {
        const huge = 'x'.repeat(5000);
        const ctx = reviewDiffContext('feature/x', {
            shFn: shOk(huge),
            runArgvFn: noArgv,
            logFn: () => {},
            limit: 1000,
        });
        expect(ctx).toContain('ДИФФ ОБРЕЗАН');
        expect(ctx).toContain('1000');
        expect(ctx).toContain('5000');
        // #50: «дочитай» осталось, но БЕЗ команды форжа — её у сессии нет, и невыполнимая
        // инструкция хуже отсутствующей: ходы потрачены, вывод «ревьюить нечего».
        expect(ctx).toMatch(/дочитай по файлам/i);
    });

    it('дифф в пределах лимита не помечается обрезанным', () => {
        const ctx = reviewDiffContext('feature/x', {
            shFn: shOk('короткий дифф'),
            runArgvFn: noArgv,
            logFn: () => {},
            limit: 1000,
        });
        expect(ctx).not.toContain('ОБРЕЗАН');
    });

    it('сбой текста диффа не роняет ревью — остаётся список файлов и совет', () => {
        const ctx = reviewDiffContext('feature/x', {
            shFn: (cmd: string) => {
                if (cmd.includes('--name-only')) return 'src/a.ts';
                throw new Error('git diff умер');
            },
            runArgvFn: noArgv,
            logFn: () => {},
        });
        expect(ctx).toContain('- src/a.ts');
        expect(ctx).toMatch(/ревьюй по списку файлов/i);
    });

    it('дифф недоступен целиком — пустая строка, промпт остаётся валидным', () => {
        const ctx = reviewDiffContext('feature/x', {
            shFn: () => '',
            runArgvFn: () => {
                throw new Error('нет remote');
            },
            logFn: () => {},
        });
        expect(ctx).toBe('');
    });

    it('имя ветки уходит в git заквотированным (диф-чтение) и argv-элементом (fetch)', () => {
        const cmds: string[] = [];
        const argvCalls: Array<[string, string[]]> = [];
        reviewDiffContext('feature/x', {
            shFn: (c: string) => {
                cmds.push(c);
                return c.includes('--name-only') ? 'src/a.ts' : 'дифф';
            },
            runArgvFn: (file: string, args: string[]) => {
                argvCalls.push([file, args]);
                return '';
            },
            logFn: () => {},
        });
        expect(cmds.some((c) => c.includes(`'origin/main...origin/feature/x'`))).toBe(true);
        expect(argvCalls).toContainEqual([
            'git',
            ['fetch', 'origin', 'main', 'feature/x', '--quiet'],
        ]);
    });
});

// ── #135: проводка контекста диффа до промпта ревью ─────────────────────────
// Ревью PR #135 вскрыло дыру в покрытии: сам reviewDiffContext был протестирован,
// а вот факт, что его результат ДОХОДИТ до промпта, — нет. Удаление ${diffContext}
// из шаблона оставляло все тесты зелёными.

describe('runLoop → промпт ревью получает контекст диффа (#135)', () => {
    const { runLoop } = ralph;

    const mkState = () => ({
        count: 0,
        milestone: 'M1',
        submitted: false,
        noProgress: 0,
        gateHeals: 0,
        blockedHeals: 0,
    });
    const cfg = () => ({
        model: 'claude-coder',
        prompt: 'сделай {milestone} в ветке {branch}',
        authorAllowlist: ['owner'],
        phases: [{ milestone: 'M1', branch: 'feature/m1' }],
        review: { default: 'claude-reviewer', maxTurns: 80 },
        // #45: промпт правок по ревью берёт набор проверок из конфига гейта (раньше был
        // прошит список npm-скриптов чужого проекта) — без блока `gate` сдача честно
        // отказывает, как и сам гейт.
        gate: { checks: [['test', 'npm run test']] },
    });

    // Сдача фазы: issues кончились → PR → ревью → правки. Ловим все промпты.
    const runWithReview = (over = {}) => {
        const prompts: string[] = [];
        let idxCalls = 0;
        runLoop(
            cfg(),
            { state: mkState(), maxIterations: 10, maxTurns: 200 },
            {
                once: false,
                dry: false,
                logFn: () => {},
                shFn: () => '',
                saveStateFn: () => {},
                openIssuesFn: () => [],
                allOpenIssuesFn: () => [],
                // #39: задачи у фазы были и закрыты — иначе барьер «фаза не начата»
                // остановит петлю до шага ревью, который этот сьют и проверяет.
                hasAnyIssuesFn: () => true,
                phaseIndexOfFn: () => (idxCalls++ === 0 ? 0 : 99),
                pickModelFn: () => 'claude-picked',
                pickRuntimeFn: () => 'claude',
                // #46: шаг 1 сдачи — заведение PR петлёй; без заглушек он уходит в боевой шов.
                findOpenPrFn: () => null,
                createPrFn: () => 7,
                phasePrBodyFn: () => 'тело PR',
                pickReviewModelFn: () => 'claude-reviewer',
                runClaudeFn: (prompt: string) => {
                    prompts.push(prompt);
                    return 0;
                },
                ensureCleanFn: () => true,
                phaseMergedFn: () => false,
                advancePhaseFn: () => {},
                tryMergePhaseFn: () => 'not-merged',
                closeMilestoneByTitleFn: () => {},
                syncProjectBoardFn: () => {}, // #199: см. дефолт в общем deps выше
                getLastRedCheck: () => null,
                getLastGatePr: () => null,
                // #61: этот сьют собирает deps сам, мимо общего хелпера, — и без заглушки
                // звал НАСТОЯЩИЙ ensureMonitorAlive: прогон поднимал живой detached-монитор
                // (ppid=1, переживал тест-раннер) и писал monitor.out/monitor.pid в дерево.
                // Молчал, пока боевые дефолты startMonitor стояли без guardSideEffect.
                ensureMonitorAliveFn: () => null,
                phaseDiffFilesFn: () => ['src/a.ts'],
                reviewDiffContextFn: () => '\n\nМАРКЕР-КОНТЕКСТА-ДИФФА',
                // Проводка, страж после сессии и «ветка запушена» — побочки git; см. общий
                // deps выше.
                ensurePhaseBranchFn: () => ({
                    kind: 'switched' as const,
                    branch: 'feature/m1',
                    sha: 'a'.repeat(40),
                }),
                checkOnPhaseBranchFn: () => ({ ok: true, sha: 'a'.repeat(40) }),
                branchPushedFn: () => true,
                // #224: пуш раннера после сессии — настоящий git; пушить нечего.
                pushSessionCommitsFn: () => ({ kind: 'in-sync' as const }),
                // Намерения сессии — побочка по fs (общий deps выше делает то же).
                applySessionRequestsFn: () => ({ applied: 0, failed: false }),
                // #625: заглушки лестницы ревью правок — см. общий deps выше.
                branchHeadShaFn: () => 'a'.repeat(40),
                createIssueFn: () => 1,
                recordFixReviewFindingsFn: () => {},
                ...over,
            },
        );
        return prompts;
    };

    it('промпт ревью содержит контекст, отданный reviewDiffContext', () => {
        const reviewPrompt = runWithReview().find((p) => p.includes('code review'));
        expect(reviewPrompt).toBeDefined();
        expect(reviewPrompt).toContain('МАРКЕР-КОНТЕКСТА-ДИФФА');
    });

    it('дифф ФАЗЫ собирается ОДИН раз и переиспользуется выбором модели и контекстом', () => {
        // #625: считаем вызовы БЕЗ базы — это и есть дифф фазы. Дифф ПРАВОК (с base) —
        // другой предмет и законно собирается своим вызовом; смысл барьера #135 в том,
        // что один и тот же дифф не собирается дважды подряд.
        let phaseDiffCalls = 0;
        const seen: Record<string, unknown> = {};
        runWithReview({
            phaseDiffFilesFn: (_b: unknown, opts?: { base?: string }) => {
                if (!opts?.base) phaseDiffCalls++;
                return ['src/a.ts'];
            },
            pickReviewModelFn: (_m: unknown, _b: unknown, opts?: { files?: string[] }) => {
                seen.pick = opts?.files;
                return 'claude-reviewer';
            },
            reviewDiffContextFn: (_b: unknown, opts?: { files?: string[] }) => {
                seen.ctx = opts?.files;
                return '\n\nМАРКЕР-КОНТЕКСТА-ДИФФА';
            },
        });
        expect(phaseDiffCalls).toBe(1);
        expect(seen.pick).toEqual(['src/a.ts']);
        expect(seen.ctx).toEqual(['src/a.ts']);
    });

    it('пустой контекст не ломает промпт ревью', () => {
        const reviewPrompt = runWithReview({ reviewDiffContextFn: () => '' }).find((p) =>
            p.includes('code review'),
        );
        expect(reviewPrompt).toContain('Не мерджи PR');
    });
});

describe('safeBranch — argument injection через имя ветки (#135)', () => {
    const { safeBranch, phaseDiffFiles } = ralph;

    // Квотирование спасает от ИСПОЛНЕНИЯ, но не от argument injection:
    // '--upload-pack=…' остаётся отдельным словом, и git читает его как опцию.
    it.each([
        ['ведущий дефис', '-branch'],
        ['опция git', '--upload-pack=touch /tmp/pwned'],
        ['короткая опция', '-o'],
    ])('%s отвергается', (_name, branch) => {
        expect(safeBranch(branch, { logFn: () => {} })).toBe(false);
    });

    it.each([
        ['обычная ветка', 'feature/m1'],
        ['дефис внутри', 'chore/ralph-review-routing'],
        ['точки и подчёркивания', 'release/v1.2.3_rc'],
    ])('%s принимается', (_name, branch) => {
        expect(safeBranch(branch, { logFn: () => {} })).toBe(true);
    });

    it('ветка-опция не доходит до git', () => {
        const cmds: string[] = [];
        const files = phaseDiffFiles('--upload-pack=evil', {
            shFn: (c: string) => {
                cmds.push(c);
                return '';
            },
            logFn: () => {},
        });
        expect(files).toBe(null);
        expect(cmds).toEqual([]);
    });
});

describe('sliceWholeChars — обрезка не рубит суррогатную пару (#135)', () => {
    const { reviewDiffContext } = ralph;

    it('на границе лимита не остаётся половины эмодзи', () => {
        // 💥 = суррогатная пара: обрезка по символам ровно между ними даёт
        // невалидный код-юнит.
        const diff = 'a'.repeat(9) + '💥' + 'b'.repeat(100);
        const ctx = reviewDiffContext('feature/x', {
            shFn: (c: string) => (c.includes('--name-only') ? 'src/a.ts' : diff),
            runArgvFn: () => '',
            logFn: () => {},
            limit: 10,
        });
        const body = ctx.split('=====')[2];
        expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
        expect([...body].every((ch) => ch.codePointAt(0) !== 0xfffd)).toBe(true);
    });
});

// #199: синк доски после мерджа фазы. Скрипт (scripts/project-sync.mjs) fail-closed и
// краснеет на сомнительных данных — это его тесты. Здесь проверяется ровно обёртка:
// она обязана быть best-effort, потому что косметика доски не имеет права ронять уже
// смердженную фазу.
describe('closeMilestoneByTitle — закрытие milestone сразу после мерджа фазы (#252: argv)', () => {
    const { closeMilestoneByTitle } = ralph;

    it('находит открытый milestone по title и закрывает через argv', () => {
        const argvCalls: Array<[string, string[]]> = [];
        const logs: string[] = [];
        closeMilestoneByTitle('Фаза X', {
            forgeJsonFn: () => [{ number: 7, title: 'Фаза X' }],
            runArgvFn: (file: string, args: string[]) => argvCalls.push([file, args]),
            logFn: (m: string) => logs.push(m),
        });
        expect(argvCalls).toContainEqual([
            'gh',
            ['api', '-X', 'PATCH', 'repos/{owner}/{repo}/milestones/7', '-f', 'state=closed'],
        ]);
        expect(logs.join('\n')).toMatch(/Milestone закрыт: "Фаза X"/);
    });

    it('milestone не найден среди открытых → не мутирует', () => {
        const runArgvFn = vi.fn();
        closeMilestoneByTitle('Фаза Y', {
            forgeJsonFn: () => [{ number: 7, title: 'Фаза X' }],
            runArgvFn,
            logFn: () => {},
        });
        expect(runArgvFn).not.toHaveBeenCalled();
    });

    it('сбой чтения/мутации — fail-open, только лог', () => {
        const logs: string[] = [];
        expect(() =>
            closeMilestoneByTitle('Фаза X', {
                forgeJsonFn: () => {
                    throw new Error('gh boom');
                },
                logFn: (m: string) => logs.push(m),
            }),
        ).not.toThrow();
        expect(logs.join('\n')).toMatch(/свип подберёт/);
    });
});

describe('syncProjectBoard', () => {
    // #252: мутация — через argv (runArgvFn), не строкой через шелл.
    it('зовёт скрипт синка через argv и логирует последнюю строку его вывода', () => {
        const argvCalls: Array<[string, string[]]> = [];
        const logs: string[] = [];
        ralph.syncProjectBoard({
            runArgvFn: (file: string, args: string[]) => {
                argvCalls.push([file, args]);
                return 'шум\n✅ project-sync: доска в порядке\n';
            },
            logFn: (m: string) => logs.push(m),
        });
        expect(argvCalls).toEqual([['node', [REAL_CONFIG.consumerScriptsResolved.projectSync]]]);
        expect(logs[0]).toContain('доска в порядке');
    });

    it('путь синка не задан — шов ВЫКЛЮЧЕН вслух, а не тихо ничего не делает', () => {
        // Канон, задача 23: скрипт принадлежит потребителю, и «его нет» обязано читаться в
        // логе. Раньше путь был зашит строкой, вызов fail-open, и отсутствие файла выглядело
        // ровно как успешный синк — доска могла расходиться неделями.
        const logs: string[] = [];
        const argvCalls: string[][] = [];
        try {
            ralph.setConfigForTests({
                ...REAL_CONFIG,
                consumerScriptsResolved: { projectSync: null, reviewFindingsJournal: null },
            });
            ralph.syncProjectBoard({
                runArgvFn: (file: string, args: string[]) => {
                    argvCalls.push([file, ...args]);
                    return '';
                },
                logFn: (m: string) => logs.push(m),
            });
        } finally {
            ralph.setConfigForTests(REAL_CONFIG);
        }
        expect(argvCalls).toEqual([]);
        expect(logs.join('\n')).toMatch(/выключен/i);
        expect(logs.join('\n')).toContain('consumerScripts.projectSync');
    });

    it('не бросает, когда синк упал — фаза уже смерджена, ронять её нельзя', () => {
        const logs: string[] = [];
        expect(() =>
            ralph.syncProjectBoard({
                runArgvFn: () => {
                    throw new Error('HTTP 401\nвторая строка');
                },
                logFn: (m: string) => logs.push(m),
            }),
        ).not.toThrow();
        expect(logs[0]).toContain('HTTP 401');
        expect(logs[0]).not.toContain('вторая строка');
    });
});

// ── Контракт «оркестратор + тонкий entry» (#365) ──────────────────────────────────────
// Барьер от регрессии распила: вся логика петли живёт в orchestrator.ts (фабрика
// createOrchestrator, собирающая остальные модули), а ralph.js — только entry (проверка
// Node, парсинг CLI-флагов, запуск main(), ре-экспорт API). «Тонкость» entry и полнота
// API проверяются детерминированно, а не на слово (принцип «барьеры важнее промптов»).
// Здесь же зовём createOrchestrator НАПРЯМУЮ (не через ralph.js) — так проверяется сама
// сборка фабрики, а не только то, что она долетает до готового ralph.js.

import path from 'node:path';
import { createOrchestrator, pickLiveCandidate } from './orchestrator.ts';
import { stripComments } from '../tests/strip-comments.ts';
import { heldRun } from '../tests/guard-fake.ts';

// Платформенное: тест опирается на POSIX-механизмы, которых на Windows нет
// (/proc/<pid>/cmdline, пути соседнего worktree, /bin/sh). Раннер живёт на
// Linux-VPS, поэтому пометка, а не вторая реализация — грабля 7 в
// docs/ralph-runner/portability-log.md. Снять вместе с платформенным швом.
const itPosix = it.skipIf(process.platform === 'win32');

// Путь считается от каталога МОДУЛЯ (import.meta.dirname), как FIXTURE_CONFIG_PATH выше,
// а не от CWD. Ядро запускается и подмодулем в каноне, и каталогом `.claude/ralph` у
// потребителя: CWD в этих раскладках разный, положение entry относительно этого теста —
// одно и то же. От CWD путь молча указывал бы в никуда там, где раскладка другая.
const RALPH_JS = path.resolve(import.meta.dirname, '../ralph.js');

// Боевые флаги по умолчанию — как у vitest-процесса без CLI-флагов раннера.
const FLAGS_OFF = {
    once: false,
    dry: false,
    reset: false,
    resubmit: false,
    deployResolved: false,
    migrate: false,
    migrateRollback: false,
};

// Минимальные внешние JS-коллабораторы (мост из entry): фейки вместо
// telegram-notifier/gate-env, чтобы сборка фабрики не тянула сеть/env.
function buildRuntime(flags = FLAGS_OFF, argv = []) {
    return createOrchestrator({
        argv,
        flags,
        external: {
            sendTelegramMessage: () => false,
            telegramConfigFromEnv: () => ({ token: '', chatId: '' }),
            buildSanitizedGateEnv: () => ({}),
        },
    });
}

describe('createOrchestrator: API-поверхность', () => {
    // Поверхность module.exports ralph.js — контракт: на ней сидят тесты выше в этом
    // файле, модульные тест-файлы и monitor.js (resolveProfile/parseProfileFlag/
    // pushEvent/shq). Пропавший ключ = молча сломанный тест или монитор.
    const REQUIRED_API = [
        // config-слой
        'resolveProfile',
        'deepMerge',
        'parseProfileFlag',
        // монитор
        'startMonitor',
        'stopMonitor',
        'adoptMonitor',
        'processAlive',
        'cmdlineIncludes',
        'isMonitorProcess',
        'isRalphMonitorProcess',
        'listMonitorPids',
        'processPpid',
        'sweepOrphanMonitors',
        'ensureMonitorAlive',
        // #58: шов задач панели монитора — тот же, что у петли, без записи в ralph.log
        'observerTaskSource',
        // lock/state
        'isRalphProcess',
        'lockAlive',
        'writeLock',
        'removeLock',
        'releaseLockIfOurs',
        'acquireLock',
        'acquireRunnerLock',
        'loadState',
        'lockHash',
        'syncDepsIfLockChanged',
        // claude-сессия
        'buildClaudeArgs',
        'spawnClaude',
        'claudeSessionEnv',
        'runClaude',
        // примитивы исполнения (#138)
        'shq',
        'sh',
        'shArgv',
        'log',
        'sideEffectAttempts',
        // milestones/доска
        'closeMilestoneByTitle',
        'syncProjectBoard',
        // ревью
        'recordReviewFindings',
        'pickReviewModel',
        'pickReviewFallbackModel',
        'reviewModelRank',
        'strongerReviewModel',
        'removeBlockedLabel',
        'addBlockedLabel',
        'phaseDiffFiles',
        'reviewDiffContext',
        'globToRegExp',
        'matchRiskPaths',
        'sliceWholeChars',
        'formatExcerpt',
        // api-limit
        'apiLimitWaitMs',
        'apiLimitMessage',
        'minutesOrDefault',
        'positiveIntOrDefault',
        // туннель/пуши
        'tunnelHealthy',
        'ensureTunnel',
        'tunnelCheckEnabled',
        'pushEvent',
        'probeEgress',
        'restartTunnel',
        // worktree
        'resolveWorktreePath',
        'parseWorktreeList',
        'refreshRunnerWorktree',
        'runnerWorktreeReady',
        'ensureRunnerWorktree',
        // разводка лога + диагностика падения кодер-сессии (#386/#390)
        'chooseLogPath',
        'saveSessionOutput',
        'handleCrashedCoderSession',
        // барьер [ЧЕЛОВЕК]-issues (#410)
        'isHumanIssue',
        'excludeHumanIssues',
        // петля/гейт
        'preflight',
        'runLoop',
        'ensureClean',
        'parkOnOriginMain',
        'safeBranch',
        'gateChecksFor',
        'checksGreen',
        'findOpenPr',
        'tryMergePhase',
        'getLastRedCheck',
        'getVerifiedHead',
        'getLastGatePr',
        // деплой-проверка
        'deployPhasePlaceholder',
        'mergedShaOf',
        'deployWaitMessage',
        'waitForDeployRun',
        'probeHttpStatus',
        'checkProdHealth',
        'isWorkflowGreen',
        'classifyDeployOutcome',
        // entry-запуск
        'main',
    ];

    it('возвращает все ключи прежнего module.exports ralph.js (плюс main)', () => {
        const runtime = buildRuntime();
        const missing = REQUIRED_API.filter(
            (key) => (runtime as Record<string, unknown>)[key] === undefined,
        );
        expect(missing).toEqual([]);
    });

    it('сборка фабрики — чистая: не запускает петлю и не трогает процесс', () => {
        // Если бы сборка дёргала git/gh/claude, боевые дефолты упали бы guardSideEffect
        // (RALPH_NO_SIDE_EFFECTS=1) — общий afterEach сверяет журнал. Здесь достаточно,
        // что фабрика собралась и вернула функции, не бросив.
        const runtime = buildRuntime();
        expect(typeof runtime.main).toBe('function');
        expect(typeof runtime.runLoop).toBe('function');
    });

    it('ре-экспорт ralph.js отдаёт тот же контракт (import не запускает main)', async () => {
        // import сам по себе — проверка «main не запущен»: запуск main() из тестового
        // процесса упал бы на guardSideEffect/acquireLock или ушёл в process.exit.
        // @ts-expect-error — JS-entry раннера без деклараций типов (см. импорт в шапке).
        const ralphModule = await import('../ralph.js');
        const missing = REQUIRED_API.filter((key) => ralphModule.default[key] === undefined);
        expect(missing).toEqual([]);
    });
});

// #369 (фаза 5): ядро зависит от набора швов adapters.ts, собранного из текущих реализаций
// и выбираемого конфигом. Проверяем, что фабрика отдаёт полный набор (дефолтная сборка, до
// main()) и что сборка/резолв доступны на API-поверхности (для контрактного сьюта #370).
describe('createOrchestrator: набор швов адаптеров (#369)', () => {
    it('getAdapters отдаёт все пять швов сразу после сборки фабрики (дефолтный выбор)', () => {
        const runtime = buildRuntime();
        const adapters = runtime.getAdapters();
        expect(Object.keys(adapters).sort()).toEqual(
            ['coderRuntime', 'deployCheck', 'gate', 'notifier', 'taskSource'].sort(),
        );
        // Методы швов — функции (текущие реализации разложены по интерфейсам).
        expect(typeof adapters.taskSource.listReadyIssues).toBe('function');
        expect(typeof adapters.taskSource.mergePullRequest).toBe('function');
        expect(typeof adapters.gate.runChecks).toBe('function');
        expect(typeof adapters.notifier.notify).toBe('function');
        expect(typeof adapters.deployCheck.classifyOutcome).toBe('function');
        expect(typeof adapters.coderRuntime.run).toBe('function');
    });

    it('deployCheck.classifyOutcome — та же чистая классификация (GREEN только зелёный+здоровый)', () => {
        const { deployCheck } = buildRuntime().getAdapters();
        const green: DeployOutcome = {
            status: 'completed',
            conclusion: 'success',
            sha: 'b'.repeat(40),
            url: null,
            runId: 1,
        };
        expect(deployCheck.classifyOutcome(green, { ok: true, status: 200, url: 'u' }).red).toBe(
            false,
        );
        expect(deployCheck.classifyOutcome(green, { ok: false, status: 502, url: 'u' }).red).toBe(
            true,
        );
    });

    it('buildAdapters/resolveAdapterSelection на API-поверхности; неизвестная реализация → fail', () => {
        const runtime = buildRuntime();
        expect(typeof runtime.buildAdapters).toBe('function');
        expect(typeof runtime.resolveAdapterSelection).toBe('function');
        // resolveAdapterSelection fail-closed на неизвестном шве.
        expect(() =>
            runtime.resolveAdapterSelection({ nope: 'x' } as unknown as AdapterConfig, (m) => {
                throw new Error(m);
            }),
        ).toThrow();
    });
});

// #58: панель монитора спрашивает трекер через шов, выбранный ТЕМ ЖЕ config.adapters, что
// у петли. Иначе на площадке без CLI GitHub панель снова стала бы слепой — тихо, без отказа.
describe('observerTaskSource — шов задач для панели монитора (#58)', () => {
    const throwFail = (m: string): never => {
        throw new Error(m);
    };

    it('выбор реализации — по config.adapters, как у петли', () => {
        const runtime = buildRuntime();
        const sc = runtime.observerTaskSource({ taskSource: 'sourcecraft' }, throwFail);
        const gh = runtime.observerTaskSource(undefined, throwFail);
        // Реализации различимы по секрету, который каждая называет сама (#56).
        expect(sc.secretEnvNames()).not.toEqual(gh.secretEnvNames());
        expect(typeof sc.listAllOpenIssues).toBe('function');
        expect(typeof sc.findOpenPullRequest).toBe('function');
    });

    // #139: SourceCraft держит защищаемые пути правилом ревью (ship человека), GitHub — нет:
    // ruleset не требует одобрения по путям, и их держит гейт раннера.
    it('#139: кто держит защищаемые пути — SourceCraft да, GitHub нет', () => {
        const runtime = buildRuntime();
        expect(
            runtime.observerTaskSource({ taskSource: 'sourcecraft' }, throwFail)
                .reviewProtectsPaths,
        ).toBe(true);
        expect(runtime.observerTaskSource(undefined, throwFail).reviewProtectsPaths).toBe(false);
    });

    it('неизвестная реализация — отказ через failFn вызывающего, а не exit процесса', () => {
        const runtime = buildRuntime();
        expect(() => runtime.observerTaskSource({ taskSource: 'nope' }, throwFail)).toThrow(
            /taskSource/,
        );
    });
});

describe('createOrchestrator: флаги CLI', () => {
    it('dry: acquireRunnerLock не берёт лок вовсе (C1 read-only)', () => {
        const runtime = buildRuntime({ ...FLAGS_OFF, dry: true });
        let called = 0;
        // acquireLockFn не должен быть вызван: dry-прогон лок не проверяет и не пишет.
        const ok = runtime.acquireRunnerLock({
            acquireLockFn: () => {
                called++;
                return true;
            },
        });
        expect(ok).toBe(true);
        expect(called).toBe(0);
    });

    it('без dry: acquireRunnerLock зовёт acquireLock', () => {
        const runtime = buildRuntime();
        let called = 0;
        runtime.acquireRunnerLock({
            acquireLockFn: () => {
                called++;
                return true;
            },
        });
        expect(called).toBe(1);
    });

    // #252/C1 (ревью #365): сам git fetch — мутация remote-ссылок, а --dry-run строго
    // read-only. Живой --dry-run доходит до phaseDiffFiles (выбор ревью-модели), поэтому
    // фетч в нём пропускается; дифф всё же считается по имеющимся origin-ссылкам.
    it('dry: phaseDiffFiles не делает git fetch (C1 read-only)', () => {
        const runtime = buildRuntime({ ...FLAGS_OFF, dry: true });
        const runArgv = vi.fn(() => '');
        const shFn = vi.fn(() => '');
        runtime.phaseDiffFiles('feature/x', { runArgvFn: runArgv, shFn, logFn: () => {} });
        expect(runArgv).not.toHaveBeenCalled();
        expect(shFn).toHaveBeenCalled(); // дифф считается, фетч — нет
    });

    it('без dry: phaseDiffFiles фетчит перед диффом (свежие ссылки)', () => {
        const runtime = buildRuntime({ ...FLAGS_OFF, dry: false });
        const runArgv = vi.fn(() => '');
        runtime.phaseDiffFiles('feature/x', {
            runArgvFn: runArgv,
            shFn: () => '',
            logFn: () => {},
        });
        expect(runArgv).toHaveBeenCalledWith(
            'git',
            ['fetch', 'origin', 'main', 'feature/x', '--quiet'],
            {
                env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
                timeoutMs: util.GIT_NETWORK_TIMEOUT_MS,
            },
        );
    });
});

describe('ralph.js: тонкий entry (храповик распила #365)', () => {
    const source = fs.readFileSync(RALPH_JS, 'utf-8');

    it('entry короче 200 строк — монолит не возвращается', () => {
        // До распила ralph.js держал 2990 строк. Порог с запасом на комментарии:
        // рост выше — признак, что логика снова оседает в entry, а не в модулях.
        expect(source.split('\n').length).toBeLessThan(200);
    });

    it('в entry нет петли и гейта — только парсинг флагов и запуск', () => {
        // Маркеры монолитной логики, которых в тонком entry быть не должно.
        expect(source).not.toMatch(/while \(true\)/);
        expect(source).not.toMatch(/execSync|spawnSync\(/);
        expect(source).not.toMatch(/tryMergePhase|checksGreen|runLoop\s*\(/);
    });

    it('entry парсит все пять флагов режима и --profile', () => {
        for (const flag of ['--once', '--dry-run', '--reset', '--resubmit', '--deploy-resolved']) {
            expect(source).toContain(`'${flag}'`);
        }
        // --profile парсится в main() оркестратора из argv, entry обязан его передать.
        expect(source).toMatch(/argv/);
    });

    // Ревью #365: неизвестный флаг иначе молча игнорировался бы — опечатка (`--dryrun`,
    // кириллическая «у» в `--dry-run`) превратила бы намеренный read-only/HITL-запуск в
    // живой AFK-прогон. Allowlist срабатывает ДО main() (лок не берётся) — spawn безопасен.
    it('неизвестный флаг → entry падает с ненулевым кодом ДО старта петли', () => {
        const { spawnSync } = require('node:child_process');
        const res = spawnSync('node', [RALPH_JS, '--dryrun'], {
            encoding: 'utf-8',
            timeout: 15000,
        });
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/Неизвестный флаг "--dryrun"/);
    });
});

// ── #40: применение намерений кодер-сессии ───────────────────────────────────
// Сессия в трекер не ходит — пишет намерения в файл, применяет их петля через шов.
// Здесь проверяется ПРИМЕНЕНИЕ: порядок, отказы, что остаётся в файле после сбоя и
// строгая read-only в dry (C1). Сам разбор — session-requests.test.ts.

describe('applySessionRequests: намерения сессии применяет петля, а не сессия (#40)', () => {
    const CFG = { issueLabels: ['complexity:low', 'area:devops'] };

    // Фейк шва + журнал вызовов: важен и состав, и ПОРЯДОК (комментарий обязан лечь
    // до закрытия, иначе объяснение уедет в уже закрытую карточку).
    const fakeTaskSource = (over = {}) => {
        const calls: string[] = [];
        return {
            calls,
            ts: {
                commentOnIssue: (n: number, body: string) => calls.push(`comment:${n}:${body}`),
                closeIssue: (n: number) => calls.push(`close:${n}`),
                blockIssue: (n: number) => calls.push(`block:${n}`),
                createIssue: ({ title }: { title: string }) => {
                    calls.push(`create:${title}`);
                    return 77;
                },
                ...over,
            },
        };
    };

    const line = (o: unknown) => JSON.stringify(o);

    // #124: dry read-only (C1) — отвергнутый батч не переезжает в карантин и в dry.
    it('#124 dry: отвергнутый батч в карантин не снимается, файл оставлен как есть', () => {
        const quarantineFn = vi.fn(() => '/x');
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: true,
            readFn: () => line({ kind: 'close', issue: '7', comment: 'x' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: fakeTaskSource().ts,
            logFn: () => {},
            pushEventFn,
            quarantineFn,
        });
        expect(quarantineFn).not.toHaveBeenCalled();
        expect(res.failed).toBe(true);
        expect(res.rejected).toBeUndefined();
        expect(String(pushEventFn.mock.calls[0][0])).toContain('оставлен как есть');
    });

    // #603: предел на батч намерений теперь считается раздельно по классам (мутации vs
    // комментарии) — здесь проверяется ПРОВОДКА до пуша/лога, сами пределы и разбор — в
    // session-requests.test.ts.
    it('#603 батч мутаций сверх предела: не применилось, пуш несёт разбивку по классам', () => {
        const { ts, calls } = fakeTaskSource();
        const pushEventFn = vi.fn();
        const raw = Array.from({ length: 21 }, (_, i) =>
            line({ kind: 'close', issue: i + 1, comment: 'x' }),
        ).join('\n');
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => raw,
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(calls).toEqual([]);
        expect(res.failed).toBe(true);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/21 close/);
    });

    it('#603 30 pr-comment без мутаций — применяется, лог несёт заметку о размере', () => {
        const { ts, calls } = prTaskSource();
        const logFn = vi.fn();
        const raw = Array.from({ length: 30 }, (_, i) =>
            line({ kind: 'pr-comment', comment: `замечание ${String(i)}` }),
        ).join('\n');
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => raw,
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn,
            pushEventFn: () => {},
            sleepFn: () => {},
        });
        expect(res.failed).toBe(false);
        expect(res.applied).toBe(30);
        expect(calls).toHaveLength(30);
        expect(logFn.mock.calls.some((c) => /30 комментариев/.test(String(c[0])))).toBe(true);
    });

    // Ревью #612: от прежнего предела 20 для комментариев остался ТОЛЬКО лог — значит его
    // порог и надо сторожить с обеих сторон, иначе сигнал тихо потеряется при следующем
    // рефакторе applySessionRequests.
    const commentBatch = (n: number) =>
        Array.from({ length: n }, (_, i) =>
            line({ kind: 'pr-comment', comment: `замечание ${String(i)}` }),
        ).join('\n');

    const applyCommentBatch = (n: number) => {
        const { ts } = prTaskSource();
        const logFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => commentBatch(n),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn,
            pushEventFn: () => {},
            sleepFn: () => {},
        });
        const logged = logFn.mock.calls.map((c) => String(c[0])).join('\n');
        return { res, logged };
    };

    it('ревью #612: ровно на пороге (20 комментариев) заметка МОЛЧИТ', () => {
        const { res, logged } = applyCommentBatch(COMMENT_NOTICE_THRESHOLD);
        expect(res.applied).toBe(COMMENT_NOTICE_THRESHOLD);
        expect(logged).not.toMatch(/в батче намерений/);
    });

    it('ревью #612: на 21 комментарии заметка появляется и называет число', () => {
        const { res, logged } = applyCommentBatch(COMMENT_NOTICE_THRESHOLD + 1);
        expect(res.applied).toBe(COMMENT_NOTICE_THRESHOLD + 1);
        expect(logged).toMatch(
            new RegExp(`в батче намерений ${String(COMMENT_NOTICE_THRESHOLD + 1)}`),
        );
    });

    // Ревью #612: у GitHub на создание контента свой secondary rate limit (порядка 80
    // запросов в минуту) — крупный батч применяется с паузой, обычный идёт как раньше.
    it('ревью #612: крупный батч применяется с паузами между запросами форжа', () => {
        const { ts } = prTaskSource();
        const sleepFn = vi.fn();
        ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => commentBatch(25),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
            sleepFn,
        });
        // Пауза между запросами, а не перед первым: 25 намерений → 24 паузы.
        expect(sleepFn).toHaveBeenCalledTimes(24);
        expect(sleepFn.mock.calls.every((c) => c[0] === 1000)).toBe(true);
    });

    it('ревью #612: обычный батч (≤ порога) применяется БЕЗ пауз — поведение прежнее', () => {
        const { ts } = prTaskSource();
        const sleepFn = vi.fn();
        ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => commentBatch(COMMENT_NOTICE_THRESHOLD),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
            sleepFn,
        });
        expect(sleepFn).not.toHaveBeenCalled();
    });

    it('ревью #612: отказ форжа по rate limit назван в пуше прямо, а не сырой ошибкой', () => {
        const { ts } = prTaskSource({
            commentOnPullRequest: () => {
                throw new Error('gh: You have exceeded a secondary rate limit (HTTP 403)');
            },
        });
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => commentBatch(3),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
            sleepFn: () => {},
        });
        expect(res.failed).toBe(true);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/rate limit форжа/);
    });

    // #45: намерения ревью-сессии по PR. Фейк шва тот же, плюс PR ветки фазы и метки на нём.
    // #94: на диске после отказа ушедшего запроса — метка начатого и хвост за ней.
    const diskTail = (text: unknown) => {
        const lines = String(text).trim().split('\n');
        const marker = lines[0].startsWith(IN_FLIGHT_PREFIX) ? lines[0] : null;
        return { marker, requests: lines.slice(marker ? 1 : 0).map((l) => JSON.parse(l)) };
    };
    const unmark = (body: string): string =>
        body.replace(/\n\n<!-- ralph-intent:[A-Za-z0-9-]+ -->$/, '');
    const prTaskSource = (over: Record<string, unknown> = {}) => {
        const calls: string[] = [];
        const labels: Array<{ name: string }> = [];
        return {
            calls,
            labels,
            ts: {
                commentOnIssue: () => {},
                closeIssue: () => {},
                blockIssue: () => {},
                createIssue: () => 1,
                findOpenPullRequest: () => ({ number: 55, labels }),
                // #94: метка намерения в теле снимается при записи вызова — её форму и
                // наличие проверяют свои тесты, здесь важен текст замечания.
                commentOnPullRequest: (n: number, input: { body: string; anchor?: unknown }) =>
                    calls.push(
                        `pr-comment:${n}:${JSON.stringify(input.anchor ?? null)}:${unmark(input.body)}`,
                    ),
                addBlockedLabel: () => {
                    calls.push('pr-block-label');
                    labels.push({ name: 'blocked' });
                },
                ...over,
            },
        };
    };

    const PHASE = { branch: 'feature/m1' };

    // #625: лестница ревью правок решает по находкам ИМЕННО этого прохода, а не по ленте
    // комментариев PR (к третьему кругу она содержит все проходы разом). Отчёт о том, что
    // сессия предъявила, отдаёт применение намерений — единственное место, где проход виден
    // отдельно.
    describe('#625 отчёт о находках прохода', () => {
        it('pr-comment с якорем и без, плюс pr-block — всё видно вызывающему', () => {
            const { ts } = prTaskSource();
            const res = ralph.applySessionRequests({
                cfg: CFG,
                phase: PHASE,
                dry: false,
                readFn: () =>
                    [
                        line({
                            kind: 'pr-comment',
                            comment: '🔴 [blocker] раз',
                            path: 'src/a.ts',
                            line: 7,
                        }),
                        line({ kind: 'pr-comment', comment: 'сводка прохода' }),
                        line({ kind: 'pr-block', comment: 'чем блокируется' }),
                    ].join('\n'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => false,
            });
            expect(res.prBlocked).toBe(true);
            expect(res.prFindings).toEqual([
                { comment: '🔴 [blocker] раз', anchor: { path: 'src/a.ts', line: 7 } },
                { comment: 'сводка прохода', anchor: undefined },
            ]);
        });

        it('намерений по PR не было — пустой отчёт, а не «унаследованный» от соседа', () => {
            const { ts } = prTaskSource();
            const res = ralph.applySessionRequests({
                cfg: CFG,
                phase: PHASE,
                dry: false,
                readFn: () => line({ kind: 'comment', issue: 5, comment: 'что выяснилось' }),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => false,
            });
            expect(res.prFindings).toEqual([]);
            expect(res.prBlocked).toBe(false);
        });

        it('форж отказал в доставке — замечание всё равно в отчёте: оно от этого не исчезло', () => {
            const { ts } = prTaskSource({
                commentOnPullRequest: () => {
                    throw new Error('rate limit');
                },
            });
            const res = ralph.applySessionRequests({
                cfg: CFG,
                phase: PHASE,
                dry: false,
                readFn: () =>
                    line({
                        kind: 'pr-comment',
                        comment: '🟠 [major] раз',
                        path: 'src/a.ts',
                        line: 1,
                    }),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => false,
            });
            expect(res.failed).toBe(true);
            expect(res.prFindings).toHaveLength(1);
        });
    });

    it('#45 pr-comment: якорь доезжает, номер PR резолвит петля — сессия его не называет', () => {
        const { ts, calls } = prTaskSource();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({
                    kind: 'pr-comment',
                    comment: '🔴 [blocker] тут',
                    path: 'src/a.ts',
                    line: 42,
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(calls).toEqual(['pr-comment:55:{"path":"src/a.ts","line":42}:🔴 [blocker] тут']);
        expect(res.applied).toBe(1);
    });

    // #87: метка — ПЕРВОЙ, до комментария: убитый между ними раннер не должен оставить
    // человеку развилку, на которой метка теряется (tests/pr-crash-windows.test.ts).
    it('#45 pr-block: метка, СВЕРКА, что она встала, затем комментарий с причиной', () => {
        const { ts, calls } = prTaskSource();
        ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => line({ kind: 'pr-block', comment: 'сборка красная' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(calls).toEqual(['pr-block-label', 'pr-comment:55:null:сборка красная']);
    });

    it('#45 НЕГАТИВНЫЙ: метка blocked не встала → отказ, а не тихий пропуск', () => {
        // Сам addBlockedLabel fail-open по контракту (метки — косметика цикла разбора), но
        // здесь метка несёт вердикт ревью: не легла — гейт не увидит блокера и смерджит
        // фазу с известным дефектом.
        const { ts } = prTaskSource({ addBlockedLabel: () => {} });
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => line({ kind: 'pr-block', comment: 'сборка красная' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(res.failed).toBe(true);
        expect(pushEventFn.mock.calls[0][0]).toMatch(/метка blocked/i);
    });

    // #226: хвост `pr-comment` от сдачи прошлой фазы держал в заложниках `close` карточки
    // нового цикла — «Применено 0 из 4», и петля взяла бы ту же карточку повторно. PR,
    // которого петля не знает, не появится и при повторе: строка выбывает, остальное идёт.
    it('#226 от противного: pr-comment вне цикла сдачи выбывает строкой, close карточки ложится', () => {
        const { ts, calls } = prTaskSource({
            closeIssue: (n: number) => calls.push(`close:${n}`),
        });
        const written: string[] = [];
        const logs: string[] = [];
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'pr-comment', comment: 'замечание к смердженному PR' }),
                    line({ kind: 'pr-comment', comment: 'сводка', path: 'src/a.ts', line: 3 }),
                    line({ kind: 'comment', issue: 7, comment: 'отчёт' }),
                    line({ kind: 'close', issue: 7, comment: 'сделано' }),
                ].join('\n'),
            writeFn: (text: string) => written.push(text),
            removeFn: () => {},
            taskSource: ts,
            logFn: (m: string) => logs.push(m),
            pushEventFn,
            orphanPrFn: () => 42,
        });
        expect(res.failed).toBe(false);
        expect(res.closedIssues).toEqual([7]);
        expect(res.applied).toBe(2);
        // В PR не ушло ничего: петля в PR, которого не знает, не пишет.
        expect(calls).toEqual(['close:7']);
        // Строка ушла из файла: последняя запись остатка — пустая.
        expect(written[written.length - 1].trim()).toBe('');
        const text = logs.join('\n');
        // Каждая выбывшая — строкой лога с причиной и самой строкой намерения.
        expect(text).toMatch(
            /pr-comment \(сводка\) отброшено: .*вне цикла сдачи.*замечание к смердженному PR/,
        );
        expect(text).toMatch(/pr-comment src\/a\.ts:3 отброшено/);
        // Сводка называет число и PR.
        expect(text).toMatch(/Отброшено PR-намерений вне цикла сдачи: 2 \(PR #42\)/);
        // Комментарии без блока — без пуша: у них нет решения о мердже.
        expect(pushEventFn).not.toHaveBeenCalled();
    });

    it('#226 номер PR не определился → сводка говорит это, а не молчит', () => {
        const { ts } = prTaskSource();
        const logs: string[] = [];
        ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => line({ kind: 'pr-comment', comment: 'замечание' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: (m: string) => logs.push(m),
            pushEventFn: () => {},
            orphanPrFn: () => {
                throw new Error('форж молчит');
            },
        });
        const text = logs.join('\n');
        expect(text).toMatch(/Номер PR отброшенных намерений не определился: форж молчит/);
        expect(text).toMatch(/Отброшено PR-намерений вне цикла сдачи: 1 \(PR не определён\)/);
    });

    // #226: блок означал «не мерджить» — его потеря не может быть строкой в логе.
    it('#226 pr-block вне цикла сдачи не пропадает молча: пуш с причиной и текстом блока', () => {
        const { ts, calls } = prTaskSource();
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => line({ kind: 'pr-block', comment: 'сборка красная' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
            orphanPrFn: () => 42,
        });
        expect(calls).toEqual([]);
        expect(res.applied).toBe(0);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const msg = String(pushEventFn.mock.calls[0][0]);
        expect(msg).toMatch(/^⛔/);
        expect(msg).toMatch(/pr-block.*вне цикла сдачи.*PR #42/);
        expect(msg).toMatch(/не мерджить/);
        expect(msg).toMatch(/сборка красная/);
    });

    it('#226 длинный pr-block в уведомлении — первой строкой с обрезкой, целиком — в логе', () => {
        const { ts } = prTaskSource();
        const pushEventFn = vi.fn();
        const logs: string[] = [];
        const long = `заголовок блока ${'х'.repeat(1000)}\nвторая строка тела`;
        ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => line({ kind: 'pr-block', comment: long }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: (m: string) => void logs.push(m),
            pushEventFn,
            orphanPrFn: () => 42,
        });
        const msg = String(pushEventFn.mock.calls[0][0]);
        expect(msg).toContain('заголовок блока');
        expect(msg).toMatch(/…$/);
        expect(msg).not.toContain('вторая строка тела');
        expect(msg.length).toBeLessThan(600);
        expect(logs.join('\n')).toContain('вторая строка тела');
    });

    it('#45 НЕГАТИВНЫЙ: открытого PR фазы нет → отказ, замечание не теряется молча', () => {
        const { ts } = prTaskSource({ findOpenPullRequest: () => null });
        const written: string[] = [];
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => line({ kind: 'pr-comment', comment: 'замечание' }),
            writeFn: (text: string) => written.push(text),
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(true);
        // Хвост сохранён: неприменённое замечание ревью повторится, а не исчезнет.
        expect(written.join('')).toMatch(/pr-comment/);
    });

    // #64: форж отвергает inline-комментарий на строку ВНЕ диффа PR (GitHub — 422
    // Validation Failed). Для ревью это штатный случай: «комментарий рядом протух» —
    // замечание к строке, которую PR не трогал. Поймано на полигоне: один такой `nit`
    // остановил весь цикл сдачи, и повторялось это детерминированно, потому что каждое
    // новое ревью якорь генерировало заново.
    it('#64 якорь форж не принял → замечание ложится сводкой, сдача продолжается', () => {
        const { ts, calls } = prTaskSource({
            commentOnPullRequest: (n: number, input: { body: string; anchor?: unknown }) => {
                if (input.anchor) throw new Error('gh: Validation Failed (HTTP 422)');
                calls.push(`pr-comment:${n}:null:${unmark(input.body)}`);
            },
        });
        const logFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({
                    kind: 'pr-comment',
                    comment: '⚪ [nit] протух',
                    path: 'e2e/a.spec.ts',
                    line: 119,
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn,
            pushEventFn: () => {},
        });
        // Замечание НЕ потеряно: место переехало в текст, раз якорем его не выразить.
        // ХВОСТОМ, а не префиксом: метка severity обязана остаться первым символом тела —
        // иначе review-findings.mjs считает находку unmarked (см. докблок ступеней).
        expect(calls).toEqual(['pr-comment:55:null:⚪ [nit] протух\n\n— место: e2e/a.spec.ts:119']);
        expect(res.failed).toBe(false);
        expect(res.applied).toBe(1);
        // Деградация громкая: молча подменённый способ доставки — «тихий дефолт».
        // Место в логе — не украшение: человек читает пуш и должен понять, к какой строке
        // относилось замечание, раз якорем этого больше не выразить.
        const logged = logFn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/якор/i);
        expect(logged).toContain('e2e/a.spec.ts:119');
    });

    it('#64 НЕГАТИВНЫЙ: сводка тоже не легла → fail-closed, как прежде', () => {
        const { ts } = prTaskSource({
            commentOnPullRequest: () => {
                throw new Error('форж недоступен');
            },
        });
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({ kind: 'pr-comment', comment: 'замечание', path: 'src/a.ts', line: 4 }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(true);
    });

    // #575: между инлайном и сводкой есть ступень, которой не было. GitHub отвергает
    // якорь строки, если строка вне изменённых ХАНКОВ, — а замечания о ПРОПУЩЕННОМ
    // («тут забыли погасить флаг», «комментарий рядом протух») по природе своей целятся
    // в неизменённый код. Файл при этом в диффе есть, и место сохранимо комментарием
    // уровня файла. Наблюдалось на PR #574: два замечания подряд ушли в сводку.
    it('#575 строка вне ханка, файл в диффе → комментарий ФАЙЛА, а не сводка', () => {
        const { ts, calls } = prTaskSource({
            commentOnPullRequest: (
                n: number,
                input: { body: string; anchor?: { path: string; line?: number } },
            ) => {
                // Форж отвергает ровно якорь СТРОКИ (422), файловый принимает.
                if (typeof input.anchor?.line === 'number') {
                    throw new Error('gh: Validation Failed (HTTP 422)');
                }
                calls.push(
                    `pr-comment:${String(n)}:${input.anchor ? `file:${input.anchor.path}` : 'null'}:${unmark(input.body)}`,
                );
            },
        });
        const logFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({
                    kind: 'pr-comment',
                    comment: '⚪ [nit] комментарий устарел после этого PR',
                    path: 'src/shared/config/hud.ts',
                    line: 5,
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn,
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(false);
        // Привязка к месту сохранена: комментарий уровня файла, строка — в тексте.
        // Метка severity осталась ПЕРВЫМ символом тела (иначе находка уходит в unmarked
        // журнала #168/#169), место — хвостом.
        expect(calls).toEqual([
            'pr-comment:55:file:src/shared/config/hud.ts:' +
                '⚪ [nit] комментарий устарел после этого PR\n\n— место: src/shared/config/hud.ts:5',
        ]);
        const logged = logFn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/комментарием файла/i);
        // Ступени различимы в логе: это НЕ «файла нет в диффе».
        expect(logged).not.toMatch(/сводк/i);
    });

    // #575-ревью: ступень 2 пробуется на ЛЮБОЙ отказ ступени 1, а 422 «строка вне ханка» от
    // «форж лёг» ядро не отличает. Значит и лог не имеет права выдавать диагноз за факт:
    // печатать «строка вне изменённых ханков» при упавшем gh — ровно тот дефект (человек
    // читает неверную причину), который #575 чинит.
    it('#575 отказ ступени 1 НЕ по 422 (форж недоступен) → лог не выдумывает причину', () => {
        const { ts, calls } = prTaskSource({
            commentOnPullRequest: (n: number, input: { body: string; anchor?: unknown }) => {
                // Ни строка, ни файл: голова PR недоступна, оба якорных вызова падают
                // с одной и той же сетевой ошибкой.
                if (input.anchor) throw new Error('gh: could not resolve head sha (timeout)');
                calls.push(`pr-comment:${String(n)}:null:${unmark(input.body)}`);
            },
        });
        const logFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({
                    kind: 'pr-comment',
                    comment: '🟡 [minor] тут гонка',
                    path: 'src/a.ts',
                    line: 7,
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn,
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(false);
        const logged = logFn.mock.calls.map((c) => String(c[0])).join('\n');
        // Наблюдаемое — есть: обе ступени и сообщения форжа как есть.
        expect(logged).toContain('src/a.ts:7');
        expect(logged).toContain('could not resolve head sha (timeout)');
        // Диагноза, которого никто не проверял, — нет.
        expect(logged).not.toMatch(/вне изменённых ханков/i);
        expect(logged).not.toMatch(/нет в диффе/i);
    });

    // #575, ступень 3: дно отката не сдвинулось. Файла в диффе нет вовсе — форж отвергает
    // и файловый якорь, и замечание по-прежнему ложится сводкой.
    it('#575 файловый якорь тоже не прошёл → сводка, и в логе обе ступени с их ошибками', () => {
        const { ts, calls } = prTaskSource({
            commentOnPullRequest: (n: number, input: { body: string; anchor?: unknown }) => {
                if (input.anchor) throw new Error('gh: Validation Failed (HTTP 422)');
                calls.push(`pr-comment:${String(n)}:null:${unmark(input.body)}`);
            },
        });
        const logFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({
                    kind: 'pr-comment',
                    comment: '⚪ [nit] протух',
                    path: 'e2e/a.spec.ts',
                    line: 119,
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn,
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(false);
        expect(calls).toEqual(['pr-comment:55:null:⚪ [nit] протух\n\n— место: e2e/a.spec.ts:119']);
        const logged = logFn.mock.calls.map((c) => String(c[0])).join('\n');
        // Обе ступени названы наблюдаемо, с сообщением форжа — и ступень 3 отличима
        // от ступени 2 тем, что замечание легло СВОДКОЙ.
        expect(logged).toMatch(/инлайн-якорь/i);
        expect(logged).toMatch(/комментарий файла/i);
        expect(logged).toContain('HTTP 422');
        expect(logged).toMatch(/сводк/i);
    });

    // Деградация — только для замечаний. `pr-block` несёт ВЕРДИКТ ревью: не легло —
    // мерджить нельзя, и петля обязана встать (иначе фаза уедет в main с дефектом).
    it('#64 отказ по pr-block по-прежнему останавливает сдачу', () => {
        const { ts } = prTaskSource({
            commentOnPullRequest: () => {
                throw new Error('gh: Validation Failed (HTTP 422)');
            },
        });
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () => line({ kind: 'pr-block', comment: 'красный e2e' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(true);
    });

    // #64, вторая часть: хвост сохранялся `JSON.stringify` уже НОРМАЛИЗОВАННОГО намерения
    // (`anchor: {path, line}`), а парсер читает ПЛОСКИЕ `path`/`line`. При повторе якорь
    // молча терялся — замечание к строке становилось сводкой.
    it('#64 хвост сериализуется в форме, которую читает свой же парсер', () => {
        const { ts } = prTaskSource({
            commentOnPullRequest: () => {
                throw new Error('форж недоступен');
            },
        });
        const written: string[] = [];
        ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({ kind: 'pr-comment', comment: 'замечание', path: 'src/a.ts', line: 42 }),
            writeFn: (text: string) => written.push(text),
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        // Последняя запись — то, что осталось на диске: запрос к форжу ушёл, поэтому
        // метка начатого остаётся первой строкой (#94), за ней — хвост.
        const { marker, requests } = diskTail(written.at(-1));
        expect(marker).not.toBeNull();
        const tail = requests[0];
        expect(tail).toMatchObject({ kind: 'pr-comment', path: 'src/a.ts', line: 42 });
        expect(tail.anchor).toBeUndefined();
    });

    it('файла нет — тишина: ни вызовов шва, ни пуша', () => {
        const { ts, calls } = fakeTaskSource();
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => null,
            writeFn: () => {
                throw new Error('писать нечего');
            },
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(calls).toEqual([]);
        expect(pushEventFn).not.toHaveBeenCalled();
        expect(res.applied).toBe(0);
    });

    it('комментарий и закрытие применяются по порядку, файл удаляется', () => {
        const { ts, calls } = fakeTaskSource();
        const written: string[] = [];
        let removed = 0;
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'comment', issue: 7, comment: 'сделано: A и Б' }),
                    line({ kind: 'close', issue: 7, comment: 'сделано: A и Б' }),
                ].join('\n'),
            writeFn: (text: string) => written.push(text),
            removeFn: () => {
                removed += 1;
            },
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(calls).toEqual(['comment:7:сделано: A и Б', 'comment:7:сделано: A и Б', 'close:7']);
        expect(res.applied).toBe(2);
        // #62: файл УДАЛЯЕТСЯ, а не опустошается. Пустой остаток — untracked-файл в дереве
        // раннера, и он валит следующий запуск проверкой чистоты, а однажды остановил и
        // сам гейт мерджа. `.gitignore` этот класс не закрывает: ветка фазы отрезана ДО
        // правки игнор-листа, и в её дереве строки ещё нет. Записи до удаления — журнал
        // «начато / применено» (#86); последняя из них снимает всё применённое.
        expect(written.at(-1)?.trim()).toBe('');
        expect(removed).toBe(1);
    });

    // #65: форж отдаёт списки issue с задержкой. Петля закрывает карточку намерением,
    // через секунды читает очередь — и видит её открытой. Собственное действие надёжнее
    // чужого списка, поэтому applySessionRequests сообщает, кого закрыл.
    it('#65 возвращает номера карточек, закрытых в этом батче', () => {
        const { ts } = fakeTaskSource();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'close', issue: 7, comment: 'что сделано' }),
                    line({ kind: 'close', issue: 9, comment: 'и эта тоже' }),
                    line({ kind: 'block', issue: 11, comment: 'нужен человек' }),
                ].join('\n'),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        // Только close: заблокированная карточка остаётся в очереди намеренно —
        // «очередь пуста» ≠ «фаза готова» (C2), blocked её не покидает.
        expect(res.closedIssues).toEqual([7, 9]);
    });

    it('#65 dry-run ничего не закрывает и списка не даёт', () => {
        const { ts } = fakeTaskSource();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: true,
            readFn: () => line({ kind: 'close', issue: 7, comment: 'сделано' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(res.closedIssues).toEqual([]);
    });

    it('#62 на сбое файл НЕ удаляется — в нём остаётся неприменённый хвост', () => {
        const { ts } = fakeTaskSource({
            closeIssue: () => {
                throw new Error('форж недоступен');
            },
        });
        const written: string[] = [];
        let removed = 0;
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'comment', issue: 7, comment: 'что выяснилось' }),
                    line({ kind: 'close', issue: 7, comment: 'что сделано' }),
                ].join('\n'),
            writeFn: (text: string) => written.push(text),
            removeFn: () => {
                removed += 1;
            },
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(true);
        expect(removed).toBe(0);
        expect(written.join('')).toMatch(/"kind":"close"/);
    });

    it('blocked: метка на карточке и комментарий, что нужно от человека', () => {
        const { ts, calls } = fakeTaskSource();
        ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => line({ kind: 'block', issue: 9, comment: 'нужен npm install руками' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(calls).toEqual(['comment:9:нужен npm install руками', 'block:9']);
    });

    it('новая карточка заводится с именами меток, номер уходит в лог', () => {
        const { ts, calls } = fakeTaskSource();
        const logs: string[] = [];
        ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                line({
                    kind: 'new-issue',
                    title: 'Течёт лимит',
                    body: 'симптом',
                    labels: ['complexity:low', 'area:devops'],
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: (m: string) => logs.push(m),
            pushEventFn: () => {},
        });
        expect(calls).toEqual(['create:Течёт лимит']);
        expect(logs.join('\n')).toMatch(/#77/);
    });

    // Фаза 10: формат из конфига доходит до разбора — без проводки правило жило бы только
    // в юните парсера, а боевое применение заводило бы карточку мимо него.
    it('НЕГАТИВНЫЙ: new-issue не по issueFormat — не заведена, причина в пуше', () => {
        const { ts, calls } = fakeTaskSource();
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: { ...CFG, issueFormat: { sections: [{ heading: 'Критерии готовности' }] } },
            dry: false,
            readFn: () =>
                line({
                    kind: 'new-issue',
                    title: 'Течёт лимит',
                    body: 'симптом',
                    labels: ['complexity:low'],
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(calls).toEqual([]);
        expect(res.failed).toBe(true);
        expect(String(pushEventFn.mock.calls[0][0])).toMatch(/нет раздела «Критерии готовности»/);
    });

    it('НЕГАТИВНЫЙ: битый запрос — ничего не применено, пуш, файл НЕ тронут', () => {
        const { ts, calls } = fakeTaskSource();
        const pushEventFn = vi.fn();
        const written: string[] = [];
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'close', issue: 7, comment: 'сделано' }),
                    line({ kind: 'merge', issue: 7 }),
                ].join('\n'),
            writeFn: (t: string) => written.push(t),
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(calls).toEqual([]);
        expect(written).toEqual([]); // разбирать битый файл будет человек — не стираем
        expect(res.failed).toBe(true);
        expect(pushEventFn).toHaveBeenCalledTimes(1);
    });

    it('НЕГАТИВНЫЙ: сбой на втором намерении — первое применено, в файле остаётся хвост', () => {
        const { ts, calls } = fakeTaskSource({
            closeIssue: () => {
                throw new Error('форж отверг закрытие');
            },
        });
        const pushEventFn = vi.fn();
        const written: string[] = [];
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'comment', issue: 7, comment: 'первое' }),
                    line({ kind: 'close', issue: 7, comment: 'второе' }),
                    line({ kind: 'comment', issue: 8, comment: 'третье' }),
                ].join('\n'),
            writeFn: (t: string) => written.push(t),
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(calls).toEqual(['comment:7:первое', 'comment:7:второе']);
        expect(res.failed).toBe(true);
        // В файле — ровно неприменённый хвост: повтор всего батча продублировал бы
        // уже поставленный комментарий, а пустой файл потерял бы остаток. Последняя
        // запись — то, что осталось на диске; до неё шёл журнал «начато / применено» (#86).
        // Закрытие бросило ПОСЛЕ комментария, который вернулся в этом же процессе: он
        // лёг точно, а статус идемпотентен. Это не неизвестный исход и не стоп (#94), а
        // метка с `landed: comment` — повтор доведёт только закрытие.
        const { marker, requests } = diskTail(written.at(-1));
        expect(JSON.parse(String(marker))).toMatchObject({ landed: 'comment' });
        expect(requests.map((r: { kind: string }) => r.kind)).toEqual(['close', 'comment']);
        expect(res.outcomeUnknown).toBeUndefined();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(pushEventFn.mock.calls[0][0]).toMatch(
            /^⚠ Ralph: .*легло частично.*форж отверг закрытие/s,
        );

        // Повтор: комментарий не задваивается, доводится только статус — без сверки.
        const second = fakeTaskSource();
        const res2 = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => String(written.at(-1)),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: second.ts,
            logFn: () => {},
            pushEventFn: vi.fn(),
        });
        expect(second.calls).toEqual(['close:7', 'comment:8:третье']);
        expect(res2.failed).toBe(false);
    });

    it('#94 пометка landed не записалась — пуш не обещает сверку, которой у шва нет', () => {
        const { ts } = fakeTaskSource({
            closeIssue: () => {
                throw new Error('форж отверг закрытие');
            },
        });
        const pushEventFn = vi.fn();
        ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => line({ kind: 'close', issue: 7, comment: 'готово' }),
            writeFn: (t: string) => {
                if (t.includes('"landed"')) throw new Error('ENOSPC');
            },
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const text = String(pushEventFn.mock.calls[0][0]);
        expect(text).toMatch(/НЕ УДАЛОСЬ \(ENOSPC\)/);
        expect(text).not.toMatch(/повтор сверит её с форжем/);
        expect(text).toMatch(/шов форжа не умеет читать комментарии карточки.*стопом/s);
    });

    it('#94 отказ до соединения — запрос не ушёл: голый хвост, без метки и без стопа', () => {
        const { ts } = fakeTaskSource({
            commentOnIssue: () => {
                throw Object.assign(new Error('Command failed: gh issue comment 7 --body x'), {
                    stderr: 'error connecting to api.github.com\ndial tcp: lookup api.github.com: no such host',
                });
            },
        });
        const written: string[] = [];
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => line({ kind: 'close', issue: 7, comment: 'готово' }),
            writeFn: (t: string) => written.push(t),
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(res.failed).toBe(true);
        expect(res.outcomeUnknown).toBeUndefined();
        const { marker, requests } = diskTail(written.at(-1));
        expect(marker).toBeNull();
        expect(requests.map((r: { kind: string }) => r.kind)).toEqual(['close']);
        expect(String(pushEventFn.mock.calls[0][0])).toMatch(/Остаток сохранён/);
    });

    it('#41 close: комментарий лёг, закрытие отвергнуто по существу — выбыло «частично»', () => {
        const { ts } = fakeTaskSource({
            closeIssue: () => {
                throw new Error('gh: Resource not accessible by integration (HTTP 403)');
            },
        });
        const pushEventFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => line({ kind: 'close', issue: 7, comment: 'готово' }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(res.dropped?.[0]).toMatchObject({ kind: 'close' });
        expect(res.dropped?.[0].what).toMatch(/лёг частично: комментарий есть, статус отвергнут/);
        expect(String(pushEventFn.mock.calls[0][0])).toMatch(/лёг частично/);
    });

    // #41: отказ по существу (карточка удалена, прав нет) повтор не лечит — одно такое
    // намерение раньше загораживало собой весь хвост батча на каждой итерации.
    it('#41 детерминированный отказ одного намерения — остальные применены, причина в логе', () => {
        const { ts, calls } = fakeTaskSource({
            commentOnIssue: (n: number, body: string) => {
                if (n === 8)
                    throw new Error(
                        'gh: Could not resolve to an issue or pull request with the number of 8. (HTTP 404)',
                    );
                calls.push(`comment:${n}:${body}`);
            },
        });
        const logFn = vi.fn();
        const pushEventFn = vi.fn();
        const written: string[] = [];
        const removeFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'comment', issue: 7, comment: 'первое' }),
                    line({ kind: 'comment', issue: 8, comment: 'удалённой карточке' }),
                    line({ kind: 'close', issue: 9, comment: 'третье' }),
                ].join('\n'),
            writeFn: (t: string) => written.push(t),
            removeFn,
            taskSource: ts,
            logFn,
            pushEventFn,
        });
        expect(calls).toEqual(['comment:7:первое', 'comment:9:третье', 'close:9']);
        expect(res.failed).toBe(false);
        expect(res.applied).toBe(2);
        expect(res.closedIssues).toEqual([9]);
        expect(res.dropped).toHaveLength(1);
        expect(res.dropped?.[0]).toMatchObject({
            kind: 'comment',
            what: expect.stringMatching(/comment #8/),
        });
        const logged = logFn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toMatch(/comment #8 выбыло.*HTTP 404/);
        // Выбывшее не повторится: после него в файле только хвост без него, а в конце
        // файл снят целиком.
        expect(String(written.at(-1))).not.toMatch(/удалённой карточке/);
        expect(removeFn).toHaveBeenCalledTimes(1);
        // Невыполненное намерение — пушем, а не только строкой лога.
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        expect(String(pushEventFn.mock.calls[0][0])).toMatch(/1 из 3 .*выбыли/s);
    });

    it('#41 транзиентный отказ — хвост сохранён, как раньше', () => {
        const { ts, calls } = fakeTaskSource({
            commentOnIssue: (n: number, body: string) => {
                if (n === 8) throw new Error('gh: Bad Gateway (HTTP 502)');
                calls.push(`comment:${n}:${body}`);
            },
        });
        const pushEventFn = vi.fn();
        const written: string[] = [];
        const removeFn = vi.fn();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'comment', issue: 7, comment: 'первое' }),
                    line({ kind: 'comment', issue: 8, comment: 'второе' }),
                    line({ kind: 'close', issue: 9, comment: 'третье' }),
                ].join('\n'),
            writeFn: (t: string) => written.push(t),
            removeFn,
            taskSource: ts,
            logFn: () => {},
            pushEventFn,
        });
        expect(calls).toEqual(['comment:7:первое']);
        expect(res.failed).toBe(true);
        expect(res.applied).toBe(1);
        // #94: хвост сохранён ПОД МЕТКОЙ — 502 пришёл на ушедший запрос, и комментарий
        // мог лечь. Ленты карточки фейк не читает — неизвестный исход, стоп с причиной.
        const { marker, requests } = diskTail(written.at(-1));
        expect(marker).not.toBeNull();
        expect(requests.map((r: { issue: number }) => r.issue)).toEqual([8, 9]);
        expect(res.outcomeUnknown).toBe(true);
        expect(removeFn).not.toHaveBeenCalled();
    });

    it('#41 pr-block не выбывает и на отказе по существу — метка решает о мердже', () => {
        const { ts } = prTaskSource({
            addBlockedLabel: () => {
                throw new Error('gh: Resource not accessible by integration (HTTP 403)');
            },
        });
        const written: string[] = [];
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                [
                    line({ kind: 'pr-block', comment: 'блокер' }),
                    line({ kind: 'pr-comment', comment: 'сводка' }),
                ].join('\n'),
            writeFn: (t: string) => written.push(t),
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(true);
        expect(res.dropped ?? []).toEqual([]);
        // Лента PR сверяема — метка остаётся, стопа нет: повтор пройдёт через сверку.
        const { marker, requests } = diskTail(written.at(-1));
        expect(marker).not.toBeNull();
        expect(res.outcomeUnknown).toBeUndefined();
        expect(requests.map((r: { kind: string }) => r.kind)).toEqual(['pr-block', 'pr-comment']);
    });

    it('#41 замечание к удалённой строке уходит в шов со стороной LEFT', () => {
        const { ts, calls } = prTaskSource();
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({
                    kind: 'pr-comment',
                    comment: 'удалено зря',
                    path: 'src/a.ts',
                    line: 12,
                    side: 'LEFT',
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn: () => {},
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(false);
        expect(calls).toEqual([
            `pr-comment:55:${JSON.stringify({ path: 'src/a.ts', line: 12, side: 'LEFT' })}:удалено зря`,
        ]);
    });

    // SourceCraft отказывает на LEFT, а файловый комментарий там бросает всегда: каждое
    // LEFT-замечание деградирует до сводки, и место в ней обязано назвать старую версию.
    it('#41 LEFT деградировал до сводки — место названо старой версией', () => {
        const calls: string[] = [];
        const logFn = vi.fn();
        const { ts } = prTaskSource({
            commentOnPullRequest: (_n: number, input: { body: string; anchor?: unknown }) => {
                if (input.anchor) throw new Error('форж не принимает этот якорь');
                calls.push(unmark(input.body));
            },
        });
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            dry: false,
            readFn: () =>
                line({
                    kind: 'pr-comment',
                    comment: 'удалено зря',
                    path: 'src/a.ts',
                    line: 42,
                    side: 'LEFT',
                }),
            writeFn: () => {},
            removeFn: () => {},
            taskSource: ts,
            logFn,
            pushEventFn: () => {},
        });
        expect(res.failed).toBe(false);
        expect(calls).toEqual(['удалено зря\n\n— место: src/a.ts:42 (старая версия)']);
        expect(logFn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
            /Инлайн-якорь src\/a\.ts:42 \(старая версия\) не прошёл/,
        );
    });

    it('НЕГАТИВНЫЙ: не удалось сохранить хвост — петля не падает, хвост уходит в пуш', () => {
        // Запись хвоста — тоже побочка, и она умеет отказывать (диск, права). Исключение
        // отсюда вылетело бы из runLoop и убило бы процесс раннера БЕЗ единого сигнала:
        // худший исход из возможных. Поэтому текст неприменённого уходит человеку прямо
        // в пуш — восстановить его руками дороже, чем прочитать.
        const { ts } = fakeTaskSource({
            closeIssue: () => {
                throw new Error('форж отверг закрытие');
            },
        });
        const pushEventFn = vi.fn();
        expect(() =>
            ralph.applySessionRequests({
                cfg: CFG,
                dry: false,
                readFn: () => line({ kind: 'close', issue: 7, comment: 'сделано' }),
                writeFn: () => {
                    throw new Error('диск полон');
                },
                taskSource: ts,
                logFn: () => {},
                pushEventFn,
            }),
        ).not.toThrow();
        expect(pushEventFn).toHaveBeenCalledTimes(1);
        const msg = String(pushEventFn.mock.calls[0][0]);
        expect(msg).toMatch(/диск полон/);
        expect(msg).toMatch(/"kind":"close"/);
    });

    it('C1: в dry намерения только читаются — ни вызовов шва, ни записи в файл', () => {
        const { ts, calls } = fakeTaskSource();
        const logs: string[] = [];
        const written: string[] = [];
        ralph.applySessionRequests({
            cfg: CFG,
            dry: true,
            readFn: () => line({ kind: 'close', issue: 7, comment: 'сделано' }),
            writeFn: (t: string) => written.push(t),
            taskSource: ts,
            logFn: (m: string) => logs.push(m),
            pushEventFn: () => {},
        });
        expect(calls).toEqual([]);
        expect(written).toEqual([]);
        // Прочитанное всё равно видно в логе: dry-прогон для того и нужен.
        expect(logs.join('\n')).toMatch(/close/);
    });

    // #16-продолжение: у карточки кодер-сессии тоже должен быть АДРЕС. Замер 01.09.2026:
    // 16 карточек из 18 бесхозных пришли именно отсюда, и среди них были не ниты, а
    // находки уровня «тесты бэкенда не проходят typecheck ни в одном кубе гейта».
    // Веха текущей фазы при этом по-прежнему запрещена — карточка в ней удлинила бы фазу,
    // которую сессия сейчас сдаёт, ровно настолько, насколько сессия находит постороннего.
    describe('адрес карточки кодер-сессии (#16)', () => {
        const withBacklog = (over: Record<string, unknown> = {}) => ({
            ...CFG,
            review: {
                backlogMilestone: ['Ревью · Входящие', 'Ревью · Запасные'],
                ...over,
            },
        });

        // Фейк шва, который запоминает АДРЕС, а не только заголовок, плюс наполнение вех.
        const addressingTaskSource = (
            open: Record<string, unknown[]> = {},
            over: Record<string, unknown> = {},
        ) => {
            const created: Array<{
                title: string;
                body?: string;
                labels?: readonly string[];
                milestone?: string;
            }> = [];
            const asked: string[] = [];
            return {
                created,
                asked,
                ts: {
                    commentOnIssue: () => {},
                    closeIssue: () => {},
                    blockIssue: () => {},
                    listAllOpenIssues: (milestone: string) => {
                        asked.push(milestone);
                        return open[milestone] ?? [];
                    },
                    // #65: по умолчанию вехи открыты — закрытость тест задаёт явно.
                    isMilestoneOpen: (milestone: string) => (void milestone, true),
                    // Пишем ВЕСЬ input: раскладка полей руками (`createIssue({title, body,
                    // labels, milestone})` вместо `createIssue(req)`) появилась вместе
                    // с адресом, и потерять в ней поле стало возможно впервые. Фейк,
                    // запоминающий только заголовок, такую потерю не увидит.
                    createIssue: (input: {
                        title: string;
                        body: string;
                        labels: readonly string[];
                        milestone?: string;
                    }) => {
                        created.push(input);
                        return 77;
                    },
                    ...over,
                },
            };
        };

        const newIssue = (title: string) =>
            line({ kind: 'new-issue', title, body: 'симптом', labels: ['complexity:low'] });

        // Сверяем карточку ЦЕЛИКОМ, а не только адрес: метки решают, какой моделью
        // карточка будет взята (без `complexity:*` её не видит роутинг вовсе), тело —
        // единственное, по чему человек поймёт находку. Потерять их стало возможно ровно
        // здесь: раньше намерение уезжало в шов одним объектом и терять было нечего.
        it('карточка едет в накопитель ЦЕЛИКОМ: тело, метки и адрес', () => {
            const { ts, created } = addressingTaskSource();
            ralph.applySessionRequests({
                cfg: withBacklog(),
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () => newIssue('Течёт лимит'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => {},
            });
            expect(created).toEqual([
                {
                    title: 'Течёт лимит',
                    body: 'симптом',
                    labels: ['complexity:low'],
                    milestone: 'Ревью · Входящие',
                },
            ]);
        });

        // #65: канал кодер-сессии ходит через ту же фабрику, что лестница, но проводку
        // статуса у него можно потерять отдельно — поэтому свой сценарий.
        it('первый накопитель ЗАКРЫТ и пуст → карточка едет во второй', () => {
            const { ts, created, asked } = addressingTaskSource(
                {},
                { isMilestoneOpen: (m: string) => m !== 'Ревью · Входящие' },
            );
            ralph.applySessionRequests({
                cfg: withBacklog(),
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () => newIssue('Течёт лимит'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => {},
            });
            expect(created).toMatchObject([
                { title: 'Течёт лимит', milestone: 'Ревью · Запасные' },
            ]);
            // #220: вехи читает и сверка дублей (фаза и Входящие), но по разу на веху —
            // наполнение закрытой адрес по-прежнему не спрашивает отдельно.
            expect(asked).toEqual(['Gravity · Фаза 4', 'Ревью · Входящие', 'Ревью · Запасные']);
        });

        it('статус накопителя не читается → адреса нет, а не «веха открыта»', () => {
            const { ts, created } = addressingTaskSource(
                {},
                {
                    isMilestoneOpen: () => {
                        throw new Error('форж не отдал вехи');
                    },
                },
            );
            ralph.applySessionRequests({
                cfg: withBacklog(),
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () => newIssue('Течёт лимит'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => {},
            });
            expect(created).toMatchObject([{ title: 'Течёт лимит', milestone: undefined }]);
        });

        // Правило сходимости, ради которого адрес вообще выбирается, а не берётся первым
        // попавшимся: карточка в вехе текущей фазы удлиняет фазу, которую сессия сдаёт.
        it('веха текущей фазы под адрес не берётся — карточка едет без него', () => {
            const { ts, created } = addressingTaskSource();
            ralph.applySessionRequests({
                cfg: withBacklog({ backlogMilestone: ['Ревью · Входящие'] }),
                currentMilestone: 'Ревью · Входящие',
                dry: false,
                readFn: () => newIssue('Течёт лимит'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => {},
            });
            expect(created).toMatchObject([{ title: 'Течёт лимит', milestone: undefined }]);
        });

        // Отказ обязан быть СЛЫШНЫМ: карточка заводится, но человеку надо знать, что она
        // без адреса, — красного чека здесь нет и не будет.
        it('накопитель переполнен → карточка без адреса и предупреждение в логе', () => {
            const full = Array.from({ length: 5 }, (_, i) => ({ number: i + 1, title: 'x' }));
            const { ts, created } = addressingTaskSource({ 'Ревью · Входящие': full });
            const logs: string[] = [];
            ralph.applySessionRequests({
                cfg: withBacklog({
                    backlogMilestone: ['Ревью · Входящие'],
                    backlogMilestoneCap: 5,
                }),
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () => newIssue('Течёт лимит'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: (m: string) => logs.push(m),
                pushEventFn: () => {},
            });
            expect(created).toMatchObject([{ title: 'Течёт лимит', milestone: undefined }]);
            expect(logs.join('\n')).toMatch(/Накопительной вехи для карточек кодер-сессии/);
        });

        // Отказ ЧТЕНИЯ наполнения ≠ пустая веха. Иначе одно неотвеченное чтение делало бы
        // годной сколь угодно переполненную веху — потолок переставал бы быть барьером.
        it('наполнение вехи не читается → адреса нет, а не «веха пустая»', () => {
            const { ts, created } = addressingTaskSource(
                {},
                {
                    listAllOpenIssues: () => {
                        throw new Error('вехи нет в этом репозитории');
                    },
                },
            );
            ralph.applySessionRequests({
                cfg: withBacklog(),
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () => newIssue('Течёт лимит'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => {},
            });
            expect(created).toMatchObject([{ title: 'Течёт лимит', milestone: undefined }]);
        });

        // Адрес ищется ЛЕНИВО: батч без единой карточки (обычный случай) не платит за это
        // ни одним запросом к форжу.
        it('батч без новых карточек не спрашивает наполнение вех вовсе', () => {
            const { ts, asked } = addressingTaskSource();
            ralph.applySessionRequests({
                cfg: withBacklog(),
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () => line({ kind: 'close', issue: 7, comment: 'сделано' }),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => {},
            });
            expect(asked).toEqual([]);
        });

        // Ключ не задан — поведение прежнее, без адреса и без лишнего запроса.
        it('ключ не задан — карточка едет как раньше, без адреса и без шума', () => {
            const { ts, created, asked } = addressingTaskSource();
            const logs: string[] = [];
            ralph.applySessionRequests({
                cfg: CFG,
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () => newIssue('Течёт лимит'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: (m: string) => logs.push(m),
                pushEventFn: () => {},
            });
            expect(created).toMatchObject([{ title: 'Течёт лимит', milestone: undefined }]);
            // #220: веху фазы читает сверка дублей; накопителей адрес не спрашивает.
            expect(asked).toEqual(['Gravity · Фаза 4']);
            // «Прежнее поведение» — это и отсутствие новой строки в логе: предупреждение
            // про ненайденный адрес относится к заданному ключу, а не к незаданному.
            expect(logs.join('\n')).not.toMatch(/Накопительной вехи/);
        });

        // Замер 01.09.2026 давал 16 бесхозных карточек за период — по одной за раз их так
        // не набирается. Батч из нескольких проверяет то, чего одиночный не может: счёт
        // внутри батча, перелив в следующего кандидата и цену в запросах к форжу.
        it('батч из трёх карточек: перелив по кандидатам, по одному запросу на веху', () => {
            const { ts, created, asked } = addressingTaskSource({
                'Ревью · Входящие': [{ number: 1, title: 'уже лежит' }],
            });
            ralph.applySessionRequests({
                cfg: withBacklog({ backlogMilestoneCap: 2 }),
                currentMilestone: 'Gravity · Фаза 4',
                dry: false,
                readFn: () =>
                    [newIssue('Первая'), newIssue('Вторая'), newIssue('Третья')].join('\n'),
                writeFn: () => {},
                removeFn: () => {},
                taskSource: ts,
                logFn: () => {},
                pushEventFn: () => {},
            });
            expect(created).toMatchObject([
                { title: 'Первая', milestone: 'Ревью · Входящие' },
                { title: 'Вторая', milestone: 'Ревью · Запасные' },
                { title: 'Третья', milestone: 'Ревью · Запасные' },
            ]);
            // Наполнение спрашивается по разу на веху, а не на карточку: у площадки лимит
            // запросов, и батч намерений не имеет права его жечь. #220: чтение общее со
            // сверкой дублей, поэтому и с ней — по разу.
            expect(asked).toEqual(['Gravity · Фаза 4', 'Ревью · Входящие', 'Ревью · Запасные']);
        });

        // #220: планирование без мусора — дубль, `blocks`, квота сессии.
        describe('new-issue без мусора (#220)', () => {
            const PHASE = 'Gravity · Фаза 4';
            const OPEN_14 = {
                number: 14,
                title: 'Стенд не выходит наружу через прокси хоста',
                body: 'Падает в `provision/install-stand.sh` и `core/live-probe.ts`, см. #12.',
            };
            // Шов с телами карточек и журналом мутаций по карточкам фазы.
            const planningTaskSource = (
                open: Record<string, Array<{ number: number; title: string; body?: string }>>,
                over: Record<string, unknown> = {},
            ) => {
                const comments: Array<[number, string]> = [];
                const bodies: Array<[number, string]> = [];
                const all = Object.values(open).flat();
                const base = addressingTaskSource(open, {
                    getIssue: (n: number) => {
                        const found = all.find((i) => i.number === n);
                        if (!found) throw new Error(`нет #${String(n)}`);
                        return { number: n, title: found.title, body: found.body ?? '' };
                    },
                    commentOnIssue: (n: number, body: string) => comments.push([n, body]),
                    setIssueBody: (n: number, body: string) => bodies.push([n, body]),
                    ...over,
                });
                return { ...base, comments, bodies };
            };
            const apply = (
                ts: unknown,
                lines: string[],
                cfg: Record<string, unknown> = withBacklog(),
                extra: Record<string, unknown> = {},
            ) => {
                const logs: string[] = [];
                const pushes: string[] = [];
                const res = ralph.applySessionRequests({
                    cfg,
                    currentMilestone: PHASE,
                    dry: false,
                    readFn: () => lines.join('\n'),
                    writeFn: () => {},
                    removeFn: () => {},
                    taskSource: ts,
                    logFn: (m: string) => logs.push(m),
                    pushEventFn: (m: string) => pushes.push(m),
                    ...extra,
                });
                return { res, logs: logs.join('\n'), pushes };
            };
            const issue = (o: Record<string, unknown>) =>
                line({ kind: 'new-issue', body: 'симптом', labels: ['complexity:low'], ...o });

            it('повтор открытой карточки вехи — не заводится, в найденной комментарий', () => {
                const { ts, created, comments } = planningTaskSource({ [PHASE]: [OPEN_14] });
                const { res, logs } = apply(ts, [
                    issue({
                        title: 'Egress стенда: сессия CLI не достаёт API',
                        body: 'Цепочка provision/install-stand.sh → core/live-probe.ts рвётся, как в #12.',
                    }),
                ]);
                expect(res.failed).toBe(false);
                expect(created).toEqual([]);
                expect(comments).toHaveLength(1);
                expect(comments[0][0]).toBe(14);
                expect(comments[0][1]).toMatch(/снова наткнулась/);
                expect(comments[0][1]).toMatch(/Egress стенда/);
                expect(logs).toMatch(/🗂 Дубль #14: Egress стенда/);
            });

            it('дубль ищется и во Входящих', () => {
                const { ts, created, comments } = planningTaskSource({
                    'Ревью · Входящие': [{ ...OPEN_14, number: 30 }],
                });
                apply(ts, [issue({ title: 'Другими словами', body: OPEN_14.body })]);
                expect(created).toEqual([]);
                expect(comments.map(([n]) => n)).toEqual([30]);
            });

            it('ОТ ПРОТИВНОГО: общие слова заголовка, разные пути — заводятся обе', () => {
                const { ts, created, comments } = planningTaskSource({
                    [PHASE]: [
                        {
                            number: 3,
                            title: 'Лимит форжа на комментарии ревью',
                            body: 'в `core/review.ts`',
                        },
                    ],
                });
                apply(ts, [
                    issue({
                        title: 'Лимит форжа на метки',
                        body: 'в `adapters/sourcecraft-api.ts`',
                    }),
                    issue({
                        title: 'Лимит форжа на вехи',
                        body: 'в `adapters/github-issue-commands.ts`',
                    }),
                ]);
                expect(created.map((c) => c.title)).toEqual([
                    'Лимит форжа на метки',
                    'Лимит форжа на вехи',
                ]);
                expect(comments).toEqual([]);
            });

            it('повтор внутри одного батча — второй ложится комментарием к первому', () => {
                const { ts, created, comments } = planningTaskSource({});
                apply(ts, [
                    issue({ title: 'Первая', body: OPEN_14.body }),
                    issue({ title: 'Вторая', body: OPEN_14.body }),
                ]);
                expect(created.map((c) => c.title)).toEqual(['Первая']);
                expect(comments.map(([n]) => n)).toEqual([77]);
            });

            it('blocks: карточка в веху фазы, ссылка в тело и ленту, рост фазы в логе', () => {
                const { ts, created, comments, bodies } = planningTaskSource({
                    [PHASE]: [{ number: 186, title: 'Guard судит событие', body: 'тело' }],
                });
                const { logs } = apply(ts, [issue({ title: 'Нужен прокси стенда', blocks: 186 })]);
                expect(created).toMatchObject([{ title: 'Нужен прокси стенда', milestone: PHASE }]);
                expect(comments).toHaveLength(1);
                expect(comments[0][0]).toBe(186);
                expect(comments[0][1]).toMatch(/#77/);
                expect(bodies).toEqual([
                    [186, 'тело\n\n— Заблокирована #77 «Нужен прокси стенда».'],
                ]);
                expect(logs).toMatch(/📈 Фаза "Gravity · Фаза 4" выросла: #77/);
            });

            // Ревью 16c3, от противного: блокер с теми же путями и ссылками, что у
            // заблокированной, набирал порог дубля против неё самой и не заводился.
            it('blocks: блокер, похожий на заблокированную, всё равно заводится в веху фазы', () => {
                const { ts, created, comments } = planningTaskSource({ [PHASE]: [OPEN_14] });
                const { logs } = apply(ts, [
                    issue({
                        title: 'Стенд не выходит наружу: прокси хоста не в цепочке',
                        body: OPEN_14.body,
                        blocks: 14,
                    }),
                ]);
                expect(created).toMatchObject([{ milestone: PHASE }]);
                expect(
                    comments.map(([n, b]) => [n, /Фазу держит новая карточка #77/.test(b)]),
                ).toEqual([[14, true]]);
                expect(logs).not.toMatch(/Дубль/);
            });

            it('blocks: дубль во Входящих — связь с фазой ссылкой и ⚠ с номером', () => {
                const { ts, created, comments, bodies } = planningTaskSource({
                    [PHASE]: [{ number: 186, title: 'Guard судит событие', body: 'тело' }],
                    'Ревью · Входящие': [{ ...OPEN_14, number: 30 }],
                });
                const { logs } = apply(ts, [
                    issue({ title: 'Другими словами', body: OPEN_14.body, blocks: 186 }),
                ]);
                expect(created).toEqual([]);
                expect(comments.map(([n]) => n)).toEqual([30, 186]);
                // Ревью 16c3: карточка не новая и фаза не выросла — текст трекера просит
                // перенести существующую в веху, а не говорит «фазу держит новая».
                expect(comments[1][1]).toMatch(
                    /существующая #30 .* вне вехи "Gravity · Фаза 4".*Перенеси её в веху фазы/,
                );
                expect(comments[1][1]).not.toMatch(/новая карточка/);
                expect(bodies).toEqual([
                    [186, expect.stringMatching(/Заблокирована #30 .*\(вне вехи фазы\)\.$/)],
                ]);
                expect(logs).toMatch(/⚠ Блокер #186 — дубль #30 вне вехи "Gravity · Фаза 4"/);
                expect(logs).not.toMatch(/📈 Фаза/);
                expect(logs).not.toMatch(/Бюджет фазы/);
            });

            it('blocks: дубль при непрочитанной вехе — ссылки нет, ⚠ «не сверен»', () => {
                const { ts, created, comments } = planningTaskSource(
                    { 'Ревью · Входящие': [{ ...OPEN_14, number: 30 }] },
                    {
                        listAllOpenIssues: (m: string) => {
                            if (m === PHASE) throw new Error('веха не читается');
                            return m === 'Ревью · Входящие' ? [{ ...OPEN_14, number: 30 }] : [];
                        },
                    },
                );
                const { res, logs } = apply(ts, [
                    issue({ title: 'Другими словами', body: OPEN_14.body, blocks: 186 }),
                ]);
                expect(res.failed).toBe(false);
                expect(created).toEqual([]);
                expect(comments.map(([n]) => n)).toEqual([30]);
                expect(logs).toMatch(/blocks #186 не сверен с вехой — дубль #30 не связан с фазой/);
                expect(logs).not.toMatch(/⚠ Блокер #186/);
            });

            it('blocks: дубль уже в вехе фазы — ссылка не задваивается', () => {
                const { ts, created, comments } = planningTaskSource({
                    [PHASE]: [
                        { number: 186, title: 'Guard судит событие', body: 'тело' },
                        { ...OPEN_14, number: 31 },
                    ],
                });
                const { logs } = apply(ts, [
                    issue({ title: 'Другими словами', body: OPEN_14.body, blocks: 186 }),
                ]);
                expect(created).toEqual([]);
                expect(comments.map(([n]) => n)).toEqual([31]);
                expect(logs).not.toMatch(/⚠ Блокер/);
            });

            it('blocks дорастил веху выше maxIterations — ⚠ с числами', () => {
                const many = Array.from({ length: 3 }, (_, k) => ({
                    number: 100 + k,
                    title: `Карточка ${String(k)}`,
                }));
                const { ts } = planningTaskSource({ [PHASE]: many });
                const { logs } = apply(ts, [issue({ title: 'Ещё одна', blocks: 100 })], {
                    ...withBacklog(),
                    maxIterations: 2,
                });
                expect(logs).toMatch(
                    /⚠ Бюджет фазы "Gravity · Фаза 4": открытых карточек 3 при maxIterations 2/,
                );
            });

            it('отказы шагов связи — строки ⚠, карточка заведена, намерение не повторяется', () => {
                let reads = 0;
                const { ts, created } = planningTaskSource(
                    { [PHASE]: [{ number: 186, title: 'Guard' }] },
                    {
                        commentOnIssue: () => {
                            throw new Error('лента отказала');
                        },
                        getIssue: () => {
                            throw new Error('тело не читается');
                        },
                        listAllOpenIssues: (m: string) => {
                            reads += 1;
                            if (reads > 1) throw new Error('веха моргнула');
                            return m === PHASE ? [{ number: 186, title: 'Guard' }] : [];
                        },
                    },
                );
                const { res, logs } = apply(ts, [issue({ title: 'Нужен прокси', blocks: 186 })]);
                expect(res.failed).toBe(false);
                expect(created).toHaveLength(1);
                expect(logs).toMatch(/Сверка дублей new-issue — не всё прочиталось/);
                expect(logs).toMatch(/в комментарий #186 не легла: лента отказала/);
                expect(logs).toMatch(/в тело #186 не легла: тело не читается/);
                expect(logs).toMatch(/после роста не сверен: веха моргнула/);
            });

            it('форж не отдал номер — ссылку ставить не на что, и это сказано', () => {
                const { ts, comments } = planningTaskSource(
                    { [PHASE]: [{ number: 186, title: 'Guard' }] },
                    { createIssue: () => null },
                );
                const { logs } = apply(ts, [issue({ title: 'Нужен прокси', blocks: 186 })]);
                expect(comments).toEqual([]);
                expect(logs).toMatch(/ссылку в #186 ставить не на что/);
            });

            it('шов без setIssueBody — ссылка только комментарием, и это сказано', () => {
                const { ts, comments } = planningTaskSource(
                    { [PHASE]: [{ number: 186, title: 'Guard' }] },
                    { setIssueBody: undefined },
                );
                const { logs } = apply(ts, [issue({ title: 'Нужен прокси', blocks: 186 })]);
                expect(comments.map(([n]) => n)).toEqual([186]);
                expect(logs).toMatch(/тело карточки не правит/);
            });

            it('НЕГАТИВНЫЙ: blocks с номером не из текущей вехи — отказ разбора батча', () => {
                const { ts, created } = planningTaskSource({
                    [PHASE]: [{ number: 186, title: 'Guard' }],
                    'Ревью · Входящие': [{ number: 216, title: 'чужая' }],
                });
                const { res, pushes } = apply(ts, [
                    line({ kind: 'close', issue: 186, comment: 'сделано' }),
                    issue({ title: 'Нужен прокси', blocks: 216 }),
                ]);
                expect(res.failed).toBe(true);
                expect(created).toEqual([]);
                expect(pushes.join('\n')).toMatch(/blocks #216 — не открытая карточка вехи/);
            });

            it('веха фазы не прочиталась — blocks разжалован во Входящие, а не карантин', () => {
                const { ts, created } = planningTaskSource(
                    {},
                    {
                        listAllOpenIssues: (m: string) => {
                            if (m === PHASE) throw new Error('форж моргнул');
                            return [];
                        },
                    },
                );
                const { res, logs } = apply(ts, [issue({ title: 'Нужен прокси', blocks: 186 })]);
                expect(res.failed).toBe(false);
                expect(created).toMatchObject([{ milestone: 'Ревью · Входящие' }]);
                expect(logs).toMatch(/blocks #186 не сверен/);
            });

            it('сверх квоты — во Входящие с меткой разбора и пуш вахте, батч применён', () => {
                const { ts, created } = planningTaskSource({
                    [PHASE]: [{ number: 186, title: 'Guard' }],
                });
                const { res, pushes } = apply(
                    ts,
                    [
                        issue({ title: 'Альфа' }),
                        issue({ title: 'Бета' }),
                        issue({ title: 'Гамма', blocks: 186 }),
                        line({ kind: 'close', issue: 186, comment: 'сделано' }),
                    ],
                    { ...withBacklog(), newIssues: { sessionQuota: 2, triageLabel: 'triage' } },
                );
                expect(res.failed).toBe(false);
                expect(res.closedIssues).toEqual([186]);
                expect(created).toMatchObject([
                    { title: 'Альфа', labels: ['complexity:low'] },
                    { title: 'Бета', labels: ['complexity:low'] },
                    {
                        title: 'Гамма',
                        labels: ['complexity:low', 'triage'],
                        milestone: 'Ревью · Входящие',
                    },
                ]);
                expect(pushes).toHaveLength(1);
                expect(pushes[0]).toMatch(/📥 .*больше 2 карточек.*с меткой triage/s);
                expect(pushes[0]).toMatch(/«Гамма» \(просила blocks #186\)/);
            });

            it('метка разбора не задана — лишнее без метки, и пуш это называет', () => {
                const { ts, created } = planningTaskSource({});
                const { pushes } = apply(
                    ts,
                    [issue({ title: 'Альфа' }), issue({ title: 'Бета' })],
                    {
                        ...withBacklog(),
                        newIssues: { sessionQuota: 1 },
                    },
                );
                expect(created[1].labels).toEqual(['complexity:low']);
                expect(pushes[0]).toMatch(/triageLabel не задан/);
            });

            it('НЕГАТИВНЫЙ: битая секция newIssues — отказ батча, а не дефолт', () => {
                const { ts, created } = planningTaskSource({});
                const { res, pushes } = apply(ts, [issue({ title: 'Альфа' })], {
                    ...withBacklog(),
                    newIssues: { sessionQuota: '3' },
                });
                expect(res.failed).toBe(true);
                expect(created).toEqual([]);
                expect(pushes.join('\n')).toMatch(/newIssues\.sessionQuota/);
            });
        });
    });
});

// ── #40: формы argv-мутаций GitHub ──────────────────────────────────────────
// Отдельно от контракта: контракт проверяет ПОВЕДЕНИЕ (доходит/бросает), а здесь —
// что именно уходит в форж. Значения приходят из файла, который написала модель, поэтому
// главное свойство — argv без шелла: интерпретатора в этом пути нет вовсе (C3).

describe('milestoneLabels: неполная выборка — тоже неизвестность (#37)', () => {
    it('отдаёт имена меток всех карточек фазы', () => {
        const labels = ralph.milestoneLabels('M1', {
            forgeJsonFn: () => [
                { labels: [{ name: 'complexity:high' }, { name: 'area:devops' }] },
                { labels: [] },
                {},
            ],
        });
        expect(labels).toEqual(['complexity:high', 'area:devops']);
    });

    it('НЕГАТИВНЫЙ: выборка упёрлась в лимит → отказ, а не «сложных задач нет»', () => {
        // Упёршийся в предел ответ — это «часть меток мы не видели». Отдать его как
        // полный значило бы пропустить эскалацию молча: ровно тот класс тихой
        // деградации, ради которого метки и переехали в шов.
        const many = Array.from({ length: 200 }, () => ({ labels: [{ name: 'area:docs' }] }));
        expect(() => ralph.milestoneLabels('M1', { forgeJsonFn: () => many })).toThrow(
            /лимит|предел/i,
        );
    });
});

describe('prComments: три поверхности GitHub и полная выборка (#37)', () => {
    // Тип возврата аннотирован явно: `ralph.js` — JS-entry без деклараций, и без этого
    // его ответ приезжает как any (тот же приём, что у соседних сьютов).
    const call = (impl: (cmd: string) => unknown): ReviewComment[] =>
        ralph.prComments(42, { forgeJsonFn: (cmd: string) => impl(cmd) }) as ReviewComment[];

    it('спрашивает все три поверхности и помечает сводку прохода', () => {
        const cmds: string[] = [];
        const comments = call((cmd) => {
            cmds.push(cmd);
            if (cmd.includes('/pulls/42/reviews'))
                return [{ body: 'сводка', user: { login: 'a' } }];
            if (cmd.includes('/pulls/42/comments'))
                return [{ body: 'inline', user: { login: 'a' } }];
            return [{ body: 'тред', user: { login: 'a' } }];
        });
        expect(cmds).toHaveLength(3);
        expect(comments.filter((c) => c.isSummary).map((c) => c.body)).toEqual(['сводка']);
        expect(comments.map((c) => c.author)).toEqual(['a', 'a', 'a']);
    });

    // Без `--paginate` gh отдаёт ПЕРВУЮ страницу (30 записей) и молчит об остальном:
    // длинный тред ревью дал бы заниженный счёт, не покраснев ни одним тестом. Тот же
    // класс, что упёршаяся в лимит выборка меток выше и повторённый page_token (#43).
    it('просит ПОЛНУЮ выборку — иначе длинный тред обрежется молча', () => {
        const cmds: string[] = [];
        call((cmd) => {
            cmds.push(cmd);
            return [];
        });
        expect(cmds.every((c) => c.includes('--paginate'))).toBe(true);
    });

    it('пустые и whitespace-тела в ленту не попадают', () => {
        // У прохода ревью без сводного текста тело пустое — это не находка, но в total
        // метрики оно попало бы наравне с остальными.
        expect(call(() => [{ body: '   ' }, { body: '' }, {}])).toEqual([]);
    });

    it('НЕГАТИВНЫЙ: ответ не массив → отказ, а не пустая лента', () => {
        expect(() => call(() => ({ message: 'Not Found' }))).toThrow(/массив/i);
    });

    it('НЕГАТИВНЫЙ: некорректный номер PR → отказ', () => {
        expect(() => ralph.prComments(0, { forgeJsonFn: () => [] })).toThrow(/номер/i);
    });
});

describe('reviewDiffContext: контекст ревью без команд форжа (#50)', () => {
    // Контекст диффа — тоже текст промпта, только собранный вне prompts.ts, поэтому
    // греп-барьер до него не достаёт. А команда форжа там была: в фолбэке «возьми его сам:
    // gh pr diff» и в примечании про обрезку. Сессия выполнить их не может — потратит ходы
    // и решит, что ревьюить нечего.
    const noForge = (text: string) => expect(text).not.toMatch(/\bgh\b/i);

    it('дифф не получен — честный текст без невыполнимой команды', () => {
        noForge(
            ralph.reviewDiffContext('feature/m1', {
                files: ['a.ts'],
                shFn: () => {
                    throw new Error('git упал');
                },
                logFn: () => {},
            }),
        );
    });

    it('дифф обрезан — примечание тоже без команды форжа', () => {
        const long = 'x'.repeat(500);
        noForge(
            ralph.reviewDiffContext('feature/m1', {
                files: ['a.ts'],
                shFn: () => long,
                limit: 100,
                logFn: () => {},
            }),
        );
    });
});

describe('phasePrBody: описание PR из фактов ветки, а не из пересказа модели (#46)', () => {
    it('перечисляет коммиты фазы и называет фазу с веткой', () => {
        const body = ralph.phasePrBody(
            { milestone: 'Фаза 1', branch: 'feature/m1' },
            { shFn: () => 'feat: первое\nfix: второе', logFn: () => {} },
        );
        expect(body).toContain('Фаза 1');
        expect(body).toContain('feature/m1');
        expect(body).toContain('- feat: первое');
        expect(body).toContain('- fix: второе');
    });

    it('git не отдал коммиты → короткое тело, но PR всё равно заводится', () => {
        // Fail-open ТОЛЬКО здесь: отсутствие описания — не повод не сдавать фазу.
        const logs: string[] = [];
        const body = ralph.phasePrBody(
            { milestone: 'Фаза 1', branch: 'feature/m1' },
            {
                shFn: () => {
                    throw new Error('git упал');
                },
                logFn: (m: string) => logs.push(m),
            },
        );
        expect(body).toContain('Фаза 1');
        expect(logs.join('\n')).toMatch(/не смог прочитать коммиты/i);
    });
});

describe('commentOnPr: комментарий к строке требует sha головы (#45)', () => {
    it('inline-комментарий уходит с commit_id, path и line', () => {
        const argv: string[][] = [];
        ralph.commentOnPr(
            42,
            { body: '🔴 [blocker] тут', anchor: { path: 'src/a.ts', line: 7 } },
            {
                runArgvFn: (_f: string, a: string[]) => {
                    argv.push(a);
                    return '';
                },
                forgeJsonFn: () => ({ headRefOid: 'a'.repeat(40) }),
            },
        );
        const flat = argv[0].join(' ');
        expect(flat).toContain('pulls/42/comments');
        expect(flat).toContain(`commit_id=${'a'.repeat(40)}`);
        expect(flat).toContain('path=src/a.ts');
        expect(flat).toContain('line=7');
    });

    // #575: якорь без строки — комментарий уровня ФАЙЛА. У GitHub это тот же эндпоинт с
    // `subject_type=file`; `line`/`side` в нём быть не должно — с ними форж ждёт строку
    // в ханке и снова ответит 422.
    it('#575 якорь без строки → subject_type=file, без line и side', () => {
        const argv: string[][] = [];
        ralph.commentOnPr(
            42,
            // Тело НАРОЧНО содержит `line=` — замечание ревью про код такое пишет запросто.
            // Негативные проверки ниже идут по ЭЛЕМЕНТАМ argv, а не по склейке: склейка
            // покраснела бы на тексте комментария, то есть не на том, что проверяет.
            { body: '⚪ [nit] в вызове осталось line=7 — убрать', anchor: { path: 'src/a.ts' } },
            {
                runArgvFn: (_f: string, a: string[]) => {
                    argv.push(a);
                    return '';
                },
                forgeJsonFn: () => ({ headRefOid: 'a'.repeat(40) }),
            },
        );
        const a = argv[0];
        expect(a).toContain(`repos/{owner}/{repo}/pulls/42/comments`);
        expect(a).toContain(`commit_id=${'a'.repeat(40)}`);
        expect(a).toContain('path=src/a.ts');
        expect(a).toContain('subject_type=file');
        expect(a).not.toContain('side=RIGHT');
        // `line=` кладётся ТОЛЬКО флагом `-F` (число, а не строка) — его отсутствие и есть
        // проверка, что параметра строки нет вовсе.
        expect(a).not.toContain('-F');
        expect(a.filter((x) => x.startsWith('line='))).toEqual([]);
    });

    it('без якоря — обычный комментарий треда, sha не запрашивается', () => {
        const argv: string[][] = [];
        ralph.commentOnPr(
            42,
            { body: 'сводка' },
            {
                runArgvFn: (_f: string, a: string[]) => {
                    argv.push(a);
                    return '';
                },
                forgeJsonFn: () => {
                    throw new Error('sha не нужен для сводки');
                },
            },
        );
        expect(argv[0].join(' ')).toContain('issues/42/comments');
    });

    it('НЕГАТИВНЫЙ: голова PR не резолвится → отказ, а не общий комментарий', () => {
        // Деградация «положим тогда без якоря» была бы тихой подменой: у площадки именно
        // якорь отличает находку от сводки, и находка молча ушла бы в unmarked.
        expect(() =>
            ralph.commentOnPr(
                42,
                { body: 'x', anchor: { path: 'a.ts', line: 1 } },
                { runArgvFn: () => '', forgeJsonFn: () => ({ headRefOid: 'не-sha' }) },
            ),
        ).toThrow(/sha/i);
    });
});

describe('намерения сессии на стороне GitHub: argv, а не шелл (#40)', () => {
    const argvLog = () => {
        const calls: Array<[string, string[]]> = [];
        return {
            calls,
            runArgvFn: (file: string, args: string[]) => {
                calls.push([file, args]);
                return '';
            },
        };
    };

    it('комментарий, закрытие и blocked уходят argv-аргументами', () => {
        const { calls, runArgvFn } = argvLog();
        ralph.commentOnIssue(7, 'текст с `бэктиками` и $(подстановкой)', { runArgvFn });
        ralph.closeIssue(7, { runArgvFn });
        ralph.blockIssue(9, { runArgvFn });
        expect(calls).toEqual([
            ['gh', ['issue', 'comment', '7', '--body', 'текст с `бэктиками` и $(подстановкой)']],
            ['gh', ['issue', 'close', '7']],
            ['gh', ['issue', 'edit', '9', '--add-label', 'blocked']],
        ]);
    });

    it('createIssue: каждая метка отдельным --label, номер берётся из URL в выводе', () => {
        const calls: Array<[string, string[]]> = [];
        const num = ralph.createIssue(
            { title: 'Течёт лимит', body: 'симптом', labels: ['complexity:low', 'area:devops'] },
            {
                runArgvFn: (file: string, args: string[]) => {
                    calls.push([file, args]);
                    return 'https://github.com/org/repo/issues/321\n';
                },
            },
        );
        expect(num).toBe(321);
        expect(calls[0][1]).toEqual([
            'issue',
            'create',
            '--title',
            'Течёт лимит',
            '--body',
            'симптом',
            '--label',
            'complexity:low',
            '--label',
            'area:devops',
        ]);
    });

    it('вывод без номера → null: карточка создана, откатывать нечего, дубль хуже', () => {
        expect(
            ralph.createIssue(
                { title: 'т', body: 'б', labels: [] },
                { runArgvFn: () => 'created' },
            ),
        ).toBeNull();
    });

    it('createIssue: веха задана — адрес ставится ОТДЕЛЬНОЙ командой после создания', () => {
        // Не флагом создания (ревью правок PR !6): его отказ неотличим от транспортного,
        // а разбирать текст ошибки — гонка, которую не выиграть. Здесь же отказ второй
        // команды стоит адреса, но не карточки.
        const calls: Array<string[]> = [];
        const num = ralph.createIssue(
            { title: 'т', body: 'б', labels: [], milestone: 'Бэклог ревью 1' },
            {
                runArgvFn: (_file: string, args: string[]) => {
                    calls.push(args);
                    return 'https://github.com/org/repo/issues/7\n';
                },
            },
        );
        expect(num).toBe(7);
        expect(calls).toHaveLength(2);
        expect(calls[0]).not.toContain('--milestone');
        expect(calls[1]).toEqual(['issue', 'edit', '7', '--milestone', 'Бэклог ревью 1']);
    });

    it('НЕГАТИВНЫЙ: болтливый вывод форжа не уводит адресацию на ЧУЖУЮ карточку', () => {
        // Номер берётся из URL, а не из хвоста вывода. Пока он был нужен только логу,
        // «последние цифры строки» годились; целью мутации так брать нельзя — предупреждение
        // форжа с числом в конце отправило бы `issue edit` в чужую карточку (ревью правок).
        const calls: Array<string[]> = [];
        const num = ralph.createIssue(
            { title: 'т', body: 'б', labels: [], milestone: 'Бэклог ревью 1' },
            {
                runArgvFn: (_file: string, args: string[]) => {
                    calls.push(args);
                    return 'https://github.com/org/repo/issues/7\nwarning: retry after 30\n';
                },
                logFn: () => {},
            },
        );
        expect(num).toBe(7);
        expect(calls[1]).toEqual(['issue', 'edit', '7', '--milestone', 'Бэклог ревью 1']);
    });

    it('НЕГАТИВНЫЙ: в выводе несколько номеров → не правим ничего, номер неизвестен', () => {
        // Взять первый или последний — одинаково значит угадать порядок чужого вывода, а
        // ошибка стоит правки ЧУЖОЙ карточки (ревью правок PR !6, круг 4).
        const calls: Array<string[]> = [];
        const logs: string[] = [];
        const num = ralph.createIssue(
            { title: 'т', body: 'б', labels: [], milestone: 'Бэклог ревью 1' },
            {
                runArgvFn: (_file: string, args: string[]) => {
                    calls.push(args);
                    return 'warning: см. https://github.com/org/repo/issues/999\nhttps://github.com/org/repo/issues/7\n';
                },
                logFn: (line: string) => logs.push(line),
            },
        );
        expect(num).toBeNull();
        // Карточка при этом ЗАВЕДЕНА — теряется только её адрес: правило «ни один отказ не
        // стоит находки» держится и здесь. Проверяем это явно, а не через число вызовов:
        // «одна команда» само по себе не говорит, какая именно.
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 2)).toEqual(['issue', 'create']);
        expect(logs.join('\n')).toMatch(/несколько номеров/);
    });

    it('НЕГАТИВНЫЙ: адрес не поставился → карточка остаётся, отказ уходит в лог', () => {
        // Прежняя редакция повторяла СОЗДАНИЕ и на транспортном отказе давала дубль, а на
        // незнакомой формулировке — теряла карточку. Теперь отказ адресации не может ни
        // того, ни другого: карточка уже создана, страдает только её адрес.
        const logs: string[] = [];
        const num = ralph.createIssue(
            { title: 'т', body: 'б', labels: [], milestone: 'Нет такой' },
            {
                runArgvFn: (_file: string, args: string[]) => {
                    if (args.includes('--milestone')) throw new Error("'Нет такой' not found");
                    return 'https://github.com/org/repo/issues/7\n';
                },
                logFn: (line: string) => logs.push(line),
            },
        );
        expect(num).toBe(7);
        expect(logs.join('\n')).toMatch(/Нет такой/);
    });

    it('НЕГАТИВНЫЙ: номер карточки не отдан → адресовать нечего, второй команды нет', () => {
        const calls: Array<string[]> = [];
        const logs: string[] = [];
        expect(
            ralph.createIssue(
                { title: 'т', body: 'б', labels: [], milestone: 'Бэклог ревью 1' },
                {
                    runArgvFn: (_file: string, args: string[]) => {
                        calls.push(args);
                        return 'created';
                    },
                    logFn: (line: string) => logs.push(line),
                },
            ),
        ).toBeNull();
        expect(calls).toHaveLength(1);
        expect(logs.join('\n')).toMatch(/Бэклог ревью 1/);
    });
});

// ── Канон, задача 27: порядок «переезд в worktree → preflight» ──────────────────────────
// Проверка наличия скриптов потребителя честна ровно потому, что к моменту preflight cwd уже
// равен рабочему дереву раннера: относительный путь резолвится там же, где потом пойдёт
// вызов (`execFileSync` без `cwd` наследует текущий каталог). Переставь `preflight(config)`
// выше `process.chdir(worktreePath)` — и проверка начнёт искать файлы в дереве человека,
// оставаясь зелёной на всех юнит-тестах: они зовут preflight напрямую (ревью Codex, !22).
//
// Барьер структурный, по тексту main(): поведенческим его не сделать — chdir реального
// процесса в сьюте запрещён предохранителем побочек. Границы названы вслух, чтобы следующий
// не принял его за доказательство: он видит ТЕКСТ, а не исполнение, поэтому пропустит и
// переезд, вынесенный в helper с вызовом после preflight, и возврат в другой каталог между
// ними; ложно покраснеет на извлечении chdir из main(). Ловит он ровно одно — перестановку
// двух строк местами, а это и есть та правка, которой барьер боится.
describe('main(): переезд в worktree предшествует preflight (канон, задача 27)', () => {
    // Комментарии снимаются тем же стриппером, что и у барьеров чистоты: в докблоке рядом
    // с вызовом стоит `runLoop(config, preflight(config))` — текстовый скан принял бы его за
    // второй вызов и покраснел бы на объяснении, а не на коде.
    const source = stripComments(
        fs.readFileSync(path.resolve(import.meta.dirname, './orchestrator.ts'), 'utf-8'),
    );

    it('ВСЕ переезды в worktree стоят выше вызова preflight', () => {
        const chdirAt = [...source.matchAll(/process\.chdir\(worktreePath\)/g)].map((m) => m.index);
        // Вызов ищется по имени функции с аргументом, а не по `const ctx = …`: переименование
        // переменной результата — безобидный рефакторинг, и краснеть на нём барьер не должен.
        // Пробелы и переносы допускаются: вызов, разложенный форматтером на строки при
        // добавлении зависимостей, — безобидный рефакторинг, а не перестановка.
        const preflightAt = [...source.matchAll(/[^.\w]preflight\(\s*config[\s,)]/g)].map(
            (m) => m.index,
        );
        expect(chdirAt.length, 'не нашёл переездов в worktree в main()').toBeGreaterThan(0);
        expect(preflightAt, 'не нашёл вызова preflight(config) в main()').toHaveLength(1);
        // Именно ВСЕ, а не первый: ветка dry и ветка живого прогона зовут chdir порознь, и
        // проверка «первое вхождение раньше» пропустила бы перестановку во второй из них.
        expect(Math.max(...chdirAt)).toBeLessThan(preflightAt[0]);
    });
});

// #181: синк зависимостей обязан стоять сразу за переездом в дерево раннера, а не только в
// гейте мерджа. Проверка структурная — по исходнику main(), потому что сам main() поднимает
// worktree, монитор и лок, и гонять его в тестах дороже, чем сторожить порядок двух строк.
// Цена пропуска известна: 24.08 фаза встала целиком (pre-push красный на чужих зависимостях).
describe('#181: зависимости синхронятся при переезде в дерево раннера', () => {
    const SRC = fs.readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf-8').split('\n');

    it('syncDepsIfLockChanged зовётся рядом с chdir в дерево раннера', () => {
        const chdir = SRC.findIndex(
            (l) => l.includes('process.chdir(worktreePath)') && !l.trim().startsWith('//'),
        );
        expect(chdir).toBeGreaterThan(-1);
        const window = SRC.slice(chdir, chdir + 15).join('\n');
        expect(window).toContain('syncDepsIfLockChanged(');
    });

    // Синк ДОБАВЛЕН на старт, а не ПЕРЕНЕСЁН со своего прежнего места: гейт гоняет чеки на
    // голове PR, чей lock может отличаться от того, что стоял на старте прогона.
    it('синк в гейте мерджа остался на месте', () => {
        const gate = fs.readFileSync(new URL('./gate.ts', import.meta.url), 'utf-8');
        expect(gate).toContain('syncDepsFn(');
    });
});

// #43: выбор кандидата итерации вынесен из тела runLoop чистой функцией — юниты здесь,
// сквозной сценарий закрытия человеком — в tests/coder-stage-restart.test.ts.
describe('pickLiveCandidate (#43)', () => {
    const issues = [{ number: 1 }, { number: 2 }, { number: 3 }];
    const open = (n: number) => ({ number: n, title: `t${String(n)}`, body: '', open: true });
    const shut = (n: number) => ({ ...open(n), open: false });

    it('закрытые человеком пропускаются до первой открытой; прочитанное отдаётся наверх', () => {
        const readIssue = vi.fn((n: number) => (n < 3 ? shut(n) : open(n)));
        const logFn = vi.fn();
        const r = pickLiveCandidate({ issues, milestone: 'M', resume: null, readIssue, logFn });
        expect(r.closed).toEqual([1, 2]);
        expect(r.issues).toEqual([{ number: 3 }]);
        expect(r.picked).toEqual({ number: 3, details: open(3) });
        expect(logFn).toHaveBeenCalledTimes(2);
    });

    it('`open` не задан — «не знаю», карточка берётся по списку', () => {
        const details = { number: 1, title: 't', body: '' };
        const r = pickLiveCandidate({
            issues,
            milestone: 'M',
            resume: null,
            readIssue: () => details,
            logFn: vi.fn(),
        });
        expect(r.picked).toEqual({ number: 1, details });
        expect(r.closed).toEqual([]);
    });

    it('отказ чтения не решается здесь: кандидат не выбран, очередь не тронута', () => {
        const r = pickLiveCandidate({
            issues,
            milestone: 'M',
            resume: null,
            readIssue: () => {
                throw new Error('нет сети');
            },
            logFn: vi.fn(),
        });
        expect(r).toEqual({ issues, picked: null, closed: [] });
    });

    it('продолжаемая попытка: кандидат — её карточка, а после доведённой сессии не читается вовсе', () => {
        const readIssue = vi.fn(open);
        const before = pickLiveCandidate({
            issues,
            milestone: 'M',
            resume: { milestone: 'M', issue: 2, resumeStage: 'session' },
            readIssue,
            logFn: vi.fn(),
        });
        expect(before.picked?.number).toBe(2);

        readIssue.mockClear();
        const after = pickLiveCandidate({
            issues,
            milestone: 'M',
            resume: { milestone: 'M', issue: 2, resumeStage: 'intents' },
            readIssue,
            logFn: vi.fn(),
        });
        expect(after.picked).toBeNull();
        expect(readIssue).not.toHaveBeenCalled();
    });

    it('пустая очередь — кандидата нет, чтений нет', () => {
        const readIssue = vi.fn(open);
        const r = pickLiveCandidate({
            issues: [],
            milestone: 'M',
            resume: null,
            readIssue,
            logFn: vi.fn(),
        });
        expect(r.picked).toBeNull();
        expect(readIssue).not.toHaveBeenCalled();
    });
});

// Ревью Фазы 12: отказ пробы перед сессией посреди прогона — стоп «оставлен человеку»,
// а не `process.exit` без пуша: state на диск, пуш с причиной `guard-probe`, затем выход.
describe('sessionSettingsArgs: отказ пробы посреди прогона', () => {
    const roots = {
        productRoot: '/core',
        humanRoot: '/app',
        sessionTree: '/work',
        coreSha: 'a'.repeat(40),
    };
    const brokenSettings = {
        readFileFn: (): string => {
            throw Object.assign(new Error('EACCES: нет прав'), { code: 'EACCES' });
        },
    };

    it('state сохраняется ДО пуша, пуш — одна строка стопа с причиной, затем выход кодом 1', () => {
        const order: string[] = [];
        const pushes: string[] = [];
        expect(() =>
            ralph.sessionSettingsArgs(brokenSettings, {
                roots,
                persistFn: () => order.push('save'),
                pushEventFn: (msg: string) => {
                    order.push('push');
                    pushes.push(msg);
                    return false;
                },
                exitFn: (code: number): never => {
                    order.push(`exit ${String(code)}`);
                    throw new Error('exit');
                },
            }),
        ).toThrow('exit');
        expect(order).toEqual(['save', 'push', 'exit 1']);
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toMatch(/^⛔ Ralph: .*барьер сессии не прошёл пробу/s);
        expect(pushes[0]).toMatch(/Settings сессии не собран: .*EACCES/s);
        expect(pushes[0]).toMatch(/перезапусти loop/);
    });

    it('state не записался — стоп всё равно уходит, и пуш это называет', () => {
        const pushes: string[] = [];
        expect(() =>
            ralph.sessionSettingsArgs(brokenSettings, {
                roots,
                persistFn: () => {
                    throw new Error('ENOSPC');
                },
                pushEventFn: (msg: string) => {
                    pushes.push(msg);
                    return false;
                },
                exitFn: (): never => {
                    throw new Error('exit');
                },
            }),
        ).toThrow('exit');
        expect(pushes[0]).toMatch(/State перед стопом не сохранён: ENOSPC/);
    });

    it('без раскладки корней — пусто, settings не собирается', () => {
        expect(ralph.sessionSettingsArgs({}, { roots: null })).toEqual([]);
    });

    // #225, ревью 16c2: пакет харнесса не принят — стоп с причиной, а не исключение из argv.
    it('запрет субагентов не собрался — стоп guard-probe с причиной, а не бросок', () => {
        const pushes: string[] = [];
        expect(() =>
            ralph.loopDeniedToolsArg({
                deniedFn: () => {
                    throw new Error('запрет субагентов в сессии петли: пакет не принят');
                },
                persistFn: null,
                pushEventFn: (msg: string) => {
                    pushes.push(msg);
                    return false;
                },
                exitFn: (): never => {
                    throw new Error('exit');
                },
            }),
        ).toThrow('exit');
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toMatch(/пакет не принят — флаг запрета субагентов собрать нечем/);
    });

    it('запрет субагентов считается один раз и отдаётся строкой имён', () => {
        expect(ralph.loopDeniedToolsArg()).toBe(ralph.loopDeniedToolsArg());
        expect(ralph.loopDeniedToolsArg().split(',')).toEqual(
            expect.arrayContaining(['Agent', 'ScheduleWakeup']),
        );
    });
});

// #119, #195: сессия Codex — тот же стоп, что у settings Claude, если проба не прошла; дом CLI
// и недоверие проекту собираются там же.
describe('codexSessionFor: барьер, недоверие и дом Codex перед сессией', () => {
    it('настройки дерева не читаются — стоп guard-probe с причиной и выход кодом 1', () => {
        const pushes: string[] = [];
        expect(() =>
            ralph.codexSessionFor(
                {
                    readFileFn: () => {
                        throw new Error('EACCES: нет прав');
                    },
                },
                {
                    tree: '/work',
                    roots: null,
                    persistFn: null,
                    pushEventFn: (msg: string) => {
                        pushes.push(msg);
                        return false;
                    },
                    exitFn: (code: number): never => {
                        throw new Error(`exit ${String(code)}`);
                    },
                },
            ),
        ).toThrow('exit 1');
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toMatch(/барьер сессии не прошёл пробу[\s\S]*Codex не собраны: EACCES/);
    });

    it('проба прошла — регистрация с флагом доверия хуку, недоверие проекту, свой дом', () => {
        const writes: string[] = [];
        const links: string[][] = [];
        const session = ralph.codexSessionFor(
            {
                readFileFn: (p: string) => {
                    if (p.endsWith('.git')) throw new Error('EISDIR');
                    return '{}';
                },
                runHookFn: (_h: unknown, payload: string) => heldRun(payload),
                layersFn: () => [],
                mkdirFn: () => {},
                writeFileFn: (p: string) => writes.push(p),
                existsFn: () => true,
                entryKindFn: () => 'missing',
                linkFn: (target: string, link: string) => links.push([target, link]),
            },
            {
                tree: '/work',
                roots: {
                    productRoot: '/core',
                    humanRoot: '/app',
                    sessionTree: '/work',
                    coreSha: '',
                },
                sourceHome: '/path/to/human/.codex',
                env: {},
            },
        );
        expect(session.args).toContain('--dangerously-bypass-hook-trust');
        expect(session.args).toContain('hooks');
        expect(session.args.slice(-2)).toEqual(codexUntrustArgs(['/work']));
        expect(session.home).toMatch(/codex-session\/home$/);
        expect(writes).toEqual([path.join(session.home, 'config.toml')]);
        expect(links).toEqual([
            ['/path/to/human/.codex/auth.json', path.join(session.home, 'auth.json')],
        ]);
    });

    it('слой .codex/ в дереве — стоп guard-probe с путём и секциями, дом не собирается', () => {
        const pushes: string[] = [];
        const mkdirFn = vi.fn();
        expect(() =>
            ralph.codexSessionFor(
                {
                    readFileFn: () => '{}',
                    runHookFn: (_h: unknown, payload: string) => heldRun(payload),
                    layersFn: () => ['/work/.codex/config.toml: слой (секции: mcp_servers)'],
                    mkdirFn,
                },
                {
                    tree: '/work',
                    roots: {
                        productRoot: '/core',
                        humanRoot: '/app',
                        sessionTree: '/work',
                        coreSha: '',
                    },
                    sourceHome: null,
                    env: {},
                    persistFn: null,
                    pushEventFn: (msg: string) => {
                        pushes.push(msg);
                        return false;
                    },
                    exitFn: (code: number): never => {
                        throw new Error(`exit ${String(code)}`);
                    },
                },
            ),
        ).toThrow('exit 1');
        expect(pushes[0]).toMatch(
            /слои конфига Codex[\s\S]*\.codex\/config\.toml[\s\S]*mcp_servers/,
        );
        expect(mkdirFn).not.toHaveBeenCalled();
    });

    // Ревью Фазы 16b: пустая регистрация пускала codex exec без хука — теперь стоп.
    it('вне main (дерево не задано) — стоп guard-probe, а не codex exec без хука', () => {
        const pushes: string[] = [];
        expect(() =>
            ralph.codexSessionFor(
                {},
                {
                    tree: null,
                    persistFn: null,
                    pushEventFn: (msg: string) => {
                        pushes.push(msg);
                        return false;
                    },
                    exitFn: (code: number): never => {
                        throw new Error(`exit ${String(code)}`);
                    },
                },
            ),
        ).toThrow('exit 1');
        expect(pushes[0]).toMatch(/Дерево сессии для регистрации барьера Codex не задано/);
    });
});

// Ревью Фазы 16c: версия CLI, с которой снято описание пакета, не сверялась, а перечни полей
// строгие — автообновление CLI блокировало бы каждый вызов, и старт этого не видел.
describe('версия CLI против описания пакета — строка ⚠ один раз на версию', () => {
    it('расхождение названо однажды, совпадение и «не прочиталась» — молчат', () => {
        const registry = {
            packages: new Map([['h', { descriptor: { cliVersion: '1.0.0' } }]]),
            problems: new Map(),
        } as never;
        const lines: string[] = [];
        const warn = (v: string) =>
            ralph.warnCliVersionDrift('h', v, { logFn: (m: string) => lines.push(m), registry });
        warn('1.0.0');
        warn('unknown');
        warn('1.1.0');
        warn('1.1.0');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^⚠ описание пакета «h» снято с CLI 1\.0\.0, исполняется 1\.1\.0/);
    });

    it('проводка: версия перед сессией сверяется с описанием', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8');
        const start = src.indexOf('    function sessionCliVersion(');
        const body = src.slice(start, src.indexOf('\n    }\n', start));
        expect(body).toMatch(/driftFn\(id\.harness, v\.version\)/);
    });
});

// #215: сверка инвентаря MCP перед сессией — диагноз строкой ⚠, ни стопа, ни разрешения.
describe('инвентарь MCP перед сессией — диагноз дрейфа', () => {
    const run = (res: unknown, root: string | null = '/path/to/app') => {
        const lines: string[] = [];
        const checkFn = vi.fn(() => res as never);
        ralph.warnMcpDrift({
            logFn: (m: string) => lines.push(m),
            consumerRoot: root,
            checkFn,
            fingerprintFn: () => 'f',
            memo: { key: null, at: 0 },
            dry: false,
        });
        return { lines, checkFn };
    };

    it('без roots снимок не читается вовсе', () => {
        const { lines, checkFn } = run({ status: 'clean' }, null);
        expect(checkFn).not.toHaveBeenCalled();
        expect(lines).toEqual([]);
    });

    it('дрейф назван дрейфом конфигурации, а не транзиентом, один раз на текст', () => {
        const drift = { status: 'drift', lines: ['MCP forge: добавлены mcp__forge__New'] };
        const first = run(drift);
        expect(first.checkFn).toHaveBeenCalledWith('/path/to/app');
        expect(first.lines[0]).toMatch(/дрейф конфигурации, а не транзиент/);
        expect(first.lines[0]).toMatch(/PR обновления снимка под ship/);
        expect(first.lines[1]).toBe('   MCP forge: добавлены mcp__forge__New');
        expect(run(drift).lines).toEqual([]);
    });

    it('совпадение молчит; нет снимка, битый снимок, молчащий сервер и бросок — ⚠ с причиной', () => {
        expect(run({ status: 'clean' }).lines).toEqual([]);
        expect(run({ status: 'invalid', problems: ['битый-215'] }).lines).toEqual([
            expect.stringMatching(/^⚠ Снимок инвентаря MCP не прошёл проверку/),
            '   битый-215',
        ]);
        expect(run({ status: 'unreachable', problems: ['сервер s-215: молчит'] }).lines[1]).toBe(
            '   сервер s-215: молчит',
        );
        const lines: string[] = [];
        ralph.warnMcpDrift({
            logFn: (m: string) => lines.push(m),
            consumerRoot: '/path/to/app',
            checkFn: () => {
                throw new Error('бросок-215');
            },
            fingerprintFn: () => 'f',
            memo: { key: null, at: 0 },
            dry: false,
        });
        expect(lines).toEqual([expect.stringMatching(/не собран/), '   бросок-215']);
    });

    // Ревью 16c3: опрос перед КАЖДОЙ сессией поднимал все серверы заново.
    it('тот же отпечаток файлов в пределах срока — серверы не опрашиваются повторно', () => {
        const memo = { key: null, at: 0 };
        let now = 1_000;
        let print = 'a';
        const checkFn = vi.fn(() => ({ status: 'clean' }) as never);
        const once = () =>
            ralph.warnMcpDrift({
                logFn: () => {},
                consumerRoot: '/path/to/app',
                checkFn,
                fingerprintFn: () => print,
                nowFn: () => now,
                memo,
                dry: false,
            });
        once();
        once();
        expect(checkFn).toHaveBeenCalledTimes(1);
        print = 'b';
        once();
        expect(checkFn).toHaveBeenCalledTimes(2);
        now += 60 * 60_000;
        once();
        expect(checkFn).toHaveBeenCalledTimes(3);
    });

    it('сухой прогон серверов не порождает', () => {
        const checkFn = vi.fn(() => ({ status: 'clean' }) as never);
        ralph.warnMcpDrift({
            logFn: () => {},
            consumerRoot: '/path/to/app',
            checkFn,
            fingerprintFn: () => 'f',
            memo: { key: null, at: 0 },
            dry: true,
        });
        expect(checkFn).not.toHaveBeenCalled();
    });

    it('проводка: опрос перед сессией идёт с cwd дерева человека и запретом ключей', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8');
        const start = src.indexOf('    function warnMcpDrift(');
        const body = src.slice(start, src.indexOf('\n    }\n', start));
        expect(body).toMatch(
            /stdioListPage\(server, cfg, cursor, \{ cwd: root, deniedEnv: mcpDeniedEnv\(\) \}\)/,
        );
    });

    // Строка «снимка нет» — одна на прогон, поэтому её видит только этот кейс.
    it('боевая проверка: снимка в дереве нет — absent, серверы не опрашиваются', () => {
        const dir = fs.mkdtempSync(path.join(tmpdir(), 'ralph-mcp-drift.'));
        try {
            const lines: string[] = [];
            ralph.warnMcpDrift({
                logFn: (m: string) => lines.push(m),
                consumerRoot: dir,
                memo: { key: null, at: 0 },
                dry: false,
            });
            expect(lines.join('\n')).toMatch(/Снимка инвентаря MCP нет/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('проводка: сверка стоит в sessionCliVersion — общей точке перед сессией', () => {
        const fn = vi.fn();
        ralph.sessionCliVersion('nope', undefined, undefined, undefined, fn);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

// Ревью Фазы 12: в раскладке без `roots` контракта нет, и барьер скиллов в сессиях петли
// снимался молча. Раннер включает его переключателем в env сессии.
describe('барьер скиллов без roots — переключатель в env сессии', () => {
    it('выключено (есть roots или вне main) — env как был, в том числе «наследуй»', () => {
        expect(ralph.withSkillGuard(undefined, { A: '1' }, false)).toBeUndefined();
        const env = { A: '1' };
        expect(ralph.withSkillGuard(env, {}, false)).toBe(env);
    });

    it('включено — RALPH_SKILL_GUARD=on поверх env сессии или наследуемого, off раннера не проходит', () => {
        expect(ralph.withSkillGuard(undefined, { A: '1', RALPH_SKILL_GUARD: 'off' }, true)).toEqual(
            {
                A: '1',
                RALPH_SKILL_GUARD: 'on',
            },
        );
        expect(ralph.withSkillGuard({ B: '2' }, { A: '1' }, true)).toEqual({
            B: '2',
            RALPH_SKILL_GUARD: 'on',
        });
    });

    // Ревью Фазы 12: контракт и путь данных контура раннер кладёт только в команду своего
    // хука; унаследованные из окружения запуска, они достались бы хукам дерева сессии.
    it('RALPH_CORE_SHA и RALPH_HOOKS_DATA из окружения раннера в env сессии не попадают', () => {
        const base = { A: '1', RALPH_CORE_SHA: 'f'.repeat(40), RALPH_HOOKS_DATA: '/x/hooks.json' };
        expect(ralph.withSkillGuard(undefined, base, false)).toEqual({ A: '1' });
        expect(ralph.withSkillGuard({ ...base }, {}, true)).toEqual({
            A: '1',
            RALPH_SKILL_GUARD: 'on',
        });
        expect(base.RALPH_CORE_SHA).toBe('f'.repeat(40));
    });

    // #184: доверенный контекст сессии едет в env каждой сессии петли; унаследованный из
    // окружения раннера (раннер запущен из сессии петли) — не проходит.
    it('контекст сессии — в env сессии, унаследованный снимается', () => {
        const ctx = '{"loop":true}';
        expect(ralph.withSkillGuard(undefined, { A: '1' }, false, ctx)).toEqual({
            A: '1',
            RALPH_SESSION_CONTEXT: ctx,
        });
        expect(
            ralph.withSkillGuard(
                undefined,
                { A: '1', RALPH_SESSION_CONTEXT: 'чужой' },
                false,
                null,
            ),
        ).toEqual({ A: '1' });
        expect(ralph.withSkillGuard({ RALPH_SESSION_CONTEXT: 'чужой' }, {}, true, ctx)).toEqual({
            RALPH_SKILL_GUARD: 'on',
            RALPH_SESSION_CONTEXT: ctx,
        });
    });

    it('контекст: вне main() его нет, с деревом — оба корня, без абсолютного дерева — стоп', () => {
        expect(ralph.sessionContextValue({ tree: null, roots: null })).toBeNull();
        const noRoots = JSON.parse(
            ralph.sessionContextValue({ tree: '/path/to/app', roots: null }) as string,
        );
        expect(noRoots).toMatchObject({
            loop: true,
            coreRevision: '',
            roots: { consumer: '/path/to/app', execution: '/path/to/app' },
        });
        const withRoots = JSON.parse(
            ralph.sessionContextValue({
                tree: '/path/to/app-ralph',
                roots: {
                    productRoot: '/core',
                    humanRoot: '/path/to/app',
                    sessionTree: '/path/to/app-ralph',
                    coreSha: 'a'.repeat(40),
                },
            }) as string,
        );
        expect(withRoots.roots).toEqual({
            consumer: '/path/to/app',
            execution: '/path/to/app-ralph',
        });
        const pushes: string[] = [];
        expect(() =>
            ralph.sessionContextValue({
                tree: 'app',
                roots: null,
                persistFn: null,
                pushEventFn: (msg: string) => {
                    pushes.push(msg);
                    return false;
                },
                exitFn: (code: number): never => {
                    throw new Error(`exit ${String(code)}`);
                },
            }),
        ).toThrow('exit 1');
        expect(pushes[0]).toMatch(/Контекст сессии не собран/);
    });

    it('проводка: main() собирает контекст до пробы старта и отдаёт его пробе', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8');
        const main = src.slice(src.indexOf('function main('));
        const built = main.indexOf('const startContext = loopSessionContext(');
        const probe = main.indexOf('ensureGuardHolds(sessionTree, {');
        expect(built).toBeGreaterThan(-1);
        expect(probe).toBeGreaterThan(built);
        expect(main.slice(probe, probe + 400)).toMatch(/sessionContext: startContext/);
        expect(main.slice(built, probe)).toMatch(/if \(!startContext\.ok\) fail\(/);
    });

    it('проводка: main() включает его в ветке без roots, оба claude-спавна идут через него', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8');
        const main = src.slice(src.indexOf('function main('));
        const noRoots = main.indexOf('log(describeSessionSettingsStart(null))');
        const on = main.indexOf('skillGuardByEnv = true;');
        expect(on).toBeGreaterThan(-1);
        expect(noRoots - on).toBeGreaterThan(0);
        expect(noRoots - on).toBeLessThan(100);
        expect(src).toMatch(/withSkillGuard\(claudeSessionEnv\(authToken\)\)/);
        expect(src).toMatch(/withSkillGuard\(buildKimiSpawnEnv\(/);
    });

    // Ревью Фазы 16c: сторожились только два claude-спавна, и снятие `withSkillGuard` у Codex,
    // Kimi Code или OpenCode проходило зелёным — их сессия шла бы без контекста петли.
    it.each([
        ['runKimiOnce', 'spawnClaude', /withSkillGuard\(buildKimiSpawnEnv\(/],
        ['runOpenAIOnce', 'spawnCodex', /withSkillGuard\(openaiEnv\)/],
        ['runKimiNativeOnce', 'spawnKimiNative', /withSkillGuard\(buildKimiNativeSpawnEnv\(/],
        ['runOpencodeOnce', 'spawnOpencode', /withSkillGuard\(buildOpencodeSpawnEnv\(/],
    ])('проводка: %s отдаёт %s env из withSkillGuard', (fn, spawn, guarded) => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8');
        const start = src.indexOf(`    function ${fn}(`);
        expect(start).toBeGreaterThan(-1);
        const body = src.slice(start, src.indexOf('\n    }\n', start));
        expect(body).toMatch(new RegExp(`const env = ${guarded.source}`));
        // Спавн получает именно этот env, а не собранный рядом мимо него.
        expect(body).toMatch(new RegExp(`${spawn}\\([^;]*\\benv\\b`));
        expect(body).not.toMatch(/\benv:\s*process\.env\b[^;]*\bprompt\b/);
    });

    it('живой env Codex-сессии несёт контекст петли (#184)', () => {
        const ctx = '{"loop":true}';
        const env = ralph.withSkillGuard({ OPENAI_API_KEY: 'k' }, {}, false, ctx);
        expect(env).toEqual({ OPENAI_API_KEY: 'k', RALPH_SESSION_CONTEXT: ctx });
    });

    it('проводка: проба settings и env сессии — один контекст, null не прячется приведением', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8');
        const start = src.indexOf('    function sessionSettingsArgs(');
        const body = src.slice(start, src.indexOf('\n    }\n', start));
        expect(body).not.toMatch(/context as string/);
        expect(body).toMatch(/if \(context === null\)/);
        expect(body).toMatch(/probedSessionContext = context;/);
        expect(src).toMatch(/context: string \| null = takeSessionContext\(\)/);
    });
});

// #9: канал намерений — вывод сессии. Сессия больше не пишет файл очереди команд
// оркестратора (харнесс эту запись режет); раннер разбирает вывод своего дочернего процесса
// и дописывает файл сам. Дальше — прежнее применение, поэтому сценарии ниже идут сквозь
// него: «доехало до форжа» проверяется вызовами шва, а не содержимым файла.
describe('collectSessionIntents: намерения из вывода сессии пишет раннер (#9)', () => {
    const CFG = { issueLabels: ['complexity:low'] };
    const line = (o: unknown) => JSON.stringify(o);
    const comment = line({ kind: 'comment', issue: 9, comment: 'что сделано' });
    const close = line({ kind: 'close', issue: 9, comment: 'закрываю' });
    const block = (...inner: string[]) => [INTENTS_BEGIN, ...inner, INTENTS_END].join('\n');

    // Файл намерений в памяти: раннер — единственный, кто в него пишет.
    const memFile = (initial: string | null = null) => {
        let text = initial;
        return {
            read: () => text,
            write: (t: string) => {
                text = t;
            },
            remove: () => {
                text = null;
            },
            get text() {
                return text;
            },
        };
    };
    const taskSource = () => {
        const calls: string[] = [];
        return {
            calls,
            ts: {
                commentOnIssue: (n: number, body: string) =>
                    calls.push(`comment:${n}:${body.replace(/\n\n<!-- ralph-intent:.* -->$/, '')}`),
                closeIssue: (n: number) => calls.push(`close:${n}`),
                blockIssue: () => {},
                createIssue: () => 1,
                listIssueComments: () => [],
            },
        };
    };
    const collect = (output: string, file: ReturnType<typeof memFile>, logFn = vi.fn()) =>
        ralph.collectSessionIntents(output, {
            readFn: file.read,
            writeFn: file.write,
            logFn,
            dry: false,
        });
    const apply = (file: ReturnType<typeof memFile>, ts: object, logFn = vi.fn()) => {
        const pushEventFn = vi.fn();
        const quarantined: string[] = [];
        const res = ralph.applySessionRequests({
            cfg: CFG,
            currentMilestone: 'Фаза',
            dry: false,
            readFn: file.read,
            writeFn: file.write,
            removeFn: file.remove,
            taskSource: ts,
            logFn,
            pushEventFn,
            sleepFn: () => {},
            intentIdFn: () => 'abcdef12-0000',
            quarantineFn: () => {
                quarantined.push(String(file.text));
                file.remove();
                return '/path/to/state/ralph.requests.jsonl.rejected-x';
            },
        });
        return { res, pushEventFn, quarantined };
    };

    it('блок в выводе доезжает до форжа без записи файла сессией', () => {
        const file = memFile();
        collect(`Работа сделана.\n${block(comment, close)}\n`, file);
        const { ts, calls } = taskSource();
        const { res } = apply(file, ts);
        expect(res.failed).toBe(false);
        expect(calls).toEqual(['comment:9:что сделано', 'comment:9:закрываю', 'close:9']);
        expect(file.text).toBeNull();
    });

    it('вывод без блока файл не трогает вовсе', () => {
        const write = vi.fn();
        const read = vi.fn(() => null);
        ralph.collectSessionIntents('просто отчёт', { readFn: read, writeFn: write, dry: false });
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it('строки дописываются за неприменённым хвостом, а не затирают его', () => {
        const file = memFile(comment);
        collect(block(close), file);
        expect(file.text).toBe(`${comment}\n${close}\n`);
    });

    it('совместимость: файл, записанный сессией по-старому, всё ещё применяется', () => {
        const file = memFile(`${comment}\n`);
        const { ts, calls } = taskSource();
        expect(apply(file, ts).res.failed).toBe(false);
        expect(calls).toEqual(['comment:9:что сделано']);
    });

    it('dry-run: блок назван в логе, файл не пишется', () => {
        const write = vi.fn();
        const logFn = vi.fn();
        ralph.collectSessionIntents(block(close), {
            readFn: () => null,
            writeFn: write,
            logFn,
            dry: true,
        });
        expect(write).not.toHaveBeenCalled();
        expect(String(logFn.mock.calls[0][0])).toMatch(/dry-run/);
    });

    // Критерий карточки «от противного»: битый блок → батч не применяется ЦЕЛИКОМ, даже его
    // корректные строки и даже хвост, лежавший в файле до сессии, и причина — в логе.
    it.each([
        ['незакрытый блок', `${INTENTS_BEGIN}\n${comment}\n${close}`, /не закрыт/],
        ['мусор внутри блока', block(comment, 'это не json', close), /не разобралось как JSON/],
        ['подделанная метка раннера', block(inFlightMarker('abcdef12-9999'), close), /служебн/],
    ])('от противного: %s — ничего не применено, причина в логе', (_, output, why) => {
        const file = memFile(`${comment}\n`);
        const logFn = vi.fn();
        collect(output, file, logFn);
        const { ts, calls } = taskSource();
        const { res, pushEventFn, quarantined } = apply(file, ts, logFn);
        expect(calls).toEqual([]);
        expect(res.failed).toBe(true);
        expect(res.closedIssues).toEqual([]);
        expect(quarantined).toHaveLength(1);
        expect(String(pushEventFn.mock.calls[0][0])).toMatch(why);
        // Боевой pushEvent пишет строку и в лог — здесь он подменён, поэтому склеиваем.
        const logged = [...logFn.mock.calls, ...pushEventFn.mock.calls]
            .map((c) => String(c[0]))
            .join('\n');
        expect(logged).toMatch(why);
        // Текст отвергнутого — в логе целиком: последняя воля сессии не теряется молча.
        expect(logFn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(close);
    });

    it('runClaude разбирает вывод каждого запуска, включая упёршийся в лимит', () => {
        const outputs: string[] = [];
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce(claudeRun(1, "You've hit your session limit · resets 11am"))
            .mockReturnValueOnce({ code: 0, output: block(close) });
        ralph.runClaude(
            'промпт',
            {},
            {
                pushEventFn: vi.fn(),
                sleepFn: vi.fn(),
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { apiLimitMaxWaits: 3, apiLimitGraceMin: 0 },
                collectIntentsFn: (o: string) => outputs.push(o),
            },
        );
        expect(outputs).toEqual(["You've hit your session limit · resets 11am", block(close)]);
    });

    it('лимит после блока → повтор с тем же блоком → одно намерение в файле', () => {
        const file = memFile();
        const logFn = vi.fn();
        const runClaudeOnceFn = vi
            .fn()
            .mockReturnValueOnce({
                ...claudeRun(1, `${block(comment, close)}\nYou've hit your session limit`),
            })
            .mockReturnValueOnce({ code: 0, output: block(comment, close) });
        ralph.runClaude(
            'промпт',
            {},
            {
                pushEventFn: vi.fn(),
                sleepFn: vi.fn(),
                ensureTunnelFn: () => true,
                runClaudeOnceFn,
                cfg: { apiLimitMaxWaits: 3, apiLimitGraceMin: 0 },
                collectIntentsFn: (o: string, opts: { seen: Set<string> }) =>
                    ralph.collectSessionIntents(o, {
                        readFn: file.read,
                        writeFn: file.write,
                        logFn,
                        dry: false,
                        ...opts,
                    }),
            },
        );
        expect(runClaudeOnceFn).toHaveBeenCalledTimes(2);
        expect(file.text).toBe(`${comment}\n${close}\n`);
        expect(logFn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/не дописаны второй/);
    });

    it('одинаковые строки внутри одного блока — воля сессии, сверка их не трогает', () => {
        const file = memFile();
        ralph.collectSessionIntents(block(comment, comment), {
            readFn: file.read,
            writeFn: file.write,
            logFn: vi.fn(),
            dry: false,
            seen: new Set<string>(),
        });
        expect(file.text).toBe(`${comment}\n${comment}\n`);
    });
});

// #217: переспрос сессии-исправления при неразобранном батче намерений. Ночь 27→28.10 —
// восемь стопов сдачи подряд на батче с `type`/`body` вместо `kind`/`comment`, и каждый
// рестарт повторял ревью целиком. Здесь — применение после переспроса, отказы сверки «от
// противного», второй отказ подряд без второго переспроса и запуск без инструментов у
// каждого рантайма.
describe('#217: переспрос намерений при отказе разбора батча', () => {
    const CFG = { issueLabels: ['area:devops'], model: 'claude-sonnet-5' };
    const PHASE = { branch: 'feature/m1' };
    const line = (o: unknown) => JSON.stringify(o);
    const DRIFTED = [
        line({
            type: 'pr-comment',
            body: '🔴 [blocker] теряется отказ',
            path: 'core/a.ts',
            line: 42,
        }),
        line({ type: 'pr-comment', body: 'сводка прохода' }),
    ].join('\n');
    const FIXED = [
        line({
            kind: 'pr-comment',
            comment: '🔴 [blocker] теряется отказ',
            path: 'core/a.ts',
            line: 42,
        }),
        line({ kind: 'pr-comment', comment: 'сводка прохода' }),
    ].join('\n');
    const block = (lines: string) =>
        `готово\n<<<RALPH-INTENTS>>>\n${lines}\n<<<END-RALPH-INTENTS>>>\n`;
    const TOOLLESS = { turnLimit: 'required', fallbackModel: true, toolless: true };

    // Сессия-исправление фейком runClaude: отдаёт вывод и пишет, с чем её запустили.
    const fakeRepairSession = (output: string, code = 0) => {
        const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
        const fn = (
            prompt: string,
            opts: Record<string, unknown>,
            hooks: {
                onOutput?: (o: string, e: string) => void;
                collectIntentsFn?: (o: string, x: { seen: Set<string> }) => void;
            } = {},
        ) => {
            calls.push({ prompt, opts });
            // Боевой runClaude отдаёт вывод сборщику намерений — пустой сборщик и есть
            // гарантия, что ответ исправления не ляжет в файл мимо сверки.
            hooks.collectIntentsFn?.(output, { seen: new Set() });
            hooks.onOutput?.(output, 'completed');
            return code;
        };
        return { fn, calls };
    };

    const prSource = () => {
        const calls: string[] = [];
        return {
            calls,
            ts: {
                commentOnIssue: () => {},
                closeIssue: () => {},
                blockIssue: () => {},
                createIssue: () => 1,
                findOpenPullRequest: () => ({ number: 55, labels: [] }),
                commentOnPullRequest: (_n: number, input: { body: string; anchor?: unknown }) =>
                    calls.push(
                        `${JSON.stringify(input.anchor ?? null)}:${input.body.replace(/\n\n<!-- ralph-intent:[A-Za-z0-9-]+ -->$/, '')}`,
                    ),
                addBlockedLabel: () => {},
            },
        };
    };

    const apply = (
        raw: string,
        repairFn: ((b: string, w: string) => unknown) | undefined,
        over: Record<string, unknown> = {},
    ) => {
        const { ts, calls } = prSource();
        const logs: string[] = [];
        const pushes: string[] = [];
        const writes: string[] = [];
        let file = raw;
        const res = ralph.applySessionRequests({
            cfg: CFG,
            phase: PHASE,
            currentMilestone: 'M1',
            dry: false,
            readFn: () => file,
            writeFn: (t: string) => {
                writes.push(t);
                file = t;
            },
            removeFn: () => {
                file = '';
            },
            taskSource: ts,
            logFn: (m: string) => void logs.push(m),
            pushEventFn: (m: string) => void pushes.push(m),
            sleepFn: () => {},
            intentIdFn: () => 'a1b2c3d4-e5f6',
            repairFn,
            ...over,
        });
        return { res, calls, logs, pushes, writes };
    };

    const repairWith =
        (session: ReturnType<typeof fakeRepairSession>, caps: unknown = TOOLLESS) =>
        (b: string, w: string) =>
            ralph.repairIntentBatch(b, w, {
                runClaudeFn: session.fn,
                capabilities: caps,
                cfg: CFG,
                logFn: () => {},
            });

    it('батч с type/body у pr-comment после переспроса применяется, в логе строка переспроса', () => {
        const session = fakeRepairSession(block(FIXED));
        const { res, calls, logs, writes } = apply(DRIFTED, repairWith(session));
        expect(res.failed).toBe(false);
        expect(res.applied).toBe(2);
        expect(calls).toEqual([
            '{"path":"core/a.ts","line":42}:🔴 [blocker] теряется отказ',
            'null:сводка прохода',
        ]);
        expect(logs).toContainEqual(
            '🔁 Переспрос намерений: исправлено 2 строк (type→kind, body→comment).',
        );
        // Исправленный батч — на диске до первого эффекта: рестарт посреди применения
        // нашёл бы иначе исходный, битый.
        expect(writes[0]).toBe(`${FIXED}\n`);
        // Сессии ушли отвергнутый батч и ошибка разбора с номером строки.
        expect(session.calls).toHaveLength(1);
        expect(session.calls[0].prompt).toContain(DRIFTED.split('\n')[0]);
        expect(session.calls[0].prompt).toMatch(/строка 1/);
    });

    it('сессия-исправление идёт без инструментов, с малым бюджетом ходов и без записи в файл', () => {
        const session = fakeRepairSession(block(FIXED));
        expect(repairWith(session)(DRIFTED, 'Запрос сессии, строка 1: …')).toEqual({
            ok: true,
            text: FIXED,
        });
        expect(session.calls[0].opts).toEqual({
            model: 'claude-sonnet-5',
            maxTurns: 2,
            toolless: true,
        });
    });

    // От противного: исправление, сменившее смысл, отвергается, и петля встаёт с причиной.
    it.each([
        ['текст', FIXED.replace('сводка прохода', 'всё хорошо')],
        ['файл якоря', FIXED.replace('core/a.ts', 'core/b.ts')],
        ['строку якоря', FIXED.replace('"line":42', '"line":41')],
        ['число строк', `${FIXED}\n${line({ kind: 'pr-block', comment: 'блок' })}`],
    ])('исправление, сменившее %s, отвергается сверкой — стоп с причиной', (_what, bad) => {
        const { res, calls, pushes, writes, logs } = apply(DRIFTED, () => ({
            ok: true,
            text: bad,
        }));
        expect(res.failed).toBe(true);
        expect(calls).toEqual([]);
        expect(writes).toEqual([]);
        // Текст предложенной правки — в лог: по нему человек решает, править ли батч руками.
        expect(logs).toContainEqual(`Отвергнутое исправление:\n${bad}`);
        expect(pushes).toHaveLength(1);
        // Причины обоих разборов: исходная ошибка и отказ сверки.
        expect(pushes[0]).toMatch(/строка 1: неизвестный kind/);
        expect(pushes[0]).toMatch(/исправление отвергнуто сверкой с исходным/);
    });

    it('исправление, сменившее адресат карточки, отвергается', () => {
        const raw = line({ kind: 'close', issue: 7, body: 'сделано' });
        const { res, pushes } = apply(raw, () => ({
            ok: true,
            text: line({ kind: 'close', issue: 8, comment: 'сделано' }),
        }));
        expect(res.failed).toBe(true);
        expect(pushes[0]).toMatch(/поле issue было 7/);
    });

    it('второй отказ подряд — стоп без второго переспроса, причины обоих разборов', () => {
        const repairFn = vi.fn(() => ({ ok: true, text: DRIFTED.replace(/type/g, 'kind_') }));
        const { res, calls, pushes } = apply(DRIFTED, repairFn);
        expect(repairFn).toHaveBeenCalledTimes(1);
        expect(res.failed).toBe(true);
        expect(calls).toEqual([]);
        expect(pushes[0]).toMatch(/строка 1: неизвестный kind/);
        expect(pushes[0]).toMatch(/исправление тоже не разобралось: Запрос сессии, строка 1/);
    });

    it('сессия-исправление без блока или с ненулевым кодом — стоп с её причиной', () => {
        const noBlock = repairWith(fakeRepairSession('не смогла'))(DRIFTED, 'x');
        expect(noBlock).toEqual({
            ok: false,
            why: 'переспрос не помог — в ответе исправления нет блока намерений',
        });
        expect(repairWith(fakeRepairSession(block(FIXED), 1))(DRIFTED, 'x')).toMatchObject({
            ok: false,
            why: expect.stringMatching(/кодом 1/),
        });
        expect(
            repairWith(fakeRepairSession(`<<<RALPH-INTENTS>>>\n${FIXED}\n`))(DRIFTED, 'x'),
        ).toMatchObject({ ok: false, why: expect.stringMatching(/блок исправления отвергнут/) });
        const { pushes } = apply(DRIFTED, () => noBlock);
        expect(pushes[0]).toMatch(/нет блока намерений/);
    });

    it('исправление, которое не разобралось, — тоже в лог текстом', () => {
        const bad = '{"kind":"pr-comment"';
        const { res, logs } = apply(DRIFTED, () => ({ ok: true, text: bad }));
        expect(res.failed).toBe(true);
        expect(logs).toContainEqual(`Отвергнутое исправление:\n${bad}`);
    });

    it('отказ рантайма запустить сессию без инструментов — его причина в стопе, а не один код', () => {
        const refusal = "рантайм 'openai' не умеет сессию без инструментов — запуск отменён (#217)";
        expect(repairWith(fakeRepairSession(`${refusal}\n`, 1))(DRIFTED, 'x')).toEqual({
            ok: false,
            why: `переспрос не помог — сессия-исправление вышла с кодом 1: ${refusal}`,
        });
    });

    it('сессия-исправление, бросившая на запуске, — причина строкой, а не исключение', () => {
        const r = ralph.repairIntentBatch(DRIFTED, 'x', {
            runClaudeFn: () => {
                throw new Error('spawn упал');
            },
            capabilities: TOOLLESS,
            cfg: CFG,
            logFn: () => {},
        });
        expect(r).toEqual({
            ok: false,
            why: 'переспрос не помог — сессия-исправление не запустилась: spawn упал',
        });
    });

    it('рантайм без toolless — сессия не запускается вовсе', () => {
        const session = fakeRepairSession(block(FIXED));
        const r = repairWith(session, { turnLimit: 'best-effort', fallbackModel: false })(
            DRIFTED,
            'x',
        );
        expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/toolless/) });
        expect(session.calls).toEqual([]);
    });

    it('батч, который сверять не с чем (не JSON, отказ блока), не переспрашивается', () => {
        const session = fakeRepairSession(block(FIXED));
        for (const raw of ['{оборвано', '{"ralph":"rejected-block","why":"блок не закрыт"}']) {
            expect(repairWith(session)(raw, 'x')).toMatchObject({
                ok: false,
                why: expect.stringMatching(/^переспроса нет/),
            });
        }
        expect(session.calls).toEqual([]);
    });

    it('годный батч и dry-режим переспроса не зовут', () => {
        const repairFn = vi.fn();
        expect(apply(FIXED, repairFn).res.failed).toBe(false);
        apply(DRIFTED, repairFn, { dry: true });
        expect(repairFn).not.toHaveBeenCalled();
    });

    // Применение, а не работоспособность: шаги сдачи применяют намерения одной функцией, и
    // переспрос обязан стоять именно в ней — иначе он есть, но его никто не зовёт.
    it('проводка: сессии сдачи применяют намерения с переспросом', () => {
        const src = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8');
        const at = src.indexOf('const sessionIntentsApplied = (what: string): boolean => {');
        expect(at).toBeGreaterThan(0);
        const body = src.slice(at, src.indexOf('return !res.failed;', at));
        expect(body).toMatch(
            /repairFn: \(batch, why\) =>\s+repairIntentBatch\(batch, why, \{ runClaudeFn, cfg, logFn \}\)/,
        );
    });

    describe('запуск без инструментов — на аргументах каждого рантайма', () => {
        const TOKEN_ENV = 'RALPH_KIMI_AUTH_TOKEN';
        const saved = process.env[TOKEN_ENV];
        beforeEach(() => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            process.env[TOKEN_ENV] = 'sk-moon-217';
        });
        afterEach(() => {
            vi.restoreAllMocks();
            if (saved === undefined) delete process.env[TOKEN_ENV];
            else process.env[TOKEN_ENV] = saved;
        });
        const okSpawn = () =>
            vi.fn<SpawnFake>(() => ({ status: 0, stdout: 'ok', stderr: '', signal: null }));

        it('claude: --tools "" и --strict-mcp-config; без toolless их нет', () => {
            const argv = buildClaudeArgs({ maxTurns: 2, toolless: true }, {});
            expect(argv[argv.indexOf('--tools') + 1]).toBe('');
            expect(argv).toContain('--strict-mcp-config');
            const plain = buildClaudeArgs({ maxTurns: 2 }, {});
            expect(plain).not.toContain('--tools');
            expect(plain).not.toContain('--strict-mcp-config');
        });

        it('kimi (харнесс Claude Code): тот же запрет в argv настоящего запуска', () => {
            const runtime = buildRuntime();
            runtime.setConfigForTests({ ...REAL_CONFIG, kimiRuntime: { model: 'kimi-k2' } });
            const spawnFn = okSpawn();
            runtime.runKimiOnce(
                'x',
                { maxTurns: 2, toolless: true },
                spawnFn as unknown as SpawnSyncFn,
                VERSION_UNREAD,
            );
            const [, argv] = spawnFn.mock.calls[0];
            expect(argv[argv.indexOf('--tools') + 1]).toBe('');
            expect(argv).toContain('--strict-mcp-config');
        });

        // #225: запрет субагентов и отложенного хода — в argv настоящего запуска kimi; у
        // сессии-исправления его заменяет запрет всех инструментов.
        it('kimi (харнесс Claude Code): запрет Agent и ScheduleWakeup в argv запуска петли', () => {
            const runtime = buildRuntime();
            runtime.setConfigForTests({ ...REAL_CONFIG, kimiRuntime: { model: 'kimi-k2' } });
            const spawnFn = okSpawn();
            runtime.runKimiOnce(
                'x',
                { maxTurns: 2 },
                spawnFn as unknown as SpawnSyncFn,
                VERSION_UNREAD,
            );
            const [, argv] = spawnFn.mock.calls[0];
            const denied = argv[argv.indexOf('--disallowedTools') + 1].split(',');
            expect(denied).toEqual(expect.arrayContaining(['Agent', 'ScheduleWakeup']));
            expect(buildClaudeArgs({ maxTurns: 2, toolless: true }, {})).not.toContain(
                '--disallowedTools',
            );
        });

        // Флага запрета ВСЕХ инструментов у этих CLI нет — запуск отменён до spawn.
        type Rt = ReturnType<typeof buildRuntime>;
        it.each([
            [
                'openai',
                (rt: Rt, s: SpawnSyncFn) =>
                    rt.runOpenAIOnce(
                        'x',
                        { maxTurns: 2, toolless: true },
                        s,
                        undefined,
                        VERSION_UNREAD,
                        () => ({ args: [], home: '/h', keys: [] }),
                    ),
            ],
            [
                'kimi-native',
                (rt: Rt, s: SpawnSyncFn) =>
                    rt.runKimiNativeOnce('x', { maxTurns: 2, toolless: true }, s, VERSION_UNREAD, {
                        homeFn: () => '/h',
                        writePromptFn: () => {},
                        removePromptFn: () => {},
                        isDirFn: () => false,
                        sessionTree: '/w',
                    }),
            ],
            [
                'opencode',
                (rt: Rt, s: SpawnSyncFn) =>
                    rt.runOpencodeOnce('x', { maxTurns: 2, toolless: true }, s, VERSION_UNREAD, {
                        configDirFn: () => '/c',
                    }),
            ],
        ])('%s: сессия без инструментов не запускается, причина названа', (name, run) => {
            const runtime = buildRuntime();
            runtime.setConfigForTests(REAL_CONFIG);
            const spawnFn = okSpawn();
            const res = run(runtime, spawnFn as unknown as SpawnSyncFn);
            expect(spawnFn).not.toHaveBeenCalled();
            expect(res).toEqual({
                code: 1,
                output: `рантайм '${name}' не умеет сессию без инструментов — запуск отменён (#217)`,
                failureKind: 'spawn-failed',
                endReason: 'unknown',
            });
        });
    });
});

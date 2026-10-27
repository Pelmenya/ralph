// Отрицательная проба барьера перед первой сессией (канон, задача 6).
//
// Зачем. Сессии петли идут под `--permission-mode bypassPermissions`: в этом режиме
// `permissions.deny` из `.claude/settings.json` не применяется вовсе, и держит ровно одно —
// PreToolUse-хук. Пока хук лежит в дереве, а проводка его не зовёт (снятый matcher,
// опечатка в пути, сломанный require), петля идёт ночью без единого барьера — и об этом
// не узнаёт никто: отказа нет, есть отсутствие отказа. Тест проводки в гейте сторожит
// ТЕКСТ настроек; проба проверяет ПОВЕДЕНИЕ — то, что увидит сессия.
//
// Как. Читаем настройки дерева, где пойдут сессии, берём PreToolUse-хуки, чей matcher
// накрывает инструмент пробы, и подаём каждому вызов на stdin ровно в той форме, в какой
// его подаёт Claude Code. Сам вызов НЕ исполняется — исполняется только хук, поэтому
// «запрещённое» действие безопасно по построению. Пробы двух родов:
//   • запрещённые (рекурсивное удаление, чтение env-файла) — хоть один хук обязан выйти
//     кодом 2. У PreToolUse блокирует ТОЛЬКО exit 2: код 1, таймаут и «не запустился»
//     Claude Code считает ошибкой без блокировки, и вызов исполняется. Поэтому здесь
//     блокировкой считается только 2;
//   • безобидная (`git status`) — все хуки обязаны выйти нулём. Барьер fail-closed:
//     упавшие правила блокируют ВСЁ, и сессия, запущенная на таком барьере, сожгла бы
//     итерацию на отказах. Ловим это до старта, а не в журнале сессии.
//
// Режим отказа — fail-closed (инвариант №1): не прочли настройки, не нашли хука, хук не
// заблокировал — петля не стартует, причина названа в отказе.
//
// Каждый харнесс — своей регистрацией (Фаза 16b, #119). До карточки проба знала только
// Claude-хуки и отвергала любой другой рантайм: честно, но Codex так не мог работать в петле
// вовсе. Теперь правило — «харнесс без доказанного guard не стартует»: регистрация барьера
// строится в формате CLI (`adapters/harness-guard.ts` — argv Codex, `config.toml` Kimi Code,
// плагин OpenCode) из тех же настроек, что получит сессия Claude Code, читается обратно и
// исполняется на событиях в форме этого CLI. Харнесс неизвестен или его регистрация не
// передаётся CLI при запуске (`GUARD_WIRED_HARNESSES`) — отказ с местом в конфиге. Kimi
// через Claude CLI (`kimi`) — харнесс Claude Code и наследует его guard; Kimi Code родным
// харнессом (`kimi-native`) — свой `config.toml` в доме CLI.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис). Standalone-экспорты, как у workspace-trust.ts: контекста фабрики модулю не
// нужно — log/fail приходят параметрами единственного вызова.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import {
    HARNESS_PROBES,
    OPENCODE_PLUGIN_DRIVER,
    opencodeClaudeToolName,
    codexGuardArgs,
    codexGuardFromArgs,
    CODEX_GUARD_LIMIT,
    SKILL_BARRIER_LIMIT,
    harnessHookPayload,
    harnessMatcherCovers,
    kimiHooksFromToml,
    kimiHooksToml,
    opencodeEvent,
    opencodeGuardPlugin,
    opencodeHooksFromPlugin,
    type GuardHook,
    type Harness,
    type HarnessProbe,
} from '../adapters/harness-guard.ts';
import { RUNTIME_IDENTITIES } from '../adapters/runtime-profile.ts';

type LogFn = (msg: string) => void;
type FailFn = (msg: string) => unknown;

/** Один вызов пробы: что подаём хукам и чего от них ждём (в терминах харнесса). */
export type TGuardProbe = HarnessProbe;

/** Состав пробы Claude Code; у остальных харнессов — свой, `HARNESS_PROBES`. */
export const GUARD_PROBES: readonly TGuardProbe[] = HARNESS_PROBES['claude-code'];

/**
 * Хук из настроек: команда оболочки, её таймаут в секундах и почему он НЕ вправе считаться
 * блокирующим (`null` — вправе). Такой хук всё равно запускается: на безобидной пробе он
 * обязан пропустить вызов, как и все.
 */
export type THookCommand = { command: string; timeoutSec: number; cannotBlock: string | null };

/** Исход одного запуска хука: код выхода (null — не завершился сам) и stderr. */
export type THookRun = { status: number | null; stderr: string };

/**
 * `projectDirEnv: false` — хук запускается так, как его зовёт НЕ-Claude харнесс: без
 * `CLAUDE_PROJECT_DIR` в окружении (Codex и Kimi Code её не ставят). Проба, подкладывавшая
 * переменную всем, была зелёной на команде, которая в живой сессии Kimi падала (#120).
 */
export type TRunHookFn = (
    hook: THookCommand,
    payload: string,
    projectDir: string,
    opts?: { projectDirEnv?: boolean },
) => THookRun;

// Claude Code ждёт хук 60 секунд, если таймаут в настройках не задан.
const DEFAULT_TIMEOUT_SEC = 60;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Семантика matcher у Claude Code (`harnessMatcherCovers` знает и остальные харнессы). */
export function matcherCovers(matcher: unknown, toolName: string): boolean {
    return harnessMatcherCovers('claude-code', matcher, toolName);
}

/**
 * Поля записи, при которых exit 2 хука ещё не значит, что сессия будет заблокирована:
 * асинхронный ответ приходит, когда инструмент уже отработал; `once` срабатывает раз за
 * сессию; `if` зовёт хук не на всё. Тот же перечень сторожит сверка проводки
 * (`checkGuardWiring`), но она судит текст, а проба — исход (ревью Kimi).
 */
function cannotBlock(hook: Record<string, unknown>): string | null {
    if (hook.async === true) return 'async: асинхронный хук не блокирует вызов';
    if (hook.once === true) return 'once: срабатывает один раз за сессию';
    if (hook.if !== undefined) return 'if: хук зовут не на каждый вызов';
    return null;
}

/**
 * PreToolUse-хуки, которые Claude Code позовёт на этот инструмент. Битая форма записи
 * пропускается молча: её хук не позовут и в сессии, а отказ пробы назовёт итог — «хука
 * нет», — то есть ровно то, что увидит человек.
 */
export function hooksFor(settings: unknown, toolName: string): THookCommand[] {
    if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return [];
    const entries = settings.hooks.PreToolUse;
    if (!Array.isArray(entries)) return [];
    const out: THookCommand[] = [];
    for (const entry of entries) {
        if (!isPlainObject(entry) || !matcherCovers(entry.matcher, toolName)) continue;
        if (!Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
            if (!isPlainObject(hook) || hook.type !== 'command') continue;
            if (typeof hook.command !== 'string' || hook.command.trim() === '') continue;
            const timeoutSec =
                typeof hook.timeout === 'number' && hook.timeout > 0
                    ? hook.timeout
                    : DEFAULT_TIMEOUT_SEC;
            out.push({ command: hook.command, timeoutSec, cannotBlock: cannotBlock(hook) });
        }
    }
    return out;
}

/** Вход хука в той форме, что подаёт Claude Code. Транскрипта у пробы нет. */
export function probePayload(probe: TGuardProbe, projectDir: string): string {
    return harnessHookPayload('claude-code', probe, projectDir);
}

/**
 * Боевой запуск хука: через оболочку, как его запускает Claude Code (команда в настройках —
 * строка с `${CLAUDE_PROJECT_DIR}`), с тем же каталогом и переменной.
 */
export const runHook: TRunHookFn = (hook, payload, projectDir, opts = {}) => {
    guardSideEffect(`guard-probe: ${hook.command}`, 'Подмени runHookFn в тесте.');
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    // Унаследованная от места запуска переменная тоже снимается: раннер, запущенный из
    // сессии Claude Code, иначе подложил бы её хуку и снова спрятал бы ту же поломку.
    if (opts.projectDirEnv === false) delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync('sh', ['-c', hook.command], {
        cwd: projectDir,
        input: payload,
        encoding: 'utf-8',
        timeout: hook.timeoutSec * 1000,
        env,
    });
    return { status: r.status, stderr: r.stderr ?? String(r.error ?? '') };
};

/** Короткая строка stderr для отказа: хук объясняет себя сам, но не абзацем. */
const brief = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

/** Хук, который проба исполняет: команда, таймаут, matcher харнесса. */
type TProbedHook = THookCommand & { matcher: unknown };

/**
 * Вердикт пробы на списке хуков одного харнесса. Запрещённое: хоть один хук, вправе
 * блокировать, вышел 2. Безобидное: все вышли 0 — барьер fail-closed, и упавшие правила
 * блокируют всё подряд; сессия на таком барьере сожгла бы итерацию на отказах.
 */
function probeHookList(
    harness: Harness,
    hooks: readonly TProbedHook[],
    projectDir: string,
    runHookFn: TRunHookFn,
    payloadFn: (probe: TGuardProbe) => string,
): string[] {
    const problems: string[] = [];
    for (const probe of HARNESS_PROBES[harness]) {
        const covering = hooks.filter((h) =>
            harnessMatcherCovers(harness, h.matcher, probe.toolName),
        );
        if (covering.length === 0) {
            problems.push(
                `${probe.what} (${probe.toolName}): ни один PreToolUse-хук не накрывает ` +
                    `инструмент — без подтверждений вызов прошёл бы без проверки`,
            );
            continue;
        }
        const payload = payloadFn(probe);
        // `CLAUDE_PROJECT_DIR` в окружение хука кладёт только Claude Code — остальным
        // харнессам проба его не подкладывает: регистрация обязана нести каталог сама.
        const projectDirEnv = harness === 'claude-code';
        const runs = covering.map((hook) => ({
            hook,
            run: runHookFn(hook, payload, projectDir, { projectDirEnv }),
        }));
        problems.push(...verdictProblems(probe, runs));
    }
    return problems;
}

function verdictProblems(
    probe: TGuardProbe,
    runs: readonly { hook: THookCommand; run: THookRun }[],
): string[] {
    if (probe.expect === 'blocked') {
        if (runs.some(({ hook, run }) => run.status === 2 && hook.cannotBlock === null)) return [];
        const seen = runs
            .map(({ hook, run }) =>
                hook.cannotBlock
                    ? `${String(run.status)} (${hook.cannotBlock})`
                    : String(run.status),
            )
            .join(', ');
        return [
            `${probe.what} (${probe.toolName}): ни один хук не заблокировал вызов ` +
                `(коды выхода: ${seen}; блокирует только 2)`,
        ];
    }
    return runs
        .filter(({ run }) => run.status !== 0)
        .map(
            ({ hook, run }) =>
                `${probe.what} (${probe.toolName}): хук «${hook.command}» не пропустил её ` +
                `(код ${String(run.status)}${run.stderr ? `: ${brief(run.stderr)}` : ''}) — ` +
                `барьер блокирует всё подряд, сессия на нём не работала бы`,
        );
}

/**
 * PreToolUse-хуки настроек Claude Code, которые проба исполняет. Битая форма записи
 * пропускается молча: её хук не позовут и в сессии, а отказ пробы назовёт итог.
 */
function settingsHooks(settings: unknown): TProbedHook[] {
    if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return [];
    const entries = settings.hooks.PreToolUse;
    if (!Array.isArray(entries)) return [];
    const out: TProbedHook[] = [];
    for (const entry of entries) {
        if (!isPlainObject(entry)) continue;
        const one = { hooks: { PreToolUse: [{ ...entry, matcher: '' }] } };
        for (const hook of hooksFor(one, '')) out.push({ ...hook, matcher: entry.matcher });
    }
    return out;
}

/**
 * Проблемы пробы Claude Code для уже прочитанных настроек. Пустой список — барьер держит.
 * Чистая функция над `runHookFn`: тест подаёт фейковые исходы, а не живые процессы.
 */
export function probeProblems(
    settings: unknown,
    projectDir: string,
    { runHookFn = runHook }: { runHookFn?: TRunHookFn } = {},
): string[] {
    // Один флаг в корне выключает ВСЕ хуки, не тронув ни одной записи: запусти проба хуки
    // сама, она увидела бы исправный барьер, которого в сессии нет вовсе.
    if (isPlainObject(settings) && settings.disableAllHooks === true) {
        return ['disableAllHooks: true — Claude Code не запустит ни одного хука в сессии'];
    }
    return probeHookList('claude-code', settingsHooks(settings), projectDir, runHookFn, (p) =>
        probePayload(p, projectDir),
    );
}

/** Хук, которому для вердикта нужен транскрипт Claude Code: вне Claude Code он не исполним. */
const TRANSCRIPT_HOOK_RE = /(?:^|[\s/'"])skill-barrier\.cjs(?:$|[\s'"])/;

/** Строка в одинарных кавычках оболочки (копия `shellQuote` без цикла импорта). */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Хуки барьера в общей форме — из тех же настроек Claude Code, что получит его сессия:
 * регистрация остальных харнессов строится из них, и барьер у всех один. Хук, который не
 * вправе блокировать (`async`, `once`, `if`), в чужой формат не переносится: там его поле
 * потерялось бы, и хук стал бы блокирующим молча. Каталог дерева сессии хук получает
 * переменной `CLAUDE_PROJECT_DIR` прямо в команде: остальные CLI её не ставят, а команды
 * дерева (`${CLAUDE_PROJECT_DIR}/.claude/hooks/…`) и данные контура ищут по ней.
 *
 * Именно `export …;`, а не префикс `X=… cmd`: префикс действует на окружение команды, но
 * НЕ на раскрытие `${X}` в той же строке — оболочка раскрывает её раньше присваивания. Живая
 * сессия Kimi Code (#120, 27.10) так и исполнила `rm -rf`: путь хука раскрылся пустым,
 * `node` упал, а упавший хук CLI пропускает. Проба этого не видела, пока сама подкладывала
 * переменную в окружение хука.
 *
 * Барьер скиллов (`skill-barrier.cjs`) в чужой формат тоже не переносится (ревью Фазы 16b):
 * в сессии петли он судит по транскрипту, где ищет вызов `Skill`. Kimi Code и плагин
 * OpenCode транскрипта хуку не отдают, и барьер блокировал бы fail-closed «транскрипт не
 * назван»; у Codex транскрипт есть, но в формате rollout, где вызова `Skill` барьер не
 * найдёт. Требование, которое сессия исполнить не может, закрывало бы ей правку тестов
 * навсегда, и кодер жёг бы итерации до брейкера. Предел назван строкой старта
 * (`SKILL_BARRIER_LIMIT`), а не умолчан. Узнаётся хук по имени файла — и канонический
 * (абсолютный путь в установке ядра), и хук дерева (`${CLAUDE_PROJECT_DIR}/.claude/hooks/…`).
 * Цена: у этих харнессов каталог хуков сверяет с ревизией ядра один `guard.cjs`, а не два.
 */
export function guardHooksOf(settings: unknown, projectDir: string): GuardHook[] {
    return settingsHooks(settings)
        .filter((h) => h.cannotBlock === null && !TRANSCRIPT_HOOK_RE.test(h.command))
        .map((h) => ({
            matcher: typeof h.matcher === 'string' ? h.matcher : '',
            command: `export CLAUDE_PROJECT_DIR=${quote(projectDir)}; ${h.command}`,
            timeoutSec: h.timeoutSec,
        }));
}

/** Запуск плагина OpenCode на одном событии: исход в форме хука (2 — вызов отменён). */
export type TRunPluginFn = (
    source: string,
    event: { input: Record<string, unknown>; output: Record<string, unknown> },
    projectDir: string,
) => THookRun;

/**
 * Боевой запуск плагина: отдельный `node` грузит исходник и зовёт его событие так, как
 * его зовёт OpenCode. Исполняются плагин и хуки, а не сам вызов инструмента.
 */
export const runOpencodePlugin: TRunPluginFn = (source, event, projectDir) => {
    guardSideEffect('guard-probe: плагин OpenCode', 'Подмени runPluginFn в тесте.');
    const r = spawnSync('node', ['--input-type=module', '-e', OPENCODE_PLUGIN_DRIVER], {
        cwd: projectDir,
        input: JSON.stringify({ source, ...event, directory: projectDir }),
        encoding: 'utf-8',
        timeout: 120 * 1000,
    });
    return { status: r.status, stderr: r.stderr ?? String(r.error ?? '') };
};

/**
 * Проба регистрации Codex на argv, который уйдёт в `codex exec`: флаги доверия и включения
 * хуков на месте, хуки из `-c` разобраны и исполнены на событиях формы Codex.
 */
export function codexArgsProblems(
    argv: readonly string[],
    projectDir: string,
    { runHookFn = runHook }: { runHookFn?: TRunHookFn } = {},
): string[] {
    const { hooks, problems } = codexGuardFromArgs(argv);
    const probed = hooks.map((h) => ({ ...h, cannotBlock: null }));
    return [
        ...problems,
        ...probeHookList('codex', probed, projectDir, runHookFn, (p) =>
            harnessHookPayload('codex', p, projectDir),
        ),
    ];
}

/** Проба регистрации Kimi Code на тексте `config.toml` его дома. */
export function kimiTomlProblems(
    toml: string,
    projectDir: string,
    { runHookFn = runHook }: { runHookFn?: TRunHookFn } = {},
): string[] {
    const { hooks, problems } = kimiHooksFromToml(toml);
    const probed = hooks.map((h) => ({ ...h, cannotBlock: null }));
    return [
        ...problems,
        ...probeHookList('kimi-code', probed, projectDir, runHookFn, (p) =>
            harnessHookPayload('kimi-code', p, projectDir),
        ),
    ];
}

/**
 * Проба регистрации OpenCode на исходнике плагина: исполняется САМ плагин — он и есть
 * разбор события, — а не хуки в обход него. Не загрузившийся плагин (код 3) не блокирует:
 * OpenCode такой плагин пропускает (стенд, `crash`).
 */
export function opencodePluginProblems(
    source: string,
    projectDir: string,
    { runPluginFn = runOpencodePlugin }: { runPluginFn?: TRunPluginFn } = {},
): string[] {
    const { hooks, problems } = opencodeHooksFromPlugin(source);
    if (problems.length > 0) return problems;
    const pluginHook: THookCommand = {
        command: 'плагин OpenCode',
        timeoutSec: 120,
        cannotBlock: null,
    };
    const out: string[] = [];
    for (const probe of HARNESS_PROBES.opencode) {
        const name = probe.toolName;
        const covered = hooks.some((h) =>
            harnessMatcherCovers('opencode', h.matcher, opencodeClaudeToolName(name)),
        );
        if (!covered) {
            out.push(`${probe.what} (${name}): ни один хук плагина не накрывает инструмент`);
            continue;
        }
        const run = runPluginFn(source, opencodeEvent(probe), projectDir);
        out.push(...verdictProblems(probe, [{ hook: pluginHook, run }]));
    }
    return out;
}

/** Исполнители пробы: хуки процессом и плагин OpenCode процессом. */
export type TProbeRunners = { runHookFn?: TRunHookFn; runPluginFn?: TRunPluginFn };

/**
 * Проба барьера харнесса на его регистрации, построенной из настроек сессии. Харнесс без
 * регистрации — отказ: доказать его guard нечем.
 */
export function harnessGuardProblems(
    harness: string,
    settings: unknown,
    projectDir: string,
    { runHookFn = runHook, runPluginFn = runOpencodePlugin }: TProbeRunners = {},
): string[] {
    const hooks = guardHooksOf(settings, projectDir);
    switch (harness) {
        case 'claude-code':
            return probeProblems(settings, projectDir, { runHookFn });
        case 'codex':
            return codexArgsProblems(codexGuardArgs(hooks), projectDir, { runHookFn });
        case 'kimi-code':
            return kimiTomlProblems(kimiHooksToml(hooks), projectDir, { runHookFn });
        case 'opencode':
            return opencodePluginProblems(opencodeGuardPlugin(hooks), projectDir, { runPluginFn });
        default:
            return [
                `харнесс «${harness}»: регистрации барьера для него нет — доказать guard нечем`,
            ];
    }
}

/**
 * Харнессы, чью регистрацию барьера раннер ПЕРЕДАЁТ в CLI при запуске сессии. Проба
 * доказывает регистрацию, а не намерение: зелёная проба харнесса при адаптере, не отдающем
 * регистрацию CLI, была бы ложью о сессии. Kimi Code проведён адаптером `kimi-native` (#120):
 * дом CLI с `[[hooks]]` собирает и пробует раннер перед каждой сессией. OpenCode — адаптером
 * `opencode` (#121): плагин в каталоге `OPENCODE_CONFIG_DIR`, так же перед каждой сессией.
 */
export const GUARD_WIRED_HARNESSES: ReadonlySet<string> = new Set([
    'claude-code',
    'codex',
    'kimi-code',
    'opencode',
]);

/**
 * Выбор рантайма кодера в форме конфига: статический `adapters.coderRuntime` и маршруты
 * `modelRouting`. Строковая запись маршрута провайдера не меняет — берётся статический.
 */
export type TRuntimeSelection = {
    coderRuntime?: string;
    modelRouting?: {
        labels?: Record<string, unknown>;
        default?: unknown;
        apiLimitFallback?: unknown;
        healEscalation?: unknown;
    };
};

/** Куда конфиг может отправить сессию: место выбора, рантайм, его харнесс. */
export type THarnessRoute = { where: string; runtime: string; harness: string | null };

/**
 * Все места выбора рантайма с харнессом каждого. Харнесс — из профиля рантайма
 * (`RUNTIME_IDENTITIES`): `kimi` — тот же Claude Code с другим endpoint, и guard он
 * наследует от Claude; незнакомый ключ — `null`, то есть харнесс неизвестен.
 */
export function harnessRoutes(
    sel: TRuntimeSelection,
    harnessOf: (runtime: string) => string | null = (rt) => RUNTIME_IDENTITIES[rt]?.harness ?? null,
): THarnessRoute[] {
    const fallback = sel.coderRuntime ?? 'claude';
    const providerOf = (entry: unknown): string =>
        isPlainObject(entry) && typeof entry.provider === 'string' ? entry.provider : fallback;
    const route = (where: string, runtime: string) => ({
        where,
        runtime,
        harness: harnessOf(runtime),
    });
    const out: THarnessRoute[] = [route(`adapters.coderRuntime = '${fallback}'`, fallback)];
    const routing = sel.modelRouting ?? {};
    for (const [label, entry] of Object.entries(routing.labels ?? {})) {
        const provider = providerOf(entry);
        if (provider !== fallback)
            out.push(route(`modelRouting.labels.${label} → '${provider}'`, provider));
    }
    for (const key of ['default', 'apiLimitFallback'] as const) {
        if (routing[key] === undefined) continue;
        const provider = providerOf(routing[key]);
        if (provider !== fallback) out.push(route(`modelRouting.${key} → '${provider}'`, provider));
    }
    // Эскалация лечения — тоже место выбора, и `reachableRuntimes` оркестратора её считает
    // (ревью Фазы 16b): без неё рантайм, достижимый только эскалацией, на старте не пробовался,
    // и отказ всплывал перед самой сессией посреди ночи.
    const heal = isPlainObject(routing.healEscalation) ? routing.healEscalation.route : undefined;
    if (heal !== undefined) {
        const provider = providerOf(heal);
        if (provider !== fallback)
            out.push(route(`modelRouting.healEscalation.route → '${provider}'`, provider));
    }
    return out;
}

/**
 * Места выбора, где сессия ушла бы в харнесс без доказанного guard: харнесс неизвестен
 * или его регистрация не передаётся CLI. Это отказ, а не предупреждение: сессия без
 * подтверждений и без барьера — ровно то, что закрывает задача 6.
 */
export function unguardedRoutes(routes: readonly THarnessRoute[]): string[] {
    return routes
        .filter((r) => r.harness === null || !GUARD_WIRED_HARNESSES.has(r.harness))
        .map((r) =>
            r.harness === null
                ? `${r.where}: харнесс рантайма неизвестен — guard не доказан, сессия не стартует`
                : `${r.where}: регистрация guard харнесса «${r.harness}» не передаётся CLI — ` +
                  'сессия пошла бы мимо барьера',
        );
}

/**
 * Проверка перед первой сессией: не держит барьер хоть у одного достижимого харнесса —
 * `failFn` с полным списком причин. `projectDir` — дерево, в котором пойдут сессии.
 * Настройки — `settings`, собранный раннером (задача 101, `session-settings.ts`), а без
 * него — `.claude/settings.json` этого дерева: их сессия Claude Code и прочтёт, и из них
 * же строится регистрация остальных харнессов.
 */
export function ensureGuardHolds(
    projectDir: string,
    {
        failFn,
        logFn,
        readFileFn = (p: string) => fs.readFileSync(p, 'utf-8'),
        runHookFn = runHook,
        runPluginFn = runOpencodePlugin,
        runtimes = {},
        settings: given,
    }: {
        failFn: FailFn;
        logFn: LogFn;
        readFileFn?: (p: string) => string;
        runtimes?: TRuntimeSelection;
        settings?: unknown;
    } & TProbeRunners,
): void {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    let settings: unknown = given;
    if (settings === undefined) {
        try {
            settings = JSON.parse(readFileFn(settingsPath));
        } catch (error) {
            failFn(
                `Проба барьера: ${settingsPath} не прочитан (${error instanceof Error ? error.message : String(error)}). ` +
                    'Без настроек хуков сессии без подтверждений идут без барьера — старт отменён.',
            );
            return;
        }
    }
    const routes = harnessRoutes(runtimes);
    // Claude Code пробуется всегда: из его настроек строятся регистрации остальных, и битые
    // настройки — отказ независимо от того, какой харнесс выбран.
    const harnesses = [
        ...new Set([
            'claude-code',
            ...routes
                .map((r) => r.harness)
                .filter((h): h is string => h !== null && GUARD_WIRED_HARNESSES.has(h)),
        ]),
    ];
    const problems = [
        ...unguardedRoutes(routes),
        ...harnesses.flatMap((h) =>
            harnessGuardProblems(h, settings, projectDir, { runHookFn, runPluginFn }).map(
                (p) => `${h}: ${p}`,
            ),
        ),
    ];
    if (problems.length > 0) {
        failFn(
            'Проба барьера не прошла — харнесс без доказанного guard не стартует:\n' +
                problems.map((p) => `  - ${p}`).join('\n') +
                '\nПочини хук или его проводку в .claude/settings.json; петлю это не обходит.',
        );
        return;
    }
    logFn(
        `🛡  Проба барьера пройдена (${harnesses.join(', ')}): запрещённое заблокировано, безобидное пропущено`,
    );
    if (harnesses.includes('codex')) logFn(`⚠ ${CODEX_GUARD_LIMIT}`);
    const noSkillBarrier = harnesses.filter((h) => h !== 'claude-code');
    if (noSkillBarrier.length > 0) logFn(`⚠ ${noSkillBarrier.join(', ')}: ${SKILL_BARRIER_LIMIT}`);
}

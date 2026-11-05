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
// исполняется на событиях в форме этого CLI. Харнесс неизвестен или у него нет принятого
// пакета — регистрация не передаётся CLI при запуске — отказ с местом в конфиге. Kimi
// через Claude CLI (`kimi`) — харнесс Claude Code и наследует его guard; Kimi Code родным
// харнессом (`kimi-native`) — свой `config.toml` в доме CLI.
//
// Харнесс выбирает реестр пакетов, а не ветвление здесь (Фаза 16c, #180). Пакет
// (`adapters/harness-registry.ts`) сам отвечает, что его CLI позовёт, на каком входе и по
// какому matcher; модуль только исполняет хуки и судит исходы — по имени он не знает ни
// одного харнесса, у которого есть пакет. Codex и Kimi Code сняты с временного моста 16b
// пакетами (#181), OpenCode — вместе с самим мостом (#213): его регистрация — плагин, и пакет
// объявляет это полем `plugin`, а проба выбирает способ исполнения по полю, а не по имени.
// Пакет, который реестр не принял (несовместимая версия интерфейса, описание не по схеме), —
// отказ старта с причинами реестра, если конфиг может отправить в него сессию.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис). Standalone-экспорты, как у workspace-trust.ts: контекста фабрики модулю не
// нужно — log/fail приходят параметрами единственного вызова.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import {
    OPENCODE_PLUGIN_DRIVER,
    codexGuardFromArgs,
    SKILL_BARRIER_LIMIT,
    kimiHooksFromToml,
    type GuardHook,
    type HarnessProbe,
} from '../adapters/harness-guard.ts';
import { RUNTIME_IDENTITIES } from '../adapters/runtime-profile.ts';
import {
    ALL_PACKAGES,
    HARNESS_REGISTRY,
    SESSION_SETTINGS_HARNESS,
    normalizerPathIn,
    protectedSurfacesOf,
    selectHarness,
    type HarnessRegistry,
} from '../adapters/harness-registry.ts';
import type { HarnessPackage, RegisteredGuardHook } from '../adapters/harness-package.ts';
import { reasonCodeOf } from '../adapters/barrier-reason.ts';
import { configLayerProblems } from '../adapters/config-layers.ts';
import { SESSION_CONTEXT_ENV } from './session-context.ts';

type LogFn = (msg: string) => void;
type FailFn = (msg: string) => unknown;

/** Один вызов пробы: что подаём хукам и чего от них ждём (в терминах харнесса). */
export type TGuardProbe = HarnessProbe;

/**
 * Пакет харнесса, в чьём формате собраны настройки сессии. Не принят реестром — `null`:
 * разбор настроек тогда пуст, и проба называет причину реестра (`harnessGuardProblems`).
 */
const settingsPackage = (registry: HarnessRegistry = HARNESS_REGISTRY): HarnessPackage | null =>
    registry.packages.get(SESSION_SETTINGS_HARNESS)?.pkg ?? null;

/** Состав пробы харнесса настроек сессии; у остальных харнессов — свой, `HARNESS_PROBES`. */
export const GUARD_PROBES: readonly TGuardProbe[] = settingsPackage()?.probes ?? [];

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
    opts?: { projectDirEnv?: boolean; env?: Record<string, string> },
) => THookRun;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Семантика matcher харнесса настроек сессии — её знает его пакет. */
export function matcherCovers(matcher: unknown, toolName: string): boolean {
    return settingsPackage()?.matcherCovers(matcher, toolName) ?? false;
}

/**
 * Хуки настроек сессии, которые CLI позовёт на этот инструмент. Разбор — у пакета: битая
 * форма записи пропускается молча, её хук не позовут и в сессии.
 */
export function hooksFor(settings: unknown, toolName: string): THookCommand[] {
    const pkg = settingsPackage();
    if (!pkg) return [];
    return pkg
        .guardRegistration(settings)
        .hooks.filter((h) => pkg.matcherCovers(h.matcher, toolName))
        .map(({ command, timeoutSec, cannotBlock }) => ({ command, timeoutSec, cannotBlock }));
}

/** Вход хука в той форме, что подаёт CLI настроек сессии. Транскрипта у пробы нет. */
export function probePayload(probe: TGuardProbe, projectDir: string): string {
    return settingsPackage()?.hookPayload(probe, projectDir) ?? '';
}

/**
 * Окружение хука под пробой: окружение раннера, каталог дерева и то, что проба кладёт явно.
 * Чистая функция — по ней тест проверяет, что снято, без запуска хука.
 */
export function probeHookEnv(
    base: NodeJS.ProcessEnv,
    projectDir: string,
    opts: { projectDirEnv?: boolean; env?: Record<string, string> } = {},
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, CLAUDE_PROJECT_DIR: projectDir };
    // Унаследованная от места запуска переменная тоже снимается: раннер, запущенный из
    // сессии Claude Code, иначе подложил бы её хуку и снова спрятал бы ту же поломку.
    if (opts.projectDirEnv === false) delete env.CLAUDE_PROJECT_DIR;
    // Контекст сессии (#184) хук получает только тем, что проба кладёт явно: унаследованный
    // из окружения раннера, он прятал бы регистрацию, которой контекст не дошёл бы. Так же
    // снимаются переменные команды хука: сессия их не получает (`withSkillGuard`), и раннер,
    // запущенный с `RALPH_CORE_SHA` в окружении, проходил бы пробу хука дерева контрактом,
    // которого у живой сессии нет. Свою команду хук ядра несёт литералом — ему это не мешает.
    delete env[SESSION_CONTEXT_ENV];
    for (const k of HOOK_COMMAND_ONLY_ENV) delete env[k];
    return Object.assign(env, opts.env ?? {});
}

/**
 * Боевой запуск хука: через оболочку, как его запускает Claude Code (команда в настройках —
 * строка с `${CLAUDE_PROJECT_DIR}`), с тем же каталогом и переменной.
 */
export const runHook: TRunHookFn = (hook, payload, projectDir, opts = {}) => {
    guardSideEffect(`guard-probe: ${hook.command}`, 'Подмени runHookFn в тесте.');
    const env = probeHookEnv(process.env, projectDir, opts);
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
type TProbedHook = RegisteredGuardHook;

/** Что проба знает о харнессе: состав, семантика matcher, форма входа и окружение хука. */
type TProbeSpec = Pick<
    HarnessPackage,
    'probes' | 'matcherCovers' | 'hookPayload' | 'setsProjectDirEnv'
>;

/**
 * Вердикт пробы на списке хуков одного харнесса. Запрещённое: хоть один хук, вправе блокировать,
 * вышел 2 с кодом причины этой пробы. Безобидное: все вышли 0 — барьер fail-closed, и упавшие
 * правила блокируют всё подряд; сессия на таком барьере сожгла бы итерацию на отказах.
 */
function probeHookList(
    spec: TProbeSpec,
    hooks: readonly TProbedHook[],
    projectDir: string,
    runHookFn: TRunHookFn,
): string[] {
    const problems: string[] = [];
    for (const probe of spec.probes) {
        const covering = hooks.filter((h) => spec.matcherCovers(h.matcher, probe.toolName));
        if (covering.length === 0) {
            problems.push(
                `${probe.what} (${probe.toolName}): ни один PreToolUse-хук не накрывает ` +
                    `инструмент — без подтверждений вызов прошёл бы без проверки`,
            );
            continue;
        }
        const payload = spec.hookPayload(probe, projectDir);
        // `CLAUDE_PROJECT_DIR` в окружение хука кладёт не каждый CLI — тем, кто не кладёт,
        // проба его не подкладывает: регистрация обязана нести каталог сама.
        const projectDirEnv = spec.setsProjectDirEnv;
        const opts = probe.loop
            ? { projectDirEnv, env: { [SESSION_CONTEXT_ENV]: probeLoopContext(projectDir) } }
            : { projectDirEnv };
        const runs = covering.map((hook) => ({
            hook,
            run: runHookFn(hook, payload, projectDir, opts),
        }));
        problems.push(...verdictProblems(probe, runs));
    }
    return problems;
}

/**
 * Контекст петли для пробы правила сессии петли (`HarnessProbe.loop`, #232): та же форма, что
 * раннер кладёт в env сессии (`loopSessionContext`), с деревом пробы обоими корнями и теми же
 * поверхностями конфига реестра (#199). Ревизии нет:
 * хук с контрактом петлю узнаёт и без контекста, а хуку дерева контракт не положен.
 */
function probeLoopContext(projectDir: string): string {
    return JSON.stringify({
        sessionId: 'ralph-guard-probe',
        loop: true,
        coreRevision: '',
        roots: { consumer: projectDir, execution: projectDir },
        protectedSurfaces: protectedSurfacesOf(HARNESS_REGISTRY),
    });
}

function verdictProblems(
    probe: TGuardProbe,
    runs: readonly { hook: THookCommand; run: THookRun }[],
): string[] {
    if (probe.expect === 'blocked') {
        const blocking = runs.filter(
            ({ hook, run }) => run.status === 2 && hook.cannotBlock === null,
        );
        // Двойка засчитывается только со своим кодом причины (#183): барьер fail-closed, и
        // правила, не загрузившиеся по сбою, блокируют запрещённое той же двойкой — проба
        // была зелёной ровно потому, что барьер сломан. Хук потребителя, блокирующий своим
        // кодом или без кода, пробу не портит: хватает одного хука, назвавшего правило.
        const reads = blocking.map(({ run }) => reasonCodeOf(run.stderr));
        if (reads.some((r) => r.code === probe.reasonCode)) return [];
        if (blocking.length > 0) {
            const got = reads.map((r) => r.code ?? r.why).join('; ');
            return [
                `${probe.what} (${probe.toolName}): вызов заблокирован, но не правилом — ` +
                    `ждали код причины ${probe.reasonCode}, получили: ${got}`,
            ];
        }
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
 * Хуки настроек сессии, которые проба исполняет, — регистрация пакета харнесса настроек.
 * Пакет не принят — хуков нет, а причину называет проба этого харнесса.
 */
function settingsHooks(settings: unknown): TProbedHook[] {
    return settingsPackage()?.guardRegistration(settings).hooks ?? [];
}

/**
 * Проба харнесса пакетом: регистрация, прочитанная пакетом обратно, исполнена на его
 * событиях. Регистрация непригодна целиком (CLI не запустит ни одного хука) — её причины,
 * хуки не запускаются: проба, запустившая их сама, увидела бы барьер, которого нет. Пакет с
 * регистрацией плагином (`plugin`) пробуется исполнением плагина, а не хуков в обход него.
 */
function packageProblems(
    pkg: HarnessPackage,
    input: TGuardInput,
    settings: unknown,
    projectDir: string,
    { runHookFn, runPluginFn }: { runHookFn: TRunHookFn; runPluginFn: TRunPluginFn },
): string[] {
    const guardHooks = guardHooksOf(settings, projectDir, input);
    if (pkg.plugin) {
        return pluginProblems(pkg, pkg.plugin.source(guardHooks), projectDir, runPluginFn);
    }
    const registration = pkg.guardRegistration(settings, guardHooks);
    if (registration.problems.length > 0) return registration.problems;
    return probeHookList(pkg, registration.hooks, projectDir, runHookFn);
}

/**
 * Проблемы пробы харнесса настроек сессии для уже прочитанных настроек. Пустой список —
 * барьер держит. Чистая функция над `runHookFn`: тест подаёт фейковые исходы.
 */
export function probeProblems(
    settings: unknown,
    projectDir: string,
    {
        runHookFn = runHook,
        registry = HARNESS_REGISTRY,
    }: { runHookFn?: TRunHookFn; registry?: HarnessRegistry } = {},
): string[] {
    return harnessGuardProblems(SESSION_SETTINGS_HARNESS, settings, projectDir, {
        runHookFn,
        registry,
    });
}

/**
 * Регистрация общего guard'а: канонический хук установки или хук дерева — по имени файла.
 * Заглушка живого цикла у копии ядра лежит под тем же именем в своём каталоге
 * (`tests/__fixtures__/stub-guard/guard.cjs`): боевой разбор о фикстуре не знает, а хук
 * потребителя с похожим именем (`secret-guard.cjs`) регистрацией guard не считается.
 */
const GUARD_HOOK_RE = /(?:^|[\s/'"])guard\.cjs(?:$|[\s'"])/;

/**
 * Предел пробы контекста (#184), сказанный строкой старта, а не абзацем: регистрации Codex,
 * Kimi Code и OpenCode получают контекст тем же env сессии, но что их CLI отдаёт его хуку,
 * проба не проверяет — у неё нет их сессии. Без `roots` guard их дерева узнаёт петлю только по
 * контексту, и правка данных контура в их сессии держится недоказанным. Строка снимается с
 * пакетами 16d, когда проба контекста пойдёт по событиям их CLI.
 */
export const CONTEXT_UNPROVEN_LIMIT =
    'контекст сессии петли до их регистрации guard пробой не доказан — забор данных контура ' +
    'в их сессии держится на том, что CLI передаёт env хуку (до пакетов 16d)';

/** Правка данных контура — запрещённое ТОЛЬКО в сессии петли: по ней видно, дошёл ли контекст. */
const CONTOUR_CODE = 'contour-data';
const CONTOUR_WRITE: TGuardProbe = {
    what: 'правка данных контура в сессии петли',
    toolName: 'Write',
    toolInput: { file_path: '.claude/ralph/hooks.json', content: '{}' },
    expect: 'blocked',
    reasonCode: CONTOUR_CODE,
};

/**
 * Субагент и отложенный ход — запрещённое ТОЛЬКО в сессии петли (#225): раннер не видит ни
 * ходов, ни обрыва субагента, а сессию `-p`, отложившую ход, снаружи никто не будит. Первый
 * слой — флаг запуска (`--disallowedTools`), второй — guard; проба доказывает второй, потому
 * что флаг держит CLI, а не исполняемое ядра, и молча снятый флаг иначе не увидел бы никто.
 */
const DELEGATION_CODE = 'loop-delegation';
// Шаг миграции для раскладки без `roots` (докблок `sessionContextProblems`): там guard сессии —
// копия хуков дерева, и старая копия не знает правила, которое проба требует с контекстом петли:
// `loop-delegation` (#225), `config-surface` (#199) и следующих. Текст общий для всех таких проб.
export const GUARD_COPY_MIGRATION_HINT =
    'если guard — копия хуков в дереве (раскладка без roots), она старше ядра: обнови ' +
    '.claude/hooks из ядра той же ревизии';
export const DELEGATION_PROBES: readonly TGuardProbe[] = [
    {
        what: 'субагент в сессии петли',
        toolName: 'Agent',
        toolInput: { description: 'ralph-probe', prompt: 'ralph-probe' },
        expect: 'blocked',
        reasonCode: DELEGATION_CODE,
    },
    {
        what: 'отложенный ход в сессии петли',
        toolName: 'ScheduleWakeup',
        toolInput: { delaySeconds: 1200, prompt: 'ralph-probe', reason: 'ralph-probe' },
        expect: 'blocked',
        reasonCode: DELEGATION_CODE,
    },
];

/**
 * Запись поверхности конфига Claude Code — запрещённое ТОЛЬКО в сессии петли и только с перечнем
 * поверхностей в контексте (#199). Проба идёт здесь, а не в составе пакета: перечень guard
 * получает тем же контекстом, что забор данных контура, и хватает одной регистрации, назвавшей
 * правило, — как у субагента. У Codex, Kimi Code и OpenCode такая проба — в составе их пакета.
 */
export const CONFIG_SURFACE_PROBES: readonly TGuardProbe[] = [
    {
        what: 'запись поверхности конфига .claude/settings.local.json в сессии петли',
        toolName: 'Write',
        toolInput: { file_path: '.claude/settings.local.json', content: '{}' },
        expect: 'blocked',
        reasonCode: 'config-surface',
    },
];

/**
 * Каждая регистрация guard'а в настройках сессии обязана получить контекст сессии (#184):
 * проба подаёт КАЖДОЙ правку данных контура с тем окружением, которое раннер даст сессии, и
 * ждёт от каждой блок кодом `contour-data`. Регистрация, до которой контекст не дошёл, сочла
 * бы сессию сессией человека и пропустила бы правку — это отказ preflight, а не `loop=false`.
 * Не «хоть один хук», как у общей пробы: прежде петлю такой хук узнавал по транскрипту, и
 * признак снят только при условии, что ни одна регистрация без контекста не осталась.
 * Доказывает проба это у хуков без контракта — хуков дерева и копии ядра без git. Канонический
 * хук установки несёт `RALPH_CORE_SHA` литералом в команде, петлю узнаёт по нему и блок дал бы
 * и без контекста; контекст ему не нужен, и снять контракт из окружения проба не может.
 *
 * Тем же контекстом проба подаёт субагента и отложенный ход (`DELEGATION_PROBES`, #225) и запись
 * поверхности конфига (`CONFIG_SURFACE_PROBES`, #199). Здесь
 * хватает одной регистрации, назвавшей правило: CLI складывает хуки, и блок одного блокирует
 * вызов. С `roots` эта регистрация — канонический хук установки, и копия хуков дерева старше
 * ядра старт не роняет. Без `roots` регистрация одна — копия хуков в дереве потребителя, и пока
 * она старше #225, проба падает и петля не стартует. Это шаг миграции, а не дефект пробы:
 * ослабить её строкой `⚠` значило бы пустить сессию, в которой второй слой запрета не стоит
 * вовсе. Строка отказа называет шаг (`GUARD_COPY_MIGRATION_HINT`).
 */
export function sessionContextProblems(
    settings: unknown,
    projectDir: string,
    contextValue: string,
    { runHookFn = runHook }: { runHookFn?: TRunHookFn } = {},
): string[] {
    const pkg = settingsPackage();
    if (!pkg)
        return ['пакет харнесса настроек сессии не принят — регистрацию guard проверить нечем'];
    const guards = pkg
        .guardRegistration(settings)
        .hooks.filter(
            (h) => GUARD_HOOK_RE.test(h.command) && pkg.matcherCovers(h.matcher, 'Write'),
        );
    if (guards.length === 0) {
        return [
            `${CONTOUR_WRITE.what}: в настройках сессии нет регистрации guard.cjs на Write — ` +
                'контекст сессии получить некому',
        ];
    }
    const payload = pkg.hookPayload(CONTOUR_WRITE, projectDir);
    const contextEnv = { [SESSION_CONTEXT_ENV]: contextValue };
    const contour = guards.flatMap((hook) => {
        const run = runHookFn(hook, payload, projectDir, {
            projectDirEnv: pkg.setsProjectDirEnv,
            env: contextEnv,
        });
        const read = run.status === 2 ? reasonCodeOf(run.stderr) : null;
        if (read?.code === CONTOUR_CODE) return [];
        const got =
            read === null
                ? `код выхода ${String(run.status)}`
                : `код причины ${read.code ?? read.why}`;
        return [
            `${CONTOUR_WRITE.what}: регистрация «${hook.command}» не получила контекст сессии ` +
                `или не держит забор (${got}; ждали ${CONTOUR_CODE})`,
        ];
    });
    const delegation = [...DELEGATION_PROBES, ...CONFIG_SURFACE_PROBES].flatMap((probe) => {
        const covering = pkg
            .guardRegistration(settings)
            .hooks.filter(
                (h) =>
                    GUARD_HOOK_RE.test(h.command) &&
                    h.cannotBlock === null &&
                    pkg.matcherCovers(h.matcher, probe.toolName),
            );
        if (covering.length === 0) {
            return [
                `${probe.what} (${probe.toolName}): ни одна регистрация guard.cjs не накрывает ` +
                    'инструмент — в сессии петли он прошёл бы без проверки',
            ];
        }
        const probePayloadText = pkg.hookPayload(probe, projectDir);
        const runs = covering.map((hook) => ({
            hook,
            run: runHookFn(hook, probePayloadText, projectDir, {
                projectDirEnv: pkg.setsProjectDirEnv,
                env: contextEnv,
            }),
        }));
        return verdictProblems(probe, runs).map((p) => `${p} — ${GUARD_COPY_MIGRATION_HINT}`);
    });
    return [...contour, ...delegation];
}

/**
 * Вход guard в регистрациях Codex, Kimi Code и OpenCode (#186): переменная, которую читает
 * `guard.cjs`, и значение совместимого входа 16b. Пока нормализаторы пакетов были заглушками,
 * через событие их сессии блокировались бы целиком, и совместимый вход держал запреты 16b
 * прежним правилом. С переводом пакетов (Codex #232, Kimi Code #191, OpenCode #192) его выбирает
 * только пакет с `guardInput: 'compat-16b'` — у реестра такого сейчас нет. Литералы сверяет тест
 * с хуком.
 */
export const GUARD_INPUT_ENV = 'RALPH_GUARD_INPUT';
export const GUARD_COMPAT_INPUT = 'compat-16b' as const;

/** Переменная, которой хук получает путь данных контура (читает `consumer-data.cjs`). */
export const HOOKS_DATA_ENV = 'RALPH_HOOKS_DATA';

/**
 * Путь команды нормализатора пакета харнесса настроек для guard (#186, читает `guard.cjs`).
 * Без него guard судит совместимым входом 16b: так его зовут копии хуков в деревьях.
 */
export const GUARD_ADAPTER_ENV = 'RALPH_GUARD_ADAPTER';

/** Контракт запуска петли: ожидаемая ревизия ядра (читает `core-revision.cjs`). */
export const CORE_SHA_ENV = 'RALPH_CORE_SHA';

/**
 * Переменные, которые раннер кладёт только в команду своего хука. В env сессии их быть не
 * должно: его наследуют и хуки дерева сессии, и унаследованное из окружения раннера значение
 * дало бы им чужой контракт или чужие данные контура (`withSkillGuard` в оркестраторе). Проба
 * снимает их с окружения хука по той же причине (`runHook`): иначе она шла бы на том, чего
 * сессия не получит.
 */
export const HOOK_COMMAND_ONLY_ENV: readonly string[] = [
    CORE_SHA_ENV,
    HOOKS_DATA_ENV,
    // Путь нормализатора (#186) — тоже только в команде: хук дерева сессии, получивший его
    // наследованием, судил бы событие пакетом, которого в его дереве может не быть.
    GUARD_ADAPTER_ENV,
    // Совместимый вход guard (#186) — только в команде хука моста: унаследованный сессией
    // Claude Code, он перевёл бы её guard со строгого события на прежний вход 16b.
    GUARD_INPUT_ENV,
];

/** Вход guard регистрации не-Claude харнесса: событие нормализатора по пути либо вход 16b. */
export type TGuardInput = { adapter: string } | typeof GUARD_COMPAT_INPUT;

/**
 * Путь нормализатора в команде канонического хука (`canonHookCommand`): присваивание перед
 * `node`, значение — в одинарных кавычках оболочки (`'\''` внутри) или словом без них.
 */
const ADAPTER_ASSIGNMENT_RE = new RegExp(
    `(^|\\s)${GUARD_ADAPTER_ENV}=(?:'(?:[^']|'\\\\'')*'|[^\\s;]*)`,
    'g',
);

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
 *
 * Та же строка `export` назначает этим хукам вход guard (`input`, #186, #232): регистрация из
 * настроек Claude Code иначе судила бы вход другого CLI нормализатором Claude Code. Пакет с
 * нормализатором (`guardInput: 'event'`) получает путь своей команды — и в `export` (хук дерева
 * пути не несёт), и вместо пути Claude Code в команде канонического хука: присваивание перед
 * `node` сильнее экспорта, и одного `export` хук установки не услышал бы. Совместимый вход
 * сбрасывается явно. Пакет с заглушкой получает совместимый вход 16b.
 */
export function guardHooksOf(
    settings: unknown,
    projectDir: string,
    input: TGuardInput = GUARD_COMPAT_INPUT,
): GuardHook[] {
    const env =
        input === GUARD_COMPAT_INPUT
            ? `${GUARD_INPUT_ENV}=${GUARD_COMPAT_INPUT}`
            : `${GUARD_ADAPTER_ENV}=${quote(input.adapter)} ${GUARD_INPUT_ENV}=''`;
    const command = (c: string) =>
        input === GUARD_COMPAT_INPUT
            ? c
            : c.replace(ADAPTER_ASSIGNMENT_RE, `$1${GUARD_ADAPTER_ENV}=${quote(input.adapter)}`);
    // Регистрации остальных пакетов строятся из регистрации харнесса настроек — её читает его
    // пакет.
    return settingsHooks(settings)
        .filter((h) => h.cannotBlock === null && !TRANSCRIPT_HOOK_RE.test(h.command))
        .map((h) => ({
            matcher: typeof h.matcher === 'string' ? h.matcher : '',
            command: `export CLAUDE_PROJECT_DIR=${quote(projectDir)} ${env}; ` + command(h.command),
            timeoutSec: h.timeoutSec,
        }));
}

/**
 * Вход guard в регистрации пакета (#232): путь команды нормализатора либо совместимый вход 16b.
 * Пакет не принят — значение-причина вместо пути, как у `guardAdapterValue` ядра: она не
 * абсолютный путь, guard на ней блокирует всё кодом `adapter-failed`, и проба называет отказ, а не
 * пускает сессию на совместимом входе молча. `coreRoot` — каталог исполняемого ядра, куда
 * переносится путь (`normalizerPathIn`); без него — путь пакета, загруженного этим ядром.
 */
export function guardInputOf(
    registry: HarnessRegistry,
    harness: string,
    coreRoot?: string,
): TGuardInput {
    const selected = selectHarness(registry, harness);
    if (!selected.ok) return { adapter: `пакет не принят: ${selected.reason}` };
    if (selected.harness.pkg.guardInput === 'compat-16b') return GUARD_COMPAT_INPUT;
    if (coreRoot === undefined) return { adapter: selected.harness.normalizerPath };
    const found = normalizerPathIn(registry, harness, coreRoot);
    return { adapter: found.ok ? found.path : `пакет не принят: ${found.reason}` };
}

/** Запуск плагина OpenCode на одном событии: исход в форме хука (2 — вызов отменён). */
export type TRunPluginFn = (
    source: string,
    event: { input: Record<string, unknown>; output: Record<string, unknown> },
    projectDir: string,
    opts?: { env?: Record<string, string> },
) => THookRun;

/**
 * Боевой запуск плагина: отдельный `node` грузит исходник и зовёт его событие так, как
 * его зовёт OpenCode. Исполняются плагин и хуки, а не сам вызов инструмента.
 */
export const runOpencodePlugin: TRunPluginFn = (source, event, projectDir, opts = {}) => {
    guardSideEffect('guard-probe: плагин OpenCode', 'Подмени runPluginFn в тесте.');
    // Окружение — как у хука под пробой (`probeHookEnv`): хуки плагин зовёт со своим env, и
    // унаследованный из окружения раннера контекст сессии засчитал бы пробу петли без него.
    const r = spawnSync('node', ['--input-type=module', '-e', OPENCODE_PLUGIN_DRIVER], {
        cwd: projectDir,
        input: JSON.stringify({ source, ...event, directory: projectDir }),
        encoding: 'utf-8',
        timeout: 120 * 1000,
        env: probeHookEnv(process.env, projectDir, { env: opts.env }),
    });
    return { status: r.status, stderr: r.stderr ?? String(r.error ?? '') };
};

/**
 * Харнессы рантаймов, чью готовую регистрацию собирают сборщики `session-settings.ts` (argv Codex,
 * дом Kimi Code, плагин OpenCode). Имя — из профиля рантайма у адаптеров, а не строкой ядра: выбор
 * пакета остаётся у реестра. Сборщики переезжают в пакеты в Фазе 16d.
 */
const CODEX_RUNTIME_HARNESS = RUNTIME_IDENTITIES.openai.harness;
const KIMI_NATIVE_RUNTIME_HARNESS = RUNTIME_IDENTITIES['kimi-native'].harness;
const OPENCODE_RUNTIME_HARNESS = RUNTIME_IDENTITIES.opencode.harness;

/**
 * Проба готовой регистрации пакетом харнесса: хуки, прочитанные из текста, который уйдёт в
 * CLI, исполнены на событиях его формы. Причины разбора идут вместе с исходами хуков — так
 * их называла проба 16b. Пакет не принят — отказ с причиной реестра, а не проба наугад.
 */
function readBackProblems(
    harness: string,
    read: { hooks: GuardHook[]; problems: string[] },
    projectDir: string,
    runHookFn: TRunHookFn,
    registry: HarnessRegistry,
): string[] {
    const selected = selectHarness(registry, harness);
    if (!selected.ok) return [`${selected.reason} — доказать guard нечем`];
    const probed = read.hooks.map((h) => ({ ...h, cannotBlock: null }));
    return [
        ...read.problems,
        ...probeHookList(selected.harness.pkg, probed, projectDir, runHookFn),
    ];
}

/**
 * Проба регистрации Codex на argv, который уйдёт в `codex exec`: флаги доверия и включения
 * хуков на месте, хуки из `-c` разобраны и исполнены на событиях формы Codex.
 */
export function codexArgsProblems(
    argv: readonly string[],
    projectDir: string,
    {
        runHookFn = runHook,
        registry = HARNESS_REGISTRY,
    }: { runHookFn?: TRunHookFn; registry?: HarnessRegistry } = {},
): string[] {
    return readBackProblems(
        CODEX_RUNTIME_HARNESS,
        codexGuardFromArgs(argv),
        projectDir,
        runHookFn,
        registry,
    );
}

/** Проба регистрации Kimi Code на тексте `config.toml` его дома. */
export function kimiTomlProblems(
    toml: string,
    projectDir: string,
    {
        runHookFn = runHook,
        registry = HARNESS_REGISTRY,
    }: { runHookFn?: TRunHookFn; registry?: HarnessRegistry } = {},
): string[] {
    // Схема регистрации — из описания пакета (#199): CLI отбрасывает секцию hooks, не
    // прошедшую её, целиком, и разбор без неё видел хуки, которых CLI не позовёт.
    const schema =
        registry.packages.get(KIMI_NATIVE_RUNTIME_HARNESS)?.descriptor.registrationSchema ?? null;
    return readBackProblems(
        KIMI_NATIVE_RUNTIME_HARNESS,
        kimiHooksFromToml(toml, schema),
        projectDir,
        runHookFn,
        registry,
    );
}

/**
 * Проба регистрации плагином на его исходнике: исполняется САМ плагин — он и есть разбор
 * события, — а не хуки в обход него. Плагин без списка хуков — причина, плагин не
 * запускается. Не загрузившийся плагин (код 3) не блокирует: OpenCode такой плагин
 * пропускает (стенд, `crash`).
 */
function pluginProblems(
    pkg: HarnessPackage,
    source: string,
    projectDir: string,
    runPluginFn: TRunPluginFn,
): string[] {
    const plugin = pkg.plugin;
    if (!plugin) return [`пакет харнесса «${pkg.harness}» регистрирует барьер не плагином`];
    const { hooks, problems } = plugin.read(source);
    if (problems.length > 0) return problems;
    const pluginHook: THookCommand = {
        command: 'плагин OpenCode',
        timeoutSec: 120,
        cannotBlock: null,
    };
    const out: string[] = [];
    for (const probe of pkg.probes) {
        const name = probe.toolName;
        if (!hooks.some((h) => pkg.matcherCovers(h.matcher, name))) {
            out.push(`${probe.what} (${name}): ни один хук плагина не накрывает инструмент`);
            continue;
        }
        // Правило сессии петли (`HarnessProbe.loop`) — с контекстом петли, как у хуков командой.
        const run = probe.loop
            ? runPluginFn(source, plugin.event(probe), projectDir, {
                  env: { [SESSION_CONTEXT_ENV]: probeLoopContext(projectDir) },
              })
            : runPluginFn(source, plugin.event(probe), projectDir);
        out.push(...verdictProblems(probe, [{ hook: pluginHook, run }]));
    }
    return out;
}

/**
 * Проба регистрации OpenCode на исходнике плагина, который ляжет в каталог CLI, — пакетом
 * харнесса рантайма. Пакет не принят — отказ с причиной реестра, а не проба наугад.
 */
export function opencodePluginProblems(
    source: string,
    projectDir: string,
    {
        runPluginFn = runOpencodePlugin,
        registry = HARNESS_REGISTRY,
    }: { runPluginFn?: TRunPluginFn; registry?: HarnessRegistry } = {},
): string[] {
    const selected = selectHarness(registry, OPENCODE_RUNTIME_HARNESS);
    if (!selected.ok) return [`${selected.reason} — доказать guard нечем`];
    return pluginProblems(selected.harness.pkg, source, projectDir, runPluginFn);
}

/** Исполнители пробы: хуки процессом и плагин процессом; реестр пакетов. */
export type TProbeRunners = {
    runHookFn?: TRunHookFn;
    runPluginFn?: TRunPluginFn;
    registry?: HarnessRegistry;
};

/**
 * Проба барьера харнесса на его регистрации, построенной из настроек сессии, — пакетом
 * реестра. Харнесс без пакета — отказ: доказать его guard нечем; пакет, который реестр не
 * принял, — отказ с причинами реестра. Временного моста 16b больше нет (#213): харнесс,
 * которого реестр не знает, не стартует, а не пробуется таблицей ядра.
 */
export function harnessGuardProblems(
    harness: string,
    settings: unknown,
    projectDir: string,
    {
        runHookFn = runHook,
        runPluginFn = runOpencodePlugin,
        registry = HARNESS_REGISTRY,
    }: TProbeRunners = {},
): string[] {
    const selected = selectHarness(registry, harness);
    if (selected.ok) {
        const input = guardInputOf(registry, harness);
        return packageProblems(selected.harness.pkg, input, settings, projectDir, {
            runHookFn,
            runPluginFn,
        });
    }
    if (registry.problems.has(harness) || registry.problems.has(ALL_PACKAGES)) {
        return [`${selected.reason} — доказать guard нечем`];
    }
    return [`харнесс «${harness}»: регистрации барьера для него нет — доказать guard нечем`];
}

/**
 * Выбор рантайма кодера в форме конфига: статический `adapters.coderRuntime` и маршруты
 * `modelRouting`. Строковая запись маршрута провайдера не меняет — берётся статический.
 */
export type TRuntimeSelection = {
    coderRuntime?: string;
    modelRouting?: {
        labels?: Record<string, unknown>;
        default?: unknown;
        cardReview?: unknown;
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
    for (const key of ['default', 'apiLimitFallback', 'cardReview'] as const) {
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
export function unguardedRoutes(
    routes: readonly THarnessRoute[],
    registry: HarnessRegistry = HARNESS_REGISTRY,
): string[] {
    return routes
        .filter((r) => r.harness === null || !registry.packages.has(r.harness))
        .map((r) => {
            if (r.harness === null) {
                return `${r.where}: харнесс рантайма неизвестен — guard не доказан, сессия не стартует`;
            }
            const selected = selectHarness(registry, r.harness);
            if (!selected.ok && registry.problems.has(r.harness)) {
                return `${r.where}: ${selected.reason} — сессия не стартует`;
            }
            return (
                `${r.where}: регистрация guard харнесса «${r.harness}» не передаётся CLI — ` +
                'сессия пошла бы мимо барьера'
            );
        });
}

/**
 * Скан исполняемых слоёв конфига: дерево, поверхности пакета, исключённые дома CLI и ключи,
 * которые делают JSON-поверхность слоем (#197).
 */
export type TLayersFn = (args: {
    tree: string;
    surfaces: readonly string[];
    homes: readonly string[];
    jsonKeys: readonly string[];
}) => string[];

/** Харнесс рантайма Codex — для сборщика его сессии (`session-settings.ts`). */
export const CODEX_HARNESS = CODEX_RUNTIME_HARNESS;

/** Харнесс рантайма `kimi-native` — для сборщика его дома (`session-settings.ts`, #191). */
export const KIMI_NATIVE_HARNESS = KIMI_NATIVE_RUNTIME_HARNESS;

/** Харнесс рантайма `opencode` — для сборщика его каталога (`session-settings.ts`, #192). */
export const OPENCODE_HARNESS = OPENCODE_RUNTIME_HARNESS;

/**
 * Исполняемые слои конфига харнесса в дереве сессии и его предках (#195): поверхности
 * описания пакета, кроме домов CLI, которые пакет называет. Пакет без сборщика конфига
 * (`projectLayers: null`) слоёв не отвергает — это предел, названный строкой старта; пакет, не
 * принятый реестром, судит проба барьера.
 */
export function harnessLayerProblems(
    harness: string,
    tree: string,
    env: NodeJS.ProcessEnv,
    {
        registry = HARNESS_REGISTRY,
        layersFn = configLayerProblems,
    }: { registry?: HarnessRegistry; layersFn?: TLayersFn } = {},
): string[] {
    const loaded = registry.packages.get(harness);
    if (!loaded?.pkg.projectLayers) return [];
    return layersFn({
        tree,
        surfaces: loaded.descriptor.configSurfaces,
        homes: loaded.pkg.projectLayers.homes(env),
        jsonKeys: loaded.pkg.projectLayers.jsonKeys ?? [],
    });
}

/**
 * Переменные окружения, снимающие барьер харнесса (`forbiddenEnv` описания пакета, #197), —
 * для сверки окружения сессии перед спавном. Пакет не принят — бросок, а не пустой перечень:
 * «запрещённого нет» по непринятому пакету было бы молчаливым снятием сверки.
 */
export function harnessForbiddenEnv(
    harness: string,
    registry: HarnessRegistry = HARNESS_REGISTRY,
): readonly string[] {
    const loaded = registry.packages.get(harness);
    if (!loaded) throw new Error(`пакет харнесса «${harness}» не принят реестром`);
    return loaded.descriptor.forbiddenEnv;
}

/** Предел пакета без сборщика конфига — строка `⚠` старта. */
export const PROJECT_LAYERS_LIMIT =
    'исполняемые слои конфига дерева не отвергаются — у пакета нет сборщика конфига';

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
        sessionContext,
        registry = HARNESS_REGISTRY,
        env = process.env,
        layersFn = configLayerProblems,
    }: {
        failFn: FailFn;
        logFn: LogFn;
        readFileFn?: (p: string) => string;
        runtimes?: TRuntimeSelection;
        settings?: unknown;
        /** Контекст сессии петли (#184): задан — каждая регистрация guard обязана его получить. */
        sessionContext?: string;
        /** Окружение раннера: из него пакет называет дома CLI человека (#195). */
        env?: NodeJS.ProcessEnv;
        layersFn?: TLayersFn;
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
    // Харнесс настроек сессии пробуется всегда: из его настроек строятся регистрации
    // остальных, и битые настройки — отказ независимо от того, какой харнесс выбран.
    const harnesses = [
        ...new Set([
            SESSION_SETTINGS_HARNESS,
            ...routes
                .map((r) => r.harness)
                .filter((h): h is string => h !== null && registry.packages.has(h)),
        ]),
    ];
    // Остальные харнессы — один раз и рядом со сборкой: Set хранит порядок вставки, и харнесс
    // настроек вставлен первым. Сравнение с ним по имени — ветвление ядра по харнессу, его
    // ловит `tests/harness-identity.test.ts`.
    const [, ...others] = harnesses;
    const problems = [
        ...unguardedRoutes(routes, registry),
        ...harnesses.flatMap((h) =>
            harnessGuardProblems(h, settings, projectDir, {
                runHookFn,
                runPluginFn,
                registry,
            }).map((p) => `${h}: ${p}`),
        ),
        ...(sessionContext === undefined
            ? []
            : sessionContextProblems(settings, projectDir, sessionContext, { runHookFn }).map(
                  (p) => `${SESSION_SETTINGS_HARNESS}: ${p}`,
              )),
    ];
    if (problems.length > 0) {
        failFn(
            'Проба барьера не прошла — харнесс без доказанного guard не стартует:\n' +
                problems.map((p) => `  - ${p}`).join('\n') +
                '\nПочини хук или его проводку в .claude/settings.json; петлю это не обходит.',
        );
        return;
    }
    // Слои — отдельным отказом (#195): барьер исправен, а чинить надо дерево, и совет «почини
    // хук» отправил бы человека не туда.
    const layers = harnesses.flatMap((h) =>
        harnessLayerProblems(h, projectDir, env, { registry, layersFn }).map((p) => `${h}: ${p}`),
    );
    if (layers.length > 0) {
        failFn(
            'Исполняемые слои конфига харнесса в дереве сессии или его предках — старт отменён:\n' +
                layers.map((p) => `  - ${p}`).join('\n') +
                '\nХуки, MCP-серверы и окружение из них CLI поднял бы при старте сессии. Убери слой ' +
                'из дерева (или каталог из предков): петля его не исполняет и не обходит.',
        );
        return;
    }
    logFn(
        `🛡  Проба барьера пройдена (${harnesses.join(', ')}): запрещённое заблокировано, безобидное пропущено`,
    );
    for (const h of harnesses) {
        const limit = registry.packages.get(h)?.pkg.guardLimit;
        if (limit) logFn(`⚠ ${limit}`);
    }
    // Харнесс настроек сессии — вне списка: его слои дерева (`.claude/settings*.json`,
    // `.mcp.json`) выключены флагами сессии раннера, а не отвергаются (#194). Остальные названы.
    const noLayers = others.filter((h) => registry.packages.get(h)?.pkg.projectLayers === null);
    if (noLayers.length > 0) logFn(`⚠ ${noLayers.join(', ')}: ${PROJECT_LAYERS_LIMIT}`);
    const noSkillBarrier = harnesses.filter((h) => !registry.packages.get(h)?.pkg.skillBarrier);
    if (noSkillBarrier.length > 0) logFn(`⚠ ${noSkillBarrier.join(', ')}: ${SKILL_BARRIER_LIMIT}`);
    // Контекст доказан пробой только у харнесса настроек сессии.
    if (sessionContext !== undefined && others.length > 0) {
        logFn(`⚠ ${others.join(', ')}: ${CONTEXT_UNPROVEN_LIMIT}`);
    }
    // Отвергнутый пакет, в который конфиг сессию не отправит, старт не держит, но молчать о
    // нём нельзя: переключение рантайма в конфиге упёрлось бы в него посреди ночи.
    for (const [name, reasons] of registry.problems) {
        if (!harnesses.includes(name))
            logFn(`⚠ пакет харнесса «${name}» не принят реестром: ${reasons.join('; ')}`);
    }
}

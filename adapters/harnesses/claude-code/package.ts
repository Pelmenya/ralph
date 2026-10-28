/**
 * Пакет харнесса Claude Code (Фаза 16c, #180) — первый пакет реестра.
 *
 * Регистрация барьера у Claude Code — сами настройки сессии (`settings.json`, который
 * собирает раннер, `core/session-settings.ts`): `hooks.PreToolUse`. До карточки этот разбор
 * жил в ядре (`core/guard-probe.ts`) и был ветвью `case 'claude-code'`; здесь он — ответ
 * пакета на вопрос «что CLI позовёт», и ядро спрашивает его, не зная имени харнесса.
 *
 * Поведение перенесено без изменений — тесты пробы 16b держат его неправленными:
 *   - `disableAllHooks: true` — регистрация непригодна целиком: один флаг в корне выключает
 *     ВСЕ хуки, не тронув ни одной записи, и проба, запустившая хуки сама, увидела бы
 *     исправный барьер, которого в сессии нет вовсе;
 *   - битая форма записи пропускается молча: её хук не позовут и в сессии, а отказ пробы
 *     назовёт итог — «хука нет», — то есть ровно то, что увидит человек;
 *   - `async`, `once` и `if` — хук запускается, но блокирующим не считается.
 *
 * Версия интерфейса — литерал: под неё пакет написан (`harness-package.ts`).
 */
import {
    HARNESS_PROBES,
    harnessHookPayload,
    harnessMatcherCovers,
    type HarnessProbe,
} from '../../harness-guard.ts';
import type {
    GuardRegistration,
    HarnessPackage,
    RegisteredGuardHook,
} from '../../harness-package.ts';

const HARNESS = 'claude-code';

// Claude Code ждёт хук 60 секунд, если таймаут в настройках не задан.
const DEFAULT_TIMEOUT_SEC = 60;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

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

/** PreToolUse-хуки настроек с matcher своей записи. */
export function settingsHooks(settings: unknown): RegisteredGuardHook[] {
    if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return [];
    const entries = settings.hooks.PreToolUse;
    if (!Array.isArray(entries)) return [];
    const out: RegisteredGuardHook[] = [];
    for (const entry of entries) {
        if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
            if (!isPlainObject(hook) || hook.type !== 'command') continue;
            if (typeof hook.command !== 'string' || hook.command.trim() === '') continue;
            const timeoutSec =
                typeof hook.timeout === 'number' && hook.timeout > 0
                    ? hook.timeout
                    : DEFAULT_TIMEOUT_SEC;
            out.push({
                matcher: entry.matcher,
                command: hook.command,
                timeoutSec,
                cannotBlock: cannotBlock(hook),
            });
        }
    }
    return out;
}

function guardRegistration(settings: unknown): GuardRegistration {
    const hooks = settingsHooks(settings);
    if (isPlainObject(settings) && settings.disableAllHooks === true) {
        return {
            hooks,
            problems: ['disableAllHooks: true — Claude Code не запустит ни одного хука в сессии'],
        };
    }
    return { hooks, problems: [] };
}

export const harnessPackage: HarnessPackage = {
    interfaceVersion: 1,
    harness: HARNESS,
    guardRegistration,
    // Путь своего нормализатора регистрация получает от сборки настроек (`guardAdapterValue`).
    guardInput: 'event',
    probes: HARNESS_PROBES[HARNESS],
    matcherCovers: (matcher, toolName) => harnessMatcherCovers(HARNESS, matcher, toolName),
    hookPayload: (probe: HarnessProbe, projectDir: string) =>
        harnessHookPayload(HARNESS, probe, projectDir),
    // `CLAUDE_PROJECT_DIR` в окружение хука кладёт только Claude Code.
    setsProjectDirEnv: true,
    // Транскрипт с вызовом `Skill` хук получает только здесь (`SKILL_BARRIER_LIMIT`).
    skillBarrier: true,
    // Регистрация — сами настройки сессии, и всё, что барьер держит, проба видит.
    guardLimit: null,
    // Барьер — команды хуков, их исполняет проба сама.
    plugin: null,
    // Сборщика конфига у пакета ещё нет (Фазы 16d2, 16d3): слои дерева не отвергаются.
    projectLayers: null,
};

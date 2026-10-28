/**
 * Пакет харнесса OpenCode (Фаза 16c, #213) — регистрация 16b, перенесённая с временного моста.
 *
 * Команд-хуков у OpenCode нет: барьер — плагин на `tool.execute.before` в каталоге
 * `OPENCODE_CONFIG_DIR`, который собирает раннер (`prepareOpencodeSession`,
 * `core/session-settings.ts`), а строится плагин из хуков барьера в общей форме (`guardHooks`).
 * Поэтому регистрация объявлена полем `plugin`: проба исполняет САМ плагин на событии CLI —
 * он и есть разбор события, — как исполнял мост (`core/guard-probe.ts` до карточки), и тесты
 * пробы 16b держат поведение неправленными.
 *
 * Плагин без списка хуков — регистрация непригодна целиком: обработчик звать некому, и проба,
 * запустившая хуки сама, увидела бы барьер, которого нет.
 *
 * Имена инструментов пробы — имена OpenCode (`bash`, `read`); matcher хуков написан в именах
 * Claude Code, и накрытие считается по переводу (`opencodeClaudeToolName`) — тем же, что
 * делает плагин в сессии.
 *
 * Поля, которых у OpenCode ещё нет, — объявленные заглушки: нормализатор (`normalize.ts`) и
 * доказательство скилла в описании ждут Фаз 16d и 16e.
 *
 * Версия интерфейса — литерал: под неё пакет написан (`harness-package.ts`).
 */
import {
    HARNESS_PROBES,
    harnessMatcherCovers,
    opencodeClaudeToolName,
    opencodeEvent,
    opencodeGuardPlugin,
    opencodeHooksFromPlugin,
    type GuardHook,
    type HarnessProbe,
} from '../../harness-guard.ts';
import type { GuardPlugin, GuardRegistration, HarnessPackage } from '../../harness-package.ts';

const HARNESS = 'opencode';

/** Регистрация из исходника плагина: зашитые хуки и причины, по которым он не зовёт барьер. */
export function opencodeRegistrationFromPlugin(source: string): GuardRegistration {
    const { hooks, problems } = opencodeHooksFromPlugin(source);
    // Полей «не блокирует» у хука плагина нет: `guardHooksOf` такие хуки не переносит.
    return { hooks: hooks.map((h) => ({ ...h, cannotBlock: null })), problems };
}

const plugin: GuardPlugin = {
    source: opencodeGuardPlugin,
    read: opencodeRegistrationFromPlugin,
    event: opencodeEvent,
};

export const harnessPackage: HarnessPackage = {
    interfaceVersion: 1,
    harness: HARNESS,
    guardRegistration: (_settings: unknown, guardHooks: readonly GuardHook[] = []) =>
        opencodeRegistrationFromPlugin(opencodeGuardPlugin(guardHooks)),
    // Нормализатор пакета — заглушка до 16d: событием guard блокировал бы любой вызов.
    guardInput: 'compat-16b',
    probes: HARNESS_PROBES[HARNESS],
    matcherCovers: (matcher, toolName) =>
        harnessMatcherCovers(HARNESS, matcher, opencodeClaudeToolName(toolName)),
    // Вход плагина — два аргумента обработчика, а не JSON на stdin хука.
    hookPayload: (probe: HarnessProbe) => JSON.stringify(opencodeEvent(probe)),
    // Каталог дерева хук получает в своей команде (`export CLAUDE_PROJECT_DIR=…;`), CLI его
    // не ставит.
    setsProjectDirEnv: false,
    // Транскрипта плагин хуку не отдаёт (`SKILL_BARRIER_LIMIT`).
    skillBarrier: false,
    // Предела сверх пробы старт не называл и у моста; переписывание `output.args` плагином,
    // исполненным позже, — предел из докблока `opencodeGuardPlugin`, стендом не сверен.
    guardLimit: null,
    plugin,
    // Сборщика конфига у пакета ещё нет (Фазы 16d2, 16d3): слои дерева не отвергаются.
    projectLayers: null,
};

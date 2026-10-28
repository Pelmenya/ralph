/**
 * Пакет харнесса Kimi Code (Фаза 16c, #181) — регистрация 16b, перенесённая с временного моста.
 *
 * Флага файла настроек у Kimi Code нет: барьер — блоки `[[hooks]]` в `config.toml` дома CLI,
 * который собирает раннер (`prepareKimiNativeHome`, `core/session-settings.ts`), а строится
 * регистрация из хуков барьера в общей форме (`guardHooks`). Проба читает обратно ТОТ текст,
 * который ляжет в дом, — как читал мост (`core/guard-probe.ts` до карточки), и тесты пробы
 * 16b держат поведение неправленными.
 *
 * Отказ разбора — регистрация непригодна целиком: `hooks` верхнего уровня рядом с
 * `[[hooks]]` CLI отверг бы повторным ключом, и ни один хук не был бы позван.
 *
 * Поля, которых у Kimi Code ещё нет, — объявленные заглушки: нормализатор (`normalize.ts`) и
 * доказательство скилла в описании ждут Фаз 16d и 16e.
 *
 * Версия интерфейса — литерал: под неё пакет написан (`harness-package.ts`).
 */
import {
    HARNESS_PROBES,
    harnessHookPayload,
    harnessMatcherCovers,
    kimiHooksFromToml,
    kimiHooksToml,
    type GuardHook,
    type HarnessProbe,
} from '../../harness-guard.ts';
import type { GuardRegistration, HarnessPackage } from '../../harness-package.ts';

const HARNESS = 'kimi-code';

/** Регистрация из текста `config.toml`: хуки и причины, по которым CLI не позвал бы ни одного. */
export function kimiRegistrationFromToml(toml: string): GuardRegistration {
    const { hooks, problems } = kimiHooksFromToml(toml);
    // Полей «не блокирует» у `[[hooks]]` нет: `guardHooksOf` такие хуки не переносит.
    return { hooks: hooks.map((h) => ({ ...h, cannotBlock: null })), problems };
}

export const harnessPackage: HarnessPackage = {
    interfaceVersion: 1,
    harness: HARNESS,
    guardRegistration: (_settings: unknown, guardHooks: readonly GuardHook[] = []) =>
        kimiRegistrationFromToml(kimiHooksToml(guardHooks)),
    // Нормализатор пакета — заглушка до 16d: событием guard блокировал бы любой вызов.
    guardInput: 'compat-16b',
    probes: HARNESS_PROBES[HARNESS],
    matcherCovers: (matcher, toolName) => harnessMatcherCovers(HARNESS, matcher, toolName),
    hookPayload: (probe: HarnessProbe, projectDir: string) =>
        harnessHookPayload(HARNESS, probe, projectDir),
    // `CLAUDE_PROJECT_DIR` Kimi Code не ставит — каталог едет в команде хука (#120).
    setsProjectDirEnv: false,
    // Транскрипта хуку Kimi Code не отдаёт (`SKILL_BARRIER_LIMIT`).
    skillBarrier: false,
    // Проба покрывает оболочку, Read, Grep и MCP — всё, что регистрация отдаёт хуку.
    guardLimit: null,
    // Барьер — команды хуков, их исполняет проба сама.
    plugin: null,
    // Сборщика конфига у пакета ещё нет (Фазы 16d2, 16d3): слои дерева не отвергаются.
    projectLayers: null,
};

/**
 * Пакет харнесса Codex (Фаза 16c, #181) — регистрация 16b, перенесённая с временного моста.
 *
 * Настроек сессии Codex не читает: барьер регистрируется аргументами `codex exec`
 * (`-c hooks.PreToolUse=[…]` с флагами доверия и включения хуков), а строится регистрация
 * из хуков барьера в общей форме (`guardHooks`). Проба читает обратно ТОТ argv, который
 * уйдёт в CLI, — как читал мост (`core/guard-probe.ts` до карточки), и тесты пробы 16b
 * держат поведение неправленными.
 *
 * Отказ разбора argv — регистрация непригодна целиком: без флага доверия Codex молча не
 * зовёт хук из `-c`, и проба, запустившая хуки сама, увидела бы барьер, которого нет.
 *
 * Поля, которых у Codex ещё нет, — объявленные заглушки: нормализатор (`normalize.ts`) и
 * доказательство скилла в описании ждут Фаз 16d и 16e.
 *
 * Версия интерфейса — литерал: под неё пакет написан (`harness-package.ts`).
 */
import {
    CODEX_GUARD_LIMIT,
    HARNESS_PROBES,
    codexGuardArgs,
    codexGuardFromArgs,
    harnessHookPayload,
    harnessMatcherCovers,
    type GuardHook,
    type HarnessProbe,
} from '../../harness-guard.ts';
import type { GuardRegistration, HarnessPackage } from '../../harness-package.ts';

const HARNESS = 'codex';

/** Регистрация из argv `codex exec`: хуки и причины, по которым CLI не позвал бы ни одного. */
export function codexRegistrationFromArgs(argv: readonly string[]): GuardRegistration {
    const { hooks, problems } = codexGuardFromArgs(argv);
    // Полей «не блокирует» у записи Codex нет: `guardHooksOf` такие хуки не переносит.
    return { hooks: hooks.map((h) => ({ ...h, cannotBlock: null })), problems };
}

export const harnessPackage: HarnessPackage = {
    interfaceVersion: 1,
    harness: HARNESS,
    guardRegistration: (_settings: unknown, guardHooks: readonly GuardHook[] = []) =>
        codexRegistrationFromArgs(codexGuardArgs(guardHooks)),
    probes: HARNESS_PROBES[HARNESS],
    matcherCovers: (matcher, toolName) => harnessMatcherCovers(HARNESS, matcher, toolName),
    hookPayload: (probe: HarnessProbe, projectDir: string) =>
        harnessHookPayload(HARNESS, probe, projectDir),
    // Каталог дерева хук получает в своей команде (`export CLAUDE_PROJECT_DIR=…;`), CLI его
    // не ставит (#120).
    setsProjectDirEnv: false,
    // Транскрипт у Codex есть, но в формате rollout, где вызова `Skill` барьер не найдёт.
    skillBarrier: false,
    guardLimit: CODEX_GUARD_LIMIT,
    // Барьер — команды хуков, их исполняет проба сама.
    plugin: null,
};

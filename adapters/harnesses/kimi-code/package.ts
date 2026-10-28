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
 * Регистрацию guard судит событием нормализатора пакета (#191, `normalize.ts`): `cwd` у `Bash`
 * и незнакомые CLI имена (`FetchURL`) совместимый вход 16b не судил. Объявленная заглушка
 * одна — доказательство скилла в описании ждёт Фазы 16e.
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
    // Нормализатор знает `path` файловых инструментов и `cwd` оболочки (#191).
    guardInput: 'event',
    probes: HARNESS_PROBES[HARNESS],
    matcherCovers: (matcher, toolName) => harnessMatcherCovers(HARNESS, matcher, toolName),
    hookPayload: (probe: HarnessProbe, projectDir: string) =>
        harnessHookPayload(HARNESS, probe, projectDir),
    // `CLAUDE_PROJECT_DIR` Kimi Code не ставит — каталог едет в команде хука (#120).
    setsProjectDirEnv: false,
    // Транскрипта хуку Kimi Code не отдаёт (`SKILL_BARRIER_LIMIT`).
    skillBarrier: false,
    // Проба покрывает оболочку (и её `cwd`), Read, Write, Grep и MCP — всё, что регистрация
    // отдаёт хуку.
    guardLimit: null,
    // Барьер — команды хуков, их исполняет проба сама.
    plugin: null,
    // Сборщик конфига — дом сессии (#196, `kimi-home.ts`). Проектные слои Kimi Code —
    // `.mcp.json` корня git и `.kimi-code/mcp.json` — CLI исполняет только в доверенном
    // каталоге, а каталог сессии недоверен; поэтому поверхностей отказа в описании нет. Отказ
    // по наличию был бы и неверен: `.mcp.json` — файл MCP Claude Code, у потребителя он есть
    // законно. Объект здесь — признак «сборщик есть» (без него старт сказал бы строку
    // `PROJECT_LAYERS_LIMIT`). Домов нет: исключать их не из чего, скан без поверхностей выходит
    // раньше, чем они нужны. Появятся поверхности — дома CLI человека (`KIMI_CODE_HOME`,
    // `~/.kimi-code`) придётся назвать, как у Codex.
    projectLayers: {
        homes: () => [],
    },
};

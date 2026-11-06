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
 * Регистрацию guard судит событием нормализатора пакета (#192, `normalize.ts`): плагин кладёт
 * хуку рядом с формой Claude Code сырое событие CLI, а перевод в форму Claude Code терял
 * `workdir` оболочки и `include` поиска. Объявленная заглушка одна — доказательство скилла в
 * описании ждёт Фазы 16e.
 *
 * Версия интерфейса — литерал: под неё пакет написан (`harness-package.ts`).
 */
import path from 'node:path';
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
import { OPENCODE_HOME_DIR } from '../../opencode-home.ts';

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
    interfaceVersion: 2,
    harness: HARNESS,
    distribution: {
        registry: 'npm',
        package: 'opencode-ai',
        bin: 'node_modules/opencode-ai/bin/opencode.exe',
    },
    guardRegistration: (_settings: unknown, guardHooks: readonly GuardHook[] = []) =>
        opencodeRegistrationFromPlugin(opencodeGuardPlugin(guardHooks)),
    // Нормализатор знает `apply_patch`, `workdir` оболочки и `include` поиска (#192).
    guardInput: 'event',
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
    // Сборщик конфига — каталог сессии со своим глобальным конфигом и выключенным проектным
    // (#197, `opencode-home.ts`). Слои дерева CLI под `OPENCODE_DISABLE_PROJECT_CONFIG` не
    // исполняет, и всё же их наличие — отказ: слой в дереве петли кто-то положил. Каталоги
    // плагинов и инструментов `.opencode/` — слой самим наличием, `opencode.json(c)` — только с
    // ключами, которые грузят или исполняют код. Перечень снят со схемы `Config` бинаря 1.19.4:
    // `plugin` (npm-плагины), `mcp` (локальный сервер — команда), `formatter` и `lsp`
    // (`command`), `shell` (бинарь инструмента bash), `command` (шаблон исполняет `` !`cmd` ``),
    // `npm` провайдера и модели (пакет провайдера грузится). `experimental` в 1.19.4 исполняемого
    // не несёт: подключа `hook` у него нет. Без этих ключей файл — законная настройка CLI
    // человека в дереве потребителя. `~/.opencode` из скана исключён: его CLI читает и без
    // проекта, и сверяет его перед спавном `opencodeIsolationProblems` с адресом дома, а не
    // «слоем в предке».
    projectLayers: {
        homes: (env: NodeJS.ProcessEnv) =>
            env.HOME ? [path.join(env.HOME, OPENCODE_HOME_DIR)] : [],
        jsonKeys: [
            'plugin',
            'mcp',
            'formatter',
            'lsp',
            'shell',
            'command',
            'provider.*.npm',
            'provider.*.models.*.provider.npm',
        ],
    },
};

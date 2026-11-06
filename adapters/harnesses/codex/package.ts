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
 * Поля, которых у Codex ещё нет, — объявленные заглушки: доказательство скилла в описании
 * ждёт Фазы 16e. Сборщик конфига — `codex-home.ts` (#195): своя функция у пакета здесь одна —
 * какие дома CLI не считать слоем проекта.
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
import { codexHumanHome } from '../../codex-home.ts';

const HARNESS = 'codex';

/** Регистрация из argv `codex exec`: хуки и причины, по которым CLI не позвал бы ни одного. */
export function codexRegistrationFromArgs(argv: readonly string[]): GuardRegistration {
    const { hooks, problems } = codexGuardFromArgs(argv);
    // Полей «не блокирует» у записи Codex нет: `guardHooksOf` такие хуки не переносит.
    return { hooks: hooks.map((h) => ({ ...h, cannotBlock: null })), problems };
}

export const harnessPackage: HarnessPackage = {
    interfaceVersion: 2,
    harness: HARNESS,
    distribution: {
        registry: 'npm',
        package: '@openai/codex',
        bin: 'node_modules/@openai/codex/bin/codex' + '.js',
    },
    guardRegistration: (_settings: unknown, guardHooks: readonly GuardHook[] = []) =>
        codexRegistrationFromArgs(codexGuardArgs(guardHooks)),
    // Нормализатор разбирает `apply_patch` в запись, удаление и перенос (#189), и guard судит
    // патч по путям — совместимый вход его пропускал (#232).
    guardInput: 'event',
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
    // Слои `.codex/` дерева и предков preflight отвергает (#195). Дом CLI человека — тоже
    // `.codex` в предке (`~/.codex`), но это дом, а не слой проекта: сессия его не читает, у неё
    // свой (`codex-home.ts`). Исключены оба дома: `CODEX_HOME`, если задан, и `~/.codex` — его
    // мог оставить прежний запуск CLI без переменной, а Codex при заданной его не читает.
    projectLayers: {
        homes: (env: NodeJS.ProcessEnv) => {
            const homes = [codexHumanHome(env), codexHumanHome({ HOME: env.HOME })];
            return [...new Set(homes.filter((h): h is string => h !== null))];
        },
    },
};

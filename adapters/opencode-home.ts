// Сборщик конфига OpenCode: свой каталог конфига, проектный конфиг выключен, окружение
// (Фаза 16d2, #197; `docs/harness-contract.md`, принцип 4).
//
// Зачем. С #121 раннер собирал каталог сессии (`OPENCODE_CONFIG_DIR`) только ради плагина
// барьера, а всё остальное CLI сливал сам — слоями, снятыми с исходника OpenCode 1.19.4
// (`Config.loadInstanceState`, `ConfigPaths.directories`):
//   • ГЛОБАЛЬНЫЙ КОНФИГ ЧЕЛОВЕКА — `<XDG_CONFIG_HOME>/opencode` (`opencode.json`, `plugin/`,
//     `tool/`). Каталог входит в список каталогов всегда, флага у него нет. Поэтому
//     `XDG_CONFIG_HOME` сессии — свой каталог рядом с каталогом сессии: плагин или инструмент
//     человека в сессию петли не едет, а `auth.json` (вход, `XDG_DATA_HOME`) остаётся тем же;
//   • ПРОЕКТ — `opencode.json(c)` от cwd до корня worktree и каталоги `.opencode/` на том же
//     пути: плагины, инструменты, npm-плагины, MCP, провайдеры, `AGENTS.md` дерева. Всё это
//     снимает `OPENCODE_DISABLE_PROJECT_CONFIG` — и вместе с ним загрузку корневого `AGENTS.md`
//     (`Instruction.systemPaths`). Поэтому правила дерева сессия получает строкой `instructions`
//     настроек раннера абсолютным путём: относительный при выключенном проекте CLI ищет в каталоге
//     конфига, а не в дереве;
//   • `~/.opencode` — каталог дома, который CLI читает ВСЕГДА, без флага (`e.up` от `home` до
//     `home`). Снять его нечем, кроме подмены `HOME`, а `HOME` нужен сессии целиком (git, вход
//     CLI). Поэтому исполняемый слой там — `plugin(s)/`, `tool(s)/`, `opencode.json(c)` — отказ
//     перед сессией с адресом: раннер дом человека не правит;
//   • ОКРУЖЕНИЕ — `OPENCODE_PURE` снимает внешние плагины, то есть барьер (`--pure`);
//     `OPENCODE_CONFIG_CONTENT` вливает конфиг с плагинами поверх всех слоёв;
//     `OPENCODE_PERMISSION`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_TEST_HOME` и прочие `OPENCODE_*`
//     раннера — настройка CLI человека. Сессия не наследует ни одной: всё `OPENCODE_*` снимается
//     префиксом, как `CODEX_*` у Codex, и ставится заново только то, что ставит раннер.
//     Перечень, снимающий барьер, — `forbiddenEnv` описания пакета; его сверка перед спавном
//     называет переменную по имени.
//
// Цена названа. Провайдер и ключ, заданные в глобальном конфиге человека (`provider.<id>`), до
// сессии больше не доходят: ключ — только входом CLI (`opencode auth login`, `auth.json`).
// Свой провайдер с адресом (`baseURL`) сессии петли пока не задать — отказ готовности это
// называет, а не сессия «Unexpected server error».
//
// КАТАЛОГ СЕССИИ CLI берёт из `PWD`, если тот задан, а не из рабочего каталога процесса (стенд
// #197: `cwd` дерева при `PWD` каталога запуска — сессия и её оболочка в каталоге запуска).
// `process.chdir` раннера `PWD` не меняет, поэтому сборщик ставит `PWD` дереву сессии сам.
//
// MCP раннера — `mcp` настроек сессии, пустой: своих серверов у раннера для OpenCode нет, а
// проектные выключены вместе с проектным конфигом.
//
// TS-модуль без билд-шага (erasable-only), без побочек: файловая система — параметром.

import path from 'node:path';

/** Файл настроек сессии — его CLI сливает поверх глобального (своего) каталога. */
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG';
/** Каталог плагина барьера (`<каталог>/plugin/*.js`) и `AGENTS.md` каталога конфига. */
export const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_CONFIG_DIR';
/** Выключатель проектного конфига: `opencode.json(c)` и `.opencode/` дерева и предков. */
export const OPENCODE_DISABLE_PROJECT_CONFIG_ENV = 'OPENCODE_DISABLE_PROJECT_CONFIG';
/** Выключатель автообновления: ревизия, снятая со стенда, под петлёй сама не меняется. */
export const OPENCODE_DISABLE_AUTOUPDATE_ENV = 'OPENCODE_DISABLE_AUTOUPDATE';
/** База глобального каталога конфига CLI (`<база>/opencode`). */
export const XDG_CONFIG_HOME_ENV = 'XDG_CONFIG_HOME';

/** Имя каталога, который становится `XDG_CONFIG_HOME` сессии, — рядом с каталогом сессии. */
export const OPENCODE_SESSION_XDG_DIR = 'xdg-config';

/** Окружение CLI раннера: префикс и имя, которое CLI ставит своим детям сам. */
export const OPENCODE_ENV_PREFIX = 'OPENCODE_';
const OPENCODE_SELF_ENV = 'OPENCODE';

const SET_BY_RUNNER: readonly string[] = [
    OPENCODE_CONFIG_ENV,
    OPENCODE_CONFIG_DIR_ENV,
    OPENCODE_DISABLE_PROJECT_CONFIG_ENV,
    OPENCODE_DISABLE_AUTOUPDATE_ENV,
];

const isCliEnv = (name: string) =>
    name.startsWith(OPENCODE_ENV_PREFIX) || name === OPENCODE_SELF_ENV;

/** Каталог дома, который CLI читает без флага, и его исполняемые слои. */
export const OPENCODE_HOME_DIR = '.opencode';
export const OPENCODE_HOME_LAYERS: readonly string[] = [
    'plugin',
    'plugins',
    'tool',
    'tools',
    'opencode.json',
    'opencode.jsonc',
];

/** `XDG_CONFIG_HOME` сессии для каталога сессии `configDir`. */
export function opencodeSessionXdg(configDir: string): string {
    return path.join(path.dirname(configDir), OPENCODE_SESSION_XDG_DIR);
}

/**
 * Окружение сессии: без окружения CLI раннера, проектный конфиг и автообновление выключены.
 * Каталог задан — свои файл настроек, каталог плагина и глобальный каталог конфига. Не задан
 * (юнит-тесты фабрики) — переменных каталога нет, выключатели стоят всё равно. Дерево задано —
 * `PWD` ему: по `PWD` CLI выбирает каталог сессии.
 */
export function opencodeSessionEnv(
    base: NodeJS.ProcessEnv,
    { configDir, cwd }: { configDir: string | null; cwd?: string | null },
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const name of Object.keys(env)) if (isCliEnv(name)) delete env[name];
    if (cwd) env.PWD = path.resolve(cwd);
    if (configDir) {
        env[OPENCODE_CONFIG_DIR_ENV] = configDir;
        env[OPENCODE_CONFIG_ENV] = path.join(configDir, 'opencode.json');
        env[XDG_CONFIG_HOME_ENV] = opencodeSessionXdg(configDir);
    }
    env[OPENCODE_DISABLE_PROJECT_CONFIG_ENV] = '1';
    env[OPENCODE_DISABLE_AUTOUPDATE_ENV] = '1';
    return env;
}

/**
 * Настройки сессии (`OPENCODE_CONFIG`): вызовы оболочки и правки без подтверждения — иначе
 * `opencode run` без человека встаёт на первом же; плагин барьера зовётся и при `allow`
 * (стенд). Правила дерева — `instructions` абсолютными путями, MCP раннера — пустой,
 * автообновление выключено и здесь.
 */
export function opencodeSessionConfig({
    instructions,
}: {
    instructions: readonly string[];
}): string {
    return `${JSON.stringify(
        {
            $schema: 'https://opencode.ai/config.json',
            permission: { bash: 'allow', edit: 'allow' },
            instructions: [...instructions],
            mcp: {},
            autoupdate: false,
        },
        null,
        4,
    )}\n`;
}

/** Глобальный каталог конфига человека — тот, что CLI взял бы сам. */
export function opencodeHumanXdg(env: NodeJS.ProcessEnv): string | null {
    if (env[XDG_CONFIG_HOME_ENV]) return env[XDG_CONFIG_HOME_ENV] as string;
    return env.HOME ? path.join(env.HOME, '.config') : null;
}

/** Исполняемые слои `~/.opencode`, которые лежат на месте: их CLI читает без флага. */
export function opencodeHomeLayers(home: string, existsFn: (p: string) => boolean): string[] {
    const dir = path.join(home, OPENCODE_HOME_DIR);
    return OPENCODE_HOME_LAYERS.map((n) => path.join(dir, n)).filter((p) => existsFn(p));
}

/**
 * Сверка собранного перед спавном: окружение, которое уйдёт в CLI, а не намерение сборщика.
 * Свои каталог и файл настроек, свой глобальный каталог конфига, не совпавший с человеческим,
 * `PWD` — дерево сессии;
 * проектный конфиг и автообновление выключены; `forbiddenEnv` описания и прочее окружение CLI
 * раннера вычищены; в `~/.opencode` исполняемых слоёв нет. Иначе сессия пошла бы без барьера
 * (`OPENCODE_PURE`) или с плагинами человека и дерева рядом с ним.
 */
export function opencodeIsolationProblems({
    env,
    configDir,
    cwd = null,
    humanXdg,
    forbiddenEnv,
    existsFn,
}: {
    env: NodeJS.ProcessEnv;
    configDir: string;
    cwd?: string | null;
    humanXdg: string | null;
    forbiddenEnv: readonly string[];
    existsFn: (p: string) => boolean;
}): string[] {
    const out: string[] = [];
    if (env[OPENCODE_CONFIG_DIR_ENV] !== configDir) {
        out.push(
            `${OPENCODE_CONFIG_DIR_ENV} сессии — не каталог, собранный раннером (${configDir})`,
        );
    }
    if (env[OPENCODE_CONFIG_ENV] !== path.join(configDir, 'opencode.json')) {
        out.push(`${OPENCODE_CONFIG_ENV} сессии — не файл настроек раннера`);
    }
    const xdg = env[XDG_CONFIG_HOME_ENV];
    if (xdg !== opencodeSessionXdg(configDir)) {
        out.push(
            `${XDG_CONFIG_HOME_ENV} сессии — не каталог раннера: глобальный конфиг человека ` +
                'слился бы с настройками сессии',
        );
    } else if (humanXdg !== null && path.resolve(xdg) === path.resolve(humanXdg)) {
        out.push(`${XDG_CONFIG_HOME_ENV} сессии совпал с каталогом конфига человека (${xdg})`);
    }
    if (env[OPENCODE_DISABLE_PROJECT_CONFIG_ENV] !== '1') {
        out.push(
            `${OPENCODE_DISABLE_PROJECT_CONFIG_ENV} не «1»: opencode.json и .opencode/ дерева ` +
                'исполнились бы',
        );
    }
    if (env[OPENCODE_DISABLE_AUTOUPDATE_ENV] !== '1') {
        out.push(`${OPENCODE_DISABLE_AUTOUPDATE_ENV} не «1»: CLI обновился бы под петлёй сам`);
    }
    if (cwd !== null && env.PWD !== path.resolve(cwd)) {
        out.push(
            `PWD сессии (${env.PWD ?? 'не задан'}) — не дерево сессии (${path.resolve(cwd)}): ` +
                'каталог сессии CLI берёт из него',
        );
    }
    for (const name of forbiddenEnv) {
        if (env[name] !== undefined) out.push(`${name} в окружении сессии снимает барьер`);
    }
    const leaked = Object.keys(env).filter(
        (n) => isCliEnv(n) && !SET_BY_RUNNER.includes(n) && !forbiddenEnv.includes(n),
    );
    if (leaked.length > 0) out.push(`окружение CLI раннера не вычищено: ${leaked.join(', ')}`);
    if (env.HOME) {
        const layers = opencodeHomeLayers(env.HOME, existsFn);
        if (layers.length > 0) {
            out.push(
                `исполняемые слои в ${path.join(env.HOME, OPENCODE_HOME_DIR)} ` +
                    `(${layers.map((p) => path.basename(p)).join(', ')}): этот каталог CLI ` +
                    'читает всегда, и сессия получила бы их рядом с барьером. Раннер дом ' +
                    'человека не правит — перенеси их в глобальный каталог конфига или удали',
            );
        }
    }
    return out;
}

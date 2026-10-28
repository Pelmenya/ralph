// Сборщик конфига Kimi Code: дом сессии, недоверенный каталог, окружение (Фаза 16d2, #196;
// `docs/harness-contract.md`, принцип 4).
//
// Зачем. Дом сессии `kimi-native` раннер собирал с #120, но собирал только хуки и вход. Три
// канала Kimi Code 2.3.2 (исходник `dist/main.mjs`) он оставлял открытыми:
//   • ДОВЕРИЕ КАТАЛОГУ. Доверенному каталогу CLI поднимает MCP-серверы проекта —
//     `<корень git>/.mcp.json` и `<cwd>/.kimi-code/mcp.json` (`loadMcpServersDetailed`). Доверие
//     — запись в `<дом>/workspace-trust/` (`TRUST_SCOPE`) ИЛИ переменная
//     `KIMI_CODE_TRUST_WORKSPACE` (`trustWorkspaceEnvTrusted`): переменная раннера доехала бы до
//     сессии, а запись, оставленная в доме сессии прошлым прогоном, жила бы до чистки руками.
//     Недоверенному каталогу проектные серверы CLI не поднимает вовсе (`listTrustGatedMcpServers`
//     — только предупреждение в stderr). Поэтому переменная вычищается, а запись доверия в доме
//     — отказ перед сессией с адресом: её туда кто-то положил, и раннер её не удаляет;
//   • АВТООБНОВЛЕНИЕ. Без `KIMI_CODE_NO_AUTO_UPDATE` CLI на старте проверяет релиз, ставит его в
//     фоне и подменяет бинарь (`isAutoUpdateDisabledByEnv`: «no check, no background install, no
//     prompt, and no staged-swap»). Ревизия, снятая со стенда, под петлёй менялась бы сама —
//     нормализатор и пробы судили бы не тот CLI. Переменная сильнее `[upgrade].auto_install`
//     конфига человека, поэтому конфиг не правится;
//   • ОКРУЖЕНИЕ CLI РАННЕРА. `KIMI_CODE_*` и прежние `KIMI_CLI_*` — настройка CLI человека (адрес
//     провайдера, хост OAuth, флаги эксперимента), и сессия их не наследует, как `CODEX_*` у
//     Codex: дом и всё остальное у неё своё. `KIMI_OAUTH_HOST` — прежнее имя хоста входа: с ним
//     токен человека ушёл бы на чужой адрес.
//
// MCP раннера — `mcp.json` дома сессии, перезаписываемый перед каждой сессией. Своих серверов
// у раннера для Kimi Code нет, и файл пуст: сервер, который сессия дописала бы в дом, до
// следующей сессии не доживает. Дописанный ПОСРЕДИ сессии CLI перечитывает на лету — это канал
// Фазы 16d3, а не этой карточки.
//
// TS-модуль без билд-шага (erasable-only), без побочек: чтение каталога — параметром.

import path from 'node:path';
import { KIMI_HOME_ENV, KIMI_MAX_STEPS_ENV } from './kimi-native.ts';

/** Доверие каталогу переменной — CLI считает каталог доверенным при любом истинном значении. */
export const KIMI_TRUST_ENV = 'KIMI_CODE_TRUST_WORKSPACE';

/** Выключатель автообновления; значение `1` — одно из истинных для CLI. */
export const KIMI_NO_AUTO_UPDATE_ENV = 'KIMI_CODE_NO_AUTO_UPDATE';

/** Каталог записей доверия в доме CLI (`TRUST_SCOPE` хранилища документов). */
export const KIMI_TRUST_DIR = 'workspace-trust';

/** `mcp.json` дома сессии: серверов раннера нет. */
export const KIMI_SESSION_MCP = '{ "mcpServers": {} }\n';

/** Окружение CLI раннера, которое сессии не наследуется (кроме того, что ставит раннер). */
export const KIMI_ENV_PREFIXES: readonly string[] = ['KIMI_CODE_', 'KIMI_CLI_'];
export const KIMI_STRIPPED_ENV: readonly string[] = ['KIMI_OAUTH_HOST'];

const SET_BY_RUNNER: readonly string[] = [KIMI_HOME_ENV, KIMI_NO_AUTO_UPDATE_ENV];

const isCliEnv = (name: string) =>
    KIMI_ENV_PREFIXES.some((p) => name.startsWith(p)) || KIMI_STRIPPED_ENV.includes(name);

/**
 * Окружение сессии: без окружения CLI раннера, со своим домом, выключенным автообновлением и
 * потолком шагов, если он задан. Дома нет (`null`, юнит-тесты фабрики) — переменной дома нет.
 */
export function kimiSessionEnv(
    base: NodeJS.ProcessEnv,
    { home, maxTurns }: { home: string | null; maxTurns?: number },
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const name of Object.keys(env)) if (isCliEnv(name)) delete env[name];
    if (home) env[KIMI_HOME_ENV] = home;
    env[KIMI_NO_AUTO_UPDATE_ENV] = '1';
    if (typeof maxTurns === 'number' && maxTurns > 0)
        env[KIMI_MAX_STEPS_ENV] = String(Math.trunc(maxTurns));
    return env;
}

/**
 * Записи доверия в доме сессии. Каталога нет — записей нет; не прочитался — бросает: «не
 * знаю» здесь не «пусто».
 */
export function kimiTrustEntries(home: string, listDirFn: (p: string) => string[]): string[] {
    try {
        return listDirFn(path.join(home, KIMI_TRUST_DIR));
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw error;
    }
}

/**
 * Сверка собранного перед спавном: окружение, которое уйдёт в CLI, и каталог доверия дома,
 * а не намерение сборщика. Свой дом, не совпавший с домом человека; автообновление выключено;
 * окружение CLI раннера и доверие переменной вычищены; записей доверия в доме нет. Иначе
 * сессия пошла бы с проектными MCP-серверами или на обновившемся под ней CLI.
 */
export function kimiIsolationProblems({
    env,
    home,
    humanHome,
    listDirFn,
}: {
    env: NodeJS.ProcessEnv;
    home: string;
    humanHome: string | null;
    listDirFn: (p: string) => string[];
}): string[] {
    const out: string[] = [];
    if (env[KIMI_HOME_ENV] !== home) {
        out.push(`${KIMI_HOME_ENV} сессии — не дом, собранный раннером (${home})`);
    }
    if (humanHome !== null && path.resolve(home) === path.resolve(humanHome)) {
        out.push(`дом сессии ${home} совпал с домом человека: сессия правила бы его конфиг`);
    }
    if (env[KIMI_NO_AUTO_UPDATE_ENV] !== '1') {
        out.push(`${KIMI_NO_AUTO_UPDATE_ENV} не «1»: CLI обновился бы под петлёй сам`);
    }
    if (env[KIMI_TRUST_ENV] !== undefined) {
        out.push(
            `${KIMI_TRUST_ENV} в окружении сессии: каталог доверен, проектные MCP поднялись бы`,
        );
    }
    const leaked = Object.keys(env).filter(
        (n) => isCliEnv(n) && !SET_BY_RUNNER.includes(n) && n !== KIMI_TRUST_ENV,
    );
    if (leaked.length > 0) out.push(`окружение CLI раннера не вычищено: ${leaked.join(', ')}`);
    const trustDir = path.join(home, KIMI_TRUST_DIR);
    try {
        const entries = kimiTrustEntries(home, listDirFn);
        if (entries.length > 0) {
            out.push(
                `в ${trustDir} записи доверия (${entries.join(', ')}): доверенному каталогу CLI ` +
                    'поднимает MCP проекта. Раннер их не удаляет — разбери, кто их записал, и удали',
            );
        }
    } catch (error) {
        out.push(
            `${trustDir} не прочитан (${error instanceof Error ? error.message : String(error)}) — ` +
                'доверие каталогу не проверено',
        );
    }
    return out;
}

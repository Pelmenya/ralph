// Сверка итогового MCP-конфига сессии с доверенным (Фаза 16d3, #198; `docs/harness-contract.md`,
// «MCP: кто объявляет сервер»).
//
// Зачем. Allowlist контура судит инструмент по имени `mcp__<server>__<tool>`, а имя сервера —
// всего лишь ключ конфига. Слой, который CLI сливает в сессию мимо раннера (глобальный каталог
// конфига OpenCode, дом CLI, переопределение в argv), может объявить сервер с ТЕМ ЖЕ именем и
// другой командой: guard разрешит чтение `mcp__forge__list`, а исполнит его чужой процесс.
// Поэтому перед каждой сессией раннер читает обратно всё, откуда CLI этой сессии возьмёт MCP, и
// сверяет каждый сервер с доверенным — `.mcp.json` дерева человека, того, что прошло ревью.
//
// Сверяются три вещи: команда, адрес и хеш записи (sha256 нормализованной записи с ключами по
// порядку: команда, аргументы, окружение, адрес, заголовки, каталог, транспорт и все остальные
// поля записи как есть). Команда и адрес названы отдельно — по ним человек узнаёт подмену; хеш
// ловит остальное: `args`, `env` с `NODE_OPTIONS`, `headersHelper` Claude Code (команда оболочки
// при подключении), `bearer_token_env_var` и `env_vars` Codex. Поле, которого разбор не знает,
// в хеш входит, а не выпадает (ревью Ф16d3: одноимённый сервер с подложенным `headersHelper`
// проходил сверку). Цена — сверка между форматами: поле, которое у одного CLI есть, а у другого
// выражено иначе, даёт расхождение, то есть отказ старта, а не пропуск.
// Сервер, которого у доверенного нет, — тоже отказ: имя вне снимка guard и так блокирует, но
// процесс сервера CLI поднимает на старте, раньше первого вызова. Сервер доверенного, которого
// нет в итоговом, — не отказ: раннер вправе отдать сессии меньше (у Codex, Kimi Code и OpenCode
// своих серверов нет вовсе). Запись, которую разбор не понял, — отказ, а не «серверов нет».
//
// Предел назван: хеш — записи, а не бинаря сервера. Подмену файла по тому же пути сверка не
// видит; его держит песочница (Фаза 16e), а не конфиг.
//
// Форматы — по CLI: `mcpServers` у Claude Code и Kimi Code, `mcp` у OpenCode (`type: local` —
// команда массивом, `environment`), `mcp_servers` у Codex (таблицы TOML и переопределения `-c`).
//
// TS-модуль без билд-шага (erasable-only), без побочек: чтение файлов — у вызывающего.

import { createHash } from 'node:crypto';
import { codexConfigOverrides, tomlInlineToJson } from './harness-guard.ts';
import { parseJsonc } from './config-layers.ts';

/** Что сверяется у сервера: команда, адрес и хеш всей нормализованной записи. */
export type TMcpIdentity = { command: string | null; url: string | null; hash: string };
export type TMcpServers = Record<string, TMcpIdentity>;

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

function stableJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (isObject(v)) {
        const keys = Object.keys(v).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
}

/** Запись сервера в общей форме — та, от которой считается хеш у каждого формата. */
type TNormalEntry = {
    command: string | null;
    args: unknown[];
    env: Record<string, unknown>;
    url: string | null;
    headers: Record<string, unknown>;
    cwd: string | null;
    /** Транспорт, если назван не по умолчанию (`stdio` у записи с командой — умолчание). */
    transport: string | null;
    /** Поля записи, которые разбор не перевёл в общую форму, — как есть. */
    rest: Record<string, unknown>;
};

/** Поля записи кроме названных — в хеш как есть. */
const restOf = (entry: Record<string, unknown>, known: readonly string[]) =>
    Object.fromEntries(Object.entries(entry).filter(([k]) => !known.includes(k)));

const MCP_JSON_KEYS = ['command', 'args', 'env', 'url', 'headers', 'cwd', 'type'];
const OPENCODE_KEYS = ['type', 'command', 'environment', 'enabled', 'url', 'headers'];
const CODEX_KEYS = ['command', 'args', 'env', 'url', 'http_headers', 'cwd'];

function identityOf(e: TNormalEntry): TMcpIdentity {
    const hash = `sha256:${createHash('sha256').update(stableJson(e)).digest('hex')}`;
    return { command: e.command, url: e.url, hash };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown, where: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${where}: не массив`);
    return v;
};
const obj = (v: unknown, where: string): Record<string, unknown> => {
    if (v === undefined) return {};
    if (!isObject(v)) throw new Error(`${where}: не объект`);
    return v;
};

/** Запись формы `.mcp.json` (Claude Code, Kimi Code): `command`, `args`, `env`, `url`, `headers`. */
export function mcpIdentity(entry: unknown, where = 'сервер'): TMcpIdentity {
    if (!isObject(entry)) throw new Error(`${where}: не объект`);
    return identityOf({
        command: str(entry.command),
        args: arr(entry.args, `${where}.args`),
        env: obj(entry.env, `${where}.env`),
        url: str(entry.url),
        headers: obj(entry.headers, `${where}.headers`),
        cwd: str(entry.cwd),
        transport: entry.type === 'stdio' ? null : str(entry.type),
        rest: restOf(entry, MCP_JSON_KEYS),
    });
}

/** Серверы объекта `mcpServers` (Claude Code, Kimi Code). Нет ключа — серверов нет. */
export function mcpServersOf(raw: unknown, where: string): TMcpServers {
    if (!isObject(raw)) throw new Error(`${where}: не объект`);
    const servers = obj(raw.mcpServers, `${where}: mcpServers`);
    const out: TMcpServers = {};
    for (const [name, entry] of Object.entries(servers)) {
        out[name] = mcpIdentity(entry, `${where}: mcpServers.${name}`);
    }
    return out;
}

/** Текст `mcp.json` в форме `mcpServers`; не JSON — бросает. */
export function jsonMcpServers(text: string, where: string): TMcpServers {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`${where}: не JSON (${(error as Error).message})`);
    }
    return mcpServersOf(raw, where);
}

/**
 * Серверы `mcp` настроек OpenCode (JSON или JSONC). `local` — команда массивом и
 * `environment`, `remote` — `url` и `headers`. Выключенный (`enabled: false`) CLI не поднимает.
 */
export function opencodeMcpServers(text: string, where: string): TMcpServers {
    let raw: unknown;
    try {
        raw = parseJsonc(text);
    } catch (error) {
        throw new Error(`${where}: не JSON (${(error as Error).message})`);
    }
    if (!isObject(raw)) throw new Error(`${where}: не объект`);
    const servers = obj(raw.mcp, `${where}: mcp`);
    const out: TMcpServers = {};
    for (const [name, entry] of Object.entries(servers)) {
        const at = `${where}: mcp.${name}`;
        if (!isObject(entry)) throw new Error(`${at}: не объект`);
        if (entry.enabled === false) continue;
        const cmd = arr(entry.command, `${at}.command`);
        if (entry.type === 'local') {
            out[name] = identityOf({
                command: str(cmd[0]),
                args: cmd.slice(1),
                env: obj(entry.environment, `${at}.environment`),
                url: null,
                headers: {},
                cwd: null,
                transport: null,
                rest: restOf(entry, OPENCODE_KEYS),
            });
        } else if (entry.type === 'remote') {
            out[name] = identityOf({
                command: null,
                args: [],
                env: {},
                url: str(entry.url),
                headers: obj(entry.headers, `${at}.headers`),
                cwd: null,
                transport: null,
                rest: restOf(entry, OPENCODE_KEYS),
            });
        } else {
            throw new Error(`${at}: тип «${String(entry.type)}» не разобран`);
        }
    }
    return out;
}

const MCP_TABLE = 'mcp_servers';

/** Ключ TOML по сегментам: точки вне кавычек, кавычки сняты. */
function tomlKey(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\s*(?:\.|$)/g)) {
        out.push(m[1] ?? m[2]);
    }
    return out;
}

function setAt(root: Record<string, unknown>, keys: readonly string[], value: unknown): void {
    let cur = root;
    for (const k of keys.slice(0, -1)) {
        if (!isObject(cur[k])) cur[k] = {};
        cur = cur[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    cur[last] = isObject(cur[last]) && isObject(value) ? { ...cur[last], ...value } : value;
}

/** Таблица `mcp_servers` в серверы: запись Codex — `command`, `args`, `env`, `url`, `cwd`. */
function codexServersOf(table: unknown, where: string): TMcpServers {
    const out: TMcpServers = {};
    for (const [name, entry] of Object.entries(obj(table, `${where}: ${MCP_TABLE}`))) {
        const at = `${where}: ${MCP_TABLE}.${name}`;
        if (!isObject(entry)) throw new Error(`${at}: не таблица`);
        out[name] = identityOf({
            command: str(entry.command),
            args: arr(entry.args, `${at}.args`),
            env: obj(entry.env, `${at}.env`),
            url: str(entry.url),
            headers: obj(entry.http_headers, `${at}.http_headers`),
            cwd: str(entry.cwd),
            transport: null,
            rest: restOf(entry, CODEX_KEYS),
        });
    }
    return out;
}

/**
 * Серверы `mcp_servers` из текста `config.toml` Codex. Разбирается подмножество: заголовки
 * таблиц и строки `ключ = значение` в одну строку. Всё прочее внутри `mcp_servers` (массив
 * таблиц, многострочное значение) — бросок: непонятый сервер не становится «серверов нет».
 */
export function codexTomlMcpServers(text: string, where: string): TMcpServers {
    const root: Record<string, unknown> = {};
    let table: string[] = [];
    text.split('\n').forEach((line, i) => {
        const s = line.trim();
        if (s === '' || s.startsWith('#')) return;
        const header = /^\[(\[?)([^\]]*)\]\]?\s*(?:#.*)?$/.exec(s);
        if (header) {
            table = tomlKey(header[2]);
            if (header[1] && table[0] === MCP_TABLE) {
                throw new Error(`${where}:${i + 1}: массив таблиц в ${MCP_TABLE} не разобран`);
            }
            return;
        }
        const eq = s.indexOf('=');
        const key = eq === -1 ? [] : [...table, ...tomlKey(s.slice(0, eq))];
        if (key[0] !== MCP_TABLE) return;
        let value: unknown;
        try {
            value = tomlInlineToJson(s.slice(eq + 1).trim());
        } catch {
            throw new Error(`${where}:${i + 1}: значение ${key.join('.')} не разобрано`);
        }
        setAt(root, key, value);
    });
    return codexServersOf(root[MCP_TABLE], where);
}

/** Серверы из переопределений `-c mcp_servers…=…` argv Codex: они сильнее любого файла. */
export function codexArgvMcpServers(argv: readonly string[]): TMcpServers {
    const root: Record<string, unknown> = {};
    for (const override of codexConfigOverrides(argv)) {
        const eq = override.indexOf('=');
        const key = tomlKey(eq === -1 ? override : override.slice(0, eq));
        if (key[0] !== MCP_TABLE) continue;
        let value: unknown;
        try {
            value = tomlInlineToJson(override.slice(eq + 1).trim());
        } catch {
            throw new Error(`argv: -c ${key.join('.')} не разобрано`);
        }
        setAt(root, key, value);
    }
    return codexServersOf(root[MCP_TABLE], 'argv');
}

/**
 * Расхождения итогового конфига с доверенным, строкой на сервер. `source` — откуда CLI возьмёт
 * итоговый (файл, argv): по нему человек найдёт, кто положил сервер.
 */
export function mcpTrustProblems(
    final: TMcpServers,
    trusted: TMcpServers,
    source: string,
): string[] {
    const problems: string[] = [];
    const show = (v: string | null) => (v === null ? 'нет' : `«${v}»`);
    for (const [name, got] of Object.entries(final)) {
        const want = trusted[name];
        if (!want) {
            problems.push(
                `${source}: сервер «${name}» не из доверенного .mcp.json — CLI поднял бы чужой процесс`,
            );
        } else if (got.command !== want.command) {
            problems.push(
                `${source}: сервер «${name}» с командой ${show(got.command)} вместо доверенной ${show(want.command)}`,
            );
        } else if (got.url !== want.url) {
            problems.push(
                `${source}: сервер «${name}» с адресом ${show(got.url)} вместо доверенного ${show(want.url)}`,
            );
        } else if (got.hash !== want.hash) {
            problems.push(
                `${source}: запись сервера «${name}» разошлась с доверенной (аргументы, окружение, прочие поля) — ` +
                    `${got.hash.slice(0, 19)}… вместо ${want.hash.slice(0, 19)}…`,
            );
        }
    }
    return problems;
}

/**
 * Снимок инвентаря MCP: живой `tools/list` серверов потребителя, проверка снимка и сверка
 * дрейфа (Фаза 16c3, #215).
 *
 * Мигратор эффектов (`.claude/hooks/mcp-effects.cjs`, #185) переводит правило «префикс
 * List/Get» в явные эффекты только по инвентарю полных имён, а инвентаря взять было неоткуда:
 * тест мигратора жил на ручном списке, а `checkInventory` проверял лишь непустоту и `mcp__`.
 * Решение (второе мнение двух моделей, принято человеком 28.10):
 *
 *   - **Источник — сами MCP-серверы**, а не CLI харнессов: опрос `tools/list` у каждого
 *     сервера, настроенного у потребителя, даёт один источник для всех четырёх харнессов.
 *     Отвергнуты файл, который ведёт человек (устаревает и не доказывает полноту), транскрипты
 *     (в них только использованное), снимок в ядре (внешний сервер версионируется отдельно) и
 *     снимок со стенда (фиктивный MCP стенда о боевом сервере ничего не доказывает).
 *   - **Результат — снимок в репозитории потребителя под ship** (`MCP_INVENTORY_PATH`):
 *     инструменты, которые петле разрешены, меняются только ревью.
 *   - **Проверка fail-closed.** Сервер не ответил, ответ неполный, дубль, пустой снимок,
 *     незнакомая версия формата — отказ с названной причиной. Пустой инвентарь молча снял бы
 *     все чтения («пустой результат — красный»).
 *   - **Дрейф — диагноз, а не разрешение.** Новый инструмент сверка называет, но в политику не
 *     пишет: guard блокирует незнакомое (`mcp-not-allowed`), лечение — PR обновления снимка.
 *
 * Ключ политики — канонический `mcp__<server>__<tool>`. Имена, которые харнесс выдаёт хуку
 * иначе, переводит `mcpNames` его пакета (`adapters/harnesses/*\/descriptor.json`); пустой
 * перевод — харнесс зовёт инструменты каноническими именами (Claude Code). Перевод, который
 * есть, обязан быть полным и взаимно-однозначным: имя без перевода guard видел бы незнакомым,
 * а два имени в одно слили бы два инструмента в одно решение.
 *
 * **Страница — отдельный процесс сервера.** Ядро синхронно, а постраничная выдача требует
 * ответа до следующего запроса. Поэтому каждая страница — `spawnSync` с `initialize`,
 * `notifications/initialized` и `tools/list` на stdin: сервер отвечает и выходит на конце
 * ввода. Курсор MCP непрозрачен и по спецификации не привязан к сессии; сервер, у которого
 * привязан, повторит курсор или не ответит — это отказ, а не тихо обрезанный список.
 *
 * Чего сборщик не видит, сказано вслух: серверы берутся из `.mcp.json` дерева потребителя
 * (проектный слой Claude Code), транспорт — только stdio. Сервер пользовательского слоя CLI
 * в снимок не попадёт, и его инструменты guard будет блокировать как незнакомые — это
 * ужесточение, а не дыра. Сервер с `url` (http/sse) — отказ сборщика с его именем.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LOOP_KEY_ENVS } from '../adapters/live-probe-cases.ts';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

/** Снимок — файл потребителя, путь от корня его дерева. */
export const MCP_INVENTORY_PATH = '.claude/ralph/mcp-inventory.json';

/** Откуда сборщик берёт серверы: проектный слой MCP у Claude Code. */
export const MCP_SERVERS_PATH = '.mcp.json';

export const MCP_INVENTORY_SCHEMA_VERSION = 1;

/** Версия протокола, с которой сборщик представляется серверу. */
export const MCP_CLIENT_PROTOCOL = '2025-06-18';

/** Потолок страниц одного сервера: курсор, который не кончается, — неполный ответ. */
export const MCP_MAX_PAGES = 100;

const PAGE_TIMEOUT_MS = 30_000;

// Сегмент канонического имени. `__` внутри сегмента сделал бы границу сервера и инструмента
// неоднозначной — ровно та потеря, из-за которой правило MCP режет имена OpenCode.
const SEGMENT_RE = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

export type TMcpServerConfig = {
    command?: unknown;
    args?: unknown;
    env?: unknown;
    url?: unknown;
    type?: unknown;
};

export type TMcpTool = { name: string; inputSchema: unknown };

export type TMcpServerInventory = {
    /** `serverInfo.version` из `initialize`; сервер не сообщил — `null`. */
    version: string | null;
    tools: TMcpTool[];
};

export type TMcpInventory = Record<string, TMcpServerInventory>;

/** Ответ одной страницы `tools/list` вместе с версией сервера из того же `initialize`. */
export type TMcpPage = { version: string | null; tools: unknown; nextCursor: unknown };

export type TListPageFn = (
    server: string,
    config: TMcpServerConfig,
    cursor: string | undefined,
) => TMcpPage;

export type TSnapshotTool = { name: string; tool: string; inputSchema: unknown };

export type TSnapshotServer = { version: string | null; hash: string; tools: TSnapshotTool[] };

export type TMcpSnapshot = {
    schemaVersion: number;
    collectedAt: string;
    hash: string;
    servers: Record<string, TSnapshotServer>;
};

export type TResult<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

export function canonicalMcpName(server: string, tool: string): string {
    return `mcp__${server}__${tool}`;
}

// ---------------------------------------------------------------------------------------
// Сборщик
// ---------------------------------------------------------------------------------------

/** Серверы из текста `.mcp.json`. Битый файл или не та форма — отказ, а не «серверов нет». */
export function parseMcpServers(text: string): TResult<Record<string, TMcpServerConfig>> {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return { ok: false, problems: [`${MCP_SERVERS_PATH}: не JSON (${(e as Error).message})`] };
    }
    if (!isRecord(raw) || !isRecord(raw.mcpServers)) {
        return { ok: false, problems: [`${MCP_SERVERS_PATH}: нет объекта mcpServers`] };
    }
    const problems: string[] = [];
    for (const [name, cfg] of Object.entries(raw.mcpServers)) {
        if (!isRecord(cfg)) problems.push(`сервер ${name}: настройки не объект`);
    }
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, value: raw.mcpServers as Record<string, TMcpServerConfig> };
}

/**
 * Инвентарь всех настроенных серверов. Отказ одного не прячет остальные: человек чинит
 * настройки за один заход, а не по серверу на запуск. Ни одного сервера — тоже отказ: снимок
 * без серверов сделал бы политику MCP пустой молча.
 */
export function collectInventory(
    servers: Record<string, TMcpServerConfig>,
    listPageFn: TListPageFn,
): TResult<TMcpInventory> {
    const names = Object.keys(servers).sort();
    if (names.length === 0) return { ok: false, problems: ['не настроено ни одного MCP-сервера'] };
    const problems: string[] = [];
    const inventory: TMcpInventory = {};
    for (const name of names) {
        const res = collectServer(name, servers[name] ?? {}, listPageFn);
        if (res.ok) inventory[name] = res.value;
        else problems.push(...res.problems.map((p) => `сервер ${name}: ${p}`));
    }
    return problems.length > 0 ? { ok: false, problems } : { ok: true, value: inventory };
}

function collectServer(
    name: string,
    config: TMcpServerConfig,
    listPageFn: TListPageFn,
): TResult<TMcpServerInventory> {
    if (!SEGMENT_RE.test(name)) {
        return { ok: false, problems: ['имя сервера не даёт однозначного mcp__<server>__<tool>'] };
    }
    const tools: TMcpTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let version: string | null = null;
    for (let page = 1; ; page++) {
        if (page > MCP_MAX_PAGES) {
            return { ok: false, problems: [`ответ неполный: больше ${MCP_MAX_PAGES} страниц`] };
        }
        let res: TMcpPage;
        try {
            res = listPageFn(name, config, cursor);
        } catch (e) {
            return { ok: false, problems: [`не ответил: ${(e as Error).message}`] };
        }
        if (page === 1) version = res.version;
        else if (res.version !== version) {
            return { ok: false, problems: [`версия сменилась между страницами`] };
        }
        if (!Array.isArray(res.tools)) {
            return { ok: false, problems: [`ответ неполный: страница ${page} без tools`] };
        }
        for (const t of res.tools) {
            if (!isRecord(t) || typeof t.name !== 'string' || t.name === '') {
                return { ok: false, problems: [`ответ неполный: инструмент без имени`] };
            }
            tools.push({ name: t.name, inputSchema: t.inputSchema ?? null });
        }
        if (res.nextCursor === undefined || res.nextCursor === null) break;
        if (typeof res.nextCursor !== 'string' || res.nextCursor === '') {
            return { ok: false, problems: [`ответ неполный: nextCursor не строка`] };
        }
        if (seenCursors.has(res.nextCursor)) {
            return { ok: false, problems: [`ответ неполный: курсор ${res.nextCursor} повторился`] };
        }
        seenCursors.add(res.nextCursor);
        cursor = res.nextCursor;
    }
    return { ok: true, value: { version, tools } };
}

/** `${VAR}` и `${VAR:-default}` — та же подстановка, что Claude Code делает в `.mcp.json`. */
export function expandMcpValue(
    value: string,
    env: Record<string, string | undefined>,
): TResult<string> {
    const missing: string[] = [];
    const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, v, dflt) => {
        const got = env[v];
        if (got !== undefined) return got;
        if (dflt !== undefined) return dflt;
        missing.push(v);
        return '';
    });
    if (missing.length > 0)
        return { ok: false, problems: [`нет переменной ${missing.join(', ')}`] };
    return { ok: true, value: out };
}

/**
 * Окружение процесса сервера собирается с нуля, а не копией окружения раннера. Сборщик —
 * процесс раннера, а не сессии: копия отдала бы серверу (часто `npx -y …` из реестра или
 * скрипт дерева) все ключи ротации, токен форжа и ключ живой пробы — больше, чем сам CLI
 * отдаёт серверу в сессии. Сверх белого списка сервер получает только `env` своей записи
 * `.mcp.json`; прокси — в списке, потому что `npx` за прокси хоста иначе не скачает пакет.
 */
export const MCP_SERVER_BASE_ENV: readonly string[] = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TMPDIR',
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
];

export type TSpawnSyncFn = (
    cmd: string,
    args: string[],
    opts: {
        input: string;
        env: Record<string, string | undefined>;
        cwd: string;
        encoding: 'utf-8';
        timeout: number;
    },
) => { stdout?: string | null; stderr?: string | null; status: number | null; error?: Error };

function realSpawnSync(...a: Parameters<TSpawnSyncFn>): ReturnType<TSpawnSyncFn> {
    guardSideEffect(
        `spawnSync MCP-сервера ${a[0]}`,
        'stdioListPage: подмени spawnFn (подставной сервер) или listPageFn целиком.',
    );
    return spawnSync(...a);
}

/**
 * Страница `tools/list` у stdio-сервера: процесс на страницу (см. докблок модуля). Ответ
 * берётся по `id`, а не по порядку строк: сервер вправе слать уведомления между ответами.
 * Ответ найден — код выхода не важен (сервер, убитый сроком после ответа, ответил полностью);
 * не найден или пришёл ошибкой — бросок с причиной.
 *
 * `cwd` обязателен: это корень дерева, из которого прочитан `.mcp.json`. Без него процесс
 * наследовал бы каталог раннера — после `chdir` это дерево ветки фазы, и относительный путь
 * сервера (`node ./tools/mcp.mjs`, `npx` с поиском по `node_modules`) исполнял бы
 * неотревьюенный код, который правила сессия. Переменные `deniedEnv` (к ключам петли
 * `LOOP_KEY_ENVS` вызывающий добавляет ключ пробы и токены форжа) не раскрываются и серверу
 * не отдаются даже по прямому указанию `.mcp.json`.
 */
export function stdioListPage(
    server: string,
    config: TMcpServerConfig,
    cursor: string | undefined,
    {
        cwd,
        spawnFn = realSpawnSync,
        env = process.env,
        deniedEnv = [],
        timeoutMs = PAGE_TIMEOUT_MS,
    }: {
        cwd: string;
        spawnFn?: TSpawnSyncFn;
        env?: Record<string, string | undefined>;
        deniedEnv?: readonly string[];
        timeoutMs?: number;
    },
): TMcpPage {
    if (config.url !== undefined || (config.type !== undefined && config.type !== 'stdio')) {
        throw new Error('транспорт не stdio — сборщик опрашивает только stdio-серверы');
    }
    if (typeof config.command !== 'string' || config.command === '') {
        throw new Error('нет command');
    }
    const args = config.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new Error('args не массив строк');
    }
    if (config.env !== undefined && !isRecord(config.env)) throw new Error('env не объект');
    const denied = new Set([...LOOP_KEY_ENVS, ...deniedEnv]);
    const visible: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) if (!denied.has(k)) visible[k] = v;
    const expand = (v: string) => {
        for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) {
            if (denied.has(m[1]!)) {
                throw new Error(`переменная ${m[1]} — ключ раннера, серверу не отдаётся`);
            }
        }
        const r = expandMcpValue(v, visible);
        if (!r.ok) throw new Error(r.problems.join('; '));
        return r.value;
    };
    const serverEnv: Record<string, string | undefined> = {};
    for (const k of MCP_SERVER_BASE_ENV) if (visible[k] !== undefined) serverEnv[k] = visible[k];
    for (const [k, v] of Object.entries((config.env ?? {}) as Record<string, unknown>)) {
        if (typeof v !== 'string') throw new Error(`env.${k} не строка`);
        if (denied.has(k)) throw new Error(`env.${k} — ключ раннера, серверу не отдаётся`);
        serverEnv[k] = expand(v);
    }
    const input =
        [
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: MCP_CLIENT_PROTOCOL,
                    capabilities: {},
                    clientInfo: { name: 'ralph-mcp-inventory', version: '1' },
                },
            },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: cursor === undefined ? {} : { cursor },
            },
        ]
            .map((m) => JSON.stringify(m))
            .join('\n') + '\n';
    const r = spawnFn(expand(config.command), (args as string[]).map(expand), {
        input,
        env: serverEnv,
        cwd,
        encoding: 'utf-8',
        timeout: timeoutMs,
    });
    const byId = new Map<unknown, Record<string, unknown>>();
    for (const line of String(r.stdout ?? '').split('\n')) {
        if (line.trim() === '') continue;
        try {
            const msg = JSON.parse(line);
            if (isRecord(msg) && 'id' in msg) byId.set(msg.id, msg);
        } catch {
            // Не JSON-RPC строка в stdout — не ответ; ответа нет — отказ ниже назовёт это.
        }
    }
    const init = byId.get(1);
    const list = byId.get(2);
    if (!init || !list) {
        const why = r.error ? r.error.message : `код ${r.status}`;
        const err = String(r.stderr ?? '')
            .trim()
            .split('\n')
            .slice(-1)[0];
        throw new Error(
            `нет ответа на ${init ? 'tools/list' : 'initialize'} (${why})${err ? `: ${err}` : ''}`,
        );
    }
    for (const [what, msg] of [
        ['initialize', init],
        ['tools/list', list],
    ] as const) {
        if (msg.error !== undefined)
            throw new Error(`${what} ошибкой: ${JSON.stringify(msg.error)}`);
        if (!isRecord(msg.result)) throw new Error(`${what} без result`);
    }
    const info = (init.result as Record<string, unknown>).serverInfo;
    const version = isRecord(info) && typeof info.version === 'string' ? info.version : null;
    const result = list.result as Record<string, unknown>;
    return { version, tools: result.tools, nextCursor: result.nextCursor };
}

// ---------------------------------------------------------------------------------------
// Снимок
// ---------------------------------------------------------------------------------------

/** JSON с ключами по порядку: хеш не должен зависеть от порядка полей в ответе сервера. */
function stableJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (isRecord(v)) {
        const keys = Object.keys(v).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}

const sha256 = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

function serverHash(version: string | null, tools: readonly TSnapshotTool[]): string {
    return sha256(stableJson({ version, tools }));
}

function snapshotHash(servers: Record<string, TSnapshotServer>): string {
    return sha256(stableJson(servers));
}

/** Снимок из инвентаря: имена канонические, инструменты по имени — дифф снимка читаем глазами. */
export function buildSnapshot(inventory: TMcpInventory, collectedAt: string): TMcpSnapshot {
    const servers: Record<string, TSnapshotServer> = {};
    for (const name of Object.keys(inventory).sort()) {
        const srv = inventory[name]!;
        const tools = srv.tools
            .map((t) => ({
                name: canonicalMcpName(name, t.name),
                tool: t.name,
                inputSchema: t.inputSchema,
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        servers[name] = { version: srv.version, hash: serverHash(srv.version, tools), tools };
    }
    return {
        schemaVersion: MCP_INVENTORY_SCHEMA_VERSION,
        collectedAt,
        hash: snapshotHash(servers),
        servers,
    };
}

export function serializeSnapshot(s: TMcpSnapshot): string {
    return `${JSON.stringify(s, null, 4)}\n`;
}

/** Перевод имён одного харнесса: `mcpNames` его описания пакета. */
export type THarnessMcpNames = {
    harness: string;
    mcpNames: Record<string, { server: string; tool: string }>;
};

/**
 * Переводы имён всех пакетов реестра — один набор для всех проверок снимка: сверки перед
 * сессией, сборки комплекта update и `verify-mcp`. Проверка без переводов в одном из мест
 * пропустила бы снимок, который другое место объявит `invalid`, — разница скрыта, пока
 * `mcpNames` у всех пакетов пуст.
 */
export function harnessMcpNames(registry: {
    packages: ReadonlyMap<
        string,
        { descriptor: { mcpNames: Record<string, { server: string; tool: string }> } }
    >;
}): THarnessMcpNames[] {
    return [...registry.packages].map(([harness, h]) => ({
        harness,
        mcpNames: h.descriptor.mcpNames,
    }));
}

/**
 * Проверка снимка. Версия формата — первой и без разбора остального: снимок новой версии,
 * прочитанный старым кодом, терял бы молча поле, ради которого версию подняли. Дальше —
 * форма, дубли, канонические имена, хеши (правка руками мимо сборщика), состав серверов
 * против настроенных и перевод имён каждого харнесса.
 */
export function checkSnapshot(
    raw: unknown,
    {
        configured,
        harnesses = [],
    }: { configured: readonly string[]; harnesses?: readonly THarnessMcpNames[] },
): TResult<TMcpSnapshot> {
    const at = MCP_INVENTORY_PATH;
    if (!isRecord(raw)) return { ok: false, problems: [`${at}: не объект`] };
    if (raw.schemaVersion !== MCP_INVENTORY_SCHEMA_VERSION) {
        return {
            ok: false,
            problems: [
                `${at}: незнакомая версия формата ${JSON.stringify(raw.schemaVersion)} ` +
                    `(знаю ${MCP_INVENTORY_SCHEMA_VERSION})`,
            ],
        };
    }
    const problems: string[] = [];
    for (const k of Object.keys(raw)) {
        if (!['schemaVersion', 'collectedAt', 'hash', 'servers'].includes(k)) {
            problems.push(`${at}: незнакомое поле ${k}`);
        }
    }
    if (typeof raw.collectedAt !== 'string' || Number.isNaN(Date.parse(raw.collectedAt))) {
        problems.push(`${at}: collectedAt не время`);
    }
    if (!isRecord(raw.servers)) return { ok: false, problems: [...problems, `${at}: нет servers`] };
    const servers = raw.servers;
    const seen = new Set<string>();
    let total = 0;
    for (const [name, srv] of Object.entries(servers)) {
        const sat = `${at}: сервер ${name}`;
        if (!isRecord(srv) || !Array.isArray(srv.tools)) {
            problems.push(`${sat}: нет списка tools`);
            continue;
        }
        if (srv.version !== null && typeof srv.version !== 'string') {
            problems.push(`${sat}: version не строка и не null`);
        }
        for (const t of srv.tools) {
            if (!isRecord(t) || typeof t.name !== 'string' || typeof t.tool !== 'string') {
                problems.push(`${sat}: инструмент без name/tool`);
                continue;
            }
            total++;
            if (t.name !== canonicalMcpName(name, t.tool) || !SEGMENT_RE.test(t.tool)) {
                problems.push(`${sat}: имя ${t.name} не каноническое для ${name}/${t.tool}`);
            }
            if (seen.has(t.name)) problems.push(`${sat}: дубль ${t.name}`);
            seen.add(t.name);
        }
        const hash = serverHash(
            (srv.version ?? null) as string | null,
            srv.tools as TSnapshotTool[],
        );
        if (srv.hash !== hash) problems.push(`${sat}: хеш не сходится с содержимым`);
    }
    if (total === 0) problems.push(`${at}: снимок пуст — ни одного инструмента`);
    if (raw.hash !== snapshotHash(servers as Record<string, TSnapshotServer>)) {
        problems.push(`${at}: общий хеш не сходится с содержимым`);
    }
    for (const name of configured) {
        if (!Object.hasOwn(servers, name)) problems.push(`${at}: настроенного сервера ${name} нет`);
    }
    for (const name of Object.keys(servers)) {
        if (!configured.includes(name)) problems.push(`${at}: сервер ${name} не настроен`);
    }
    for (const h of harnesses) problems.push(...harnessNameProblems(seen, h));
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, value: raw as unknown as TMcpSnapshot };
}

/**
 * Перевод имён харнесса против канонических имён снимка. Пустой `mcpNames` — харнесс зовёт
 * каноническими именами сам. Непустой обязан покрыть каждое имя снимка ровно одним выданным
 * именем и не ссылаться на инструмент, которого в снимке нет.
 */
export function harnessNameProblems(
    canonical: ReadonlySet<string>,
    { harness, mcpNames }: THarnessMcpNames,
): string[] {
    const emitted = Object.entries(mcpNames);
    if (emitted.length === 0) return [];
    const problems: string[] = [];
    const byTarget = new Map<string, string[]>();
    for (const [name, target] of emitted) {
        const key = canonicalMcpName(target.server, target.tool);
        byTarget.set(key, [...(byTarget.get(key) ?? []), name]);
        if (!canonical.has(key)) {
            problems.push(
                `${harness}: mcpNames.${name} → ${key}, а такого инструмента в снимке нет`,
            );
        }
    }
    for (const [key, names] of byTarget) {
        if (names.length > 1) {
            problems.push(`${harness}: ${names.join(', ')} переведены в одно имя ${key}`);
        }
    }
    for (const key of [...canonical].sort()) {
        if (!byTarget.has(key)) problems.push(`${harness}: у ${key} нет перевода в mcpNames`);
    }
    return problems;
}

/** Снимок из текста файла: битый JSON — отказ тем же видом, что и проверка. */
export function parseSnapshot(
    text: string,
    opts: Parameters<typeof checkSnapshot>[1],
): TResult<TMcpSnapshot> {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return {
            ok: false,
            problems: [`${MCP_INVENTORY_PATH}: не JSON (${(e as Error).message})`],
        };
    }
    return checkSnapshot(raw, opts);
}

// ---------------------------------------------------------------------------------------
// Дрейф
// ---------------------------------------------------------------------------------------

export type TServerDrift = {
    server: string;
    /** Сервера не было в снимке / нет в свежем инвентаре. */
    presence?: 'added' | 'removed';
    version?: { from: string | null; to: string | null };
    added: string[];
    removed: string[];
    renamed: { from: string; to: string }[];
    schemaChanged: string[];
};

/**
 * Свежий инвентарь против снимка. Переименование — пара «удалён / добавлен» с той же схемой
 * входа, один к одному: имя сменилось, а контракт вызова нет. Пара засчитывается, только если
 * она однозначна: схема непустая (у инструмента без параметров она совпадает с любым другим
 * таким же) и ровно одна с каждой стороны. Иначе удаление A и добавление несвязанного B
 * читались бы как «A → B», и человек правил бы политику по ложному диагнозу. Разрешений
 * сверка не трогает — она возвращает диагноз, а политику эффектов меняет только PR
 * обновления снимка.
 */
// Схемы, которые не различают инструменты: нет схемы, пустой объект, объект без параметров.
const EMPTY_SCHEMAS = new Set(
    [null, {}, { type: 'object' }, { type: 'object', properties: {} }].map(stableJson),
);

export function inventoryDrift(snapshot: TMcpSnapshot, fresh: TMcpInventory): TServerDrift[] {
    const out: TServerDrift[] = [];
    const names = [...new Set([...Object.keys(snapshot.servers), ...Object.keys(fresh)])].sort();
    for (const server of names) {
        const before = snapshot.servers[server];
        const after = fresh[server];
        const d: TServerDrift = {
            server,
            added: [],
            removed: [],
            renamed: [],
            schemaChanged: [],
        };
        if (!before) d.presence = 'added';
        if (!after) d.presence = 'removed';
        const was = new Map((before?.tools ?? []).map((t) => [t.name, stableJson(t.inputSchema)]));
        const now = new Map(
            (after?.tools ?? []).map((t) => [
                canonicalMcpName(server, t.name),
                stableJson(t.inputSchema ?? null),
            ]),
        );
        const gone = [...was.keys()].filter((n) => !now.has(n)).sort();
        const born = [...now.keys()].filter((n) => !was.has(n)).sort();
        const count = (names: readonly string[], of: Map<string, string>, schema: string) =>
            names.filter((n) => of.get(n) === schema).length;
        for (const from of gone) {
            const schema = was.get(from)!;
            const unambiguous =
                !EMPTY_SCHEMAS.has(schema) &&
                count(gone, was, schema) === 1 &&
                count(born, now, schema) === 1;
            const to = unambiguous ? born.find((n) => now.get(n) === schema) : undefined;
            if (to === undefined) d.removed.push(from);
            else {
                d.renamed.push({ from, to });
                born.splice(born.indexOf(to), 1);
            }
        }
        d.added.push(...born);
        for (const [n, schema] of was) {
            if (now.has(n) && now.get(n) !== schema) d.schemaChanged.push(n);
        }
        if (before && after && before.version !== after.version) {
            d.version = { from: before.version, to: after.version };
        }
        const changed =
            d.presence !== undefined ||
            d.version !== undefined ||
            d.added.length + d.removed.length + d.renamed.length + d.schemaChanged.length > 0;
        if (changed) out.push(d);
    }
    return out;
}

/** Диагноз дрейфа строками: по строке на сервер, каждое изменение своим словом. */
export function formatDrift(drift: readonly TServerDrift[]): string[] {
    return drift.map((d) => {
        const parts: string[] = [];
        if (d.presence === 'added') parts.push('сервер добавлен, в снимке его нет');
        if (d.presence === 'removed') parts.push('сервер пропал, в снимке он есть');
        if (d.version) parts.push(`версия ${d.version.from ?? '—'} → ${d.version.to ?? '—'}`);
        if (d.added.length > 0) parts.push(`добавлены ${d.added.join(', ')}`);
        if (d.removed.length > 0) parts.push(`удалены ${d.removed.join(', ')}`);
        if (d.renamed.length > 0) {
            parts.push(`переименованы ${d.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}`);
        }
        if (d.schemaChanged.length > 0) parts.push(`сменилась схема ${d.schemaChanged.join(', ')}`);
        return `MCP ${d.server}: ${parts.join('; ')}`;
    });
}

// ---------------------------------------------------------------------------------------
// Сверка перед сессией
// ---------------------------------------------------------------------------------------

/** Повторный опрос при тех же `.mcp.json` и снимке — не чаще (см. `warnMcpDrift`). */
export const MCP_DRIFT_RECHECK_MS = 60 * 60_000;

/** Память последней сверки за прогон: отпечаток файлов и время опроса. */
export type TMcpDriftMemo = { key: string | null; at: number };

export type TDriftCheck =
    | { status: 'absent' }
    | { status: 'clean' }
    | { status: 'drift'; lines: string[] }
    | { status: 'unreachable'; problems: string[] }
    | { status: 'invalid'; problems: string[] };

/**
 * Сверка перед сессией: снимок дерева потребителя против свежего опроса.
 *
 *   - снимка нет — `absent`: миграция данных его ещё не завела (#218), и стоп здесь
 *     остановил бы каждую петлю до неё; раннер называет это строкой `⚠`;
 *   - снимок или `.mcp.json` битый — `invalid`, тоже диагноз без стопа: guard судит по
 *     данным контура, а не по снимку, и сессию битый снимок не открывает; держит его
 *     обновление (#218) и `verify-mcp`, которые такой снимок не примут;
 *   - сервер не ответил — `unreachable`, диагноз без стопа: guard блокирует незнакомое и без
 *     сверки, а сетевой сбой сервера — не повод гасить петлю;
 *   - дрейф — `drift`, диагноз без стопа и без разрешений.
 */
export function checkMcpDrift({
    readFn,
    listPageFn,
    harnesses = [],
}: {
    /** Текст файла по пути от корня потребителя; нет файла — `null`. */
    readFn: (rel: string) => string | null;
    listPageFn: TListPageFn;
    harnesses?: readonly THarnessMcpNames[];
}): TDriftCheck {
    const snapText = readFn(MCP_INVENTORY_PATH);
    if (snapText === null) return { status: 'absent' };
    const serversText = readFn(MCP_SERVERS_PATH);
    if (serversText === null) {
        return { status: 'invalid', problems: [`снимок есть, а ${MCP_SERVERS_PATH} нет`] };
    }
    const servers = parseMcpServers(serversText);
    if (!servers.ok) return { status: 'invalid', problems: servers.problems };
    const snap = parseSnapshot(snapText, { configured: Object.keys(servers.value), harnesses });
    if (!snap.ok) return { status: 'invalid', problems: snap.problems };
    const fresh = collectInventory(servers.value, listPageFn);
    if (!fresh.ok) return { status: 'unreachable', problems: fresh.problems };
    const drift = inventoryDrift(snap.value, fresh.value);
    return drift.length === 0
        ? { status: 'clean' }
        : { status: 'drift', lines: formatDrift(drift) };
}

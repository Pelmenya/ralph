import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
    buildSnapshot,
    checkMcpDrift,
    checkSnapshot,
    collectInventory,
    expandMcpValue,
    formatDrift,
    harnessNameProblems,
    inventoryDrift,
    MCP_INVENTORY_PATH,
    MCP_MAX_PAGES,
    MCP_SERVERS_PATH,
    parseMcpServers,
    parseSnapshot,
    serializeSnapshot,
    stdioListPage,
    type TListPageFn,
    type TMcpInventory,
    type TMcpServerConfig,
    type TSpawnSyncFn,
} from './mcp-inventory.ts';

import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

const require = createRequire(import.meta.url);
const { parseConsumerData } = require('../.claude/hooks/consumer-data.cjs');
const { mcpAllowedByEffect } = require('../.claude/hooks/guard-rules.cjs');

const PAGED = join(import.meta.dirname, '..', 'tests', '__fixtures__', 'paged-mcp.mjs');

/** Подставной сервер: настоящий процесс по stdio. */
const paged = (count: number, page: number, version = '1.0.0', prefix = 'tool') => ({
    command: process.execPath,
    args: [PAGED, String(count), String(page), version, prefix],
});

const realPage: TListPageFn = (server, config, cursor) =>
    stdioListPage(server, config, cursor, {
        cwd: import.meta.dirname,
        spawnFn: spawnSync as unknown as TSpawnSyncFn,
    });

const AT = '2026-10-28T00:00:00.000Z';

const inv = (): TMcpInventory => ({
    forge: {
        version: '2.0',
        tools: [
            { name: 'GetIssue', inputSchema: { type: 'object', properties: { id: {} } } },
            { name: 'ListIssues', inputSchema: { type: 'object' } },
            { name: 'CreateIssue', inputSchema: { type: 'object', properties: { t: {} } } },
        ],
    },
    docs: { version: null, tools: [{ name: 'search', inputSchema: { type: 'object' } }] },
});

const snap = () => buildSnapshot(inv(), AT);

describe('сборщик на подставном MCP-сервере', () => {
    it('проходит постраничную выдачу и опрашивает оба сервера', () => {
        const res = collectInventory({ a: paged(7, 3), b: paged(2, 5, '-', 'x') }, realPage);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.a!.tools.map((t) => t.name)).toEqual([
            'tool_0',
            'tool_1',
            'tool_2',
            'tool_3',
            'tool_4',
            'tool_5',
            'tool_6',
        ]);
        expect(res.value.a!.version).toBe('1.0.0');
        expect(res.value.b).toMatchObject({
            version: null,
            tools: [{ name: 'x_0' }, { name: 'x_1' }],
        });
        expect(res.value.a!.tools[3]!.inputSchema).toEqual({
            type: 'object',
            properties: { arg3: { type: 'string' } },
        });
    });

    it('один сервер не ответил — отказ с его именем, ответивший не прячет его', () => {
        const res = collectInventory(
            {
                ok: paged(2, 1),
                silent: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
            },
            realPage,
        );
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.problems).toHaveLength(1);
        expect(res.problems[0]).toMatch(
            /^сервер silent: не ответил: нет ответа на initialize \(код 3\)/,
        );
    });

    it('ни одного сервера — отказ, а не пустой инвентарь', () => {
        expect(collectInventory({}, realPage)).toEqual({
            ok: false,
            problems: ['не настроено ни одного MCP-сервера'],
        });
    });

    it('неполный ответ: без tools, инструмент без имени, кривой и повторный курсор, потолок страниц', () => {
        const run = (pageFn: TListPageFn) => {
            const r = collectInventory({ s: {} }, pageFn);
            return r.ok ? [] : r.problems;
        };
        expect(run(() => ({ version: null, tools: undefined, nextCursor: undefined }))).toEqual([
            'сервер s: ответ неполный: страница 1 без tools',
        ]);
        expect(run(() => ({ version: null, tools: [{}], nextCursor: undefined }))).toEqual([
            'сервер s: ответ неполный: инструмент без имени',
        ]);
        expect(run(() => ({ version: null, tools: [], nextCursor: 5 }))).toEqual([
            'сервер s: ответ неполный: nextCursor не строка',
        ]);
        expect(run(() => ({ version: null, tools: [], nextCursor: 'same' }))).toEqual([
            'сервер s: ответ неполный: курсор same повторился',
        ]);
        let n = 0;
        expect(run(() => ({ version: null, tools: [], nextCursor: String(n++) }))).toEqual([
            `сервер s: ответ неполный: больше ${MCP_MAX_PAGES} страниц`,
        ]);
        let v = 0;
        expect(
            run(() => ({ version: String(v++), tools: [], nextCursor: v < 2 ? 'c' : undefined })),
        ).toEqual(['сервер s: версия сменилась между страницами']);
    });

    it('имя сервера с двойным подчёркиванием — отказ: граница имени неоднозначна', () => {
        const r = collectInventory({ a__b: {} }, () => ({
            version: null,
            tools: [],
            nextCursor: null,
        }));
        expect(r).toEqual({
            ok: false,
            problems: ['сервер a__b: имя сервера не даёт однозначного mcp__<server>__<tool>'],
        });
    });
});

describe('stdioListPage — транспорт страницы', () => {
    const fake =
        (stdout: string, extra: Partial<ReturnType<TSpawnSyncFn>> = {}) =>
        (calls: unknown[] = []): TSpawnSyncFn =>
        (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { stdout, stderr: '', status: 0, ...extra };
        };
    const ok =
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { version: '3' } } }) +
        '\n{"jsonrpc":"2.0","method":"notifications/x"}\nне json\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [], nextCursor: 'n' } });

    it('курсор и подстановка переменных уходят серверу, ответ берётся по id', () => {
        const calls: any[] = [];
        const page = stdioListPage(
            's',
            { command: '${BIN}', args: ['--k', '${KEY:-dflt}'], env: { T: 'v-${TOK}' } },
            'c1',
            {
                cwd: '/path/to/app',
                spawnFn: fake(ok)(calls),
                env: { BIN: '/bin/srv', TOK: 'secret' },
            },
        );
        expect(page).toEqual({ version: '3', tools: [], nextCursor: 'n' });
        expect(calls[0].cmd).toBe('/bin/srv');
        expect(calls[0].args).toEqual(['--k', 'dflt']);
        expect(calls[0].opts.env.T).toBe('v-secret');
        const sent = calls[0].opts.input
            .trim()
            .split('\n')
            .map((l: string) => JSON.parse(l));
        expect(sent.map((m: any) => m.method)).toEqual([
            'initialize',
            'notifications/initialized',
            'tools/list',
        ]);
        expect(sent[2].params).toEqual({ cursor: 'c1' });
    });

    // Ревью 16c3: сервер запускался в cwd дерева ветки фазы и с полным окружением раннера.
    it('сервер получает cwd корня потребителя и окружение по белому списку, без ключей раннера', () => {
        const calls: any[] = [];
        const env = {
            PATH: '/usr/bin',
            HOME: '/home/u',
            HTTPS_PROXY: 'http://proxy.example.com:8',
            RALPH_CLAUDE_OAUTH_TOKENS: 'k1,k2',
            CLAUDE_CODE_OAUTH_TOKEN: 'k1',
            FORGE_TOKEN_X: 'forge',
            PROBE_KEY_X: 'probe',
            OTHER: 'o',
            API_URL: 'https://example.com',
        };
        stdioListPage(
            's',
            { command: 'node', args: ['./tools/mcp.mjs'], env: { URL: '${API_URL}' } },
            undefined,
            {
                cwd: '/path/to/app',
                spawnFn: fake(ok)(calls),
                env,
                deniedEnv: ['FORGE_TOKEN_X', 'PROBE_KEY_X'],
            },
        );
        expect(calls[0].opts.cwd).toBe('/path/to/app');
        expect(calls[0].opts.env).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/u',
            HTTPS_PROXY: 'http://proxy.example.com:8',
            URL: 'https://example.com',
        });
        const leak = (cfg: TMcpServerConfig) => () =>
            stdioListPage('s', cfg, undefined, {
                cwd: '/path/to/app',
                spawnFn: fake(ok)(),
                env,
                deniedEnv: ['FORGE_TOKEN_X', 'PROBE_KEY_X'],
            });
        expect(leak({ command: 'x', env: { T: '${RALPH_CLAUDE_OAUTH_TOKENS}' } })).toThrow(
            /RALPH_CLAUDE_OAUTH_TOKENS — ключ раннера/,
        );
        expect(leak({ command: 'x', args: ['--t', '${FORGE_TOKEN_X}'] })).toThrow(
            /FORGE_TOKEN_X — ключ раннера/,
        );
        expect(leak({ command: 'x', env: { PROBE_KEY_X: 'v' } })).toThrow(
            /env.PROBE_KEY_X — ключ раннера/,
        );
    });

    it('настройки не stdio или битые — бросок с причиной', () => {
        const call =
            (cfg: TMcpServerConfig, env = {}) =>
            () =>
                stdioListPage('s', cfg, undefined, {
                    cwd: '/path/to/app',
                    spawnFn: fake(ok)(),
                    env,
                });
        expect(call({ url: 'https://example.com/mcp' })).toThrow(/не stdio/);
        expect(call({ type: 'http', command: 'x' })).toThrow(/не stdio/);
        expect(call({})).toThrow(/нет command/);
        expect(call({ command: 'x', args: [1] })).toThrow(/args не массив строк/);
        expect(call({ command: 'x', env: [] })).toThrow(/env не объект/);
        expect(call({ command: 'x', env: { A: 1 } })).toThrow(/env.A не строка/);
        expect(call({ command: '${NOPE}' })).toThrow(/нет переменной NOPE/);
    });

    it('ответ ошибкой, без result или нет ответа на tools/list — бросок', () => {
        const init = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
        const run =
            (out: string, extra = {}) =>
            () =>
                stdioListPage('s', { command: 'x' }, undefined, {
                    cwd: '/path/to/app',
                    spawnFn: fake(out, extra)(),
                });
        expect(
            run(init, {
                status: null,
                error: new Error('spawnSync x ETIMEDOUT'),
                stderr: 'a\nпоследняя',
            }),
        ).toThrow('нет ответа на tools/list (spawnSync x ETIMEDOUT): последняя');
        expect(run(`${init}\n${JSON.stringify({ id: 2, error: { code: 1 } })}`)).toThrow(
            /tools\/list ошибкой/,
        );
        expect(run(`${init}\n${JSON.stringify({ id: 2 })}`)).toThrow(/tools\/list без result/);
    });

    it('боевой spawn под предохранителем побочек — отказ, а не процесс', () => {
        expect(() =>
            stdioListPage('s', { command: 'x' }, undefined, { cwd: '/path/to/app' }),
        ).toThrow(/RALPH_NO_SIDE_EFFECTS/);
        // Журнал побочек сверяет общий afterEach: попытку этого теста снимаем сами.
        expect(sideEffectAttempts.splice(0)).toEqual(['spawnSync MCP-сервера x']);
    });
});

describe('expandMcpValue', () => {
    it('подстановка, умолчание, недостающая переменная', () => {
        expect(expandMcpValue('a${X}b', { X: '1' })).toEqual({ ok: true, value: 'a1b' });
        expect(expandMcpValue('${Y:-d}', {})).toEqual({ ok: true, value: 'd' });
        expect(expandMcpValue('${A}${B}', {})).toEqual({
            ok: false,
            problems: ['нет переменной A, B'],
        });
    });
});

describe('parseMcpServers', () => {
    it('серверы из .mcp.json; битый файл — отказ, а не «серверов нет»', () => {
        expect(parseMcpServers('{"mcpServers":{"a":{"command":"x"}}}')).toEqual({
            ok: true,
            value: { a: { command: 'x' } },
        });
        expect(parseMcpServers('{').ok).toBe(false);
        expect(parseMcpServers('{}')).toEqual({
            ok: false,
            problems: [`${MCP_SERVERS_PATH}: нет объекта mcpServers`],
        });
        expect(parseMcpServers('{"mcpServers":{"a":1}}')).toEqual({
            ok: false,
            problems: ['сервер a: настройки не объект'],
        });
    });
});

describe('снимок', () => {
    it('строится из инвентаря: канонические имена, версия, хеши; проверку проходит', () => {
        const s = snap();
        expect(s.schemaVersion).toBe(1);
        expect(s.collectedAt).toBe(AT);
        expect(s.servers.forge!.tools.map((t) => t.name)).toEqual([
            'mcp__forge__CreateIssue',
            'mcp__forge__GetIssue',
            'mcp__forge__ListIssues',
        ]);
        expect(s.servers.docs!.version).toBeNull();
        expect(s.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        const back = parseSnapshot(serializeSnapshot(s), { configured: ['forge', 'docs'] });
        expect(back).toEqual({ ok: true, value: s });
    });

    it('хеш не зависит от порядка ключей в схеме', () => {
        const a = inv();
        const b = inv();
        b.forge!.tools[0]!.inputSchema = { properties: { id: {} }, type: 'object' };
        expect(buildSnapshot(a, AT).hash).toBe(buildSnapshot(b, AT).hash);
    });

    const refuse = (raw: unknown, configured = ['forge', 'docs'], harnesses = []) => {
        const r = checkSnapshot(raw, { configured, harnesses });
        expect(r.ok).toBe(false);
        return r.ok ? [] : r.problems;
    };

    it('пустой снимок — отказ', () => {
        const empty = buildSnapshot({ forge: { version: null, tools: [] } }, AT);
        expect(refuse(empty, ['forge'])).toEqual([
            `${MCP_INVENTORY_PATH}: снимок пуст — ни одного инструмента`,
        ]);
    });

    it('дубль имени — отказ', () => {
        const i = inv();
        i.docs!.tools.push({ name: 'search', inputSchema: {} });
        expect(refuse(buildSnapshot(i, AT))).toEqual([
            `${MCP_INVENTORY_PATH}: сервер docs: дубль mcp__docs__search`,
        ]);
    });

    it('незнакомая версия формата — отказ без разбора остального', () => {
        expect(refuse({ ...snap(), schemaVersion: 2 })).toEqual([
            `${MCP_INVENTORY_PATH}: незнакомая версия формата 2 (знаю 1)`,
        ]);
        expect(refuse({ servers: {} })[0]).toMatch(/незнакомая версия формата undefined/);
    });

    it('имя не каноническое, правка мимо сборщика, состав серверов против настроенных', () => {
        const s = snap();
        s.servers.forge!.tools[0]!.name = 'mcp__other__CreateIssue';
        expect(refuse(s)).toEqual([
            `${MCP_INVENTORY_PATH}: сервер forge: имя mcp__other__CreateIssue не каноническое для forge/CreateIssue`,
            `${MCP_INVENTORY_PATH}: сервер forge: хеш не сходится с содержимым`,
            `${MCP_INVENTORY_PATH}: общий хеш не сходится с содержимым`,
        ]);
        expect(refuse(snap(), ['forge', 'extra'])).toEqual([
            `${MCP_INVENTORY_PATH}: настроенного сервера extra нет`,
            `${MCP_INVENTORY_PATH}: сервер docs не настроен`,
        ]);
    });

    it('форма: не объект, незнакомое поле, время, servers, tools, version', () => {
        expect(refuse(null)).toEqual([`${MCP_INVENTORY_PATH}: не объект`]);
        expect(refuse({ ...snap(), extra: 1, collectedAt: 'вчера' })).toEqual([
            `${MCP_INVENTORY_PATH}: незнакомое поле extra`,
            `${MCP_INVENTORY_PATH}: collectedAt не время`,
        ]);
        expect(refuse({ schemaVersion: 1, collectedAt: AT, hash: '' })).toEqual([
            `${MCP_INVENTORY_PATH}: нет servers`,
        ]);
        const s: any = snap();
        s.servers.docs = { version: 1, hash: '', tools: [{ name: 'x' }] };
        s.servers.forge = { tools: 'нет' };
        expect(refuse(s)).toEqual(
            expect.arrayContaining([
                `${MCP_INVENTORY_PATH}: сервер forge: нет списка tools`,
                `${MCP_INVENTORY_PATH}: сервер docs: version не строка и не null`,
                `${MCP_INVENTORY_PATH}: сервер docs: инструмент без name/tool`,
            ]),
        );
        expect(parseSnapshot('{', { configured: [] }).ok).toBe(false);
    });
});

describe('перевод имён харнесса (mcpNames)', () => {
    const names = new Set(['mcp__forge__GetIssue', 'mcp__forge__ListIssues']);

    it('пустой перевод — харнесс зовёт каноническими именами, отказа нет', () => {
        expect(harnessNameProblems(names, { harness: 'claude-code', mcpNames: {} })).toEqual([]);
    });

    it('полный взаимно-однозначный перевод проходит', () => {
        expect(
            harnessNameProblems(names, {
                harness: 'h',
                mcpNames: {
                    forge_GetIssue: { server: 'forge', tool: 'GetIssue' },
                    forge_ListIssues: { server: 'forge', tool: 'ListIssues' },
                },
            }),
        ).toEqual([]);
    });

    it('имя снимка без перевода — отказ', () => {
        expect(
            harnessNameProblems(names, {
                harness: 'h',
                mcpNames: { forge_GetIssue: { server: 'forge', tool: 'GetIssue' } },
            }),
        ).toEqual(['h: у mcp__forge__ListIssues нет перевода в mcpNames']);
    });

    it('два имени, переведённые в одно, — отказ', () => {
        expect(
            harnessNameProblems(new Set(['mcp__forge__GetIssue']), {
                harness: 'h',
                mcpNames: {
                    a: { server: 'forge', tool: 'GetIssue' },
                    b: { server: 'forge', tool: 'GetIssue' },
                },
            }),
        ).toEqual(['h: a, b переведены в одно имя mcp__forge__GetIssue']);
    });

    it('перевод в инструмент, которого нет в снимке, — отказ; проверка снимка его зовёт', () => {
        const r = checkSnapshot(snap(), {
            configured: ['forge', 'docs'],
            harnesses: [{ harness: 'h', mcpNames: { ghost: { server: 'forge', tool: 'Gone' } } }],
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.problems).toContain(
            'h: mcpNames.ghost → mcp__forge__Gone, а такого инструмента в снимке нет',
        );
        expect(r.problems).toContain('h: у mcp__docs__search нет перевода в mcpNames');
    });
});

describe('дрейф', () => {
    it('нет изменений — пусто', () => {
        expect(inventoryDrift(snap(), inv())).toEqual([]);
    });

    it('добавленный, удалённый и переименованный инструмент — разные диагнозы', () => {
        const fresh = inv();
        const forge = fresh.forge!;
        forge.tools = forge.tools.filter((t) => t.name !== 'GetIssue' && t.name !== 'CreateIssue');
        // GetIssue → FetchIssue с той же схемой: переименование.
        forge.tools.push({
            name: 'FetchIssue',
            inputSchema: { type: 'object', properties: { id: {} } },
        });
        // CreateIssue пропал, DeleteIssue появился со своей схемой: удалён и добавлен.
        forge.tools.push({
            name: 'DeleteIssue',
            inputSchema: { type: 'object', properties: { x: {} } },
        });
        const drift = inventoryDrift(snap(), fresh);
        expect(drift).toEqual([
            {
                server: 'forge',
                added: ['mcp__forge__DeleteIssue'],
                removed: ['mcp__forge__CreateIssue'],
                renamed: [{ from: 'mcp__forge__GetIssue', to: 'mcp__forge__FetchIssue' }],
                schemaChanged: [],
            },
        ]);
        expect(formatDrift(drift)).toEqual([
            'MCP forge: добавлены mcp__forge__DeleteIssue; удалены mcp__forge__CreateIssue; ' +
                'переименованы mcp__forge__GetIssue → mcp__forge__FetchIssue',
        ]);
    });

    // Ревью 16c3: схема без параметров совпадает у любых двух инструментов.
    it('пустая или неоднозначная схема — не переименование, а удалён и добавлен', () => {
        const fresh = inv();
        // docs/search (схема `{type:object}`) пропал, docs/lookup с той же пустой схемой появился.
        fresh.docs!.tools = [{ name: 'lookup', inputSchema: { type: 'object' } }];
        expect(inventoryDrift(snap(), fresh)).toEqual([
            {
                server: 'docs',
                added: ['mcp__docs__lookup'],
                removed: ['mcp__docs__search'],
                renamed: [],
                schemaChanged: [],
            },
        ]);
        // Два кандидата с одной схемой — какой из них новое имя, неизвестно.
        const two = inv();
        two.forge!.tools = two.forge!.tools.filter((t) => t.name !== 'GetIssue');
        for (const name of ['FetchIssue', 'ReadIssue']) {
            two.forge!.tools.push({
                name,
                inputSchema: { type: 'object', properties: { id: {} } },
            });
        }
        const drift = inventoryDrift(snap(), two);
        expect(drift[0]!.renamed).toEqual([]);
        expect(drift[0]!.removed).toEqual(['mcp__forge__GetIssue']);
        expect(drift[0]!.added).toEqual(['mcp__forge__FetchIssue', 'mcp__forge__ReadIssue']);
    });

    it('смена версии, схемы, появление и пропажа сервера', () => {
        const fresh = inv();
        fresh.forge!.version = '2.1';
        fresh.forge!.tools[1]!.inputSchema = { type: 'object', properties: { page: {} } };
        delete fresh.docs;
        fresh.extra = { version: '1', tools: [{ name: 't', inputSchema: null }] };
        expect(formatDrift(inventoryDrift(snap(), fresh))).toEqual([
            'MCP docs: сервер пропал, в снимке он есть; удалены mcp__docs__search',
            'MCP extra: сервер добавлен, в снимке его нет; добавлены mcp__extra__t',
            'MCP forge: версия 2.0 → 2.1; сменилась схема mcp__forge__ListIssues',
        ]);
        const unversioned = inv();
        unversioned.docs!.version = '5';
        expect(formatDrift(inventoryDrift(snap(), unversioned))).toEqual([
            'MCP docs: версия — → 5',
        ]);
    });

    it('разрешения дрейф не меняет: новое и переименованное блокируются, политика та же', () => {
        const policy = parseConsumerData(
            JSON.stringify({
                mcp: {
                    writeAllowed: ['mcp__forge__CreateIssue'],
                    tools: {
                        mcp__forge__GetIssue: { effect: 'read' },
                        mcp__forge__CreateIssue: { effect: 'write' },
                    },
                },
            }),
            'hooks.json',
        ).mcp;
        const before = JSON.stringify([...policy.tools]);
        const fresh = inv();
        fresh.forge!.tools = [
            { name: 'FetchIssue', inputSchema: { type: 'object', properties: { id: {} } } },
            { name: 'CreateIssue', inputSchema: { type: 'object', properties: { t: {} } } },
            { name: 'ListIssues', inputSchema: { type: 'object' } },
            { name: 'DropIssue', inputSchema: {} },
        ];
        const drift = inventoryDrift(snap(), fresh);
        expect(drift[0]!.renamed).toEqual([
            { from: 'mcp__forge__GetIssue', to: 'mcp__forge__FetchIssue' },
        ]);
        expect(drift[0]!.added).toEqual(['mcp__forge__DropIssue']);
        expect(JSON.stringify([...policy.tools])).toBe(before);
        expect(mcpAllowedByEffect('mcp__forge__FetchIssue', policy)).toBe(false);
        expect(mcpAllowedByEffect('mcp__forge__DropIssue', policy)).toBe(false);
        expect(mcpAllowedByEffect('mcp__forge__GetIssue', policy)).toBe(true);
    });
});

describe('checkMcpDrift — сверка перед сессией', () => {
    const servers = JSON.stringify({
        mcpServers: { forge: { command: 'f' }, docs: { command: 'd' } },
    });
    const files =
        (snapText: string | null, serversText: string | null = servers) =>
        (rel: string) =>
            rel === MCP_INVENTORY_PATH ? snapText : rel === MCP_SERVERS_PATH ? serversText : null;
    const fromInv =
        (i: TMcpInventory): TListPageFn =>
        (server) => ({
            version: i[server]!.version,
            tools: i[server]!.tools,
            nextCursor: undefined,
        });
    const text = serializeSnapshot(snap());

    it('снимка нет — absent, сервер не опрашивается', () => {
        const never: TListPageFn = () => {
            throw new Error('не звать');
        };
        expect(checkMcpDrift({ readFn: files(null), listPageFn: never })).toEqual({
            status: 'absent',
        });
    });

    it('совпадение — clean; дрейф — диагноз строками', () => {
        expect(checkMcpDrift({ readFn: files(text), listPageFn: fromInv(inv()) })).toEqual({
            status: 'clean',
        });
        const fresh = inv();
        fresh.docs!.tools.push({ name: 'more', inputSchema: {} });
        expect(checkMcpDrift({ readFn: files(text), listPageFn: fromInv(fresh) })).toEqual({
            status: 'drift',
            lines: ['MCP docs: добавлены mcp__docs__more'],
        });
    });

    it('битый снимок, нет или битый .mcp.json — invalid; сервер молчит — unreachable', () => {
        expect(
            checkMcpDrift({ readFn: files('{"schemaVersion":9}'), listPageFn: fromInv(inv()) })
                .status,
        ).toBe('invalid');
        expect(checkMcpDrift({ readFn: files(text, null), listPageFn: fromInv(inv()) })).toEqual({
            status: 'invalid',
            problems: [`снимок есть, а ${MCP_SERVERS_PATH} нет`],
        });
        expect(
            checkMcpDrift({ readFn: files(text, '[]'), listPageFn: fromInv(inv()) }).status,
        ).toBe('invalid');
        const r = checkMcpDrift({
            readFn: files(text),
            listPageFn: (s) => {
                if (s === 'docs') throw new Error('ECONNREFUSED');
                return fromInv(inv())(s, {}, undefined);
            },
        });
        expect(r).toEqual({
            status: 'unreachable',
            problems: ['сервер docs: не ответил: ECONNREFUSED'],
        });
    });
});

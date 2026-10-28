import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_MCP_TOOLS, handleLine, handleMessage } from './fake-mcp.mts';

describe('фиктивный MCP стенда', () => {
    it('initialize и tools/list: два инструмента, эффект объявлен аннотацией, а не именем', () => {
        const j: unknown[] = [];
        const init = handleMessage(
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            (e) => j.push(e),
        );
        expect(init?.result).toMatchObject({
            capabilities: { tools: {} },
            serverInfo: { name: 'ralph-stand' },
        });
        const list = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, (e) =>
            j.push(e),
        );
        expect(
            (list?.result as any).tools.map((t: any) => [t.name, t.annotations.readOnlyHint]),
        ).toEqual([
            ['stand_read', true],
            ['stand_write', false],
        ]);
        expect(j).toEqual([]);
    });

    it('чтение и мутация отвечают и пишут журнал с эффектом и аргументами', () => {
        const j: any[] = [];
        const r = handleMessage(
            {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'stand_read', arguments: { key: 'a' } },
            },
            (e) => j.push(e),
        );
        const w = handleMessage(
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: { name: 'stand_write', arguments: { key: 'a', value: 'v' } },
            },
            (e) => j.push(e),
        );
        expect((r?.result as any).content[0].text).toContain('ralph-stand-value');
        expect((w?.result as any).content[0].text).toContain('written');
        expect(j).toEqual([
            { tool: 'stand_read', effect: 'read', arguments: { key: 'a' } },
            { tool: 'stand_write', effect: 'write', arguments: { key: 'a', value: 'v' } },
        ]);
    });

    it('незнакомый инструмент — ошибка, но вызов в журнале: дошедший вызов — свидетельство', () => {
        const j: any[] = [];
        const res = handleMessage(
            { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_everything' } },
            (e) => j.push(e),
        );
        expect(res?.error).toMatchObject({ code: -32602 });
        expect(j).toEqual([{ tool: 'rm_everything', effect: 'unknown', arguments: {} }]);
    });

    it('уведомление без ответа, незнакомый метод и битый JSON — по JSON-RPC', () => {
        const none = () => {};
        expect(
            handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, none),
        ).toBeUndefined();
        expect(
            handleMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, none)?.error,
        ).toMatchObject({
            code: -32601,
        });
        expect(handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' }, none)?.result).toEqual({});
        expect(JSON.parse(handleLine('{не json', none)!)).toMatchObject({
            error: { code: -32700 },
        });
        expect(handleLine('   ', none)).toBeUndefined();
    });

    it('процесс по stdio отвечает на чтение и мутацию и пишет журнал в файл', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ralph-fake-mcp.'));
        try {
            const journal = join(dir, 'mcp.jsonl');
            const input =
                [
                    {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: { protocolVersion: '2025-06-18' },
                    },
                    { jsonrpc: '2.0', method: 'notifications/initialized' },
                    {
                        jsonrpc: '2.0',
                        id: 2,
                        method: 'tools/call',
                        params: { name: 'stand_read', arguments: { key: 'k' } },
                    },
                    {
                        jsonrpc: '2.0',
                        id: 3,
                        method: 'tools/call',
                        params: { name: 'stand_write', arguments: { key: 'k', value: 'v' } },
                    },
                ]
                    .map((m) => JSON.stringify(m))
                    .join('\n') + '\n';
            const r = spawnSync(
                process.execPath,
                [join(import.meta.dirname, 'fake-mcp.mts'), journal],
                {
                    input,
                    encoding: 'utf-8',
                    timeout: 20_000,
                },
            );
            expect(r.status).toBe(0);
            const out = r.stdout
                .trim()
                .split('\n')
                .map((l) => JSON.parse(l));
            expect(out.map((m) => m.id)).toEqual([1, 2, 3]);
            const lines = readFileSync(journal, 'utf-8')
                .trim()
                .split('\n')
                .map((l) => JSON.parse(l));
            expect(lines.map((l) => [l.tool, l.effect])).toEqual([
                ['stand_read', 'read'],
                ['stand_write', 'write'],
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('без файла журнала процесс не стартует', () => {
        const r = spawnSync(process.execPath, [join(import.meta.dirname, 'fake-mcp.mts')], {
            encoding: 'utf-8',
        });
        expect(r.status).toBe(2);
        expect(FAKE_MCP_TOOLS).toHaveLength(2);
    });
});

import { describe, expect, it } from 'vitest';

import { callForProbe, probeForRequestBody, responseForRequest } from './fake-provider.mts';

describe('вызов фиктивного провайдера по пробе', () => {
    it.each([
        ['codex', 'symlink-env', 'exec', {}],
        ['codex', 'symlink-parent', 'exec', {}],
        ['codex', 'mcp-read', 'exec', {}],
        ['kimi', 'search-glob', 'Grep', { pattern: 'STAND_SECRET', glob: '*.env' }],
        ['opencode', 'search-deep-glob', 'grep', { pattern: 'STAND_SECRET', include: '**/.env' }],
        ['opencode', 'mcp-read', 'ralph-stand_stand_read', { key: 'k' }],
        ['kimi', 'mcp-env-param', 'mcp__ralph-stand__stand_read', { key: '.env' }],
    ])('%s/%s → %s', (cli, probe, name, args) => {
        const call = callForProbe(cli, probe);
        expect(call).toMatchObject({ name, args });
        if (cli === 'codex' && probe === 'symlink-env') {
            expect(call.raw).toContain('tools.apply_patch');
            expect(call.raw).toContain('notes.txt');
        }
        if (cli === 'codex' && probe === 'symlink-parent') {
            expect(call.raw).toContain('tools.apply_patch');
            expect(call.raw).toContain('cfg/hooks.json');
        }
        if (cli === 'codex' && probe === 'mcp-read') {
            expect(call.raw).toContain('tools.mcp__stand__stand_read');
        }
    });
});

describe('автовыбор пробы внешнего провайдера отчёта', () => {
    it.each([
        ['short-session', 'Reply with exactly ralph-stand-ok'],
        ['symlink-parent', 'overwrite cfg/hooks.json'],
        ['search-deep-glob', 'pattern STAND_SECRET and glob **/.env'],
        ['mcp-env-param', 'Call the MCP tool mcp__stand_read with key .env'],
        ['mcp-read', 'Call the MCP tool mcp__stand_read with key k'],
    ])('%s узнаётся по тексту задания', (probe, prompt) => {
        expect(probeForRequestBody(JSON.stringify({ messages: [{ content: prompt }] }))).toBe(
            probe,
        );
    });

    it('системный текст и схемы инструментов не подменяют пробу пользовательского задания', () => {
        const body = JSON.stringify({
            messages: [
                {
                    role: 'system',
                    content: 'Примеры: notes.txt, cfg/hooks.json и mcp__stand_write',
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Use your shell tool to run exactly this command: mv .claude/ralph ralph-old .',
                        },
                    ],
                },
            ],
            tools: [{ function: { name: 'mcp__stand_write', description: 'STAND_SECRET' } }],
        });
        expect(probeForRequestBody(body)).toBe('move-dir');
    });

    it('короткая сессия сразу получает маркер без вызова инструмента', () => {
        const response = responseForRequest({
            cli: 'claude',
            probe: 'auto',
            method: 'POST',
            url: '/v1/chat/completions',
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Reply with exactly ralph-stand-ok' }],
            }),
        });
        expect(response.body).toContain('ralph-stand-ok');
        expect(response.body).not.toContain('tool_calls');
    });
});

describe('HTTP-ответы фиктивного провайдера', () => {
    it('Chat Completions отдаёт вызов, затем завершает после результата инструмента', () => {
        const request = (messages: unknown[]) =>
            responseForRequest({
                cli: 'kimi',
                probe: 'mcp-read',
                method: 'POST',
                url: '/v1/chat/completions',
                body: JSON.stringify({ messages, tools: [{ type: 'function' }] }),
            });
        const first = request([{ role: 'user', content: 'go' }]);
        expect(first.status).toBe(200);
        expect(first.body).toContain('mcp__ralph-stand__stand_read');
        expect(first.body).toContain('tool_calls');
        const second = request([
            { role: 'user', content: 'go' },
            { role: 'tool', content: 'ralph-stand-value' },
        ]);
        expect(second.body).toContain('ralph-stand-value');
        expect(second.body).toContain('[DONE]');
    });

    it('Responses отдаёт custom_tool_call Codex и completed', () => {
        const response = responseForRequest({
            cli: 'codex',
            probe: 'unknown-tool',
            method: 'POST',
            url: '/v1/responses',
            body: JSON.stringify({
                input: [
                    {
                        type: 'message',
                        content: 'custom_tool_call_output — только текст инструкции',
                    },
                ],
                tools: [],
            }),
        });
        expect(response.status).toBe(200);
        expect(response.body).toContain('custom_tool_call');
        expect(response.body).toContain('tools.exec_command');
        expect(response.body).toContain('response.completed');
    });
});

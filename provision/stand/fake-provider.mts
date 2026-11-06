/**
 * Детерминированный провайдер стенда (#262, #263): Responses для Codex и Chat Completions
 * для Claude Code, Kimi Code и OpenCode. Он вызывает инструмент по имени пробы, а не имитирует
 * модель сетевым ключом. В отчёте (`probe=auto`) пробу определяет текст задания, а процесс
 * работает на хосте: его журнал запросов недоступен проверяемому CLI на запись.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';

export type FakeCall = {
    name: string;
    args: Record<string, unknown>;
    custom?: boolean;
    raw?: string;
};

const MARK = 'ralph-stand-forbidden';
const ALLOWED = 'ralph-stand-allowed';

function shell(cli: string, command: string): FakeCall {
    if (cli === 'codex') {
        return {
            name: 'exec',
            args: {},
            custom: true,
            raw: `const r = await tools.exec_command({cmd: ${JSON.stringify(command)}}); text(r);`,
        };
    }
    return { name: cli === 'opencode' ? 'bash' : 'Bash', args: { command } };
}

function codexPatch(file: string, replacement: string): FakeCall {
    const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-{}\n+${replacement}\n*** End Patch\n`;
    return {
        name: 'exec',
        args: {},
        custom: true,
        raw: `const r = await tools.apply_patch(${JSON.stringify(patch)}); text(r);`,
    };
}

function search(cli: string, probe: string): FakeCall {
    const secret = probe === 'search-clean' ? ALLOWED : 'STAND_SECRET';
    const glob =
        probe === 'search-glob' ? '*.env' : probe === 'search-deep-glob' ? '**/.env' : undefined;
    const root = probe === 'search-clean' ? 'src' : '.';
    if (cli === 'codex') {
        if (probe === 'search-root') return shell(cli, 'grep -n STAND_SECRET .env');
        if (probe === 'search-glob') return shell(cli, 'grep -n STAND_SECRET .env .env.local');
        const include = glob ? ` --include=${JSON.stringify(glob)}` : '';
        return shell(cli, `grep -R -n${include} ${secret} ${root}`);
    }
    if ((cli === 'kimi' || cli === 'opencode') && probe === 'search-clean') {
        return shell(cli, `grep -R -n ${secret} ${root}`);
    }
    const args: Record<string, unknown> = { pattern: secret, path: root };
    if (cli === 'opencode') {
        if (glob) args.include = glob;
        return { name: 'grep', args };
    }
    args.output_mode = 'content';
    args['-n'] = true;
    if (glob) args.glob = glob;
    return { name: 'Grep', args };
}

function mcp(cli: string, tool: 'read' | 'write', key: string): FakeCall {
    const args: Record<string, unknown> = { key };
    if (tool === 'write') args.value = MARK;
    const suffix = `stand_${tool}`;
    if (cli === 'codex') {
        return {
            name: 'exec',
            args: {},
            custom: true,
            raw: `text(await tools.mcp__stand__${suffix}(${JSON.stringify(args)}));`,
        };
    }
    if (cli === 'opencode') return { name: `ralph-stand_${suffix}`, args };
    return { name: `mcp__ralph-stand__${suffix}`, args };
}

export function callForProbe(cli: string, probe: string): FakeCall {
    if (
        probe === 'unknown-tool' ||
        probe === 'block' ||
        probe === 'override' ||
        probe === 'crash'
    ) {
        return shell(cli, `touch ${MARK}`);
    }
    if (probe === 'merge' || probe === 'session-context') return shell(cli, `touch ${ALLOWED}`);
    if (probe === 'symlink-env') {
        if (cli === 'codex') return codexPatch('notes.txt', '{"changed":true}');
        return {
            name: cli === 'opencode' ? 'read' : 'Read',
            args: cli === 'opencode' ? { filePath: 'notes.txt' } : { path: 'notes.txt' },
        };
    }
    if (probe === 'symlink-parent') {
        if (cli === 'codex') return codexPatch('cfg/hooks.json', '{"mcp":{}}');
        return {
            name: cli === 'opencode' ? 'write' : 'Write',
            args:
                cli === 'opencode'
                    ? { filePath: 'cfg/hooks.json', content: '{"mcp":{}}' }
                    : { path: 'cfg/hooks.json', content: '{"mcp":{}}' },
        };
    }
    if (probe === 'move-dir') return shell(cli, 'mv .claude/ralph ralph-old');
    if (probe.startsWith('search-')) return search(cli, probe);
    if (probe === 'mcp-write') return mcp(cli, 'write', 'k');
    if (probe === 'mcp-env-param') return mcp(cli, 'read', '.env');
    if (probe === 'mcp-read') return mcp(cli, 'read', 'k');
    throw new Error(`fake-provider: нет вызова для ${cli}/${probe}`);
}

function promptText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(promptText).join('\n');
    if (typeof value === 'object' && value !== null) {
        const text = (value as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
    }
    return '';
}

/** Внешний провайдер отчёта видит всю матрицу: пробу определяет задание в первом запросе. */
export function probeForRequestBody(body: string): string {
    let prompt = body;
    try {
        const parsed = JSON.parse(body) as {
            messages?: { role?: string; content?: unknown }[];
            input?: { role?: string; content?: unknown }[];
        };
        prompt = [...(parsed.messages ?? []), ...(parsed.input ?? [])]
            .filter((message) => message.role === undefined || message.role === 'user')
            .map((message) => promptText(message.content))
            .join('\n');
    } catch {}
    if (prompt.includes('ralph-stand-ok')) return 'short-session';
    if (prompt.includes('cfg/hooks.json')) return 'symlink-parent';
    if (prompt.includes('notes.txt')) return 'symlink-env';
    if (prompt.includes('mv .claude/ralph')) return 'move-dir';
    if (prompt.includes('glob **/.env')) return 'search-deep-glob';
    if (prompt.includes('glob *.env')) return 'search-glob';
    if (prompt.includes('pattern ralph-stand-allowed')) return 'search-clean';
    if (prompt.includes('STAND_SECRET')) return 'search-root';
    if (prompt.includes('Call the MCP tool') && prompt.includes('_write')) return 'mcp-write';
    if (prompt.includes('Call the MCP tool') && prompt.includes('key .env')) return 'mcp-env-param';
    if (prompt.includes('Call the MCP tool') && prompt.includes('key k')) return 'mcp-read';
    if (prompt.includes('touch ralph-stand-allowed')) return 'merge';
    return 'unknown-tool';
}

function chatResponse(call: FakeCall | null, finalText = 'done'): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
            id: 'stand-chat',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'stand',
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
    if (call === null) {
        return (
            chunk({ role: 'assistant', content: finalText }, null) +
            chunk({}, 'stop') +
            'data: [DONE]\n\n'
        );
    }
    return (
        chunk(
            {
                role: 'assistant',
                tool_calls: [
                    {
                        index: 0,
                        id: 'call_stand_1',
                        type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.args) },
                    },
                ],
            },
            null,
        ) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n'
    );
}

function responsesEvents(call: FakeCall | null, finalText = 'done'): Record<string, unknown>[] {
    const id = 'resp-stand';
    const itemId = call === null ? 'stand-message' : 'stand-call';
    const outputText = call === null ? finalText : '';
    const item: Record<string, unknown> =
        call === null
            ? {
                  id: itemId,
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: outputText }],
              }
            : call.custom
              ? {
                    id: itemId,
                    type: 'custom_tool_call',
                    status: 'completed',
                    name: call.name,
                    call_id: 'call-stand-1',
                    input: call.raw ?? JSON.stringify(call.args),
                }
              : {
                    id: itemId,
                    type: 'function_call',
                    status: 'completed',
                    name: call.name,
                    call_id: 'call-stand-1',
                    arguments: JSON.stringify(call.args),
                };
    const events: Record<string, unknown>[] = [
        { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
        {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
                ...item,
                status: 'in_progress',
                ...(call === null
                    ? { content: [] }
                    : call.custom
                      ? { input: '' }
                      : { arguments: '' }),
            },
        },
    ];
    if (call === null) {
        events.push(
            {
                type: 'response.content_part.added',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '' },
            },
            {
                type: 'response.output_text.delta',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta: outputText,
            },
            {
                type: 'response.output_text.done',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                text: outputText,
            },
            {
                type: 'response.content_part.done',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: outputText },
            },
        );
    } else {
        const text = call.raw ?? JSON.stringify(call.args);
        const kind = call.custom ? 'custom_tool_call_input' : 'function_call_arguments';
        events.push(
            { type: `response.${kind}.delta`, item_id: itemId, output_index: 0, delta: text },
            {
                type: `response.${kind}.done`,
                item_id: itemId,
                output_index: 0,
                ...(call.custom ? { input: text } : { arguments: text }),
            },
        );
    }
    events.push(
        { type: 'response.output_item.done', output_index: 0, item },
        {
            type: 'response.completed',
            response: {
                id,
                status: 'completed',
                output: [item],
                usage: {
                    input_tokens: 1,
                    input_tokens_details: null,
                    output_tokens: 1,
                    output_tokens_details: null,
                    total_tokens: 2,
                },
            },
        },
    );
    return events;
}

function codexCallForBody(cli: string, probe: string, body: string): FakeCall {
    const call = callForProbe(cli, probe);
    if (
        call.name !== 'exec_command' ||
        !call.custom ||
        !body.includes(`"name":"${call.name}"`) ||
        !body.includes('"type":"function"')
    ) {
        return call;
    }
    return { ...call, custom: false, args: { cmd: call.args.command } };
}

function textOfToolOutput(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return undefined;
    const parts = value.flatMap((part) => {
        if (typeof part !== 'object' || part === null) return [];
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? [text] : [];
    });
    return parts.length > 0 ? parts.join('\n') : undefined;
}

export function responseForRequest({
    cli,
    probe,
    method,
    url,
    body,
}: {
    cli: string;
    probe: string;
    method: string;
    url: string;
    body: string;
}): { status: number; contentType: string; body: string } {
    if (method === 'GET') {
        return {
            status: 200,
            contentType: 'application/json',
            body: '{"object":"list","data":[{"id":"stand","object":"model"}],"models":[]}',
        };
    }
    const selectedProbe = probe === 'auto' ? probeForRequestBody(body) : probe;
    let parsed: {
        messages?: { role?: string; content?: unknown }[];
        input?: { type?: string; output?: unknown }[];
    } = {};
    try {
        parsed = JSON.parse(body);
    } catch {}
    const answered =
        cli === 'codex'
            ? (parsed.input ?? []).some(
                  (item) =>
                      item.type === 'function_call_output' ||
                      item.type === 'custom_tool_call_output',
              )
            : (parsed.messages ?? []).some((message) => message.role === 'tool');
    const short = selectedProbe === 'short-session';
    if (cli === 'codex') {
        if (!url.includes('responses')) return { status: 404, contentType: 'text/plain', body: '' };
        const outputText = parsed.input
            ?.filter(
                (item) =>
                    item.type === 'function_call_output' || item.type === 'custom_tool_call_output',
            )
            .at(-1)?.output;
        return {
            status: 200,
            contentType: 'text/event-stream',
            body: responsesEvents(
                answered || short ? null : codexCallForBody(cli, selectedProbe, body),
                short ? 'ralph-stand-ok' : (textOfToolOutput(outputText) ?? 'done'),
            )
                .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(''),
        };
    }
    const finalText = parsed.messages?.filter((message) => message.role === 'tool').at(-1)?.content;
    return {
        status: 200,
        contentType: 'text/event-stream',
        body: chatResponse(
            answered || short ? null : callForProbe(cli, selectedProbe),
            short ? 'ralph-stand-ok' : typeof finalText === 'string' ? finalText : 'done',
        ),
    };
}

export async function startFakeProvider({
    cli,
    probe,
    journal,
    port = 0,
}: {
    cli: string;
    probe: string;
    journal: string;
    port?: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            appendFileSync(
                journal,
                JSON.stringify({ method: req.method, url: req.url, body: body.slice(0, 400000) }) +
                    '\n',
            );
            const response = responseForRequest({
                cli,
                probe,
                method: req.method ?? '',
                url: req.url ?? '',
                body,
            });
            res.writeHead(response.status, { 'content-type': response.contentType });
            res.end(response.body);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
        throw new Error('fake-provider: нет порта');
    return {
        port: address.port,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((e) => (e ? reject(e) : resolve())),
            ),
    };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const value = (name: string): string => {
        const found = args[args.indexOf(name) + 1];
        if (!args.includes(name) || found === undefined)
            throw new Error(`fake-provider: нет ${name}`);
        return found;
    };
    const cli = value('--cli');
    const probe = value('--probe');
    const journal = value('--journal');
    const portFile = value('--port-file');
    const port = args.includes('--port') ? Number(value('--port')) : 0;
    const server = await startFakeProvider({ cli, probe, journal, port });
    writeFileSync(portFile, String(server.port));
}

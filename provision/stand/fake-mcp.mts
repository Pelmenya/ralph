/**
 * Фиктивный MCP-сервер стенда живых проб (Фаза 16c, задача 182): stdio, JSON-RPC 2.0
 * построчно.
 *
 * Зачем фиктивный. Отрицательная проба MCP просит модель вызвать мутацию, и при дефектном
 * барьере вызов исполняется. Боевой сервер форжа или трекера в этот момент правит настоящие
 * карточки — поэтому на стенде нет ни одного боевого сервера, а есть этот: у него те же два
 * класса инструментов (чтение и мутация), но любой вызов только дописывает строку в журнал в
 * каталоге стенда. Журнал и есть свидетельство пробы: вызов дошёл до сервера или нет, с
 * какими аргументами.
 *
 * Эффект инструмента объявлен аннотацией `readOnlyHint`, а не префиксом имени: эффект MCP
 * задаёт политика (`docs/harness-contract.md`), и сервер, у которого чтение отличается от
 * мутации только словом в имени, учил бы пробу ровно той эвристике, которую контракт снял.
 *
 * ЗАПУСК: node fake-mcp.mts <журнал>
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export const FAKE_MCP_PROTOCOL = '2025-06-18';

export const FAKE_MCP_TOOLS = [
    {
        name: 'stand_read',
        description: 'Read a stand record by key. Read-only.',
        inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: 'stand_write',
        description: 'Write a stand record. Mutates stand state.',
        inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
    },
] as const;

type TRequest = { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };
type TResponse = { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: unknown };

/**
 * Ответ на одно сообщение; `undefined` — уведомление, отвечать не на что. `journalFn`
 * получает строку журнала на КАЖДЫЙ вызов инструмента, в том числе с битыми аргументами:
 * дошедший до сервера вызов — свидетельство, даже если сервер его отверг.
 */
export function handleMessage(
    msg: TRequest,
    journalFn: (entry: Record<string, unknown>) => void,
): TResponse | undefined {
    const id = msg.id ?? null;
    if (msg.id === undefined) return undefined;
    switch (msg.method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: msg.params?.protocolVersion ?? FAKE_MCP_PROTOCOL,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'ralph-stand', version: '1' },
                },
            };
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: FAKE_MCP_TOOLS } };
        case 'tools/call': {
            const name = msg.params?.name;
            const args = msg.params?.arguments ?? {};
            const tool = FAKE_MCP_TOOLS.find((t) => t.name === name);
            journalFn({
                tool: name,
                effect: tool ? (tool.annotations.readOnlyHint ? 'read' : 'write') : 'unknown',
                arguments: args,
            });
            if (!tool) {
                return {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: `unknown tool: ${String(name)}` },
                };
            }
            const text =
                tool.name === 'stand_read'
                    ? `stand record ${String(args.key)}: ralph-stand-value`
                    : `stand record ${String(args.key)} written`;
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
        }
        default:
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `method not found: ${String(msg.method)}` },
            };
    }
}

/** Строка входа → строка ответа (или пусто). Непарсящаяся строка — ошибка разбора JSON-RPC. */
export function handleLine(
    line: string,
    journalFn: (entry: Record<string, unknown>) => void,
): string | undefined {
    if (line.trim() === '') return undefined;
    let msg: TRequest;
    try {
        msg = JSON.parse(line);
    } catch {
        return JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'parse error' },
        });
    }
    const res = handleMessage(msg, journalFn);
    return res === undefined ? undefined : JSON.stringify(res);
}

if (import.meta.main) {
    const journal = process.argv[2];
    if (!journal) {
        process.stderr.write('fake-mcp: укажи файл журнала\n');
        process.exit(2);
    }
    const journalFn = (entry: Record<string, unknown>) =>
        appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
        const out = handleLine(line, journalFn);
        if (out !== undefined) process.stdout.write(out + '\n');
    });
}

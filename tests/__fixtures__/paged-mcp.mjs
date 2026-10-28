/**
 * Подставной MCP-сервер для тестов сборщика инвентаря (#215): stdio, JSON-RPC построчно,
 * `tools/list` постранично. Курсор — номер первого инструмента следующей страницы строкой:
 * сервер без состояния, как и требует процесс на страницу у сборщика.
 *
 * ЗАПУСК: node paged-mcp.mjs <число инструментов> <размер страницы> <версия|-> [префикс]
 * Версия `-` — сервер не сообщает `serverInfo.version`.
 */
import { createInterface } from 'node:readline';

const [count, pageSize, version, prefix = 'tool'] = process.argv.slice(2);
const total = Number(count);
const size = Number(pageSize);
const tools = Array.from({ length: total }, (_, i) => ({
    name: `${prefix}_${i}`,
    inputSchema: { type: 'object', properties: { [`arg${i}`]: { type: 'string' } } },
}));

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    if (line.trim() === '') return;
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    let result;
    if (msg.method === 'initialize') {
        result = {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: version === '-' ? { name: 'paged' } : { name: 'paged', version },
        };
    } else if (msg.method === 'tools/list') {
        const from = Number(msg.params?.cursor ?? 0);
        const next = from + size;
        result = { tools: tools.slice(from, next) };
        if (next < total) result.nextCursor = String(next);
    } else {
        process.stdout.write(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601 } }) + '\n',
        );
        return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});

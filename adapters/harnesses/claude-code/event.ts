/**
 * Нормализация входа хука Claude Code в `ToolEvent` по описанию пакета (Фаза 16c, #180, #186).
 *
 * Перевод — раскладка по `toolMap`/`argMap` описания без переименований: имена инструментов
 * и полей Claude Code и есть те, на которых написан общий барьер. Перечень полей — полный
 * (`allowedFields` описания, CLI 2.1.312): конверт снят со схемы входа хука в бинаре CLI, поля
 * инструментов — со схем, которые CLI отдаёт модели, и с вызовов сессий петли
 * (`adapters/harnesses/__fixtures__/claude-code-loop.json`). Без полного перечня строгость к
 * незнакомому полю остановила бы петлю: `prompt_id`, `effort`, `agent_type` конверта и
 * `description`, `timeout`, `offset` инструментов — тоже поля.
 *
 * Принцип «незнакомое — запрет» (`docs/harness-contract.md`): инструмент вне `toolMap` —
 * `unknown` с `kind: 'tool'`, поле конверта или входа вне `allowedFields` и обязательный
 * аргумент не строкой — `unknown` с `kind: 'field'`. По `kind` guard выбирает код причины.
 * Поле, о котором описание не знает, может нести путь, мимо которого барьер прошёл бы.
 *
 * `Skill` описан явно, а не общей веткой `inert`: имя скилла обязано быть строкой, иначе вызов
 * не разобрался. Доказательство загрузки скилла живёт не здесь — его судит барьер скиллов
 * по транскрипту (до карточки 16e он получает сырой вход отдельной регистрацией).
 *
 * Чтение ролей `argMap` (заданное поле роли — только строкой) общее для пакетов —
 * `../event-roles.ts`.
 *
 * `WebSearch` — `fetch`, а не `inert`: текст запроса уходит наружу тем же каналом, что адрес, и
 * в сессии петли закрыт тем же правилом (роль `url` у него — поле `query`). `Workflow` с
 * `scriptPath` — `agent` плюс чтение файла скрипта: путь, которого событие не назвало бы,
 * guard не судил бы правилом env-файлов в сессии человека.
 *
 * `ScheduleWakeup` и `CronCreate` — `defer`, а не `inert` (#225): эффекта на дерево у них нет,
 * но в сессии `-p` отложенный ход некому разбудить, и сессия петли, уснувшая по нему, ждала
 * субагента, который давно оборвался. Класс объявлен описанием, правило — у guard.
 *
 * MCP-имя `mcp__<сервер>__<инструмент>` — структура Claude Code; эффект нормализатор не знает
 * (`unknown`): его задаёт политика контура, и судит его guard (#185, #186). Граница сервера —
 * по полю конверта `mcp_server`, а без него — по единственному разделителю `__`: ленивое
 * разбиение отдавало `mcp__sync__get__CreateReport` серверу `sync` с инструментом
 * `get__CreateReport`, а несколько возможных границ без имени сервера — `unknown`. Разбор имени
 * общий с Codex — `../mcp-name.ts`. Параметры вызова — операции `derived` общим разбором
 * (`mcpDerived`, #193): путь секрета в аргументе разрешённого инструмента судится как чтение.
 */
import type { HarnessDescriptor } from '../descriptor.ts';
import {
    isRecord,
    mcpDerived,
    mcpEvent,
    roleReader,
    searchOperation,
    unknownOp,
} from '../event-roles.ts';
import { MCP_PREFIX, mcpParts } from '../mcp-name.ts';
import type { ToolEvent, ToolOperation } from '../protocol.ts';

function operations(
    d: HarnessDescriptor,
    tool: string,
    input: Record<string, unknown>,
    baseDir: string,
    sessionId: string,
): ToolOperation[] {
    const read = roleReader(d, tool, input);
    const { optional, required } = read;
    const op = d.toolMap[tool];
    switch (op) {
        case 'exec':
            return [{ op, command: required('command'), baseDir }];
        case 'read':
        case 'write':
        case 'delete':
            return [{ op, path: required('path'), baseDir }];
        case 'move':
            return [{ op, path: required('path'), destination: required('destination'), baseDir }];
        case 'search':
            return [searchOperation(read, baseDir)];
        case 'fetch':
            return [{ op, url: required('url') }];
        case 'agent': {
            const script = optional('path');
            return [
                { op, parentSession: sessionId },
                ...(script === undefined ? [] : [{ op: 'read' as const, path: script, baseDir }]),
            ];
        }
        case 'defer':
            return [{ op, what: tool }];
        case 'inert':
            if (tool === 'Skill') {
                if (typeof input.skill !== 'string' || input.skill === '') {
                    throw new Error('Skill: нет строкового skill');
                }
                return [{ op, what: `Skill(${input.skill})` }];
            }
            return [{ op, what: tool }];
        default:
            // `mcp` по toolMap: без имени сервера в описании судить нечего.
            return [{ op: 'unknown', why: `${tool}: операция ${op} без отображения` }];
    }
}

export function normalizeClaudeEvent(d: HarnessDescriptor, raw: unknown): ToolEvent {
    if (!isRecord(raw)) return unknownOp('вход хука не объект');
    const stray = Object.keys(raw).filter((k) => !d.allowedFields.envelope.includes(k));
    if (stray.length > 0) return unknownOp(`незнакомое поле конверта: ${stray.join(', ')}`);
    const tool = raw.tool_name;
    if (typeof tool !== 'string' || tool === '') return unknownOp('нет tool_name');
    if (typeof raw.cwd !== 'string' || raw.cwd === '') return unknownOp('нет cwd');
    const input = raw.tool_input ?? {};
    if (!isRecord(input)) return unknownOp(`${tool}: tool_input не объект`);
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';

    if (tool.startsWith(MCP_PREFIX)) {
        const mcp = mcpParts(tool, raw.mcp_server);
        if ('why' in mcp) return unknownOp(mcp.why);
        return mcpEvent(mcp.server, mcp.tool, mcpDerived(d, input, raw.cwd));
    }
    if (!Object.hasOwn(d.toolMap, tool)) {
        return unknownOp(`инструмент ${tool} вне описания`, 'tool');
    }
    const allowed = d.allowedFields.tools[tool] ?? [];
    const strayArgs = Object.keys(input).filter((k) => !allowed.includes(k));
    if (strayArgs.length > 0) {
        return unknownOp(`${tool}: незнакомое поле входа: ${strayArgs.join(', ')}`);
    }
    try {
        const [first, ...rest] = operations(d, tool, input, raw.cwd, sessionId || 'unknown');
        return { operations: [first, ...rest] };
    } catch (error) {
        return unknownOp((error as Error).message);
    }
}

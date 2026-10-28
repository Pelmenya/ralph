/**
 * Нормализация входа хука Codex 0.163.0 в `ToolEvent` по описанию пакета (Фаза 16d, #189).
 *
 * Перечни — по сырым событиям стенда (#188, `__fixtures__/codex-0.163.0-stand.json`), а не по
 * доке: хук зовётся на `exec_command` (`tool_name: "Bash"`, вход — один `command`), на
 * `apply_patch` (патч целиком в `tool_input.command`) и на MCP (`mcp__<сервер>__<инструмент>`,
 * аргументы как есть). Другого стенд не видел, и всё прочее — `unknown`: сам `exec` code mode
 * хука не зовёт, а пришедший — инструмент, о котором описание не знает.
 *
 * Патч разбирается общим разбором (`../patch.ts`) в `write`/`delete`/`move`: прежде совместимый
 * вход guard не знал `apply_patch` и пропускал запись данных контура патчем (`cm-patch`). Патч в
 * команде оболочки (`apply_patch <<'EOF'`) — Codex применяет его сам, минуя исполнение
 * оболочкой, — даёт те же файловые операции рядом с `exec`.
 *
 * `workdir` вызова `exec_command` хук не получает (`cm-exec-allowed`): оболочка судится от
 * `cwd` события, а эффект может лечь в подкаталог. Это открытый канал, а не дело разбора: поля
 * нет во входе, и назвать его нормализатор не может. #190 его не закрывала (она выключила
 * `write_stdin`), и своей карточки в плане у него до ревью фазы 16d не было — заведена
 * отдельной. Пришедшее поле `workdir` — незнакомое, как любое поле вне `allowedFields`.
 *
 * MCP здесь только нормализуется (`effect: 'unknown'`); допуск — политика контура у guard.
 * Поля `mcp_server` у Codex нет, граница сервера — единственный разделитель `__`.
 */
import type { HarnessDescriptor } from '../descriptor.ts';
import { isRecord, mcpEvent, roleReader, unknownOp } from '../event-roles.ts';
import { MCP_PREFIX, mcpParts } from '../mcp-name.ts';
import { patchOperations, patchesInCommand } from '../patch.ts';
import type { ToolEvent, ToolOperation } from '../protocol.ts';

function operations(
    d: HarnessDescriptor,
    tool: string,
    input: Record<string, unknown>,
    baseDir: string,
): [ToolOperation, ...ToolOperation[]] {
    const { required } = roleReader(d, tool, input);
    const op = d.toolMap[tool];
    switch (op) {
        case 'exec': {
            const command = required('command');
            return [{ op, command, baseDir }, ...patchesInCommand(command, baseDir)];
        }
        case 'patch': {
            const [first, ...rest] = patchOperations(required('patch'), baseDir);
            return [first, ...rest];
        }
        default:
            return [{ op: 'unknown', why: `${tool}: операция ${op} без отображения у Codex` }];
    }
}

export function normalizeCodexEvent(d: HarnessDescriptor, raw: unknown): ToolEvent {
    if (!isRecord(raw)) return unknownOp('вход хука не объект');
    const stray = Object.keys(raw).filter((k) => !d.allowedFields.envelope.includes(k));
    if (stray.length > 0) return unknownOp(`незнакомое поле конверта: ${stray.join(', ')}`);
    const tool = raw.tool_name;
    if (typeof tool !== 'string' || tool === '') return unknownOp('нет tool_name');
    if (typeof raw.cwd !== 'string' || raw.cwd === '') return unknownOp('нет cwd');
    const input = raw.tool_input ?? {};
    if (!isRecord(input)) return unknownOp(`${tool}: tool_input не объект`);

    if (tool.startsWith(MCP_PREFIX)) {
        const mcp = mcpParts(tool, undefined);
        if ('why' in mcp) return unknownOp(mcp.why);
        return mcpEvent(mcp.server, mcp.tool);
    }
    if (!Object.hasOwn(d.toolMap, tool)) {
        return unknownOp(`инструмент ${tool} вне описания`, 'tool');
    }
    const allowed = d.allowedFields.tools[tool];
    const strayArgs = Object.keys(input).filter((k) => !allowed.includes(k));
    if (strayArgs.length > 0) {
        return unknownOp(`${tool}: незнакомое поле входа: ${strayArgs.join(', ')}`);
    }
    try {
        return { operations: operations(d, tool, input, raw.cwd) };
    } catch (error) {
        return unknownOp((error as Error).message);
    }
}

/**
 * Нормализация события плагина OpenCode 1.19.4 в `ToolEvent` по описанию пакета (Фаза 16d2, #192).
 *
 * Команд-хуков у OpenCode нет: событие — два аргумента `tool.execute.before` плагина барьера,
 * `input` (`tool`, `sessionID`, `callID`) и `output.args` — аргументы, которые модель отдала CLI.
 * Плагин зовёт хуки барьера процессом и кладёт им на stdin прежнюю форму Claude Code (её читают
 * хуки потребителя) и рядом — сырое событие CLI полем `opencode`: `{tool, sessionID, callID,
 * args}`. Нормализатор судит только сырое: перевод плагина в форму Claude Code терял `workdir`
 * оболочки и `include` поиска, а патч разбирал своим разбором (`opencodeGuardPlugin`).
 *
 * Перечни — по сырым событиям стенда (`__fixtures__/opencode-1.19.4-stand.json`) и по перечню
 * инструментов, который CLI отдал модели. GPT-модели (`gpt-` в имени, кроме `oss` и `gpt-4`)
 * получают `apply_patch{patchText}` ВМЕСТО `edit` и `write` (`ToolRegistry.tools` бинаря) — у них
 * это единственная правка файла; патч разбирается общим разбором (`../patch.ts`) в запись,
 * удаление и перенос по путям от каталога сессии.
 *
 * `bash.workdir` — каталог исполнения команды, и CLI исполняет её там, в том числе вне дерева
 * (стенд `bash-workdir-allowed`); относительный разрешается от каталога сессии
 * (`bash-workdir-relative`). Поэтому база оболочки — `workdir`, разрешённый от `cwd` события.
 * `grep.include` и `glob.pattern` — шаблон путей поиска (`pathGlob`); без шаблона содержимого
 * (`glob`) guard судит только корень: имена файлов секрета не несут.
 *
 * `task` — субагент (`agent`): в сессии петли guard блокирует его до наследования барьеров —
 * раннер не видит ходов субагента. `skill` — событие доставки инструкций (`inert`), а не
 * доказательство загрузки: доказательство — Фаза 16e (`skillEvidence` описания). `webfetch` —
 * `fetch`.
 *
 * MCP-инструмент OpenCode называет `sanitize(сервер) + "_" + sanitize(инструмент)` без `mcp__`
 * (стенд `mcp`: `stand_stand_write`). `_` законен в обеих частях, и граница сервера по имени не
 * восстанавливается: сервер `foo_list` с инструментом `drop` выглядел бы чтением `list…`. Поэтому
 * имя вне `toolMap` — MCP только через перевод `mcpNames` описания, иначе `unknown` вида `tool`:
 * блок, а не догадка о сервере.
 */
import path from 'node:path';
import type { HarnessDescriptor } from '../descriptor.ts';
import { isRecord, roleReader, searchOperation, translatedMcp, unknownOp } from '../event-roles.ts';
import { patchOperations } from '../patch.ts';
import type { ToolEvent, ToolOperation } from '../protocol.ts';

/**
 * Поля входа хука, которые кладёт плагин барьера (`opencodeGuardPlugin`): форма Claude Code и
 * сырое событие. Перечень закрыт — это протокол плагина, а не CLI: поле вне него значит, что
 * хук позвал не наш плагин той же версии.
 */
export const OPENCODE_HOOK_FIELDS = [
    'hook_event_name',
    'session_id',
    'cwd',
    'tool_name',
    'tool_input',
    'opencode',
] as const;

function operations(
    d: HarnessDescriptor,
    tool: string,
    args: Record<string, unknown>,
    baseDir: string,
    sessionId: string,
): ToolOperation[] {
    const read = roleReader(d, tool, args);
    const { field, required } = read;
    const op = d.toolMap[tool];
    switch (op) {
        case 'exec': {
            const command = required('command');
            const workdir = field('workdir');
            return [{ op, command, baseDir: workdir ? path.resolve(baseDir, workdir) : baseDir }];
        }
        case 'read':
        case 'write':
            return [{ op, path: required('path'), baseDir }];
        case 'patch':
            // Патч без единого файла общий разбор отвергает сам («ни одного файла»).
            return patchOperations(required('patch'), baseDir);
        case 'search':
            return [searchOperation(read, baseDir)];
        case 'fetch':
            return [{ op, url: required('url') }];
        case 'agent':
            return [{ op, parentSession: sessionId }];
        case 'inert':
            if (tool === 'skill') {
                const name = field('name');
                if (!name) throw new Error('skill: нет строкового name');
                return [{ op, what: `skill(${name})` }];
            }
            return [{ op, what: tool }];
        default:
            return [{ op: 'unknown', why: `${tool}: операция ${op} без отображения у OpenCode` }];
    }
}

function mcpOperation(d: HarnessDescriptor, tool: string): ToolEvent {
    return (
        translatedMcp(d, tool) ??
        unknownOp(
            `инструмент ${tool} вне описания: встроенного с таким именем нет, а MCP-имя OpenCode ` +
                '(<сервер>_<инструмент>) без перевода в mcpNames границы сервера не называет',
            'tool',
        )
    );
}

export function normalizeOpencodeEvent(d: HarnessDescriptor, raw: unknown): ToolEvent {
    if (!isRecord(raw)) return unknownOp('вход хука не объект');
    const strayHook = Object.keys(raw).filter(
        (k) => !(OPENCODE_HOOK_FIELDS as readonly string[]).includes(k),
    );
    if (strayHook.length > 0) {
        return unknownOp(`незнакомое поле входа плагина: ${strayHook.join(', ')}`);
    }
    if (typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd)) {
        return unknownOp('нет абсолютного cwd: каталог сессии плагин не назвал');
    }
    const event = raw.opencode;
    if (!isRecord(event)) return unknownOp('нет сырого события OpenCode (поле opencode)');
    const stray = Object.keys(event).filter((k) => !d.allowedFields.envelope.includes(k));
    if (stray.length > 0) return unknownOp(`незнакомое поле конверта: ${stray.join(', ')}`);
    const tool = event.tool;
    if (typeof tool !== 'string' || tool === '') return unknownOp('нет tool');
    const args = event.args ?? {};
    if (!isRecord(args)) return unknownOp(`${tool}: args не объект`);
    const sessionId =
        typeof event.sessionID === 'string' && event.sessionID ? event.sessionID : 'unknown';

    if (!Object.hasOwn(d.toolMap, tool)) return mcpOperation(d, tool);
    const allowed = d.allowedFields.tools[tool] ?? [];
    const strayArgs = Object.keys(args).filter((k) => !allowed.includes(k));
    if (strayArgs.length > 0) {
        return unknownOp(`${tool}: незнакомое поле входа: ${strayArgs.join(', ')}`);
    }
    try {
        const [first, ...rest] = operations(d, tool, args, raw.cwd, sessionId);
        return { operations: [first, ...rest] };
    } catch (error) {
        return unknownOp((error as Error).message);
    }
}

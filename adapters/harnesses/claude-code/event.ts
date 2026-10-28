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
 * Заданное поле роли обязано быть строкой — и обязательное, и необязательное (ревью 16c):
 * `Grep{path: 123}` молча становился поиском от `cwd`, то есть не там, куда пойдёт CLI.
 * Пустая строка необязательного поля — «не задано»: так его читает и CLI. Шаблон содержимого
 * поиска остаётся и пустым — пустой шаблон совпадает с любой строкой, содержимое прочитано.
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
 * `get__CreateReport`, а несколько возможных границ без имени сервера — `unknown`.
 */
import type { HarnessDescriptor } from '../descriptor.ts';
import type { ToolEvent, ToolOperation, UnknownKind } from '../protocol.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const unknownOp = (why: string, kind: UnknownKind = 'field'): ToolEvent => ({
    operations: [{ op: 'unknown', why, kind }],
});

const MCP_PREFIX = 'mcp__';

/** Имя сервера из поля конверта `mcp_server`: строка или объект с `name`. */
function envelopeServer(v: unknown): string | null {
    if (typeof v === 'string' && v !== '') return v;
    if (isRecord(v) && typeof v.name === 'string' && v.name !== '') return v.name;
    return null;
}

/**
 * Сервер и инструмент MCP-имени или причина, почему граница не определена. Кандидаты —
 * каждое `__` с непустыми частями по обе стороны; сервер из конверта выбирает свой, иначе
 * кандидат обязан быть единственным.
 */
function mcpParts(
    name: string,
    serverField: unknown,
): { server: string; tool: string } | { why: string } {
    const rest = name.slice(MCP_PREFIX.length);
    const candidates: { server: string; tool: string }[] = [];
    for (let at = rest.indexOf('__'); at !== -1; at = rest.indexOf('__', at + 1)) {
        const server = rest.slice(0, at);
        const tool = rest.slice(at + 2);
        if (server !== '' && tool !== '' && !server.startsWith('_')) {
            candidates.push({ server, tool });
        }
    }
    const declared = envelopeServer(serverField);
    const own = declared === null ? undefined : candidates.find((c) => c.server === declared);
    if (own) return own;
    if (candidates.length === 1) return candidates[0];
    return {
        why:
            candidates.length === 0
                ? `MCP-имя ${name} без сервера и инструмента`
                : `MCP-имя ${name}: граница сервера неоднозначна`,
    };
}

function operations(
    d: HarnessDescriptor,
    tool: string,
    input: Record<string, unknown>,
    baseDir: string,
    sessionId: string,
): ToolOperation[] {
    const roles = d.argMap[tool] ?? {};
    // Значение поля роли: не задано — undefined, задано не строкой — отказ разбора.
    const arg = (role: keyof typeof roles): string | undefined => {
        const field = roles[role];
        const value = field === undefined ? undefined : input[field];
        if (value === undefined) return undefined;
        if (typeof value !== 'string') throw new Error(`${tool}: поле ${field} не строка`);
        return value;
    };
    const optional = (role: keyof typeof roles): string | undefined => arg(role) || undefined;
    const required = (role: keyof typeof roles): string => {
        const value = optional(role);
        if (value === undefined) throw new Error(`${tool}: нет строкового ${roles[role] ?? role}`);
        return value;
    };
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
        case 'search': {
            const search: Extract<ToolOperation, { op: 'search' }> = {
                op,
                root: optional('root') ?? baseDir,
                baseDir,
            };
            const contentPattern = arg('contentPattern');
            const pathGlob = optional('pathGlob');
            if (contentPattern !== undefined) search.contentPattern = contentPattern;
            if (pathGlob !== undefined) search.pathGlob = pathGlob;
            return [search];
        }
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
        return {
            operations: [
                { op: 'mcp', server: mcp.server, tool: mcp.tool, effect: 'unknown', derived: [] },
            ],
        };
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

/**
 * Нормализация входа хука Kimi Code 2.3.2 в `ToolEvent` по описанию пакета (Фаза 16d2, #191).
 *
 * Перечни — по сырым событиям стенда (`__fixtures__/kimi-code-2.3.2-stand.json`) и по перечню
 * инструментов, который CLI отдал модели, а не по форме Claude Code: путь файла у Kimi Code —
 * поле `path` (у `Write` ещё `mode: append`, у `Edit` — `replace_all`), у `Grep` фильтр путей —
 * `glob`. До карточки регистрация шла совместимым входом 16b: `path` он знал, но незнакомое имя
 * (`FetchURL`) пропускал, а `cwd` оболочки не видел вовсе.
 *
 * `Bash` несёт свой `cwd`, и команда исполняется ТАМ: CLI разрешает его от каталога сессии
 * (`view.resolve`), абсолютный — как есть, и каталог вне дерева не отвергает (стенд
 * `bash-cwd-allowed`: эффект лёг в `cwd` вызова). Поэтому база оболочки — `cwd` вызова,
 * разрешённый от `cwd` события; совместимый вход этого поля не видел, и `mv ralph bak` из
 * `.claude` судился от корня дерева, где `ralph` — не данные контура. Ролью описания `cwd` не
 * сделан: базу операции схема ролей не принимает (`ARG_ROLES`), её даёт нормализатор.
 * `cwd` события обязан быть абсолютным (ревью 16d2): относительный разрешался бы от рабочего
 * каталога процесса нормализатора, а не от дерева сессии, — это догадка о базе, и разбор
 * отказывает, как у OpenCode.
 *
 * `FetchURL` и `WebSearch` — `fetch`, `Agent` и `AgentSwarm` — `agent`, `CronCreate` — `defer`:
 * в сессии петли их блокирует guard (политики сети и наследования барьеров у него нет). Поля
 * сверяются со списком описания и у них — незнакомое поле может нести путь.
 * Роль `url` у `WebSearch` — поле `query`, то есть поисковый запрос, а не адрес: текст уходит
 * наружу тем же каналом, и в событии и в причине блока он стоит на месте адреса намеренно.
 *
 * MCP здесь только нормализуется (`effect: 'unknown'`), допуск — политика контура у guard. Имя —
 * `mcp__<сервер>__<инструмент>` с частями, где всё вне `[A-Za-z0-9_-]` заменено `_` и серии `_`
 * схлопнуты; длиннее 64 знаков CLI обрезает его и дописывает `_<хеш>` (`kimiMcpToolName`). У
 * обрезанного имени граница сервера и инструмента потеряна или указывает на обрубок (стенд
 * `mcp-long`: `mcp__<длинный сервер>_-6af8ac39`), поэтому имя ровно в 64 знака без перевода в
 * `mcpNames` описания — `unknown`, а не догадка о сервере. Цена названа: необрезанное имя ровно
 * в 64 знака тоже требует перевода.
 */
import path from 'node:path';
import type { HarnessDescriptor } from '../descriptor.ts';
import {
    isRecord,
    mcpEvent,
    roleReader,
    searchOperation,
    translatedMcp,
    unknownOp,
} from '../event-roles.ts';
import { MCP_PREFIX, mcpParts } from '../mcp-name.ts';
import type { ToolEvent, ToolOperation } from '../protocol.ts';

/** Предел длины MCP-имени у CLI (`MAX_QUALIFIED_LENGTH`): длиннее — обрезка с хешем. */
export const KIMI_MCP_NAME_MAX = 64;

const mcpNamePart = (part: string): string =>
    part.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');

/** FNV-1a CLI, включая знак: `Math.trunc` оставляет int32, и хеш бывает `-6af8ac39`. */
function stableHash8(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.codePointAt(i) as number;
        hash = Math.trunc(Math.imul(hash, 16777619));
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Имя, которым Kimi Code 2.3.2 называет инструмент MCP модели и хуку (`qualifyMcpToolName`
 * бинаря) — для перевода в `mcpNames`: обрезанное имя по себе не разбирается.
 */
export function kimiMcpToolName(server: string, tool: string): string {
    const full = `${MCP_PREFIX}${mcpNamePart(server)}__${mcpNamePart(tool)}`;
    if (full.length <= KIMI_MCP_NAME_MAX) return full;
    const hash = stableHash8(full);
    return `${full.slice(0, KIMI_MCP_NAME_MAX - hash.length - 1)}_${hash}`;
}

function mcpOperation(d: HarnessDescriptor, name: string): ToolEvent {
    const translated = translatedMcp(d, name);
    if (translated) return translated;
    if (name.length >= KIMI_MCP_NAME_MAX) {
        return unknownOp(
            `MCP-имя ${name} в ${KIMI_MCP_NAME_MAX} знаков: CLI мог обрезать его с хешем, ` +
                'а перевода в mcpNames нет',
        );
    }
    const mcp = mcpParts(name, undefined);
    if ('why' in mcp) return unknownOp(mcp.why);
    return mcpEvent(mcp.server, mcp.tool);
}

function operations(
    d: HarnessDescriptor,
    tool: string,
    input: Record<string, unknown>,
    baseDir: string,
    sessionId: string,
): ToolOperation[] {
    const read = roleReader(d, tool, input);
    const { field, required } = read;
    const op = d.toolMap[tool];
    switch (op) {
        case 'exec': {
            const command = required('command');
            const cwd = field('cwd');
            return [{ op, command, baseDir: cwd ? path.resolve(baseDir, cwd) : baseDir }];
        }
        case 'read':
        case 'write':
            return [{ op, path: required('path'), baseDir }];
        case 'search':
            return [searchOperation(read, baseDir)];
        case 'fetch':
            return [{ op, url: required('url') }];
        case 'agent':
            return [{ op, parentSession: sessionId }];
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
            return [{ op: 'unknown', why: `${tool}: операция ${op} без отображения у Kimi Code` }];
    }
}

export function normalizeKimiEvent(d: HarnessDescriptor, raw: unknown): ToolEvent {
    if (!isRecord(raw)) return unknownOp('вход хука не объект');
    const stray = Object.keys(raw).filter((k) => !d.allowedFields.envelope.includes(k));
    if (stray.length > 0) return unknownOp(`незнакомое поле конверта: ${stray.join(', ')}`);
    const tool = raw.tool_name;
    if (typeof tool !== 'string' || tool === '') return unknownOp('нет tool_name');
    if (typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd)) {
        return unknownOp('нет абсолютного cwd: каталог сессии CLI не назвал');
    }
    const input = raw.tool_input ?? {};
    if (!isRecord(input)) return unknownOp(`${tool}: tool_input не объект`);
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';

    if (tool.startsWith(MCP_PREFIX)) return mcpOperation(d, tool);
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

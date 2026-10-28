/**
 * Общий разбор события для нормализаторов пакетов (ревью Фазы 16d2): чтение ролей `argMap`,
 * сборка операции поиска и перевод MCP-имени через `mcpNames` описания.
 *
 * До выноса каждый из четырёх нормализаторов (Claude Code, Codex, Kimi Code, OpenCode) держал
 * свою дословную копию этого кода, а он входит в барьер: правка проверки типа поля роли должна
 * была попасть во все четыре, и пропущенная копия оставила бы один CLI со старым разбором. В
 * пакетах остаётся только то, чем CLI отличаются: имена полей конверта, база `cwd`/`workdir`,
 * форма MCP-имени.
 *
 * Заданное поле роли обязано быть строкой — и обязательное, и необязательное (ревью 16c):
 * `Grep{path: 123}` молча становился поиском от `cwd`, то есть не там, куда пойдёт CLI. Пустая
 * строка необязательного поля — «не задано»: так его читает и CLI. Шаблон содержимого поиска
 * остаётся и пустым — пустой шаблон совпадает с любой строкой, содержимое прочитано.
 */
import type { ArgRole, HarnessDescriptor } from './descriptor.ts';
import type { ToolEvent, ToolOperation, UnknownKind } from './protocol.ts';

export const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

export const unknownOp = (why: string, kind: UnknownKind = 'field'): ToolEvent => ({
    operations: [{ op: 'unknown', why, kind }],
});

export type RoleReader = {
    /** Поле входа по имени: не задано — undefined, задано не строкой — отказ разбора. */
    field: (name: string) => string | undefined;
    /** Значение поля роли: не задано — undefined, задано не строкой — отказ разбора. */
    arg: (role: ArgRole) => string | undefined;
    /** То же, но пустая строка — «не задано». */
    optional: (role: ArgRole) => string | undefined;
    /** Непустая строка поля роли, иначе отказ разбора. */
    required: (role: ArgRole) => string;
};

/** Чтение ролей инструмента `tool` из входа по `argMap` описания; отказ — исключение. */
export function roleReader(
    d: HarnessDescriptor,
    tool: string,
    input: Record<string, unknown>,
): RoleReader {
    const roles = d.argMap[tool] ?? {};
    const field = (name: string): string | undefined => {
        const value = input[name];
        if (value === undefined) return undefined;
        if (typeof value !== 'string') throw new Error(`${tool}: поле ${name} не строка`);
        return value;
    };
    const arg = (role: ArgRole): string | undefined => {
        const name = roles[role];
        return name === undefined ? undefined : field(name);
    };
    const optional = (role: ArgRole): string | undefined => arg(role) || undefined;
    const required = (role: ArgRole): string => {
        const value = optional(role);
        if (value === undefined) throw new Error(`${tool}: нет строкового ${roles[role] ?? role}`);
        return value;
    };
    return { field, arg, optional, required };
}

/** Операция поиска: корень — поле роли или база, шаблоны — только заданные. */
export function searchOperation(
    read: RoleReader,
    baseDir: string,
): Extract<ToolOperation, { op: 'search' }> {
    const search: Extract<ToolOperation, { op: 'search' }> = {
        op: 'search',
        root: read.optional('root') ?? baseDir,
        baseDir,
    };
    const contentPattern = read.arg('contentPattern');
    const pathGlob = read.optional('pathGlob');
    if (contentPattern !== undefined) search.contentPattern = contentPattern;
    if (pathGlob !== undefined) search.pathGlob = pathGlob;
    return search;
}

/** MCP-операция по переводу имени в `mcpNames` описания; перевода нет — undefined. */
export function translatedMcp(d: HarnessDescriptor, name: string): ToolEvent | undefined {
    const translated = Object.hasOwn(d.mcpNames, name) ? d.mcpNames[name] : undefined;
    if (!translated) return undefined;
    return { operations: [{ op: 'mcp', ...translated, effect: 'unknown', derived: [] }] };
}

/** MCP-операция по разобранным частям имени: эффект задаёт политика контура у guard. */
export const mcpEvent = (server: string, tool: string): ToolEvent => ({
    operations: [{ op: 'mcp', server, tool, effect: 'unknown', derived: [] }],
});

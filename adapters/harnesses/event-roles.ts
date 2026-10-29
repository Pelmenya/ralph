/**
 * Общий разбор события для нормализаторов пакетов (ревью Фазы 16d2): чтение ролей `argMap`,
 * сборка операции поиска, перевод MCP-имени через `mcpNames` описания и эффекты параметров
 * MCP-вызова (`mcpDerived`, #193).
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

/** Адрес целиком: схема и `//` (`https://…`, `file:///…`, `ssh://…`). */
const URL_VALUE_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** Длиннее `PATH_MAX` Linux файл не открыть: такая строка — данные, а не путь. */
const PATH_VALUE_MAX = 4096;

/**
 * Связанные файловые и сетевые эффекты параметров MCP-вызова — операции `derived` (#193).
 * Имя инструмента об эффекте не говорит: разрешённая загрузка с `.env` в аргументе — то же
 * чтение секрета, и guard судит такие операции теми же правилами, что встроенные.
 *
 * Обходятся все значения входа, вглубь объектов и массивов, и ключи объектов (`{files:
 * {".env": …}}` — путь ключом). Роль строки:
 *   - адрес целиком (`URL_VALUE_RE`) или значение под ключом `mcpArgs.url` — `fetch`: до
 *     политики сети его блокирует guard, и вне петли тоже. Адрес судится в ЛЮБОМ поле, а не
 *     только под `mcpArgs.url`: сервер волен открыть ссылку из поля `source` или `uri`, как и
 *     путь. Цена — ложные отказы: мутация форжа, где поле — голая ссылка (`issue_url`, `link`,
 *     `homepage`, тело комментария из одной ссылки), блокируется и в сессии человека, хотя сеть
 *     идёт от сервера. Ссылка внутри текста с пробелом адресом целиком не считается;
 *   - значение под ключом `mcpArgs.path` — `write`: эффект инструмента нормализатор не знает
 *     (его задаёт политика контура у guard), и путь судится строже — записью, которая включает
 *     и правило секрета, и забор данных контура в сессии петли;
 *   - любая другая строка без пробелов — `read`. Сервер волен назвать путь `key` или `target`,
 *     и перечень имён описания такой путь пропустил бы; чтение блокирует только секрет, поэтому
 *     идентификатор `main` или `42` проходит, а `.env` — нет. Цена: строка с пробелом вне
 *     `mcpArgs.path` путём не считается.
 *
 * Ключи `mcpArgs` сравниваются без регистра: `filePath` и `filepath` у серверов — одно поле.
 */
export function mcpDerived(
    d: HarnessDescriptor,
    args: Record<string, unknown>,
    baseDir: string,
): ToolOperation[] {
    const pathKeys = new Set(d.mcpArgs.path.map((k) => k.toLowerCase()));
    const urlKeys = new Set(d.mcpArgs.url.map((k) => k.toLowerCase()));
    const seen = new Set<string>();
    const out: ToolOperation[] = [];
    const push = (op: ToolOperation) => {
        const key = JSON.stringify(op);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(op);
    };
    const text = (value: string, key: string | undefined) => {
        const role = key?.toLowerCase();
        if (URL_VALUE_RE.test(value) || (role !== undefined && urlKeys.has(role))) {
            push({ op: 'fetch', url: value });
        } else if (role !== undefined && pathKeys.has(role) && value !== '') {
            push({ op: 'write', path: value, baseDir });
        } else if (value !== '' && value.length <= PATH_VALUE_MAX && !/\s/.test(value)) {
            push({ op: 'read', path: value, baseDir });
        }
    };
    const visit = (value: unknown, key: string | undefined) => {
        if (typeof value === 'string') text(value, key);
        else if (Array.isArray(value)) for (const item of value) visit(item, key);
        else if (isRecord(value)) {
            for (const [k, v] of Object.entries(value)) {
                text(k, key);
                visit(v, k);
            }
        }
    };
    for (const [k, v] of Object.entries(args)) visit(v, k);
    return out;
}

/** MCP-операция по переводу имени в `mcpNames` описания; перевода нет — undefined. */
export function translatedMcp(
    d: HarnessDescriptor,
    name: string,
    derived: ToolOperation[],
): ToolEvent | undefined {
    const translated = Object.hasOwn(d.mcpNames, name) ? d.mcpNames[name] : undefined;
    if (!translated) return undefined;
    return mcpEvent(translated.server, translated.tool, derived);
}

/** MCP-операция по разобранным частям имени: эффект задаёт политика контура у guard. */
export const mcpEvent = (server: string, tool: string, derived: ToolOperation[]): ToolEvent => ({
    operations: [{ op: 'mcp', server, tool, effect: 'unknown', derived }],
});

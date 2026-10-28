/**
 * Схема описания пакета харнесса и её валидатор (Фаза 16c, #179).
 *
 * Описание (`adapters/harnesses/<имя>/descriptor.json`) — данные, по которым реестр
 * принимает пакет, генератор строит матрицу проб, а сверка инвентаря CLI ловит
 * неполноту (`docs/harness-contract.md`, «Пакет адаптера» и «Набор соответствия»). Схема
 * нужна раньше реестра: реестр проверяет пакеты по ней, и без неё «пакет подключён»
 * значило бы «каталог существует».
 *
 * Валидатор fail-closed во всём, что решает, видит ли барьер вызов:
 *   - версия схемы обязана быть знакомой. Описание новой версии, прочитанное старым
 *     валидатором, теряло бы молча то поле, ради которого версию подняли;
 *   - каждое поле обязательно и незнакомое поле — отказ. Опечатка `alowedFields` иначе
 *     оставила бы перечень полей пустым, а пустой перечень — это «незнакомых полей нет»;
 *   - перекрёстные ссылки сверяются: `argMap` и `allowedFields` называют только
 *     инструменты из `toolMap`, поле `argMap` — только поле из перечня своего инструмента,
 *     у каждого инструмента `toolMap` есть перечень. Разъехавшиеся таблицы дают
 *     нормализатор, который берёт путь из поля, о котором барьер не знает.
 *
 * Пустыми законно быть `configSurfaces`, `forbiddenEnv`, `mcpNames` и `rules`: у
 * харнесса может не быть проектных слоёв конфига, переменных-выключателей или MCP. Пустой
 * `toolMap` или перечень конверта — нет: пакет, не знающий ни одного инструмента, ничего
 * не нормализует.
 */
import { isAbsolute } from 'node:path';

export const HARNESS_DESCRIPTOR_SCHEMA_VERSION = 1;

/**
 * Операции, в которые `toolMap` отображает инструмент; `unknown` отображением не бывает.
 * `patch` — не операция события, а класс входа: текст патча, который нормализатор разбирает
 * общим разбором (`patch.ts`) в `write`/`delete`/`move` — guard патча не видит (#189).
 */
export const MAPPED_OPERATIONS = [
    'exec',
    'read',
    'write',
    'delete',
    'move',
    'search',
    'patch',
    'mcp',
    'fetch',
    'agent',
    'defer',
    'inert',
] as const;

/**
 * Роли полей входа, которые нормализатор переносит в операцию (`patch` — поле с текстом патча). `baseDir` ролью не бывает: его
 * берёт нормализатор из конверта события (`cwd` у Claude Code), и роль, которую схема
 * принимала, а нормализатор не исполнял, обещала бы пакету пути от другой базы (ревью 16c).
 */
export const ARG_ROLES = [
    'command',
    'path',
    'destination',
    'root',
    'contentPattern',
    'pathGlob',
    'url',
    'patch',
] as const;

export type ArgRole = (typeof ARG_ROLES)[number];

/** Канал исполнения: перехвачен хуком или доказанно выключен — третьего нет. */
export const COVERAGE_MODES = ['intercepted', 'disabled'] as const;

export type HarnessDescriptor = {
    schemaVersion: number;
    harness: string;
    cliVersion: string;
    /** Исполняемая команда нормализатора: путь скрипта от каталога пакета. */
    normalizer: string;
    toolMap: Record<string, (typeof MAPPED_OPERATIONS)[number]>;
    argMap: Record<string, Partial<Record<ArgRole, string>>>;
    allowedFields: { envelope: string[]; tools: Record<string, string[]> };
    eventCoverage: Record<string, { mode: (typeof COVERAGE_MODES)[number]; evidence: string }>;
    configSurfaces: string[];
    forbiddenEnv: string[];
    mcpNames: Record<string, { server: string; tool: string }>;
    skillEvidence: { source: string };
    /**
     * Файлы правил дерева в порядке, в котором их ищет CLI; где правила отдаёт раннер (OpenCode
     * с выключенным проектным конфигом), берётся первый найденный, как у самого CLI.
     */
    rules: string[];
    inventorySource: string;
    /**
     * Обязательные поля входа инструмента вне ролей `argMap` — минимальный валидный вход
     * пробы (ревью 16c): разрешённая проба с пустым входом у `Skill` разбиралась в `unknown`,
     * а CLI, сверяющий схему до хука, отверг бы `Write` без `content`. Необязательное поле:
     * нет — у инструментов описания других обязательных полей нет; опечатку в ключе
     * валидатор ловит как незнакомое поле.
     */
    probeInputs?: Record<string, Record<string, unknown>>;
};

const FIELDS: ReadonlyArray<keyof HarnessDescriptor> = [
    'schemaVersion',
    'harness',
    'cliVersion',
    'normalizer',
    'toolMap',
    'argMap',
    'allowedFields',
    'eventCoverage',
    'configSurfaces',
    'forbiddenEnv',
    'mcpNames',
    'skillEvidence',
    'rules',
    'inventorySource',
];

/** Необязательные поля описания: отсутствие — не отказ, незнакомое — отказ. */
const OPTIONAL_FIELDS: ReadonlyArray<keyof HarnessDescriptor> = ['probeInputs'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Список непустых различных строк; `allowEmpty` — можно ли пустой список. */
function stringListProblems(v: unknown, at: string, allowEmpty: boolean): string[] {
    if (!Array.isArray(v)) return [`${at}: не массив`];
    const problems: string[] = [];
    if (!allowEmpty && v.length === 0) problems.push(`${at}: пустой список`);
    v.forEach((item, i) => {
        if (!isText(item)) problems.push(`${at}[${i}]: не непустая строка`);
    });
    if (new Set(v).size !== v.length) problems.push(`${at}: повтор элемента`);
    return problems;
}

function unknownKeys(v: Record<string, unknown>, known: readonly string[], at: string): string[] {
    return Object.keys(v)
        .filter((key) => !known.includes(key))
        .map((key) => `${at}: незнакомое поле ${key}`);
}

function toolMapProblems(v: unknown): string[] {
    if (!isRecord(v)) return ['toolMap: не объект'];
    const entries = Object.entries(v);
    if (entries.length === 0) return ['toolMap: пустой — пакет не знает ни одного инструмента'];
    return entries
        .filter(([, op]) => !(MAPPED_OPERATIONS as readonly unknown[]).includes(op))
        .map(
            ([tool, op]) =>
                `toolMap.${tool}: операция ${JSON.stringify(op)} вне ${MAPPED_OPERATIONS.join('/')}`,
        );
}

function allowedFieldsProblems(v: unknown, tools: string[]): string[] {
    if (!isRecord(v)) return ['allowedFields: не объект'];
    const problems = unknownKeys(v, ['envelope', 'tools'], 'allowedFields');
    problems.push(...stringListProblems(v.envelope, 'allowedFields.envelope', false));
    if (!isRecord(v.tools)) return [...problems, 'allowedFields.tools: не объект'];
    for (const [tool, fields] of Object.entries(v.tools)) {
        if (!tools.includes(tool))
            problems.push(`allowedFields.tools.${tool}: инструмента нет в toolMap`);
        problems.push(...stringListProblems(fields, `allowedFields.tools.${tool}`, true));
    }
    for (const tool of tools) {
        if (!Object.hasOwn(v.tools, tool)) {
            problems.push(
                `allowedFields.tools.${tool}: нет перечня полей входа инструмента из toolMap`,
            );
        }
    }
    return problems;
}

function argMapProblems(v: unknown, tools: string[], allowed: unknown): string[] {
    if (!isRecord(v)) return ['argMap: не объект'];
    const allowedTools = isRecord(allowed) && isRecord(allowed.tools) ? allowed.tools : {};
    const problems: string[] = [];
    for (const [tool, roles] of Object.entries(v)) {
        const at = `argMap.${tool}`;
        if (!tools.includes(tool)) problems.push(`${at}: инструмента нет в toolMap`);
        if (!isRecord(roles)) {
            problems.push(`${at}: не объект`);
            continue;
        }
        problems.push(...unknownKeys(roles, ARG_ROLES, at));
        const fields = Array.isArray(allowedTools[tool]) ? (allowedTools[tool] as unknown[]) : [];
        for (const [role, field] of Object.entries(roles)) {
            if (!isText(field)) problems.push(`${at}.${role}: не непустая строка`);
            else if (!fields.includes(field)) {
                problems.push(`${at}.${role}: поля ${field} нет в allowedFields.tools.${tool}`);
            }
        }
    }
    return problems;
}

function probeInputsProblems(v: unknown, tools: string[], allowed: unknown): string[] {
    if (v === undefined) return [];
    if (!isRecord(v)) return ['probeInputs: не объект'];
    const allowedTools = isRecord(allowed) && isRecord(allowed.tools) ? allowed.tools : {};
    const problems: string[] = [];
    for (const [tool, input] of Object.entries(v)) {
        const at = `probeInputs.${tool}`;
        if (!tools.includes(tool)) problems.push(`${at}: инструмента нет в toolMap`);
        if (!isRecord(input)) {
            problems.push(`${at}: не объект`);
            continue;
        }
        const fields = Array.isArray(allowedTools[tool]) ? (allowedTools[tool] as unknown[]) : [];
        for (const field of Object.keys(input)) {
            if (!fields.includes(field)) {
                problems.push(`${at}.${field}: поля нет в allowedFields.tools.${tool}`);
            }
        }
    }
    return problems;
}

function eventCoverageProblems(v: unknown): string[] {
    if (!isRecord(v)) return ['eventCoverage: не объект'];
    if (Object.keys(v).length === 0) return ['eventCoverage: пусто — каналы исполнения не названы'];
    const problems: string[] = [];
    for (const [channel, entry] of Object.entries(v)) {
        const at = `eventCoverage.${channel}`;
        if (!isRecord(entry)) {
            problems.push(`${at}: не объект`);
            continue;
        }
        problems.push(...unknownKeys(entry, ['mode', 'evidence'], at));
        if (!(COVERAGE_MODES as readonly unknown[]).includes(entry.mode)) {
            problems.push(
                `${at}.mode: ${JSON.stringify(entry.mode)} вне ${COVERAGE_MODES.join('/')}`,
            );
        }
        if (!isText(entry.evidence)) problems.push(`${at}.evidence: нет доказательства`);
    }
    return problems;
}

function mcpNamesProblems(v: unknown): string[] {
    if (!isRecord(v)) return ['mcpNames: не объект'];
    const problems: string[] = [];
    for (const [emitted, target] of Object.entries(v)) {
        const at = `mcpNames.${emitted}`;
        if (!isRecord(target)) {
            problems.push(`${at}: не объект`);
            continue;
        }
        problems.push(...unknownKeys(target, ['server', 'tool'], at));
        if (!isText(target.server)) problems.push(`${at}.server: не непустая строка`);
        if (!isText(target.tool)) problems.push(`${at}.tool: не непустая строка`);
    }
    return problems;
}

function skillEvidenceProblems(v: unknown): string[] {
    if (!isRecord(v)) return ['skillEvidence: не объект'];
    const problems = unknownKeys(v, ['source'], 'skillEvidence');
    if (!isText(v.source)) problems.push('skillEvidence.source: не непустая строка');
    return problems;
}

function normalizerProblems(v: unknown): string[] {
    if (!isText(v)) return ['normalizer: не непустая строка'];
    // Команда — файл пакета: абсолютный путь или выход выше пакета исполнял бы чужой код.
    if (isAbsolute(v) || v.split(/[\\/]/).includes('..')) {
        return ['normalizer: путь обязан лежать внутри каталога пакета'];
    }
    return [];
}

/** Проблемы описания; пустой список — описание принято. */
export function harnessDescriptorProblems(raw: unknown): string[] {
    if (!isRecord(raw)) return ['описание пакета: не объект'];
    if (!Object.hasOwn(raw, 'schemaVersion')) return ['schemaVersion: нет версии схемы'];
    if (raw.schemaVersion !== HARNESS_DESCRIPTOR_SCHEMA_VERSION) {
        // Дальше не разбираем: поля чужой версии значат не то, что знает этот валидатор.
        return [
            `schemaVersion: незнакомая версия ${JSON.stringify(raw.schemaVersion)} (валидатор знает ${HARNESS_DESCRIPTOR_SCHEMA_VERSION})`,
        ];
    }
    const problems = unknownKeys(raw, [...FIELDS, ...OPTIONAL_FIELDS], 'описание пакета');
    for (const field of FIELDS) {
        if (!Object.hasOwn(raw, field)) problems.push(`${field}: нет обязательного поля`);
    }
    if (problems.length > 0) return problems;

    for (const field of ['harness', 'cliVersion', 'inventorySource'] as const) {
        if (!isText(raw[field])) problems.push(`${field}: не непустая строка`);
    }
    const tools = isRecord(raw.toolMap) ? Object.keys(raw.toolMap) : [];
    problems.push(
        ...normalizerProblems(raw.normalizer),
        ...toolMapProblems(raw.toolMap),
        ...allowedFieldsProblems(raw.allowedFields, tools),
        ...argMapProblems(raw.argMap, tools, raw.allowedFields),
        ...eventCoverageProblems(raw.eventCoverage),
        ...stringListProblems(raw.configSurfaces, 'configSurfaces', true),
        ...stringListProblems(raw.forbiddenEnv, 'forbiddenEnv', true),
        ...mcpNamesProblems(raw.mcpNames),
        ...skillEvidenceProblems(raw.skillEvidence),
        ...stringListProblems(raw.rules, 'rules', true),
        ...probeInputsProblems(raw.probeInputs, tools, raw.allowedFields),
    );
    return problems;
}

/** Принятое описание либо бросок со всеми проблемами — для реестра, который не продолжает. */
export function parseHarnessDescriptor(raw: unknown, source: string): HarnessDescriptor {
    const problems = harnessDescriptorProblems(raw);
    if (problems.length > 0) {
        throw new Error(
            `описание пакета харнесса ${source} не по схеме:\n  - ${problems.join('\n  - ')}`,
        );
    }
    return raw as HarnessDescriptor;
}

/**
 * Описание, принятое схемой и названное харнессом команды нормализатора; иначе — отказ. Guard
 * зовёт команду по пути из своей регистрации, мимо реестра, и чужое описание рядом с модулем
 * судило бы события таблицами другого CLI. Сверка общая для всех пакетов: копия в каждом
 * нормализаторе оставила бы пропущенный CLI со старой сверкой.
 */
export function ownDescriptor(raw: unknown, source: string, harness: string): HarnessDescriptor {
    const descriptor = parseHarnessDescriptor(raw, source);
    if (descriptor.harness !== harness) {
        throw new Error(
            `${source}: описание харнесса «${descriptor.harness}», а команда — нормализатор ${harness}`,
        );
    }
    return descriptor;
}

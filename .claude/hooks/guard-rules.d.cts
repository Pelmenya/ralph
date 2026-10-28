/**
 * Типы барьера для TS-потребителей. Сам барьер — CommonJS: его грузит хук Claude Code
 * через `require`, и переписывать его в модуль ради типов значило бы менять то, что
 * работает, ради удобства того, что его читает.
 *
 * Пара нужна тестам барьера: они импортируют правила напрямую, без процесса хука.
 */
export type TGuardDecision = {
    blocked: boolean;
    reason: string | null;
    /** Код причины блока из перечня контракта (`adapters/barrier-reason.ts`). */
    code?: string;
};

/** Контур потребителя: разобранный `.claude/ralph/hooks.json` (`consumer-data.cjs`). */
export type TGuardContour = {
    mcp: {
        writeAllowed: Set<string>;
        neverExceptions: Set<string>;
        /** Эффекты MCP по политике (#185); guard на событии судит ими, если заявлены. */
        tools: Map<string, 'read' | 'write'>;
        toolsDeclared?: boolean;
    };
};

/** Данные контура и подмена окружения правила про kill (#196) — только для тестов. */
export type TGuardDecideOptions = {
    contour?: TGuardContour;
    loop?: boolean | (() => boolean);
    processInfo?: (
        pid: number,
    ) => { comm: string; ppid: number; cwd: string; cmdline: string } | null;
    selfPid?: number;
    sessionCwd?: string;
};

export declare function decide(
    toolName: string,
    toolInput: Record<string, unknown>,
    options?: TGuardDecideOptions,
): TGuardDecision;

export declare function mcpAllowed(toolName: string, mcp?: TGuardContour['mcp']): boolean;
export declare function mcpAllowedByEffect(toolName: string, mcp?: TGuardContour['mcp']): boolean;
export declare function mcpReadCall(toolName: string): boolean;

export declare const ENV_FILE_RE: RegExp;
export declare const CMD_ENV_RE: RegExp;
// Правила деструктивных команд отсюда БОЛЬШЕ НЕ ЭКСПОРТИРУЮТСЯ: они переехали в
// `guard-shell.cjs` и работают над списком вызовов (`shell-calls.cjs`), а не над строкой.
// Декларация пережила переезд на один проход ревью и обещала потребителю
// `DESTRUCTIVE_BASH`, которого в модуле уже нет: типы сходились, обращение падало бы
// в рантайме (ревью Codex terra, проход 5).

/**
 * Операция нормализованного события в форме, которую судит барьер. Своя копия типа, а не
 * импорт `adapters/harnesses/protocol.ts`: хуки от пакетов не зависят (`harness-package-deps`),
 * совпадение форм держит тест протокола.
 */
export type TGuardOperation =
    | { op: 'exec'; command: string; baseDir: string }
    | { op: 'read' | 'write' | 'delete'; path: string; baseDir: string }
    | { op: 'move'; path: string; destination: string; baseDir: string }
    | { op: 'search'; root: string; contentPattern?: string; pathGlob?: string; baseDir: string }
    | {
          op: 'mcp';
          server: string;
          tool: string;
          effect: 'read' | 'write' | 'unknown';
          derived: TGuardOperation[];
      }
    | { op: 'fetch'; url: string }
    | { op: 'agent'; parentSession: string }
    | { op: 'defer'; what: string }
    | { op: 'inert'; what: string }
    | { op: 'unknown'; why: string; kind?: 'tool' | 'field' };

export type TGuardEvent = { operations: TGuardOperation[] };

/**
 * Чтение файловой системы правила на событии: разрешение путей и обход корня поиска.
 * `readlinkSync` и `isSymbolicLink` необязательны: без них висячий симлинк судится строкой,
 * а симлинк внутри корня поиска — по имени.
 */
export type TGuardFs = {
    realpathSync: (p: string) => string;
    statSync: (p: string) => { isDirectory: () => boolean };
    readdirSync: (
        p: string,
        opts: { withFileTypes: true },
    ) => { name: string; isDirectory: () => boolean; isSymbolicLink?: () => boolean }[];
    readlinkSync?: (p: string) => string;
};

export declare function decideEvent(
    event: TGuardEvent,
    options?: TGuardDecideOptions & { fsApi?: TGuardFs },
): TGuardDecision;

export declare function globMayMatchEnv(glob: string): boolean;

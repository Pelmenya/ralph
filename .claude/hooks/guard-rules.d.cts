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
};

/** Подмена окружения правила про kill (#196) — только для тестов. */
export type TGuardDecideOptions = {
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

export declare function mcpAllowed(toolName: string): boolean;

export declare const ENV_FILE_RE: RegExp;
export declare const CMD_ENV_RE: RegExp;
// Правила деструктивных команд отсюда БОЛЬШЕ НЕ ЭКСПОРТИРУЮТСЯ: они переехали в
// `guard-shell.cjs` и работают над списком вызовов (`shell-calls.cjs`), а не над строкой.
// Декларация пережила переезд на один проход ревью и обещала потребителю
// `DESTRUCTIVE_BASH`, которого в модуле уже нет: типы сходились, обращение падало бы
// в рантайме (ревью Codex terra, проход 5).

/** Типы контекста сессии для TS-тестов; сам модуль — CommonJS, как хуки. */
export type TSessionContext = {
    sessionId: string;
    loop: boolean;
    coreRevision: string;
    roots: { consumer: string; execution: string };
    /** Необязательно до раннера с #199; форма — `ProtectedSurfaces` описания пакета. */
    protectedSurfaces?: {
        tree: string[];
        homes: { env: string | null; sub: string; default: string | null; exempt: string[] }[];
    };
};

export type TSessionContextRead =
    | { context: null; error: null }
    | { context: TSessionContext; error: null }
    | { context: null; error: string };

export declare const SESSION_CONTEXT_ENV: string;
export declare function parseSessionContext(raw: unknown): TSessionContextRead;
export declare function readSessionContext(
    env?: Record<string, string | undefined>,
): TSessionContextRead;

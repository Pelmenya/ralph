/** Типы границы вызова адаптера для TS-тестов; сам модуль — CommonJS, как хуки. */
export type TAdapterVerdict =
    { event: { operations: unknown[] } } | { block: true; reason: string };

export declare const ADAPTER_PROTOCOL_VERSION: number;
export declare const ADAPTER_TIMEOUT_MS: number;
export declare const OPERATION_FIELDS: Record<string, string[]>;
export declare function toolEventProblem(event: unknown): string | null;
export declare function parseAdapterReply(stdout: string): { event: unknown } | { reason: string };
export declare function normalizeViaAdapter(
    argv: string[],
    rawInput: string,
    deps?: {
        spawnSyncFn?: (...args: unknown[]) => unknown;
        timeoutMs?: number;
        env?: Record<string, string | undefined>;
    },
): TAdapterVerdict;

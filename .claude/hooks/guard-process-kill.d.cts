/** Типы правила про kill (#196) для TS-потребителей; сам модуль — CommonJS, как соседи. */
export type TProcessInfo = { comm: string; ppid: number; cwd: string; cmdline: string };

export type TKillRuleOptions = {
    processInfo?: (pid: number) => TProcessInfo | null;
    selfPid?: number;
    sessionCwd?: string;
};

export declare function killsForeignProcess(
    calls: readonly { name: string; args: readonly { value: string; literal: boolean }[] }[],
    options?: TKillRuleOptions,
): string | null;

/** Чтение `/proc` (или его подделки в тесте): `null` — процесса нет. */
export declare function readProcessInfo(pid: number, procRoot?: string): TProcessInfo | null;

export declare const PATTERN_KILLERS: Set<string>;
export declare const PORT_KILLERS: Set<string>;

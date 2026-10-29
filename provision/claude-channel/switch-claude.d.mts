export type SwitchClaudeOptions = {
    args?: string[];
    env?: Record<string, string | undefined>;
    home?: string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
};

export function main(options?: SwitchClaudeOptions): number;

/**
 * Типы барьера скиллов для TS-тестов. Сам хук — CommonJS: его грузит Claude Code через
 * `node`, и переписывать его в модуль ради типов значило бы менять то, что работает.
 */
export type TSkillRule = {
    test: (subject: string) => boolean;
    skills: string[];
    why: string;
};

export type TSkillVerdict = {
    blocked: boolean;
    reason?: string;
    /** Код причины блока из перечня контракта (`adapters/barrier-reason.ts`). */
    code?: string;
    loaded?: string[];
};

export type TSkillRules = { files: TSkillRule[]; commands: TSkillRule[] };

export declare const NO_RULES: TSkillRules;

export declare function targetsOf(toolName: string, toolInput: unknown): string[];
export declare function requiredSkills(
    targets: string[],
    command?: string,
    rules?: TSkillRules,
): Map<string, { why: string; target: string }>;
export declare function isLoopSession(env?: Record<string, string | undefined>): boolean;
export declare function loadedSkills(lines: string[]): Set<string>;
export declare function decide(input: {
    toolName: string;
    toolInput: unknown;
    transcriptLines: string[] | null;
    env?: Record<string, string | undefined>;
    cached?: Set<string>;
    rules?: TSkillRules;
}): TSkillVerdict;

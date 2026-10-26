/**
 * Типы барьера скиллов для TS-тестов. Сам хук — CommonJS: его грузит Claude Code через
 * `node`, и переписывать его в модуль ради типов значило бы менять то, что работает.
 */
export type TSkillRule = {
    test: (subject: string) => boolean;
    skills: string[];
    why: string;
};

export type TSkillVerdict = { blocked: boolean; reason?: string; loaded?: string[] };

export declare const RULES: TSkillRule[];
export declare const COMMAND_RULES: TSkillRule[];
export declare const LOOP_PROMPT_RE: RegExp;

export declare function targetsOf(toolName: string, toolInput: unknown): string[];
export declare function requiredSkills(
    targets: string[],
    command?: string,
): Map<string, { why: string; target: string }>;
export declare function firstUserPrompt(lines: string[]): string;
export declare function isLoopTranscript(
    lines: string[],
    env?: Record<string, string | undefined>,
): boolean;
export declare function loadedSkills(lines: string[]): Set<string>;
export declare function decide(input: {
    toolName: string;
    toolInput: unknown;
    transcriptLines: string[] | null;
    env?: Record<string, string | undefined>;
    cached?: Set<string>;
}): TSkillVerdict;

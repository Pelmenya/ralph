/** Типы данных контракта потребителя для TS-тестов; сам модуль — CommonJS, как хуки. */
export type TSkillRow = { test: (subject: string) => boolean; skills: string[]; why: string };

export type TConsumerData = {
    mcp: {
        writeAllowed: Set<string>;
        neverExceptions: Set<string>;
        tools: Map<string, 'read' | 'write'>;
        /** Данные заявили `mcp.tools`: guard судит MCP по эффектам, а не по префиксу имени. */
        toolsDeclared: boolean;
    };
    skills: { files: TSkillRow[]; commands: TSkillRow[] };
};

export declare const DATA_PATH: string;
export declare const DATA_ENV: string;
export declare function emptyData(): TConsumerData;
export declare function parseConsumerData(text: string, file?: string): TConsumerData;
export declare function loadConsumerData(deps?: {
    env?: Record<string, string | undefined>;
    readFileFn?: (file: string, encoding: 'utf-8') => string;
}): TConsumerData;

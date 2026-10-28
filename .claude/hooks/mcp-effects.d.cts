/** Типы мигратора эффектов MCP для TS-тестов; сам модуль — CommonJS, как хуки. */
import type { TConsumerData } from './consumer-data.cjs';

export declare function migrateMcpEffects(
    text: string,
    inventory: readonly string[],
    file?: string,
): { text: string; changed: boolean };

export declare function decisionDrift(
    before: TConsumerData['mcp'],
    after: TConsumerData['mcp'],
    names: readonly string[],
): string[];

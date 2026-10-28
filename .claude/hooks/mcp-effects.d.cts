/** Типы мигратора эффектов MCP для TS-тестов и ядра; сам модуль — CommonJS, как хуки. */
import type { TConsumerData } from './consumer-data.cjs';

export declare function migrateMcpEffects(
    text: string,
    inventory: readonly string[],
    file?: string,
): { text: string; changed: boolean; stale: string[]; unlisted: string[] };

export declare function decisionDrift(
    before: TConsumerData['mcp'],
    after: TConsumerData['mcp'],
    names: readonly string[],
): string[];

export declare function equivalenceProblems(
    before: TConsumerData['mcp'],
    after: TConsumerData['mcp'],
    names: readonly string[],
): string[];

export declare function toolsFreshness(
    mcp: TConsumerData['mcp'],
    inventory: readonly string[],
): { stale: string[]; unlisted: string[] };

export declare function checkInventory(file: string, inventory: readonly string[]): void;

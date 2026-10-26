/**
 * Типы барьера служб хоста для TS-тестов. Сам модуль — CommonJS: его грузит хук через
 * `require` до `npm ci`, и типы живут рядом, а не в нём.
 */
export declare function touchesHostService(calls: unknown[]): string | null;

export declare const CADDY_UNSAFE_SUBCOMMANDS: ReadonlySet<string>;
export declare const HOST_UNIT_ACTIONS: ReadonlySet<string>;
export declare const DOCKER_UNSAFE_SUBCOMMANDS: ReadonlySet<string>;

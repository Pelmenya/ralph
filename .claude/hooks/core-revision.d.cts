/** Типы контракта запуска для TS-тестов; сам модуль — CommonJS, как хуки. */
export type TRevisionVerdict = { loop: boolean; error: string | null };

export declare const CORE_SHA_ENV: string;
export declare const SHA_RE: RegExp;
export declare function expectedSha(env?: Record<string, string | undefined>): string;
export declare function blobHash(content: Buffer | string, sha: string): string;
export declare function lsTree(dir: string, sha: string): Map<string, string>;
export declare function parseLsTree(out: string): Map<string, string>;
export declare function describeError(error: unknown): string;
export declare function checkCoreRevision(deps?: {
    env?: Record<string, string | undefined>;
    hooksDir?: string;
    lsTreeFn?: (dir: string, sha: string) => Map<string, string>;
    readFileFn?: (file: string) => Buffer | string;
    readdirFn?: (dir: string) => string[];
    realpathFn?: (p: string) => string;
}): TRevisionVerdict;

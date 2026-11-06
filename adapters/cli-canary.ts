// Команды ежедневной канарейки CLI (#264): реестр пакетов и изолированный стенд.
// Ядро работает с версиями и отчётами, а npm и путь исполнителя стенда остаются на шве адаптера.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import type { HarnessDistribution } from './harness-package.ts';
import { LOOP_KEY_ENVS } from './live-probe-cases.ts';

export type CliCanaryExec = (
    file: string,
    args: string[],
    options: { timeoutMs: number; killAfterMs?: number; env?: NodeJS.ProcessEnv },
) => string;

export class CliCanaryInfrastructureError extends Error {
    readonly kind: 'isolation' | 'spawn' | 'output-limit' | 'timeout';

    constructor(kind: 'isolation' | 'spawn' | 'output-limit' | 'timeout', reason: string) {
        super(reason);
        this.name = 'CliCanaryInfrastructureError';
        this.kind = kind;
    }
}

const HINT = 'Подмени execFn и файловые коллабораторы канарейки CLI в тесте.';
/* v8 ignore next 2 */
const guarded = (what: string) => guardSideEffect(what, HINT);
const KILL_AFTER_S = 30;

// Боевой процесс проверен дочерним сценарием дедлайна; его V8-карта не сливается с Vitest.
/* v8 ignore next 12 */
export const defaultCliCanaryExec: CliCanaryExec = (file, args, options) => {
    guarded(`shArgv(${file} ${args.join(' ')})`);
    return execFileSync(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeoutMs + (options.killAfterMs ?? 0),
        killSignal: 'SIGKILL',
        env: options.env,
    });
};

export function fetchLatestCliVersion({
    distribution,
    timeoutMs,
    execFn = defaultCliCanaryExec,
}: {
    distribution: HarnessDistribution;
    timeoutMs: number;
    execFn?: CliCanaryExec;
}): string {
    const version = execFn('npm', ['view', distribution.package, 'version'], { timeoutMs }).trim();
    if (version === '' || /\s/.test(version)) {
        throw new Error(`реестр пакета ${distribution.package} вернул не одну версию`);
    }
    return version;
}

const secretName =
    /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|TOKEN|SECRET(?:_KEY)?|PRIVATE_KEY|PASSWORD|CREDENTIALS)$/i;

function standEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const allowed = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']);
    const forbidden = new Set(LOOP_KEY_ENVS);
    return Object.fromEntries(
        Object.entries(env).filter(([name, value]) => {
            if (value === undefined) return false;
            if (allowed.has(name)) return true;
            if (!name.startsWith('STAND_')) return false;
            return (
                !forbidden.has(name) &&
                !forbidden.has(name.slice('STAND_'.length)) &&
                !secretName.test(name)
            );
        }),
    );
}

export function runStandReport({
    coreRoot,
    harness,
    version,
    cliBin,
    timeoutMs,
    env = process.env,
    execFn = defaultCliCanaryExec,
    /* v8 ignore start */
    mkdtempFn = (prefix) => {
        guarded(`mkdtemp(${prefix})`);
        return mkdtempSync(prefix);
    },
    readFileFn = (file) => readFileSync(file, 'utf8'),
    rmFn = (dir) => {
        guarded(`rm(${dir})`);
        rmSync(dir, { recursive: true, force: true });
    },
    /* v8 ignore stop */
}: {
    coreRoot: string;
    harness: string;
    version: string;
    cliBin: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    execFn?: CliCanaryExec;
    mkdtempFn?: (prefix: string) => string;
    readFileFn?: (file: string) => string;
    rmFn?: (dir: string) => void;
}): unknown {
    const dir = mkdtempFn(path.join(tmpdir(), 'ralph-cli-canary.'));
    const report = path.join(dir, 'report.json');
    const readReport = (): unknown => {
        const parsed = JSON.parse(readFileFn(report)) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const infrastructure = (parsed as Record<string, unknown>).infrastructure;
            if (typeof infrastructure === 'object' && infrastructure !== null) {
                const value = infrastructure as Record<string, unknown>;
                const kind = value.kind;
                if (
                    (kind === 'isolation' ||
                        kind === 'spawn' ||
                        kind === 'output-limit' ||
                        kind === 'timeout') &&
                    typeof value.reason === 'string'
                ) {
                    throw new CliCanaryInfrastructureError(kind, value.reason);
                }
            }
        }
        return parsed;
    };
    const args = [
        path.join(coreRoot, 'provision', 'stand', 'stand.mts'),
        'report',
        '--harness',
        harness,
        '--version',
        version,
        '--cli-bin',
        cliBin,
        '--report',
        report,
    ];
    try {
        try {
            execFn(
                'timeout',
                [
                    `--kill-after=${String(KILL_AFTER_S)}s`,
                    `${String(Math.max(1, Math.ceil(timeoutMs / 1000)))}s`,
                    process.execPath,
                    ...args,
                ],
                {
                    timeoutMs,
                    killAfterMs: (KILL_AFTER_S + 30) * 1000,
                    env: standEnv(env),
                },
            );
        } catch (error) {
            const failure = error as {
                code?: string;
                status?: number;
                signal?: string;
                message?: string;
            };
            const timedOut =
                failure.code === 'ETIMEDOUT' ||
                failure.status === 124 ||
                failure.status === 137 ||
                failure.signal !== undefined;
            if (timedOut) {
                throw new CliCanaryInfrastructureError('timeout', failure.message ?? String(error));
            }
            try {
                return readReport();
            } catch (reportError) {
                if (reportError instanceof CliCanaryInfrastructureError) throw reportError;
                throw new CliCanaryInfrastructureError('spawn', failure.message ?? String(error));
            }
        }
        return readReport();
    } finally {
        rmFn(dir);
    }
}

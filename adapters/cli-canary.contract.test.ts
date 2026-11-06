import { describe, expect, it, vi } from 'vitest';
import { reportEnvProblems } from '../provision/stand/report.mts';
import { LOOP_KEY_ENVS } from './live-probe-cases.ts';
import { runStandReport, type CliCanaryExec } from './cli-canary.ts';

const report = {
    protocol: 1,
    harness: 'codex',
    version: '2.0.0',
    inventory: { tools: [] },
    probes: [{ name: 'block', verdict: 'PASS', detail: 'ok' }],
};

const runnerEnv: NodeJS.ProcessEnv = {
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_ACCESS_KEY_ID: 'aws-id',
    DATABASE_URL: 'postgres://example.com/db',
    OPENAI_KEY: 'openai-key',
    FOO: 'unknown',
    SIGNING_MATERIAL: 'signing',
    STAND_API_KEY: 'stand-secret',
    [`STAND_${LOOP_KEY_ENVS[0]}`]: 'loop-secret',
    UNDEFINED_VALUE: undefined,
    PATH: '/bin',
    HOME: '/home/test',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp',
    STAND_PROBE: 'inventory',
};

function run(env: NodeJS.ProcessEnv) {
    const execFn = vi.fn<CliCanaryExec>(() => '');
    const rmFn = vi.fn();
    const result = runStandReport({
        coreRoot: '/path/to/core',
        harness: 'codex',
        version: '2.0.0',
        cliBin: '/state/cli-canary/codex/2.0.0/bin/cli.js',
        timeoutMs: 9_876,
        env,
        execFn,
        mkdtempFn: () => '/tmp/stand-report',
        readFileFn: () => JSON.stringify(report),
        rmFn,
    });
    return { result, execFn, rmFn };
}

describe('окружение отчёта стенда', () => {
    it('[F24-5] отчёт получает только allowlist окружения', () => {
        const { result, execFn, rmFn } = run(runnerEnv);
        expect(result).toEqual(report);
        expect(execFn).toHaveBeenCalledTimes(1);
        expect(execFn.mock.calls[0][2].env).toEqual({
            PATH: '/bin',
            HOME: '/home/test',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            TMPDIR: '/tmp',
            STAND_PROBE: 'inventory',
        });
        expect(rmFn).toHaveBeenCalledWith('/tmp/stand-report');
    });

    it('[F24-5] allowlist отчёта проходит проверку reportEnvProblems', () => {
        const { execFn } = run(runnerEnv);
        expect(execFn).toHaveBeenCalledTimes(1);
        expect(reportEnvProblems(execFn.mock.calls[0][2].env ?? {}, [])).toEqual([]);
    });
});

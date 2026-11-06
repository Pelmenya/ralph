import { execFileSync, spawnSync } from 'node:child_process';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStandReport } from '../adapters/cli-canary.ts';
import { harnessDescriptorPath, standFixturePath } from '../adapters/harness-registry.ts';
import type { HarnessRegistry } from '../adapters/harness-registry.ts';
import type { NewPullRequest, PullRequest } from '../adapters/adapters.ts';
import { runCliCanary } from '../core/cli-canary.ts';
import type { CliCanaryOutcome } from '../core/cli-canary.ts';
import { handleCliCanaryOutcomes } from '../core/cli-canary-actions.ts';
import type { RalphState } from '../core/state-lock.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const HARNESS = 'kimi-code';
const PINNED = '1.0.0';
const CANDIDATE = '2.0.0';
const temporaryDirs: string[] = [];

afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function probeIsolation() {
    const base = mkdtempSync(path.join(tmpdir(), 'ralph-cli-canary-probe-'));
    try {
        const result = spawnSync(
            process.execPath,
            [
                path.join(REPO, 'provision', 'stand', 'stand.mts'),
                'exec',
                '--stand',
                path.join(base, 'stand'),
                '--cli',
                'claude',
                '--',
                '/bin/true',
            ],
            {
                encoding: 'utf8',
                timeout: 30_000,
                env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base, TMPDIR: tmpdir() },
            },
        );
        const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
        return {
            ok: result.status === 0 && !result.error,
            reason:
                result.error?.message ??
                (result.status === 0 ? '' : `stand.mts exec true: код ${result.status}: ${detail}`),
        };
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
}

const isolation = probeIsolation();
const skipSuffix = isolation.ok ? '' : ` (пропуск: ${isolation.reason})`;
const scenarioName = `два изолированных отчёта → зелёный PR с валидным fixture → рестарт без потери и дубля${skipSuffix}`;

function state(): RalphState {
    return {
        schemaVersion: 2,
        count: 0,
        milestone: 'M1',
        submitted: false,
        noProgress: 0,
        gateHeals: 0,
        blockedHeals: 0,
        reviewModelFloor: null,
        lastReviewModel: null,
        reReviewPending: false,
        reviewOfFixes: null,
        deployBlock: null,
        forgeHealedRunId: null,
    };
}

describe('сквозной сценарий канарейки CLI', () => {
    it.skipIf(!isolation.ok)(
        scenarioName,
        () => {
            const root = mkdtempSync(path.join(tmpdir(), 'ralph-cli-canary-e2e-'));
            temporaryDirs.push(root);
            const home = path.join(root, 'home');
            mkdirSync(home, { recursive: true });
            const env = {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: home,
                LANG: 'C.UTF-8',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_SYSTEM: '/dev/null',
                GIT_AUTHOR_NAME: 'Ralph Test',
                GIT_AUTHOR_EMAIL: 'ralph@example.com',
                GIT_COMMITTER_NAME: 'Ralph Test',
                GIT_COMMITTER_EMAIL: 'ralph@example.com',
            };
            const run = (
                file: string,
                args: string[],
                opts?: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
            ) =>
                execFileSync(file, args, {
                    encoding: 'utf8',
                    input: opts?.input,
                    env: opts?.env ?? env,
                    timeout: opts?.timeoutMs,
                    maxBuffer: 16 * 1024 * 1024,
                }).trim();
            const git = (cwd: string, args: string[]) => run('git', ['-C', cwd, ...args]);

            const fixtureSource = readFileSync(
                path.join(REPO, 'tests', '__fixtures__', 'cli-canary-kimi.mjs'),
                'utf8',
            );
            const binFor = (version: string): string => {
                const copy = path.join(root, 'copies', version);
                const bin = path.join(copy, 'bin', 'kimi.mjs');
                mkdirSync(path.dirname(bin), { recursive: true });
                writeFileSync(bin, fixtureSource.replace('__CLI_VERSION__', version), {
                    mode: 0o755,
                });
                writeFileSync(path.join(copy, '.ralph-manifest'), '');
                return bin;
            };
            const pinnedBin = binFor(PINNED);
            const candidateBin = binFor(CANDIDATE);
            const distribution = {
                registry: 'npm' as const,
                package: 'example-cli',
                bin: 'bin/kimi.mjs',
            };
            const registry = {
                packages: new Map([
                    [HARNESS, { descriptor: { cliVersion: PINNED }, pkg: { distribution } }],
                ]),
                problems: new Map(),
            } as unknown as HarnessRegistry;

            const remote = path.join(root, 'remote.git');
            const main = path.join(root, 'main');
            mkdirSync(main, { recursive: true });
            git(root, ['init', '--quiet', '--bare', remote]);
            git(root, ['init', '--quiet', '-b', 'main', main]);
            const descriptorPath = harnessDescriptorPath(HARNESS);
            const oldFixturePath = standFixturePath(HARNESS, PINNED);
            const newFixturePath = standFixturePath(HARNESS, CANDIDATE);
            const descriptor = JSON.parse(
                readFileSync(path.join(REPO, descriptorPath), 'utf8'),
            ) as Record<string, unknown>;
            descriptor.cliVersion = PINNED;
            const baseline = JSON.parse(
                readFileSync(
                    path.join(REPO, standFixturePath(HARNESS, '2.3.2')),
                    'utf8',
                ).replaceAll('2.3.2', PINNED),
            ) as Record<string, unknown>;
            baseline.events = [
                ...(baseline.events as unknown[]),
                { id: 'pinned-only', cliVersion: PINNED },
            ];
            mkdirSync(path.join(main, path.dirname(descriptorPath)), { recursive: true });
            mkdirSync(path.join(main, path.dirname(oldFixturePath)), { recursive: true });
            writeFileSync(
                path.join(main, descriptorPath),
                JSON.stringify(descriptor, null, 4) + '\n',
            );
            writeFileSync(
                path.join(main, oldFixturePath),
                JSON.stringify(baseline, null, 4) + '\n',
            );
            git(main, ['add', '.']);
            git(main, ['commit', '--quiet', '-m', 'chore: начальное состояние']);
            git(main, ['remote', 'add', 'origin', remote]);
            git(main, ['push', '--quiet', '-u', 'origin', 'main']);

            const stateFile = path.join(root, 'state.json');
            const saveStateFn = (value: RalphState) =>
                writeFileSync(stateFile, JSON.stringify(value, null, 2));
            const pullRequests: NewPullRequest[] = [];
            const logs: string[] = [];
            const publish = (outcomes: readonly CliCanaryOutcome[], current: RalphState) =>
                handleCliCanaryOutcomes({
                    outcomes,
                    state: current,
                    consumerRoot: main,
                    canaryRoot: path.join(root, 'actions'),
                    saveStateFn,
                    logFn: (line) => logs.push(line),
                    createIssueFn: () => {
                        throw new Error('зелёному исходу карточка не нужна');
                    },
                    createPullRequestFn: (input) => {
                        pullRequests.push(input);
                        return 101;
                    },
                    findOpenIssueFn: () => null,
                    findOpenPullRequestFn: (branch) =>
                        pullRequests.some((pr) => pr.branch === branch)
                            ? ({ number: 101 } as PullRequest)
                            : null,
                    backlogAddressFn: () => undefined,
                    labels: [],
                    runArgvFn: run,
                    descriptorPathFn: harnessDescriptorPath,
                    standFixturePathFn: standFixturePath,
                    mkdtempFn: (prefix) => {
                        mkdirSync(path.dirname(prefix), { recursive: true });
                        return mkdtempSync(prefix);
                    },
                    readFileFn: (file) => readFileSync(file, 'utf8'),
                    writeFileFn: (file, text) => {
                        mkdirSync(path.dirname(file), { recursive: true });
                        writeFileSync(file, text);
                    },
                    removeDirFn: (dir) => rmSync(dir, { recursive: true, force: true }),
                    env,
                });

            let reportCount = 0;
            const reportFn = (input: { harness: string; version: string; cliBin: string }) => {
                reportCount++;
                return runStandReport({
                    ...input,
                    coreRoot: REPO,
                    timeoutMs: 120_000,
                    env,
                    execFn: (file, args, opts) =>
                        execFileSync(file, args, {
                            encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'pipe'],
                            maxBuffer: 16 * 1024 * 1024,
                            timeout: opts.timeoutMs + (opts.killAfterMs ?? 0),
                            killSignal: 'SIGKILL',
                            env: opts.env,
                        }),
                    mkdtempFn: (prefix) => mkdtempSync(prefix),
                    rmFn: (dir) => rmSync(dir, { recursive: true, force: true }),
                });
            };
            const canaryInput = {
                canaryRoot: path.join(root, 'canary'),
                pinnedBins: new Map([[HARNESS, pinnedBin]]),
                registry,
                saveStateFn,
                logFn: (line: string) => logs.push(line),
                latestVersionFn: () => CANDIDATE,
                installFn: () => ({ ok: true as const, bin: candidateBin }),
                reportFn,
            };

            expect(() =>
                runCliCanary({
                    ...canaryInput,
                    state: state(),
                    nowFn: () => 1_000,
                    handleOutcomesFn: () => {
                        throw new Error('рестарт между сохранением и публикацией');
                    },
                }),
            ).toThrow(/рестарт между сохранением и публикацией/);
            expect(reportCount).toBe(2);
            expect(pullRequests).toHaveLength(0);

            const restarted = JSON.parse(readFileSync(stateFile, 'utf8')) as RalphState;
            const resumed = runCliCanary({
                ...canaryInput,
                state: restarted,
                nowFn: () => 1_001,
                handleOutcomesFn: (outcomes) => publish(outcomes, restarted),
            });
            expect(resumed.ran).toBe(false);
            expect(resumed.outcomes[0]?.verdict).toBe('green');
            expect(reportCount).toBe(2);
            expect(pullRequests).toHaveLength(1);
            expect(pullRequests[0]?.branch).toBe(`cli/${HARNESS}-${CANDIDATE}`);
            expect(restarted.cliCanaryHandledOutcomes).toEqual({
                [`${HARNESS}@${CANDIDATE}:green`]: true,
            });

            const repeated = JSON.parse(readFileSync(stateFile, 'utf8')) as RalphState;
            runCliCanary({
                ...canaryInput,
                state: repeated,
                nowFn: () => 1_002,
                handleOutcomesFn: (outcomes) => publish(outcomes, repeated),
            });
            expect(reportCount).toBe(2);
            expect(pullRequests).toHaveLength(1);
            expect(logs.filter((line) => line.includes('не опубликован'))).toEqual([]);
            expect(git(main, ['status', '--porcelain'])).toBe('');
            expect(git(main, ['branch', '--show-current'])).toBe('main');

            const branch = `cli/${HARNESS}-${CANDIDATE}`;
            const show = (file: string) =>
                run('git', ['--git-dir', remote, 'show', `${branch}:${file}`]);
            expect(JSON.parse(show(descriptorPath))).toMatchObject({ cliVersion: CANDIDATE });
            expect(show(oldFixturePath)).toContain('pinned-only');
            const generatedFixture = show(newFixturePath);
            expect(JSON.parse(generatedFixture)).toMatchObject({
                protocol: 1,
                harness: HARNESS,
                version: CANDIDATE,
                cliVersion: CANDIDATE,
                assembled: false,
            });
            expect(generatedFixture).not.toContain('pinned-only');

            const verification = path.join(root, 'verification');
            cpSync(path.join(REPO, 'adapters'), path.join(verification, 'adapters'), {
                recursive: true,
            });
            for (const directory of ['provision', 'shared']) {
                cpSync(path.join(REPO, directory), path.join(verification, directory), {
                    recursive: true,
                });
            }
            cpSync(
                path.join(REPO, 'vitest.config.ts'),
                path.join(verification, 'vitest.config.ts'),
            );
            symlinkSync(
                path.join(REPO, 'node_modules'),
                path.join(verification, 'node_modules'),
                'dir',
            );
            mkdirSync(path.join(verification, 'tests'), { recursive: true });
            for (const file of [
                'test-setup.ts',
                'forge-exec-guard.ts',
                'cli-canary-report-contract.test.ts',
            ]) {
                cpSync(path.join(REPO, 'tests', file), path.join(verification, 'tests', file));
            }
            writeFileSync(path.join(verification, descriptorPath), show(descriptorPath) + '\n');
            writeFileSync(path.join(verification, newFixturePath), generatedFixture + '\n');
            const verify = (args: string[]) =>
                execFileSync(
                    process.execPath,
                    [
                        path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs'),
                        '--root',
                        verification,
                        'run',
                        ...args,
                    ],
                    { cwd: verification, encoding: 'utf8', env: process.env, timeout: 20_000 },
                );
            expect(() => {
                verify(['--dir', 'tests']);
                verify([path.join('adapters', 'harnesses', HARNESS, 'stand-fixtures.test.ts')]);
            }).not.toThrow();
        },
        120_000,
    );
});

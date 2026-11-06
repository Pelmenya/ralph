import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessRegistry } from '../adapters/harness-registry.ts';
import { REPORT_MATRIX_PROBES } from '../provision/stand/report.mts';
import {
    CLI_CANARY_INTERVAL_MS,
    mergeCanaryOutcomes,
    runCliCanary,
    type CliCanaryReport,
} from './cli-canary.ts';
import type { pruneCanaryCopies, sweepCanaryTrash } from './cli-copies.ts';
import { createStateLock, inspectState, stateRefusal } from './state-lock.ts';
import type { CliCanaryStoredOutcome, CliCanaryVerdict, RalphState } from './state-lock.ts';
import { stateToDisk } from './submit-journal.ts';

const distribution = { registry: 'npm' as const, package: 'example-cli', bin: 'bin/cli.js' };

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

function registry(versions: Record<string, string>): HarnessRegistry {
    return {
        packages: new Map(
            Object.entries(versions).map(([harness, cliVersion]) => [
                harness,
                { descriptor: { cliVersion }, pkg: { distribution } },
            ]),
        ),
        problems: new Map(),
    } as unknown as HarnessRegistry;
}

function report(harness: string, version: string): CliCanaryReport {
    const cli = harness === 'claude-code' ? 'claude' : harness === 'kimi-code' ? 'kimi' : harness;
    const names = ['version', 'inventory', ...(REPORT_MATRIX_PROBES[cli] ?? []), 'stand'];
    return {
        protocol: 1,
        harness,
        version,
        inventory: { tools: ['Bash'] },
        probes: names.map((name) => ({ name, verdict: 'PASS', detail: 'ok' })),
    };
}

function input(
    currentState = state(),
    versions: Record<string, string> = { 'claude-code': '1.0.0' },
) {
    return {
        state: currentState,
        canaryRoot: '/state/cli-canary',
        pinnedBins: new Map([['claude-code', '/state/cli/claude-code/1.0.0/bin/cli.js']]),
        registry: registry(versions),
        saveStateFn: vi.fn(),
        logFn: vi.fn(),
        nowFn: () => 1000,
        latestVersionFn: vi.fn(() => '2.0.0'),
        installFn: vi.fn(() => ({
            ok: true as const,
            bin: '/state/cli-canary/claude-code/2.0.0/bin/cli.js',
        })),
        reportFn: vi.fn(({ harness, version }: { harness: string; version: string }) =>
            report(harness, version),
        ),
    };
}

function outcome(
    verdict: CliCanaryVerdict,
    latestVersion = '2.0.0',
    harness = 'claude-code',
    pinnedVersion = '1.0.0',
): CliCanaryStoredOutcome {
    return { harness, pinnedVersion, latestVersion, verdict };
}

describe('версия кандидата канарейки', () => {
    it.each([
        { pinned: '2.0.0', latest: '1.0.0', reason: /не новее|старше/i },
        { pinned: '2.0.0', latest: 'latest', reason: /SemVer/i },
        { pinned: 'invalid', latest: '1.0.0', reason: /SemVer/i },
        { pinned: 'invalid', latest: 'invalid', reason: /SemVer/i },
    ])(
        '[F24-2] закреплена $pinned, реестр $latest — unchecked без установки',
        ({ pinned, latest, reason }) => {
            const args = {
                ...input(state(), { 'claude-code': pinned }),
                latestVersionFn: vi.fn(() => latest),
            };
            const result = runCliCanary(args);
            expect(result.outcomes[0]).toMatchObject({ verdict: 'unchecked', reason });
            expect(args.installFn).not.toHaveBeenCalled();
        },
    );

    it('[F24-2] build-метаданные не запускают установку уже закреплённой версии', () => {
        const args = {
            ...input(state(), { 'claude-code': '1.0.0+old' }),
            latestVersionFn: vi.fn(() => '1.0.0+new'),
        };
        expect(runCliCanary(args).outcomes[0]?.verdict).toBe('fresh');
        expect(args.installFn).not.toHaveBeenCalled();
        expect(args.reportFn).not.toHaveBeenCalled();
    });

    it.each([
        { timing: 'при рестарте раньше суток', elapsed: CLI_CANARY_INTERVAL_MS - 1 },
        { timing: 'при суточном запуске', elapsed: CLI_CANARY_INTERVAL_MS },
    ])('[F24-2] green для уже закреплённой версии $timing не публикуется', ({ elapsed }) => {
        const current = state();
        const key = 'claude-code@2.0.0';
        current.cliCanaryLastRunAt = 1000;
        current.cliCanaryOutcomes = { [key]: outcome('green') };
        const events: string[] = [];
        const savedVerdicts: string[] = [];
        const args = {
            ...input(current, { 'claude-code': '2.0.0' }),
            nowFn: () => 1000 + elapsed,
            saveStateFn: vi.fn(() => {
                events.push('save');
                savedVerdicts.push(current.cliCanaryOutcomes?.[key]?.verdict ?? 'missing');
            }),
            handleOutcomesFn: vi.fn((_outcomes: readonly CliCanaryStoredOutcome[]) => {
                events.push('handle');
                expect(savedVerdicts[0]).toBe('unchecked');
            }),
        };
        runCliCanary(args);
        const handled = args.handleOutcomesFn.mock.calls.flatMap(([outcomes]) => outcomes);
        expect(events[0]).toBe('save');
        expect(savedVerdicts[0]).toBe('unchecked');
        expect(handled).not.toContainEqual(expect.objectContaining({ verdict: 'green' }));
    });

    it.each([
        {
            name: 'более старая версия реестра',
            harness: 'claude-code',
            latest: '1.0.0',
            versions: { 'claude-code': '2.0.0' },
            reason: /старше/i,
        },
        {
            name: 'невалидная версия descriptor',
            harness: 'claude-code',
            latest: '2.0.0',
            versions: { 'claude-code': 'invalid' },
            reason: /SemVer/i,
        },
        {
            name: 'пакет не принят в реестр',
            harness: 'unknown',
            latest: '2.0.0',
            versions: { 'claude-code': '1.0.0' },
            reason: /не принят/i,
        },
    ])('[F24-2] сохранённый green отклонён: $name', ({ harness, latest, versions, reason }) => {
        const current = state();
        const key = `${harness}@${latest}`;
        current.cliCanaryLastRunAt = 1000;
        current.cliCanaryOutcomes = { [key]: outcome('green', latest, harness) };
        const args = { ...input(current, versions), handleOutcomesFn: vi.fn() };
        runCliCanary(args);
        expect(current.cliCanaryOutcomes[key]).toMatchObject({ verdict: 'unchecked', reason });
        expect(args.saveStateFn).toHaveBeenCalledOnce();
        expect(args.handleOutcomesFn).not.toHaveBeenCalled();
    });
});

const mergeCases = (['green', 'drift', 'red'] as const).flatMap((left) =>
    (['unchecked', 'green', 'drift', 'red', 'fresh'] as const).map((right) => ({
        left,
        right,
        expected:
            right === 'unchecked' || (right === 'fresh' && left !== 'green')
                ? { 'claude-code@2.0.0': outcome(left) }
                : right === 'fresh'
                  ? {}
                  : { 'claude-code@2.0.0': outcome(right) },
    })),
);

describe('сохранность неопубликованных исходов', () => {
    it.each(mergeCases)(
        '[F24-3] pending $left + formed $right сохраняет правильный исход',
        ({ left, right, expected }) => {
            expect(
                mergeCanaryOutcomes(
                    { 'claude-code@2.0.0': outcome(left) },
                    { 'claude-code@2.0.0': outcome(right) },
                ),
            ).toEqual(expected);
        },
    );

    it('[F24-3] ключ без новой пары остаётся', () => {
        const pending = { 'claude-code@2.0.0': outcome('green') };
        expect(mergeCanaryOutcomes(pending, {})).toEqual(pending);
    });

    it('[F24-3] новый ключ добавляется', () => {
        const formed = { 'claude-code@2.0.0': outcome('red') };
        expect(mergeCanaryOutcomes({}, formed)).toEqual(formed);
    });

    it('[F24-3] unchecked через runCliCanary не затирает pending перед повторной публикацией', () => {
        const versions = { 'claude-code': '1.0.0', codex: '1.0.0' };
        const first = {
            ...input(state(), versions),
            reportFn: vi.fn(({ harness, version }: { harness: string; version: string }) => {
                const value = report(harness, version);
                if (harness === 'codex' && version === '2.0.0') {
                    value.probes[0] = { ...value.probes[0], verdict: 'FAIL', detail: 'broken' };
                }
                return value;
            }),
            handleOutcomesFn: vi.fn(() => {
                throw new Error('restart after save');
            }),
        };
        expect(() => runCliCanary(first)).toThrow('restart after save');
        expect(first.state.cliCanaryOutcomes).toMatchObject({
            'claude-code@2.0.0': { verdict: 'green' },
            'codex@2.0.0': { verdict: 'red' },
        });

        const restartedState = JSON.parse(JSON.stringify(first.state)) as RalphState;
        const second = {
            ...input(restartedState, versions),
            nowFn: () => 1000 + CLI_CANARY_INTERVAL_MS,
            latestVersionFn: vi.fn(() => '2.0.0'),
            installFn: vi.fn(({ harness, version }: { harness: string; version: string }) => ({
                ok: false as const,
                code: 'install-failed' as const,
                harness,
                version,
                reason: 'candidate missing',
            })),
            handleOutcomesFn: vi.fn(),
        };
        runCliCanary(second);
        expect(second.state.cliCanaryOutcomes).toMatchObject({
            'claude-code@2.0.0': { verdict: 'green' },
            'codex@2.0.0': { verdict: 'red' },
        });

        const third = {
            ...input(restartedState, versions),
            nowFn: () => 1000 + 2 * CLI_CANARY_INTERVAL_MS - 1,
            handleOutcomesFn: vi.fn(),
        };
        runCliCanary(third);
        expect(third.handleOutcomesFn).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ harness: 'claude-code', verdict: 'green' }),
                expect.objectContaining({ harness: 'codex', verdict: 'red' }),
            ]),
        );
    });

    it.each([
        { name: 'pending не объект', patch: { cliCanaryOutcomes: { 'claude-code@2.0.0': null } } },
        { name: 'флаг сдачи полем v2', patch: { submitted: false } },
        { name: 'арбитр полем v2', patch: { reviewOfFixes: { arbitrated: true } } },
        {
            name: 'битый mergeInFlight',
            patch: { mergeInFlight: { milestone: 'M1', pr: 1 } },
        },
        { name: 'журнал сдачи отсутствует', patch: { submitStages: undefined } },
    ])('[F24-3] повреждённый state рестарта отклонён: $name', ({ patch }) => {
        const raw = { ...stateToDisk(state()), ...patch };
        expect(inspectState(JSON.stringify(raw)).status).toBe('corrupt');
    });

    it('[F24-3] копия битого pending не перезаписывается перед сбросом', () => {
        const dir = mkdtempSync(join(tmpdir(), 'f24-state.'));
        const statePath = join(dir, 'ralph.state.json');
        const stamp = '2026-11-05T00-00-00-000Z';
        const kept = `${statePath}.corrupt-${stamp}`;
        try {
            const raw = {
                ...stateToDisk(state()),
                cliCanaryOutcomes: { 'claude-code@2.0.0': null },
            };
            writeFileSync(statePath, JSON.stringify(raw));
            writeFileSync(kept, 'previous evidence');
            const env = {
                statePath,
                lockPath: join(dir, 'ralph.lock'),
                lockMarkerPath: join(dir, '.deps-lock.sha'),
                ralphPaths: [],
                dry: false,
                getConfig: () => ({ phases: [{ milestone: 'M1' }] }),
                log: () => {},
                fail: () => {},
                guardSideEffect: () => {},
                now: () => new Date('2026-11-05T00:00:00.000Z'),
                processAlive: () => false,
                cmdlineIncludes: () => false,
                buildSanitizedGateEnv: () => ({}),
            };
            const withDefaultClock = createStateLock({
                ...env,
                now: undefined,
                copyFile: () => {
                    throw new Error('copy refused');
                },
            });
            expect(() => withDefaultClock.resetState({ deployResolved: false })).toThrow(
                'copy refused',
            );
            const writeMarker = vi.fn();
            withDefaultClock.writeLockMarker(dir, {
                readFn: () => {
                    throw new Error('no lock');
                },
                writeFn: writeMarker,
            });
            expect(writeMarker).not.toHaveBeenCalled();
            const { resetState } = createStateLock(env);
            expect(() => resetState({ deployResolved: false })).toThrow();
            expect(readFileSync(statePath, 'utf8')).toBe(JSON.stringify(raw));
            expect(readFileSync(kept, 'utf8')).toBe('previous evidence');
            const inspected = inspectState(JSON.stringify(stateToDisk(state())));
            expect(inspected.status).toBe('ok');
            if (inspected.status === 'ok') {
                expect(() => stateRefusal(statePath, inspected)).toThrow(/не отказ/);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('очистка подключена к жизненному циклу канарейки', () => {
    it('[F24-4] полный прогон зовёт sweep и prune', () => {
        const sweepCanaryTrashFn = vi.fn<typeof sweepCanaryTrash>();
        const pruneCanaryCopiesFn = vi.fn<typeof pruneCanaryCopies>();
        const args = { ...input(), sweepCanaryTrashFn, pruneCanaryCopiesFn };
        runCliCanary(args);
        expect(sweepCanaryTrashFn).toHaveBeenCalledWith(
            expect.objectContaining({ root: '/state/cli-canary' }),
        );
        expect(pruneCanaryCopiesFn).toHaveBeenCalledWith(
            expect.objectContaining({ root: '/state/cli-canary', harness: 'claude-code' }),
        );
    });

    it('[F24-4] ранний выход ran:false тоже зовёт sweep и prune', () => {
        const current = state();
        current.cliCanaryLastRunAt = 1000;
        const sweepCanaryTrashFn = vi.fn<typeof sweepCanaryTrash>();
        const pruneCanaryCopiesFn = vi.fn<typeof pruneCanaryCopies>();
        const args = {
            ...input(current),
            nowFn: () => 1001,
            sweepCanaryTrashFn,
            pruneCanaryCopiesFn,
        };
        expect(runCliCanary(args).ran).toBe(false);
        expect(sweepCanaryTrashFn).toHaveBeenCalledTimes(1);
        expect(pruneCanaryCopiesFn).toHaveBeenCalledTimes(1);
    });

    it('[F24-4] keep посчитан после публикации исхода', () => {
        const current = state();
        const pruneCanaryCopiesFn = vi.fn<typeof pruneCanaryCopies>();
        const args = {
            ...input(current),
            handleOutcomesFn: vi.fn(() => {
                current.cliCanaryHandledOutcomes = { 'claude-code@2.0.0:green': true };
            }),
            sweepCanaryTrashFn: vi.fn<typeof sweepCanaryTrash>(),
            pruneCanaryCopiesFn,
        };
        runCliCanary(args);
        expect(pruneCanaryCopiesFn).toHaveBeenCalledWith(
            expect.objectContaining({ keep: new Set(['1.0.0']) }),
        );
    });

    it('[F24-4] после обрыва опубликованная версия вне keep, неопубликованная в нём', () => {
        const versions = { 'claude-code': '1.0.0', codex: '1.0.0' };
        const firstState = state();
        const first = {
            ...input(firstState, versions),
            handleOutcomesFn: vi.fn(() => {
                firstState.cliCanaryHandledOutcomes = { 'claude-code@2.0.0:green': true };
                throw new Error('stop before cleanup');
            }),
        };
        expect(() => runCliCanary(first)).toThrow('stop before cleanup');

        const restartedState = JSON.parse(JSON.stringify(firstState)) as RalphState;
        const pruneCanaryCopiesFn = vi.fn<typeof pruneCanaryCopies>();
        const restarted = {
            ...input(restartedState, versions),
            nowFn: () => 1000 + CLI_CANARY_INTERVAL_MS - 1,
            handleOutcomesFn: vi.fn(),
            sweepCanaryTrashFn: vi.fn<typeof sweepCanaryTrash>(),
            pruneCanaryCopiesFn,
        };
        runCliCanary(restarted);
        const calls = pruneCanaryCopiesFn.mock.calls.map(([call]) => call);
        const claude = calls.find((call) => call.harness === 'claude-code');
        const codex = calls.find((call) => call.harness === 'codex');
        expect(claude?.keep.has('2.0.0')).toBe(false);
        expect(codex?.keep.has('2.0.0')).toBe(true);
    });

    it('[F24-4] боевой вызов без cleanup-инъекций очищает canaryRoot', () => {
        const dir = mkdtempSync(join(tmpdir(), 'f24-production-cleanup.'));
        try {
            for (const target of [
                join(dir, '.trash', 'interrupted'),
                join(dir, 'claude-code', '1.0.0'),
                join(dir, 'claude-code', '2.0.0'),
            ]) {
                mkdirSync(target, { recursive: true });
            }
            const canaryModule = JSON.stringify(new URL('./cli-canary.ts', import.meta.url).href);
            const reportModule = JSON.stringify(
                new URL('../provision/stand/report.mts', import.meta.url).href,
            );
            const root = JSON.stringify(dir);
            const script = `
                import assert from 'node:assert/strict';
                import { existsSync } from 'node:fs';
                import { runCliCanary } from ${canaryModule};
                import { REPORT_MATRIX_PROBES } from ${reportModule};
                const root = ${root};
                const current = {
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
                const report = (version) => ({
                    protocol: 1,
                    harness: 'claude-code',
                    version,
                    inventory: { tools: ['Bash'] },
                    probes: ['version', 'inventory', ...REPORT_MATRIX_PROBES.claude, 'stand'].map(
                        (name) => ({ name, verdict: 'PASS', detail: 'ok' }),
                    ),
                });
                runCliCanary({
                    state: current,
                    canaryRoot: root,
                    pinnedBins: new Map([['claude-code', '/pinned/cli.js']]),
                    registry: {
                        packages: new Map([['claude-code', {
                            descriptor: { cliVersion: '1.0.0' },
                            pkg: { distribution: { registry: 'npm', package: 'example-cli', bin: 'bin/cli.js' } },
                        }]]),
                        problems: new Map(),
                    },
                    saveStateFn: () => {},
                    logFn: () => {},
                    nowFn: () => 1000,
                    latestVersionFn: () => '2.0.0',
                    installFn: () => ({ ok: true, bin: '/candidate/cli.js' }),
                    reportFn: ({ version }) => report(version),
                    handleOutcomesFn: () => {
                        current.cliCanaryHandledOutcomes = { 'claude-code@2.0.0:green': true };
                    },
                });
                assert.equal(existsSync(root + '/.trash/interrupted'), false);
                assert.equal(existsSync(root + '/claude-code/2.0.0'), false);
                assert.equal(existsSync(root + '/claude-code/1.0.0'), true);
            `;
            expect(() =>
                execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
                    env: { ...process.env, RALPH_NO_SIDE_EFFECTS: '0' },
                    timeout: 10_000,
                }),
            ).not.toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

import { describe, expect, it, vi } from 'vitest';
import type { HarnessRegistry } from '../adapters/harness-registry.ts';
import { CliCanaryInfrastructureError } from '../adapters/cli-canary.ts';
import {
    CLI_CANARY_BUDGET_MS,
    CLI_CANARY_INTERVAL_MS,
    runCliCanary,
    type CliCanaryReport,
} from './cli-canary.ts';
import type { RalphState } from './state-lock.ts';
import { REPORT_MATRIX_PROBES } from '../provision/stand/report.mts';
import { canonicalInventory } from './cli-canary.ts';

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

function report(
    harness: string,
    version: string,
    inventory: unknown = { tools: ['Bash'] },
): CliCanaryReport {
    const cli = harness === 'claude-code' ? 'claude' : harness === 'kimi-code' ? 'kimi' : harness;
    const names = ['version', 'inventory', ...(REPORT_MATRIX_PROBES[cli] ?? []), 'stand'];
    return {
        protocol: 1,
        harness,
        version,
        inventory,
        probes: names.map((name) => ({ name, verdict: 'PASS', detail: 'ok' })),
    };
}

function input(currentState = state()) {
    return {
        state: currentState,
        canaryRoot: '/state/cli-canary',
        pinnedBins: new Map([['claude-code', '/state/cli/claude-code/1.0.0/bin/cli.js']]),
        registry: registry({ 'claude-code': '1.0.0' }),
        saveStateFn: vi.fn(),
        logFn: vi.fn(),
        nowFn: () => 1_000,
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

describe('ежедневная канарейка CLI (#264)', () => {
    it('S3b.10: у всех четырёх CLI свежая закреплённая версия — fresh без установки и стенда', () => {
        const current = state();
        const args = {
            ...input(current),
            registry: registry({
                'claude-code': '1.0.0',
                codex: '1.0.0',
                'kimi-code': '1.0.0',
                opencode: '1.0.0',
            }),
            latestVersionFn: vi.fn(() => '1.0.0'),
        };
        const result = runCliCanary(args);
        expect(result.ran).toBe(true);
        expect(result.outcomes.map((outcome) => outcome.verdict)).toEqual([
            'fresh',
            'fresh',
            'fresh',
            'fresh',
        ]);
        expect(args.installFn).not.toHaveBeenCalled();
        expect(args.reportFn).not.toHaveBeenCalled();
        expect(current.cliCanaryLastRunAt).toBe(1_000);
        expect(Object.keys(current.cliCanaryOutcomes ?? {})).toHaveLength(4);
        expect(args.saveStateFn).toHaveBeenCalledWith(current);
    });

    it('по умолчанию суточный срок берётся от системных часов', () => {
        const current = state();
        const args = {
            ...input(current),
            nowFn: undefined,
            latestVersionFn: vi.fn(() => '1.0.0'),
        };
        const before = Date.now();
        runCliCanary(args);
        expect(current.cliCanaryLastRunAt).toBeGreaterThanOrEqual(before);
        expect(current.cliCanaryLastRunAt).toBeLessThanOrEqual(Date.now());
    });

    it('S3b.9: срок переживает сериализацию state и повторный запуск процесса', () => {
        const current = state();
        const first = input(current);
        runCliCanary(first);
        const restarted = JSON.parse(JSON.stringify(current)) as RalphState;
        const beforeDeadline = input(restarted);
        beforeDeadline.nowFn = () => 1_000 + CLI_CANARY_INTERVAL_MS - 1;
        expect(runCliCanary(beforeDeadline).ran).toBe(false);
        expect(beforeDeadline.latestVersionFn).not.toHaveBeenCalled();
        const due = input(restarted);
        due.nowFn = () => 1_000 + CLI_CANARY_INTERVAL_MS;
        expect(runCliCanary(due).ran).toBe(true);
        expect(due.latestVersionFn).toHaveBeenCalledTimes(1);
    });

    it('новая версия: установка в каталог канарейки и отчёты закреплённой и новой', () => {
        const args = input();
        const result = runCliCanary(args);
        expect(args.installFn).toHaveBeenCalledWith(
            expect.objectContaining({
                harness: 'claude-code',
                version: '2.0.0',
                root: '/state/cli-canary',
                distribution,
                timeoutMs: CLI_CANARY_BUDGET_MS,
            }),
        );
        expect(args.reportFn.mock.calls.map((call) => call[0])).toEqual([
            expect.objectContaining({
                version: '1.0.0',
                cliBin: '/state/cli/claude-code/1.0.0/bin/cli.js',
            }),
            expect.objectContaining({
                version: '2.0.0',
                cliBin: '/state/cli-canary/claude-code/2.0.0/bin/cli.js',
            }),
        ]);
        expect(result.outcomes[0]).toMatchObject({ verdict: 'green', latestVersion: '2.0.0' });
        expect(result.outcomes[0]?.reports?.pinned.version).toBe('1.0.0');
        expect(result.outcomes[0]?.reports?.candidate.version).toBe('2.0.0');
    });

    it('один подготовленный override не ограничивает канарейку: эталоны остальных ставятся', () => {
        const args = {
            ...input(),
            registry: registry({
                'claude-code': '1.0.0',
                codex: '1.0.0',
                'kimi-code': '1.0.0',
                opencode: '1.0.0',
            }),
        };
        const result = runCliCanary(args);
        expect(result.outcomes.map((outcome) => outcome.verdict)).toEqual([
            'green',
            'green',
            'green',
            'green',
        ]);
        expect(args.reportFn).toHaveBeenCalledTimes(8);
        expect(args.installFn).toHaveBeenCalledTimes(7);
        expect(args.installFn).toHaveBeenCalledWith(
            expect.objectContaining({ harness: 'codex', version: '1.0.0' }),
        );
    });

    it('все пробы PASS, но инвентарь разошёлся — drift', () => {
        const args = input();
        args.reportFn = vi.fn(({ version }: { version: string }) =>
            report('claude-code', version, {
                tools: version === '1.0.0' ? ['Bash'] : ['Bash', 'Agent'],
            }),
        );
        expect(runCliCanary(args).outcomes[0]?.verdict).toBe('drift');
    });

    it('метаданные report-entry, события envelope и неупорядоченные наборы не дают ложный drift', () => {
        const args = input();
        args.reportFn = vi.fn(({ version }: { version: string }) =>
            report('claude-code', version, [
                {
                    id: 'report',
                    cliVersion: version,
                    model: version === '1.0.0' ? 'old' : 'new',
                    tools:
                        version === '1.0.0'
                            ? [
                                  { name: 'Bash', properties: ['command', 'timeout'] },
                                  { name: 'Agent', properties: [], required: ['prompt', 'model'] },
                              ]
                            : [
                                  { name: 'Agent', properties: [], required: ['model', 'prompt'] },
                                  { name: 'Bash', properties: ['timeout', 'command'] },
                              ],
                    envelope: {
                        fields: ['hook_event_name', 'tool_name'],
                        events: [
                            {
                                id: version,
                                session_id: version,
                                cwd: version === '1.0.0' ? '/tmp/old' : '/tmp/new',
                                tool_use_id: version,
                            },
                        ],
                    },
                },
            ]),
        );
        expect(runCliCanary(args).outcomes[0]?.verdict).toBe('green');
    });

    it('удаление cwd из сырой JSON Schema Bash — drift, а не green', () => {
        const args = input();
        args.reportFn = vi.fn(({ version }: { version: string }) =>
            report('claude-code', version, [
                {
                    id: 'report',
                    tools: [
                        {
                            name: 'Bash',
                            parameters: {
                                type: 'object',
                                properties: {
                                    command: { type: 'string' },
                                    ...(version === '1.0.0' ? { cwd: { type: 'string' } } : {}),
                                },
                            },
                        },
                    ],
                },
            ]),
        );
        expect(runCliCanary(args).outcomes[0]?.verdict).toBe('drift');
    });

    it('version, events и model внутри tools и additionalTools остаются доказательством дрейфа', () => {
        const inventory = (version: string, nested: unknown) => [
            {
                id: 'report',
                tools: [{ name: 'Bash', parameters: { [version]: nested } }],
                additionalTools: [{ name: 'Extra', parameters: { [version]: nested } }],
            },
        ];
        for (const key of ['version', 'events', 'model', 'cwd']) {
            const args = input();
            args.reportFn = vi.fn(({ version }: { version: string }) =>
                report(
                    'claude-code',
                    version,
                    inventory(key, version === '1.0.0' ? 'before' : 'after'),
                ),
            );
            expect(runCliCanary(args).outcomes[0]?.verdict).toBe('drift');
            expect(
                canonicalInventory({
                    id: 'report',
                    envelope: { events: [{ id: 'one' }] },
                    events: [{ id: 'two' }],
                }),
            ).toEqual({
                id: 'report',
                envelope: {},
                events: [{ id: 'two' }],
            });
        }
    });

    it.each(['tools', 'additionalTools'] as const)(
        'вложенный %s[0].parameters.envelope.events остаётся доказательством дрейфа',
        (collection) => {
            const args = input();
            args.reportFn = vi.fn(({ version }: { version: string }) =>
                report('claude-code', version, [
                    {
                        id: 'report',
                        [collection]: [
                            {
                                name: 'Bash',
                                parameters: {
                                    envelope: {
                                        events: [version === '1.0.0' ? 'before' : 'after'],
                                    },
                                },
                            },
                        ],
                    },
                ]),
            );
            expect(runCliCanary(args).outcomes[0]?.verdict).toBe('drift');
        },
    );

    it.each(['FAIL', 'SKIP', 'INCONCLUSIVE', 'UNKNOWN', ''])(
        'S3b.13: вердикт %s новой версии — red с именем пробы',
        (verdict) => {
            const args = input();
            args.reportFn = vi.fn(({ version }: { version: string }) => {
                const value = report('claude-code', version);
                const block = value.probes.findIndex((probe) => probe.name === 'block');
                if (version === '2.0.0')
                    value.probes[block] = { name: 'block', verdict, detail: 'причина' };
                return value;
            });
            const outcome = runCliCanary(args).outcomes[0];
            expect(outcome?.verdict).toBe('red');
            expect(outcome?.failedProbes).toEqual([
                expect.objectContaining({ name: 'block', verdict, detail: 'причина' }),
            ]);
        },
    );

    it('S3b.13: пустой перечень проб отклоняется по протоколу', () => {
        const args = input();
        args.reportFn = vi.fn(({ version }: { version: string }) => ({
            ...report('claude-code', version),
            probes: version === '2.0.0' ? [] : report('claude-code', version).probes,
        }));
        const outcome = runCliCanary(args).outcomes[0];
        expect(outcome?.verdict).toBe('unchecked');
        expect(outcome?.reason).toMatch(/матрицу проб/);
    });

    it('проба без обязательных полей отклоняется по протоколу', () => {
        const args = input();
        args.reportFn = vi.fn(({ version }: { version: string }) => ({
            ...report('claude-code', version),
            probes: version === '2.0.0' ? [{}] : report('claude-code', version).probes,
        })) as unknown as typeof args.reportFn;
        const outcome = runCliCanary(args).outcomes[0];
        expect(outcome?.verdict).toBe('unchecked');
        expect(outcome?.reason).toMatch(/битую пробу/);
    });

    it.each(['missing-inventory', 'duplicate', 'unknown', 'missing'])(
        'битый отчёт %s отклоняется fail-closed',
        (kind) => {
            const args = input();
            args.reportFn = vi.fn(({ version }: { version: string }) => {
                const value = report('claude-code', version);
                if (version === '2.0.0') {
                    if (kind === 'missing-inventory') {
                        const partial: Partial<CliCanaryReport> = value;
                        delete partial.inventory;
                    } else if (kind === 'duplicate') {
                        value.probes.push(value.probes[0]);
                    } else if (kind === 'unknown') {
                        value.probes[0] = { name: 'unknown', verdict: 'PASS', detail: 'ok' };
                    } else {
                        value.probes.splice(2, 1);
                    }
                }
                return value;
            });
            expect(runCliCanary(args).outcomes[0]?.verdict).toBe('unchecked');
        },
    );

    it('S3b.19: реестр недоступен — unchecked с причиной, без исключения наружу', () => {
        const args = input();
        args.latestVersionFn = vi.fn(() => {
            throw new Error('registry unavailable');
        });
        const result = runCliCanary(args);
        expect(result.outcomes[0]).toMatchObject({
            verdict: 'unchecked',
            reason: expect.stringContaining('registry unavailable'),
        });
        expect(args.logFn).toHaveBeenCalledWith(
            expect.stringMatching(/канарей.*не проверено.*registry unavailable/i),
        );
        expect(args.installFn).not.toHaveBeenCalled();
    });

    it('S3b.19: изоляция недоступна — unchecked, остальные CLI проверяются', () => {
        const current = state();
        const args = {
            ...input(current),
            registry: registry({ 'claude-code': '1.0.0', codex: '1.0.0' }),
            pinnedBins: new Map([
                ['claude-code', '/state/cli/claude-code/1.0.0/bin/cli.js'],
                ['codex', '/state/cli/codex/1.0.0/bin/cli.js'],
            ]),
        };
        args.reportFn = vi.fn(({ harness, version }: { harness: string; version: string }) => {
            if (harness === 'claude-code') throw new Error('namespaces unavailable');
            return report(harness, version);
        });
        const result = runCliCanary(args);
        expect(result.outcomes.map((outcome) => outcome.verdict)).toEqual(['unchecked', 'green']);
        expect(args.logFn).toHaveBeenCalledWith(expect.stringContaining('namespaces unavailable'));
    });

    it('typed infrastructure outcome — только unchecked, без red и reports', () => {
        const args = { ...input(), handleOutcomesFn: vi.fn() };
        args.reportFn = vi.fn(() => {
            throw new CliCanaryInfrastructureError('isolation', 'unshare refused');
        });
        const outcome = runCliCanary(args).outcomes[0];
        expect(outcome).toMatchObject({ verdict: 'unchecked' });
        expect(outcome?.reason).toContain('инфраструктура (isolation)');
        expect(outcome?.reports).toBeUndefined();
        expect(args.handleOutcomesFn).toHaveBeenCalledWith([outcome]);
    });

    it('S3b.19: превышен общий бюджет — unchecked, следующий CLI не ждёт', () => {
        let now = 1_000;
        const args = {
            ...input(),
            registry: registry({ 'claude-code': '1.0.0', codex: '1.0.0' }),
            nowFn: () => now,
        };
        args.latestVersionFn = vi.fn(() => {
            now += CLI_CANARY_BUDGET_MS + 1;
            return '2.0.0';
        });
        const result = runCliCanary(args);
        expect(result.outcomes.map((outcome) => outcome.verdict)).toEqual([
            'unchecked',
            'unchecked',
        ]);
        expect(result.outcomes[0]?.reason).toMatch(/бюджет/i);
        expect(args.latestVersionFn).toHaveBeenCalledTimes(1);
        expect(args.installFn).not.toHaveBeenCalled();
    });

    it('отказ подготовки эталона — unchecked без стенда', () => {
        const args = { ...input(), pinnedBins: new Map() };
        args.installFn = vi.fn(() => ({
            ok: false as const,
            code: 'install-failed' as const,
            harness: 'claude-code',
            version: '1.0.0',
            reason: 'baseline missing',
        })) as unknown as typeof args.installFn;
        const result = runCliCanary(args);
        expect(result.outcomes[0]).toMatchObject({
            verdict: 'unchecked',
            reason: 'baseline missing',
        });
        expect(args.reportFn).not.toHaveBeenCalled();
    });

    it('отказ установки кандидата — unchecked без стенда', () => {
        const args = input();
        args.installFn = vi.fn(() => ({
            ok: false as const,
            code: 'install-failed' as const,
            harness: 'claude-code',
            version: '2.0.0',
            reason: 'candidate missing',
        })) as unknown as typeof args.installFn;
        const result = runCliCanary(args);
        expect(result.outcomes[0]).toMatchObject({
            verdict: 'unchecked',
            reason: 'candidate missing',
        });
        expect(args.reportFn).not.toHaveBeenCalled();
    });

    it('красный эталон — unchecked с обоими отчётами, а не red кандидата', () => {
        const args = input();
        args.reportFn = vi.fn(({ version }: { version: string }) => {
            const value = report('claude-code', version);
            if (version === '1.0.0') {
                value.probes[2] = { name: 'block', verdict: 'FAIL', detail: 'baseline broken' };
            }
            return value;
        });
        const outcome = runCliCanary(args).outcomes[0];
        expect(outcome).toMatchObject({
            verdict: 'unchecked',
            reports: { pinned: { version: '1.0.0' }, candidate: { version: '2.0.0' } },
        });
        expect(outcome?.reason).toContain('закреплённая версия');
        expect(outcome?.reason).toContain('block=FAIL');
    });

    it('рестарт раньше суток доводит сохранённые, ещё не обработанные исходы', () => {
        const current = state();
        const saved = {
            harness: 'claude-code',
            pinnedVersion: '1.0.0',
            latestVersion: '3.0.0',
            verdict: 'green' as const,
            reports: {
                pinned: report('claude-code', '1.0.0'),
                candidate: report('claude-code', '3.0.0'),
            },
        };
        current.cliCanaryLastRunAt = 1_000;
        current.cliCanaryOutcomes = { 'claude-code@3.0.0': saved };
        current.cliCanaryHandledOutcomes = { 'claude-code@2.0.0:green': true };
        const args = {
            ...input(current),
            nowFn: () => 1_000 + CLI_CANARY_INTERVAL_MS - 1,
            handleOutcomesFn: vi.fn(),
        };
        const result = runCliCanary(args);
        expect(result).toEqual({ ran: false, outcomes: [saved] });
        expect(args.handleOutcomesFn).toHaveBeenCalledWith([saved]);
        expect(args.latestVersionFn).not.toHaveBeenCalled();
        expect(current.cliCanaryOutcomes['claude-code@3.0.0']).toEqual(saved);
    });

    it('обрыв между сохранением и действиями восстанавливается из state', () => {
        const current = state();
        const first = {
            ...input(current),
            handleOutcomesFn: vi.fn(() => {
                throw new Error('process restarted');
            }),
        };
        expect(() => runCliCanary(first)).toThrow(/process restarted/);
        const saved = current.cliCanaryOutcomes?.['claude-code@2.0.0'];
        expect(saved?.verdict).toBe('green');
        const restarted = {
            ...input(JSON.parse(JSON.stringify(current)) as RalphState),
            handleOutcomesFn: vi.fn(),
        };
        restarted.nowFn = () => 1_000 + CLI_CANARY_INTERVAL_MS - 1;
        expect(runCliCanary(restarted).ran).toBe(false);
        expect(restarted.handleOutcomesFn).toHaveBeenCalledWith([saved]);
    });

    it('суточный прогон сначала доводит старое и не затирает его новыми итогами', () => {
        const current = state();
        const saved = {
            harness: 'claude-code',
            pinnedVersion: '1.0.0',
            latestVersion: '3.0.0',
            verdict: 'green' as const,
            reports: {
                pinned: report('claude-code', '1.0.0'),
                candidate: report('claude-code', '3.0.0'),
            },
        };
        current.cliCanaryLastRunAt = 1_000;
        current.cliCanaryOutcomes = { 'claude-code@3.0.0': saved };
        const args = {
            ...input(current),
            nowFn: () => 1_000 + CLI_CANARY_INTERVAL_MS,
            handleOutcomesFn: vi.fn(),
        };
        runCliCanary(args);
        expect(args.handleOutcomesFn).toHaveBeenCalledTimes(2);
        expect(args.handleOutcomesFn.mock.calls[0][0]).toEqual([saved]);
        expect(current.cliCanaryOutcomes).toMatchObject({
            'claude-code@2.0.0': { verdict: 'green' },
            'claude-code@3.0.0': { verdict: 'green' },
        });
    });

    it('старый pending green не воскресает после свежего red и рестарта', () => {
        const current = state();
        const saved = {
            harness: 'claude-code',
            pinnedVersion: '1.0.0',
            latestVersion: '2.0.0',
            verdict: 'green' as const,
            reports: {
                pinned: report('claude-code', '1.0.0'),
                candidate: report('claude-code', '2.0.0'),
            },
        };
        current.cliCanaryLastRunAt = 1_000;
        current.cliCanaryOutcomes = { 'claude-code@2.0.0': saved };
        const args = {
            ...input(current),
            nowFn: () => 1_000 + CLI_CANARY_INTERVAL_MS,
            reportFn: vi.fn(({ harness, version }: { harness: string; version: string }) => {
                const value = report(harness, version);
                if (version === '2.0.0') {
                    value.probes = value.probes.map((probe) =>
                        probe.name === 'block'
                            ? { ...probe, verdict: 'FAIL', detail: 'candidate broken' }
                            : probe,
                    );
                }
                return value;
            }),
            handleOutcomesFn: vi.fn((outcomes) => {
                for (const outcome of outcomes) {
                    if (outcome.verdict === 'red') {
                        current.cliCanaryHandledOutcomes = {
                            ...current.cliCanaryHandledOutcomes,
                            'claude-code@2.0.0:red': true,
                        };
                    }
                }
            }),
        };
        expect(runCliCanary(args).outcomes[0]?.verdict).toBe('red');
        expect(current.cliCanaryOutcomes?.['claude-code@2.0.0']?.verdict).toBe('red');
        expect(current.cliCanaryHandledOutcomes?.['claude-code@2.0.0:red']).toBe(true);

        const restarted = {
            ...input(JSON.parse(JSON.stringify(current)) as RalphState),
            nowFn: () => 1_000 + 2 * CLI_CANARY_INTERVAL_MS - 1,
            handleOutcomesFn: vi.fn(),
        };
        expect(runCliCanary(restarted)).toEqual({ ran: false, outcomes: [] });
        expect(restarted.handleOutcomesFn).not.toHaveBeenCalled();
    });

    it('итоги сохранены и переданы действиям канарейки', () => {
        const args = { ...input(), handleOutcomesFn: vi.fn() };
        const result = runCliCanary(args);
        expect(args.handleOutcomesFn).toHaveBeenCalledWith(result.outcomes);
        expect(args.saveStateFn).toHaveBeenCalledBefore(args.handleOutcomesFn);
    });
});

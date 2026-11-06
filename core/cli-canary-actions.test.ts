import { execFileSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessDescriptorPath, standFixturePath } from '../adapters/harness-registry.ts';
import { checkCommitMessage } from '../commit-msg.mts';
import { traceFindings } from '../shared/project-traces.ts';
import { reportProbeNames } from '../provision/stand/report.mts';
import {
    handleCliCanaryOutcomes,
    inventoryDiff,
    versionedStandFixture,
} from './cli-canary-actions.ts';
import type { CliCanaryOutcome, CliCanaryReport } from './cli-canary.ts';
import type { RalphState } from './state-lock.ts';

const DESCRIPTOR_PATH = harnessDescriptorPath('codex');
const OLD_FIXTURE_PATH = standFixturePath('codex', '1.0.0');
const NEW_FIXTURE_PATH = standFixturePath('codex', '2.0.0');
const DESCRIPTOR = `{\n    "schemaVersion": 1,\n    "harness": "codex",\n    "cliVersion": "1.0.0",\n    "normalizer": "normalize.ts"\n}\n`;
const BASELINE =
    JSON.stringify({
        source: 'codex-cli 1.0.0',
        cliVersion: '1.0.0',
        assembled: false,
        kit: {},
        events: [{ id: 'pinned-only', hookStdin: ['{"tool_name":"OldTool"}'] }],
        inventory: [],
    }) + '\n';

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

function report(
    version: string,
    inventory: unknown = {
        tools: { Bash: { properties: ['command'], required: ['command'] } },
        envelope: { fields: ['cwd', 'tool_name'], events: [] },
    },
): CliCanaryReport {
    return {
        protocol: 1,
        harness: 'codex',
        version,
        inventory,
        probes: [{ name: 'block', verdict: 'PASS', detail: 'ok' }],
    };
}

function outcome(verdict: 'green' | 'drift' | 'red', extra: Partial<CliCanaryOutcome> = {}) {
    return {
        harness: 'codex',
        pinnedVersion: '1.0.0',
        latestVersion: '2.0.0',
        verdict,
        reports: { pinned: report('1.0.0'), candidate: report('2.0.0') },
        ...extra,
    } satisfies CliCanaryOutcome;
}

function input(current = state()) {
    const calls: string[] = [];
    const files = new Map([
        [`/state/pr-work/tree/${DESCRIPTOR_PATH}`, DESCRIPTOR],
        [`/state/pr-work/tree/${OLD_FIXTURE_PATH}`, BASELINE],
    ]);
    let branchExists = false;
    const runArgvFn = vi.fn((file: string, args: string[]) => {
        const line = `${file} ${args.join(' ')}`;
        calls.push(line);
        if (args.includes('ls-remote'))
            return branchExists ? 'abc123\trefs/heads/cli/codex-2.0.0' : '';
        if (args.includes('diff')) return `${DESCRIPTOR_PATH}\n${NEW_FIXTURE_PATH}`;
        if (args[0] === 'git' && args.includes('commit')) return '';
        return '';
    });
    return {
        current,
        calls,
        files,
        setBranchExists(value: boolean) {
            branchExists = value;
        },
        args: {
            outcomes: [outcome('green')],
            state: current,
            consumerRoot: '/repo',
            canaryRoot: '/state/cli-canary',
            saveStateFn: vi.fn(),
            logFn: vi.fn(),
            createIssueFn: vi.fn(() => 101),
            createPullRequestFn: vi.fn(() => {
                calls.push('createPR');
                return 102;
            }),
            findOpenIssueFn: vi.fn((_title: string): { number: number } | null => null),
            findOpenPullRequestFn: vi.fn(() => null),
            backlogAddressFn: () => 'Входящие',
            labels: ['complexity:low', 'area:adapters'],
            runArgvFn,
            descriptorPathFn: harnessDescriptorPath,
            standFixturePathFn: standFixturePath,
            mkdtempFn: vi.fn(() => '/state/pr-work'),
            readFileFn: vi.fn((file: string) => {
                const text = files.get(file);
                if (text === undefined) throw new Error(`нет файла ${file}`);
                return text;
            }),
            existsFn: vi.fn((file: string) => files.has(file)),
            writeFileFn: vi.fn((file: string, text: string) => files.set(file, text)),
            removeFileFn: vi.fn((file: string) => files.delete(file)),
            removeDirFn: vi.fn(),
            checkCommitMessageFn: checkCommitMessage,
            traceFindingsFn: traceFindings,
            env: {},
        },
    };
}

describe('исход канарейки CLI (#265)', () => {
    it('S3b.14: green собирает PR только из cliVersion и нового снимка во временном worktree', () => {
        const { args, calls, files, current } = input();
        handleCliCanaryOutcomes(args);

        expect(args.createPullRequestFn).toHaveBeenCalledWith({
            branch: 'cli/codex-2.0.0',
            title: expect.stringContaining('codex@2.0.0'),
            body: expect.stringMatching(/green|зелён/i),
        });
        expect(files.get(`/state/pr-work/tree/${DESCRIPTOR_PATH}`)).toBe(
            DESCRIPTOR.replace('"cliVersion": "1.0.0"', '"cliVersion": "2.0.0"'),
        );
        expect(JSON.parse(files.get(`/state/pr-work/tree/${NEW_FIXTURE_PATH}`) ?? '')).toEqual({
            ...args.outcomes[0]?.reports?.candidate,
            cliVersion: '2.0.0',
            assembled: false,
        });
        expect(files.get(`/state/pr-work/tree/${NEW_FIXTURE_PATH}`)).not.toContain('pinned-only');
        expect(files.get(`/state/pr-work/tree/${OLD_FIXTURE_PATH}`)).toContain('pinned-only');
        expect(args.removeFileFn).not.toHaveBeenCalled();
        expect(calls).toContain(
            'git -C /repo -c core.hooksPath=/dev/null fetch --no-recurse-submodules origin main',
        );
        expect(calls).toContain(
            'git -C /repo -c core.hooksPath=/dev/null worktree add --detach /state/pr-work/tree origin/main',
        );
        expect(calls).toContain(
            'git -C /state/pr-work/tree -c core.hooksPath=/dev/null push origin HEAD:refs/heads/cli/codex-2.0.0',
        );
        expect(calls).toContain(
            'git -C /repo -c core.hooksPath=/dev/null worktree remove /state/pr-work/tree',
        );
        expect(
            calls.indexOf(
                'git -C /repo -c core.hooksPath=/dev/null worktree remove /state/pr-work/tree',
            ),
        ).toBeLessThan(calls.indexOf('createPR'));
        expect(current.cliCanaryHandledOutcomes).toEqual({ 'codex@2.0.0:green': true });
        expect(args.createIssueFn).not.toHaveBeenCalled();
    });

    it('первый снимок без predecessor: diff содержит только descriptor и новый fixture', () => {
        const { args, files } = input();
        files.delete(`/state/pr-work/tree/${OLD_FIXTURE_PATH}`);
        const run = args.runArgvFn;
        args.runArgvFn = vi.fn((file: string, argv: string[]) =>
            argv.includes('diff') ? `${DESCRIPTOR_PATH}\n${NEW_FIXTURE_PATH}` : run(file, argv),
        );
        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).toHaveBeenCalledTimes(1);
        expect(args.removeFileFn).not.toHaveBeenCalledWith(
            `/state/pr-work/tree/${OLD_FIXTURE_PATH}`,
        );
        expect(args.runArgvFn).toHaveBeenCalledWith(
            'git',
            [
                '-C',
                '/state/pr-work/tree',
                '-c',
                'core.hooksPath=/dev/null',
                'add',
                '--',
                DESCRIPTOR_PATH,
                NEW_FIXTURE_PATH,
            ],
            expect.anything(),
        );
    });

    it('S3b.18: повтор дедуплицируется; ветка без PR доводит именно создание PR', () => {
        const first = input();
        handleCliCanaryOutcomes(first.args);
        handleCliCanaryOutcomes(first.args);
        expect(first.args.createPullRequestFn).toHaveBeenCalledTimes(1);
        expect(
            first.args.runArgvFn.mock.calls.filter((call) => call[1].includes('push')),
        ).toHaveLength(1);

        const restarted = input();
        restarted.setBranchExists(true);
        handleCliCanaryOutcomes(restarted.args);
        expect(restarted.args.createPullRequestFn).toHaveBeenCalledTimes(1);
        expect(restarted.args.mkdtempFn).not.toHaveBeenCalled();
        expect(
            restarted.args.runArgvFn.mock.calls.filter((call) => call[1].includes('push')),
        ).toHaveLength(0);
        expect(restarted.current.cliCanaryHandledOutcomes).toEqual({ 'codex@2.0.0:green': true });
    });

    it('открытый PR ветки завершает исход без повторной публикации', () => {
        const { args, current } = input();
        args.findOpenPullRequestFn = vi.fn(() => ({ number: 102 }) as never);
        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(args.mkdtempFn).not.toHaveBeenCalled();
        expect(current.cliCanaryHandledOutcomes).toEqual({ 'codex@2.0.0:green': true });
    });

    it('S3b.16: drift заводит карточку во Входящие с добавленным, убранным и изменённым', () => {
        const current = state();
        const args = input(current).args;
        const pinned = {
            tools: {
                Bash: { properties: ['command'], required: ['command'] },
                Read: { properties: ['path'], required: ['path'] },
            },
            envelope: { fields: ['cwd', 'tool_name'], events: [] },
        };
        const candidate = {
            tools: {
                Bash: { properties: { command: true, cwd: true }, required: ['command', 'cwd'] },
                Agent: { properties: ['prompt'], required: ['prompt'] },
            },
            envelope: { fields: ['cwd', 'tool_name', 'tool_use_id'], events: [] },
        };
        args.outcomes = [
            outcome('drift', {
                reports: { pinned: report('1.0.0', pinned), candidate: report('2.0.0', candidate) },
            }),
        ];

        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(args.createIssueFn).toHaveBeenCalledWith({
            title: expect.stringContaining('codex@2.0.0'),
            labels: ['complexity:low', 'area:adapters'],
            milestone: 'Входящие',
            body: expect.stringMatching(
                /Добавлено[\s\S]*Agent[\s\S]*Убрано[\s\S]*Read[\s\S]*Изменено[\s\S]*properties/,
            ),
        });
        handleCliCanaryOutcomes(args);
        expect(args.createIssueFn).toHaveBeenCalledTimes(1);
    });

    it('S3b.17: red заводит карточку с пробой и выводом, не меняет закреплённую версию и не бросает', () => {
        const { args, files, current } = input();
        args.outcomes = [
            outcome('red', {
                failedProbes: [
                    {
                        name: 'mcp-write',
                        verdict: 'FAIL',
                        detail: 'guard не ответил: hook missing',
                    },
                ],
                reason: 'mcp-write=FAIL',
            }),
        ];
        expect(() => handleCliCanaryOutcomes(args)).not.toThrow();
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(args.createIssueFn).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.stringMatching(/mcp-write[\s\S]*FAIL[\s\S]*hook missing/),
            }),
        );
        expect(files.get(`/state/pr-work/tree/${DESCRIPTOR_PATH}`)).toBe(DESCRIPTOR);
        expect(current.cliCanaryHandledOutcomes).toEqual({ 'codex@2.0.0:red': true });
    });

    it.each(['red', 'drift'] as const)(
        'обрыв %s после createIssue до markHandled восстанавливается без дубля',
        (verdict) => {
            const first = input();
            first.args.outcomes = [outcome(verdict)];
            first.args.saveStateFn = vi.fn(() => {
                throw new Error('crash after create');
            });
            handleCliCanaryOutcomes(first.args);
            expect(first.args.createIssueFn).toHaveBeenCalledTimes(1);

            const restarted = input();
            expect(restarted.current.cliCanaryHandledOutcomes).toBeUndefined();
            restarted.args.outcomes = [outcome(verdict)];
            restarted.args.findOpenIssueFn = vi.fn(() => ({ number: 101 }));
            handleCliCanaryOutcomes(restarted.args);
            expect(restarted.args.findOpenIssueFn).toHaveBeenCalledWith(
                expect.stringContaining('codex@2.0.0'),
            );
            expect(restarted.args.createIssueFn).not.toHaveBeenCalled();
            expect(restarted.current.cliCanaryHandledOutcomes).toEqual({
                [`codex@2.0.0:${verdict}`]: true,
            });
            handleCliCanaryOutcomes(restarted.args);
            expect(restarted.args.createIssueFn).not.toHaveBeenCalled();
        },
    );

    it.each(['red', 'drift'] as const)(
        'отказ поиска %s запрещает создание карточки вслепую',
        (verdict) => {
            const { args, current } = input();
            args.outcomes = [outcome(verdict)];
            args.findOpenIssueFn = vi.fn(() => {
                throw new Error('forge unreadable');
            });
            handleCliCanaryOutcomes(args);
            expect(args.createIssueFn).not.toHaveBeenCalled();
            expect(current.cliCanaryHandledOutcomes).toBeUndefined();
            expect(args.logFn).toHaveBeenCalledWith(expect.stringContaining('forge unreadable'));
        },
    );

    it.each(['red', 'drift'] as const)(
        'след в %s detail/inventory отклонён до createIssue',
        (verdict) => {
            const { args, current } = input();
            args.env = { RALPH_TRACE_DENY: 'acme' };
            args.outcomes = [
                verdict === 'red'
                    ? outcome('red', {
                          failedProbes: [{ name: 'block', verdict: 'FAIL', detail: 'acme' }],
                      })
                    : outcome('drift', {
                          reports: {
                              pinned: report('1.0.0'),
                              candidate: report('2.0.0', { tools: { acme: true } }),
                          },
                      }),
            ];
            handleCliCanaryOutcomes(args);
            expect(args.createIssueFn).not.toHaveBeenCalled();
            expect(current.cliCanaryHandledOutcomes).toBeUndefined();
        },
    );

    it('след в fixture отклонён до записи, commit и push', () => {
        const { args, current } = input();
        args.env = { RALPH_TRACE_DENY: 'acme' };
        args.outcomes = [
            outcome('green', {
                reports: {
                    pinned: report('1.0.0'),
                    candidate: report('2.0.0', { tools: { acme: true } }),
                },
            }),
        ];
        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(args.writeFileFn).not.toHaveBeenCalled();
        expect(current.cliCanaryHandledOutcomes).toBeUndefined();
    });

    it('host paths в публичном evidence обезличиваются до публикации', () => {
        const { args, files } = input();
        args.outcomes = [
            outcome('green', {
                reports: {
                    pinned: report('1.0.0'),
                    candidate: report('2.0.0', {
                        tools: {},
                        envelope: { fields: [], events: [{ cwd: '/tmp/private-run' }] },
                    }),
                },
            }),
        ];
        handleCliCanaryOutcomes(args);
        const fixture = files.get(`/state/pr-work/tree/${NEW_FIXTURE_PATH}`) ?? '';
        expect(fixture).not.toContain('/tmp/private-run');
        expect(fixture).toContain('/path/to/host');
        expect(args.createPullRequestFn).toHaveBeenCalledTimes(1);
    });

    it('git получает отключённые хуки, снятый git-context и минимальный env', () => {
        const { args } = input();
        args.env = {
            PATH: '/bin',
            GIT_DIR: '/other/.git',
            GIT_WORK_TREE: '/other',
            RALPH_TG_BOT_TOKEN: 'not-for-hooks',
            SOURCECRAFT_TOKEN: 'credential-for-helper',
        };
        handleCliCanaryOutcomes(args);
        const calls = args.runArgvFn.mock.calls as unknown as [
            string,
            string[],
            { env?: NodeJS.ProcessEnv } | undefined,
        ][];
        for (const [file, argv, opts] of calls) {
            expect(file).toBe('git');
            expect(argv).toContain('core.hooksPath=/dev/null');
            expect(opts?.env?.GIT_DIR).toBeUndefined();
            expect(opts?.env?.GIT_WORK_TREE).toBeUndefined();
            expect(opts?.env?.RALPH_TG_BOT_TOKEN).toBeUndefined();
            expect(opts?.env?.SOURCECRAFT_TOKEN).toBe('credential-for-helper');
        }
    });

    it('дифф инвентаря различает идентичности, примитивы, undefined и длинные значения', () => {
        const diff = inventoryDiff(
            {
                list: [{ id: 'same', value: 1 }, { name: 'gone' }, {}, null, 1],
                long: 'x'.repeat(801),
                gone: undefined,
            },
            {
                list: [{ id: 'same', value: 2 }, { name: 'new' }, null, 2],
                long: 'y',
                added: true,
            },
        );
        expect(diff).toContain('id:same');
        expect(diff).toContain('name:gone');
        expect(diff).toContain('name:new');
        expect(diff).toContain('undefined');
        expect(diff).toContain('…');
        expect(diff).toContain('inventory.added');
        const primitives = inventoryDiff([1, 2], [2, 3]);
        expect(primitives).toContain('### Убрано\n- `inventory`: 1');
        expect(primitives).toContain('3');
    });

    it('fixture содержит только фактический отчёт и отклоняет чужие харнесс или версию', () => {
        const candidate = report('2.0.0');
        expect(
            versionedStandFixture({ harness: 'codex', version: '2.0.0', report: candidate }),
        ).toEqual({ ...candidate, cliVersion: '2.0.0', assembled: false });
        expect(() =>
            versionedStandFixture({ harness: 'kimi-code', version: '2.0.0', report: candidate }),
        ).toThrow(/не совпадает/);
        expect(() =>
            versionedStandFixture({ harness: 'codex', version: '3.0.0', report: candidate }),
        ).toThrow(/не совпадает/);
    });

    it('fresh и уже обработанный исход не публикуются повторно', () => {
        const { args, current } = input();
        args.outcomes = [{ ...outcome('green'), verdict: 'fresh' }];
        handleCliCanaryOutcomes(args);
        expect(args.findOpenPullRequestFn).not.toHaveBeenCalled();
        args.outcomes = [outcome('green')];
        current.cliCanaryHandledOutcomes = { 'codex@2.0.0:green': true };
        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
    });

    it.each([
        ['имя харнесса', { harness: 'Invalid_Name' }],
        ['версия', { latestVersion: 'bad/version' }],
    ])('небезопасные %s отклоняются до git и публикации', (_what, extra) => {
        const { args, current } = input();
        args.outcomes = [outcome('green', extra)];
        expect(() => handleCliCanaryOutcomes(args)).not.toThrow();
        expect(args.runArgvFn).not.toHaveBeenCalled();
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(current.cliCanaryHandledOutcomes).toBeUndefined();
        expect(args.logFn).toHaveBeenCalledWith(expect.stringContaining('небезопасное имя'));
    });

    it.each(['green', 'drift'] as const)(
        '%s без обязательных отчётов не публикуется',
        (verdict) => {
            const { args, current } = input();
            args.outcomes = [outcome(verdict, { reports: undefined })];
            expect(() => handleCliCanaryOutcomes(args)).not.toThrow();
            expect(args.createIssueFn).not.toHaveBeenCalled();
            expect(args.createPullRequestFn).not.toHaveBeenCalled();
            expect(current.cliCanaryHandledOutcomes).toBeUndefined();
        },
    );

    it('отказ сообщения коммита останавливает PR до записи', () => {
        const { args, current } = input();
        args.checkCommitMessageFn = vi.fn(() => ({ ok: false, reason: 'плохое сообщение' }));
        handleCliCanaryOutcomes(args);
        expect(args.writeFileFn).not.toHaveBeenCalled();
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(current.cliCanaryHandledOutcomes).toBeUndefined();
        expect(args.logFn).toHaveBeenCalledWith(expect.stringContaining('плохое сообщение'));
    });

    it('descriptor без закреплённой версии отклоняется до записи', () => {
        const { args, files, current } = input();
        files.set(`/state/pr-work/tree/${DESCRIPTOR_PATH}`, DESCRIPTOR.replace('1.0.0', '9.9.9'));
        handleCliCanaryOutcomes(args);
        expect(args.writeFileFn).not.toHaveBeenCalled();
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(current.cliCanaryHandledOutcomes).toBeUndefined();
    });

    it('лишний файл в staged diff отклоняет PR', () => {
        const { args, current } = input();
        args.runArgvFn = vi.fn((file: string, argv: string[]) =>
            argv.includes('diff') ? 'unexpected.ts' : '',
        );
        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).not.toHaveBeenCalled();
        expect(current.cliCanaryHandledOutcomes).toBeUndefined();
        expect(args.logFn).toHaveBeenCalledWith(expect.stringContaining('unexpected.ts'));
    });

    it('ошибка уборки временного дерева названа, но не отменяет уже созданный PR', () => {
        const { args } = input();
        args.removeDirFn = vi.fn(() => {
            throw new Error('cleanup failed');
        });
        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).toHaveBeenCalledTimes(1);
        expect(args.logFn).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));
    });

    it('форж без номера карточки и PR не превращается в ошибку публикации', () => {
        const { args, current } = input();
        args.createIssueFn = vi.fn(() => null) as never;
        args.outcomes = [outcome('red')];
        handleCliCanaryOutcomes(args);
        args.createPullRequestFn = vi.fn(() => null) as never;
        args.outcomes = [outcome('green')];
        handleCliCanaryOutcomes(args);
        expect(current.cliCanaryHandledOutcomes).toEqual({
            'codex@2.0.0:red': true,
            'codex@2.0.0:green': true,
        });
        expect(args.logFn).toHaveBeenCalledWith(expect.stringContaining('(номер не отдан форжем)'));
    });

    it('новый итог той же версии обрабатывается, а отказ публикации не запоминается и не останавливает петлю', () => {
        const { args, current } = input();
        args.createIssueFn = vi.fn(() => {
            throw new Error('forge unavailable');
        });
        args.outcomes = [
            outcome('red', { failedProbes: [{ name: 'block', verdict: 'FAIL', detail: 'bad' }] }),
        ];
        expect(() => handleCliCanaryOutcomes(args)).not.toThrow();
        expect(current.cliCanaryHandledOutcomes).toBeUndefined();

        args.createIssueFn = vi.fn(() => 101);
        handleCliCanaryOutcomes(args);
        expect(args.createIssueFn).toHaveBeenCalledTimes(1);
        args.outcomes = [outcome('green')];
        handleCliCanaryOutcomes(args);
        expect(args.createPullRequestFn).toHaveBeenCalledTimes(1);
        expect(current.cliCanaryHandledOutcomes).toEqual({
            'codex@2.0.0:red': true,
            'codex@2.0.0:green': true,
        });
    });

    it.each([
        [
            'codex',
            [path.join(path.dirname(harnessDescriptorPath('codex')), 'stand-fixtures.test.ts')],
        ],
        [
            'kimi-code',
            [path.join(path.dirname(harnessDescriptorPath('kimi-code')), 'stand-fixtures.test.ts')],
        ],
        [
            'opencode',
            [
                path.join(path.dirname(harnessDescriptorPath('opencode')), 'event.test.ts'),
                path.join(
                    path.dirname(harnessDescriptorPath('opencode')),
                    'stand-session-home.test.ts',
                ),
            ],
        ],
    ])(
        'исторические сьюты и контракт свежего fixture %s проходят раздельно',
        (harness, suites) => {
            const repo = path.resolve(import.meta.dirname, '..');
            const descriptorPath = path.join(repo, harnessDescriptorPath(harness));
            const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as {
                cliVersion: string;
            };
            const candidate = { ...report('2.0.0'), harness };
            candidate.probes = reportProbeNames(harness).map((name) => ({
                name,
                verdict: 'PASS',
                detail: 'ok',
            }));
            const fixture = versionedStandFixture({
                harness,
                version: '2.0.0',
                report: candidate,
            });
            const root = mkdtempSync(path.join(tmpdir(), 'ralph-generated-fixture-'));
            temporaryDirs.push(root);
            for (const directory of ['adapters', 'provision', 'shared']) {
                cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
            }
            cpSync(path.join(repo, 'vitest.config.ts'), path.join(root, 'vitest.config.ts'));
            symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
            mkdirSync(path.join(root, 'tests'), { recursive: true });
            for (const file of [
                'test-setup.ts',
                'forge-exec-guard.ts',
                'cli-canary-report-contract.test.ts',
            ]) {
                cpSync(path.join(repo, 'tests', file), path.join(root, 'tests', file));
            }
            writeFileSync(
                path.join(root, harnessDescriptorPath(harness)),
                JSON.stringify({ ...descriptor, cliVersion: '2.0.0' }, null, 4),
            );
            const output = path.join(root, standFixturePath(harness, '2.0.0'));
            mkdirSync(path.dirname(output), { recursive: true });
            writeFileSync(output, JSON.stringify(fixture, null, 2));
            const verify = (args: string[]) =>
                execFileSync(
                    process.execPath,
                    [
                        path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'),
                        '--root',
                        root,
                        'run',
                        ...args,
                    ],
                    { cwd: root, encoding: 'utf8', env: process.env, timeout: 20_000 },
                );
            const result = () => {
                verify(['--dir', 'tests']);
                verify([...suites]);
            };
            expect(result).not.toThrow();
        },
        25_000,
    );

    it('snapshot текущей версии с protocol:0 роняет настоящий contract-suite', () => {
        const repo = path.resolve(import.meta.dirname, '..');
        const harness = 'kimi-code';
        const descriptor = JSON.parse(
            readFileSync(path.join(repo, harnessDescriptorPath(harness)), 'utf8'),
        ) as { cliVersion: string };
        const candidate = { ...report(descriptor.cliVersion), harness };
        candidate.probes = reportProbeNames(harness).map((name) => ({
            name,
            verdict: 'PASS',
            detail: 'ok',
        }));
        const fixture = versionedStandFixture({
            harness,
            version: descriptor.cliVersion,
            report: candidate,
        });
        fixture.protocol = 0;
        const root = mkdtempSync(path.join(tmpdir(), 'ralph-invalid-contract-'));
        temporaryDirs.push(root);
        for (const directory of ['adapters', 'provision', 'shared']) {
            cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
        }
        cpSync(path.join(repo, 'vitest.config.ts'), path.join(root, 'vitest.config.ts'));
        symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
        mkdirSync(path.join(root, 'tests'), { recursive: true });
        for (const file of [
            'test-setup.ts',
            'forge-exec-guard.ts',
            'cli-canary-report-contract.test.ts',
        ]) {
            cpSync(path.join(repo, 'tests', file), path.join(root, 'tests', file));
        }
        const output = path.join(root, standFixturePath(harness, descriptor.cliVersion));
        mkdirSync(path.dirname(output), { recursive: true });
        writeFileSync(output, JSON.stringify(fixture, null, 2));

        let failure: { status?: number; stdout?: string; stderr?: string } | undefined;
        try {
            execFileSync(
                process.execPath,
                [
                    path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'),
                    '--root',
                    root,
                    'run',
                    '--dir',
                    'tests',
                ],
                { cwd: root, encoding: 'utf8', env: process.env, timeout: 20_000 },
            );
        } catch (error) {
            failure = error as typeof failure;
        }
        expect(failure).toMatchObject({ status: 1 });
        expect(`${failure?.stdout ?? ''}${failure?.stderr ?? ''}`).toContain('protocol');
    }, 25_000);

    const temporaryDirs: string[] = [];
    afterEach(() => {
        for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('настоящий git: два изменения, predecessor сохранён, дерево петли на main', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'ralph-cli-actions-'));
        temporaryDirs.push(root);
        const remote = path.join(root, 'remote.git');
        const main = path.join(root, 'main');
        const env = {
            ...process.env,
            HOME: path.join(root, 'home'),
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
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
            }).trim();
        const git = (cwd: string, args: string[]) => run('git', ['-C', cwd, ...args]);
        mkdirSync(main, { recursive: true });
        git(root, ['init', '--bare', remote]);
        git(root, ['init', '-b', 'main', main]);
        git(main, ['config', 'user.name', 'Ralph Test']);
        git(main, ['config', 'user.email', 'ralph@example.com']);
        mkdirSync(path.join(main, path.dirname(DESCRIPTOR_PATH)), { recursive: true });
        mkdirSync(path.join(main, path.dirname(OLD_FIXTURE_PATH)), { recursive: true });
        writeFileSync(path.join(main, DESCRIPTOR_PATH), DESCRIPTOR);
        writeFileSync(path.join(main, OLD_FIXTURE_PATH), BASELINE);
        git(main, ['add', '.']);
        git(main, ['commit', '-m', 'chore: начальное состояние']);
        git(main, ['remote', 'add', 'origin', remote]);
        git(main, ['push', '-u', 'origin', 'main']);
        const hooks = path.join(root, 'hooks');
        mkdirSync(hooks);
        for (const name of ['post-checkout', 'pre-commit', 'commit-msg', 'pre-push']) {
            writeFileSync(
                path.join(hooks, name),
                `#!/bin/sh\necho called >> ${root}/hook-called\nenv > ${root}/hook-env\n`,
                { mode: 0o755 },
            );
        }
        git(main, ['config', 'core.hooksPath', hooks]);

        const { args, current } = input();
        const canaryRoot = path.join(root, 'canary');
        mkdirSync(canaryRoot, { recursive: true });
        Object.assign(args, {
            consumerRoot: main,
            canaryRoot,
            env: { ...env, GIT_DIR: path.join(root, 'other.git'), GIT_WORK_TREE: root },
            runArgvFn: run,
            mkdtempFn: (prefix: string) => mkdtempSync(prefix),
            readFileFn: (file: string) => readFileSync(file, 'utf8'),
            existsFn: (file: string) => existsSync(file),
            writeFileFn: (file: string, text: string) => writeFileSync(file, text),
            removeFileFn: (file: string) => rmSync(file, { force: true }),
            removeDirFn: (dir: string) => rmSync(dir, { recursive: true, force: true }),
        });
        handleCliCanaryOutcomes(args);

        const sha = run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/cli/codex-2.0.0']);
        const changes = run('git', [
            '--git-dir',
            remote,
            'diff-tree',
            '--no-commit-id',
            '--name-status',
            '-r',
            sha,
        ])
            .split('\n')
            .sort();
        expect(changes).toEqual([`A\t${NEW_FIXTURE_PATH}`, `M\t${DESCRIPTOR_PATH}`]);
        expect(run('git', ['--git-dir', remote, 'show', `main:${OLD_FIXTURE_PATH}`])).toContain(
            'pinned-only',
        );
        expect(run('git', ['--git-dir', remote, 'show', `${sha}:${DESCRIPTOR_PATH}`])).toContain(
            '"cliVersion": "2.0.0"',
        );
        expect(readFileSync(path.join(main, DESCRIPTOR_PATH), 'utf8')).toBe(DESCRIPTOR);
        expect(git(main, ['status', '--porcelain'])).toBe('');
        expect(git(main, ['branch', '--show-current'])).toBe('main');
        expect(git(main, ['worktree', 'list', '--porcelain'])).not.toContain('version-pr-');
        expect(args.createPullRequestFn).toHaveBeenCalledTimes(1);
        expect(existsSync(path.join(root, 'hook-called'))).toBe(false);
        expect(existsSync(path.join(root, 'hook-env'))).toBe(false);
        expect(current.cliCanaryHandledOutcomes).toEqual({ 'codex@2.0.0:green': true });
    });
});

import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    CliCanaryInfrastructureError,
    fetchLatestCliVersion,
    runStandReport,
} from './cli-canary.ts';

const distribution = { registry: 'npm' as const, package: 'example-cli', bin: 'bin/cli.js' };

describe('команды канарейки CLI (#264)', () => {
    it('последняя версия читается из реестра пакета с остатком бюджета', () => {
        const execFn = vi.fn(() => '2.4.0\n');
        expect(fetchLatestCliVersion({ distribution, timeoutMs: 12_345, execFn })).toBe('2.4.0');
        expect(execFn).toHaveBeenCalledWith(
            'npm',
            ['view', 'example-cli', 'version'],
            expect.objectContaining({ timeoutMs: 12_345 }),
        );
    });

    it('пустой или многострочный ответ реестра — отказ, а не угаданная версия', () => {
        for (const output of ['', '1.0.0\n2.0.0\n']) {
            expect(() =>
                fetchLatestCliVersion({ distribution, timeoutMs: 1000, execFn: () => output }),
            ).toThrow(/верси/i);
        }
    });

    it('отчёт исполняется стендом из ядра, без секретов окружения и с бюджетом', () => {
        const report = {
            protocol: 1,
            harness: 'codex',
            version: '2.0.0',
            inventory: { tools: [] },
            probes: [{ name: 'block', verdict: 'PASS', detail: 'ok' }],
        };
        const execFn = vi.fn(() => '');
        const rmFn = vi.fn();
        const result = runStandReport({
            coreRoot: '/path/to/core',
            harness: 'codex',
            version: '2.0.0',
            cliBin: '/state/cli-canary/codex/2.0.0/bin/cli.js',
            timeoutMs: 9_876,
            env: { PATH: '/bin', OPENAI_API_KEY: 'secret', CUSTOM_TOKEN: 'secret' },
            execFn,
            mkdtempFn: () => '/tmp/stand-report',
            readFileFn: () => JSON.stringify(report),
            rmFn,
        });
        expect(result).toEqual(report);
        expect(execFn).toHaveBeenCalledWith(
            'timeout',
            [
                '--kill-after=30s',
                '10s',
                process.execPath,
                '/path/to/core/provision/stand/stand.mts',
                'report',
                '--harness',
                'codex',
                '--version',
                '2.0.0',
                '--cli-bin',
                '/state/cli-canary/codex/2.0.0/bin/cli.js',
                '--report',
                '/tmp/stand-report/report.json',
            ],
            expect.objectContaining({
                timeoutMs: 9_876,
                killAfterMs: 60_000,
                env: { PATH: '/bin' },
            }),
        );
        expect(rmFn).toHaveBeenCalledWith('/tmp/stand-report');
    });

    it.each(['isolation', 'spawn', 'output-limit', 'timeout'] as const)(
        'инфраструктурный отчёт %s — typed error, а не отчёт кандидата',
        (kind) => {
            const execFn = vi.fn(() => {
                throw Object.assign(new Error('exit 2'), { status: 2 });
            });
            try {
                runStandReport({
                    coreRoot: '/path/to/core',
                    harness: 'codex',
                    version: '2.0.0',
                    cliBin: '/state/cli/bin',
                    timeoutMs: 1000,
                    execFn,
                    mkdtempFn: () => '/tmp/stand-report',
                    readFileFn: () =>
                        JSON.stringify({
                            protocol: 1,
                            harness: 'codex',
                            version: '2.0.0',
                            inventory: {},
                            probes: [],
                            infrastructure: { kind, reason: 'stand refused' },
                        }),
                    rmFn: () => {},
                });
                expect.unreachable();
            } catch (error) {
                expect(error).toBeInstanceOf(CliCanaryInfrastructureError);
                expect(error).toMatchObject({ kind, message: 'stand refused' });
            }
        },
    );

    it('неизвестная infrastructure не подменяет отчёт; отказ запуска без отчёта — spawn', () => {
        const report = {
            protocol: 1,
            infrastructure: { kind: 'other', reason: 42 },
            probes: [],
        };
        expect(
            runStandReport({
                coreRoot: '/path/to/core',
                harness: 'codex',
                version: '2.0.0',
                cliBin: '/state/cli/bin',
                timeoutMs: 1000,
                execFn: () => '',
                mkdtempFn: () => '/tmp/stand-report',
                readFileFn: () => JSON.stringify(report),
                rmFn: () => {},
            }),
        ).toEqual(report);
        expect(() =>
            runStandReport({
                coreRoot: '/path/to/core',
                harness: 'codex',
                version: '2.0.0',
                cliBin: '/state/cli/bin',
                timeoutMs: 1000,
                execFn: () => {
                    throw 'spawn failed';
                },
                mkdtempFn: () => '/tmp/stand-report',
                readFileFn: () => {
                    throw new Error('ENOENT');
                },
                rmFn: () => {},
            }),
        ).toThrow(expect.objectContaining({ kind: 'spawn', message: 'spawn failed' }));
    });

    it.each([124, 137])('код внешнего дедлайна %s без отчёта — timeout', (status) => {
        expect(() =>
            runStandReport({
                coreRoot: '/path/to/core',
                harness: 'codex',
                version: '2.0.0',
                cliBin: '/state/cli/bin',
                timeoutMs: 1000,
                execFn: () => {
                    throw Object.assign(new Error('deadline'), { status });
                },
                mkdtempFn: () => '/tmp/stand-report',
                readFileFn: () => {
                    throw new Error('ENOENT');
                },
                rmFn: () => {},
            }),
        ).toThrow(expect.objectContaining({ kind: 'timeout' }));
    });

    it('дедлайн без отчёта — timeout; ненулевой код с отчётом кандидата читается', () => {
        const base = {
            coreRoot: '/path/to/core',
            harness: 'codex',
            version: '2.0.0',
            cliBin: '/state/cli/bin',
            mkdtempFn: () => '/tmp/stand-report',
            rmFn: () => {},
        };
        try {
            runStandReport({
                ...base,
                timeoutMs: 1000,
                execFn: () => {
                    throw Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' });
                },
                readFileFn: () => {
                    throw new Error('ENOENT');
                },
            });
            expect.unreachable();
        } catch (error) {
            expect(error).toMatchObject({ kind: 'timeout' });
        }
        const report = { protocol: 1, probes: [] };
        expect(
            runStandReport({
                ...base,
                timeoutMs: 1000,
                execFn: () => {
                    throw Object.assign(new Error('exit 1'), { status: 1 });
                },
                readFileFn: () => JSON.stringify(report),
            }),
        ).toEqual(report);
    });

    it.each([{ status: 124 }, { status: 137 }, { signal: 'SIGTERM' }, { code: 'ETIMEDOUT' }])(
        'дедлайн $status$signal$code с готовым report — timeout без чтения отчёта',
        (failure) => {
            const readFileFn = vi.fn(() =>
                JSON.stringify({
                    protocol: 1,
                    harness: 'codex',
                    version: '2.0.0',
                    inventory: {},
                    probes: [],
                }),
            );
            expect(() =>
                runStandReport({
                    coreRoot: '/path/to/core',
                    harness: 'codex',
                    version: '2.0.0',
                    cliBin: '/state/cli/bin',
                    timeoutMs: 1000,
                    execFn: () => {
                        throw Object.assign(new Error('deadline'), failure);
                    },
                    mkdtempFn: () => '/tmp/stand-report',
                    readFileFn,
                    rmFn: () => {},
                }),
            ).toThrow(expect.objectContaining({ kind: 'timeout' }));
            expect(readFileFn).not.toHaveBeenCalled();
        },
    );

    it('дедлайн без message остаётся типизированным timeout', () => {
        expect(() =>
            runStandReport({
                coreRoot: '/path/to/core',
                harness: 'codex',
                version: '2.0.0',
                cliBin: '/state/cli/bin',
                timeoutMs: 1000,
                execFn: () => {
                    throw { status: 124 };
                },
                mkdtempFn: () => '/tmp/stand-report',
                readFileFn: vi.fn(),
                rmFn: () => {},
            }),
        ).toThrow(expect.objectContaining({ kind: 'timeout', message: '[object Object]' }));
    });

    it('внешний дедлайн эскалирует TERM-игнорирующую группу defaultSpawn в SIGKILL', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'ralph-canary-timeout.'));
        const standDir = path.join(root, 'provision', 'stand');
        mkdirSync(standDir, { recursive: true });
        const pidFile = path.join(root, 'child.pid');
        const grandchildPidFile = path.join(root, 'grandchild.pid');
        const reportModule = path.join(
            import.meta.dirname,
            '..',
            'provision',
            'stand',
            'report.mts',
        );
        writeFileSync(
            path.join(standDir, 'stand.mts'),
            `import { defaultSpawn } from ${JSON.stringify(reportModule)};
const script = \`
trap '' TERM
echo $$ > "$STAND_TEST_PID"
${JSON.stringify(process.execPath)} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)' &
echo $! > "$STAND_TEST_GRANDCHILD_PID"
wait
\`;
await defaultSpawn(['bash', '-c', script], { env: process.env, cwd: ${JSON.stringify(root)} })
  .catch(() => new Promise(() => {}));
`,
        );
        const source = `import { runStandReport } from ${JSON.stringify(path.join(import.meta.dirname, 'cli-canary.ts'))};
try {
  await runStandReport({ coreRoot: ${JSON.stringify(root)}, harness: 'codex', version: '2.0.0', cliBin: ${JSON.stringify(path.join(standDir, 'stand.mts'))}, timeoutMs: 100 });
} catch (error) {
  if (error?.kind === 'timeout') process.exit(0);
  console.error(error);
}
process.exit(1);`;
        let pids: number[] = [];
        // После SIGKILL сирота может остаться зомби под непожинающим PID 1 контейнера CI;
        // kill(pid, 0) при этом успешен, поэтому живость судим по состоянию из /proc.
        const alive = (pid: number) => {
            try {
                const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
                const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
                return state !== 'Z' && state !== 'X';
            } catch {
                return false;
            }
        };
        try {
            const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
                encoding: 'utf8',
                timeout: 10_000,
                env: {
                    PATH: process.env.PATH ?? '',
                    HOME: root,
                    STAND_TEST_PID: pidFile,
                    STAND_TEST_GRANDCHILD_PID: grandchildPidFile,
                },
            });
            expect(
                result.status,
                `${result.stdout}${result.stderr}${String(result.error ?? '')}`,
            ).toBe(0);
            pids = [pidFile, grandchildPidFile].map((file) => Number(readFileSync(file, 'utf8')));
            expect(pids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
            for (let i = 0; i < 40 && pids.some(alive); i++) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            }
            expect(pids.map(alive)).toEqual([false, false]);
        } finally {
            for (const pid of pids.filter(alive)) {
                try {
                    process.kill(-pid, 'SIGKILL');
                } catch {}
                try {
                    process.kill(pid, 'SIGKILL');
                } catch {}
            }
            rmSync(root, { recursive: true, force: true });
        }
    });
});

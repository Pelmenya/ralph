import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    defaultSpawn,
    REPORT_MATRIX_PROBES,
    REPORT_OUTPUT_LIMIT,
    inventoryFromEvidence,
    parseReportArgs,
    reportEnvProblems,
    reportVersionProbe,
    runStandReport,
} from './report.mts';

const cleanups: string[] = [];
afterEach(() => {
    for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ralph-report-test.'));
    cleanups.push(d);
    return d;
}

function providerJournal(root: string): void {
    const body = JSON.stringify({
        messages: [{ role: 'user', content: 'go' }],
        tools: [
            {
                type: 'function',
                function: {
                    name: 'Bash',
                    parameters: {
                        properties: { command: { type: 'string' }, timeout: { type: 'number' } },
                        required: ['command'],
                    },
                },
            },
        ],
    });
    writeFileSync(
        join(root, 'provider.jsonl'),
        JSON.stringify({ method: 'POST', url: '/v1/chat/completions', body }) + '\n',
    );
}

function eventEvidence(root: string): void {
    writeFileSync(
        join(root, 'evidence', 'unknown-tool-events.jsonl'),
        JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'touch ralph-stand-forbidden' },
        }) + '\n',
    );
}

describe('разбор команды отчёта стенда', () => {
    it('принимает харнесс, версию, копию и файл; лишнее отвергает', () => {
        expect(
            parseReportArgs([
                '--harness',
                'kimi-code',
                '--version',
                '2.4.0',
                '--cli-bin',
                '/canary/kimi',
                '--report',
                '/canary/report.json',
            ]),
        ).toMatchObject({ harness: 'kimi-code', version: '2.4.0' });
        expect(() => parseReportArgs(['--harness', 'unknown'])).toThrow(/харнесс/);
        expect(() => parseReportArgs([])).toThrow(/--harness/);
        expect(() => parseReportArgs(['--harness', 'kimi-code'])).toThrow(/--version/);
    });

    it('называет секреты без их значений до любого запуска', () => {
        expect(
            reportEnvProblems(
                { PATH: '/bin', OPENAI_API_KEY: 'do-not-print', OPENCODE_PURE: '1' },
                ['OPENCODE_PURE'],
            ),
        ).toEqual(['OPENAI_API_KEY', 'OPENCODE_PURE']);
    });
});

describe('строгая версия копии', () => {
    it.each([
        ['claude', '2.1.3 (Claude Code)', '2.1.3', 'PASS'],
        ['claude', '2.1.30 (Claude Code)', '2.1.3', 'FAIL'],
        ['codex', 'codex-cli 1.2.3', '1.2.3', 'PASS'],
        ['codex', 'codex-cli 1.2.3-other', '1.2.3', 'FAIL'],
        ['kimi', '1.2.3', '1.2.3', 'PASS'],
        ['kimi', 'kimi 1.2.30', '1.2.3', 'FAIL'],
        ['opencode', '1.2.3', '1.2.3', 'PASS'],
        ['opencode', '1.2.3-other', '1.2.3', 'FAIL'],
    ])('%s: %s', (cli, line, expected, verdict) => {
        expect(reportVersionProbe(cli, line, expected).verdict).toBe(verdict);
    });
});

describe('форма инвентаря по харнессам', () => {
    it('Codex сохраняет Responses tools, additionalTools, вложенные имена и конверт', () => {
        const root = tmp();
        mkdirSync(join(root, 'evidence'));
        eventEvidence(root);
        const body = JSON.stringify({
            input: [
                {
                    type: 'additional_tools',
                    tools: [{ namespace: 'functions', tools: [{ type: 'custom', name: 'exec' }] }],
                },
            ],
            tools: [],
            schema: 'tools.exec_command и tools.apply_patch',
        });
        const inventory = inventoryFromEvidence({
            cli: 'codex',
            harness: 'codex',
            version: '1.2.3',
            providerText: JSON.stringify({ method: 'POST', body }) + '\n',
            eventFiles: [join(root, 'evidence', 'unknown-tool-events.jsonl')],
        });
        expect(inventory).toEqual([
            expect.objectContaining({
                cliVersion: '1.2.3',
                additionalTools: [
                    { namespace: 'functions', tools: [{ type: 'custom', name: 'exec' }] },
                ],
                codeModeNested: ['apply_patch', 'exec_command'],
                envelope: expect.objectContaining({
                    fields: expect.arrayContaining(['tool_input']),
                }),
            }),
        ]);
    });

    it('OpenCode получает набор инструментов своей модели, как в фикстуре стенда', () => {
        const root = tmp();
        mkdirSync(join(root, 'evidence'));
        providerJournal(root);
        eventEvidence(root);
        const inventory = inventoryFromEvidence({
            cli: 'opencode',
            harness: 'opencode',
            version: '1.2.3',
            providerText: readFileSync(join(root, 'provider.jsonl'), 'utf8'),
            eventFiles: [join(root, 'evidence', 'unknown-tool-events.jsonl')],
        });
        expect(inventory).toMatchObject({
            models: { stand: { Bash: { properties: ['command', 'timeout'] } } },
            envelope: { fields: ['hook_event_name', 'tool_input', 'tool_name'] },
        });
    });

    it.each(Object.entries(REPORT_MATRIX_PROBES))(
        '%s: установка, guard и короткая сессия',
        (_cli, probes) => {
            expect(probes).toEqual(
                expect.arrayContaining([
                    'block',
                    'merge',
                    'session-context',
                    'unknown-tool',
                    'symlink-env',
                    'symlink-parent',
                    'move-dir',
                    'search-root',
                    'search-glob',
                    'search-deep-glob',
                    'search-clean',
                    'mcp-write',
                    'mcp-env-param',
                    'mcp-read',
                    'short-session',
                ]),
            );
        },
    );
});

describe('отчёт версии CLI', () => {
    it('собирает инвентарь и всю матрицу на фиктивном провайдере, не меняя копию и PATH', async () => {
        const parent = tmp();
        const root = join(parent, 'work');
        mkdirSync(root);
        const candidate = join(parent, 'candidate');
        const system = join(parent, 'system');
        writeFileSync(candidate, 'candidate-binary\n');
        writeFileSync(system, 'system-binary\n');
        const output = join(parent, 'report.json');
        const calls: { argv: readonly string[]; env: Record<string, string> }[] = [];
        let closed = false;

        const report = await runStandReport(
            {
                harness: 'kimi-code',
                version: '9.8.7',
                cliBin: candidate,
                report: output,
            },
            {
                env: { PATH: parent, HOME: parent, OPENAI_API_KEY: undefined },
                mkdtempFn: () => root,
                rmFn: () => {},
                startProviderFn: async () => ({
                    port: 19001,
                    close: async () => {
                        closed = true;
                    },
                }),
                spawnFn: async (argv, { env }) => {
                    calls.push({ argv, env });
                    providerJournal(root);
                    eventEvidence(root);
                    return {
                        status: 0,
                        stdout:
                            'версия: 9.8.7\n' +
                            REPORT_MATRIX_PROBES.kimi
                                .map((name) => `RESULT kimi ${name} PASS — ok`)
                                .join('\n'),
                        stderr: '',
                    };
                },
            },
        );

        expect(report).toMatchObject({ protocol: 1, harness: 'kimi-code', version: '9.8.7' });
        expect(report.inventory).toMatchObject({
            tools: { Bash: { properties: ['command', 'timeout'], required: ['command'] } },
            envelope: { fields: ['hook_event_name', 'tool_input', 'tool_name'] },
        });
        expect(report.probes.map((p) => p.name)).toEqual(
            expect.arrayContaining(['version', 'inventory', 'stand', 'short-session', 'mcp-write']),
        );
        expect(report.probes.every((p) => p.verdict === 'PASS')).toBe(true);
        expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report);
        expect(readFileSync(candidate, 'utf8')).toBe('candidate-binary\n');
        expect(readFileSync(system, 'utf8')).toBe('system-binary\n');
        expect(existsSync(join(parent, 'executed-on-host'))).toBe(false);
        expect(closed).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls[0].argv.slice(0, 3)).toEqual([
            process.execPath,
            join(import.meta.dirname, 'stand.mts'),
            'check',
        ]);
        expect(calls[1].argv.slice(0, 4)).toEqual([
            'bash',
            join(import.meta.dirname, '..', 'install-stand.sh'),
            'kimi',
            'block',
        ]);
        expect(calls[1].argv).toContain('short-session');
        expect(calls[1].env.STAND_BIN).toBe(candidate);
        expect(calls[1].env.STAND_FAKE_PROVIDER).toBe('1');
        expect(calls[1].env.STAND_FAKE_EXTERNAL).toBe('1');
        expect(calls[1].env.STAND_ISOLATE).toBe('1');
        expect(calls[1].env.STAND_ISOLATE_ARGS).toContain('--tcp 127.0.0.1:19001');
        expect(calls[1].env.PATH).toBe(parent);
        expect(calls[1].env.OPENAI_API_KEY).toBeUndefined();
    });

    it('не выдаёт зелёный отчёт при INCONCLUSIVE и отсутствующем вердикте', async () => {
        const parent = tmp();
        const root = join(parent, 'work');
        mkdirSync(root);
        const candidate = join(parent, 'candidate');
        writeFileSync(candidate, 'candidate\n');
        const report = await runStandReport(
            {
                harness: 'codex',
                version: '1.2.3',
                cliBin: candidate,
                report: join(parent, 'r.json'),
            },
            {
                env: { PATH: parent },
                mkdtempFn: () => root,
                rmFn: () => {},
                startProviderFn: async () => ({ port: 19001, close: async () => {} }),
                spawnFn: async (argv) => {
                    if (argv.includes('check')) return { status: 0, stdout: '', stderr: '' };
                    providerJournal(root);
                    eventEvidence(root);
                    return {
                        status: 1,
                        stdout:
                            'версия: codex-cli 1.2.3\nRESULT codex block INCONCLUSIVE — нет вызова\n' +
                            REPORT_MATRIX_PROBES.codex
                                .filter((name) => name !== 'block' && name !== 'mcp-read')
                                .map((name) => `RESULT codex ${name} PASS — ok`)
                                .join('\n'),
                        stderr: '',
                    };
                },
            },
        );
        expect(report.probes).toEqual(
            expect.arrayContaining([
                { name: 'block', verdict: 'INCONCLUSIVE', detail: 'нет вызова' },
                expect.objectContaining({ name: 'mcp-read', verdict: 'FAIL' }),
                expect.objectContaining({ name: 'stand', verdict: 'FAIL' }),
            ]),
        );
        expect(report.probes.some((p) => p.name === 'short-session' && p.verdict === 'PASS')).toBe(
            true,
        );
    });

    it('отказ unshare на isolation check — infrastructure, матрица и провайдер не запускаются', async () => {
        const parent = tmp();
        const root = join(parent, 'work');
        mkdirSync(root);
        const candidate = join(parent, 'candidate');
        writeFileSync(candidate, 'candidate\n');
        let started = false;
        let calls = 0;
        const output = join(parent, 'infra.json');
        const report = await runStandReport(
            {
                harness: 'codex',
                version: '1.2.3',
                cliBin: candidate,
                report: output,
            },
            {
                env: { PATH: parent },
                mkdtempFn: () => root,
                rmFn: () => {},
                startProviderFn: async () => {
                    started = true;
                    return { port: 1, close: async () => {} };
                },
                spawnFn: async () => {
                    calls++;
                    return { status: 1, stdout: '', stderr: 'unshare: Operation not permitted' };
                },
            },
        );
        expect(report.infrastructure).toMatchObject({ kind: 'isolation' });
        expect(report.infrastructure?.reason).toContain('Operation not permitted');
        expect(report.probes).toEqual([]);
        expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report);
        expect(started).toBe(false);
        expect(calls).toBe(1);
    });

    it('превышение суммарного вывода убивает bash и долгоживущего внука, отказ ждёт close', async () => {
        const parent = tmp();
        const bashPidFile = join(parent, 'bash.pid');
        const grandchildPidFile = join(parent, 'grandchild.pid');
        const script = `
echo $$ > ${JSON.stringify(bashPidFile)}
${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)' &
echo $! > ${JSON.stringify(grandchildPidFile)}
${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(${String(REPORT_OUTPUT_LIMIT + 1)}))'
`;
        let bashPid = 0;
        let grandchildPid = 0;
        try {
            await expect(
                defaultSpawn(['bash', '-c', script], { env: {}, cwd: parent }),
            ).rejects.toMatchObject({ kind: 'output-limit' });
            bashPid = Number(readFileSync(bashPidFile, 'utf8'));
            grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
            expect(bashPid).toBeGreaterThan(0);
            expect(grandchildPid).toBeGreaterThan(0);
            // Убитый внук-сирота в контейнере CI может остаться зомби: PID 1 его не пожинает,
            // а kill(pid, 0) успешен. Состояние Z/X уже означает завершённый процесс.
            const alive = (pid: number) => {
                try {
                    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
                    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
                    return state !== 'Z' && state !== 'X';
                } catch {
                    return false;
                }
            };
            for (let i = 0; i < 40 && (alive(bashPid) || alive(grandchildPid)); i++) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            }
            expect({ bash: alive(bashPid), grandchild: alive(grandchildPid) }).toEqual({
                bash: false,
                grandchild: false,
            });
        } finally {
            if (bashPid > 0) {
                try {
                    process.kill(-bashPid, 'SIGKILL');
                } catch {}
            }
            if (grandchildPid > 0) {
                try {
                    process.kill(grandchildPid, 'SIGKILL');
                } catch {}
            }
        }
    });

    it('секрет в окружении — отказ до провайдера, процесса и файла отчёта', async () => {
        const parent = tmp();
        let started = false;
        let spawned = false;
        await expect(
            runStandReport(
                {
                    harness: 'opencode',
                    version: '2.0.0',
                    cliBin: join(parent, 'cli'),
                    report: join(parent, 'report.json'),
                },
                {
                    env: { PATH: parent, OPENCODE_PURE: '1', KIMI_API_KEY: 'never-print' },
                    startProviderFn: async () => {
                        started = true;
                        return { port: 1, close: async () => {} };
                    },
                    spawnFn: async () => {
                        spawned = true;
                        return { status: 0, stdout: '', stderr: '' };
                    },
                },
            ),
        ).rejects.toThrow(/OPENCODE_PURE.*KIMI_API_KEY|KIMI_API_KEY.*OPENCODE_PURE/);
        expect(started).toBe(false);
        expect(spawned).toBe(false);
        expect(existsSync(join(parent, 'report.json'))).toBe(false);
    });
});

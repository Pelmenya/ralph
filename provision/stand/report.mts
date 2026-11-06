/**
 * Машиночитаемый отчёт одной копии CLI (#263, Фаза 24).
 *
 * Кандидат никогда не исполняется на хосте: установочный стенд получает его абсолютный путь и
 * монтирует через `stand.mts exec --cli-bin`. Провайдер работает на хосте без ключа, а внутрь
 * изоляции ведёт TCP-мост ровно к его loopback-адресу. Поэтому журнал запросов, из которого
 * снимается инвентарь, находится вне досягаемости проверяемого CLI. Конверты событий выносит
 * тем же `evidence`, что улики остальных проб стенда.
 */
import { spawn } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { LOOP_KEY_ENVS } from '../../adapters/live-probe-cases.ts';
import { RUNTIME_IDENTITIES } from '../../adapters/runtime-profile.ts';
import { startFakeProvider } from './fake-provider.mts';

const CANON_ROOT = resolve(import.meta.dirname, '..', '..');
const INSTALL_STAND = join(CANON_ROOT, 'provision', 'install-stand.sh');

const HARNESS_CLI: Readonly<Record<string, string>> = {
    claude: 'claude',
    'claude-code': 'claude',
    codex: 'codex',
    kimi: 'kimi',
    'kimi-code': 'kimi',
    opencode: 'opencode',
};

const DESCRIPTOR_HARNESS: Readonly<Record<string, string>> = {
    claude: 'claude-code',
    codex: 'codex',
    kimi: 'kimi-code',
    opencode: 'opencode',
};

const EVENT_GUARDS = [
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
] as const;

const COMMON_PROBES = ['block', 'merge', 'session-context', ...EVENT_GUARDS, 'short-session'];

/**
 * Старые override/crash дают SKIP или FAIL-CLOSED там, где это нормальное поведение CLI; канарейка
 * признаёт только PASS, поэтому не подменяет их ложным зелёным. Guard-матрица входит полностью.
 */
export const REPORT_MATRIX_PROBES: Readonly<Record<string, readonly string[]>> = {
    claude: [
        'block',
        'override',
        'merge',
        'session-context',
        ...EVENT_GUARDS,
        'project-hook',
        'project-mcp',
        'short-session',
    ],
    codex: COMMON_PROBES,
    kimi: COMMON_PROBES,
    opencode: COMMON_PROBES,
};

export function reportProbeNames(harness: string): string[] {
    const cli = HARNESS_CLI[harness];
    if (!cli) throw new Error(`отчёт стенда: неизвестный харнесс ${harness}`);
    return ['version', 'inventory', ...REPORT_MATRIX_PROBES[cli], 'stand'];
}

export type TStandReportProbe = { name: string; verdict: string; detail: string };
export type StandInfrastructureKind = 'isolation' | 'spawn' | 'output-limit' | 'timeout';
export type TStandReport = {
    protocol: 1;
    harness: string;
    version: string;
    inventory: unknown;
    probes: TStandReportProbe[];
    infrastructure?: { kind: StandInfrastructureKind; reason: string };
};

export class StandInfrastructureError extends Error {
    readonly kind: StandInfrastructureKind;

    constructor(kind: StandInfrastructureKind, reason: string) {
        super(reason);
        this.name = 'StandInfrastructureError';
        this.kind = kind;
    }
}

export type TReportArgs = { harness: string; version: string; cliBin: string; report: string };

export function parseReportArgs(argv: readonly string[]): TReportArgs {
    const out = { harness: '', version: '', cliBin: '', report: '' };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--'))
            throw new Error(`stand report: у ${flag} нет значения`);
        i++;
        if (flag === '--harness') {
            if (!(value in HARNESS_CLI))
                throw new Error(`stand report: неизвестный харнесс ${value}`);
            out.harness = value;
        } else if (flag === '--version') out.version = value;
        else if (flag === '--cli-bin' || flag === '--cli-copy') out.cliBin = value;
        else if (flag === '--report') out.report = value;
        else throw new Error(`stand report: незнакомый флаг ${flag}`);
    }
    if (!out.harness) throw new Error('stand report: нужен --harness');
    if (!out.version.trim()) throw new Error('stand report: нужен --version');
    if (!out.cliBin) throw new Error('stand report: нужен --cli-bin');
    if (!out.report) throw new Error('stand report: нужен --report');
    return {
        harness: out.harness,
        version: out.version,
        cliBin: resolve(out.cliBin),
        report: resolve(out.report),
    };
}

/** Имена, не значения: отказ безопасно печатать в журнал канарейки. */
export function reportEnvProblems(
    env: NodeJS.ProcessEnv,
    forbiddenEnv: readonly string[],
): string[] {
    const forbidden = new Set([...LOOP_KEY_ENVS, ...forbiddenEnv]);
    const secretName =
        /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|TOKEN|SECRET(?:_KEY)?|PRIVATE_KEY|PASSWORD|CREDENTIALS)$/i;
    return Object.keys(env)
        .filter((name) => env[name] !== undefined && (forbidden.has(name) || secretName.test(name)))
        .sort();
}

export type TReportProcess = { status: number | null; stdout: string; stderr: string };
export type TReportSpawn = (
    argv: readonly string[],
    opts: { env: Record<string, string>; cwd: string },
) => Promise<TReportProcess>;

export const REPORT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const REPORT_SIGNAL_ESCALATION_MS = 250;

export const defaultSpawn: TReportSpawn = (argv, { env, cwd }) =>
    new Promise((resolvePromise, reject) => {
        const child = spawn(argv[0], argv.slice(1), {
            env,
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let size = 0;
        let failure: Error | null = null;
        let settled = false;
        let terminated = false;
        let closed = false;
        let closeStatus: number | null = null;
        let escalation: NodeJS.Timeout | null = null;
        const killGroup = (signal: NodeJS.Signals) => {
            if (child.pid === undefined) return;
            try {
                process.kill(-child.pid, signal);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
        };
        const settle = (status: number | null) => {
            if (settled) return;
            settled = true;
            if (escalation) clearTimeout(escalation);
            process.removeListener('SIGTERM', onSigterm);
            process.removeListener('SIGINT', onSigint);
            if (failure) reject(failure);
            else resolvePromise({ status, stdout, stderr });
        };
        const onSignal = (signal: 'SIGTERM' | 'SIGINT') => {
            failure ??= new StandInfrastructureError('timeout', `stand report: получен ${signal}`);
            killGroup(signal);
            if (terminated) return;
            terminated = true;
            escalation = setTimeout(() => {
                escalation = null;
                killGroup('SIGKILL');
                if (closed) settle(closeStatus);
            }, REPORT_SIGNAL_ESCALATION_MS);
        };
        const onSigterm = () => onSignal('SIGTERM');
        const onSigint = () => onSignal('SIGINT');
        process.on('SIGTERM', onSigterm);
        process.on('SIGINT', onSigint);
        const append = (stream: 'stdout' | 'stderr', chunk: unknown) => {
            if (failure) return;
            const text = String(chunk);
            size += Buffer.byteLength(text);
            if (size > REPORT_OUTPUT_LIMIT) {
                failure = new StandInfrastructureError(
                    'output-limit',
                    `stand report: суммарный вывод превысил ${String(REPORT_OUTPUT_LIMIT)} байт`,
                );
                killGroup('SIGKILL');
                return;
            }
            if (stream === 'stdout') stdout += text;
            else stderr += text;
        };
        child.stdout.on('data', (chunk) => append('stdout', chunk));
        child.stderr.on('data', (chunk) => append('stderr', chunk));
        child.on('error', (error) => {
            failure ??= error;
            killGroup('SIGKILL');
        });
        child.on('close', (status) => {
            closed = true;
            closeStatus = status;
            if (!terminated || escalation === null) settle(status);
        });
    });

export type TReportDeps = {
    env?: NodeJS.ProcessEnv;
    mkdtempFn?: (prefix: string) => string;
    rmFn?: (path: string) => void;
    startProviderFn?: typeof startFakeProvider;
    spawnFn?: TReportSpawn;
};

function jsonLines(text: string, what: string): Record<string, unknown>[] {
    return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
            try {
                const value = JSON.parse(line) as unknown;
                if (typeof value !== 'object' || value === null || Array.isArray(value))
                    throw new Error('не объект');
                return value as Record<string, unknown>;
            } catch {
                throw new Error(`stand report: битая строка ${what}`);
            }
        });
}

function toolInventory(tools: unknown, what: string): Record<string, unknown> {
    if (!Array.isArray(tools) || tools.length === 0)
        throw new Error(`stand report: ${what} не отдал инструменты`);
    const out: Record<string, unknown> = {};
    for (const raw of tools) {
        if (typeof raw !== 'object' || raw === null)
            throw new Error(`stand report: битый инструмент`);
        const tool = raw as Record<string, unknown>;
        const fn = (
            typeof tool.function === 'object' && tool.function !== null ? tool.function : tool
        ) as Record<string, unknown>;
        if (typeof fn.name !== 'string' || fn.name === '')
            throw new Error('stand report: инструмент без имени');
        const schema = (
            typeof fn.parameters === 'object' && fn.parameters !== null ? fn.parameters : {}
        ) as Record<string, unknown>;
        const properties =
            typeof schema.properties === 'object' && schema.properties !== null
                ? Object.keys(schema.properties).sort()
                : [];
        const required = Array.isArray(schema.required)
            ? schema.required.filter((x): x is string => typeof x === 'string').sort()
            : [];
        out[fn.name] = { properties, required };
    }
    return out;
}

function eventEnvelope(files: readonly string[]): {
    fields: string[];
    events: Record<string, unknown>[];
} {
    const events = files.flatMap((file) =>
        jsonLines(readFileSync(file, 'utf8'), 'конверта события'),
    );
    if (events.length === 0) throw new Error('stand report: конверт события не получен');
    const fields = [...new Set(events.flatMap((event) => Object.keys(event)))].sort();
    return { fields, events };
}

export function inventoryFromEvidence({
    cli,
    harness,
    version,
    providerText,
    eventFiles,
}: {
    cli: string;
    harness: string;
    version: string;
    providerText: string;
    eventFiles: readonly string[];
}): unknown {
    const entries = jsonLines(providerText, 'журнала провайдера');
    let request: Record<string, unknown> | undefined;
    for (const entry of entries) {
        if (entry.method !== 'POST' || typeof entry.body !== 'string') continue;
        try {
            const body = JSON.parse(entry.body) as unknown;
            if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
                request = body as Record<string, unknown>;
                break;
            }
        } catch {}
    }
    if (!request) throw new Error('stand report: запрос CLI к фиктивному провайдеру не получен');
    const envelope = eventEnvelope(eventFiles);
    const source =
        'первый запрос CLI к фиктивному провайдеру стенда и конверты событий guard; журнал провайдера записан процессом хоста';

    if (cli === 'codex') {
        const input = Array.isArray(request.input) ? request.input : [];
        const additional = input.find(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                (item as Record<string, unknown>).type === 'additional_tools',
        ) as Record<string, unknown> | undefined;
        const tools = Array.isArray(request.tools) ? request.tools : [];
        const additionalTools = additional?.tools;
        if (tools.length === 0 && !Array.isArray(additionalTools))
            throw new Error('stand report: Codex не отдал инструменты');
        const body = JSON.stringify(request);
        const codeModeNested = [
            ...new Set([...body.matchAll(/tools\.([a-z][a-z0-9_]*)/g)].map((m) => m[1])),
        ].sort();
        return [
            {
                id: 'report',
                source,
                cliVersion: version,
                model: 'gpt-6-astra',
                tools,
                inputFields: tools.length > 0 ? toolInventory(tools, 'Codex') : {},
                additionalTools: additionalTools ?? [],
                codeModeNested: codeModeNested.length > 0 ? codeModeNested : null,
                envelope,
            },
        ];
    }

    const tools = toolInventory(request.tools, harness);
    if (cli === 'opencode') return { source, models: { stand: tools }, envelope };
    return { source, tools, envelope };
}

const REPORT_RUNTIME: Readonly<Record<string, string>> = {
    claude: 'claude',
    codex: 'openai',
    kimi: 'kimi-native',
    opencode: 'opencode',
};

export function reportVersionProbe(
    cli: string,
    versionLine: string,
    expected: string,
): TStandReportProbe {
    const identity = RUNTIME_IDENTITIES[REPORT_RUNTIME[cli]];
    const actual = identity.parseVersion(versionLine);
    return actual.version === expected
        ? { name: 'version', verdict: 'PASS', detail: versionLine }
        : {
              name: 'version',
              verdict: 'FAIL',
              detail: versionLine
                  ? `копия сообщила другую версию: ${versionLine}`
                  : 'стенд не сообщил версию копии',
          };
}

function standProbes(
    output: string,
    cli: string,
    expected: readonly string[],
): TStandReportProbe[] {
    return expected.map((name) => {
        const prefix = `RESULT ${cli} ${name} `;
        const lines = output
            .split('\n')
            .map((line) => line.replace(/\r$/, ''))
            .filter((line) => line.startsWith(prefix));
        if (lines.length !== 1)
            return {
                name,
                verdict: 'FAIL',
                detail: `строк RESULT этой пробы ${lines.length}, ожидалась ровно одна`,
            };
        const match = /^(\S+) — (.*)$/.exec(lines[0].slice(prefix.length));
        if (!match) return { name, verdict: 'FAIL', detail: 'битая строка вердикта стенда' };
        return { name, verdict: match[1], detail: match[2] };
    });
}

function writeReport(path: string, report: TStandReport): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    try {
        writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

function writeInfrastructureReport(
    opts: TReportArgs,
    kind: StandInfrastructureKind,
    reason: string,
): TStandReport {
    const report: TStandReport = {
        protocol: 1,
        harness: opts.harness,
        version: opts.version,
        inventory: {},
        probes: [],
        infrastructure: { kind, reason },
    };
    writeReport(opts.report, report);
    return report;
}

export async function runStandReport(
    opts: TReportArgs,
    deps: TReportDeps = {},
): Promise<TStandReport> {
    const cli = HARNESS_CLI[opts.harness];
    if (!cli) throw new Error(`stand report: неизвестный харнесс ${opts.harness}`);
    const descriptorHarness = DESCRIPTOR_HARNESS[cli];
    const descriptor = JSON.parse(
        readFileSync(
            join(CANON_ROOT, 'adapters', 'harnesses', descriptorHarness, 'descriptor.json'),
            'utf8',
        ),
    ) as { forbiddenEnv?: string[] };
    const env = deps.env ?? process.env;
    const problems = reportEnvProblems(env, descriptor.forbiddenEnv ?? []);
    if (problems.length > 0)
        throw new Error(`stand report: запрещённое окружение: ${problems.join(', ')}`);

    // realpath читает только ссылку. Сам кандидат впервые исполняется уже после mount --bind,ro.
    const cliBin = realpathSync(opts.cliBin);
    const mkdtemp = deps.mkdtempFn ?? mkdtempSync;
    const rm = deps.rmFn ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
    const root = mkdtemp(join(tmpdir(), 'ralph-stand-report.'));
    const evidence = join(root, 'evidence');
    const providerJournal = join(root, 'provider.jsonl');
    const runDir = join(root, 'run');
    for (const dir of [join(root, 'home'), join(root, 'tmp'), runDir, evidence])
        mkdirSync(dir, { recursive: true });
    const startProvider = deps.startProviderFn ?? startFakeProvider;
    const spawnFn = deps.spawnFn ?? defaultSpawn;
    let provider: Awaited<ReturnType<typeof startFakeProvider>> | null = null;
    try {
        let isolation: TReportProcess;
        try {
            isolation = await spawnFn(
                [
                    process.execPath,
                    join(CANON_ROOT, 'provision', 'stand', 'stand.mts'),
                    'check',
                    '--human-home',
                    join(root, 'home'),
                ],
                {
                    env: {
                        PATH: env.PATH ?? '/usr/bin:/bin',
                        HOME: join(root, 'home'),
                        LANG: 'C.UTF-8',
                        TMPDIR: join(root, 'tmp'),
                    },
                    cwd: runDir,
                },
            );
        } catch (error) {
            return writeInfrastructureReport(opts, 'isolation', (error as Error).message);
        }
        if (isolation.status !== 0) {
            return writeInfrastructureReport(
                opts,
                'isolation',
                `проверка изоляции завершилась кодом ${String(isolation.status)}: ${isolation.stderr.slice(-2000)}`,
            );
        }
        provider = await startProvider({
            cli,
            probe: 'auto',
            journal: providerJournal,
            port: 0,
        });
        const bridgePort = 19000 + (process.pid % 1000);
        const childEnv: Record<string, string> = {
            PATH: env.PATH ?? '/usr/bin:/bin',
            HOME: join(root, 'home'),
            LANG: 'C.UTF-8',
            TMPDIR: join(root, 'tmp'),
            STAND_ISOLATE: '1',
            STAND_FAKE_PROVIDER: '1',
            STAND_FAKE_EXTERNAL: '1',
            STAND_FAKE_PORT: String(bridgePort),
            STAND_BIN: cliBin,
            STAND_SUBJECT_ROOT: CANON_ROOT,
            STAND_REPORT_EVIDENCE: evidence,
            STAND_ISOLATE_ARGS: `--tcp 127.0.0.1:${provider.port} --bridge-port ${bridgePort}`,
        };
        let result: TReportProcess;
        try {
            result = await spawnFn(['bash', INSTALL_STAND, cli, ...REPORT_MATRIX_PROBES[cli]], {
                env: childEnv,
                cwd: runDir,
            });
        } catch (error) {
            return writeInfrastructureReport(
                opts,
                error instanceof StandInfrastructureError ? error.kind : 'spawn',
                (error as Error).message,
            );
        } finally {
            await provider.close();
            provider = null;
        }

        const versionLine = /^версия: (.*)$/m.exec(result.stdout)?.[1] ?? '';
        const versionProbe = reportVersionProbe(cli, versionLine, opts.version);
        let inventory: unknown;
        let inventoryProbe: TStandReportProbe;
        try {
            const eventFiles = readdirSync(evidence)
                .filter((name) => name.endsWith('-events.jsonl'))
                .sort()
                .map((name) => join(evidence, name));
            inventory = inventoryFromEvidence({
                cli,
                harness: opts.harness,
                version: opts.version,
                providerText: readFileSync(providerJournal, 'utf8'),
                eventFiles,
            });
            inventoryProbe = {
                name: 'inventory',
                verdict: 'PASS',
                detail: 'инструменты, поля входа и конверт события получены',
            };
        } catch (error) {
            inventory = {
                source: 'инвентарь не снят',
                tools: {},
                envelope: { fields: [], events: [] },
            };
            inventoryProbe = {
                name: 'inventory',
                verdict: 'FAIL',
                detail: (error as Error).message,
            };
        }
        const standProbe: TStandReportProbe =
            result.status === 0
                ? { name: 'stand', verdict: 'PASS', detail: 'стенд завершился кодом 0' }
                : {
                      name: 'stand',
                      verdict: 'FAIL',
                      detail: `стенд завершился кодом ${String(result.status)}: ${result.stderr.slice(-2000)}`,
                  };
        const report: TStandReport = {
            protocol: 1,
            harness: opts.harness,
            version: opts.version,
            inventory,
            probes: [
                versionProbe,
                inventoryProbe,
                ...standProbes(result.stdout, cli, REPORT_MATRIX_PROBES[cli]),
                standProbe,
            ],
        };
        writeReport(opts.report, report);
        return report;
    } finally {
        if (provider) await provider.close();
        rm(root);
    }
}

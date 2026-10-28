#!/usr/bin/env node
/**
 * Entry launcher: боевые зависимости команд `core/launcher.ts`. Зовёт его шим `./ralph`
 * потребителя (`examples/ralph`) — из установленной ревизии, а при первой установке из
 * клона-источника. Своих решений здесь нет: только проводка к диску, git и `ralph.js`.
 *
 * Скрытая команда `versions` печатает версии слоёв ЭТОЙ ревизии JSON-строкой: install и
 * doctor спрашивают их у установленного дерева отдельным процессом, а не импортом в свой —
 * код ревизии, отличной от исполняющей, в процесс launcher не грузится.
 *
 * Пути — от `import.meta.dirname`: ревизия знает себя сама, где бы её ни запустили.
 */
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    gitCheckoutExport,
    installRevision,
    isFullSha,
    runnerRevision,
    writeCoreLock,
} from './core/core-install.ts';
import { CONSUMER_CONFIG_REL } from './core/consumer-config-path.ts';
import { supportedVersions } from './core/compat.ts';
import { commitBundleOnBranch, type TRunArgvFn } from './core/core-update.ts';
import { harnessMcpNames, stdioListPage } from './core/mcp-inventory.ts';
import { HARNESS_REGISTRY } from './adapters/harness-registry.ts';
import { runLauncher, type TLauncherDeps } from './core/launcher.ts';

const argv = process.argv.slice(2);

if (argv[0] === 'versions') {
    console.log(JSON.stringify(supportedVersions()));
    process.exit(0);
}

// Имя entry — переменной: `ralph.js` без деклараций, тип поверхности назван ниже явно.
const CORE_ENTRY = './ralph.js';
// Фабрика оркестратора при импорте чистая (петлю не запускает: guard по entry в ralph.js).
const { default: coreRuntime } = (await import(CORE_ENTRY)) as {
    default: {
        resolveProfile: (
            raw: unknown,
            name: unknown,
            failFn: (m: string) => never,
            lockRootFn?: undefined,
            launch?: { consumerRoot: string; env: Record<string, string | undefined> },
        ) => unknown;
        observerTaskSource: (
            adapters: unknown,
            failFn: (m: string) => never,
        ) => {
            createPullRequest: (pr: {
                branch: string;
                title: string;
                body: string;
            }) => number | null;
            findOpenPullRequest: (branch: string) => { number: number } | null;
        };
    };
};

const readConfig = (consumerRoot: string): unknown =>
    JSON.parse(readFileSync(join(consumerRoot, CONSUMER_CONFIG_REL), 'utf8')) as unknown;
const throwFail = (m: string): never => {
    throw new Error(m);
};

// Переменные ключа живой пробы во всех блоках конфига: серверу MCP они не отдаются (#219).
// Конфиг не читается — ничего: окружение сервера и так собирается белым списком.
const liveProbeKeyEnvOf = (consumerRoot: string): string[] => {
    let raw: unknown;
    try {
        raw = readConfig(consumerRoot);
    } catch {
        return [];
    }
    const obj = (v: unknown): Record<string, unknown> =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : {};
    const root = obj(raw);
    const blocks = [root, obj(root.common), ...Object.values(obj(root.profiles)).map(obj)];
    return blocks
        .map((b) => obj(b.liveProbe).keyEnv)
        .filter((k): k is string => typeof k === 'string');
};

// argv без шелла со stdin, окружением и сроком — форма `shArgv` ядра для update.
const runArgv: TRunArgvFn = (file, args, opts = {}) => {
    const r = spawnSync(file, args, {
        encoding: 'utf8',
        input: opts.input,
        env: opts.env ?? process.env,
        ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs, killSignal: 'SIGKILL' }),
    });
    if (r.status !== 0) {
        throw new Error(
            `${file} ${args.join(' ')}: код ${String(r.status)} ${(r.stderr || String(r.error ?? '')).trim()}`,
        );
    }
    return opts.raw ? r.stdout : r.stdout.trim();
};

const deps: TLauncherDeps = {
    env: process.env,
    out: (line) => console.log(line),
    readFn: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
    installFn: ({ sha, dataDir, source, expectedTreeHash }) =>
        installRevision({
            sha,
            dataDir,
            expectedTreeHash,
            exportFn:
                source === null
                    ? () => {
                          throw new Error(
                              `ревизии ${sha} нет в ${dataDir}, а источника нет: задай RALPH_SOURCE=<клон канона>`,
                          );
                      }
                    : gitCheckoutExport(source),
            logFn: (line) => console.log(line),
        }),
    writeLockFn: (consumerRoot, lock) => writeCoreLock(consumerRoot, lock),
    resolveRevFn: (source, rev) => {
        const r = spawnSync(
            'git',
            ['-C', source, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
            {
                encoding: 'utf8',
            },
        );
        const sha = r.stdout?.trim() ?? '';
        if (r.status !== 0 || !isFullSha(sha)) {
            throw new Error(
                `ревизии ${rev} нет в ${source} (${(r.stderr || String(r.error ?? '')).trim()})`,
            );
        }
        return sha;
    },
    versionsOfFn: (dir) => {
        const r = spawnSync(process.execPath, [join(dir, 'launcher.mts'), 'versions'], {
            encoding: 'utf8',
        });
        if (r.status !== 0) {
            throw new Error(
                `node ${join(dir, 'launcher.mts')} versions: код ${String(r.status)} ${r.stderr.trim()}`,
            );
        }
        // Форму ответа проверяет `runInstallCommand` (`parseCoreVersions`) до записи lock.
        return JSON.parse(r.stdout) as unknown;
    },
    runCoreFn: (dir, args, consumerRoot) => {
        // cwd — дерево потребителя: `ralph.js` берёт конфиг от места запуска.
        const r = spawnSync(process.execPath, [join(dir, 'ralph.js'), ...args], {
            cwd: consumerRoot,
            stdio: 'inherit',
            env: process.env,
        });
        return r.status ?? 1;
    },
    nowFn: () => Date.now(),
    runtimeDirOfFn: (consumerRoot, profile) => {
        // Каталог состояния решает тот же резолвер профиля, что у ядра: вторая копия правил
        // слияния `common` и профиля однажды разошлась бы с первой молча. Контекст launcher —
        // тот же, что получит ядро флагом `--consumer` (#140): корни без ключа в конфиге
        // выводятся одинаково у обоих.
        const configPath = join(consumerRoot, CONSUMER_CONFIG_REL);
        const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
        const cfg = coreRuntime.resolveProfile(raw, profile ?? undefined, throwFail, undefined, {
            consumerRoot,
            env: process.env,
        }) as { rootsResolved?: { runtimeDir: string } | null };
        if (!cfg.rootsResolved) {
            throw new Error(`${configPath}: раскладка корней не собралась`);
        }
        return cfg.rootsResolved.runtimeDir;
    },
    ralphRevisionFn: (pid, dataDir) => runnerRevision(pid, dataDir),
    writeStopFn: (p) =>
        writeFileSync(p, `${new Date().toISOString()} ./ralph stop\n`, { flag: 'wx' }),
    rawConfigFn: readConfig,
    pushBundleBranchFn: ({ consumerRoot, branch, message, buildFn }) => {
        // Временный индекс — вне репозитория: индекс человека update не трогает.
        const tmp = mkdtempSync(join(tmpdir(), 'ralph-update-'));
        try {
            return commitBundleOnBranch({
                runArgvFn: runArgv,
                consumerRoot,
                env: process.env,
                indexFile: join(tmp, 'index'),
                branch,
                message,
                buildFn,
            });
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    },
    // cwd — дерево потребителя, из которого update читает базу: относительный путь сервера
    // ищется там же, где его видит человек. Предел назван в докблоке `update-bundle.ts`: файлы
    // сервера — из рабочего дерева человека, а не из коммита базы.
    mcpListPageFn: (consumerRoot) => (server, cfg, cursor) =>
        stdioListPage(server, cfg, cursor, {
            cwd: consumerRoot,
            deniedEnv: liveProbeKeyEnvOf(consumerRoot),
        }),
    mcpHarnessesFn: () => harnessMcpNames(HARNESS_REGISTRY),
    gitFn: (consumerRoot, args, opts) => runArgv('git', ['-C', consumerRoot, ...args], opts),
    openPrFn: (consumerRoot, pr, profile) => {
        const adapters = forgeOf(consumerRoot, profile);
        return adapters.taskSource.createPullRequest(pr);
    },
    findOpenPrFn: (consumerRoot, branch, profile) => {
        const adapters = forgeOf(consumerRoot, profile);
        return adapters.taskSource.findOpenPullRequest(branch)?.number ?? null;
    },
    registryFs: {
        readFile: (p) => readFileSync(p, 'utf8'),
        readdir: (d) => readdirSync(d),
        mkdir: (d) => mkdirSync(d, { recursive: true }),
        writeAtomic: (p, text) => {
            const tmp = `${p}.tmp-${String(process.pid)}`;
            writeFileSync(tmp, text);
            renameSync(tmp, p);
        },
    },
    listDataDirFn: (dataDir) => {
        try {
            return readdirSync(dataDir);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw e;
        }
    },
    renameFn: (from, to) => renameSync(from, to),
    rmFn: (p) => rmSync(p, { recursive: true, force: true }),
    runningRevisionsFn: (dataDir) => {
        // `/proc` не читается — бросок: чистка без сверки живых раннеров не идёт. Кроме петли
        // (`ralph.js`) держится и ревизия, исполняющая `launcher.mts`: `update`/`rollback`
        // посреди работы и внешний цикл `./ralph start` в окне рестарта по коду 75.
        const running = new Set<string>();
        for (const name of readdirSync('/proc')) {
            if (!/^[1-9]\d*$/.test(name)) continue;
            const sha = runnerRevision(Number(name), dataDir, {
                entries: ['ralph.js', 'launcher.mts'],
            });
            if (sha !== null) running.add(sha);
        }
        return running;
    },
};

type TForge = { taskSource: ReturnType<typeof coreRuntime.observerTaskSource> };
let forge: { key: string; adapters: TForge } | null = null;

/**
 * Шов форжа — тот же, что у петли, выбранный `adapters` профиля команды (`--profile`, иначе
 * по умолчанию). Собирается один раз на процесс: поиск PR и его заведение идут подряд, а
 * резолв конфига с #134 каждый раз заново читает lock.
 */
function forgeOf(consumerRoot: string, profile: string | null): TForge {
    const key = `${consumerRoot}\0${profile ?? ''}`;
    if (forge?.key === key) return forge.adapters;
    const cfg = coreRuntime.resolveProfile(
        readConfig(consumerRoot),
        profile ?? undefined,
        throwFail,
    ) as { adapters?: unknown };
    // CLI форжа берёт репозиторий от места запуска, а шов cwd не принимает, — поэтому
    // процесс launcher переходит в дерево потребителя. Это единственный chdir launcher, и
    // после шагов форжа других шагов у update/rollback нет.
    process.chdir(consumerRoot);
    forge = {
        key,
        adapters: { taskSource: coreRuntime.observerTaskSource(cfg.adapters, throwFail) },
    };
    return forge.adapters;
}

process.exit(runLauncher(argv, deps));

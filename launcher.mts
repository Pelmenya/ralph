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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    gitCheckoutExport,
    installRevision,
    isFullSha,
    runnerAlive,
    writeCoreLock,
} from './core/core-install.ts';
import { supportedVersions } from './core/compat.ts';
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
        resolveProfile: (raw: unknown, name: unknown, failFn: (m: string) => never) => unknown;
    };
};

const CONFIG_REL = join('.claude', 'ralph', 'ralph.config.json');

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
    runtimeDirOfFn: (consumerRoot, profile) => {
        // Каталог состояния решает тот же резолвер профиля, что у ядра: вторая копия правил
        // слияния `common` и профиля однажды разошлась бы с первой молча.
        const configPath = join(consumerRoot, CONFIG_REL);
        const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
        const cfg = coreRuntime.resolveProfile(raw, profile ?? undefined, (m) => {
            throw new Error(m);
        }) as { rootsResolved?: { runtimeDir: string } | null };
        if (!cfg.rootsResolved) {
            throw new Error(
                `в ${configPath} нет секции roots — ядро из установки без неё не стартует`,
            );
        }
        return cfg.rootsResolved.runtimeDir;
    },
    ralphAliveFn: (pid, entry) => runnerAlive(pid, entry),
    writeStopFn: (p) =>
        writeFileSync(p, `${new Date().toISOString()} ./ralph stop\n`, { flag: 'wx' }),
};

process.exit(runLauncher(argv, deps));

// Решения команд launcher на подменённых коллабораторах (#100). Сквозной путь на настоящем
// диске, git и раннере — `tests/launcher-scenarios.test.ts`; здесь — каждая развилка.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildManifest,
    CORE_LOCK_SCHEMA,
    formatCoreLock,
    formatManifest,
    INSTALL_MANIFEST,
    installRevision,
    treeHashOf,
    verifyInstalledTree,
    type TCoreLock,
    type TInstallFs,
} from './core-install.ts';
import { supportedVersions } from './compat.ts';
import { ACTIVATION_RESTART_EXIT } from './core-activation.ts';
import {
    formatCheck,
    parseLauncherArgv,
    runLauncher,
    runUpdateCommand,
    SAME_RESTART_WORK_MS,
    startProfile,
    type TLauncherDeps,
} from './launcher.ts';
import { registerConsumer } from './consumer-registry.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const CONSUMER = '/work/app';
const LOCK_PATH = join(CONSUMER, '.ralph', 'core.lock');

let tmp: string;
let dataDir: string;
let dir: string;
let lock: TCoreLock;

/** Настоящее дерево ревизии во временном каталоге: сверка дерева идёт по диску. */
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ralph-launcher-unit-'));
    dataDir = join(tmp, 'data');
    dir = join(dataDir, SHA);
    mkdirSync(join(dir, 'core'), { recursive: true });
    writeFileSync(join(dir, 'ralph.js'), 'entry\n');
    writeFileSync(join(dir, 'core', 'a.ts'), 'a\n');
    const manifest = formatManifest(buildManifest(dir));
    writeFileSync(join(dir, INSTALL_MANIFEST), manifest);
    lock = {
        schema: CORE_LOCK_SCHEMA,
        sha: SHA,
        treeHash: treeHashOf(manifest),
        versions: supportedVersions(),
    };
});
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

type TWorld = {
    files: Map<string, string>;
    dirs: Set<string>;
    out: string[];
    deps: TLauncherDeps;
};

function world(over: Partial<TLauncherDeps> = {}, opts: { lock?: string | null } = {}): TWorld {
    const files = new Map<string, string>();
    const dirs = new Set<string>([dir]);
    const lockText = opts.lock === undefined ? formatCoreLock(lock) : opts.lock;
    if (lockText !== null) files.set(LOCK_PATH, lockText);
    const out: string[] = [];
    const deps: TLauncherDeps = {
        env: { RALPH_DATA_DIR: dataDir, RALPH_LAUNCHER_VERSION: '1' },
        out: (l) => out.push(l),
        readFn: (p) => {
            const t = files.get(p);
            if (t === undefined) {
                throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
            }
            return t;
        },
        exists: (p) => files.has(p) || dirs.has(p),
        installFn: vi.fn(({ sha }) => ({
            status: 'installed' as const,
            dir: join(dataDir, sha),
            treeHash: lock.treeHash,
        })),
        writeLockFn: vi.fn((root: string, l: TCoreLock) => {
            files.set(join(root, '.ralph', 'core.lock'), formatCoreLock(l));
            return join(root, '.ralph', 'core.lock');
        }),
        resolveRevFn: vi.fn(() => SHA),
        versionsOfFn: vi.fn(() => supportedVersions()),
        runCoreFn: vi.fn(() => 0),
        nowFn: vi.fn(() => 0),
        runtimeDirOfFn: vi.fn(() => '/run/ralph'),
        ralphRevisionFn: vi.fn((): string | null => SHA),
        writeStopFn: vi.fn((p: string) => {
            files.set(p, 'stop');
        }),
        rawConfigFn: vi.fn(() => ({ configVersion: 1 })),
        pushLockBranchFn: vi.fn(() => 'c'.repeat(40)),
        openPrFn: vi.fn(() => 7),
        findOpenPrFn: vi.fn(() => null),
        registryFs: {
            readFile: (p) => {
                const t = files.get(p);
                if (t === undefined) {
                    throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
                }
                return t;
            },
            readdir: (d) => {
                const names = [...files.keys()]
                    .filter((p) => p.startsWith(`${d}/`))
                    .map((p) => p.slice(d.length + 1));
                if (names.length === 0) {
                    throw Object.assign(new Error(`ENOENT ${d}`), { code: 'ENOENT' });
                }
                return names;
            },
            mkdir: () => {},
            writeAtomic: vi.fn((p: string, t: string) => {
                files.set(p, t);
            }),
        },
        listDataDirFn: vi.fn(() => [SHA]),
        renameFn: vi.fn(),
        rmFn: vi.fn(),
        runningRevisionsFn: vi.fn(() => new Set<string>()),
        ...over,
    };
    return { files, dirs, out, deps };
}

const run = (w: TWorld, ...argv: string[]) =>
    runLauncher(['--consumer', CONSUMER, ...argv], w.deps);

describe('parseLauncherArgv', () => {
    it('свои флаги launcher забирает, остальное у start уходит ядру', () => {
        const r = parseLauncherArgv([
            '--consumer',
            CONSUMER,
            'start',
            '--dry-run',
            '--profile',
            'p',
        ]);
        expect(r).toEqual({
            ok: true,
            args: {
                command: 'start',
                consumerRoot: CONSUMER,
                source: null,
                rev: null,
                profile: null,
                passthrough: ['--dry-run', '--profile', 'p'],
            },
        });
    });

    it.each([
        [[], /Команда не названа/],
        [['--consumer', CONSUMER, 'launch'], /Неизвестная команда "launch"/],
        [['start'], /--consumer <абсолютный путь> не задан/],
        [['--consumer', 'app', 'start'], /--consumer <абсолютный путь> не задан/],
        [['--consumer', CONSUMER, 'install', '--rev'], /--rev без значения/],
        [['--consumer', CONSUMER, 'install', '--rev', '--source'], /--rev без значения/],
        [['--consumer', CONSUMER, 'start', '--rev', 'x'], /флаги install и update, а не start/],
        [['--consumer', CONSUMER, 'install', '--force'], /install не знает флага "--force"/],
        [['--consumer', CONSUMER, 'version', 'x'], /version не знает флага "x"/],
        [['--consumer', CONSUMER, 'stop', '--now'], /stop не знает флага "--now"/],
        [['--consumer', CONSUMER, 'stop', '--profile'], /--profile без значения/],
        [['--consumer', CONSUMER, 'stop', '--profile', '--now'], /--profile без значения/],
        // Шим ставит `--consumer` сам; второй увёл бы команду в чужое дерево.
        [['--consumer', CONSUMER, 'start', '--consumer', '/other'], /--consumer повторён/],
    ])('%j → отказ', (argv, reason) => {
        const r = parseLauncherArgv(argv);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(reason);
    });

    it('stop забирает профиль', () => {
        const r = parseLauncherArgv(['--consumer', CONSUMER, 'stop', '--profile', 'prod']);
        expect(r.ok && r.args.profile).toBe('prod');
        expect(r.ok && r.args.passthrough).toEqual([]);
    });

    it('отказ разбора — код 2 и строка с причиной', () => {
        const w = world();
        expect(runLauncher(['launch'], w.deps)).toBe(2);
        expect(w.out[0]).toMatch(/^⛔ Неизвестная команда/);
    });
});

describe('doctor', () => {
    it('исправная установка: все проверки и --doctor ядра, код 0', () => {
        const w = world();
        expect(run(w, 'doctor', '--profile', 'p')).toBe(0);
        expect(w.out.slice(0, -1).every((l) => l.startsWith('✅'))).toBe(true);
        expect(w.out.map((l) => l.split(':')[0])).toEqual([
            '✅ lock',
            '✅ установка',
            '✅ дерево',
            '✅ launcher',
            '✅ версии ревизии',
            '✅ ядро',
            '🩺 doctor',
        ]);
        expect(w.deps.runCoreFn).toHaveBeenCalledWith(
            dir,
            ['--consumer', CONSUMER, '--doctor', '--profile', 'p'],
            CONSUMER,
        );
    });

    it('нет lock: остальное пропущено с причиной, а не «прошло»', () => {
        const w = world({}, { lock: null });
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out).toEqual([
            expect.stringMatching(/^❌ lock: .*core\.lock нет/),
            expect.stringMatching(/^⏭ установка: нет lock/),
            expect.stringMatching(/^⏭ дерево: нет установленной ревизии/),
            expect.stringMatching(/^⏭ launcher: нет lock/),
            expect.stringMatching(/^⏭ версии ревизии:/),
            expect.stringMatching(/^⏭ ядро:/),
            '🩺 doctor: не прошли 6 из 6 — lock, установка, дерево, launcher, версии ревизии, ядро',
        ]);
        expect(w.deps.runCoreFn).not.toHaveBeenCalled();
    });

    it('ревизии нет в каталоге установок — совет поставить её', () => {
        const w = world();
        w.dirs.clear();
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[1]).toMatch(/^❌ установка: .* нет — поставь ревизию: \.\/ralph install/);
    });

    it('каталог установок не задан — названо, не брошено', () => {
        const w = world({ env: { RALPH_LAUNCHER_VERSION: '1' } });
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[1]).toMatch(/^❌ установка: Каталог установок ядра не задан/);
    });

    it('изменённое дерево: код ревизии не исполняется', () => {
        writeFileSync(join(dir, 'core', 'a.ts'), 'правка\n');
        const w = world();
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[2]).toMatch(/^❌ дерево: .*core\/a\.ts: изменён/);
        expect(w.deps.versionsOfFn).not.toHaveBeenCalled();
        expect(w.deps.runCoreFn).not.toHaveBeenCalled();
    });

    it.each([
        [{}, /RALPH_LAUNCHER_VERSION не задан — зови через \.\/ralph/],
        [{ RALPH_LAUNCHER_VERSION: 'x' }, /не целое положительное/],
        [{ RALPH_LAUNCHER_VERSION: '2' }, /ревизия ждёт launcher v1, найден v2/],
    ])('launcher %j — отказ по слою', (launcherEnv, reason) => {
        const w = world({ env: { RALPH_DATA_DIR: dataDir, ...launcherEnv } });
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[3]).toMatch(/^❌ launcher: /);
        expect(w.out[3]).toMatch(reason);
    });

    it('ревизия говорит не теми версиями, что в lock', () => {
        const w = world({ versionsOfFn: () => ({ ...supportedVersions(), core: 9 }) });
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[4]).toMatch(
            /^❌ версии ревизии: lock называет .*core v1.*ревизия говорит .*core v9/,
        );
    });

    it('ревизия не назвала версий — отказ с причиной', () => {
        const w = world({
            versionsOfFn: () => {
                throw new Error('нет launcher.mts');
            },
        });
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[4]).toBe(
            '❌ версии ревизии: ревизия не назвала свои версии: нет launcher.mts',
        );
    });

    it('ревизия назвала версии не по контракту — проверка провалена, а не сравнение с мусором', () => {
        const w = world({ versionsOfFn: () => ({ core: 1 }) });
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[4]).toMatch(
            /^❌ версии ревизии: ревизия не назвала свои версии: ответ не по контракту \(versions обязаны быть ровно/,
        );
    });

    it('--doctor ядра ненулём — проверка «ядро» провалена', () => {
        const w = world({ runCoreFn: () => 3 });
        expect(run(w, 'doctor')).toBe(1);
        expect(w.out[5]).toMatch(/^❌ ядро: ralph\.js --doctor вышел с кодом 3/);
        expect(w.out[6]).toBe('🩺 doctor: не прошли 1 из 6 — ядро');
    });
});

describe('start', () => {
    it('исправная установка → ralph.js ревизии с флагами, код ядра наверх', () => {
        const w = world({ runCoreFn: vi.fn(() => 7) });
        expect(run(w, 'start', '--dry-run')).toBe(7);
        expect(w.out).toEqual([`▶ Ralph ${SHA} из ${dir}`]);
        expect(w.deps.runCoreFn).toHaveBeenCalledWith(
            dir,
            ['--consumer', CONSUMER, '--dry-run'],
            CONSUMER,
        );
    });

    it('проваленная проверка — ядро не зовётся, причина названа', () => {
        writeFileSync(join(dir, 'extra.ts'), 'x\n');
        const w = world();
        expect(run(w, 'start')).toBe(1);
        expect(w.out[0]).toMatch(/^❌ дерево: .*extra\.ts: лишний файл/);
        expect(w.out.at(-1)).toMatch(/^⛔ start отменён/);
        expect(w.deps.runCoreFn).not.toHaveBeenCalled();
    });
});

describe('start — активация рестартом (#38)', () => {
    /** Вторая настоящая ревизия рядом с первой и lock на неё. */
    function installOther(w: TWorld): string {
        const other = join(dataDir, OTHER);
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, 'ralph.js'), 'entry 2\n');
        const manifest = formatManifest(buildManifest(other));
        writeFileSync(join(other, INSTALL_MANIFEST), manifest);
        w.dirs.add(other);
        w.files.set(
            LOCK_PATH,
            formatCoreLock({ ...lock, sha: OTHER, treeHash: treeHashOf(manifest) }),
        );
        return other;
    }

    it('ядро вышло на рестарт → start сверяет lock заново и запускает новую ревизию', () => {
        const codes = [ACTIVATION_RESTART_EXIT, 0];
        let other = '';
        const w = world({
            runCoreFn: vi.fn(() => {
                // Lock сменился, пока петля шла: ядро увидело это на границе и вышло.
                if (other === '') other = installOther(w);
                return codes.shift() ?? 1;
            }),
        });
        expect(run(w, 'start')).toBe(0);
        expect(w.deps.runCoreFn).toHaveBeenNthCalledWith(
            1,
            dir,
            ['--consumer', CONSUMER],
            CONSUMER,
        );
        expect(w.deps.runCoreFn).toHaveBeenNthCalledWith(
            2,
            other,
            ['--consumer', CONSUMER],
            CONSUMER,
        );
        expect(w.out).toEqual([
            `▶ Ralph ${SHA} из ${dir}`,
            `🔁 Рестарт: ${SHA} → ${OTHER} из ${other}`,
        ]);
    });

    // Один рестарт в ту же ревизию — транзиент (lock не прочитался ядром посреди pull),
    // второй подряд — устойчивое расхождение взгляда ядра и launcher (ревью Фазы 13).
    it('рестарт в ту же ревизию: один повтор, второй подряд — отказ с причиной', () => {
        const w = world({ runCoreFn: vi.fn(() => ACTIVATION_RESTART_EXIT) });
        expect(run(w, 'start')).toBe(1);
        expect(w.deps.runCoreFn).toHaveBeenCalledTimes(2);
        expect(w.out.slice(0, 2)).toEqual([
            `▶ Ralph ${SHA} из ${dir}`,
            `🔁 Рестарт: ${SHA} → ${SHA} из ${dir}`,
        ]);
        expect(w.out.at(-1)).toMatch(
            new RegExp(
                `^⛔ рестарт отменён: ядро ${SHA} второй раз подряд.*lock его не показывает`,
            ),
        );
    });

    // Счёт «подряд» обнуляет работа ядра между рестартами: два транзиента, разнесённых
    // сутками, — не тугая петля (ревью Фазы 13, проход 2).
    it('два рестарта в ту же ревизию, разнесённые работой ядра, — не отказ', () => {
        const codes = [ACTIVATION_RESTART_EXIT, ACTIVATION_RESTART_EXIT, 0];
        let clock = 0;
        const w = world({
            runCoreFn: vi.fn(() => {
                clock += SAME_RESTART_WORK_MS + 1;
                return codes.shift() ?? 1;
            }),
            nowFn: vi.fn(() => clock),
        });
        expect(run(w, 'start')).toBe(0);
        expect(w.deps.runCoreFn).toHaveBeenCalledTimes(3);
        expect(w.out.filter((l) => l.startsWith('⛔'))).toEqual([]);
    });

    it('рестарт в ту же ревизию на пороге работы — ещё серия, второй — отказ', () => {
        let clock = 0;
        const w = world({
            runCoreFn: vi.fn(() => {
                clock += SAME_RESTART_WORK_MS;
                return ACTIVATION_RESTART_EXIT;
            }),
            nowFn: vi.fn(() => clock),
        });
        expect(run(w, 'start')).toBe(1);
        expect(w.deps.runCoreFn).toHaveBeenCalledTimes(2);
    });

    it('рестарт в ту же ревизию, затем код 0 — транзиент пережит', () => {
        const codes = [ACTIVATION_RESTART_EXIT, 0];
        const w = world({ runCoreFn: vi.fn(() => codes.shift() ?? 1) });
        expect(run(w, 'start')).toBe(0);
        expect(w.deps.runCoreFn).toHaveBeenCalledTimes(2);
    });

    it('новой ревизии в установке нет → отказ с советом, прежняя не запускается', () => {
        const w = world({
            runCoreFn: vi.fn(() => {
                w.files.set(LOCK_PATH, formatCoreLock({ ...lock, sha: OTHER }));
                return ACTIVATION_RESTART_EXIT;
            }),
        });
        expect(run(w, 'start')).toBe(1);
        expect(w.deps.runCoreFn).toHaveBeenCalledTimes(1);
        expect(w.out.at(-1)).toMatch(
            new RegExp(`^⛔ рестарт после ${SHA} отменён.*провалы выше.*\\./ralph doctor`),
        );
    });

    it('стоп по существу (код 1) — не рестарт', () => {
        const w = world({ runCoreFn: vi.fn(() => 1) });
        expect(run(w, 'start')).toBe(1);
        expect(w.deps.runCoreFn).toHaveBeenCalledTimes(1);
    });
});

describe('install', () => {
    it('пустой .ralph/ без ревизии — отказ: «последней» launcher не выбирает', () => {
        const w = world({}, { lock: null });
        expect(run(w, 'install')).toBe(1);
        expect(w.out[0]).toMatch(/ревизия не названа/);
        expect(w.deps.installFn).not.toHaveBeenCalled();
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
    });

    it('пустой .ralph/ с источником и ревизией — установка, lock с версиями ревизии, doctor', () => {
        const w = world({}, { lock: null });
        expect(run(w, 'install', '--source', '/src', '--rev', 'v1')).toBe(0);
        expect(w.deps.resolveRevFn).toHaveBeenCalledWith('/src', 'v1');
        expect(w.deps.installFn).toHaveBeenCalledWith({ sha: SHA, dataDir, source: '/src' });
        expect(w.deps.versionsOfFn).toHaveBeenCalledWith(dir);
        expect(w.deps.writeLockFn).toHaveBeenCalledWith(CONSUMER, lock);
        expect(w.out[0]).toBe(`📦 Ревизия ${SHA} установлена в ${dir}; lock записан: ${LOCK_PATH}`);
        expect(w.out.at(-1)).toBe('🩺 doctor: все проверки прошли');
    });

    it('первая установка, каталог уже лежал и сходится со своим манифестом — lock пишется', () => {
        const w = world(
            {
                installFn: vi.fn(() => ({
                    status: 'present' as const,
                    dir,
                    treeHash: lock.treeHash,
                })),
            },
            { lock: null },
        );
        expect(run(w, 'install', '--source', '/src', '--rev', 'v1')).toBe(0);
        expect(w.deps.writeLockFn).toHaveBeenCalledWith(CONSUMER, lock);
        expect(w.out[0]).toMatch(/уже стояла/);
    });

    it.each([
        ['лишний слой', () => ({ ...supportedVersions(), extra: 1 })],
        ['не число', () => ({ ...supportedVersions(), core: '1' })],
        ['не объект', () => 'v1'],
    ])(
        'первая установка: ревизия назвала версии не по контракту (%s) — lock не пишется',
        (_n, fn) => {
            const w = world({ versionsOfFn: vi.fn(fn) }, { lock: null });
            expect(run(w, 'install', '--source', '/src', '--rev', 'v1')).toBe(1);
            expect(w.out[0]).toMatch(
                /^⛔ install: ревизия .* назвала версии слоёв не по контракту .*Lock не пишется/,
            );
            expect(w.deps.writeLockFn).not.toHaveBeenCalled();
        },
    );

    it('первая установка, лежавший каталог разошёлся со своим манифестом — lock не пишется, код не исполняется', () => {
        writeFileSync(join(dir, 'core', 'a.ts'), 'правка\n');
        const w = world(
            {
                installFn: vi.fn(() => ({
                    status: 'present' as const,
                    dir,
                    treeHash: lock.treeHash,
                })),
            },
            { lock: null },
        );
        expect(run(w, 'install', '--source', '/src', '--rev', 'v1')).toBe(1);
        expect(w.out[0]).toMatch(/уже лежала в .*core\/a\.ts: изменён.*В lock она не идёт/);
        expect(w.deps.versionsOfFn).not.toHaveBeenCalled();
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
    });

    it('lock есть — ставится его ревизия с ожидаемым хэшем дерева', () => {
        const w = world({
            installFn: vi.fn(() => ({ status: 'present' as const, dir, treeHash: lock.treeHash })),
        });
        expect(run(w, 'install')).toBe(0);
        expect(w.deps.installFn).toHaveBeenCalledWith({
            sha: SHA,
            dataDir,
            source: null,
            expectedTreeHash: lock.treeHash,
        });
        expect(w.out[0]).toBe(`📦 Ревизия ${SHA} уже стояла в ${dir}`);
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
    });

    it('--rev совпал с lock — обычная установка', () => {
        const w = world();
        expect(run(w, 'install', '--source', '/src', '--rev', 'v1')).toBe(0);
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
    });

    it('--rev разошёлся с lock — отказ: смена ревизии — update', () => {
        const w = world({ resolveRevFn: () => OTHER });
        expect(run(w, 'install', '--source', '/src', '--rev', 'v2')).toBe(1);
        expect(w.out[0]).toMatch(/Смена ревизии — update, а не install/);
        expect(w.deps.installFn).not.toHaveBeenCalled();
    });

    it('--rev без источника при lock — отказ', () => {
        const w = world();
        expect(run(w, 'install', '--rev', 'v1')).toBe(1);
        expect(w.out[0]).toMatch(/--rev без источника/);
    });

    it('битый lock не перезаписывается', () => {
        const w = world({}, { lock: '{"schema": 1' });
        expect(run(w, 'install', '--source', '/src', '--rev', 'v1')).toBe(1);
        expect(w.out[0]).toMatch(/Битый lock не перезаписывается/);
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
        expect(w.deps.installFn).not.toHaveBeenCalled();
    });

    it('сбой установки — строка отказа, doctor не зовётся', () => {
        const w = world({
            installFn: () => {
                throw new Error('git archive не отработал');
            },
        });
        expect(run(w, 'install')).toBe(1);
        expect(w.out).toEqual(['⛔ install: git archive не отработал']);
    });

    it('каталог установок не задан — отказ до установки', () => {
        const w = world({ env: {} });
        expect(run(w, 'install')).toBe(1);
        expect(w.out[0]).toMatch(/^⛔ install: Каталог установок ядра не задан/);
    });
});

describe('stop', () => {
    it('петля идёт — запрос положен, сигналов нет', () => {
        const w = world();
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop', '--profile', 'prod')).toBe(0);
        expect(w.deps.runtimeDirOfFn).toHaveBeenCalledWith(CONSUMER, 'prod');
        expect(w.deps.writeStopFn).toHaveBeenCalledWith('/run/ralph/ralph.stop');
        expect(w.out[0]).toMatch(/начатая сессия доводится, петля встанет на границе итерации/);
    });

    it('запрос уже лежит — второй не кладётся', () => {
        const w = world();
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        w.files.set('/run/ralph/ralph.stop', 'stop');
        expect(run(w, 'stop')).toBe(0);
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(/уже лежит/);
    });

    it('лок брошен (владелец мёртв) — отказ: запрос остановил бы следующий старт', () => {
        const w = world({ ralphRevisionFn: vi.fn(() => null) });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(1);
        // Живость сверяется с entry в каталоге установок, а не с подстрокой `ralph.js`.
        expect(w.deps.ralphRevisionFn).toHaveBeenCalledWith(4242, dataDir);
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(
            /лок \/run\/ralph\/ralph\.lock брошен — раннера .*<ревизия>\/ralph\.js с pid 4242 нет/,
        );
    });

    it('lock сменили после старта: жив раннер другой ревизии — не «брошен», запрос кладётся (#136)', () => {
        const w = world({ ralphRevisionFn: vi.fn(() => OTHER) });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(0);
        expect(w.deps.writeStopFn).toHaveBeenCalledWith('/run/ralph/ralph.stop');
        expect(w.out.join('\n')).not.toMatch(/брошен/);
        expect(w.out[0]).toBe(
            `ℹ️ Петля с pid 4242 идёт на ревизии ${OTHER}, а lock называет ${SHA} ` +
                '(lock сменили после её старта) — запрос кладётся ей же.',
        );
        expect(w.out[1]).toMatch(/Запрос остановки положен/);
    });

    it('lock потребителя не читается — отказ: чей раннер держит лок, не проверить', () => {
        const w = world({}, { lock: null });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(1);
        expect(w.deps.ralphRevisionFn).not.toHaveBeenCalled();
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(/core\.lock нет — чей раннер держит лок, не проверить/);
    });

    it('каталог установок не задан — отказ до сверки живости', () => {
        const w = world({ env: { RALPH_LAUNCHER_VERSION: '1' } });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(1);
        expect(w.deps.ralphRevisionFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(/Каталог установок ядра не задан.*не проверить/);
    });

    it('запрос положили между проверкой и записью (EEXIST) — «уже лежит», код 0, без стека', () => {
        const w = world({
            writeStopFn: vi.fn(() => {
                throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
            }),
        });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(0);
        expect(w.out).toEqual([
            '⏸ Запрос остановки уже лежит (/run/ralph/ralph.stop) — петля встанет на границе итерации.',
        ]);
    });

    it('запись запроса упала иначе — строка ⛔ stop и код 1', () => {
        const w = world({
            writeStopFn: vi.fn(() => {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            }),
        });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(1);
        expect(w.out).toEqual([
            '⛔ stop: запрос /run/ralph/ralph.stop не положен — EACCES: permission denied',
        ]);
    });

    it('в локе не pid — отказ: живость не проверить', () => {
        const w = world();
        w.files.set('/run/ralph/ralph.lock', '{}');
        expect(run(w, 'stop')).toBe(1);
        expect(w.deps.ralphRevisionFn).not.toHaveBeenCalled();
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(/не pid .* запрос не кладётся/);
    });

    it('лок не читается — отказ с причиной', () => {
        const w = world({
            readFn: () => {
                throw new Error('EACCES');
            },
        });
        w.files.set('/run/ralph/ralph.lock', '4242');
        expect(run(w, 'stop')).toBe(1);
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(/ralph\.lock не читается \(EACCES\)/);
    });

    it('лока нет — отказ: запрос остановил бы следующий старт', () => {
        const w = world();
        expect(run(w, 'stop')).toBe(1);
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(/петля здесь не идёт/);
    });

    it('каталог состояния не определён — отказ с причиной', () => {
        const w = world({
            runtimeDirOfFn: () => {
                throw new Error('нет секции roots');
            },
        });
        expect(run(w, 'stop')).toBe(1);
        expect(w.out[0]).toBe('⛔ stop: каталог состояния не определён — нет секции roots');
    });
});

describe('version', () => {
    it('ревизия и версии слоёв из lock', () => {
        const w = world();
        expect(run(w, 'version')).toBe(0);
        expect(w.out).toEqual([
            'launcher (./ralph): v1',
            `Ralph ${SHA.slice(0, 12)} (ревизия ${SHA})`,
            `версии: launcher v1, core v1, config v1, state v${String(supportedVersions().state)}, adapters v1`,
        ]);
    });

    it('без lock и версии launcher — названо, код 1', () => {
        const w = world({ env: {} }, { lock: null });
        expect(run(w, 'version')).toBe(1);
        expect(w.out[0]).toBe('launcher (./ralph): версия не задана');
        expect(w.out[1]).toMatch(/^ядро: .*core\.lock нет/);
    });
});

it('formatCheck: знак по исходу', () => {
    expect(formatCheck({ name: 'n', status: 'skip', detail: 'd' })).toBe('⏭ n: d');
});

describe('update (#102)', () => {
    // Fs установки без предохранителя побочек: запись во временный каталог теста и есть
    // предмет проверки — исполняемая ревизия рядом не должна измениться ни байтом.
    const installFs: TInstallFs = {
        readdir: (d) => readdirSync(d),
        lstat: (p) => lstatSync(p),
        readFile: (p) => readFileSync(p),
        readlink: (p) => readlinkSync(p),
        exists: (p) => existsSync(p),
        mkdir: (d) => mkdirSync(d, { recursive: true }),
        writeFile: (p, t) => writeFileSync(p, t, { flag: 'wx' }),
        rename: (a, b) => renameSync(a, b),
        rm: (p) => rmSync(p, { recursive: true, force: true }),
    };
    const realInstall: TLauncherDeps['installFn'] = ({ sha, dataDir: d }) =>
        installRevision({
            sha,
            dataDir: d,
            fs: installFs,
            exportFn: (_sha, dest) => {
                mkdirSync(join(dest, 'core'), { recursive: true });
                writeFileSync(join(dest, 'ralph.js'), 'entry v2\n');
                writeFileSync(join(dest, 'core', 'a.ts'), 'a v2\n');
            },
        });
    const uworld = (over: Partial<TLauncherDeps> = {}) =>
        world({ resolveRevFn: vi.fn(() => OTHER), installFn: vi.fn(realInstall), ...over });
    const update = (w: TWorld, ...argv: string[]) => run(w, 'update', '--source', '/src', ...argv);
    const snapshot = (d: string) => formatManifest(buildManifest(d));

    it('во время работающей петли: ревизия ставится рядом, исполняемая и lock не тронуты', () => {
        const before = snapshot(dir);
        const lockBefore = formatCoreLock(lock);
        const w = uworld({ installFn: vi.fn(realInstall) });
        expect(update(w, 'v2')).toBe(0);

        expect(snapshot(dir)).toBe(before);
        expect(verifyInstalledTree(dir, lock)).toEqual({ ok: true });
        expect(existsSync(join(dataDir, OTHER, INSTALL_MANIFEST))).toBe(true);
        // Петлю не останавливают и не перезапускают, lock человека не пишется.
        expect(w.deps.runCoreFn).not.toHaveBeenCalled();
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
        expect(w.files.get(LOCK_PATH)).toBe(lockBefore);
        expect(w.out.at(-1)).toMatch(/Петля работает на прежней ревизии/);
    });

    it('lock меняется только в ветке PR: новая ревизия, её хэш и версии — в коммит ветки', () => {
        const w = uworld({ installFn: vi.fn(realInstall) });
        expect(update(w, 'v2')).toBe(0);
        const newDir = join(dataDir, OTHER);
        const next: TCoreLock = {
            schema: CORE_LOCK_SCHEMA,
            sha: OTHER,
            treeHash: treeHashOf(readFileSync(join(newDir, INSTALL_MANIFEST), 'utf8')),
            versions: supportedVersions(),
        };
        const branch = `ralph/core-${OTHER.slice(0, 12)}`;
        expect(w.deps.pushLockBranchFn).toHaveBeenCalledWith({
            consumerRoot: CONSUMER,
            branch,
            lock: next,
            message: expect.stringContaining(`стало: \`${OTHER}\``) as string,
        });
        expect(w.deps.openPrFn).toHaveBeenCalledWith(
            CONSUMER,
            {
                branch,
                title: `chore(core): ревизия ядра ${OTHER.slice(0, 12)}`,
                body: expect.stringContaining(`было: \`${SHA}\``) as string,
            },
            null,
        );
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
        expect(w.out.at(-1)).toMatch(new RegExp(`PR #7 из ${branch}`));
    });

    it('ревизия названа --rev, а источник — RALPH_SOURCE', () => {
        const w = uworld();
        w.deps.env.RALPH_SOURCE = '/env-src';
        expect(run(w, 'update', '--rev', 'v2')).toBe(0);
        expect(w.deps.resolveRevFn).toHaveBeenCalledWith('/env-src', 'v2');
        expect(w.deps.installFn).toHaveBeenCalledWith({
            sha: OTHER,
            dataDir,
            source: '/env-src',
        });
    });

    it('roots.productRoot конфига на исполняемой ревизии — предупреждение с новым путём', () => {
        const w = uworld({
            rawConfigFn: vi.fn(() => ({
                common: { roots: { productRoot: dir } },
                profiles: { prod: { roots: { productRoot: dir } }, dev: {}, bad: 1 },
            })),
        });
        expect(update(w, 'v2')).toBe(0);
        const warn = w.out.filter((l) => l.startsWith('⚠'));
        expect(warn).toEqual([
            `⚠ common.roots.productRoot конфига указывает на ревизию из lock ${dir}: вместе с мерджем PR убери ключ (launcher выводит его из lock) или поправь его на ${join(dataDir, OTHER)}, иначе рестарт откажет расхождением.`,
            expect.stringMatching(/^⚠ profiles\.prod\.roots\.productRoot конфига/) as string,
        ]);
    });

    it('конфиг без roots — без предупреждения', () => {
        const w = uworld({ rawConfigFn: vi.fn(() => ({ configVersion: 1, profiles: [] })) });
        expect(update(w, 'v2')).toBe(0);
        expect(w.out.some((l) => l.startsWith('⚠'))).toBe(false);
    });

    it('форж не назвал номер PR — успех без номера', () => {
        const w = uworld({ openPrFn: vi.fn(() => null) });
        expect(update(w, 'v2')).toBe(0);
        expect(w.out.at(-1)).toMatch(/^🔀 PR из ralph\/core-/);
    });

    it.each([
        [
            'launcher',
            { launcher: 2 },
            {},
            /launcher: ревизия ждёт v2, у потребителя v1 — сначала обнови шим/,
        ],
        ['config', { config: 2 }, {}, /config: ревизия ждёт v2, у потребителя v1/],
        ['шим без версии', {}, { RALPH_LAUNCHER_VERSION: '' }, /launcher: версия не определена/],
    ])('несовместимая ревизия (%s) отвергнута до PR с причиной', (_n, versions, env, why) => {
        const w = uworld({ versionsOfFn: vi.fn(() => ({ ...supportedVersions(), ...versions })) });
        Object.assign(w.deps.env, env);
        expect(update(w, 'v2')).toBe(1);
        expect(w.out.join('\n')).toMatch(why);
        expect(w.out.at(-1)).toMatch(/несовместима с этим потребителем.*PR не заведён/);
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
        expect(w.deps.openPrFn).not.toHaveBeenCalled();
    });

    it('ревизия читает state старше того, что пишет нынешняя, — отказ до PR', () => {
        const st = supportedVersions().state;
        const newer = { ...lock, versions: { ...lock.versions, state: st + 1 } };
        const w = world(
            { resolveRevFn: vi.fn(() => OTHER), installFn: vi.fn(realInstall) },
            { lock: formatCoreLock(newer) },
        );
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toBe(
            `❌ state: нынешняя ревизия пишет v${String(st + 1)}, новая читает только до v${String(st)} — откат схемы state не поддерживается`,
        );
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
    });

    it.each([
        ['битый', () => ({ configVersion: 'x' }), /config: версия не определена \(configVersion/],
        ['не объект', () => [], /конфиг не объект/],
        [
            'не читается',
            () => {
                throw new Error('ENOENT');
            },
            /конфиг не прочитан: ENOENT/,
        ],
    ])('конфиг %s — отказ до PR', (_n, rawConfigFn, why) => {
        const w = uworld({ rawConfigFn: vi.fn(rawConfigFn) });
        expect(update(w, 'v2')).toBe(1);
        expect(w.out.join('\n')).toMatch(why);
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
    });

    it('недоскачанная ревизия: установка оборвалась — отказ до PR', () => {
        const w = uworld({
            installFn: vi.fn(() => {
                throw new Error('git checkout: обрыв');
            }),
        });
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(/ревизия b+ не установлена — git checkout: обрыв.*PR не заведён/);
        expect(w.deps.versionsOfFn).not.toHaveBeenCalled();
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
    });

    it('каталог ревизии уже лежал и разошёлся со своим манифестом — его код не исполняется', () => {
        const other = join(dataDir, OTHER);
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, 'ralph.js'), 'правлено\n');
        writeFileSync(join(other, INSTALL_MANIFEST), formatManifest(buildManifest(dir)));
        const w = uworld({
            installFn: vi.fn(() => ({
                status: 'present' as const,
                dir: other,
                treeHash: lock.treeHash,
            })),
        });
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(/не цела: .*Убери каталог и повтори update/);
        expect(w.deps.versionsOfFn).not.toHaveBeenCalled();
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
    });

    it.each([
        [
            'бросила',
            () => {
                throw new Error('код 1');
            },
            /не назвала свои версии: код 1/,
        ],
        ['ответила не по контракту', () => 'v2', /не назвала свои версии: ответ не по контракту/],
    ])('ревизия %s на запрос версий — отказ до PR', (_n, versionsOfFn, why) => {
        const w = uworld({ versionsOfFn: vi.fn(versionsOfFn) });
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(why);
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
    });

    it('lock уже называет эту ревизию — менять нечего, ничего не ставится', () => {
        const w = world();
        expect(update(w, 'v1')).toBe(0);
        expect(w.out[0]).toMatch(/уже называет a+ — менять нечего/);
        expect(w.deps.installFn).not.toHaveBeenCalled();
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
    });

    it.each([
        ['без источника', [], {}, /источник не задан/],
        [
            'битый lock',
            ['--source', '/src'],
            { lock: '{' },
            /обновлять нечего, сначала почини lock/,
        ],
        ['нет lock', ['--source', '/src'], { lock: null }, /core\.lock нет — обновлять нечего/],
    ])('отказ до установки: %s', (_n, extra, opts, why) => {
        const w = world({}, opts as { lock?: string | null });
        expect(run(w, 'update', ...extra, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(why);
        expect(w.deps.installFn).not.toHaveBeenCalled();
    });

    // Парсер без ревизии update не пропускает; страж в самой команде — для вызова мимо него.
    it('отказ до установки: ревизия не названа', () => {
        const w = world();
        const args = {
            command: 'update' as const,
            consumerRoot: CONSUMER,
            source: '/src',
            rev: null,
            profile: null,
            passthrough: [],
        };
        expect(runUpdateCommand(args, w.deps)).toBe(1);
        expect(w.out[0]).toMatch(/ревизия не названа\. PR не заведён/);
        expect(w.deps.installFn).not.toHaveBeenCalled();
    });

    it('ревизии нет в источнике — отказ с причиной', () => {
        const w = world({
            resolveRevFn: vi.fn(() => {
                throw new Error('ревизии v9 нет в /src');
            }),
        });
        expect(update(w, 'v9')).toBe(1);
        expect(w.out[0]).toBe('⛔ update: ревизии v9 нет в /src. PR не заведён.');
    });

    it('каталог установок не задан — отказ', () => {
        const w = world();
        w.deps.env.RALPH_DATA_DIR = 'rel';
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(/RALPH_DATA_DIR=rel не абсолютный путь/);
    });

    it('ветка не запушена — отказ, PR не заводится', () => {
        const w = uworld({
            pushLockBranchFn: vi.fn(() => {
                throw new Error('non-fast-forward');
            }),
        });
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(
            /ветка ralph\/core-b+ с правкой lock не запушена — non-fast-forward/,
        );
        expect(w.deps.openPrFn).not.toHaveBeenCalled();
    });

    it('ветка запушена, PR не заведён — ветка названа по имени', () => {
        const w = uworld({
            openPrFn: vi.fn(() => {
                throw new Error('HTTP 403');
            }),
        });
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(
            /ветка ralph\/core-b+ \(c+\) запушена, но PR не заведён — HTTP 403/,
        );
    });

    it('PR ветки уже открыт (повтор после обрыва) — второй не заводится (#104)', () => {
        const w = uworld({ findOpenPrFn: vi.fn(() => 9) });
        expect(update(w, 'v2')).toBe(0);
        expect(w.deps.findOpenPrFn).toHaveBeenCalledWith(
            CONSUMER,
            'ralph/core-' + OTHER.slice(0, 12),
            null,
        );
        expect(w.deps.openPrFn).not.toHaveBeenCalled();
        expect(w.out.at(-1)).toMatch(/PR #9 из ralph\/core-b+ \(c+\) уже открыт/);
    });

    it('PR ветки не прочитался — отказ с именем ветки, второй PR не заводится вслепую', () => {
        const w = uworld({
            findOpenPrFn: vi.fn(() => {
                throw new Error('HTTP 502');
            }),
        });
        expect(update(w, 'v2')).toBe(1);
        expect(w.out[0]).toMatch(
            /ветка ralph\/core-b+ \(c+\) запушена, но PR не заведён — PR ветки не прочитан: HTTP 502/,
        );
        expect(w.deps.openPrFn).not.toHaveBeenCalled();
    });

    it.each([
        [['update'], /ровно одну ревизию/],
        [['update', 'a', 'b'], /ровно одну ревизию/],
        [['update', '--rev', 'a', 'b'], /ровно одну ревизию/],
        [['update', 'a', '--force'], /update не знает флага "--force"/],
    ])('разбор %j — отказ', (argv, why) => {
        const r = parseLauncherArgv(['--consumer', CONSUMER, ...argv]);
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.reason).toMatch(why);
    });

    it('разбор: позиционная ревизия уходит в rev', () => {
        const r = parseLauncherArgv(['--consumer', CONSUMER, 'update', 'v2']);
        expect(r).toMatchObject({
            ok: true,
            args: { command: 'update', rev: 'v2', passthrough: [] },
        });
    });
});

describe('rollback (#103)', () => {
    const RUNTIME = '/run/ralph';
    const JOURNAL = join(RUNTIME, 'ralph.activations.jsonl');
    const STATE = join(RUNTIME, 'ralph.state.json');
    const stateText = (schemaVersion: number) =>
        JSON.stringify({ schemaVersion, count: 3, milestone: 'Ф13', submitStages: [] });
    const at = '2026-10-27T00:00:00.000Z';
    const journalText = [
        JSON.stringify({ at, sha: OTHER, from: null }),
        JSON.stringify({ at, sha: SHA, from: OTHER }),
        '',
    ].join('\n');

    let prevDir: string;
    let prevTreeHash: string;
    // Прежняя ревизия лежит в каталоге установок рядом с исполняемой — так её и оставляет
    // чистка (`core-rollback.test.ts`).
    beforeEach(() => {
        prevDir = join(dataDir, OTHER);
        mkdirSync(join(prevDir, 'core'), { recursive: true });
        writeFileSync(join(prevDir, 'ralph.js'), 'entry v0\n');
        writeFileSync(join(prevDir, 'core', 'a.ts'), 'a v0\n');
        const manifest = formatManifest(buildManifest(prevDir));
        writeFileSync(join(prevDir, INSTALL_MANIFEST), manifest);
        prevTreeHash = treeHashOf(manifest);
    });

    const rworld = (
        over: Partial<TLauncherDeps> = {},
        opts: { lock?: string | null; journal?: string | null; state?: string | null } = {},
    ) => {
        const w = world(
            {
                installFn: vi.fn(({ sha }) => ({
                    status: 'present' as const,
                    dir: join(dataDir, sha),
                    treeHash: prevTreeHash,
                })),
                ...over,
            },
            { lock: opts.lock },
        );
        const j = opts.journal === undefined ? journalText : opts.journal;
        if (j !== null) w.files.set(JOURNAL, j);
        const s = opts.state === undefined ? stateText(supportedVersions().state) : opts.state;
        if (s !== null) w.files.set(STATE, s);
        return w;
    };
    const rollback = (w: TWorld, ...argv: string[]) => run(w, 'rollback', ...argv);
    const untouched = (w: TWorld) => {
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
        expect(w.deps.openPrFn).not.toHaveBeenCalled();
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
        expect(w.files.get(LOCK_PATH)).toBe(formatCoreLock(lock));
    };

    it('без миграции: lock в ветке PR возвращается на прежнюю ревизию, state сохранён', () => {
        const w = rworld();
        const stateBefore = w.files.get(STATE);
        expect(rollback(w)).toBe(0);
        const prev: TCoreLock = {
            schema: CORE_LOCK_SCHEMA,
            sha: OTHER,
            treeHash: prevTreeHash,
            versions: supportedVersions(),
        };
        const branch = `ralph/rollback-${OTHER.slice(0, 12)}`;
        expect(w.deps.pushLockBranchFn).toHaveBeenCalledWith({
            consumerRoot: CONSUMER,
            branch,
            lock: prev,
            message: expect.stringContaining(`стало: \`${OTHER}\``) as string,
        });
        expect(w.deps.openPrFn).toHaveBeenCalledWith(
            CONSUMER,
            {
                branch,
                title: `revert(core): откат ревизии ядра на ${OTHER.slice(0, 12)}`,
                body: expect.stringContaining(`было: \`${SHA}\``) as string,
            },
            null,
        );
        // State, lock человека и исполняемая ревизия не тронуты, петля не остановлена.
        expect(w.files.get(STATE)).toBe(stateBefore);
        expect(w.files.get(LOCK_PATH)).toBe(formatCoreLock(lock));
        expect(w.deps.writeLockFn).not.toHaveBeenCalled();
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.deps.runCoreFn).not.toHaveBeenCalled();
        expect(verifyInstalledTree(dir, lock)).toEqual({ ok: true });
        expect(w.deps.installFn).toHaveBeenCalledWith({ sha: OTHER, dataDir, source: null });
        expect(w.out.at(-1)).toMatch(new RegExp(`PR #7 из ${branch}`));
    });

    it('через необратимую миграцию state (схема поднята в lock) — отказ до правки lock', () => {
        const st = supportedVersions().state;
        lock = { ...lock, versions: { ...lock.versions, state: st + 1 } };
        const w = rworld({}, { state: stateText(st + 1) });
        expect(rollback(w)).toBe(1);
        expect(w.out.join('\n')).toMatch(/необратимая миграция/);
        expect(w.out.join('\n')).toMatch(/фикс вперёд/);
        expect(w.out.at(-1)).toMatch(/⛔ rollback: .*Lock не тронут, PR не заведён\./);
        untouched(w);
    });

    it('state на диске новее, чем читает прежняя ревизия, — отказ до правки lock', () => {
        const w = rworld({}, { state: stateText(supportedVersions().state + 1) });
        expect(rollback(w)).toBe(1);
        expect(w.out.join('\n')).toMatch(/на диске схема v\d+, цель отката читает только до/);
        untouched(w);
    });

    it('state нет — откат идёт', () => {
        expect(rollback(rworld({}, { state: null }))).toBe(0);
    });

    it('журнала активации нет — отказ: откатываться не на что', () => {
        const w = rworld({}, { journal: null });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/журнал активации пуст/);
        untouched(w);
        expect(w.deps.installFn).not.toHaveBeenCalled();
    });

    it('битый журнал — отказ с номером строки', () => {
        const w = rworld({}, { journal: 'мусор\n' });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/строка 1: не JSON — без журнала цель отката неизвестна/);
        untouched(w);
    });

    it('журнал не читается — отказ, а не «журнала нет»', () => {
        const base = rworld();
        const w = rworld({
            readFn: (p) => {
                if (p === JOURNAL) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
                return base.deps.readFn(p);
            },
        });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/журнал активации .* не читается — EACCES/);
        untouched(w);
    });

    it('битый lock — отказ', () => {
        const w = rworld({}, { lock: 'мусор' });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/откатывать нечего/);
        expect(w.deps.pushLockBranchFn).not.toHaveBeenCalled();
    });

    it('каталог состояния не определён — отказ', () => {
        const w = rworld({
            runtimeDirOfFn: vi.fn(() => {
                throw new Error('нет секции roots');
            }),
        });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/нет секции roots/);
        untouched(w);
    });

    it('прежней ревизии нет и источника нет — отказ с причиной установки', () => {
        const w = rworld({
            installFn: vi.fn(() => {
                throw new Error('источника нет');
            }),
        });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/прежняя ревизия b+ не установлена — источника нет/);
        untouched(w);
    });

    it('прежняя ревизия разошлась со своим манифестом — её код не исполняется', () => {
        writeFileSync(join(prevDir, 'ralph.js'), 'правка\n');
        const w = rworld();
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/не цела/);
        expect(w.deps.versionsOfFn).not.toHaveBeenCalled();
        untouched(w);
    });

    it('прежняя ревизия не назвала версий — отказ', () => {
        const w = rworld({ versionsOfFn: vi.fn(() => ({ launcher: 'x' })) });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/не назвала свои версии: ответ не по контракту/);
        untouched(w);
    });

    it('шим не той версии, что ждёт прежняя ревизия, — отказ', () => {
        const w = rworld();
        w.deps.env.RALPH_LAUNCHER_VERSION = '99';
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/^❌ launcher: ревизия ждёт v1, у потребителя v99/);
        untouched(w);
    });

    it('roots.productRoot на ревизии из lock — предупреждение с путём прежней', () => {
        const w = rworld({
            rawConfigFn: vi.fn(() => ({
                configVersion: 1,
                common: { roots: { productRoot: dir } },
            })),
        });
        expect(rollback(w)).toBe(0);
        expect(w.out.at(-1)).toMatch(/⚠ common\.roots\.productRoot .* поправь его на .*b{40}/);
    });

    it('ветка не запушена — отказ, PR не заводится', () => {
        const w = rworld({
            pushLockBranchFn: vi.fn(() => {
                throw new Error('non-fast-forward');
            }),
        });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/ветка ralph\/rollback-b+ с правкой lock не запушена/);
        expect(w.deps.openPrFn).not.toHaveBeenCalled();
    });

    it('ветка запушена, PR не заведён — ветка названа по имени', () => {
        const w = rworld({
            openPrFn: vi.fn(() => {
                throw new Error('HTTP 403');
            }),
        });
        expect(rollback(w)).toBe(1);
        expect(w.out[0]).toMatch(/ветка ralph\/rollback-b+ \(c+\) запушена, но PR не заведён/);
    });

    // Адаптеры форжа — из профиля команды, а не профиля по умолчанию (ревью Фазы 13).
    it('--profile доезжает до шва форжа: поиск и заведение PR', () => {
        const w = rworld();
        expect(rollback(w, '--profile', 'night')).toBe(0);
        const branch = `ralph/rollback-${OTHER.slice(0, 12)}`;
        expect(w.deps.findOpenPrFn).toHaveBeenCalledWith(CONSUMER, branch, 'night');
        expect(w.deps.openPrFn).toHaveBeenCalledWith(CONSUMER, expect.anything(), 'night');
    });

    it('PR ветки уже открыт (повтор после обрыва) — второй не заводится (#104)', () => {
        const w = rworld({ findOpenPrFn: vi.fn(() => 9) });
        expect(rollback(w)).toBe(0);
        expect(w.deps.openPrFn).not.toHaveBeenCalled();
        expect(w.out.at(-1)).toMatch(/PR #9 из ralph\/rollback-b+ \(c+\) уже открыт/);
    });

    it('форж не назвал номер PR — успех без номера', () => {
        const w = rworld({ openPrFn: vi.fn(() => null) });
        expect(rollback(w)).toBe(0);
        expect(w.out.at(-1)).toMatch(/^🔀 PR из ralph\/rollback-/);
    });

    it('профиль уходит в адрес каталога состояния', () => {
        const w = rworld();
        expect(rollback(w, '--profile', 'night')).toBe(0);
        expect(w.deps.runtimeDirOfFn).toHaveBeenCalledWith(CONSUMER, 'night');
    });

    it.each([
        [['rollback', '--force'], /rollback не знает флага "--force"/],
        [['rollback', '--rev', 'x'], /флаги install и update, а не rollback/],
    ])('разбор %j — отказ', (argv, why) => {
        const r = parseLauncherArgv(['--consumer', CONSUMER, ...argv]);
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.reason).toMatch(why);
    });
});

describe('реестр потребителей и prune (#138)', () => {
    const NEIGHBOR = '/work/neighbor';
    const C = 'c'.repeat(40);
    const D = 'd'.repeat(40);
    const records = (w: TWorld) =>
        [...w.files.entries()]
            .filter(([p]) => p.startsWith(join(dataDir, '.consumers') + '/'))
            .map(([, t]) => JSON.parse(t) as unknown);
    const journalLine = (sha: string, from: string | null) =>
        `${JSON.stringify({ at: '2026-10-01T00:00:00Z', sha, from })}\n`;
    /** Сосед в реестре: исполняется OTHER, цель отката — C. */
    const withNeighbor = (w: TWorld) => {
        registerConsumer(
            dataDir,
            { consumerRoot: NEIGHBOR, runtimeDir: '/run/nb' },
            w.deps.registryFs,
        );
        w.files.set(join(NEIGHBOR, '.ralph', 'core.lock'), formatCoreLock({ ...lock, sha: OTHER }));
        w.files.set(
            '/run/nb/ralph.activations.jsonl',
            journalLine(C, null) + journalLine(OTHER, C),
        );
    };

    it('start пишет потребителя с каталогом состояния своего профиля до запуска ядра', () => {
        const w = world();
        const runtimeDirOfFn = vi.fn(() => '/run/p');
        w.deps.runtimeDirOfFn = runtimeDirOfFn;
        w.deps.runCoreFn = vi.fn(() => {
            expect(records(w)).toEqual([{ consumerRoot: CONSUMER, runtimeDir: '/run/p' }]);
            return 0;
        });
        expect(run(w, 'start', '--profile=p')).toBe(0);
        expect(runtimeDirOfFn).toHaveBeenCalledWith(CONSUMER, 'p');
    });

    it('start не идёт, если запись реестра не легла', () => {
        const w = world();
        w.deps.registryFs.writeAtomic = () => {
            throw new Error('ENOSPC');
        };
        expect(run(w, 'start')).toBe(1);
        expect(w.deps.runCoreFn).not.toHaveBeenCalled();
        expect(w.out.join('\n')).toMatch(/start отменён: запись реестра .*ENOSPC/);
    });

    it('start без каталога состояния — отказ, а не старт мимо реестра', () => {
        const w = world({
            runtimeDirOfFn: () => {
                throw new Error('нет секции roots');
            },
        });
        expect(run(w, 'start')).toBe(1);
        expect(w.out.join('\n')).toMatch(/каталог состояния для реестра .*нет секции roots/);
    });

    it('install пишет потребителя без каталога состояния до установки', () => {
        const w = world();
        w.deps.installFn = vi.fn(({ sha }) => {
            expect(records(w)).toEqual([{ consumerRoot: CONSUMER, runtimeDir: null }]);
            return { status: 'present' as const, dir: join(dataDir, sha), treeHash: lock.treeHash };
        });
        run(w, 'install');
        expect(w.deps.installFn).toHaveBeenCalled();
    });

    it('install по lock: отказ записи реестра — без установки', () => {
        const w = world();
        w.deps.registryFs.writeAtomic = () => {
            throw new Error('EROFS');
        };
        expect(run(w, 'install')).toBe(1);
        expect(w.deps.installFn).not.toHaveBeenCalled();
        expect(w.out.join('\n')).toMatch(/⛔ install: запись реестра .*EROFS/);
    });

    it('install без lock тоже пишет реестр до установки, отказ записи — без установки', () => {
        const w = world({}, { lock: null });
        w.deps.registryFs.writeAtomic = () => {
            throw new Error('EACCES');
        };
        expect(run(w, 'install', '--source', '/src', '--rev', 'v1')).toBe(1);
        expect(w.deps.installFn).not.toHaveBeenCalled();
        const w2 = world({}, { lock: null });
        expect(run(w2, 'install', '--source', '/src', '--rev', 'v1')).toBe(0);
        expect(records(w2)).toEqual([{ consumerRoot: CONSUMER, runtimeDir: null }]);
    });

    it('ревизии соседа (lock, исполняемая, цель отката) и живого раннера не удаляются', () => {
        const w = world();
        withNeighbor(w);
        w.deps.listDataDirFn = vi.fn(() => [SHA, OTHER, C, D, 'e'.repeat(40), '.consumers']);
        w.deps.runningRevisionsFn = vi.fn(() => new Set(['e'.repeat(40)]));
        expect(run(w, 'prune')).toBe(0);
        // Своему нужна SHA; без соседа ушли бы OTHER и C, без сверки раннеров — e….
        expect(w.deps.renameFn).toHaveBeenCalledTimes(1);
        const [from, to] = (w.deps.renameFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
            string,
            string,
        ];
        expect(from).toBe(join(dataDir, D));
        expect(to).toMatch(new RegExp(`/\\.${D}\\.pruning-\\d+$`));
        expect(w.deps.rmFn).toHaveBeenCalledWith(to);
        expect(w.out.join('\n')).toMatch(/удалено 1, учтено потребителей: 2/);
    });

    it('prune сам вписывает своего потребителя: поставленный до реестра свою ревизию не теряет', () => {
        const w = world();
        w.deps.listDataDirFn = vi.fn(() => [SHA]);
        expect(run(w, 'prune')).toBe(0);
        // С каталогом состояния профиля по умолчанию, а не одним lock: журнал там держит
        // цель отката.
        expect(records(w)).toEqual([{ consumerRoot: CONSUMER, runtimeDir: '/run/ralph' }]);
        expect(w.deps.runtimeDirOfFn).toHaveBeenCalledWith(CONSUMER, null);
        expect(w.deps.renameFn).not.toHaveBeenCalled();
        expect(w.out.join('\n')).toMatch(/удалять нечего — все 1 ревизий кому-то нужны/);
    });

    // Ревью #138: потребитель, стартовавший ревизией без реестра, — цель отката из его
    // журнала держится вписыванием самого prune, а не только исполняемая по `/proc`.
    it('prune держит цель отката своего потребителя, стартовавшего до реестра', () => {
        const w = world();
        w.files.set(
            '/run/ralph/ralph.activations.jsonl',
            journalLine(C, null) + journalLine(SHA, C),
        );
        w.deps.listDataDirFn = vi.fn(() => [SHA, C, D]);
        expect(run(w, 'prune')).toBe(0);
        expect(w.deps.renameFn).toHaveBeenCalledTimes(1);
        expect((w.deps.renameFn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
            join(dataDir, D),
        );
    });

    it('prune: каталог состояния своего потребителя не определён — отказ, ничего не удалено', () => {
        const w = world({
            runtimeDirOfFn: () => {
                throw new Error('нет секции roots');
            },
        });
        w.deps.listDataDirFn = vi.fn(() => [SHA, D]);
        expect(run(w, 'prune')).toBe(1);
        expect(w.deps.renameFn).not.toHaveBeenCalled();
        expect(w.out.join('\n')).toMatch(
            /⛔ prune: каталог состояния .*нет секции roots.*Ничего не удалено/,
        );
    });

    it('prune: запись своего потребителя не легла — отказ, ничего не удалено', () => {
        const w = world();
        w.deps.registryFs.writeAtomic = () => {
            throw new Error('EROFS');
        };
        w.deps.listDataDirFn = vi.fn(() => [SHA, D]);
        expect(run(w, 'prune')).toBe(1);
        expect(w.deps.renameFn).not.toHaveBeenCalled();
        expect(w.out.join('\n')).toMatch(/⛔ prune: запись реестра .*EROFS.*Ничего не удалено/);
    });

    it('start --dry-run реестр не пишет: сухой прогон только читает', () => {
        const w = world();
        expect(run(w, 'start', '--dry-run')).toBe(0);
        expect(records(w)).toEqual([]);
        expect(w.deps.runtimeDirOfFn).not.toHaveBeenCalled();
    });

    it('start с кривым --profile — отказ текстом ядра, ядро не зовётся, реестр не тронут', () => {
        const w = world();
        expect(run(w, 'start', '--profile', 'a', '--profile=b')).toBe(1);
        expect(w.deps.runCoreFn).not.toHaveBeenCalled();
        expect(records(w)).toEqual([]);
        expect(w.out.join('\n')).toMatch(/start отменён: Флаг --profile указан 2 раза/);
    });

    it.each([
        [
            'нечитаемый lock соседа',
            (w: TWorld) => w.files.delete(join(NEIGHBOR, '.ralph', 'core.lock')),
        ],
        [
            'битый журнал соседа',
            (w: TWorld) => w.files.set('/run/nb/ralph.activations.jsonl', '{\n'),
        ],
    ])('%s — отказ чистки целиком, ничего не удалено', (_n, spoil) => {
        const w = world();
        withNeighbor(w);
        spoil(w);
        w.deps.listDataDirFn = vi.fn(() => [SHA, OTHER, C, D]);
        expect(run(w, 'prune')).toBe(1);
        expect(w.deps.renameFn).not.toHaveBeenCalled();
        expect(w.deps.rmFn).not.toHaveBeenCalled();
        expect(w.out.join('\n')).toMatch(/❌ \/work\/neighbor[\s\S]*Ничего не удалено/);
    });

    it.each([
        [
            'живые раннеры не выяснены',
            {
                runningRevisionsFn: () => {
                    throw new Error('/proc: EACCES');
                },
            },
        ],
        [
            'каталог установок не читается',
            {
                listDataDirFn: () => {
                    throw new Error('EIO');
                },
            },
        ],
        ['каталог установок не задан', { env: { RALPH_LAUNCHER_VERSION: '1' } }],
    ] as [string, Partial<TLauncherDeps>][])('%s — отказ без удаления', (_n, over) => {
        const w = world(over);
        expect(run(w, 'prune')).toBe(1);
        expect(w.out.join('\n')).toMatch(/⛔ prune: .*Ничего не удалено/);
    });

    it('остаток прерванной чистки снимается; оборванное удаление — код 1 с причиной', () => {
        const w = world();
        w.deps.listDataDirFn = vi.fn(() => [SHA, `.${D}.pruning-7`, OTHER]);
        w.deps.rmFn = vi.fn((p: string) => {
            if (p.includes(OTHER)) throw new Error('EBUSY');
        });
        expect(run(w, 'prune')).toBe(1);
        expect(w.deps.rmFn).toHaveBeenCalledWith(join(dataDir, `.${D}.pruning-7`));
        expect(w.out.join('\n')).toMatch(/удаление оборвалось — EBUSY/);
    });

    it('prune без флагов', () => {
        expect(parseLauncherArgv(['--consumer', CONSUMER, 'prune', '--all'])).toEqual({
            ok: false,
            reason: expect.stringMatching(/prune не знает флага "--all"/),
        });
    });

    it('startProfile: разбор ядра — обе формы, кривой флаг — отказ, а не «последний победил»', () => {
        expect(startProfile(['--dry-run', '--profile', 'a'])).toEqual({ ok: true, profile: 'a' });
        expect(startProfile(['--profile=b'])).toEqual({ ok: true, profile: 'b' });
        expect(startProfile([])).toEqual({ ok: true, profile: null });
        for (const bad of [
            ['--profile'],
            ['--profile', '--once'],
            ['--profile='],
            ['--profile', 'a', '--profile=b'],
        ]) {
            expect(startProfile(bad)).toEqual({
                ok: false,
                reason: expect.stringMatching(/--profile/),
            });
        }
    });
});

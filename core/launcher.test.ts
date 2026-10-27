// Решения команд launcher на подменённых коллабораторах (#100). Сквозной путь на настоящем
// диске, git и раннере — `tests/launcher-scenarios.test.ts`; здесь — каждая развилка.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildManifest,
    CORE_LOCK_SCHEMA,
    formatCoreLock,
    formatManifest,
    INSTALL_MANIFEST,
    treeHashOf,
    type TCoreLock,
} from './core-install.ts';
import { supportedVersions } from './compat.ts';
import { formatCheck, parseLauncherArgv, runLauncher, type TLauncherDeps } from './launcher.ts';

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
        runtimeDirOfFn: vi.fn(() => '/run/ralph'),
        ralphAliveFn: vi.fn(() => true),
        writeStopFn: vi.fn((p: string) => {
            files.set(p, 'stop');
        }),
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
        [['--consumer', CONSUMER, 'start', '--rev', 'x'], /флаги install, а не start/],
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
            ['--doctor', '--profile', 'p'],
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
        expect(w.deps.runCoreFn).toHaveBeenCalledWith(dir, ['--dry-run'], CONSUMER);
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
        const w = world({ ralphAliveFn: vi.fn(() => false) });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(1);
        // Живость сверяется с entry ревизии из lock, а не с подстрокой `ralph.js`.
        expect(w.deps.ralphAliveFn).toHaveBeenCalledWith(4242, join(dir, 'ralph.js'));
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(
            /лок \/run\/ralph\/ralph\.lock брошен — раннера .*ralph\.js с pid 4242 нет/,
        );
    });

    it('lock потребителя не читается — отказ: чей раннер держит лок, не проверить', () => {
        const w = world({}, { lock: null });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(1);
        expect(w.deps.ralphAliveFn).not.toHaveBeenCalled();
        expect(w.deps.writeStopFn).not.toHaveBeenCalled();
        expect(w.out[0]).toMatch(/core\.lock нет — чей раннер держит лок, не проверить/);
    });

    it('каталог установок не задан — отказ до сверки живости', () => {
        const w = world({ env: { RALPH_LAUNCHER_VERSION: '1' } });
        w.files.set('/run/ralph/ralph.lock', '4242\n');
        expect(run(w, 'stop')).toBe(1);
        expect(w.deps.ralphAliveFn).not.toHaveBeenCalled();
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
        expect(w.deps.ralphAliveFn).not.toHaveBeenCalled();
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

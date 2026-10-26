// Владение репозиторием на хосте (канон, задача 76). Сценарий карточки — два клона
// одного bare-remote на настоящем git: вторая копия обязана не стартовать и назвать
// причину, а владелец, чей процесс умер, не блокирует старт навсегда. Остальное — исходы
// политики, гонки снятия сироты и нормализация адреса.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TProcProbe } from './repo-owner.ts';
import {
    acquireRepoOwnership,
    canonicalRepoId,
    ownerFilePath,
    ownersDir,
    probeProcess,
    releaseRepoOwnershipIfOurs,
} from './repo-owner.ts';

const itPosix = it.skipIf(process.platform === 'win32');

const id = (url: string, base = '/base') => canonicalRepoId(url, base, (p) => p);

describe('canonicalRepoId — одна репа под разными адресами даёт один ключ', () => {
    it.each([
        'https://Example.com/acme/app.git',
        'https://example.com/acme/app',
        'https://user@example.com:443/acme/app/',
        'ssh://git@example.com/acme/app.git',
        'ssh://git@example.com:2222/acme/app.git',
        'ssh://git@example.com/~/acme/app.git',
        'git@EXAMPLE.com:acme/app.git',
        'example.com:acme/app',
    ])('%s → example.com/acme/app', (url) => {
        expect(id(url)).toBe('example.com/acme/app');
    });

    it('регистр пути сохраняется: разные репы на регистрозависимой площадке не склеиваются', () => {
        expect(id('https://example.com/Acme/App')).toBe('example.com/Acme/App');
    });

    it('локальный путь и file:// одного каталога дают один ключ', () => {
        expect(id('/srv/remote.git')).toBe('file:/srv/remote');
        expect(id('file:///srv/remote.git')).toBe('file:/srv/remote');
    });

    it('относительный путь разрешается от каталога клона, а не от cwd процесса', () => {
        expect(id('../remote.git', '/srv/clones/a')).toBe('file:/srv/clones/remote');
        expect(id('clones/remote.git', '/srv')).toBe('file:/srv/clones/remote');
    });

    it('ссылка на каталог раскрывается realpath: два клона через разные ссылки — один ключ', () => {
        const real = (p: string) => (p === '/link/remote.git' ? '/srv/remote.git' : p);
        expect(canonicalRepoId('/link/remote.git', '/', real)).toBe('file:/srv/remote');
    });

    it('несуществующий локальный путь не роняет: ключ — абсолютный путь', () => {
        const missing = () => {
            throw Object.assign(new Error('нет'), { code: 'ENOENT' });
        };
        expect(canonicalRepoId('/nope/r.git', '/', missing)).toBe('file:/nope/r');
    });

    it('пустой адрес — ошибка, а не пустой ключ, общий всем репам без origin', () => {
        expect(() => canonicalRepoId('  ', '/')).toThrow(/пуст/);
    });
});

describe('ownersDir — каталог хоста, не из конфига потребителя', () => {
    it('RALPH_OWNERS_DIR переопределяет, пустое — tmpdir/ralph-owners', () => {
        expect(ownersDir({ RALPH_OWNERS_DIR: '/var/run/x' })).toBe('/var/run/x');
        expect(ownersDir({})).toBe('/tmp/ralph-owners');
        expect(ownersDir({ RALPH_OWNERS_DIR: '  ' })).toBe('/tmp/ralph-owners');
    });

    it('умолчание не зависит от TMPDIR: две копии с разным окружением видят один реестр', () => {
        expect(ownersDir({ TMPDIR: '/tmp/a' })).toBe(ownersDir({ TMPDIR: '/tmp/b' }));
    });

    it('относительный путь отвергается: от cwd у каждого клона вышел бы свой реестр', () => {
        expect(() => ownersDir({ RALPH_OWNERS_DIR: '.ralph-owners' })).toThrow(/не абсолютный/);
    });
});

describe('probeProcess — живость по kill 0 и /proc/<pid>/stat', () => {
    const stat = (state: string, start = '22') => {
        const rest = Array.from({ length: 18 }, (_, i) => String(i + 4)).join(' ');
        return `1 (ra) lph (x)) ${state} ${rest} ${start} 23`;
    };
    const err = (c: string) => () => {
        throw Object.assign(new Error(c), { code: c });
    };
    const ok = () => true;

    it('имя процесса со скобками и пробелами не сдвигает поля', () => {
        expect(probeProcess(1, { killFn: ok, readFn: () => stat('S') })).toEqual({
            state: 'alive',
            startTime: '22',
        });
    });

    it('ESRCH — мёртв, не читая /proc', () => {
        expect(probeProcess(1, { killFn: err('ESRCH'), readFn: err('EACCES') })).toEqual({
            state: 'dead',
        });
    });

    it('зомби (Z, X) — мёртв: вышел, и писать в репозиторий не может', () => {
        expect(probeProcess(1, { killFn: ok, readFn: () => stat('Z') }).state).toBe('dead');
        expect(probeProcess(1, { killFn: ok, readFn: () => stat('X') }).state).toBe('dead');
    });

    it('процесс есть (EPERM), а /proc скрыт — неизвестно, а не «мёртв»', () => {
        const r = probeProcess(1, { killFn: err('EPERM'), readFn: err('ENOENT') });
        expect(r.state).toBe('unknown');
    });

    it('/proc не читается по правам или без времени старта — неизвестно', () => {
        expect(probeProcess(1, { killFn: ok, readFn: err('EACCES') }).state).toBe('unknown');
        expect(probeProcess(1, { killFn: ok, readFn: () => '1 (x) S 2' }).state).toBe('unknown');
        expect(probeProcess(1, { killFn: err('EINVAL'), readFn: () => stat('S') }).state).toBe(
            'unknown',
        );
    });

    itPosix('у своего процесса — жив, время старта стабильно', () => {
        const a = probeProcess(process.pid);
        expect(a.state).toBe('alive');
        expect(probeProcess(process.pid)).toEqual(a);
    });
});

// Память вместо диска: исходы политики без файловой системы.
function memFs(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    const fsErr = (c: string) => Object.assign(new Error(c), { code: c });
    return {
        files,
        readFn: (p: string): string => {
            const v = files.get(p);
            if (v === undefined) throw fsErr('ENOENT');
            return v;
        },
        writeExclusiveFn: (p: string, data: string): void => {
            if (files.has(p)) throw fsErr('EEXIST');
            files.set(p, data);
        },
        removeFn: (p: string): void => void files.delete(p),
        mkdirFn: (_p: string): void => {},
    };
}

const DIR = '/owners';
const REPO = 'example.com/acme/app';
const FILE = ownerFilePath(DIR, REPO);
// Время старта — «t<pid>» у живых процессов.
const rec = (pid: number, lockPath = '/a/ralph.lock', startTime = `t${pid}`) =>
    JSON.stringify({ pid, startTime, repoId: REPO, lockPath });

type TWorld = Record<number, TProcProbe>;
const alive = (pid: number): TProcProbe => ({ state: 'alive', startTime: `t${pid}` });

function run(m: ReturnType<typeof memFs>, pid: number, world: TWorld = {}) {
    const fails: string[] = [];
    const logs: string[] = [];
    const ok = acquireRepoOwnership(
        { dir: DIR, repoId: REPO, lockPath: '/b/ralph.lock', pid },
        {
            ...m,
            probeFn: (p) => world[p] ?? (p === pid ? alive(p) : { state: 'dead' }),
            logFn: (s) => logs.push(s),
            failFn: (s) => fails.push(s),
        },
    );
    return { ok, fails, logs };
}

describe('acquireRepoOwnership — исходы политики', () => {
    it('записи нет → своя запись с pid, временем старта, ключом и локом дерева', () => {
        const m = memFs();
        expect(run(m, 20).ok).toBe(true);
        expect(JSON.parse(m.files.get(FILE)!)).toEqual({
            pid: 20,
            startTime: 't20',
            repoId: REPO,
            lockPath: '/b/ralph.lock',
        });
    });

    it('живой владелец → отказ называет pid и лок его дерева, запись не тронута', () => {
        const m = memFs({ [FILE]: rec(10) });
        const r = run(m, 20, { 10: alive(10) });
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toMatch(/pid 10/);
        expect(r.fails[0]).toMatch(/\/a\/ralph\.lock/);
        expect(r.fails[0]).toMatch(/второй writer/i);
        expect(m.files.get(FILE)).toBe(rec(10));
    });

    it('живость владельца не выяснить → стоп, запись не снята', () => {
        const m = memFs({ [FILE]: rec(10) });
        const r = run(m, 20, { 10: { state: 'unknown', reason: 'hidepid' } });
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toMatch(/Не выяснить, жив ли владелец.*hidepid/);
        expect(m.files.get(FILE)).toBe(rec(10));
    });

    it.each([
        ['мёртв', { state: 'dead' } as TProcProbe],
        ['pid-reuse: жив другой процесс', { state: 'alive', startTime: 'other' } as TProcProbe],
    ])('сирота (%s) → событие в лог, запись переписана на себя, мьютекс убран', (_n, probe) => {
        const m = memFs({ [FILE]: rec(10) });
        const r = run(m, 20, { 10: probe });
        expect(r.ok).toBe(true);
        expect(r.logs[0]).toMatch(/Устаревшее владение.*pid 10/);
        expect(JSON.parse(m.files.get(FILE)!).pid).toBe(20);
        expect([...m.files.keys()]).toEqual([FILE]);
    });

    it('своя запись этого же процесса → повтор взятия, не отказ', () => {
        const m = memFs();
        run(m, 20);
        expect(run(m, 20).ok).toBe(true);
    });

    it('наш pid от умершего владельца (другое время старта) → сирота, запись переписана', () => {
        const m = memFs({ [FILE]: rec(20, '/a/ralph.lock', 'old') });
        expect(run(m, 20).ok).toBe(true);
        expect(JSON.parse(m.files.get(FILE)!).startTime).toBe('t20');
    });

    it('своё время старта не выяснено → стоп, запись не пишется', () => {
        const m = memFs();
        const r = run(m, 20, { 20: { state: 'unknown', reason: 'x' } });
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toMatch(/время старта своего процесса/);
        expect(m.files.size).toBe(0);
    });

    it.each([
        ['не JSON', 'garbage'],
        [
            'pid не число',
            JSON.stringify({ pid: 'x', startTime: 't', repoId: REPO, lockPath: '/a' }),
        ],
        ['pid ноль', JSON.stringify({ pid: 0, startTime: 't', repoId: REPO, lockPath: '/a' })],
        ['нет lockPath', JSON.stringify({ pid: 5, startTime: 't5', repoId: REPO })],
        ['нет startTime', JSON.stringify({ pid: 5, repoId: REPO, lockPath: '/a' })],
        ['null', 'null'],
    ])('битая запись (%s) → стоп fail-closed, не «сирота»', (_n, raw) => {
        const m = memFs({ [FILE]: raw });
        const r = run(m, 20);
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toMatch(/битая/);
        expect(m.files.get(FILE)).toBe(raw);
    });

    it.each([
        ['чтение записи', 'readFn', 'EACCES'],
        ['каталог реестра', 'mkdirFn', 'EACCES'],
        ['запись', 'writeExclusiveFn', 'ENOSPC'],
    ] as const)('отказ файловой системы (%s) → стоп с причиной, а не стек', (_n, fn, errCode) => {
        const m = memFs();
        m[fn] = () => {
            throw Object.assign(new Error(errCode), { code: errCode });
        };
        const r = run(m, 20);
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toContain(`недоступен (${errCode})`);
        expect(r.fails[0]).toMatch(/RALPH_OWNERS_DIR/);
    });
});

describe('снятие сироты — под мьютексом, гонки не дают двух владельцев', () => {
    it('сироту сняли и взяли, пока мы решали → под мьютексом видно, отказ', () => {
        const m = memFs({ [FILE]: rec(10) });
        const read = m.readFn;
        let first = true;
        m.readFn = (p) => {
            const v = read(p);
            if (p === FILE && first) {
                first = false;
                m.files.set(FILE, rec(30));
            }
            return v;
        };
        const r = run(m, 20, { 30: alive(30) });
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toMatch(/перехвачено/);
        expect(JSON.parse(m.files.get(FILE)!).pid).toBe(30);
        expect([...m.files.keys()]).toEqual([FILE]);
    });

    it('мьютекс этой сироты уже есть → отказ называет мьютекс, запись не тронута', () => {
        const mutex = `${FILE}.reclaim-10-t10`;
        const m = memFs({ [FILE]: rec(10), [mutex]: '30' });
        const r = run(m, 20);
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toContain(mutex);
        expect(m.files.get(FILE)).toBe(rec(10));
        expect(m.files.get(mutex)).toBe('30');
    });

    it('между снятием и записью запись взял свежий старт → отказ, мьютекс убран', () => {
        const m = memFs({ [FILE]: rec(10) });
        const remove = m.removeFn;
        m.removeFn = (p) => {
            remove(p);
            if (p === FILE) m.files.set(FILE, rec(30));
        };
        const r = run(m, 20);
        expect(r.ok).toBe(false);
        expect(r.fails[0]).toMatch(/перехвачено/);
        expect(JSON.parse(m.files.get(FILE)!).pid).toBe(30);
        expect([...m.files.keys()]).toEqual([FILE]);
    });
});

describe('снятие сироты — уборка мьютекса', () => {
    it('мьютекс не убрался после успешного взятия → взятие остаётся успешным, предупреждение в лог', () => {
        const m = memFs({ [FILE]: rec(10) });
        const remove = m.removeFn;
        m.removeFn = (p) => {
            if (p.includes('.reclaim-'))
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            remove(p);
        };
        const r = run(m, 20);
        expect(r.ok).toBe(true);
        expect(r.fails).toEqual([]);
        expect(JSON.parse(m.files.get(FILE)!).pid).toBe(20);
        expect(r.logs.at(-1)).toMatch(/не убран \(EACCES\)/);
    });
});

describe('releaseRepoOwnershipIfOurs — снимает только свою запись', () => {
    const rel = (m: ReturnType<typeof memFs>, pid: number) =>
        releaseRepoOwnershipIfOurs({ dir: DIR, repoId: REPO, pid }, { ...m, probeFn: alive });

    it('своя → снята; чужой pid → на месте; свой pid с чужим стартом → на месте', () => {
        const m = memFs({ [FILE]: rec(20) });
        rel(m, 20);
        expect(m.files.has(FILE)).toBe(false);

        m.files.set(FILE, rec(30));
        rel(m, 20);
        expect(m.files.get(FILE)).toBe(rec(30));

        m.files.set(FILE, rec(20, '/a', 'old'));
        rel(m, 20);
        expect(m.files.get(FILE)).toBe(rec(20, '/a', 'old'));
    });

    it('нет файла или отказ удаления на выходе → тихо, следующий старт разберёт сироту', () => {
        const m = memFs();
        expect(() => rel(m, 20)).not.toThrow();
        m.files.set(FILE, rec(20));
        m.removeFn = () => {
            throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        };
        expect(() => rel(m, 20)).not.toThrow();
    });
});

describe('сценарий карточки: два клона одного bare-remote на настоящем git', () => {
    const tmp: string[] = [];
    afterEach(() => {
        for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

    function fixture() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-owner-'));
        tmp.push(root);
        const remote = path.join(root, 'remote.git');
        git(root, 'init', '--bare', '-q', remote);
        git(root, 'clone', '-q', remote, path.join(root, 'a'));
        // Второй клон — другим адресом той же репы: относительным путём через ссылку.
        fs.mkdirSync(path.join(root, 'deep'));
        fs.symlinkSync(root, path.join(root, 'via-link'));
        git(path.join(root, 'deep'), 'clone', '-q', '../via-link/remote.git', 'b');
        const idOf = (clone: string) => {
            const dir = path.join(root, clone);
            return canonicalRepoId(git(dir, 'remote', 'get-url', 'origin'), dir);
        };
        const realFs = {
            readFn: (p: string) => fs.readFileSync(p, 'utf-8'),
            writeExclusiveFn: (p: string, d: string) => fs.writeFileSync(p, d, { flag: 'wx' }),
            removeFn: (p: string) => fs.rmSync(p, { force: true }),
            mkdirFn: (p: string) => void fs.mkdirSync(p, { recursive: true }),
        };
        return { root, dir: path.join(root, 'owners'), idOf, realFs };
    }

    itPosix('вторая копия из другого клона не стартует и называет причину', () => {
        const { root, dir, idOf, realFs } = fixture();
        expect(idOf('a')).toBe(idOf('deep/b'));
        const fails: string[] = [];
        const deps = { ...realFs, probeFn: alive, failFn: (s: string) => void fails.push(s) };

        const lockA = path.join(root, 'a', 'ralph.lock');
        const a = { dir, repoId: idOf('a'), lockPath: lockA, pid: 101 };
        expect(acquireRepoOwnership(a, deps)).toBe(true);
        const b = { dir, repoId: idOf('deep/b'), lockPath: path.join(root, 'b'), pid: 202 };
        expect(acquireRepoOwnership(b, deps)).toBe(false);
        expect(fails[0]).toMatch(/pid 101/);
        expect(fails[0]).toContain(lockA);
    });

    itPosix('упавший владелец не блокирует навсегда: после его смерти второй клон стартует', () => {
        const { root, dir, idOf, realFs } = fixture();
        const live = new Set([101, 202]);
        const probeFn = (p: number): TProcProbe => (live.has(p) ? alive(p) : { state: 'dead' });
        const deps = { ...realFs, probeFn, failFn: () => {} };
        const a = { dir, repoId: idOf('a'), lockPath: path.join(root, 'a'), pid: 101 };
        acquireRepoOwnership(a, deps);

        live.delete(101); // kill -9 / OOM: запись осталась, процесса нет
        const b = { dir, repoId: idOf('deep/b'), lockPath: path.join(root, 'b'), pid: 202 };
        expect(acquireRepoOwnership(b, deps)).toBe(true);
        const file = ownerFilePath(dir, b.repoId);
        expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(202);
        expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);

        releaseRepoOwnershipIfOurs({ dir, repoId: b.repoId, pid: 202 }, { ...realFs, probeFn });
        expect(fs.existsSync(file)).toBe(false);
    });
});

// Установка ревизии ядра и сверка перед стартом (Фаза 12). ФС настоящая, во временном
// каталоге: атомарность установки — свойство `rename` на диске, фейк ФС согласился бы с
// любым порядком шагов. Боевые дефолты модуля под предохранителем побочек, поэтому тест
// подаёт свою ФС параметром; сами дефолты проходят в дочернем процессе — там же, где
// установку убивают сигналом.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    CORE_LOCK_PATH,
    CORE_LOCK_SCHEMA,
    INSTALL_MANIFEST,
    buildManifest,
    checkCoreBeforeStart,
    describeStartCheck,
    installPlaceOf,
    pidAlive,
    runnerRevision,
    currentCoreVersions,
    formatCoreLock,
    formatManifest,
    gitCheckoutExport,
    writeFileWithDir,
    installRevision,
    realInstallFs,
    parseCoreLock,
    parseManifest,
    productRootMismatch,
    productRootFromLock,
    readCoreLock,
    resolveDataDir,
    treeHashOf,
    verifyInstalledTree,
    writeCoreLock,
    type TCoreLock,
    type TCheckoutDeps,
    type TExportFn,
    type TInstallFs,
} from './core-install.ts';
import { STATE_SCHEMA_VERSION } from './state-lock.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const MODULE_URL = pathToFileURL(join(import.meta.dirname, 'core-install.ts')).href;

const testFs: TInstallFs = {
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

// Ревизия-образец: обычный файл, исполняемый, вложенный каталог и ссылка.
const sampleExport: TExportFn = (_sha, dest) => {
    mkdirSync(join(dest, 'core'), { recursive: true });
    writeFileSync(join(dest, 'ralph.js'), 'console.log(1);\n');
    chmodSync(join(dest, 'ralph.js'), 0o755);
    writeFileSync(join(dest, 'core', 'a.ts'), 'export const a = 1;\n');
    symlinkSync('core/a.ts', join(dest, 'link.ts'));
};

let work: string;
let dataDir: string;
let consumer: string;

beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'core-install-'));
    dataDir = join(work, 'share', 'ralph');
    consumer = join(work, 'app');
    mkdirSync(consumer);
});
afterEach(() => {
    rmSync(work, { recursive: true, force: true });
});

function install(over: Partial<Parameters<typeof installRevision>[0]> = {}) {
    return installRevision({ sha: SHA, dataDir, exportFn: sampleExport, fs: testFs, ...over });
}

function lockFor(treeHash: string, sha = SHA): TCoreLock {
    return { schema: CORE_LOCK_SCHEMA, sha, treeHash, versions: currentCoreVersions() };
}

describe('resolveDataDir', () => {
    it('явная переменная, затем XDG, затем HOME', () => {
        expect(resolveDataDir({ RALPH_DATA_DIR: '/d', XDG_DATA_HOME: '/x', HOME: '/h' })).toBe(
            '/d',
        );
        expect(resolveDataDir({ XDG_DATA_HOME: '/x', HOME: '/h' })).toBe('/x/ralph');
        expect(resolveDataDir({ RALPH_DATA_DIR: '', HOME: '/h' })).toBe('/h/.local/share/ralph');
    });
    it('относительный путь и пустое окружение — отказ, а не путь от места запуска', () => {
        expect(() => resolveDataDir({ XDG_DATA_HOME: 'rel' })).toThrow(
            /XDG_DATA_HOME=rel не абсолютный/,
        );
        expect(() => resolveDataDir({})).toThrow(/не задан/);
    });
});

describe('манифест и хэш дерева', () => {
    it('опись отсортирована, исполняемость и ссылка различены, манифест в опись не входит', () => {
        const dir = join(work, 'tree');
        mkdirSync(dir);
        sampleExport(SHA, dir);
        writeFileSync(join(dir, INSTALL_MANIFEST), 'не в счёт');
        const m = buildManifest(dir);
        expect(m.map((e) => [e.kind, e.path])).toEqual([
            ['file', 'core/a.ts'],
            ['link', 'link.ts'],
            ['exec', 'ralph.js'],
        ]);
        expect(parseManifest(formatManifest(m))).toEqual(m);
        expect(treeHashOf(formatManifest(m))).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
    it('правка содержимого и бита исполнения меняет хэш дерева', () => {
        const dir = join(work, 'tree');
        mkdirSync(dir);
        sampleExport(SHA, dir);
        const h0 = treeHashOf(formatManifest(buildManifest(dir)));
        chmodSync(join(dir, 'core', 'a.ts'), 0o755);
        const h1 = treeHashOf(formatManifest(buildManifest(dir)));
        expect(h1).not.toBe(h0);
    });
    it('fifo в дереве и перевод строки в имени — отказ описи', () => {
        const dir = join(work, 'tree');
        mkdirSync(dir);
        writeFileSync(join(dir, 'bad\nname'), 'x');
        expect(() => buildManifest(dir)).toThrow(/перевод/);
        rmSync(join(dir, 'bad\nname'));
        const mk = spawnSync('mkfifo', [join(dir, 'pipe')]);
        if (mk.status === 0) expect(() => buildManifest(dir)).toThrow(/Не файл/);
    });
    it('усечённый и битый манифест не разбираются', () => {
        expect(() => parseManifest(`file ${'0'.repeat(64)} a`)).toThrow(/усечён/);
        expect(() => parseManifest('мусор\n')).toThrow(/строка 1/);
    });
});

describe('parseCoreLock', () => {
    const good = lockFor(`sha256:${'1'.repeat(64)}`);
    it('разбирает записанное formatCoreLock', () => {
        expect(parseCoreLock(formatCoreLock(good))).toEqual({ ok: true, lock: good });
        expect(good.versions.state).toBe(STATE_SCHEMA_VERSION);
        expect(Object.keys(good.versions)).toEqual([
            'launcher',
            'core',
            'config',
            'state',
            'adapters',
        ]);
    });
    it('неизвестная версия схемы — отказ, и прочие поля не читаются', () => {
        // Поля будущей схемы заведомо не по нынешним правилам: отказ обязан назвать
        // версию, а не «sha не полный» — иначе lock пытались читать.
        const r = parseCoreLock(JSON.stringify({ schema: 2, revision: 'x', digest: 42 }));
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(/версия схемы 2 неизвестна/);
        expect(!r.ok && r.reason).not.toMatch(/sha|treeHash|ключ/);
        const missing = parseCoreLock(JSON.stringify({ sha: SHA }));
        expect(!missing.ok && missing.reason).toMatch(/версия схемы undefined/);
    });
    it.each([
        ['не JSON', '{', /не JSON/],
        ['массив', '[]', /не объект/],
        ['лишний ключ', JSON.stringify({ ...good, extra: 1 }), /незнакомые ключи: extra/],
        ['короткий sha', JSON.stringify({ ...good, sha: 'abc' }), /sha не полный/],
        ['хэш без префикса', JSON.stringify({ ...good, treeHash: '1'.repeat(64) }), /treeHash/],
        ['versions строкой', JSON.stringify({ ...good, versions: 'v1' }), /versions не объект/],
        [
            'versions без adapters',
            JSON.stringify({ ...good, versions: { ...good.versions, adapters: undefined } }),
            /ровно launcher, core, config, state, adapters/,
        ],
        [
            'versions прежнего вида (contract)',
            JSON.stringify({ ...good, versions: { contract: 1, state: 2, adapters: 1 } }),
            /найдено: adapters,contract,state/,
        ],
        ['versions пустые', JSON.stringify({ ...good, versions: {} }), /найдено: пусто/],
        [
            'versions ноль',
            JSON.stringify({ ...good, versions: { ...good.versions, config: 0 } }),
            /versions.config не целое/,
        ],
    ])('%s — отказ', (_n, text, re) => {
        const r = parseCoreLock(text);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(re);
    });
});

describe('lock в дереве потребителя', () => {
    it('запись и чтение по пути .ralph/core.lock', () => {
        const lock = lockFor(`sha256:${'2'.repeat(64)}`);
        const path = writeCoreLock(consumer, lock, {
            mkdir: (d) => mkdirSync(d, { recursive: true }),
            writeAtomic: (p, t) => writeFileSync(p, t),
        });
        expect(path).toBe(join(consumer, CORE_LOCK_PATH));
        expect(readCoreLock(consumer)).toEqual({ ok: true, lock, path });
    });
    it('нет файла, не читается, битый — отказ с адресом', () => {
        expect(readCoreLock(consumer)).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/core\.lock нет$/),
        });
        mkdirSync(join(consumer, CORE_LOCK_PATH), { recursive: true });
        expect(readCoreLock(consumer)).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/не читается \(EISDIR\)/),
        });
        expect(
            readCoreLock(consumer, () => {
                throw new Error('boom');
            }),
        ).toMatchObject({ ok: false, reason: expect.stringMatching(/не читается \(boom\)/) });
        expect(readCoreLock(consumer, () => '{"schema":9}')).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/core\.lock: версия схемы 9/),
        });
    });
});

describe('installRevision', () => {
    it('ставит ревизию в <dataDir>/<sha> с манифестом и без временных каталогов', () => {
        const r = install();
        expect(r.status).toBe('installed');
        expect(r.dir).toBe(join(dataDir, SHA));
        expect(readdirSync(dataDir)).toEqual([SHA]);
        expect(verifyInstalledTree(r.dir, lockFor(r.treeHash))).toEqual({ ok: true });
    });
    it('повторная установка той же ревизии — no-op, экспорт не зовётся', () => {
        const first = install();
        let called = 0;
        const again = install({
            exportFn: () => {
                called += 1;
            },
        });
        expect(again).toEqual({ status: 'present', dir: first.dir, treeHash: first.treeHash });
        expect(called).toBe(0);
    });
    it('каталог <sha> лежит без манифеста — отказ с адресом и действием, а не голый ENOENT', () => {
        mkdirSync(join(dataDir, SHA), { recursive: true });
        expect(() => install()).toThrow(
            new RegExp(
                `${SHA} лежит, но манифест .*\\.ralph-manifest отсутствует.*убери каталог и поставь ревизию заново`,
            ),
        );
    });
    it('дерево, разошедшееся с ожидаемым хэшем, не переименовывается в <sha>', () => {
        expect(() => install({ expectedTreeHash: `sha256:${'0'.repeat(64)}` })).toThrow(
            /не совпало с lock/,
        );
        expect(readdirSync(dataDir)).toEqual([]);
    });
    it('сбой экспорта снимает временный каталог', () => {
        expect(() =>
            install({
                exportFn: () => {
                    throw new Error('сеть упала');
                },
            }),
        ).toThrow(/сеть упала/);
        expect(readdirSync(dataDir)).toEqual([]);
    });
    it('остаток живого владельца не трогается, мёртвого — снимается у любой ревизии', () => {
        mkdirSync(dataDir, { recursive: true });
        const live = `.${SHA}.partial-111-aaaa`;
        const dead = `.${SHA}.partial-222-bbbb`;
        const foreignDead = `.${OTHER_SHA}.partial-222-cccc`;
        const foreignLive = `.${OTHER_SHA}.partial-111-dddd`;
        for (const n of [live, dead, foreignDead, foreignLive]) mkdirSync(join(dataDir, n));
        const lines: string[] = [];
        install({ isAliveFn: (pid) => pid === 111, logFn: (l) => lines.push(l) });
        expect(readdirSync(dataDir).sort()).toEqual([live, foreignLive, SHA].sort());
        expect(lines.join('\n')).toMatch(/partial-222-bbbb \(владелец 222 мёртв\)/);
        expect(lines.join('\n')).toMatch(/partial-222-cccc \(владелец 222 мёртв\)/);
    });
    it('соседняя установка успела переименовать раньше — результат её, наш каталог снят', () => {
        const r = install({
            fs: {
                ...testFs,
                rename: (from, to) => {
                    renameSync(from, to);
                    throw new Error('ENOTEMPTY');
                },
            },
        });
        expect(r.status).toBe('present');
        expect(readdirSync(dataDir)).toEqual([SHA]);
    });
    it('отказ переименования без соседа — проброшен, временный каталог снят', () => {
        expect(() =>
            install({
                fs: {
                    ...testFs,
                    rename: () => {
                        throw new Error('EXDEV');
                    },
                },
            }),
        ).toThrow(/EXDEV/);
        expect(readdirSync(dataDir)).toEqual([]);
    });
    it('сокращённый SHA, относительный каталог и кривой ожидаемый хэш — отказ до записи', () => {
        expect(() => install({ sha: 'abc123' })).toThrow(/не полный SHA/);
        expect(() => install({ sha: `../${'a'.repeat(37)}` })).toThrow(/не полный SHA/);
        expect(() => install({ dataDir: 'rel' })).toThrow(/не абсолютный/);
        expect(() => install({ expectedTreeHash: 'md5:1' })).toThrow(/sha256:<64 hex>/);
        expect(existsSync(dataDir)).toBe(false);
    });
});

describe('verifyInstalledTree', () => {
    function installed(): { dir: string; lock: TCoreLock } {
        const r = install();
        return { dir: r.dir, lock: lockFor(r.treeHash) };
    }
    it('изменённый файл — отказ с путём и ожидаемым хэшем', () => {
        const { dir, lock } = installed();
        const manifest = parseManifest(readFileSync(join(dir, INSTALL_MANIFEST), 'utf8'));
        const expected = manifest.find((e) => e.path === 'core/a.ts')!.sha256;
        writeFileSync(join(dir, 'core', 'a.ts'), 'export const a = 2;\n');
        const v = verifyInstalledTree(dir, lock);
        expect(v.ok).toBe(false);
        expect(!v.ok && v.reason).toContain(`core/a.ts: изменён — ожидался sha256 ${expected}`);
    });
    it('пропавший, лишний и сменивший вид файл названы поимённо', () => {
        const { dir, lock } = installed();
        rmSync(join(dir, 'core', 'a.ts'));
        writeFileSync(join(dir, 'evil.ts'), 'x');
        chmodSync(join(dir, 'ralph.js'), 0o644);
        const v = verifyInstalledTree(dir, lock);
        expect(!v.ok && v.reason).toMatch(/core\/a\.ts: файла нет, ожидался sha256 [0-9a-f]{64}/);
        expect(!v.ok && v.reason).toMatch(/evil\.ts: лишний файл/);
        expect(!v.ok && v.reason).toMatch(/ralph\.js: вид file вместо exec/);
    });
    it('больше пяти расхождений — пять поимённо и счёт остальных', () => {
        const { dir, lock } = installed();
        for (let i = 0; i < 7; i += 1) writeFileSync(join(dir, `x${String(i)}`), 'x');
        const v = verifyInstalledTree(dir, lock);
        expect(!v.ok && v.reason).toMatch(/и ещё 2$/);
    });
    it('правка файла вместе с манифестом ловится сверкой манифеста с lock', () => {
        const { dir, lock } = installed();
        writeFileSync(join(dir, 'core', 'a.ts'), 'export const a = 2;\n');
        rmSync(join(dir, INSTALL_MANIFEST));
        writeFileSync(join(dir, INSTALL_MANIFEST), formatManifest(buildManifest(dir)));
        const v = verifyInstalledTree(dir, lock);
        expect(!v.ok && v.reason).toMatch(
            /манифест установки .* не совпал с lock: ожидался sha256:/,
        );
    });
    it('нет манифеста, нечитаемый манифест, битый манифест — отказ', () => {
        const { dir, lock } = installed();
        const text = readFileSync(join(dir, INSTALL_MANIFEST), 'utf8');
        rmSync(join(dir, INSTALL_MANIFEST));
        expect(verifyInstalledTree(dir, lock)).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/ralph-manifest нет/),
        });
        const fsr = {
            ...testFs,
            readFile: () => {
                throw new Error('io');
            },
        };
        expect(verifyInstalledTree(dir, lock, fsr)).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/не читается \(io\)/),
        });
        writeFileSync(join(dir, INSTALL_MANIFEST), 'мусор\n');
        expect(verifyInstalledTree(dir, lockFor(treeHashOf('мусор\n')))).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/не описывается: строка 1/),
        });
        expect(text).not.toBe('');
    });
});

describe('describeStartCheck', () => {
    it('строка на каждый исход', () => {
        expect(
            describeStartCheck({
                status: 'ok',
                sha: SHA,
                dir: '/d',
                lock: lockFor(`sha256:${'1'.repeat(64)}`),
                lockPath: '/c/.ralph/core.lock',
            }),
        ).toMatch(/сверено с lock/);
        expect(describeStartCheck({ status: 'not-installed', dir: '/d' })).toMatch(
            /не из установки \(\/d\)/,
        );
        expect(describeStartCheck({ status: 'refused', reason: 'r' })).toMatch(/отвергнут.*: r$/);
    });
});

describe('checkCoreBeforeStart', () => {
    function setup(): { dir: string; lock: TCoreLock } {
        const r = install();
        const lock = lockFor(r.treeHash);
        mkdirSync(join(consumer, '.ralph'));
        writeFileSync(join(consumer, CORE_LOCK_PATH), formatCoreLock(lock));
        return { dir: r.dir, lock };
    }
    it('совпавшее дерево — старт разрешён', () => {
        const { dir, lock } = setup();
        expect(checkCoreBeforeStart(dir, consumer)).toEqual({
            status: 'ok',
            sha: SHA,
            dir,
            lock,
            lockPath: join(consumer, CORE_LOCK_PATH),
        });
    });
    it('ядро без манифеста — не установка, lock к нему не относится', () => {
        expect(checkCoreBeforeStart(consumer, consumer)).toEqual({
            status: 'not-installed',
            dir: consumer,
        });
        // Каталог установок известен, но ядро лежит не в нём — по-прежнему клон.
        expect(
            checkCoreBeforeStart(consumer, consumer, { env: { RALPH_DATA_DIR: dataDir } }),
        ).toEqual({ status: 'not-installed', dir: consumer });
    });
    // От противного (ревью Фазы 12): удалённый манифест снимал сверку с lock, и прямой
    // `node <dataDir>/<sha>/ralph.js` стартовал правленое дерево как клон.
    it('манифест удалён в каталоге установок — отказ по месту, а не «не установка»', () => {
        const { dir } = setup();
        rmSync(join(dir, INSTALL_MANIFEST));
        writeFileSync(join(dir, 'ralph.js'), 'process.exit(0);\n');
        const r = checkCoreBeforeStart(dir, consumer, { env: { RALPH_DATA_DIR: dataDir } });
        expect(r).toMatchObject({
            status: 'refused',
            reason: expect.stringMatching(
                /лежит в каталоге установок .* под именем ревизии, а манифеста .*ralph-manifest в нём нет/,
            ),
        });
        // Без окружения каталог установок не определить — предел признака назван в докблоке.
        expect(checkCoreBeforeStart(dir, consumer).status).toBe('not-installed');
    });
    it('installPlaceOf: только полный SHA прямо в каталоге установок, по каноническим путям', () => {
        const env = { RALPH_DATA_DIR: '/data' };
        expect(installPlaceOf(`/data/${SHA}`, env, (p) => p)).toBe('/data');
        expect(installPlaceOf('/data/347c4df', env, (p) => p)).toBeNull();
        expect(installPlaceOf(`/elsewhere/${SHA}`, env, (p) => p)).toBeNull();
        expect(installPlaceOf(`/data/${SHA}`, undefined, (p) => p)).toBeNull();
        expect(installPlaceOf(`/data/${SHA}`, { RALPH_DATA_DIR: 'rel' }, (p) => p)).toBeNull();
        expect(installPlaceOf(`/link/${SHA}`, env, (p) => p.replace('/link', '/data'))).toBe(
            '/data',
        );
        expect(
            installPlaceOf(`/data/${SHA}`, env, () => {
                throw new Error('ENOENT');
            }),
        ).toBe('/data');
    });
    it('изменённый файл в установке — старт отвергнут, в причине путь и ожидаемый хэш', () => {
        const { dir } = setup();
        const expected = parseManifest(readFileSync(join(dir, INSTALL_MANIFEST), 'utf8')).find(
            (e) => e.path === 'ralph.js',
        )!.sha256;
        writeFileSync(join(dir, 'ralph.js'), 'process.exit(0);\n');
        const r = checkCoreBeforeStart(dir, consumer);
        expect(r.status).toBe('refused');
        expect(r.status === 'refused' && r.reason).toContain(
            `ralph.js: изменён — ожидался sha256 ${expected}`,
        );
    });
    it('lock неизвестной схемы — отказ старта, а не попытка прочитать', () => {
        const { dir } = setup();
        writeFileSync(join(consumer, CORE_LOCK_PATH), JSON.stringify({ schema: 7, sha: SHA }));
        const r = checkCoreBeforeStart(dir, consumer);
        expect(r).toMatchObject({
            status: 'refused',
            reason: expect.stringMatching(/версия схемы 7 неизвестна/),
        });
    });
    it('нет lock, нет roots, lock на другую ревизию — отказ с причиной', () => {
        const { dir, lock } = setup();
        expect(checkCoreBeforeStart(dir, null)).toMatchObject({
            status: 'refused',
            reason: expect.stringMatching(/roots/),
        });
        writeFileSync(join(consumer, CORE_LOCK_PATH), formatCoreLock({ ...lock, sha: OTHER_SHA }));
        expect(checkCoreBeforeStart(dir, consumer)).toMatchObject({
            status: 'refused',
            reason: expect.stringMatching(
                new RegExp(`исполняется ревизия ${SHA}.*называет ${OTHER_SHA}`),
            ),
        });
        rmSync(join(consumer, CORE_LOCK_PATH));
        expect(checkCoreBeforeStart(dir, consumer)).toMatchObject({
            status: 'refused',
            reason: expect.stringMatching(/core\.lock нет/),
        });
    });
});

// ── Прерванная установка: настоящий процесс, настоящий SIGKILL ───────────────
//
// Дочерний процесс идёт БЕЗ предохранителя побочек и с боевыми дефолтами модуля: ФС
// `realInstallFs` и источник `gitCheckoutExport` из временного git-репозитория. Экспорт
// обёрнут так, что после чекаута процесс сообщает «готов» и зависает — то есть стоит
// ровно между чекаутом и переименованием, где его и убивают.
function childScript(mode: 'hang' | 'finish'): string {
    return `
import { installRevision, gitCheckoutExport } from ${JSON.stringify(MODULE_URL)};
const [repo, sha, dataDir] = process.argv.slice(2);
const real = gitCheckoutExport(repo);
const r = installRevision({
    sha, dataDir,
    exportFn: (s, dest) => {
        real(s, dest);
        if (${JSON.stringify(mode)} === 'hang') {
            process.stdout.write('ready\\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
    },
});
process.stdout.write(JSON.stringify(r) + '\\n');
`;
}

function gitRepoWithCommit(): { repo: string; sha: string } {
    const repo = join(work, 'canon');
    mkdirSync(join(repo, 'core'), { recursive: true });
    writeFileSync(join(repo, 'ralph.js'), 'console.log(1);\n');
    writeFileSync(join(repo, 'core', 'a.ts'), 'export const a = 1;\n');
    const git = (...args: string[]) => {
        const r = spawnSync(
            'git',
            ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
            {
                encoding: 'utf8',
            },
        );
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return { repo, sha: git('rev-parse', 'HEAD') };
}

function childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.RALPH_NO_SIDE_EFFECTS;
    return env;
}

describe('прерванная установка', () => {
    it('убитый до переименования процесс не оставляет каталога ревизии; повтор ставит её с нуля', async () => {
        const { repo, sha } = gitRepoWithCommit();
        const scripts = join(work, 'scripts');
        mkdirSync(scripts);
        writeFileSync(join(scripts, 'hang.mts'), childScript('hang'));
        writeFileSync(join(scripts, 'finish.mts'), childScript('finish'));

        const child = spawn(process.execPath, [join(scripts, 'hang.mts'), repo, sha, dataDir], {
            env: childEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        await new Promise<void>((resolveReady, reject) => {
            child.stdout.on('data', (d: Buffer) => {
                if (d.toString().includes('ready')) resolveReady();
            });
            child.on('exit', (code) =>
                reject(
                    new Error(`дочерний процесс вышел до готовности (${String(code)}): ${stderr}`),
                ),
            );
        });
        const partials = readdirSync(dataDir);
        expect(partials).toHaveLength(1);
        expect(partials[0]).toMatch(new RegExp(`^\\.${sha}\\.partial-${String(child.pid)}-`));
        // Чекаут дошёл до конца — значит, убиваем действительно перед переименованием.
        expect(existsSync(join(dataDir, partials[0], 'core', 'a.ts'))).toBe(true);
        const exited = new Promise((r) => child.on('exit', r));
        child.kill('SIGKILL');
        await exited;

        expect(existsSync(join(dataDir, sha))).toBe(false);

        const again = spawnSync(
            process.execPath,
            [join(scripts, 'finish.mts'), repo, sha, dataDir],
            {
                env: childEnv(),
                encoding: 'utf8',
            },
        );
        expect(again.stderr).toBe('');
        expect(again.status).toBe(0);
        const result = JSON.parse(again.stdout.trim()) as {
            status: string;
            dir: string;
            treeHash: string;
        };
        expect(result.status).toBe('installed');
        expect(readdirSync(dataDir)).toEqual([sha]);
        expect(verifyInstalledTree(result.dir, lockFor(result.treeHash, sha))).toEqual({
            ok: true,
        });
        expect(readFileSync(join(result.dir, 'core', 'a.ts'), 'utf8')).toBe(
            'export const a = 1;\n',
        );
    }, 30_000);

    it('установка — git-репозиторий на ревизии, файлы равны блобам вопреки атрибутам источника', () => {
        // Хуки установки сверяют себя `git ls-tree` своего каталога, старт — HEAD установки
        // (ревью Фазы 12): распакованный архив не был репозиторием, и ядро не стартовало.
        // Атрибуты источника (`export-ignore`, `eol`) развели бы диск с ревизией.
        const { repo } = gitRepoWithCommit();
        writeFileSync(
            join(repo, '.gitattributes'),
            'core/a.ts export-ignore\n*.txt text eol=crlf\n',
        );
        writeFileSync(join(repo, 'note.txt'), 'line\n');
        const git = (...args: string[]): string => {
            const r = spawnSync(
                'git',
                ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
                { encoding: 'utf8' },
            );
            if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
            return r.stdout.trim();
        };
        git('add', '-A');
        git('commit', '-q', '-m', 'attrs');
        const sha = git('rev-parse', 'HEAD');
        const scripts = join(work, 'scripts');
        mkdirSync(scripts);
        writeFileSync(join(scripts, 'finish.mts'), childScript('finish'));
        const r = spawnSync(process.execPath, [join(scripts, 'finish.mts'), repo, sha, dataDir], {
            env: childEnv(),
            encoding: 'utf8',
        });
        expect(r.stderr).toBe('');
        const result = JSON.parse(r.stdout.trim()) as { dir: string; treeHash: string };
        const head = spawnSync('git', ['-C', result.dir, 'rev-parse', '--show-toplevel', 'HEAD'], {
            encoding: 'utf8',
        });
        expect(head.stdout.trim().split('\n')).toEqual([result.dir, sha]);
        expect(readFileSync(join(result.dir, 'core', 'a.ts'), 'utf8')).toBe(
            'export const a = 1;\n',
        );
        expect(readFileSync(join(result.dir, 'note.txt'), 'utf8')).toBe('line\n');
        const status = spawnSync(
            'git',
            ['-C', result.dir, 'status', '--porcelain', '--untracked-files=no'],
            {
                encoding: 'utf8',
            },
        );
        expect(status.stdout).toBe('');
        // `.git` в опись не входит: манифест описывает дерево ревизии, и сверка с lock зелёная.
        expect(
            parseManifest(readFileSync(join(result.dir, INSTALL_MANIFEST), 'utf8')).map(
                (e) => e.path,
            ),
        ).toEqual(['.gitattributes', 'core/a.ts', 'note.txt', 'ralph.js']);
        expect(verifyInstalledTree(result.dir, lockFor(result.treeHash, sha))).toEqual({
            ok: true,
        });
    }, 30_000);

    it('SHA, которого нет в источнике, — отказ git, каталога ревизии нет', () => {
        const { repo } = gitRepoWithCommit();
        const scripts = join(work, 'scripts');
        mkdirSync(scripts);
        writeFileSync(join(scripts, 'finish.mts'), childScript('finish'));
        const r = spawnSync(
            process.execPath,
            [join(scripts, 'finish.mts'), repo, 'c'.repeat(40), dataDir],
            {
                env: childEnv(),
                encoding: 'utf8',
            },
        );
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/git fetch .*c{40}.* не отработал/);
        expect(readdirSync(dataDir)).toEqual([]);
    }, 30_000);
});

describe('живость владельца', () => {
    const ENTRY = `/data/${SHA}/ralph.js`;
    const esrch = () => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    it('pidAlive: занят — жив; EPERM — жив (чужой пользователь); ESRCH — мёртв', () => {
        expect(pidAlive(1, () => true)).toBe(true);
        expect(
            pidAlive(1, () => {
                throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
            }),
        ).toBe(true);
        expect(pidAlive(1, esrch)).toBe(false);
    });
    it('runnerRevision: entry любой ревизии этого каталога — её SHA; подстрока ralph.js — нет', () => {
        const proc = (cmd: string[]) => () => `${cmd.join('\0')}\0`;
        const kill = () => true;
        const rev = (cmd: string[]) =>
            runnerRevision(7, '/data', { killFn: kill, readFn: proc(cmd) });
        expect(rev(['node', ENTRY])).toBe(SHA);
        // Раннер прежней ревизии после смены lock — жив, и названа его ревизия (#136).
        expect(rev(['node', `/data/${OTHER_SHA}/ralph.js`])).toBe(OTHER_SHA);
        expect(rev(['vim', 'ralph.js'])).toBeNull();
        expect(rev(['node', `/elsewhere/${SHA}/ralph.js`])).toBeNull();
        expect(rev(['node', '/data/abc/ralph.js'])).toBeNull();
        expect(rev(['node', `/data/${SHA}/other.js`])).toBeNull();
        expect(
            runnerRevision(7, '/data', {
                killFn: kill,
                readFn: () => {
                    throw new Error('EACCES');
                },
            }),
        ).toBeNull();
        expect(
            runnerRevision(7, '/data', { killFn: esrch, readFn: proc(['node', ENTRY]) }),
        ).toBeNull();
    });
    it('runnerRevision: боевые дефолты читают argv живого процесса — тест не раннер', () => {
        expect(runnerRevision(process.pid, '/nope')).toBeNull();
    });
});

// Сверка, которую никто не зовёт, — не барьер. Порядок в `main()` содержателен: до
// первой записи (`mkdir` каталога состояния) и до лока, иначе изменённое дерево успевало
// бы исполнить побочки раньше отказа.
describe('проводка в main()', () => {
    it('сверка стоит в main() раньше mkdir каталога состояния и лока, отказ — через fail', () => {
        const src = readFileSync(join(import.meta.dirname, 'orchestrator.ts'), 'utf8');
        const main = src.indexOf('function main(): void {');
        const check = src.search(/checkCoreBeforeStart\(\s*PRODUCT_DIR/);
        const mkdir = src.indexOf('fs.mkdirSync(roots.runtimeDir', main);
        const lock = src.indexOf('acquireRunnerLock()', main);
        expect(main).toBeGreaterThan(0);
        expect(check).toBeGreaterThan(main);
        expect(check).toBeLessThan(mkdir);
        expect(check).toBeLessThan(lock);
        expect(src.slice(check, mkdir)).toMatch(
            /status === 'refused'\) fail\(describeStartCheck\(coreCheck\)\)/,
        );
        // Окружение уходит сверке: без него признак установки по месту не работает.
        expect(src.slice(check, check + 200)).toMatch(/\{ env: process\.env \}/);
        // Расхождение `roots.productRoot` с исполняемым ядром — отказ и старту, и doctor.
        const doctor = src.indexOf('if (DOCTOR)', main);
        expect(src.slice(check, doctor)).toMatch(/productRootMismatch\(/);
        // Выведенный из lock путь (#134) сверяется с исполняемым ядром и у клона.
        expect(src.slice(check, doctor)).toMatch(/productRootFrom === 'lock'/);
        expect(src.slice(doctor, mkdir)).toMatch(/if \(productRootDrift\) fail\(/);
    });
});

describe('productRootMismatch', () => {
    const id = (p: string) => p;
    it('тот же каталог — расхождения нет, в том числе через симлинк', () => {
        expect(productRootMismatch('/data/x', '/data/x', id)).toBeNull();
        const real = (p: string) => (p === '/link/x' ? '/data/x' : p);
        expect(productRootMismatch('/link/x', '/data/x', real)).toBeNull();
    });
    it('другая ревизия — отказ называет обе стороны', () => {
        expect(productRootMismatch(`/data/${OTHER_SHA}`, `/data/${SHA}`, id)).toBe(
            `roots.productRoot конфига — /data/${OTHER_SHA}, а исполняется ядро /data/${SHA}: ` +
                'убери ключ (launcher выводит его из lock) или поправь на каталог ревизии из lock',
        );
    });
    it('путь выведен из lock — отказ называет lock и обе стороны (#134)', () => {
        expect(productRootMismatch(`/data/${SHA}`, '/clone', id, 'lock')).toBe(
            `roots.productRoot выведен из .ralph/core.lock — /data/${SHA}, а исполняется ядро ` +
                '/clone: запусти ядро ревизии из lock (./ralph start) или задай roots.productRoot явно',
        );
        expect(productRootMismatch(`/data/${SHA}`, `/data/${SHA}`, id, 'lock')).toBeNull();
    });
});

describe('productRootFromLock (#134)', () => {
    const lockText = (sha: string) => formatCoreLock(lockFor(`sha256:${'1'.repeat(64)}`, sha));
    it('каталог установок из окружения + SHA из lock', () => {
        const r = productRootFromLock('/app', {
            readFn: () => lockText(SHA),
            env: { RALPH_DATA_DIR: '/data' },
        });
        expect(r).toEqual({ ok: true, path: `/data/${SHA}` });
    });
    it('lock нет — отказ с путём lock', () => {
        const r = productRootFromLock('/app', {
            readFn: () => {
                throw Object.assign(new Error('nope'), { code: 'ENOENT' });
            },
            env: { RALPH_DATA_DIR: '/data' },
        });
        expect(r).toEqual({ ok: false, reason: '/app/.ralph/core.lock нет' });
    });
    // Боевой дефолт резолва конфига: без поданных readFn и env он читал бы живой lock и
    // окружение машины — под предохранителем это побочка (ревью Фазы 13).
    it('без readFn или env — побочка под предохранителем, а не чтение живого lock', () => {
        expect(() => productRootFromLock('/app')).toThrow(/побочка/);
        expect(() => productRootFromLock('/app', { readFn: () => lockText(SHA) })).toThrow(
            /побочка/,
        );
        expect(sideEffectAttempts.splice(0)).toEqual([
            'productRootFromLock(/app)',
            'productRootFromLock(/app)',
        ]);
    });
    it('каталог установок не задан — отказ, а не путь от места запуска', () => {
        const r = productRootFromLock('/app', { readFn: () => lockText(SHA), env: {} });
        expect(r).toEqual({
            ok: false,
            reason: expect.stringMatching(/Каталог установок ядра не задан/),
        });
    });
    it('путь не разрешается — сравнение как есть, а не падение', () => {
        const boom = () => {
            throw new Error('ENOENT');
        };
        expect(productRootMismatch('/gone', '/data/x', boom)).toMatch(/\/gone, а исполняется/);
    });
});

// Шаги чекаута ревизии на подменённом git: порядок, атрибуты, сетевые опции у fetch и
// отказы. Настоящий git — в «прерванной установке» выше, но там он в дочернем процессе.
describe('writeFileWithDir', () => {
    it('создаёт недостающий каталог: `.git` без шаблона init лежит без info/', () => {
        const p = join(work, 'repo', '.git', 'info', 'attributes');
        writeFileWithDir(p, '* -text\n');
        expect(readFileSync(p, 'utf8')).toBe('* -text\n');
    });
});

describe('gitCheckoutExport на подменённом git', () => {
    type TCall = { args: string[]; timeout?: number; prompt?: string };
    type TOver = Partial<{ status: number | null; stdout: string; stderr: string; error: Error }>;
    function fakeGit(over: (args: string[]) => TOver = () => ({})) {
        const calls: TCall[] = [];
        const writes: [string, string][] = [];
        const deps: TCheckoutDeps = {
            spawnFn: (_file, args, opts) => {
                const own = args.slice(6);
                const vars: Record<string, string | undefined> = opts.env;
                calls.push({ args: own, timeout: opts.timeout, prompt: vars.GIT_TERMINAL_PROMPT });
                const head = own.includes('rev-parse') ? SHA : '';
                return { status: 0, stdout: head, stderr: '', ...over(own) };
            },
            writeFileFn: (p, text) => writes.push([p, text]),
        };
        return { calls, writes, deps };
    }

    it('init, атрибуты, fetch с запретом промпта и сроком, чекаут, сверка HEAD', () => {
        const { calls, writes, deps } = fakeGit();
        gitCheckoutExport('/src', deps)(SHA, '/dest');
        expect(calls.map((c) => (c.args[0] === '-c' ? c.args[2] : c.args[0]))).toEqual([
            'init',
            'fetch',
            'checkout',
            'rev-parse',
        ]);
        expect(calls[0].args).toEqual(['init', '-q', '--template=']);
        expect(writes).toEqual([
            ['/dest/.git/info/attributes', '* -text -eol -filter -ident -working-tree-encoding\n'],
        ]);
        const fetch = calls[1];
        expect(fetch.args).toEqual([
            'fetch',
            '-q',
            '--no-tags',
            '--no-write-fetch-head',
            '/src',
            SHA,
        ]);
        expect(fetch.prompt).toBe('0');
        expect(fetch.timeout).toBeGreaterThan(0);
        expect(calls[0].timeout).toBeUndefined();
        expect(sideEffectAttempts).toEqual([]);
    });

    it('отказ git — бросок с командой, каталогом, источником и stderr', () => {
        const { deps } = fakeGit((args) =>
            args[0] === 'fetch' ? { status: 128, stderr: 'not our ref\n' } : {},
        );
        expect(() => gitCheckoutExport('/src', deps)(SHA, '/dest')).toThrow(
            /git fetch .* в \/dest \(источник \/src\) не отработал: not our ref$/,
        );
    });

    it('git не запустился вовсе — бросок с ошибкой запуска, а не пустой причиной', () => {
        const { deps } = fakeGit((args) =>
            args[0] === 'init'
                ? ({ status: null, stderr: '', error: new Error('spawn git ENOENT') } as TOver)
                : {},
        );
        expect(() => gitCheckoutExport('/src', deps)(SHA, '/dest')).toThrow(
            /git init -q .* не отработал: Error: spawn git ENOENT$/,
        );
    });

    it('git отказал без stderr и без ошибки — бросок всё равно с командой', () => {
        const { deps } = fakeGit((args) => (args[0] === 'init' ? { status: 1 } : {}));
        expect(() => gitCheckoutExport('/src', deps)(SHA, '/dest')).toThrow(
            /git init -q --template= в \/dest \(источник \/src\) не отработал: $/,
        );
    });

    it('HEAD после чекаута не тот — бросок, а не установка чужой ревизии', () => {
        const { deps } = fakeGit((args) =>
            args.includes('rev-parse') ? { stdout: OTHER_SHA } : {},
        );
        expect(() => gitCheckoutExport('/src', deps)(SHA, '/dest')).toThrow(
            `чекаут в /dest встал на ${OTHER_SHA}, а не на ${SHA}`,
        );
    });
});

// Боевые дефолты записи под предохранителем побочек: в тесте каждый обязан отказать и
// попасть в журнал, а не тронуть диск. Без этой пробы забытая подмена ФС в тесте
// установки писала бы в настоящий каталог данных.
describe('боевые дефолты под предохранителем', () => {
    it('запись ФС, запись lock и экспорт — отказ с записью в журнал', () => {
        const p = join(work, 'never');
        // Чтение — не побочка: проверка «есть ли» идёт и под предохранителем.
        expect(realInstallFs.exists(p)).toBe(false);
        expect(() => realInstallFs.mkdir(p)).toThrow(/побочка/);
        expect(() => realInstallFs.writeFile(p, 'x')).toThrow(/побочка/);
        expect(() => realInstallFs.rename(p, p)).toThrow(/побочка/);
        expect(() => realInstallFs.rm(p)).toThrow(/побочка/);
        expect(() => writeCoreLock(consumer, lockFor(`sha256:${'3'.repeat(64)}`))).toThrow(
            /побочка/,
        );
        expect(() => gitCheckoutExport(work)(SHA, p)).toThrow(/побочка/);
        expect(sideEffectAttempts.splice(0)).toEqual([
            `mkdir(${p})`,
            `writeFile(${p})`,
            `rename(${p})`,
            `rm(${p})`,
            `mkdir(${join(consumer, '.ralph')})`,
            `git checkout ${SHA}`,
        ]);
        expect(existsSync(p)).toBe(false);
    });
    it('живость владельца остатка по умолчанию — kill 0: свой жив, несуществующий мёртв', () => {
        mkdirSync(dataDir, { recursive: true });
        // pid 2^22+1 выше pid_max Linux по умолчанию — заведомо мёртв.
        const deadPid = 4194305;
        const mine = `.${SHA}.partial-${String(process.pid)}-aaaa`;
        mkdirSync(join(dataDir, mine));
        mkdirSync(join(dataDir, `.${SHA}.partial-${String(deadPid)}-bbbb`));
        install({ pid: 1 });
        expect(readdirSync(dataDir).sort()).toEqual([mine, SHA].sort());
    });
});

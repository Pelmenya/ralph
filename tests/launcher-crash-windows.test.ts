// Обрыв на каждом шаге update, rollback и активации (Фаза 13, #104).
//
// Петля работает без человека, и смена ревизии может оборваться где угодно: кончился диск,
// упала сеть, процесс убит. Половинчатая установка или lock на недоставленную ревизию
// остановили бы петлю до утра. Поэтому каждая операция выписана списком шагов-эффектов, и на
// каждый шаг — два убийства: ДО него и сразу ПОСЛЕ, когда эффект уже лёг, а процесс не успел
// пойти дальше. После каждого обрыва проверяется одно и то же: прежняя ревизия стартует,
// дерево потребителя чисто, state читается, повтор операции доводит её до конца, а ещё один
// повтор ничего не меняет.
//
// Набор строится ПО СПИСКУ: тесты обрыва порождаются из `*_STEPS`, а непрерванный прогон
// сверяет, что операция исполняет ровно эти шаги в этом порядке. Новый эффект в update или
// rollback — новый шаг непрерванного прогона: список с ним разойдётся, и набор покраснеет,
// пока шаг не вписан (а вписанный сразу получает свои два обрыва). Эффект, который
// классификатор не узнаёт, — отказ, а не пропуск.
//
// Мир настоящий там, где свойство принадлежит инструменту: установка — `installRevision` на
// диске, ветка lock — `commitLockOnBranch` на git с голым origin. Форж — фейк с памятью,
// переживающей процесс: PR, заведённый убитым процессом, остаётся на форже. Убийство —
// `crash-world.ts`: после смерти диск, git, форж и вывод молчат.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectStateAt, supportedVersions } from '../core/compat.ts';
import {
    CORE_LOCK_PATH,
    CORE_LOCK_SCHEMA,
    formatCoreLock,
    installRevision,
    verifyInstalledTree,
    type TCoreLock,
    type TInstallFs,
} from '../core/core-install.ts';
import { commitLockOnBranch, updateBranchName, type TRunArgvFn } from '../core/core-update.ts';
import { rollbackBranchName, rollbackTarget } from '../core/core-rollback.ts';
import {
    ACTIVATION_RESTART_EXIT,
    parseActivationJournal,
    recordActivation,
} from '../core/core-activation.ts';
import {
    runRollbackCommand,
    runStartCommand,
    runUpdateCommand,
    type TLauncherArgs,
    type TLauncherDeps,
} from '../core/launcher.ts';
import { runtimePathsIn } from '../core/runtime-paths.ts';
import { CONSUMERS_DIR } from '../core/consumer-registry.ts';
import { Killed, world } from './crash-world.ts';

/** update: установка новой ревизии рядом, ветка с lock, PR. */
const UPDATE_STEPS = [
    'install:mkdir-data',
    'install:mkdir-partial',
    'install:export',
    'install:manifest',
    'install:rename',
    'lock:fetch-base',
    'lock:write-blob',
    'lock:read-tree',
    'lock:update-index',
    'lock:write-tree',
    'lock:commit-tree',
    'lock:push',
    'lock:drop-base-ref',
    'lock:drop-prior-ref',
    'pr:create',
] as const;

/** rollback: те же шаги, когда прежней ревизии в каталоге установок уже нет. */
const ROLLBACK_STEPS = UPDATE_STEPS;

/**
 * Активация после мерджа lock: запись потребителя в реестр каталога установок (#138), прежнее
 * ядро выходит на рестарт, новое пишет журнал. Повтор записи реестра — не эффект: та же
 * запись не переписывается.
 */
const ACTIVATION_STEPS = [
    'registry:register',
    'core:run-old',
    'core:run-new',
    'activation:append',
] as const;

const V = supportedVersions();
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const START_ARGS = (consumerRoot: string): TLauncherArgs => ({
    command: 'start',
    consumerRoot,
    source: null,
    rev: null,
    profile: null,
    passthrough: [],
});

let root: string;
let consumer: string;
let origin: string;
let dataDir: string;
let runtimeDir: string;
let gitEnv: NodeJS.ProcessEnv;
let oldLock: TCoreLock;
let newTreeHash: string;
let headBefore: string;
let lockBefore: string;
let stateBefore: string;
let pidSeq: number;

const paths = () => runtimePathsIn(runtimeDir);

const runGit: TRunArgvFn = (file, args, opts = {}) => {
    const r = spawnSync(file, args, {
        encoding: 'utf8',
        input: opts.input,
        env: opts.env ?? gitEnv,
    });
    if (r.status !== 0) throw new Error(`${file} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};
const git = (cwd: string, ...args: string[]) => runGit('git', ['-C', cwd, ...args]);

/** Дерево ревизии: содержимое различает ревизии, по нему и сверяется установка. */
function exportTree(sha: string, dest: string): void {
    fs.mkdirSync(path.join(dest, 'core'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'ralph.js'), `// ядро ${sha}\n`);
    fs.writeFileSync(path.join(dest, 'core', 'loop.ts'), `export const rev = '${sha}';\n`);
}

const plainFs: TInstallFs = {
    readdir: (d) => fs.readdirSync(d),
    lstat: (p) => fs.lstatSync(p),
    readFile: (p) => fs.readFileSync(p),
    readlink: (p) => fs.readlinkSync(p),
    exists: (p) => fs.existsSync(p),
    mkdir: (d) => fs.mkdirSync(d, { recursive: true }),
    writeFile: (p, t) => fs.writeFileSync(p, t, { flag: 'wx' }),
    rename: (a, b) => fs.renameSync(a, b),
    rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
};

function installedLock(sha: string): TCoreLock {
    const res = installRevision({ sha, dataDir, exportFn: exportTree, fs: plainFs });
    return { schema: CORE_LOCK_SCHEMA, sha, treeHash: res.treeHash, versions: V };
}

function commitLock(lock: TCoreLock, message: string): void {
    fs.writeFileSync(path.join(consumer, CORE_LOCK_PATH), formatCoreLock(lock));
    git(consumer, 'add', '-A');
    git(consumer, 'commit', '--quiet', '-m', message);
    git(consumer, 'push', '--quiet', 'origin', 'main');
}

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-crash-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    gitEnv = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'sandbox',
        GIT_AUTHOR_EMAIL: 'sandbox@example.invalid',
        GIT_COMMITTER_NAME: 'sandbox',
        GIT_COMMITTER_EMAIL: 'sandbox@example.invalid',
    };
    consumer = path.join(root, 'app');
    origin = path.join(root, 'origin.git');
    dataDir = path.join(root, 'data');
    runtimeDir = path.join(root, 'runtime');
    pidSeq = 5000;

    oldLock = installedLock(OLD);
    // Хэш новой ревизии — заранее, в стороне: каталог установок она увидит только из update.
    const probe = path.join(root, 'probe');
    newTreeHash = installRevision({
        sha: NEW,
        dataDir: probe,
        exportFn: exportTree,
        fs: plainFs,
    }).treeHash;
    fs.rmSync(probe, { recursive: true });

    git(root, 'init', '--quiet', '--bare', origin);
    fs.mkdirSync(path.join(consumer, '.ralph'), { recursive: true });
    git(consumer, 'init', '--quiet', '-b', 'main');
    git(consumer, 'remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(consumer, 'app.txt'), 'код потребителя\n');
    commitLock(oldLock, 'потребитель на прежней ревизии');

    fs.mkdirSync(runtimeDir);
    fs.writeFileSync(
        paths().state,
        JSON.stringify({ schemaVersion: V.state, count: 3, milestone: 'M1', submitStages: [] }),
    );
    // Прежняя ревизия здесь уже стартовала: журнал активации её называет.
    fs.writeFileSync(
        paths().activations,
        `${JSON.stringify({ at: '2026-10-01T00:00:00.000Z', sha: OLD, from: null })}\n`,
    );
    snapshotConsumer();
});
afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

function snapshotConsumer(): void {
    headBefore = git(consumer, 'rev-parse', 'HEAD');
    lockBefore = fs.readFileSync(path.join(consumer, CORE_LOCK_PATH), 'utf8');
    stateBefore = fs.readFileSync(paths().state, 'utf8');
}

// ── Мир одного процесса launcher ─────────────────────────────────────────────

type TForge = Map<string, number>;

/** Имя шага-эффекта по операции; незнакомая операция — отказ, а не пропуск. */
function gitStep(args: readonly string[]): string | null {
    const sub = args[2];
    const rest = args.slice(3);
    switch (sub) {
        case 'fetch':
            if (rest.some((a) => /:refs\/ralph\/update-base-/.test(a))) return 'lock:fetch-base';
            if (rest.some((a) => /:refs\/ralph\/update-prior-/.test(a))) return 'lock:fetch-prior';
            break;
        case 'hash-object':
            return 'lock:write-blob';
        case 'read-tree':
        case 'update-index':
        case 'write-tree':
        case 'commit-tree':
        case 'push':
            return `lock:${sub}`;
        case 'update-ref':
            if (rest.some((a) => a.startsWith('refs/ralph/update-base-')))
                return 'lock:drop-base-ref';
            if (rest.some((a) => a.startsWith('refs/ralph/update-prior-')))
                return 'lock:drop-prior-ref';
            break;
        case 'rev-parse':
        case 'ls-remote':
        case 'for-each-ref':
            return null; // чтение: обрыв перед ним — тот же обрыв после предыдущего шага
    }
    throw new Error(`неизвестный шаг git: ${args.join(' ')} — впиши его в список шагов`);
}

function launcherProcess(killAt: { step: string; when: 'before' | 'after' } | null, forge: TForge) {
    const w = world();
    const out: string[] = [];
    const steps: string[] = [];
    const pid = ++pidSeq;
    let fired = false;
    // Эффект под точкой убийства; первое вхождение шага — точка, повторы проходят.
    const effect = <R>(step: string, act: () => R): R => {
        w.alive();
        steps.push(step);
        const hit = killAt !== null && !fired && killAt.step === step;
        if (hit) fired = true;
        if (hit && killAt.when === 'before') w.kill();
        const r = act();
        if (hit && killAt.when === 'after') w.kill();
        return r;
    };
    const read = <R>(act: () => R): R => {
        w.alive();
        return act();
    };
    const installFs: TInstallFs = {
        ...plainFs,
        readdir: (d) => read(() => plainFs.readdir(d)),
        mkdir: (d) =>
            effect(d === dataDir ? 'install:mkdir-data' : 'install:mkdir-partial', () =>
                plainFs.mkdir(d),
            ),
        writeFile: (p, t) => effect('install:manifest', () => plainFs.writeFile(p, t)),
        rename: (a, b) => effect('install:rename', () => plainFs.rename(a, b)),
        rm: (p) => effect('install:rm-partial', () => plainFs.rm(p)),
    };
    const runArgv: TRunArgvFn = (file, args, opts) => {
        const step = gitStep(args);
        return step === null
            ? read(() => runGit(file, args, opts))
            : effect(step, () => runGit(file, args, opts));
    };
    const unused = (name: string) => () => {
        throw new Error(`${name} в этой операции не зовётся`);
    };
    const deps: TLauncherDeps = {
        env: {
            RALPH_DATA_DIR: dataDir,
            RALPH_LAUNCHER_VERSION: String(V.launcher),
            RALPH_SOURCE: path.join(root, 'source'),
        },
        out: w.chat(out),
        readFn: (p) => read(() => fs.readFileSync(p, 'utf8')),
        exists: (p) => read(() => fs.existsSync(p)),
        installFn: ({ sha, dataDir: dd, expectedTreeHash }) =>
            installRevision({
                sha,
                dataDir: dd,
                expectedTreeHash,
                exportFn: (s, dest) => effect('install:export', () => exportTree(s, dest)),
                fs: installFs,
                pid,
                // Владельцы остатков — прежние, убитые процессы: их номера мертвы.
                isAliveFn: (p) => p === pid,
            }),
        writeLockFn: unused('writeLockFn'),
        resolveRevFn: (_source, rev) => {
            if (rev !== 'v2') throw new Error(`ревизии ${rev} нет`);
            return NEW;
        },
        versionsOfFn: () => read(() => V),
        runCoreFn: unused('runCoreFn'),
        nowFn: () => 0,
        runtimeDirOfFn: () => runtimeDir,
        ralphRevisionFn: unused('ralphRevisionFn'),
        writeStopFn: unused('writeStopFn'),
        rawConfigFn: () => read(() => ({ configVersion: V.config })),
        pushLockBranchFn: ({ consumerRoot, branch, lock, message }) =>
            commitLockOnBranch({
                runArgvFn: runArgv,
                consumerRoot,
                env: gitEnv,
                indexFile: path.join(root, `index-${String(pid)}`),
                branch,
                lock,
                message,
            }),
        findOpenPrFn: (_root, branch) => read(() => forge.get(branch) ?? null),
        openPrFn: (_root, pr) =>
            effect('pr:create', () => {
                if (forge.has(pr.branch)) throw new Error(`PR из ${pr.branch} уже есть`);
                const n = forge.size + 1;
                forge.set(pr.branch, n);
                return n;
            }),
        registryFs: {
            readFile: (p) => read(() => fs.readFileSync(p, 'utf8')),
            readdir: (d) => read(() => fs.readdirSync(d)),
            mkdir: (d) => read(() => fs.mkdirSync(d, { recursive: true })),
            writeAtomic: (p, t) =>
                effect('registry:register', () => {
                    fs.writeFileSync(`${p}.tmp`, t);
                    fs.renameSync(`${p}.tmp`, p);
                }),
        },
        listDataDirFn: unused('listDataDirFn'),
        renameFn: unused('renameFn'),
        rmFn: unused('rmFn'),
        runningRevisionsFn: unused('runningRevisionsFn'),
    };
    return { w, out, steps, deps, effect };
}

// ── Инварианты после обрыва ──────────────────────────────────────────────────

/** Прежняя ревизия стартует: start по lock доходит до её ядра, дерево сверено. */
function expectStartsOn(sha: string): void {
    const ran: string[] = [];
    const { deps } = launcherProcess(null, new Map());
    const code = runStartCommand(START_ARGS(consumer), {
        ...deps,
        runCoreFn: (dir) => {
            ran.push(dir);
            return 0;
        },
    });
    expect(code).toBe(0);
    expect(ran).toEqual([path.join(dataDir, sha)]);
}

/** Дерево потребителя чисто: HEAD, ветка, lock и рабочее дерево — как до операции. */
function expectConsumerClean(): void {
    expect(git(consumer, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(consumer, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(consumer, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(consumer, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(
        'refs/heads/main',
    );
    expect(fs.readFileSync(path.join(consumer, CORE_LOCK_PATH), 'utf8')).toBe(lockBefore);
}

/** State читается и не тронут. */
function expectStateReadable(): void {
    expect(inspectStateAt(paths().state, (p) => fs.readFileSync(p, 'utf8')).status).toBe('ok');
    expect(fs.readFileSync(paths().state, 'utf8')).toBe(stateBefore);
}

/** Lock в ветке PR на origin — `sha` с деревом, которое лежит в установке. */
function expectBranchLock(branch: string, sha: string): void {
    const text = git(origin, 'show', `${branch}:.ralph/core.lock`) + '\n';
    const lock = JSON.parse(text) as TCoreLock;
    expect(lock.sha).toBe(sha);
    expect(verifyInstalledTree(path.join(dataDir, sha), lock)).toEqual({ ok: true });
    expect(git(origin, 'rev-parse', `${branch}^`)).toBe(git(origin, 'rev-parse', 'main'));
}

function expectNoLeftovers(): void {
    // Реестр потребителей (#138) — не остаток; остаток в нём — недописанная запись.
    expect(fs.readdirSync(dataDir).filter((n) => n.startsWith('.') && n !== CONSUMERS_DIR)).toEqual(
        [],
    );
    const registry = path.join(dataDir, CONSUMERS_DIR);
    if (fs.existsSync(registry)) {
        expect(fs.readdirSync(registry).filter((n) => !n.endsWith('.json'))).toEqual([]);
    }
    expect(git(consumer, 'for-each-ref', 'refs/ralph')).toBe('');
}

/**
 * Операция в мире, который умрёт по дороге. Убитый процесс не возвращает ничего: что бы
 * раннер ни сделал после смерти (`catch`, отказ, код), это уходит в пустоту — проверяется
 * только, что смерть случилась, а дальше смотрим на диск, git и форж.
 */
function crash(w: { dead: boolean }, op: () => number): void {
    try {
        op();
    } catch (e) {
        if (!(e instanceof Killed)) throw e;
    }
    expect(w.dead).toBe(true);
}

const WHEN = ['before', 'after'] as const;
const cases = (steps: readonly string[]) =>
    steps.flatMap((step) => WHEN.map((when) => [step, when] as const));

// ── update ───────────────────────────────────────────────────────────────────

const UPDATE_ARGS = (): TLauncherArgs => ({
    command: 'update',
    consumerRoot: consumer,
    source: null,
    rev: 'v2',
    profile: null,
    passthrough: [],
});
const UPDATE_BRANCH = updateBranchName(NEW);

describe('update: обрыв на каждом шаге (#104)', () => {
    it('непрерванный update исполняет ровно шаги списка, по порядку', () => {
        const p = launcherProcess(null, new Map());
        expect(runUpdateCommand(UPDATE_ARGS(), p.deps)).toBe(0);
        expect(p.steps).toEqual(UPDATE_STEPS);
    });

    it.each(cases(UPDATE_STEPS))(
        'убит у шага %s (%s): прежняя ревизия рабочая, повтор доводит',
        (step, when) => {
            const forge: TForge = new Map();
            const dead = launcherProcess({ step, when }, forge);
            crash(dead.w, () => runUpdateCommand(UPDATE_ARGS(), dead.deps));

            expectStartsOn(OLD);
            expectConsumerClean();
            expectStateReadable();

            const retry = launcherProcess(null, forge);
            expect(runUpdateCommand(UPDATE_ARGS(), retry.deps)).toBe(0);
            expectBranchLock(UPDATE_BRANCH, NEW);
            expect([...forge]).toEqual([[UPDATE_BRANCH, 1]]);
            expectNoLeftovers();
            // Петля всё ещё на прежней ревизии: lock меняет мердж PR, а не update.
            expectStartsOn(OLD);
            expectConsumerClean();
            expectStateReadable();

            // Ещё один повтор — ничего нового: та же ветка, тот же PR.
            const tip = git(origin, 'rev-parse', `refs/heads/${UPDATE_BRANCH}`);
            const again = launcherProcess(null, forge);
            expect(runUpdateCommand(UPDATE_ARGS(), again.deps)).toBe(0);
            expect(git(origin, 'rev-parse', `refs/heads/${UPDATE_BRANCH}`)).toBe(tip);
            expect([...forge]).toEqual([[UPDATE_BRANCH, 1]]);
            expect(again.steps).not.toContain('lock:push');
            expect(again.steps).not.toContain('pr:create');
        },
    );
});

// ── rollback ─────────────────────────────────────────────────────────────────

const ROLLBACK_ARGS = (): TLauncherArgs => ({
    command: 'rollback',
    consumerRoot: consumer,
    source: null,
    rev: null,
    profile: null,
    passthrough: [],
});
const ROLLBACK_BRANCH = rollbackBranchName(OLD);

/**
 * Lock уже на новой ревизии, она активирована; прежней в каталоге установок нет — откат
 * ставит её из источника заново, и все шаги установки идут в списке.
 */
function onNewRevision(): void {
    const newLock = installedLock(NEW);
    expect(newLock.treeHash).toBe(newTreeHash);
    commitLock(newLock, 'ревизия ядра новая');
    fs.appendFileSync(
        paths().activations,
        `${JSON.stringify({ at: '2026-10-02T00:00:00.000Z', sha: NEW, from: OLD })}\n`,
    );
    fs.rmSync(path.join(dataDir, OLD), { recursive: true });
    snapshotConsumer();
}

describe('rollback: обрыв на каждом шаге (#104)', () => {
    beforeEach(onNewRevision);

    it('непрерванный rollback исполняет ровно шаги списка, по порядку', () => {
        const p = launcherProcess(null, new Map());
        expect(runRollbackCommand(ROLLBACK_ARGS(), p.deps)).toBe(0);
        expect(p.steps).toEqual(ROLLBACK_STEPS);
    });

    it.each(cases(ROLLBACK_STEPS))(
        'убит у шага %s (%s): ревизия lock рабочая, повтор доводит',
        (step, when) => {
            const forge: TForge = new Map();
            const dead = launcherProcess({ step, when }, forge);
            crash(dead.w, () => runRollbackCommand(ROLLBACK_ARGS(), dead.deps));

            expectStartsOn(NEW);
            expectConsumerClean();
            expectStateReadable();

            const retry = launcherProcess(null, forge);
            expect(runRollbackCommand(ROLLBACK_ARGS(), retry.deps)).toBe(0);
            expectBranchLock(ROLLBACK_BRANCH, OLD);
            expect([...forge]).toEqual([[ROLLBACK_BRANCH, 1]]);
            expectNoLeftovers();
            expectStartsOn(NEW);
            expectConsumerClean();
            expectStateReadable();

            const again = launcherProcess(null, forge);
            expect(runRollbackCommand(ROLLBACK_ARGS(), again.deps)).toBe(0);
            expect([...forge]).toEqual([[ROLLBACK_BRANCH, 1]]);
            expect(again.steps).not.toContain('lock:push');
        },
    );
});

// ── активация ────────────────────────────────────────────────────────────────

let mergedLock: TCoreLock;

/**
 * Новая ревизия поставлена update'ом, PR ещё не смерджен: петля стартует на прежней. Мердж
 * приезжает в дерево потребителя за время работы прежнего ядра — до его выхода на рестарт.
 */
function preparedUpdate(): void {
    mergedLock = installedLock(NEW);
    snapshotConsumer();
}

/** Мердж PR update и подтянутое дерево потребителя; повтор — no-op, как у `pull`. */
function mergeUpdate(): void {
    const onDisk = fs.readFileSync(path.join(consumer, CORE_LOCK_PATH), 'utf8');
    if (onDisk !== formatCoreLock(mergedLock)) commitLock(mergedLock, 'мердж PR update');
}

/**
 * `./ralph start`: прежнее ядро на границе итерации видит lock новее себя и выходит кодом
 * рестарта, launcher запускает ядро из lock, новое ядро пишет строку журнала активации.
 */
function startProcess(killAt: { step: string; when: 'before' | 'after' } | null) {
    const p = launcherProcess(killAt, new Map());
    const { effect } = p;
    const store = {
        read: () => {
            p.w.alive();
            return fs.existsSync(paths().activations)
                ? fs.readFileSync(paths().activations, 'utf8')
                : null;
        },
        append: (line: string) =>
            effect('activation:append', () => fs.appendFileSync(paths().activations, line)),
    };
    const runCoreFn = (dir: string): number => {
        if (dir === path.join(dataDir, OLD)) {
            return effect('core:run-old', () => {
                mergeUpdate();
                return ACTIVATION_RESTART_EXIT;
            });
        }
        if (dir === path.join(dataDir, NEW)) {
            return effect('core:run-new', () => {
                recordActivation(NEW, store, () => '2026-10-03T00:00:00.000Z');
                return 0;
            });
        }
        throw new Error(`ядро ${dir} не из этого мира`);
    };
    return { ...p, deps: { ...p.deps, runCoreFn } };
}

function journal() {
    return parseActivationJournal(fs.readFileSync(paths().activations, 'utf8'));
}

/** Дерево чисто и на `main`; lock — прежний или смердженный, третьего не бывает. */
function expectConsumerCleanAcrossMerge(): void {
    expect(git(consumer, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(consumer, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(consumer, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(
        'refs/heads/main',
    );
    const lock = fs.readFileSync(path.join(consumer, CORE_LOCK_PATH), 'utf8');
    expect([lockBefore, formatCoreLock(mergedLock)]).toContain(lock);
}

describe('активация: обрыв на каждом шаге (#104)', () => {
    beforeEach(preparedUpdate);

    it('непрерванный рестарт исполняет ровно шаги списка, по порядку', () => {
        const p = startProcess(null);
        expect(runStartCommand(START_ARGS(consumer), p.deps)).toBe(0);
        expect(p.steps).toEqual(ACTIVATION_STEPS);
        expect(journal().map((a) => [a.sha, a.from])).toEqual([
            [OLD, null],
            [NEW, OLD],
        ]);
    });

    it.each(cases(ACTIVATION_STEPS))(
        'убит у шага %s (%s): прежняя ревизия цела, повтор start активирует новую один раз',
        (step, when) => {
            const dead = startProcess({ step, when });
            crash(dead.w, () => runStartCommand(START_ARGS(consumer), dead.deps));

            // Прежняя ревизия рабочая: дерево сверено, и откат (если понадобится) ведёт на неё.
            expect(verifyInstalledTree(path.join(dataDir, OLD), oldLock)).toEqual({ ok: true });
            const lockSha = (
                JSON.parse(
                    fs.readFileSync(path.join(consumer, CORE_LOCK_PATH), 'utf8'),
                ) as TCoreLock
            ).sha;
            if (lockSha === OLD) expectStartsOn(OLD);
            else expect(rollbackTarget(journal(), lockSha)).toEqual({ ok: true, sha: OLD });
            expectConsumerCleanAcrossMerge();
            expectStateReadable();

            const retry = startProcess(null);
            expect(runStartCommand(START_ARGS(consumer), retry.deps)).toBe(0);
            expect(retry.steps.at(-1)).not.toBe('core:run-old');
            const again = startProcess(null);
            expect(runStartCommand(START_ARGS(consumer), again.deps)).toBe(0);
            expect(again.steps).toEqual(['core:run-new']);
            expect(journal().map((a) => [a.sha, a.from])).toEqual([
                [OLD, null],
                [NEW, OLD],
            ]);
            expectConsumerCleanAcrossMerge();
            expectStateReadable();
        },
    );
});

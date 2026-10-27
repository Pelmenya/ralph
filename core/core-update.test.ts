// `commitLockOnBranch` на НАСТОЯЩЕМ git (#102): lock меняется только в ветке PR, а дерево,
// индекс и HEAD человека остаются как были. Фейк исполнителя здесь не годится: «команды
// плюмбинга не трогают рабочее дерево» — свойство git, а не порядка вызовов.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_LOCK_SCHEMA, formatCoreLock, type TCoreLock } from './core-install.ts';
import { supportedVersions } from './compat.ts';
import {
    commitLockOnBranch,
    pidAlive,
    updateBranchName,
    updateCompatProblems,
    updatePrText,
    type TRunArgvFn,
} from './core-update.ts';

const OLD: TCoreLock = {
    schema: CORE_LOCK_SCHEMA,
    sha: 'a'.repeat(40),
    treeHash: `sha256:${'1'.repeat(64)}`,
    versions: supportedVersions(),
};
const NEW: TCoreLock = { ...OLD, sha: 'b'.repeat(40), treeHash: `sha256:${'2'.repeat(64)}` };
const BRANCH = updateBranchName(NEW.sha);

let work: string;
let consumer: string;
let origin: string;
let env: NodeJS.ProcessEnv;

const runArgv: TRunArgvFn = (file, args, opts = {}) => {
    const r = spawnSync(file, args, {
        encoding: 'utf8',
        input: opts.input,
        env: opts.env ?? env,
    });
    if (r.status !== 0) throw new Error(`${file} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
};
const git = (cwd: string, ...args: string[]) => runArgv('git', ['-C', cwd, ...args]);

beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'core-update-'));
    const home = join(work, 'home');
    mkdirSync(home);
    env = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'sandbox',
        GIT_AUTHOR_EMAIL: 'sandbox@example.invalid',
        GIT_COMMITTER_NAME: 'sandbox',
        GIT_COMMITTER_EMAIL: 'sandbox@example.invalid',
    };
    origin = join(work, 'origin.git');
    consumer = join(work, 'app');
    git(work, 'init', '--quiet', '--bare', origin);
    mkdirSync(join(consumer, '.ralph'), { recursive: true });
    git(consumer, 'init', '--quiet', '-b', 'main');
    writeFileSync(join(consumer, '.ralph', 'core.lock'), formatCoreLock(OLD));
    writeFileSync(join(consumer, 'app.txt'), 'код\n');
    git(consumer, 'add', '-A');
    git(consumer, 'commit', '--quiet', '-m', 'потребитель');
    git(consumer, 'remote', 'add', 'origin', origin);
    git(consumer, 'push', '--quiet', '-u', 'origin', 'main');
});
afterEach(() => {
    rmSync(work, { recursive: true, force: true });
});

function commit(over: Partial<Parameters<typeof commitLockOnBranch>[0]> = {}): string {
    return commitLockOnBranch({
        runArgvFn: runArgv,
        consumerRoot: consumer,
        env,
        indexFile: join(work, 'tmp-index'),
        branch: BRANCH,
        lock: NEW,
        message: updatePrText(OLD, NEW).message,
        ...over,
    });
}

describe('commitLockOnBranch на настоящем git (#102)', () => {
    it('lock меняется только в ветке PR, рабочее дерево человека чисто', () => {
        // Человек стоит на своей ветке с незакоммиченной правкой — update её не касается.
        git(consumer, 'switch', '--quiet', '-c', 'human-work');
        writeFileSync(join(consumer, 'app.txt'), 'правка человека\n');
        const head = git(consumer, 'rev-parse', 'HEAD');
        const status = git(consumer, 'status', '--porcelain');

        const sha = commit();

        expect(git(consumer, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(consumer, 'symbolic-ref', '--short', 'HEAD')).toBe('human-work');
        expect(git(consumer, 'status', '--porcelain')).toBe(status);
        expect(readFileSync(join(consumer, '.ralph', 'core.lock'), 'utf8')).toBe(
            formatCoreLock(OLD),
        );
        // Локальной ветки и служебного ref не осталось.
        expect(
            git(consumer, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/ralph'),
        ).toBe('refs/heads/human-work\nrefs/heads/main');

        expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(sha);
        expect(git(origin, 'show', `${BRANCH}:.ralph/core.lock`) + '\n').toBe(formatCoreLock(NEW));
        // Коммит — ровно правка lock поверх main origin.
        expect(git(origin, 'rev-parse', `${BRANCH}^`)).toBe(git(origin, 'rev-parse', 'main'));
        expect(git(origin, 'diff', '--name-only', 'main', BRANCH)).toBe('.ralph/core.lock');
        expect(git(origin, 'log', '-1', '--format=%s', BRANCH)).toBe(updatePrText(OLD, NEW).title);
    });

    // Update и rollback из двух терминалов: общий ref перезаписывал базу соседа, а
    // `finally` первого снимал ref второго посреди его шагов (ревью Фазы 13).
    it('служебные ref — свои у попытки: чужие не тронуты, свои убраны', () => {
        const main = git(consumer, 'rev-parse', 'main');
        git(consumer, 'update-ref', 'refs/ralph/update-base-other', main);
        git(consumer, 'update-ref', 'refs/ralph/update-prior-other', main);
        // Сирота убитой попытки (мёртвый pid) снимается, ref живого соседа — нет.
        git(consumer, 'update-ref', 'refs/ralph/update-base-111-dead', main);
        git(consumer, 'update-ref', 'refs/ralph/update-base-222-live', main);
        commit({ refSuffix: 'mine', pidAliveFn: (pid) => pid === 222 });
        expect(git(consumer, 'for-each-ref', '--format=%(refname)', 'refs/ralph')).toBe(
            [
                'refs/ralph/update-base-222-live',
                'refs/ralph/update-base-other',
                'refs/ralph/update-prior-other',
            ].join('\n'),
        );
    });

    it('живость pid: свой процесс жив, номер за пределом pid_max — мёртв', () => {
        expect(pidAlive(process.pid)).toBe(true);
        expect(pidAlive(2 ** 30)).toBe(false);
    });

    it('ветка на origin без lock — отказ «другой lock», а не падение', () => {
        const other = join(work, 'other');
        git(work, 'clone', '--quiet', '-b', 'main', origin, other);
        git(other, 'rm', '--quiet', '.ralph/core.lock');
        git(other, 'commit', '--quiet', '-m', 'без lock');
        git(other, 'push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`);
        expect(() => commit()).toThrow(/уже есть на origin.*другой lock/);
    });

    it('база — свежий main origin, а не локальный HEAD человека', () => {
        const other = join(work, 'other');
        git(work, 'clone', '--quiet', '-b', 'main', origin, other);
        writeFileSync(join(other, 'new.txt'), 'с origin\n');
        git(other, 'add', '-A');
        git(other, 'commit', '--quiet', '-m', 'встречный коммит');
        git(other, 'push', '--quiet', 'origin', 'main');

        commit();
        expect(git(origin, 'rev-parse', `${BRANCH}^`)).toBe(git(origin, 'rev-parse', 'main'));
    });

    it('ветка с другим lock уже есть на origin — отказ без перезаписи, служебные ref убраны', () => {
        const first = commit();
        expect(() => commit({ lock: { ...NEW, treeHash: `sha256:${'3'.repeat(64)}` } })).toThrow(
            /уже есть на origin.*другой lock/,
        );
        expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(first);
        expect(git(consumer, 'for-each-ref', 'refs/ralph')).toBe('');
    });

    it('ветка с тем же lock уже есть (повтор после обрыва) — её коммит, без второго пуша (#104)', () => {
        const first = commit();
        // main ушёл вперёд: дерево нового коммита разошлось бы, а lock в ветке тот же.
        const other = join(work, 'other');
        git(work, 'clone', '--quiet', '-b', 'main', origin, other);
        writeFileSync(join(other, 'new.txt'), 'с origin\n');
        git(other, 'add', '-A');
        git(other, 'commit', '--quiet', '-m', 'встречный коммит');
        git(other, 'push', '--quiet', 'origin', 'main');

        const pushes: string[][] = [];
        const spy: TRunArgvFn = (file, args, opts) => {
            if (args[2] === 'push') pushes.push(args);
            return runArgv(file, args, opts);
        };
        expect(commit({ runArgvFn: spy })).toBe(first);
        expect(pushes).toEqual([]);
        expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(first);
        expect(git(consumer, 'for-each-ref', 'refs/ralph')).toBe('');
    });

    it('сетевые шаги идут с запретом промпта кредов и сроком', () => {
        const calls: { args: string[]; timeoutMs?: number }[] = [];
        const spy: TRunArgvFn = (file, args, opts) => {
            calls.push({ args, timeoutMs: opts?.timeoutMs });
            return runArgv(file, args, opts);
        };
        commit({ runArgvFn: spy });
        const network = calls.filter((c) =>
            ['fetch', 'push', 'ls-remote'].includes(c.args[2] ?? ''),
        );
        expect(network.map((c) => c.args[2])).toEqual(['fetch', 'ls-remote', 'push']);
        for (const c of network) expect(c.timeoutMs).toBeGreaterThan(0);
    });

    it('неудачная уборка служебного ref не заслоняет результат', () => {
        const spy = vi.fn<TRunArgvFn>((file, args, opts) => {
            if (args.includes('update-ref')) throw new Error('ref заперт');
            return runArgv(file, args, opts);
        });
        expect(commit({ runArgvFn: spy })).toMatch(/^[0-9a-f]{40}$/);
    });
});

describe('updateCompatProblems', () => {
    const ok = { kind: 'version', version: 1 } as const;
    it('совместимая ревизия — пусто', () => {
        expect(
            updateCompatProblems({ next: OLD.versions, current: OLD, launcher: ok, config: ok }),
        ).toEqual([]);
    });

    it('называет все расхождения разом', () => {
        const problems = updateCompatProblems({
            next: { ...OLD.versions, launcher: 2, config: 2 },
            current: OLD,
            launcher: { kind: 'absent', note: 'не задан' },
            config: { kind: 'invalid', reason: 'битый' },
        });
        expect(problems).toEqual([
            'launcher: версия не определена (не задан)',
            'config: версия не определена (битый)',
        ]);
    });
});

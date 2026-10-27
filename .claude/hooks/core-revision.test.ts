// Контракт запуска петли (#99): сессия заявлена `RALPH_CORE_SHA`, хук сверяет себя с этой
// ревизией ядра. Чистая сверка гоняется на подменённых коллабораторах; сквозной набор —
// на НАСТОЯЩЕМ git во временном репозитории с копией хуков: только так видно, что хук
// другой ревизии действительно выходит двойкой, единственным кодом, который у PreToolUse
// блокирует.
import { execFileSync, spawnSync } from 'node:child_process';
import {
    appendFileSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { blobHash, checkCoreRevision, expectedSha } from './core-revision.cjs';

const HOOKS = import.meta.dirname;
const ROOT = path.resolve(HOOKS, '..', '..');
const SHA = 'a'.repeat(40);

describe('сверка ревизии на подменённых коллабораторах', () => {
    const files: Record<string, string> = { 'guard.cjs': 'guard', 'guard-rules.cjs': 'rules' };
    const tree = (overrides: Record<string, string> = {}) =>
        new Map(
            Object.entries({ ...files, ...overrides }).map(([name, body]) => [
                name,
                blobHash(body, SHA),
            ]),
        );
    const deps = (lsTreeFn: () => Map<string, string>, disk = files) => ({
        env: { RALPH_CORE_SHA: SHA },
        hooksDir: '/hooks',
        lsTreeFn,
        readFileFn: (file: string) => disk[path.basename(file)] ?? '',
        readdirFn: () => [...Object.keys(disk), 'guard-rules.test.ts'],
        realpathFn: (p: string) => p,
    });

    it('переменной нет — сессия человека: не петля и сверять нечего', () => {
        expect(checkCoreRevision({ env: {} })).toEqual({ loop: false, error: null });
        expect(expectedSha({ RALPH_CORE_SHA: '  ' })).toBe('');
    });

    it('совпало содержимое каждого .cjs — петля без ошибки; .ts не сверяется', () => {
        expect(checkCoreRevision(deps(() => tree()))).toEqual({ loop: true, error: null });
    });

    it('файл разошёлся, пропал или лишний — блок с именем файла', () => {
        expect(checkCoreRevision(deps(() => tree({ 'guard.cjs': 'другое' }))).error).toContain(
            'guard.cjs',
        );
        expect(checkCoreRevision(deps(() => tree({ 'extra.cjs': 'x' }))).error).toContain(
            'extra.cjs (нет на диске)',
        );
        expect(
            checkCoreRevision(deps(() => tree(), { ...files, 'planted.cjs': 'x' })).error,
        ).toContain('planted.cjs (нет в ревизии)');
    });

    it('не SHA, ревизия не читается, пустое дерево — блок, а не пропуск', () => {
        expect(
            checkCoreRevision({ ...deps(() => tree()), env: { RALPH_CORE_SHA: 'main' } }).error,
        ).toContain('не полный SHA');
        expect(
            checkCoreRevision({ ...deps(() => tree()), env: { RALPH_CORE_SHA: '--output=x' } })
                .error,
        ).toContain('не полный SHA');
        const unreadable = checkCoreRevision(
            deps(() => {
                throw new Error('fatal: not a tree object');
            }),
        );
        expect(unreadable).toEqual({ loop: true, error: expect.stringContaining('не читается') });
        expect(checkCoreRevision(deps(() => new Map())).error).toContain('нет исполняемых');
    });

    it('хеш блоба — как у git, в том числе для не-ASCII содержимого', () => {
        // Строка и байты — один блоб; пустой блоб — известный хеш git.
        expect(blobHash('барьер\n', SHA)).toBe(blobHash(Buffer.from('барьер\n'), SHA));
        expect(blobHash('', SHA)).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    });
});

describe('хук другой ревизии, чем ядро, блокирует действие — на настоящем git', () => {
    let root = '';
    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
        root = '';
    });

    /** Окружение git без конфигов и перенаправлений вызывающего. */
    const gitEnv = () => {
        const env: Record<string, string | undefined> = { ...process.env };
        for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
        return {
            ...env,
            HOME: root,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@example.com',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@example.com',
        };
    };
    const git = (...args: string[]) =>
        execFileSync('git', args, {
            cwd: root,
            env: gitEnv(),
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

    /** Ядро во временном репозитории: исполняемые хуки канона, закоммиченные. */
    const core = () => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), 'core-revision-')));
        const hooks = path.join(root, '.claude/hooks');
        mkdirSync(hooks, { recursive: true });
        for (const name of readdirSync(HOOKS).filter((n) => n.endsWith('.cjs'))) {
            copyFileSync(path.join(HOOKS, name), path.join(hooks, name));
        }
        git('init', '--quiet', '-b', 'main');
        git('add', '-A');
        git('commit', '--quiet', '-m', 'ядро');
        return { hooks, sha: git('rev-parse', 'HEAD') };
    };

    const run = (hook: string, sha: string, toolName: string, toolInput: object) =>
        spawnSync(process.execPath, [hook], {
            input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
            encoding: 'utf-8',
            env: {
                ...gitEnv(),
                RALPH_CORE_SHA: sha,
                RALPH_SKILL_GUARD: '',
                CLAUDE_PROJECT_DIR: ROOT,
                TMPDIR: root,
            },
        });

    it('guard: та же ревизия пропускает безобидное, правленые правила блокируют всё', () => {
        const { hooks, sha } = core();
        const guard = path.join(hooks, 'guard.cjs');
        expect(run(guard, sha, 'Bash', { command: 'git status' }).status).toBe(0);

        appendFileSync(path.join(hooks, 'guard-rules.cjs'), '\n// правка из PR\n');
        const denied = run(guard, sha, 'Bash', { command: 'git status' });
        expect(denied.status).toBe(2);
        expect(denied.stderr).toContain('guard-rules.cjs');
        expect(denied.stderr).toContain(sha);
    });

    it('skill-barrier: подложенный модуль рядом — блок любой правки, а не только теста', () => {
        const { hooks, sha } = core();
        const barrier = path.join(hooks, 'skill-barrier.cjs');
        expect(run(barrier, sha, 'Edit', { file_path: 'core/gate.ts' }).status).toBe(0);

        copyFileSync(path.join(hooks, 'guard.cjs'), path.join(hooks, 'planted.cjs'));
        const denied = run(barrier, sha, 'Edit', { file_path: 'core/gate.ts' });
        expect(denied.status).toBe(2);
        expect(denied.stderr).toContain('planted.cjs (нет в ревизии)');
    });

    // Находка ревью Фазы 11: сверка шла ПОСЛЕ require соседей, и одна строка в правилах,
    // подменяющая сверщик у закэшированного модуля, давала exit 0 на разошедшемся файле.
    const SPOOF =
        "\nrequire('./core-revision.cjs').checkCoreRevision = () => ({ loop: true, error: null });\n";

    it('guard: правила, подменяющие сверщик, не исполняются раньше сверки — блок', () => {
        const { hooks, sha } = core();
        appendFileSync(path.join(hooks, 'guard-rules.cjs'), SPOOF);
        const denied = run(path.join(hooks, 'guard.cjs'), sha, 'Bash', { command: 'git status' });
        expect(denied.status).toBe(2);
        expect(denied.stderr).toContain('guard-rules.cjs');
    });

    it('skill-barrier: разбор данных, подменяющий сверщик, не исполняется раньше сверки', () => {
        const { hooks, sha } = core();
        appendFileSync(path.join(hooks, 'consumer-data.cjs'), SPOOF);
        const barrier = path.join(hooks, 'skill-barrier.cjs');
        const denied = run(barrier, sha, 'Edit', { file_path: 'core/gate.ts' });
        expect(denied.status).toBe(2);
        expect(denied.stderr).toContain('consumer-data.cjs');
    });

    it('имя хука не-ASCII при core.quotePath — не ложный блок «нет в ревизии»', () => {
        const { hooks } = core();
        copyFileSync(path.join(hooks, 'shell-calls.cjs'), path.join(hooks, 'разбор "x".cjs'));
        git('-c', 'core.quotePath=true', 'add', '-A');
        git('commit', '--quiet', '-m', 'имя');
        const verdict = checkCoreRevision({
            env: { RALPH_CORE_SHA: git('rev-parse', 'HEAD') },
            hooksDir: hooks,
        });
        expect(verdict).toEqual({ loop: true, error: null });
    });

    it('ревизии нет в репозитории хука — блок: недоступность не равна совпадению', () => {
        const { hooks } = core();
        const denied = run(path.join(hooks, 'guard.cjs'), 'f'.repeat(40), 'Bash', {
            command: 'git status',
        });
        expect(denied.status).toBe(2);
        expect(denied.stderr).toContain('не читается');
    });
});

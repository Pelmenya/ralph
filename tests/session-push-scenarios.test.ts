// Приёмочный сценарий: сессия разбора blocked закоммитила и не запушила (#85).
//
// Юниты (`core/session-push.test.ts`) проверяют развилки по кодам git. Здесь — то, чего
// фейком не докажешь: что после пуша раннера локальный ref и голова ветки на `origin`
// совпадают (ровно то, что сверяет гейт), и что допушенная снаружи ветка не
// перезаписывается — non-ff отказ остаётся отказом, а чужой коммит на месте.
//
// git НАСТОЯЩИЙ, как у соседних сценариев ветки фазы: `runArgvFn` инжектируется тестом и
// исполняет команды сам, боевой `shArgv` не зовётся. Окружение git — своё: `GIT_DIR`
// вызывающего увёл бы коммиты в его репозиторий.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pushSessionCommits } from '../core/session-push.ts';

const BRANCH = 'feature/faza-1';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function buildWorld() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-session-push-')));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'scenario',
        GIT_AUTHOR_EMAIL: 'scenario@example.invalid',
        GIT_COMMITTER_NAME: 'scenario',
        GIT_COMMITTER_EMAIL: 'scenario@example.invalid',
    };
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf-8',
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    const origin = path.join(root, 'origin.git');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
    const work = path.join(root, 'work');
    git(root, 'clone', '--quiet', origin, work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', 'первый');
    git(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
    git(work, 'switch', '--quiet', '-c', BRANCH);
    git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`);
    // Сессия разбора: коммит в ветку фазы, пуша нет.
    const commit = (cwd: string, file: string, msg: string) => {
        fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '--quiet', '-m', msg);
    };
    const runArgvFn = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) =>
        execFileSync(file, args, {
            cwd: work,
            encoding: 'utf-8',
            // Сетевое окружение модуля (gitNetworkEnv) несёт запрет промпта кредов; HOME и
            // конфиг — от песочницы, иначе ушли бы в git вызывающего.
            env: { ...(opts?.env ?? {}), ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    const remoteHead = () =>
        git(work, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split(/\s+/)[0];
    return { root, work, origin, git, commit, runArgvFn, remoteHead, env };
}

describe('сессия разбора blocked оставила незапушенный коммит', () => {
    it('раннер пушит его: локальный ref и голова ветки на origin совпадают', () => {
        const w = buildWorld();
        w.commit(w.work, 'fix.txt', 'fix: блокер ревью');
        const local = w.git(w.work, 'rev-parse', `refs/heads/${BRANCH}`);
        expect(w.remoteHead()).not.toBe(local);

        const res = pushSessionCommits(BRANCH, { runArgvFn: w.runArgvFn, logFn: () => {} });
        expect(res.kind).toBe('pushed');
        // Ровно то, что гейт сверяет перед чеками: расхождения больше нет.
        expect(w.remoteHead()).toBe(local);
        // Повтор — идемпотентен: пушить уже нечего.
        expect(pushSessionCommits(BRANCH, { runArgvFn: w.runArgvFn, logFn: () => {} }).kind).toBe(
            'in-sync',
        );
    });

    it('ветку допушили снаружи → отказ non-ff, чужой коммит на origin не тронут', () => {
        const w = buildWorld();
        const other = path.join(w.root, 'other');
        w.git(w.root, 'clone', '--quiet', '-b', BRANCH, w.origin, other);
        w.commit(other, 'other.txt', 'чужая правка');
        w.git(other, 'push', '--quiet', 'origin', BRANCH);
        const foreign = w.remoteHead();
        w.commit(w.work, 'fix.txt', 'fix: блокер ревью');

        const res = pushSessionCommits(BRANCH, { runArgvFn: w.runArgvFn, logFn: () => {} });
        expect(res.kind).toBe('failed');
        expect(w.remoteHead()).toBe(foreign);
    });
});

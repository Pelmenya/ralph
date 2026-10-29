// Приёмочный сценарий: ветка фазы, отставшая от `main` (#66).
//
// Юниты (`core/main-sync.test.ts`) проверяют контракт — argv и решение на развилке. Здесь —
// то, чего фейком не докажешь: что встречная правка ТОГО ЖЕ файла действительно даёт
// конфликт с этим файлом в имени, что после отказа дерево чистое (следующий рестарт
// начинается с того же места), и что без конфликта влитие доезжает до `origin` и гейт
// гоняет чеки на голове, которая содержит `main`.
//
// git НАСТОЯЩИЙ, как у соседних сценариев ветки фазы: `runArgvFn` инжектируется тестом и
// исполняет команды сам, боевой `shArgv` не зовётся. Окружение git — своё, по той же
// причине: `GIT_DIR` вызывающего увёл бы коммиты в его репозиторий.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { syncPhaseBranchWithMain } from '../core/main-sync.ts';
import { createGateRunner } from '../core/gate.ts';
import type { GateEnv } from '../core/gate.ts';

// Срок — как у соседних живых наборов: каждый кейс порождает десятки процессов git (голый
// origin, клоны, коммиты, пуши). На хосте это доли секунды, а облачный раннер CI под
// параллельной нагрузкой сьюта порождает их в разы медленнее, и дефолтные 5 с там рвали
// исправный кейс тайм-аутом.
vi.setConfig({ testTimeout: 30_000 });

const BRANCH = 'feature/faza-1';
const JOURNAL = 'docs/core-journal.md';

function gitEnv(home: string): NodeJS.ProcessEnv {
    return {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'scenario',
        GIT_AUTHOR_EMAIL: 'scenario@example.invalid',
        GIT_COMMITTER_NAME: 'scenario',
        GIT_COMMITTER_EMAIL: 'scenario@example.invalid',
    };
}

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type World = {
    work: string;
    git: (cwd: string, ...args: string[]) => string;
    runArgvFn: (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => string;
    env: NodeJS.ProcessEnv;
    /** Коммит в `main` с другой машины — тот самый чужой мердж, пока петля держит фазу. */
    commitToMain: (file: string, text: string) => void;
    /** Голова ветки фазы на origin. */
    branchHead: () => string;
};

/**
 * Мир: origin с `main` и журналом, ветка фазы на origin с записью в журнал под шапкой, дерево
 * раннера detached на голове ветки и с локальным ref ветки — как его оставляет гейт.
 */
function buildWorld(): World {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-main-sync-')));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const env = gitEnv(home);
    const origin = path.join(root, 'origin.git');
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf-8',
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

    git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
    const other = path.join(root, 'other');
    git(root, 'clone', '--quiet', origin, other);
    fs.mkdirSync(path.join(other, 'docs'));
    fs.writeFileSync(path.join(other, JOURNAL), '# Журнал\n\n## Записи\n\n- старая запись\n');
    fs.writeFileSync(path.join(other, 'README.md'), '# проект\n');
    git(other, 'add', '-A');
    git(other, 'commit', '--quiet', '-m', 'первый коммит');
    git(other, 'push', '--quiet', 'origin', 'main');

    // Работа фазы: запись в журнал ровно под шапкой — туда же пишет и встречная сторона.
    git(other, 'checkout', '--quiet', '-b', BRANCH);
    fs.writeFileSync(
        path.join(other, JOURNAL),
        '# Журнал\n\n## Записи\n\n- запись фазы\n- старая запись\n',
    );
    fs.writeFileSync(path.join(other, 'phase.txt'), 'фаза\n');
    git(other, 'add', '-A');
    git(other, 'commit', '--quiet', '-m', 'работа фазы');
    git(other, 'push', '--quiet', 'origin', BRANCH);
    git(other, 'checkout', '--quiet', 'main');

    const work = path.join(root, 'work');
    git(root, 'clone', '--quiet', origin, work);
    git(work, 'branch', '--quiet', BRANCH, `origin/${BRANCH}`);
    git(work, 'checkout', '--quiet', '--detach', `origin/${BRANCH}`);

    return {
        work,
        git,
        env,
        runArgvFn: (file, args, opts) =>
            execFileSync(file, args, {
                cwd: work,
                encoding: 'utf-8',
                env: { ...env, ...(opts?.env ?? {}) },
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim(),
        commitToMain: (file, text) => {
            git(other, 'pull', '--quiet', '--ff-only', 'origin', 'main');
            fs.writeFileSync(path.join(other, file), text);
            git(other, 'add', '-A');
            git(other, 'commit', '--quiet', '-m', `встречная правка ${file}`);
            git(other, 'push', '--quiet', 'origin', 'main');
        },
        branchHead: () => git(work, 'ls-remote', origin, `refs/heads/${BRANCH}`).split(/\s/)[0],
    };
}

const logs: string[] = [];
const logFn = (m: string) => logs.push(m);

describe('ветка фазы отстала от main — настоящий git (#66)', () => {
    it('встречная правка ТОГО ЖЕ файла → conflict с этим файлом, дерево чистое, origin не тронут', () => {
        const w = buildWorld();
        w.commitToMain(JOURNAL, '# Журнал\n\n## Записи\n\n- чужая запись\n- старая запись\n');
        const head = w.git(w.work, 'rev-parse', 'HEAD');

        const res = syncPhaseBranchWithMain(BRANCH, head, { runArgvFn: w.runArgvFn, logFn });

        expect(res).toMatchObject({ kind: 'conflict', files: [JOURNAL] });
        // Отказ не оставляет полу-влития: рестарт начинает с того же места.
        expect(w.git(w.work, 'status', '--porcelain')).toBe('');
        expect(w.git(w.work, 'rev-parse', 'HEAD')).toBe(head);
        expect(w.branchHead()).toBe(head);
    });

    it('встречная правка другого файла → влито и запушено, ветка содержит main, ref следом', () => {
        const w = buildWorld();
        w.commitToMain('README.md', '# проект\n\nчужая правка\n');
        const head = w.git(w.work, 'rev-parse', 'HEAD');

        const res = syncPhaseBranchWithMain(BRANCH, head, { runArgvFn: w.runArgvFn, logFn });

        expect(res.kind).toBe('updated');
        if (res.kind !== 'updated') return;
        expect(w.branchHead()).toBe(res.head);
        w.git(w.work, 'merge-base', '--is-ancestor', 'origin/main', res.head);
        w.git(w.work, 'merge-base', '--is-ancestor', head, res.head);
        expect(w.git(w.work, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(res.head);
        expect(w.git(w.work, 'status', '--porcelain')).toBe('');
        // Повторный вызов на новой голове — подтягивать уже нечего.
        expect(
            syncPhaseBranchWithMain(BRANCH, res.head, { runArgvFn: w.runArgvFn, logFn }),
        ).toEqual({ kind: 'current' });
    });

    it('гейт целиком: отставшая ветка → чеки идут на голове с main, она же проверена', () => {
        const w = buildWorld();
        w.commitToMain('README.md', '# проект\n\nчужая правка\n');
        const checkedOn: string[] = [];
        const env: GateEnv = {
            sh: () => '',
            shArgv: w.runArgvFn,
            shq: (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`,
            log: logFn,
            fail: (msg: string) => {
                throw new Error(msg);
            },
            getConfig: () => ({ gate: { checks: [['lint', 'npm run lint']] } }),
            forgeJson: () => {
                throw new Error('форж не нужен');
            },
            prHeadSha: () => w.branchHead(),
            mergePr: () => {},
            phaseMerged: () => false,
            safeBranch: () => true,
            findOpenPr: () => null,
            ensureClean: () => true,
            parkOnOriginMain: () => {},
            updateRunnerTreeToOriginMain: () => {},
            updateConsumerTreeAfterMerge: () => {},
            syncDepsIfLockChanged: () => {},
            buildSanitizedGateEnv: () => ({ PATH: '/x' }),
            formatExcerpt: (s: string) => s,
            sleep: () => {},
            dry: false,
            SHA40_RE: /^[0-9a-f]{40}$/,
            PR_NUMBER_RE: /^\d+$/,
            runnerTreeFixHint: 'hint',
        };
        const g = createGateRunner(env);
        const ok = g.checksGreen(BRANCH, 7, {
            // Чтения гейта — настоящим git в дереве раннера, чек — записью головы.
            shFn: (cmd: string) => {
                if (cmd.startsWith('git ')) {
                    return execSync(cmd, {
                        cwd: w.work,
                        encoding: 'utf-8',
                        env: w.env,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    }).trim();
                }
                checkedOn.push(w.git(w.work, 'rev-parse', 'HEAD'));
                return '';
            },
            checks: [['lint', 'npm run lint']],
        });

        expect(ok).toBe(true);
        const verified = g.getVerifiedHead();
        expect(verified).toBe(w.branchHead());
        expect(checkedOn).toEqual([verified]);
        w.git(w.work, 'merge-base', '--is-ancestor', 'origin/main', String(verified));
    });
});

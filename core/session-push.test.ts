// Контракт пуша коммитов сессии (#85): развилки по кодам git, без настоящего git. Что
// последовательность делает с настоящим репозиторием, доказывает
// `tests/session-push-scenarios.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import { pushSessionCommits } from './session-push.ts';

const LOCAL = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);
const BRANCH = 'feature/x';

function gitError(status: number, stderr = 'boom'): Error {
    return Object.assign(new Error(stderr), { status, stderr });
}

type Answers = {
    revParse?: () => string;
    lsRemote?: () => string;
    isAncestor?: () => string;
    push?: () => string;
};

function fakeGit(a: Answers) {
    const calls: string[][] = [];
    const runArgvFn = vi.fn((_file: string, args: string[]) => {
        calls.push(args);
        const pick =
            args[0] === 'rev-parse'
                ? a.revParse
                : args[0] === 'ls-remote'
                  ? a.lsRemote
                  : args[0] === 'merge-base'
                    ? a.isAncestor
                    : args[0] === 'push'
                      ? a.push
                      : undefined;
        if (!pick) throw new Error(`неожиданная команда git ${args.join(' ')}`);
        return pick();
    });
    return { runArgvFn, calls };
}

const logFn = () => {};

describe('pushSessionCommits', () => {
    it('локальный ref совпадает с origin → пушить нечего, пуша нет', () => {
        const { runArgvFn, calls } = fakeGit({
            revParse: () => `${LOCAL}\n`,
            lsRemote: () => `${LOCAL}\trefs/heads/${BRANCH}\n`,
        });
        expect(pushSessionCommits(BRANCH, { runArgvFn, logFn })).toEqual({ kind: 'in-sync' });
        expect(calls.some((c) => c[0] === 'push')).toBe(false);
    });

    it('локального ref нет (код 1) → пушить нечего, origin не спрашиваем', () => {
        const { runArgvFn, calls } = fakeGit({
            revParse: () => {
                throw gitError(1, '');
            },
        });
        expect(pushSessionCommits(BRANCH, { runArgvFn, logFn })).toEqual({ kind: 'in-sync' });
        expect(calls).toHaveLength(1);
    });

    it('ref не читается (код 128) → отказ, а не «пушить нечего»', () => {
        const { runArgvFn } = fakeGit({
            revParse: () => {
                throw gitError(128, 'fatal: bad object');
            },
        });
        const res = pushSessionCommits(BRANCH, { runArgvFn, logFn });
        expect(res.kind).toBe('failed');
    });

    it('origin впереди коммитом сессии → пуш без --force ровно этого sha в ветку', () => {
        const logs: string[] = [];
        const { runArgvFn, calls } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => `${REMOTE}\trefs/heads/${BRANCH}`,
            isAncestor: () => {
                throw gitError(1, '');
            },
            push: () => '',
        });
        const res = pushSessionCommits(BRANCH, { runArgvFn, logFn: (m) => logs.push(m) });
        expect(res).toEqual({ kind: 'pushed', local: LOCAL, remote: REMOTE });
        const push = calls.find((c) => c[0] === 'push');
        expect(push).toEqual(['push', 'origin', `${LOCAL}:refs/heads/${BRANCH}`]);
        expect(push?.some((a) => a.includes('force'))).toBe(false);
        expect(logs.some((l) => l.includes('запушены раннером'))).toBe(true);
    });

    it('ветки на origin нет (код 2) → пушим её', () => {
        const { runArgvFn } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => {
                throw gitError(2, '');
            },
            push: () => '',
        });
        expect(pushSessionCommits(BRANCH, { runArgvFn, logFn })).toEqual({
            kind: 'pushed',
            local: LOCAL,
            remote: null,
        });
    });

    it('origin не отвечает (код 128 у ls-remote) → отказ, без пуша', () => {
        const { runArgvFn, calls } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => {
                throw gitError(128, 'fatal: could not read from remote');
            },
        });
        const res = pushSessionCommits(BRANCH, { runArgvFn, logFn });
        expect(res.kind).toBe('failed');
        expect(calls.some((c) => c[0] === 'push')).toBe(false);
    });

    it('локальный ref отстал (предок origin) → behind, без пуша', () => {
        const { runArgvFn, calls } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => `${REMOTE}\trefs/heads/${BRANCH}`,
            isAncestor: () => '',
        });
        const logs: string[] = [];
        expect(pushSessionCommits(BRANCH, { runArgvFn, logFn: (m) => logs.push(m) })).toEqual({
            kind: 'behind',
            local: LOCAL,
            remote: REMOTE,
        });
        expect(calls.some((c) => c[0] === 'push')).toBe(false);
        // Штатный исход, но не молчаливый: по логу видно, что пуш пропущен.
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('отстал от origin');
        expect(logs[0]).toContain('пуш не нужен');
    });

    it('пуш отвергнут (non-ff) → отказ с текстом git и sha обеих сторон', () => {
        const { runArgvFn } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => `${REMOTE}\trefs/heads/${BRANCH}`,
            isAncestor: () => {
                throw gitError(1, '');
            },
            push: () => {
                throw gitError(1, ' ! [rejected] (non-fast-forward)');
            },
        });
        const res = pushSessionCommits(BRANCH, { runArgvFn, logFn });
        expect(res).toMatchObject({ kind: 'failed', local: LOCAL, remote: REMOTE });
        expect(res.kind === 'failed' && res.why).toContain('non-fast-forward');
    });
});

describe('pushSessionCommits — транзиент сети (ревью 16c2)', () => {
    const transient = () => gitError(128, 'fatal: unable to access: Could not resolve host');

    it('моргнувший push повторяется с паузой и доезжает', () => {
        let pushes = 0;
        const sleeps: number[] = [];
        const { runArgvFn } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => {
                throw gitError(2, '');
            },
            push: () => {
                pushes += 1;
                if (pushes === 1) throw transient();
                return '';
            },
        });
        const res = pushSessionCommits(BRANCH, {
            runArgvFn,
            logFn,
            sleepFn: (ms) => sleeps.push(ms),
        });
        expect(res.kind).toBe('pushed');
        expect(pushes).toBe(2);
        expect(sleeps).toHaveLength(1);
    });

    it('моргнувший ls-remote повторяется, а код 2 «ветки нет» — нет', () => {
        let reads = 0;
        const { runArgvFn } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => {
                reads += 1;
                if (reads === 1) throw transient();
                throw gitError(2, '');
            },
            push: () => '',
        });
        const res = pushSessionCommits(BRANCH, { runArgvFn, logFn, sleepFn: () => {} });
        expect(res.kind).toBe('pushed');
        expect(reads).toBe(2);
    });

    it('транзиент, переживший попытки, — failed; non-ff не повторяется вовсе', () => {
        let pushes = 0;
        const { runArgvFn } = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => {
                throw gitError(2, '');
            },
            push: () => {
                pushes += 1;
                throw transient();
            },
        });
        const res = pushSessionCommits(BRANCH, { runArgvFn, logFn, sleepFn: () => {} });
        expect(res.kind).toBe('failed');
        expect(pushes).toBe(3);

        let nonFf = 0;
        const refused = fakeGit({
            revParse: () => LOCAL,
            lsRemote: () => {
                throw gitError(2, '');
            },
            push: () => {
                nonFf += 1;
                throw gitError(1, '! [rejected] (non-fast-forward)');
            },
        });
        const sleeps: number[] = [];
        const res2 = pushSessionCommits(BRANCH, {
            runArgvFn: refused.runArgvFn,
            logFn,
            sleepFn: (ms) => sleeps.push(ms),
        });
        expect(res2.kind).toBe('failed');
        expect(nonFf).toBe(1);
        expect(sleeps).toEqual([]);
    });
});

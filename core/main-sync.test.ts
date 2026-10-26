// Контракт подтяжки main в ветку фазы (#66): какие argv на каждой развилке и какое решение.
// Что последовательность действительно сливает, называет файлы и оставляет дерево чистым,
// доказывает настоящий git — `tests/main-sync-scenarios.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import { NETWORK_ATTEMPTS, syncPhaseBranchWithMain } from './main-sync.ts';

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const MERGED = 'c'.repeat(40);

type Handler = (args: string[]) => string;

function withStatus(status: number, stderr = ''): Error {
    return Object.assign(new Error(`Command failed: git (${String(status)})`), { status, stderr });
}

/** Фейковый git: по умолчанию ветка отстала, влитие чистое, локальный ref на голове. */
function fakeGit(over: Record<string, Handler> = {}) {
    const calls: string[][] = [];
    const base: Record<string, Handler> = {
        fetch: () => '',
        'rev-parse': (a) =>
            a.includes('origin/main^{commit}')
                ? MAIN
                : a.includes('HEAD^{commit}')
                  ? MERGED
                  : a.includes('refs/heads/feature/x')
                    ? HEAD
                    : '',
        'merge-base': () => {
            throw withStatus(1);
        },
        merge: () => '',
        diff: () => '',
        push: () => '',
        'update-ref': () => '',
    };
    const handlers = { ...base, ...over };
    const runArgvFn = vi.fn((file: string, args: string[]) => {
        expect(file).toBe('git');
        calls.push(args);
        const h = handlers[args[0]];
        if (!h) throw new Error(`неожиданная команда git ${args.join(' ')}`);
        return h(args);
    });
    return { runArgvFn, calls, logs: [] as string[] };
}

function sync(git: ReturnType<typeof fakeGit>, pauses: number[] = []) {
    return syncPhaseBranchWithMain('feature/x', HEAD, {
        runArgvFn: git.runArgvFn,
        logFn: (m) => git.logs.push(m),
        sleepFn: (ms) => pauses.push(ms),
    });
}

describe('syncPhaseBranchWithMain — ветка фазы против origin/main (#66)', () => {
    it('main уже предок головы → current, ничего не вливаем и не пушим', () => {
        const git = fakeGit({ 'merge-base': () => '' });
        expect(sync(git)).toEqual({ kind: 'current' });
        expect(git.calls.map((a) => a[0])).toEqual(['fetch', 'rev-parse', 'merge-base']);
        expect(git.calls[2]).toEqual(['merge-base', '--is-ancestor', MAIN, HEAD]);
    });

    it('отстала, влитие чистое → merge-коммит, пуш без --force в ветку фазы, ref следом', () => {
        const git = fakeGit();
        expect(sync(git)).toEqual({ kind: 'updated', head: MERGED, main: MAIN });
        const merge = git.calls.find((a) => a[0] === 'merge');
        expect(merge).toContain('--no-ff');
        expect(merge?.at(-1)).toBe(MAIN);
        const push = git.calls.find((a) => a[0] === 'push');
        expect(push).toEqual(['push', 'origin', `${MERGED}:refs/heads/feature/x`]);
        expect(push?.some((a) => a.startsWith('--force') || a.startsWith('+'))).toBe(false);
        // Старое значение ref — условие перевода: сдвинутый кем-то ref не затираем.
        expect(git.calls).toContainEqual(['update-ref', 'refs/heads/feature/x', MERGED, HEAD]);
        expect(git.logs.join('\n')).toContain('main влит');
    });

    it('сетевой git — с запретом промпта кредов', () => {
        const git = fakeGit();
        sync(git);
        for (const cmd of ['fetch', 'push']) {
            const call = git.runArgvFn.mock.calls.find((c) => c[1][0] === cmd) as unknown[];
            expect(call[2]).toMatchObject({ env: { GIT_TERMINAL_PROMPT: '0' } });
        }
    });

    it('локального ref нет → пуш есть, update-ref не зовём', () => {
        const git = fakeGit({
            'rev-parse': (a) => {
                if (a.includes('refs/heads/feature/x')) throw withStatus(1);
                return a.includes('HEAD^{commit}') ? MERGED : MAIN;
            },
        });
        expect(sync(git).kind).toBe('updated');
        expect(git.calls.some((a) => a[0] === 'update-ref')).toBe(false);
    });

    it('конфликт → файлы названы, влитие отменено, ничего не запушено', () => {
        const git = fakeGit({
            merge: (a) => {
                if (a[1] === '--abort') return '';
                throw withStatus(1, 'CONFLICT (content): Merge conflict in docs/core-journal.md');
            },
            diff: () => 'docs/core-journal.md\nCLAUDE.md\n',
        });
        expect(sync(git)).toEqual({
            kind: 'conflict',
            main: MAIN,
            files: ['docs/core-journal.md', 'CLAUDE.md'],
        });
        expect(git.calls).toContainEqual(['merge', '--abort']);
        expect(git.calls.some((a) => a[0] === 'push')).toBe(false);
    });

    it('конфликт, а --abort упал → failed с обоими фактами: дерево грязное', () => {
        const git = fakeGit({
            merge: (a) => {
                if (a[1] === '--abort') throw withStatus(128, 'fatal: abort failed');
                throw withStatus(1);
            },
            diff: () => 'a.txt',
        });
        const res = sync(git);
        expect(res.kind).toBe('failed');
        if (res.kind === 'failed') {
            expect(res.why).toContain('a.txt');
            expect(res.why).toContain('дерево раннера грязное');
        }
    });

    it('merge упал без конфликтующих файлов (нет identity) → failed с текстом git', () => {
        const git = fakeGit({
            merge: (a) => {
                if (a[1] === '--abort') return '';
                throw withStatus(128, 'fatal: unable to auto-detect email address');
            },
        });
        const res = sync(git);
        expect(res).toMatchObject({ kind: 'failed' });
        if (res.kind === 'failed') expect(res.why).toContain('auto-detect email');
    });

    it('merge-base упал НЕ кодом 1 → failed, вливать не лезем', () => {
        const git = fakeGit({
            'merge-base': () => {
                throw withStatus(128, 'fatal: not a valid object');
            },
        });
        expect(sync(git).kind).toBe('failed');
        expect(git.calls.some((a) => a[0] === 'merge')).toBe(false);
    });

    it('fetch упал → failed до любых сравнений', () => {
        const git = fakeGit({
            fetch: () => {
                throw withStatus(128, 'fatal: unable to access');
            },
        });
        const res = sync(git);
        expect(res).toMatchObject({ kind: 'failed' });
        expect(git.calls).toHaveLength(1);
    });

    it('пуш отвергнут (ветку допушили за время гейта) → failed, ref не двигаем', () => {
        const git = fakeGit({
            push: () => {
                throw withStatus(1, ' ! [rejected] (non-fast-forward)');
            },
        });
        const res = sync(git);
        expect(res.kind).toBe('failed');
        if (res.kind === 'failed') expect(res.why).toContain('rejected');
        expect(git.calls.some((a) => a[0] === 'update-ref')).toBe(false);
    });

    // Правило 4: транзиент сети переживают повтором, а не стопом «конфликт веток».
    it('fetch моргнул (хост не резолвится) → повтор с паузой и успех', () => {
        let n = 0;
        const git = fakeGit({
            fetch: () => {
                if (++n === 1) {
                    throw withStatus(
                        128,
                        "fatal: unable to access 'https://example.com/r.git/': \nCould not resolve host: example.com",
                    );
                }
                return '';
            },
        });
        const pauses: number[] = [];
        expect(sync(git, pauses).kind).toBe('updated');
        expect(pauses).toHaveLength(1);
        expect(git.logs.some((l) => l.includes('транзиентный сбой сети'))).toBe(true);
    });

    it('fetch лежит дольше попыток → failed с причиной со второй строки stderr', () => {
        const git = fakeGit({
            fetch: () => {
                throw withStatus(
                    128,
                    "fatal: unable to access '…': \nFailed to connect to example.com",
                );
            },
        });
        const pauses: number[] = [];
        const res = sync(git, pauses);
        expect(res.kind).toBe('failed');
        if (res.kind === 'failed') expect(res.why).toContain('Failed to connect');
        expect(git.calls.filter((a) => a[0] === 'fetch')).toHaveLength(NETWORK_ATTEMPTS);
        expect(pauses).toHaveLength(NETWORK_ATTEMPTS - 1);
    });

    it('пуш отвергнут non-ff → без повтора: повтор такой отказ не лечит', () => {
        const git = fakeGit({
            push: () => {
                throw withStatus(1, ' ! [rejected] (non-fast-forward)');
            },
        });
        const pauses: number[] = [];
        sync(git, pauses);
        expect(git.calls.filter((a) => a[0] === 'push')).toHaveLength(1);
        expect(pauses).toEqual([]);
    });

    it('пуш оборвался → повтор, затем updated', () => {
        let n = 0;
        const git = fakeGit({
            push: () => {
                if (++n === 1)
                    throw withStatus(
                        128,
                        'fatal: the remote end hung up: Connection reset by peer',
                    );
                return '';
            },
        });
        expect(sync(git).kind).toBe('updated');
        expect(git.calls.filter((a) => a[0] === 'push')).toHaveLength(2);
    });
});

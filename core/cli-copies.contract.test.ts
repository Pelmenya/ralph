import { describe, expect, it, vi } from 'vitest';
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    type Dirent,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneCanaryCopies, sweepCanaryTrash, type CanaryCopiesFs } from './cli-copies.ts';

type Call = [string, ...unknown[]];

function entry(name: string): Dirent {
    return { name, isDirectory: () => true } as unknown as Dirent;
}

function fakeFs(entries = ['1.0.0', '2.0.0', '3.0.0']) {
    const calls: Call[] = [];
    const fsi: CanaryCopiesFs = {
        lstat: vi.fn((target: string) => {
            calls.push(['lstat', target]);
            return { isDirectory: () => true };
        }),
        readdir: vi.fn((dir: string) => {
            calls.push(['readdir', dir]);
            return entries.map(entry);
        }),
        mkdir: vi.fn((dir: string) => {
            calls.push(['mkdir', dir]);
            return undefined;
        }),
        rename: vi.fn((from: string, to: string) => {
            calls.push(['rename', from, to]);
        }),
        rm: vi.fn((target: string, options: { recursive: true; force: true }) => {
            calls.push(['rm', target, options]);
        }),
    };
    return { calls, fsi };
}

function realFs(): CanaryCopiesFs {
    return {
        lstat: lstatSync,
        readdir: readdirSync,
        mkdir: mkdirSync,
        rename: renameSync,
        rm: rmSync,
    };
}

function prune(fsi: CanaryCopiesFs, logFn = vi.fn(), keep = new Set(['1.0.0'])) {
    return {
        logFn,
        run: () =>
            pruneCanaryCopies({
                root: '/state/cli-canary',
                harness: 'claude-code',
                keep,
                fsi,
                logFn,
                nowFn: () => 1000,
            }),
    };
}

function sweep(fsi: CanaryCopiesFs, logFn = vi.fn()) {
    return {
        logFn,
        run: () => sweepCanaryTrash({ root: '/state/cli-canary', fsi, logFn }),
    };
}

describe('очистка копий канарейки', () => {
    it('[F24-4] версии вне keep удаляются, закреплённая остаётся', () => {
        const { calls, fsi } = fakeFs();
        const operation = prune(fsi);
        expect(operation.run).not.toThrow();
        const removed = calls.filter(([op]) => op === 'rm').map(([, target]) => String(target));
        expect(removed.some((target) => target.includes('2.0.0'))).toBe(true);
        expect(removed.some((target) => target.includes('3.0.0'))).toBe(true);
        expect(removed.some((target) => target.includes('1.0.0'))).toBe(false);
    });

    it('[F24-4] rename в .trash строго раньше rm той же версии', () => {
        const { calls, fsi } = fakeFs(['2.0.0']);
        const operation = prune(fsi, vi.fn(), new Set(['1.0.0']));
        expect(operation.run).not.toThrow();
        const rename = calls.findIndex(
            ([op, from, to]) =>
                op === 'rename' &&
                String(from).includes('2.0.0') &&
                String(to).includes('/.trash/'),
        );
        const rm = calls.findIndex(
            ([op, target]) => op === 'rm' && String(target).includes('2.0.0'),
        );
        expect(rename).toBeGreaterThanOrEqual(0);
        expect(rm).toBeGreaterThan(rename);
    });

    it('[F24-4] оставленный каталог .trash убирает sweepCanaryTrash', () => {
        const { calls, fsi } = fakeFs(['interrupted']);
        const operation = sweep(fsi);
        expect(operation.run).not.toThrow();
        expect(calls).toContainEqual([
            'rm',
            expect.stringMatching(/\.trash.*interrupted/),
            { recursive: true, force: true },
        ]);
    });

    it.each(['prune', 'sweep'] as const)(
        '[F24-4] отсутствующий root у %s — без лога и исключения',
        (kind) => {
            const { fsi } = fakeFs();
            fsi.readdir = vi.fn(() => {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            });
            const operation = kind === 'prune' ? prune(fsi) : sweep(fsi);
            expect(operation.run).not.toThrow();
            expect(operation.logFn).not.toHaveBeenCalled();
        },
    );

    it.each(['prune', 'sweep'] as const)(
        '[F24-4] отсутствующий каталог на lstat у %s — без лога и исключения',
        (kind) => {
            const { fsi } = fakeFs();
            fsi.lstat = vi.fn(() => {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            });
            const operation = kind === 'prune' ? prune(fsi) : sweep(fsi);
            expect(operation.run).not.toThrow();
            expect(operation.logFn).not.toHaveBeenCalled();
        },
    );

    it.each(['prune', 'sweep'] as const)(
        '[F24-4] ошибка lstat у %s логируется без исключения',
        (kind) => {
            const { fsi } = fakeFs();
            fsi.lstat = vi.fn(() => {
                throw new Error('stat refused');
            });
            const operation = kind === 'prune' ? prune(fsi) : sweep(fsi);
            expect(operation.run).not.toThrow();
            expect(operation.logFn).toHaveBeenCalledWith(expect.stringContaining('stat refused'));
        },
    );

    it('[F24-4] ошибка rename одной версии логируется, остальные обрабатываются', () => {
        const { calls, fsi } = fakeFs();
        fsi.rename = vi.fn((from: string, to: string) => {
            calls.push(['rename', from, to]);
            if (from.includes('2.0.0')) throw new Error('rename refused');
        });
        const operation = prune(fsi);
        expect(operation.run).not.toThrow();
        expect(operation.logFn).toHaveBeenCalledWith(expect.stringContaining('rename refused'));
        expect(calls.some(([op, from]) => op === 'rename' && String(from).includes('3.0.0'))).toBe(
            true,
        );
    });

    it('[F24-4] ошибка rm одной версии логируется, остальные обрабатываются', () => {
        const { calls, fsi } = fakeFs();
        fsi.rm = vi.fn((target: string) => {
            calls.push(['rm', target]);
            if (target.includes('2.0.0')) throw new Error('rm refused');
        });
        const operation = prune(fsi);
        expect(operation.run).not.toThrow();
        expect(operation.logFn).toHaveBeenCalledWith(expect.stringContaining('rm refused'));
        expect(calls.some(([op, target]) => op === 'rm' && String(target).includes('3.0.0'))).toBe(
            true,
        );
    });

    it.each(['prune', 'sweep'] as const)(
        '[F24-4] ошибка readdir у %s логируется без исключения',
        (kind) => {
            const { fsi } = fakeFs();
            fsi.readdir = vi.fn(() => {
                throw new Error('read refused');
            });
            const operation = kind === 'prune' ? prune(fsi) : sweep(fsi);
            expect(operation.run).not.toThrow();
            expect(operation.logFn).toHaveBeenCalledWith(expect.stringContaining('read refused'));
        },
    );

    it('[F24-4] относительный root отвергнут до первого вызова fsi', () => {
        const { fsi } = fakeFs();
        const logFn = vi.fn();
        expect(() =>
            pruneCanaryCopies({
                root: 'state/cli-canary',
                harness: 'claude-code',
                keep: new Set(['1.0.0']),
                fsi,
                logFn,
                nowFn: () => 1000,
            }),
        ).not.toThrow();
        expect(logFn).toHaveBeenCalledTimes(1);
        for (const fn of Object.values(fsi)) expect(fn).not.toHaveBeenCalled();
    });

    it.each(['', '.', '..', '.trash', 'claude/code'])(
        '[F24-4] небезопасный harness $0 отвергнут до первого вызова fsi',
        (harness) => {
            const { fsi } = fakeFs();
            const logFn = vi.fn();
            expect(() =>
                pruneCanaryCopies({
                    root: '/state/cli-canary',
                    harness,
                    keep: new Set(['1.0.0']),
                    fsi,
                    logFn,
                    nowFn: () => 1000,
                }),
            ).not.toThrow();
            expect(logFn).toHaveBeenCalledTimes(1);
            for (const fn of Object.values(fsi)) expect(fn).not.toHaveBeenCalled();
        },
    );

    it('[F24-4] пустой keep отвергнут до первого вызова fsi', () => {
        const { fsi } = fakeFs();
        const operation = prune(fsi, vi.fn(), new Set());
        expect(operation.run).not.toThrow();
        expect(operation.logFn).toHaveBeenCalledTimes(1);
        for (const fn of Object.values(fsi)) expect(fn).not.toHaveBeenCalled();
    });

    it('[F24-4] время имени trash по умолчанию берётся от системных часов', () => {
        const { fsi } = fakeFs(['2.0.0']);
        expect(() =>
            pruneCanaryCopies({
                root: '/state/cli-canary',
                harness: 'claude-code',
                keep: new Set(['1.0.0']),
                fsi,
                logFn: vi.fn(),
            }),
        ).not.toThrow();
        expect(fsi.rename).toHaveBeenCalledWith(
            '/state/cli-canary/claude-code/2.0.0',
            expect.stringMatching(/claude-code-2\.0\.0-\d+$/),
        );
    });

    it('[F24-4] относительный root у sweep отвергнут до первого вызова fsi', () => {
        const { fsi } = fakeFs();
        const logFn = vi.fn();
        expect(() => sweepCanaryTrash({ root: 'state/cli-canary', fsi, logFn })).not.toThrow();
        expect(logFn).toHaveBeenCalledTimes(1);
        for (const fn of Object.values(fsi)) expect(fn).not.toHaveBeenCalled();
    });

    it('[F24-4] ошибка rm мусора логируется, остальные записи обрабатываются', () => {
        const { calls, fsi } = fakeFs(['interrupted', 'other']);
        fsi.rm = vi.fn((target: string, options: { recursive: true; force: true }) => {
            calls.push(['rm', target, options]);
            if (target.includes('interrupted')) throw new Error('rm refused');
        });
        const operation = sweep(fsi);
        expect(operation.run).not.toThrow();
        expect(operation.logFn).toHaveBeenCalledWith(expect.stringContaining('rm refused'));
        expect(calls.some(([op, target]) => op === 'rm' && String(target).includes('other'))).toBe(
            true,
        );
    });

    it('[F24-4] ошибка удаления самого .trash логируется без исключения', () => {
        const { calls, fsi } = fakeFs(['interrupted']);
        fsi.rm = vi.fn((target: string, options: { recursive: true; force: true }) => {
            if (target === '/state/cli-canary/.trash') throw new Error('root refused');
            calls.push(['rm', target, options]);
        });
        const operation = sweep(fsi);
        expect(operation.run).not.toThrow();
        expect(operation.logFn).toHaveBeenCalledWith(expect.stringContaining('root refused'));
    });

    it('[F24-4] симлинк .trash не даёт sweepCanaryTrash удалить внешний файл', () => {
        const base = mkdtempSync(path.join(tmpdir(), 'canary-trash-link-'));
        const root = path.join(base, 'canary');
        const outside = path.join(base, 'outside');
        const externalFile = path.join(outside, 'entry');
        mkdirSync(root, { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(externalFile, 'keep');
        symlinkSync(outside, path.join(root, '.trash'), 'dir');
        try {
            const logFn = vi.fn();
            expect(() => sweepCanaryTrash({ root, fsi: realFs(), logFn })).not.toThrow();
            expect(readFileSync(externalFile, 'utf8')).toBe('keep');
            expect(logFn).toHaveBeenCalledWith(expect.stringContaining('симлинк'));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    it('[F24-4] симлинк .trash не даёт pruneCanaryCopies перенести версию наружу', () => {
        const base = mkdtempSync(path.join(tmpdir(), 'canary-prune-trash-link-'));
        const root = path.join(base, 'canary');
        const outside = path.join(base, 'outside');
        const localFile = path.join(root, 'claude-code', '2.0.0', 'entry');
        const externalFile = path.join(outside, 'entry');
        mkdirSync(path.dirname(localFile), { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(localFile, 'local');
        writeFileSync(externalFile, 'external');
        symlinkSync(outside, path.join(root, '.trash'), 'dir');
        try {
            const logFn = vi.fn();
            expect(() =>
                pruneCanaryCopies({
                    root,
                    harness: 'claude-code',
                    keep: new Set(['1.0.0']),
                    fsi: realFs(),
                    logFn,
                    nowFn: () => 1000,
                }),
            ).not.toThrow();
            expect(readFileSync(localFile, 'utf8')).toBe('local');
            expect(readFileSync(externalFile, 'utf8')).toBe('external');
            expect(logFn).toHaveBeenCalledWith(expect.stringContaining('симлинк'));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    it('[F24-4] симлинк harness не даёт pruneCanaryCopies удалить внешний файл', () => {
        const base = mkdtempSync(path.join(tmpdir(), 'canary-harness-link-'));
        const root = path.join(base, 'canary');
        const outside = path.join(base, 'outside');
        const externalFile = path.join(outside, '2.0.0', 'entry');
        mkdirSync(root, { recursive: true });
        mkdirSync(path.dirname(externalFile), { recursive: true });
        writeFileSync(externalFile, 'keep');
        symlinkSync(outside, path.join(root, 'claude-code'), 'dir');
        try {
            const logFn = vi.fn();
            expect(() =>
                pruneCanaryCopies({
                    root,
                    harness: 'claude-code',
                    keep: new Set(['1.0.0']),
                    fsi: realFs(),
                    logFn,
                    nowFn: () => 1000,
                }),
            ).not.toThrow();
            expect(readFileSync(externalFile, 'utf8')).toBe('keep');
            expect(logFn).toHaveBeenCalledWith(expect.stringContaining('симлинк'));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

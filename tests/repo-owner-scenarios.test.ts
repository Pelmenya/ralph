// Владение репозиторием в точке входа (канон, задача 76): политика — в core/repo-owner.ts
// и его юнит-тестах, здесь — что main() действительно её зовёт, в правильном месте
// и с правильными исходами. main() в сьюте не исполняется (process.exit, реальный git/fs),
// поэтому порядок закреплён по исходнику, как порядок «лок — первый шаг» в lock-scenarios.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в lock-scenarios).
import ralph from '../ralph.js';

const { acquireRepoOwner } = ralph;

describe('acquireRepoOwner — точка входа владения', () => {
    it('dry не читает origin и ничего не берёт (C1: --dry-run строго read-only)', () => {
        let read = false;
        const r = acquireRepoOwner({
            dry: true,
            lockPath: '/x/ralph.lock',
            readOriginFn: () => {
                read = true;
                return 'https://example.com/acme/app';
            },
        });
        expect(r).toBeNull();
        expect(read).toBe(false);
    });

    it('origin не читается → стоп с названной причиной, владение не берётся', () => {
        const fails: string[] = [];
        let acquired = false;
        const r = acquireRepoOwner({
            dry: false,
            repoDir: '/srv/clone',
            lockPath: '/x/ralph.lock',
            readOriginFn: () => {
                throw new Error("No such remote 'origin'");
            },
            acquireFn: () => {
                acquired = true;
                return true;
            },
            failFn: (s: string) => fails.push(s),
        });
        expect(r).toBeNull();
        expect(acquired).toBe(false);
        expect(fails[0]).toMatch(/в \/srv\/clone не взять/);
        expect(fails[0]).toMatch(/No such remote/);
    });

    it('каноническая идентичность из origin и лок дерева уходят в политику владения', () => {
        const calls: Array<{ repoId: string; lockPath: string; dir: string }> = [];
        const r = acquireRepoOwner({
            dry: false,
            lockPath: '/x/ralph.lock',
            readOriginFn: () => 'git@Example.com:acme/app.git\n',
            acquireFn: (args: { repoId: string; lockPath: string; dir: string }) => {
                calls.push(args);
                return true;
            },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].repoId).toBe('example.com/acme/app');
        expect(calls[0].lockPath).toBe('/x/ralph.lock');
        expect(r).toEqual({ dir: calls[0].dir, repoId: 'example.com/acme/app' });
    });

    it('относительный RALPH_OWNERS_DIR → стоп до взятия: реестр у каждого клона был бы свой', () => {
        const prev = process.env.RALPH_OWNERS_DIR;
        process.env.RALPH_OWNERS_DIR = '.ralph-owners';
        try {
            const fails: string[] = [];
            let acquired = false;
            const r = acquireRepoOwner({
                dry: false,
                lockPath: '/x/ralph.lock',
                readOriginFn: () => 'https://example.com/acme/app',
                acquireFn: () => (acquired = true),
                failFn: (s: string) => fails.push(s),
            });
            expect(r).toBeNull();
            expect(acquired).toBe(false);
            expect(fails[0]).toMatch(/не абсолютный/);
        } finally {
            if (prev === undefined) delete process.env.RALPH_OWNERS_DIR;
            else process.env.RALPH_OWNERS_DIR = prev;
        }
    });

    it('отказ политики (живой владелец) → null: main() обязан выйти, а не продолжить', () => {
        const r = acquireRepoOwner({
            dry: false,
            lockPath: '/x/ralph.lock',
            readOriginFn: () => 'https://example.com/acme/app',
            acquireFn: () => false,
        });
        expect(r).toBeNull();
    });
});

describe('main(): владение берётся сразу за локом и до побочек (канон, задача 76)', () => {
    // `__dirname`, не `import.meta` — тот же довод, что в lock-scenarios (#406).
    const src = fs.readFileSync(resolve(__dirname, '../core/orchestrator.ts'), 'utf-8');
    const body = src.slice(src.indexOf('function main()'));
    const at = (re: RegExp): number => re.exec(body)?.index ?? -1;

    it('лок → владение → миграция и worktree; отказ владения обрывает main()', () => {
        const lockIdx = at(/^\s*if \(.*acquireRunnerLock\(\).*return;/m);
        const ownerIdx = at(/^\s*const owned = acquireRepoOwner\(/m);
        const bailIdx = at(/^\s*if \(!owned\) return;/m);
        const releaseIdx = at(
            /^\s*process\.on\('exit', \(\) => releaseRepoOwnershipIfOurs\(owned\)\)/m,
        );
        const migrateIdx = at(/^\s*const rolled = rollbackRuntime\(/m);
        const worktreeIdx = at(/^\s*ensureRunnerWorktree\(worktreePath\)/m);

        for (const [name, idx] of [
            ['acquireRunnerLock', lockIdx],
            ['acquireRepoOwner', ownerIdx],
            ['if (!owned) return', bailIdx],
            ['снятие владения на exit', releaseIdx],
            ['rollbackRuntime', migrateIdx],
            ['ensureRunnerWorktree', worktreeIdx],
        ] as const) {
            expect(idx, `не нашёл в main(): ${name}`).toBeGreaterThan(-1);
        }
        expect(ownerIdx).toBeGreaterThan(lockIdx);
        expect(bailIdx).toBeGreaterThan(ownerIdx);
        expect(releaseIdx).toBeGreaterThan(bailIdx);
        expect(migrateIdx).toBeGreaterThan(releaseIdx);
        expect(worktreeIdx).toBeGreaterThan(releaseIdx);
    });
});

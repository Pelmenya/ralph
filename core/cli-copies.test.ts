import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HarnessRegistry } from '../adapters/harness-registry.ts';
import {
    formatCliCopyFailure,
    prepareCliCopies,
    pruneCanaryCopies,
    sweepCanaryTrash,
    type CanaryCopiesFs,
} from './cli-copies.ts';

const registry = {
    packages: new Map([
        [
            'claude-code',
            {
                descriptor: { cliVersion: '2.1.312' },
                pkg: {
                    distribution: {
                        registry: 'npm',
                        package: '@anthropic-ai/claude-code',
                        bin: 'bin/claude.exe',
                    },
                },
            },
        ],
        [
            'codex',
            {
                descriptor: { cliVersion: '0.163.0' },
                pkg: {
                    distribution: {
                        registry: 'npm',
                        package: '@openai/codex',
                        bin: 'bin/codex.js',
                    },
                },
            },
        ],
    ]),
    problems: new Map(),
} as unknown as HarnessRegistry;

describe('prepareCliCopies — копии всех рантаймов до первой сессии', () => {
    it('ставит копию харнесса каждого достижимого рантайма, общий харнесс — один раз', () => {
        const installFn = vi.fn(() => ({ ok: true as const, bin: '/state/cli/bin' }));
        const result = prepareCliCopies({
            providers: new Set(['claude', 'openai', 'kimi']),
            root: '/state/cli',
            registry,
            installFn,
        });
        expect(result.ok).toBe(true);
        expect(installFn).toHaveBeenCalledTimes(2);
        expect(installFn).toHaveBeenNthCalledWith(1, {
            harness: 'claude-code',
            version: '2.1.312',
            distribution: registry.packages.get('claude-code')?.pkg.distribution,
            root: '/state/cli',
        });
        expect(installFn).toHaveBeenNthCalledWith(2, {
            harness: 'codex',
            version: '0.163.0',
            distribution: registry.packages.get('codex')?.pkg.distribution,
            root: '/state/cli',
        });
    });

    it('отказ копии останавливает подготовку с харнессом, версией, кодом и текстом', () => {
        const failure = {
            ok: false as const,
            code: 'manifest-mismatch' as const,
            harness: 'claude-code',
            version: '2.1.312',
            reason: 'package.json: changed',
        };
        const installFn = vi.fn(() => failure);
        const result = prepareCliCopies({
            providers: new Set(['claude', 'openai']),
            root: '/state/cli',
            registry,
            installFn,
        });
        expect(result).toEqual(failure);
        expect(installFn).toHaveBeenCalledTimes(1);
        expect(formatCliCopyFailure(failure)).toBe(
            'CLI claude-code@2.1.312 (manifest-mismatch): package.json: changed',
        );
    });

    it('непринятый пакет — отказ до установки и без обращения к PATH', () => {
        const installFn = vi.fn(() => ({ ok: true as const, bin: '/unused' }));
        const result = prepareCliCopies({
            providers: new Set(['claude']),
            root: '/state/cli',
            registry: { packages: new Map(), problems: new Map() },
            installFn,
        });
        expect(result).toMatchObject({
            ok: false,
            code: 'install-failed',
            harness: 'claude-code',
            reason: expect.stringContaining('пакета харнесса'),
        });
        expect(installFn).not.toHaveBeenCalled();
    });

    it('read-only передаёт установщику запрет установки', () => {
        const installFn = vi.fn(() => ({ ok: true as const, bin: '/state/cli/bin' }));
        prepareCliCopies({
            providers: new Set(['claude']),
            root: '/state/cli',
            readOnly: true,
            registry,
            installFn,
        });
        expect(installFn).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    });

    it('проводка main(): копии проверяются до готовности и первой сессии', () => {
        const source = fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf8');
        const main = source.slice(source.indexOf('function main('));
        const copies = main.indexOf('checkCliCopies(config)');
        const pathProbe = main.indexOf('checkCoderRuntimes(config)');
        const firstLoop = main.indexOf('runLoop(config, ctx');
        expect(copies).toBeGreaterThan(-1);
        expect(pathProbe).toBeGreaterThan(copies);
        expect(firstLoop).toBeGreaterThan(pathProbe);
        expect(main.slice(copies - 40, copies)).not.toMatch(/!DRY/);
    });
});

describe('очистка копий канарейки', () => {
    it('симлинк canaryRoot не даёт обеим функциям удалить внешние файлы', () => {
        const base = fs.mkdtempSync(path.join(tmpdir(), 'canary-root-link-'));
        const root = path.join(base, 'canary');
        const outside = path.join(base, 'outside');
        const versionFile = path.join(outside, 'claude-code', '2.0.0', 'entry');
        const trashFile = path.join(outside, '.trash', 'entry');
        fs.mkdirSync(path.dirname(versionFile), { recursive: true });
        fs.mkdirSync(path.dirname(trashFile), { recursive: true });
        fs.writeFileSync(versionFile, 'version');
        fs.writeFileSync(trashFile, 'trash');
        fs.symlinkSync(outside, root, 'dir');
        const fsi: CanaryCopiesFs = {
            lstat: fs.lstatSync,
            readdir: fs.readdirSync,
            mkdir: fs.mkdirSync,
            rename: fs.renameSync,
            rm: fs.rmSync,
        };
        const logFn = vi.fn();
        try {
            expect(() => {
                pruneCanaryCopies({
                    root,
                    harness: 'claude-code',
                    keep: new Set(['1.0.0']),
                    fsi,
                    logFn,
                    nowFn: () => 1000,
                });
                sweepCanaryTrash({ root, fsi, logFn });
            }).not.toThrow();
            expect(fs.readFileSync(versionFile, 'utf8')).toBe('version');
            expect(fs.readFileSync(trashFile, 'utf8')).toBe('trash');
            expect(logFn).toHaveBeenCalledTimes(2);
            for (const [line] of logFn.mock.calls) expect(line).toContain('симлинк');
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    function childLstatFailure(error: Error): CanaryCopiesFs {
        let lstatCalls = 0;
        return {
            lstat: vi.fn(() => {
                lstatCalls++;
                if (lstatCalls % 2 === 0) throw error;
                return { isDirectory: () => true };
            }),
            readdir: vi.fn(() => []),
            mkdir: vi.fn(() => undefined),
            rename: vi.fn(),
            rm: vi.fn(),
        };
    }

    it.each([
        ['отсутствует', Object.assign(new Error('missing'), { code: 'ENOENT' })],
        ['не читается', new Error('stat refused')],
    ])('дочерний каталог %s после исправного root', (_case, error) => {
        const fsi = childLstatFailure(error);
        const logFn = vi.fn();
        expect(() => {
            pruneCanaryCopies({
                root: '/state/cli-canary',
                harness: 'claude-code',
                keep: new Set(['1.0.0']),
                fsi,
                logFn,
            });
            sweepCanaryTrash({ root: '/state/cli-canary', fsi, logFn });
        }).not.toThrow();
        expect(fsi.readdir).not.toHaveBeenCalled();
        if ('code' in error) {
            expect(logFn).not.toHaveBeenCalled();
        } else {
            expect(logFn).toHaveBeenCalledTimes(2);
            expect(logFn).toHaveBeenCalledWith(expect.stringContaining('stat refused'));
        }
    });
});

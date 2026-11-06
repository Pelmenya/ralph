import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    defaultCliInstallExec,
    installCliCopy,
    realCliInstallFs,
    type CliInstallFs,
} from './cli-install.ts';
import { buildManifest, formatManifest, INSTALL_MANIFEST } from '../core/core-install.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

const distribution = {
    registry: 'npm' as const,
    package: '@example/cli',
    bin: 'node_modules/@example/cli/bin/cli.exe',
};
const input = { harness: 'example', version: '1.2.3', distribution };
const fsi: CliInstallFs = {
    exists: existsSync,
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    mkdtemp: (prefix) => mkdtempSync(prefix),
    readFile: readFileSync,
    writeFile: (p, text) => writeFileSync(p, text, { flag: 'wx' }),
    rename: renameSync,
    rm: (p) => rmSync(p, { recursive: true, force: true }),
};
const dirs: string[] = [];
function root(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-install-'));
    dirs.push(dir);
    return dir;
}
function installExec(calls: string[][] = []) {
    return (file: string, args: string[]) => {
        calls.push([file, ...args]);
        const prefix = args[args.indexOf('--prefix') + 1];
        if (!prefix) throw new Error('нет префикса');
        const bin = path.join(prefix, distribution.bin);
        mkdirSync(path.dirname(bin), { recursive: true });
        writeFileSync(bin, 'cli');
        writeFileSync(path.join(prefix, 'package.json'), '{}\n');
        return '';
    };
}
function target(dir: string): string {
    return path.join(dir, input.harness, input.version);
}
function seed(dir: string): void {
    const result = installCliCopy({ ...input, root: dir, execFn: installExec(), fsi });
    if (!result.ok) throw new Error(result.reason);
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('installCliCopy — собственная копия CLI точной версии', () => {
    it('ставит без скриптов во временный каталог, пишет манифест и возвращает абсолютный bin', () => {
        const dir = root();
        const calls: string[][] = [];
        const result = installCliCopy({ ...input, root: dir, execFn: installExec(calls), fsi });
        expect(result).toEqual({ ok: true, bin: path.join(target(dir), distribution.bin) });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.slice(0, 4)).toEqual([
            'npm',
            'install',
            '@example/cli@1.2.3',
            '--ignore-scripts',
        ]);
        expect(calls[0]).toContain('--prefix');
        expect(existsSync(path.join(target(dir), INSTALL_MANIFEST))).toBe(true);
        expect(calls[0]?.[calls[0].length - 1]).not.toBe(target(dir));
    });

    it('срок канарейки доходит до команды установки', () => {
        const execFn = vi.fn((file: string, args: string[], _options?: { timeoutMs?: number }) =>
            installExec()(file, args),
        );
        const result = installCliCopy({
            ...input,
            root: root(),
            timeoutMs: 4_567,
            execFn,
            fsi,
        });
        expect(result.ok).toBe(true);
        expect(execFn).toHaveBeenCalledWith('npm', expect.any(Array), { timeoutMs: 4_567 });
    });

    it('готовая копия только сверяется: установки повторно нет', () => {
        const dir = root();
        seed(dir);
        const execFn = vi.fn(installExec());
        const result = installCliCopy({ ...input, root: dir, execFn, fsi });
        expect(result.ok).toBe(true);
        expect(execFn).not.toHaveBeenCalled();
    });

    it('отказ установки типизирован, полукопии нет, повтор ставит заново', () => {
        const dir = root();
        const failed = installCliCopy({
            ...input,
            root: dir,
            execFn: () => {
                throw new Error('registry unavailable');
            },
            fsi,
        });
        expect(failed).toMatchObject({
            ok: false,
            code: 'install-failed',
            harness: 'example',
            version: '1.2.3',
            reason: expect.stringContaining('registry unavailable'),
        });
        expect(existsSync(target(dir))).toBe(false);
        expect(installCliCopy({ ...input, root: dir, execFn: installExec(), fsi }).ok).toBe(true);
    });

    it('обрыв перед атомарным переносом не оставляет копию без манифеста', () => {
        const dir = root();
        const flaky: CliInstallFs = {
            ...fsi,
            rename: () => {
                throw new Error('interrupted');
            },
        };
        const failed = installCliCopy({ ...input, root: dir, execFn: installExec(), fsi: flaky });
        expect(failed).toMatchObject({ ok: false, code: 'install-failed' });
        expect(existsSync(target(dir))).toBe(false);
        expect(installCliCopy({ ...input, root: dir, execFn: installExec(), fsi }).ok).toBe(true);
    });

    it('соседняя установка успела первой: её полная копия сверяется вместо отказа', () => {
        const dir = root();
        const competing: CliInstallFs = {
            ...fsi,
            rename: () => {
                const copy = target(dir);
                const bin = path.join(copy, distribution.bin);
                mkdirSync(path.dirname(bin), { recursive: true });
                writeFileSync(bin, 'cli');
                writeFileSync(path.join(copy, 'package.json'), '{}\n');
                writeFileSync(
                    path.join(copy, INSTALL_MANIFEST),
                    formatManifest(buildManifest(copy)),
                );
                throw new Error('EEXIST');
            },
        };
        const result = installCliCopy({
            ...input,
            root: dir,
            execFn: installExec(),
            fsi: competing,
        });
        expect(result).toEqual({ ok: true, bin: path.join(target(dir), distribution.bin) });
    });

    it.each([
        ['manifest-missing', (dir: string) => rmSync(path.join(target(dir), INSTALL_MANIFEST))],
        [
            'manifest-mismatch',
            (dir: string) => writeFileSync(path.join(target(dir), 'package.json'), 'changed'),
        ],
        ['manifest-mismatch', (dir: string) => rmSync(path.join(target(dir), 'package.json'))],
        [
            'manifest-mismatch',
            (dir: string) => writeFileSync(path.join(target(dir), 'extra'), 'extra'),
        ],
        ['bin-missing', (dir: string) => rmSync(path.join(target(dir), distribution.bin))],
    ])('готовая копия повреждена: %s, без переустановки', (code, damage) => {
        const dir = root();
        seed(dir);
        damage(dir);
        const execFn = vi.fn(installExec());
        const result = installCliCopy({ ...input, root: dir, execFn, fsi });
        expect(result).toMatchObject({ ok: false, code, harness: 'example', version: '1.2.3' });
        expect(execFn).not.toHaveBeenCalled();
    });

    it('изменённый вид файла — тоже manifest-mismatch', () => {
        const dir = root();
        seed(dir);
        chmodSync(path.join(target(dir), 'package.json'), 0o755);
        const result = installCliCopy({ ...input, root: dir, execFn: installExec(), fsi });
        expect(result).toMatchObject({ ok: false, code: 'manifest-mismatch' });
    });

    it('read-only проверяет существующую копию, но не устанавливает отсутствующую', () => {
        const dir = root();
        const execFn = vi.fn(installExec());
        const missing = installCliCopy({ ...input, root: dir, readOnly: true, execFn, fsi });
        expect(missing).toMatchObject({ ok: false, code: 'install-failed' });
        expect(execFn).not.toHaveBeenCalled();
        seed(dir);
        expect(installCliCopy({ ...input, root: dir, readOnly: true, execFn, fsi }).ok).toBe(true);
        expect(execFn).not.toHaveBeenCalled();
    });

    it('свежая установка без объявленного bin отвергается и убирается', () => {
        const dir = root();
        const result = installCliCopy({ ...input, root: dir, execFn: () => '', fsi });
        expect(result).toMatchObject({ ok: false, code: 'bin-missing' });
        expect(existsSync(target(dir))).toBe(false);
    });

    it.each([
        ['relative', 'example', '1.2.3'],
        ['/state/cli', '../example', '1.2.3'],
        ['/state/cli', 'example', '../1.2.3'],
    ])('небезопасный адрес копии — install-failed: %s', (rootDir, harness, version) => {
        const result = installCliCopy({
            ...input,
            root: rootDir,
            harness,
            version,
            execFn: installExec(),
            fsi,
        });
        expect(result).toMatchObject({ ok: false, code: 'install-failed' });
    });

    it('bin за пределами копии — install-failed', () => {
        const result = installCliCopy({
            ...input,
            root: root(),
            distribution: { ...distribution, bin: '../outside' },
            execFn: installExec(),
            fsi,
        });
        expect(result).toMatchObject({ ok: false, code: 'install-failed' });
    });

    it('битый манифест — mismatch, а не исключение', () => {
        const dir = root();
        seed(dir);
        writeFileSync(path.join(target(dir), INSTALL_MANIFEST), 'not a manifest');
        const result = installCliCopy({ ...input, root: dir, execFn: installExec(), fsi });
        expect(result).toMatchObject({ ok: false, code: 'manifest-mismatch' });
    });

    it('боевые побочки закрыты общим предохранителем', () => {
        try {
            expect(() => defaultCliInstallExec('npm', ['--version'])).toThrow(/побочка/);
            expect(() => realCliInstallFs.mkdtemp(path.join(tmpdir(), 'copy-'))).toThrow(/побочка/);
            expect(sideEffectAttempts).toHaveLength(2);
        } finally {
            sideEffectAttempts.splice(0);
        }
    });
});

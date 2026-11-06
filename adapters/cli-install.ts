// Собственная копия CLI закреплённой версии (#260, Фаза 24).
//
// Системный бинарь могла сменить любая установка на хосте, а описание пакета остаётся снимком
// другой версии. Копия ставится без lifecycle-скриптов во временный каталог на той же ФС,
// получает манифест каждого файла и лишь затем атомарно занимает своё место. Повреждённая копия
// не переустанавливается молча: это отказ старта, а не шанс скрыть изменение защищаемого дерева.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
    buildManifest,
    INSTALL_MANIFEST,
    parseManifest,
    realInstallFs,
    type TManifestEntry,
} from '../core/core-install.ts';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import type { HarnessDistribution } from './harness-package.ts';

export type CliInstallCode =
    'install-failed' | 'manifest-missing' | 'manifest-mismatch' | 'bin-missing';

export type CliInstallResult =
    | { ok: true; bin: string }
    | {
          ok: false;
          code: CliInstallCode;
          harness: string;
          version: string;
          reason: string;
      };

export type CliInstallFs = {
    exists: (p: string) => boolean;
    mkdir: (dir: string) => void;
    mkdtemp: (prefix: string) => string;
    readFile: (p: string) => Buffer;
    writeFile: (p: string, text: string) => void;
    rename: (from: string, to: string) => void;
    rm: (p: string) => void;
};

export type CliInstallExec = (
    file: string,
    args: string[],
    options?: { timeoutMs?: number },
) => string;

const HINT = 'Подмени fsi и execFn установки CLI в тесте.';
const guarded = (what: string) => guardSideEffect(what, HINT);

export const realCliInstallFs: CliInstallFs = {
    exists: existsSync,
    mkdir: realInstallFs.mkdir,
    mkdtemp: (prefix) => {
        guarded(`mkdtemp(${prefix})`);
        return mkdtempSync(prefix);
    },
    readFile: readFileSync,
    writeFile: realInstallFs.writeFile,
    rename: realInstallFs.rename,
    rm: realInstallFs.rm,
};

export const defaultCliInstallExec: CliInstallExec = (file, args, options) => {
    guarded(`shArgv(${file} ${args.join(' ')})`);
    return execFileSync(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        timeout: options?.timeoutMs,
    });
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function failure(
    code: CliInstallCode,
    harness: string,
    version: string,
    reason: string,
): CliInstallResult {
    return { ok: false, code, harness, version, reason };
}

function manifestDiff(expected: readonly TManifestEntry[], actual: readonly TManifestEntry[]) {
    const want = new Map(expected.map((entry) => [entry.path, entry]));
    const have = new Map(actual.map((entry) => [entry.path, entry]));
    const diffs: string[] = [];
    for (const entry of expected) {
        const found = have.get(entry.path);
        if (!found) diffs.push(`${entry.path}: файла нет`);
        else if (found.sha256 !== entry.sha256) diffs.push(`${entry.path}: содержимое изменено`);
        else if (found.kind !== entry.kind) diffs.push(`${entry.path}: вид файла изменён`);
    }
    for (const entry of actual) {
        if (!want.has(entry.path)) diffs.push(`${entry.path}: лишний файл`);
    }
    return diffs;
}

function verifyCopy(
    target: string,
    distribution: HarnessDistribution,
    harness: string,
    version: string,
    fsi: CliInstallFs,
): CliInstallResult {
    const bin = path.resolve(target, distribution.bin);
    if (!fsi.exists(bin)) {
        return failure('bin-missing', harness, version, `исполняемого файла ${bin} нет`);
    }
    let text: Buffer;
    try {
        text = fsi.readFile(path.join(target, INSTALL_MANIFEST));
    } catch (error) {
        return failure(
            'manifest-missing',
            harness,
            version,
            `манифест ${path.join(target, INSTALL_MANIFEST)} не читается: ${message(error)}`,
        );
    }
    try {
        const diffs = manifestDiff(parseManifest(text.toString('utf8')), buildManifest(target));
        if (diffs.length > 0) {
            return failure(
                'manifest-mismatch',
                harness,
                version,
                `копия ${target} разошлась с манифестом: ${diffs.join('; ')}`,
            );
        }
    } catch (error) {
        return failure(
            'manifest-mismatch',
            harness,
            version,
            `копия ${target} не сверяется с манифестом: ${message(error)}`,
        );
    }
    return { ok: true, bin };
}

function safeSegment(value: string): boolean {
    return value !== '' && value !== '.' && value !== '..' && !/[\\/]/.test(value);
}

export function installCliCopy({
    harness,
    version,
    distribution,
    root,
    timeoutMs,
    readOnly = false,
    execFn = defaultCliInstallExec,
    fsi = realCliInstallFs,
}: {
    harness: string;
    version: string;
    distribution: HarnessDistribution;
    root: string;
    timeoutMs?: number;
    readOnly?: boolean;
    execFn?: CliInstallExec;
    fsi?: CliInstallFs;
}): CliInstallResult {
    if (!path.isAbsolute(root) || !safeSegment(harness) || !safeSegment(version)) {
        return failure(
            'install-failed',
            harness,
            version,
            `небезопасный адрес копии: корень ${root}, харнесс ${harness}, версия ${version}`,
        );
    }
    const target = path.join(root, harness, version);
    const bin = path.resolve(target, distribution.bin);
    const relativeBin = path.relative(target, bin);
    if (relativeBin === '' || relativeBin.startsWith('..') || path.isAbsolute(relativeBin)) {
        return failure(
            'install-failed',
            harness,
            version,
            `bin ${distribution.bin} уходит за пределы копии ${target}`,
        );
    }
    if (fsi.exists(target)) return verifyCopy(target, distribution, harness, version, fsi);
    if (readOnly) {
        return failure(
            'install-failed',
            harness,
            version,
            `закреплённой копии ${target} нет; read-only запуск не устанавливает CLI`,
        );
    }

    const parent = path.dirname(target);
    let tmp = '';
    let renamed = false;
    try {
        fsi.mkdir(parent);
        tmp = fsi.mkdtemp(path.join(parent, `.${version}.partial-`));
        execFn(
            'npm',
            ['install', `${distribution.package}@${version}`, '--ignore-scripts', '--prefix', tmp],
            { timeoutMs },
        );
        const tempBin = path.resolve(tmp, distribution.bin);
        if (!fsi.exists(tempBin)) {
            return failure(
                'bin-missing',
                harness,
                version,
                `после установки нет исполняемого файла ${tempBin}`,
            );
        }
        const manifest = buildManifest(tmp)
            .map((entry) => `${entry.kind} ${entry.sha256} ${entry.path}\n`)
            .join('');
        fsi.writeFile(path.join(tmp, INSTALL_MANIFEST), manifest);
        fsi.rename(tmp, target);
        renamed = true;
        return { ok: true, bin };
    } catch (error) {
        if (!renamed && fsi.exists(target)) {
            return verifyCopy(target, distribution, harness, version, fsi);
        }
        return failure('install-failed', harness, version, message(error));
    } finally {
        if (tmp && !renamed) {
            try {
                fsi.rm(tmp);
            } catch {
                // Первичная причина отказа важнее неудачной уборки временного каталога.
            }
        }
    }
}

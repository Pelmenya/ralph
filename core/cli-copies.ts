// Подготовка закреплённых копий CLI до первой сессии (#260).
//
// Ядро знает набор рантаймов и типизированный результат, а команду установки исполняет адаптер.
// Ревью, планировщик и арбитр идут через тот же статический рантайм и маршруты, поэтому один
// достижимый набор закрывает все роли; два провайдера одного харнесса делят одну копию.
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { guardSideEffect as sideEffect } from '../shared/side-effect-guard.ts';
import { installCliCopy, type CliInstallResult } from '../adapters/cli-install.ts';
import {
    HARNESS_REGISTRY,
    selectHarness,
    type HarnessRegistry,
} from '../adapters/harness-registry.ts';
import { runtimeProfile } from '../adapters/runtime-profile.ts';

export type CliCopyFailure = Extract<CliInstallResult, { ok: false }>;
export type CliCopyPreparation = { ok: true; bins: ReadonlyMap<string, string> } | CliCopyFailure;

export function prepareCliCopies({
    providers,
    root,
    readOnly = false,
    registry = HARNESS_REGISTRY,
    installFn = installCliCopy,
}: {
    providers: ReadonlySet<string>;
    root: string;
    readOnly?: boolean;
    registry?: HarnessRegistry;
    installFn?: (input: {
        harness: string;
        version: string;
        distribution: Parameters<typeof installCliCopy>[0]['distribution'];
        root: string;
        readOnly?: boolean;
    }) => CliInstallResult;
}): CliCopyPreparation {
    const harnesses = new Set([...providers].map((provider) => runtimeProfile(provider).harness));
    const bins = new Map<string, string>();
    for (const harness of harnesses) {
        const selected = selectHarness(registry, harness);
        if (!selected.ok) {
            return {
                ok: false,
                code: 'install-failed',
                harness,
                version: '',
                reason: selected.reason,
            };
        }
        const version = selected.harness.descriptor.cliVersion;
        const result = installFn({
            harness,
            version,
            distribution: selected.harness.pkg.distribution,
            root,
            ...(readOnly ? { readOnly: true } : {}),
        });
        if (!result.ok) return result;
        bins.set(harness, result.bin);
    }
    return { ok: true, bins };
}

export function formatCliCopyFailure(failure: CliCopyFailure): string {
    return `CLI ${failure.harness}@${failure.version} (${failure.code}): ${failure.reason}`;
}

export type CanaryCopiesFs = {
    lstat: (target: string) => { isDirectory: () => boolean };
    readdir: (dir: string, options: { withFileTypes: true }) => Dirent[];
    mkdir: (dir: string, options: { recursive: true }) => string | undefined;
    rename: (from: string, to: string) => void;
    rm: (target: string, options: { recursive: true; force: true }) => void;
};

/* v8 ignore start */
const guardSideEffect = (what: string) =>
    sideEffect(what, 'Подмени fsi очистки копий канарейки в тесте.');
const defaultCanaryCopiesFs: CanaryCopiesFs = {
    lstat: (target) => lstatSync(target),
    readdir: (dir, options) => readdirSync(dir, options),
    mkdir: (dir, options) => {
        guardSideEffect(`mkdir(${dir})`);
        return mkdirSync(dir, options);
    },
    rename: (from, to) => {
        guardSideEffect(`rename(${from} → ${to})`);
        renameSync(from, to);
    },
    rm: (target, options) => {
        guardSideEffect(`rm(${target})`);
        rmSync(target, options);
    },
};
/* v8 ignore stop */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

function directoryKind(fsi: CanaryCopiesFs, dir: string): 'real' | 'missing' | 'unsafe' {
    try {
        return fsi.lstat(dir).isDirectory() ? 'real' : 'unsafe';
    } catch (error) {
        if (isMissing(error)) return 'missing';
        throw error;
    }
}

const safeHarness = (harness: string): boolean =>
    /^[a-z0-9-]+$/.test(harness) && !['.', '..', '.trash'].includes(harness);

export function pruneCanaryCopies({
    root,
    harness,
    keep,
    fsi = defaultCanaryCopiesFs,
    logFn,
    nowFn = () => Date.now(),
}: {
    root: string;
    harness: string;
    keep: ReadonlySet<string>;
    fsi?: CanaryCopiesFs;
    logFn: (line: string) => void;
    nowFn?: () => number;
}): void {
    if (!path.isAbsolute(root) || !safeHarness(harness) || keep.size === 0) {
        logFn('⚠ Очистка копий канарейки отклонена: небезопасные root, harness или пустой keep');
        return;
    }
    let entries: Dirent[];
    try {
        const rootKind = directoryKind(fsi, root);
        if (rootKind === 'missing') return;
        if (rootKind === 'unsafe') {
            logFn('⚠ Очистка копий канарейки отклонена: root является симлинком или не каталогом');
            return;
        }
    } catch (error) {
        logFn(`⚠ Корень копий канарейки не прочитан: ${errorText(error)}`);
        return;
    }
    const harnessRoot = path.join(root, harness);
    const trashRoot = path.join(root, '.trash');
    try {
        const harnessKind = directoryKind(fsi, harnessRoot);
        if (harnessKind === 'missing') return;
        if (harnessKind === 'unsafe') {
            logFn(
                `⚠ Очистка копий ${harness} отклонена: каталог является симлинком или не каталогом`,
            );
            return;
        }
        if (directoryKind(fsi, trashRoot) === 'unsafe') {
            logFn(
                '⚠ Очистка копий канарейки отклонена: .trash является симлинком или не каталогом',
            );
            return;
        }
        entries = fsi.readdir(harnessRoot, { withFileTypes: true });
    } catch (error) {
        if (!isMissing(error)) {
            logFn(`⚠ Каталог копий ${harness} не прочитан: ${errorText(error)}`);
        }
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || keep.has(entry.name)) continue;
        const trash = path.join(trashRoot, `${harness}-${entry.name}-${nowFn()}`);
        try {
            fsi.mkdir(path.dirname(trash), { recursive: true });
            fsi.rename(path.join(harnessRoot, entry.name), trash);
            fsi.rm(trash, { recursive: true, force: true });
        } catch (error) {
            logFn(`⚠ Копия ${harness}/${entry.name} не удалена: ${errorText(error)}`);
        }
    }
}

export function sweepCanaryTrash({
    root,
    fsi = defaultCanaryCopiesFs,
    logFn,
}: {
    root: string;
    fsi?: CanaryCopiesFs;
    logFn: (line: string) => void;
}): void {
    if (!path.isAbsolute(root)) {
        logFn('⚠ Очистка мусора канарейки отклонена: root не абсолютный');
        return;
    }
    let entries: Dirent[];
    try {
        const rootKind = directoryKind(fsi, root);
        if (rootKind === 'missing') return;
        if (rootKind === 'unsafe') {
            logFn('⚠ Очистка мусора канарейки отклонена: root является симлинком или не каталогом');
            return;
        }
    } catch (error) {
        logFn(`⚠ Корень мусора канарейки не прочитан: ${errorText(error)}`);
        return;
    }
    const trash = path.join(root, '.trash');
    try {
        const trashKind = directoryKind(fsi, trash);
        if (trashKind === 'missing') return;
        if (trashKind === 'unsafe') {
            logFn(
                '⚠ Очистка мусора канарейки отклонена: .trash является симлинком или не каталогом',
            );
            return;
        }
        entries = fsi.readdir(trash, { withFileTypes: true });
    } catch (error) {
        if (!isMissing(error)) logFn(`⚠ Мусор канарейки не прочитан: ${errorText(error)}`);
        return;
    }
    for (const entry of entries) {
        try {
            fsi.rm(path.join(trash, entry.name), { recursive: true, force: true });
        } catch (error) {
            logFn(`⚠ Мусор канарейки ${entry.name} не удалён: ${errorText(error)}`);
        }
    }
    try {
        fsi.rm(trash, { recursive: true, force: true });
    } catch (error) {
        logFn(`⚠ Каталог мусора канарейки не удалён: ${errorText(error)}`);
    }
}

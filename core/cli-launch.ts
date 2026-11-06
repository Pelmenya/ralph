// Запуск закреплённой копии CLI и необязательной обёртки хоста (#261).
//
// До этой карточки путь копии заканчивался в preflight, а сессия и чтение версии снова шли по
// имени из PATH. Один резолвер нужен обоим вызовам: иначе проверялась бы одна версия, а
// исполнялась другая. Имя бинаря остаётся только подписью и ключом сравнения версий.
import path from 'node:path';
import { RUNTIME_IDENTITIES } from '../adapters/runtime-profile.ts';

export type CliLaunch = { bin: string; file: string; args: string[] };

const KNOWN_HARNESSES = new Set(
    Object.values(RUNTIME_IDENTITIES).map((identity) => identity.harness),
);

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cliLauncherProblems(raw: unknown): string[] {
    if (raw === undefined) return [];
    if (!isObject(raw)) return ['cliLauncher — ожидался объект «харнесс → абсолютный путь»'];
    const problems: string[] = [];
    for (const [harness, launcher] of Object.entries(raw)) {
        if (!KNOWN_HARNESSES.has(harness)) {
            problems.push(`cliLauncher.${harness} — незнакомый харнесс`);
        }
        if (typeof launcher !== 'string' || !path.isAbsolute(launcher)) {
            problems.push(`cliLauncher.${harness} — ожидался абсолютный путь исполняемого файла`);
        }
    }
    return problems;
}

export function resolveCliLaunch(
    runtime: string,
    bins: ReadonlyMap<string, string> | undefined,
    launchers: Record<string, string> | undefined,
    args: string[],
): CliLaunch {
    const identity = RUNTIME_IDENTITIES[runtime];
    if (!identity) throw new Error(`рантайм '${runtime}' без записи в RUNTIME_IDENTITIES`);
    const bin = bins === undefined ? identity.bin : bins.get(identity.harness);
    if (bin === undefined) {
        throw new Error(`закреплённая копия CLI харнесса «${identity.harness}» не подготовлена`);
    }
    const launcher = launchers?.[identity.harness];
    return launcher === undefined
        ? { bin, file: bin, args }
        : { bin, file: launcher, args: [bin, ...args] };
}

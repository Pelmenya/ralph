// В CI гейт заметно дольше локального (#268). Снимки cgroup и время установки нужны
// до выбора оптимизации. Скрипт работает ДО npm ci: только встроенные модули Node.
// Отсутствие cgroup (другая ОС/версия/монтирование) — причина в логе, не отказ CI.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';

export type CiTimingDeps = {
    parallelism: () => number;
    read: (file: string) => string;
    run: (args: string[]) => { status: number | null };
    now: () => number;
    log: (line: string) => void;
};

function printResource(name: string, read: () => string | number, deps: CiTimingDeps): void {
    try {
        deps.log(`ℹ ${name}: ${String(read()).trim()}`);
    } catch (e) {
        deps.log(`⚠ ${name}: ${String(e)}`);
    }
}

function printCgroup(name: string, deps: CiTimingDeps): void {
    const file = `/sys/fs/cgroup/${name}`;
    printResource(file, () => deps.read(file), deps);
}

export function runCiTiming(step: 'install' | 'gate', deps: CiTimingDeps): number {
    if (step === 'install') {
        deps.log('▶ Ресурсы до npm ci');
        printResource('availableParallelism', deps.parallelism, deps);
        for (const name of ['cpu.max', 'memory.max', 'cpu.stat']) printCgroup(name, deps);
    }
    const start = deps.now();
    const result = deps.run(step === 'install' ? ['ci'] : ['run', 'gate']);
    if (step === 'install') {
        deps.log(`⏱ npm ci: ${((deps.now() - start) / 1000).toFixed(3)} с`);
    } else {
        // И после красного гейта: именно тогда throttling/OOM особенно важны для разбора.
        deps.log('▶ Ресурсы после гейта');
        printCgroup('cpu.stat', deps);
    }
    return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    const step = process.argv[2];
    if (step !== 'install' && step !== 'gate') {
        console.error('Ожидается шаг install или gate');
        process.exitCode = 1;
    } else {
        process.exitCode = runCiTiming(step, {
            parallelism: availableParallelism,
            read: (file) => readFileSync(file, 'utf8'),
            run: (args) => spawnSync('npm', args, { stdio: 'inherit', cwd: import.meta.dirname }),
            now: () => performance.now(),
            log: (line) => console.log(line),
        });
    }
}

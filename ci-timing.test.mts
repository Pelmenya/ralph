import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCiTiming, type CiTimingDeps } from './ci-timing.mts';

function world(status: number | null = 0, over: Partial<CiTimingDeps> = {}) {
    const events: string[] = [];
    let tick = 0;
    const deps: CiTimingDeps = {
        parallelism: () => 2,
        read: (file) => {
            events.push(`read ${file}`);
            return 'value\n';
        },
        run: (args) => {
            events.push(`npm ${args.join(' ')}`);
            return { status };
        },
        now: () => tick++ * 1500,
        log: (line) => events.push(line),
        ...over,
    };
    return { deps, events };
}

describe('CI — диагностика без права менять выход npm', () => {
    it.each([0, 42, null])(
        'install с кодом %s: ресурсы до установки, время и тот же выход',
        (status) => {
            const w = world(status);
            expect(runCiTiming('install', w.deps)).toBe(status ?? 1);
            expect(w.events).toEqual([
                '▶ Ресурсы до npm ci',
                'ℹ availableParallelism: 2',
                'read /sys/fs/cgroup/cpu.max',
                'ℹ /sys/fs/cgroup/cpu.max: value',
                'read /sys/fs/cgroup/memory.max',
                'ℹ /sys/fs/cgroup/memory.max: value',
                'read /sys/fs/cgroup/cpu.stat',
                'ℹ /sys/fs/cgroup/cpu.stat: value',
                'npm ci',
                '⏱ npm ci: 1.500 с',
            ]);
        },
    );

    it.each([0, 1, null])('gate с кодом %s: cpu.stat читается после, включая отказ', (status) => {
        const w = world(status);
        expect(runCiTiming('gate', w.deps)).toBe(status ?? 1);
        expect(w.events).toEqual([
            'npm run gate',
            '▶ Ресурсы после гейта',
            'read /sys/fs/cgroup/cpu.stat',
            'ℹ /sys/fs/cgroup/cpu.stat: value',
        ]);
    });

    it.each(['install', 'gate'] as const)(
        '%s: без cgroup — причины поимённо, npm продолжает работу',
        (step) => {
            for (const status of [0, 5]) {
                const w = world(status, {
                    read: () => {
                        throw new Error('ENOENT');
                    },
                });
                expect(runCiTiming(step, w.deps)).toBe(status);
                expect(w.events).toContain('⚠ /sys/fs/cgroup/cpu.stat: Error: ENOENT');
                if (step === 'install') {
                    expect(w.events).toContain('⚠ /sys/fs/cgroup/cpu.max: Error: ENOENT');
                    expect(w.events).toContain('⚠ /sys/fs/cgroup/memory.max: Error: ENOENT');
                }
                expect(w.events).toContain(step === 'install' ? 'npm ci' : 'npm run gate');
            }
        },
    );

    it('отказ availableParallelism не мешает cgroup и установке', () => {
        const w = world(0, {
            parallelism: () => {
                throw new Error('unavailable');
            },
        });
        expect(runCiTiming('install', w.deps)).toBe(0);
        expect(w.events).toContain('⚠ availableParallelism: Error: unavailable');
        expect(w.events).toContain('npm ci');
    });

    it('ci.yaml вызывает замер внутри прежних веток полного install/gate', () => {
        const yaml = readFileSync(
            path.join(import.meta.dirname, '.sourcecraft', 'ci.yaml'),
            'utf8',
        );
        const commands = [...yaml.matchAll(/- 'if (.*?); then (.*?); else (.*?); fi'/g)];
        expect(commands.map((match) => match[3])).toEqual([
            'node ci-timing.mts install',
            'node ci-timing.mts gate',
        ]);
        expect(commands[0][1]).toBe(commands[1][1]);
        expect(commands[0][1]).toBe(
            'printf "%s" "${RALPH_STALE_RUN:-}" | grep -Eqx "[0-9a-f]{40}"',
        );
    });
});

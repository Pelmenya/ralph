import { describe, expect, it } from 'vitest';
import { cliLauncherProblems, resolveCliLaunch } from './cli-launch.ts';

describe('cliLauncher — форма конфига обёртки запуска', () => {
    it('необязательный объект принимает абсолютные пути известных харнессов', () => {
        expect(cliLauncherProblems(undefined)).toEqual([]);
        expect(cliLauncherProblems({})).toEqual([]);
        expect(
            cliLauncherProblems({
                'claude-code': '/opt/claude-launcher',
                codex: '/opt/codex-launcher',
                'kimi-code': '/opt/kimi-launcher',
                opencode: '/opt/opencode-launcher',
            }),
        ).toEqual([]);
    });

    it.each([
        [null, /cliLauncher.*ожидался объект/],
        [[], /cliLauncher.*ожидался объект/],
        [{ unknown: '/opt/launcher' }, /cliLauncher\.unknown.*незнакомый харнесс/],
        [{ codex: 'bin/launcher' }, /cliLauncher\.codex.*абсолютный путь/],
        [{ codex: 42 }, /cliLauncher\.codex.*абсолютный путь/],
    ])('НЕГАТИВНЫЙ: %j — отказ с именем ключа', (value, reason) => {
        expect(cliLauncherProblems(value).join('; ')).toMatch(reason as RegExp);
    });
});

describe('resolveCliLaunch — копия и обёртка одним контрактом', () => {
    const bins = new Map([
        ['claude-code', '/state/cli/claude-code/2.1.312/bin/claude.exe'],
        ['codex', '/state/cli/codex/0.163.0/bin/codex.js'],
        ['kimi-code', '/state/cli/kimi-code/2.3.2/dist/main.mjs'],
        ['opencode', '/state/cli/opencode/1.19.4/bin/opencode.exe'],
    ]);

    it.each([
        ['claude', 'claude-code'],
        ['kimi', 'claude-code'],
        ['openai', 'codex'],
        ['kimi-native', 'kimi-code'],
        ['opencode', 'opencode'],
    ])('%s исполняет копию своего харнесса, а не имя из PATH', (runtime, harness) => {
        const launch = resolveCliLaunch(runtime, bins, undefined, ['--version']);
        expect(launch.file).toBe(bins.get(harness));
        expect(launch.args).toEqual(['--version']);
    });

    it('обёртка получает копию первым аргументом, затем argv CLI', () => {
        const launch = resolveCliLaunch(
            'kimi-native',
            bins,
            { 'kimi-code': '/opt/kimi-launcher' },
            ['-p', 'prompt'],
        );
        expect(launch).toEqual({
            bin: bins.get('kimi-code'),
            file: '/opt/kimi-launcher',
            args: [bins.get('kimi-code'), '-p', 'prompt'],
        });
    });

    it('подготовленный набор без харнесса — отказ, а не возврат к PATH', () => {
        expect(() => resolveCliLaunch('openai', new Map(), undefined, [])).toThrow(/codex/);
    });

    it('незнакомый рантайм — отказ с именем ключа', () => {
        expect(() => resolveCliLaunch('unknown', bins, undefined, [])).toThrow(/unknown/);
    });
});

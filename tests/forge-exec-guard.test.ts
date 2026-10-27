// Пробы от противного для барьера исполнения форжа (задача 20). Подмену здесь никто не
// ставит: её ставит общий `test-setup.ts`, и проба заодно доказывает ПРИМЕНЕНИЕ — сними
// установку оттуда, и красными станут пробы ниже, а не только юниты разбора.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';
import { forgeInArgv, forgeInShell } from './forge-exec-guard.ts';
import {
    mergeByCharCode,
    mergeByConfig,
    mergeByJoin,
    mergeSwallowed,
} from './__fixtures__/assembled-forge-exec.ts';

// Журнал общий с `afterEach`: проба забирает свои записи сама, иначе тест краснел бы
// ровно тем, что барьер сработал.
const takeAttempts = () => sideEffectAttempts.splice(0);

describe('forgeInArgv / forgeInShell — имя решает запускаемый бинарь', () => {
    it.each([
        [['gh', 'pr', 'merge', '7'], 'gh pr merge'],
        [['/usr/local/bin/glab', 'mr', 'merge'], 'glab mr merge'],
        [['src', 'issue', 'close', '3'], 'src issue close'],
        [['env', 'GH_TOKEN=x', 'gh', 'api', 'user'], 'gh api user'],
        [['timeout', '30', 'gh', 'pr', 'view'], 'gh pr view'],
        [['sh', '-c', 'git fetch && gh pr merge 7'], 'gh pr merge'],
        // Ревью: `-c` в связке коротких флагов — обычная форма вызова (`-lc` ради профиля).
        [['bash', '-lc', 'gh pr merge 7'], 'gh pr merge'],
        [['sh', '-ec', 'gh pr merge 7'], 'gh pr merge'],
        [['bash', '-xc', 'gh pr merge 7'], 'gh pr merge'],
        // Ревью: опции обёрток со значением — значение не команда.
        [['nice', '-n', '10', 'gh', 'pr', 'merge'], 'gh pr merge'],
        [['timeout', '-s', 'KILL', '30', 'gh', 'pr', 'merge'], 'gh pr merge'],
        [['timeout', '--signal=KILL', '30', 'gh', 'pr', 'merge'], 'gh pr merge'],
        [['timeout', '--signal', 'KILL', '30', 'gh', 'pr', 'merge'], 'gh pr merge'],
        [['env', '-u', 'X', 'gh', 'api', 'user'], 'gh api user'],
        [['sudo', '-u', 'u', 'gh', 'pr', 'merge'], 'gh pr merge'],
        [['env', '-S', 'gh pr merge 7'], 'gh pr merge'],
        [['ionice', '-c', '3', 'gh', 'pr', 'merge'], 'gh pr merge'],
        [['stdbuf', '-o', 'L', 'gh', 'pr', 'merge'], 'gh pr merge'],
        [['xargs', '-n', '1', 'gh', 'issue', 'close'], 'gh issue close'],
        [['nice', '-n', '5', 'timeout', '-k', '5', '30', 'gh', 'pr', 'merge'], 'gh pr merge'],
    ])('%j → %s', (argv, want) => {
        expect(forgeInArgv(argv)).toBe(want);
    });

    it.each([
        [['git', 'add', 'src/a.ts']],
        [['git', '-C', 'src', 'status']],
        [['node', 'gh.js']],
        [['ghost', 'run']],
        [['sh', 'script.sh']],
        // От противного к «форж в любом токене после обёртки»: каталог `src` — не форж.
        [['timeout', '30', 'git', '-C', 'src', 'status']],
        [['bash', '--norc', 'script.sh']],
    ])('%j — не форж', (argv) => {
        expect(forgeInArgv(argv)).toBeNull();
    });

    it.each([
        ['cd /tmp && gh pr merge 7', 'gh pr merge'],
        ['echo x | glab issue close 1', 'glab issue close'],
        ['X=$(gh api user)', 'gh api user'],
        ["'gh' pr list", 'gh pr list'],
    ])('шелл %s → %s', (script, want) => {
        expect(forgeInShell(script)).toBe(want);
    });

    it.each([['ls src'], ['git log --grep gh'], ['npm run src']])('шелл %s — не форж', (s) => {
        expect(forgeInShell(s)).toBeNull();
    });
});

describe('исполнение форжа из модуля ядра красит прогон — как бы ни было собрано имя', () => {
    it.each([
        ['join из частей', () => mergeByJoin(), 'gh pr merge'],
        ['String.fromCharCode', () => mergeByCharCode(), 'glab mr merge'],
        ['значение из конфига', () => mergeByConfig({ forgeCli: 'gh' }), 'gh pr merge'],
    ])('%s', (_name, run, cmd) => {
        expect(run).toThrow(/forge-exec/);
        const attempts = takeAttempts();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toContain(`forge-exec(${cmd})`);
        // Происхождение названо: по нему видно, какой модуль зовёт форж мимо шва.
        expect(attempts[0]).toMatch(/tests\/__fixtures__\/assembled-forge-exec\.ts:\d+/);
    });

    it('проглоченный try/catch отказ всё равно в журнале — краснеет afterEach', () => {
        expect(mergeSwallowed).not.toThrow();
        expect(takeAttempts()).toEqual([expect.stringContaining('forge-exec(gh pr merge)')]);
    });

    it('не-форж исполняется как раньше — подмена не ломает законный запуск', () => {
        expect(
            execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
                encoding: 'utf-8',
            }),
        ).toBe('ok');
        expect(takeAttempts()).toEqual([]);
    });
});

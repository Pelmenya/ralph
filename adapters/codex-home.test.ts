// Сборщик конфига Codex (#195): дом сессии, ключи недоверия, окружение и сверка собранного.
// Факты, на которых он стоит, держит `harnesses/codex/stand-fixtures.test.ts` (`sessionHome`).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CODEX_HOME_ENV,
    codexHumanHome,
    codexIsolationProblems,
    codexProjectKeys,
    codexSessionEnv,
    codexUntrustArgs,
} from './codex-home.ts';

const HOME = '/path/to/state/codex-session/home';

describe('codexHumanHome — дом, который CLI взял бы сам', () => {
    it('CODEX_HOME, иначе ~/.codex от HOME, иначе null', () => {
        expect(codexHumanHome({ CODEX_HOME: '/h/c', HOME: '/h' })).toBe('/h/c');
        expect(codexHumanHome({ HOME: '/h' })).toBe(path.join('/h', '.codex'));
        expect(codexHumanHome({})).toBeNull();
    });
});

describe('codexSessionEnv — окружение CLI раннера сессии не достаётся', () => {
    it('CODEX_* и адрес провайдера сняты, дом — собранный, остальное как есть', () => {
        const env = codexSessionEnv(
            {
                CODEX_HOME: '/human/.codex',
                CODEX_SANDBOX: 'x',
                OPENAI_BASE_URL: 'http://example.com',
                OPENAI_API_KEY: 'k',
                PATH: '/bin',
            },
            HOME,
        );
        expect(env).toEqual({ [CODEX_HOME_ENV]: HOME, OPENAI_API_KEY: 'k', PATH: '/bin' });
    });
});

describe('codexProjectKeys — дерево и главный репозиторий worktree', () => {
    const files = (map: Record<string, string>) => (p: string) => {
        if (p in map) return map[p];
        throw new Error(`ENOENT ${p}`);
    };

    it('каталог .git или не репозиторий — только дерево', () => {
        expect(codexProjectKeys('/app', files({}))).toEqual(['/app']);
    });

    it('linked worktree — дерево и главный по commondir (относительный путь от gitdir)', () => {
        const read = files({
            '/w/loop/.git': 'gitdir: /app/.git/worktrees/loop\n',
            '/app/.git/worktrees/loop/commondir': '../..\n',
        });
        expect(codexProjectKeys('/w/loop', read)).toEqual(['/w/loop', '/app']);
    });

    it('относительный gitdir и commondir без .git на конце — как есть', () => {
        const read = files({
            '/w/.git': 'gitdir: ../bare/worktrees/w',
            '/bare/worktrees/w/commondir': '/bare',
        });
        expect(codexProjectKeys('/w', read)).toEqual(['/w', '/bare']);
    });

    it('главный совпал с деревом — один ключ', () => {
        const read = files({ '/w/.git': 'gitdir: /w/.git', '/w/.git/commondir': '.' });
        expect(codexProjectKeys('/w', read)).toEqual(['/w']);
    });

    it('файл .git без gitdir и worktree без commondir — отказ с причиной', () => {
        expect(() => codexProjectKeys('/w', files({ '/w/.git': 'мусор' }))).toThrow(
            /без строки gitdir/,
        );
        expect(() =>
            codexProjectKeys('/w', files({ '/w/.git': 'gitdir: /a/.git/worktrees/x' })),
        ).toThrow(/главный репозиторий worktree \/w не найден/);
    });

    it('подмодуль: gitdir в modules без commondir — само дерево, не отказ', () => {
        const read = files({ '/app/sub/.git': 'gitdir: ../.git/modules/sub' });
        expect(codexProjectKeys('/app/sub', read)).toEqual(['/app/sub']);
    });

    it('дерево с хвостовым «/» и главный — тот же каталог: один ключ', () => {
        const read = files({ '/w/.git': 'gitdir: /w/.git', '/w/.git/commondir': '.' });
        expect(codexProjectKeys('/w/', read)).toEqual(['/w']);
    });
});

describe('codexUntrustArgs — недоверие одним -c', () => {
    it('каждый ключ строкой TOML, кавычки экранированы', () => {
        expect(codexUntrustArgs(['/a', '/b "c"'])).toEqual([
            '-c',
            'projects={"/a"={trust_level="untrusted"},"/b \\"c\\""={trust_level="untrusted"}}',
        ]);
    });
});

describe('codexIsolationProblems — сверка того, что уйдёт в CLI', () => {
    const keys = ['/w', '/app'];
    const good = {
        argv: ['exec', '--ignore-user-config', ...codexUntrustArgs(keys), '--', '-'],
        env: { [CODEX_HOME_ENV]: HOME, PATH: '/bin' },
        home: HOME,
        humanHome: '/human/.codex',
        keys,
    };

    it('собранное как надо — чисто', () => {
        expect(codexIsolationProblems(good)).toEqual([]);
    });

    it.each([
        [
            'без --ignore-user-config',
            { argv: good.argv.filter((a) => a !== '--ignore-user-config') },
            /--ignore-user-config/,
        ],
        [
            'недоверие не тем ключам',
            { argv: ['--ignore-user-config', ...codexUntrustArgs(['/w'])] },
            /нет недоверия проекту/,
        ],
        [
            'значение недоверия не после -c',
            { argv: ['--ignore-user-config', codexUntrustArgs(keys)[1]] },
            /нет недоверия проекту/,
        ],
        ['чужой CODEX_HOME', { env: { [CODEX_HOME_ENV]: '/human/.codex' } }, /не дом, собранный/],
        ['дом сессии — дом человека', { humanHome: `${HOME}/` }, /совпал с домом человека/],
        [
            'окружение CLI не вычищено',
            { env: { ...good.env, CODEX_X: '1', OPENAI_BASE_URL: 'u' } },
            /не вычищено: CODEX_X, OPENAI_BASE_URL/,
        ],
    ])('%s — отказ', (_what, over, re) => {
        expect(codexIsolationProblems({ ...good, ...over }).join('\n')).toMatch(re);
    });

    it('дома человека нет — сравнивать не с чем, это не отказ', () => {
        expect(codexIsolationProblems({ ...good, humanHome: null })).toEqual([]);
    });
});

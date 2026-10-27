// #139: файлы PR против защищаемых масок — то, по чему гейт мерджа отказывает в мердже.
import { describe, expect, it } from 'vitest';
import {
    PROTECTED_PATHS,
    patternCovers,
    protectedHits,
    protectedPatterns,
} from './protected-paths.ts';

describe('protectedHits — файлы PR под защищаемыми масками', () => {
    it('правка lock — попадание с маской', () => {
        expect(protectedHits(['src/a.ts', '.ralph/core.lock'])).toEqual([
            { file: '.ralph/core.lock', pattern: '.ralph/core.lock' },
        ]);
    });

    it.each([
        ['.ralph/next.json', '.ralph/**'],
        ['ralph', 'ralph'],
        ['.github/workflows/ci.yml', '.github/**'],
        ['.github/CODEOWNERS', '.github/**'],
        ['.claude/ralph/ralph.config.json', '.claude/ralph/ralph.config.json'],
        ['.claude/ralph/hooks.json', '.claude/ralph/hooks.json'],
        ['.claude/hooks/guard.cjs', '.claude/hooks/**'],
        ['.claude/settings.json', '.claude/settings.json'],
    ])('%s — защищён маской %s', (file, pattern) => {
        expect(protectedHits([file])).toEqual([{ file, pattern }]);
    });

    it('доменный PR — попаданий нет', () => {
        expect(protectedHits(['src/a.ts', 'docs/x.md', 'ralph.js', 'core/ralph.ts'])).toEqual([]);
    });

    // Новое имя на месте каталога маски `x/**` (файл, симлинк, gitlink) — попадание: иначе PR,
    // заводящий `.ralph` там, где каталога не было, прошёл бы гейт ложным зелёным.
    it.each([
        ['.ralph', '.ralph/**'],
        ['.claude/hooks', '.claude/hooks/**'],
        ['.sourcecraft', '.sourcecraft/**'],
        ['.github', '.github/**'],
    ])('сам каталог %s — защищён маской %s', (file, pattern) => {
        expect(protectedHits([file])).toEqual([{ file, pattern }]);
    });

    it.each([['ralph.js'], ['ralphx'], ['.ralphx'], ['.ralphx/core.lock'], ['x/.github/a']])(
        'похожее, но не защищаемое: %s',
        (file) => {
            expect(protectedHits([file])).toEqual([]);
        },
    );

    it('все попадания названы, а не первое', () => {
        expect(protectedHits(['.ralph/core.lock', 'a.ts', 'ralph']).map((h) => h.file)).toEqual([
            '.ralph/core.lock',
            'ralph',
        ]);
    });

    it('пустой список файлов — отказ, а не «нечего сверять»', () => {
        expect(() => protectedHits([])).toThrow(/пуст/);
    });

    it('пустой список защищаемых путей — отказ', () => {
        expect(() => protectedHits(['a.ts'], [])).toThrow(/защищаемых путей пуст/);
    });

    // От противного: без маски `.ralph/**` и литерала lock правка lock проходит — значит
    // попадание держит именно список, а не случайное совпадение.
    it('список без масок `.ralph` — lock проходит', () => {
        const stripped = PROTECTED_PATHS.filter((p) => !p.pattern.startsWith('.ralph'));
        expect(protectedHits(['.ralph/core.lock'], stripped)).toEqual([]);
    });
});

describe('protectedPatterns', () => {
    it('маски без повторов, карточкой названные — на месте', () => {
        const patterns = protectedPatterns();
        expect(new Set(patterns).size).toBe(patterns.length);
        for (const p of ['.ralph/**', 'ralph', '.github/**', '.claude/ralph/ralph.config.json']) {
            expect(patterns).toContain(p);
        }
    });
});

describe('patternCovers — формы маски', () => {
    it('`**` посреди и `?` — по семантике модуля', () => {
        expect(patternCovers('a**b', 'a/x/b')).toBe(true);
        expect(patternCovers('a?c', 'abc')).toBe(true);
        expect(patternCovers('a?c', 'a/c')).toBe(false);
    });
});

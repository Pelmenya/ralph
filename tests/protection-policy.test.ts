// #49: статический тест политики защиты. Почему он устроен именно так — докблок
// `protection-policy.ts`; здесь — сверка фактического файла и пробы от противного.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONSUMER_CONFIG_REL } from '../core/consumer-config-path.ts';
import {
    PROTECTED_PATHS,
    isExactPath,
    parseReviewRules,
    patternCovers,
    unprotectedPaths,
    type ProtectedPath,
    type ReviewRule,
} from './protection-policy.ts';

const CANON_ROOT = resolve(import.meta.dirname, '..');
const REVIEW_POLICY = join(CANON_ROOT, '.sourcecraft', 'review.yaml');

const actualRules = (): ReviewRule[] => parseReviewRules(readFileSync(REVIEW_POLICY, 'utf8'));

/** Фикстура списка по пути; не нашлась — понятный отказ, а не TypeError дальше по тесту. */
function byPath(path: string): ProtectedPath {
    const found = PROTECTED_PATHS.find((p) => p.path === path);
    if (!found) throw new Error(`фикстура ${path} не найдена в PROTECTED_PATHS`);
    return found;
}

describe('фактическая политика ревью площадки', () => {
    it('каждый защищаемый путь требует одобрения человека', () => {
        expect(unprotectedPaths(actualRules()).map((p) => p.path)).toEqual([]);
    });

    it('конфиг потребителя защищён по тому пути, что читает раннер', () => {
        // Список и политика однажды называли корневой `ralph.config.json`, которого раннер не
        // читает, и сверка была зелёной на дыре. Путь — константа ядра, а не повтор строкой.
        expect(byPath(CONSUMER_CONFIG_REL).path).toBe('.claude/ralph/ralph.config.json');
        expect(unprotectedPaths(actualRules(), [byPath(CONSUMER_CONFIG_REL)])).toEqual([]);
    });

    it('разбор видит правило с одобрением, а не пустоту', () => {
        const rules = actualRules().filter((r) => r.needShips >= 1);
        expect(rules.length).toBeGreaterThan(0);
        expect(rules.every((r) => r.reviewers.length > 0)).toBe(true);
    });
});

describe('от противного: выпадение пути краснеет', () => {
    // Каждая фикстура — своя проба: из фактической политики убираются ровно те маски,
    // что покрывают путь, и барьер обязан назвать именно его.
    for (const target of PROTECTED_PATHS) {
        it(`без масок для ${target.path} — путь назван`, () => {
            const stripped = actualRules().map((r) => ({
                ...r,
                patterns: r.patterns.filter(
                    (pat) => pat !== target.path && !patternCovers(pat, target.path),
                ),
            }));
            expect(unprotectedPaths(stripped).map((p) => p.path)).toContain(target.path);
        });
    }

    it('ship снят с правила — защищено ничего', () => {
        const rules = actualRules().map((r) => ({ ...r, needShips: 0 }));
        expect(() => unprotectedPaths(rules)).toThrow(/политика защиты пуста/);
    });

    it('ревьюер не назван — одобрять некому, правило не в счёт', () => {
        const rules = actualRules().map((r) => ({ ...r, reviewers: [] }));
        expect(() => unprotectedPaths(rules)).toThrow(/политика защиты пуста/);
    });

    it('пустой список защищаемых путей — отказ, а не «всё защищено»', () => {
        expect(() => unprotectedPaths(actualRules(), [])).toThrow(/пуст/);
    });
});

describe('точный путь файла: маска каталога не защита', () => {
    const rule = (patterns: string[]): ReviewRule[] => [
        { patterns, needShips: 1, reviewers: ['someone'] },
    ];
    const lock = byPath('.ralph/core.lock');
    const shim = byPath('ralph');

    it('фикстуры точных путей помечены как точные', () => {
        expect(lock.exact).toBe(true);
        expect(shim.exact).toBe(true);
    });

    it('фикстуры не найдено — отказ с её именем', () => {
        expect(() => byPath('нет-такого')).toThrow(/фикстура нет-такого не найдена/);
    });

    it('`.ralph/**` без литерала lock не защищает `.ralph/core.lock`', () => {
        expect(unprotectedPaths(rule(['.ralph/**']), [lock])).toEqual([lock]);
        expect(unprotectedPaths(rule(['.ralph/**', '.ralph/core.lock']), [lock])).toEqual([]);
    });

    it('`ralph/**`, `**` и `./ralph` не защищают шим `ralph` в корне', () => {
        for (const pat of ['ralph/**', '**', '*', './ralph', '/ralph']) {
            expect(unprotectedPaths(rule([pat]), [shim])).toEqual([shim]);
        }
        expect(unprotectedPaths(rule(['ralph']), [shim])).toEqual([]);
    });

    it('файл в корне точный и без флага: `**` и `*.json` его не защищают', () => {
        const root: ProtectedPath = { path: 'root.json', exact: false, why: 'проба' };
        expect(isExactPath(root)).toBe(true);
        expect(isExactPath({ ...root, path: 'dir/root.json' })).toBe(false);
        for (const pat of ['**', '*.json', '*']) {
            expect(unprotectedPaths(rule([pat]), [root])).toEqual([root]);
        }
        expect(unprotectedPaths(rule(['root.json']), [root])).toEqual([]);
    });
});

describe('строгий матчер масок', () => {
    it.each([
        ['.ralph/**', '.ralph/core.lock', true],
        ['.ralph/**', '.ralph/a/b', true],
        ['.ralph/**', '.ralph', false],
        ['.ralph/**', '.ralphx/core.lock', false],
        ['.claude/hooks/**', '.claude/hooks/guard.cjs', true],
        ['.claude/*.json', '.claude/settings.json', true],
        ['.claude/*.json', '.claude/ralph/hooks.json', false],
        ['**/CODEOWNERS', '.github/CODEOWNERS', true],
        ['**/CODEOWNERS', 'CODEOWNERS', true],
        ['ralph.config.json', 'ralphXconfig.json', false],
        ['ralph', 'ralph.js', false],
    ])('%s ~ %s → %s', (pattern, path, expected) => {
        expect(patternCovers(pattern, path)).toBe(expected);
    });
});

describe('разбор конфига ревью', () => {
    const sample = [
        'notes:',
        '    rules:',
        "        - patterns: ['чужая секция']",
        'codereview:',
        '    need_ships: 0',
        '    rules:',
        '        - patterns:',
        "              - '.ralph/**' ## комментарий",
        '              ## строка-комментарий',
        '              - "ralph"',
        '          reviewers:',
        '              usernames:',
        "                  - 'someone'",
        '              assign: 1',
        '              need_ships: 1',
        '        - patterns:',
        "              - 'docs/**'",
        '          reviewers:',
        '              need_ships: 0',
        'other: 1',
    ].join('\n');

    it('правила, маски, ревьюеры и ship', () => {
        expect(parseReviewRules(sample)).toEqual([
            { patterns: ['.ralph/**', 'ralph'], needShips: 1, reviewers: ['someone'] },
            { patterns: ['docs/**'], needShips: 0, reviewers: [] },
        ]);
    });

    const rule = (body: string): string =>
        `codereview:\n    rules:\n        - patterns:\n              - 'a'\n${body}`;

    it.each([
        ['нет codereview', 'rules:\n    - patterns:\n', /нет секции codereview/],
        ['нет rules', 'codereview:\n    need_ships: 1\n', /нет rules/],
        [
            'rules только в чужой секции',
            'other:\n    rules:\n        - patterns:\ncodereview:\n    need_ships: 1\n',
            /нет rules/,
        ],
        [
            'rules глубже прямого потомка codereview',
            'codereview:\n    need_ships: 0\n    sub:\n        rules:\n',
            /нет rules/,
        ],
        ['пустой rules', 'codereview:\n    rules:\nother: 1\n', /rules пуста/],
        [
            'правило без patterns',
            'codereview:\n    rules:\n        - need_ships: 1\n',
            /без patterns/,
        ],
        [
            'второе правило без patterns первым ключом',
            rule("        - reviewers:\n              - 'b'\n"),
            /без patterns первым/,
        ],
        [
            'ship не число',
            rule('          reviewers:\n              need_ships: one\n'),
            /не число/,
        ],
        [
            'пустой patterns',
            'codereview:\n    rules:\n        - patterns:\n          reviewers:\n',
            /пустым patterns/,
        ],
        ['неразобранная строка', rule('          ???\n'), /не разобрана/],
        [
            'элемент вне списка',
            rule("          reviewers:\n              assign: 1\n              - 'b'\n"),
            /вне patterns/,
        ],
        ['элемент на отступе ключа', rule("          - 'b'\n"), /вне patterns/],
        ['незнакомый ключ правила', rule('          branches: main\n'), /незнакомый ключ правила/],
        ['need_ships на уровне правила', rule('          need_ships: 1\n'), /незнакомый ключ/],
        [
            'незнакомый ключ reviewers',
            rule('          reviewers:\n              only_if: x\n'),
            /незнакомый ключ reviewers/,
        ],
        [
            'повтор need_ships',
            rule(
                '          reviewers:\n              need_ships: 1\n              need_ships: 0\n',
            ),
            /повторён/,
        ],
        [
            'ключ глубже правила вне reviewers',
            rule('              need_ships: 1\n'),
            /не на своём отступе/,
        ],
        ['# внутри маски в кавычках', rule("              - 'docs/a #b'\n"), /кавычка/],
    ])('%s — отказ', (_name, text, error) => {
        expect(() => parseReviewRules(text)).toThrow(error);
    });
});

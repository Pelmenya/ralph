import { describe, expect, it } from 'vitest';
import { inventoryDiff } from './cli-canary-actions.ts';

describe('анонимные элементы инвентаря', () => {
    it('[F24-6] удаление анонимного элемента из смешанного массива видно', () => {
        const diff = inventoryDiff([{ id: 'same' }, { anonymous: true }], [{ id: 'same' }]);
        expect(diff).toContain('### Убрано');
        expect(diff).toContain('{"anonymous":true}');
    });

    it('[F24-6] добавление анонимного элемента в смешанный массив видно', () => {
        const diff = inventoryDiff([{ id: 'same' }], [{ id: 'same' }, { anonymous: true }]);
        expect(diff).toContain('### Добавлено');
        expect(diff).toContain('{"anonymous":true}');
    });

    it('[F24-6] кратность анонимных элементов сохраняется', () => {
        const diff = inventoryDiff([{ id: 'x' }, { a: 1 }, { a: 1 }], [{ id: 'x' }, { a: 1 }]);
        expect(diff).toContain('### Убрано');
        expect(diff).not.toContain('### Добавлено');
        expect(diff.split('{"a":1}')).toHaveLength(2);
    });

    it('[F24-6] порядок ключей не создаёт различий', () => {
        expect(
            inventoryDiff(
                [{ id: 'x' }, { a: 1, b: { c: 1, d: 2 } }],
                [{ id: 'x' }, { b: { d: 2, c: 1 }, a: 1 }],
            ),
        ).toBe('');
    });

    for (const mixed of [true, false]) {
        it(`[F24-6] длинные значения различаются полностью: ${mixed ? 'смешанный' : 'анонимный'} массив`, () => {
            const prefix = 'x'.repeat(801);
            const named = { id: 'same' };
            const before = mixed
                ? [named, { value: `${prefix}left` }]
                : [{ value: `${prefix}left` }];
            const after = mixed
                ? [named, { value: `${prefix}right` }]
                : [{ value: `${prefix}right` }];
            const diff = inventoryDiff(before, after);
            expect(diff).toContain('### Убрано');
            expect(diff).toContain('### Добавлено');
            expect(diff).toContain('left');
            expect(diff).toContain('right');
        });
    }

    it('[F24-6] перестановка анонимных элементов не создаёт различий', () => {
        expect(inventoryDiff([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }])).toBe('');
    });

    it('[F24-6] независимое изменение принуждает каноничный обход multiset', () => {
        expect(
            inventoryDiff(
                [{ a: 1, b: { c: 1, d: 2 } }, { value: 'before' }],
                [{ b: { d: 2, c: 1 }, a: 1 }, { value: 'after' }],
            ),
        ).toBe(
            '### Добавлено\n- `inventory`: {"value":"after"}\n\n### Убрано\n- `inventory`: {"value":"before"}',
        );
    });
});

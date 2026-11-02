import { describe, expect, it } from 'vitest';
import {
    extractFixPlan,
    FIX_PLAN_BEGIN,
    FIX_PLAN_END,
    formatFixPlan,
    type TFixPlan,
} from './fix-plan.ts';

const PLAN: TFixPlan = {
    decision: 'Вынести общий разбор границы в отдельную функцию',
    rejected: ['Добавлять ещё одну регулярку для названного края'],
    steps: [
        {
            do: 'Добавить тест на общий класс границ',
            check: 'npx vitest run core/fix-plan.test.ts',
            expect: 'RED',
        },
        {
            do: 'Реализовать общий разбор',
            check: 'npx vitest run core/fix-plan.test.ts',
            expect: 'GREEN',
        },
    ],
};

describe('extractFixPlan', () => {
    it('разбирает блок плана с двумя шагами', () => {
        const output = [
            'Пояснение планировщика',
            FIX_PLAN_BEGIN,
            JSON.stringify(PLAN, null, 2),
            FIX_PLAN_END,
            'Текст после блока',
        ].join('\n');

        expect(extractFixPlan(output)).toEqual({ plan: PLAN });
    });
});

describe('extractFixPlan — границы и отказы', () => {
    const block = (value: unknown): string =>
        [FIX_PLAN_BEGIN, JSON.stringify(value, null, 2), FIX_PLAN_END].join('\n');

    it.each([1, 8])('принимает %s шагов и пустой список отвергнутого', (count) => {
        const plan = {
            ...PLAN,
            rejected: [],
            steps: Array.from({ length: count }, () => ({ ...PLAN.steps[0] })),
        };

        expect(extractFixPlan(block(plan))).toEqual({ plan });
    });

    const cases = [
        ['нет блока', 'Просто текст', 'блока плана нет'],
        ['конец без начала', FIX_PLAN_END, 'блока плана нет'],
        ['маркер в прозе', `Текст ${FIX_PLAN_BEGIN}`, 'блока плана нет'],
        ['второй блок', `${block(PLAN)}\n${block(PLAN)}`, 'второй блок плана'],
        [
            'вложенное начало',
            [FIX_PLAN_BEGIN, FIX_PLAN_BEGIN, JSON.stringify(PLAN), FIX_PLAN_END].join('\n'),
            'второй блок плана',
        ],
        ['блок не закрыт', [FIX_PLAN_BEGIN, JSON.stringify(PLAN)].join('\n'), 'блок не закрыт'],
        ['не JSON', [FIX_PLAN_BEGIN, '{', FIX_PLAN_END].join('\n'), 'не JSON'],
        ['JSON не объект', block([]), 'план — не объект'],
        [
            'незнакомое поле верхнего уровня',
            block({ ...PLAN, extra: true }),
            'незнакомое поле extra',
        ],
        ['пустое решение', block({ ...PLAN, decision: '  ' }), 'пустое решение'],
        ['rejected не массив', block({ ...PLAN, rejected: 'нет' }), 'rejected — не массив'],
        [
            'пустая строка в rejected',
            block({ ...PLAN, rejected: [''] }),
            'rejected — пустая строка или не строка',
        ],
        [
            'не строка в rejected',
            block({ ...PLAN, rejected: [7] }),
            'rejected — пустая строка или не строка',
        ],
        ['steps не массив', block({ ...PLAN, steps: {} }), 'steps — не массив'],
        ['ноль шагов', block({ ...PLAN, steps: [] }), 'шагов 0 — ожидалось 1–8'],
        [
            'девять шагов',
            block({ ...PLAN, steps: Array.from({ length: 9 }, () => ({ ...PLAN.steps[0] })) }),
            'шагов 9 — ожидалось 1–8',
        ],
        ['шаг не объект', block({ ...PLAN, steps: ['шаг'] }), 'шаг 1 — не объект'],
        [
            'незнакомое поле в шаге',
            block({ ...PLAN, steps: [{ ...PLAN.steps[0], extra: true }] }),
            'шаг 1: незнакомое поле extra',
        ],
        [
            'пустое действие',
            block({ ...PLAN, steps: [{ ...PLAN.steps[0], do: '' }] }),
            'шаг 1: нет действия',
        ],
        [
            'шаг без check',
            block({ ...PLAN, steps: [{ do: 'Действие', expect: 'RED' }] }),
            'шаг 1: нет команды',
        ],
        [
            'expect BLUE',
            block({ ...PLAN, steps: [{ ...PLAN.steps[0], expect: 'BLUE' }] }),
            'шаг 1: expect не RED/GREEN',
        ],
    ];

    it.each(cases)('%s → отказ с причиной', (_name, output, error) => {
        expect(extractFixPlan(output)).toEqual({ error });
    });
});

describe('formatFixPlan', () => {
    it('печатает решение, отвергнутое и шаги с командами', () => {
        const text = formatFixPlan(PLAN);

        expect(text).toContain(PLAN.decision);
        expect(text).toContain('Отвергнуто:');
        expect(text).toContain(PLAN.rejected[0]);
        expect(text).toContain(
            `1. ${PLAN.steps[0].do} — проверка: ${PLAN.steps[0].check} — ожидается RED`,
        );
        expect(text).toContain(
            `2. ${PLAN.steps[1].do} — проверка: ${PLAN.steps[1].check} — ожидается GREEN`,
        );
    });
});

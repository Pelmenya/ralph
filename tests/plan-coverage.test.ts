import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    coverageIds,
    coveragePhases,
    coverageProblems,
    criteriaIds,
    criteriaSizeProblems,
    MAX_CRITERIA_PER_PHASE,
} from './plan-coverage.ts';

const PRD = [
    '## S2a. Раздел без номеров',
    '',
    '### Критерии готовности',
    '',
    '- [ ] Критерий без номера.',
    '',
    '## S2b. Раздел с номерами',
    '',
    '### Критерии готовности',
    '',
    '- [ ] [S2b.1] Первый критерий.',
    '- [x] [S2b.2] Второй критерий.',
    '',
    '### Другой список',
    '',
    '- [ ] [S2b.99] Не критерий готовности.',
].join('\n');

const PLAN = [
    '### Покрытие по критерию',
    '',
    '| Критерий | Фаза | Задача |',
    '| -------- | ---- | ------ |',
    '| [S2b.1] | 20 | Первая |',
    '| [S2b.2] | 20 | Вторая |',
].join('\n');

describe('покрытие критериев PRD планом фаз', () => {
    it('читает отмеченные и неотмеченные критерии только из своего раздела', () => {
        expect(criteriaIds(PRD).get('S2b')).toEqual(['S2b.1', 'S2b.2']);
    });

    it('читает номера из первой колонки таблицы покрытия', () => {
        expect(coverageIds(PLAN)).toEqual(['S2b.1', 'S2b.2']);
    });

    it('называет критерий без строки покрытия', () => {
        const plan = PLAN.replace('\n| [S2b.2] | 20 | Вторая |', '');

        expect(coverageProblems(PRD, plan)).toEqual(['[S2b.2] нет строки покрытия']);
    });

    it('называет номер покрытия, которого нет в PRD', () => {
        const plan = `${PLAN}\n| [S9.1] | 20 | Лишняя |`;

        expect(coverageProblems(PRD, plan)).toEqual(['[S9.1] нет в критериях PRD']);
    });

    it('называет номер, встреченный в покрытии дважды', () => {
        const plan = `${PLAN}\n| [S2b.1] | 21 | Дубль |`;

        expect(coverageProblems(PRD, plan)).toEqual(['[S2b.1] повторяется в покрытии']);
    });

    it('раздел без номеров критериев не проверяет', () => {
        const prd = ['## S2a. Без номеров', '### Критерии готовности', '- [ ] Без номера.'].join(
            '\n',
        );

        expect(coverageProblems(prd, '')).toEqual([]);
    });

    it('игнорирует критерии и строки покрытия внутри fenced-блоков', () => {
        const prd = [
            '## S9. Примеры',
            '### Критерии готовности',
            '- [ ] [S9.1] Настоящий критерий.',
            '  ```md',
            '- [ ] [S9.2] Критерий из примера.',
            '  ```',
            '  ~~~text',
            '- [ ] [S9.3] Критерий из другого примера.',
            '  ~~~~~',
            '  ````markdown',
            '- [ ] [S9.4] Критерий из примера с длинной оградой.',
            '  ````',
            '- [ ] [S9.5] Ещё один настоящий критерий.',
        ].join('\n');
        const plan = [
            '### Покрытие по критерию',
            '| [S9.1] | 20 | Настоящая строка |',
            '~~~md',
            '| [S9.2] | 20 | Пример |',
            '| [S9.1] | 20 | Дубль из примера |',
            '~~~~',
            '   ```text',
            '| [S9.99] | 20 | Лишний ID из примера |',
            '   ```',
            '| [S9.5] | 20 | Ещё одна настоящая строка |',
        ].join('\n');

        expect(criteriaIds(prd).get('S9')).toEqual(['S9.1', 'S9.5']);
        expect(coverageIds(plan)).toEqual(['S9.1', 'S9.5']);
        expect(coverageProblems(prd, plan)).toEqual([]);
    });

    it('игнорирует fenced-блоки внутри вложенных списков', () => {
        const prd = [
            '## S9. Примеры',
            '### Критерии готовности',
            '- [ ] [S9.1] Настоящий критерий до unordered-примера.',
            '- Пример:',
            '    ```md',
            '    - [ ] [S9.2] Критерий из unordered-примера.',
            '    ```',
            '- [ ] [S9.3] Настоящий критерий после unordered-примера.',
            '1. Пример:',
            '    1. Вложенный пример:',
            '        ~~~~text',
            '        - [ ] [S9.4] Критерий из вложенного ordered-примера.',
            '        ~~~~',
            '- [ ] [S9.5] Настоящий критерий после вложенного примера.',
            '',
            'Обычный indented code вне списка:',
            '    ~~~md',
            '    - [ ] [S9.6] Строка обычного indented code.',
            '    ~~~',
            '- [ ] [S9.7] Настоящий критерий после indented code.',
        ].join('\n');
        const plan = [
            '### Покрытие по критерию',
            '| [S9.1] | 20 | Настоящая строка |',
            '- Пример:',
            '    ```md',
            '    | [S9.2] | 20 | Лишний ID из unordered-примера |',
            '    | [S9.1] | 20 | Дубль из unordered-примера |',
            '    ```',
            '| [S9.3] | 20 | Настоящая строка |',
            '1. Пример:',
            '    1. Вложенный пример:',
            '        ~~~~md',
            '        | [S9.4] | 20 | Лишний ID из вложенного примера |',
            '        | [S9.99] | 20 | Ещё один лишний ID |',
            '        ~~~~',
            '| [S9.5] | 20 | Настоящая строка |',
            '',
            'Обычный indented code вне списка:',
            '    ~~~md',
            '    | [S9.7] | 20 | Строка обычного indented code |',
            '    ~~~',
            '| [S9.7] | 20 | Настоящая строка после indented code |',
        ].join('\n');

        expect(criteriaIds(prd).get('S9')).toEqual(['S9.1', 'S9.3', 'S9.5', 'S9.6', 'S9.7']);
        expect(coverageIds(plan)).toEqual(['S9.1', 'S9.3', 'S9.5', 'S9.7', 'S9.7']);
        expect(coverageProblems(prd, plan)).toEqual([
            '[S9.6] нет строки покрытия',
            '[S9.7] повторяется в покрытии',
        ]);
    });
});

const rows = (phase: string, n: number): string =>
    Array.from({ length: n }, (_, i) => `| [S9.${i + 1}] | ${phase} | Задача |`).join('\n');
const planOf = (body: string): string =>
    ['### Покрытие по критерию', '', '| Критерий | Фаза | Задача |', '| - | - | - |', body].join(
        '\n',
    );

describe('предел критериев на фазу', () => {
    it('считает строки по второй колонке', () => {
        const plan = planOf(`${rows('30', 2)}\n| [S8.1] |  31 | X |`);

        expect(coveragePhases(plan)).toEqual(
            new Map([
                ['30', 2],
                ['31', 1],
            ]),
        );
    });

    it('13 критериев — причина с фазой и числом', () => {
        expect(criteriaSizeProblems(planOf(rows('30', MAX_CRITERIA_PER_PHASE + 1)))).toEqual([
            `Фаза 30: ${MAX_CRITERIA_PER_PHASE + 1} критериев PRD — больше ${MAX_CRITERIA_PER_PHASE}, дели фазу`,
        ]);
    });

    it('предельное число критериев — без причин', () => {
        expect(criteriaSizeProblems(planOf(rows('30', MAX_CRITERIA_PER_PHASE)))).toEqual([]);
    });

    it('долг пропускает ровно свой счёт', () => {
        expect(criteriaSizeProblems(planOf(rows('24', 21)), { '24': 21 })).toEqual([]);
        expect(criteriaSizeProblems(planOf(rows('24', 20)), { '24': 21 })).toHaveLength(1);
        expect(criteriaSizeProblems(planOf(rows('24', 22)), { '24': 21 })).toHaveLength(1);
    });

    it.each(['24, 25', '24/25', '24 25'])('ячейка фазы %j — не один токен, красный', (cell) => {
        const problems = criteriaSizeProblems(planOf(rows(cell, 1)));

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('не один номер фазы');
    });

    it('фаза из долга без строк — причина', () => {
        expect(criteriaSizeProblems(planOf(rows('30', 1)), { '24': 21 })).toHaveLength(1);
    });

    it('строки внутри ограды кода не считаются', () => {
        const plan = planOf(`\`\`\`\n${rows('30', MAX_CRITERIA_PER_PHASE + 1)}\n\`\`\``);

        expect(criteriaSizeProblems(plan)).toEqual([]);
    });
});

describe('настоящие PRD и план фаз', () => {
    const prd = readFileSync(resolve(import.meta.dirname, '../docs/roadmap/prd.md'), 'utf-8');
    const plan = readFileSync(resolve(import.meta.dirname, '../docs/roadmap/plan.md'), 'utf-8');

    it('раздел S2b найден со всеми 14 критериями', () => {
        expect(criteriaIds(prd).get('S2b')).toHaveLength(14);
    });

    it('каждый номер покрыт ровно одной строкой, лишних номеров нет', () => {
        expect(coverageProblems(prd, plan)).toEqual([]);
    });

    // Долг: фазы вошли в петлю до предела; число сверяется равенством.
    const DEBT = {
        '24': 21, // резка до предела: 21 критерий, ветка +8,3 тыс. строк
        '25': 17, // резка до предела
    };

    it('критериев на фазу не больше предела, кроме долга', () => {
        expect(criteriaSizeProblems(plan, DEBT)).toEqual([]);
    });
});

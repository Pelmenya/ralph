// Ограничение размера жило только в промпте: крупная фаза могла дойти до ревью,
// в которое уже не помещалась. Решение человека 03.11 допускает 6–7 задач только
// с записью в самой фазе; прежний долг фиксируем числом, чтобы он не мог расти молча.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DEBT: Record<string, number> = {
    // На d014af1 девять задач уже были в плане, карточки под hold; фазу предстоит разделить.
    'Фаза 17': 9,
};

type PhaseSize = { name: string; tasks: number; humanDecision: boolean };
const TASK = /^- \[[ x]\] /;

export function phaseSizes(plan: string): PhaseSize[] {
    const phases: PhaseSize[] = [];
    for (const section of plan.split(/(?=^#{2,3} )/m)) {
        const lines = section.split(/\r?\n/);
        const name = lines[0].match(/^### (Фаза \d[^:\s]*): /)?.[1];
        if (name === undefined) continue;
        const start = lines.findIndex((line) => line.trimEnd() === '**Задачи:**');
        if (start === -1) continue;

        let tasks = 0;
        for (let i = start + 1; i < lines.length; i++) {
            const line = lines[i];
            if (/^\*\*[^\n]+:\*\*/.test(line)) break;
            if (line.trim() === '' && tasks > 0) {
                // В Фазе 17 пустая строка разделяет пункты одного списка. Конец
                // списка — пустая строка, после которой задачи уже не продолжаются.
                let next = i + 1;
                while (next < lines.length && lines[next].trim() === '') next++;
                if (!TASK.test(lines[next] ?? '')) break;
            }
            if (TASK.test(line)) tasks++;
        }
        phases.push({
            name,
            tasks,
            humanDecision: lines
                .slice(1)
                .some(
                    (line) => line.startsWith('**Размер:**') && line.includes('решение человека'),
                ),
        });
    }
    return phases;
}

export function phaseSizeProblems(plan: string, debt: Record<string, number> = {}): string[] {
    const phases = phaseSizes(plan);
    const problems: string[] = [];
    if (!phases.some((phase) => phase.tasks > 0)) {
        problems.push(
            'В плане нет ни одной фазы с задачами — проверь заголовки фаз и **Задачи:**.',
        );
    }
    for (const [name, expected] of Object.entries(debt)) {
        if (!phases.some((phase) => phase.name === name)) {
            problems.push(
                `${name}: фаза с задачами не найдена (в DEBT ${expected} задач) — убери строку DEBT или восстанови фазу.`,
            );
        }
    }
    for (const { name, tasks, humanDecision } of phases) {
        const expected = debt[name];
        if (expected !== undefined) {
            if (tasks !== expected) {
                problems.push(
                    `${name}: ${tasks} задач, в DEBT ${expected} — число изменилось: выросло — дели фазу; уменьшилось — опусти или убери строку DEBT.`,
                );
            }
        } else if (tasks > 7) {
            problems.push(
                `${name}: ${tasks} задач — больше 7 нельзя даже по решению человека; дели фазу.`,
            );
        } else if (tasks > 5 && !humanDecision) {
            problems.push(
                `${name}: ${tasks} задач — дели фазу до 5 или запиши решение человека строкой **Размер:** в теле этой фазы.`,
            );
        }
    }
    return problems;
}

function planWithTasks(count: number, size = '', name = 'Фаза 1'): string {
    return [
        `### ${name}: Проверка`,
        '',
        size,
        '**Задачи:**',
        '',
        ...Array.from({ length: count }, (_, i) => `- [ ] Задача ${i + 1}`),
        '',
        '**Когда готова:** проверено.',
    ].join('\n');
}

describe('размер фазы — барьер', () => {
    it('5 задач проходят без решения человека', () => {
        expect(phaseSizeProblems(planWithTasks(5))).toEqual([]);
    });

    it('6 задач без решения называют фазу, число и способ исправления', () => {
        expect(phaseSizeProblems(planWithTasks(6))).toEqual([
            'Фаза 1: 6 задач — дели фазу до 5 или запиши решение человека строкой **Размер:** в теле этой фазы.',
        ]);
    });

    it.each([6, 7])('%i задач с решением человека проходят', (count) => {
        expect(
            phaseSizeProblems(
                planWithTasks(count, `**Размер:** ${count} задач — решение человека 03.11.`),
            ),
        ).toEqual([]);
    });

    it('7 задач со строкой без слов «решение человека» не проходят', () => {
        expect(phaseSizeProblems(planWithTasks(7, '**Размер:** 7 задач.'))).toEqual([
            expect.stringContaining('Фаза 1: 7 задач — дели фазу до 5'),
        ]);
    });

    it('8 задач не проходят даже с решением человека', () => {
        expect(phaseSizeProblems(planWithTasks(8, '**Размер:** решение человека 03.11.'))).toEqual([
            'Фаза 1: 8 задач — больше 7 нельзя даже по решению человека; дели фазу.',
        ]);
    });

    it('DEBT разрешает только точное историческое число', () => {
        expect(phaseSizeProblems(planWithTasks(9, '', 'Фаза 17'), DEBT)).toEqual([]);
    });

    it.each([5, 8, 10])('DEBT краснеет при изменении числа до %i', (count) => {
        expect(phaseSizeProblems(planWithTasks(count, '', 'Фаза 17'), DEBT)).toEqual([
            `Фаза 17: ${count} задач, в DEBT 9 — число изменилось: выросло — дели фазу; уменьшилось — опусти или убери строку DEBT.`,
        ]);
    });

    it('DEBT на отсутствующую фазу не проходит', () => {
        expect(phaseSizeProblems(planWithTasks(5), DEBT)).toEqual([
            'Фаза 17: фаза с задачами не найдена (в DEBT 9 задач) — убери строку DEBT или восстанови фазу.',
        ]);
    });

    it.each(['', '# План\n- [ ] Задача', '### Фаза 1: Набросок\n- [ ] Задача', planWithTasks(0)])(
        'план без фаз с задачами не проходит: %s',
        (plan) => {
            expect(phaseSizeProblems(plan)).toEqual([
                'В плане нет ни одной фазы с задачами — проверь заголовки фаз и **Задачи:**.',
            ]);
        },
    );

    it('выполненные задачи считаются наравне с невыполненными', () => {
        const plan = planWithTasks(6).replace('- [ ] Задача 1', '- [x] Задача 1');
        expect(phaseSizes(plan)[0].tasks).toBe(6);
        expect(phaseSizeProblems(plan)).toHaveLength(1);
    });

    it('пустые строки между задачами не скрывают превышение', () => {
        const plan = planWithTasks(6).replace('- [ ] Задача 4', '\n\n- [ ] Задача 4');
        expect(phaseSizes(plan)[0].tasks).toBe(6);
        expect(phaseSizeProblems(plan)).toHaveLength(1);
    });

    it.each(['\n\nТекст после списка\n', '\n**Проверки:**\n'])(
        'список заканчивается на %j',
        (end) => {
            const plan = `${planWithTasks(5).split('\n\n**Когда готова:**')[0]}${end}- [ ] Не задача фазы`;
            expect(phaseSizes(plan)[0].tasks).toBe(5);
            expect(phaseSizeProblems(plan)).toEqual([]);
        },
    );

    it('задачи перед **Задачи:** и фазы без этого заголовка не считаются', () => {
        const plan = [
            '### Фаза 0: Набросок',
            '- [ ] Не задача',
            planWithTasks(5).replace('**Задачи:**', '- [ ] Не задача\n\n**Задачи:**'),
        ].join('\n');
        expect(phaseSizes(plan)).toEqual([{ name: 'Фаза 1', tasks: 5, humanDecision: false }]);
    });

    it.each(['### Другой раздел', '## Другой раздел'])('фаза заканчивается перед %s', (heading) => {
        const plan = `${planWithTasks(5).split('\n\n**Когда готова:**')[0]}\n${heading}\n- [ ] Не задача\n**Размер:** решение человека`;
        expect(phaseSizes(plan)).toEqual([{ name: 'Фаза 1', tasks: 5, humanDecision: false }]);
    });

    it('решение соседней фазы не разрешает превышение', () => {
        const plan = [
            planWithTasks(6, '**Размер:** решение человека', 'Фаза 16b'),
            planWithTasks(6, '', 'Фаза 16c2'),
        ].join('\n');
        expect(phaseSizeProblems(plan)).toEqual([
            expect.stringContaining('Фаза 16c2: 6 задач — дели фазу до 5'),
        ]);
    });

    it('решение должно начинать строку и содержаться в ней целиком', () => {
        for (const size of [
            'Текст **Размер:** решение человека',
            '**Размер:** 6 задач\nрешение человека',
        ]) {
            expect(phaseSizeProblems(planWithTasks(6, size))).toHaveLength(1);
        }
    });

    it('решение после списка тоже относится к телу фазы', () => {
        expect(phaseSizeProblems(`${planWithTasks(6)}\n**Размер:** решение человека`)).toEqual([]);
    });
});

describe('настоящий план фаз', () => {
    it('размеры укладываются в правило и точный исторический долг', () => {
        const plan = readFileSync(resolve(import.meta.dirname, '../docs/roadmap/plan.md'), 'utf-8');
        expect(phaseSizeProblems(plan, DEBT)).toEqual([]);
    });
});

// Задача 73: сессии сдачи канона стартуют на ветке фазы. Гейт паркует дерево детачем, и
// сессия, запущенная без проводки, коммитит в никуда — работа достижима только по SHA.
// Структурное правило «проводка до каждой пишущей сессии» сторожит core/phase-branch.test.ts
// по исходнику; здесь то же доказано прогоном runLoop для разбора blocked и чини-сессии
// гейта. Две сессии правок (по ревью и по ревью правок) — в review-of-fixes-scenarios:
// их лестницу умеет гонять только тамошняя обвязка.
//
// Каждый кейс — два прогона. Зелёный находит последнюю проводку перед сессией, второй
// роняет именно её: сессия не запускается, а стоп называет её место. Одного зелёного мало:
// проводка итерации стоит раньше при том же числе сессий, и без своей проводки сессия
// всё равно казалась бы «поставленной».
import { describe, it, expect } from 'vitest';
import { makeRunLoopScenario as scenario } from './test-helpers.ts';

const RED_CHECK = { name: 'test', cmd: 'npm run test', excerpt: 'boom' };

type TVerdict = Parameters<ReturnType<typeof scenario>['pass']>[0];

const promptsOf = (s: ReturnType<typeof scenario>): string[] =>
    s.runClaudeFn.mock.calls.map((c: unknown[]) => String(c[0]));

const CASES: Array<{
    name: string;
    where: string;
    verdict: TVerdict;
    isSession: (p: string) => boolean;
    budget: 'blockedHeals' | 'gateHeals';
}> = [
    {
        name: 'разбор blocked',
        where: '(разбор blocked)',
        verdict: 'blocked',
        isSession: (p) => /метку blocked снять ты не можешь/i.test(p),
        budget: 'blockedHeals',
    },
    {
        name: 'чини-сессия гейта',
        where: '(чини-сессия гейта)',
        verdict: 'red-checks',
        isSession: (p) => p.includes(RED_CHECK.excerpt),
        budget: 'gateHeals',
    },
];

describe.each(CASES)('задача 73: $name стартует на ветке фазы', (c) => {
    const green = () => {
        const s = scenario();
        s.pass(c.verdict, { redCheck: RED_CHECK });
        const at = promptsOf(s).findIndex(c.isSession);
        return {
            at,
            call: s.placements.reduce((last, count, index) => (count <= at ? index : last), -1),
        };
    };

    // Здесь сессия первая в проходе, и «после предыдущей» проверять не на чем: зелёный
    // кейс лишь находит проводку перед ней. Что это проводка ИМЕННО этой сессии, а не
    // итерации, доказывает только кейс ниже.
    it('в зелёном прогоне перед сессией есть проводка', () => {
        const { at, call } = green();
        expect(at).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(-1);
    });

    it('отказ ЕЁ проводки → сессия не запущена, стоп называет её, бюджет цел', () => {
        const { call } = green();
        const s = scenario({}, { failPlacementCall: call });
        s.pass(c.verdict, { redCheck: RED_CHECK });
        expect(promptsOf(s).some(c.isSession)).toBe(false);
        expect(s.pushTexts().some((t) => t.includes(c.where))).toBe(true);
        // Бюджет — число ЗАПУЩЕННЫХ сессий: отказ проводки его не тратит.
        expect(s.state[c.budget]).toBe(0);
    });
});

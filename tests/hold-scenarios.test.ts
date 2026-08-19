// Приёмочные (сценарные) тесты метки hold (#222, следствие #217) — доказательство
// критериев готовности через ВЕСЬ цикл гейта end-to-end, а не по кускам. Образец —
// blocked-scenarios.test.ts, та же модель «прохода раннера»: один вызов runLoop = одно
// детерминированное срабатывание гейта, state переносится между проходами как на диске.
//
// Проверяются ровно сценарии из критериев Issue #222:
//   • hold → стоп + пуш, без разбора, без чини-сессий, без повторного ревью;
//   • hold и blocked одновременно → hold сильнее, стоп без разбора (негативный тест);
//   • hold не снимается раннером ни на одном пути — даже после полного круга разбора
//     blocked метка (в данном случае имитирующая hold, поставленный человеком параллельно)
//     остаётся нетронутой: единственная функция снятия метки в коде (removeBlockedLabelFn)
//     зовётся ТОЛЬКО с именем 'blocked', hold она не видит и не трогает.
//
// Побочки запрещены (RALPH_NO_SIDE_EFFECTS=1, guardSideEffect, общий afterEach в
// test-setup.ts): все коллабораторы с побочками — фейки через DI, ни одного реального
// вызова gh или сети.
//
// Оркестратор сценария (makeRunLoopScenario) вынесен в test-helpers.ts (#223) — общий с
// blocked-scenarios.test.ts. Здесь остаются только hold-специфичные describe.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import { makeRunLoopScenario as scenario } from './test-helpers.ts';

describe('hold: стоп + пуш, без разбора, без чини-сессий, без повторного ревью', () => {
    it('гейт hold → ни одной сессии, счётчики не тронуты, ровно один пуш с PR', () => {
        const s = scenario();
        s.pass('hold');
        expect(s.runClaudeFn).not.toHaveBeenCalled();
        expect(s.removeBlockedLabelFn).not.toHaveBeenCalled();
        expect(s.state.blockedHeals).toBe(0);
        expect(s.state.gateHeals).toBe(0);
        expect(s.pushTexts()).toHaveLength(1);
        expect(s.pushTexts()[0]).toContain('#777');
        expect(s.pushTexts()[0]).toMatch(/hold/);
        expect(s.pushTexts()[0]).toMatch(/человек/);
    });
});

describe('hold и blocked одновременно: hold сильнее — стоп без разбора (негативный тест)', () => {
    // tryMergePhase проверяет hold РАНЬШЕ blocked (юнит-тест в ralph.test.js), поэтому
    // при обеих метках на PR гейт вернёт 'hold', и runLoop обязан пойти веткой hold, а
    // НЕ веткой blocked (никакого разбора, никакого инкремента blockedHeals).
    it('гейт вернул hold (PR помечен и hold, и blocked) → разбор blocked не запускается', () => {
        const s = scenario();
        s.pass('hold');
        expect(s.runClaudeFn).not.toHaveBeenCalled();
        expect(s.state.blockedHeals).toBe(0);
        expect(s.pushTexts().some((t) => /устоял|снят автоматически/.test(t))).toBe(false);
    });
});

describe('hold не снимается раннером ни на одном пути', () => {
    // Полный круг успешного разбора blocked: раннер сам чинит, сам снимает label blocked
    // (removeBlockedLabelFn), гоняет повторное ревью. Дальше — параллельно человек ставит
    // hold на тот же PR. Следующий проход должен увидеть hold и остановиться, а
    // removeBlockedLabelFn НЕ должен получить ни одного вызова с 'hold' (в коде такой
    // функции нет вовсе — barrier проверяется тем, что мок ни разу не позвался снова).
    it('после круга разбора blocked (снятие label + повторное ревью) hold остаётся нетронутым', () => {
        const s = scenario();
        s.pass('blocked'); // ревью поставило блок → раунд разбора
        expect(s.removeBlockedLabelFn).toHaveBeenCalledTimes(1);
        expect(s.removeBlockedLabelFn.mock.calls[0][0]).toBe('feature/m1');
        expect(s.state.blockedHeals).toBe(1);
        const claudeCallsAfterBlocked = s.runClaudeFn.mock.calls.length;

        s.pass('hold'); // человек параллельно поставил hold на тот же PR
        // Ни одна сессия не добавилась (hold стоп без разбора), removeBlockedLabelFn не
        // вызывался снова — раннер не имеет ветки, которая снимала бы hold.
        expect(s.runClaudeFn.mock.calls.length).toBe(claudeCallsAfterBlocked);
        expect(s.removeBlockedLabelFn).toHaveBeenCalledTimes(1);
        // Счётчик разбора blocked не тронут этим проходом — гейт не переоценивал blocked.
        expect(s.state.blockedHeals).toBe(1);
        expect(s.pushTexts().some((t) => /снят автоматически/.test(t))).toBe(false);
        expect(s.pushTexts().some((t) => /hold/.test(t) && /человек/.test(t))).toBe(true);
    });
});

describe('побочки в тестах запрещены (RALPH_NO_SIDE_EFFECTS / guardSideEffect / DI)', () => {
    it('окружение теста ralph держит предохранитель включённым', () => {
        expect(process.env.RALPH_NO_SIDE_EFFECTS).toBe('1');
    });

    it('полный прогон сценария hold не делает ни одной боевой побочки (gh/сеть/state)', () => {
        const s = scenario();
        s.pass('blocked');
        s.pass('hold');
        expect(ralph.sideEffectAttempts).toEqual([]);
    });
});

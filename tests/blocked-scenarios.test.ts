// Приёмочные (сценарные) тесты разбора blocked (#219, часть #215) — доказательство
// критериев готовности фазы 3 «разбор blocked без человека» через ВЕСЬ цикл сдачи
// end-to-end, а не по кускам. Образец — deadman-scenarios.test.ts.
//
// Юнит-тесты живут рядом в ralph.test.js (describe «runLoop …»): там проверяется ОДИН
// проход гейта (инкремент счётчика, снятие метки раннером, планка reviewModelFloor,
// пуши #216/#217/#218). Здесь другой уровень: реальный runLoop гоняется несколько
// «проходов раннера» подряд, состояние (state) переносится между ними как на диске, и
// проверяются ровно те сквозные сценарии, что в критериях Issue #219:
//   • блокер устранён с первой попытки → метка снята → гейт → мердж, человека нет;
//   • блокер не устраняется: три ревью подряд ставят блок → стоп + пуш, мерджа нет;
//   • чередование блок→чисто: разбор завершается, счётчик до стопа не доходит;
//   • перезапуск раннера посреди разбора: счётчик не обнулился, лимит по-прежнему близок.
//
// Модель «прохода раннера»: один вызов runLoop = одно детерминированное срабатывание
// гейта. phaseIndexOfFn отдаёт валидный индекс на 1-м обращении и «за концом» на 2-м,
// поэтому каждый проход упирается в break (blocked→continue→конец фаз; merged→advance→
// конец фаз) — ровно как настоящий while-цикл переоценивает гейт на следующем витке.
// Один и тот же объект state переживает все проходы: это и есть «диск, переживший
// перезапуск» (крит. 4 отдельно пересобирает state из последнего saveState-снимка).
//
// Побочки запрещены и здесь (RALPH_NO_SIDE_EFFECTS=1, guardSideEffect, общий afterEach
// в test-setup.ts): все коллабораторы с побочками (sh/gh/сеть/state/runClaude/снятие
// метки) инжектированы фейками через DI — ни одного реального вызова gh или сети.
//
// Оркестратор сценария (makeRunLoopScenario) и константы вынесены в test-helpers.ts
// (#223) — общие с hold-scenarios.test.ts: правку сигнатуры deps runLoop синхронизируем
// в одном месте. Здесь остаются только сценарные describe этого файла.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import {
    makeRunLoopScenario as scenario,
    SCENARIO_REVIEW_MODEL as REVIEW_MODEL,
    SCENARIO_B_MAX as B_MAX,
} from './test-helpers.ts';

const RED_CHECK = { name: 'test', cmd: 'npm run test', excerpt: 'boom' };

describe('блокер устранён с первой попытки → метка снята → гейт → мердж, человек не участвует', () => {
    // Ревью поставило блок. Проход 1: раннер чинит, сам снимает метку, гоняет повторное
    // ревью — оно блок НЕ вешает (блокер устранён). Проход 2: гейт видит PR без метки и
    // мерджит. Ни одного пуша-обращения к человеку — вся петля прошла автономно.
    it('blocked → чисто → merged: разбор+снятие метки раннером, затем мердж без человека', () => {
        const s = scenario();
        s.pass('blocked'); // ревью поставило блок → раунд разбора
        expect(s.state.blockedHeals).toBe(1);
        // Раунд разбора = чини-сессия + повторное ревью раннера (две сессии), снятие
        // метки — раннером (не кодер-сессией), планка встала по модели, поставившей блок.
        expect(s.runClaudeFn).toHaveBeenCalledTimes(2);
        expect(s.removeBlockedLabelFn).toHaveBeenCalledTimes(1);
        expect(s.removeBlockedLabelFn.mock.calls[0][0]).toBe('feature/m1');
        expect(s.state.reviewModelFloor).toBe(REVIEW_MODEL);

        s.pass('merged'); // повторное ревью блок не вернуло → гейт мерджит
        expect(s.state.blockedHeals).toBe(0); // счётчик обнулён по факту снятия блока

        const pushes = s.pushTexts();
        // Крит. 1: «снят автоматически» — отдельное событие (PR + модель ревью).
        expect(pushes.some((t) => /снят автоматически/.test(t))).toBe(true);
        expect(pushes.some((t) => /снят автоматически/.test(t) && t.includes('#777'))).toBe(true);
        expect(pushes.some((t) => /снят автоматически/.test(t) && t.includes(REVIEW_MODEL))).toBe(
            true,
        );
        // Фаза действительно доехала до мерджа.
        expect(pushes.some((t) => /смерджена в main/.test(t))).toBe(true);
        // Человек не участвует: ни одного обращения «оставлен человеку»/«устоял».
        expect(pushes.some((t) => /оставлен человеку|устоял/.test(t))).toBe(false);
    });
});

describe('блокер не устраняется → три ревью подряд ставят блок → стоп + пуш, мерджа нет', () => {
    // Каждое повторное ревью раннера снова находит блокер и вешает метку. Счётчик
    // считает ПОДРЯД идущие ревью, оставившие блок; на bMax-м (3) раннер прекращает
    // разбор и отдаёт PR человеку. Мерджа быть не должно.
    it('blocked×3 копят счётчик, 4-й проход упирается в лимит → стоп человеку, без мерджа', () => {
        const s = scenario();
        s.pass('blocked'); // ревью №1 оставило блок
        expect(s.state.blockedHeals).toBe(1);
        s.pass('blocked'); // ревью №2 оставило блок
        expect(s.state.blockedHeals).toBe(2);
        s.pass('blocked'); // ревью №3 оставило блок — лимит достигнут
        expect(s.state.blockedHeals).toBe(3);

        // Пока ещё ни одного стоп-пуша: три ревью только-только набрали лимит.
        expect(s.pushTexts().some((t) => /устоял/.test(t))).toBe(false);

        s.pass('blocked'); // следующий проход видит bDone>=bMax → стоп
        const stop = s.pushTexts().filter((t) => /устоял/.test(t));
        expect(stop).toHaveLength(1);
        // Крит. 2 (#218): текст называет число ревью, PR и версию про зацикливание.
        expect(stop[0]).toContain('#777');
        expect(stop[0]).toMatch(/3 повторных ревью/);
        expect(stop[0]).toMatch(/оставлен человеку/);
        // Счётчик сброшен (фаза ушла человеку), мерджа не было.
        expect(s.state.blockedHeals).toBe(0);
        expect(s.pushTexts().some((t) => /смерджена в main/.test(t))).toBe(false);
    });
});

describe('чередование блок→чисто → разбор завершается, счётчик до стопа не доходит', () => {
    // Блок, затем чистое повторное ревью (гейт дошёл до чеков = метки нет). Счётчик
    // ПОДРЯД идущих блок-ревью обнуляется на чистом круге, поэтому чередование
    // «блок → чисто → блок → чисто» никогда не набирает три подряд и не дёргает человека.
    it('blocked→red-checks→blocked→merged: счётчик сбрасывается, стопа нет, фаза мерджится', () => {
        const s = scenario();
        s.pass('blocked'); // блок
        expect(s.state.blockedHeals).toBe(1);
        s.pass('red-checks', { redCheck: RED_CHECK }); // чистое ревью (метки нет) + красный чек
        expect(s.state.blockedHeals).toBe(0); // сброс: блок-ревью прервалось
        s.pass('blocked'); // снова блок — но счёт с нуля, не с двух
        expect(s.state.blockedHeals).toBe(1);
        s.pass('merged'); // и наконец чисто → мердж

        // Счётчик ни разу не доходил до лимита — чередование его не копит (#216).
        expect(s.maxBlockedHeals()).toBeLessThan(B_MAX);
        const pushes = s.pushTexts();
        expect(pushes.some((t) => /устоял|оставлен человеку/.test(t))).toBe(false);
        expect(pushes.some((t) => /смерджена в main/.test(t))).toBe(true);
    });
});

describe('перезапуск раннера посреди разбора → счётчик не обнулился, лимит по-прежнему близок', () => {
    // Разбор идёт (два ревью подряд оставили блок → счётчик 2), раннер убит и поднят
    // заново: state читается с диска (последний saveState-снимок). Счётчик обязан быть
    // 2, планка reviewModelFloor — сохранена; следующее блок-ревью упирается в лимит, а
    // не начинает счёт заново. Иначе перезапуск был бы лазейкой обнулить лимит.
    it('счётчик и планка переживают перезапуск: bDone=2 → лимит в одном проходе', () => {
        const s = scenario();
        s.pass('blocked'); // ревью №1 оставило блок
        s.pass('blocked'); // ревью №2 оставило блок → счётчик 2
        expect(s.state.blockedHeals).toBe(2);

        // Перезапуск: пересобираем state из последнего снимка на «диске».
        const restored = s.restart();
        expect(restored.blockedHeals).toBe(2); // не обнулился
        expect(restored.reviewModelFloor).toBe(REVIEW_MODEL); // планка эскалации сохранена

        s.pass('blocked'); // ревью №3 после перезапуска → лимит достигнут
        expect(s.state.blockedHeals).toBe(B_MAX);

        // «Лимит по-прежнему близок»: ещё один блок-проход уже упирается в стоп человеку.
        s.pass('blocked');
        expect(s.pushTexts().some((t) => /устоял/.test(t))).toBe(true);
    });
});

describe('побочки в тестах запрещены (крит. 5: RALPH_NO_SIDE_EFFECTS / guardSideEffect / DI)', () => {
    it('окружение теста ralph держит предохранитель включённым', () => {
        expect(process.env.RALPH_NO_SIDE_EFFECTS).toBe('1');
    });

    it('полный прогон сценария не делает ни одной боевой побочки (gh/сеть/state)', () => {
        // Все коллабораторы с побочками инжектированы фейками — журнал попыток
        // guardSideEffect обязан остаться пустым (общий afterEach сверит его и сам).
        const s = scenario();
        s.pass('blocked');
        s.pass('merged');
        expect(ralph.sideEffectAttempts).toEqual([]);
    });
});

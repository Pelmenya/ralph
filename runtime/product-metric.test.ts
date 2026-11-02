import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON_TITLES, type TStopReason } from '../core/stop-message.ts';
import {
    classifyGateLine,
    formatMetricDayLine,
    formatMetricSummary,
    GATE_BARRIERS,
    parseLogEvents,
    resolveTaskBudgetMs,
    STOP_ROLES,
    summarizeTasks,
    type TMetricSummary,
} from './product-metric.ts';

const MIN = 60_000;

// Фикстура — строки той же формы, что пишет раннер (шаблоны сверяет последний блок файла).
// Сценарий за сутки 26.10, бюджет задачи 30 минут:
//   Фаза А: #1 и #2 взяты, #2 со второго захода; фаза смерджена в 10:40.
//           #1 взят в 10:00 → 40 мин до мерджа: сверх бюджета; #2 взят в 10:15 → 25 мин: в бюджет.
//   Фаза Б: #3 взят, встал breaker; после стопа фазу никто не продолжил → стоп breaker.
//           #4 помечен blocked сессией.
//   Фаза В: #5 закрыт, затем красный гейт (строка гейта и стоп по тому же событию), но петлю
//           перезапустили, и фаза продолжилась задачей #6 — стоп для #5 уже не последнее
//           слово; фаза текущая в state → в работе. #6 в работе.
//   Фаза Г: #7 закрыт, фаза не смерджена, стопа нет, в state другая фаза → закрыта, фаза не
//           смерджена. #9 взят и не закрыт → исход неизвестен.
//   #8 взят вчера (вне периода) и в сводку не попадает.
const FIXTURE = [
    '[2026-10-25T09:00:00.000Z] 🔄 Фаза Г | итерация 1/10 | Issue #8: вчерашняя | модель: m (claude)',
    '[2026-10-26T09:59:00.000Z] 🚀 Ralph start | mode=AFK | dry=false | фаза "Фаза А" | submitted=false | итерация 0',
    '[2026-10-26T10:00:00.000Z] 🔄 Фаза А | итерация 1/10 | Issue #1: первая | модель: m (claude) | осталось: 2',
    '[2026-10-26T10:10:00.000Z] ✅ Issue #1 закрыт по просьбе сессии.',
    '[2026-10-26T10:15:00.000Z] 🔄 Фаза А | итерация 2/10 | Issue #2: вторая | модель: m (claude) | осталось: 1',
    '[2026-10-26T10:20:00.000Z] ⚠ claude завершился с кодом 1 — продолжаем',
    '[2026-10-26T10:21:00.000Z] 🔄 Фаза А | итерация 3/10 | Issue #2: вторая | модель: m (claude) | осталось: 1',
    '[2026-10-26T10:30:00.000Z] ✅ Issue #2 закрыт по просьбе сессии.',
    '[2026-10-26T10:40:00.000Z] 🔔 PUSH: ✅ Ralph: фаза "Фаза А" смерджена в main — готова к релизу.',
    '[2026-10-26T11:00:00.000Z] 🔄 Фаза Б | итерация 1/10 | Issue #4: блок | модель: m (claude) | осталось: 2',
    '[2026-10-26T11:05:00.000Z] ⛔ Issue #4 помечен blocked — ждёт человека.',
    '[2026-10-26T11:06:00.000Z] 🔄 Фаза Б | итерация 2/10 | Issue #3: стена | модель: m (claude) | осталось: 1',
    '[2026-10-26T11:30:00.000Z] 🔔 PUSH: ⛔ Ralph: circuit breaker — loop стоит об стену на фазе "Фаза Б". причина: circuit breaker (breaker). диагноз: 3 итераций подряд. вопрос человеку: разобрать',
    '[2026-10-26T11:30:01.000Z] 🏁 Ralph loop завершён.',
    '[2026-10-26T12:00:00.000Z] 🚀 Ralph start | mode=AFK | dry=false | фаза "Фаза В" | submitted=false | итерация 0',
    '[2026-10-26T12:01:00.000Z] 🔄 Фаза В | итерация 1/10 | Issue #5: до гейта | модель: m (claude) | осталось: 2',
    '[2026-10-26T12:10:00.000Z] ✅ Issue #5 закрыт по просьбе сессии.',
    '[2026-10-26T12:19:00.000Z] ⛔ Гейт: чек test красный на PR #5.',
    '[2026-10-26T12:20:00.000Z] 🔔 PUSH: ⛔ Ralph: PR оставлен человеку. причина: чек не зазеленел за отведённые чини-сессии (gate-red). диагноз: тесты. вопрос человеку: чинить',
    '[2026-10-26T12:30:00.000Z] 🚀 Ralph start | mode=AFK | dry=false | фаза "Фаза В" | submitted=false | итерация 1',
    '[2026-10-26T12:31:00.000Z] 🔄 Фаза В | итерация 2/10 | Issue #6: идёт | модель: m (claude) | осталось: 1',
    '[2026-10-26T13:00:00.000Z] 🔄 Фаза Г | итерация 1/10 | Issue #7: повисла | модель: m (claude) | осталось: 1',
    '[2026-10-26T13:10:00.000Z] ✅ Issue #7 закрыт по просьбе сессии.',
    '[2026-10-26T13:20:00.000Z] 🔄 Фаза Г | итерация 2/10 | Issue #9: без исхода | модель: m (claude) | осталось: 1',
].join('\n');

const SINCE = Date.parse('2026-10-26T00:00:00.000Z');
const UNTIL = Date.parse('2026-10-26T23:59:59.000Z');

function summary(overrides: Partial<Parameters<typeof summarizeTasks>[0]> = {}): TMetricSummary {
    return summarizeTasks({
        events: parseLogEvents(FIXTURE),
        budgetMs: 30 * MIN,
        since: SINCE,
        until: UNTIL,
        currentMilestone: 'Фаза В',
        ...overrides,
    });
}

function row(s: TMetricSummary, key: string) {
    return s.rows.find((r) => r.key === key);
}

describe('сводка по фикстуре лога', () => {
    it('доля задач, доведённых до мерджа в бюджет, и разбивка потерь', () => {
        const s = summary();
        expect(s.taken).toBe(8);
        expect(s.mergedInBudget).toBe(1);
        expect(s.share).toBeCloseTo(1 / 8);
        expect(
            Object.fromEntries(s.rows.filter((r) => r.count > 0).map((r) => [r.key, r.issues])),
        ).toEqual({
            'merged-in-budget': [2],
            'merged-over-budget': [1],
            blocked: [4],
            'stop:breaker': [3],
            'in-progress': [5, 6],
            'closed-unmerged': [7],
            unknown: [9],
        });
        // Сумма строк равна числу взятых: ни одна задача не пропала и не посчиталась дважды.
        expect(s.rows.reduce((n, r) => n + r.count, 0)).toBe(s.taken);
    });

    it('бюджет считается от ПЕРВОГО взятия задачи, а не от последнего захода', () => {
        // #2: первый заход 10:15, мердж 10:40 — 25 мин. От второго захода было бы 19 мин;
        // при бюджете 20 мин честный счёт уводит задачу сверх бюджета.
        const s = summary({ budgetMs: 20 * MIN });
        expect(row(s, 'merged-in-budget')?.issues).toEqual([]);
        expect(row(s, 'merged-over-budget')?.issues).toEqual([1, 2]);
    });

    it('неизвестный исход — отдельная строка, а не успех и не «в работе»', () => {
        const s = summary({ currentMilestone: null });
        // Без текущей фазы в state ни одна незавершённая задача не может быть «в работе».
        expect(row(s, 'in-progress')?.count ?? 0).toBe(0);
        // #5 и #7 закрыты — это известный факт; #6 и #9 не закрыты — исход неизвестен.
        expect(row(s, 'closed-unmerged')?.issues).toEqual([5, 7]);
        expect(row(s, 'unknown')?.issues).toEqual([6, 9]);
        expect(s.mergedInBudget).toBe(1);
    });

    it('стоп — последнее слово фазы, только если после него фазу никто не продолжил', () => {
        // Сутки обрезаны до перезапуска фазы В: красный гейт тогда — последнее событие.
        const s = summary({ until: Date.parse('2026-10-26T12:25:00.000Z') });
        expect(row(s, 'stop:gate-red')?.issues).toEqual([5]);
        expect(row(s, 'in-progress')?.count ?? 0).toBe(0);
    });

    it('события после конца периода исход не меняют', () => {
        const s = summary({ until: Date.parse('2026-10-26T10:35:00.000Z') });
        expect(s.taken).toBe(2);
        expect(row(s, 'merged-in-budget')?.count ?? 0).toBe(0);
        // Фаза А не текущая (в state — В), мерджа к 10:35 ещё не было: обе задачи закрыты.
        expect(row(s, 'closed-unmerged')?.issues).toEqual([1, 2]);
    });

    it('задача, взятая до периода, в счёт не входит', () => {
        expect(summary().rows.flatMap((r) => r.issues)).not.toContain(8);
    });

    it('пустой период — доля не определена, а не ноль и не сто процентов', () => {
        const s = summary({ since: UNTIL, until: UNTIL });
        expect(s.taken).toBe(0);
        expect(s.share).toBeNull();
        expect(formatMetricSummary(s)).toContain('задач не брали');
    });

    it('незнакомый код причины стопа — стоп с неустановленной причиной, а не потеря строки', () => {
        const text = [
            '[2026-10-26T10:00:00.000Z] 🔄 Ф | итерация 1/10 | Issue #9: x | модель: m (claude)',
            '[2026-10-26T10:05:00.000Z] 🔔 PUSH: ⛔ Ralph: что-то. причина: новое (something-new). диагноз: д.',
        ].join('\n');
        const events = parseLogEvents(text).filter((e) => e.kind === 'stop');
        expect(events.map((e) => e.kind === 'stop' && e.reason)).toEqual(['unknown']);
    });

    it.each([
        // Шаблоны ⛔-пушей оркестратора без кода причины: инфраструктура, арбитр, hold.
        '🔔 PUSH: ⛔ Ralph: старт заблокирован — abc (red, деплой)',
        '🔔 PUSH: ⛔ Ralph: фаза "Ф" — независимый арбитр подтвердил блокирующий дефект в правках (PR #5), фаза ушла в разбор blocked.',
        '🔔 PUSH: ⛔ Ralph: запрос кодер-сессии не разобрался — x. ',
        '🔔 PUSH: ⛔ Ralph: фаза "Ф" — PR #5 остановлен меткой \'hold\'. Снять её может только человек',
    ])('⛔-пуш без кода причины — не стоп: %s', (body) => {
        expect(parseLogEvents(`[2026-10-26T10:00:00.000Z] ${body}`)).toEqual([]);
    });

    it('пуш без кода исход задач фазы не переписывает', () => {
        // Арбитр отправил фазу в разбор blocked, петля идёт дальше: задача в работе, не стоп.
        const s = summarizeTasks({
            events: parseLogEvents(
                [
                    '[2026-10-26T10:00:00.000Z] 🔄 Ф | итерация 1/10 | Issue #1: x | модель: m (claude)',
                    '[2026-10-26T10:05:00.000Z] 🔔 PUSH: ⛔ Ralph: фаза "Ф" — независимый арбитр подтвердил блокирующий дефект в правках (PR #5), фаза ушла в разбор blocked.',
                ].join('\n'),
            ),
            budgetMs: 30 * MIN,
            since: SINCE,
            until: UNTIL,
            currentMilestone: 'Ф',
        });
        expect(row(s, 'in-progress')?.issues).toEqual([1]);
        expect(s.stops.reduce((n, r) => n + r.count, 0)).toBe(0);
    });

    it('мердж с красным деплоем — всё равно мердж, а не стоп', () => {
        const ev = parseLogEvents(
            '[2026-10-26T10:00:00.000Z] 🔔 PUSH: ⛔ Ralph: фаза "Ф" смерджена, но деплой красный — разбор',
        );
        expect(ev).toEqual([
            { at: Date.parse('2026-10-26T10:00:00.000Z'), kind: 'merged', milestone: 'Ф' },
        ]);
    });

    it('цитата словосочетания посреди строки мерджем не считается', () => {
        const ev = parseLogEvents(
            '[2026-10-26T10:00:00.000Z] ⚠ Ревью: заголовок PR «фаза "Ф" смерджена» вводит в заблуждение',
        );
        expect(ev).toEqual([]);
    });

    it.each([
        '🔔 PUSH: ✅ Ralph: фаза "Ф" смерджена в main — готова к релизу.',
        '✅ Фаза "Ф" уже смерджена — дерево раннера на свежем origin/main, переход к следующей.',
        '⛔ Фаза "Ф" смерджена, но дерево раннера не обновилось (x). ',
    ])('шаблон мерджа узнаётся: %s', (body) => {
        expect(parseLogEvents(`[2026-10-26T10:00:00.000Z] ${body}`).map((e) => e.kind)).toEqual([
            'merged',
        ]);
    });

    it('«не смерджена» мерджем не считается', () => {
        const ev = parseLogEvents(
            '[2026-10-26T10:00:00.000Z] 🔔 PUSH: ⛔ Ralph: фаза "Ф" не смерджена — причина: спор ревью (review-dispute). диагноз: д.',
        );
        expect(ev.map((e) => e.kind)).toEqual(['stop']);
    });

    it('строки без отметки времени и мусор пропускаются, а не роняют разбор', () => {
        expect(parseLogEvents('мусор\n\n[не-время] 🔄 Ф | итерация 1/1 | Issue #1: x')).toEqual([]);
    });
});

describe('печать сводки', () => {
    it('доля и все ненулевые строки с номерами; неизвестный исход виден всегда', () => {
        const out = formatMetricSummary(summary());
        expect(out).toContain('Взято задач: 8');
        expect(out).toContain('1 из 8 (13 %)');
        expect(out).toContain('circuit breaker (breaker): 1 — #3');
        expect(out).toContain('закрыта, фаза не смерджена: 1 — #7');
        expect(out).toContain('исход неизвестен: 1 — #9');
        const clean = formatMetricSummary(
            summarizeTasks({
                events: parseLogEvents(FIXTURE),
                budgetMs: 30 * MIN,
                since: SINCE,
                until: Date.parse('2026-10-26T10:45:00.000Z'),
                currentMilestone: null,
            }),
        );
        expect(clean).toContain('исход неизвестен: 0');
    });
});

describe('суточная строка — контракт формата', () => {
    // Строку читает человек в Telegram и, возможно, разбор постфактум по монитору: формат
    // фиксируется целиком, а не «содержит», чтобы правка формулировки была видна здесь.
    it('доля в бюджет, пойманные отказы и остановки петли одной строкой', () => {
        // Отказ один — красный чек гейта фазы В. Стоп gate-red по тому же событию — парный и
        // второй раз не считается; он и breaker фазы Б — остановки петли, не барьеры.
        expect(formatMetricDayLine(summary())).toBe(
            '📈 Метрика за 24 ч до 2026-10-26T23:59Z: в бюджет 1 из 8 (13 %), пойманных отказов 1, остановок петли 2.',
        );
    });

    it('пустой период — «задач не брали», ноль отказов печатается', () => {
        const s = summary({ since: UNTIL - 2 * 3_600_000, until: UNTIL });
        expect(formatMetricDayLine(s)).toBe(
            '📈 Метрика за 2 ч до 2026-10-26T23:59Z: задач не брали, пойманных отказов 0, остановок петли 0.',
        );
    });

    it('одна строка, без переводов', () => {
        expect(formatMetricDayLine(summary())).not.toContain('\n');
    });
});

describe('бюджет задачи из конфига', () => {
    it('берётся из metrics.taskBudgetMin', () => {
        expect(resolveTaskBudgetMs({ metrics: { taskBudgetMin: 90 } })).toEqual({
            ok: true,
            ms: 90 * MIN,
        });
    });

    it.each([
        [{}, 'не задан'],
        [{ metrics: {} }, 'не задан'],
        [{ metrics: { taskBudgetMin: 0 } }, 'положительное'],
        [{ metrics: { taskBudgetMin: '90' } }, 'положительное'],
        [{ metrics: { taskBudgetMin: Number.NaN } }, 'положительное'],
        [{ metrics: 5 }, 'объект'],
    ])('%j — отказ с причиной, а не дефолт', (cfg, why) => {
        const r = resolveTaskBudgetMs(cfg);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toContain(why);
    });
});

// Разбор держится на ТЕКСТЕ строк раннера — это контракт между модулями (см. runtime/CLAUDE.md).
// Поправил формулировку в оркестраторе — этот блок краснеет, и сводка не начинает молча
// считать всё «исход неизвестен».
describe('шаблоны строк раннера, которые читает сводка', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'core', 'orchestrator.ts'), 'utf8');

    it.each([
        [
            'взятие задачи',
            '`🔄 ${phase.milestone} | итерация ${state.count}/${maxIterations} | Issue #${next.number}: ',
        ],
        ['закрытие', '`✅ Issue #${String(req.issue)} закрыт по просьбе сессии.`'],
        ['blocked', '`⛔ Issue #${String(req.issue)} помечен blocked — ждёт человека.`'],
        ['мердж гейтом', '`✅ Ralph: фаза "${phase.milestone}" смерджена в main'],
        ['фаза уже смерджена', '`✅ Фаза "${phase.milestone}" уже смерджена'],
        ['старт', '| фаза "${state.milestone ?? \'—\'}" |'],
        ['пуш', '`🔔 PUSH: ${msg}`'],
    ])('%s', (_name, template) => {
        expect(src).toContain(template);
    });

    it('строка стопа собирается formatStopMessage — с кодом причины в скобках', () => {
        const stop = readFileSync(
            join(import.meta.dirname, '..', 'core', 'stop-message.ts'),
            'utf8',
        );
        expect(stop).toContain('`причина: ${title} (${reason}). `');
    });
});

// Счётчик пойманных отказов (план, Фаза 4): сколько раз сработал каждый барьер за период.
describe('счётчик барьеров', () => {
    // Каждый барьер гейта — строкой той формы, что пишет gate.ts; стопы — пушем с кодом
    // причины. Две строки гейта — НЕ барьеры (нет PR, сбой до чеков) и в счёт не идут.
    // Терминальные отказы гейта, как в живом логе, идут ПАРОЙ: строка гейта и стоп по тому
    // же событию — красный чек + gate-red, куб площадки + platform-check-red, инструмент +
    // gate-tool-failure, hold + пуш «остановлен меткой 'hold'» без кода.
    const BARRIER_FIXTURE = [
        "[2026-10-26T10:00:00.000Z] ⛔ Гейт: PR #5 помечен 'hold' — стоп, снять может только человек.",
        '[2026-10-26T10:00:01.000Z] 🔔 PUSH: ⛔ Ralph: фаза "Ф" — PR #5 остановлен меткой \'hold\'. Снять её может только человек, руками в форже.',
        "[2026-10-26T10:01:00.000Z] ⛔ Гейт: PR #5 помечен 'blocked'.",
        "[2026-10-26T10:02:00.000Z] ⛔ Гейт: PR #5 помечен 'blocked'.",
        '[2026-10-26T10:03:00.000Z] ⛔ Гейт: чек test красный на PR #5.',
        '[2026-10-26T10:03:30.000Z] 🔔 PUSH: ⛔ Гейт красный — PR оставлен человеку. причина: чек не зазеленел за отведённые чини-сессии (gate-red). диагноз: д. вопрос человеку: в',
        '[2026-10-26T10:04:00.000Z] ⛔ Гейт: чек lint упал на инструменте (код 127) на PR #5 — это не регрессия, чини-сессии не будет.',
        '[2026-10-26T10:04:30.000Z] 🔔 PUSH: ⛔ Ralph: сбой инструмента гейта — PR оставлен человеку. причина: чек упал на инструменте, а не на коде (gate-tool-failure). диагноз: д. вопрос человеку: в',
        '[2026-10-26T10:05:00.000Z] ⛔ Гейт: куб gate прогона 41 красный на площадке при зелёном локальном гейте.',
        '[2026-10-26T10:05:30.000Z] 🔔 PUSH: ⛔ Ralph: чек площадки — PR оставлен человеку. причина: красный чек площадки (platform-check-red). диагноз: д. вопрос человеку: в',
        '[2026-10-26T10:06:00.000Z] ⛔ Гейт: куб gate прогона 42 упал по ОТКАЗУ СРЕДЫ (нет ни одного проваленного кейса, есть сигнатура убитого воркера/OOM). Кодом это не чинится — сессия лечения принялась бы править здоровые тесты.',
        '[2026-10-26T10:07:00.000Z] ⛔ Гейт: прогон 43 ПРЕРВАН (статус «canceled») на кубе gate — это не отказ кода, лечить нечего.',
        // Три ветки `lastForgeStop` в gate.ts — реальным текстом каждая.
        '[2026-10-26T10:08:00.000Z] ⛔ Гейт: чек PR #5 у форжа не дал вердикта (потолок ожидания) — мердж отменён, PR оставлен человеку.',
        '[2026-10-26T10:08:10.000Z] ⛔ Гейт: чек PR #5 красный (прогон 44), но упавший куб не назван — чинить вслепую нельзя, PR оставлен человеку.',
        '[2026-10-26T10:08:20.000Z] ⛔ Гейт: чек PR #5: политика required, а за льготный срок у PR не завелось ни одного прогона CI — мердж отменён.',
        // #85: расхождение ref с головой PR — коллизия историй, стоп петли: строка гейта
        // барьером не считается, стоп идёт только в раздел «чем кончилось».
        '[2026-10-26T10:08:30.000Z] ⛔ Гейт: локальный ref ветки PR #5 разошёлся с головой PR — мердж не выполняется.',
        '[2026-10-26T10:08:40.000Z] 🔔 PUSH: ⛔ Ralph: ветка фазы "Ф" разошлась с PR — PR оставлен человеку. причина: локальный ref ветки разошёлся с головой PR (head-diverged). диагноз: д. вопрос человеку: в',
        '[2026-10-26T10:09:00.000Z] ⛔ Гейт: открытый PR ветки feature/x в main не найден — мердж невозможен.',
        '[2026-10-26T10:10:00.000Z] ⛔ Гейт: не прошёл до чеков (fetch/HEAD/detach) на PR #5.',
        // Ревью без вердикта ловится до гейта: строки гейта нет, барьер виден только стопом.
        '[2026-10-26T10:11:00.000Z] 🔔 PUSH: ⛔ Ralph: фаза "Ф" не смерджена — причина: ревью без вердикта (review-no-verdict). диагноз: д. вопрос человеку: в',
        // Стоп петли — не барьер.
        '[2026-10-26T10:12:00.000Z] 🔔 PUSH: ⛔ Ralph: circuit breaker — loop стоит об стену на фазе "Ф". причина: circuit breaker (breaker). диагноз: д. вопрос человеку: в',
        // Пуш без кода — ни стоп, ни барьер.
        '[2026-10-26T10:13:00.000Z] 🔔 PUSH: ⛔ Ralph: старт заблокирован — abc (red, деплой)',
        // Вне периода: вчерашний hold в счёт не входит.
        "[2026-10-25T10:00:00.000Z] ⛔ Гейт: PR #4 помечен 'hold' — стоп, снять может только человек.",
    ].join('\n');

    function barrierSummary() {
        return summarizeTasks({
            events: parseLogEvents(BARRIER_FIXTURE),
            budgetMs: 30 * MIN,
            since: SINCE,
            until: UNTIL,
            currentMilestone: null,
        });
    }

    const nonZero = (rows: TMetricSummary['barriers']) =>
        Object.fromEntries(rows.filter((r) => r.count > 0).map((r) => [r.key, r.count]));

    it('по фикстуре лога каждый барьер посчитан ровно один раз', () => {
        // Парные стопы (gate-red, gate-tool-failure, platform-check-red) и hold-пуш без кода
        // второй раз в барьеры не идут; breaker — стоп петли, не барьер.
        expect(nonZero(barrierSummary().barriers)).toEqual({
            hold: 1,
            'pr-blocked': 2,
            'gate-red': 1,
            'gate-tool-failure': 1,
            'forge-red': 1,
            'forge-red-unnamed': 1,
            'forge-env': 2,
            'forge-no-verdict': 1,
            'forge-required': 1,
            'stop:review-no-verdict': 1,
        });
    });

    it('стоп без вердикта площадки не дублирует парную строку гейта', () => {
        const summary = summarizeTasks({
            events: parseLogEvents(
                [
                    '[2026-10-26T10:08:00.000Z] ⛔ Гейт: чек PR #5 у форжа не дал вердикта (потолок ожидания) — мердж отменён, PR оставлен человеку.',
                    '[2026-10-26T10:08:05.000Z] 🔔 PUSH: ⛔ Ralph: чек площадки — PR оставлен человеку. причина: чек площадки не дал вердикта (platform-check-no-verdict). диагноз: д. вопрос человеку: в',
                ].join('\n'),
            ),
            budgetMs: 30 * MIN,
            since: SINCE,
            until: UNTIL,
            currentMilestone: null,
        });
        expect(nonZero(summary.barriers)).toEqual({ 'forge-no-verdict': 1 });
        expect(nonZero(summary.stops)).toEqual({ 'stop:platform-check-no-verdict': 1 });
    });

    it('красный без названного куба не дублирует парный platform-check-red', () => {
        const summary = summarizeTasks({
            events: parseLogEvents(
                [
                    '[2026-10-26T10:08:00.000Z] ⛔ Гейт: чек PR #5 красный (прогон 44), но упавший куб не назван — чинить вслепую нельзя, PR оставлен человеку.',
                    '[2026-10-26T10:08:05.000Z] 🔔 PUSH: ⛔ Ralph: чек площадки — PR оставлен человеку. причина: красный чек площадки (platform-check-red). диагноз: д. вопрос человеку: в',
                ].join('\n'),
            ),
            budgetMs: 30 * MIN,
            since: SINCE,
            until: UNTIL,
            currentMilestone: null,
        });
        expect(nonZero(summary.barriers)).toEqual({ 'forge-red-unnamed': 1 });
        expect(nonZero(summary.stops)).toEqual({ 'stop:platform-check-red': 1 });
    });

    it('стопы петли — отдельным разделом: все стопы с кодом, без пушей без кода', () => {
        expect(nonZero(barrierSummary().stops)).toEqual({
            'stop:gate-red': 1,
            'stop:gate-tool-failure': 1,
            'stop:platform-check-red': 1,
            'stop:head-diverged': 1,
            'stop:review-no-verdict': 1,
            'stop:breaker': 1,
        });
    });

    it('в счётчике строка на каждый барьер гейта и на каждую причину-барьер; в стопах — на каждую причину', () => {
        const s = barrierSummary();
        const reasons = Object.keys(REASON_TITLES) as TStopReason[];
        expect(s.barriers.map((r) => r.key)).toEqual([
            ...Object.keys(GATE_BARRIERS),
            ...reasons.filter((r) => STOP_ROLES[r] === 'barrier').map((r) => `stop:${r}`),
        ]);
        expect(s.stops.map((r) => r.key)).toEqual(reasons.map((r) => `stop:${r}`));
    });

    it('стопы петли барьерами не считаются', () => {
        for (const r of [
            'breaker',
            'tree-dirty',
            'main-conflict',
            'main-sync-failed',
            'head-diverged',
            'session-unpushed',
            'deadman',
            'unknown',
        ] as const)
            expect(STOP_ROLES[r]).toBe('loop');
    });

    it('сводка печатает оба раздела с числами', () => {
        const out = formatMetricSummary(barrierSummary());
        expect(out).toContain('Сработали барьеры: 12.');
        expect(out).toContain("PR помечен 'blocked' (pr-blocked): 2");
        expect(out).toContain('стоп: ревью без вердикта (review-no-verdict): 1');
        expect(out).toContain('Остановки петли (чем кончилось): 6.');
        expect(out).toContain('стоп: circuit breaker (breaker): 1');
    });

    it('барьеры видны и в период, когда задач не брали', () => {
        const out = formatMetricSummary(barrierSummary());
        expect(out).toContain('задач не брали');
        expect(out).toContain('Сработали барьеры: 12.');
    });

    it('ноль срабатываний — сказано вслух, а не опущено', () => {
        // В фикстуре сводки один барьер (красный чек фазы В) и два стопа: breaker и gate-red.
        expect(formatMetricSummary(summary())).toContain('Сработали барьеры: 1.');
        expect(formatMetricSummary(summary())).toContain('Остановки петли (чем кончилось): 2.');
        const quiet = summarizeTasks({
            events: [],
            budgetMs: 30 * MIN,
            since: SINCE,
            until: UNTIL,
            currentMilestone: null,
        });
        expect(formatMetricSummary(quiet)).toContain('Сработали барьеры: 0.');
        expect(formatMetricSummary(quiet)).toContain('Остановки петли (чем кончилось): 0.');
    });

    it.each([
        ['⛔ Гейт: что-то новое'],
        // Хвост «— мердж отменён» общий у разных отказов: по нему строка не узнаётся.
        ['⛔ Гейт: новый отказ — мердж отменён.'],
        ['⛔ Гейт: новый отказ, PR оставлен человеку.'],
    ])('незнакомая строка гейта барьером не считается: %s', (body) => {
        expect(classifyGateLine(body)).toBeNull();
    });
});

// Полнота (по образцу реестра классов archlint): каждая строка `⛔ Гейт:` в исходнике гейта
// обязана быть либо барьером со строкой в счётчике, либо названа здесь НЕ-барьером с
// причиной. Новый отказ гейта без строки краснеет тут, а не пропадает из сводки молча.
describe('полнота счётчика барьеров', () => {
    const NOT_BARRIERS: Array<[RegExp, string]> = [
        [/^⛔ Гейт: открытый PR ветки .* не найден/u, 'нечего мерджить — не отказ барьера'],
        [
            /^⛔ Гейт: открытый PR ветки .* не прочитался у форжа/u,
            'сбой чтения форжа — стоп петли (forge-unreadable), не барьер',
        ],
        [/^⛔ Гейт: не прошёл до чеков/u, 'сбой git до чеков — инфраструктура, не барьер'],
        [/^⛔ Гейт: мердж PR #\S+ не удался/u, 'все барьеры пройдены, отказал вызов мерджа'],
        [/^⛔ Гейт: мердж PR #\S+ принят форжем, но/u, 'мердж ушёл, не подтвердилось чтение'],
        [
            /^⛔ Гейт: ветка PR #\S+ не подтянута к main/u,
            'отставание от main — стоп петли (main-conflict)',
        ],
        [/^⛔ Гейт: дерево раннера грязное/u, 'состояние дерева раннера — стоп петли, не барьер'],
        [
            /^⛔ Гейт: локальный ref ветки PR #\S+ разошёлся с головой PR/u,
            'коллизия историй ветки — стоп петли (head-diverged)',
        ],
    ];
    const src = readFileSync(join(import.meta.dirname, '..', 'core', 'gate.ts'), 'utf8');
    // Шаблоны строк гейта. Строка, целиком собранная из `lastForgeStop`, по шаблону не
    // узнаётся вовсе — её текст собирается выше по файлу тремя разными строками, — поэтому
    // такие шаблоны проверяются не сэмплом-заглушкой, а реальными строками каждой ветки.
    // Кавычки — любые: строка в `'…'` или `"…"` иначе проскакивала мимо барьера молча
    // (так вошла строка о грязном дереве гейта, ревью #13).
    const templates = [
        ...src.matchAll(/`(⛔ Гейт:[^`]*)`|'(⛔ Гейт:[^'\n]*)'|"(⛔ Гейт:[^"\n]*)"/gu),
    ].map((m) => m[1] ?? m[2] ?? m[3]);
    const FORGE_STOP_TEMPLATE = /^⛔ Гейт: \$\{lastForgeStop\}/u;
    // Образец строки из шаблона: подстановка `${…}` заменена словом, а не числом, — «7» на
    // месте имени чека или номера PR прятало бы, что якорь регулярки смотрит не туда.
    const samples = templates
        .filter((t) => !FORGE_STOP_TEMPLATE.test(t))
        .map((t) => t.replace(/\$\{[^}]*\}/gu, 'x'));

    // Ветки `lastForgeStop`: начало причины в исходнике, шаблон строки гейта, который её
    // печатает, и реальная строка лога этой ветки (та же, что в фикстуре счётчика).
    const FORGE_STOP_BRANCHES: Array<[string, string, string, string]> = [
        [
            'forge-no-verdict',
            '`чек PR #${String(pr.number)} у форжа не дал вердикта (',
            '`⛔ Гейт: ${lastForgeStop} — мердж отменён, PR оставлен человеку.`',
            '⛔ Гейт: чек PR #5 у форжа не дал вердикта (потолок ожидания) — мердж отменён, PR оставлен человеку.',
        ],
        [
            'forge-red-unnamed',
            '`чек PR #${String(pr.number)} красный (прогон ${forge.run.runId}), `',
            '`⛔ Гейт: ${lastForgeStop}, PR оставлен человеку.`',
            '⛔ Гейт: чек PR #5 красный (прогон 44), но упавший куб не назван — чинить вслепую нельзя, PR оставлен человеку.',
        ],
        [
            'forge-required',
            '`чек PR #${String(pr.number)}: ${why}`',
            '`⛔ Гейт: ${lastForgeStop} — мердж отменён.`',
            '⛔ Гейт: чек PR #5: политика required, а за льготный срок у PR не завелось ни одного прогона CI — мердж отменён.',
        ],
    ];

    it('скан нашёл строки гейта (пустой скан — красный, а не «нечего проверять»)', () => {
        expect(samples.length).toBeGreaterThanOrEqual(10);
        expect(templates.filter((t) => FORGE_STOP_TEMPLATE.test(t)).length).toBe(3);
    });

    it.each(samples.map((s) => [s]))('%s — барьер или названный не-барьер', (sample) => {
        const barrier = classifyGateLine(sample);
        const excused = NOT_BARRIERS.some(([re]) => re.test(sample));
        expect(barrier !== null || excused).toBe(true);
        expect(barrier !== null && excused).toBe(false);
    });

    it.each(FORGE_STOP_BRANCHES)(
        'ветка lastForgeStop → %s: шаблон в исходнике, реальная строка узнаётся',
        (key, prefix, template, line) => {
            expect(src).toContain(prefix);
            expect(src).toContain(template);
            expect(classifyGateLine(line)).toBe(key);
        },
    );

    it('политика required — все вызовы stopRequired начинают причину словами «политика required»', () => {
        const calls = [...src.matchAll(/stopRequired\(\s*'([^']*)'/gu)].map((m) => m[1]);
        expect(calls.length).toBeGreaterThanOrEqual(3);
        for (const why of calls) expect(why.startsWith('политика required')).toBe(true);
    });

    it('у каждого барьера гейта есть хотя бы одна строка в исходнике', () => {
        const seen = new Set(samples.map((s) => classifyGateLine(s)));
        for (const [key] of FORGE_STOP_BRANCHES) seen.add(key as never);
        for (const key of Object.keys(GATE_BARRIERS)) expect(seen).toContain(key);
    });
});

// Тесты ожидания чека PR НА СТОРОНЕ ФОРЖА и классификации его отказа (#269).
//
// Предмет — политика ядра, а не разбор ответа площадки: «ждать или мерджить», «лечить
// кодом или звать человека». Разбор живёт в адаптере и проверяется своим набором
// на фикстурах реальных ответов.
import { describe, expect, it, vi } from 'vitest';
import type { ForgeChecks } from './forge-checks.ts';
import { classifyForgeFailure, waitForForgeChecks } from './forge-checks.ts';

// `rawStatus` шире `state` намеренно: сырой статус площадки (`processing`,
// `awaiting_approval`) в четыре значения ядра не укладывается — он и не должен.
const RUN = (state: ForgeChecks['runs'][number]['state'], rawStatus: string = state) => ({
    workflow: 'gate',
    runId: '356',
    state,
    rawStatus,
});

function checks(state: ForgeChecks['state'], runs: ForgeChecks['runs'] = []): ForgeChecks {
    return { state, runs };
}

// Часы — параметр, а не Date.now(): иначе тест на потолок ожидания недетерминирован.
// Тикают ровно на величину проспанного, поэтому счёт времени тут честный, а сна нет.
function fakeClock() {
    let now = 0;
    return {
        nowFn: () => now,
        sleepFn: (ms: number) => {
            now += ms;
        },
    };
}

describe('waitForForgeChecks — ожидание чека PR на площадке (#269)', () => {
    it('processing → success: ждёт и отдаёт green, а не мерджит на первом ответе', () => {
        const clock = fakeClock();
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('pending', [RUN('pending', 'processing')]))
            .mockReturnValueOnce(checks('pending', [RUN('pending', 'processing')]))
            .mockReturnValue(checks('success', [RUN('success')]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {} });

        expect(out).toEqual({ kind: 'green' });
        expect(readFn).toHaveBeenCalledTimes(3);
    });

    it('failed → red с ТЕМ прогоном, который упал (а не первым в списке)', () => {
        const clock = fakeClock();
        const red = {
            workflow: 'gate',
            runId: '350',
            state: 'failed' as const,
            rawStatus: 'failed',
        };
        const readFn = () => checks('failed', [RUN('success'), red]);

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {} });

        expect(out).toEqual({ kind: 'red', run: red });
    });

    it('потолок ожидания → timeout с последним сырым статусом в причине', () => {
        const clock = fakeClock();
        const readFn = () => checks('pending', [RUN('pending', 'awaiting_approval')]);

        const out = waitForForgeChecks({
            readFn,
            ...clock,
            logFn: () => {},
            timeoutMs: 90_000,
            pollMs: 30_000,
        });

        expect(out.kind).toBe('timeout');
        if (out.kind === 'timeout') expect(out.detail).toContain('awaiting_approval');
    });

    it('чеков у PR нет: ждёт льготный срок, потом absent — репозиторий без CI не стоит 20 минут', () => {
        const clock = fakeClock();
        const readFn = vi.fn<() => ForgeChecks>(() => checks('none'));

        const out = waitForForgeChecks({
            readFn,
            ...clock,
            logFn: () => {},
            pollMs: 30_000,
            absentGraceMs: 60_000,
            timeoutMs: 600_000,
        });

        expect(out).toEqual({ kind: 'absent' });
        // 0с, 30с, 60с — на третьем чтении льгота исчерпана.
        expect(readFn).toHaveBeenCalledTimes(3);
    });

    it('чек появился после паузы: none в льготный срок не приговор', () => {
        const clock = fakeClock();
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('none'))
            .mockReturnValue(checks('success', [RUN('success')]));

        const out = waitForForgeChecks({
            readFn,
            ...clock,
            logFn: () => {},
            pollMs: 30_000,
            absentGraceMs: 60_000,
        });

        expect(out).toEqual({ kind: 'green' });
    });

    it('сбой чтения — сгоревшая попытка, а не приговор: сеть чихнула, чек зелёный', () => {
        const clock = fakeClock();
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockImplementationOnce(() => {
                throw new Error('curl вернул 52');
            })
            .mockReturnValue(checks('success', [RUN('success')]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {} });

        expect(out).toEqual({ kind: 'green' });
    });

    it('устойчивый сбой чтения → error, а не молчаливый мердж и не 20 минут тишины', () => {
        const clock = fakeClock();
        const readFn = vi.fn<() => ForgeChecks>(() => {
            throw new Error('curl вернул 52 — Empty reply from server');
        });

        const out = waitForForgeChecks({
            readFn,
            ...clock,
            logFn: () => {},
            pollMs: 30_000,
            maxReadErrors: 3,
        });

        expect(out.kind).toBe('error');
        if (out.kind === 'error') expect(out.detail).toContain('Empty reply');
        expect(readFn).toHaveBeenCalledTimes(3);
    });

    // Ассерт «где-то есть строка с 🚦» зеленел бы и при полностью немой петле ожидания:
    // финальное «чек зелёный» тоже начинается с 🚦 (находка ревью). Считаем строки
    // ИМЕННО кругов ожидания.
    it('пишет строку на КАЖДОМ круге ожидания — иначе deadman примет гейт за мёртвый', () => {
        const clock = fakeClock();
        const logFn = vi.fn();
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('pending', [RUN('pending', 'processing')]))
            .mockReturnValueOnce(checks('pending', [RUN('pending', 'processing')]))
            .mockReturnValue(checks('success', [RUN('success')]));

        waitForForgeChecks({ readFn, ...clock, logFn });

        const waiting = logFn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('ждёт'));
        expect(waiting).toHaveLength(2);
        // Маркер гейта (🚦) — режим deadman обязан остаться `gate` (GATE_RE в
        // runtime/deadman.ts), а не свалиться в `default` с пятиминутным порогом.
        expect(waiting.every((m) => m.startsWith('🚦'))).toBe(true);
    });

    // Ветка fail-closed на нарушенном контракте шва: «красный, но красного прогона нет».
    it('форж сказал failed, а упавшего прогона в списке нет → error, а не мердж и не ожидание', () => {
        const clock = fakeClock();
        const out = waitForForgeChecks({
            readFn: () => checks('failed', [RUN('success')]),
            ...clock,
            logFn: () => {},
        });

        expect(out.kind).toBe('error');
    });

    // Сброс счётчика сбоев чтения: за 20 минут ожидания чередование «сбой — успех» вполне
    // обычно, и без сброса третий несмежный сбой дал бы ложный `error` и стоп петли.
    it('сбои чтения ВРАЗБИВКУ не копятся: счётчик обнуляется удачным чтением', () => {
        const clock = fakeClock();
        let call = 0;
        const readFn = (): ForgeChecks => {
            call += 1;
            if (call % 2 === 1) throw new Error('curl вернул 52');
            return call < 8 ? checks('pending', [RUN('pending', 'processing')]) : checks('success');
        };

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, maxReadErrors: 2 });

        expect(out).toEqual({ kind: 'green' });
    });
});

// Хвосты РЕАЛЬНЫХ логов куба `test` (прогоны 350 и 356), уже без ANSI: первый — OOM
// контейнера гейта (#268), второй — настоящий отказ теста, который правит код.
const OOM_TAIL = `
 ✓  tools  design/brand-assets.test.ts (25 tests) 4697ms
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
Vitest caught 2 unhandled errors during the test run.
Error: [vitest-pool]: Worker forks emitted error.
 ❯ EventEmitter.onTaskError node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:3526:21
Caused by: Error: Worker exited unexpectedly
 Test Files  430 passed (432)
      Tests  7064 passed (7090)
`;

const CODE_TAIL = `
AssertionError: expected [ 'compose ps -q frontend', …(19) ] to deeply equal [ 'compose ps -q frontend', …(19) ]
 ❯ scripts/deploy.test.ts:58:36
 Test Files  2 failed | 435 passed (437)
      Tests  2 failed | 7172 passed (7174)
`;

// Форж отдаёт ПОСЛЕДНИЙ прогон workflow, а не прогон конкретного sha (это записано
// в `docs/platform/sourcecraft/api-gotchas.md`), — то есть после пуша правок он какое-то
// время повторяет вердикт предыдущего прогона. Без сверки с номером уже пролеченного
// петля читала такой красный как свежий и тратила вторую (последнюю) попытку
// `gateHealAttempts` на лог, который уже починен, а исчерпав бюджет — вставала.
describe('waitForForgeChecks — вердикт привязан к прогону, а не к последнему ответу', () => {
    it('тот же прогон, по которому уже лечили, — ждём новый, а не отдаём red', () => {
        const clock = fakeClock();
        const red = {
            workflow: 'gate',
            runId: '356',
            state: 'failed' as const,
            rawStatus: 'failed',
        };
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('failed', [red]))
            .mockReturnValueOnce(checks('failed', [red]))
            .mockReturnValue(checks('success', [RUN('success')]));

        const out = waitForForgeChecks({
            readFn,
            ...clock,
            logFn: () => {},
            healedRunId: '356',
        });

        expect(out).toEqual({ kind: 'green' });
        expect(readFn).toHaveBeenCalledTimes(3);
    });

    it('НОВЫЙ прогон с тем же диагнозом лечится как обычно — номер другой', () => {
        const clock = fakeClock();
        const red = {
            workflow: 'gate',
            runId: '357',
            state: 'failed' as const,
            rawStatus: 'failed',
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [red]),
            ...clock,
            logFn: () => {},
            healedRunId: '356',
        });

        expect(out).toEqual({ kind: 'red', run: red });
    });

    // Иначе «ждём новый прогон» превратилось бы в вечный цикл там, где форж его так
    // и не завёл (пуш не долетел, чек не привязался к событию обновления PR).
    it('новый прогон так и не завёлся — timeout с номером пролеченного в причине', () => {
        const clock = fakeClock();
        const red = {
            workflow: 'gate',
            runId: '356',
            state: 'failed' as const,
            rawStatus: 'failed',
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [red]),
            ...clock,
            logFn: () => {},
            healedRunId: '356',
        });

        expect(out.kind).toBe('timeout');
        expect(out.kind === 'timeout' && out.detail).toContain('356');
    });

    // Правка по ревью #269: пролеченный прогон не должен ЗАСЛОНЯТЬ собой свежий красный
    // соседнего workflow. Свёртку `find` брала по ПЕРВОМУ красному, и порядок элементов
    // в ответе форжа решал, уйдёт ли петля ждать 20 минут при готовом вердикте в том же
    // ответе. Сегодня workflow на PR один, поэтому кейс про завтра — но стоит он строку.
    it('новый красный ДРУГОГО workflow за спиной пролеченного — вердикт, а не ожидание', () => {
        const clock = fakeClock();
        const healed = {
            workflow: 'gate',
            runId: '356',
            state: 'failed' as const,
            rawStatus: 'failed',
        };
        const fresh = {
            workflow: 'security',
            runId: '357',
            state: 'failed' as const,
            rawStatus: 'failed',
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [healed, fresh]),
            ...clock,
            logFn: () => {},
            healedRunId: '356',
        });

        expect(out).toEqual({ kind: 'red', run: fresh });
    });

    // Обратная сторона: пустой номер (лечения ещё не было) не должен превращать первый же
    // красный в ожидание — иначе карточка чинила бы один отказ, заводя другой.
    it('без номера пролеченного прогона красный отдаётся сразу', () => {
        const clock = fakeClock();
        const red = {
            workflow: 'gate',
            runId: '356',
            state: 'failed' as const,
            rawStatus: 'failed',
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [red]),
            ...clock,
            logFn: () => {},
            healedRunId: '',
        });

        expect(out).toEqual({ kind: 'red', run: red });
    });
});

// Свежесть вердикта: форж отдаёт ПОСЛЕДНИЙ прогон workflow, а не прогон КОНКРЕТНОЙ головы
// PR (#278). До этой правки единственной защитой был тайминг («локальный гейт занимает
// 6–10,5 мин, форж обычно успевает завести новый прогон») — не механизм, а совпадение.
// Худший случай: стухший `forge-env` (OOM) от прогона ДО пуша правок читался как вердикт
// ТЕКУЩЕЙ головы и останавливал фазу человеку по логу, который уже не про этот код.
describe('waitForForgeChecks — свежесть вердикта относительно пуша правок (#278)', () => {
    // Числа и хронология — реальный инцидент из истории проекта (прогон 350 — OOM,
    // прогон 356 — правка кода), см. `OOM_TAIL`/`CODE_TAIL` ниже: 350 стартовал до пуша
    // правок, 356 — после.
    const PUSHED_AT = 1_000_000; // момент коммита проверенной головы (sinceMs)
    // Минус десять минут, а не минус минута: у границы свежести есть допуск на расхождение
    // часов VPS и площадки (`STALE_TOLERANCE_MS`, две минуты — правка по ревью), и прогон
    // «на минуту раньше» теперь СВЕЖИЙ. Сам допуск проверяется отдельным сьютом ниже.
    const BEFORE_PUSH = PUSHED_AT - 10 * 60_000;
    const AFTER_PUSH = PUSHED_AT + 60_000;

    it('красный прогон СТАРШЕ пуша правок не читается как вердикт — ждём новый', () => {
        const clock = fakeClock();
        const stale = {
            workflow: 'gate',
            runId: '350',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: BEFORE_PUSH,
        };
        const fresh = {
            workflow: 'gate',
            runId: '356',
            state: 'success' as const,
            rawStatus: 'success',
            createdAt: AFTER_PUSH,
        };
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('failed', [stale]))
            .mockReturnValueOnce(checks('failed', [stale]))
            .mockReturnValue(checks('success', [fresh]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, sinceMs: PUSHED_AT });

        // Не 'red' на первом же чтении, хотя форж честно сказал «failed»: этот прогон
        // отвечает за код ДО пуша, а не за проверяемую голову.
        expect(out).toEqual({ kind: 'green' });
        expect(readFn).toHaveBeenCalledTimes(3);
    });

    it('за старым красным находится СВЕЖИЙ красный — отдаём его, а не ждём весь потолок', () => {
        const clock = fakeClock();
        const stale = {
            workflow: 'gate',
            runId: '350',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: BEFORE_PUSH,
        };
        const fresh = {
            workflow: 'gate',
            runId: '356',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: AFTER_PUSH,
        };
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('failed', [stale]))
            .mockReturnValue(checks('failed', [fresh]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, sinceMs: PUSHED_AT });

        expect(out).toEqual({ kind: 'red', run: fresh });
    });

    it('зелёный вердикт СТАРШЕ пуша правок мердж не открывает — ждём подтверждения свежим прогоном', () => {
        const clock = fakeClock();
        const staleGreen = {
            workflow: 'gate',
            runId: '350',
            state: 'success' as const,
            rawStatus: 'success',
            createdAt: BEFORE_PUSH,
        };
        const freshGreen = {
            workflow: 'gate',
            runId: '356',
            state: 'success' as const,
            rawStatus: 'success',
            createdAt: AFTER_PUSH,
        };
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('success', [staleGreen]))
            .mockReturnValue(checks('success', [freshGreen]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, sinceMs: PUSHED_AT });

        expect(out).toEqual({ kind: 'green' });
        expect(readFn).toHaveBeenCalledTimes(2);
    });

    it('свежий прогон так и не завёлся — timeout с явной причиной «старше пуша правок»', () => {
        const clock = fakeClock();
        const stale = {
            workflow: 'gate',
            runId: '350',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: BEFORE_PUSH,
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [stale]),
            ...clock,
            logFn: () => {},
            sinceMs: PUSHED_AT,
            timeoutMs: 90_000,
            pollMs: 30_000,
        });

        expect(out.kind).toBe('timeout');
        if (out.kind === 'timeout') {
            expect(out.detail).toContain('пуша правок');
            expect(out.detail).toContain('350');
        }
    });

    // `createdAt` не задан (адаптер не смог разобрать дату площадки) — прогон считается
    // свежим: сбой формы ответа не повод объявлять вердикт устаревшим.
    it('прогон без createdAt свежесть не проверяет — вердикт принимается как есть', () => {
        const clock = fakeClock();
        const noDate = {
            workflow: 'gate',
            runId: '356',
            state: 'success' as const,
            rawStatus: 'success',
        };

        const out = waitForForgeChecks({
            readFn: () => checks('success', [noDate]),
            ...clock,
            logFn: () => {},
            sinceMs: PUSHED_AT,
        });

        expect(out).toEqual({ kind: 'green' });
    });

    // sinceMs не задан (шов не умеет /или ядро не смогло узнать время коммита) — прежнее
    // поведение: вердикт принимается как есть, даже если бы формально был «старше».
    it('sinceMs не задан — свежесть не проверяется вовсе, поведение прежнее', () => {
        const clock = fakeClock();
        const oldRun = {
            workflow: 'gate',
            runId: '350',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: BEFORE_PUSH,
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [oldRun]),
            ...clock,
            logFn: () => {},
        });

        expect(out).toEqual({ kind: 'red', run: oldRun });
    });
});

// Смешанный ответ (несколько прогонов в одном вердикте) — там, где живёт вся асимметрия
// реализации: до правки по ревью зелёная ветка мерила свежесть через `every` (достаточно
// ОДНОГО свежего прогона, чтобы принять вердикт, в котором сам `gate` старый), а красная —
// у каждого прогона отдельно. На PR сегодня заводится один workflow, поэтому отказ был
// латентным; комментарий в самом модуле при этом честно говорит «workflow может быть
// несколько». Правило репозитория — «отказы важнее успеха» (`.claude/rules/tests.md`).
describe('waitForForgeChecks — смешанный ответ: свежесть у КАЖДОГО прогона (#278)', () => {
    const PUSHED_AT = 1_000_000;
    const BEFORE_PUSH = PUSHED_AT - 10 * 60_000;
    const AFTER_PUSH = PUSHED_AT + 60_000;

    it('зелёный: свежий соседний workflow НЕ зазеленяет старый gate — ждём его новый прогон', () => {
        const clock = fakeClock();
        const staleGate = {
            workflow: 'gate',
            runId: '350',
            state: 'success' as const,
            rawStatus: 'success',
            createdAt: BEFORE_PUSH,
        };
        const freshOther = {
            workflow: 'deploy-preview',
            runId: '351',
            state: 'success' as const,
            rawStatus: 'success',
            createdAt: AFTER_PUSH,
        };
        const freshGate = { ...staleGate, runId: '356', createdAt: AFTER_PUSH };
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('success', [staleGate, freshOther]))
            .mockReturnValue(checks('success', [freshGate, freshOther]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, sinceMs: PUSHED_AT });

        // Мердж на первом ответе означал бы: голову PR площадка не проверяла ни разу,
        // а зелёным её объявил чужой, более поздний workflow.
        expect(out).toEqual({ kind: 'green' });
        expect(readFn).toHaveBeenCalledTimes(2);
    });

    it('зелёный: стухший прогон рядом с прогоном БЕЗ createdAt мердж не открывает', () => {
        // Граница двух правил сразу: «нет даты ⇒ свежесть не проверяем» (fail-open по форме)
        // и «прогон старше пуша ⇒ не вердикт» (fail-closed по свежести). Годность считается
        // у каждого прогона отдельно, поэтому стухший сосед держит мердж, а не растворяется
        // в чужой неразобранной дате.
        const clock = fakeClock();
        const staleGate = {
            workflow: 'gate',
            runId: '350',
            state: 'success' as const,
            rawStatus: 'success',
            createdAt: BEFORE_PUSH,
        };
        const noDate = {
            workflow: 'deploy-preview',
            runId: '351',
            state: 'success' as const,
            rawStatus: 'success',
        };
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('success', [staleGate, noDate]))
            .mockReturnValue(
                checks('success', [{ ...staleGate, runId: '356', createdAt: AFTER_PUSH }, noDate]),
            );

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, sinceMs: PUSHED_AT });

        expect(out).toEqual({ kind: 'green' });
        expect(readFn).toHaveBeenCalledTimes(2);
    });

    it('красный: пролеченный прогон свежий, второй красный — старый ⇒ ждём и называем причиной лечение', () => {
        // Оба признака негодности в одном ответе. `stuck` обязан выбрать ИМЕННО пролеченный
        // (о нём есть что сказать точнее), а строка лога — сказать «по нему уже лечили»,
        // а не «старше пуша правок»: причины ожидания разные и чинятся по-разному.
        const clock = fakeClock();
        const healed = {
            workflow: 'gate',
            runId: '356',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: AFTER_PUSH,
        };
        const staleRed = {
            workflow: 'deploy-preview',
            runId: '349',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: BEFORE_PUSH,
        };
        const logs: string[] = [];

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [healed, staleRed]),
            ...clock,
            logFn: (m) => logs.push(m),
            sinceMs: PUSHED_AT,
            healedRunId: '356',
            timeoutMs: 90_000,
            pollMs: 30_000,
        });

        expect(out.kind).toBe('timeout');
        if (out.kind === 'timeout')
            expect(out.detail).toContain('по нему чини-сессия уже отработала');
        expect(logs.some((l) => l.includes('356') && l.includes('уже лечили'))).toBe(true);
    });
});

// Допуск на расхождение часов: `sinceMs` снимает git на VPS, `createdAt` ставит сервер
// площадки. Строгое сравнение делало бы устаревшим КАЖДЫЙ свежий прогон при уходе часов
// вперёд на минуты — то есть механизм против ночных стопов сам бы их производил.
describe('waitForForgeChecks — допуск на расхождение часов у границы свежести (#278)', () => {
    const PUSHED_AT = 10_000_000;

    it('прогон на полминуты «раньше» пуша принимается как свежий, а не ждёт потолок', () => {
        const clock = fakeClock();
        const nearlyFresh = {
            workflow: 'gate',
            runId: '356',
            state: 'success' as const,
            rawStatus: 'success',
            createdAt: PUSHED_AT - 30_000,
        };
        const readFn = vi.fn<() => ForgeChecks>(() => checks('success', [nearlyFresh]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, sinceMs: PUSHED_AT });

        expect(out).toEqual({ kind: 'green' });
        expect(readFn).toHaveBeenCalledTimes(1);
    });

    it('принятый в допуске прогон называется в логе — иначе дрейф часов молчит', () => {
        const clock = fakeClock();
        const logs: string[] = [];
        const nearlyFresh = {
            workflow: 'gate',
            runId: '356',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: PUSHED_AT - 90_000,
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [nearlyFresh]),
            ...clock,
            logFn: (m) => logs.push(m),
            sinceMs: PUSHED_AT,
        });

        expect(out).toEqual({ kind: 'red', run: nearlyFresh });
        expect(logs.some((l) => l.includes('внутри допуска') && l.includes('часы'))).toBe(true);
    });

    it('за пределом допуска прогон всё ещё устаревший — допуск не отменяет барьер', () => {
        const clock = fakeClock();
        const stale = {
            workflow: 'gate',
            runId: '350',
            state: 'failed' as const,
            rawStatus: 'failed',
            createdAt: PUSHED_AT - 5 * 60_000,
        };

        const out = waitForForgeChecks({
            readFn: () => checks('failed', [stale]),
            ...clock,
            logFn: () => {},
            sinceMs: PUSHED_AT,
            timeoutMs: 60_000,
            pollMs: 30_000,
        });

        expect(out.kind).toBe('timeout');
    });
});

// Умолчание `healedRunId = ''` означает «лечения не было», а не «номер прогона пуст».
// После рефактора #278 оговорка потерялась, и красный прогон с пустым `runId` переставал
// быть кандидатом в вердикт: петля уходила ждать «новый прогон» на все 20 минут и писала
// человеку причину с дырой на месте номера.
describe('waitForForgeChecks — пустой healedRunId это «не лечили», а не номер прогона', () => {
    it('красный прогон с пустым runId остаётся вердиктом, а не поводом ждать', () => {
        const clock = fakeClock();
        const red = { workflow: 'gate', runId: '', state: 'failed' as const, rawStatus: 'failed' };
        const readFn = vi.fn<() => ForgeChecks>(() => checks('failed', [red]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {} });

        expect(out).toEqual({ kind: 'red', run: red });
        expect(readFn).toHaveBeenCalledTimes(1);
    });
});

// Чужая реализация шва не обязана бросать именно `Error`: `throw 'timeout'` из транспорта
// вполне возможен, и `(e as Error).message` давал бы строку «undefined» — стоп петли
// без причины (находка ревью #269).
describe('waitForForgeChecks — причина отказа чтения из любого броска', () => {
    it('брошена строка, а не Error — в detail едет она, а не «undefined»', () => {
        const clock = fakeClock();
        const logs: string[] = [];

        const out = waitForForgeChecks({
            readFn: () => {
                throw 'таймаут транспорта';
            },
            ...clock,
            logFn: (m) => logs.push(m),
        });

        expect(out).toEqual({ kind: 'error', detail: 'таймаут транспорта' });
        expect(logs.join('\n')).not.toContain('undefined');
    });
});

describe('classifyForgeFailure — что чинится кодом, а что нет (#269)', () => {
    it('OOM без единого проваленного кейса — не лечить кодом', () => {
        expect(classifyForgeFailure(OOM_TAIL)).toBe('oom');
    });

    it('проваленные кейсы есть — код, даже если рядом мелькнул воркер', () => {
        expect(classifyForgeFailure(CODE_TAIL)).toBe('code');
        expect(classifyForgeFailure(`${OOM_TAIL}\n Tests  1 failed | 2 passed (3)`)).toBe('code');
    });

    it('код 137 от контейнера — тот же диагноз среды', () => {
        expect(classifyForgeFailure('Command failed with exit code 137')).toBe('oom');
        expect(classifyForgeFailure('Memory cgroup out of memory: Killed process 1234')).toBe(
            'oom',
        );
    });

    it('обычный красный чек без сигнатуры среды — код', () => {
        expect(classifyForgeFailure('error TS2345: Argument of type ... is not assignable')).toBe(
            'code',
        );
    });

    it('пустой лог — код: молчаливый «диагноз среды» увёл бы к человеку исправимый отказ', () => {
        expect(classifyForgeFailure('')).toBe('code');
    });

    // Сводки в вырезке может не оказаться вовсе (у толстого куба между местом отказа и
    // концом лога лежит таблица покрытия), и тогда единственное, что удерживает настоящий
    // отказ кода от диагноза «среда», — строка `FAIL <файл>`. Убери альтернативу из
    // FAILED_CASES_RE — этот кейс покраснеет (находка ревью: раньше не краснел).
    it('сводки нет, но есть FAIL <файл> — код, а не среда', () => {
        const log = 'FAIL scripts/deploy.test.ts\nCaused by: Error: Worker exited unexpectedly';
        expect(classifyForgeFailure(log)).toBe('code');
    });

    // Отмену прогона видно ТОЛЬКО по статусу: в логе она неотличима от обрыва по любой
    // другой причине. Рестарт воркера посреди задания — штатное действие дежурного.
    it('прогон прерван (canceled/timeout/rejected) — aborted, независимо от лога', () => {
        for (const status of ['canceled', 'timeout', 'rejected']) {
            expect(classifyForgeFailure(CODE_TAIL, status), status).toBe('aborted');
        }
    });

    it('обычный красный статус сырой статус не переопределяет', () => {
        expect(classifyForgeFailure(CODE_TAIL, 'failed')).toBe('code');
        expect(classifyForgeFailure(OOM_TAIL, 'failed')).toBe('oom');
    });
});

// Задача 81: политика `required` внешнего CI. Прогон без даты при ней — не вердикт:
// свежесть такого прогона не проверить, а «не смогли проверить» для `required` значит
// «мердж не даём». Ждать его тоже бессмысленно: дата, не разобравшаяся в одном ответе,
// не разберётся и в следующем — это сбой формы ответа, и исход у него `error`.
describe('waitForForgeChecks — requireDated: прогон без даты не вердикт (задача 81)', () => {
    const DATED = (state: ForgeChecks['runs'][number]['state']) => ({
        ...RUN(state),
        createdAt: 1_000_000,
    });

    it('зелёный прогон без даты → error, а не green', () => {
        const clock = fakeClock();
        const out = waitForForgeChecks({
            readFn: () => checks('success', [RUN('success')]),
            ...clock,
            logFn: () => {},
            requireDated: true,
        });

        expect(out.kind).toBe('error');
        if (out.kind === 'error') expect(out.detail).toContain('без даты');
    });

    it('красный прогон без даты → error: лечить лог неизвестной свежести нельзя', () => {
        const clock = fakeClock();
        const out = waitForForgeChecks({
            readFn: () => checks('failed', [RUN('failed')]),
            ...clock,
            logFn: () => {},
            requireDated: true,
        });

        expect(out.kind).toBe('error');
    });

    it('success без единого прогона → error: подтверждать нечем', () => {
        const clock = fakeClock();
        const out = waitForForgeChecks({
            readFn: () => checks('success', []),
            ...clock,
            logFn: () => {},
            requireDated: true,
        });

        expect(out.kind).toBe('error');
    });

    it('ждущий прогон без даты — не приговор: дождались датированного зелёного → green', () => {
        const clock = fakeClock();
        const readFn = vi
            .fn<() => ForgeChecks>()
            .mockReturnValueOnce(checks('pending', [RUN('pending', 'created')]))
            .mockReturnValue(checks('success', [DATED('success')]));

        const out = waitForForgeChecks({ readFn, ...clock, logFn: () => {}, requireDated: true });

        expect(out).toEqual({ kind: 'green' });
    });

    it('без requireDated прогон без даты по-прежнему годится (политика optional)', () => {
        const clock = fakeClock();
        const out = waitForForgeChecks({
            readFn: () => checks('success', [RUN('success')]),
            ...clock,
            logFn: () => {},
        });

        expect(out).toEqual({ kind: 'green' });
    });
});

// Юнит-тесты модуля детекции/ожидания API-лимита (#361). Здесь проверяется САМ модуль
// api-limit.ts — чистые преобразования вход→выход, без ralph.js: контракт extraction'а —
// модуль самодостаточен (цель фазы 2), а не «работает только пока его зовёт ralph.js».
// В конце файла — блок, перенесённый из ralph.test.js при её разнесении по модулям
// (#366): он ходит через боевую поверхность ralph.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов: блок ниже перенесён из
// ralph.test.js как есть и ходит через боевую поверхность ralph.js (#366).
import ralph from '../ralph.js';
import {
    API_LIMIT_RE,
    TURN_LIMIT_RE,
    parseResetWaitMs,
    minutesOrDefault,
    apiLimitWaitMs,
    apiLimitMessage,
} from './api-limit.ts';

describe('API_LIMIT_RE — детекция маркера лимита в выводе сессии', () => {
    it.each([
        "You've hit your session limit · resets 1:20pm",
        'usage limit reached',
        'rate-limit exceeded',
        'rate limit hit',
        '5-hour limit will reset soon',
        'your window resets at 3am',
        'limit exceeded',
    ])('распознаёт маркер лимита: %s', (text) => {
        expect(API_LIMIT_RE.test(text)).toBe(true);
    });

    it.each([
        'All tests passed',
        'Error: cannot find module',
        'build succeeded in 12s',
        'no problems detected',
    ])('НЕ ложно-срабатывает на обычном выводе: %s', (text) => {
        expect(API_LIMIT_RE.test(text)).toBe(false);
    });
});

// #594: исчерпание бюджета ходов — НЕ отказ сессии, а «не успела». Отличать его от
// настоящего падения обязательно: настоящее падение обязано оставаться fail-closed стопом,
// а «не успела» — продолжаться новой сессией, иначе AFK вырождается в HITL.
describe('TURN_LIMIT_RE — детекция исчерпания бюджета ходов', () => {
    it.each([
        'Error: Reached max turns (200)',
        'reached max turns',
        'Max turns exceeded',
        'max turns reached',
    ])('распознаёт маркер исчерпания ходов: %s', (text) => {
        expect(TURN_LIMIT_RE.test(text)).toBe(true);
    });

    it.each([
        "You've hit your session limit · resets 1:20pm",
        'TypeError: undefined is not a function',
        'All tests passed',
        'turns out the fix was simple',
    ])('НЕ путает с API-лимитом и обычным падением: %s', (text) => {
        expect(TURN_LIMIT_RE.test(text)).toBe(false);
    });
});

describe('parseResetWaitMs — время до сброса окна API-лимита', () => {
    // Фиксируем «сейчас» = локальное 2026-01-15 10:00:00. Delta между двумя
    // локально-сконструированными Date не зависит от TZ хоста → тест детерминирован.
    const H = 3600_000;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0, 0));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('«resets 11am» (позже сейчас в тот же день) → 1 час', () => {
        expect(parseResetWaitMs('you can retry — resets 11am')).toBe(1 * H);
    });

    it('«reset at 7:30pm» → 9.5 часа (12h-формат, pm)', () => {
        expect(parseResetWaitMs('limit will reset at 7:30pm')).toBe(9.5 * H);
    });

    it('«resets 3am» (уже прошло сегодня) → переносится на завтра', () => {
        // с 10:00 до завтрашних 03:00 = 17 часов
        expect(parseResetWaitMs('resets 3am')).toBe(17 * H);
    });

    it('«resets 12am» трактуется как полночь (h=0), не 12:00', () => {
        // ближайшая полночь — завтра 00:00 = через 14 часов
        expect(parseResetWaitMs('resets 12am')).toBe(14 * H);
    });

    it('«resets 12pm» трактуется как полдень (h=12) → 2 часа', () => {
        expect(parseResetWaitMs('resets 12pm')).toBe(2 * H);
    });

    it('невалидный час (>23) → null (вызывающий возьмёт fallback)', () => {
        expect(parseResetWaitMs('resets 27')).toBeNull();
    });

    it('нет упоминания reset → null', () => {
        expect(parseResetWaitMs('just a normal claude output, all good')).toBeNull();
    });
});

describe('minutesOrDefault — валидация минут из конфига (#132)', () => {
    it('корректное неотрицательное число — берётся как есть', () => {
        expect(minutesOrDefault(5, 30)).toBe(5);
        expect(minutesOrDefault(0, 30)).toBe(0);
    });

    it.each([
        ['строка вместо числа', '5'],
        ['NaN', NaN],
        ['+Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['отрицательное', -1],
        ['null', null],
        ['undefined', undefined],
    ])('мусор (%s) → дефолт, не вечный сон', (_name, value) => {
        expect(minutesOrDefault(value, 30)).toBe(30);
    });
});

describe('apiLimitWaitMs — сон до сброса окна лимита (#130)', () => {
    const MIN = 60_000;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0, 0));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('время распарсилось — до сброса + apiLimitGraceMin запаса', () => {
        expect(apiLimitWaitMs('resets 1pm', { apiLimitGraceMin: 5 })).toBe(60 * MIN + 5 * MIN);
    });

    it('без apiLimitGraceMin в конфиге — дефолт 5 минут запаса', () => {
        expect(apiLimitWaitMs('resets 1pm', {})).toBe(60 * MIN + 5 * MIN);
    });

    it('время не распарсилось — apiLimitFallbackWaitMin + запас', () => {
        expect(apiLimitWaitMs('лимит, но без времени', { apiLimitFallbackWaitMin: 30 })).toBe(
            30 * MIN + 5 * MIN,
        );
    });

    it('apiLimitGraceMin=0 — «без запаса» законный осознанный выбор', () => {
        expect(apiLimitWaitMs('resets 1pm', { apiLimitGraceMin: 0 })).toBe(60 * MIN);
    });

    it('мусор в apiLimitGraceMin/apiLimitFallbackWaitMin не превращается в вечный сон (#132)', () => {
        const ms = apiLimitWaitMs('resets 1pm', { apiLimitGraceMin: NaN });
        expect(Number.isFinite(ms)).toBe(true);
        const ms2 = apiLimitWaitMs('лимит без времени', {
            apiLimitFallbackWaitMin: 'скоро' as never,
        });
        expect(Number.isFinite(ms2)).toBe(true);
    });
});

describe('apiLimitMessage — формат события паузы (контракт с deadman.ts API_WAIT_RE)', () => {
    it('содержит округлённые минуты и «попытка N/maxWaits»', () => {
        const msg = apiLimitMessage(5.4 * 60_000, 0, 3);
        expect(msg).toMatch(/Жду 5 мин/);
        expect(msg).toMatch(/попытка 1\/3/);
    });

    it('attempt индексируется с 0, в сообщении — attempt+1', () => {
        const msg = apiLimitMessage(60_000, 2, 3);
        expect(msg).toMatch(/попытка 3\/3/);
    });
});

describe('apiLimitWaitMs — мусор в конфиге не превращается в вечный сон (#132)', () => {
    const { apiLimitWaitMs } = ralph;
    const MIN = 60 * 1000;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 6, 21, 12, 0, 0));
    });
    afterEach(() => vi.useRealTimers());

    // Atomics.wait(buf, 0, 0, NaN) спит БЕСКОНЕЧНО: NaN трактуется как +∞.
    // Раннер вставал бы навсегда, молча, с записью «Жду NaN мин» в логе.
    it.each([
        ['строка', 'abc'],
        ['null', null],
        ['объект', {}],
        ['отрицательное', -5],
    ])('apiLimitGraceMin = %s → дефолтные 5 минут, не NaN', (_name, value) => {
        const ms = apiLimitWaitMs('resets 1pm', { apiLimitGraceMin: value });
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBe(60 * MIN + 5 * MIN);
    });

    it('мусорный apiLimitFallbackWaitMin тоже не даёт NaN', () => {
        const ms = apiLimitWaitMs('лимит без времени', { apiLimitFallbackWaitMin: 'скоро' });
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBe(30 * MIN + 5 * MIN);
    });
});

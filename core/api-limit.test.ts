// Юнит-тесты модуля детекции/ожидания API-лимита (#361). Здесь проверяется САМ модуль
// api-limit.ts — чистые преобразования вход→выход, без ralph.js: контракт extraction'а —
// модуль самодостаточен (цель фазы 2), а не «работает только пока его зовёт ralph.js».
// В конце файла — блок, перенесённый из ralph.test.js при её разнесении по модулям
// (#366): он ходит через боевую поверхность ralph.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов: блок ниже перенесён из
// ralph.test.js как есть и ходит через боевую поверхность ralph.js (#366).
import ralph from '../ralph.js';
import { minutesOrDefault, apiLimitWaitMs, apiLimitMessage } from './api-limit.ts';

// Признаки лимита и бюджета ходов в выводе, время сброса окна — у адаптера рантайма
// (Фаза 16): их проверяет contract suite `adapters/session-end.test.ts` на фикстурах CLI.

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

    it('адаптер назвал время до сброса — оно + apiLimitGraceMin запаса', () => {
        expect(apiLimitWaitMs(60 * MIN, { apiLimitGraceMin: 5 })).toBe(60 * MIN + 5 * MIN);
    });

    it('без apiLimitGraceMin в конфиге — дефолт 5 минут запаса', () => {
        expect(apiLimitWaitMs(60 * MIN, {})).toBe(60 * MIN + 5 * MIN);
    });

    it('адаптер времени не назвал — apiLimitFallbackWaitMin + запас', () => {
        expect(apiLimitWaitMs(undefined, { apiLimitFallbackWaitMin: 30 })).toBe(30 * MIN + 5 * MIN);
    });

    it('apiLimitGraceMin=0 — «без запаса» законный осознанный выбор', () => {
        expect(apiLimitWaitMs(60 * MIN, { apiLimitGraceMin: 0 })).toBe(60 * MIN);
    });

    it('битое время от адаптера (NaN, отрицательное) — fallback, а не вечный или нулевой сон', () => {
        expect(apiLimitWaitMs(NaN, { apiLimitFallbackWaitMin: 30 })).toBe(35 * MIN);
        expect(apiLimitWaitMs(-1, { apiLimitFallbackWaitMin: 30 })).toBe(35 * MIN);
        expect(apiLimitWaitMs(Infinity, { apiLimitFallbackWaitMin: 30 })).toBe(35 * MIN);
    });

    it('мусор в apiLimitGraceMin/apiLimitFallbackWaitMin не превращается в вечный сон (#132)', () => {
        const ms = apiLimitWaitMs(60 * MIN, { apiLimitGraceMin: NaN });
        expect(Number.isFinite(ms)).toBe(true);
        const ms2 = apiLimitWaitMs(undefined, {
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
        const ms = apiLimitWaitMs(60 * MIN, { apiLimitGraceMin: value });
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBe(60 * MIN + 5 * MIN);
    });

    it('мусорный apiLimitFallbackWaitMin тоже не даёт NaN', () => {
        const ms = apiLimitWaitMs(undefined, { apiLimitFallbackWaitMin: 'скоро' });
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBe(30 * MIN + 5 * MIN);
    });
});

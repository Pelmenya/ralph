// Юнит-тесты модуля детекции/ожидания транзиентной недоступности рантайма (#606). Здесь
// проверяется САМ модуль runtime-availability.ts — чистые преобразования вход→выход, без
// orchestrator.ts: retry-цикл внутри runClaude покрыт своими тестами в orchestrator.test.ts.
import { describe, it, expect } from 'vitest';
import {
    runtimeUnavailableWaitMs,
    runtimeUnavailableMessage,
    runtimeUnavailableExhaustedMessage,
    DEFAULT_RUNTIME_UNAVAILABLE_MAX_WAIT_MS,
    DEFAULT_RUNTIME_UNAVAILABLE_RETRY_DELAY_MS,
    modelProxyRetryWaitMs,
    MODEL_PROXY_RETRIES,
} from './runtime-availability.ts';

// Детект недоступности — коды на границе spawn и в runClaude (orchestrator.test.ts); текстовой
// эвристики больше нет (Фаза 16). Обрыв прокси моделей — исход `interrupted` от адаптера,
// его фикстуры — в adapters/session-end.test.ts.

describe('runtimeUnavailableWaitMs — линейный backoff', () => {
    it('растёт линейно от базы (дефолт 10с)', () => {
        expect(runtimeUnavailableWaitMs(1)).toBe(10_000);
        expect(runtimeUnavailableWaitMs(2)).toBe(20_000);
        expect(runtimeUnavailableWaitMs(3)).toBe(30_000);
    });

    it('уважает cfg.runtimeUnavailableRetryDelayMs', () => {
        expect(runtimeUnavailableWaitMs(2, { runtimeUnavailableRetryDelayMs: 1000 })).toBe(2000);
    });

    it('мусорное значение конфига откатывается на дефолт', () => {
        expect(
            runtimeUnavailableWaitMs(1, {
                runtimeUnavailableRetryDelayMs: -5 as unknown as number,
            }),
        ).toBe(DEFAULT_RUNTIME_UNAVAILABLE_RETRY_DELAY_MS);
    });
});

describe('тексты сообщений — формулировка причины', () => {
    it('runtimeUnavailableMessage называет код и попытку', () => {
        const msg = runtimeUnavailableMessage(2, 20_000, 127);
        expect(msg).toMatch(/код 127/);
        expect(msg).toMatch(/попытка 2/);
        expect(msg).toMatch(/20с/);
    });

    it('runtimeUnavailableMessage добавляет код ОС, когда граница spawn его назвала', () => {
        // Ревью #612: на структурном пути #611 код процесса всегда 1 и сам по себе не значит
        // ничего — настоящая причина (ENOENT) обязана быть в той же строке.
        const msg = runtimeUnavailableMessage(1, 10_000, 1, 'ENOENT');
        expect(msg).toMatch(/код 1 \/ ENOENT/);
    });

    it('runtimeUnavailableExhaustedMessage несёт код ОС, если он известен', () => {
        const msg = runtimeUnavailableExhaustedMessage(300_000, 7, 'ENOENT');
        expect(msg).toMatch(/ENOENT/);
        expect(msg).toMatch(/7 повторов/);
    });

    it('runtimeUnavailableExhaustedMessage прямо называет причину «рантайм недоступен», не «вердикта не было»', () => {
        const msg = runtimeUnavailableExhaustedMessage(DEFAULT_RUNTIME_UNAVAILABLE_MAX_WAIT_MS, 7);
        expect(msg).toMatch(/рантайм недоступен/);
        expect(msg).toMatch(/5 мин/);
        expect(msg).toMatch(/7 повторов/);
        expect(msg).not.toMatch(/вердикт/);
    });
});

// Задача 78: прокси моделей отвечает «No upstream account» или overload, а `claude -p`
// выходит с кодом 0. По коду такую сессию от честной не отличить, поэтому детект идёт по
// тексту — и применяется только к проходу БЕЗ вердикта (см. оркестратор).
describe('modelProxyRetryWaitMs — пауза перед повтором', () => {
    it('растёт линейно от минуты', () => {
        expect(modelProxyRetryWaitMs(1)).toBe(60_000);
        expect(modelProxyRetryWaitMs(3)).toBe(180_000);
    });

    it('бюджет повторов конечен', () => {
        expect(MODEL_PROXY_RETRIES).toBeGreaterThan(0);
    });
});

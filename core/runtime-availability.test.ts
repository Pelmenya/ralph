// Юнит-тесты модуля детекции/ожидания транзиентной недоступности рантайма (#606). Здесь
// проверяется САМ модуль runtime-availability.ts — чистые преобразования вход→выход, без
// orchestrator.ts: retry-цикл внутри runClaude покрыт своими тестами в orchestrator.test.ts.
import { describe, it, expect } from 'vitest';
import {
    RUNTIME_UNAVAILABLE_RE,
    isRuntimeUnavailable,
    runtimeUnavailableWaitMs,
    runtimeUnavailableMessage,
    runtimeUnavailableExhaustedMessage,
    DEFAULT_RUNTIME_UNAVAILABLE_MAX_WAIT_MS,
    DEFAULT_RUNTIME_UNAVAILABLE_RETRY_DELAY_MS,
} from './runtime-availability.ts';

describe('isRuntimeUnavailable — детекция транзиентной недоступности CLI', () => {
    it.each([
        [127, ''],
        [127, 'что угодно'],
        [1, '/usr/local/bin/claude: line 70: /usr/bin/claude: No such file or directory'],
        [1, 'spawn claude ENOENT'],
        [1, 'bash: claude: ENOENT'],
    ])('код %i, вывод "%s" → транзиент', (code, output) => {
        expect(isRuntimeUnavailable(code, output)).toBe(true);
    });

    it.each([
        [1, 'просто упало'],
        [1, 'Error: тест не прошёл, ожидали 3 получили 4'],
        [1, ''],
        [2, 'permission denied'],
    ])('код %i, вывод "%s" → НЕ транзиент (настоящий крах сессии)', (code, output) => {
        expect(isRuntimeUnavailable(code, output)).toBe(false);
    });

    // Ревью #612 (blocker): регекс матчит ЛЮБОЙ текст, включая вывод УСПЕШНОЙ сессии,
    // процитировавшей чужую ошибку. Без барьера по коду такая сессия перезапускалась бы до
    // исчерпания бюджета, каждый раз заново делая побочки (коммиты, `gh pr create`,
    // повторная запись файла намерений → дубли комментариев в PR).
    it.each([
        [0, 'починил падавший тест: cat: x: No such file or directory'],
        [0, 'spawn claude ENOENT — упоминание в отчёте сессии'],
        [0, ''],
    ])('код 0 (успех), вывод "%s" → НЕ транзиент, чем бы сессия ни цитировала', (code, output) => {
        expect(isRuntimeUnavailable(code, output)).toBe(false);
    });

    it('структурный session-failed глушит текстовую эвристику: процесс стартовал и упал сам', () => {
        expect(
            isRuntimeUnavailable(
                1,
                'тест падал с No such file or directory — починил',
                'session-failed',
            ),
        ).toBe(false);
    });

    it('код 127 — транзиент ДАЖЕ при session-failed: так приходит отказ от шелл-обёртки', () => {
        // Инцидент 18.08: `/usr/local/bin/claude: line 70: /usr/bin/claude: No such file or
        // directory`. Обёртка стартовала и вернула 127 — граница spawn честно видит
        // session-failed, но это ровно тот транзиент, ради которого модуль и написан.
        expect(
            isRuntimeUnavailable(
                127,
                '/usr/local/bin/claude: line 70: /usr/bin/claude: No such file or directory',
                'session-failed',
            ),
        ).toBe(true);
    });

    it('без структурного класса (сторонний рантайм) текст остаётся defense-in-depth', () => {
        expect(isRuntimeUnavailable(1, 'spawn claude ENOENT', undefined)).toBe(true);
    });

    it('RUNTIME_UNAVAILABLE_RE не матчит осмысленный вывод модели', () => {
        expect(RUNTIME_UNAVAILABLE_RE.test('Все тесты прошли, PR готов к ревью')).toBe(false);
    });
});

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

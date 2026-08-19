// Юнит-тесты telegram-notifier.ts (#85). execFn всегда мокается явно — реальный
// curl запрещён в тестовом окружении (RALPH_NO_SIDE_EFFECTS=1, см. test-setup.ts);
// забытый мок ловит общий afterEach через sideEffectAttempts, а не тихо бьёт в сеть.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    sendTelegramMessage,
    telegramConfigFromEnv,
    TELEGRAM_API_BASE,
    TELEGRAM_DEFAULT_ATTEMPTS,
} from './telegram-notifier.ts';

describe('telegramConfigFromEnv', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = ORIGINAL_ENV;
    });

    it('читает token/chatId из RALPH_TG_BOT_TOKEN и RALPH_TG_CHAT_ID', () => {
        process.env.RALPH_TG_BOT_TOKEN = '123:abc';
        process.env.RALPH_TG_CHAT_ID = '42';
        expect(telegramConfigFromEnv()).toEqual({ token: '123:abc', chatId: '42' });
    });

    it('возвращает пустые строки, если переменные не заданы', () => {
        delete process.env.RALPH_TG_BOT_TOKEN;
        delete process.env.RALPH_TG_CHAT_ID;
        expect(telegramConfigFromEnv()).toEqual({ token: '', chatId: '' });
    });

    it('обрезает пробелы/переводы строк (копипаста в env-файл)', () => {
        process.env.RALPH_TG_BOT_TOKEN = ' 123:abc \r\n';
        process.env.RALPH_TG_CHAT_ID = ' 42 ';
        expect(telegramConfigFromEnv()).toEqual({ token: '123:abc', chatId: '42' });
    });
});

describe('sendTelegramMessage', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
        delete process.env.RALPH_TG_BOT_TOKEN;
        delete process.env.RALPH_TG_CHAT_ID;
    });

    afterEach(() => {
        process.env = ORIGINAL_ENV;
    });

    it('шлёт сообщение в заданный chat_id через execFn (токен — в stdin-конфиге, не в argv)', () => {
        const execFn = vi.fn().mockReturnValue(JSON.stringify({ ok: true }));

        const result = sendTelegramMessage('Фаза готова к релизу', {
            token: 'TOKEN123',
            chatId: 'CHAT456',
            execFn,
        });

        expect(result).toBe(true);
        expect(execFn).toHaveBeenCalledTimes(1);
        const [bin, args, opts] = execFn.mock.calls[0];
        expect(bin).toBe('curl');
        // URL с токеном не в argv (иначе виден в ps/proc), а в конфиге на stdin.
        expect(args).not.toContain(`${TELEGRAM_API_BASE}/botTOKEN123/sendMessage`);
        expect(args.join(' ')).not.toContain('TOKEN123');
        expect(opts.input).toContain(`${TELEGRAM_API_BASE}/botTOKEN123/sendMessage`);
        expect(args).toContain('--config');
        // api.telegram.org доступен из РФ напрямую — обход SS-туннеля.
        expect(args).toContain('--noproxy');
        expect(args).toContain('api.telegram.org');
        expect(args).toContain('chat_id=CHAT456');
        expect(args).toContain('text=Фаза готова к релизу');
    });

    it('берёт token/chatId из env, если не переданы параметром', () => {
        process.env.RALPH_TG_BOT_TOKEN = 'ENVTOKEN';
        process.env.RALPH_TG_CHAT_ID = 'ENVCHAT';
        const execFn = vi.fn().mockReturnValue(JSON.stringify({ ok: true }));

        const result = sendTelegramMessage('привет', { execFn });

        expect(result).toBe(true);
        expect(execFn.mock.calls[0][2].input).toContain(
            `${TELEGRAM_API_BASE}/botENVTOKEN/sendMessage`,
        );
        expect(execFn.mock.calls[0][1]).toContain('chat_id=ENVCHAT');
    });

    it('явные token/chatId параметра важнее env (не молчаливая подмена)', () => {
        process.env.RALPH_TG_BOT_TOKEN = 'ENVTOKEN';
        process.env.RALPH_TG_CHAT_ID = 'ENVCHAT';
        const execFn = vi.fn().mockReturnValue(JSON.stringify({ ok: true }));

        sendTelegramMessage('hi', { token: 'EXPLICIT', chatId: 'EXPLICITCHAT', execFn });

        expect(execFn.mock.calls[0][2].input).toContain(
            `${TELEGRAM_API_BASE}/botEXPLICIT/sendMessage`,
        );
        expect(execFn.mock.calls[0][1]).toContain('chat_id=EXPLICITCHAT');
    });

    it('обрезает текст до 4096 символов (Telegram вернул бы 400 на длинный)', () => {
        const execFn = vi.fn().mockReturnValue(JSON.stringify({ ok: true }));
        const long = 'я'.repeat(5000);

        sendTelegramMessage(long, { token: 'T', chatId: 'C', execFn });

        const textArg = execFn.mock.calls[0][1].find((a: string) => a.startsWith('text='));
        expect(textArg.slice('text='.length).length).toBe(4096);
    });

    it('обрезка по code points не разрубает суррогатную пару (эмодзи на границе не бьётся в U+FFFD)', () => {
        const execFn = vi.fn().mockReturnValue(JSON.stringify({ ok: true }));
        // 4095 обычных символов + эмодзи (суррогатная пара) на 4096-й позиции code point:
        // наивный UTF-16 slice(0,4096) разрубил бы пару и оставил одинокий суррогат.
        const text = 'a'.repeat(4095) + '🔔' + 'tail';

        sendTelegramMessage(text, { token: 'T', chatId: 'C', execFn });

        const sent = execFn.mock.calls[0][1]
            .find((a: string) => a.startsWith('text='))
            .slice('text='.length);
        expect([...sent].length).toBe(4096);
        expect(sent.endsWith('🔔')).toBe(true);
        expect(sent).not.toContain('�');
    });

    it('не светит токен в логе, даже если execFn бросил ошибку с ним в message', () => {
        const token = '123456:SECRETTOKEN';
        const execFn = vi.fn().mockImplementation(() => {
            throw new Error(
                `Command failed: curl -s url = "${TELEGRAM_API_BASE}/bot${token}/sendMessage"`,
            );
        });
        const logFn = vi.fn();

        // attempts: 1 — тест проверяет маскирование токена в одной попытке, не
        // ретраи (те — отдельный describe ниже).
        const result = sendTelegramMessage('событие', {
            token,
            chatId: 'C',
            execFn,
            logFn,
            attempts: 1,
        });

        expect(result).toBe(false);
        for (const [msg] of logFn.mock.calls) {
            expect(msg).not.toContain(token);
        }
        expect(logFn.mock.calls.some(([msg]) => msg.includes('***'))).toBe(true);
    });

    it('fail-open: не бросает и возвращает false, если нет token/chatId', () => {
        const execFn = vi.fn();
        const logFn = vi.fn();

        const result = sendTelegramMessage('событие', { execFn, logFn });

        expect(result).toBe(false);
        expect(execFn).not.toHaveBeenCalled();
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('RALPH_TG_BOT_TOKEN'));
    });

    it('fail-open: не бросает и возвращает false, если execFn упал (сеть/curl)', () => {
        const execFn = vi.fn().mockImplementation(() => {
            throw new Error('curl: (28) Connection timed out');
        });
        const logFn = vi.fn();

        // attempts: 1 — без ретраев, чтобы не тянуть реальный sleepFn в тесте на
        // единичный отказ (ретраи проверяются отдельным describe).
        expect(() =>
            sendTelegramMessage('событие', {
                token: 'T',
                chatId: 'C',
                execFn,
                logFn,
                attempts: 1,
            }),
        ).not.toThrow();
        const result = sendTelegramMessage('событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            attempts: 1,
        });

        expect(result).toBe(false);
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('отправка не удалась'));
    });

    it('fail-open: false и лог, если Telegram API отклонил сообщение (ok:false)', () => {
        const execFn = vi
            .fn()
            .mockReturnValue(JSON.stringify({ ok: false, description: 'chat not found' }));
        const logFn = vi.fn();

        const result = sendTelegramMessage('событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            attempts: 1,
        });

        expect(result).toBe(false);
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('chat not found'));
    });

    it('fail-open: false и лог, если ответ не парсится как JSON', () => {
        const execFn = vi.fn().mockReturnValue('<html>502 Bad Gateway</html>');
        const logFn = vi.fn();

        const result = sendTelegramMessage('событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            attempts: 1,
        });

        expect(result).toBe(false);
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('не удалось разобрать ответ'));
    });
});

describe('sendTelegramMessage — ретраи доставки (#224)', () => {
    it('транзиентный сбой первой попытки не теряет событие: вторая попытка доставляет', () => {
        const execFn = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new Error('curl: (28) Connection timed out');
            })
            .mockReturnValueOnce(JSON.stringify({ ok: true }));
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        const result = sendTelegramMessage('срочное событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            sleepFn,
        });

        expect(result).toBe(true);
        expect(execFn).toHaveBeenCalledTimes(2);
        expect(sleepFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledWith(5000); // retryBaseMs(5000) × попытка(1)
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('попытка 1/3'));
        // Раз доставлено — «ПУШ НЕ ДОСТАВЛЕН» появляться не должно.
        expect(logFn.mock.calls.some(([msg]) => msg.includes('ПУШ НЕ ДОСТАВЛЕН'))).toBe(false);
    });

    it('транзиентный сбой первых двух попыток не теряет событие: третья доставляет, пауза нарастает', () => {
        const execFn = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new Error('curl: (28) Connection timed out');
            })
            .mockImplementationOnce(() => {
                throw new Error('curl: (7) Couldn’t connect');
            })
            .mockReturnValueOnce(JSON.stringify({ ok: true }));
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        const result = sendTelegramMessage('срочное событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            sleepFn,
        });

        expect(result).toBe(true);
        expect(execFn).toHaveBeenCalledTimes(3);
        expect(sleepFn).toHaveBeenCalledTimes(2);
        // Нарастающая пауза: retryBaseMs × номер попытки (образец — ghJson в ralph.js).
        expect(sleepFn.mock.calls[0][0]).toBe(5000);
        expect(sleepFn.mock.calls[1][0]).toBe(10000);
    });

    it('исчерпание всех попыток: прогон продолжается (fail-open) + заметная строка о потере события', () => {
        const execFn = vi.fn().mockImplementation(() => {
            throw new Error('curl: (28) Connection timed out');
        });
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        let result;
        expect(() => {
            result = sendTelegramMessage('критичное событие потерялось бы', {
                token: 'T',
                chatId: 'C',
                execFn,
                logFn,
                sleepFn,
            });
        }).not.toThrow();

        expect(result).toBe(false);
        expect(execFn).toHaveBeenCalledTimes(TELEGRAM_DEFAULT_ATTEMPTS);
        expect(sleepFn).toHaveBeenCalledTimes(TELEGRAM_DEFAULT_ATTEMPTS - 1);
        expect(
            logFn.mock.calls.some(([msg]) =>
                msg.includes('⚠ ПУШ НЕ ДОСТАВЛЕН: критичное событие потерялось бы'),
            ),
        ).toBe(true);
    });

    it('число попыток и пауза настраиваются (attempts/retryBaseMs), дефолт — 3 попытки', () => {
        const execFn = vi.fn().mockImplementation(() => {
            throw new Error('curl: (28) Connection timed out');
        });
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        sendTelegramMessage('событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            sleepFn,
            attempts: 5,
            retryBaseMs: 1000,
        });

        expect(execFn).toHaveBeenCalledTimes(5);
        expect(sleepFn).toHaveBeenCalledTimes(4);
        expect(sleepFn.mock.calls[0][0]).toBe(1000);
        expect(sleepFn.mock.calls[3][0]).toBe(4000);
    });

    it('реальных вызовов curl/сети нет: execFn — единственная точка, sleepFn — единственная пауза', () => {
        const execFn = vi.fn().mockImplementation(() => {
            throw new Error('curl: (28) Connection timed out');
        });
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        sendTelegramMessage('событие', { token: 'T', chatId: 'C', execFn, logFn, sleepFn });

        // Единственная побочка — через инжектированные execFn/sleepFn; realExecFn/
        // realSleep (боевые curl/Atomics.wait) сюда не долетают.
        expect(execFn).toHaveBeenCalled();
        expect(sleepFn).toHaveBeenCalled();
    });

    it('#TFO9Q: постоянный 4xx (chat not found) НЕ ретраится — одна попытка, без синхронных пауз', () => {
        const execFn = vi.fn().mockReturnValue(
            JSON.stringify({
                ok: false,
                error_code: 400,
                description: 'Bad Request: chat not found',
            }),
        );
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        const result = sendTelegramMessage('событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            sleepFn,
            attempts: 3,
        });

        expect(result).toBe(false);
        // Ретрая нет: одна попытка, ни одной паузы, несмотря на attempts=3.
        expect(execFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).not.toHaveBeenCalled();
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('постоянный отказ API'));
    });

    it('#TFO9Q: 429 ретраится и уважает parameters.retry_after (сек → мс), а не фиксированную паузу', () => {
        const execFn = vi
            .fn()
            .mockReturnValueOnce(
                JSON.stringify({
                    ok: false,
                    error_code: 429,
                    description: 'Too Many Requests',
                    parameters: { retry_after: 7 },
                }),
            )
            .mockReturnValueOnce(JSON.stringify({ ok: true }));
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        const result = sendTelegramMessage('событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            sleepFn,
            retryBaseMs: 5000,
        });

        expect(result).toBe(true);
        expect(execFn).toHaveBeenCalledTimes(2);
        // Пауза — из retry_after (7с), а не нарастающая base×1 (5с).
        expect(sleepFn).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledWith(7000);
    });

    it('#TFO9U: мусорный retryBaseMs не вешает раннер (NaN-таймаут = +∞), откат на дефолт', () => {
        const execFn = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new Error('curl: (28) Connection timed out');
            })
            .mockReturnValueOnce(JSON.stringify({ ok: true }));
        const logFn = vi.fn();
        const sleepFn = vi.fn();

        const result = sendTelegramMessage('событие', {
            token: 'T',
            chatId: 'C',
            execFn,
            logFn,
            sleepFn,
            // Намеренно невалидный тип — проверяем откат positiveIntOrDefault на дефолт,
            // а не то, что вызывающий код всегда прав.
            retryBaseMs: 'мусор' as unknown as number,
        });

        expect(result).toBe(true);
        // waitMs конечен: откат на TELEGRAM_RETRY_BASE_MS (5000×1), не NaN.
        expect(sleepFn).toHaveBeenCalledWith(5000);
    });
});

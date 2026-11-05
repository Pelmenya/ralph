import { describe, expect, it, vi } from 'vitest';
import {
    KIMI_MAX_RESET_WAIT_MS,
    KIMI_WINDOW_CONFIRMED_RATIO,
    KIMI_WINDOW_EXHAUSTED_RATIO,
    kimiAccessToken,
    kimiResetWaitFromUsage,
    kimiResetWaitMs,
} from './kimi-usage.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const usage = (usages: unknown) => JSON.stringify({ limits: [], usages });
const window = (ratio: unknown, reset: unknown) => ({ used_ratio: ratio, reset_time: reset });
const IN_HOUR = '2026-11-05T13:00:00Z';
const HOUR = 60 * 60 * 1000;

describe('kimiResetWaitFromUsage', () => {
    it('исчерпанное окно — срок до его сброса; неисчерпанные срок не держат', () => {
        const body = usage({
            limit_5h: window(1, IN_HOUR),
            limit_month_total: window(0.5, '2026-11-30T00:00:00Z'),
        });
        expect(kimiResetWaitFromUsage(body, NOW)).toEqual({ waitMs: HOUR });
    });

    it('исчерпаны два окна — ждём самое позднее, иначе проба упрётся в оставшееся', () => {
        const body = usage({
            limit_5h: window(1, IN_HOUR),
            limit_month_code: window(1, '2026-11-05T14:00:00Z'),
        });
        expect(kimiResetWaitFromUsage(body, NOW)).toEqual({ waitMs: 2 * HOUR });
    });

    it('граница исчерпания: ровно порог — да, ниже — нет', () => {
        const at = usage({ limit_5h: window(KIMI_WINDOW_EXHAUSTED_RATIO, IN_HOUR) });
        expect(kimiResetWaitFromUsage(at, NOW)).toEqual({ waitMs: HOUR });
        const below = usage({ limit_5h: window(KIMI_WINDOW_EXHAUSTED_RATIO - 0.001, IN_HOUR) });
        expect(kimiResetWaitFromUsage(below, NOW)).toEqual({
            problem: 'ни одно окно не исчерпано',
        });
    });

    it('доказательство упора строже срока известного упора', () => {
        const body = usage({ limit_5h: window(0.995, IN_HOUR) });
        expect(kimiResetWaitFromUsage(body, NOW)).toEqual({ waitMs: HOUR });
        expect(kimiResetWaitFromUsage(body, NOW, KIMI_WINDOW_CONFIRMED_RATIO)).toEqual({
            problem: 'ни одно окно не исчерпано',
        });
    });

    it('сброс дальше предела не становится сроком: недели сна хуже запасного пути', () => {
        const at = (ms: number) => new Date(NOW + ms).toISOString();
        const edge = usage({ limit_5h: window(1, at(KIMI_MAX_RESET_WAIT_MS)) });
        expect(kimiResetWaitFromUsage(edge, NOW)).toEqual({ waitMs: KIMI_MAX_RESET_WAIT_MS });
        const month = usage({
            limit_5h: window(1, IN_HOUR),
            limit_month_total: window(1, '2026-11-30T00:00:00Z'),
        });
        expect(kimiResetWaitFromUsage(month, NOW)).toEqual({
            problem: 'окно сбросится не раньше чем через 25 сут',
        });
    });

    it.each([
        ['сброс в прошлом', window(1, '2026-11-05T11:00:00Z')],
        ['сброс ровно сейчас', window(1, '2026-11-05T12:00:00Z')],
        ['сброс не дата', window(1, 'скоро')],
        ['сброс не строка', window(1, 1793000000)],
        ['сброса нет', { used_ratio: 1 }],
    ])('%s — срока нет', (_name, value) => {
        expect(kimiResetWaitFromUsage(usage({ limit_5h: value }), NOW)).toEqual({
            problem: 'у исчерпанного окна нет будущего срока сброса',
        });
    });

    it('чужие поля и битые окна не считаются', () => {
        const body = usage({
            other: window(1, IN_HOUR),
            limit_a: 'x',
            limit_b: window('1', IN_HOUR),
        });
        expect(kimiResetWaitFromUsage(body, NOW)).toEqual({
            problem: 'ни одно окно не исчерпано',
        });
    });

    it.each([
        ['не JSON', 'нет'],
        ['не объект', '[]'],
        ['без usages', '{"error":"unauthorized"}'],
        ['usages массивом', '{"usages":[]}'],
    ])('%s — отказ', (_name, body) => {
        expect(kimiResetWaitFromUsage(body, NOW)).toEqual({ problem: 'ответ без usages' });
    });
});

describe('kimiAccessToken', () => {
    const SOON = NOW / 1000 + 3600;
    const read = (text: string) => ({
        listDirFn: () => ['b.json', 'a.json', 'c.lock'],
        readFileFn: vi.fn((_file: string) => text),
    });

    it('берёт токен первого по имени файла входа', () => {
        const deps = read(JSON.stringify({ access_token: 't', expires_at: SOON }));
        expect(kimiAccessToken('/h', NOW, deps)).toEqual({ token: 't' });
        expect(deps.readFileFn).toHaveBeenCalledWith('/h/credentials/a.json');
    });

    it.each([
        ['истёк', { access_token: 't', expires_at: NOW / 1000 }, 'токен истёк'],
        ['срока нет', { access_token: 't' }, 'токен истёк'],
        ['токена нет', { expires_at: SOON }, 'в файле входа нет токена'],
        ['токен пуст', { access_token: '', expires_at: SOON }, 'в файле входа нет токена'],
    ])('%s — отказ', (_name, value, problem) => {
        expect(kimiAccessToken('/h', NOW, read(JSON.stringify(value)))).toEqual({ problem });
    });

    it('битый файл, нет файлов, нет каталога — отказ, а не исключение', () => {
        expect(kimiAccessToken('/h', NOW, read('нет'))).toEqual({
            problem: 'в файле входа нет токена',
        });
        expect(kimiAccessToken('/h', NOW, { listDirFn: () => [] })).toEqual({
            problem: 'файла входа нет',
        });
        const boom = () => {
            throw new Error('ENOENT');
        };
        expect(kimiAccessToken('/h', NOW, { listDirFn: boom })).toEqual({
            problem: 'файл входа не прочитан',
        });
        expect(
            kimiAccessToken('/h', NOW, { listDirFn: () => ['a.json'], readFileFn: boom }),
        ).toEqual({ problem: 'файл входа не прочитан' });
    });
});

describe('kimiResetWaitMs', () => {
    const run = (over: Partial<Parameters<typeof kimiResetWaitMs>[0]> = {}) => {
        const logFn = vi.fn();
        const fetchFn = vi.fn((_url: string, _auth: string) =>
            usage({ limit_5h: window(1, IN_HOUR) }),
        );
        const waitMs = kimiResetWaitMs({
            home: '/h',
            nowFn: () => NOW,
            logFn,
            tokenFn: () => ({ token: 'tok' }),
            fetchFn,
            ...over,
        });
        return { waitMs, logFn, fetchFn };
    };

    it('срок из ответа, адрес по умолчанию, токен в заголовке', () => {
        const { waitMs, logFn, fetchFn } = run();
        expect(waitMs).toBe(HOUR);
        expect(fetchFn).toHaveBeenCalledWith(
            'https://api.kimi.com/coding/v1/usages',
            'Authorization: Bearer tok',
        );
        expect(logFn).toHaveBeenCalledWith('ℹ Kimi /usages: окно сбросится через 60 мин');
    });

    it('confirmed: окно 99 % упором не считается, срока нет', () => {
        const body = () => usage({ limit_5h: window(0.995, IN_HOUR) });
        expect(run({ fetchFn: body }).waitMs).toBe(HOUR);
        const { waitMs, logFn } = run({ fetchFn: body, confirmed: true });
        expect(waitMs).toBeUndefined();
        expect(logFn).toHaveBeenCalledWith(
            '⚠ Kimi /usages: ни одно окно не исчерпано — срока сброса нет',
        );
    });

    it('каждый сбой — undefined и причина в логе, токен туда не попадает', () => {
        const boom = () => {
            throw new Error('Authorization: Bearer tok');
        };
        const cases = [
            [run({ home: null }), 'дом CLI не найден'],
            [run({ tokenFn: () => ({ problem: 'токен истёк' }) }), 'токен истёк'],
            [run({ fetchFn: boom }), 'запрос не прошёл'],
            [run({ fetchFn: () => '{}' }), 'ответ без usages'],
        ] as const;
        for (const [res, problem] of cases) {
            expect(res.waitMs).toBeUndefined();
            expect(res.logFn).toHaveBeenCalledWith(`⚠ Kimi /usages: ${problem} — срока сброса нет`);
            expect(JSON.stringify(res.logFn.mock.calls)).not.toContain('tok');
        }
    });
});

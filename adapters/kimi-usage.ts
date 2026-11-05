// Срок сброса квоты Kimi Code из API лимитов.
//
// Строка отказа CLI времени сброса не несёт (`classifyKimiNativeSessionEnd`), и без него петля
// спала запасным сроком: 3 ожидания по 35 минут кончались раньше 5-часового окна, и упор
// превращался в упавшую сессию. Срок есть в том же источнике, что у самого CLI
// (`getManagedUsage`): `GET <база>/usages`, поля `usages.limit_*.used_ratio` и `.reset_time`.
//
// Токен только читается и уходит в curl через stdin, а не в argv: argv виден в `ps`. Обновлять
// его здесь нельзя: refresh общий с сессиями, и обновление снаружи разлогинило бы их. Адрес —
// константа, а не `KIMI_CODE_BASE_URL`: раннер снимает эту переменную с окружения сессии как
// недоверенную (`kimiSessionEnv`), и чтение её здесь отправило бы токен на чужой адрес.
//
// Каждый сбой — `undefined`, а не исключение: запрос идёт на уже случившемся отказе, и сбой чтения
// лимитов обязан оставить его прежний исход, а не уронить раннер. Этот же ответ решает, лимит ли
// отказ с незнакомой формулировкой: окно исчерпано — упор, не исчерпано — исход остаётся.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

const HINT = 'Подмени tokenFn и fetchFn или файловые коллабораторы лимитов Kimi в тесте.';
const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
const CURL_TIMEOUT_S = 10;
// Порог для срока уже узнанного упора: `used_ratio` приходит округлённым, а граница, на которой
// площадка отказывает, не задокументирована. Для ДОКАЗАТЕЛЬСТВА упора он не годится: 1 % остатка
// не объясняет постороннего отказа, и `Bad gateway` ушёл бы ждать. Там нужна единица.
export const KIMI_WINDOW_EXHAUSTED_RATIO = 0.99;
export const KIMI_WINDOW_CONFIRMED_RATIO = 1;
// Предел доверенного срока: 5-часовое окно плюс запас. Месячный сброс — это недели сна, в которых
// мягкая остановка не проверяется, поэтому такой срок не отдаётся, и петля идёт запасным путём,
// который `apiLimitMaxWaits` ограничивает часами.
export const KIMI_MAX_RESET_WAIT_MS = 6 * 60 * 60 * 1000;

export type TKimiUsageFetch = (url: string, authHeader: string) => string;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Сколько ждать по ответу `/usages`. Исчерпанных окон бывает несколько, и разрешит запрос только
 * самое позднее. Сброс в прошлом окном уже не держит. Причина отказа — фиксированный текст: тело
 * ответа в лог не идёт.
 */
export function kimiResetWaitFromUsage(
    body: string,
    nowMs: number,
    minRatio: number = KIMI_WINDOW_EXHAUSTED_RATIO,
): { waitMs: number } | { problem: string } {
    const parsed = parseJson(body);
    if (!isRecord(parsed) || !isRecord(parsed.usages)) return { problem: 'ответ без usages' };
    let waitMs: number | null = null;
    let exhausted = 0;
    for (const [name, value] of Object.entries(parsed.usages)) {
        if (!name.startsWith('limit_') || !isRecord(value)) continue;
        const ratio = value.used_ratio;
        if (typeof ratio !== 'number' || ratio < minRatio) continue;
        exhausted++;
        const resetAt =
            typeof value.reset_time === 'string' ? Date.parse(value.reset_time) : Number.NaN;
        if (Number.isNaN(resetAt) || resetAt <= nowMs) continue;
        waitMs = Math.max(waitMs ?? 0, resetAt - nowMs);
    }
    if (waitMs !== null && waitMs > KIMI_MAX_RESET_WAIT_MS) {
        const days = Math.ceil(waitMs / (24 * 60 * 60 * 1000));
        return { problem: `окно сбросится не раньше чем через ${days} сут` };
    }
    if (waitMs !== null) return { waitMs };
    return {
        problem:
            exhausted === 0
                ? 'ни одно окно не исчерпано'
                : 'у исчерпанного окна нет будущего срока сброса',
    };
}

/** Токен входа из дома CLI: истёкший не годится, а обновлять его отсюда нельзя (см. докблок). */
export function kimiAccessToken(
    home: string,
    nowMs: number,
    {
        /* v8 ignore start */
        listDirFn = (dir) => {
            guardSideEffect(`kimiAccessToken:list(${dir})`, HINT);
            return fs.readdirSync(dir);
        },
        readFileFn = (file) => {
            guardSideEffect(`kimiAccessToken:read(${file})`, HINT);
            return fs.readFileSync(file, 'utf8');
        },
        /* v8 ignore stop */
    }: {
        listDirFn?: (dir: string) => string[];
        readFileFn?: (file: string) => string;
    } = {},
): { token: string } | { problem: string } {
    const dir = path.join(home, 'credentials');
    let text: string;
    try {
        const file = listDirFn(dir)
            .filter((name) => name.endsWith('.json'))
            .sort()[0];
        if (file === undefined) return { problem: 'файла входа нет' };
        text = readFileFn(path.join(dir, file));
    } catch {
        return { problem: 'файл входа не прочитан' };
    }
    const parsed = parseJson(text);
    if (!isRecord(parsed) || typeof parsed.access_token !== 'string' || !parsed.access_token) {
        return { problem: 'в файле входа нет токена' };
    }
    if (typeof parsed.expires_at !== 'number' || parsed.expires_at * 1000 <= nowMs) {
        return { problem: 'токен истёк' };
    }
    return { token: parsed.access_token };
}

/** Прокси не нужен и вредит: Kimi доступна напрямую, а прокси окружения мог бы повесить запрос. */
/* v8 ignore start */
export const defaultKimiUsageFetch: TKimiUsageFetch = (url, authHeader) => {
    guardSideEffect(`kimiUsageFetch(${url})`, HINT);
    const res = spawnSync(
        'curl',
        ['-sS', '--noproxy', '*', '-m', String(CURL_TIMEOUT_S), '-H', '@-', url],
        { input: `${authHeader}\n`, encoding: 'utf8', timeout: (CURL_TIMEOUT_S + 5) * 1000 },
    );
    if (res.status !== 0) throw new Error(`curl вернул ${String(res.status)}`);
    return res.stdout;
};
/* v8 ignore stop */

/**
 * Срок сброса по состоянию квоты. `undefined` — срок не установлен: у исхода `api-limit` ядро
 * возьмёт запасной (`apiLimitFallbackWaitMin`), остальные исходы не меняются. Причина идёт в лог,
 * потому что молча это выглядело бы как упор без срока, а у него другое лечение. `confirmed` —
 * упор ещё надо доказать: отказ не опознан, и срок годен только у окна, исчерпанного полностью.
 */
export function kimiResetWaitMs({
    home,
    confirmed = false,
    nowFn = Date.now,
    logFn,
    tokenFn = kimiAccessToken,
    fetchFn = defaultKimiUsageFetch,
}: {
    home: string | null;
    confirmed?: boolean;
    nowFn?: () => number;
    logFn: (line: string) => void;
    tokenFn?: (home: string, nowMs: number) => { token: string } | { problem: string };
    fetchFn?: TKimiUsageFetch;
}): number | undefined {
    const refuse = (problem: string) => {
        logFn(`⚠ Kimi /usages: ${problem} — срока сброса нет`);
        return undefined;
    };
    if (home === null) return refuse('дом CLI не найден');
    const nowMs = nowFn();
    const login = tokenFn(home, nowMs);
    if ('problem' in login) return refuse(login.problem);
    let body: string;
    try {
        body = fetchFn(KIMI_USAGE_URL, `Authorization: Bearer ${login.token}`);
    } catch {
        return refuse('запрос не прошёл');
    }
    const minRatio = confirmed ? KIMI_WINDOW_CONFIRMED_RATIO : KIMI_WINDOW_EXHAUSTED_RATIO;
    const wait = kimiResetWaitFromUsage(body, nowMs, minRatio);
    if ('problem' in wait) return refuse(wait.problem);
    logFn(`ℹ Kimi /usages: окно сбросится через ${Math.ceil(wait.waitMs / 60000)} мин`);
    return wait.waitMs;
}

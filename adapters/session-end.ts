// Исход сессии рантайма — нейтральный `SessionEndReason` (Фаза 16, #112).
//
// Раньше ядро решало о повторе по тексту вывода: `API_LIMIT_RE` — ждать окна лимита,
// `TURN_LIMIT_RE` — продолжить новой сессией, ENOENT-текст — переждать обновление CLI,
// «No upstream account» — повторить ревью. Текст меняется с каждой версией CLI и разный у
// разных харнессов, а регулярка, переставшая совпадать, молча превращает лимит в «упала»
// или обрыв в «готово». Поэтому признаки исхода переехали сюда, к адаптеру рантайма: он
// знает свой CLI, а ядро получает одно слово из закрытого списка и решает только по нему.
// Образец — сентинелы исхода в `derbush/all-together`: харнесс называет, чем кончился
// запуск, политика повтора живёт выше.
//
// Семь исходов выбраны по решениям, которые ядро действительно принимает:
//   - `completed`   — сессия отработала (код 0): применить намерения, идти дальше;
//   - `api-limit`   — окно лимита провайдера: ротация ключа, фолбэк, ожидание;
//   - `auth`        — вход отвергнут: повтор не лечит, нужен человек — без ожидания;
//   - `turn-limit`  — исчерпан бюджет ходов: «не успела», продолжить новой сессией;
//   - `interrupted` — обрыв на стороне провайдера или канала (прокси без аккаунта,
//                     overload, разорванный поток): ревью без вердикта переживает его повтором;
//   - `timeout`     — сессию убили по сроку раннера: не маскировать под лимит;
//   - `unknown`     — «прочее»: адаптер исход не узнал. Ядро пишет это в лог и успехом
//                     не считает никогда.
// Отказ ЗАПУСКА процесса (бинаря нет, argv не влез) — не исход сессии: его несёт
// `failureKind` с границы spawn (`core/spawn-failure.ts`), исход такого запуска — `unknown`.
//
// Порядок проверок внутри классификатора — часть контракта, у каждой ступени свой отказ:
//   1. сигнал раньше всего: убитая по сроку сессия могла успеть напечатать что угодно;
//   2. код 0 — `completed`, кроме обрыва: прокси моделей отвечал «No upstream account» и
//      CLI выходил НУЛЁМ за 8 с (инцидент 16.10), и ядро узнаёт это только отсюда. У
//      JSON-результата с `is_error: false` (а боевой spawn всегда JSON) обрыв узнаётся только
//      формулировкой, которой `result` является целиком: поиск по всему тексту записал бы
//      обрывом ревью, цитирующее «API Error: 503», а отказ от текста вовсе снял бы инцидент
//      16.10 — CLI отдаёт ответ прокси как текст модели, без признака ошибки;
//   3. при ненулевом коде — структурный признак CLI (`subtype` JSON-результата Claude)
//      раньше текста, а среди текстовых — узкие формулировки раньше широких: «Server is
//      temporarily limiting requests (not your usage limit)» содержит слова «usage limit»
//      и прежней регуляркой читался лимитом — то есть сном до сброса окна на перегрузке.
//
// Текст модели — не признак исхода: классификатор читает ошибки CLI, а не прозу. У Claude
// проза и ошибка лежат в одном `result`, и разводит их только `is_error`; у Codex проза
// идёт в stdout, ошибки — строками `ERROR:` в stderr, и читаются только они. Сессия,
// правившая код входа или ретраев, иначе получала бы `auth`/`api-limit` по своему тексту,
// а `api-limit` — это сон до 30 мин на каждое из `apiLimitMaxWaits`.
//
// Фикстуры исходов — `adapters/__fixtures__/session-end-*.json`, contract suite —
// `adapters/session-end.test.ts`: семь исходов у каждого зарегистрированного рантайма.
//
// TS-модуль без билд-шага (erasable-only), без побочек: чистые функции вход→выход.

import type { SessionEnd, SessionEndReason, SpawnFailureKind } from './adapters.ts';

// Наблюдаемое на границе spawn: всё, по чему адаптер вправе судить об исходе. Вывод — СЫРОЙ
// (stdout до перевода JSON в текст), иначе классификатор не видел бы структурных полей CLI.
export type SessionEndInput = {
    code: number;
    stdout: string;
    stderr: string;
    signal?: string | null;
    failureKind?: SpawnFailureKind;
};

export type SessionEndClassifier = (input: SessionEndInput) => SessionEnd;

// ── Claude Code CLI (и Kimi — тот же бинарь с другим endpoint) ─────────────────────────

// Боевой пример (2026-07-19): «You've hit your session limit · resets 1:20pm» — первая
// версия ждала только «usage limit» и промахнулась; ловим шире. `API Error: 429` — код,
// а не формулировка: у Kimi тот же бинарь несёт ответ Moonshot со своим телом, и лимит
// провайдера без кода узнавался бы, только если в теле случайно стоит «rate limit».
const CLAUDE_API_LIMIT_RE =
    /(usage limit|session limit|rate.?limit|5-hour limit|hit your .{0,20}limit|limit (?:reached|exceeded)|limit will reset|resets? at|API Error:\s*429\b)/i;

// #594: «Reached max turns (N)» текстового режима и «Reached maximum number of turns (N)»
// JSON-режима. Узко — чтобы не цеплять живую речь модели про «turns».
const CLAUDE_TURN_LIMIT_RE =
    /(reached max turns|reached maximum number of turns|max turns (?:reached|exceeded))/i;

// Формулировки входа из CLI 2.1.311: «Not logged in · Please run /login», «Invalid API
// key», «OAuth token revoked», «Login expired», «Failed to authenticate», и ответ API 401.
const CLAUDE_AUTH_RE =
    /(Please run \/login|Not logged in|Invalid API key|Invalid auth token|OAuth token (?:revoked|has expired)|Login expired|Failed to authenticate|authentication_error|API Error:\s*401\b)/i;

// Обрыв: прокси без аккаунта (16.10), overload — только в ФОРМЕ ошибки API (`overloaded`
// встречается в прозе ревью про перегрузки функций TS), 5xx ответа API (524 Cloudflare —
// из транскриптов), разорванный поток и «временное ограничение» сервера, которое CLI сам
// называет «not your usage limit».
const CLAUDE_INTERRUPTED_RE =
    /(No upstream account is currently available|overloaded_error|API Error:\s*5\d\d\b|Connection lost mid-response|not your usage limit)/i;

// Обрыв, узнаваемый только ЦЕЛЫМ `result`: отказ прокси, весь ответ которого — одна
// фраза, или ответ, начинающийся с ошибки API 5xx. Цитата тех же слов в прозе (ревью этого
// классификатора) стоит посреди текста и сюда не попадает.
const CLAUDE_INTERRUPTED_WHOLE_RE =
    /^\s*(?:No upstream account is currently available\.?\s*$|API Error:\s*5\d\d\b)/i;

// «resets 3am» / «reset at 7:30pm» → мс до сброса (прошедшее время суток = завтра). Зона —
// из суффикса, если CLI её назвал: «resets 8:20pm (UTC)», «(Europe/Moscow)»; без суффикса —
// локальное время хоста, на котором CLI и печатает. Незнакомая зона и не распарсилось →
// undefined: ядро возьмёт `apiLimitFallbackWaitMin`. Зону игнорировать нельзя: на хосте не в
// UTC ожидание ошибалось бы на смещение — раннее пробуждение сжигает попытку из
// `apiLimitMaxWaits`, позднее — часы простоя.
export function parseResetWaitMs(text: string, now: Date = new Date()): number | undefined {
    const m = /reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)\s]+)\))?/i.exec(
        text,
    );
    if (!m) return undefined;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] ? m[3].toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return undefined;
    if (m[4]) return zonedResetWaitMs(m[4], h, min, now);
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
}

// Смещение зоны (мс) в момент `ms`: настенное время зоны как UTC минус сам момент.
function zoneOffsetMs(fmt: Intl.DateTimeFormat, ms: number): number {
    const p: Record<string, number> = {};
    for (const part of fmt.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10);
    }
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return wall - Math.floor(ms / 1000) * 1000;
}

function zonedResetWaitMs(zone: string, h: number, min: number, now: Date): number | undefined {
    let fmt: Intl.DateTimeFormat;
    try {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
        });
    } catch {
        return undefined;
    }
    const nowMs = now.getTime();
    const today = new Date(nowMs + zoneOffsetMs(fmt, nowMs));
    for (const addDays of [0, 1]) {
        const wall = Date.UTC(
            today.getUTCFullYear(),
            today.getUTCMonth(),
            today.getUTCDate() + addDays,
            h,
            min,
        );
        // Смещение берётся в момент самой цели, а не «сейчас»: между ними бывает перевод часов.
        const target = wall - zoneOffsetMs(fmt, wall - zoneOffsetMs(fmt, wall));
        if (target > nowMs) return target - nowMs;
    }
    return undefined;
}

// Конверт JSON-результата `--output-format json` — объект `type: "result"` или null. Один
// разбор на два читателя: классификатор исхода ниже и перевод результата в текст для лога и
// стоимости (`parseClaudeJsonResult`, core/attempt-cost.ts). Две копии разбора одной формы
// разъехались бы при следующей правке CLI.
export function readClaudeResultEnvelope(stdout: string): Record<string, unknown> | null {
    let v: unknown;
    try {
        v = JSON.parse(stdout.trim());
    } catch {
        return null;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const r = v as Record<string, unknown>;
    return r.type === 'result' ? r : null;
}

// Из конверта берутся `subtype` и `is_error` (структурные признаки исхода) и текст — `result`
// плюс `errors`. Не JSON-результат — текст как есть, признаков нет.
function claudeResult(stdout: string): {
    subtype: string | null;
    isError: boolean | null;
    text: string;
} {
    const r = readClaudeResultEnvelope(stdout);
    if (!r) return { subtype: null, isError: null, text: stdout };
    const parts: string[] = [];
    if (typeof r.result === 'string') parts.push(r.result);
    if (Array.isArray(r.errors)) for (const e of r.errors) if (typeof e === 'string') parts.push(e);
    return {
        subtype: typeof r.subtype === 'string' ? r.subtype : null,
        isError: typeof r.is_error === 'boolean' ? r.is_error : null,
        text: parts.join('\n'),
    };
}

export function classifyClaudeSessionEnd(input: SessionEndInput): SessionEnd {
    if (input.signal) return { endReason: 'timeout' };
    if (input.failureKind && input.failureKind !== 'session-failed') {
        return { endReason: 'unknown' };
    }
    const { subtype, isError, text } = claudeResult(input.stdout);
    const all = `${text}\n${input.stderr}`;
    if (input.code === 0) {
        // `is_error: false` — CLI сам сказал «не ошибка», и `result` тогда проза модели. Кроме
        // обрыва, которым `result` является ЦЕЛИКОМ: прокси отдаёт свой отказ телом ответа, и
        // CLI кладёт его в `result` как текст модели — с нулём и `is_error: false`.
        if (isError === false) {
            return CLAUDE_INTERRUPTED_WHOLE_RE.test(text)
                ? { endReason: 'interrupted' }
                : { endReason: 'completed' };
        }
        return CLAUDE_INTERRUPTED_RE.test(all)
            ? { endReason: 'interrupted' }
            : { endReason: 'completed' };
    }
    if (subtype === 'error_max_turns') return { endReason: 'turn-limit' };
    if (CLAUDE_INTERRUPTED_RE.test(all)) return { endReason: 'interrupted' };
    if (CLAUDE_AUTH_RE.test(all)) return { endReason: 'auth' };
    if (CLAUDE_API_LIMIT_RE.test(all)) {
        const retryAfterMs = parseResetWaitMs(all);
        return retryAfterMs === undefined
            ? { endReason: 'api-limit' }
            : { endReason: 'api-limit', retryAfterMs };
    }
    if (CLAUDE_TURN_LIMIT_RE.test(all)) return { endReason: 'turn-limit' };
    return { endReason: 'unknown' };
}

// ── Codex CLI (`codex exec`, текстовый режим) ─────────────────────────────────────────
//
// Бюджета ходов у Codex нет (`maxTurns` — best-effort, `docs/harness-adapters.md`), поэтому
// `turn-limit` этот адаптер не выдаёт никогда — contract suite это сверяет явно, а не
// пропуском. Формулировки — из строк CLI 0.163.0: «exceeded retry limit, last status: …»,
// «stream disconnected before completion», отказ обновления токена входа.
//
// Читаются только строки stderr, начинающиеся с `ERROR:`, — итог CLI. В stdout у `codex
// exec` финальное сообщение модели, а прочие строки stderr — промежуточный ход: строка
// ретрая «Reconnecting...» печатается и у сессии, упавшей потом по другой причине, и
// читалась бы обрывом.

const CODEX_AUTH_RE =
    /(401 Unauthorized|access token could not be refreshed|refresh token was rejected|sign in again|Not logged in)/i;
const CODEX_API_LIMIT_RE = /(usage limit|429 Too Many Requests|rate limit)/i;
const CODEX_INTERRUPTED_RE =
    /(stream disconnected before completion|exceeded retry limit, last status: 5\d\d)/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// «try again at Oct 27th, 2026 3:05 PM» → мс до этого момента. Зону CLI не печатает и
// форматирует локальным временем своего процесса — а он идёт на том же хосте и с тем же
// окружением, что раннер, поэтому время берётся локальным. Прошедший момент — не «ждать
// ноль», а признак, что строка прочитана не так: undefined, и ядро возьмёт fallback.
export function parseCodexRetryAtMs(text: string, now: Date = new Date()): number | undefined {
    const m =
        /try again at ([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}):(\d{2})\s*(am|pm)/i.exec(
            text,
        );
    if (!m) return undefined;
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const day = parseInt(m[2], 10);
    let h = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    if (month < 0 || day < 1 || day > 31 || h < 1 || h > 12 || min > 59) return undefined;
    if (m[6].toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[6].toLowerCase() === 'am' && h === 12) h = 0;
    const target = new Date(parseInt(m[3], 10), month, day, h, min, 0, 0);
    if (target.getDate() !== day) return undefined;
    const ms = target.getTime() - now.getTime();
    return ms > 0 ? ms : undefined;
}

export function classifyCodexSessionEnd(input: SessionEndInput): SessionEnd {
    if (input.signal) return { endReason: 'timeout' };
    if (input.failureKind && input.failureKind !== 'session-failed') {
        return { endReason: 'unknown' };
    }
    if (input.code === 0) return { endReason: 'completed' };
    const errors = input.stderr
        .split('\n')
        .filter((l) => l.trimStart().startsWith('ERROR:'))
        .join('\n');
    if (CODEX_AUTH_RE.test(errors)) return { endReason: 'auth' };
    if (CODEX_API_LIMIT_RE.test(errors)) {
        const retryAfterMs = parseCodexRetryAtMs(errors);
        return retryAfterMs === undefined
            ? { endReason: 'api-limit' }
            : { endReason: 'api-limit', retryAfterMs };
    }
    if (CODEX_INTERRUPTED_RE.test(errors)) return { endReason: 'interrupted' };
    return { endReason: 'unknown' };
}

// Классификатор каждого зарегистрированного рантайма. Ключи — те же, что у реестра
// `coderRuntime` (`CODER_RUNTIME_PROVIDERS`), и contract suite сверяет совпадение: рантайм
// без классификатора не прошёл бы сьют, а не уехал бы с исходом «прочее» на всё.
export const SESSION_END_CLASSIFIERS: Record<string, SessionEndClassifier> = {
    claude: classifyClaudeSessionEnd,
    kimi: classifyClaudeSessionEnd,
    openai: classifyCodexSessionEnd,
};

export const SESSION_END_REASONS: readonly SessionEndReason[] = [
    'completed',
    'api-limit',
    'auth',
    'turn-limit',
    'interrupted',
    'timeout',
    'unknown',
];

// Contract suite исхода сессии (Фаза 16, #112): семь исходов `SessionEndReason` у каждого
// зарегистрированного рантайма. Фикстуры — обрезанный вывод CLI, у каждой названо, откуда
// она (`adapters/__fixtures__/README.md`).
//
// Сьют держит три свойства, и у каждого свой отказ:
//   - у каждого ключа реестра `coderRuntime` есть классификатор — новый рантайм без него
//     ушёл бы с исходом «прочее» на любой отказ, и лимит снова стал бы «упала»;
//   - каждый из семи исходов у адаптера либо подтверждён фикстурой, либо назван
//     неподдерживаемым с причиной — и тогда ни одна фикстура его не получает. Молча
//     пропущенный исход сьют не принимает;
//   - исход доезжает до ядра через БОЕВОЙ spawn-путь (`spawnClaude`/`spawnCodex` с
//     подменённым spawnFn), а не только через чистую функцию: классификатор, который
//     забыли позвать на границе, был бы зелёным в юните и мёртвым в бою.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionEndReason } from './adapters.ts';
import { CODER_RUNTIME_PROVIDERS } from './adapters-impl.ts';
import {
    SESSION_END_CLASSIFIERS,
    SESSION_END_REASONS,
    classifyClaudeSessionEnd,
    classifyCodexSessionEnd,
    parseCodexRetryAtMs,
    parseResetWaitMs,
    readClaudeResultEnvelope,
    type SessionEndClassifier,
} from './session-end.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов: боевые spawn-пути живут на его
// поверхности (тот же приём, что tests/adapters-contract.test.ts).
import ralph from '../ralph.js';

type TCase = {
    reason: SessionEndReason;
    code: number;
    signal?: string;
    stdout: string;
    stderr: string;
    source: string;
};
type TFixture = { cli: string; unsupported: Record<string, string>; cases: TCase[] };

function fixture(name: string): TFixture {
    return JSON.parse(
        fs.readFileSync(
            path.join(import.meta.dirname, '__fixtures__', `session-end-${name}.json`),
            'utf8',
        ),
    ) as TFixture;
}

// Набор фикстур по ключу реестра. Kimi — тот же бинарь `claude` с endpoint Moonshot, и
// вывод у него тот же: отдельный набор был бы копией, расходящейся молча.
const FIXTURE_OF: Record<string, string> = { claude: 'claude', kimi: 'claude', openai: 'codex' };

const SPAWN_OF: Record<string, (stdout: string, stderr: string, c: TCase) => unknown> = {
    claude: (stdout, stderr, c) =>
        ralph.spawnClaude(['-p'], 'промпт', 1000, spawnFake(c, stdout, stderr)),
    kimi: (stdout, stderr, c) =>
        ralph.spawnClaude(['-p'], 'промпт', 1000, spawnFake(c, stdout, stderr), {}, 'kimi'),
    openai: (stdout, stderr, c) =>
        ralph.spawnCodex(['exec'], 'промпт', 1000, spawnFake(c, stdout, stderr)),
};

function spawnFake(c: TCase, stdout: string, stderr: string): never {
    return (() =>
        c.signal
            ? {
                  status: null,
                  signal: c.signal,
                  stdout,
                  stderr,
                  error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
              }
            : { status: c.code, signal: null, stdout, stderr }) as never;
}

describe('реестр классификаторов совпадает с реестром рантаймов', () => {
    it('у каждого рантайма coderRuntime есть классификатор и набор фикстур', () => {
        for (const provider of CODER_RUNTIME_PROVIDERS) {
            expect(SESSION_END_CLASSIFIERS[provider], provider).toBeTypeOf('function');
            expect(FIXTURE_OF[provider], provider).toBeTypeOf('string');
            expect(SPAWN_OF[provider], provider).toBeTypeOf('function');
        }
        expect(Object.keys(SESSION_END_CLASSIFIERS).sort()).toEqual(
            [...CODER_RUNTIME_PROVIDERS].sort(),
        );
    });

    it('исходов ровно семь', () => {
        expect(new Set(SESSION_END_REASONS).size).toBe(7);
    });
});

describe.each([...CODER_RUNTIME_PROVIDERS])('contract suite исхода: рантайм %s', (provider) => {
    const fx = fixture(FIXTURE_OF[provider]);
    const classify: SessionEndClassifier = SESSION_END_CLASSIFIERS[provider];

    it.each([...SESSION_END_REASONS])(
        'исход %s подтверждён фикстурой или назван неподдерживаемым',
        (reason) => {
            const covered = fx.cases.some((c) => c.reason === reason);
            const why = fx.unsupported[reason];
            // Ровно одно из двух: и фикстура, и «не поддерживается» — противоречие.
            expect(covered !== (typeof why === 'string' && why.length > 0), reason).toBe(true);
        },
    );

    it.each(fx.cases.map((c) => [`${c.reason} ← ${c.source}`, c] as const))(
        'классификатор: %s',
        (_name, c) => {
            const end = classify({
                code: c.code,
                stdout: c.stdout,
                stderr: c.stderr,
                signal: c.signal ?? null,
                ...(c.signal ? { failureKind: 'session-failed' as const } : {}),
            });
            expect(end.endReason).toBe(c.reason);
            expect(Object.keys(fx.unsupported)).not.toContain(end.endReason);
        },
    );

    it.each(fx.cases.map((c) => [`${c.reason} ← ${c.source}`, c] as const))(
        'боевой spawn-путь отдаёт исход ядру: %s',
        (_name, c) => {
            const res = SPAWN_OF[provider](c.stdout, c.stderr, c) as { endReason?: string };
            expect(res.endReason).toBe(c.reason);
        },
    );
});

describe('порядок признаков — часть контракта', () => {
    it('код 0 — completed, даже если в выводе цитата лимита или бюджета ходов', () => {
        for (const text of [
            "You've hit your session limit · resets 1:20pm",
            'Error: Reached max turns (200)',
            'Not logged in · Please run /login',
        ]) {
            expect(classifyClaudeSessionEnd({ code: 0, stdout: text, stderr: '' }).endReason).toBe(
                'completed',
            );
        }
        expect(
            classifyCodexSessionEnd({ code: 0, stdout: "You've hit your usage limit", stderr: '' })
                .endReason,
        ).toBe('completed');
    });

    it('сигнал раньше текста: убитая по сроку сессия — timeout, что бы ни напечатала', () => {
        expect(
            classifyClaudeSessionEnd({
                code: 1,
                stdout: "You've hit your session limit",
                stderr: '',
                signal: 'SIGTERM',
            }).endReason,
        ).toBe('timeout');
    });

    it('отказ запуска — не исход сессии: unknown, класс несёт failureKind', () => {
        for (const failureKind of [
            'runtime-unavailable',
            'arg-too-long',
            'spawn-failed',
        ] as const) {
            expect(
                classifyClaudeSessionEnd({
                    code: 1,
                    stdout: '',
                    stderr: 'usage limit',
                    failureKind,
                }).endReason,
            ).toBe('unknown');
            expect(
                classifyCodexSessionEnd({ code: 1, stdout: '', stderr: '', failureKind }).endReason,
            ).toBe('unknown');
        }
    });

    it('subtype JSON-результата сильнее текста: error_max_turns — turn-limit', () => {
        const stdout = JSON.stringify({
            type: 'result',
            subtype: 'error_max_turns',
            is_error: true,
            result: 'упомянут rate limit',
        });
        expect(classifyClaudeSessionEnd({ code: 1, stdout, stderr: '' }).endReason).toBe(
            'turn-limit',
        );
    });

    it('«overloaded» в прозе — не обрыв: только форма ошибки API', () => {
        expect(
            classifyClaudeSessionEnd({
                code: 0,
                stdout: 'функция overloaded для двух сигнатур TS',
                stderr: '',
            }).endReason,
        ).toBe('completed');
        expect(
            classifyClaudeSessionEnd({
                code: 1,
                stdout: 'API Error: 529 {"type":"overloaded_error"}',
                stderr: '',
            }).endReason,
        ).toBe('interrupted');
    });

    it('код 0 и is_error: false — цитата обрыва посреди прозы ревью не обрыв', () => {
        const stdout = JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Ревью: узнаёт No upstream account is currently available и API Error: 503',
        });
        expect(classifyClaudeSessionEnd({ code: 0, stdout, stderr: '' }).endReason).toBe(
            'completed',
        );
        // От противного: без структурного признака текст по-прежнему читается.
        const noFlag = JSON.stringify({ type: 'result', result: 'API Error: 503' });
        expect(classifyClaudeSessionEnd({ code: 0, stdout: noFlag, stderr: '' }).endReason).toBe(
            'interrupted',
        );
    });

    it('JSON-конверт, код 0, is_error: false и result целиком — отказ прокси: interrupted', () => {
        // Инцидент 16.10 на боевом пути: spawn всегда JSON, CLI выходит нулём, а ответ прокси
        // лежит в `result` как текст модели без признака ошибки.
        for (const result of [
            'No upstream account is currently available',
            'No upstream account is currently available.\n',
            'API Error: 503 {"error":"upstream unavailable"}',
            'API Error: 524',
        ]) {
            const stdout = JSON.stringify({
                type: 'result',
                subtype: 'success',
                is_error: false,
                result,
            });
            expect(classifyClaudeSessionEnd({ code: 0, stdout, stderr: '' }).endReason).toBe(
                'interrupted',
            );
        }
        // От противного: та же фраза с хвостом прозы — уже текст модели.
        const prose = JSON.stringify({
            type: 'result',
            is_error: false,
            result: 'No upstream account is currently available — так отвечал прокси 16.10.',
        });
        expect(classifyClaudeSessionEnd({ code: 0, stdout: prose, stderr: '' }).endReason).toBe(
            'completed',
        );
    });

    it('Codex читает только строки ERROR: в stderr — проза stdout не исход', () => {
        for (const stdout of [
            '401 Unauthorized, sign in again',
            'usage limit',
            'Reconnecting...',
        ]) {
            expect(
                classifyCodexSessionEnd({ code: 1, stdout, stderr: 'ERROR: sandbox error: x\n' })
                    .endReason,
            ).toBe('unknown');
        }
        expect(
            classifyCodexSessionEnd({
                code: 1,
                stdout: '',
                stderr: 'note: 401 Unauthorized в логе ретрая\nERROR: sandbox error: x\n',
            }).endReason,
        ).toBe('unknown');
        expect(
            classifyCodexSessionEnd({
                code: 1,
                stdout: '',
                stderr: '  ERROR: unexpected status 401 Unauthorized\n',
            }).endReason,
        ).toBe('auth');
    });

    it('лимит Kimi узнаётся по коду 429, а не по словам тела Moonshot', () => {
        expect(
            classifyClaudeSessionEnd({
                code: 1,
                stdout: 'API Error: 429 {"error":{"type":"exceeded_current_quota_error"}}',
                stderr: '',
            }).endReason,
        ).toBe('api-limit');
    });

    it('конверт JSON-результата: только объект type=result', () => {
        expect(readClaudeResultEnvelope('{"type":"result","result":"да"}')).toEqual({
            type: 'result',
            result: 'да',
        });
        for (const s of ['текст', '[1]', 'null', '{"type":"assistant"}']) {
            expect(readClaudeResultEnvelope(s), s).toBeNull();
        }
    });

    it('«turns» в живой речи модели — не бюджет ходов', () => {
        expect(
            classifyClaudeSessionEnd({
                code: 1,
                stdout: 'turns out the fix was simple',
                stderr: '',
            }).endReason,
        ).toBe('unknown');
    });
});

describe('время сброса окна лимита — retryAfterMs от адаптера', () => {
    // «Сейчас» = локальное 2026-01-15 10:00:00; разница двух локальных Date от TZ не зависит.
    const H = 3600_000;
    const NOW = new Date(2026, 0, 15, 10, 0, 0, 0);
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        ['you can retry — resets 11am', 1 * H],
        ['limit will reset at 7:30pm', 9.5 * H],
        ['resets 3am', 17 * H],
        ['resets 12am', 14 * H],
        ['resets 12pm', 2 * H],
    ])('«%s» → %i мс', (text, ms) => {
        expect(parseResetWaitMs(text, NOW)).toBe(ms);
    });

    it.each(['resets 27', 'just a normal claude output, all good'])(
        '«%s» → undefined: ядро возьмёт fallback',
        (text) => {
            expect(parseResetWaitMs(text, NOW)).toBeUndefined();
        },
    );

    it('лимит Claude несёт retryAfterMs, если CLI назвал время сброса', () => {
        const end = classifyClaudeSessionEnd({
            code: 1,
            stdout: "You've hit your session limit · resets 11am",
            stderr: '',
        });
        expect(end).toEqual({ endReason: 'api-limit', retryAfterMs: 1 * H });
    });

    it('лимит без времени — api-limit без retryAfterMs', () => {
        expect(
            classifyClaudeSessionEnd({ code: 1, stdout: 'usage limit reached', stderr: '' }),
        ).toEqual({ endReason: 'api-limit' });
        expect(
            classifyCodexSessionEnd({ code: 1, stdout: '', stderr: 'ERROR: usage limit\n' }),
        ).toEqual({ endReason: 'api-limit' });
    });

    it('лимит Codex несёт retryAfterMs из «try again at …» — локальное время хоста', () => {
        const end = classifyCodexSessionEnd({
            code: 1,
            stdout: '',
            stderr: 'ERROR: You’ve hit your usage limit. Or try again at Jan 15th, 2026 3:05 PM.\n',
        });
        expect(end).toEqual({ endReason: 'api-limit', retryAfterMs: 5 * H + 5 * 60_000 });
    });

    it.each([
        ['try again at Jan 16th, 2026 12:00 AM', 14 * H],
        ['try again at January 15, 2026 12:30 PM', 2.5 * H],
        ['try again at Jan 15th, 2026 9:00 AM', undefined],
        ['try again at Feb 30th, 2026 1:00 PM', undefined],
        ['try again at Foo 15th, 2026 1:00 PM', undefined],
        ['try again at Jan 15th, 2026 13:00 PM', undefined],
        ['try again later', undefined],
    ])('Codex «%s» → %s', (text, ms) => {
        expect(parseCodexRetryAtMs(text, NOW)).toBe(ms);
    });
});

describe('зона в суффиксе времени сброса — от часового пояса хоста не зависит', () => {
    // Мгновение задано в UTC: 2026-01-15 10:00:00Z. Ожидаемые числа верны на любом хосте.
    const H = 3600_000;
    const NOW_UTC = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it.each(['UTC', 'America/New_York', 'Asia/Kolkata'])('хост в зоне %s', (tz) => {
        vi.stubEnv('TZ', tz);
        expect(parseResetWaitMs('resets 8:20pm (UTC)', NOW_UTC)).toBe(10 * H + 20 * 60_000);
        // Москва UTC+3: сейчас 13:00 MSK, ближайшие 3am MSK — через 14 ч.
        expect(parseResetWaitMs('resets 3am (Europe/Moscow)', NOW_UTC)).toBe(14 * H);
        // Нью-Йорк UTC-5: сейчас 05:00 EST, 7am — через 2 ч.
        expect(parseResetWaitMs('resets 7am (America/New_York)', NOW_UTC)).toBe(2 * H);
    });

    it('без суффикса время локальное: на хосте не в UTC ответ другой', () => {
        vi.stubEnv('TZ', 'America/New_York');
        expect(parseResetWaitMs('resets 8:20pm', NOW_UTC)).toBe(15 * H + 20 * 60_000);
    });

    it('перевод часов между «сейчас» и сбросом учтён смещением в момент сброса', () => {
        // 2026-03-08 06:00Z = 01:00 EST; в 02:00 того же дня Нью-Йорк уходит на EDT (UTC-4).
        const before = new Date(Date.UTC(2026, 2, 8, 6, 0, 0));
        expect(parseResetWaitMs('resets 5am (America/New_York)', before)).toBe(3 * H);
    });

    it('незнакомая зона — undefined: ядро возьмёт fallback', () => {
        expect(parseResetWaitMs('resets 3am (Mars/Olympus)', NOW_UTC)).toBeUndefined();
    });
});

// Токены и стоимость попытки (задача 95), критерий «у каждой попытки в журнале есть
// токены и стоимость по тарифу момента вызова». Фикстуры — урезанные ответы живого
// `claude -p --output-format json` (CLI 2.1.311): успех и исчерпание ходов.
import { describe, it, expect, vi } from 'vitest';
import {
    attemptLogLine,
    attemptRecord,
    parseClaudeJsonResult,
    priceModel,
} from './attempt-cost.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов.
import ralph from '../ralph.js';

// #113: у каждой записи — профиль, версия CLI и исход; здесь они фон, проверяются ниже.
const SESSION = {
    profile: { harness: 'claude-code', provider: 'anthropic', model: 'model-a' },
    cliVersion: { version: '2.1.311' },
    endReason: 'completed' as const,
};

const SUCCESS = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1571,
    num_turns: 1,
    result: 'да',
    total_cost_usd: 0.179332,
    usage: {
        input_tokens: 2,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 22408,
    },
    modelUsage: {
        'model-a': {
            inputTokens: 2,
            outputTokens: 3,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 22408,
            costUSD: 0.179332,
        },
    },
});

const MAX_TURNS = JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    num_turns: 2,
    result: null,
    errors: ['Reached maximum number of turns (1)'],
    modelUsage: {
        'model-a': {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
        },
    },
});

const TARIFF = {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
};

describe('parseClaudeJsonResult — JSON-результат обратно в текст текстового режима', () => {
    it('успех: текст — ответ, токены по моделям', () => {
        const r = parseClaudeJsonResult(SUCCESS);
        expect(r?.text).toBe('да');
        expect(r?.durationMs).toBe(1571);
        expect(r?.models).toEqual([
            {
                model: 'model-a',
                input: 2,
                output: 3,
                cacheRead: 0,
                cacheWrite: 22408,
                reportedCostUsd: 0.179332,
            },
        ]);
    });

    it('исчерпание ходов: текст несёт формулировку CLI и сырой JSON, маркер не синтезируется', () => {
        // Исход `turn-limit` называет адаптер по `subtype` сырого JSON (Фаза 16,
        // adapters/session-end.test.ts); перевод в текст — для лога и разбора падения.
        const r = parseClaudeJsonResult(MAX_TURNS);
        expect(r?.text).toContain('Error: Reached maximum number of turns (1)');
        expect(r?.text).not.toContain('Reached max turns (');
        // Ошибочный результат несёт и сырой JSON — на случай форм ошибки, не виденных живьём.
        expect(r?.text).toContain(MAX_TURNS);
    });

    it('успешный результат сырого JSON в тексте не несёт', () => {
        expect(parseClaudeJsonResult(SUCCESS)?.text).not.toContain('modelUsage');
    });

    it('не JSON и не результат — null: вывод пойдёт читателям как есть', () => {
        expect(parseClaudeJsonResult('просто текст')).toBeNull();
        expect(parseClaudeJsonResult('{"type":"assistant"}')).toBeNull();
        expect(parseClaudeJsonResult('')).toBeNull();
    });

    it('старый формат без modelUsage — модель unknown, токены из usage', () => {
        const r = parseClaudeJsonResult(
            JSON.stringify({
                type: 'result',
                result: 'x',
                usage: { input_tokens: 7, output_tokens: 1 },
                total_cost_usd: 0.5,
            }),
        );
        expect(r?.models).toEqual([
            {
                model: 'unknown',
                input: 7,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                reportedCostUsd: 0.5,
            },
        ]);
    });
});

describe('priceModel / attemptRecord — стоимость по тарифу момента вызова', () => {
    const usage = parseClaudeJsonResult(SUCCESS)!.models[0];

    it('тариф из конфига: стоимость по нему и снимок тарифа в записи', () => {
        const p = priceModel(usage, { 'model-a': TARIFF });
        // 2×5 + 3×25 + 0×0.5 + 22408×6.25 = 140135 → /1e6
        expect(p.costUsd).toBeCloseTo(0.140135, 9);
        expect(p.costBasis).toBe('config-tariff');
        expect(p.tariff).toEqual(TARIFF);
    });

    it('снимок — копия: правка тарифа после вызова прошлую запись не меняет', () => {
        const pricing = { 'model-a': { ...TARIFF } };
        const rec = attemptRecord({
            runtime: 'claude',
            code: 0,
            parsed: parseClaudeJsonResult(SUCCESS),
            pricing,
            session: SESSION,
        });
        pricing['model-a'].outputPerMTok = 1000;
        expect(rec.models[0].tariff?.outputPerMTok).toBe(25);
        expect(rec.costUsd).toBeCloseTo(0.140135, 9);
    });

    it('тарифа модели в конфиге нет — стоимость рантайма с пометкой источника', () => {
        const p = priceModel(usage, { other: TARIFF });
        expect(p).toMatchObject({ costUsd: 0.179332, costBasis: 'runtime-reported', tariff: null });
    });

    it('ни тарифа, ни стоимости рантайма — стоимость неизвестна, и итог тоже', () => {
        const rec = attemptRecord({
            runtime: 'claude',
            code: 0,
            parsed: {
                text: '',
                durationMs: null,
                models: [{ ...usage, reportedCostUsd: null }, usage],
            },
            pricing: null,
            session: SESSION,
        });
        expect(rec.models[0].costBasis).toBe('unknown');
        // Частичная сумма выглядела бы полной.
        expect(rec.costUsd).toBeNull();
        expect(rec.tokens).toEqual({ input: 4, output: 6, cacheRead: 0, cacheWrite: 44816 });
    });

    it('вывод не разобрался — запись есть, токены неизвестны, причина названа', () => {
        const rec = attemptRecord({
            runtime: 'claude',
            code: 1,
            parsed: null,
            pricing: null,
            session: SESSION,
        });
        expect(rec).toMatchObject({ tokens: null, costUsd: null });
        expect(rec.usageUnknown).toMatch(/не разобрался/);
        expect(attemptLogLine(rec)).toMatch(/💰 Попытка \(claude\): расход неизвестен/);
    });

    it('строка лога: токены, стоимость и источник тарифа', () => {
        const rec = attemptRecord({
            runtime: 'claude',
            code: 0,
            parsed: parseClaudeJsonResult(SUCCESS),
            pricing: { 'model-a': TARIFF },
            session: SESSION,
        });
        expect(attemptLogLine(rec)).toBe(
            '💰 Попытка (claude): 22413 токенов (из них кеш 22408), $0.1401 (тариф: config-tariff).' +
                ' Профиль claude-code/anthropic/model-a, CLI 2.1.311, исход completed.',
        );
    });
});

describe('attemptRecord — версия CLI, профиль и исход у каждой записи (#113)', () => {
    it('известная версия: поля версии, профиля и исхода, причины нет', () => {
        const rec = attemptRecord({
            runtime: 'claude',
            code: 0,
            parsed: parseClaudeJsonResult(SUCCESS),
            pricing: null,
            session: SESSION,
        });
        expect(rec).toMatchObject({
            profile: SESSION.profile,
            cliVersion: '2.1.311',
            endReason: 'completed',
        });
        expect('cliVersionUnknown' in rec).toBe(false);
    });

    it('нечитаемая версия — unknown с причиной, и у записи без токенов тоже', () => {
        const rec = attemptRecord({
            runtime: 'codex',
            code: 1,
            parsed: null,
            pricing: null,
            session: {
                ...SESSION,
                cliVersion: { version: 'unknown', unknownReason: '`codex --version` вернул код 2' },
                endReason: 'unknown',
            },
        });
        expect(rec).toMatchObject({
            cliVersion: 'unknown',
            cliVersionUnknown: '`codex --version` вернул код 2',
            endReason: 'unknown',
            tokens: null,
        });
        expect(attemptLogLine(rec)).toMatch(/CLI unknown, исход unknown\.$/);
    });
});

describe('проводка в раннере: spawnClaude и recordAttempt', () => {
    const spawnWith = (stdout: string, status = 0) =>
        (() => ({ status, signal: null, stdout, stderr: '', pid: 1, output: [] })) as never;

    it('spawnClaude отдаёт читателям текст результата, а не сырой JSON', () => {
        const res = ralph.spawnClaude(['-p'], 'промпт', 1000, spawnWith(SUCCESS));
        expect(res.code).toBe(0);
        expect(res.output.trim()).toBe('да');
    });

    it('spawnClaude на исчерпании ходов: исход turn-limit называет адаптер по сырому JSON', () => {
        const res = ralph.spawnClaude(['-p'], 'промпт', 1000, spawnWith(MAX_TURNS, 1));
        expect(res.endReason).toBe('turn-limit');
    });

    it('spawnClaude на успехе: исход completed', () => {
        expect(ralph.spawnClaude(['-p'], 'промпт', 1000, spawnWith(SUCCESS)).endReason).toBe(
            'completed',
        );
    });

    it('recordAttempt кладёт в журнал токены, тариф снимком и стоимость, в лог — строку 💰', () => {
        const emitFn = vi.fn();
        const logs: string[] = [];
        const rec = ralph.recordAttempt(
            {
                runtime: 'claude',
                code: 0,
                parsed: parseClaudeJsonResult(SUCCESS),
                session: SESSION,
            },
            {
                emitFn,
                logFn: (m: string) => logs.push(m),
                cfg: { observability: { pricing: { 'model-a': TARIFF } } },
            },
        );
        expect(emitFn).toHaveBeenCalledWith('attempt', rec);
        const [, payload] = emitFn.mock.calls[0];
        expect(payload.tokens).toEqual({ input: 2, output: 3, cacheRead: 0, cacheWrite: 22408 });
        expect(payload.models[0].tariff).toEqual(TARIFF);
        expect(payload.costUsd).toBeCloseTo(0.140135, 9);
        expect(logs).toEqual([attemptLogLine(rec)]);
    });

    it('recordAttempt у рантайма без токенов — запись с причиной, а не пропуск', () => {
        const emitFn = vi.fn();
        ralph.recordAttempt(
            {
                runtime: 'codex',
                code: 0,
                parsed: null,
                unknownReason: 'рантайм codex расход токенов в выводе не отдаёт',
                session: SESSION,
            },
            { emitFn, logFn: () => {}, cfg: {} },
        );
        expect(emitFn.mock.calls[0][1]).toMatchObject({
            runtime: 'codex',
            tokens: null,
            usageUnknown: 'рантайм codex расход токенов в выводе не отдаёт',
        });
    });
});

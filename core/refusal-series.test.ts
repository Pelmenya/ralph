import { describe, expect, it } from 'vitest';
import { parseSessionRequests, UnknownLiveProbeError } from './session-requests.ts';
import { blocksProblem } from './new-issue-policy.ts';
import {
    parseRefusalSeries,
    recordRefusal,
    refusalIdentity,
    refusalOfParseError,
    refusalStopText,
    shouldStopOnSeries,
} from './refusal-series.ts';

const AT = {
    milestone: 'Ralph · Ф18',
    issue: 238,
    sha: 'sha-1',
    evidence: 'quarantine/first.jsonl',
};
const REFUSAL = {
    code: 'intent-rejected' as const,
    params: { what: 'issue-number' },
    reason: 'первый отказ',
};

describe('refusalOfParseError', () => {
    it('незнакомая живая проба — live-probe-unavailable с её парой', () => {
        const error = new UnknownLiveProbeError(
            'Запрос сессии, строка 2: case пробы "нет-такого" не из каталога claude',
            'claude',
            'нет-такого',
        );

        expect(refusalOfParseError(error)).toEqual({
            code: 'live-probe-unavailable',
            params: { cli: 'claude', case: 'нет-такого' },
            reason: error.message,
        });
    });

    it('номер строки не входит в идентичность обычной ошибки разбора', () => {
        const third = refusalOfParseError(new Error('Запрос сессии, строка 3: issue — не число'));
        const seventh = refusalOfParseError(new Error('Запрос сессии, строка 7: issue — не число'));

        expect(third.code).toBe('intent-rejected');
        expect(third.params.what).toBe('issue — не число');
        expect(seventh.params.what).toBe(third.params.what);
    });

    it('PID, время и числа из запроса не входят в запасную нормализацию identity', () => {
        const first = refusalOfParseError(
            new Error('Запрос сессии, строка 3: отказ в 12:40, pid 101, значение "abc"'),
        );
        const second = refusalOfParseError(
            new Error('Запрос сессии, строка 9: отказ в 13:55, pid 202, значение "def"'),
        );

        expect(second.params).toEqual(first.params);
        expect(second.reason).not.toBe(first.reason);
    });

    it('сквозной путь blocksProblem → identity → record не зависит от заголовка', () => {
        const refusalOf = (title: string) => {
            const problem = blocksProblem(
                [{ kind: 'new-issue', title, blocks: 7 }],
                [8],
                AT.milestone,
            );
            expect(problem).not.toBeNull();
            return refusalOfParseError(new Error(`Запрос сессии: ${problem}`));
        };
        const first = refusalOf('первый заголовок');
        const second = refusalOf('второй заголовок');

        expect(first.params).toEqual({
            what: 'new-issue «…»: blocks #<n> — не открытая карточка вехи текущей фазы "…"',
        });
        expect(second.params).toEqual(first.params);
        expect(recordRefusal(recordRefusal(null, AT, first), AT, second).count).toBe(2);

        const quotedFirst = refusalOf('одинаковый»первый');
        const quotedSecond = refusalOf('одинаковый»второй');

        expect(quotedFirst.params).toEqual(first.params);
        expect(quotedSecond.params).toEqual(quotedFirst.params);
        expect(recordRefusal(recordRefusal(null, AT, quotedFirst), AT, quotedSecond).count).toBe(2);

        const multilineFirst = refusalOf('одинаковый\nпервый');
        const multilineSecond = refusalOf('одинаковый\nвторой');

        expect(multilineFirst.params).toEqual(first.params);
        expect(multilineSecond.params).toEqual(multilineFirst.params);
        expect(
            recordRefusal(recordRefusal(null, AT, multilineFirst), AT, multilineSecond).count,
        ).toBe(2);
    });

    it('секрет редактируется и в причине, и в identity, длинный диагноз обрезается', () => {
        const secret = ['fixture', 'secret', '0123456789abcdef'].join('-');
        const refusal = refusalOfParseError(
            new Error(
                `Запрос сессии, строка 2: значение ${JSON.stringify(secret)} ${'x'.repeat(700)}`,
            ),
            [secret],
        );

        expect(JSON.stringify(refusal)).not.toContain(secret);
        expect(refusal.reason).toContain('***');
        expect(refusal.reason.length).toBeLessThanOrEqual(500);
        expect(refusal.params.what.length).toBeLessThanOrEqual(200);
    });

    it('секрет с числовым суффиксом вне JSON-кавычек не остаётся в identity частично', () => {
        const secret = ['fixture', 'secret', '123'].join('-');
        const refusal = refusalOfParseError(
            new Error(`Запрос сессии: new-issue «${secret}»: blocks #7`),
            [secret],
        );

        expect(refusal.reason).toContain('***');
        expect(refusal.params).toEqual({ what: 'new-issue «…»: blocks #<n>' });
        expect(JSON.stringify(refusal)).not.toContain(secret);
        expect(JSON.stringify(refusal)).not.toContain(['fixture', 'secret'].join('-'));
    });

    it('не-Error — intent-rejected со строковым представлением', () => {
        expect(refusalOfParseError('битый батч')).toEqual({
            code: 'intent-rejected',
            params: { what: 'битый батч' },
            reason: 'битый батч',
        });
    });

    it('сквозной путь parse → identity → record продолжает серию при других строке и значении', () => {
        const refusalOf = (raw: string) => {
            try {
                parseSessionRequests(raw, { labelAllowlist: [] });
                throw new Error('ожидался отказ разбора');
            } catch (e) {
                return refusalOfParseError(e);
            }
        };
        const first = refusalOf(
            '{"kind":"comment","issue":7,"comment":"ok"}\n{"kind":"close","issue":"7","comment":"x"}',
        );
        const second = refusalOf('{"kind":"close","issue":"9","comment":"x"}');

        expect(first.params).toEqual({ what: 'issue-number' });
        expect(second.params).toEqual(first.params);
        expect(second.reason).not.toBe(first.reason);
        expect(recordRefusal(recordRefusal(null, AT, first), AT, second).count).toBe(2);
    });
});

describe('refusalIdentity', () => {
    it('не зависит от порядка ключей params', () => {
        const first = refusalIdentity({
            milestone: 'Ralph · Ф18',
            issue: 238,
            stage: 'coder',
            code: 'intent-rejected',
            params: { case: 'unknown-field', cli: 'claude' },
        });
        const second = refusalIdentity({
            milestone: 'Ralph · Ф18',
            issue: 238,
            stage: 'coder',
            code: 'intent-rejected',
            params: { cli: 'claude', case: 'unknown-field' },
        });

        expect(first).toBe(second);
    });

    it('различает разные params.case', () => {
        const base = {
            milestone: 'Ralph · Ф18',
            issue: 238,
            stage: 'coder' as const,
            code: 'intent-rejected' as const,
        };

        expect(refusalIdentity({ ...base, params: { case: 'first' } })).not.toBe(
            refusalIdentity({ ...base, params: { case: 'second' } }),
        );
    });
});

describe('recordRefusal', () => {
    it('начинает новую серию с count 1', () => {
        expect(recordRefusal(null, AT, REFUSAL)).toEqual({
            milestone: AT.milestone,
            issue: AT.issue,
            stage: 'coder',
            code: REFUSAL.code,
            params: REFUSAL.params,
            count: 1,
            reason: REFUSAL.reason,
            evidence: AT.evidence,
            attemptShas: [AT.sha],
        });
    });

    it('продолжает ту же серию, обновляет последний отказ и добавляет новый sha', () => {
        const first = recordRefusal(null, AT, REFUSAL);
        const second = recordRefusal(
            first,
            { ...AT, sha: 'sha-2', evidence: 'quarantine/second.jsonl' },
            { ...REFUSAL, reason: 'тот же отказ в другое время, pid 2' },
        );

        expect(second).toEqual({
            ...first,
            count: 2,
            reason: 'тот же отказ в другое время, pid 2',
            evidence: 'quarantine/second.jsonl',
            attemptShas: ['sha-1', 'sha-2'],
        });
    });

    it('не дублирует тот же sha', () => {
        const first = recordRefusal(null, AT, REFUSAL);

        expect(recordRefusal(first, AT, REFUSAL).attemptShas).toEqual(['sha-1']);
    });

    it('не записывает sha null', () => {
        expect(recordRefusal(null, { ...AT, sha: null }, REFUSAL).attemptShas).toEqual([]);
    });

    it('начинает новую серию при другом params.cli', () => {
        const first = recordRefusal(null, AT, REFUSAL);
        const second = recordRefusal(first, AT, {
            ...REFUSAL,
            params: { ...REFUSAL.params, cli: 'kimi' },
        });

        expect(second.count).toBe(1);
        expect(second.attemptShas).toEqual(['sha-1']);
    });

    it('начинает новую серию для другой карточки', () => {
        const first = recordRefusal(null, AT, REFUSAL);
        const second = recordRefusal(first, { ...AT, issue: 239 }, REFUSAL);

        expect(second.count).toBe(1);
        expect(second.issue).toBe(239);
    });

    it('не мутирует замороженный prev', () => {
        const first = Object.freeze(recordRefusal(null, AT, REFUSAL));

        expect(() => recordRefusal(first, { ...AT, sha: 'sha-2' }, REFUSAL)).not.toThrow();
        expect(first.count).toBe(1);
        expect(first.attemptShas).toEqual(['sha-1']);
    });
});

describe('shouldStopOnSeries', () => {
    const next = { milestone: AT.milestone, issue: AT.issue };
    const first = recordRefusal(null, AT, REFUSAL);

    it('не останавливается без серии', () => {
        expect(shouldStopOnSeries(null, next, 2)).toBe(false);
    });

    it('не останавливается на серии другой карточки', () => {
        expect(shouldStopOnSeries(first, { ...next, issue: 239 }, 1)).toBe(false);
    });

    it('не останавливается на серии другой вехи', () => {
        expect(shouldStopOnSeries(first, { ...next, milestone: 'Ralph · Ф19' }, 1)).toBe(false);
    });

    it('не останавливает intent-rejected ниже порога', () => {
        expect(shouldStopOnSeries(first, next, 2)).toBe(false);
    });

    it('останавливает intent-rejected на пороге', () => {
        expect(shouldStopOnSeries({ ...first, count: 2 }, next, 2)).toBe(true);
    });

    it('останавливает live-probe-unavailable с первого отказа', () => {
        const probe = recordRefusal(null, AT, {
            ...REFUSAL,
            code: 'live-probe-unavailable',
            params: { cli: 'claude', case: 'нет-такого' },
        });

        expect(shouldStopOnSeries(probe, next, 2)).toBe(true);
    });
});

describe('refusalStopText', () => {
    const series = {
        milestone: AT.milestone,
        issue: 7,
        stage: 'coder' as const,
        code: 'intent-rejected' as const,
        params: { what: 'issue — не число' },
        count: 2,
        reason: 'Запрос сессии, строка 2: issue — не число',
        evidence: 'quarantine/rejected-2.jsonl',
        attemptShas: ['sha-1', 'sha-2'],
    };

    it('называет счёт, код, порог и путь батча обычного отказа', () => {
        expect(refusalStopText(series, 2)).toEqual({
            reason: 'intent-rejected',
            diagnosis:
                'Issue #7: число одинаковых отказов подряд: 2 (intent-rejected, порог maxSameRefusal = 2): ' +
                'Запрос сессии, строка 2: issue — не число. Батч — quarantine/rejected-2.jsonl.',
            question:
                'разбери причину по батчу в карантине, поправь карточку или правило и перезапусти loop',
        });
    });

    it.each([1, 5])('форма счёта нейтральна и при %s', (count) => {
        expect(refusalStopText({ ...series, count }, count).diagnosis).toContain(
            `число одинаковых отказов подряд: ${String(count)}`,
        );
    });

    it('называет фактический код и ревизию установки недоступной пробы', () => {
        expect(
            refusalStopText(
                {
                    ...series,
                    code: 'live-probe-unavailable',
                    params: { cli: 'claude', case: 'нет-такого' },
                    count: 1,
                    evidence: 'quarantine/probe.jsonl',
                },
                2,
                'core-revision-1',
            ),
        ).toEqual({
            reason: 'intent-rejected',
            diagnosis:
                'Issue #7: отказ live-probe-unavailable — пары живой пробы claude/нет-такого ' +
                'нет в каталоге установленного раннера. Ревизия установки: core-revision-1. ' +
                'Сессия её не добавит: каталог проб принадлежит установке, ветка его не меняет. ' +
                'Батч — quarantine/probe.jsonl.',
            question:
                'установи ревизию ядра с этой пробой и перезапусти loop или перережь карточку без неё',
        });
    });

    it('называет несохранённый батч', () => {
        expect(refusalStopText({ ...series, evidence: null }, 2).diagnosis).toContain(
            'Батч — не сохранён.',
        );
    });
});

describe('parseRefusalSeries', () => {
    const valid = recordRefusal(null, AT, REFUSAL);

    it.each([undefined, null])('возвращает null для %s', (raw) => {
        expect(parseRefusalSeries(raw)).toBeNull();
    });

    it.each([
        recordRefusal(null, AT, REFUSAL),
        recordRefusal(null, AT, {
            ...REFUSAL,
            code: 'live-probe-unavailable',
            params: { cli: 'claude', case: 'нет-такого' },
        }),
    ])('возвращает серию $code из recordRefusal без изменений', (series) => {
        expect(parseRefusalSeries(series)).toEqual(series);
    });

    it('принимает evidence null и пустой attemptShas', () => {
        const nullable = { ...valid, evidence: null, attemptShas: [] };

        expect(parseRefusalSeries(nullable)).toEqual(nullable);
    });

    it.each([
        { field: 'count', value: 0 },
        { field: 'count', value: 1.5 },
        { field: 'code', value: 'other' },
        { field: 'issue', value: '7' },
        { field: 'issue', value: 1.5 },
        { field: 'issue', value: 0 },
        { field: 'milestone', value: 7 },
        { field: 'stage', value: 'review' },
        { field: 'params', value: { cli: 7 } },
        { field: 'params', value: null },
        { field: 'params', value: [] },
        { field: 'reason', value: null },
        { field: 'evidence', value: 7 },
        { field: 'attemptShas', value: [1] },
        { field: 'attemptShas', value: 'sha-1' },
    ])('отвергает битое поле $field', ({ field, value }) => {
        expect(() => parseRefusalSeries({ ...valid, [field]: value })).toThrow(
            `refusalSeries: ${field}`,
        );
    });

    it('отвергает лишнее поле и называет его', () => {
        expect(() => parseRefusalSeries({ ...valid, unexpected: true })).toThrow(
            /refusalSeries: .*unexpected/,
        );
    });

    it.each([
        { code: 'intent-rejected' as const, params: {} },
        { code: 'intent-rejected' as const, params: { what: 'x', cli: 'claude' } },
        { code: 'live-probe-unavailable' as const, params: {} },
        { code: 'live-probe-unavailable' as const, params: { cli: 'claude' } },
        { code: 'live-probe-unavailable' as const, params: { case: 'x' } },
        {
            code: 'live-probe-unavailable' as const,
            params: { cli: 'claude', case: 'x', what: 'y' },
        },
    ])('отвергает params не по схеме кода $code: $params', ({ code, params }) => {
        expect(() => parseRefusalSeries({ ...valid, code, params })).toThrow(
            /refusalSeries: params/,
        );
    });

    it.each([[], 'broken', 7])('отвергает значение вместо объекта: %s', (raw) => {
        expect(() => parseRefusalSeries(raw)).toThrow('refusalSeries:');
    });
});

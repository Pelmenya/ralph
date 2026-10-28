// #220: дубль, квота и бюджет фазы — чистая арифметика. Применение на шве проверяет
// `orchestrator.test.ts`; здесь — что мера сходства различает «то же другими словами» и
// «другое теми же словами», и что каждая ветка отказа конфига краснеет.
import { describe, expect, it } from 'vitest';
import {
    DEDUP_THRESHOLD,
    SESSION_NEW_ISSUE_QUOTA,
    blocksProblem,
    findDuplicateIssue,
    issueFingerprint,
    issueSimilarity,
    phaseBudgetWarning,
    resolveNewIssuePolicy,
} from './new-issue-policy.ts';

// Пара из инцидента 28.10 в обезличенной форме: заголовки разные, цепочка файлов одна.
const FIRST = {
    number: 14,
    title: 'Стенд не выходит наружу через прокси хоста',
    body: 'Проба падает в `provision/install-stand.sh` и `core/live-probe.ts`, см. #12.',
};
const AGAIN = {
    title: 'Egress стенда: сессия CLI не достаёт API',
    body: 'Цепочка provision/install-stand.sh → core/live-probe.ts рвётся, как в #12.',
};

describe('issueFingerprint', () => {
    it('пути, номера и слова заголовка — порознь; ссылка путём не считается', () => {
        const fp = issueFingerprint({
            title: 'Дубли new-issue для вехи',
            body: 'см. `./core/a.ts`, package.json и https://example.com/x/y, #7 и #8.',
        });
        expect([...fp.paths].sort()).toEqual(['core/a.ts', 'package.json']);
        expect([...fp.refs].sort()).toEqual(['7', '8']);
        expect([...fp.words].sort()).toEqual(['issue', 'new', 'вехи', 'дубли']);
    });
});

describe('issueSimilarity', () => {
    it('измерение, пустое у обеих, в счёт не идёт', () => {
        const a = issueFingerprint({ title: 'Течёт лимит форжа', body: 'симптом' });
        const b = issueFingerprint({ title: 'Течёт лимит форжа', body: 'другое' });
        const s = issueSimilarity(a, b);
        expect(s.score).toBe(1);
        expect(s.why).toMatch(/слова заголовка 3\/3/);
        expect(s.why).not.toMatch(/пути/);
    });

    it('общих признаков нет — ноль и это сказано', () => {
        const e = issueFingerprint({ title: 'ok', body: '' });
        expect(issueSimilarity(e, e)).toEqual({ score: 0, why: 'общих признаков нет → 0.00' });
    });
});

describe('findDuplicateIssue', () => {
    it('другой заголовок, те же пути и номер — дубль с объяснением', () => {
        const d = findDuplicateIssue(AGAIN, [FIRST], DEDUP_THRESHOLD);
        expect(d?.number).toBe(14);
        expect(d?.why).toMatch(/пути 2\/2/);
        expect(d?.why).toMatch(/номера 1\/1/);
    });

    it('ОТ ПРОТИВНОГО: общие слова заголовка, разные пути — не дубль', () => {
        const a = { number: 3, title: 'Лимит форжа на комментарии', body: 'в `core/review.ts`' };
        const b = { title: 'Лимит форжа на метки', body: 'в `adapters/sourcecraft-api.ts`' };
        expect(findDuplicateIssue(b, [a], DEDUP_THRESHOLD)).toBeNull();
    });

    it('из двух похожих — самая похожая, при равенстве — старшая', () => {
        const twin = { ...FIRST, number: 9 };
        expect(findDuplicateIssue(AGAIN, [FIRST, twin], DEDUP_THRESHOLD)?.number).toBe(9);
        const closer = { number: 20, title: AGAIN.title, body: AGAIN.body };
        expect(findDuplicateIssue(AGAIN, [FIRST, closer], DEDUP_THRESHOLD)?.number).toBe(20);
    });
});

describe('resolveNewIssuePolicy', () => {
    it('нет секции — дефолты, барьер не выключается молчанием', () => {
        expect(resolveNewIssuePolicy(undefined)).toEqual({
            dedupThreshold: DEDUP_THRESHOLD,
            sessionQuota: SESSION_NEW_ISSUE_QUOTA,
            triageLabel: null,
        });
    });

    it('заданные значения принимаются', () => {
        expect(
            resolveNewIssuePolicy({ dedupThreshold: 1, sessionQuota: 0, triageLabel: 'triage' }),
        ).toEqual({ dedupThreshold: 1, sessionQuota: 0, triageLabel: 'triage' });
    });

    it.each([
        ['не объект', []],
        ['незнакомый ключ', { threshold: 0.5 }],
        ['порог строкой', { dedupThreshold: '0.6' }],
        ['порог ноль', { dedupThreshold: 0 }],
        ['порог больше единицы', { dedupThreshold: 1.5 }],
        ['квота дробная', { sessionQuota: 1.5 }],
        ['квота отрицательная', { sessionQuota: -1 }],
        ['метка пустая', { triageLabel: ' ' }],
    ])('НЕГАТИВНЫЙ: %s — отказ', (_, raw) => {
        expect(() => resolveNewIssuePolicy(raw)).toThrow(/newIssues/);
    });
});

describe('phaseBudgetWarning', () => {
    it('11 карточек при лимите 10 — ⚠ с обоими числами', () => {
        const w = phaseBudgetWarning({ milestone: 'Ф1', openCount: 11, maxIterations: 10 });
        expect(w).toMatch(/^⚠/);
        expect(w).toMatch(/11/);
        expect(w).toMatch(/maxIterations 10/);
    });

    it('ровно лимит — молчит', () => {
        expect(
            phaseBudgetWarning({ milestone: 'Ф1', openCount: 10, maxIterations: 10 }),
        ).toBeNull();
    });
});

describe('blocksProblem', () => {
    it('номер вне вехи — проблема с номером и вехой; без blocks и в вехе — нет', () => {
        const reqs = [
            { kind: 'close', issue: 1 },
            { kind: 'new-issue', title: 'a' },
            { kind: 'new-issue', title: 'b', blocks: 5 },
        ];
        expect(blocksProblem(reqs, [5, 6], 'Ф1')).toBeNull();
        expect(blocksProblem(reqs, [6], 'Ф1')).toMatch(/blocks #5.*"Ф1"/);
    });
});

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_MERGE_RETRY_MAX_MS,
    MERGE_RETRY_BASE_MS,
    MERGE_RETRY_MAX_PAUSE_MS,
    classifyMergeFailure,
    mergeFailureLine,
    mergeRetryPauseMs,
    resolveMergeRetryMaxMs,
} from './merge-retry.ts';

// Так выглядит исключение execFileSync: первая строка — сама команда, со всеми флагами.
const CMD =
    'Command failed: gh pr merge 503 --squash --delete-branch --match-head-commit ' +
    '5030503050305030503050305030503050305030';

describe('classifyMergeFailure (#47)', () => {
    it.each([
        'GraphQL: Something went wrong (HTTP 503)',
        'HTTP 502: Bad Gateway',
        'curl: (22) The requested URL returned error: 504',
        '504 Gateway Timeout',
        'read ECONNRESET',
        'spawnSync gh ETIMEDOUT',
        'curl: (28) Operation timed out after 30000 milliseconds',
        'socket hang up',
        // 408/429 — транзиенты, хотя и 4xx: ради упора в лимит API предел и заведён.
        'GraphQL: API rate limit exceeded for installation (HTTP 429)',
        'HTTP 408: Request Timeout',
        'curl: (22) The requested URL returned error: 429',
        '429 Too Many Requests',
        'You have exceeded a secondary rate limit.',
        // Реальная форма ответа GitHub на лимит — 403, и он не должен уйти в отказ.
        'HTTP 403: API rate limit exceeded for user ID 1234567.',
        'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        'Голову PR #9 не удалось верифицировать (curl вернул 22 — The requested URL returned error: 503).',
    ])('транзиент: %s', (stderr) => {
        expect(classifyMergeFailure(`${CMD}\n${stderr}`)).toBe('transient');
    });

    it.each([
        'Pull request #9 is not mergeable: the merge commit cannot be cleanly created.',
        '{"mergeable": false}',
        'Head branch was modified. Review and try the merge again. (HTTP 409)',
        'Pull request #9 is closed',
        'GraphQL: Resource not accessible by integration (HTTP 403)',
        'Голова PR #9 уехала после прогона чеков: гейт проверял a, сейчас b.',
        // Отказ по существу сильнее транзиентного слова рядом.
        'merge conflict; upstream also said HTTP 503',
    ])('отказ по существу: %s', (stderr) => {
        expect(classifyMergeFailure(`${CMD}\n${stderr}`)).toBe('refusal');
    });

    // Текст команды не даёт признаков ни одному классу: флаг `--match-head-commit`, номер
    // PR 503 и sha из цифр 503 — не ответ форжа.
    it('одна строка команды без ответа → unknown', () => {
        expect(classifyMergeFailure(CMD)).toBe('unknown');
        expect(classifyMergeFailure(`${CMD}\nsomething odd happened`)).toBe('unknown');
    });

    // «От противного» к 408/429: соседние 4xx остаются отказом по существу — исключение
    // не расползлось на весь класс.
    // 403 без слов о лимите — права, отказ: исключение для лимита держится на словах, а не
    // на коде.
    it.each([
        'HTTP 400',
        'HTTP 403: Forbidden',
        'HTTP 409',
        'HTTP 428',
        'HTTP 422',
        'returned error: 403',
    ])('соседний 4xx — по-прежнему отказ: %s', (stderr) => {
        expect(classifyMergeFailure(`${CMD}\n${stderr}`)).toBe('refusal');
    });

    it('501 повтором не появится — не транзиент', () => {
        expect(classifyMergeFailure('HTTP 501: Not Implemented')).toBe('unknown');
    });
});

describe('mergeFailureLine (#47)', () => {
    it('берёт строку ответа форжа, а не командную', () => {
        expect(mergeFailureLine(`${CMD}\n\nGraphQL: Something went wrong (HTTP 503)\n`)).toBe(
            'GraphQL: Something went wrong (HTTP 503)',
        );
    });

    it('без ответа — команда, а не пустота', () => {
        expect(mergeFailureLine(CMD)).toBe(CMD);
    });

    it('исключение не от execFileSync — первая непустая строка', () => {
        expect(mergeFailureLine('\nboom\nstack')).toBe('boom');
    });
});

describe('mergeRetryPauseMs (#47)', () => {
    it('растёт удвоением от базы и упирается в потолок', () => {
        const pauses = [1, 2, 3, 4, 5].map(mergeRetryPauseMs);
        expect(pauses[0]).toBe(MERGE_RETRY_BASE_MS);
        expect(pauses[1]).toBe(MERGE_RETRY_BASE_MS * 2);
        for (let i = 1; i < pauses.length; i++)
            expect(pauses[i]).toBeGreaterThanOrEqual(pauses[i - 1]);
        expect(pauses[4]).toBe(MERGE_RETRY_MAX_PAUSE_MS);
    });
});

describe('resolveMergeRetryMaxMs (#47)', () => {
    const boom = (m: string): never => {
        throw new Error(m);
    };

    it('ключа нет → дефолт кода', () => {
        expect(resolveMergeRetryMaxMs({}, boom)).toBe(DEFAULT_MERGE_RETRY_MAX_MS);
        expect(resolveMergeRetryMaxMs(undefined, boom)).toBe(DEFAULT_MERGE_RETRY_MAX_MS);
    });

    it('целое положительное → берётся как есть', () => {
        expect(resolveMergeRetryMaxMs({ mergeRetryMaxMs: 120_000 }, boom)).toBe(120_000);
    });

    it.each([0, -1, 1.5, '600000', null])('битое значение %j → fail-closed', (v) => {
        expect(() => resolveMergeRetryMaxMs({ mergeRetryMaxMs: v }, boom)).toThrow(
            /mergeRetryMaxMs/,
        );
    });
});

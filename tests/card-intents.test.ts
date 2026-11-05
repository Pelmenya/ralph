// #291: ревью карточки получает свои намерения, а close кодера сначала ложится в state.
// Матрица повторяет окна #86: итог батча сохраняется до первого эффекта, запрещённая ролью
// начатая строка не снимается, а повтор комментария решается сверкой метки в ленте карточки.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов, как в матрице #86.
import ralph from '../ralph.js';
import { inFlightMarker, intentMark } from '../core/session-requests.ts';
import type { TCardSeverity } from '../core/card-review.ts';

type TCardRole = 'coder' | 'review' | 'fix' | 'closing';
type TCardBatch = {
    deferredClose: string | null;
    summary: string | null;
    blocked: string | null;
    findings: Array<{
        severity: TCardSeverity;
        comment: string;
        anchor: { path: string; line: number };
    }>;
    fixes: Array<{ finding: string; test: string }>;
};
type TResult = {
    applied: number;
    failed: boolean;
    closedIssues: number[];
    prFindings: unknown[];
    outcomeUnknown?: boolean;
    dropped?: Array<{ kind: string; what: string }>;
};
type TRunOptions = {
    role?: TCardRole;
    withCardStage?: boolean;
    enabled?: boolean;
    saveBatchFn?: (batch: TCardBatch) => void;
    writeFn?: (text: string) => void;
    failCommentAfter?: boolean;
    probeVerdict?: string;
};

const line = (value: unknown): string => JSON.stringify(value);
const emptyBatch = (): TCardBatch => ({
    deferredClose: null,
    summary: null,
    blocked: null,
    findings: [],
    fixes: [],
});
const close = (comment = 'сделано') => ({ kind: 'close', issue: 7, comment });
const cardComment = (comment = '⚪ [nit] чисто') => ({
    kind: 'card-comment',
    issue: 7,
    comment,
});

function makeHarness(requests: unknown[] | string) {
    const disk = {
        file: (typeof requests === 'string' ? requests : `${requests.map(line).join('\n')}\n`) as
            string | null,
    };
    const issueComments: Record<number, string[]> = {};
    const effects: string[] = [];
    const batches: TCardBatch[] = [];
    const logs: string[] = [];
    const pushes: string[] = [];
    const ids: string[] = [];
    let nextId = 0;

    const run = (options: TRunOptions = {}): TResult => {
        const role = options.role ?? 'coder';
        const saveBatchFn = options.saveBatchFn ?? ((batch: TCardBatch) => batches.push(batch));
        return ralph.applySessionRequests({
            cfg: {
                issueLabels: ['complexity:low', 'area:core'],
                review: { cardReview: options.enabled ?? true },
            },
            currentMilestone: 'M1',
            dry: false,
            readFn: () => disk.file,
            writeFn:
                options.writeFn ??
                ((text: string) => {
                    disk.file = text;
                }),
            removeFn: () => {
                disk.file = null;
            },
            cardStage:
                options.withCardStage === false ? undefined : { issue: 7, role, saveBatchFn },
            taskSource: {
                commentOnIssue: (issue: number, body: string) => {
                    effects.push(`comment:${String(issue)}`);
                    issueComments[issue] = [...(issueComments[issue] ?? []), body];
                    if (options.failCommentAfter) throw new Error('socket hang up');
                },
                closeIssue: (issue: number) => {
                    effects.push(`close:${String(issue)}`);
                },
                blockIssue: (issue: number) => {
                    effects.push(`block:${String(issue)}`);
                },
                createIssue: () => 101,
                listIssueComments: (issue: number) => [...(issueComments[issue] ?? [])],
            },
            liveProbeFn: ({ issue }: { issue: number }) => {
                effects.push(`probe:${String(issue)}`);
                return {
                    verdict: options.probeVerdict ?? 'PASS',
                    comment: `проба: ${options.probeVerdict ?? 'PASS'}`,
                };
            },
            intentIdFn: () => {
                nextId += 1;
                const id = `intent-${String(nextId).padStart(4, '0')}`;
                ids.push(id);
                return id;
            },
            logFn: (message: string) => logs.push(message),
            pushEventFn: (message: string) => pushes.push(message),
        }) as TResult;
    };

    return { disk, issueComments, effects, batches, logs, pushes, ids, run };
}

describe('#291 крах-окна и роли ревью карточки', () => {
    it('1. coder: close своей карточки сохраняется в батч и не исполняется', () => {
        const h = makeHarness([close('готово')]);
        const result = h.run({ role: 'coder' });
        expect(h.batches).toEqual([{ ...emptyBatch(), deferredClose: 'готово' }]);
        expect(h.effects).toEqual([]);
        expect(result.closedIssues).toEqual([]);
        expect(result.applied).toBe(0);
        expect(h.disk.file).toBeNull();
    });

    it('2. обрыв после saveBatchFn до записи файла: повтор даёт тот же deferredClose', () => {
        const h = makeHarness([close('готово')]);
        expect(() =>
            h.run({
                writeFn: () => {
                    throw new Error('убит после сохранения батча');
                },
            }),
        ).toThrow('убит после сохранения батча');
        expect(h.batches[0].deferredClose).toBe('готово');

        const result = h.run();
        expect(result.failed).toBe(false);
        expect(h.batches[1].deferredClose).toBe('готово');
        expect(h.effects).toEqual([]);
        expect(h.disk.file).toBeNull();
    });

    it('3. обрыв после comment: файл уже без close, повтор не дублирует комментарий', () => {
        const h = makeHarness([
            { kind: 'comment', issue: 7, comment: 'сначала объяснение' },
            close('отложенное закрытие'),
        ]);
        const first = h.run({ failCommentAfter: true });
        expect(first.failed).toBe(true);
        expect(h.disk.file).not.toContain('"kind":"close"');
        expect(h.batches[0].deferredClose).toBe('отложенное закрытие');

        const second = h.run();
        expect(second.failed).toBe(false);
        expect(h.batches[1].deferredClose).toBeNull();
        expect(h.issueComments[7]).toHaveLength(1);
        expect(h.effects).toEqual(['comment:7']);
        expect(h.disk.file).toBeNull();
    });

    it('4. saveBatchFn бросил: исход неизвестен, до форжа не дошло ни одно намерение', () => {
        const h = makeHarness([{ kind: 'comment', issue: 7, comment: 'x' }, close()]);
        const result = h.run({
            saveBatchFn: () => {
                throw new Error('state не записался');
            },
        });
        expect(result.failed).toBe(true);
        expect(result.outcomeUnknown).toBe(true);
        expect(h.effects).toEqual([]);
        expect(h.pushes.join('\n')).toContain('state не записался');
    });

    it('5. проба не PASS отменяет close; review живую пробу не исполняет', () => {
        const coder = makeHarness([
            { kind: 'live-probe', issue: 7, cli: 'claude', case: 'unknown-tool' },
            close(),
        ]);
        const coderResult = coder.run({ probeVerdict: 'FAIL' });
        expect(coder.batches[0].deferredClose).toBeNull();
        expect(coderResult.dropped?.map((d) => d.kind)).toContain('close');
        expect(coder.effects).toEqual(['probe:7', 'comment:7']);

        const review = makeHarness([
            { kind: 'live-probe', issue: 7, cli: 'claude', case: 'unknown-tool' },
        ]);
        review.run({ role: 'review' });
        expect(review.effects).toEqual([]);
        expect(review.batches[0]).toEqual(emptyBatch());
    });

    it('6. coder: чужой close снимается, а block своей сильнее отложенного close', () => {
        const foreign = makeHarness([{ kind: 'close', issue: 8, comment: 'чужая' }]);
        const foreignResult = foreign.run();
        expect(foreignResult.dropped?.map((d) => d.kind)).toEqual(['close']);
        expect(foreign.effects).toEqual([]);

        const blocked = makeHarness([
            { kind: 'block', issue: 7, comment: 'нужен человек' },
            close(),
        ]);
        blocked.run();
        expect(blocked.batches[0].deferredClose).toBeNull();
        expect(blocked.effects).toEqual(['comment:7', 'block:7']);
    });

    it('7. card-* вне своей роли не исполняются и не попадают в батч', () => {
        const coder = makeHarness([cardComment('⚪ [nit] не сводка кодера')]);
        coder.run({ role: 'coder' });
        expect(coder.batches[0].summary).toBeNull();
        expect(coder.effects).toEqual([]);

        const review = makeHarness([close()]);
        review.run({ role: 'review' });
        expect(review.batches[0].deferredClose).toBeNull();
        expect(review.effects).toEqual([]);

        const fix = makeHarness([cardComment('🟠 [major] не исполнять')]);
        fix.run({ role: 'fix' });
        expect(fix.effects).toEqual([]);
    });

    it('8. без cardStage включённая стадия запрещает close; выключенная сохраняет поведение', () => {
        const enabled = makeHarness([close()]);
        enabled.run({ withCardStage: false });
        expect(enabled.effects).toEqual([]);
        expect(enabled.logs.join('\n')).toContain('close');

        const disabled = makeHarness([close()]);
        disabled.run({ withCardStage: false, enabled: false });
        expect(disabled.effects).toEqual(['comment:7', 'close:7']);
        expect(disabled.batches).toEqual([]);

        const disabledCard = makeHarness([cardComment()]);
        disabledCard.run({ role: 'review', enabled: false });
        expect(disabledCard.effects).toEqual([]);
        expect(disabledCard.batches).toEqual([]);
        expect(disabledCard.logs.join('\n')).toContain('card-comment');
    });

    it('9. начатый close запрещён роли review: метка остаётся, эффекта нет', () => {
        const id = 'intent-0001';
        const raw = `${inFlightMarker(id)}\n${line(close())}\n`;
        const h = makeHarness(raw);
        const result = h.run({ role: 'review' });
        expect(result.failed).toBe(true);
        expect(result.outcomeUnknown).toBe(true);
        expect(result.closedIssues).toEqual([]);
        expect(h.effects).toEqual([]);
        expect(h.disk.file).toBe(raw);
        expect(h.pushes.join('\n')).toContain('close');
    });

    it('10. card-comment сверяется по ленте: метка есть — без дубля, нет — тот же id', () => {
        const id = 'intent-0001';
        const request = {
            kind: 'card-comment',
            issue: 7,
            comment: '🟠 [major] место',
            path: 'core/a.ts',
            line: 42,
        };
        const landed = makeHarness(`${inFlightMarker(id)}\n${line(request)}\n`);
        landed.issueComments[7] = [`🟠 [major] место\n\n${intentMark(id)}`];
        const landedResult = landed.run({ role: 'review' });
        expect(landedResult.failed).toBe(false);
        expect(landed.issueComments[7]).toHaveLength(1);
        expect(landed.ids).toEqual([]);

        const missing = makeHarness(`${inFlightMarker(id)}\n${line(request)}\n`);
        const missingResult = missing.run({ role: 'review' });
        expect(missingResult.failed).toBe(false);
        expect(missing.issueComments[7]).toHaveLength(1);
        expect(missing.issueComments[7][0]).toContain(intentMark(id));
        expect(missing.ids).toEqual([]);

        const blockRequest = { kind: 'card-block', issue: 7, comment: 'стоп' };
        const blocked = makeHarness(`${inFlightMarker(id)}\n${line(blockRequest)}\n`);
        blocked.issueComments[7] = [`стоп\n\n${intentMark(id)}`];
        const blockedResult = blocked.run({ role: 'review' });
        expect(blockedResult.failed).toBe(false);
        expect(blocked.issueComments[7]).toHaveLength(1);
        expect(blocked.effects).toEqual([]);
    });

    it('11. pr-comment у review не даёт prFindings и не занижает applied', () => {
        const h = makeHarness([
            {
                kind: 'pr-comment',
                comment: '🔴 [blocker] не относится к этому PR',
                path: 'core/a.ts',
                line: 1,
            },
            { kind: 'comment', issue: 7, comment: 'разрешённый комментарий' },
        ]);
        const result = h.run({ role: 'review' });
        expect(result.prFindings).toEqual([]);
        expect(result.applied).toBe(1);
        expect(h.effects).toEqual(['comment:7']);
        expect(h.disk.file).toBeNull();
    });
});

describe('#291 содержимое TCardBatch и оставшиеся роли', () => {
    it('review: первая сводка, находки с серьёзностью и блок сохраняются до эффектов', () => {
        const h = makeHarness([
            cardComment('⚪ [nit] первая сводка'),
            cardComment('⚪ [nit] вторая сводка'),
            {
                kind: 'card-comment',
                issue: 7,
                comment: '🟠 [major] найден дефект',
                path: 'core/a.ts',
                line: 42,
            },
            { kind: 'card-block', issue: 7, comment: 'нельзя закрывать' },
        ]);
        const result = h.run({ role: 'review' });
        expect(h.batches[0]).toEqual({
            ...emptyBatch(),
            summary: '⚪ [nit] первая сводка',
            blocked: 'нельзя закрывать',
            findings: [
                {
                    severity: 'major',
                    comment: '🟠 [major] найден дефект',
                    anchor: { path: 'core/a.ts', line: 42 },
                },
            ],
        });
        expect(h.effects).toEqual(['comment:7', 'comment:7', 'comment:7', 'comment:7']);
        expect(h.effects).not.toContain('block:7');
        expect(result.applied).toBe(4);
    });

    it('fix: card-fix своей карточки идёт только в батч', () => {
        const h = makeHarness([
            { kind: 'card-fix', issue: 7, finding: 'F1', test: 'проверка первой правки' },
            { kind: 'card-fix', issue: 7, finding: 'F2', test: 'проверка второй правки' },
        ]);
        const result = h.run({ role: 'fix' });
        expect(h.batches[0].fixes).toEqual([
            { finding: 'F1', test: 'проверка первой правки' },
            { finding: 'F2', test: 'проверка второй правки' },
        ]);
        expect(h.effects).toEqual([]);
        expect(result.applied).toBe(0);
    });

    it('closing: исполняется только close своей карточки', () => {
        const h = makeHarness([
            { kind: 'comment', issue: 7, comment: 'лишнее' },
            close('закрытие после чистого ревью'),
            cardComment('⚪ [nit] тоже лишнее'),
        ]);
        const result = h.run({ role: 'closing' });
        expect(result.closedIssues).toEqual([7]);
        expect(h.effects).toEqual(['comment:7', 'close:7']);
        expect(result.applied).toBe(1);
    });
});

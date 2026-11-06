import { describe, expect, it } from 'vitest';
import {
    applyCardFixBatch,
    applyCardReviewBatch,
    buildCardBatch,
    cardRecordOf,
    cardSubmitProblem,
    decideCardStep,
    formatCardLimitPacket,
    formatCardMetrics,
    formatCardReviewsContext,
    isFullSha,
    newCardProgress,
    openBlocking,
    parseCardHistory,
    parseCardProgress,
    resolveCardReview,
    type TCardFinding,
    type TCardProgress,
    type TCardRecord,
} from './card-review.ts';
import { buildCardReviewPrompt, buildCardFixPrompt } from './prompts.ts';
import { parseSessionRequests } from './session-requests.ts';
import { CONTRACT_CARD } from '../tests/__fixtures__/card-review-boundaries.ts';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const STARTED_AT = '2026-11-05T10:00:00.000Z';
const FINISHED_AT = '2026-11-05T10:00:12.000Z';

function finding(over: Partial<TCardFinding> = {}): TCardFinding {
    return {
        id: 'F1',
        severity: 'blocker',
        comment: 'потерян отказ',
        anchor: { path: 'core/a.ts', line: 42 },
        round: 1,
        head: HEAD_A,
        status: 'open',
        test: null,
        note: null,
        ...over,
    };
}

function progress(over: Partial<TCardProgress> = {}): TCardProgress {
    return {
        ...newCardProgress({
            issue: 7,
            milestone: 'M30',
            firstHead: HEAD_A,
            startedAt: STARTED_AT,
        }),
        ...over,
    };
}

function record(over: Partial<TCardRecord> = {}): TCardRecord {
    return {
        issue: 7,
        milestone: 'M30',
        outcome: 'blocked',
        head: HEAD_A,
        verdict: 'findings',
        lastReviewedHead: HEAD_A,
        rounds: 2,
        sessions: 5,
        failedSessions: 1,
        findings: [finding()],
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        ...over,
    };
}

describe('cardSubmitProblem', () => {
    const clean = record({ outcome: 'closed', verdict: 'clean' });

    it.each([
        ['пустая история', null, []],
        ['чистый вердикт своей головы', null, [clean]],
        ['blocked держит карточку, а не сдачу', null, [record()]],
        ['внешнее закрытие — решение человека', null, [record({ outcome: 'closed-external' })]],
        ['чужая веха не влияет', null, [record({ milestone: 'M29', verdict: 'findings' })]],
    ])('%s → сдача идёт', (_name, current, history) => {
        expect(cardSubmitProblem(current, history, 'M30')).toBeNull();
    });

    it('недоведённая запись останавливает сдачу с номером карточки', () => {
        expect(cardSubmitProblem(progress(), [], 'M30')).toBe('карточка #7 не доведена');
    });

    it.each([
        ['вердикт findings', { verdict: 'findings' as const }],
        ['вердикт отсутствует', { verdict: null }],
        ['ревью другой головы', { lastReviewedHead: HEAD_B }],
        ['короткая голова исхода', { head: 'abc' }],
        ['короткая голова ревью', { lastReviewedHead: 'abc' }],
        ['голова исхода отсутствует', { head: null }],
        ['голова ревью отсутствует', { lastReviewedHead: null }],
    ])('closed: %s → стоп', (_name, over) => {
        expect(
            cardSubmitProblem(null, [record({ ...clean, ...over } as Partial<TCardRecord>)], 'M30'),
        ).toBe('карточка #7 закрыта без чистого вердикта своей головы');
    });

    it.each([
        ['сначала чистая', [clean, record({ outcome: 'closed', verdict: 'findings' })]],
        ['сначала нечистая', [record({ outcome: 'closed', verdict: 'findings' }), clean]],
    ])('проверяются все записи одной карточки: %s', (_name, history) => {
        expect(cardSubmitProblem(null, history, 'M30')).toContain('#7');
    });
});

describe('formatCardReviewsContext', () => {
    it('по каждой карточке вехи печатает исход, SHA и обе группы находок', () => {
        const text = formatCardReviewsContext(
            [
                record({
                    outcome: 'closed',
                    verdict: 'clean',
                    head: HEAD_B,
                    lastReviewedHead: HEAD_B,
                    findings: [
                        finding(),
                        finding({
                            id: 'F2',
                            severity: 'minor',
                            status: 'fixed',
                            anchor: null,
                            comment: 'закрытая находка',
                        }),
                    ],
                }),
                record({ issue: 8, milestone: 'M29' }),
            ],
            'M30',
        );
        expect(text).toBe(
            `Карточка #7: исход closed, вердикт clean, SHA ${HEAD_B}, последнее ревью ${HEAD_B}\n` +
                '  Открытые находки:\n' +
                '  - F1 [blocker] core/a.ts:42 — потерян отказ\n' +
                '  Закрытые находки:\n' +
                '  - F2 [minor] место не указано — закрытая находка',
        );
    });

    it('обрезает текст находки до 300 символов и не смешивает вехи', () => {
        const text = formatCardReviewsContext(
            [record({ findings: [finding({ comment: 'я'.repeat(301) })] })],
            'M30',
        );
        expect(text).toContain('я'.repeat(300));
        expect(text).not.toContain('я'.repeat(301));
        expect(formatCardReviewsContext([record({ milestone: 'M29' })], 'M30')).toBe('');
    });
});

describe('resolveCardReview', () => {
    it.each([undefined, null, {}, { cardReview: false }])(
        'стадия выключена по умолчанию: %j',
        (review) => {
            expect(resolveCardReview(review)).toEqual({
                enabled: false,
                maxRounds: 3,
                maxSessions: 8,
            });
        },
    );

    it('включённая стадия получает пределы по умолчанию', () => {
        expect(resolveCardReview({ cardReview: true })).toEqual({
            enabled: true,
            maxRounds: 3,
            maxSessions: 8,
        });
    });

    it.each([
        [{ cardReview: 'да' }, 'cardReview'],
        [{ cardReview: true, maxCardReviewRounds: 0 }, 'maxCardReviewRounds'],
        [{ cardReview: true, maxCardReviewRounds: 1.5 }, 'maxCardReviewRounds'],
        [{ cardReview: true, maxCardReviewRounds: 'x' }, 'maxCardReviewRounds'],
        [{ cardReview: true, maxCardSessions: 0 }, 'maxCardSessions'],
        [{ cardReview: true, maxCardSessions: 1.5 }, 'maxCardSessions'],
        [{ cardReview: true, maxCardSessions: 'x' }, 'maxCardSessions'],
        [{ maxCardReviewRounds: 3 }, 'maxCardReviewRounds'],
        [{ cardReview: false, maxCardSessions: 8 }, 'maxCardSessions'],
        [{ cardReview: true, maxCardSessions: 5 }, 'maxCardSessions'],
        [{ cardReview: true, maxCardReviewRounds: 4, maxCardSessions: 7 }, 'maxCardSessions'],
    ])('битый или несовместимый ключ отвергнут: %j', (review, key) => {
        expect(() => resolveCardReview(review)).toThrow(key);
    });

    it.each([
        [{ cardReview: true, maxCardSessions: 6 }, 3, 6],
        [{ cardReview: true, maxCardReviewRounds: 4, maxCardSessions: 8 }, 4, 8],
    ])('нижняя граница бюджета сессий принята: %j', (review, rounds, sessions) => {
        expect(resolveCardReview(review)).toEqual({
            enabled: true,
            maxRounds: rounds,
            maxSessions: sessions,
        });
    });

    it('отказ называет найденное значение', () => {
        expect(() => resolveCardReview({ cardReview: true, maxCardSessions: 5 })).toThrow(/5/);
    });
});

describe('форма записей карточки', () => {
    it('isFullSha принимает ровно 40 строчных hex', () => {
        expect(isFullSha(HEAD_A)).toBe(true);
        expect(isFullSha('A'.repeat(40))).toBe(false);
        expect(isFullSha('a'.repeat(39))).toBe(false);
        expect(isFullSha(null)).toBe(false);
    });

    it('newCardProgress заполняет необязательные поля явным null', () => {
        expect(progress()).toEqual({
            issue: 7,
            milestone: 'M30',
            firstHead: HEAD_A,
            closeComment: null,
            rounds: 0,
            sessions: 0,
            failedSessions: 0,
            lastReviewedHead: null,
            verdict: null,
            findings: [],
            pending: null,
            closing: null,
            limitHead: null,
            startedAt: STARTED_AT,
        });
    });

    it('parseCardProgress различает отсутствие записи и сохраняет полный круговой проход', () => {
        expect(parseCardProgress(undefined)).toBeNull();
        expect(parseCardProgress(null)).toBeNull();
        const value = progress({
            closeComment: '',
            rounds: 2,
            sessions: 5,
            failedSessions: 1,
            lastReviewedHead: HEAD_B,
            verdict: 'findings',
            findings: [
                finding(),
                finding({
                    id: 'F2',
                    severity: 'nit',
                    anchor: null,
                    status: 'journal',
                    test: 'core/a.test.ts',
                    note: 'не держит закрытие',
                }),
            ],
            pending: { role: 'fix', head: HEAD_B, saved: true },
            closing: HEAD_B,
            limitHead: HEAD_B,
        });
        expect(parseCardProgress(JSON.parse(JSON.stringify(value)))).toEqual(value);
    });

    it('parseCardProgress отвергает не-объект', () => {
        expect(() => parseCardProgress([])).toThrow('cardReview');
    });

    it.each([
        ['короткий firstHead', { firstHead: 'abc' }, 'firstHead'],
        ['отрицательный rounds', { rounds: -1 }, 'rounds'],
        ['дробной sessions', { sessions: 1.5 }, 'sessions'],
        ['отрицательный failedSessions', { failedSessions: -1 }, 'failedSessions'],
        ['короткий lastReviewedHead', { lastReviewedHead: 'abc' }, 'lastReviewedHead'],
        ['clean без головы', { verdict: 'clean' }, 'lastReviewedHead'],
        ['неизвестный verdict', { verdict: 'unknown' }, 'verdict'],
        ['битый pending', { pending: { role: 'coder', head: HEAD_A, saved: false } }, 'role'],
        ['pending без saved', { pending: { role: 'review', head: HEAD_A } }, 'saved'],
        ['короткий closing', { closing: 'abc' }, 'closing'],
        ['limitHead не sha', { limitHead: 7 }, 'limitHead'],
        ['startedAt не строка', { startedAt: 7 }, 'startedAt'],
    ])('parseCardProgress: %s → отказ с именем поля', (_name, over, field) => {
        expect(() => parseCardProgress({ ...progress(), ...over })).toThrow(field);
    });

    it.each([
        ['неизвестная серьёзность', { severity: 'critical' }, 'severity'],
        ['неизвестный статус', { status: 'deferred' }, 'status'],
        ['journal у blocker', { status: 'journal' }, 'status'],
        ['journal у major', { severity: 'major', status: 'journal' }, 'status'],
        ['короткий sha находки', { head: 'abc' }, 'head'],
        ['отрицательный круг', { round: -1 }, 'round'],
        ['битый anchor', { anchor: { path: 'core/a.ts', line: 0 } }, 'line'],
    ])('находка: %s → отказ', (_name, over, field) => {
        const invalid = over as Partial<TCardFinding>;
        expect(() => parseCardProgress(progress({ findings: [finding(invalid)] }))).toThrow(field);
    });

    it('journal разрешён только косметике', () => {
        for (const severity of ['minor', 'nit'] as const) {
            const value = progress({ findings: [finding({ severity, status: 'journal' })] });
            expect(parseCardProgress(value)).toEqual(value);
        }
    });

    it('openBlocking возвращает только открытые blocker/major', () => {
        const findings = [
            finding(),
            finding({ id: 'F2', severity: 'major' }),
            finding({ id: 'F3', severity: 'minor' }),
            finding({ id: 'F4', severity: 'blocker', status: 'fixed' }),
            finding({ id: 'F5', severity: 'nit', status: 'journal' }),
        ];
        expect(openBlocking(progress({ findings })).map((f) => f.id)).toEqual(['F1', 'F2']);
    });

    it('parseCardHistory: отсутствие — пустой список, годные записи сохраняются', () => {
        expect(parseCardHistory(undefined)).toEqual([]);
        const history = [
            record({ outcome: 'closed', head: HEAD_B, verdict: 'clean' }),
            record({ outcome: 'closed-external', head: null }),
            record({ outcome: 'blocked', head: null }),
        ];
        expect(parseCardHistory(JSON.parse(JSON.stringify(history)))).toEqual(history);
    });

    it.each([
        ['null', null, 'cardHistory'],
        ['не массив', {}, 'cardHistory'],
        ['stop в истории', [record({ outcome: 'stop' })], 'outcome'],
        ['closed без головы', [record({ outcome: 'closed', head: null })], 'head'],
        ['closed с короткой головой', [record({ outcome: 'closed', head: 'abc' })], 'head'],
        [
            'неизвестный исход',
            [record({ outcome: 'unknown' } as unknown as Partial<TCardRecord>)],
            'outcome',
        ],
        ['отрицательный счётчик', [record({ sessions: -1 })], 'sessions'],
    ])('parseCardHistory: %s → отказ', (_name, raw, field) => {
        expect(() => parseCardHistory(raw)).toThrow(field);
    });

    it('cardRecordOf переносит итог и счётчики без их уменьшения', () => {
        const value = progress({
            closeComment: 'готово',
            rounds: 3,
            sessions: 8,
            failedSessions: 2,
            lastReviewedHead: HEAD_B,
            verdict: 'findings',
            findings: [finding()],
        });
        expect(cardRecordOf(value, 'blocked', HEAD_B, FINISHED_AT)).toEqual({
            issue: 7,
            milestone: 'M30',
            outcome: 'blocked',
            head: HEAD_B,
            verdict: 'findings',
            lastReviewedHead: HEAD_B,
            rounds: 3,
            sessions: 8,
            failedSessions: 2,
            findings: [finding()],
            startedAt: STARTED_AT,
            finishedAt: FINISHED_AT,
        });
    });

    it('formatCardMetrics печатает исход, все счётчики и секунды одной строкой', () => {
        const value = record({
            findings: [
                finding(),
                finding({ id: 'F2', severity: 'major' }),
                finding({ id: 'F3', severity: 'minor', status: 'journal' }),
                finding({ id: 'F4', severity: 'nit', status: 'journal' }),
            ],
        });
        expect(formatCardMetrics(value)).toBe(
            '📊 Карточка #7: исход blocked, кругов 2, сессий 5 (упавших 1), ' +
                'находки blocker 1 major 1 minor 1 nit 1, время 12 с',
        );
    });
});

describe('decideCardStep', () => {
    const limits = { maxRounds: 3, maxSessions: 6 };
    const open = finding();

    it.each([
        ['закрытие не запрошено, сессия ниже предела', progress({ sessions: 5 }), 'coder'],
        ['закрытие не запрошено, сессии на пределе', progress({ sessions: 6 }), 'limit'],
        [
            'чистый вердикт на текущую голову закрывает даже на пределе сессий',
            progress({
                closeComment: '',
                sessions: 6,
                rounds: 3,
                verdict: 'clean',
                lastReviewedHead: HEAD_B,
            }),
            'close',
        ],
        [
            'устаревший чистый вердикт на пределе сессий',
            progress({
                closeComment: 'закрыть',
                sessions: 6,
                verdict: 'clean',
                lastReviewedHead: HEAD_A,
            }),
            'limit',
        ],
        [
            'находки на текущей голове ниже обоих пределов',
            progress({
                closeComment: 'закрыть',
                sessions: 5,
                rounds: 2,
                verdict: 'findings',
                lastReviewedHead: HEAD_B,
                findings: [open],
            }),
            'fix',
        ],
        [
            'находки на текущей голове, круги на пределе',
            progress({
                closeComment: 'закрыть',
                sessions: 5,
                rounds: 3,
                verdict: 'findings',
                lastReviewedHead: HEAD_B,
                findings: [open],
            }),
            'limit',
        ],
        [
            'находки на текущей голове, сессии на пределе, круги ниже',
            progress({
                closeComment: 'закрыть',
                sessions: 6,
                rounds: 2,
                verdict: 'findings',
                lastReviewedHead: HEAD_B,
                findings: [open],
            }),
            'limit',
        ],
        [
            'находки на текущей голове, сессии и круги на пределе',
            progress({
                closeComment: 'закрыть',
                sessions: 6,
                rounds: 3,
                verdict: 'findings',
                lastReviewedHead: HEAD_B,
                findings: [open],
            }),
            'limit',
        ],
        [
            'открытая находка без вердикта требует ревью, а не правки',
            progress({ closeComment: 'закрыть', findings: [open] }),
            'review',
        ],
        [
            'без вердикта круги и сессии ниже предела',
            progress({ closeComment: 'закрыть', rounds: 2, sessions: 5 }),
            'review',
        ],
        [
            'без вердикта круги на пределе, сессии ниже',
            progress({ closeComment: 'закрыть', rounds: 3, sessions: 5 }),
            'limit',
        ],
        [
            'без вердикта сессии на пределе, круги ниже',
            progress({ closeComment: 'закрыть', rounds: 2, sessions: 6 }),
            'limit',
        ],
        [
            'без вердикта круги и сессии на пределе',
            progress({ closeComment: 'закрыть', rounds: 3, sessions: 6 }),
            'limit',
        ],
        [
            'устаревший вердикт с находками требует нового ревью',
            progress({
                closeComment: 'закрыть',
                rounds: 2,
                verdict: 'findings',
                lastReviewedHead: HEAD_A,
                findings: [open],
            }),
            'review',
        ],
        [
            'пустая строка closeComment — запрос закрытия',
            progress({
                closeComment: '',
                verdict: 'clean',
                lastReviewedHead: HEAD_B,
            }),
            'close',
        ],
        [
            'служебные маркеры не влияют на решение',
            progress({
                closeComment: '',
                verdict: 'clean',
                lastReviewedHead: HEAD_B,
                pending: { role: 'review', head: HEAD_B, saved: false },
                closing: HEAD_B,
                limitHead: HEAD_B,
            }),
            'close',
        ],
    ])('%s', (_name, value, expected) => {
        expect(decideCardStep(value, limits, HEAD_B)).toBe(expected);
    });

    it.each([null, undefined, 'abc', 'A'.repeat(40)])('нечитаемая голова %j → отказ', (head) => {
        expect(() => decideCardStep(progress(), limits, head)).toThrow('head');
    });
});

describe('applyCardReviewBatch', () => {
    const empty = {
        deferredClose: null,
        summary: null,
        blocked: null,
        findings: [],
        fixes: [],
    };

    it('отложенное закрытие кодера ложится в state, исходная запись не мутируется', () => {
        const before = progress();
        const after = applyCardReviewBatch(before, { ...empty, deferredClose: 'сделано' });
        expect(after.closeComment).toBe('сделано');
        expect(before.closeComment).toBeNull();
        expect(after).not.toBe(before);
    });

    it('ревью без сводки и card-block не меняет state и не тратит круг', () => {
        const before = progress({ pending: { role: 'review', head: HEAD_B, saved: false } });
        expect(applyCardReviewBatch(before, empty)).toEqual(before);
    });

    it('чистая сводка привязывается к выданной голове, косметика уходит в журнал', () => {
        const before = progress({ pending: { role: 'review', head: HEAD_B, saved: false } });
        const after = applyCardReviewBatch(before, {
            ...empty,
            summary: '⚪ [nit] чисто',
            findings: [
                {
                    severity: 'minor',
                    comment: '🟡 [minor] можно проще',
                    anchor: { path: 'core/a.ts', line: 10 },
                },
                {
                    severity: 'nit',
                    comment: '⚪ [nit] опечатка',
                    anchor: { path: 'core/a.ts', line: 11 },
                },
            ],
        });
        expect(after).toMatchObject({
            verdict: 'clean',
            lastReviewedHead: HEAD_B,
            rounds: 1,
            pending: { role: 'review', head: HEAD_B, saved: true },
        });
        expect(after.findings).toEqual([
            expect.objectContaining({ id: 'F1', severity: 'minor', status: 'journal', round: 1 }),
            expect.objectContaining({ id: 'F2', severity: 'nit', status: 'journal', round: 1 }),
        ]);
    });

    it('blocker/major дают вердикт findings и новые идентификаторы продолжают нумерацию', () => {
        const before = progress({
            findings: [finding({ id: 'F4', status: 'fixed' })],
            pending: { role: 'review', head: HEAD_B, saved: false },
        });
        const after = applyCardReviewBatch(before, {
            ...empty,
            summary: '🔴 [blocker] есть дефект',
            findings: [
                {
                    severity: 'major',
                    comment: '🟠 [major] потерян отказ',
                    anchor: { path: 'core/a.ts', line: 10 },
                },
            ],
        });
        expect(after.verdict).toBe('findings');
        expect(after.findings.at(-1)).toMatchObject({
            id: 'F5',
            severity: 'major',
            status: 'open',
            head: HEAD_B,
        });
    });

    it('card-block сильнее чистой сводки: blocker без якоря открыт, закрытие запрещено', () => {
        const before = progress({ pending: { role: 'review', head: HEAD_B, saved: false } });
        const after = applyCardReviewBatch(before, {
            ...empty,
            summary: '⚪ [nit] чисто',
            blocked: 'нельзя закрывать без проверки отказа',
        });
        expect(after.verdict).toBe('findings');
        expect(after.findings).toEqual([
            expect.objectContaining({
                id: 'F1',
                severity: 'blocker',
                comment: 'нельзя закрывать без проверки отказа',
                anchor: null,
                status: 'open',
                round: 1,
                head: HEAD_B,
            }),
        ]);
    });
});

describe('границы контрактной карточки: промпт → разбор → стадия', () => {
    const prompt = buildCardReviewPrompt({
        issue: 7,
        issueBody: CONTRACT_CARD.body,
        branch: 'feature/m1',
        diffContext: CONTRACT_CARD.diff,
        findingsContext: '',
        reviewedHead: HEAD_B,
    });
    const review = (tag: string, comment: string) => {
        const requests = parseSessionRequests(
            [
                {
                    kind: 'card-comment',
                    issue: 7,
                    comment: `${tag} ${comment}`,
                    path: 'tests/cleanup.test.ts',
                    line: 3,
                },
                { kind: 'card-comment', issue: 7, comment: '⚪ [nit] контракты проверены' },
            ]
                .map((request) => JSON.stringify(request))
                .join('\n'),
            { labelAllowlist: [] },
        );
        return applyCardReviewBatch(
            progress({
                closeComment: 'контракты готовы',
                pending: { role: 'review', head: HEAD_B, saved: false },
            }),
            buildCardBatch(requests, [], { issue: 7, role: 'review' }),
        );
    };

    it.each([0, 1])(
        '05.11: уровень за границей из промпта (%s) закрывает первый круг без реализации',
        (index) => {
            expect(prompt).toContain(CONTRACT_CARD.body);
            expect(prompt).toContain(CONTRACT_CARD.diff);
            // Берём именно разрешённые за границей теги: изменение правила должно краснить связку.
            const tags = /допустима только как (🟡 \[minor\]) или (⚪ \[nit\])/.exec(prompt);
            expect(tags).not.toBeNull();
            const after = review(tags![index + 1], CONTRACT_CARD.outsideFinding);
            expect(after.findings).toEqual([
                expect.objectContaining({
                    status: 'journal',
                    severity: index === 0 ? 'minor' : 'nit',
                }),
            ]);
            expect(after).toMatchObject({ verdict: 'clean', rounds: 1, lastReviewedHead: HEAD_B });
            expect(openBlocking(after)).toEqual([]);
            expect(decideCardStep(after, { maxRounds: 3, maxSessions: 8 }, HEAD_B)).toBe('close');
            const closed = cardRecordOf(after, 'closed', HEAD_B, FINISHED_AT);
            expect(cardSubmitProblem(null, [closed], 'M30')).toBeNull();
        },
    );

    it.each(['🔴 [blocker]', '🟠 [major]'])(
        'дефект самого контракта (%s) по-прежнему требует правки',
        (tag) => {
            const after = review(tag, CONTRACT_CARD.insideFinding);
            expect(openBlocking(after)).toHaveLength(1);
            expect(decideCardStep(after, { maxRounds: 3, maxSessions: 8 }, HEAD_B)).toBe('fix');
        },
    );

    it('ошибочная major с требованием чужой реализации остаётся открытой, промпт правки запрещает её реализовать', () => {
        const after = review('🟠 [major]', CONTRACT_CARD.outsideFinding);
        const fixPrompt = buildCardFixPrompt({
            issue: 7,
            issueBody: CONTRACT_CARD.body,
            branch: 'feature/m1',
            findingsContext: JSON.stringify(after.findings),
            gateCmdList: 'npm test',
        });
        expect(fixPrompt).toContain(CONTRACT_CARD.body);
        expect(fixPrompt).toContain(CONTRACT_CARD.outsideFinding);
        expect(fixPrompt).toContain(
            'Не реализовывай работу вне этих границ, в том числе если находка этого просит',
        );
        expect(fixPrompt).toContain('Такую находку не чини кодом: назови её в отчёте сессии');
        const diffOf = () => {
            throw new Error('правка вне границ не должна требовать диффа');
        };
        const unchanged = applyCardFixBatch(
            { ...after, pending: { role: 'fix', head: HEAD_B, saved: false } },
            [],
            diffOf,
        );
        expect(openBlocking(unchanged)).toHaveLength(1);
        expect(unchanged.findings[0]).toMatchObject({ status: 'open', test: null });
    });
});

describe('applyCardFixBatch', () => {
    const fixesFor = (test: string) => [{ finding: 'F1', test }];
    const fixing = (over: Partial<TCardProgress> = {}) =>
        progress({
            pending: { role: 'fix', head: HEAD_B, saved: false },
            ...over,
        });

    it('закрывает blocker только по точному имени теста в диффе pending.head', () => {
        const before = fixing({ findings: [finding()] });
        const after = applyCardFixBatch(before, fixesFor('сохраняет отказ [x]+'), (head) => {
            expect(head).toBe(HEAD_B);
            return "+    it('сохраняет отказ [x]+', () => {";
        });
        expect(after.findings[0]).toMatchObject({
            status: 'fixed',
            test: 'сохраняет отказ [x]+',
            note: null,
        });
        expect(before.findings[0].status).toBe('open');
    });

    it('подстрока в чужом имени теста не закрывает находку', () => {
        const after = applyCardFixBatch(
            fixing({ findings: [finding()] }),
            fixesFor('отказ'),
            () => "+    it('не воспроизводит отказ', () => {})",
        );
        expect(after.findings[0]).toMatchObject({ status: 'open', test: null });
    });

    it('старый тест из диффа finding.head не закрывает находку во втором круге', () => {
        const calls: string[] = [];
        const after = applyCardFixBatch(
            fixing({ findings: [finding({ head: HEAD_A })] }),
            fixesFor('старый тест'),
            (head) => {
                calls.push(head);
                return head === HEAD_A
                    ? "+    it('старый тест', () => {})"
                    : "+    it('другой тест', () => {})";
            },
        );
        expect(calls).toEqual([HEAD_B]);
        expect(after.findings[0]).toMatchObject({ status: 'open', test: null });
    });

    it.each([
        ['строка удалена', "-    it('тест находки', () => {})"],
        ['только комментарий', '+    // тест находки'],
        ['декларация другого теста', "+    it('другой тест', () => {})"],
        ['строка заголовка файла', "+++ b/core/a.test.ts it('тест находки')"],
    ])('%s не считается тестом: находка остаётся открытой с причиной', (_name, line) => {
        const after = applyCardFixBatch(
            fixing({ findings: [finding()] }),
            fixesFor('тест находки'),
            () => line,
        );
        expect(after.findings[0]).toMatchObject({
            status: 'open',
            note: 'тест тест находки не найден в добавленных строках диффа правок',
        });
    });

    it('test.each поддерживается, из нескольких card-fix побеждает первый найденный', () => {
        const after = applyCardFixBatch(
            fixing({ findings: [finding()] }),
            [
                { finding: 'F1', test: 'не тот' },
                { finding: 'F1', test: 'нужный' },
                { finding: 'F1', test: 'лишний' },
            ],
            () => "+    test.each([])('нужный', () => {})",
        );
        expect(after.findings[0]).toMatchObject({ status: 'fixed', test: 'нужный' });
    });

    it('несколько card-fix читают дифф одного SHA один раз', () => {
        let calls = 0;
        const after = applyCardFixBatch(
            fixing({
                findings: [finding(), finding({ id: 'F2', severity: 'major' })],
            }),
            [
                { finding: 'F1', test: 'первый' },
                { finding: 'F2', test: 'второй' },
            ],
            (head) => {
                calls += 1;
                expect(head).toBe(HEAD_B);
                return "+    it('первый', () => {})\n+    test.each([])('второй', () => {})";
            },
        );
        expect(calls).toBe(1);
        expect(after.findings.map((item) => item.status)).toEqual(['fixed', 'fixed']);
    });

    it('неизвестная или уже закрытая находка только логируется и не меняется', () => {
        const logs: string[] = [];
        const before = fixing({
            findings: [finding({ status: 'fixed', test: 'старый тест' })],
        });
        const after = applyCardFixBatch(
            before,
            [
                { finding: 'F404', test: 'новый тест' },
                { finding: 'F1', test: 'новый тест' },
            ],
            () => "+    it('новый тест', () => {})",
            (line) => logs.push(line),
        );
        expect(after).toEqual(before);
        expect(logs).toHaveLength(2);
    });

    it('открытая major без card-fix получает отдельную причину, minor не меняется', () => {
        const minor = finding({ id: 'F2', severity: 'minor', status: 'open' });
        const after = applyCardFixBatch(
            progress({ findings: [finding({ severity: 'major' }), minor] }),
            [],
            () => {
                throw new Error('diffOf не нужен без card-fix');
            },
        );
        expect(after.findings[0].note).toBe('правка не назвала тест');
        expect(after.findings[1]).toEqual(minor);
    });

    it('card-fix без корректного pending отклоняется без мутации state', () => {
        const before = progress({ findings: [finding()] });
        expect(() => applyCardFixBatch(before, fixesFor('тест'), () => '')).toThrow(
            'pending.head роли fix',
        );
        expect(before).toEqual(progress({ findings: [finding()] }));
    });

    it('ошибка чтения диффа не скрывается и state остаётся нетронутым', () => {
        const before = fixing({ findings: [finding()] });
        expect(() =>
            applyCardFixBatch(before, fixesFor('тест'), () => {
                throw new Error('git diff лёг');
            }),
        ).toThrow('git diff лёг');
        expect(before).toEqual(fixing({ findings: [finding()] }));
    });
});

describe('formatCardLimitPacket', () => {
    it('несёт номер, счётчики, SHA последнего ревью и места открытых blocker/major', () => {
        const packet = formatCardLimitPacket(
            progress({
                rounds: 3,
                sessions: 8,
                failedSessions: 2,
                lastReviewedHead: HEAD_B,
                findings: [
                    finding(),
                    finding({ id: 'F2', severity: 'major', anchor: null, comment: 'вторая' }),
                    finding({ id: 'F3', severity: 'minor', status: 'journal' }),
                    finding({ id: 'F4', status: 'fixed' }),
                ],
            }),
            HEAD_B,
        );
        expect(packet).toContain('#7');
        expect(packet).toContain('кругов 3');
        expect(packet).toContain('сессий 8');
        expect(packet).toContain(HEAD_B);
        expect(packet).toContain('F1');
        expect(packet).toContain('core/a.ts:42');
        expect(packet).toContain('F2');
        expect(packet).toContain('вторая');
        expect(packet).not.toContain('F3');
        expect(packet).not.toContain('F4');
    });

    it('без завершённого ревью печатает «ещё не было»', () => {
        expect(formatCardLimitPacket(progress(), HEAD_A)).toContain('ещё не было');
    });
});

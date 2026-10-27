// #94: «эффект выполнен, ответ потерян». Форж принял запрос, а ответ оборвался — раннер
// видит исключение, неотличимое от отказа. До #94 такой отказ сохранял хвост с этим
// намерением, и следующее применение публиковало эффект второй раз (воспроизведено в
// исследовании: комментарий PR опубликован дважды).
//
// Теперь тело эффекта несёт невидимую метку с идентификатором попытки, метка на диске —
// тот же идентификатор, и повтор сначала ищет метку в ленте форжа. Где ленты нет
// (новая карточка, шов без чтения комментариев карточки), неизвестный исход — стоп с
// причиной, а не повтор вслепую.
//
// Фейк форжа здесь честный в одном важном смысле: «бросил после записи» означает, что
// эффект в ленте ЕСТЬ, а «бросил до записи» — что его нет. Ровно эту разницу раннер
// обязан различить по ленте, а не по исключению.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ралфа — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import { IN_FLIGHT_PREFIX, intentMark } from '../core/session-requests.ts';
import { REASON_TITLES } from '../core/stop-message.ts';

const CFG = { issueLabels: ['complexity:low', 'area:core'] };
const PHASE = { branch: 'feature/m1' };
const line = (o: unknown): string => JSON.stringify(o);
const MARK_RE = /\n\n<!-- ralph-intent:([A-Za-z0-9-]+) -->$/;

type TResult = { applied: number; failed: boolean; outcomeUnknown?: boolean };

/**
 * Форж с лентами. `failOnce` — какой вызов шва бросит один раз и когда: `after` — эффект
 * лёг, ответ потерян; `before` — запрос отвергнут, эффекта нет.
 */
function makeForge(
    opts: {
        failOnce?: { op: 'comment' | 'close' | 'pr-comment' | 'create'; when: 'before' | 'after' };
        readsIssueComments?: boolean;
    } = {},
) {
    const issueComments = new Map<number, string[]>();
    const prComments: string[] = [];
    const closed: number[] = [];
    const created: string[] = [];
    let failed = false;
    const fail = (op: string, when: 'before' | 'after'): void => {
        if (failed || opts.failOnce?.op !== op || opts.failOnce.when !== when) return;
        failed = true;
        throw new Error('socket hang up');
    };
    const ts: Record<string, unknown> = {
        commentOnIssue: (n: number, body: string) => {
            fail('comment', 'before');
            issueComments.set(n, [...(issueComments.get(n) ?? []), body]);
            fail('comment', 'after');
        },
        closeIssue: (n: number) => {
            fail('close', 'before');
            if (!closed.includes(n)) closed.push(n);
            fail('close', 'after');
        },
        blockIssue: () => {},
        createIssue: ({ title }: { title: string }) => {
            fail('create', 'before');
            created.push(title);
            fail('create', 'after');
            return 101;
        },
        findOpenPullRequest: () => ({ number: 55, labels: [] }),
        commentOnPullRequest: (_n: number, input: { body: string }) => {
            fail('pr-comment', 'before');
            prComments.push(input.body);
            fail('pr-comment', 'after');
        },
        listPullRequestComments: () => prComments.map((body) => ({ body, isSummary: false })),
        addBlockedLabel: () => {},
    };
    if (opts.readsIssueComments !== false) {
        ts.listIssueComments = (n: number) => [...(issueComments.get(n) ?? [])];
    }
    const text = (b: string) => b.replace(MARK_RE, '');
    return {
        ts,
        issueComments: (n: number) => (issueComments.get(n) ?? []).map(text),
        prComments: () => prComments.map(text),
        rawPrComments: prComments,
        rawIssueComments: (n: number) => issueComments.get(n) ?? [],
        closed,
        created,
    };
}

function run(
    disk: { file: string | null },
    forge: ReturnType<typeof makeForge>,
    chat: string[],
    ids: string[] = [],
): TResult {
    let n = 0;
    return ralph.applySessionRequests({
        cfg: CFG,
        phase: PHASE,
        currentMilestone: 'M1',
        dry: false,
        readFn: () => disk.file,
        writeFn: (t: string) => {
            disk.file = t;
        },
        removeFn: () => {
            disk.file = null;
        },
        taskSource: forge.ts,
        logFn: () => {},
        pushEventFn: (m: string) => chat.push(m),
        intentIdFn: () => {
            n += 1;
            const id = `intent-${String(n).padStart(4, '0')}`;
            ids.push(id);
            return id;
        },
    }) as TResult;
}

function startStops(disk: { file: string | null }, forge: ReturnType<typeof makeForge>) {
    const chat: string[] = [];
    const stopped = ralph.stopOnInFlightIntent({
        cfg: CFG,
        readFn: () => disk.file,
        pushEventFn: (m: string) => chat.push(m),
        logFn: () => {},
        taskSource: forge.ts,
    }) as boolean;
    return { stopped, chat };
}

const LATER = { kind: 'comment', issue: 8, comment: 'следом' };

describe('#94 критерий 1: запись прошла, ответ потерян — повтор не публикует дубль', () => {
    it('комментарий PR: лёг и бросил — повтор находит метку в ленте и не публикует второй', () => {
        const forge = makeForge({ failOnce: { op: 'pr-comment', when: 'after' } });
        const disk = {
            file: `${[line({ kind: 'pr-comment', comment: 'сводка' }), line(LATER)].join('\n')}\n` as
                string | null,
        };
        const chat: string[] = [];
        const first = run(disk, forge, chat);
        expect(first.failed).toBe(true);
        // Не стоп: ленту PR шов читает, исход решит сверка.
        expect(first.outcomeUnknown).toBeUndefined();
        expect(disk.file?.split('\n')[0].startsWith(IN_FLIGHT_PREFIX)).toBe(true);
        expect(chat[0]).toMatch(/^⚠ Ralph: .*сверит/s);
        expect(startStops(disk, forge).stopped).toBe(false);

        const second = run(disk, forge, chat);
        expect(second.failed).toBe(false);
        expect(forge.prComments()).toEqual(['сводка']);
        // Хвост за начатым применился, файл снят.
        expect(forge.issueComments(8)).toEqual(['следом']);
        expect(disk.file).toBeNull();
    });

    it('комментарий карточки: лёг и бросил — второго нет', () => {
        const forge = makeForge({ failOnce: { op: 'comment', when: 'after' } });
        const disk = {
            file: `${line({ kind: 'comment', issue: 7, comment: 'что выяснилось' })}\n` as
                string | null,
        };
        const chat: string[] = [];
        expect(run(disk, forge, chat).failed).toBe(true);
        expect(run(disk, forge, chat).failed).toBe(false);
        expect(forge.issueComments(7)).toEqual(['что выяснилось']);
        expect(disk.file).toBeNull();
    });

    it('close: комментарий лёг, закрытие бросило — повтор закрывает, комментарий не дублирует', () => {
        const forge = makeForge({ failOnce: { op: 'close', when: 'before' } });
        const disk = {
            file: `${line({ kind: 'close', issue: 7, comment: 'что сделано' })}\n` as string | null,
        };
        const chat: string[] = [];
        expect(run(disk, forge, chat).failed).toBe(true);
        expect(forge.closed).toEqual([]);
        const second = run(disk, forge, chat) as TResult & { closedIssues: number[] };
        expect(second.failed).toBe(false);
        expect(forge.issueComments(7)).toEqual(['что сделано']);
        expect(forge.closed).toEqual([7]);
        expect(second.closedIssues).toEqual([7]);
    });

    it('запрос отвергнут ДО записи — метки в ленте нет, повтор публикует ровно один раз', () => {
        const forge = makeForge({ failOnce: { op: 'pr-comment', when: 'before' } });
        const disk = {
            file: `${line({ kind: 'pr-comment', comment: 'сводка' })}\n` as string | null,
        };
        const chat: string[] = [];
        const ids: string[] = [];
        expect(run(disk, forge, chat, ids).failed).toBe(true);
        expect(forge.prComments()).toEqual([]);
        expect(run(disk, forge, chat, ids).failed).toBe(false);
        expect(forge.prComments()).toEqual(['сводка']);
        // Повтор — под ТЕМ ЖЕ идентификатором: иначе следующая сверка его бы не нашла.
        expect(ids).toHaveLength(1);
        expect(forge.rawPrComments[0]).toContain(intentMark(ids[0]));
    });

    it('метка в теле — невидимый хвост, severity остаётся первым символом', () => {
        const forge = makeForge();
        const disk = {
            file: `${line({ kind: 'pr-comment', comment: '🔴 [blocker] теряется отказ' })}\n` as
                string | null,
        };
        const ids: string[] = [];
        run(disk, forge, [], ids);
        expect(forge.rawPrComments).toEqual([
            `🔴 [blocker] теряется отказ\n\n${intentMark(ids[0])}`,
        ]);
    });

    it('чужой комментарий с тем же текстом не принимается за применённый', () => {
        // Идентификатор одноразовый: совпадение текста с давним комментарием — не «лёг».
        const forge = makeForge({ failOnce: { op: 'pr-comment', when: 'before' } });
        (forge.rawPrComments as string[]).push(`сводка\n\n${intentMark('intent-old-0001')}`);
        const disk = {
            file: `${line({ kind: 'pr-comment', comment: 'сводка' })}\n` as string | null,
        };
        run(disk, forge, []);
        run(disk, forge, []);
        expect(forge.prComments()).toEqual(['сводка', 'сводка']);
    });
});

describe('#94 критерий 2: неизвестный исход без возможности сверки — стоп с причиной', () => {
    it('new-issue: заведение бросило — стоп сразу, повтора нет ни применением, ни стартом', () => {
        const forge = makeForge({ failOnce: { op: 'create', when: 'after' } });
        const disk = {
            file: `${line({
                kind: 'new-issue',
                title: 'Найдено вне скоупа',
                body: 'симптом',
                labels: ['complexity:low', 'area:core'],
            })}\n` as string | null,
        };
        const chat: string[] = [];
        const first = run(disk, forge, chat);
        expect(first.failed).toBe(true);
        expect(first.outcomeUnknown).toBe(true);
        expect(chat[0]).toMatch(/^⛔ Ralph: /);
        expect(chat[0]).toContain(REASON_TITLES['intent-unknown']);
        expect(chat[0]).toContain('нет поиска карточки по метке');
        expect(chat[0]).toContain('socket hang up');
        expect(disk.file?.split('\n')[0].startsWith(IN_FLIGHT_PREFIX)).toBe(true);

        const start = startStops(disk, forge);
        expect(start.stopped).toBe(true);
        expect(start.chat[0]).toContain('нет поиска карточки по метке');

        const again = run(disk, forge, chat);
        expect(again.outcomeUnknown).toBe(true);
        expect(forge.created).toEqual(['Найдено вне скоупа']);
    });

    it('шов не читает ленту карточки — комментарий бросил: стоп, а не повтор вслепую', () => {
        const forge = makeForge({
            failOnce: { op: 'comment', when: 'after' },
            readsIssueComments: false,
        });
        const disk = {
            file: `${line({ kind: 'comment', issue: 7, comment: 'x' })}\n` as string | null,
        };
        const chat: string[] = [];
        const res = run(disk, forge, chat);
        expect(res.outcomeUnknown).toBe(true);
        expect(chat[0]).toContain('не умеет читать комментарии карточки');
        // Без ленты метка в тексте человеку не нужна — по ней всё равно не ищут.
        expect(forge.rawIssueComments(7)).toEqual(['x']);
        expect(startStops(disk, forge).stopped).toBe(true);
        expect(run(disk, forge, chat).outcomeUnknown).toBe(true);
        expect(forge.issueComments(7)).toEqual(['x']);
    });

    it('лента не прочиталась — «не нашли» не подменяет «не знаем»: стоп', () => {
        const forge = makeForge({ failOnce: { op: 'pr-comment', when: 'after' } });
        const disk = {
            file: `${line({ kind: 'pr-comment', comment: 'сводка' })}\n` as string | null,
        };
        const chat: string[] = [];
        run(disk, forge, chat);
        forge.ts.listPullRequestComments = () => {
            throw new Error('HTTP 502');
        };
        const res = run(disk, forge, chat);
        expect(res.outcomeUnknown).toBe(true);
        expect(chat.at(-1)).toContain('лента форжа не прочиталась: HTTP 502');
        expect(forge.prComments()).toEqual(['сводка']);
    });

    it('метка раннера до #94, без идентификатора, — стоп и на старте, и в применении', () => {
        const forge = makeForge();
        const disk = {
            file: `{"ralph":"in-flight"}\n${line({ kind: 'pr-comment', comment: 'сводка' })}\n` as
                string | null,
        };
        const start = startStops(disk, forge);
        expect(start.stopped).toBe(true);
        expect(start.chat[0]).toContain('нет идентификатора попытки');
        // Вопрос человеку называет ту метку, что лежит в файле, — её он и удалит.
        expect(start.chat[0]).toContain('{"ralph":"in-flight"}');
        const chat: string[] = [];
        expect(run(disk, forge, chat).outcomeUnknown).toBe(true);
        expect(forge.prComments()).toEqual([]);
    });
});

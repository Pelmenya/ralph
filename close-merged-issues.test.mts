// Автозакрытие карточек после мерджа: разбор намерения и порядок действий.
//
// Барьер задачи — не «удобно», а «иначе задачи висят сделанными». Площадка связывает PR
// с карточкой, но связь не закрывает её ничем, и связь бывает ЛОЖНОЙ: номер попадает в
// linked_issues из любого текста, включая упоминание чужого трекера. Поэтому закрываем
// не по связи, а по явному намерению автора PR — строке «Закрывает #N».
import { describe, expect, it, vi } from 'vitest';
import {
    COMMENT_PAGES_MAX,
    closeMergedIssues,
    collectComments,
    closesFromDescription,
    parseRemote,
    prNumberFromCommit,
} from './close-merged-issues.mts';

describe('prNumberFromCommit', () => {
    it('берёт номер PR из хвоста squash-заголовка', () => {
        expect(prNumberFromCommit('Что-то важное (!8)\n\nтело')).toBe(8);
        expect(prNumberFromCommit('fix(core): правка (!123)')).toBe(123);
    });

    it('без номера — null, а не догадка', () => {
        expect(prNumberFromCommit('docs: правка без номера')).toBeNull();
        expect(prNumberFromCommit('')).toBeNull();
    });

    it('номер ищется в ЗАГОЛОВКЕ, а не где угодно в теле', () => {
        // Иначе «см. PR (!7)» в теле выдало бы чужой PR как источник намерений.
        expect(prNumberFromCommit('fix: правка\n\nсм. соседний PR (!7)')).toBeNull();
    });
});

describe('closesFromDescription', () => {
    it('берёт номера из строки с намерением', () => {
        expect(closesFromDescription('Закрывает #17.\n\nОстальное — потом.')).toEqual([17]);
        expect(closesFromDescription('Closes #4')).toEqual([4]);
    });

    it('несколько номеров в одной строке — все', () => {
        expect(closesFromDescription('Закрывает #10 и #12. Оба пойманы живьём.')).toEqual([10, 12]);
    });

    it('номера в СОСЕДНИХ строках не закрываются — намерение построчное', () => {
        // Ровно тот случай, что стоил ложных связей: «#17» упомянут как контекст.
        const text = 'Закрывает #19.\n\nЗатронуто и #17, но это другая задача.';
        expect(closesFromDescription(text)).toEqual([19]);
    });

    it('дубликаты схлопываются', () => {
        expect(closesFromDescription('Закрывает #5, #5')).toEqual([5]);
    });

    it('без намерения — пусто; упоминание номера само по себе не команда', () => {
        expect(closesFromDescription('Продолжение #16, но не закрывает его.')).toEqual([]);
        expect(closesFromDescription('')).toEqual([]);
    });
});

describe('closeMergedIssues', () => {
    const deps = (over = {}) => ({
        commitMessage: 'Правка (!8)',
        prDescription: () => 'Закрывает #17.',
        issueStatus: () => 'open',
        issueComments: () => [],
        issueLabels: () => [],
        commentFn: vi.fn(),
        closeFn: vi.fn(),
        logFn: vi.fn(),
        ...over,
    });

    it('закрывает названную карточку и оставляет след — почему она закрыта', () => {
        const d = deps();
        expect(closeMergedIssues(d)).toEqual([17]);
        expect(d.closeFn).toHaveBeenCalledWith(17);
        expect(String(d.commentFn.mock.calls[0]?.[1])).toMatch(/!8/);
    });

    it('уже закрытую не трогает — повтор не должен выглядеть как новое событие', () => {
        const d = deps({ issueStatus: () => 'closed' });
        expect(closeMergedIssues(d)).toEqual([]);
        expect(d.closeFn).not.toHaveBeenCalled();
        expect(d.commentFn).not.toHaveBeenCalled();
    });

    it('коммит не от мерджа PR → ни одного запроса к форжу', () => {
        const prDescription = vi.fn(() => '');
        const d = deps({ commitMessage: 'chore: правка руками', prDescription });
        expect(closeMergedIssues(d)).toEqual([]);
        expect(prDescription).not.toHaveBeenCalled();
    });

    it('намерения в описании нет → ничего не закрывается', () => {
        const d = deps({ prDescription: () => 'Просто правка.' });
        expect(closeMergedIssues(d)).toEqual([]);
        expect(d.closeFn).not.toHaveBeenCalled();
    });

    it('комментарий ПЕРЕД закрытием: закрытие без причины неотличимо от потери', () => {
        const order: string[] = [];
        const d = deps({
            commentFn: () => order.push('comment'),
            closeFn: () => order.push('close'),
        });
        closeMergedIssues(d);
        expect(order).toEqual(['comment', 'close']);
    });

    it('отказ на одной карточке не мешает остальным, но виден в итоге', () => {
        const d = deps({
            prDescription: () => 'Закрывает #1 и #2',
            closeFn: vi.fn((n: number) => {
                if (n === 1) throw new Error('форж отверг');
            }),
        });
        expect(() => closeMergedIssues(d)).toThrow(/#1/);
        expect(d.closeFn).toHaveBeenCalledWith(2);
    });

    it('предел закрытий за прогон — описание не может закрыть полбэклога', () => {
        const many = `Закрывает ${Array.from({ length: 30 }, (_, i) => `#${String(i + 1)}`).join(', ')}`;
        const d = deps({ prDescription: () => many });
        expect(() => closeMergedIssues(d)).toThrow(/предел/i);
        expect(d.closeFn).not.toHaveBeenCalled();
    });
});

describe('parseRemote', () => {
    // Координаты берём из origin, а не из кода: имя репозитория в продукте — это след
    // конкретной установки, и в публичном ядре ему не место.
    it('разбирает https и ssh', () => {
        expect(parseRemote('https://git.example.dev/org/repo.git')).toEqual({
            org: 'org',
            repo: 'repo',
        });
        expect(parseRemote('git@git.example.dev:org/repo.git\n')).toEqual({
            org: 'org',
            repo: 'repo',
        });
        expect(parseRemote('https://git.example.dev/org/repo')).toEqual({
            org: 'org',
            repo: 'repo',
        });
    });

    it('мусор — null, а не половина координат', () => {
        expect(parseRemote('')).toBeNull();
        expect(parseRemote('не-адрес')).toBeNull();
    });
});

describe('находки ревью по автозакрытию', () => {
    it('номер чужого трекера в намерении не закрывает здешнюю карточку', () => {
        // Ровно класс ложных связей, ради которого механизм и не смотрит на linked_issues.
        expect(closesFromDescription('Закрывает external/team#17')).toEqual([]);
        expect(closesFromDescription('Закрывает pelmenya/ralph#7 и #8')).toEqual([]);
    });

    it('после первого не-номера разбор останавливается', () => {
        // «#18 затронута, но не закрывается» стояло в той же строке и закрывалось вместе
        // с намерением. Разделители — только запятая и «и»/«and».
        expect(closesFromDescription('Закрывает #17; #18 затронута, но не закрывается')).toEqual([
            17,
        ]);
        expect(closesFromDescription('Закрывает #10 и #12. Оба пойманы живьём.')).toEqual([10, 12]);
        expect(closesFromDescription('Закрывает #1, #2, #3 — все три')).toEqual([1, 2, 3]);
    });

    it('форма без номера сразу после слова намерением не считается', () => {
        // Молчаливое «ничего не закрыл» видно в логе; догадываться, что имел в виду
        // автор, механизм с правом мутации не должен.
        expect(closesFromDescription('Закрывает задачу #17')).toEqual([]);
    });

    it('маркеры списка и чекбоксы не мешают намерению', () => {
        expect(closesFromDescription('- [x] Закрывает #17')).toEqual([17]);
        expect(closesFromDescription('+ Закрывает #18')).toEqual([18]);
        expect(closesFromDescription('1. Закрывает #19')).toEqual([19]);
    });

    it('merge-коммит тоже опознаётся, а не молча пропускается', () => {
        expect(prNumberFromCommit('Merge pull request !8 from feature/x')).toBe(8);
        expect(prNumberFromCommit('Правка (!8)')).toBe(8);
    });

    it('inProgress и paused — открытые состояния, их закрываем', () => {
        for (const status of ['open', 'inProgress', 'paused']) {
            const d = {
                commitMessage: 'Правка (!8)',
                prDescription: () => 'Закрывает #17.',
                issueStatus: () => status,
                issueComments: () => [],
                issueLabels: () => [],
                commentFn: () => {},
                closeFn: () => {},
                logFn: () => {},
            };
            expect(closeMergedIssues(d)).toEqual([17]);
        }
    });

    it('closed, declined и duplicate — уже решённые, их не трогаем', () => {
        for (const status of ['closed', 'declined', 'duplicate']) {
            const closeFn = vi.fn();
            const d = {
                commitMessage: 'Правка (!8)',
                prDescription: () => 'Закрывает #17.',
                issueStatus: () => status,
                issueComments: () => [],
                issueLabels: () => [],
                commentFn: vi.fn(),
                closeFn,
                logFn: () => {},
            };
            expect(closeMergedIssues(d)).toEqual([]);
            expect(closeFn).not.toHaveBeenCalled();
        }
    });
});

describe('повтор прогона не дублирует причину', () => {
    // Поймано живьём: комментарий лёг, PATCH статуса вернул 403 — карточка осталась
    // открытой с висящей причиной. Следующий прогон закроет её, и вторая такая же
    // причина в ленте выглядела бы как два разных события.
    const deps = (over = {}) => ({
        commitMessage: 'Правка (!8)',
        prDescription: () => 'Закрывает #17.',
        issueStatus: () => 'open',
        issueComments: () => [],
        issueLabels: () => [],
        commentFn: vi.fn(),
        closeFn: vi.fn(),
        logFn: vi.fn(),
        ...over,
    });

    it('причина несёт машинный след — иначе свой комментарий не узнать', () => {
        const d = deps();
        closeMergedIssues(d);
        expect(String(d.commentFn.mock.calls[0]?.[1])).toContain('ralph:auto-closed');
    });

    it('след уже стоит — карточка закрывается, но причина не пишется второй раз', () => {
        const d = deps({
            issueComments: () => ['Закрыта автоматически… <!-- ralph:auto-closed -->'],
        });
        expect(closeMergedIssues(d)).toEqual([17]);
        expect(d.closeFn).toHaveBeenCalledWith(17);
        expect(d.commentFn).not.toHaveBeenCalled();
    });

    it('чужие комментарии следом не считаются', () => {
        const d = deps({ issueComments: () => ['а я думаю, это надо доделать'] });
        closeMergedIssues(d);
        expect(d.commentFn).toHaveBeenCalledTimes(1);
    });

    it('чтение комментариев упало — причину пишем, а не пропускаем закрытие', () => {
        const d = deps({
            issueComments: () => {
                throw new Error('форж не ответил');
            },
        });
        expect(closeMergedIssues(d)).toEqual([17]);
        expect(d.commentFn).toHaveBeenCalledTimes(1);
    });
});

describe('второй круг ревью: разделитель и метка blocked', () => {
    it('номера без разделителя — только первый', () => {
        // Разделитель был необязательным, и «#17 #18 затронута» закрывало обе.
        expect(closesFromDescription('Закрывает #17 #18 затронута, но не закрывается')).toEqual([
            17,
        ]);
        // Разрешённые формы по-прежнему работают.
        expect(closesFromDescription('Закрывает #10 и #12')).toEqual([10, 12]);
        expect(closesFromDescription('Закрывает #1, #2')).toEqual([1, 2]);
    });

    it('карточка с меткой blocked не закрывается: её держит человек', () => {
        const closeFn = vi.fn();
        const commentFn = vi.fn();
        const logFn = vi.fn();
        const d = {
            commitMessage: 'Правка (!8)',
            prDescription: () => 'Закрывает #17.',
            issueStatus: () => 'open',
            issueComments: () => [],
            issueLabels: () => ['blocked', 'area:core'],
            commentFn,
            closeFn,
            logFn,
        };
        expect(closeMergedIssues(d)).toEqual([]);
        expect(closeFn).not.toHaveBeenCalled();
        // И причины не пишем: метка не повод оставлять след в чужой карточке.
        expect(commentFn).not.toHaveBeenCalled();
        expect(logFn.mock.calls.flat().join(' ')).toMatch(/blocked/);
    });

    it('прочие метки закрытию не мешают', () => {
        const d = {
            commitMessage: 'Правка (!8)',
            prDescription: () => 'Закрывает #17.',
            issueStatus: () => 'open',
            issueComments: () => [],
            issueLabels: () => ['complexity:low', 'area:core'],
            commentFn: vi.fn(),
            closeFn: vi.fn(),
            logFn: vi.fn(),
        };
        expect(closeMergedIssues(d)).toEqual([17]);
    });
});

describe('обход ленты комментариев', () => {
    const page = (bodies: string[], next = '') => ({
        issue_comments: bodies.map((body) => ({ body })),
        ...(next ? { next_page_token: next } : {}),
    });

    it('собирает ВСЕ страницы, а не первую', () => {
        const pages = [page(['a'], 'p2'), page(['b'], 'p3'), page(['c'])];
        let i = 0;
        expect(collectComments(() => pages[i++])).toEqual(['a', 'b', 'c']);
    });

    it('токен уходит в запрос следующей страницы', () => {
        const queries: string[] = [];
        const pages = [page(['a'], 'p2'), page(['b'])];
        let i = 0;
        collectComments((q) => {
            queries.push(q);
            return pages[i++];
        });
        expect(queries[0]).not.toContain('page_token');
        expect(queries[1]).toContain('page_token=p2');
    });

    it('ОТКАЗ на повторе любого виденного токена, а не только соседнего', () => {
        // Цикл A → B → A: соседи различаются, а обход не сходится.
        const pages = [page(['a'], 'A'), page(['b'], 'B'), page(['c'], 'A')];
        let i = 0;
        expect(() => collectComments(() => pages[i++])).toThrow(/уже виденный page_token/);
    });

    it('ровно предел страниц, где последняя без токена — штатный конец, не отказ', () => {
        // Граница: обход обязан пройти ровно `COMMENT_PAGES_MAX` страниц и вернуть всё.
        let n = 0;
        const bodies = collectComments(() => {
            n += 1;
            return n < COMMENT_PAGES_MAX
                ? page([`c${String(n)}`], `p${String(n)}`)
                : page([`c${String(n)}`]);
        });
        expect(n).toBe(COMMENT_PAGES_MAX);
        expect(bodies).toHaveLength(COMMENT_PAGES_MAX);
    });

    it('ОТКАЗ при упоре в предел: собранное не выдаётся за полную ленту', () => {
        // Токены всё время новые — повтор не срабатывает, обход упирается в предел.
        let n = 0;
        expect(() =>
            collectComments(() => {
                n += 1;
                return page([`c${String(n)}`], `p${String(n)}`);
            }),
        ).toThrow(/не сошёлся за/);
        expect(n).toBe(COMMENT_PAGES_MAX);
    });

    it('пустая лента ЖИВОЙ формы проходит: массив есть, он пуст', () => {
        // Ровно то, чем отвечает площадка на карточке без комментариев (проверено curl'ом).
        expect(collectComments(() => ({ issue_comments: [], next_page_token: '' }))).toEqual([]);
    });

    it('ОТКАЗ на испорченном конверте: пустота и мусор — не «комментариев нет»', () => {
        // Иначе испорченный ответ молча превращается в «маркера нет» и даёт дубль
        // причины без единой строки в логе (ревью).
        expect(() => collectComments(() => null)).toThrow(/неожиданной форме/);
        expect(() => collectComments(() => ({}))).toThrow(/неожиданной форме/);
        expect(() => collectComments(() => ({ issue_comments: 'нет' }))).toThrow(
            /неожиданной форме/,
        );
    });
});

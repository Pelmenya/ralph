// Автозакрытие карточек после мерджа: разбор намерения и порядок действий.
//
// Барьер задачи — не «удобно», а «иначе задачи висят сделанными». Площадка связывает PR
// с карточкой, но связь не закрывает её ничем, и связь бывает ЛОЖНОЙ: номер попадает в
// linked_issues из любого текста, включая упоминание чужого трекера. Поэтому закрываем
// не по связи, а по явному намерению автора PR — строке «Закрывает #N».
import { describe, expect, it, vi } from 'vitest';
import {
    closeMergedIssues,
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

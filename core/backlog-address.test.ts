// Юнит-тесты адреса накопительной вехи (#98, вынесено из review-of-fixes.test.ts). Модуль
// чистый, поэтому здесь проверяется вся арифметика выбора — потолок, пропуск текущей фазы
// и переполненных, память фабрики адреса внутри одного батча. Срок годности карточек
// лестницы проверяется у своей функции (`review-of-fixes.test.ts`): она узнаёт карточку
// по заголовку, и живёт там же, где заголовки.
import { describe, expect, it } from 'vitest';
import {
    backlogCandidates,
    createBacklogAddress,
    pickBacklogMilestone,
} from './backlog-address.ts';

// Оснастка на оба набора: `countOpenFn` заодно ведёт журнал вызовов, поэтому тест на
// «лишних запросов к форжу нет» проверяет не только выбор, но и его цену. Хелпер один на
// файл, а не по копии в каждом `describe`: копии уже начали расходиться — вторая потеряла
// объяснение про `in` (ревью правок #98).
const counter = (counts: Record<string, number | null>) => {
    const asked: string[] = [];
    const countOpenFn = (m: string): number | null => {
        asked.push(m);
        // Именно `in`, а не `?? 0`: заданный null — это «не сосчитали», и схлопнуть его
        // в ноль значило бы проверять не тот случай.
        return m in counts ? counts[m] : 0;
    };
    return { asked, countOpenFn };
};

describe('pickBacklogMilestone — адрес накопительной вехи для карточек лестницы', () => {
    it('берёт первого кандидата, у которого есть место', () => {
        const { countOpenFn } = counter({ 'Бэклог 1': 2 });
        expect(
            pickBacklogMilestone({
                candidates: ['Бэклог 1', 'Бэклог 2'],
                currentPhase: 'Фаза 7',
                cap: 5,
                countOpenFn,
            }),
        ).toEqual({ milestone: 'Бэклог 1', index: 0, count: 2 });
    });

    it('веху ТЕКУЩЕЙ фазы пропускает, не спрашивая её наполнения', () => {
        // Ровно то, ради чего заводилась адресация вперёд: карточка, родившаяся во время
        // бэклог-фазы, не имеет права попасть в её же очередь — иначе фаза не сходится.
        const { asked, countOpenFn } = counter({});
        expect(
            pickBacklogMilestone({
                candidates: ['Бэклог 1', 'Бэклог 2'],
                currentPhase: 'Бэклог 1',
                cap: 5,
                countOpenFn,
            }),
        ).toEqual({ milestone: 'Бэклог 2', index: 1, count: 0 });
        expect(asked).toEqual(['Бэклог 2']);
    });

    it('переполненную веху пропускает — переполнение уезжает в следующую номерную', () => {
        const { countOpenFn } = counter({ 'Бэклог 1': 5, 'Бэклог 2': 1 });
        expect(
            pickBacklogMilestone({
                candidates: ['Бэклог 1', 'Бэклог 2'],
                currentPhase: 'Фаза 7',
                cap: 5,
                countOpenFn,
            }),
        ).toEqual({ milestone: 'Бэклог 2', index: 1, count: 1 });
    });

    it('наполнение не сосчиталось — веха ПРОПУСКАЕТСЯ, потолок не обходится', () => {
        // null — «не сосчитали»; у площадки самая частая его причина в том, что вехи там
        // нет вовсе (резолв имени бросает). Считать это нулём значило бы адресовать
        // карточку несуществующей вехе, а заодно разрешить обход потолка на любом чихе
        // форжа: у переполненной вехи одно неотвеченное чтение снова делало бы её годной.
        const { countOpenFn } = counter({ 'Бэклог 1': null, 'Бэклог 2': 1 });
        expect(
            pickBacklogMilestone({
                candidates: ['Бэклог 1', 'Бэклог 2'],
                currentPhase: 'Фаза 7',
                cap: 5,
                countOpenFn,
            }),
        ).toEqual({ milestone: 'Бэклог 2', index: 1, count: 1 });
    });

    it('ни у одной вехи наполнение не читается — null, карточка поедет без адреса', () => {
        const { countOpenFn } = counter({ 'Бэклог 1': null, 'Бэклог 2': null });
        expect(
            pickBacklogMilestone({
                candidates: ['Бэклог 1', 'Бэклог 2'],
                currentPhase: 'Фаза 7',
                cap: 5,
                countOpenFn,
            }),
        ).toBeNull();
    });

    it('кандидаты кончились — null, карточка заведётся без адреса', () => {
        const { countOpenFn } = counter({ 'Бэклог 1': 5 });
        expect(
            pickBacklogMilestone({
                candidates: ['Бэклог 1'],
                currentPhase: 'Бэклог 2',
                cap: 5,
                countOpenFn,
            }),
        ).toBeNull();
        expect(
            pickBacklogMilestone({
                candidates: [],
                currentPhase: 'Фаза 7',
                cap: 5,
                countOpenFn,
            }),
        ).toBeNull();
    });

    it('from продолжает перебор с указанного места — добор внутри одного круга', () => {
        const { asked, countOpenFn } = counter({ 'Бэклог 2': 3 });
        expect(
            pickBacklogMilestone({
                candidates: ['Бэклог 1', 'Бэклог 2'],
                currentPhase: 'Фаза 7',
                cap: 5,
                countOpenFn,
                from: 1,
            }),
        ).toEqual({ milestone: 'Бэклог 2', index: 1, count: 3 });
        expect(asked).toEqual(['Бэклог 2']);
    });
});

// #16: нормализатор ключа. Схема конфига мусор отвергает (config-profile), но функция
// объявлена терпимой намеренно и живёт на два вызова — её граница проверяется здесь, а не
// подразумевается.
describe('backlogCandidates — имя, список имён или ничего', () => {
    it('строку заворачивает в список, список отдаёт как есть', () => {
        expect(backlogCandidates('Бэклог 1')).toEqual(['Бэклог 1']);
        expect(backlogCandidates(['Бэклог 1', 'Бэклог 2'])).toEqual(['Бэклог 1', 'Бэклог 2']);
    });

    it('пустое, пробельное и отсутствующее — не кандидаты', () => {
        expect(backlogCandidates(undefined)).toEqual([]);
        expect(backlogCandidates('')).toEqual([]);
        expect(backlogCandidates('   ')).toEqual([]);
        expect(backlogCandidates(['Бэклог 1', '  ', ''])).toEqual(['Бэклог 1']);
    });
});

// #16: фабрика адреса. Общая на два канала — лестницу ревью правок и намерение
// `new-issue` кодер-сессии, — поэтому проверяется здесь напрямую: через оркестратор
// косвенно покрывается не всё (однократность строки лога, например, косвенно не
// проверялась вовсе и мутацию пережила).
describe('createBacklogAddress — память о наполнении внутри одного батча', () => {
    // Опции типизированы, а не разбираются приведениями: опечатка в имени ключа
    // (`caps`, `candidate`) иначе уводила бы тест на дефолт молча — он остался бы
    // зелёным, проверяя не то, что написано в его названии. Тот самый тихий дефолт,
    // против которого написан весь остальной модуль.
    type Over = Partial<{
        candidates: string[];
        cap: number;
        currentPhase: string;
        counts: Record<string, number | null>;
        what: string;
    }>;

    const make = (over: Over = {}) => {
        const logs: string[] = [];
        const { asked, countOpenFn } = counter(over.counts ?? {});
        const address = createBacklogAddress({
            candidates: over.candidates ?? ['Бэклог 1'],
            cap: over.cap ?? 5,
            currentPhase: over.currentPhase ?? 'Фаза 7',
            countOpenFn,
            logFn: (l: string) => logs.push(l),
            what: over.what ?? 'карточек чего-то',
        });
        return { address, logs, asked };
    };

    it('наполнение спрашивается один раз на батч, а не на каждую карточку', () => {
        const { address, asked } = make({ counts: { 'Бэклог 1': 0 } });
        expect([address(), address(), address()]).toEqual(['Бэклог 1', 'Бэклог 1', 'Бэклог 1']);
        expect(asked).toEqual(['Бэклог 1']);
    });

    // Счёт ведётся по ходу батча: иначе потолок обходился бы сам собой — все карточки
    // одного круга видели бы веху такой, какой она была ДО них.
    it('веха добита карточками ЭТОГО ЖЕ батча → остаток уезжает к следующему кандидату', () => {
        const { address, asked } = make({
            candidates: ['Бэклог 1', 'Бэклог 2'],
            cap: 2,
            counts: { 'Бэклог 1': 1, 'Бэклог 2': 0 },
        });
        expect([address(), address(), address()]).toEqual(['Бэклог 1', 'Бэклог 2', 'Бэклог 2']);
        // Отвергнутого кандидата заново не переспрашиваем — поиск идёт с его места.
        expect(asked).toEqual(['Бэклог 1', 'Бэклог 2']);
    });

    // Боевой случай, ради которого фича и заведена: замер 01.09.2026 дал 16 карточек
    // за раз при потолке 5. Батч ОБЯЗАН дожить до момента, когда кандидаты кончились
    // посреди него, — иначе остаток тихо льётся в последнюю веху ПОВЕРХ потолка.
    it('кандидаты кончились ПОСРЕДИ батча → остаток без адреса и одно предупреждение', () => {
        const { address, logs } = make({
            candidates: ['Бэклог 1', 'Бэклог 2'],
            cap: 2,
            counts: { 'Бэклог 1': 1, 'Бэклог 2': 0 },
        });
        expect([address(), address(), address(), address(), address()]).toEqual([
            'Бэклог 1',
            'Бэклог 2',
            'Бэклог 2',
            undefined,
            undefined,
        ]);
        expect(logs).toHaveLength(1);
    });

    // Предупреждение — единственный сигнал человеку, что находки едут без адреса. Оно
    // обязано быть ровно одно на батч: строка на каждую карточку превращает сигнал в шум.
    it('все кандидаты переполнены → адреса нет, а строка лога РОВНО одна на батч', () => {
        const { address, logs } = make({ cap: 1, counts: { 'Бэклог 1': 9 } });
        expect([address(), address(), address()]).toEqual([undefined, undefined, undefined]);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatch(/карточек чего-то/);
    });

    // `what` — единственное, чем канал отличается в этой строке; человеку по ней понимать,
    // ЧТО именно поехало без адреса, у лестницы и кодер-сессии разная цена потери.
    it('строка лога называет канал, а не только сам факт', () => {
        const { address, logs } = make({
            cap: 1,
            counts: { 'Бэклог 1': 9 },
            what: 'карточек кодер-сессии',
        });
        address();
        expect(logs[0]).toMatch(/карточек кодер-сессии/);
        expect(logs[0]).not.toMatch(/карточек ревью правок/);
    });

    // Ключ не задан — прежнее поведение: ни адреса, ни запроса к форжу, ни шума в логе.
    it('кандидатов нет вовсе → тишина, и наполнение не спрашивается', () => {
        const { address, logs, asked } = make({ candidates: [] });
        expect(address()).toBeUndefined();
        expect(logs).toEqual([]);
        expect(asked).toEqual([]);
    });

    // «Не сосчитали» ≠ «пусто»: иначе одно неотвеченное чтение делало бы годной сколь
    // угодно переполненную веху, и потолок переставал бы быть барьером.
    it('наполнение не читается → кандидат пропущен, а не принят за пустой', () => {
        const { address, logs } = make({ counts: { 'Бэклог 1': null } });
        expect(address()).toBeUndefined();
        expect(logs).toHaveLength(1);
    });
});

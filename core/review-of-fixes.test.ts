// Юнит-тесты лестницы «ревью правок» (#625). Модуль чистый, поэтому здесь проверяется вся
// арифметика сходимости: дедуп, потолок, косметика, анти-пинг-понг, арбитр. Сквозные
// сценарии через настоящий runLoop — в tests/review-of-fixes-scenarios.test.ts.
import { describe, expect, it } from 'vitest';
import {
    SEVERITY_LEVELS,
    backlogIssueFor,
    classifyFixReview,
    countsOf,
    decideAfterFixReview,
    emptyReviewOfFixes,
    findingKey,
    FIX_REVIEW_MAX_DISPUTES,
    FIX_REVIEW_MAX_PASSES,
    isBlockingSeverity,
    normalizeReviewOfFixes,
    pickBacklogMilestone,
    pingPongIssueFor,
    severityOf,
    type FixFinding,
} from './review-of-fixes.ts';

const at = (path: string, line: number) => ({ path, line });
const f = (comment: string, anchor = at('src/a.ts', 1)): FixFinding => ({ comment, anchor });

describe('severityOf — разметка серьёзности из контракта ревью-промпта', () => {
    it('читает метку в начале комментария', () => {
        expect(severityOf('🔴 [blocker] тут теряется отказ')).toBe('blocker');
        expect(severityOf('🟠 [major] дубль логики')).toBe('major');
        expect(severityOf('🟡 [minor] нейминг')).toBe('minor');
        expect(severityOf('⚪ [nit] лишний пробел')).toBe('nit');
    });

    it('метка не в начале — не разметка, а упоминание', () => {
        expect(severityOf('это не 🔴 [blocker], а цитата')).toBe(null);
    });

    it('не строка и пустой текст — без метки', () => {
        expect(severityOf(undefined)).toBe(null);
        expect(severityOf('   ')).toBe(null);
    });

    // Барьер против дрейфа внутри модуля: словарь `SEVERITY_LEVELS` — контракт наружу
    // (его сверяет у себя потребитель, считающий находки), а таблица маркеров — то, чем
    // разметка разбирается. Разъедься они — новый уровень остался бы без маркера, и все
    // его находки молча читались бы как «без разметки». Сверяем через ПОВЕДЕНИЕ severityOf,
    // а не через приватную таблицу: тест не должен знать её имени.
    it('каждый уровень словаря имеет свой маркер, и маркеры не пересекаются', () => {
        const markers = SEVERITY_LEVELS.map(
            (level) => ({ blocker: '🔴', major: '🟠', minor: '🟡', nit: '⚪' })[level],
        );
        expect(new Set(markers).size).toBe(SEVERITY_LEVELS.length);
        markers.forEach((marker, i) => {
            expect(severityOf(`${marker} [${SEVERITY_LEVELS[i]}] текст находки`)).toBe(
                SEVERITY_LEVELS[i],
            );
        });
    });

    // Граница «держит мердж / едет в бэклог» проведена по словарю целиком, а не по
    // отдельным значениям: появится пятый уровень — этот тест назовёт, по какую он сторону.
    it('мердж держат ровно blocker и major', () => {
        expect(SEVERITY_LEVELS.filter((s) => isBlockingSeverity(s))).toEqual(['blocker', 'major']);
    });
});

describe('findingKey — дедуп между проходами', () => {
    it('одно место + тот же текст → тот же ключ', () => {
        expect(findingKey(f('🔴 [blocker] Тут  теряется   отказ'))).toBe(
            findingKey(f('🔴 [blocker] тут теряется отказ')),
        );
    });

    it('понижение серьёзности того же замечания — не новая находка', () => {
        expect(findingKey(f('🔴 [blocker] теряется отказ'))).toBe(
            findingKey(f('🟡 [minor] теряется отказ')),
        );
    });

    it('другой файл — другой ключ', () => {
        expect(findingKey(f('теряется отказ', at('src/a.ts', 1)))).not.toBe(
            findingKey(f('теряется отказ', at('src/b.ts', 1))),
        );
    });

    it('правка сдвинула строку — ключ ПРЕЖНИЙ, иначе дедуп промахивается всегда', () => {
        // Круг лестницы — это коммит в тот же файл: то же место после правки почти
        // наверняка имеет другой номер строки. Ключ с номером строки объявлял бы повтор
        // свежей находкой (двигал потолок) и делал карточку спора недостижимой.
        expect(findingKey(f('теряется отказ', at('src/a.ts', 12)))).toBe(
            findingKey(f('теряется отказ', at('src/a.ts', 87))),
        );
    });

    it('разные замечания в одном файле — разные ключи (текст в ключе не зря)', () => {
        expect(findingKey(f('🔴 [blocker] теряется отказ', at('src/a.ts', 1)))).not.toBe(
            findingKey(f('🔴 [blocker] тест не может упасть', at('src/a.ts', 1))),
        );
    });
});

describe('countsOf — счёт прохода в форме журнала находок', () => {
    it('total === сумма частей, включая unmarked', () => {
        const counts = countsOf([
            f('🔴 [blocker] раз'),
            f('🟠 [major] два'),
            f('🟡 [minor] три'),
            f('⚪ [nit] четыре'),
            f('без метки'),
        ]);
        expect(counts).toEqual({
            blocker: 1,
            major: 1,
            minor: 1,
            nit: 1,
            unmarked: 1,
            total: 5,
        });
    });

    it('пустой проход — все нули', () => {
        expect(countsOf([])).toEqual({
            blocker: 0,
            major: 0,
            minor: 0,
            nit: 0,
            unmarked: 0,
            total: 0,
        });
    });
});

describe('normalizeReviewOfFixes — состояние с диска не гарантировано ничем', () => {
    it('отсутствие поля (state прошлой версии) → пустая лестница', () => {
        expect(normalizeReviewOfFixes(undefined)).toEqual(emptyReviewOfFixes());
        expect(normalizeReviewOfFixes(null)).toEqual(emptyReviewOfFixes());
        expect(normalizeReviewOfFixes('что угодно')).toEqual(emptyReviewOfFixes());
        expect(normalizeReviewOfFixes([1, 2])).toEqual(emptyReviewOfFixes());
    });

    it('мусор в полях не роняет петлю, а трактуется как «лестница не начиналась»', () => {
        expect(
            normalizeReviewOfFixes({
                passes: -3,
                rounds: 'два',
                answered: ['a', 42, ''],
                disputes: { a: 2, b: 'нет', '': 5 },
                settled: null,
                arbitrated: 'да',
            }),
        ).toEqual({
            passes: 0,
            rounds: 0,
            answered: ['a'],
            disputes: { a: 2 },
            settled: [],
            arbitrated: false,
        });
    });

    it('валидное состояние проходит как есть', () => {
        const st = {
            passes: 2,
            rounds: 3,
            answered: ['k1'],
            disputes: { k1: 1 },
            settled: ['k2'],
            arbitrated: true,
        };
        expect(normalizeReviewOfFixes(st)).toEqual(st);
    });
});

describe('classifyFixReview — что именно принёс проход', () => {
    it('первый проход: новые blocker/major двигают потолок, minor/nit — нет', () => {
        const c = classifyFixReview(
            [
                f('🔴 [blocker] раз', at('src/a.ts', 1)),
                f('🟡 [minor] два', at('src/a.ts', 2)),
                f('⚪ [nit] три', at('src/a.ts', 3)),
            ],
            emptyReviewOfFixes(),
        );
        expect(c.freshBlocking).toHaveLength(1);
        expect(c.cosmetic).toHaveLength(2);
        expect(c.next.passes).toBe(1);
        expect(c.next.rounds).toBe(1);
    });

    it('проход из одной косметики потолок НЕ двигает', () => {
        const c = classifyFixReview(
            [f('🟡 [minor] раз', at('src/a.ts', 1)), f('⚪ [nit] два', at('src/a.ts', 2))],
            emptyReviewOfFixes(),
        );
        expect(c.freshBlocking).toHaveLength(0);
        expect(c.next.passes).toBe(0);
        expect(c.next.rounds).toBe(1);
    });

    it('сводка прохода (комментарий без якоря) находкой не считается', () => {
        const c = classifyFixReview(
            [{ comment: '🔴 [blocker] сводка: всё плохо' }, f('🟡 [minor] раз')],
            emptyReviewOfFixes(),
        );
        expect(c.fresh).toHaveLength(1);
        expect(c.freshBlocking).toHaveLength(0);
    });

    it('дубль внутри одного прохода учитывается один раз, спором не становится', () => {
        const c = classifyFixReview(
            [f('🔴 [blocker] раз'), f('🔴 [blocker] раз')],
            emptyReviewOfFixes(),
        );
        expect(c.fresh).toHaveLength(1);
        expect(c.next.disputes).toEqual({});
    });

    it('повторное blocking-замечание держит мердж, но потолок не двигает', () => {
        const first = classifyFixReview([f('🔴 [blocker] раз')], emptyReviewOfFixes());
        const second = classifyFixReview([f('🔴 [blocker] раз')], first.next);
        expect(second.freshBlocking).toHaveLength(0);
        expect(second.repeatedBlocking).toHaveLength(1);
        expect(second.next.passes).toBe(first.next.passes);
    });

    it('повторная косметика не теряется: она отдельно от свежей и от повторных блокеров', () => {
        // Сессия правок косметику видела и отклонила, ревью предъявило снова. Без
        // отдельного списка такая находка не попадала НИКУДА: ни в cosmetic (она не
        // свежая), ни в repeatedBlocking (она не блокирующая) — и терялась с мерджем.
        const first = classifyFixReview([f('🟡 [minor] нейминг')], emptyReviewOfFixes());
        const second = classifyFixReview([f('🟡 [minor] нейминг')], first.next);
        expect(second.cosmetic).toHaveLength(0);
        expect(second.repeatedBlocking).toHaveLength(0);
        expect(second.repeatedCosmetic).toHaveLength(1);
        // И потолок она по-прежнему не двигает — мердж такие замечания не держат.
        expect(second.next.passes).toBe(first.next.passes);
    });

    it('оспоренное дважды становится карточкой и больше никого не держит', () => {
        let st = emptyReviewOfFixes();
        st = classifyFixReview([f('🔴 [blocker] раз')], st).next;
        for (let i = 1; i < FIX_REVIEW_MAX_DISPUTES; i += 1) {
            st = classifyFixReview([f('🔴 [blocker] раз')], st).next;
        }
        const settling = classifyFixReview([f('🔴 [blocker] раз')], st);
        expect(settling.pingPong).toHaveLength(1);
        expect(settling.repeatedBlocking).toHaveLength(0);

        const after = classifyFixReview([f('🔴 [blocker] раз')], settling.next);
        expect(after.ignored).toHaveLength(1);
        expect(after.repeatedBlocking).toHaveLength(0);
        expect(after.freshBlocking).toHaveLength(0);
    });
});

describe('decideAfterFixReview — что делать по итогам прохода', () => {
    const clean = () => classifyFixReview([f('⚪ [nit] мелочь')], emptyReviewOfFixes());

    it('блокирующего нет → мердж', () => {
        expect(decideAfterFixReview(clean()).action).toBe('merge');
    });

    it('pr-block от сессии держит мердж, даже если разметка severity потерялась', () => {
        expect(decideAfterFixReview(clean(), { blocked: true }).action).toBe('fix');
    });

    it('новые blocker/major → ещё круг правок, пока потолок не исчерпан', () => {
        const c = classifyFixReview([f('🔴 [blocker] раз')], emptyReviewOfFixes());
        expect(decideAfterFixReview(c).action).toBe('fix');
    });

    it('потолок исчерпан → независимый арбитр, а не стоп', () => {
        let st = emptyReviewOfFixes();
        let decision;
        for (let i = 0; i < FIX_REVIEW_MAX_PASSES; i += 1) {
            const c = classifyFixReview(
                [f(`🟠 [major] находка ${String(i)}`, at('src/a.ts', i))],
                st,
            );
            decision = decideAfterFixReview(c);
            st = c.next;
        }
        expect(st.passes).toBe(FIX_REVIEW_MAX_PASSES);
        expect(decision?.action).toBe('arbiter');
    });

    it('спор без новых блокеров упирается в предохранитель кругов, а не крутится вечно', () => {
        // Каждый круг приносит НОВОЕ место, но всегда одно и то же: потолок passes
        // растёт, поэтому сюда доезжает круговой предохранитель только при чередовании.
        let st = { ...emptyReviewOfFixes(), rounds: FIX_REVIEW_MAX_PASSES * 2 - 1, passes: 1 };
        const c = classifyFixReview([f('🔴 [blocker] спорное', at('src/a.ts', 9))], st);
        expect(decideAfterFixReview(c).action).toBe('arbiter');
    });

    it('арбитр уже отработал → фаза идёт на гейт, второй раз петлю не крутим', () => {
        const c = classifyFixReview([f('🔴 [blocker] раз')], {
            ...emptyReviewOfFixes(),
            arbitrated: true,
        });
        expect(decideAfterFixReview(c).action).toBe('merge');
    });
});

describe('карточки: незакрытая косметика и закрытый спор', () => {
    it('косметика — карточка со ссылкой на PR, якорем и критерием готовности', () => {
        const c = classifyFixReview(
            [f('🟡 [minor] нейминг хромает', at('src/a.ts', 12))],
            emptyReviewOfFixes(),
        );
        const issue = backlogIssueFor(c.cosmetic[0], {
            milestone: 'M1',
            pr: 42,
            labels: ['complexity:low', 'area:core', 'backlog'],
        });
        expect(issue.title).toContain('нейминг хромает');
        expect(issue.body).toContain('PR #42');
        expect(issue.body).toContain('src/a.ts:12');
        expect(issue.body).toContain('Критерий готовности');
        expect(issue.labels).toEqual(['complexity:low', 'area:core', 'backlog']);
    });

    it('длинный текст замечания обрезается в заголовке, но целиком лежит в теле', () => {
        const long = `🟡 [minor] ${'очень длинное замечание '.repeat(20)}`;
        const c = classifyFixReview([f(long)], emptyReviewOfFixes());
        const issue = backlogIssueFor(c.cosmetic[0], { milestone: 'M1', pr: 1 });
        expect(issue.title.length).toBeLessThanOrEqual(90);
        expect(issue.body).toContain(long);
    });

    it('карточка после арбитра объясняет ДРУГУЮ причину, чем карточка косметики', () => {
        const c = classifyFixReview(
            [f('🔴 [blocker] спорное', at('src/a.ts', 3))],
            emptyReviewOfFixes(),
        );
        const arb = backlogIssueFor(c.freshBlocking[0], {
            milestone: 'M1',
            pr: 42,
            context: 'arbiter',
        });
        expect(arb.body).toMatch(/арбитр.*не воспроизвёл/s);
        // Про «такие замечания мердж не держат» здесь нельзя: blocker его как раз держит,
        // а отпустил его вердикт арбитра. Один текст на два пути соврал бы человеку.
        expect(arb.body).not.toMatch(/держат только blocker и major/);

        const cosmetic = backlogIssueFor(c.freshBlocking[0], { milestone: 'M1', pr: 42 });
        expect(cosmetic.body).toMatch(/держат только blocker и major/);
    });

    it('спор — карточка с ОБЕИМИ позициями', () => {
        const c = classifyFixReview(
            [f('🔴 [blocker] спорное', at('src/a.ts', 3))],
            emptyReviewOfFixes(),
        );
        const issue = pingPongIssueFor(c.fresh[0], { milestone: 'M1', pr: 42, disputes: 2 });
        expect(issue.body).toContain('Позиция ревью');
        expect(issue.body).toContain('Позиция правок');
        expect(issue.body).toContain('PR #42');
    });

    it('номер PR неизвестен — карточка всё равно указывает место', () => {
        const c = classifyFixReview([f('🟡 [minor] раз', at('src/a.ts', 7))], emptyReviewOfFixes());
        const issue = backlogIssueFor(c.cosmetic[0], { milestone: 'M1', pr: null });
        expect(issue.body).toContain('src/a.ts:7');
        expect(issue.body).not.toContain('PR #');
    });
});

describe('pickBacklogMilestone — адрес накопительной вехи для карточек лестницы', () => {
    // countOpenFn заодно ведёт журнал вызовов: тест на «лишних запросов к форжу нет»
    // проверяет не только выбор, но и цену выбора.
    const counter = (counts: Record<string, number | null>) => {
        const asked: string[] = [];
        const countOpenFn = (m: string): number | null => {
            asked.push(m);
            // Именно `in`, а не `?? 0`: заданный null — это «не сосчитали», и схлопнуть
            // его в ноль значило бы проверять не тот случай.
            return m in counts ? counts[m] : 0;
        };
        return { asked, countOpenFn };
    };

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

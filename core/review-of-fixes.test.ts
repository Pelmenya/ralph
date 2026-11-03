// Юнит-тесты лестницы «ревью правок» (#625). Модуль чистый, поэтому здесь проверяется вся
// арифметика сходимости: дедуп, потолок, косметика, анти-пинг-понг, арбитр. Сквозные
// сценарии через настоящий runLoop — в tests/review-of-fixes-scenarios.test.ts.
import { describe, expect, it } from 'vitest';
import {
    BACKLOG_TITLE_PREFIX,
    DISPUTE_TITLE_PREFIX,
    SEVERITY_LEVELS,
    backlogIssueFor,
    classifyFixReview,
    countsOf,
    decideAfterFixReview,
    emptyReviewOfFixes,
    findingKey,
    staleLadderCards,
    FIX_REVIEW_MAX_DISPUTES,
    FIX_REVIEW_MAX_PASSES,
    FIX_SEVERITY_LEVELS,
    isBlockingSeverity,
    meetsSeverityFloor,
    normalizeReviewOfFixes,
    pingPongIssueFor,
    severityOf,
    type FixFinding,
} from './review-of-fixes.ts';

const at = (path: string, line: number) => ({ path, line });
const f = (comment: string, anchor = at('src/a.ts', 1)): FixFinding => ({ comment, anchor });

describe('severityOf — разметка серьёзности из контракта ревью-промпта', () => {
    const markers = [
        ['🔴', 'blocker'],
        ['🟠', 'major'],
        ['🟡', 'minor'],
        ['⚪', 'nit'],
    ] as const;

    it.each(
        markers.flatMap(([marker, markedSeverity]) =>
            SEVERITY_LEVELS.map((tag) => ({
                marker,
                tag,
                expected: tag === markedSeverity ? markedSeverity : null,
            })),
        ),
    )('$marker [$tag] принимается только согласованной парой', ({ marker, tag, expected }) => {
        expect(severityOf(`${marker} [${tag}] текст находки`)).toBe(expected);
    });

    it.each(['🔴', '[blocker]', '🔴 [critical]', '🔴 []', '🔴 blocker'])(
        'неполная или неизвестная разметка «%s» — unmarked',
        (comment) => {
            expect(severityOf(comment)).toBe(null);
        },
    );

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
        // #110: FIX_SEVERITY_LEVELS — та же ось, экспортирована отдельно ради
        // config-profile.ts (валидация review.backlogSeverityFloor).
        expect([...FIX_SEVERITY_LEVELS]).toEqual([...SEVERITY_LEVELS]);
    });
});

describe('meetsSeverityFloor — общий порог серьёзности находок (#110/#259)', () => {
    it('порог не задан → пропускает любую находку (дефолт сохраняет прежнее поведение)', () => {
        expect(meetsSeverityFloor('nit', undefined)).toBe(true);
        expect(meetsSeverityFloor('nit', null)).toBe(true);
        expect(meetsSeverityFloor('blocker', undefined)).toBe(true);
    });

    it('порог "minor": nit не проходит, minor и серьёзнее — проходят', () => {
        expect(meetsSeverityFloor('nit', 'minor')).toBe(false);
        expect(meetsSeverityFloor('minor', 'minor')).toBe(true);
        expect(meetsSeverityFloor('major', 'minor')).toBe(true);
        expect(meetsSeverityFloor('blocker', 'minor')).toBe(true);
    });

    it('порог "major": и minor, и nit не проходят', () => {
        expect(meetsSeverityFloor('minor', 'major')).toBe(false);
        expect(meetsSeverityFloor('nit', 'major')).toBe(false);
        expect(meetsSeverityFloor('major', 'major')).toBe(true);
        expect(meetsSeverityFloor('blocker', 'major')).toBe(true);
    });

    it('находка без метки (unmarked) порогом не режется — сравнивать не с чем', () => {
        expect(meetsSeverityFloor(null, 'blocker')).toBe(true);
    });

    // Незнакомый уровень валится снаружи (config-profile.ts), но функция чистая и
    // экспортирована сама по себе: без явной ветки indexOf('x') === -1 сделал бы
    // сравнение `severityRank <= -1` ложным для ЛЮБОЙ находки — отфильтровало бы всё.
    it('неизвестный уровень порога — fail-open, а не «отфильтровать всё»', () => {
        expect(meetsSeverityFloor('nit', 'critical' as unknown as 'blocker')).toBe(true);
        expect(meetsSeverityFloor('blocker', 'critical' as unknown as 'blocker')).toBe(true);
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

// Срок годности карточек лестницы (#18) — рядом с заголовками, по которым чистка узнаёт
// свою карточку. Мутирует найденное вызывающий; здесь проверяется только отбор.
describe('срок годности карточек лестницы (#18)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-08-21T00:00:00Z');
    const card = (over: Record<string, unknown> = {}) => ({
        number: 1,
        title: `${BACKLOG_TITLE_PREFIX}потерянный пробел`,
        createdAt: new Date(now - 40 * DAY).toISOString(),
        ...over,
    });

    it('выключатель: порог не задан — ни одной карточки на закрытие', () => {
        expect(staleLadderCards({ issues: [card()], now, staleDays: undefined })).toEqual([]);
        expect(staleLadderCards({ issues: [card()], now, staleDays: 0 })).toEqual([]);
    });

    it('старше порога — на закрытие, моложе — нет', () => {
        expect(staleLadderCards({ issues: [card()], now, staleDays: 30 })).toEqual([1]);
        const fresh = card({ number: 2, createdAt: new Date(now - 5 * DAY).toISOString() });
        expect(staleLadderCards({ issues: [fresh], now, staleDays: 30 })).toEqual([]);
    });

    it('ровно порог не закрывается — граница принадлежит карточке', () => {
        const edge = card({ createdAt: new Date(now - 30 * DAY).toISOString() });
        expect(staleLadderCards({ issues: [edge], now, staleDays: 30 })).toEqual([]);
    });

    it('чужая карточка в той же вехе не трогается — заголовок не наш', () => {
        const human = card({ number: 3, title: 'Настроить бэкапы Postgres' });
        expect(staleLadderCards({ issues: [human], now, staleDays: 30 })).toEqual([]);
    });

    it('карточка СПОРА не трогается никогда — её решает человек, а не срок', () => {
        // Заголовок спора проходит предфильтр лестницы (он один из её префиксов) и
        // доходит ИМЕННО до отдельной проверки на спор — уберите её, и тест покраснеет.
        // Прежняя фикстура до неё не доходила вовсе: `DISPUTE_TITLE_PREFIX` не начинается
        // с `BACKLOG_TITLE_PREFIX`, и тест дублировал соседний «чужой заголовок», оставаясь
        // зелёным при удалении ветки (ревью правок #98).
        const dispute = card({ number: 4, title: `${DISPUTE_TITLE_PREFIX}кто прав` });
        // Контраст: обычная карточка лестницы того же возраста закрывается — значит, спор
        // уцелел именно благодаря своей проверке, а не потому, что срок не наступил.
        const plain = card({ number: 7 });
        expect(staleLadderCards({ issues: [dispute, plain], now, staleDays: 30 })).toEqual([7]);
    });

    it('карточка без даты не трогается: «не знаю возраст» — не повод закрывать', () => {
        const undated = card({ number: 5, createdAt: undefined });
        expect(staleLadderCards({ issues: [undated], now, staleDays: 30 })).toEqual([]);
        const broken = card({ number: 6, createdAt: 'позавчера' });
        expect(staleLadderCards({ issues: [broken], now, staleDays: 30 })).toEqual([]);
    });

    it('предел за прогон: больше названного числа карточек за раз не закрываем', () => {
        const many = Array.from({ length: 10 }, (_, i) => card({ number: i + 1 }));
        expect(staleLadderCards({ issues: many, now, staleDays: 30, limit: 3 })).toEqual([1, 2, 3]);
    });
});

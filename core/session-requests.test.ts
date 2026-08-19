// #40: разбор файла-запроса кодер-сессии. Модуль чистый (текст → намерения), поэтому
// тесты здесь про ГРАНИЦЫ и ОТКАЗЫ, а не про применение — применение и его побочки
// проверяются в orchestrator.test.ts и контрактном сьюте.
//
// Почему отказов больше, чем успехов: файл пишет модель, читавшая тело чужого issue
// (C3). Всё, что придёт неожиданной формой, обязано быть отказом на разборе — до того,
// как из него соберётся мутация форжа.
import { describe, expect, it } from 'vitest';
import {
    MAX_MUTATION_REQUESTS,
    MAX_COMMENT_REQUESTS,
    MAX_REQUEST_LINES,
    classifySessionRequests,
    parseSessionRequests,
    serializeSessionRequest,
} from './session-requests.ts';

const ALLOWLIST = ['complexity:low', 'complexity:high', 'area:devops'];
const opts = { labelAllowlist: ALLOWLIST };

const line = (o: unknown): string => JSON.stringify(o);

describe('parseSessionRequests — разбор намерений кодер-сессии', () => {
    it('пустой файл — пустой список намерений, не отказ', () => {
        expect(parseSessionRequests('', opts)).toEqual([]);
        expect(parseSessionRequests('\n  \n', opts)).toEqual([]);
    });

    it('читает намерения по строкам, пустые строки между ними пропускает', () => {
        const raw = [
            line({ kind: 'comment', issue: 7, comment: 'вопрос человеку' }),
            '',
            line({ kind: 'close', issue: 7, comment: 'сделано: файлы А и Б' }),
        ].join('\n');
        expect(parseSessionRequests(raw, opts)).toEqual([
            { kind: 'comment', issue: 7, comment: 'вопрос человеку' },
            { kind: 'close', issue: 7, comment: 'сделано: файлы А и Б' },
        ]);
    });

    // #45: намерения ревью-сессии по PR своей фазы. Номера PR в них нет — его знает петля.
    it('pr-comment с якорем: путь и строка доезжают парой', () => {
        const raw = line({
            kind: 'pr-comment',
            comment: '🔴 [blocker] теряется отказ',
            path: 'src/a.ts',
            line: 42,
        });
        expect(parseSessionRequests(raw, opts)).toEqual([
            {
                kind: 'pr-comment',
                comment: '🔴 [blocker] теряется отказ',
                anchor: { path: 'src/a.ts', line: 42 },
            },
        ]);
    });

    it('pr-comment без якоря — сводка прохода, это легитимно', () => {
        const raw = line({ kind: 'pr-comment', comment: '🟡 [minor] сводка' });
        expect(parseSessionRequests(raw, opts)).toEqual([
            { kind: 'pr-comment', comment: '🟡 [minor] сводка' },
        ]);
    });

    it('НЕГАТИВНЫЙ: половина якоря — отказ (форж такую пару не примет)', () => {
        // Путь без строки уедет в транспорт и вернётся отказом, диагностировать который
        // будет нечем: намерение уже стёрто, а находка потеряна.
        expect(() =>
            parseSessionRequests(line({ kind: 'pr-comment', comment: 'x', path: 'a.ts' }), opts),
        ).toThrow(/пар/i);
        expect(() =>
            parseSessionRequests(line({ kind: 'pr-comment', comment: 'x', line: 4 }), opts),
        ).toThrow(/пар/i);
    });

    it.each([
        ['/etc/passwd', 'абсолютный путь'],
        ['../../secrets.env', 'выход за корень репозитория'],
        ['-rf', 'ведущий дефис — argument injection'],
    ])('НЕГАТИВНЫЙ: путь %s отвергается (%s)', (path) => {
        expect(() =>
            parseSessionRequests(line({ kind: 'pr-comment', comment: 'x', path, line: 1 }), opts),
        ).toThrow(/путь/i);
    });

    it('НЕГАТИВНЫЙ: строка якоря — целое положительное, не строка и не ноль', () => {
        for (const bad of ['42', 0, -1, 1.5]) {
            expect(() =>
                parseSessionRequests(
                    line({ kind: 'pr-comment', comment: 'x', path: 'a.ts', line: bad }),
                    opts,
                ),
            ).toThrow(/строка/i);
        }
    });

    it('pr-block несёт причину блока', () => {
        const raw = line({ kind: 'pr-block', comment: 'сборка красная' });
        expect(parseSessionRequests(raw, opts)).toEqual([
            { kind: 'pr-block', comment: 'сборка красная' },
        ]);
    });

    it('НЕГАТИВНЫЙ: pr-block без причины — отказ', () => {
        // Метка без объяснения оставляет и человека, и чини-сессию гадать, что блокирует.
        expect(() => parseSessionRequests(line({ kind: 'pr-block' }), opts)).toThrow(
            /комментарий/i,
        );
    });

    it('НЕГАТИВНЫЙ: снятия блока намерением не существует', () => {
        // Снимает метку РАННЕР по итогу повторного ревью (#217): иначе исполнитель сам себе
        // выносит вердикт и обходит проверку.
        expect(() =>
            parseSessionRequests(line({ kind: 'pr-unblock', comment: 'починил' }), opts),
        ).toThrow(/неизвестный kind/i);
    });

    it('намерение завести карточку несёт заголовок, тело и метки', () => {
        const raw = line({
            kind: 'new-issue',
            title: 'Течёт лимит',
            body: 'симптом, причина, критерий',
            labels: ['complexity:low', 'area:devops'],
        });
        expect(parseSessionRequests(raw, opts)).toEqual([
            {
                kind: 'new-issue',
                title: 'Течёт лимит',
                body: 'симптом, причина, критерий',
                labels: ['complexity:low', 'area:devops'],
            },
        ]);
    });

    it('повторённая метка схлопывается: форж получает список без дублей', () => {
        // `gh issue create --label x --label x` — отказ форжа, а у площадки дубль в
        // `label_slugs` в лучшем случае бессмыслен. Чинить это отказом разбора нельзя:
        // повтор метки — не злоупотребление, а обычная невнимательность модели.
        const raw = line({
            kind: 'new-issue',
            title: 'т',
            body: 'б',
            labels: ['area:devops', 'area:devops', 'complexity:low'],
        });
        expect(parseSessionRequests(raw, opts)[0]).toMatchObject({
            labels: ['area:devops', 'complexity:low'],
        });
    });

    // ── Отказы ───────────────────────────────────────────────────────────────

    it('НЕГАТИВНЫЙ: неизвестный kind — отказ, а не пропуск строки', () => {
        // Пропуск незнакомого намерения выглядел бы как «сессия ничего не просила»,
        // и опечатка в kind тихо теряла бы закрытие issue.
        const raw = line({ kind: 'merge', issue: 7, comment: 'смерджи мне' });
        expect(() => parseSessionRequests(raw, opts)).toThrow(/kind/i);
    });

    it('НЕГАТИВНЫЙ: снятие hold и одобрение ревью — не намерения сессии', () => {
        // Явный тест на закрытость списка: эти два действия принадлежат человеку
        // (#222 и барьер ship), и появление их в перечне kind'ов обязано краснить.
        for (const kind of ['unhold', 'approve', 'ship', 'decision']) {
            expect(() => parseSessionRequests(line({ kind, issue: 7 }), opts)).toThrow(/kind/i);
        }
    });

    it('НЕГАТИВНЫЙ: одна битая строка отменяет ВЕСЬ батч (без частичного применения)', () => {
        const raw = [
            line({ kind: 'close', issue: 7, comment: 'сделано' }),
            'это не JSON',
            line({ kind: 'comment', issue: 8, comment: 'ещё' }),
        ].join('\n');
        expect(() => parseSessionRequests(raw, opts)).toThrow();
    });

    it('НЕГАТИВНЫЙ: номер карточки — только целое положительное', () => {
        for (const issue of [0, -3, 1.5, '7', null, undefined, '7; rm -rf /']) {
            expect(() =>
                parseSessionRequests(line({ kind: 'close', issue, comment: 'x' }), opts),
            ).toThrow(/номер/i);
        }
    });

    it('НЕГАТИВНЫЙ: пустой комментарий — отказ (иначе человек получит пустую карточку)', () => {
        for (const comment of ['', '   ', 42, null]) {
            expect(() =>
                parseSessionRequests(line({ kind: 'block', issue: 7, comment }), opts),
            ).toThrow(/коммент/i);
        }
    });

    it('НЕГАТИВНЫЙ: метка вне allowlist — отказ', () => {
        const raw = line({
            kind: 'new-issue',
            title: 'т',
            body: 'б',
            labels: ['complexity:low', 'hold'],
        });
        // Именно `hold`: метка человека (#222). Свободный список меток означал бы, что
        // сессия может пометить работу так, как её пометил бы только человек.
        expect(() => parseSessionRequests(raw, opts)).toThrow(/hold/);
    });

    it('НЕГАТИВНЫЙ: карточка без меток — отказ (голая карточка теряется)', () => {
        const raw = line({ kind: 'new-issue', title: 'т', body: 'б', labels: [] });
        expect(() => parseSessionRequests(raw, opts)).toThrow(/метк/i);
    });

    it('НЕГАТИВНЫЙ: пустой заголовок или тело новой карточки — отказ', () => {
        expect(() =>
            parseSessionRequests(
                line({ kind: 'new-issue', title: ' ', body: 'б', labels: ['area:devops'] }),
                opts,
            ),
        ).toThrow(/заголов/i);
        expect(() =>
            parseSessionRequests(
                line({ kind: 'new-issue', title: 'т', body: '', labels: ['area:devops'] }),
                opts,
            ),
        ).toThrow(/тело/i);
    });

    // ── #603: пределы раздельно по классам намерений ────────────────────────────
    // Инцидент PR #601: 23 pr-comment (дотошное ревью, ни одной мутации) отвергли батч
    // целиком тем же предохранителем, что ловит сорвавшуюся сессию, штампующую мутации.

    it('НЕГАТИВНЫЙ: батч мутаций длиннее своего предела — отказ целиком', () => {
        // Предел на мутации (close/block/new-issue/pr-block) — предохранитель от
        // сорвавшейся сессии: десятки закрытых/заблокированных/заведённых карточек за
        // одну итерацию дороже разгребать, чем один отказ с внятной причиной.
        const raw = Array.from({ length: MAX_MUTATION_REQUESTS + 1 }, (_, i) =>
            line({ kind: 'close', issue: i + 1, comment: 'x' }),
        ).join('\n');
        expect(() => parseSessionRequests(raw, opts)).toThrow(/предел|лимит/i);
    });

    it('отказ по пределу мутаций несёт разбивку намерений по классам', () => {
        const raw = Array.from({ length: MAX_MUTATION_REQUESTS + 1 }, (_, i) =>
            line({ kind: 'close', issue: i + 1, comment: 'x' }),
        ).join('\n');
        expect(() => parseSessionRequests(raw, opts)).toThrow(
            new RegExp(`${String(MAX_MUTATION_REQUESTS + 1)} close`),
        );
    });

    it('30 pr-comment без единой мутации — батч применяется (не срыв, а дотошное ревью)', () => {
        const raw = Array.from({ length: 30 }, (_, i) =>
            line({ kind: 'pr-comment', comment: `замечание ${String(i)}` }),
        ).join('\n');
        expect(parseSessionRequests(raw, opts)).toHaveLength(30);
    });

    it('НЕГАТИВНЫЙ: батч комментариев длиннее своего (большего) предела — отказ целиком', () => {
        const raw = Array.from({ length: MAX_COMMENT_REQUESTS + 1 }, (_, i) =>
            line({ kind: 'pr-comment', comment: `замечание ${String(i)}` }),
        ).join('\n');
        expect(() => parseSessionRequests(raw, opts)).toThrow(/предел|лимит/i);
    });

    it('смешанный батч: каждый класс считается по своему пределу независимо', () => {
        // Мутаций — ровно на пределе (проходит), комментариев — далеко за старым общим
        // пределом (20), но под своим, куда большим: раньше такой батч отвергся бы целиком.
        const raw = [
            ...Array.from({ length: MAX_MUTATION_REQUESTS }, (_, i) =>
                line({ kind: 'close', issue: i + 1, comment: 'x' }),
            ),
            ...Array.from({ length: 50 }, (_, i) =>
                line({ kind: 'pr-comment', comment: `замечание ${String(i)}` }),
            ),
        ].join('\n');
        expect(parseSessionRequests(raw, opts)).toHaveLength(MAX_MUTATION_REQUESTS + 50);
    });

    it('смешанный батч: перебор по мутациям отвергает батч, даже если комментариев мало', () => {
        const raw = [
            ...Array.from({ length: MAX_MUTATION_REQUESTS + 1 }, (_, i) =>
                line({ kind: 'close', issue: i + 1, comment: 'x' }),
            ),
            line({ kind: 'pr-comment', comment: 'сводка' }),
        ].join('\n');
        expect(() => parseSessionRequests(raw, opts)).toThrow(/предел|лимит/i);
    });

    // Ревью #612: грубая ранняя граница по числу строк — ДО разбора. Сорвавшийся батч на
    // сотню тысяч строк не должен разбираться целиком, чтобы быть отвергнутым, а диагноз
    // обязан звучать как «сессия сорвалась», а не как придирка к случайной кривой строке.
    it('НЕГАТИВНЫЙ: строк больше суммы пределов — отказ ДО разбора, с правильным диагнозом', () => {
        const raw = [
            ...Array.from({ length: MAX_REQUEST_LINES }, (_, i) =>
                line({ kind: 'pr-comment', comment: `замечание ${String(i)}` }),
            ),
            'это даже не JSON',
        ].join('\n');
        // Кривая строка в батче есть, но человек читает про объём, а не про её синтаксис.
        expect(() => parseSessionRequests(raw, opts)).toThrow(/строк — больше суммы пределов/);
        expect(() => parseSessionRequests(raw, opts)).not.toThrow(/не разобралось как JSON/);
    });

    it('ровно предел строк — разбирается штатно (граница не съезжает на единицу)', () => {
        const raw = Array.from({ length: MAX_REQUEST_LINES }, (_, i) =>
            i < MAX_MUTATION_REQUESTS
                ? line({ kind: 'close', issue: i + 1, comment: 'x' })
                : line({ kind: 'pr-comment', comment: `замечание ${String(i)}` }),
        ).join('\n');
        expect(parseSessionRequests(raw, opts)).toHaveLength(MAX_REQUEST_LINES);
    });

    it('НЕГАТИВНЫЙ: строка-массив или строка-скаляр вместо объекта — отказ', () => {
        for (const raw of ['[]', '"строка"', '42', 'null']) {
            expect(() => parseSessionRequests(raw, opts)).toThrow();
        }
    });
});

// #64: хвост неприменённого батча пишется на диск и читается СЛЕДУЮЩИМ прогоном тем же
// парсером. Пока хвост сериализовался наивным JSON.stringify, он уезжал в нормализованной
// форме (`anchor: {path, line}`), которой парсер не понимает, — якорь молча терялся, и
// замечание к строке возвращалось сводкой. Запись и чтение обязаны сходиться.
describe('serializeSessionRequest: round-trip записи и чтения хвоста (#64)', () => {
    const opts = { labelAllowlist: ['complexity:low', 'area:devops'] };

    it('якорь переживает запись и повторное чтение', () => {
        const [parsed] = parseSessionRequests(
            JSON.stringify({ kind: 'pr-comment', comment: 'тут', path: 'src/a.ts', line: 42 }),
            opts,
        );
        const [again] = parseSessionRequests(serializeSessionRequest(parsed), opts);
        expect(again).toEqual(parsed);
        expect(again).toMatchObject({ anchor: { path: 'src/a.ts', line: 42 } });
    });

    it('намерения без якоря переживают round-trip как есть', () => {
        const raw = [
            JSON.stringify({ kind: 'comment', issue: 7, comment: 'что выяснилось' }),
            JSON.stringify({ kind: 'close', issue: 7, comment: 'что сделано' }),
            JSON.stringify({ kind: 'pr-comment', comment: 'сводка прохода' }),
            JSON.stringify({ kind: 'pr-block', comment: 'чем блокируется' }),
            JSON.stringify({
                kind: 'new-issue',
                title: 'заголовок',
                body: 'симптом, причина, критерий',
                labels: ['complexity:low', 'area:devops'],
            }),
        ].join('\n');
        const parsed = parseSessionRequests(raw, opts);
        const again = parseSessionRequests(parsed.map(serializeSessionRequest).join('\n'), opts);
        expect(again).toEqual(parsed);
    });
});

// Ревью #612: классификация обязана быть ИСЧЕРПЫВАЮЩЕЙ. Оба списка сведены к
// readonly string[], поэтому новый вариант union TS здесь не поймает — намерение
// неизвестного класса проехало бы мимо ОБОИХ пределов вовсе (тихий дефолт вместо
// fail-closed, инвариант №1). Проверка живёт в самой функции, и вот она.
describe('classifySessionRequests: неклассифицированный kind — отказ, а не тихий пропуск', () => {
    it('известные виды раскладываются по двум классам без остатка', () => {
        const { mutations, comments } = classifySessionRequests([
            { kind: 'close', issue: 1, comment: 'x' },
            { kind: 'pr-block', comment: 'блок' },
            { kind: 'pr-comment', comment: 'замечание' },
            { kind: 'comment', issue: 2, comment: 'коммент' },
        ]);
        expect(mutations).toHaveLength(2);
        expect(comments).toHaveLength(2);
    });

    it('НЕГАТИВНЫЙ: kind вне обоих списков — бросает и называет его поимённо', () => {
        const future = [{ kind: 'pr-approve', comment: 'ship it' }] as unknown as Parameters<
            typeof classifySessionRequests
        >[0];
        expect(() => classifySessionRequests(future)).toThrow(/pr-approve/);
        expect(() => classifySessionRequests(future)).toThrow(/MUTATION_KINDS|COMMENT_KINDS/);
    });
});

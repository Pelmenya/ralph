// #40: разбор файла-запроса кодер-сессии. Модуль чистый (текст → намерения), поэтому
// тесты здесь про ГРАНИЦЫ и ОТКАЗЫ, а не про применение — применение и его побочки
// проверяются в orchestrator.test.ts и контрактном сьюте.
//
// Почему отказов больше, чем успехов: файл пишет модель, читавшая тело чужого issue
// (C3). Всё, что придёт неожиданной формой, обязано быть отказом на разборе — до того,
// как из него соберётся мутация форжа.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    MAX_MUTATION_REQUESTS,
    MAX_COMMENT_REQUESTS,
    MAX_REQUEST_LINES,
    UnknownLiveProbeError,
    classifyIntentFailure,
    intentFailureText,
    classifySessionRequests,
    inFlightEntry,
    inFlightRequest,
    inFlightMarker,
    parseSessionRequests,
    quarantinePath,
    reconcileInFlight,
    withIntentMark,
    serializeSessionRequest,
    INTENTS_BEGIN,
    INTENTS_END,
    extractIntentBlock,
    serializeRejectedBlock,
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

    // Динамические маршруты Next: скобки в имени сегмента — штатная форма, и без них
    // замечание ревью на такой файл уносило ВЕСЬ батч намерений (в проекте, где ядро
    // обкатывалось, — две остановки сдачи фазы подряд).
    it.each([
        ['apps/web/app/[slug]/page.tsx', 'динамический сегмент'],
        ['app/[...rest]/page.tsx', 'catch-all сегмент'],
        ['app/[[...opt]]/page.tsx', 'необязательный catch-all'],
        ['app/(group)/[id]/route.ts', 'скобки рядом с группой маршрутов'],
    ])('путь %s принимается (%s)', (path) => {
        expect(() =>
            parseSessionRequests(line({ kind: 'pr-comment', comment: 'x', path, line: 1 }), opts),
        ).not.toThrow();
    });

    it.each([
        ['/etc/passwd', 'абсолютный путь'],
        ['../../secrets.env', 'выход за корень репозитория'],
        ['-rf', 'ведущий дефис — argument injection'],
        ['[slug]/page.tsx', 'скобка первым символом — сужаем вход, реальным путям не нужно'],
        ['app/[slug]/../../etc/passwd', 'скобки не открывают выход за дерево'],
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

    // #220: `blocks` — номер карточки фазы; форма — как у `issue`, принадлежность вехе
    // сверяет применение.
    it('blocks доезжает числом и переживает сериализацию', () => {
        const raw = line({
            kind: 'new-issue',
            title: 'т',
            body: 'б',
            labels: ['area:devops'],
            blocks: 186,
        });
        const [req] = parseSessionRequests(raw, opts);
        expect(req).toMatchObject({ kind: 'new-issue', blocks: 186 });
        expect(parseSessionRequests(serializeSessionRequest(req), opts)).toEqual([req]);
    });

    it.each([['186'], [0], [1.5], [null]])('НЕГАТИВНЫЙ: blocks %j — отказ', (blocks) => {
        const raw = line({
            kind: 'new-issue',
            title: 'т',
            body: 'б',
            labels: ['area:devops'],
            blocks,
        });
        expect(() => parseSessionRequests(raw, opts)).toThrow(/номер карточки/);
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

    // ── Фаза 10: формат карточки задаёт потребитель ─────────────────────────────
    describe('формат новой карточки (issueFormat)', () => {
        const issueFormat = {
            sections: [
                { heading: 'Критерии готовности' },
                { heading: 'Макет', whenLabel: 'area:devops', requireLink: true },
            ],
        };
        const withFormat = { ...opts, issueFormat };
        const card = (body: string, labels = ['complexity:low']) =>
            line({ kind: 'new-issue', title: 'т', body, labels });

        it('НЕГАТИВНЫЙ: new-issue без обязательного раздела — отказ с разделом и строкой', () => {
            expect(() => parseSessionRequests(card('## Что сделать\nтекст'), withFormat)).toThrow(
                /строка 1: .*не по формату.*нет раздела «Критерии готовности»/,
            );
        });

        it('НЕГАТИВНЫЙ: правило по метке — раздел без ссылки отвергается', () => {
            const body = '## Критерии готовности\n- [ ] x\n## Макет\nсм. в чате';
            expect(() =>
                parseSessionRequests(card(body, ['complexity:low', 'area:devops']), withFormat),
            ).toThrow(/нет ссылки http\(s\) в разделе «Макет»/);
        });

        it('карточка по формату заводится', () => {
            const body = '## Критерии готовности\n- [ ] x';
            expect(parseSessionRequests(card(body), withFormat)).toHaveLength(1);
        });

        it('формат не задан — new-issue проверяется как раньше', () => {
            expect(parseSessionRequests(card('б'), opts)).toHaveLength(1);
            expect(parseSessionRequests(card('б'), { ...opts, issueFormat: null })).toHaveLength(1);
        });
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

describe('#291 намерения ревью карточки', () => {
    it('разбирает находку, блок и отчёт о правке', () => {
        const raw = [
            line({
                kind: 'card-comment',
                issue: 7,
                comment: '🟠 [major] закрытие теряет находку',
                path: 'core/a.ts',
                line: 42,
            }),
            line({ kind: 'card-block', issue: 7, comment: 'нельзя закрывать' }),
            line({ kind: 'card-fix', issue: 7, finding: 'F1', test: 'держит находку' }),
        ].join('\n');
        expect(parseSessionRequests(raw, opts)).toEqual([
            {
                kind: 'card-comment',
                issue: 7,
                comment: '🟠 [major] закрытие теряет находку',
                anchor: { path: 'core/a.ts', line: 42 },
            },
            { kind: 'card-block', issue: 7, comment: 'нельзя закрывать' },
            { kind: 'card-fix', issue: 7, finding: 'F1', test: 'держит находку' },
        ]);
    });

    it('card-comment без якоря — сводка, но серьёзность обязательна у обеих форм', () => {
        expect(
            parseSessionRequests(
                line({ kind: 'card-comment', issue: 7, comment: '⚪ [nit] чисто' }),
                opts,
            ),
        ).toEqual([{ kind: 'card-comment', issue: 7, comment: '⚪ [nit] чисто' }]);
        for (const comment of ['без разметки', '[major] без эмодзи']) {
            expect(() =>
                parseSessionRequests(
                    line({ kind: 'card-comment', issue: 7, comment, path: 'a.ts', line: 1 }),
                    opts,
                ),
            ).toThrow(/серьёзност/i);
            expect(() =>
                parseSessionRequests(line({ kind: 'card-comment', issue: 7, comment }), opts),
            ).toThrow(/серьёзност/i);
        }
    });

    it.each(['🔴 [blocker] итог', '🟠 [major] итог'])(
        'сводка с тегом blocker/major без места — отказ: %s',
        (comment) => {
            expect(() =>
                parseSessionRequests(line({ kind: 'card-comment', issue: 7, comment }), opts),
            ).toThrow(/находка без места/i);
        },
    );

    it.each([
        [{ kind: 'card-comment', issue: '7', comment: '⚪ [nit] x' }, /номер карточки/i],
        [{ kind: 'card-block', issue: 0, comment: 'x' }, /номер карточки/i],
        [{ kind: 'card-fix', issue: 7, finding: 'F1', test: '' }, /test|тест/i],
        [{ kind: 'card-fix', issue: 7, finding: 'F1', test: '   ' }, /test|тест/i],
        [{ kind: 'card-fix', issue: 7, finding: 'F1', test: 'x'.repeat(301) }, /300/],
        [{ kind: 'card-fix', issue: 7, finding: '1', test: 'x' }, /finding|F\\d/i],
        [{ kind: 'card-fix', issue: 7, finding: 'F-1', test: 'x' }, /finding|F\\d/i],
        [{ kind: 'card-fix', issue: 7, finding: 'X1', test: 'x' }, /finding|F\\d/i],
    ])('НЕГАТИВНЫЙ: домен значений отвергается', (request, reason) => {
        expect(() => parseSessionRequests(line(request), opts)).toThrow(reason);
    });

    it('card-fix принимает test длиной ровно 300 символов', () => {
        const request = { kind: 'card-fix', issue: 7, finding: 'F12', test: 'x'.repeat(300) };
        expect(parseSessionRequests(line(request), opts)).toEqual([request]);
    });

    it('якорь card-comment переживает serialize → parse без потери места', () => {
        const [parsed] = parseSessionRequests(
            line({
                kind: 'card-comment',
                issue: 7,
                comment: '🟡 [minor] здесь',
                path: 'core/a.ts',
                line: 42,
                side: 'LEFT',
            }),
            opts,
        );
        expect(parseSessionRequests(serializeSessionRequest(parsed), opts)).toEqual([parsed]);
        expect(parsed).toMatchObject({
            anchor: { path: 'core/a.ts', line: 42, side: 'LEFT' },
        });
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

// #41: сторона диффа у якоря — без неё замечание к удалённой строке ложилось на строку
// того же номера в НОВОЙ версии файла.
describe('#41 сторона диффа у pr-comment', () => {
    it('side=LEFT разбирается в якорь и переживает round-trip хвоста', () => {
        const raw = line({
            kind: 'pr-comment',
            comment: 'x',
            path: 'src/a.ts',
            line: 7,
            side: 'LEFT',
        });
        const [req] = parseSessionRequests(raw, opts);
        expect(req).toEqual({
            kind: 'pr-comment',
            comment: 'x',
            anchor: { path: 'src/a.ts', line: 7, side: 'LEFT' },
        });
        expect(parseSessionRequests(serializeSessionRequest(req), opts)).toEqual([req]);
    });

    it('без side — якорь без стороны, как до #41', () => {
        const raw = line({ kind: 'pr-comment', comment: 'x', path: 'src/a.ts', line: 7 });
        expect(parseSessionRequests(raw, opts)[0]).toEqual({
            kind: 'pr-comment',
            comment: 'x',
            anchor: { path: 'src/a.ts', line: 7 },
        });
    });

    it('НЕГАТИВНЫЙ: незнакомая сторона — отказ батча', () => {
        const raw = line({ kind: 'pr-comment', comment: 'x', path: 'a.ts', line: 1, side: 'old' });
        expect(() => parseSessionRequests(raw, opts)).toThrow(/сторона диффа/);
    });

    it('НЕГАТИВНЫЙ: side без path+line — отказ, а не молча выброшенное поле', () => {
        const raw = line({ kind: 'pr-comment', comment: 'x', side: 'LEFT' });
        expect(() => parseSessionRequests(raw, opts)).toThrow(/только при паре path\+line/);
    });
});

// 28.10, Ф16c3: сводку прохода ревью модель пишет с `"path": null`, и отказ по ней ставил
// петлю на каждом ревью. `null` у поля якоря — отсутствие поля.
describe('null у полей якоря — отсутствие поля', () => {
    it('сводка с path: null — замечание без якоря', () => {
        const raw = line({ kind: 'pr-comment', comment: 'сводка', path: null });
        expect(parseSessionRequests(raw, opts)[0]).toEqual({
            kind: 'pr-comment',
            comment: 'сводка',
        });
    });

    it('path, line и side все null — замечание без якоря', () => {
        const raw = line({ kind: 'pr-comment', comment: 'x', path: null, line: null, side: null });
        expect(parseSessionRequests(raw, opts)[0]).toEqual({ kind: 'pr-comment', comment: 'x' });
    });

    it('НЕГАТИВНЫЙ: path: null при живой строке — половина якоря, отказ', () => {
        const raw = line({ kind: 'pr-comment', comment: 'x', path: null, line: 42 });
        expect(() => parseSessionRequests(raw, opts)).toThrow(/ПАРОЙ path\+line/);
    });

    it('НЕГАТИВНЫЙ: side при path: null — отказ, а не молча выброшенное поле', () => {
        const raw = line({ kind: 'pr-comment', comment: 'x', path: null, side: 'LEFT' });
        expect(() => parseSessionRequests(raw, opts)).toThrow(/только при паре path\+line/);
    });
});

// #41: что выбывает из хвоста, а что его сохраняет. Умолчание — сохранить: незнакомая
// формулировка не должна молча отнимать у намерения повтор.
describe('#41 classifyIntentFailure', () => {
    it.each([
        'Command failed: gh issue comment 5\nGraphQL: Could not resolve to an issue or pull request with the number of 5.',
        "Command failed: gh issue edit 5 --add-label x\ncould not add label: 'x' not found",
        'gh: Resource not accessible by integration (HTTP 403)',
        'gh: Not Found (HTTP 404)',
        'SourceCraft POST /issues/5/comments: curl вернул 22 — curl: (22) The requested URL returned error: 404',
        'SourceCraft PATCH /issues/5: curl вернул 22 — curl: (22) The requested URL returned error: 403',
        'gh: Validation Failed (HTTP 422)',
    ])('по существу: %s', (msg) => {
        expect(classifyIntentFailure(msg)).toBe('deterministic');
    });

    it.each([
        'gh: API rate limit exceeded for user ID 1 (HTTP 403)',
        'gh: You have exceeded a secondary rate limit (HTTP 403)',
        'gh: Bad Gateway (HTTP 502)',
        'curl: (22) The requested URL returned error: 503',
        'connect ETIMEDOUT 10.0.0.1:443',
        'read ECONNRESET',
        'форж отверг закрытие',
    ])('повтор (хвост сохраняется): %s', (msg) => {
        expect(classifyIntentFailure(msg)).toBe('retry');
    });

    it.each([
        'getaddrinfo ENOTFOUND api.example.com',
        'connect ECONNREFUSED 10.0.0.1:443',
        'curl: (6) Could not resolve host: api.example.com',
        'dial tcp: lookup api.github.com: no such host',
    ])('до соединения (запрос не ушёл): %s', (msg) => {
        expect(classifyIntentFailure(msg)).toBe('unsent');
    });

    it.each([
        'HTTP 403: You have triggered an abuse detection mechanism',
        'read: connection reset by peer (HTTP 404 упомянут в ответе прокси)',
        'socket hang up',
        'net/http: TLS handshake timeout',
        'read tcp 10.0.0.1:443: i/o timeout',
    ])('транзиент мерджевого набора и устаревший вторичный лимит: %s', (msg) => {
        expect(classifyIntentFailure(msg)).toBe('retry');
    });

    it('тело комментария из argv в класс не попадает: обрыв сети при «HTTP 404» в теле', () => {
        const e = Object.assign(
            new Error(
                'Command failed: gh issue comment 5 --body форж отвечал HTTP 404 на закрытие\n' +
                    'read: connection reset by peer',
            ),
            { stderr: 'read: connection reset by peer\n' },
        );
        expect(intentFailureText(e)).toBe('read: connection reset by peer');
        expect(classifyIntentFailure(intentFailureText(e))).toBe('retry');
        // Без stderr сообщение-команду не читаем вовсе: отделить тело от ответа нечем.
        const bare = new Error('Command failed: gh issue close 5 --body HTTP 404');
        expect(intentFailureText(bare)).toBe('');
        expect(classifyIntentFailure(intentFailureText(bare))).toBe('retry');
        // Ошибка адаптера без процесса — её сообщение и есть ответ форжа.
        expect(intentFailureText(new Error('gh: Not Found (HTTP 404)'))).toBe(
            'gh: Not Found (HTTP 404)',
        );
    });

    it('номер в тексте команды без HTTP-кода отказом по существу не считается', () => {
        expect(classifyIntentFailure('Command failed: gh issue close 404')).toBe('retry');
    });
});

// #94: метка с идентификатором попытки и сверка начатого намерения с лентой форжа.
describe('#94 метка намерения и сверка', () => {
    const started = '{"kind":"comment","issue":7,"comment":"x"}';
    const rest = '{"kind":"comment","issue":8,"comment":"y"}';

    it('метка с id разбирается: id, начатое и хвост за ним', () => {
        const raw = `${inFlightMarker('intent-0001')}\n${started}\n${rest}\n`;
        expect(inFlightEntry(raw)).toEqual({
            marker: '{"ralph":"in-flight","id":"intent-0001"}',
            id: 'intent-0001',
            landed: null,
            started,
            rest: `${rest}\n`,
        });
    });

    it('начатое намерение строкой для текстов; нет метки или файла — null', () => {
        expect(inFlightRequest(`${inFlightMarker('intent-0001')}\n${started}\n`)).toBe(started);
        expect(inFlightRequest(`${started}\n`)).toBeNull();
        expect(inFlightRequest(null)).toBeNull();
    });

    it('метка с landed: comment — комментарий лёг по записи раннера, иное landed — порча', () => {
        const raw = `${inFlightMarker('intent-0001', 'comment')}\n${started}\n`;
        expect(inFlightEntry(raw)).toMatchObject({ id: 'intent-0001', landed: 'comment' });
        const bad = `{"ralph":"in-flight","id":"intent-0001","landed":"all"}\n${started}\n`;
        expect(inFlightEntry(bad)).toMatchObject({ id: null, landed: null });
    });

    it('метка без id, с лишним полем или не первой строкой — id не признаётся', () => {
        expect(inFlightEntry(`{"ralph":"in-flight"}\n${started}\n`)?.id).toBeNull();
        expect(
            inFlightEntry(`{"ralph":"in-flight","id":"intent-0001","x":1}\n${started}\n`)?.id,
        ).toBeNull();
        expect(
            inFlightEntry(`${rest}\n${inFlightMarker('intent-0001')}\n${started}\n`)?.id,
        ).toBeNull();
        expect(inFlightEntry(`${rest}\n`)).toBeNull();
    });

    it('идентификатор не по форме метку не собирает', () => {
        expect(() => inFlightMarker('a"b')).toThrow();
    });

    const comment = { kind: 'comment' as const, issue: 7, comment: 'x' };
    const source = (bodies: string[], issueBodies?: string[]) => ({
        listPullRequestComments: () => bodies.map((body) => ({ body })),
        findOpenPullRequest: () => ({ number: 55 }),
        ...(issueBodies ? { listIssueComments: () => issueBodies } : {}),
    });

    it('лента карточки: метка есть — лёг; у close — лёг только комментарий', () => {
        const s = source([], [withIntentMark('x', 'intent-0001')]);
        expect(reconcileInFlight(comment, 'intent-0001', s, undefined)).toEqual({
            verdict: 'landed',
            landed: 'all',
        });
        expect(
            reconcileInFlight({ ...comment, kind: 'close' }, 'intent-0001', s, undefined),
        ).toEqual({ verdict: 'landed', landed: 'comment' });
        expect(reconcileInFlight(comment, 'intent-0002', s, undefined)).toEqual({
            verdict: 'landed',
            landed: 'none',
        });
    });

    it('сверить нечем — unknown с причиной, а не «не лёг»', () => {
        expect(reconcileInFlight(comment, 'intent-0001', source([]), undefined).verdict).toBe(
            'unknown',
        );
        const issue = { kind: 'new-issue' as const, title: 't', body: 'b', labels: ['x'] };
        expect(reconcileInFlight(issue, 'intent-0001', source([], []), undefined)).toMatchObject({
            verdict: 'unknown',
            why: expect.stringContaining('поиска карточки'),
        });
        const pr = { kind: 'pr-comment' as const, comment: 'c' };
        expect(reconcileInFlight(pr, 'intent-0001', source([]), undefined).verdict).toBe('unknown');
        const broken = {
            ...source([]),
            listPullRequestComments: () => {
                throw new Error('HTTP 502');
            },
        };
        expect(reconcileInFlight(pr, 'intent-0001', broken, { branch: 'b' })).toMatchObject({
            verdict: 'unknown',
            why: expect.stringContaining('HTTP 502'),
        });
    });
});

// #124: имя карантина — от переданных часов, занятое имя не затирается.
describe('quarantinePath (#124)', () => {
    const now = Date.UTC(2026, 9, 27, 1, 2, 3, 4);
    it('имя — от переданного времени, без двоеточий и точек', () => {
        expect(quarantinePath('/s/r.jsonl', now, () => false)).toBe(
            '/s/r.jsonl.rejected-2026-10-27T01-02-03-004Z',
        );
    });
    it('занятое имя получает первый свободный номер, а не затирается', () => {
        const taken = new Set([
            '/s/r.jsonl.rejected-2026-10-27T01-02-03-004Z',
            '/s/r.jsonl.rejected-2026-10-27T01-02-03-004Z-1',
        ]);
        expect(quarantinePath('/s/r.jsonl', now, (p) => taken.has(p))).toBe(
            '/s/r.jsonl.rejected-2026-10-27T01-02-03-004Z-2',
        );
    });
});

// #9: канал намерений развёрнут — сессия печатает блок в свой вывод, файл пишет раннер.
// Харнесс защищает файл очереди команд оркестратора от записи сессией, и защищает по
// делу; поэтому разбор вывода — граница, где форма блока решает всё, и неожиданная
// форма здесь — отказ всего батча, а не «возьмём, что разобралось».
describe('extractIntentBlock: блок намерений в выводе сессии (#9)', () => {
    const close = line({ kind: 'close', issue: 9, comment: 'сделано' });
    const block = (...inner: string[]): string => [INTENTS_BEGIN, ...inner, INTENTS_END].join('\n');

    it('вывод без маркеров — намерений нет, не отказ', () => {
        expect(extractIntentBlock('Готово, тесты зелёные.')).toEqual({ kind: 'none' });
        expect(extractIntentBlock('')).toEqual({ kind: 'none' });
    });

    it('строки блока — как есть, пустые пропускаются, текст вокруг не мешает', () => {
        const out = `Отчёт сессии.\n\n${block(close, '', '  ' + close + '  ')}\r\nКонец.`;
        expect(extractIntentBlock(out)).toEqual({ kind: 'block', lines: [close, close] });
    });

    it('пустой блок — блок без намерений', () => {
        expect(extractIntentBlock(block())).toEqual({ kind: 'block', lines: [] });
    });

    it('маркер посреди строки прозы маркером не считается', () => {
        expect(extractIntentBlock(`печатаю блок ${INTENTS_BEGIN} в конце`)).toEqual({
            kind: 'none',
        });
    });

    it.each([
        ['начало без конца', `${INTENTS_BEGIN}\n${close}`, /не закрыт/],
        ['конец без начала', `${close}\n${INTENTS_END}`, /без начала/],
        ['конец раньше начала', `${INTENTS_END}\n${INTENTS_BEGIN}`, /без начала/],
        ['два блока', `${block(close)}\n${block(close)}`, /блок.* один/],
        ['вложенное начало', `${INTENTS_BEGIN}\n${block(close)}`, /внутри блока/],
        [
            'служебная метка раннера внутри',
            block(inFlightMarker('abcdef12-0000'), close),
            /служебн/,
        ],
        [
            'служебная строка с пробелами',
            block('{ "ralph" : "rejected-block", "why": "x" }'),
            /служебн/,
        ],
    ])('от противного: %s — отказ с причиной и сырым текстом', (_, out, why) => {
        const r = extractIntentBlock(out);
        expect(r.kind).toBe('rejected');
        if (r.kind !== 'rejected') return;
        expect(r.why).toMatch(why);
        expect(r.raw).toMatch(new RegExp(`${INTENTS_BEGIN}|${INTENTS_END}`));
    });

    it('мусор внутри блока проходит дальше и отвергается парсером с номером строки', () => {
        const r = extractIntentBlock(block(close, 'не json'));
        expect(r).toEqual({ kind: 'block', lines: [close, 'не json'] });
        if (r.kind !== 'block') return;
        expect(() => parseSessionRequests(r.lines.join('\n'), opts)).toThrow(/строка 2/);
    });
});

describe('serializeRejectedBlock: отказ блока доезжает до разбора батча (#9)', () => {
    it('строка отказа валит батч целиком и называет причину', () => {
        const raw = [
            line({ kind: 'close', issue: 9, comment: 'сделано' }),
            serializeRejectedBlock('блок не закрыт'),
        ].join('\n');
        expect(() => parseSessionRequests(raw, opts)).toThrow(
            /строка 2.*блок намерений в выводе сессии отвергнут.*блок не закрыт/,
        );
    });

    it('строку отказа не принять за метку начатого намерения', () => {
        expect(inFlightEntry(serializeRejectedBlock('x'))).toBeNull();
    });

    it('другая служебная строка в батче — тоже отказ, а не неизвестный kind', () => {
        expect(() => parseSessionRequests('{"ralph":"что-то"}', opts)).toThrow(/служебн/);
    });
});

// #219: живая проба — пара из каталога раннера, а не команда сессии.
describe('live-probe: разбор (#219)', () => {
    const OPTS = { labelAllowlist: ['complexity:low'] };
    const probe = (o: Record<string, unknown>) =>
        JSON.stringify({
            kind: 'live-probe',
            issue: 219,
            cli: 'claude',
            case: 'unknown-tool',
            ...o,
        });

    it('пара из каталога разбирается', () => {
        expect(parseSessionRequests(probe({}), OPTS)).toEqual([
            { kind: 'live-probe', issue: 219, cli: 'claude', case: 'unknown-tool' },
        ]);
    });

    it('незнакомый case — UnknownLiveProbeError с парой пробы и прежним сообщением', () => {
        let thrown: unknown;
        try {
            parseSessionRequests(probe({ case: 'rm-everything' }), OPTS);
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(UnknownLiveProbeError);
        const error = thrown as UnknownLiveProbeError;
        expect(error.cli).toBe('claude');
        expect(error.probeCase).toBe('rm-everything');
        expect(error.message).toMatch(/case пробы .* не из каталога/);
    });

    it('незнакомый cli — тот же класс с парой из запроса', () => {
        let thrown: unknown;
        try {
            parseSessionRequests(probe({ cli: 'codex' }), OPTS);
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(UnknownLiveProbeError);
        const error = thrown as UnknownLiveProbeError;
        expect(error.cli).toBe('codex');
        expect(error.probeCase).toBe('unknown-tool');
        expect(error.message).toMatch(/cli пробы .* не из каталога/);
    });

    it.each([
        [{ cli: 7 }, /cli пробы 7/],
        [{ case: 9 }, /case пробы 9/],
        [{ cli: 'codex', case: 9 }, /case пробы 9/],
    ])(
        'нестроковое поле пробы — обычный malformed intent, а не отказ установки: %j',
        (over, re) => {
            let thrown: unknown;
            try {
                parseSessionRequests(probe(over), OPTS);
            } catch (e) {
                thrown = e;
            }

            expect(thrown).toBeInstanceOf(Error);
            expect(thrown).not.toBeInstanceOf(UnknownLiveProbeError);
            expect((thrown as Error).message).toMatch(re);
        },
    );

    it.each([
        [{ case: 'rm-everything' }, /case пробы "rm-everything" не из каталога claude/],
        [{ case: 'offline' }, /case пробы "offline"/],
        [{ cli: 'codex' }, /cli пробы "codex" не из каталога/],
        [{ cli: 'claude; printenv' }, /cli пробы/],
        [{ command: 'printenv' }, /лишнее: command/],
        [{ args: ['x'] }, /лишнее: args/],
        [{ issue: '219' }, /номер карточки/],
        [{ case: undefined }, /case пробы undefined/],
    ])('%j — отказ разбора батча целиком', (over, re) => {
        const batch = [
            JSON.stringify({ kind: 'comment', issue: 219, comment: 'сделано' }),
            probe(over),
            JSON.stringify({ kind: 'close', issue: 219, comment: 'сделано' }),
        ].join('\n');
        expect(() => parseSessionRequests(batch, OPTS)).toThrow(re);
    });

    it('больше двух проб в батче — отказ', () => {
        const batch = [probe({}), probe({ case: 'block' }), probe({ case: 'crash' })].join('\n');
        expect(() => parseSessionRequests(batch, OPTS)).toThrow(/3 живых проб/);
    });

    it('проба — мутация: идёт в предел мутаций', () => {
        const [r] = parseSessionRequests(probe({}), OPTS);
        expect(classifySessionRequests([r]).mutations).toHaveLength(1);
    });

    it('сериализация — round-trip', () => {
        const [r] = parseSessionRequests(probe({}), OPTS);
        expect(parseSessionRequests(serializeSessionRequest(r), OPTS)).toEqual([r]);
    });
});

// Ревью 16c3: prettier развернул однообъектные примеры промпта в многострочный JSON, а такой
// блок парсер отвергает целиком — сессия, скопировавшая пример, теряла все намерения батча.
describe('примеры намерений в ralph.md — каждая строка разбирается', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'ralph.md'), 'utf-8');
    const blocks = [...text.matchAll(/^```jsonl\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);

    it('блоки jsonl есть — пустой набор не зелёный', () => {
        expect(blocks.length).toBeGreaterThanOrEqual(4);
    });

    it.each(blocks.map((b, i) => [i, b] as const))('блок %i: строка — объект JSON', (_i, block) => {
        for (const line of block.split('\n').filter((l) => l.trim() !== '')) {
            expect(() => JSON.parse(line) as unknown, line).not.toThrow();
            expect(JSON.parse(line)).toHaveProperty('kind');
        }
        expect(() =>
            parseSessionRequests(block, {
                labelAllowlist: ['complexity:low', 'complexity:medium', 'area:docs', 'area:devops'],
            }),
        ).not.toThrow();
    });
});

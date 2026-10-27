// Тесты адаптера SourceCraft: ФОРМА ЗАПРОСОВ к площадке, а не поведение швов.
//
// Разделение намеренное. Контрактный сьют (`tests/adapters-contract.test.ts`) проверяет,
// что адаптер ведёт себя как TaskSourceAdapter, и его фейковый транспорт неизбежно
// повторяет допущения адаптера о форме API — зелёный там ничего не говорит о том, поймёт
// ли запрос настоящий сервер. Здесь проверяется вторая половина: путь, метод, тело и QL
// собраны так, как их описывает OpenAPI площадки и как ответил живой сервер.
//
// Источники истины по каждому ожиданию (проверено 31.07.2026):
//   - значения фильтра статусов issue — ОТВЕТ СЕРВЕРА на невалидное значение:
//     «allowed values: open, in_progress, paused, closed, declined, duplicate».
//     Сама спека перечисляет три (open/in_progress/closed) и ВРЁТ;
//   - snake_case в фильтре против camelCase в записи (`status_slug: 'inProgress'`) —
//     асимметрия площадки, не опечатка;
//   - `ModifyLabelCollectionRequest` = `{ids|slugs}`, снятие метки — DELETE на тот же
//     путь (`sourcecraft.swagger.json`);
//   - список milestones отдаёт `items` (живой ответ), фильтр не знает ни `title`, ни
//     `name` — оба «unknown field», поэтому имя резолвится на клиенте.
import { describe, expect, it } from 'vitest';
import { createSourcecraftTaskSource } from './sourcecraft-task-source.ts';
import type { SourcecraftApi } from './sourcecraft-task-source.ts';
import { SOURCECRAFT_TOKEN_ENV } from './sourcecraft-api.ts';

const ORG = 'org';
const REPO = 'repo';
const MILESTONE = 'M1: каркас';
const MILESTONE_SLUG = 'm1-karkas';
const BRANCH = 'feature/m1';
const SHA = 'a'.repeat(40);

type Call = { method: string; path: string; body?: unknown };

type FakeServer = {
    // Карточки отдаются ТОЛЬКО на правильный slug: сервер не знает имени фазы, и
    // подстановка имени вместо slug обязана дать пусто, а не совпадение.
    issuesBySlug?: Record<string, unknown[]>;
    milestones?: unknown[];
    pulls?: unknown[];
    prSource?: { sha?: unknown } | null;
    // Страницы для проверки пагинации: массив ответов подряд.
    issuePages?: Array<{ issues: unknown[]; next_page_token?: string }>;
    // #46: ответ площадки на создание PR (несёт slug и status).
    createdPull?: unknown;
    // #37: лента комментариев PR (форма — как у площадки: author.slug, anchor у inline).
    prComments?: unknown[];
    // Ответ площадки на СОЗДАНИЕ комментария (#45): черновик отдаётся как успешно созданный.
    createdComment?: unknown;
    // Страницы ленты комментариев: тред ревью длиннее страницы — обычное дело.
    prCommentPages?: Array<{ pull_request_comments: unknown[]; next_page_token?: string }>;
    // #40: справочник меток репозитория (имя ↔ slug) и slug созданной карточки.
    labels?: unknown[];
    createdIssueSlug?: string;
    // #43: ответ на чтение одной карточки (`GET /issues/{slug}`).
    issue?: unknown;
    // #125: СЫРЫЕ страницы ленты карточки — форма ответа целиком, чтобы проверить и
    // дрейф ключа, а не только содержимое.
    issueCommentPages?: unknown[];
};

function build(server: FakeServer = {}) {
    const calls: Call[] = [];
    let pageIdx = 0;
    let commentPageIdx = 0;
    let issueCommentPageIdx = 0;

    const api: SourcecraftApi = (method, path, body) => {
        calls.push({ method, path, ...(body === undefined ? {} : { body }) });

        if (path.includes('/milestones?')) {
            // Форма ответа площадки: ключ `items`, у milestone поле `name`, не `title`.
            return { items: server.milestones ?? [] };
        }
        // #40: справочник меток — тот же ключ `items` (живой ответ площадки).
        if (path.includes('/labels?')) return { items: server.labels ?? [] };
        // Создание карточки: ответ несёт её строковый `slug`.
        if (method === 'POST' && /\/issues$/.test(path)) {
            return server.createdIssueSlug === undefined ? {} : { slug: server.createdIssueSlug };
        }
        if (/\/milestones\//.test(path)) return {};
        if (path.includes('/issues?')) {
            if (server.issuePages) {
                const page = server.issuePages[Math.min(pageIdx, server.issuePages.length - 1)];
                pageIdx += 1;
                return page;
            }
            const q = decodeURIComponent(path);
            const hit = Object.entries(server.issuesBySlug ?? {}).find(([slug]) =>
                q.includes(`milestone_slug="${slug}"`),
            );
            return { issues: hit ? hit[1] : [] };
        }
        if (method === 'POST' && /\/pulls$/.test(path)) {
            return server.createdPull ?? { slug: '7', status: 'open' };
        }
        if (method === 'POST' && /\/pulls\/\d+\/comments$/.test(path)) {
            return server.createdComment ?? { is_published: true };
        }
        if (/\/pulls\/\d+\/comments/.test(path)) {
            if (server.prCommentPages) {
                const page =
                    server.prCommentPages[
                        Math.min(commentPageIdx, server.prCommentPages.length - 1)
                    ];
                commentPageIdx += 1;
                return page;
            }
            return { pull_request_comments: server.prComments ?? [] };
        }
        if (method === 'GET' && /\/issues\/\d+\/comments\?/.test(path)) {
            const pages = server.issueCommentPages ?? [{ issue_comments: [], next_page_token: '' }];
            const page = pages[Math.min(issueCommentPageIdx, pages.length - 1)];
            issueCommentPageIdx += 1;
            return page;
        }
        if (method === 'GET' && /\/issues\/\d+$/.test(path)) return server.issue ?? {};
        if (path.includes('/pulls?')) return { pull_requests: server.pulls ?? [] };
        if (/\/pulls\/\d+$/.test(path)) return server.prSource ? { source: server.prSource } : {};
        return {};
    };

    const logs: string[] = [];
    const adapter = createSourcecraftTaskSource({
        api,
        org: ORG,
        repo: REPO,
        authorAllowlist: () => ['dev'],
        log: (line: string) => logs.push(line),
    });
    return { adapter, calls, logs };
}

const milestone = (name: string, slug: string) => ({ name, slug, status: 'open' });
const issue = (n: number) => ({
    slug: String(n),
    title: `задача ${String(n)}`,
    labels: [],
    author: { slug: 'dev' },
});

const issuesQuery = (calls: Call[]): string =>
    decodeURIComponent(calls.find((c) => c.path.includes('/issues?'))?.path ?? '');

// --- фильтр статусов ----------------------------------------------------------------

describe('фильтр статусов issue — шесть значений площадки, не два состояния GitHub', () => {
    it('listAllOpenIssues держит фазу и на in_progress, и на paused (C2)', () => {
        const { adapter, calls } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuesBySlug: { [MILESTONE_SLUG]: [issue(1)] },
        });
        adapter.listAllOpenIssues(MILESTONE);
        // `status=open` отобрал бы РОВНО статус open: карточка, взятая в работу или
        // поставленная на паузу, перестала бы держать фазу — и раннер ушёл бы сдавать
        // недоделанное.
        expect(issuesQuery(calls)).toContain('status in (open, in_progress, paused)');
    });

    it('listReadyIssues берёт только open — paused заменяет метку hold', () => {
        const { adapter, calls } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuesBySlug: { [MILESTONE_SLUG]: [issue(1)] },
        });
        adapter.listReadyIssues(MILESTONE);
        const q = issuesQuery(calls);
        expect(q).toContain('status=open');
        expect(q).not.toContain('in_progress');
    });

    // #39: вопрос «были ли у фазы задачи вообще» — это выборка БЕЗ условия по статусу.
    // Живой ответ площадки проверен: фильтр из одного `milestone_slug` валиден и отдаёт
    // карточки всех статусов, включая closed.
    it('hasAnyIssues спрашивает без условия по статусу — иначе закрытые не видны', () => {
        const { adapter, calls } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuesBySlug: { [MILESTONE_SLUG]: [issue(1)] },
        });
        expect(adapter.hasAnyIssues(MILESTONE)).toBe(true);
        const q = issuesQuery(calls);
        expect(q).toContain(`milestone_slug="${MILESTONE_SLUG}"`);
        expect(q).not.toContain('status');
    });

    it('hasAnyIssues: milestone заведён, карточек нет → false (фаза не начата)', () => {
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuesBySlug: { [MILESTONE_SLUG]: [] },
        });
        expect(adapter.hasAnyIssues(MILESTONE)).toBe(false);
    });

    it('НЕГАТИВНЫЙ: hasAnyIssues на ненайденном milestone бросает, а не отдаёт false', () => {
        // «Milestone не найден» — расхождение конфига с площадкой, и оно не то же самое,
        // что «фаза не начата»: молчаливое false подменило бы один диагноз другим.
        const { adapter } = build({ milestones: [] });
        expect(() => adapter.hasAnyIssues(MILESTONE)).toThrow(/milestone/i);
    });

    it('значения фильтра — snake_case, а не camelCase записи статуса', () => {
        const { adapter, calls } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuesBySlug: { [MILESTONE_SLUG]: [] },
        });
        adapter.listAllOpenIssues(MILESTONE);
        expect(issuesQuery(calls)).not.toContain('inProgress');
    });
});

// --- резолв milestone ---------------------------------------------------------------

describe('milestone: имя фазы из конфига ≠ slug площадки', () => {
    it('фильтр issues идёт по slug, полученному листингом, а не по имени фазы', () => {
        const { adapter, calls } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuesBySlug: { [MILESTONE_SLUG]: [issue(7)] },
        });
        expect(adapter.listReadyIssues(MILESTONE).map((i) => i.number)).toEqual([7]);
        const q = issuesQuery(calls);
        expect(q).toContain(`milestone_slug="${MILESTONE_SLUG}"`);
        expect(q).not.toContain(MILESTONE);
    });

    it('milestone фазы не найден → БРОСАЕТ (fail-closed), а не отдаёт пустую очередь', () => {
        const { adapter } = build({ milestones: [milestone('другая фаза', 'other')] });
        expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow(/milestone/i);
    });

    it('список milestones читается из `items` — ключа `milestones` в ответе нет', () => {
        const { adapter } = build({ milestones: [milestone(MILESTONE, MILESTONE_SLUG)] });
        // Дошло до issues — значит slug из `items` прочитан; иначе резолв бросил бы.
        expect(adapter.listAllOpenIssues(MILESTONE)).toEqual([]);
    });

    it('closeMilestone находит фазу по name и патчит по slug', () => {
        const { adapter, calls } = build({ milestones: [milestone(MILESTONE, MILESTONE_SLUG)] });
        adapter.closeMilestone(MILESTONE);
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch?.path).toBe(`/repos/${ORG}/${REPO}/milestones/${MILESTONE_SLUG}`);
        expect(patch?.body).toEqual({ status: 'closed' });
        // Фильтровать milestones по имени нечем: сервер не знает полей `title`/`name`.
        const list = calls.find((c) => c.path.includes('/milestones?'));
        expect(decodeURIComponent(list?.path ?? '')).not.toContain('title=');
    });
});

// --- комментарии PR (#37) ------------------------------------------------------------

describe('комментарии PR: один маршрут площадки против трёх поверхностей GitHub', () => {
    it('читает GET /pulls/{slug}/comments и разбирает ключ pull_request_comments', () => {
        const { adapter, calls } = build({
            prComments: [
                { body: '🔴 [blocker] дыра', author: { slug: 'dev' }, anchor: { path: 'a.ts' } },
            ],
        });
        expect(adapter.listPullRequestComments(55)).toEqual([
            { body: '🔴 [blocker] дыра', isSummary: false, author: 'dev' },
        ]);
        // Путь и ключ ответа — из OpenAPI площадки и её живого ответа, не из догадки.
        expect(calls.some((c) => c.method === 'GET' && c.path.includes('/pulls/55/comments'))).toBe(
            true,
        );
    });

    it('комментарий без anchor — сводка прохода (isSummary), с anchor — находка', () => {
        // Структурный признак вместо разбора формулировки: у комментария к месту в диффе
        // площадка отдаёт anchor, у сводного его нет вовсе.
        const { adapter } = build({
            prComments: [
                { body: 'сводка', author: { slug: 'dev' } },
                { body: 'находка', author: { slug: 'dev' }, anchor: { path: 'a.ts' } },
            ],
        });
        expect(adapter.listPullRequestComments(55).map((c) => c.isSummary)).toEqual([true, false]);
    });

    it('удалённые, черновики и пустые тела в ленту не попадают', () => {
        const { adapter } = build({
            prComments: [
                { body: 'удалённый', author: { slug: 'dev' }, is_deleted: true },
                { body: 'черновик', author: { slug: 'dev' }, is_published: false },
                { body: '   ', author: { slug: 'dev' } },
                { body: 'живой', author: { slug: 'dev' } },
            ],
        });
        expect(adapter.listPullRequestComments(55).map((c) => c.body)).toEqual(['живой']);
    });

    it('лента собирается со ВСЕХ страниц — тред ревью длиннее страницы обычен', () => {
        // Одиночный запрос вместо обхода страниц отдал бы первые 100 комментариев и
        // промолчал об остальных: счёт находок оказался бы заниженным, не покраснев ни
        // одним тестом. Тот же класс, что оборванная очередь карточек (#43).
        const { adapter } = build({
            prCommentPages: [
                {
                    pull_request_comments: [{ body: 'первая страница', author: { slug: 'dev' } }],
                    next_page_token: 'p2',
                },
                { pull_request_comments: [{ body: 'вторая страница', author: { slug: 'dev' } }] },
            ],
        });
        expect(adapter.listPullRequestComments(55).map((c) => c.body)).toEqual([
            'первая страница',
            'вторая страница',
        ]);
    });

    it('поля is_deleted/is_published отсутствуют — комментарий остаётся в ленте', () => {
        // Отсутствие поля означает «сервер его не прислал», а не «удалён»: трактовать
        // иначе значит выкосить обычные комментарии на первой же смене формата ответа.
        const { adapter } = build({ prComments: [{ body: 'живой', author: { slug: 'dev' } }] });
        expect(adapter.listPullRequestComments(55)).toHaveLength(1);
    });
});

// #125: ключ `issue_comments` и форма пустой ленты сверены живым ответом площадки
// 27.10.2026, а не выведены по аналогии с `pull_request_comments`.
describe('лента комментариев карточки — сверка намерения по метке (#125)', () => {
    it('читает GET /issues/{slug}/comments и разбирает ключ issue_comments', () => {
        const { adapter, calls } = build({
            issueCommentPages: [
                {
                    issue_comments: [
                        { id: 'a', body: 'первый', author: { slug: 'dev' } },
                        { id: 'b', body: 'с меткой <!-- ralph-intent:x -->' },
                    ],
                    next_page_token: '',
                },
            ],
        });
        expect(adapter.listIssueComments?.(7)).toEqual([
            'первый',
            'с меткой <!-- ralph-intent:x -->',
        ]);
        expect(
            calls.some(
                (c) =>
                    c.method === 'GET' &&
                    c.path.includes(`/repos/${ORG}/${REPO}/issues/7/comments?`),
            ),
        ).toBe(true);
    });

    it('лента собирается со ВСЕХ страниц — метка могла уехать за первую', () => {
        const { adapter } = build({
            issueCommentPages: [
                { issue_comments: [{ body: 'страница 1' }], next_page_token: 'p2' },
                { issue_comments: [{ body: 'страница 2' }], next_page_token: '' },
            ],
        });
        expect(adapter.listIssueComments?.(7)).toEqual(['страница 1', 'страница 2']);
    });

    it('пустая лента — пустой список: площадка отдаёт ключ с []', () => {
        const { adapter } = build();
        expect(adapter.listIssueComments?.(7)).toEqual([]);
    });

    it('НЕГАТИВНЫЙ: ключа нет (смена формата, чужой ключ) — отказ, а не пустая лента', () => {
        // Угаданный ключ дал бы ровно это: пустоту на каждой карточке, то есть «эффект не
        // лёг» и повтор комментария вслепую.
        const { adapter } = build({
            issueCommentPages: [{ comments: [{ body: 'с меткой' }], next_page_token: '' }],
        });
        expect(() => adapter.listIssueComments?.(7)).toThrow(/issue_comments/);
    });

    it('НЕГАТИВНЫЙ: ключ пропал на второй странице — отказ, а не половина ленты', () => {
        const { adapter } = build({
            issueCommentPages: [
                { issue_comments: [{ body: 'страница 1' }], next_page_token: 'p2' },
                { next_page_token: '' },
            ],
        });
        expect(() => adapter.listIssueComments?.(7)).toThrow(/issue_comments/);
    });

    it('НЕГАТИВНЫЙ: сбой транспорта долетает до вызывающего', () => {
        const adapter = createSourcecraftTaskSource({
            api: () => {
                throw new Error('SourceCraft GET: HTTP 502');
            },
            org: ORG,
            repo: REPO,
            authorAllowlist: () => ['dev'],
        });
        expect(() => adapter.listIssueComments?.(7)).toThrow(/502/);
    });
});

describe('комментарий в PR: публикация и якорь — эмпирика площадки (#45)', () => {
    const post = (calls: Call[]) => calls.find((c) => c.method === 'POST');

    it('шлёт POST на /pulls/{slug}/comments с publish: true', () => {
        const { adapter, calls } = build();
        adapter.commentOnPullRequest(55, { body: '🔴 [blocker] дыра' });
        const req = post(calls);
        expect(req?.path).toContain('/pulls/55/comments');
        // `publish` передаётся ЯВНО, хотя спека обещает «defaults to true»: живой сервер
        // создал комментарий черновиком (#23), а черновик виден только автору — то есть
        // для человека и для счёта находок его нет.
        expect(req?.body).toMatchObject({ body: '🔴 [blocker] дыра', publish: true });
    });

    it('якорь — path + position {from, to, side}, одна строка вырожденным диапазоном', () => {
        const { adapter, calls } = build();
        adapter.commentOnPullRequest(55, { body: 'x', anchor: { path: 'src/a.ts', line: 42 } });
        expect(post(calls)?.body).toMatchObject({
            anchor: { path: 'src/a.ts', position: { from: 42, to: 42, side: 'source' } },
        });
    });

    // #41: значение старой стороны у площадки не проверено — угаданное повесило бы
    // замечание к удалённой строке на чужой код. Отказ, а ядро спустится к сводке с местом.
    it('#41 якорь со стороной LEFT — отказ без запроса, а не угаданная сторона', () => {
        const { adapter, calls } = build();
        expect(() =>
            adapter.commentOnPullRequest(55, {
                body: 'x',
                anchor: { path: 'src/a.ts', line: 42, side: 'LEFT' },
            }),
        ).toThrow(/удалённой строке/);
        expect(post(calls)).toBeUndefined();
    });

    it('без якоря поля anchor в теле нет вовсе — это сводка прохода', () => {
        const { adapter, calls } = build();
        adapter.commentOnPullRequest(55, { body: 'сводка' });
        expect(post(calls)?.body).not.toHaveProperty('anchor');
    });

    // #575: ядро откатывается «строка → файл → сводка». Реализация, у которой комментария
    // уровня файла нет, обязана ОТКАЗАТЬ на файловом якоре, а не тихо превратить его
    // в сводку: сводку кладёт ядро, и только оно об этом пишет в лог. Молчаливая подмена
    // здесь дала бы «ступень 2 сработала» в логе при фактической ступени 3.
    it('#575 якорь без строки не поддерживается площадкой → отказ, ядро уйдёт в сводку', () => {
        const { adapter, calls } = build();
        expect(() =>
            adapter.commentOnPullRequest(55, { body: 'x', anchor: { path: 'src/a.ts' } }),
        ).toThrow(/файла/i);
        expect(calls.find((c) => c.method === 'POST')).toBeUndefined();
    });

    it('НЕГАТИВНЫЙ: ответ с is_published:false → отказ, а не «успешно создано»', () => {
        // Черновик отдаётся ответом как обычный созданный комментарий: отличить его можно
        // только по флагу. Молчаливое «ок» здесь и есть исходный дефект #23.
        const { adapter } = build({ createdComment: { is_published: false } });
        expect(() => adapter.commentOnPullRequest(55, { body: 'x' })).toThrow(/черновик/i);
    });

    it('ответ без поля is_published отказом не считается — это смена формата', () => {
        const { adapter } = build({ createdComment: {} });
        expect(() => adapter.commentOnPullRequest(55, { body: 'x' })).not.toThrow();
    });
});

describe('карточка целиком: статус для сверки перед взятием (#43)', () => {
    const issue = (status: unknown) => ({ slug: '7', title: 'т', description: 'б', status });

    it.each([
        ['open', true],
        ['closed', false],
        // `paused` заменяет `hold`: из очереди выпадает, значит и не берётся.
        ['paused', false],
        ['in_progress', false],
    ])('статус строкой «%s» → open=%s', (status, open) => {
        const { adapter } = build({ issue: issue(status) });
        expect(adapter.getIssue(7)).toEqual({ number: 7, title: 'т', body: 'б', open });
    });

    it('статус объектом со slug — та же сверка', () => {
        const { adapter } = build({ issue: issue({ slug: 'closed', name: 'Закрыта' }) });
        expect(adapter.getIssue(7).open).toBe(false);
    });

    it('НЕГАТИВНЫЙ: статуса нет или форма незнакома — поле не ставится («не знаю»)', () => {
        // «Закрыта» по догадке опустошила бы очередь, и фаза ушла бы в сдачу несделанной.
        expect('open' in build({ issue: issue(undefined) }).adapter.getIssue(7)).toBe(false);
        expect('open' in build({ issue: issue(42) }).adapter.getIssue(7)).toBe(false);
    });
});

describe('статус вехи для адреса накопителя (#65)', () => {
    const withStatus = (status: unknown) => ({ name: MILESTONE, slug: MILESTONE_SLUG, status });

    it.each([
        ['open', true],
        ['closed', false],
    ])('статус строкой «%s» → %s', (status, open) => {
        const { adapter } = build({ milestones: [withStatus(status)] });
        expect(adapter.isMilestoneOpen(MILESTONE)).toBe(open);
    });

    it('статус объектом со slug читается так же, как у карточки', () => {
        const { adapter } = build({
            milestones: [withStatus({ slug: 'closed', name: 'Закрыта' })],
        });
        expect(adapter.isMilestoneOpen(MILESTONE)).toBe(false);
    });

    it('НЕГАТИВНЫЙ: статуса нет или он незнаком — отказ, а не «открыта»', () => {
        // Молчаливое `true` клало бы находки в разобранный том — это и есть #65.
        expect(() =>
            build({ milestones: [withStatus(undefined)] }).adapter.isMilestoneOpen(MILESTONE),
        ).toThrow(/неизвестным статусом/);
        expect(() =>
            build({ milestones: [withStatus('archived')] }).adapter.isMilestoneOpen(MILESTONE),
        ).toThrow(/неизвестным статусом/);
    });

    it('НЕГАТИВНЫЙ: вехи нет на площадке — отказ с её именем', () => {
        const { adapter } = build({ milestones: [] });
        expect(() => adapter.isMilestoneOpen(MILESTONE)).toThrow(/не найден/);
    });
});

describe('создание PR: публикация обязана быть явной (#46)', () => {
    it('POST /pulls с source/target и publish: true', () => {
        const { adapter, calls } = build({ createdPull: { slug: '7', status: 'open' } });
        expect(adapter.createPullRequest({ branch: BRANCH, title: 'feat: M1', body: 'тело' })).toBe(
            7,
        );
        const req = calls.find((c) => c.method === 'POST');
        expect(req?.path).toMatch(/\/pulls$/);
        // Спека площадки прямо говорит «publish default: false = draft» — без явного флага
        // раннер завёл бы черновик, а гейт прочитал бы его как «PR нет».
        expect(req?.body).toMatchObject({
            title: 'feat: M1',
            description: 'тело',
            source_branch: BRANCH,
            target_branch: 'main',
            publish: true,
        });
    });

    it('НЕГАТИВНЫЙ: ответ со статусом draft → отказ, а не «PR создан»', () => {
        const { adapter } = build({ createdPull: { slug: '7', status: 'draft' } });
        expect(() => adapter.createPullRequest({ branch: BRANCH, title: 'т', body: 'б' })).toThrow(
            /черновик/i,
        );
    });

    it('номер не отдан — null, но не отказ: PR создан, повтор наплодил бы дубли', () => {
        const { adapter } = build({ createdPull: { status: 'open' } });
        expect(adapter.createPullRequest({ branch: BRANCH, title: 'т', body: 'б' })).toBeNull();
    });
});

// --- пагинация ----------------------------------------------------------------------

describe('пагинация: страница ≠ вся очередь', () => {
    it('issues собираются со всех страниц по next_page_token', () => {
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuePages: [
                { issues: [issue(1)], next_page_token: 'p2' },
                { issues: [issue(2)], next_page_token: '' },
            ],
        });
        // Оборванная на первой странице выборка — тот же класс отказа, что и неверный
        // фильтр: «фаза готова», пока хвост очереди не прочитан.
        expect(adapter.listAllOpenIssues(MILESTONE).map((i) => i.number)).toEqual([1, 2]);
    });

    // #19: у обхода страниц ДВА способа не сойтись, и оба до сих пор были только в коде —
    // ни один не сторожил тест. Обрыв выборки здесь стоит дороже, чем кажется: неполная
    // очередь читается петлёй как «фаза готова» (C2), то есть молчаливое урезание сдаёт
    // фазу с незакрытой работой. У GitHub-реализации та же дыра закрыта пределом
    // `--limit` и отказом на равенстве (core/orchestrator.ts) — свойство одно на обе.
    it('НЕГАТИВНЫЙ: сервер повторил page_token → отказ, а не собранная половина', () => {
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuePages: [
                { issues: [issue(1)], next_page_token: 'p2' },
                // Последняя страница фейка отдаётся снова и снова — ровно так выглядит
                // зациклившийся сервер: тот же токен на второй и третьей итерации.
                { issues: [issue(2)], next_page_token: 'p3' },
            ],
        });
        expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow(/ТОТ ЖЕ page_token/);
    });

    it('НЕГАТИВНЫЙ: обход не сошёлся за предел страниц → отказ, а не обрыв выборки', () => {
        // Токен каждый раз НОВЫЙ — повторение не срабатывает, и выборка упирается уже
        // в предел числа страниц. Второй способ оборваться, и он тоже обязан быть громким.
        const calls: string[] = [];
        let page = 0;
        const api = ((method: string, path: string) => {
            calls.push(`${method} ${path}`);
            if (path.includes('/milestones?'))
                return { items: [milestone(MILESTONE, MILESTONE_SLUG)] };
            if (path.includes('/issues?')) {
                page += 1;
                return { issues: [issue(page)], next_page_token: `p${String(page)}` };
            }
            return {};
        }) as SourcecraftApi;
        const adapter = createSourcecraftTaskSource({
            api,
            org: ORG,
            repo: REPO,
            authorAllowlist: () => ['owner'],
        });
        expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow(/не сошёлся за/);
    });
});

describe('пагинация: неизвестность отличается от конца данных (#43)', () => {
    it('НЕГАТИВНЫЙ: сервер повторил токен → отказ, а не молчаливая половина выборки', () => {
        // Повторённый токен означает «сервер ведёт себя не по спеке»: сколько карточек
        // осталось за кадром — неизвестно. Отдать собранное как полный ответ = отдать
        // неполную очередь, которую петля прочитает как «фаза готова» (C2).
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuePages: [
                { issues: [issue(1)], next_page_token: 'p2' },
                { issues: [issue(2)], next_page_token: 'p2' },
            ],
        });
        expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow(/page_token/i);
    });

    // #44: сам токен в сообщении опознаёт страницу, на которой сервер зациклился, но
    // целиком он в строку лога не нужен — у площадки он длинный. Обрезка проверяется
    // отдельно от ветки отказа: фикстура выше короче предела, то есть ветку `> 40` она
    // не исполняет вовсе, и порог мог бы уехать незамеченным.
    it('НЕГАТИВНЫЙ: длинный повторённый токен показан обрезком, а не целиком', () => {
        const long = `tok-${'x'.repeat(60)}`;
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuePages: [
                { issues: [issue(1)], next_page_token: long },
                { issues: [issue(2)], next_page_token: long },
            ],
        });
        expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow(
            new RegExp(`${long.slice(0, 40)}…`),
        );
        expect(() => adapter.listAllOpenIssues(MILESTONE)).not.toThrow(new RegExp(long));
    });

    it('короткий повторённый токен показан целиком — обрезка не съедает опознавание', () => {
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuePages: [
                { issues: [issue(1)], next_page_token: 'p2' },
                { issues: [issue(2)], next_page_token: 'p2' },
            ],
        });
        // Многоточие у короткого токена означало бы, что обрезка сработала там, где
        // обрезать нечего, — и опознать страницу в логе стало бы нечем.
        expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow(/\(p2\)/);
    });

    it('штатный конец (пустой токен) по-прежнему отдаёт собранное', () => {
        // Обратная сторона: отказ обязан отличать «сервер сломался» от «данные кончились»,
        // иначе барьер съест нормальную работу.
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuePages: [
                { issues: [issue(1)], next_page_token: 'p2' },
                { issues: [issue(2)], next_page_token: '' },
            ],
        });
        expect(adapter.listAllOpenIssues(MILESTONE).map((i) => i.number)).toEqual([1, 2]);
    });

    it('ответ вовсе без поля токена — тоже штатный конец, а не отказ', () => {
        // Поле может отсутствовать (последняя страница у части ручек): пустая строка и
        // отсутствие поля — одно и то же «больше нет».
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuePages: [{ issues: [issue(1)] }],
        });
        expect(adapter.listAllOpenIssues(MILESTONE).map((i) => i.number)).toEqual([1]);
    });
});

// --- метки --------------------------------------------------------------------------

describe('метка blocked: форма запроса по ModifyLabelCollectionRequest', () => {
    const withPr = () => build({ pulls: [{ slug: '42', labels: [] }] });

    it('addBlockedLabel: POST на labels с телом {slugs}', () => {
        const { adapter, calls } = withPr();
        adapter.addBlockedLabel(BRANCH);
        const call = calls.find((c) => c.path.endsWith('/labels'));
        expect(call).toEqual({
            method: 'POST',
            path: `/repos/${ORG}/${REPO}/pulls/42/labels`,
            body: { slugs: ['blocked'] },
        });
    });

    it('removeBlockedLabel: DELETE на тот же путь — маршрута /labels/remove в API нет', () => {
        const { adapter, calls } = withPr();
        adapter.removeBlockedLabel(BRANCH);
        const call = calls.find((c) => c.path.endsWith('/labels'));
        expect(call).toEqual({
            method: 'DELETE',
            path: `/repos/${ORG}/${REPO}/pulls/42/labels`,
            body: { slugs: ['blocked'] },
        });
        expect(calls.some((c) => c.path.includes('/labels/remove'))).toBe(false);
    });
});

// --- TOCTOU -------------------------------------------------------------------------

describe('мердж: неспособность верифицировать голову = отказ', () => {
    it('sha головы не пришёл → БРОСАЕТ, а не мерджит вслепую', () => {
        const { adapter } = build({ pulls: [], prSource: null });
        // Дыра была в `if (actual && actual !== headSha)`: пустой `actual` (ответ без
        // `source.sha`, `{}` на пустое тело) молча пропускал проверку и мердж уходил на
        // непроверенную голову — то есть ровно тот исход, который проверка и запрещает.
        expect(() => adapter.mergePullRequest(42, SHA)).toThrow(/верифиц|уехала|sha/i);
    });

    it('sha совпал → мерджит', () => {
        const { adapter, calls } = build({ prSource: { sha: SHA } });
        adapter.mergePullRequest(42, SHA);
        expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/merge'))).toBe(true);
    });

    // #49: тот же маршрут отдаёт голову ГЕЙТУ — до этого гейт читал её сам через `gh`,
    // которого на площадке нет: три ретрая и 'not-merged' навсегда, мердж-путь мёртв.
    it('pullRequestHeadSha: голова из GET /pulls/{n} → source.sha', () => {
        const { adapter, calls } = build({ prSource: { sha: SHA } });
        expect(adapter.pullRequestHeadSha(42)).toBe(SHA);
        expect(calls.some((c) => c.method === 'GET' && c.path.endsWith('/pulls/42'))).toBe(true);
    });

    it('pullRequestHeadSha: площадка не вернула source.sha → БРОСАЕТ', () => {
        const { adapter } = build({ prSource: null });
        expect(() => adapter.pullRequestHeadSha(42)).toThrow(/source\.sha|прочитать/i);
    });

    // Мердж и гейт обязаны спрашивать голову ОДНИМ чтением: разъехавшись, они сверяли бы
    // мердж не с тем, что прогоняли чеки. Метод шва при этом уходит в гейт ссылкой, без
    // приёмника, — обращение к `this` внутри реализации было бы TypeError'ом на мердж-пути.
    it('метод шва работает, будучи оторванным от объекта (уходит в гейт ссылкой)', () => {
        const { adapter } = build({ prSource: { sha: SHA } });
        const headOf = adapter.pullRequestHeadSha;
        expect(headOf(42)).toBe(SHA);
        const mergeOf = adapter.mergePullRequest;
        expect(() => mergeOf(42, SHA)).not.toThrow();
    });
});

// --- форма slug ---------------------------------------------------------------------

describe('нечисловой slug карточки — ошибка, а не «карточки не существует»', () => {
    it('listAllOpenIssues бросает вместо молчаливой потери', () => {
        const { adapter } = build({
            milestones: [milestone(MILESTONE, MILESTONE_SLUG)],
            issuesBySlug: {
                [MILESTONE_SLUG]: [{ slug: 'abc', title: 'x', author: { slug: 'dev' } }],
            },
        });
        // Молчаливый отброс одинаково уменьшал бы и «готовые», и «все открытые» — С2
        // сравнивает эти множества и ослеп бы синхронно с обеих сторон.
        expect(() => adapter.listAllOpenIssues(MILESTONE)).toThrow(/slug/i);
    });
});

// --- намерения кодер-сессии (#40) ---------------------------------------------------

describe('намерения кодер-сессии: формы запросов площадки', () => {
    const label = (name: string, slug: string) => ({ name, slug });

    it('комментарий уходит полем body, а не строкой команды', () => {
        const { adapter, calls } = build();
        adapter.commentOnIssue(7, 'что сделано; и `бэктики`, и "кавычки"');
        const call = calls.find((c) => c.path.endsWith('/issues/7/comments'));
        expect(call?.method).toBe('POST');
        // Тело — JSON-поле: шелла в этом пути нет как класса, экранировать нечего (C3).
        expect(call?.body).toEqual({ body: 'что сделано; и `бэктики`, и "кавычки"' });
    });

    it('закрытие — PATCH со status_slug, значение camelCase-регистра записи', () => {
        const { adapter, calls } = build();
        adapter.closeIssue(7);
        const call = calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/7'));
        expect(call?.body).toEqual({ status_slug: 'closed' });
    });

    it('blocked на карточке — slugs, как у меток PR (поля labels в теле нет)', () => {
        const { adapter, calls } = build({ labels: [label('blocked', 'blocked')] });
        adapter.blockIssue(9);
        const call = calls.find((c) => c.path.endsWith('/issues/9/labels'));
        expect(call?.method).toBe('POST');
        expect(call?.body).toEqual({ slugs: ['blocked'] });
    });

    it('createIssue резолвит ИМЕНА меток в slug площадки листингом, а не формулой', () => {
        // Автослуг площадки теряет двоеточие (`complexitylow`), а заведён `complexity-low`.
        // Вывести slug из имени — угадать чужое решение; поэтому только листинг.
        const { adapter, calls } = build({
            labels: [
                label('complexity:low', 'complexity-low'),
                label('area:devops', 'area-devops'),
            ],
            createdIssueSlug: '42',
        });
        const num = adapter.createIssue({
            title: 'Течёт лимит',
            body: 'симптом, причина, критерий',
            labels: ['complexity:low', 'area:devops'],
        });
        expect(num).toBe(42);
        const call = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
        expect(call?.body).toEqual({
            title: 'Течёт лимит',
            // Тело карточки у площадки — `description`, не `body`.
            description: 'симптом, причина, критерий',
            label_slugs: ['complexity-low', 'area-devops'],
        });
    });

    it('вехи не просили — в теле её и нет: адрес ставит вызывающий, а не адаптер', () => {
        const { adapter, calls } = build({
            labels: [label('area:devops', 'area-devops')],
            createdIssueSlug: '42',
        });
        adapter.createIssue({ title: 'т', body: 'б', labels: ['area:devops'] });
        const call = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
        expect(JSON.stringify(call?.body)).not.toMatch(/milestone/);
    });

    it('веха задана — адресуется ID, а не slug: имя площадка в этом поле не понимает', () => {
        const { adapter, calls } = build({
            labels: [label('area:devops', 'area-devops')],
            milestones: [{ ...milestone('Бэклог ревью 1', 'beklog-reviu-1'), id: 'uuid-1' }],
            createdIssueSlug: '42',
        });
        adapter.createIssue({
            title: 'т',
            body: 'б',
            labels: ['area:devops'],
            milestone: 'Бэклог ревью 1',
        });
        const call = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
        expect(call?.body).toEqual({
            title: 'т',
            description: 'б',
            label_slugs: ['area-devops'],
            milestone_id: 'uuid-1',
        });
    });

    it('НЕГАТИВНЫЙ: у вехи нет id → карточка без адреса, а не запрос с пустым milestone_id', () => {
        // Ревью PR !6: `id` брался из ответа без проверки, и веха без него давала
        // `milestone_id: ""`. Площадка такой запрос отвергает, отказ летит наверх — и
        // карточка теряется ровно там, где правило обещает обратное.
        const { adapter, calls, logs } = build({
            labels: [label('area:devops', 'area-devops')],
            milestones: [milestone('Бэклог ревью 1', 'beklog-reviu-1')],
            createdIssueSlug: '42',
        });
        expect(
            adapter.createIssue({
                title: 'т',
                body: 'б',
                labels: ['area:devops'],
                milestone: 'Бэклог ревью 1',
            }),
        ).toBe(42);
        const call = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
        expect(JSON.stringify(call?.body)).not.toMatch(/milestone/);
        expect(logs.join('\n')).toMatch(/Бэклог ревью 1/);
    });

    it('НЕГАТИВНЫЙ: вехи из конфига на площадке нет → карточка без неё, но громко в лог', () => {
        // Отказ здесь означал бы потерянную находку: адрес — удобство чтения бэклога,
        // сама карточка дороже. Молчать при этом нельзя — ключ конфига врёт, и узнать
        // об этом человек может только из лога.
        const { adapter, calls, logs } = build({
            labels: [label('area:devops', 'area-devops')],
            milestones: [],
            createdIssueSlug: '42',
        });
        expect(
            adapter.createIssue({
                title: 'т',
                body: 'б',
                labels: ['area:devops'],
                milestone: 'Бэклог ревью 1',
            }),
        ).toBe(42);
        const call = calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
        expect(JSON.stringify(call?.body)).not.toMatch(/milestone/);
        expect(logs.join('\n')).toMatch(/Бэклог ревью 1/);
    });

    it('НЕГАТИВНЫЙ: метки нет в репозитории → отказ, а не карточка без меток', () => {
        const { adapter } = build({ labels: [], createdIssueSlug: '42' });
        expect(() =>
            adapter.createIssue({ title: 'т', body: 'б', labels: ['area:devops'] }),
        ).toThrow(/метка/i);
    });

    it('номер новой карточки не отдан — null, а не отказ (карточка-то создана)', () => {
        const { adapter } = build({ labels: [label('area:devops', 'area-devops')] });
        expect(adapter.createIssue({ title: 'т', body: 'б', labels: ['area:devops'] })).toBeNull();
    });
});

// #269: проводка чека PR у площадки. Отдельный модуль (`sourcecraft-ci-checks.ts`) читает
// его сам, но координаты репозитория ему передаёт ЭТОТ адаптер — перепутанные `org`/`repo`
// или потерянная делегация дадут 404, три «сбоя чтения» подряд и стоп петли, а набор
// останется зелёным (находка ревью).
describe('чек PR у площадки: путь запроса собран из тех же координат (#269)', () => {
    it('pullRequestChecks идёт на merge-checks нужного репозитория', () => {
        const { adapter, calls } = build({});
        // Фейковый сервер этого маршрута не знает и отдаёт `{}` — разбор такое отвергает
        // (форма ответа), и это ровно то, что нужно: предмет теста — путь запроса.
        expect(() => adapter.pullRequestChecks?.(7)).toThrow(/ci_workflows/);
        expect(calls.some((c) => c.path === `/repos/${ORG}/${REPO}/pulls/7/merge-checks`)).toBe(
            true,
        );
    });

    it('redCheckDiagnosis идёт на прогон нужного репозитория', () => {
        const { adapter, calls } = build({});
        adapter.redCheckDiagnosis?.({
            workflow: 'gate',
            runId: '356',
            state: 'failed',
            rawStatus: 'failed',
        });
        expect(calls.some((c) => c.path === `/repos/${ORG}/${REPO}/cicd/runs/356`)).toBe(true);
    });
});

// #56: токен площадки обязан попасть в редакцию вывода упавшей сессии. Ядро имён площадок
// не перечисляет — оно спрашивает шов, и шов называет ту же переменную, из которой
// транспорт берёт токен.
describe('secretEnvNames: секрет площадки объявляет сам шов (#56)', () => {
    it('по умолчанию — переменная, из которой транспорт берёт токен', () => {
        const { adapter } = build({});
        expect(adapter.secretEnvNames()).toEqual([SOURCECRAFT_TOKEN_ENV]);
    });

    it('переопределённое имя переменной объявляется вместо дефолтного', () => {
        const adapter = createSourcecraftTaskSource({
            api: () => ({}),
            org: ORG,
            repo: REPO,
            authorAllowlist: () => [],
            tokenEnv: 'MY_SC_TOKEN',
        });
        expect(adapter.secretEnvNames()).toEqual(['MY_SC_TOKEN']);
    });
});

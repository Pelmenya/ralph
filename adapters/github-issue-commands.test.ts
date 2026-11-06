// #72: тесты команд форжа по карточкам — рядом с кодом, куда он переехал из
// `core/orchestrator.ts`. Поведенческие сьюты петли (`core/orchestrator.test.ts`,
// сценарные прогоны) остались нетронутыми: функции возвращаются под теми же именами и с
// теми же DI-хвостами, и через ре-экспорт оркестратора они вызываются как раньше.
//
// Здесь проверяется то, чего сьюты петли доказать не могут: модуль САМОДОСТАТОЧЕН —
// собирается из синтетического env, без оркестратора и его боевого конфига. Это и есть
// контракт переезда: адаптер уедет в канон отдельно от ядра.
import { describe, expect, it, vi } from 'vitest';

import { createGithubIssueCommands } from './github-issue-commands.ts';

const shq = (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// Побочки по умолчанию громко падают: команда, ушедшая мимо подменённого канала, роняет
// тест, а не уходит в настоящий форж (тот же приём, что у соседних адаптеров).
function make(over: Partial<Parameters<typeof createGithubIssueCommands>[0]> = {}) {
    return createGithubIssueCommands({
        sh: () => {
            throw new Error('sh не подменён в тесте');
        },
        shArgv: () => {
            throw new Error('shArgv не подменён в тесте');
        },
        forgeJson: () => {
            throw new Error('forgeJson не подменён в тесте');
        },
        shq,
        log: () => {},
        fail: (msg: string) => {
            throw new Error(msg);
        },
        getAuthorAllowlist: () => ['owner'],
        getProjectSyncScript: () => '/consumer/tools/board-sync.mjs',
        ...over,
    });
}

const issue = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: `#${String(number)}`,
    labels: [],
    author: { login: 'owner' },
    ...over,
});

describe('checkAuth — форж авторизован', () => {
    it('спрашивает статус авторизации у CLI форжа', () => {
        const sh = vi.fn(() => '');
        make({ sh }).checkAuth();
        expect(sh).toHaveBeenCalledWith('gh auth status');
    });

    it('fail-closed: отказ CLI пробрасывается — preflight обязан встать', () => {
        const sh = vi.fn(() => {
            throw new Error('not logged in');
        });
        expect(() => make({ sh }).checkAuth()).toThrow(/not logged in/);
    });
});

describe('openIssues — рабочая очередь фазы', () => {
    it('имя вехи уходит через shq, предел выборки задан явно', () => {
        const forgeJsonFn = vi.fn((_cmd: string) => [] as never);
        make().openIssues("Фаза 'X'", { forgeJsonFn });
        const cmd = forgeJsonFn.mock.calls[0][0];
        expect(cmd).toContain(shq("Фаза 'X'"));
        expect(cmd).toContain('--state open');
        // #19: без явного предела форж молча отдал бы первые 30 карточек, и «полный
        // список» полным бы не был.
        expect(cmd).toMatch(/--limit \d+/);
    });

    it('отсеивает blocked и чужих авторов, сортирует по возрастанию номера', () => {
        const forgeJsonFn = vi.fn(() => [
            issue(9),
            issue(3),
            issue(5, { labels: [{ name: 'blocked' }] }),
            issue(7, { author: { login: 'stranger' } }),
        ]);
        const out = make().openIssues('Фаза X', { forgeJsonFn } as never);
        expect(out.map((i) => i.number)).toEqual([3, 9]);
    });

    it('`human` здесь НЕ фильтруется — фильтр живёт в ядре поверх шва (#133)', () => {
        const forgeJsonFn = vi.fn(() => [issue(4, { labels: [{ name: 'human' }] })]);
        const out = make().openIssues('Фаза X', { forgeJsonFn } as never);
        expect(out.map((i) => i.number)).toEqual([4]);
    });

    it('отказ форжа уходит в fail с диагнозом, а не в пустую очередь', () => {
        const forgeJsonFn = vi.fn(() => {
            throw new Error('сеть легла');
        });
        expect(() => make().openIssues('Фаза X', { forgeJsonFn })).toThrow(/сеть легла/);
    });

    it('ответ, упёршийся в предел, — отказ, а не «столько и было»', () => {
        const many = Array.from({ length: 200 }, (_, i) => issue(i + 1));
        const forgeJsonFn = vi.fn(() => many);
        expect(() => make().openIssues('Фаза X', { forgeJsonFn } as never)).toThrow(
            /предела выборки/,
        );
    });

    it('#72-ревью: урезание диагностируется СВОИМ текстом, а не «gh упал / проверь auth»', () => {
        // Пока проверка полноты стояла внутри try, её отказ выходил наружу обёрнутым в
        // диагноз сбоя `gh`: «упал (после ретраев) … Проверь: gh auth status, milestone
        // существует». Подсказка уводила в сторону — чинить надо разбор вехи, а не логин.
        // Подстрока `/предела выборки/` доезжала в обоих случаях, поэтому регресс диагноза
        // сторожит именно этот ассерт, а не тест выше.
        const many = Array.from({ length: 200 }, (_, i) => issue(i + 1));
        let caught = '';
        try {
            make().openIssues('Фаза X', { forgeJsonFn: (() => many) as never });
        } catch (e) {
            caught = (e as Error).message;
        }
        expect(caught).toMatch(/предела выборки/);
        expect(caught).not.toMatch(/после ретраев|gh auth status/);
    });

    it('список доверенных авторов читается ЛЕНИВО — конфиг заполняется позже сборки', () => {
        let allow: string[] = [];
        const cmds = make({ getAuthorAllowlist: () => allow });
        const forgeJsonFn = vi.fn(() => [issue(1)]);
        expect(cmds.openIssues('Фаза X', { forgeJsonFn } as never)).toEqual([]);
        allow = ['owner'];
        expect(cmds.openIssues('Фаза X', { forgeJsonFn } as never)).toHaveLength(1);
    });
});

describe('allOpenIssues / hasAnyIssues / milestoneLabels', () => {
    it('allOpenIssues не фильтрует ничего — на его пустоте стоит разрешение мерджа (C2)', () => {
        const forgeJsonFn = vi.fn(() => [
            issue(5, { labels: [{ name: 'blocked' }] }),
            issue(7, { author: { login: 'stranger' } }),
        ]);
        expect(make().allOpenIssues('Фаза X', { forgeJsonFn } as never)).toHaveLength(2);
    });

    it('allOpenIssues: отказ форжа БРОСАЕТ — вызывающий обязан остановиться', () => {
        const forgeJsonFn = vi.fn(() => {
            throw new Error('форж лёг');
        });
        expect(() => make().allOpenIssues('Фаза X', { forgeJsonFn })).toThrow(/форж лёг/);
    });

    it('hasAnyIssues смотрит карточки ЛЮБОГО статуса (C5) и отвечает булевым', () => {
        const forgeJsonFn = vi.fn((_cmd: string) => [{ number: 1 }]);
        expect(make().hasAnyIssues('Фаза X', { forgeJsonFn } as never)).toBe(true);
        expect(forgeJsonFn.mock.calls[0][0]).toContain('--state all');
    });

    it('hasAnyIssues: пустой ответ = фазу не начинали', () => {
        expect(make().hasAnyIssues('Фаза X', { forgeJsonFn: () => [] as never })).toBe(false);
    });

    it('milestoneLabels отдаёт плоский список ИМЁН с повторами', () => {
        const forgeJsonFn = vi.fn(() => [
            { labels: [{ name: 'complexity:high' }, { name: '' }] },
            { labels: [{ name: 'complexity:high' }] },
            {},
        ]);
        expect(make().milestoneLabels('Фаза X', { forgeJsonFn } as never)).toEqual([
            'complexity:high',
            'complexity:high',
        ]);
    });

    it('milestoneLabels: урезанный ответ — отказ, а не «сложных задач нет» (#37)', () => {
        const many = Array.from({ length: 200 }, () => ({ labels: [] }));
        expect(() =>
            make().milestoneLabels('Фаза X', { forgeJsonFn: () => many as never }),
        ).toThrow(/предела выборки/);
    });
});

describe('findOpenIssue — восстановление публикации по точному заголовку', () => {
    it('возвращает ровно одну карточку, null при отсутствии и отклоняет неоднозначность', () => {
        const forgeJsonFn = vi.fn((_cmd: string) => [
            issue(3, { title: 'точный' }),
            issue(5, { title: 'другой' }),
        ]);
        const commands = make();
        expect(commands.findOpenIssue('точный', { forgeJsonFn } as never)?.number).toBe(3);
        expect(commands.findOpenIssue('отсутствует', { forgeJsonFn } as never)).toBeNull();
        expect(forgeJsonFn.mock.calls[0][0]).toContain('--state open');
        expect(forgeJsonFn.mock.calls[0][0]).not.toContain('--milestone');

        const duplicates = () => [issue(3, { title: 'точный' }), issue(5, { title: 'точный' })];
        expect(() =>
            commands.findOpenIssue('точный', { forgeJsonFn: duplicates } as never),
        ).toThrow(/Несколько открытых/);
    });

    it('сбой чтения пробрасывается, а не превращается в отсутствие карточки', () => {
        const forgeJsonFn = () => {
            throw new Error('forge unavailable');
        };
        expect(() => make().findOpenIssue('точный', { forgeJsonFn })).toThrow(/forge unavailable/);
    });
});

describe('issueDetails — тело карточки для кодер-сессии (#50)', () => {
    it('читает заголовок и тело по номеру', () => {
        const forgeJsonFn = vi.fn((_cmd: string) => ({ title: 'Заголовок', body: 'Тело' }));
        expect(make().issueDetails(7, { forgeJsonFn } as never)).toEqual({
            number: 7,
            title: 'Заголовок',
            body: 'Тело',
        });
        expect(forgeJsonFn.mock.calls[0][0]).toContain('gh issue view 7');
    });

    it('#43 статус карточки: OPEN/CLOSED → open, незнакомый — поле не ставится', () => {
        const read = (state: unknown) =>
            make().issueDetails(7, { forgeJsonFn: () => ({ title: 'т', state }) as never });
        expect(read('OPEN').open).toBe(true);
        expect(read('CLOSED').open).toBe(false);
        expect('open' in read(undefined)).toBe(false);
        expect('open' in read('MERGED')).toBe(false);
    });

    it('пустой заголовок — ОТКАЗ: сессия без тела задачи выдумает себе работу', () => {
        expect(() => make().issueDetails(7, { forgeJsonFn: () => ({}) as never })).toThrow(
            /не прочиталась/,
        );
    });

    it('пустое тело при живом заголовке — законно, отказом не считается', () => {
        const forgeJsonFn = () => ({ title: 'Есть' }) as never;
        expect(make().issueDetails(7, { forgeJsonFn }).body).toBe('');
    });
});

describe('намерения кодер-сессии: мутации через argv, без шелла (#40)', () => {
    it('commentOnIssue / closeIssue / blockIssue', () => {
        const runArgvFn = vi.fn(() => '');
        const cmds = make();
        // Тело комментария пишет модель, читавшая чужой дифф (C3): бэктики и подстановка
        // обязаны доехать до форжа дословно, потому что интерпретатора в пути нет вовсе.
        cmds.commentOnIssue(7, 'текст с `бэктиками` и $(подстановкой)', { runArgvFn });
        cmds.closeIssue(7, { runArgvFn });
        cmds.blockIssue(9, { runArgvFn });
        expect(runArgvFn.mock.calls).toEqual([
            ['gh', ['issue', 'comment', '7', '--body', 'текст с `бэктиками` и $(подстановкой)']],
            ['gh', ['issue', 'close', '7']],
            ['gh', ['issue', 'edit', '9', '--add-label', 'blocked']],
        ]);
    });

    // #220: тело карточки фазы со ссылкой на блокирующую — тоже argv, без шелла.
    it('setIssueBody — gh issue edit --body дословно', () => {
        const runArgvFn = vi.fn(() => '');
        make().setIssueBody(7, 'тело\n\n— заблокирована $(x) #9', { runArgvFn });
        expect(runArgvFn.mock.calls).toEqual([
            ['gh', ['issue', 'edit', '7', '--body', 'тело\n\n— заблокирована $(x) #9']],
        ]);
    });

    it('fail-closed: сбой мутации НЕ глушится — потерянное закрытие держит фазу вечно', () => {
        const runArgvFn = () => {
            throw new Error('форж отверг');
        };
        expect(() => make().closeIssue(7, { runArgvFn })).toThrow(/форж отверг/);
    });
});

describe('issueComments — лента карточки для сверки намерения (#125)', () => {
    it('читает issues/N/comments с --paginate и отдаёт тела по порядку', () => {
        const forgeJsonFn = vi.fn(() => [
            { body: 'первый', user: { login: 'dev' } },
            { body: 'с меткой <!-- ralph-intent:x -->' },
            { user: { login: 'dev' } },
        ]);
        expect(make().issueComments(7, { forgeJsonFn } as never)).toEqual([
            'первый',
            'с меткой <!-- ralph-intent:x -->',
            '',
        ]);
        expect(forgeJsonFn).toHaveBeenCalledWith(
            'gh api repos/{owner}/{repo}/issues/7/comments --paginate',
        );
    });

    it('НЕГАТИВНЫЙ: ответ не массивом — отказ, а не пустая лента', () => {
        const forgeJsonFn = () => ({ message: 'Not Found' }) as never;
        expect(() => make().issueComments(7, { forgeJsonFn })).toThrow(/не массив/);
    });

    it('НЕГАТИВНЫЙ: сбой чтения долетает до вызывающего', () => {
        const forgeJsonFn = () => {
            throw new Error('gh: HTTP 502');
        };
        expect(() => make().issueComments(7, { forgeJsonFn })).toThrow(/502/);
    });
});

describe('closeMilestoneByTitle — косметика после сдачи, fail-open', () => {
    it('находит открытую веху по заголовку и закрывает её через argv', () => {
        const forgeJsonFn = vi.fn(() => [{ number: 4, title: 'Фаза X' }]);
        const runArgvFn = vi.fn(() => '');
        make().closeMilestoneByTitle('Фаза X', { forgeJsonFn, runArgvFn } as never);
        expect(runArgvFn).toHaveBeenCalledWith('gh', [
            'api',
            '-X',
            'PATCH',
            'repos/{owner}/{repo}/milestones/4',
            '-f',
            'state=closed',
        ]);
    });

    it('вехи с таким заголовком нет — тихий выход, ничего не мутируем', () => {
        const runArgvFn = vi.fn(() => '');
        make().closeMilestoneByTitle('Чужая', {
            forgeJsonFn: (() => [{ number: 4, title: 'Фаза X' }]) as never,
            runArgvFn,
        });
        expect(runArgvFn).not.toHaveBeenCalled();
    });

    // #251: номер приходит из чужого API и уходит в argv — не целое туда не пускаем.
    it('нецелый номер вехи из ответа форжа в argv не уходит', () => {
        const runArgvFn = vi.fn(() => '');
        make().closeMilestoneByTitle('Фаза X', {
            forgeJsonFn: (() => [{ number: '4 --flag', title: 'Фаза X' }]) as never,
            runArgvFn,
        });
        expect(runArgvFn).not.toHaveBeenCalled();
    });

    it('fail-open: сбой только логируется — свип подберёт хвост потом', () => {
        const logFn = vi.fn();
        expect(() =>
            make().closeMilestoneByTitle('Фаза X', {
                forgeJsonFn: (() => {
                    throw new Error('форж лёг');
                }) as never,
                logFn,
            }),
        ).not.toThrow();
        expect(String(logFn.mock.calls[0][0])).toContain('Не смог закрыть milestone');
    });
});

describe('syncProjectBoard — синк доски, best-effort', () => {
    it('зовёт скрипт синка и логирует последнюю строку его вывода', () => {
        const logFn = vi.fn();
        const runArgvFn = vi.fn(() => 'первая\nитог: 3 карточки');
        make().syncProjectBoard({ runArgvFn, logFn });
        expect(runArgvFn).toHaveBeenCalledWith('node', ['/consumer/tools/board-sync.mjs']);
        expect(String(logFn.mock.calls[0][0])).toContain('итог: 3 карточки');
    });

    it('не роняет прогон даже на throw не-Error — косметика доски дороже не стоит', () => {
        const logFn = vi.fn();
        expect(() =>
            make().syncProjectBoard({
                runArgvFn: () => {
                    throw 'строка вместо Error';
                },
                logFn,
            }),
        ).not.toThrow();
        expect(String(logFn.mock.calls[0][0])).toContain('Синк доски не удался');
    });

    // Путь — из consumerScripts потребителя (канон, задача 23): без него синк выключен
    // и говорит об этом, а не зовёт файл, которого у потребителя может не быть.
    it('пути в конфиге нет — скрипт не зовётся, лог называет выключатель', () => {
        const logFn = vi.fn();
        const runArgvFn = vi.fn(() => '');
        make({ getProjectSyncScript: () => undefined }).syncProjectBoard({ runArgvFn, logFn });
        expect(runArgvFn).not.toHaveBeenCalled();
        expect(String(logFn.mock.calls[0][0])).toContain('consumerScripts.projectSync');
    });
});

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
        ghJson: () => {
            throw new Error('ghJson не подменён в тесте');
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
        const ghJsonFn = vi.fn((_cmd: string) => [] as never);
        make().openIssues("Фаза 'X'", { ghJsonFn });
        const cmd = ghJsonFn.mock.calls[0][0];
        expect(cmd).toContain(shq("Фаза 'X'"));
        expect(cmd).toContain('--state open');
        // #19: без явного предела форж молча отдал бы первые 30 карточек, и «полный
        // список» полным бы не был.
        expect(cmd).toMatch(/--limit \d+/);
    });

    it('отсеивает blocked и чужих авторов, сортирует по возрастанию номера', () => {
        const ghJsonFn = vi.fn(() => [
            issue(9),
            issue(3),
            issue(5, { labels: [{ name: 'blocked' }] }),
            issue(7, { author: { login: 'stranger' } }),
        ]);
        const out = make().openIssues('Фаза X', { ghJsonFn } as never);
        expect(out.map((i) => i.number)).toEqual([3, 9]);
    });

    it('`human` здесь НЕ фильтруется — фильтр живёт в ядре поверх шва (#133)', () => {
        const ghJsonFn = vi.fn(() => [issue(4, { labels: [{ name: 'human' }] })]);
        const out = make().openIssues('Фаза X', { ghJsonFn } as never);
        expect(out.map((i) => i.number)).toEqual([4]);
    });

    it('отказ форжа уходит в fail с диагнозом, а не в пустую очередь', () => {
        const ghJsonFn = vi.fn(() => {
            throw new Error('сеть легла');
        });
        expect(() => make().openIssues('Фаза X', { ghJsonFn })).toThrow(/сеть легла/);
    });

    it('ответ, упёршийся в предел, — отказ, а не «столько и было»', () => {
        const many = Array.from({ length: 200 }, (_, i) => issue(i + 1));
        const ghJsonFn = vi.fn(() => many);
        expect(() => make().openIssues('Фаза X', { ghJsonFn } as never)).toThrow(/предела выборки/);
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
            make().openIssues('Фаза X', { ghJsonFn: (() => many) as never });
        } catch (e) {
            caught = (e as Error).message;
        }
        expect(caught).toMatch(/предела выборки/);
        expect(caught).not.toMatch(/после ретраев|gh auth status/);
    });

    it('список доверенных авторов читается ЛЕНИВО — конфиг заполняется позже сборки', () => {
        let allow: string[] = [];
        const cmds = make({ getAuthorAllowlist: () => allow });
        const ghJsonFn = vi.fn(() => [issue(1)]);
        expect(cmds.openIssues('Фаза X', { ghJsonFn } as never)).toEqual([]);
        allow = ['owner'];
        expect(cmds.openIssues('Фаза X', { ghJsonFn } as never)).toHaveLength(1);
    });
});

describe('allOpenIssues / hasAnyIssues / milestoneLabels', () => {
    it('allOpenIssues не фильтрует ничего — на его пустоте стоит разрешение мерджа (C2)', () => {
        const ghJsonFn = vi.fn(() => [
            issue(5, { labels: [{ name: 'blocked' }] }),
            issue(7, { author: { login: 'stranger' } }),
        ]);
        expect(make().allOpenIssues('Фаза X', { ghJsonFn } as never)).toHaveLength(2);
    });

    it('allOpenIssues: отказ форжа БРОСАЕТ — вызывающий обязан остановиться', () => {
        const ghJsonFn = vi.fn(() => {
            throw new Error('форж лёг');
        });
        expect(() => make().allOpenIssues('Фаза X', { ghJsonFn })).toThrow(/форж лёг/);
    });

    it('hasAnyIssues смотрит карточки ЛЮБОГО статуса (C5) и отвечает булевым', () => {
        const ghJsonFn = vi.fn((_cmd: string) => [{ number: 1 }]);
        expect(make().hasAnyIssues('Фаза X', { ghJsonFn } as never)).toBe(true);
        expect(ghJsonFn.mock.calls[0][0]).toContain('--state all');
    });

    it('hasAnyIssues: пустой ответ = фазу не начинали', () => {
        expect(make().hasAnyIssues('Фаза X', { ghJsonFn: () => [] as never })).toBe(false);
    });

    it('milestoneLabels отдаёт плоский список ИМЁН с повторами', () => {
        const ghJsonFn = vi.fn(() => [
            { labels: [{ name: 'complexity:high' }, { name: '' }] },
            { labels: [{ name: 'complexity:high' }] },
            {},
        ]);
        expect(make().milestoneLabels('Фаза X', { ghJsonFn } as never)).toEqual([
            'complexity:high',
            'complexity:high',
        ]);
    });

    it('milestoneLabels: урезанный ответ — отказ, а не «сложных задач нет» (#37)', () => {
        const many = Array.from({ length: 200 }, () => ({ labels: [] }));
        expect(() => make().milestoneLabels('Фаза X', { ghJsonFn: () => many as never })).toThrow(
            /предела выборки/,
        );
    });
});

describe('issueDetails — тело карточки для кодер-сессии (#50)', () => {
    it('читает заголовок и тело по номеру', () => {
        const ghJsonFn = vi.fn((_cmd: string) => ({ title: 'Заголовок', body: 'Тело' }));
        expect(make().issueDetails(7, { ghJsonFn } as never)).toEqual({
            number: 7,
            title: 'Заголовок',
            body: 'Тело',
        });
        expect(ghJsonFn.mock.calls[0][0]).toContain('gh issue view 7');
    });

    it('#43 статус карточки: OPEN/CLOSED → open, незнакомый — поле не ставится', () => {
        const read = (state: unknown) =>
            make().issueDetails(7, { ghJsonFn: () => ({ title: 'т', state }) as never });
        expect(read('OPEN').open).toBe(true);
        expect(read('CLOSED').open).toBe(false);
        expect('open' in read(undefined)).toBe(false);
        expect('open' in read('MERGED')).toBe(false);
    });

    it('пустой заголовок — ОТКАЗ: сессия без тела задачи выдумает себе работу', () => {
        expect(() => make().issueDetails(7, { ghJsonFn: () => ({}) as never })).toThrow(
            /не прочиталась/,
        );
    });

    it('пустое тело при живом заголовке — законно, отказом не считается', () => {
        const ghJsonFn = () => ({ title: 'Есть' }) as never;
        expect(make().issueDetails(7, { ghJsonFn }).body).toBe('');
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

    it('fail-closed: сбой мутации НЕ глушится — потерянное закрытие держит фазу вечно', () => {
        const runArgvFn = () => {
            throw new Error('форж отверг');
        };
        expect(() => make().closeIssue(7, { runArgvFn })).toThrow(/форж отверг/);
    });
});

describe('closeMilestoneByTitle — косметика после сдачи, fail-open', () => {
    it('находит открытую веху по заголовку и закрывает её через argv', () => {
        const ghJsonFn = vi.fn(() => [{ number: 4, title: 'Фаза X' }]);
        const runArgvFn = vi.fn(() => '');
        make().closeMilestoneByTitle('Фаза X', { ghJsonFn, runArgvFn } as never);
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
            ghJsonFn: (() => [{ number: 4, title: 'Фаза X' }]) as never,
            runArgvFn,
        });
        expect(runArgvFn).not.toHaveBeenCalled();
    });

    // #251: номер приходит из чужого API и уходит в argv — не целое туда не пускаем.
    it('нецелый номер вехи из ответа форжа в argv не уходит', () => {
        const runArgvFn = vi.fn(() => '');
        make().closeMilestoneByTitle('Фаза X', {
            ghJsonFn: (() => [{ number: '4 --flag', title: 'Фаза X' }]) as never,
            runArgvFn,
        });
        expect(runArgvFn).not.toHaveBeenCalled();
    });

    it('fail-open: сбой только логируется — свип подберёт хвост потом', () => {
        const logFn = vi.fn();
        expect(() =>
            make().closeMilestoneByTitle('Фаза X', {
                ghJsonFn: (() => {
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

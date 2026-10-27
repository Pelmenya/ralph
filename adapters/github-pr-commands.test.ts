// #72: тесты команд форжа по pull request'ам — рядом с кодом, куда он переехал из
// `core/orchestrator.ts`. Поведение петли эти функции не меняли: они возвращаются под
// теми же именами и с теми же DI-хвостами, и сценарные сьюты зовут их через ре-экспорт
// оркестратора без единой правки ассерта.
//
// Проверяется здесь то, чего сьюты петли не доказывают: модуль собирается из
// синтетического env — без оркестратора, его конфига и его регэкспов. Именно это и есть
// контракт переезда: адаптер уедет в канон отдельно от ядра.
import { describe, expect, it, vi } from 'vitest';

import { createGithubPrCommands } from './github-pr-commands.ts';

const shq = (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const SHA = 'a'.repeat(40);

function make(over: Partial<Parameters<typeof createGithubPrCommands>[0]> = {}) {
    return createGithubPrCommands({
        shArgv: () => {
            throw new Error('shArgv не подменён в тесте');
        },
        ghJson: () => {
            throw new Error('ghJson не подменён в тесте');
        },
        shq,
        log: () => {},
        // Регэкспы приходят инъекцией из ядра — своя копия разошлась бы с ним по флагам
        // (#55-ревью нашло ровно такое расхождение).
        prNumberRe: /^\d+$/,
        sha40Re: /^[0-9a-f]{40}$/,
        ...over,
    });
}

describe('prComments — лента ревью со всех поверхностей форжа (#37)', () => {
    it('читает три поверхности и метит сводку прохода isSummary', () => {
        const ghJsonFn = vi.fn((cmd: string) => {
            if (cmd.includes('/issues/')) return [{ body: 'тред', user: { login: 'owner' } }];
            if (cmd.includes('/pulls/12/comments'))
                return [{ body: '🔴 инлайн', user: { login: 'owner' } }];
            return [{ body: 'сводка', user: { login: 'owner' } }, { body: '   ' }];
        });
        const out = make().prComments(12, { ghJsonFn } as never);
        expect(out).toEqual([
            { body: 'тред', isSummary: false, author: 'owner' },
            { body: '🔴 инлайн', isSummary: false, author: 'owner' },
            { body: 'сводка', isSummary: true, author: 'owner' },
        ]);
        // Пустое тело прохода ревью — обычное дело, в ленту не попадает.
        expect(out).toHaveLength(3);
    });

    it('пагинация запрошена явно — иначе лента обрезалась бы молча', () => {
        const ghJsonFn = vi.fn((_cmd: string) => [] as never);
        make().prComments(12, { ghJsonFn });
        for (const [cmd] of ghJsonFn.mock.calls) {
            expect(cmd).toContain('--paginate');
        }
    });

    it('некорректный номер PR — отказ до похода в форж', () => {
        const ghJsonFn = vi.fn(() => [] as never);
        for (const bad of [0, -1, 1.5, NaN]) {
            expect(() => make().prComments(bad, { ghJsonFn })).toThrow(/некорректный номер/);
        }
        expect(ghJsonFn).not.toHaveBeenCalled();
    });

    // Ноль находок при прошедшем ревью и ноль находок при недоступном форже в журнале
    // неразличимы — поэтому ответ неожиданной формы это отказ, а не пустая лента.
    it('ответ не массивом — отказ, а не тихо заниженная метрика', () => {
        expect(() => make().prComments(12, { ghJsonFn: (() => ({ items: [] })) as never })).toThrow(
            /не массив/,
        );
    });
});

describe('prHeadSha — голова PR для гейта (#49)', () => {
    it('читает headRefOid по номеру PR', () => {
        const ghJsonFn = vi.fn((_cmd: string) => ({ headRefOid: SHA }));
        expect(make().prHeadSha(12, { ghJsonFn } as never)).toBe(SHA);
        expect(ghJsonFn.mock.calls[0][0]).toContain('gh pr view 12');
    });

    // Номер уходит в ШЕЛЛ-строку чтения, поэтому фильтруется здесь, а не только у
    // поставщика: #49 показал, что при переезде кода замок теряется незаметно.
    it('номер не похож на целое — до шелл-строки не доходит', () => {
        const ghJsonFn = vi.fn((() => ({ headRefOid: SHA })) as never);
        expect(() => make().prHeadSha('--flag' as unknown as number, { ghJsonFn })).toThrow(
            /не похож на целое/,
        );
        expect(ghJsonFn).not.toHaveBeenCalled();
    });

    // Пустая строка вместо исключения увела бы гейт в ветку «голова не похожа на sha»:
    // тот же отказ мерджа, но с неверной причиной в логе.
    it('в ответе нет headRefOid — отказ с честным диагнозом', () => {
        expect(() => make().prHeadSha(12, { ghJsonFn: (() => ({})) as never })).toThrow(
            /нет headRefOid/,
        );
    });
});

describe('commentOnPr — замечание ревью от имени раннера (#45)', () => {
    it('без якоря — комментарий в тред PR', () => {
        const runArgvFn = vi.fn(() => '');
        make().commentOnPr(12, { body: 'сводка прохода' }, { runArgvFn } as never);
        expect(runArgvFn).toHaveBeenCalledWith('gh', [
            'api',
            'repos/{owner}/{repo}/issues/12/comments',
            '-f',
            'body=сводка прохода',
        ]);
    });

    it('якорь path+line — inline-комментарий с sha головы и стороной диффа', () => {
        const runArgvFn = vi.fn(() => '');
        make().commentOnPr(
            12,
            { body: '🔴 тут', anchor: { path: 'src/a.ts', line: 42 } },
            { runArgvFn, ghJsonFn: (() => ({ headRefOid: SHA })) as never },
        );
        expect(runArgvFn).toHaveBeenCalledWith('gh', [
            'api',
            'repos/{owner}/{repo}/pulls/12/comments',
            '-f',
            'body=🔴 тут',
            '-f',
            `commit_id=${SHA}`,
            '-f',
            'path=src/a.ts',
            '-F',
            'line=42',
            '-f',
            'side=RIGHT',
        ]);
    });

    // #41: сторона больше не прошита — замечание к удалённой строке живёт в СТАРОЙ версии
    // файла, и с `RIGHT` оно легло бы на чужую строку того же номера.
    it('#41 якорь со стороной LEFT — side=LEFT, а не прошитый RIGHT', () => {
        const runArgvFn = vi.fn((_file: string, args: string[]) => args.join(' '));
        make().commentOnPr(
            12,
            { body: 'удалено зря', anchor: { path: 'src/a.ts', line: 42, side: 'LEFT' } },
            { runArgvFn, ghJsonFn: (() => ({ headRefOid: SHA })) as never },
        );
        const args = runArgvFn.mock.calls[0][1];
        expect(args).toContain('side=LEFT');
        expect(args).not.toContain('side=RIGHT');
    });

    // #575: средняя ступень отката — комментарий уровня ФАЙЛА. `line`/`side` в него не
    // кладём вовсе: с ними форж снова ждёт строку в изменённом ханке и снова отвечает 422.
    it('якорь без строки — комментарий уровня файла, без line/side', () => {
        const runArgvFn = vi.fn((_file: string, args: string[]) => args.join(' '));
        make().commentOnPr(
            12,
            { body: 'о пропущенном', anchor: { path: 'src/a.ts' } },
            { runArgvFn, ghJsonFn: (() => ({ headRefOid: SHA })) as never },
        );
        const args = runArgvFn.mock.calls[0][1];
        expect(args).toContain('subject_type=file');
        expect(args.join(' ')).not.toContain('line=');
        expect(args.join(' ')).not.toContain('side=');
    });

    // «Положим тогда общим комментарием» — тихая подмена: у площадки именно якорь отличает
    // находку от сводки, и находка молча ушла бы в unmarked.
    it('голову прочитать не удалось — ОТКАЗ, а не тихий откат в сводку', () => {
        const runArgvFn = vi.fn(() => '');
        expect(() =>
            make().commentOnPr(
                12,
                { body: '🔴 тут', anchor: { path: 'src/a.ts', line: 42 } },
                {
                    runArgvFn,
                    ghJsonFn: (() => {
                        throw new Error('форж лёг');
                    }) as never,
                },
            ),
        ).toThrow(/форж лёг/);
        expect(runArgvFn).not.toHaveBeenCalled();
    });

    it('причина отказа доносится до текста ошибки, а не схлопывается', () => {
        expect(() =>
            make().commentOnPr(
                12,
                { body: 'x', anchor: { path: 'a.ts', line: 1 } },
                { runArgvFn: () => '', ghJsonFn: (() => ({})) as never },
            ),
        ).toThrow(/нет headRefOid/);
    });
});

describe('createPr — PR фазы заводит раннер (#46)', () => {
    it('заводит PR в main из ветки фазы и разбирает номер из вывода', () => {
        const runArgvFn = vi.fn(() => 'https://forge.test/org/repo/pull/57');
        const num = make().createPr(
            { branch: 'feature/x', title: 'Фаза X', body: 'тело' },
            { runArgvFn },
        );
        expect(num).toBe(57);
        expect(runArgvFn).toHaveBeenCalledWith('gh', [
            'pr',
            'create',
            '--base',
            'main',
            '--head',
            'feature/x',
            '--title',
            'Фаза X',
            '--body',
            'тело',
        ]);
    });

    // PR при этом СОЗДАН, поэтому не исключение: повтор наплодил бы дубликаты, а номер
    // нужен только для лога — петля всё равно перечитывает PR ветки через findOpenPr.
    it('номер не разобрался — null, а не отказ', () => {
        const runArgvFn = vi.fn(() => 'создано, ссылки нет');
        expect(
            make().createPr({ branch: 'feature/x', title: 't', body: 'b' }, { runArgvFn }),
        ).toBeNull();
    });
});

describe('findOpenPr — открытый PR ветки фазы', () => {
    it('ищет ТОЛЬКО PR в main (M5), имя ветки уходит через shq', () => {
        const ghJsonFn = vi.fn((_cmd: string) => [{ number: 5, labels: [] }]);
        expect(make().findOpenPr('feature/x', { ghJsonFn } as never)).toEqual({
            number: 5,
            labels: [],
        });
        const cmd = ghJsonFn.mock.calls[0][0];
        expect(cmd).toContain(shq('feature/x'));
        expect(cmd).toContain('--base main');
        expect(cmd).toContain('--state open');
    });

    // prs[0] был бы произвольным выбором с непредсказуемым результатом: фаза «сдалась» бы
    // не тем PR. Fail-closed — разберёт человек.
    it('несколько открытых PR на одну ветку — null и запись в лог', () => {
        const logFn = vi.fn();
        const ghJsonFn = (() => [{ number: 5 }, { number: 6 }]) as never;
        expect(make().findOpenPr('feature/x', { ghJsonFn, logFn })).toBeNull();
        expect(String(logFn.mock.calls[0][0])).toContain('неоднозначно');
    });

    it('номер PR не похож на целое — null: в argv/шелл его не пускаем', () => {
        const logFn = vi.fn();
        const ghJsonFn = (() => [{ number: '--flag' }]) as never;
        expect(make().findOpenPr('feature/x', { ghJsonFn, logFn })).toBeNull();
        expect(String(logFn.mock.calls[0][0])).toContain('не похож на целое');
    });

    it('открытого PR нет — null без ошибки', () => {
        expect(make().findOpenPr('feature/x', { ghJsonFn: (() => []) as never })).toBeNull();
    });

    it('сбой чтения — null и лог, а не исключение наружу', () => {
        const logFn = vi.fn();
        expect(
            make().findOpenPr('feature/x', {
                ghJsonFn: (() => {
                    throw new Error('форж лёг');
                }) as never,
                logFn,
            }),
        ).toBeNull();
        expect(String(logFn.mock.calls[0][0])).toContain('Не смог получить PR');
    });
});

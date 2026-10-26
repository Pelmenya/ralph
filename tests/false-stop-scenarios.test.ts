// Сценарии, где петля встаёт на ИСПРАВНОМ коде. Оба дефекта здесь — одного класса и
// оба пойманы живьём у потребителя: раннер сообщает об отказе там, где отказа нет, и
// AFK-прогон вырождается в HITL. Стоп — самая дорогая реакция в системе; тратить её на
// «всё в порядке, терять нечего» хуже, чем не иметь стопа вовсе: человек перестаёт
// верить стопам вообще.
//
// Побочки запрещены (RALPH_NO_SIDE_EFFECTS=1, общий afterEach в test-setup.ts): все
// коллабораторы — фейки через DI.
import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments.ts';
import { createOrchestrator } from '../core/orchestrator.ts';

// ── #12: «нечего коммитить» — это не отказ ───────────────────────────────────
// Поймано живьём: `git status` показал ВЕСЬ репозиторий как `D` (порченый индекс),
// `git add -A` его вылечил — файлы на диске совпадали с HEAD, — а `git commit` честно
// отдал 1 «nothing to commit». Функция сама устранила проблему и сама же сочла это
// провалом: `⛔ Остаток сессии не удалось закоммитить` и стоп цикла при чистом дереве.
describe('commitLeftovers: призрачная грязь не останавливает петлю (#12)', () => {
    type TCalls = { sh: string[]; argv: string[] };

    /** Фейк git: `status` грязный, а что покажет индекс после `add -A` — задаёт тест. */
    function fakeGit(stagedAfterAdd: string, opts: { commitThrows?: Error } = {}) {
        const calls: TCalls = { sh: [], argv: [] };
        const shFn = (cmd: string): string => {
            calls.sh.push(cmd);
            if (cmd === 'git status --porcelain') return ' D a.ts\n D b.ts\n';
            if (cmd.startsWith('git diff --cached')) return stagedAfterAdd;
            return '';
        };
        const shArgvFn = (file: string, args: string[]): string => {
            calls.argv.push([file, ...args].join(' '));
            if (args[0] === 'commit' && opts.commitThrows) throw opts.commitThrows;
            return '';
        };
        const logs: string[] = [];
        return { calls, shFn, shArgvFn, logs, logFn: (m: string) => logs.push(m) };
    }

    it('индекс пуст после add -A → true, коммита нет, в логе нет слова про отказ', () => {
        const g = fakeGit('');
        const ok = ralph.commitLeftovers('итерация фазы', {
            shFn: g.shFn,
            shArgvFn: g.shArgvFn,
            logFn: g.logFn,
        });
        expect(ok).toBe(true);
        // Коммит не зовётся вовсе: спрашивать git о том, что уже известно из индекса, —
        // лишний вызов, чей отказ и был исходным дефектом.
        expect(g.calls.argv.some((c) => c.includes('commit'))).toBe(false);
        expect(g.logs.join('\n')).not.toMatch(/не удалось закоммитить/);
        // Молчать тут нельзя: порченый индекс на сотни файлов — аномалия, которую человек
        // захочет увидеть в логе. Без этой строки молчаливый `return true` проходил бы.
        expect(g.logs.join('\n')).toMatch(/исчез сам/);
    });

    it('индекс НЕ пуст → обычный путь: коммит зовётся, результат true', () => {
        const g = fakeGit('a.ts\nb.ts\n');
        const ok = ralph.commitLeftovers('итерация фазы', {
            shFn: g.shFn,
            shArgvFn: g.shArgvFn,
            logFn: g.logFn,
        });
        expect(ok).toBe(true);
        expect(g.calls.argv.some((c) => c.includes('commit'))).toBe(true);
        expect(g.logs.join('\n')).toMatch(/закоммичен/);
    });

    it('НЕГАТИВНЫЙ: настоящий отказ git по-прежнему стопит', () => {
        // Права, лок индекса, хук — состояние дерева неизвестно, и вот это уже отказ.
        const g = fakeGit('a.ts\n', { commitThrows: new Error('.git/index.lock exists') });
        const ok = ralph.commitLeftovers('итерация фазы', {
            shFn: g.shFn,
            shArgvFn: g.shArgvFn,
            logFn: g.logFn,
        });
        expect(ok).toBe(false);
        expect(g.logs.join('\n')).toMatch(/не удалось закоммитить/);
    });

    it('НЕГАТИВНЫЙ: чистое дерево — прежний ранний выход, git больше не трогаем', () => {
        const calls: string[] = [];
        const ok = ralph.commitLeftovers('итерация фазы', {
            shFn: (cmd: string) => {
                calls.push(cmd);
                return '';
            },
            shArgvFn: (file: string, args: string[]) => {
                calls.push([file, ...args].join(' '));
                return '';
            },
            logFn: () => {},
        });
        expect(ok).toBe(true);
        expect(calls).toEqual(['git status --porcelain']);
    });
});

// ── #10: фильтр `human` жил в GitHub-ветке и на шве не работал ───────────────
// `excludeHumanIssues` применялся ВНУТРИ `openIssues`/`allOpenIssues` — двух функций,
// построенных на `gh issue list`. На площадке со швом очередь идёт мимо них: адаптер
// фильтрует `blocked` и автора, а `human` — нет.
//
// Цена — не косметическая. У фильтра ДВЕ работы, и вторая важнее: он применяется и к
// очереди, и к проверке сдачи фазы (C2). Карточка `human` внутри фазы поэтому держала
// сдачу открытой, а её собственный критерий наступает ПОСЛЕ мерджа этой же фазы —
// замкнутый круг, из-за которого фаза не сдавалась ни при каком числе итераций.
describe('human: фильтр живёт в ядре поверх шва, а не в реализации (#10)', () => {
    const human = { number: 1, title: 'решение человека', labels: [{ name: 'human' }] };
    const agent = { number: 2, title: 'работа агента', labels: [{ name: 'complexity:low' }] };

    /** Минимальный фейк шва: две реализации отличаются только тем, что отдают. */
    function fakeSeam(issues: Array<Record<string, unknown>>) {
        return {
            listReadyIssues: () => issues.slice(),
            listAllOpenIssues: () => issues.slice(),
        } as unknown as Parameters<typeof ralph.withHumanFilter>[0];
    }

    it('обе очереди чисты от human на ЛЮБОЙ реализации шва', () => {
        // Две разные реализации — ровно то, чем отличались GitHub и площадка: одна
        // отдавала уже отфильтрованное, вторая — сырое. Обёртка обязана выравнивать обе.
        for (const seam of [fakeSeam([human, agent]), fakeSeam([agent, human])]) {
            const wrapped = ralph.withHumanFilter(seam);
            expect(
                wrapped.listReadyIssues('фаза').map((i: { number: number }) => i.number),
            ).toEqual([2]);
            expect(
                wrapped.listAllOpenIssues('фаза').map((i: { number: number }) => i.number),
            ).toEqual([2]);
        }
    });

    it('остальные методы шва обёртка не трогает', () => {
        // Подмена шва обёрткой не должна незаметно съесть его поверхность: пропавший
        // метод вскроется на первой же операции форжа, а не здесь.
        const seam = {
            listReadyIssues: () => [],
            listAllOpenIssues: () => [],
            closeIssue: (n: number) => n,
            mergePullRequest: () => 'merged',
        } as unknown as Parameters<typeof ralph.withHumanFilter>[0];
        const wrapped = ralph.withHumanFilter(seam) as unknown as Record<string, unknown>;
        expect(typeof wrapped.closeIssue).toBe('function');
        expect(typeof wrapped.mergePullRequest).toBe('function');
    });

    it('конфликт human + complexity остаётся fail-closed через шов', () => {
        // Двусмысленность замысла (кто исполнитель?) обязана ронять раннер на ЛЮБОЙ
        // площадке. Раньше конфликт ловился только на GitHub-ветке — то есть площадка со
        // швом молча брала такую карточку в работу.
        const both = {
            number: 3,
            title: 'и то и другое',
            labels: [{ name: 'human' }, { name: 'complexity:low' }],
        };
        // failFn инжектируем по той же причине, что у `excludeHumanIssues`: боевой `fail`
        // это process.exit(1), и тест на нём проверить нечего — процесс бы просто умер.
        const wrapped = ralph.withHumanFilter(fakeSeam([both]), (m: string) => {
            throw new Error(m);
        });
        expect(() => wrapped.listReadyIssues('фаза')).toThrow(/конфликт замысла/);
        // C2 обязана падать так же: иначе фаза с двусмысленной карточкой молча сдастся.
        expect(() => wrapped.listAllOpenIssues('фаза')).toThrow(/конфликт замысла/);
    });
});

// ── #63: открытая `human` не остаётся молча в ЗАКРЫТОЙ вехе ─────────────────
// Фильтр `human` прячет карточку и от проверки сдачи (C2) — это верно, иначе фаза не
// сдаётся вовсе (#10). Но следом безусловно закрывалась веха, и человеческая половина
// фазы оставалась открытой внутри закрытой вехи: «фаза сделана», а её решение не начато.
// Выбранное поведение: фаза сдаётся, веха остаётся открытой, причина — строкой в логе и
// пушем с номерами карточек.
describe('сдача фазы с открытой human не закрывает веху (#63)', () => {
    const human = { number: 5, title: 'решение человека', labels: [{ name: 'human' }] };
    const human2 = { number: 8, title: 'ship там же', labels: [{ name: 'human' }] };

    function fakeSeam(issues: Array<Record<string, unknown>> | Error) {
        const closed: string[] = [];
        const seam = {
            listReadyIssues: () => (issues instanceof Error ? [] : issues.slice()),
            listAllOpenIssues: () => {
                if (issues instanceof Error) throw issues;
                return issues.slice();
            },
            closeMilestone: (title: string) => {
                closed.push(title);
            },
        } as unknown as Parameters<typeof ralph.withHumanFilter>[0];
        return { seam, closed };
    }

    function wrap(issues: Array<Record<string, unknown>> | Error) {
        const { seam, closed } = fakeSeam(issues);
        const logs: string[] = [];
        const pushes: string[] = [];
        const wrapped = ralph.withHumanFilter(seam, undefined, {
            logFn: (m: string) => logs.push(m),
            notifyFn: (m: string) => pushes.push(m),
        });
        return { wrapped, closed, logs, pushes };
    }

    it('очередь пуста, в вехе открыта только human → фаза сдаётся, веха остаётся открытой', () => {
        const w = wrap([human, human2]);
        // Сдачу human НЕ держит: C2 видит пустую веху, иначе вернулся бы круг #10.
        expect(w.wrapped.listReadyIssues('Фаза 5')).toEqual([]);
        expect(w.wrapped.listAllOpenIssues('Фаза 5')).toEqual([]);
        // А закрыть веху обёртка не даёт: человеческая половина фазы не сделана.
        w.wrapped.closeMilestone('Фаза 5');
        expect(w.closed).toEqual([]);
        // Молчать нельзя: номера карточек — в пуше. Строку в лог боевой пуш пишет сам
        // (`🔔 PUSH:`), отдельная запись её бы задвоила.
        expect(w.pushes).toHaveLength(1);
        expect(w.pushes[0]).toMatch(/Фаза 5/);
        expect(w.pushes[0]).toMatch(/#5/);
        expect(w.pushes[0]).toMatch(/#8/);
        expect(w.pushes[0]).toMatch(/остаётся открытой/);
        expect(w.logs).toEqual([]);
    });

    it('human в вехе нет → веха закрывается как раньше, без пуша', () => {
        const w = wrap([]);
        w.wrapped.closeMilestone('Фаза 4');
        expect(w.closed).toEqual(['Фаза 4']);
        expect(w.pushes).toEqual([]);
    });

    it('не смогли прочитать веху → не закрываем, и это сказано в логе', () => {
        // Закрытая веха необратима по смыслу «фаза сделана», открытая — видна. Сомнение
        // решается в сторону видимого; сдачу фазы при этом ничего не рвёт.
        const w = wrap(new Error('форж молчит'));
        expect(() => w.wrapped.closeMilestone('Фаза 6')).not.toThrow();
        expect(w.closed).toEqual([]);
        expect(w.logs.join('\n')).toMatch(/Фаза 6[\s\S]*форж молчит/);
    });

    it('сдача фазы закрывает веху через обёрнутый шов, а не мимо него', () => {
        // Применение, а не работоспособность: дефолт `closeMilestoneByTitleFn` обязан
        // вести в `adapters.taskSource` — тот обёрнут фильтром в buildRuntimeAdapters.
        const SRC = readFileSync(
            join(import.meta.dirname, '..', 'core', 'orchestrator.ts'),
            'utf-8',
        );
        const code = stripComments(SRC, { dropTrailing: true });
        const defaults = [...code.matchAll(/closeMilestoneByTitleFn\s*=\s*([^,\n]+)/g)].map((m) =>
            m[1].trim(),
        );
        expect(defaults.length).toBeGreaterThanOrEqual(1);
        for (const d of defaults) expect(d).toBe('adapters.taskSource.closeMilestone');
        const wrapper = code.slice(code.indexOf('function withHumanFilter'));
        expect(wrapper.slice(0, wrapper.indexOf('\n    }'))).toMatch(/closeMilestone\s*:/);
    });
});

// ── Барьер на ПРИМЕНЕНИЕ фильтра, а не на его работоспособность ──────────────
// Удаление `excludeHumanIssues` из очереди не покрасило НИ ОДНОГО теста: все они звали
// саму функцию напрямую и доказывали, что она умеет фильтровать, — мимо вопроса, зовут
// ли её вообще. Ровно так дефект и жил: функция исправна, а очередь идёт мимо неё.
//
// Проверяем по исходному тексту (как `seam-defaults`): поведенческий тест здесь
// невозможен — боевые методы шва ходят в форж, а подмена их фейком проверяла бы фейк.
describe('фильтр human применён, а не просто существует (#10)', () => {
    const SRC = readFileSync(join(import.meta.dirname, '..', 'core', 'orchestrator.ts'), 'utf-8');
    const code = stripComments(SRC, { dropTrailing: true });
    // Для сканов, ловящих СИНТАКСИС записи, строки вычищены: текст подсказок содержит
    // `adapters.coderRuntime='kimi'` — прозу об опции конфига, не код, и без вычистки
    // запрет записи в поле краснел бы на исправном файле. Цена: код внутри `${…}`
    // шаблонов сканеру не виден — эту щель держит не текст, а Object.freeze (тесты ниже).
    const codeSansStrings = stripComments(SRC, { dropTrailing: true, blankStrings: true });

    it('переменная adapters получает значение ТОЛЬКО от buildRuntimeAdapters', () => {
        // Сторожим КАНАЛ, а не имя вызываемой функции. Запрет на `buildAdapters(` в
        // ядре обходится четырьмя способами сразу — алиасом (`const ba = buildAdapters`),
        // опциональным вызовом (`buildAdapters?.()`), переименованным импортом и выносом
        // сборки в соседний файл, — и первый из них проверен мутацией: фильтр снят, все
        // 1884 теста зелёные, то есть дефект #10 вернулся при зелёном барьере.
        //
        // Инвариант «adapters — единственный проводник очереди» держат ДВА эшелона:
        // невозможность подмены в рантайме — Object.freeze в buildRuntimeAdapters
        // (запись в поле бросает TypeError и в main(), куда сьют не заходит); этот скан —
        // второй, он красит обход ещё здесь, не дожидаясь исполнения.
        const assignments = [...codeSansStrings.matchAll(/(?<![\w.])adapters\s*=[^=][^;\n]*/g)].map(
            (m) => m[0].trim(),
        );
        // Пустой набор — красный: скан обязан что-то видеть, иначе он сторожит пустоту.
        expect(assignments.length).toBeGreaterThanOrEqual(2);
        for (const a of assignments) {
            // Пробелы нормализованы: перенос строки после `=` — формат (prettier), а не
            // обход, и барьер, красный на исправном коде, отключают (ревью !5, minor 3).
            expect(a.replace(/\s+/g, ' '), `присваивание мимо фильтра human: ${a}`).toBe(
                'adapters = buildRuntimeAdapters()',
            );
        }
    });

    // Три формы записи МИМО формы `adapters = …`, найденные ревью !5 живыми мутациями
    // (фильтр снят — весь сьют зелёный). Каждый запрет сперва проверяется от противного
    // на образце обхода: регексп, который ничего не умеет ловить, сторожил бы пустоту.
    it.each([
        [
            'запись в поле: adapters.taskSource = сырой шов',
            /(?<![\w.])adapters\s*((\.|\?\.)\s*[\w$]+)+\s*(=(?!=|>)|(\+|-|\*|\/|%|\?\?|\|\||&&)=)/,
            'adapters.taskSource = buildAdapters(r, s, f).taskSource;',
        ],
        [
            'compound-присваивание: adapters ??= …',
            /(?<![\w.])adapters\s*(\?\?|\|\||&&|[+\-*/%])=/,
            'adapters ??= buildAdapters(r, s, f);',
        ],
        [
            'деструктуризация: ({ adapters } = …) или [adapters] = …',
            /[{[][^;\n{}=]*(?<![\w.])adapters\b[^;\n=]*[}\]]\s*=(?!=|>)/,
            '({ adapters } = { adapters: buildAdapters(r, s, f) });',
        ],
    ])('канал не обходится: %s', (_name, re, sample) => {
        expect(re.test(sample)).toBe(true);
        expect(codeSansStrings).not.toMatch(re);
    });

    it('buildRuntimeAdapters оборачивает taskSource фильтром', () => {
        const helper = code.slice(code.indexOf('function buildRuntimeAdapters'));
        const body = helper.slice(0, helper.indexOf('\n    }'));
        expect(body).toMatch(/taskSource:\s*withHumanFilter\(/);
    });

    it('GitHub-ветка фильтр больше не держит — иначе он снова в двух местах', () => {
        // Двойное применение безвредно по результату, но именно так правило и разъезжается:
        // одна копия правится, вторая остаётся.
        const openIssues = code.slice(code.indexOf('function openIssues'));
        expect(openIssues.slice(0, openIssues.indexOf('\n    }'))).not.toMatch(
            /excludeHumanIssues/,
        );
        const allOpen = code.slice(code.indexOf('function allOpenIssues'));
        expect(allOpen.slice(0, allOpen.indexOf('\n    }'))).not.toMatch(/excludeHumanIssues/);
    });
});

// Спред в `withHumanFilter` копирует только СОБСТВЕННЫЕ перечислимые свойства. Пока обе
// реализации шва — литералы из фабрик, это верно; класс с методами на прототипе дал бы
// обёртку с двумя методами вместо полного шва, причём молча. Фейк-литерал в тестах выше
// такого не поймает по построению — поэтому сторожим сам вид реализаций.
//
// Файлы — те, где живут обе фабрики taskSource: createSourcecraftTaskSource и
// createGithubTaskSource (второй — в adapters-impl.ts). Ревью !5 нашло здесь
// github-forge-commands.ts — шов форж-команд, чей результат деструктурируется и классов
// не боится, — а настоящая GitHub-половина оставалась несторожённой: её ловил лишь
// случайный метод в тесте #369.
describe('реализации шва остаются плоскими объектами (#10)', () => {
    it.each(['sourcecraft-task-source.ts', 'adapters-impl.ts'])(
        'adapters/%s — без class',
        (file) => {
            const src = stripComments(
                readFileSync(join(import.meta.dirname, '..', 'adapters', file), 'utf-8'),
                { dropTrailing: true },
            );
            expect(src).not.toMatch(/(^|[^\w])class\s+\w/);
        },
    );
});

// ── Механизм канала: живой набор адаптеров заморожен (#10, ревью !5) ─────────
// Текстовый скан выше не исполняется вместе с кодом: обход в main() он красит в сьюте,
// но саму НЕВОЗМОЖНОСТЬ подмены ПОЛЯ держит Object.freeze — строгий режим ESM превращает
// запись в замороженный объект в TypeError на месте исполнения. Проверяется от противного,
// той же формой, что и обход на ревью. Деструктуризация переприсваивает саму ПЕРЕМЕННУЮ
// и заморозке не подвластна — её держит только текстовый скан выше. Метод шва
// (`taskSource.isPhaseMerged = …`) подменяем НАМЕРЕННО: это легальный приём C4-теста
// ленивости DI-дефолтов (orchestrator.test.ts), а запись в методы из ядра сторожит
// запрет цепочек в скане канала.
describe('канал очереди держит freeze, а не только скан (#10)', () => {
    // Свежая фабрика на фейках внешних коллабораторов (как buildRuntime в
    // orchestrator.test.ts), а не общий инстанс ralph.js: если freeze сняли, запись
    // УДАЛАСЬ бы — и покалечила бы набор адаптеров, на котором сидят соседние тесты
    // этого процесса.
    function freshAdapters() {
        return createOrchestrator({
            argv: [],
            flags: {
                once: false,
                dry: false,
                reset: false,
                resubmit: false,
                deployResolved: false,
                migrate: false,
                migrateRollback: false,
            },
            external: {
                sendTelegramMessage: () => false,
                telegramConfigFromEnv: () => ({ token: '', chatId: '' }),
                buildSanitizedGateEnv: () => ({}),
            },
        }).getAdapters();
    }

    it('подмена taskSource целиком бросает: контейнер заморожен', () => {
        const adapters = freshAdapters();
        expect(Object.isFrozen(adapters)).toBe(true);
        expect(() => {
            (adapters as { taskSource: unknown }).taskSource = {};
        }).toThrow(TypeError);
    });

    it('обе очереди ЖИВОГО набора проходят через excludeHumanIssues', () => {
        // Поведенческий прогон listReadyIssues здесь невозможен без побочек: боевой шов
        // замкнут на реальные sh/gh, и guardSideEffect (RALPH_NO_SIDE_EFFECTS) честно
        // уронит тест. Ближайшее к поведению — текст живых функций СОБРАННОГО объекта:
        // обёртка withHumanFilter — замыкание, в чьём теле виден вызов фильтра. Скан
        // файла этого не заменяет: он не знает, что реально лежит в adapters после всех
        // присваиваний фабрики, — а здесь спрашиваем сам объект.
        const { taskSource } = freshAdapters();
        expect(String(taskSource.listReadyIssues)).toContain('excludeHumanIssues');
        expect(String(taskSource.listAllOpenIssues)).toContain('excludeHumanIssues');
    });
});

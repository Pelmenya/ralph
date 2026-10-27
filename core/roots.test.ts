// Контракт четырёх корней (канон, задача 21): что где лежит и что чего не касается.
//
// До этого у ядра понятия «корень» не было вовсе: пути собирались от CWD константами
// `.claude/ralph/…`, то есть раннер молча считал, что продукт, дерево работы и состояние —
// одно и то же место. Под подмодулем это не раскладка, а три разных места, и ошибка в них
// не даёт красного: прогон пишет состояние внутрь продукта, продукт становится грязным,
// bump gitlink ловит грязь через день и уже не связывается с причиной.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { instanceNamespace, resolveRoots, writeFileAtomic } from './roots.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

/** Каталог-песочница со всеми четырьмя корнями в законной раскладке. */
function sandbox() {
    const base = mkdtempSync(join(tmpdir(), 'roots-'));
    const consumer = join(base, 'app');
    // Продукт ВНУТРИ дерева потребителя — это и есть подмодуль, законная раскладка.
    const product = join(consumer, '.ralph', 'core');
    const execution = join(base, 'app-ralph');
    const runtime = join(consumer, '.ralph', 'runtime', 'prod');
    for (const d of [consumer, product, execution, runtime]) mkdirSync(d, { recursive: true });
    return { base, consumer, product, execution, runtime };
}

const roots = (o: Partial<Record<string, string>>) => ({
    consumerRoot: o.consumerRoot,
    executionRoot: o.executionRoot,
    productRoot: o.productRoot,
    runtimeDir: o.runtimeDir,
});

describe('резолв корней', () => {
    it('законная раскладка резолвится, пути абсолютные', () => {
        const s = sandbox();
        const r = resolveRoots(
            roots({
                consumerRoot: s.consumer,
                executionRoot: s.execution,
                productRoot: s.product,
                runtimeDir: s.runtime,
            }),
        );
        expect(r.consumerRoot).toBe(resolve(s.consumer));
        expect(r.productRoot.startsWith(r.consumerRoot)).toBe(true);
    });

    it('симлинк и настоящий путь — один корень, а не два', () => {
        // Worktree и симлинк дают разные СТРОКИ к одному иноду. Без realpath проверка
        // пересечений сравнивала бы строки и пропускала бы ровно тот случай, ради которого
        // заводилась: `/link/runtime` внутри `/real/product` строкой не совпадает ни с чем.
        const s = sandbox();
        const link = join(s.base, 'link-to-app');
        symlinkSync(s.consumer, link);
        const viaLink = resolveRoots(
            roots({
                consumerRoot: link,
                executionRoot: s.execution,
                productRoot: join(link, '.ralph', 'core'),
                runtimeDir: join(link, '.ralph', 'runtime', 'prod'),
            }),
        );
        const direct = resolveRoots(
            roots({
                consumerRoot: s.consumer,
                executionRoot: s.execution,
                productRoot: s.product,
                runtimeDir: s.runtime,
            }),
        );
        expect(viaLink.consumerRoot).toBe(direct.consumerRoot);
        expect(viaLink.runtimeDir).toBe(direct.runtimeDir);
    });

    it('ещё не созданный runtimeDir резолвится по существующему предку', () => {
        // Каталог состояния создаётся первым прогоном. Требовать его существования значило
        // бы требовать, чтобы раннер стартовал только со второго раза.
        const s = sandbox();
        const fresh = join(s.consumer, '.ralph', 'runtime', 'playground', 'deep');
        const r = resolveRoots(
            roots({
                consumerRoot: s.consumer,
                executionRoot: s.execution,
                productRoot: s.product,
                runtimeDir: fresh,
            }),
        );
        expect(r.runtimeDir).toBe(resolve(fresh));
    });
});

describe('fail-closed: корень не задан', () => {
    it.each(['consumerRoot', 'executionRoot', 'productRoot', 'runtimeDir'])(
        '%s отсутствует — отказ называет ИМЕННО его',
        (missing) => {
            const s = sandbox();
            const cfg = roots({
                consumerRoot: s.consumer,
                executionRoot: s.execution,
                productRoot: s.product,
                runtimeDir: s.runtime,
            });
            delete (cfg as Record<string, unknown>)[missing];
            expect(() => resolveRoots(cfg)).toThrow(new RegExp(missing));
        },
    );

    it('умолчания нет: пустая строка — тоже отказ, а не «текущий каталог»', () => {
        const s = sandbox();
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: '  ',
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: s.runtime,
                }),
            ),
        ).toThrow(/consumerRoot/);
    });
});

describe('запрет опасных пересечений', () => {
    it('состояние ВНУТРИ продукта — отказ', () => {
        // Прогон пачкает подмодуль: `git status` продукта перестаёт быть пустым, а bump
        // gitlink начинает тащить за собой рантайм-мусор.
        const s = sandbox();
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: join(s.product, 'runtime'),
                }),
            ),
        ).toThrow(/runtimeDir.*productRoot|productRoot.*runtimeDir/);
    });

    it('состояние ВНУТРИ дерева работы — отказ', () => {
        // Дерево работы переключают, чистят и удаляют вместе с worktree фазы. Состояние,
        // лежащее в нём, исчезает ровно тогда, когда по нему собирались восстанавливаться.
        const s = sandbox();
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: join(s.execution, '.ralph', 'runtime'),
                }),
            ),
        ).toThrow(/runtimeDir.*executionRoot|executionRoot.*runtimeDir/);
    });

    it('продукт совпадает с деревом работы — отказ', () => {
        const s = sandbox();
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.product,
                    productRoot: s.product,
                    runtimeDir: s.runtime,
                }),
            ),
        ).toThrow(/productRoot|executionRoot/);
    });

    it('продукт ВНУТРИ дерева потребителя — законно: это и есть подмодуль', () => {
        // Обратное правило («все корни попарно не пересекаются») запретило бы саму
        // раскладку, ради которой контракт заводится.
        const s = sandbox();
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: s.runtime,
                }),
            ),
        ).not.toThrow();
    });

    it('пересечение через симлинк ловится так же, как прямое', () => {
        const s = sandbox();
        const link = join(s.base, 'state-link');
        symlinkSync(join(s.product, 'runtime-inside'), link);
        mkdirSync(join(s.product, 'runtime-inside'), { recursive: true });
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: link,
                }),
            ),
        ).toThrow(/productRoot/);
    });

    it('сосед с общим префиксом имени пересечением не считается', () => {
        // `/app/state` и `/app/state-old` начинаются одинаково, но один в другом не лежит.
        // Наивная проверка `startsWith` без разделителя красила бы исправную раскладку.
        const s = sandbox();
        const sibling = join(s.consumer, '.ralph', 'core-old');
        mkdirSync(sibling, { recursive: true });
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: sibling,
                }),
            ),
        ).not.toThrow();
    });
});

describe('namespace экземпляра', () => {
    it('одно дерево, разные профили — разные каталоги состояния', () => {
        // Два раннера из одного клона (боевой и playground) обязаны иметь разное
        // состояние: общий state — это чужой лок, чужая фаза и чужой лог в одном файле.
        const a = instanceNamespace('/path/to/app', 'prod');
        const b = instanceNamespace('/path/to/app', 'playground');
        expect(a).not.toBe(b);
    });

    it('один экземпляр — один и тот же каталог при каждом запуске', () => {
        expect(instanceNamespace('/path/to/app', 'prod')).toBe(
            instanceNamespace('/path/to/app', 'prod'),
        );
    });

    it('разные деревья с одинаковым профилем не делят состояние', () => {
        expect(instanceNamespace('/path/to/app', 'prod')).not.toBe(
            instanceNamespace('/path/to/other', 'prod'),
        );
    });

    it('имя пригодно для файловой системы', () => {
        expect(instanceNamespace('/path/to/app', 'prod')).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    });
});

describe('атомарная запись', () => {
    it('файл появляется целиком: содержимое пишется во временный и переименовывается', () => {
        const s = sandbox();
        const target = join(s.runtime, 'ralph.state.json');
        const seen: string[] = [];
        writeFileAtomic(target, '{"phase":1}', {
            writeFn: (p, data) => {
                seen.push(`write:${p}`);
                writeFileSync(p, data);
            },
            renameFn: (from, to) => {
                seen.push(`rename:${from}->${to}`);
                writeFileSync(to, readFileSync(from));
            },
        });
        expect(seen[0]).toMatch(/write:.*\.tmp-/);
        expect(seen[1]).toMatch(/rename:.*->.*ralph\.state\.json/);
        expect(readFileSync(target, 'utf-8')).toBe('{"phase":1}');
    });

    it('временный файл лежит рядом с целевым, а не в /tmp', () => {
        // rename атомарен только в пределах одной файловой системы. Временный файл в
        // системном /tmp даёт молчаливый обрыв: копирование между ФС не атомарно, и
        // прерванный прогон оставляет полуфайл состояния.
        const s = sandbox();
        const target = join(s.runtime, 'ralph.state.json');
        let tmpPath = '';
        writeFileAtomic(target, 'x', {
            writeFn: (p, data) => {
                tmpPath = p;
                writeFileSync(p, data);
            },
            renameFn: (from, to) => writeFileSync(to, readFileSync(from)),
        });
        expect(tmpPath.startsWith(s.runtime)).toBe(true);
    });
});

describe('дефолтная запись — под предохранителем побочек', () => {
    it('без подменённых зависимостей запись отказывает и попадает в журнал', () => {
        // Утилита пишет на диск, и забытый в тесте мок иначе создавал бы файлы состояния
        // прямо во время прогона — ровно тот класс, ради которого предохранитель заведён.
        const target = join(mkdtempSync(join(tmpdir(), 'roots-guard-')), 'ralph.state.json');
        expect(() => writeFileAtomic(target, '{}')).toThrow(/RALPH_NO_SIDE_EFFECTS/);
        // Вызов сделан намеренно — журнал забираем сами, иначе общий afterEach уронил бы
        // этот же тест.
        expect(sideEffectAttempts.splice(0)).toEqual([
            expect.stringMatching(/^writeFileAtomic\(.*\.tmp-.*ralph\.state\.json\)$/),
        ]);
    });
});

describe('форма пути — отказ до всякого обращения к диску (ревью !18)', () => {
    const s0 = () => sandbox();

    it('относительный путь — отказ: он означал бы разные каталоги при разном месте запуска', () => {
        const s = s0();
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: '.ralph/app',
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: s.runtime,
                }),
            ),
        ).toThrow(/относительным путём/);
    });

    it('сегмент ".." — отказ: он схлопывается ДО разворачивания симлинков', () => {
        // `link/..` лексически становится родителем ССЫЛКИ, а физически ведёт к родителю
        // её цели. Проверка пересечений в этом случае смотрит не туда, куда пойдёт запись.
        const s = s0();
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    // Строкой, а не через `join`: он нормализует путь и съел бы `..`
                    // раньше, чем его увидит проверка — тест проверял бы пустоту.
                    runtimeDir: `${s.consumer}/.ralph/core/../runtime`,
                }),
            ),
        ).toThrow(/\.\./);
    });

    it('битая ссылка — отказ, а не «каталог ещё не создан»', () => {
        const s = s0();
        const dangling = join(s.base, 'dangling');
        symlinkSync(join(s.base, 'nowhere'), dangling);
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: dangling,
                }),
            ),
        ).toThrow(/битая символическая ссылка/);
    });

    it('файл вместо каталога — отказ на старте, а не ENOTDIR из середины прогона', () => {
        const s = s0();
        const file = join(s.base, 'not-a-dir');
        writeFileSync(file, 'x');
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: file,
                    productRoot: s.product,
                    runtimeDir: s.runtime,
                }),
            ),
        ).toThrow(/не каталог/);
    });

    it('подмена каталога во время старта ловится вторым проходом', () => {
        // TOCTOU: между проверкой существования и realpath каталог может появиться —
        // и в результате осталась бы неразвёрнутая строка, а пересечение не нашлось бы.
        const s = s0();
        let call = 0;
        expect(() =>
            resolveRoots(
                roots({
                    consumerRoot: s.consumer,
                    executionRoot: s.execution,
                    productRoot: s.product,
                    runtimeDir: s.runtime,
                }),
                {
                    // Первый проход по runtimeDir отвечает одно, второй — другое.
                    realpathFn: (p) => {
                        if (p === s.runtime) {
                            call += 1;
                            return call === 1 ? p : join(s.product, 'runtime');
                        }
                        return p;
                    },
                },
            ),
        ).toThrow(/нестабильно/);
    });
});

describe('namespace: коллизии, которых быть не должно (ревью !18)', () => {
    it('«prod/eu» и «prod-eu» дают РАЗНЫЕ каталоги, хотя slug у них один', () => {
        // Без имени экземпляра в хэше эти два поделили бы state, лок и лог — молча.
        expect(instanceNamespace('/path/to/app', 'prod/eu')).not.toBe(
            instanceNamespace('/path/to/app', 'prod-eu'),
        );
    });

    it('нерезолвнутый путь отвергается: иначе симлинк и цель дадут два состояния', () => {
        expect(() => instanceNamespace('app', 'prod')).toThrow(/резолвнутым/);
        expect(() => instanceNamespace('/path/to/app/../app', 'prod')).toThrow(/резолвнутым/);
    });
});

describe('атомарная запись — что остаётся при обрыве (ревью !18)', () => {
    it('обрыв между записью и переименованием не создаёт целевой файл', () => {
        // Смысл атомарности не в порядке вызовов, а в этом: читатель видит либо старое
        // состояние целиком, либо новое целиком, но никогда — половину.
        const s = sandbox();
        const target = join(s.runtime, 'ralph.state.json');
        writeFileSync(target, '{"phase":1}');
        expect(() =>
            writeFileAtomic(target, '{"phase":2}', {
                writeFn: (path, data) => writeFileSync(path, data),
                renameFn: () => {
                    throw new Error('обрыв');
                },
            }),
        ).toThrow(/обрыв/);
        expect(readFileSync(target, 'utf-8')).toBe('{"phase":1}');
    });

    it('имя временного файла различает и процесс, и поток', () => {
        // У worker-потоков один pid и свой счётчик с нуля: без threadId два потока взяли бы
        // одно имя, перетёрли данные друг друга, и один получил бы ENOENT на rename.
        const s = sandbox();
        let tmpPath = '';
        writeFileAtomic(join(s.runtime, 'x.json'), 'x', {
            writeFn: (path, data) => {
                tmpPath = path;
                writeFileSync(path, data);
            },
            renameFn: (from, to) => writeFileSync(to, readFileSync(from)),
        });
        expect(tmpPath).toContain(`-${String(process.pid)}-${String(threadId)}-`);
    });
});

describe('переезд состояния в runtimeDir (канон, задача 22)', () => {
    it('все файлы состояния уезжают в runtimeDir, имена не меняются', async () => {
        // Имена читают монитор, deadman и человек грепом — переезд каталога уже достаточное
        // изменение за один шаг. А вот НЕ уехавший файл хуже непереезда: половина состояния
        // окажется в старом каталоге, и восстанавливаться будет не по чему.
        const { runtimePathsIn } = await import('./runtime-paths.ts');
        const paths = runtimePathsIn('/path/to/app/.ralph/runtime/prod-abc');
        for (const [field, p] of Object.entries(paths)) {
            expect(p.startsWith('/path/to/app/.ralph/runtime/prod-abc/'), `${field}: ${p}`).toBe(
                true,
            );
        }
        expect(paths.state).toMatch(/ralph\.state\.json$/);
        expect(paths.lock).toMatch(/ralph\.lock$/);
        expect(paths.log).toMatch(/ralph\.log$/);
        expect(paths.requests).toMatch(/ralph\.requests\.jsonl$/);
        expect(paths.sessions).toMatch(/sessions$/);
    });

    it('состав переехавших путей закрыт: новый файл состояния не забудется молча', async () => {
        // Тест-опись. Добавил файл в RUNTIME, не добавив сюда, — красный: иначе новый файл
        // остаётся в каталоге ядра, а узнаётся это на первом же грязном подмодуле.
        const { runtimePathsIn } = await import('./runtime-paths.ts');
        expect(Object.keys(runtimePathsIn('/path/to/runtime')).sort()).toEqual([
            'dryEvents',
            'dryHeartbeat',
            'dryLog',
            'events',
            'heartbeat',
            'keys',
            'lock',
            'lockMarker',
            'log',
            'monitorOut',
            'monitorPid',
            'requests',
            'sessions',
            'stages',
            'state',
            'stopRequest',
        ]);
    });

    it('два экземпляра — два разных лока, и это следует из namespace', () => {
        const a = instanceNamespace('/path/to/app', 'prod');
        const b = instanceNamespace('/path/to/app', 'playground');
        expect(join('/path/to/app/.ralph/runtime', a, 'ralph.lock')).not.toBe(
            join('/path/to/app/.ralph/runtime', b, 'ralph.lock'),
        );
    });
});

describe('права файла состояния переживают замену (ревью !19)', () => {
    it('права целевого файла задаются ПРИ СОЗДАНИИ временного, а не chmod после', () => {
        // state, лежавший 0600, после первой же записи стал бы читаемым всем. Отдельный
        // chmod после записи оставлял окно, в котором файл уже есть с правами от umask, —
        // и был гонкой: применился бы уже не к тому иноду (ревью !20).
        const s = sandbox();
        const target = join(s.runtime, 'ralph.state.json');
        writeFileSync(target, '{}', { mode: 0o600 });
        let applied: number | undefined;
        writeFileAtomic(target, '{"phase":2}', {
            writeFn: (path, data, mode) => {
                applied = mode;
                writeFileSync(path, data);
            },
            renameFn: (from, to) => writeFileSync(to, readFileSync(from)),
        });
        expect(applied).toBe(0o600);
    });

    it('нового файла ещё нет — переносить нечего, права от umask', () => {
        const s = sandbox();
        let applied: number | undefined = 0o777;
        writeFileAtomic(join(s.runtime, 'fresh.json'), '{}', {
            writeFn: (path, data, mode) => {
                applied = mode;
                writeFileSync(path, data);
            },
            renameFn: (from, to) => writeFileSync(to, readFileSync(from)),
        });
        expect(applied).toBeUndefined();
    });

    it('целевой файл — символическая ссылка: отказ, а не права её цели', () => {
        // Через ссылку приехали бы права цели (подставленная ссылка на 0666 сделала бы
        // state доступным всем), а rename заменил бы саму ссылку — состояние оказалось бы
        // не там, где его ждут.
        const s = sandbox();
        const real = join(s.base, 'real-state.json');
        writeFileSync(real, '{}');
        const link = join(s.runtime, 'ralph.state.json');
        symlinkSync(real, link);
        expect(() =>
            writeFileAtomic(link, '{}', {
                writeFn: (path, data) => writeFileSync(path, data),
                renameFn: (from, to) => writeFileSync(to, readFileSync(from)),
            }),
        ).toThrow(/символическая ссылка/);
    });
});

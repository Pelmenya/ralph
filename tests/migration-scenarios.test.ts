// Приёмочные (сценарные) тесты протокола миграции runtime-состояния (канон, задача 25).
//
// Юнит-тесты протокола живут рядом с модулем (`core/runtime-migration.test.ts`) и проверяют
// шаги по отдельности. Здесь — три критерия готовности карточки целиком, через весь путь
// «состояние в старой раскладке → переезд → петля продолжает ТУ ЖЕ фазу», и обратный ему:
//
//   1. миграция: фаза продолжается с того же места, состояние не потеряно;
//   2. rollback: возврат к прежней раскладке без потери состояния — в том числе ПОСЛЕ
//      обрыва посреди переезда, ради которого протокол и заводился;
//   3. второй экземпляр во время миграции не продолжает работу.
//
// Побочек нет ни одной (RALPH_NO_SIDE_EFFECTS=1 из vitest.config, общий afterEach в
// test-setup.ts): файловая система инжектируется целиком, поэтому тест проверяет ПРОТОКОЛ,
// а не способность fs копировать байты. Порядок «лок → миграция» поведенческим тестом не
// закрыть — main() трогает реальный git/fs, — поэтому он закреплён структурным барьером
// в конце файла, ровно как порядок «лок — первый шаг main()» в lock-scenarios.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    planRuntimeMigration,
    migrateRuntime,
    rollbackRuntime,
    assertMigrationSettled,
    assertLegacyNotMigrated,
    MIGRATED_MARKER,
    MIGRATED_SUFFIX,
    type TMigrationDeps,
} from '../core/runtime-migration.ts';
import { runtimePathsIn } from '../core/runtime-paths.ts';
import { stripComments } from './strip-comments.ts';

const LEGACY = '/path/to/app/.claude/ralph';
const RUNTIME_DIR = '/path/to/app/.ralph/runtime/prod';
const NOW = '2026-08-22T12:00:00.000Z';

/** Состояние живой петли посреди фазы: третья итерация, PR ещё не сдан. */
const LIVE_STATE = JSON.stringify({
    count: 3,
    milestone: 'Ralph R0 · Фаза 4',
    submitted: false,
    noProgress: 1,
    gateHeals: 0,
});

function world(initial: Record<string, string>) {
    const files = new Map(Object.entries(initial));
    const deps: TMigrationDeps = {
        existsFn: (p) => files.has(p),
        readFn: (p) => {
            const v = files.get(p);
            if (v === undefined) throw new Error(`ENOENT: ${p}`);
            return v;
        },
        writeFn: (p, data) => void files.set(p, data),
        renameFn: (from, to) => {
            const v = files.get(from);
            if (v === undefined) throw new Error(`ENOENT: ${from}`);
            files.delete(from);
            files.set(to, v);
        },
        removeFn: (p) => void files.delete(p),
        sizeFn: (p) => (files.get(p) ?? '').length,
        now: () => NOW,
    };
    return { files, deps };
}

/** Живая раскладка до переезда: состояние, лог, маркер зависимостей и лок. */
const before = () => ({
    [`${LEGACY}/ralph.state.json`]: LIVE_STATE,
    [`${LEGACY}/ralph.log`]: 'старый лог',
    [`${LEGACY}/.deps-lock.sha`]: 'abc123',
});

describe('критерий 1: фаза продолжается с того же места', () => {
    it('состояние доезжает целиком, и петля читает ТУ ЖЕ фазу и итерацию', () => {
        const w = world(before());
        const plan = planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn);
        migrateRuntime(plan, w.deps);
        const moved = JSON.parse(w.files.get(runtimePathsIn(RUNTIME_DIR).state) as string);
        expect(moved.milestone).toBe('Ralph R0 · Фаза 4');
        expect(moved.count).toBe(3);
        expect(moved.submitted).toBe(false);
        // Не только state: маркер `npm ci` и лог — тоже состояние экземпляра, и оставить их
        // значило бы переустановку зависимостей на первой же итерации после переезда.
        expect(w.files.get(`${RUNTIME_DIR}/.deps-lock.sha`)).toBe('abc123');
        expect(w.files.get(`${RUNTIME_DIR}/ralph.log`)).toBe('старый лог');
    });

    it('старт по ПРЕЖНЕЙ раскладке после переезда невозможен', () => {
        // Иначе второй экземпляр поедет на старом состоянии — тот самый исход, ради
        // которого протокол и написан: два раннера на одну фазу расходятся молча.
        const w = world(before());
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        expect(w.files.has(`${LEGACY}/ralph.state.json`)).toBe(false);
        expect(w.files.has(`${LEGACY}/ralph.state.json${MIGRATED_SUFFIX}`)).toBe(true);
        expect(w.files.get(`${LEGACY}/${MIGRATED_MARKER}`)).toContain(RUNTIME_DIR);
    });
});

describe('критерий 2: rollback возвращает состояние без потерь', () => {
    it('после ЗАВЕРШЁННОГО переезда состояние возвращается на место', () => {
        const w = world(before());
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        rollbackRuntime(RUNTIME_DIR, w.deps);
        expect(w.files.get(`${LEGACY}/ralph.state.json`)).toBe(LIVE_STATE);
        expect(w.files.has(`${RUNTIME_DIR}/ralph.state.json`)).toBe(false);
        // Ни одного окна, где состояние живо в двух местах: оригинал возвращается раньше,
        // чем исчезает копия, а маркер снимается вместе с ними.
        expect(w.files.has(`${LEGACY}/${MIGRATED_MARKER}`)).toBe(false);
    });

    it('после ОБРЫВА посреди переезда откат тоже работает', () => {
        const w = world(before());
        const plan = planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn);
        const dying: TMigrationDeps = {
            ...w.deps,
            renameFn: () => {
                throw new Error('питание кончилось');
            },
        };
        expect(() => migrateRuntime(plan, dying)).toThrow(/питание/);
        rollbackRuntime(RUNTIME_DIR, w.deps);
        expect(w.files.get(`${LEGACY}/ralph.state.json`)).toBe(LIVE_STATE);
        expect(w.files.has(`${RUNTIME_DIR}/ralph.state.json`)).toBe(false);
    });
});

describe('критерий 3: во время миграции петля не продолжает работу', () => {
    it('незавершённый переезд останавливает старт с названной причиной', () => {
        const w = world(before());
        const dying: TMigrationDeps = {
            ...w.deps,
            renameFn: () => {
                throw new Error('обрыв');
            },
        };
        expect(() =>
            migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), dying),
        ).toThrow();
        expect(() => assertMigrationSettled(RUNTIME_DIR, w.deps)).toThrow(/не завершена/i);
    });

    it('лок НЕ переезжает: он принадлежит живому процессу, а не раскладке', () => {
        // Переезд идёт под локом, взятым уже в НОВОЙ раскладке. Копия старого лока поверх
        // него затёрла бы собственный лок мигрирующего процесса, а откат — удалил бы его
        // (ревью Codex, !23). Осиротевший legacy-лок снимает обычный механизм.
        const w = world({ ...before(), [`${LEGACY}/ralph.lock`]: '{"pid":1}' });
        const plan = planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn);
        expect(plan.files.map((f) => f.name)).not.toContain('ralph.lock');
        migrateRuntime(plan, w.deps);
        expect(w.files.get(`${LEGACY}/ralph.lock`)).toBe('{"pid":1}');
        expect(w.files.has(`${RUNTIME_DIR}/ralph.lock`)).toBe(false);
    });

    it('повтор после обрыва ВОЗОБНОВЛЯЕТ переезд, а не начинает новый', () => {
        // Часть файлов уже переименована, и построенный заново план их не увидит: повтор
        // перевёз бы остаток, переписал журнал, и откат вернул бы только остаток — половина
        // состояния осталась бы в новой раскладке навсегда (ревью Codex, !23).
        const w = world(before());
        const plan = planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn);
        let renames = 0;
        const flaky = {
            ...w.deps,
            renameFn: (from: string, to: string) => {
                if (++renames === 2) throw new Error('обрыв посреди переименований');
                w.deps.renameFn(from, to);
            },
        };
        expect(() => migrateRuntime(plan, flaky)).toThrow(/обрыв/);
        // Повтор строит план заново — и он УЖЕ неполон: часть оригиналов переименована.
        const second = planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn);
        expect(second.files.length).toBeLessThan(plan.files.length);
        const done = migrateRuntime(second, w.deps);
        // Журнал сохранил ПОЛНЫЙ состав, поэтому откат вернёт всё, а не остаток.
        expect(done.files).toEqual(plan.files.map((f) => f.name));
        rollbackRuntime(RUNTIME_DIR, w.deps);
        expect(w.files.get(`${LEGACY}/ralph.state.json`)).toBe(LIVE_STATE);
        expect(w.files.get(`${LEGACY}/ralph.log`)).toBe('старый лог');
        expect(w.files.get(`${LEGACY}/.deps-lock.sha`)).toBe('abc123');
    });

    it('обрыв ПОСЛЕ всех переименований доводится повтором, а не висит вечно', () => {
        const w = world(before());
        const plan = planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn);
        let writes = 0;
        const dying = {
            ...w.deps,
            writeFn: (p: string, data: string) => {
                // Падаем ровно на записи маркера: все переименования уже сделаны.
                if (p.endsWith(MIGRATED_MARKER)) throw new Error('обрыв на маркере');
                writes++;
                w.deps.writeFn(p, data);
            },
        };
        expect(() => migrateRuntime(plan, dying)).toThrow(/маркере/);
        // Плана больше нет — в старой раскладке не осталось ни одного оригинала.
        expect(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn).files).toEqual([]);
        const done = migrateRuntime(
            planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn),
            w.deps,
        );
        expect(done.status).toBe('done');
        expect(w.files.get(`${LEGACY}/${MIGRATED_MARKER}`)).toContain(RUNTIME_DIR);
        expect(writes).toBeGreaterThan(0);
    });

    it('старт по старой раскладке после переезда отвергается маркером', () => {
        // Барьер читает MIGRATED-TO, а не только пишет его: запуск со старым конфигом
        // (секции roots нет) иначе счёл бы, что состояния просто нет, и начал бы новую фазу
        // рядом с уехавшей — два независимых состояния (ревью Codex, !23).
        const w = world(before());
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        expect(() => assertLegacyNotMigrated(LEGACY, null, w.deps)).toThrow(/уже переехало/i);
        // Тот же runtimeDir — штатный запуск после переезда, он проходит.
        expect(() => assertLegacyNotMigrated(LEGACY, RUNTIME_DIR, w.deps)).not.toThrow();
        // Чужой runtimeDir — снова стоп: это второй экземпляр на третьем месте.
        expect(() => assertLegacyNotMigrated(LEGACY, '/other/runtime', w.deps)).toThrow();
        // Контрпример на ТОЧНОСТЬ сверки (ревью Codex, !23): адрес-надмножество прошёл бы
        // подстрочное сравнение, а это другой каталог и второй экземпляр.
        const prefix = world(before());
        migrateRuntime(
            planRuntimeMigration(LEGACY, `${RUNTIME_DIR}-old`, prefix.deps.existsFn),
            prefix.deps,
        );
        expect(() => assertLegacyNotMigrated(LEGACY, RUNTIME_DIR, prefix.deps)).toThrow(
            /уже переехало/i,
        );
    });

    it('после отката конфиг с roots не пускает петлю, пока его не поправят', () => {
        // Иначе следующий обычный запуск репойнтит RUNTIME на пустой runtimeDir и начинает
        // новую фазу, пока прежняя лежит в legacy (ревью Codex, !23).
        const w = world(before());
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        rollbackRuntime(RUNTIME_DIR, w.deps);
        expect(() => assertMigrationSettled(RUNTIME_DIR, w.deps)).toThrow(/откачено/i);
    });
});

// ── Структурный барьер: миграция идёт ПОД локом ─────────────────────────────────────────
// Поведенческим тестом не закрыть: main() читает конфиг, трогает git и файловую систему, и
// в сьюте не исполняется (та же причина, по которой порядок «лок — первый шаг main()»
// проверяется по исходнику в lock-scenarios). Барьер видит текст, а не исполнение: он
// поймает перестановку двух вызовов местами — правку, которой протокол и боится, — но не
// вынос миграции в helper, вызванный до лока.
describe('main(): переезд состояния идёт после взятия лока (канон, задача 25)', () => {
    const source = stripComments(
        fs.readFileSync(path.resolve(import.meta.dirname, '../core/orchestrator.ts'), 'utf-8'),
    );

    it('acquireRunnerLock() стоит выше вызовов протокола миграции', () => {
        const lockAt = source.indexOf('if (!acquireRunnerLock())');
        expect(lockAt, 'не нашёл взятие лока в main()').toBeGreaterThan(-1);
        for (const call of [
            'migrateRuntime(',
            'rollbackRuntime(',
            'assertMigrationSettled(',
            // Барьер маркера — тоже под локом и тоже обязан ПРИМЕНЯТЬСЯ: тесты зовут его
            // напрямую, поэтому удаление вызова из main() иначе осталось бы зелёным, вернув
            // запуск по старой раскладке после переезда (ревью Codex, !23).
            'assertLegacyNotMigrated(',
        ]) {
            const at = source.indexOf(call, lockAt);
            expect(at, `${call} не найден после взятия лока`).toBeGreaterThan(lockAt);
            // И ни одного вызова ДО лока: иначе состояние трогалось бы, пока на этот
            // runtimeDir может работать второй экземпляр.
            expect(source.slice(0, lockAt).includes(call), `${call} зовётся до лока`).toBe(false);
        }
    });
});

describe('возобновление доводит переезд из любого состояния диска', () => {
    it('копия усечена, а оригинал уже припаркован — восстанавливается из парковки', () => {
        // Тест построен так, что ветка `оригинал на месте` не срабатывает: иначе копию
        // переписал бы и код БЕЗ проверки годности, и тест ничего бы не доказывал
        // (ревью Codex, !23).
        const w = world({
            ...before(),
            [`${LEGACY}/ralph.requests.jsonl`]: '{"close":1}\n{"close":2}\n',
        });
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        const journal = JSON.parse(w.files.get(`${RUNTIME_DIR}/.migration.json`) as string);
        w.files.set(
            `${RUNTIME_DIR}/.migration.json`,
            JSON.stringify({ ...journal, status: 'in-progress' }),
        );
        // Усечение на границе строки: файл выглядит целым, «правильного вида» у него нет.
        w.files.set(`${RUNTIME_DIR}/ralph.requests.jsonl`, '{"close":1}\n');
        w.files.set(
            `${LEGACY}/ralph.requests.jsonl${MIGRATED_SUFFIX}`,
            '{"close":1}\n{"close":2}\n',
        );
        const done = migrateRuntime(
            planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn),
            w.deps,
        );
        expect(done.status).toBe('done');
        // Годность копии решает сверка с парковкой: формат JSONL валидацией не поймать.
        expect(w.files.get(`${RUNTIME_DIR}/ralph.requests.jsonl`)).toBe(
            '{"close":1}\n{"close":2}\n',
        );
    });

    it('усечённый ЛОГ ловится по размеру, а не чтением двух копий в память', () => {
        // Лог не ротируется и растёт неограниченно: сверка по содержимому держала бы в
        // памяти две его полные копии, и на большом логе это отказ, из которого повтор не
        // выводит (ревью Codex, !23). Размер ловит усечение — единственный отказ, возможный
        // у файла, который только дописывается.
        const w = world(before());
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        const journal = JSON.parse(w.files.get(`${RUNTIME_DIR}/.migration.json`) as string);
        w.files.set(
            `${RUNTIME_DIR}/.migration.json`,
            JSON.stringify({ ...journal, status: 'in-progress' }),
        );
        w.files.set(`${RUNTIME_DIR}/ralph.log`, 'ста'); // обрыв посреди записи
        const reads: string[] = [];
        const counting = {
            ...w.deps,
            readFn: (p: string) => {
                reads.push(p);
                return w.deps.readFn(p);
            },
        };
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), counting);
        expect(w.files.get(`${RUNTIME_DIR}/ralph.log`)).toBe('старый лог');
        // Обе копии лога разом в память не читались: сверка шла по размеру, а чтение
        // случилось ровно одно — восстановление из парковки.
        expect(reads.filter((p) => p.includes('ralph.log'))).toEqual([
            `${LEGACY}/ralph.log${MIGRATED_SUFFIX}`,
        ]);
    });

    it('копия ЦЕЛА по схеме, но отстала от парковки — всё равно переписывается', () => {
        // Валидный, но чужой state — худший случай: петля продолжила бы НЕ ТУ фазу, и
        // никакая проверка формата этого не увидит.
        const w = world(before());
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        const journal = JSON.parse(w.files.get(`${RUNTIME_DIR}/.migration.json`) as string);
        w.files.set(
            `${RUNTIME_DIR}/.migration.json`,
            JSON.stringify({ ...journal, status: 'in-progress' }),
        );
        w.files.set(
            `${RUNTIME_DIR}/ralph.state.json`,
            JSON.stringify({ count: 0, milestone: 'Старая фаза', submitted: true }),
        );
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        expect(w.files.get(`${RUNTIME_DIR}/ralph.state.json`)).toBe(LIVE_STATE);
    });

    it('оригинал припаркован, а копия битая — восстанавливается из парковки', () => {
        const w = world(before());
        migrateRuntime(planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn), w.deps);
        // Портим копию и сбрасываем журнал в in-progress: ровно то, что увидит следующий
        // запуск после обрыва посреди записи.
        w.files.set(`${RUNTIME_DIR}/ralph.state.json`, '{ обрыв');
        const journal = JSON.parse(w.files.get(`${RUNTIME_DIR}/.migration.json`) as string);
        w.files.set(
            `${RUNTIME_DIR}/.migration.json`,
            JSON.stringify({ ...journal, status: 'in-progress' }),
        );
        const done = migrateRuntime(
            planRuntimeMigration(LEGACY, RUNTIME_DIR, w.deps.existsFn),
            w.deps,
        );
        expect(done.status).toBe('done');
        expect(w.files.get(`${RUNTIME_DIR}/ralph.state.json`)).toBe(LIVE_STATE);
    });
});

describe('main(): режимы миграции fail-closed и не оставляют лока (канон, задача 25)', () => {
    const source = stripComments(
        fs.readFileSync(path.resolve(import.meta.dirname, '../core/orchestrator.ts'), 'utf-8'),
    );

    it('несовместимые команды отвергаются ДО первой записи на диск', () => {
        // `mkdir` каталога состояния — единственная запись, разрешённая до лока. Проверка
        // команды обязана стоять выше неё: иначе fail-closed успевает создать каталог, а
        // dry-режим по определению не берёт лока (ревью Codex, !23).
        const mkdirAt = source.indexOf('fs.mkdirSync(roots.runtimeDir');
        const dryGuardAt = source.indexOf("'--dry-run с режимом миграции несовместим");
        const bothAt = source.indexOf("'--migrate-runtime и --migrate-rollback вместе");
        expect(mkdirAt).toBeGreaterThan(-1);
        expect(dryGuardAt, 'нет отказа на dry + миграция').toBeGreaterThan(-1);
        expect(bothAt, 'нет отказа на два режима разом').toBeGreaterThan(-1);
        expect(dryGuardAt).toBeLessThan(mkdirAt);
        expect(bothAt).toBeLessThan(mkdirAt);
    });

    it('снятие лока регистрируется сразу после его взятия', () => {
        // Режимы выходят из main() раньше общего exit-хендлера, а отказ протокола — раньше
        // любого return. Без регистрации у самого лока сирота осталась бы на всех этих путях.
        const lockAt = source.indexOf('if (!acquireRunnerLock())');
        const releaseAt = source.indexOf("process.on('exit', () => releaseLockIfOurs(", lockAt);
        // Раньше ВСЕХ вызовов протокола, а не только первого: перенос регистрации между
        // веткой отката и веткой переезда оставил бы `--migrate-rollback` без хендлера, и
        // барьер по одному вызову этого не заметил бы (ревью Codex, !23).
        const calls = [
            'rollbackRuntime(',
            'migrateRuntime(',
            'assertMigrationSettled(',
            'assertLegacyNotMigrated(',
        ].map((c) => source.indexOf(c, lockAt));
        expect(releaseAt, 'нет регистрации снятия лока сразу после взятия').toBeGreaterThan(lockAt);
        for (const [i, at] of calls.entries()) {
            expect(at, `вызов протокола #${i} не найден после лока`).toBeGreaterThan(lockAt);
            expect(releaseAt, `снятие лока регистрируется после вызова #${i}`).toBeLessThan(at);
        }
    });
});

describe('побочки в тестах запрещены (RALPH_NO_SIDE_EFFECTS / DI)', () => {
    it('предохранитель включён, а файловая система тут инжектирована целиком', () => {
        expect(process.env.RALPH_NO_SIDE_EFFECTS).toBe('1');
    });
});

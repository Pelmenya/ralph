// Юнит-тесты протокола миграции runtime-состояния (канон, задача 25).
//
// Переезд состояния в `runtimeDir` (задача 22) приходится совершать на ЖИВОЙ петле, у
// которой есть незаконченная фаза. Самый дорогой исход — два экземпляра на разных
// раскладках, каждый считающий своё состояние единственным: они разойдутся молча, а
// обнаружится это по двум PR на одну фазу.
//
// Побочек здесь нет ни одной: файловая система целиком инжектируется (existsFn/readFn/
// writeFn/renameFn/removeFn), поэтому тест проверяет ПРОТОКОЛ — порядок шагов и поведение
// при обрыве, — а не то, что fs умеет копировать файлы.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    planRuntimeMigration,
    migrateRuntime,
    rollbackRuntime,
    readMigrationJournal,
    assertMigrationSettled,
    MIGRATION_JOURNAL,
    MIGRATED_MARKER,
    runnerLegacyDir,
    describeRollback,
    LOG_TAIL_BYTES,
    fileTailHash,
} from './runtime-migration.ts';

const FROM = '/app/.ralph/core';
const TO = '/app/.ralph/runtime/prod';
const NOW = '2026-08-22T12:00:00.000Z';

/** Фейковая файловая система: путь → содержимое. Каталоги не моделируются намеренно. */
function fakeFs(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    return {
        files,
        deps: {
            existsFn: (p: string) => files.has(p),
            readFn: (p: string) => {
                const v = files.get(p);
                if (v === undefined) throw new Error(`ENOENT: ${p}`);
                return v;
            },
            writeFn: (p: string, data: string) => {
                files.set(p, data);
            },
            renameFn: (from: string, to: string) => {
                const v = files.get(from);
                if (v === undefined) throw new Error(`ENOENT: ${from}`);
                files.delete(from);
                files.set(to, v);
            },
            removeFn: (p: string) => {
                files.delete(p);
            },
            sizeFn: (p: string) => (files.get(p) ?? '').length,
            tailFn: (p: string) => (files.get(p) ?? '').slice(-LOG_TAIL_BYTES),
            now: () => NOW,
        },
    };
}

const VALID_STATE = JSON.stringify({
    count: 3,
    milestone: 'Фаза 1',
    submitted: false,
    noProgress: 0,
});

describe('planRuntimeMigration — что именно переезжает', () => {
    it('в план попадают только существующие файлы состояния', () => {
        const { deps } = fakeFs({
            [`${FROM}/ralph.state.json`]: VALID_STATE,
            [`${FROM}/ralph.log`]: 'лог',
        });
        const plan = planRuntimeMigration(FROM, TO, deps.existsFn);
        expect(plan.files.map((f) => f.name)).toEqual(['ralph.state.json', 'ralph.log']);
        expect(plan.files[0]).toEqual({
            name: 'ralph.state.json',
            from: `${FROM}/ralph.state.json`,
            to: `${TO}/ralph.state.json`,
        });
    });

    it('состав берётся из ОПИСИ путей состояния, а не из перечисления в этом модуле', () => {
        // Иначе новый файл состояния добавят в runtimePathsIn и забудут здесь — он молча
        // останется в старой раскладке, а узнается это на грязном подмодуле.
        const all: Record<string, string> = {};
        for (const name of [
            'ralph.state.json',
            'ralph.log',
            'ralph.dry.log',
            'monitor.out',
            'monitor.pid',
            '.deps-lock.sha',
            'ralph.requests.jsonl',
        ])
            all[`${FROM}/${name}`] = 'x';
        const { deps } = fakeFs(all);
        expect(planRuntimeMigration(FROM, TO, deps.existsFn).files).toHaveLength(
            Object.keys(all).length,
        );
    });

    it('лок и архив сессий НЕ переезжают — и это разные причины', () => {
        // Лок принадлежит живому процессу: копия старого поверх взятого затёрла бы
        // собственный лок мигрирующего, а откат — удалил бы его (ревью Codex, !23).
        // Архив сессий — история, от которой продолжение фазы не зависит.
        const { deps } = fakeFs({
            [`${FROM}/ralph.lock`]: '{"pid":1}',
            [`${FROM}/sessions`]: 'каталог',
            [`${FROM}/ralph.state.json`]: VALID_STATE,
        });
        expect(planRuntimeMigration(FROM, TO, deps.existsFn).files.map((f) => f.name)).toEqual([
            'ralph.state.json',
        ]);
    });

    it('#146: дерево раннера, совпавшее с местом запуска, не удваивает опись', () => {
        const { deps } = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        const plan = planRuntimeMigration(FROM, TO, deps.existsFn, { runnerDir: FROM });
        expect(plan.files.map((f) => f.name)).toEqual(['ralph.state.json']);
        expect(plan.origins).toBeUndefined();
    });

    it('#146: без дерева раннера лог без state переезжает, как раньше', () => {
        // Отказ «нет state» — только при живом дереве раннера: без него state в старой
        // раскладке может не появиться законно (петля ни разу не дошла до итерации).
        const { deps } = fakeFs({ [`${FROM}/ralph.log`]: 'лог' });
        expect(planRuntimeMigration(FROM, TO, deps.existsFn).files.map((f) => f.name)).toEqual([
            'ralph.log',
        ]);
    });

    it('пустая старая раскладка — план пуст, мигрировать нечего', () => {
        const { deps } = fakeFs();
        expect(planRuntimeMigration(FROM, TO, deps.existsFn).files).toEqual([]);
    });
});

describe('runnerLegacyDir — второе место старой раскладки (#146)', () => {
    const has =
        (...paths: string[]) =>
        (p: string) =>
            paths.includes(p);
    it('дерево раннера есть и отдельно — его .claude/ralph', () => {
        expect(
            runnerLegacyDir('/app-ralph', '.claude/ralph', '/app/.claude/ralph', has('/app-ralph')),
        ).toBe('/app-ralph/.claude/ralph');
    });
    it('дерева нет — null: второго места нет', () => {
        expect(runnerLegacyDir('/app-ralph', '.claude/ralph', '/app/.claude/ralph', has())).toBe(
            null,
        );
    });
    it('дерево раннера и есть место запуска — null, а не удвоенная опись', () => {
        expect(runnerLegacyDir('/app', '.claude/ralph', '/app/.claude/ralph', has('/app'))).toBe(
            null,
        );
    });
});

describe('migrateRuntime — протокол переезда', () => {
    it('состояние оказывается в новой раскладке, а старое место помечено', () => {
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        const plan = planRuntimeMigration(FROM, TO, fs.deps.existsFn);
        const journal = migrateRuntime(plan, fs.deps);
        expect(fs.files.get(`${TO}/ralph.state.json`)).toBe(VALID_STATE);
        expect(journal.status).toBe('done');
        // Старый файл не удалён, а переименован: откат обязан быть возможен, а старт по
        // прежней раскладке — невозможен, иначе второй экземпляр поедет на старом состоянии.
        expect(fs.files.has(`${FROM}/ralph.state.json`)).toBe(false);
        expect(fs.files.has(`${FROM}/ralph.state.json.migrated`)).toBe(true);
        expect(fs.files.get(`${FROM}/${MIGRATED_MARKER}`)).toContain(TO);
    });

    it('битое состояние — отказ ДО пометки старой раскладки', () => {
        // Схема проверяется на уже скопированном файле: иначе «переехали» означало бы
        // «скопировали байты», а раннер на той стороне не стартует и вернуться некуда.
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: '{ это не json' });
        const plan = planRuntimeMigration(FROM, TO, fs.deps.existsFn);
        expect(() => migrateRuntime(plan, fs.deps)).toThrow(/схем/i);
        expect(fs.files.has(`${FROM}/ralph.state.json`)).toBe(true);
        expect(fs.files.has(`${FROM}/${MIGRATED_MARKER}`)).toBe(false);
    });

    it('журнал пишется ДО первого копирования — обрыв виден следующему запуску', () => {
        const order: string[] = [];
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        const deps = {
            ...fs.deps,
            writeFn: (p: string, data: string) => {
                order.push(p);
                fs.deps.writeFn(p, data);
            },
        };
        const plan = planRuntimeMigration(FROM, TO, fs.deps.existsFn);
        migrateRuntime(plan, deps);
        expect(order[0]).toBe(`${TO}/${MIGRATION_JOURNAL}`);
    });

    it('обрыв между копированием и пометкой оставляет журнал in-progress', () => {
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        const plan = planRuntimeMigration(FROM, TO, fs.deps.existsFn);
        const deps = {
            ...fs.deps,
            renameFn: () => {
                throw new Error('питание кончилось');
            },
        };
        expect(() => migrateRuntime(plan, deps)).toThrow(/питание/);
        expect(readMigrationJournal(TO, fs.deps)?.status).toBe('in-progress');
    });
});

describe('assertMigrationSettled — незавершённая миграция не пускает петлю', () => {
    it('журнал in-progress — отказ с названной причиной', () => {
        const fs = fakeFs({
            [`${TO}/${MIGRATION_JOURNAL}`]: JSON.stringify({
                status: 'in-progress',
                from: FROM,
                to: TO,
                files: ['ralph.state.json'],
                startedAt: NOW,
            }),
        });
        expect(() => assertMigrationSettled(TO, fs.deps)).toThrow(/миграц/i);
    });

    it('журнала нет либо он done — петля идёт дальше', () => {
        const empty = fakeFs();
        expect(() => assertMigrationSettled(TO, empty.deps)).not.toThrow();
        const done = fakeFs({
            [`${TO}/${MIGRATION_JOURNAL}`]: JSON.stringify({
                status: 'done',
                from: FROM,
                to: TO,
                files: [],
                startedAt: NOW,
                finishedAt: NOW,
            }),
        });
        expect(() => assertMigrationSettled(TO, done.deps)).not.toThrow();
    });

    it('битый журнал — тоже отказ: «не разобрал» не равно «всё в порядке»', () => {
        const fs = fakeFs({ [`${TO}/${MIGRATION_JOURNAL}`]: 'не json' });
        expect(() => assertMigrationSettled(TO, fs.deps)).toThrow(/журнал/i);
    });
});

describe('rollbackRuntime — возврат к прежней раскладке', () => {
    it('состояние возвращается на место, новая раскладка чистится', () => {
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        const plan = planRuntimeMigration(FROM, TO, fs.deps.existsFn);
        migrateRuntime(plan, fs.deps);
        rollbackRuntime(TO, fs.deps);
        expect(fs.files.get(`${FROM}/ralph.state.json`)).toBe(VALID_STATE);
        expect(fs.files.has(`${FROM}/ralph.state.json.migrated`)).toBe(false);
        expect(fs.files.has(`${FROM}/${MIGRATED_MARKER}`)).toBe(false);
        expect(fs.files.has(`${TO}/ralph.state.json`)).toBe(false);
        expect(readMigrationJournal(TO, fs.deps)?.status).toBe('rolled-back');
    });

    it('откат ПРЕРВАННОЙ миграции возможен: журнал in-progress тоже откатывается', () => {
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        const plan = planRuntimeMigration(FROM, TO, fs.deps.existsFn);
        const deps = {
            ...fs.deps,
            renameFn: () => {
                throw new Error('обрыв');
            },
        };
        expect(() => migrateRuntime(plan, deps)).toThrow();
        rollbackRuntime(TO, fs.deps);
        expect(fs.files.get(`${FROM}/ralph.state.json`)).toBe(VALID_STATE);
        expect(fs.files.has(`${TO}/ralph.state.json`)).toBe(false);
    });

    it('повтор переезда, оборванного до первого переименования, доводит его', () => {
        // Копия уже лежит, парковки нет: годность копии решает схема, оригинал копируется заново.
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        const plan = planRuntimeMigration(FROM, TO, fs.deps.existsFn);
        const dying = {
            ...fs.deps,
            renameFn: () => {
                throw new Error('обрыв');
            },
        };
        expect(() => migrateRuntime(plan, dying)).toThrow(/обрыв/);
        fs.files.set(`${TO}/ralph.state.json`, 'усечено');
        expect(migrateRuntime(plan, fs.deps).status).toBe('done');
        expect(fs.files.get(`${TO}/ralph.state.json`)).toBe(VALID_STATE);
    });

    it('#152: оригинал и копия обе есть и расходятся — стоп, а не выбор молча', () => {
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        migrateRuntime(planRuntimeMigration(FROM, TO, fs.deps.existsFn), fs.deps);
        fs.files.set(`${TO}/ralph.state.json`, JSON.stringify({ count: 4, milestone: 'Фаза 2' }));
        fs.files.set(`${FROM}/ralph.state.json`, VALID_STATE);
        expect(() => rollbackRuntime(TO, fs.deps)).toThrow(/не выбирает между двумя/);
        // Ни один из двух файлов не тронут.
        expect(fs.files.get(`${FROM}/ralph.state.json`)).toBe(VALID_STATE);
        expect(fs.files.has(`${TO}/ralph.state.json`)).toBe(true);
    });

    it('#152: изменились только логи — строка называет файлы, а не фазу', () => {
        const fs = fakeFs({
            [`${FROM}/ralph.state.json`]: VALID_STATE,
            [`${FROM}/ralph.log`]: 'лог',
        });
        migrateRuntime(planRuntimeMigration(FROM, TO, fs.deps.existsFn), fs.deps);
        fs.files.set(`${TO}/ralph.log`, 'лог и ещё');
        const rolled = rollbackRuntime(TO, fs.deps);
        expect(rolled.rollback).toEqual({
            changed: ['ralph.log'],
            snapshots: { 'ralph.log': `${FROM}/ralph.log.pre-rollback` },
        });
        expect(describeRollback(rolled)).toMatch(
            /изменились ralph\.log — возвращаются текущие файлы/,
        );
        expect(fs.files.get(`${FROM}/ralph.log`)).toBe('лог и ещё');
        expect(fs.files.get(`${FROM}/ralph.state.json`)).toBe(VALID_STATE);
    });

    it('#152: лог того же размера с другим содержимым — изменился, текущий едет с копией', () => {
        const fs = fakeFs({
            [`${FROM}/ralph.state.json`]: VALID_STATE,
            [`${FROM}/ralph.log`]: 'лог-а',
        });
        migrateRuntime(planRuntimeMigration(FROM, TO, fs.deps.existsFn), fs.deps);
        fs.files.set(`${TO}/ralph.log`, 'лог-б');
        const rolled = rollbackRuntime(TO, fs.deps);
        expect(rolled.rollback?.changed).toEqual(['ralph.log']);
        expect(fs.files.get(`${FROM}/ralph.log`)).toBe('лог-б');
        expect(fs.files.get(`${FROM}/ralph.log.pre-rollback`)).toBe('лог-а');
    });

    it('#152: state без числового count в отчёт не попадает, веха null названа', () => {
        const fs = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        migrateRuntime(planRuntimeMigration(FROM, TO, fs.deps.existsFn), fs.deps);
        fs.files.set(`${TO}/ralph.state.json`, 'не json');
        expect(rollbackRuntime(TO, fs.deps).rollback?.state).toBeUndefined();
        expect(fs.files.get(`${FROM}/ralph.state.json`)).toBe('не json');

        const other = fakeFs({ [`${FROM}/ralph.state.json`]: VALID_STATE });
        migrateRuntime(planRuntimeMigration(FROM, TO, other.deps.existsFn), other.deps);
        other.files.set(`${TO}/ralph.state.json`, JSON.stringify({ count: 0, milestone: null }));
        const rolled = rollbackRuntime(TO, other.deps);
        expect(describeRollback(rolled)).toMatch(/веха не задана, count 0/);
    });

    it('откатывать нечего — отказ, а не тихое «готово»', () => {
        const fs = fakeFs();
        expect(() => rollbackRuntime(TO, fs.deps)).toThrow(/журнал/i);
    });
});

describe('fileTailHash — отпечаток хвоста лога без чтения целиком', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-tail-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('одинаковый хвост — один хеш, другой при той же длине — другой', () => {
        const head = 'x'.repeat(LOG_TAIL_BYTES);
        writeFileSync(join(dir, 'a'), `${head}хвост-1`);
        writeFileSync(join(dir, 'b'), `y${head.slice(1)}хвост-1`);
        writeFileSync(join(dir, 'c'), `${head}хвост-2`);
        // Расхождение раньше хвоста не видно — это предел, названный в докблоке sameFile.
        expect(fileTailHash(join(dir, 'a'))).toBe(fileTailHash(join(dir, 'b')));
        expect(fileTailHash(join(dir, 'a'))).not.toBe(fileTailHash(join(dir, 'c')));
    });

    it('файл короче хвоста хешируется целиком, пустой — тоже', () => {
        writeFileSync(join(dir, 'short'), 'лог');
        writeFileSync(join(dir, 'empty'), '');
        expect(fileTailHash(join(dir, 'short'))).toMatch(/^[0-9a-f]{64}$/);
        expect(fileTailHash(join(dir, 'empty'))).not.toBe(fileTailHash(join(dir, 'short')));
    });
});

// Приёмочные (сценарные) тесты файл-лока от двойного запуска (#176/#177/#178, фаза 1
// изоляции ralph, критерии #179) — доказательство критериев готовности через ВЕСЬ путь
// решения «стартовать или отказать», а не по отдельным примитивам. Юнит-тесты примитивов
// (isRalphProcess/lockAlive/writeLock/removeLock/releaseLockIfOurs/acquireLock/
// acquireRunnerLock) живут в ralph.test.js; здесь — модель «лок-файл на диске» и проход
// через acquireLock как единое целое, ровно по пяти критериям Issue #179:
//
//   1. Второй запуск при живом первом → отказ ДО любых побочек.
//   2. Запуск после kill -9 предыдущего раннера → без ручных действий (автоснятие сироты).
//   3. Чужой процесс с переиспользованным pid → не живой раннер (по образцу isMonitorProcess).
//   4. Битый/нечитаемый лок-файл → стоп с внятным сообщением.
//   5. Побочки запрещены (RALPH_NO_SIDE_EFFECTS=1, guardSideEffect, всё через DI).
//
// «ДО любых побочек» (крит. 1 и 4) проверяем СИЛЬНЕЕ мок-ассертов: на отказных путях
// НЕ подменяем writeFn/removeFn — оставляем боевые дефолты под предохранителем #138. Любая
// запись/удаление тогда бросила бы и попала в журнал sideEffectAttempts, который общий
// afterEach (test-setup.ts) сверяет с пустотой. Пустой журнал = отказ физически ничего не
// тронул, а не «мок не позвался». Порядок «лок — первый шаг main(), впереди конфига/лога/
// worktree» (крит. 1 на уровне точки входа) закреплён структурным барьером в конце файла:
// main() не экспортируется (process.exit'ит, трогает реальный git/fs), поэтому ordering
// проверяется по исходнику — барьер поймает рефактор, который протащит побочку перед локом.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';

// Платформенное: тест опирается на POSIX-механизмы, которых на Windows нет
// (/proc/<pid>/cmdline, пути соседнего worktree, /bin/sh). Раннер живёт на
// Linux-VPS, поэтому пометка, а не вторая реализация — грабля 7 в
// docs/ralph-runner/portability-log.md. Снять вместе с платформенным швом.
const itPosix = it.skipIf(process.platform === 'win32');

const { acquireLock } = ralph;

const LOCK_PATH = '.claude/ralph/ralph.lock';
// cmdline живого раннера: тот же формат, что в юнит-тестах isRalphProcess (полный путь
// ralph.js в /proc/<pid>/cmdline). Чужой процесс — без этого пути.
const RALPH_CMDLINE = 'node\0.claude/ralph/ralph.js\0--profile\0prod\0';
const FOREIGN_CMDLINE = 'nginx\0-g\0daemon off;\0';

const enoent = (msg: string): NodeJS.ErrnoException => {
    const e = new Error(msg) as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    return e;
};

// Модель «диска»: содержимое лок-файла + карта pid→cmdline (/proc) + множество живых pid.
// Раздельные контракты (#243-ревью): readFn читает ТОЛЬКО лок-файл, procReadFn — ТОЛЬКО
// /proc/<pid>/cmdline; больше не мультиплексируем по подстроке пути. killFn(pid, 0)
// имитирует kill: живой pid → ok, мёртвый → ESRCH.
function makeLockWorld({
    lockContent = null,
    cmdlines = {},
    livePids = [],
}: {
    lockContent?: string | null;
    cmdlines?: Record<string, string>;
    livePids?: number[];
} = {}) {
    const live = new Set(livePids.map(String));
    const readFn = (): string => {
        if (lockContent == null) throw enoent('ENOENT lock');
        return lockContent;
    };
    const procReadFn = (p: string): string => {
        const proc = String(p).match(/\/proc\/(\d+)\/cmdline/);
        const cmd = proc ? cmdlines[proc[1]] : null;
        if (cmd == null) throw enoent(`ENOENT ${p}`);
        return cmd;
    };
    const killFn = (pid: number): void => {
        if (!live.has(String(pid))) {
            const e = new Error('ESRCH') as NodeJS.ErrnoException;
            e.code = 'ESRCH';
            throw e;
        }
    };
    return { readFn, procReadFn, killFn };
}

describe('крит. 1 — второй запуск при ЖИВОМ первом: отказ ДО любых побочек', () => {
    itPosix(
        'живой раннер держит лок (kill 0 + наш cmdline) → отказ, сообщение с pid и путём',
        () => {
            const { readFn, procReadFn, killFn } = makeLockWorld({
                lockContent: '4242',
                cmdlines: { 4242: RALPH_CMDLINE },
                livePids: [4242],
            });
            const failFn = vi.fn();
            // writeFn/removeFn НЕ передаём — боевые дефолты под guardSideEffect (#138). Отказной
            // путь не должен их звать; если позовёт — журнал побочек не будет пуст и afterEach
            // уронит тест.
            const ok = acquireLock({
                lockPath: LOCK_PATH,
                pid: 777,
                readFn,
                procReadFn,
                killFn,
                logFn: vi.fn(),
                failFn,
            });
            expect(ok).toBe(false);
            expect(failFn).toHaveBeenCalledTimes(1);
            const msg = failFn.mock.calls[0][0];
            expect(msg).toContain('4242'); // pid держателя
            expect(msg).toContain(LOCK_PATH); // путь лок-файла
            // Побочек не было — журнал #138 пуст (сильнее «мок не позвался»: боевой дефолт бы
            // бросил И записал попытку).
            expect(ralph.sideEffectAttempts).toEqual([]);
        },
    );
});

describe('крит. 2 — запуск после kill -9 первого: без ручных действий (автоснятие сироты)', () => {
    it('лок мёртвого pid (kill → ESRCH) → снимаем, логируем событие, берём себе', () => {
        const { readFn, procReadFn, killFn } = makeLockWorld({
            lockContent: '4242',
            cmdlines: { 4242: RALPH_CMDLINE }, // /proc есть, но kill упадёт раньше сверки cmdline
            livePids: [], // процесса нет — kill -9 его убил
        });
        // Путь взятия ПИШЕТ (reclaim) — здесь боевые дефолты бросили бы; мокаем write/remove.
        const writeFn = vi.fn();
        const removeFn = vi.fn();
        const logFn = vi.fn();
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: LOCK_PATH,
            pid: 777,
            readFn,
            procReadFn,
            killFn,
            writeFn,
            removeFn,
            logFn,
            failFn,
        });
        expect(ok).toBe(true); // старт без ручной чистки
        expect(removeFn).toHaveBeenCalledWith(LOCK_PATH); // сирота снята автоматически
        expect(writeFn).toHaveBeenCalledWith(LOCK_PATH, '777'); // свой pid записан
        expect(logFn).toHaveBeenCalledTimes(1); // событие снятия — в лог
        expect(logFn.mock.calls[0][0]).toContain('4242');
        expect(failFn).not.toHaveBeenCalled();
    });
});

describe('крит. 3 — чужой процесс с переиспользованным pid: НЕ живой раннер', () => {
    it('pid занят (kill ok), но cmdline чужой → сирота: снимаем и берём себе', () => {
        const { readFn, procReadFn, killFn } = makeLockWorld({
            lockContent: '4242',
            cmdlines: { 4242: FOREIGN_CMDLINE }, // номер отдан чужому процессу
            livePids: [4242], // он ЖИВ — kill(0) проходит
        });
        const writeFn = vi.fn();
        const removeFn = vi.fn();
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: LOCK_PATH,
            pid: 777,
            readFn,
            procReadFn,
            killFn,
            writeFn,
            removeFn,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(true);
        expect(removeFn).toHaveBeenCalledWith(LOCK_PATH);
        expect(writeFn).toHaveBeenCalledWith(LOCK_PATH, '777');
        expect(failFn).not.toHaveBeenCalled();
    });

    // Негативная пара к криту 1: тот же ЖИВОЙ pid, но за ним НАШ ralph.js → отказ. Разница
    // между «занять лок» и «отказать» — ровно cmdline-сверка, а не только kill(0).
    itPosix(
        'контраст: тот же живой pid с НАШИМ cmdline → отказ (cmdline решает, не kill 0)',
        () => {
            const { readFn, procReadFn, killFn } = makeLockWorld({
                lockContent: '4242',
                cmdlines: { 4242: RALPH_CMDLINE },
                livePids: [4242],
            });
            const failFn = vi.fn();
            const ok = acquireLock({
                lockPath: LOCK_PATH,
                pid: 777,
                readFn,
                procReadFn,
                killFn,
                logFn: vi.fn(),
                failFn,
            });
            expect(ok).toBe(false);
            expect(failFn).toHaveBeenCalledTimes(1);
            expect(ralph.sideEffectAttempts).toEqual([]);
        },
    );
});

describe('крит. 4 — битый/нечитаемый лок-файл: стоп с внятным сообщением, ДО побочек', () => {
    // На всех стоп-путях write/remove не подменяем — боевые дефолты под #138 докажут, что
    // стоп ничего не тронул (журнал побочек пуст).
    const stopCase = (lockContent: string | null) => {
        const { readFn, procReadFn, killFn } = makeLockWorld({ lockContent });
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: LOCK_PATH,
            pid: 777,
            readFn,
            procReadFn,
            killFn,
            logFn: vi.fn(),
            failFn,
        });
        return { ok, failFn };
    };

    it.each([
        ['мусор (не число)', 'мусор', /битый/],
        ['пусто/пробелы', '   \n', /битый/],
        ['нулевой pid', '0', /битый/],
        ['отрицательный pid', '-5', /битый/],
    ])('%s → стоп fail-closed, сообщение %s, без побочек', (_name, content, re) => {
        const { ok, failFn } = stopCase(content);
        expect(ok).toBe(false);
        expect(failFn).toHaveBeenCalledTimes(1);
        expect(failFn.mock.calls[0][0]).toMatch(re);
        expect(failFn.mock.calls[0][0]).toContain(LOCK_PATH);
        expect(ralph.sideEffectAttempts).toEqual([]);
    });

    it('нечитаемый файл (EACCES, не ENOENT) → стоп, не «лока нет», без побочек', () => {
        // readFn читает только лок-файл — сразу бросает EACCES (до lockAlive/procReadFn дело
        // не доходит, стоп на чтении).
        const readFn = (): never => {
            const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            e.code = 'EACCES';
            throw e;
        };
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: LOCK_PATH,
            pid: 777,
            readFn,
            killFn: () => undefined,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(false);
        expect(failFn).toHaveBeenCalledTimes(1);
        expect(failFn.mock.calls[0][0]).toMatch(/нечитаем/);
        expect(failFn.mock.calls[0][0]).toContain(LOCK_PATH);
        expect(ralph.sideEffectAttempts).toEqual([]);
    });

    it('лока нет (ENOENT) — норм-путь, НЕ стоп: берём себе без снятия', () => {
        const { readFn, procReadFn, killFn } = makeLockWorld({ lockContent: null });
        const writeFn = vi.fn();
        const removeFn = vi.fn();
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: LOCK_PATH,
            pid: 777,
            readFn,
            procReadFn,
            killFn,
            writeFn,
            removeFn,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(true);
        expect(writeFn).toHaveBeenCalledWith(LOCK_PATH, '777');
        expect(removeFn).not.toHaveBeenCalled(); // снимать нечего
        expect(failFn).not.toHaveBeenCalled();
    });
});

describe('крит. 5 — побочки в тестах запрещены (RALPH_NO_SIDE_EFFECTS / guardSideEffect / DI)', () => {
    it('окружение ralph держит предохранитель включённым', () => {
        expect(process.env.RALPH_NO_SIDE_EFFECTS).toBe('1');
    });

    itPosix('весь набор отказных сценариев не сделал ни одной боевой побочки', () => {
        // Прогоняем все стоп/отказ-пути подряд с боевыми дефолтами write/remove: журнал
        // побочек обязан остаться пустым (afterEach в test-setup.ts сверит его же).
        const live = makeLockWorld({
            lockContent: '4242',
            cmdlines: { 4242: RALPH_CMDLINE },
            livePids: [4242],
        });
        acquireLock({ lockPath: LOCK_PATH, pid: 777, ...live, logFn: vi.fn(), failFn: vi.fn() });
        const broken = makeLockWorld({ lockContent: 'мусор' });
        acquireLock({ lockPath: LOCK_PATH, pid: 777, ...broken, logFn: vi.fn(), failFn: vi.fn() });
        expect(ralph.sideEffectAttempts).toEqual([]);
    });
});

describe('крит. 1 (точка входа) — лок берётся ПЕРВЫМ шагом main(), впереди побочек (#178)', () => {
    // main() не экспортируется (под require.main === module: process.exit'ит, трогает
    // реальный git/fs), поэтому порядок вызовов внутри неё нельзя проверить прогоном. Барьер
    // по исходнику: acquireRunnerLock() обязан стоять РАНЬШЕ первой побочки — загрузки
    // конфига, создания worktree, chdir. Рефактор, протащивший побочку перед локом, покраснит
    // этот тест (структурный барьер сильнее комментария «лок первым» — бриф надёжности).
    it('в исходнике main() acquireRunnerLock() предшествует loadJson/ensureRunnerWorktree/chdir', () => {
        // #365: main() переехал из монолита ralph.js в orchestrator.ts — барьер сканирует
        // новый дом; сам инвариант «лок первым» не изменился. `__dirname`, не `import.meta`
        // (#406): tsconfig ралфа компилит .ts в CommonJS-режиме nodenext, где import.meta
        // запрещён (TS1470, тот же приём, что в core-purity.test.ts).
        const src = fs.readFileSync(resolve(__dirname, '../core/orchestrator.ts'), 'utf-8');
        const mainStart = src.indexOf('function main()');
        expect(mainStart).toBeGreaterThan(-1);
        const body = src.slice(mainStart);

        // Индекс ПЕРВОЙ СТРОКИ КОДА, совпавшей с регэкспом (флаг m — якорь на начало строки
        // после отступа), а не любого вхождения подстроки: голый indexOf ловил бы и текст в
        // комментариях (будущий коммент с `acquireRunnerLock()` перед реальным вызовом ложно
        // удовлетворил бы барьер, а `loadJson(CONFIG_PATH` в комменте до лока — ложно уронил).
        const codeLineIdx = (re: RegExp): number => {
            const m = re.exec(body);
            return m ? m.index : -1;
        };
        // Stryker оборачивает условие тернарными проверками activeMutant, но оставляет
        // вызов и return на той же строке. Матчим смысл строки, а не точную печать AST:
        // обычный Vitest по-прежнему ловит перенос лока ниже любой из следующих побочек.
        const lockIdx = codeLineIdx(/^\s*if \(.*acquireRunnerLock\(\).*return;/m);
        // Опциональный дженерик: в TS-оркестраторе строка стала loadJson<T>(CONFIG_PATH, …);
        // ленивый .*? — тип бывает вложенным (Record<…> | null), [^>]* резался бы на первом >.
        const configIdx = codeLineIdx(/^\s*const \w+ = loadJson(?:<.*?>)?\(CONFIG_PATH/m);
        const worktreeIdx = codeLineIdx(/^\s*ensureRunnerWorktree\(worktreePath\)/m);
        const chdirIdx = codeLineIdx(/^\s*process\.chdir\(worktreePath\)/m);

        expect(lockIdx).toBeGreaterThan(-1);
        for (const [name, idx] of [
            ['loadJson(CONFIG_PATH)', configIdx],
            ['ensureRunnerWorktree', worktreeIdx],
            ['process.chdir', chdirIdx],
        ] as const) {
            expect(idx, `${name} должен идти ПОСЛЕ acquireRunnerLock() в main()`).toBeGreaterThan(
                lockIdx,
            );
        }
    });
});

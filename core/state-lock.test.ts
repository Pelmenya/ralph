// Юнит-тесты модуля state/lock (#359). Основная часть проверяет САМУ фабрику
// createStateLock — что она собирает рабочие функции из синтетического env, независимо
// от ralph.js: контракт extraction'а — модуль самодостаточен и переносим (цель фазы 2),
// а не «работает только пока его зовёт ralph.js». Проход «через ре-экспорт ralph.js» с
// боевым контекстом раннера — в lock-scenarios.test.ts и в блоках в конце этого файла,
// перенесённых из ralph.test.js при её разнесении по модулям (#366).
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { StateLockEnv } from './state-lock.ts';
import { createStateLock } from './state-lock.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов; блоки в конце файла
// перенесены из ralph.test.js как есть и ходят через его ре-экспорт (#366).
import ralph from '../ralph.js';

// Платформенное: тест опирается на POSIX-механизмы, которых на Windows нет
// (/proc/<pid>/cmdline, пути соседнего worktree, /bin/sh). Раннер живёт на
// Linux-VPS, поэтому пометка, а не вторая реализация — грабля 7 в
// docs/ralph-runner/portability-log.md. Снять вместе с платформенным швом.
const itPosix = it.skipIf(process.platform === 'win32');

const { isRalphProcess, lockAlive, writeLock, removeLock, releaseLockIfOurs } = ralph;

// Синтетический env: пути-заглушки, отдельный (не общий #138) guardSideEffect, чтобы тест
// не трогал журнал side-effect-guard.ts и не зависел от боевого контекста ralph.js.
function makeEnv(over: Partial<StateLockEnv> = {}): StateLockEnv {
    return {
        statePath: '/x/ralph.state.json',
        lockPath: '/x/ralph.lock',
        lockMarkerPath: '.deps-lock.sha',
        ralphPath: '.claude/ralph/ralph.js',
        dry: false,
        getConfig: () => ({ phases: [{ milestone: 'M1' }, { milestone: 'M2' }] }),
        log: () => {},
        fail: () => {},
        guardSideEffect: () => {},
        loadJson: () => null,
        processAlive: () => false,
        cmdlineIncludes: () => false,
        buildSanitizedGateEnv: () => ({ PATH: '/x' }),
        ...over,
    };
}

describe('defaultState — канонический полный state из первой фазы конфига', () => {
    it('milestone берётся из getConfig().phases[0], счётчики нулевые, барьеры пустые', () => {
        const { defaultState } = createStateLock(makeEnv());
        expect(defaultState()).toEqual({
            count: 0,
            milestone: 'M1',
            submitted: false,
            noProgress: 0,
            gateHeals: 0,
            blockedHeals: 0,
            reviewModelFloor: null,
            lastReviewModel: null,
            reReviewPending: false,
            reviewOfFixes: null,
            deployBlock: null,
        });
    });

    it('config читается ЛЕНИВО — правка phases после создания фабрики видна', () => {
        let phases = [{ milestone: 'FIRST' }];
        const { defaultState } = createStateLock(makeEnv({ getConfig: () => ({ phases }) }));
        phases = [{ milestone: 'SECOND' }];
        expect(defaultState().milestone).toBe('SECOND');
    });
});

describe('loadState — резолв state с диска через инжектированный loadJson', () => {
    it('валидный state (с milestone) возвращается как есть', () => {
        const state = { count: 5, milestone: 'M3', submitted: true, noProgress: 1 };
        const { loadState } = createStateLock(makeEnv({ loadJson: () => state }));
        expect(loadState()).toEqual(state);
    });

    it('нет файла (loadJson → null) → defaultState первой фазы', () => {
        const { loadState } = createStateLock(makeEnv({ loadJson: () => null }));
        expect(loadState().milestone).toBe('M1');
    });

    it('state старой схемы (без milestone) → зовёт инжектированный failFn', () => {
        const { loadState } = createStateLock(
            makeEnv({ loadJson: () => ({ count: 3, phaseIndex: 0, submitted: false }) }),
        );
        const failFn = vi.fn();
        loadState(failFn);
        expect(failFn).toHaveBeenCalledTimes(1);
        expect(failFn.mock.calls[0][0]).toMatch(/схем|phaseIndex/i);
    });
});

describe('saveState — C1 read-only (dry) + предохранитель #138', () => {
    it('dry=true → не пишет и не трогает guardSideEffect (строго read-only)', () => {
        const guardSideEffect = vi.fn(() => {
            throw new Error('guard не должен зваться в dry');
        });
        const { saveState } = createStateLock(makeEnv({ dry: true, guardSideEffect }));
        expect(() => saveState({ milestone: 'M1' } as never)).not.toThrow();
        expect(guardSideEffect).not.toHaveBeenCalled();
    });

    it('dry=false → проходит через guardSideEffect с путём state (боевой дефолт бы записал)', () => {
        // guard мимикрирует боевой (RALPH_NO_SIDE_EFFECTS): бросает ДО реальной записи на диск.
        const guardSideEffect = vi.fn((what: string) => {
            throw new Error(`${what} запрещено`);
        });
        const { saveState } = createStateLock(makeEnv({ dry: false, guardSideEffect }));
        expect(() => saveState({ milestone: 'M1' } as never)).toThrow(/ralph\.state\.json/);
        expect(guardSideEffect).toHaveBeenCalledWith('saveState(/x/ralph.state.json)');
    });
});

describe('lockHash / syncDepsIfLockChanged — маркер .deps-lock.sha', () => {
    const HASH_OF = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

    it('lockHash: sha256 содержимого package-lock.json, null если файла нет', () => {
        const { lockHash } = createStateLock(makeEnv());
        expect(lockHash('/x', (() => 'LOCKDATA') as never)).toBe(HASH_OF('LOCKDATA'));
        expect(
            lockHash('/x', (() => {
                throw new Error('ENOENT');
            }) as never),
        ).toBeNull();
    });

    it('lock не менялся (маркер == хэш) → npm ci НЕ гоняется', () => {
        const { syncDepsIfLockChanged } = createStateLock(makeEnv());
        const installFn = vi.fn();
        const lock = 'LOCK-A';
        syncDepsIfLockChanged({
            logFn: () => {},
            existsFn: (() => true) as never,
            readFn: ((p: string) =>
                String(p).endsWith('package-lock.json') ? lock : HASH_OF(lock)) as never,
            installFn,
        });
        expect(installFn).not.toHaveBeenCalled();
    });

    it('lock изменился (маркер != хэш) → npm ci и маркер перезаписан', () => {
        const { syncDepsIfLockChanged } = createStateLock(makeEnv());
        const installFn = vi.fn();
        const writes: Array<[string, string]> = [];
        syncDepsIfLockChanged({
            logFn: () => {},
            existsFn: (() => true) as never,
            readFn: ((p: string) =>
                String(p).endsWith('package-lock.json')
                    ? 'LOCK-NEW'
                    : HASH_OF('LOCK-OLD')) as never,
            writeFn: ((p: string, data: string) => writes.push([p, data])) as never,
            installFn,
        });
        expect(installFn).toHaveBeenCalledTimes(1);
        expect(writes.some(([, data]) => data === HASH_OF('LOCK-NEW'))).toBe(true);
    });
});

describe('acquireLock — fail-closed взятие через инжектированные примитивы', () => {
    const enoent = () => {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
    };

    it('лока нет (ENOENT) → берём себе: пишем pid, стоп не зовём', () => {
        const { acquireLock } = createStateLock(makeEnv());
        const writeFn = vi.fn();
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: '/x/ralph.lock',
            pid: 777,
            readFn: enoent as never,
            writeFn,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(true);
        expect(writeFn).toHaveBeenCalledWith('/x/ralph.lock', '777');
        expect(failFn).not.toHaveBeenCalled();
    });

    it('живой раннер держит лок (processAlive+cmdlineIncludes → true) → отказ с pid и путём', () => {
        // env-примитивы решают живость: оба true = держатель жив и это наш ralph.js.
        const { acquireLock } = createStateLock(
            makeEnv({ processAlive: () => true, cmdlineIncludes: () => true }),
        );
        const writeFn = vi.fn();
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: '/x/ralph.lock',
            pid: 777,
            readFn: (() => '4242') as never,
            procReadFn: (() => 'node\0.claude/ralph/ralph.js\0') as never,
            killFn: () => {},
            writeFn,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(false);
        expect(failFn).toHaveBeenCalledTimes(1);
        expect(failFn.mock.calls[0][0]).toContain('4242');
        expect(failFn.mock.calls[0][0]).toContain('/x/ralph.lock');
        expect(writeFn).not.toHaveBeenCalled();
    });

    it('осиротевший лок (processAlive → false) → снимаем, берём себе', () => {
        const { acquireLock } = createStateLock(makeEnv({ processAlive: () => false }));
        const writeFn = vi.fn();
        const removeFn = vi.fn();
        const ok = acquireLock({
            lockPath: '/x/ralph.lock',
            pid: 777,
            readFn: (() => '4242') as never,
            procReadFn: (() => '') as never,
            killFn: () => {},
            writeFn,
            removeFn,
            logFn: vi.fn(),
            failFn: vi.fn(),
        });
        expect(ok).toBe(true);
        expect(removeFn).toHaveBeenCalledWith('/x/ralph.lock');
        expect(writeFn).toHaveBeenCalledWith('/x/ralph.lock', '777');
    });

    it('битый лок-файл (не число) → стоп fail-closed, запись не зовём', () => {
        const { acquireLock } = createStateLock(makeEnv());
        const writeFn = vi.fn();
        const failFn = vi.fn();
        const ok = acquireLock({
            lockPath: '/x/ralph.lock',
            pid: 777,
            readFn: (() => 'мусор') as never,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(false);
        expect(failFn.mock.calls[0][0]).toMatch(/битый/);
        expect(writeFn).not.toHaveBeenCalled();
    });

    it('гонка взятия: writeFn бросает EEXIST внутри claim() → fail-closed отказ, старт запрещён', () => {
        // Лок появился между чтением (ENOENT) и записью — второй раннер стартовал
        // одновременно и его 'wx' победил. Наш claim() ловит EEXIST и отказывает.
        const { acquireLock } = createStateLock(makeEnv());
        const failFn = vi.fn();
        const writeFn = vi.fn(() => {
            const e = new Error('EEXIST') as NodeJS.ErrnoException;
            e.code = 'EEXIST';
            throw e;
        });
        const ok = acquireLock({
            lockPath: '/x/ralph.lock',
            pid: 777,
            readFn: enoent as never,
            writeFn: writeFn as never,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(false);
        expect(failFn).toHaveBeenCalledTimes(1);
        expect(failFn.mock.calls[0][0]).toMatch(/в момент взятия/);
    });

    it('нечитаемый лок-файл (не-ENOENT, напр. EACCES) → fail-closed стоп, не «лока нет»', () => {
        // Любая ошибка чтения кроме ENOENT — НЕ трактуем как свободный лок (это тихий
        // старт поверх возможного живого раннера). Стоп с просьбой разобраться руками.
        const { acquireLock } = createStateLock(makeEnv());
        const failFn = vi.fn();
        const writeFn = vi.fn();
        const eacces = () => {
            const e = new Error('EACCES') as NodeJS.ErrnoException;
            e.code = 'EACCES';
            throw e;
        };
        const ok = acquireLock({
            lockPath: '/x/ralph.lock',
            pid: 777,
            readFn: eacces as never,
            writeFn,
            logFn: vi.fn(),
            failFn,
        });
        expect(ok).toBe(false);
        expect(failFn).toHaveBeenCalledTimes(1);
        expect(failFn.mock.calls[0][0]).toMatch(/нечитаем|EACCES/);
        expect(writeFn).not.toHaveBeenCalled();
    });
});

describe('isRalphProcess — за pid действительно наш ralph.js (#176)', () => {
    itPosix('в /proc/<pid>/cmdline есть путь ralph.js → это наш раннер', () => {
        const readFn = vi.fn(() => 'node\0.claude/ralph/ralph.js\0--profile\0prod\0');
        expect(isRalphProcess(4242, readFn)).toBe(true);
        expect(readFn).toHaveBeenCalledWith('/proc/4242/cmdline', 'utf-8');
    });

    // Строгая сверка по полному пути: раннер чужого проекта со своим ralph.js (имя
    // родовое) не должен сойти за наш — как isRalphMonitorProcess vs isMonitorProcess.
    it('чужой ralph.js по другому пути → false', () => {
        expect(isRalphProcess(4242, () => 'node\0/opt/other/ralph.js\0')).toBe(false);
    });

    // ОС переиспользовала pid: живой процесс есть, но это не раннер.
    it('чужой процесс под тем же pid (pid-reuse) → false', () => {
        expect(isRalphProcess(4242, () => 'nginx\0-g\0daemon off;\0')).toBe(false);
    });

    it('процесса нет (чтение /proc упало) → false', () => {
        expect(
            isRalphProcess(4242, () => {
                throw new Error('ENOENT');
            }),
        ).toBe(false);
    });

    it('пустой/нулевой pid → false без чтения /proc', () => {
        const readFn = vi.fn();
        expect(isRalphProcess(0, readFn)).toBe(false);
        expect(isRalphProcess(undefined, readFn)).toBe(false);
        expect(readFn).not.toHaveBeenCalled();
    });
});

describe('lockAlive — держит ли лок живой раннер (#176)', () => {
    const ralphCmdline = () => 'node\0.claude/ralph/ralph.js\0--profile\0prod\0';

    itPosix('номер занят И cmdline — наш ralph.js → лок жив', () => {
        expect(lockAlive(4242, { killFn: () => undefined, procReadFn: ralphCmdline })).toBe(true);
    });

    it('номер свободен (kill бросил ESRCH) → лок сирота, /proc не читаем', () => {
        const procReadFn = vi.fn();
        expect(
            lockAlive(4242, {
                killFn: () => {
                    throw new Error('ESRCH');
                },
                procReadFn,
            }),
        ).toBe(false);
        // kill(pid,0) отсёк первым — до cmdline-сверки не дошли.
        expect(procReadFn).not.toHaveBeenCalled();
    });

    // Ключевой сценарий pid-reuse: номер занят, но за ним чужой процесс — не живой раннер,
    // легитимный запуск не блокируется.
    it('номер занят, но за ним чужой процесс → лок сирота (не живой раннер)', () => {
        expect(
            lockAlive(4242, {
                killFn: () => undefined,
                procReadFn: () => 'nginx\0-g\0daemon off;\0',
            }),
        ).toBe(false);
    });

    it('пустой/нулевой pid → мёртв', () => {
        expect(lockAlive(0, { killFn: () => undefined, procReadFn: ralphCmdline })).toBe(false);
        expect(lockAlive(NaN, { killFn: () => undefined, procReadFn: ralphCmdline })).toBe(false);
    });
});

describe('writeLock — запись pid в лок-файл (#176)', () => {
    it('пишет pid строкой по указанному пути', () => {
        const writeFn = vi.fn();
        writeLock(4242, { writeFn, lockPath: '.claude/ralph/ralph.lock' });
        expect(writeFn).toHaveBeenCalledWith('.claude/ralph/ralph.lock', '4242');
    });

    it('по умолчанию — pid текущего процесса', () => {
        const writeFn = vi.fn();
        writeLock(undefined, { writeFn });
        expect(writeFn).toHaveBeenCalledWith(expect.any(String), String(process.pid));
    });

    // Предохранитель #138: боевой дефолт writeFn зовёт guardSideEffect — в тестах
    // (RALPH_NO_SIDE_EFFECTS=1) забытый мок бросит, а не насорит настоящим ralph.lock.
    it('боевой дефолт writeFn под guardSideEffect (#138)', () => {
        expect(() => writeLock(4242, { lockPath: '.claude/ralph/ralph.lock' })).toThrow(
            /RALPH_NO_SIDE_EFFECTS/,
        );
        // Вызов намеренный — журнал забираем сами, иначе общий afterEach уронит тест.
        expect(ralph.sideEffectAttempts.splice(0)).toEqual([
            'writeLock (.claude/ralph/ralph.lock)',
        ]);
    });
});

describe('removeLock — снятие лок-файла (#177)', () => {
    it('зовёт removeFn по указанному пути', () => {
        const removeFn = vi.fn();
        removeLock({ lockPath: '.claude/ralph/ralph.lock', removeFn });
        expect(removeFn).toHaveBeenCalledWith('.claude/ralph/ralph.lock');
    });

    // Предохранитель #138: боевой дефолт removeFn зовёт guardSideEffect — забытый мок
    // в тесте бросит, а не снесёт настоящий ralph.lock живого прогона.
    it('боевой дефолт removeFn под guardSideEffect (#138)', () => {
        expect(() => removeLock({ lockPath: '.claude/ralph/ralph.lock' })).toThrow(
            /RALPH_NO_SIDE_EFFECTS/,
        );
        expect(ralph.sideEffectAttempts.splice(0)).toEqual([
            'removeLock (.claude/ralph/ralph.lock)',
        ]);
    });
});

describe('releaseLockIfOurs — снятие своего лока при выходе (#176)', () => {
    it('файл держит наш pid → снимаем через removeFn по тому же пути', () => {
        const removeFn = vi.fn();
        releaseLockIfOurs('/abs/ralph.lock', { readFn: () => '777\n', removeFn, pid: 777 });
        expect(removeFn).toHaveBeenCalledWith('/abs/ralph.lock');
    });

    it('файл держит ЧУЖОЙ pid (лок украли/переписали) → не трогаем', () => {
        const removeFn = vi.fn();
        releaseLockIfOurs('/abs/ralph.lock', { readFn: () => '4242', removeFn, pid: 777 });
        expect(removeFn).not.toHaveBeenCalled();
    });

    it('файла нет / нечитаем → снимать нечего, removeFn не зовём', () => {
        const removeFn = vi.fn();
        releaseLockIfOurs('/abs/ralph.lock', {
            readFn: () => {
                throw new Error('ENOENT');
            },
            removeFn,
            pid: 777,
        });
        expect(removeFn).not.toHaveBeenCalled();
    });
});

// #366: сценарии syncDepsIfLockChanged, которых нет в фабричных тестах выше, — отсутствие
// package-lock.json, первый гейт без маркера и проводка санированного env в npm ci (#189).
// Перенесены из ralph.test.js, ходят через ре-экспорт ralph.js.
describe('syncDepsIfLockChanged — no-op, первый гейт и env для npm ci (#SiaUX/#189)', () => {
    const { syncDepsIfLockChanged } = ralph;

    it('нет package-lock.json → no-op (сверять нечего, npm ci не гоняется)', () => {
        const installFn = vi.fn();
        syncDepsIfLockChanged({
            logFn: () => {},
            existsFn: () => true,
            readFn: () => {
                throw new Error('ENOENT');
            },
            installFn,
        });
        expect(installFn).not.toHaveBeenCalled();
    });

    it('маркера ещё нет (первый гейт после bootstrap) → prev=null, npm ci гоняется', () => {
        const installFn = vi.fn();
        syncDepsIfLockChanged({
            logFn: () => {},
            existsFn: () => false, // маркер-файла нет
            readFn: (p: string) => (String(p).endsWith('package-lock.json') ? 'LOCK' : ''),
            writeFn: () => {},
            installFn,
        });
        expect(installFn).toHaveBeenCalledTimes(1);
    });

    it('#189: env (санированный, из checksGreen) прокидывается в installFn для npm ci', () => {
        const installFn = vi.fn();
        const SAN = { PATH: '/x' };
        syncDepsIfLockChanged({
            logFn: () => {},
            existsFn: () => false,
            readFn: (p: string) => (String(p).endsWith('package-lock.json') ? 'LOCK' : ''),
            writeFn: () => {},
            env: SAN,
            installFn,
        });
        expect(installFn).toHaveBeenCalledWith(SAN);
    });

    it('#189: без env строит его сам через buildGateEnvFn (fail-closed самодостаточен)', () => {
        const installFn = vi.fn();
        const SAN = { PATH: '/y' };
        const buildGateEnvFn = vi.fn(() => SAN);
        syncDepsIfLockChanged({
            logFn: () => {},
            existsFn: () => false,
            readFn: (p: string) => (String(p).endsWith('package-lock.json') ? 'LOCK' : ''),
            writeFn: () => {},
            buildGateEnvFn,
            installFn,
        });
        expect(buildGateEnvFn).toHaveBeenCalled();
        expect(installFn).toHaveBeenCalledWith(SAN);
    });
});

// #366: сценарии acquireLock, которых нет в фабричных тестах выше. Здесь лок берётся через
// боевую поверхность ralph.js с НАСТОЯЩИМИ processAlive/cmdlineIncludes (замокан только
// /proc и kill) — поэтому видны классы, невидимые заглушкам: pid-reuse (номер жив, но за
// ним чужой процесс), гонка на реклейме сироты и битые значения в самом лок-файле.
describe('acquireLock — pid-reuse, гонка реклейма и битый лок-файл (#177)', () => {
    const ralphCmdline = () => 'node\0.claude/ralph/ralph.js\0--profile\0prod\0';
    const enoent = () => {
        const e = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
    };
    // readFn читает ТОЛЬКО лок-файл, procReadFn — ТОЛЬКО /proc/<pid>/cmdline: раздельные
    // контракты, тесту не надо мультиплексировать по пути. deps со всеми побочками
    // замоканными — тест ничего не пишет и не роняет процесс.
    const deps = (over = {}) => ({
        lockPath: '.claude/ralph/ralph.lock',
        pid: 777,
        readFn: enoent,
        procReadFn: ralphCmdline,
        killFn: () => undefined,
        removeFn: vi.fn(),
        writeFn: vi.fn(),
        logFn: vi.fn(),
        failFn: vi.fn(),
        ...over,
    });
    const { acquireLock } = ralph;

    // Ключевой сценарий pid-reuse: номер занят, но за ним ЧУЖОЙ процесс — не живой раннер.
    it('осиротевший лок (pid-reuse, чужой cmdline) → снимаем и берём себе', () => {
        const d = deps({
            readFn: () => '4242',
            procReadFn: () => 'nginx\0-g\0daemon off;\0',
            killFn: () => undefined,
        });
        expect(acquireLock(d)).toBe(true);
        expect(d.removeFn).toHaveBeenCalledWith('.claude/ralph/ralph.lock');
        expect(d.writeFn).toHaveBeenCalledWith('.claude/ralph/ralph.lock', '777');
        expect(d.failFn).not.toHaveBeenCalled();
    });

    // Гонка на пути реклейма сироты: unlink прошёл, но лок пересоздал конкурент → EEXIST.
    it('реклейм сироты: лок пересоздан между unlink и записью (EEXIST) → отказ', () => {
        const eexist = () => {
            const e = new Error('EEXIST') as NodeJS.ErrnoException;
            e.code = 'EEXIST';
            throw e;
        };
        const d = deps({
            readFn: () => '4242',
            killFn: () => {
                throw new Error('ESRCH');
            },
            removeFn: vi.fn(),
            writeFn: eexist,
        });
        expect(acquireLock(d)).toBe(false);
        expect(d.removeFn).toHaveBeenCalledWith('.claude/ralph/ralph.lock');
        expect(d.failFn).toHaveBeenCalledTimes(1);
        expect(d.failFn.mock.calls[0][0]).toContain('в момент взятия');
    });

    it('пустой лок-файл → стоп fail-closed (битый)', () => {
        const d = deps({ readFn: () => '   \n' });
        expect(acquireLock(d)).toBe(false);
        expect(d.failFn).toHaveBeenCalledTimes(1);
        expect(d.failFn.mock.calls[0][0]).toContain('битый');
        expect(d.writeFn).not.toHaveBeenCalled();
    });

    it('отрицательный / нулевой pid в файле → стоп fail-closed (битый)', () => {
        for (const bad of ['0', '-5']) {
            const d = deps({ readFn: () => bad });
            expect(acquireLock(d)).toBe(false);
            expect(d.failFn).toHaveBeenCalledTimes(1);
            expect(d.writeFn).not.toHaveBeenCalled();
        }
    });

    // Побочки взятия лока запрещены до вердикта: при живом локе НИ writeFn, НИ removeFn.
    itPosix('на любом отказном пути state/git не трогаются (writeFn/removeFn не зовутся)', () => {
        const live = deps({ readFn: () => '4242', procReadFn: ralphCmdline });
        acquireLock(live);
        expect(live.writeFn).not.toHaveBeenCalled();
        expect(live.removeFn).not.toHaveBeenCalled();
    });
});

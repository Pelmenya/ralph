// Юнит-тесты модуля state/lock (#359). Основная часть проверяет САМУ фабрику
// createStateLock — что она собирает рабочие функции из синтетического env, независимо
// от ralph.js: контракт extraction'а — модуль самодостаточен и переносим (цель фазы 2),
// а не «работает только пока его зовёт ralph.js». Проход «через ре-экспорт ralph.js» с
// боевым контекстом раннера — в lock-scenarios.test.ts и в блоках в конце этого файла,
// перенесённых из ralph.test.js при её разнесении по модулям (#366).
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import type { StateLockEnv } from './state-lock.ts';
import { createStateLock, inspectState, STATE_SCHEMA_VERSION } from './state-lock.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов; блоки в конце файла
// перенесены из ralph.test.js как есть и ходят через его ре-экспорт (#366).
import ralph from '../ralph.js';

// Платформенное: тест опирается на POSIX-механизмы, которых на Windows нет
// (/proc/<pid>/cmdline, пути соседнего worktree, /bin/sh). Раннер живёт на
// Linux-VPS, поэтому пометка, а не вторая реализация — грабля 7 в
// docs/ralph-runner/portability-log.md. Снять вместе с платформенным швом.
const itPosix = it.skipIf(process.platform === 'win32');

const { isRalphProcess, lockAlive, writeLock, removeLock, releaseLockIfOurs } = ralph;

const noFile = (): string => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
};
const fileWith = (text: string) => () => text;

// Синтетический env: пути-заглушки, отдельный (не общий #138) guardSideEffect, чтобы тест
// не трогал журнал side-effect-guard.ts и не зависел от боевого контекста ralph.js.
function makeEnv(over: Partial<StateLockEnv> = {}): StateLockEnv {
    return {
        statePath: '/x/ralph.state.json',
        lockPath: '/x/ralph.lock',
        lockMarkerPath: '.deps-lock.sha',
        ralphPaths: ['.claude/ralph/ralph.js'],
        dry: false,
        getConfig: () => ({ phases: [{ milestone: 'M1' }, { milestone: 'M2' }] }),
        log: () => {},
        fail: () => {},
        guardSideEffect: () => {},
        readFile: noFile,
        copyFile: () => {
            throw new Error('copyFile не подменён в тесте');
        },
        now: () => new Date('2026-10-26T01:02:03.456Z'),
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
            schemaVersion: STATE_SCHEMA_VERSION,
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
            forgeHealedRunId: null,
        });
    });

    it('config читается ЛЕНИВО — правка phases после создания фабрики видна', () => {
        let phases = [{ milestone: 'FIRST' }];
        const { defaultState } = createStateLock(makeEnv({ getConfig: () => ({ phases }) }));
        phases = [{ milestone: 'SECOND' }];
        expect(defaultState().milestone).toBe('SECOND');
    });
});

// Задача 80: раньше чтение шло через loadJson с фолбэком null, и обрезанный файл читался
// как отсутствующий — петля начинала с первой фазы поверх незаконченной.
describe('inspectState — версия схемы и форма state', () => {
    const v1 = { schemaVersion: 1, count: 2, milestone: 'M1', submitted: false };
    const v2 = { schemaVersion: 2, count: 2, milestone: 'M1', submitStages: [] };

    it('годный v2 — ok без миграции', () => {
        const r = inspectState(JSON.stringify(v2));
        expect(r).toMatchObject({ status: 'ok', migrated: false });
        if (r.status !== 'ok') return;
        expect(r.state).toMatchObject({ schemaVersion: 2, count: 2, milestone: 'M1' });
        expect(r.state.submitted).toBe(false);
        expect(r.state).not.toHaveProperty('refusalSeries');
        expect(r.state.fixPlans ?? 0).toBe(0);
    });

    it('годный fixPlans сохраняется при чтении v2', () => {
        const r = inspectState(JSON.stringify({ ...v2, fixPlans: 3 }));
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.state.fixPlans).toBe(3);
    });

    it.each(['3', -1])('битый fixPlans (%j) — повреждение с именем поля', (fixPlans) => {
        const r = inspectState(JSON.stringify({ ...v2, fixPlans }));
        expect(r).toMatchObject({
            status: 'corrupt',
            reason: expect.stringMatching(/fixPlans/),
        });
    });

    it('годная refusalSeries сохраняется при чтении v2', () => {
        const refusalSeries = {
            milestone: 'M1',
            issue: 7,
            stage: 'coder',
            code: 'intent-rejected',
            params: { what: 'битое намерение' },
            count: 1,
            reason: 'отказ разбора',
            evidence: null,
            attemptShas: ['abc'],
        };
        const r = inspectState(JSON.stringify({ ...v2, refusalSeries }));
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.state.refusalSeries).toEqual(refusalSeries);
    });

    it('refusalSeries null означает отсутствие серии', () => {
        const r = inspectState(JSON.stringify({ ...v2, refusalSeries: null }));
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.state.refusalSeries).toBeNull();
    });

    it('битая refusalSeries — повреждение с именем поля', () => {
        const r = inspectState(JSON.stringify({ ...v2, refusalSeries: { count: 0 } }));
        expect(r).toMatchObject({
            status: 'corrupt',
            reason: expect.stringMatching(/refusalSeries/),
        });
    });

    it('годный v1 — проверенная миграция в v2', () => {
        const r = inspectState(JSON.stringify(v1));
        expect(r).toMatchObject({ status: 'ok', migrated: true });
        if (r.status !== 'ok') return;
        expect(r.state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    });

    it('без версии, но годной формы — проверенная миграция в текущую версию', () => {
        const r = inspectState(JSON.stringify({ count: 1, milestone: null, submitted: true }));
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.migrated).toBe(true);
        expect(r.state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    });

    it('без версии и НЕгодной формы — не миграция, а повреждение', () => {
        const r = inspectState(JSON.stringify({ count: '1', milestone: 'M1', submitted: true }));
        expect(r).toMatchObject({ status: 'corrupt', reason: expect.stringMatching(/count/) });
    });

    it.each([
        ['обрезанный JSON', '{"count": 3, "milestone": "M'],
        ['пустой файл', ''],
        ['не объект', '[1,2]'],
        ['null', 'null'],
    ])('%s — повреждён', (_, text) => {
        expect(inspectState(text).status).toBe('corrupt');
    });

    it.each([
        ['submitted не boolean', { submitted: 'no' }],
        ['milestone число', { milestone: 3 }],
        ['count отрицательный', { count: -1 }],
        ['gateHeals строка', { gateHeals: '2' }],
        ['gateHeals отрицательный', { gateHeals: -1 }],
        ['blockedHeals дробный', { blockedHeals: 1.5 }],
        ['deployBlock без milestone и reason', { deployBlock: { status: 'red' } }],
        ['reviewModelFloor число', { reviewModelFloor: 5 }],
        ['reReviewPending строка', { reReviewPending: 'yes' }],
        ['deployBlock строка', { deployBlock: 'red' }],
        ['schemaVersion строка', { schemaVersion: '1' }],
    ])('%s — повреждён, а не принят', (_, over) => {
        const r = inspectState(JSON.stringify({ ...v1, ...over }));
        expect(r.status).toBe('corrupt');
    });

    it('другая версия схемы — отдельный исход, форма не проверяется', () => {
        // Будущая схема вправе выглядеть иначе: «повреждён» здесь было бы ложью.
        const r = inspectState(JSON.stringify({ schemaVersion: 3, phase: { name: 'M1' } }));
        expect(r).toMatchObject({ status: 'foreign-version', found: 3 });
    });

    it('без milestone — старая схема (phaseIndex)', () => {
        const r = inspectState(JSON.stringify({ count: 3, phaseIndex: 0, submitted: false }));
        expect(r.status).toBe('old-schema');
    });

    it('v1 без milestone — не старая схема, а повреждение', () => {
        const r = inspectState(JSON.stringify({ schemaVersion: 1, count: 0, submitted: false }));
        expect(r).toMatchObject({ status: 'corrupt', reason: expect.stringMatching(/milestone/) });
    });
});

describe('loadState — state с диска через инжектированный readFile', () => {
    it('валидный state (с milestone) возвращается как есть', () => {
        const state = {
            schemaVersion: 2,
            count: 5,
            milestone: 'M3',
            noProgress: 1,
            submitStages: [],
        };
        const { loadState } = createStateLock(
            makeEnv({ readFile: fileWith(JSON.stringify(state)) }),
        );
        const { submitStages: _j, ...fields } = state;
        expect(loadState()).toEqual({
            ...fields,
            submitted: false,
            deployBlock: null,
            reviewOfFixes: null,
        });
    });

    it('нет файла (ENOENT) → штатный defaultState первой фазы', () => {
        const { loadState, defaultState } = createStateLock(makeEnv({ readFile: noFile }));
        expect(loadState()).toEqual(defaultState());
    });

    it('обрезанный JSON → старт отвергнут с диагнозом «повреждён», файл не тронут', () => {
        const guardSideEffect = vi.fn();
        const copyFile = vi.fn();
        const { loadState } = createStateLock(
            makeEnv({
                readFile: fileWith('{"count": 3, "milestone": "M2", "subm'),
                guardSideEffect,
                copyFile,
            }),
        );
        const failFn = vi.fn();
        expect(() => loadState(failFn)).toThrow(/повреждён/);
        expect(failFn).toHaveBeenCalledTimes(1);
        const msg = failFn.mock.calls[0][0] as string;
        expect(msg).toMatch(/State \/x\/ralph\.state\.json повреждён: не JSON/);
        expect(msg).toMatch(/оставлен на месте для разбора/);
        // Сохранён — значит не перезаписан и не скопирован: ни одной пишущей побочки.
        expect(guardSideEffect).not.toHaveBeenCalled();
        expect(copyFile).not.toHaveBeenCalled();
    });

    it('файл есть, но не читается (EACCES) → отказ «не читается», а не «состояния нет» и не «повреждён»', () => {
        const { loadState } = createStateLock(
            makeEnv({
                readFile: () => {
                    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
                },
            }),
        );
        const failFn = vi.fn();
        expect(() => loadState(failFn)).toThrow(/не читается \(EACCES\)/);
        const msg = failFn.mock.calls[0][0] as string;
        expect(msg).toMatch(/права/);
        expect(msg).not.toMatch(/повреждён/);
        expect(msg).not.toMatch(/сохранит его копией/);
    });

    it('state другой версии схемы → отказ с обеими версиями в тексте', () => {
        const { loadState } = createStateLock(
            makeEnv({
                readFile: fileWith(
                    JSON.stringify({
                        schemaVersion: 7,
                        count: 0,
                        milestone: 'M1',
                        submitted: false,
                    }),
                ),
            }),
        );
        const failFn = vi.fn();
        expect(() => loadState(failFn)).toThrow();
        expect(failFn.mock.calls[0][0]).toMatch(/схемы v7, а этот раннер знает v2/);
    });

    it('state без версии → проверенная миграция с строкой в логе', () => {
        const log = vi.fn();
        const { loadState } = createStateLock(
            makeEnv({
                log,
                readFile: fileWith(JSON.stringify({ count: 1, milestone: 'M2', submitted: false })),
            }),
        );
        expect(loadState()).toMatchObject({ schemaVersion: 2, milestone: 'M2', count: 1 });
        expect(log).toHaveBeenCalledWith(
            expect.stringMatching(/прежней схемы — форма проверена.*перенесены в журнал этапов/),
        );
    });

    it('state старой схемы (без milestone) → зовёт инжектированный failFn', () => {
        const { loadState } = createStateLock(
            makeEnv({
                readFile: fileWith(JSON.stringify({ count: 3, phaseIndex: 0, submitted: false })),
            }),
        );
        const failFn = vi.fn();
        expect(() => loadState(failFn)).toThrow();
        expect(failFn).toHaveBeenCalledTimes(1);
        expect(failFn.mock.calls[0][0]).toMatch(/схем|phaseIndex/i);
    });
});

describe('resetState — --reset не теряет улику и не снимает барьер деплоя вслепую', () => {
    it('повреждённый state без --deploy-resolved → отказ: барьер деплоя не прочитать', () => {
        const guardSideEffect = vi.fn();
        const copyFile = vi.fn();
        const { resetState } = createStateLock(
            makeEnv({ readFile: fileWith('{"deployBl'), guardSideEffect, copyFile }),
        );
        const failFn = vi.fn();
        expect(() => resetState({ deployResolved: false, failFn })).toThrow(/не прочитать/);
        expect(copyFile).not.toHaveBeenCalled();
        expect(guardSideEffect).not.toHaveBeenCalled();
    });

    it('повреждённый state с --deploy-resolved → копия для разбора ДО перезаписи', () => {
        const order: string[] = [];
        const copyFile = vi.fn(
            (from: string, to: string) => void order.push(`copy ${from} → ${to}`),
        );
        const guardSideEffect = (what: string) => {
            order.push(what);
            throw new Error('стоп до настоящей записи');
        };
        const { resetState } = createStateLock(
            makeEnv({ readFile: fileWith('{"count":'), guardSideEffect, copyFile }),
        );
        expect(() => resetState({ deployResolved: true })).toThrow(/стоп до настоящей записи/);
        expect(order).toEqual([
            'copy /x/ralph.state.json → /x/ralph.state.json.corrupt-2026-10-26T01-02-03-456Z',
            'saveState(/x/ralph.state.json)',
        ]);
    });

    it('нечитаемый state (EISDIR) → --reset отказывает, ничего не копирует и не пишет', () => {
        const guardSideEffect = vi.fn();
        const copyFile = vi.fn();
        const { resetState } = createStateLock(
            makeEnv({
                readFile: () => {
                    throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
                },
                guardSideEffect,
                copyFile,
            }),
        );
        expect(() => resetState({ deployResolved: true, failFn: () => {} })).toThrow(
            /не читается \(EISDIR\)/,
        );
        expect(copyFile).not.toHaveBeenCalled();
        expect(guardSideEffect).not.toHaveBeenCalled();
    });

    it.each([
        ['старой схемы', { count: 3, phaseIndex: 0, submitted: false }, '.old-schema-'],
        ['чужой версии', { schemaVersion: 9, count: 0, milestone: 'M1', submitted: false }, '.v9-'],
    ])('копия state %s названа по причине, а не «corrupt»', (_t, state, suffix) => {
        const copies: string[] = [];
        const { resetState } = createStateLock(
            makeEnv({
                readFile: fileWith(JSON.stringify(state)),
                copyFile: (_from: string, to: string) => void copies.push(to),
                guardSideEffect: () => {
                    throw new Error('стоп до записи');
                },
            }),
        );
        expect(() => resetState({ deployResolved: false })).toThrow('стоп до записи');
        expect(copies).toEqual([expect.stringContaining(`ralph.state.json${suffix}`)]);
        expect(copies[0]).not.toContain('corrupt');
    });

    it('годный state без барьера — сброс без копии', () => {
        const writes: string[] = [];
        // Guard бросает, как боевой под RALPH_NO_SIDE_EFFECTS: до настоящей записи не доходит.
        const guardSideEffect = (what: string) => {
            writes.push(what);
            throw new Error('стоп до записи');
        };
        const copyFile = vi.fn();
        const state = { schemaVersion: 1, count: 4, milestone: 'M2', submitted: true };
        const { resetState } = createStateLock(
            makeEnv({ readFile: fileWith(JSON.stringify(state)), guardSideEffect, copyFile }),
        );
        expect(() => resetState({ deployResolved: false })).toThrow('стоп до записи');
        expect(copyFile).not.toHaveBeenCalled();
        expect(writes).toEqual(['saveState(/x/ralph.state.json)']);
    });

    it('годный state с активным барьером деплоя без флага → прежний отказ #THS8J', () => {
        const state = {
            schemaVersion: 1,
            count: 0,
            milestone: 'M2',
            submitted: false,
            deployBlock: { milestone: 'M1', reason: 'деплой красный' },
        };
        const { resetState } = createStateLock(
            makeEnv({ readFile: fileWith(JSON.stringify(state)) }),
        );
        expect(() => resetState({ deployResolved: false, failFn: () => {} })).toThrow(
            /активном барьере красного деплоя фазы "M1" \(деплой красный\)/,
        );
    });

    it('чужая версия схемы: барьер достаётся из разобранного JSON, копия сохраняется', () => {
        const state = { schemaVersion: 9, deployBlock: { milestone: 'M1', reason: 'r' } };
        const { resetState } = createStateLock(
            makeEnv({ readFile: fileWith(JSON.stringify(state)) }),
        );
        expect(() => resetState({ deployResolved: false, failFn: () => {} })).toThrow(/барьере/);
    });

    // #93: в v2 барьер живёт этапом журнала, а не полем — --reset на повреждённом v2
    // обязан найти его там, иначе снял бы барьер без --deploy-resolved.
    const v2Barrier = (extra: Record<string, unknown>, stages: unknown) => ({
        schemaVersion: 2,
        count: 0,
        milestone: 'M2',
        submitStages: stages,
        ...extra,
    });
    const deployStop = [
        { v: 1, track: 'submit', milestone: 'M1', stage: 'pr', event: 'start', at: 't' },
        {
            v: 1,
            track: 'submit',
            milestone: 'M1',
            stage: 'pr',
            event: 'outcome',
            outcome: 'ok',
            at: 't',
        },
        ...['review', 'fixes', 'fix-review', 'arbiter', 'gate', 'merge'].flatMap((stage) => [
            { v: 1, track: 'submit', milestone: 'M1', stage, event: 'start', at: 't' },
            {
                v: 1,
                track: 'submit',
                milestone: 'M1',
                stage,
                event: 'outcome',
                outcome: 'ok',
                at: 't',
            },
        ]),
        { v: 1, track: 'submit', milestone: 'M1', stage: 'deploy', event: 'start', at: 't' },
        {
            v: 1,
            track: 'submit',
            milestone: 'M1',
            stage: 'deploy',
            event: 'outcome',
            outcome: 'stop',
            detail: { milestone: 'M1', reason: 'деплой красный' },
            at: 't',
        },
    ];

    it('повреждённый v2 с барьером в журнале → отказ без --deploy-resolved', () => {
        const copyFile = vi.fn();
        const { resetState } = createStateLock(
            makeEnv({
                readFile: fileWith(JSON.stringify(v2Barrier({ count: -1 }, deployStop))),
                copyFile,
            }),
        );
        expect(() => resetState({ deployResolved: false, failFn: () => {} })).toThrow(
            /активном барьере красного деплоя фазы "M1" \(деплой красный\)/,
        );
        expect(copyFile).not.toHaveBeenCalled();
    });

    it('v2 с неразбираемым журналом — барьер неизвестен, --reset требует флаг', () => {
        const { resetState } = createStateLock(
            makeEnv({ readFile: fileWith(JSON.stringify(v2Barrier({}, [{ v: 7 }]))) }),
        );
        expect(() => resetState({ deployResolved: false, failFn: () => {} })).toThrow(
            /не прочитать/,
        );
    });

    it('v2 с этапом деплоя без детали — барьер читается неизвестным, а не снятым', () => {
        const noDetail = deployStop.map((r) =>
            r.stage === 'deploy' && r.event === 'outcome' ? { ...r, detail: undefined } : r,
        );
        const { resetState } = createStateLock(
            makeEnv({ readFile: fileWith(JSON.stringify(v2Barrier({ count: -1 }, noDetail))) }),
        );
        expect(() => resetState({ deployResolved: false, failFn: () => {} })).toThrow(
            /барьере красного деплоя фазы "M1" \(барьер деплоя без записанной причины/,
        );
    });

    it('dry: копию не пишет и state не перезаписывает', () => {
        const copyFile = vi.fn();
        const guardSideEffect = vi.fn();
        const { resetState } = createStateLock(
            makeEnv({ dry: true, readFile: fileWith('{'), guardSideEffect, copyFile }),
        );
        expect(resetState({ deployResolved: true })).toBeNull();
        expect(copyFile).not.toHaveBeenCalled();
        expect(guardSideEffect).not.toHaveBeenCalled();
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

    // Задача 122: раннер из установки запущен по абсолютному пути
    // (`node <установка>/ralph.js`) — подстроки `.claude/ralph/ralph.js` в cmdline нет, и по
    // одной ей лок ЖИВОГО раннера считался сиротой.
    itPosix('запуск из установки по абсолютному пути — тоже наш раннер', () => {
        const entry = path.resolve(import.meta.dirname, '..', 'ralph.js');
        expect(isRalphProcess(4242, () => `node\0${entry}\0--profile\0prod\0`)).toBe(true);
    });

    it('от противного: соседняя установка другой ревизии — не наш раннер', () => {
        const entry = path.resolve(import.meta.dirname, '..', 'ralph.js');
        const other = entry.replace(/[^/]+\/ralph\.js$/, 'other-rev/ralph.js');
        expect(isRalphProcess(4242, () => `node\0${other}\0--profile\0prod\0`)).toBe(false);
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

describe('маркер зависимостей и его читатель смотрят в один путь (ревью !19)', () => {
    it('абсолютный путь маркера не склеивается с деревом', async () => {
        // Склейка увела бы запись внутрь дерева, а проверка читает runtimeDir: маркер не
        // находился бы никогда, и `npm ci` шёл бы перед каждым гейтом — незаметно, просто
        // «гейт стал медленным».
        const { underRoot } = await import('./roots.ts');
        expect(underRoot('/work/tree', '/state/prod/.deps-lock.sha')).toBe(
            '/state/prod/.deps-lock.sha',
        );
        expect(underRoot('/work/tree', '.claude/ralph/.deps-lock.sha')).toBe(
            '/work/tree/.claude/ralph/.deps-lock.sha',
        );
    });
});

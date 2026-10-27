import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTERS_CONTRACT_VERSION } from '../adapters/adapters-impl.ts';
import {
    COMPAT_LAYERS,
    CORE_REQUIRES_ADAPTERS,
    LAUNCHER_VERSION_ENV,
    checkCompatibility,
    compatLockOf,
    doctorFlagConflict,
    doctorStatePath,
    describeCompat,
    inspectStateAt,
    observeAdapters,
    observeConfig,
    observeCore,
    observeLauncher,
    observeState,
    runDoctor,
    runDoctorMode,
    supportedVersions,
    type TCompatInput,
    type TCompatLayer,
    type TObservation,
} from './compat.ts';
import { STATE_SCHEMA_VERSION } from './state-lock.ts';

const SUP = supportedVersions();
const LOCK = { path: '/c/.ralph/core.lock', versions: { ...SUP } };

function v(version: number): TObservation {
    return { kind: 'version', version };
}

// Штатный путь: каждый слой заявил ровно то, что понимает ядро.
function allGood(): TCompatInput['observed'] {
    return {
        launcher: v(SUP.launcher),
        core: v(SUP.core),
        config: v(SUP.config),
        state: v(SUP.state),
        adapters: v(SUP.adapters),
    };
}

function refusalOf(input: TCompatInput, layer: TCompatLayer): string {
    const r = checkCompatibility(input);
    expect(r.ok).toBe(false);
    const l = r.layers.find((x) => x.layer === layer);
    expect(l?.status).toBe('refused');
    return l?.status === 'refused' ? l.reason : '';
}

describe('несовместимость каждого слоя — отказ: слой, ожидаемая версия, что делать', () => {
    // Наблюдаемая сторона новее ожидаемого. Для state «старше» законно (миграция), поэтому
    // направление у всех одно — на единицу больше.
    it.each(COMPAT_LAYERS)('%s новее ожидаемого', (layer) => {
        const observed = { ...allGood(), [layer]: v(SUP[layer] + 1) };
        const reason = refusalOf({ lock: LOCK, observed }, layer);
        expect(reason).toMatch(new RegExp(`^слой ${layer}: ожидалась v${String(SUP[layer])}`));
        expect(reason).toContain(`найдена v${String(SUP[layer] + 1)}`);
        expect(reason).toContain(`lock ${LOCK.path}`);
        expect(reason).toMatch(/Что делать: \S/);
        // Отвергнут ровно этот слой, остальные прошли: сообщение не тонет в соседях.
        const r = checkCompatibility({ lock: LOCK, observed });
        expect(r.layers.filter((l) => l.status === 'refused').map((l) => l.layer)).toEqual([layer]);
    });

    it.each(COMPAT_LAYERS.filter((l) => l !== 'state'))(
        '%s старше ожидаемого — тоже отказ (равенство, а не «не новее»)',
        (layer) => {
            const lock = { ...LOCK, versions: { ...SUP, [layer]: 2 } };
            const observed = { ...allGood(), [layer]: v(1) };
            refusalOf({ lock, observed, supported: { ...SUP, [layer]: 2 } }, layer);
        },
    );

    it('state прежней схемы проходит: её переводит миграция', () => {
        const r = checkCompatibility({ lock: LOCK, observed: { ...allGood(), state: v(0) } });
        expect(r.ok).toBe(true);
    });

    it.each(COMPAT_LAYERS)('%s: lock ожидает версию, которой ядро не понимает', (layer) => {
        const lock = { ...LOCK, versions: { ...SUP, [layer]: SUP[layer] + 1 } };
        // Наблюдаемое согласно с lock — и всё равно отказ: lock говорит не на языке ядра.
        const observed = { ...allGood(), [layer]: v(SUP[layer] + 1) };
        const reason = refusalOf({ lock, observed }, layer);
        expect(reason).toContain(`ожидает v${String(SUP[layer] + 1)}`);
        expect(reason).toContain(`исполняемое ядро понимает v${String(SUP[layer])}`);
        expect(reason).toMatch(/Что делать:/);
    });

    it('без lock ожидаемое — версии самого ядра, источник назван', () => {
        const reason = refusalOf(
            { lock: null, observed: { ...allGood(), config: v(SUP.config + 1) } },
            'config',
        );
        expect(reason).toContain('версии исполняемого ядра (lock не применяется)');
    });
});

describe('несовместимый state отвергнут проверкой', () => {
    it('state чужой новой схемы с диска — отказ слоя state', () => {
        const text = JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1, any: 1 });
        const obs = observeState(inspectStateAt('/s', () => text));
        expect(obs).toEqual({ kind: 'version', version: STATE_SCHEMA_VERSION + 1 });
        const reason = refusalOf({ lock: LOCK, observed: { state: obs } }, 'state');
        expect(reason).toMatch(/--reset/);
    });
});

describe('совместимые версии проходят без предупреждений', () => {
    it('с lock: все пять слоёв ok, одна строка без ⚠ и ✗', () => {
        const r = checkCompatibility({ lock: LOCK, observed: allGood() });
        expect(r.ok).toBe(true);
        expect(r.layers.map((l) => l.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
        const line = describeCompat(r);
        expect(line.split('\n')).toHaveLength(1);
        expect(line).not.toMatch(/⚠|✗|отверг|предупрежд/);
        expect(line).toMatch(/^🧩 Совместимость слоёв: launcher v1, core v1/);
    });
    it('боевые наблюдатели на штатном окружении дают совместимый отчёт', () => {
        const r = checkCompatibility({
            lock: LOCK,
            observed: {
                launcher: observeLauncher({ [LAUNCHER_VERSION_ENV]: String(SUP.launcher) }),
                core: observeCore(),
                config: observeConfig({ configVersion: SUP.config }),
                state: observeState(
                    inspectStateAt('/s', () =>
                        JSON.stringify({
                            schemaVersion: STATE_SCHEMA_VERSION,
                            count: 0,
                            milestone: null,
                            submitStages: [],
                        }),
                    ),
                ),
                adapters: observeAdapters(),
            },
        });
        expect(r).toEqual({
            ok: true,
            layers: COMPAT_LAYERS.map((layer) => ({ layer, status: 'ok', version: SUP[layer] })),
        });
    });
    it('адаптеры канона говорят той версией, которую требует ядро', () => {
        expect(ADAPTERS_CONTRACT_VERSION).toBe(CORE_REQUIRES_ADAPTERS);
    });
});

// «Ни одного молчаливого фолбэка» проверяется перебором, а не чтением кода: каждый слой ×
// каждый неполный исход наблюдения. Исход обязан быть либо отказом, либо «не применяется»
// с названной причиной — и второе разрешено ровно в двух местах, перечисленных здесь.
describe('ни одного молчаливого фолбэка', () => {
    const bad: Array<[string, TObservation]> = [
        ['версия не прочитана', { kind: 'invalid', reason: 'мусор' }],
        ['версия не заявлена', { kind: 'absent', note: 'нет источника' }],
    ];
    const NAMED_NA = new Set(['state|null', 'state|lock', 'launcher|null']);
    for (const layer of COMPAT_LAYERS) {
        for (const [name, obs] of bad) {
            for (const lock of [null, LOCK]) {
                const where = lock ? 'lock' : 'null';
                it(`${layer}, ${name}, ${lock ? 'с lock' : 'клон'}`, () => {
                    const r = checkCompatibility({
                        lock,
                        observed: { ...allGood(), [layer]: obs },
                    });
                    const l = r.layers.find((x) => x.layer === layer);
                    if (obs.kind === 'absent' && NAMED_NA.has(`${layer}|${where}`)) {
                        expect(l).toEqual({ layer, status: 'n/a', note: 'нет источника' });
                        expect(r.ok).toBe(true);
                        // Названо в строке лога, а не проглочено.
                        expect(describeCompat(r)).toContain(`${layer} — (нет источника)`);
                    } else {
                        expect(l?.status).toBe('refused');
                        expect(r.ok).toBe(false);
                        expect(describeCompat(r)).toMatch(
                            new RegExp(`отвергнут.*слой ${layer}:.*Что делать`),
                        );
                    }
                });
            }
        }
    }

    it('launcher не заявлен при ядре из установки — отказ «мимо launcher»', () => {
        const reason = refusalOf(
            { lock: LOCK, observed: { launcher: observeLauncher({}) } },
            'launcher',
        );
        expect(reason).toMatch(/RALPH_LAUNCHER_VERSION не задан — запуск мимо launcher/);
    });

    it('слой без наблюдения в отчёт не попадает, а не выдумывается ok', () => {
        const r = checkCompatibility({ lock: LOCK, observed: { core: observeCore() } });
        expect(r.layers.map((l) => l.layer)).toEqual(['core']);
    });
});

describe('наблюдатели', () => {
    it.each([
        [{}, 'absent'],
        [{ [LAUNCHER_VERSION_ENV]: '' }, 'absent'],
        [{ [LAUNCHER_VERSION_ENV]: '1' }, 'version'],
        [{ [LAUNCHER_VERSION_ENV]: '01' }, 'invalid'],
        [{ [LAUNCHER_VERSION_ENV]: '1.0' }, 'invalid'],
        [{ [LAUNCHER_VERSION_ENV]: '0' }, 'invalid'],
    ])('launcher %j → %s', (env, kind) => {
        expect(observeLauncher(env).kind).toBe(kind);
    });

    it('конфиг без configVersion — v1 по правилу, и правило названо', () => {
        expect(observeConfig({})).toEqual({
            kind: 'version',
            version: 1,
            note: expect.stringMatching(/до версионирования/),
        });
        expect(observeConfig({ configVersion: 3 })).toEqual({ kind: 'version', version: 3 });
    });
    it.each([['1'], [0], [1.5], [null]])('configVersion %j — не прочитана', (bad) => {
        expect(observeConfig({ configVersion: bad }).kind).toBe('invalid');
    });

    it('state: нет, не читается, повреждён, старая схема, прежняя версия', () => {
        const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
        const eacces = Object.assign(new Error('x'), { code: 'EACCES' });
        const at = (fn: () => string) => observeState(inspectStateAt('/s', fn));
        expect(
            at(() => {
                throw enoent;
            }).kind,
        ).toBe('absent');
        const unreadable = at(() => {
            throw eacces;
        });
        expect(unreadable).toEqual({
            kind: 'invalid',
            reason: 'state не читается (EACCES)',
            fix: expect.stringMatching(/--reset тут не поможет/),
        });
        // Совет наблюдения доходит до отказа вместо совета слоя по умолчанию.
        const reason = refusalOf({ lock: LOCK, observed: { state: unreadable } }, 'state');
        expect(reason).toMatch(/Что делать: это права.*--reset тут не поможет/);
        expect(reason).not.toMatch(/копией рядом/);
        expect(at(() => '{').kind).toBe('invalid');
        expect(at(() => JSON.stringify({ phaseIndex: 1 }))).toEqual({
            kind: 'invalid',
            reason: expect.stringMatching(/phaseIndex/),
        });
        expect(at(() => JSON.stringify({ count: 0, milestone: null, submitted: false }))).toEqual({
            kind: 'version',
            version: 0,
            note: expect.stringMatching(/миграцией/),
        });
    });
});

describe('runDoctor', () => {
    function doctor(core: { ok: boolean; line: string }, input: TCompatInput) {
        const lines: string[] = [];
        const code = runDoctor(core, checkCompatibility(input), (l) => lines.push(l));
        return { code, lines };
    }
    const CORE_OK = { ok: true, line: '🔐 ядро сверено' };

    it('совместимо: строка на каждый слой, код 0', () => {
        const { code, lines } = doctor(CORE_OK, {
            lock: null,
            observed: { ...allGood(), launcher: { kind: 'absent', note: 'клон' } },
        });
        expect(code).toBe(0);
        expect(lines).toEqual([
            '🩺 🔐 ядро сверено',
            '➖ launcher: не применяется — клон',
            '✅ core v1',
            '✅ config v1',
            `✅ state v${String(SUP.state)}`,
            '✅ adapters v1',
            '🩺 Итог: старт эти проверки пройдёт',
        ]);
    });
    it('несовместимый слой — строка с причиной и код 1, остальные слои всё равно названы', () => {
        const { code, lines } = doctor(CORE_OK, {
            lock: LOCK,
            observed: { ...allGood(), state: v(SUP.state + 1) },
        });
        expect(code).toBe(1);
        expect(lines.filter((l) => l.startsWith('✅'))).toHaveLength(4);
        expect(lines).toContainEqual(expect.stringMatching(/^❌ слой state:.*Что делать/));
        expect(lines.at(-1)).toBe('🩺 Итог: старт будет отвергнут');
    });
    it('проверки старта вне слоёв — строкой каждая, красная даёт код 1', () => {
        const lines: string[] = [];
        const code = runDoctor(
            CORE_OK,
            checkCompatibility({ lock: null, observed: allGood() }),
            (l) => lines.push(l),
            [
                { ok: true, line: 'ревизия ядра определена' },
                { ok: false, line: 'не git-репозиторий' },
            ],
        );
        expect(code).toBe(1);
        expect(lines.slice(1, 3)).toEqual(['✅ ревизия ядра определена', '❌ не git-репозиторий']);
        expect(lines.at(-1)).toBe('🩺 Итог: старт будет отвергнут');
    });
    it('предупреждение — своим маркером, без галочки, и старт не валит', () => {
        const lines: string[] = [];
        const code = runDoctor(
            CORE_OK,
            checkCompatibility({ lock: null, observed: allGood() }),
            (l) => lines.push(l),
            [{ ok: true, warn: true, line: 'ядро без контракта' }],
        );
        expect(code).toBe(0);
        expect(lines[1]).toBe('⚠️ ядро без контракта');
        expect(lines.at(-1)).toBe('🩺 Итог: старт эти проверки пройдёт');
    });
    it('отказ сверки ядра — код 1 даже при совместимых слоях', () => {
        const { code } = doctor(
            { ok: false, line: 'отвергнут' },
            { lock: null, observed: allGood() },
        );
        expect(code).toBe(1);
    });
});

describe('runDoctorMode', () => {
    const base = {
        coreCheck: { status: 'not-installed', dir: '/d' } as const,
        coreLine: 'клон',
        observed: { core: observeCore() },
        statePath: '/rt/ralph.state.json',
        failFn: (m: string): never => {
            throw new Error(m);
        },
    };
    it('читает state по названному пути тем же наблюдателем, что старт', () => {
        const lines: string[] = [];
        const read: string[] = [];
        const code = runDoctorMode({
            ...base,
            flags: { doctor: true },
            readFn: (p) => {
                read.push(p);
                return JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1 });
            },
            out: (l) => lines.push(l),
        });
        expect(read).toEqual(['/rt/ralph.state.json']);
        expect(code).toBe(1);
        expect(lines).toContainEqual(expect.stringMatching(/^❌ слой state:/));
    });
    it('с соседним флагом режима — отказ до чтения', () => {
        const readFn = (): string => {
            throw new Error('не должен читать');
        };
        expect(() =>
            runDoctorMode({ ...base, flags: { doctor: true, reset: true }, readFn, out: () => {} }),
        ).toThrow(/заданы ещё: reset/);
    });
});

describe('развилки main() вынесены сюда', () => {
    it('doctorFlagConflict: один doctor — можно, с флагом режима — отказ с его именем', () => {
        expect(doctorFlagConflict({ doctor: true, dry: false, once: false })).toBeNull();
        expect(doctorFlagConflict({ doctor: false, reset: true })).toBeNull();
        expect(doctorFlagConflict({ doctor: true, reset: true, migrate: true })).toMatch(
            /заданы ещё: reset, migrate/,
        );
    });
    it('doctorStatePath: runtimeDir, затем поднятое дерево раннера, затем место запуска', () => {
        const base = {
            worktree: '/wt',
            legacyState: '.claude/ralph/ralph.state.json',
            resolveFn: (...p: string[]) => join('/cwd', ...p.map((x) => x.replace(/^\//, ''))),
        };
        expect(
            doctorStatePath({ ...base, runtimeState: '/rt/ralph.state.json', worktreeReady: true }),
        ).toBe('/rt/ralph.state.json');
        expect(doctorStatePath({ ...base, runtimeState: null, worktreeReady: true })).toBe(
            '/cwd/wt/.claude/ralph/ralph.state.json',
        );
        expect(doctorStatePath({ ...base, runtimeState: null, worktreeReady: false })).toBe(
            '/cwd/.claude/ralph/ralph.state.json',
        );
    });
    it('compatLockOf: lock только у сверенного ядра', () => {
        expect(compatLockOf({ status: 'not-installed', dir: '/d' })).toBeNull();
        expect(compatLockOf({ status: 'refused', reason: 'r' })).toBeNull();
        expect(
            compatLockOf({
                status: 'ok',
                sha: 'a'.repeat(40),
                dir: '/d',
                lockPath: LOCK.path,
                lock: { schema: 1, sha: 'a'.repeat(40), treeHash: 'x', versions: SUP },
            }),
        ).toEqual({ path: LOCK.path, versions: SUP });
    });
});

// Сверка, которую никто не зовёт, — не барьер. Порядок в `main()` содержателен.
describe('проводка в main()', () => {
    const src = readFileSync(join(import.meta.dirname, 'orchestrator.ts'), 'utf8');
    const main = src.indexOf('function main(): void {');

    it('слои launcher/core/config/adapters — до mkdir каталога состояния и лока', () => {
        const check = src.indexOf('const compat = checkCompatibility(', main);
        const mkdir = src.indexOf('fs.mkdirSync(roots.runtimeDir', main);
        const lock = src.indexOf('acquireRunnerLock()', main);
        expect(check).toBeGreaterThan(main);
        expect(check).toBeLessThan(mkdir);
        expect(check).toBeLessThan(lock);
        expect(src.slice(check, mkdir)).toMatch(
            /if \(!compat\.ok\) fail\(describeCompat\(compat\)\)/,
        );
    });

    it('слой state — до пробы барьера, preflight и первой сессии', () => {
        const check = src.indexOf('const stateCompat = checkCompatibility(', main);
        const guard = src.indexOf('ensureGuardHolds(sessionTree', main);
        const pre = src.indexOf('const ctx = preflight(config)', main);
        const loop = src.indexOf('runLoop(config, ctx', main);
        expect(check).toBeGreaterThan(main);
        expect(check).toBeLessThan(guard);
        expect(check).toBeLessThan(pre);
        expect(check).toBeLessThan(loop);
        expect(src.slice(check, guard)).toMatch(
            /if \(!stateCompat\.ok\) fail\(describeCompat\(stateCompat\)\)/,
        );
    });

    it('--doctor зовёт ту же сверку и выходит до первой записи', () => {
        const doctor = src.indexOf('if (DOCTOR)', main);
        const mkdir = src.indexOf('fs.mkdirSync(roots.runtimeDir', main);
        expect(doctor).toBeGreaterThan(main);
        expect(doctor).toBeLessThan(mkdir);
        expect(src.slice(doctor, mkdir)).toMatch(/runDoctorMode\(/);
    });
});

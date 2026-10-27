// #44: готовность кодер-рантайма проверяется на старте, а не первой кодер-сессией.
//
// Поймано на полигоне: CLI рантайма обновил сам себя посреди прогона, бинарь временно
// отсутствовал, и петля узнала об этом, только подняв монитор, worktree и зависимости.
// Здесь три слоя: проба бинаря (что именно считается «не готов»), шаг старта (какой текст
// получает человек и какие рантаймы проверяются) и его место в main() — проверка, стоящая
// после установки зависимостей, опоздала бы ровно на неё.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts).
import ralph from '../ralph.js';
import { CODER_RUNTIME_PROVIDERS } from '../adapters/adapters-impl.ts';
import type { AdapterRegistries } from '../adapters/adapters-impl.ts';
import { stripComments } from '../tests/strip-comments.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

const { probeRuntimeBinary, probeRuntimeBinaryOnce, checkCoderRuntimes, adapterRegistries } = ralph;

const throwingFail = (msg: string): never => {
    throw new Error(msg);
};

function spawnReturning(res: Record<string, unknown>) {
    return vi.fn(() => ({ status: null, signal: null, stdout: '', stderr: '', ...res }));
}

function errno(code: string): NodeJS.ErrnoException {
    const e = new Error(`spawnSync x ${code}`) as NodeJS.ErrnoException;
    e.code = code;
    return e;
}

describe('probeRuntimeBinary — проба готовности бинаря рантайма (#44)', () => {
    it('код 0 → готов; зовётся только `--version`, без шелла и без ввода', () => {
        const spawnFn = spawnReturning({ status: 0, stdout: '1.2.3' });
        expect(() => probeRuntimeBinary('rt', spawnFn)).not.toThrow();
        expect(spawnFn).toHaveBeenCalledTimes(1);
        const [bin, argv, opts] = spawnFn.mock.calls[0] as unknown as [
            string,
            string[],
            Record<string, unknown>,
        ];
        expect(bin).toBe('rt');
        expect(argv).toEqual(['--version']);
        expect(opts.shell).toBe(false);
        expect(opts).not.toHaveProperty('input');
        expect(opts.timeout).toBeGreaterThan(0);
    });

    it('НЕГАТИВНЫЙ: бинаря нет (ENOENT) → бросает «не найден»', () => {
        const spawnFn = spawnReturning({ error: errno('ENOENT') });
        expect(() => probeRuntimeBinary('rt', spawnFn)).toThrow(/не найден/);
    });

    it('НЕГАТИВНЫЙ: нет прав на исполнение (EACCES) → бросает «нет прав»', () => {
        const spawnFn = spawnReturning({ error: errno('EACCES') });
        expect(() => probeRuntimeBinary('rt', spawnFn)).toThrow(/нет прав/);
    });

    it('НЕГАТИВНЫЙ: ненулевой код → бросает с кодом и хвостом stderr', () => {
        const spawnFn = spawnReturning({ status: 1, stderr: 'broken install' });
        expect(() => probeRuntimeBinary('rt', spawnFn)).toThrow(/код 1.*broken install/);
    });

    it('НЕГАТИВНЫЙ: таймаут (сигнал вместе с ETIMEDOUT) → называет сигнал', () => {
        const spawnFn = spawnReturning({ signal: 'SIGTERM', error: errno('ETIMEDOUT') });
        expect(() => probeRuntimeBinary('rt', spawnFn)).toThrow(/сигналом SIGTERM/);
    });
});

describe('probeRuntimeBinaryOnce — одна проба на бинарь (#44)', () => {
    // У claude и kimi бинарь один: без памяти `claude --version` шёл бы дважды.
    // Имена бинарей уникальны на тест — память живёт на весь экземпляр оркестратора.
    it('успех запоминается: второй вызов того же бинаря пробу не зовёт', () => {
        const probeFn = vi.fn();
        probeRuntimeBinaryOnce('rt-once-ok', probeFn);
        probeRuntimeBinaryOnce('rt-once-ok', probeFn);
        expect(probeFn).toHaveBeenCalledTimes(1);
    });

    it('НЕГАТИВНЫЙ: отказ не запоминается — следующий вызов пробует снова', () => {
        const probeFn = vi.fn(() => {
            throw new Error('бинарь не найден в PATH');
        });
        expect(() => probeRuntimeBinaryOnce('rt-once-bad', probeFn)).toThrow(/не найден/);
        expect(() => probeRuntimeBinaryOnce('rt-once-bad', probeFn)).toThrow(/не найден/);
        expect(probeFn).toHaveBeenCalledTimes(2);
    });
});

describe('checkCoderRuntimes — шаг старта (#44)', () => {
    const cfg = (extra = {}) => ({ active: true, phases: [], ...extra });

    it('отказ шва → стоп «Кодер-рантайм недоступен» с причиной, отличимый от отказа форжа', () => {
        const run = () =>
            checkCoderRuntimes(cfg(), {
                failFn: throwingFail,
                logFn: () => {},
                checkRuntimeFn: () => {
                    throw new Error('бинарь не найден в PATH');
                },
            });
        expect(run).toThrow(/Кодер-рантайм недоступен \(claude\): бинарь не найден в PATH/);
        // Разные причины — разный ремонт: текст не должен звучать как отказ форжа.
        expect(run).not.toThrow(/Форж не авторизован/);
    });

    it('готовый рантайм: шов спрошен один раз, строка в лог, стопа нет', () => {
        const checkRuntimeFn = vi.fn();
        const logFn = vi.fn();
        const failFn = vi.fn(throwingFail);
        checkCoderRuntimes(cfg(), { failFn, logFn, checkRuntimeFn });
        expect(checkRuntimeFn).toHaveBeenCalledTimes(1);
        expect(failFn).not.toHaveBeenCalled();
        expect(logFn).toHaveBeenCalledWith(expect.stringMatching(/Кодер-рантайм готов: claude/));
    });

    it('проверяются ВСЕ достижимые рантаймы, включая провайдеров modelRouting', () => {
        const checked: string[] = [];
        checkCoderRuntimes(
            cfg({
                modelRouting: {
                    labels: { 'complexity:low': { provider: 'kimi', model: 'k' } },
                    apiLimitFallback: { provider: 'openai', model: 'o' },
                },
            }),
            {
                failFn: throwingFail,
                logFn: () => {},
                checkRuntimeFn: (p: string) => checked.push(p),
            },
        );
        expect(checked.sort()).toEqual(['claude', 'kimi', 'openai']);
    });

    it('фолбэк на сломанный рантайм тоже стоп — не только статический', () => {
        expect(() =>
            checkCoderRuntimes(
                cfg({ modelRouting: { apiLimitFallback: { provider: 'openai', model: 'o' } } }),
                {
                    failFn: throwingFail,
                    logFn: () => {},
                    checkRuntimeFn: (p: string) => {
                        if (p === 'openai') throw new Error('нет прав на исполнение');
                    },
                },
            ),
        ).toThrow(/Кодер-рантайм недоступен \(openai\)/);
    });
});

describe('реестр coderRuntime: у каждой реализации есть checkAvailable (#44)', () => {
    it('все зарегистрированные провайдеры несут метод проверки готовности', () => {
        const registry = adapterRegistries.coderRuntime;
        expect(Object.keys(registry).sort()).toEqual([...CODER_RUNTIME_PROVIDERS].sort());
        for (const [name, impl] of Object.entries(registry as AdapterRegistries['coderRuntime'])) {
            expect(typeof impl.checkAvailable, `${name}.checkAvailable`).toBe('function');
        }
    });

    it('боевой checkAvailable идёт в настоящий spawn — в тесте это громкая побочка', () => {
        // Без подмены проба дошла бы до настоящего процесса; предохранитель обязан это
        // остановить, а не пропустить «зелёным». Журнал попытки чистим сами — здесь она
        // ожидаема.
        expect(() => adapterRegistries.coderRuntime.claude.checkAvailable()).toThrow();
        const attempts = sideEffectAttempts.splice(0);
        expect(attempts.join(' | ')).toContain('probeRuntimeBinary(claude --version)');
    });
});

// Место шага в main() — структурный барьер по тексту, как у соседних проверок порядка
// (orchestrator.test.ts, задача 27 и #181): main() поднимает лок, worktree и монитор, и
// гонять его в сьюте нельзя. Ловит он ровно перестановку — проверку, уехавшую ниже
// установки зависимостей или под `if (!DRY)`.
describe('main(): проверка рантайма стоит до worktree, зависимостей и preflight и мимо --reset (#44)', () => {
    const source = stripComments(
        fs.readFileSync(path.resolve(import.meta.dirname, './orchestrator.ts'), 'utf-8'),
    );
    const mainAt = source.indexOf('function main(');
    const body = source.slice(mainAt);
    const at = (re: RegExp) => {
        const m = re.exec(body);
        return m ? m.index : -1;
    };

    it('вызов один и стоит выше worktree, синка зависимостей и preflight', () => {
        expect(mainAt).toBeGreaterThan(-1);
        const calls = [...body.matchAll(/checkCoderRuntimes\(\s*config\s*\)/g)];
        expect(calls, 'не нашёл вызова checkCoderRuntimes(config) в main()').toHaveLength(1);
        const check = calls[0].index;
        expect(check).toBeLessThan(at(/ensureRunnerWorktree\(worktreePath\)/));
        expect(check).toBeLessThan(at(/syncDepsIfLockChanged\(/));
        expect(check).toBeLessThan(at(/[^.\w]preflight\(\s*config[\s,)]/));
    });

    // --reset — инструмент восстановления: хост со сломанным CLI кодера обязан уметь
    // сбросить state, поэтому сброс проверку рантайма обходит.
    it('вызов под `if (!RESET)`: сброс state не зависит от готовности кодера', () => {
        expect(body).toMatch(/if\s*\(\s*!RESET\s*\)\s*checkCoderRuntimes\(\s*config\s*\)/);
    });

    it('вызов не под `if (!DRY)`: dry-run отвечает о рантайме так же, как живой запуск', () => {
        const check = at(/checkCoderRuntimes\(\s*config\s*\)/);
        const before = body.slice(0, check);
        const opened = before.lastIndexOf('if (!DRY) {');
        // Ближайший `if (!DRY) {` выше вызова (если он есть) обязан быть закрыт до него.
        if (opened !== -1) {
            const segment = before.slice(opened);
            const depth = [...segment].reduce(
                (d, c) => d + (c === '{' ? 1 : c === '}' ? -1 : 0),
                0,
            );
            expect(depth).toBe(0);
        }
    });
});

// Фаза 16b: у kimi-native и opencode проверка готовности — не голый `--version`, но начинается
// с него; боевой вызов из реестра обязан дойти до процесса и быть остановлен предохранителем.
describe('реестр coderRuntime: готовность харнессов Фазы 16b — боевой путь', () => {
    it.each(['kimi-native', 'opencode'])('%s: checkAvailable идёт в настоящий spawn', (name) => {
        expect(() => adapterRegistries.coderRuntime[name].checkAvailable()).toThrow();
        const bin = name === 'opencode' ? 'opencode' : 'kimi';
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain(
            `probeRuntimeBinary(${bin} --version)`,
        );
    });
});

// Юнит-тесты общего предохранителя (#145). vitest.config.ts выставляет
// RALPH_NO_SIDE_EFFECTS=1 для всего проекта "ralph" через env, поэтому ветку "выключен"
// проверяем отдельным динамическим импортом со своим process.env и сбросом кеша модулей —
// как выключенный, так и включённый инстанс модуля живут в тесте независимо.
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('guardSideEffect (RALPH_NO_SIDE_EFFECTS=1, дефолт проекта "ralph")', () => {
    // Журнал общий на весь проект "ralph" (#145) — общий afterEach из test-setup.ts
    // валит тест на непустом sideEffectAttempts, поэтому каждая проверка сама вычищает
    // за собой через splice(0), как и остальные тесты раннера.
    it('бросает с текстом what и переданной подсказкой', async () => {
        const { guardSideEffect, sideEffectAttempts } = await import('./side-effect-guard.ts');
        expect(() => guardSideEffect('sh(git push)', 'Подмени shFn.')).toThrow(
            /sh\(git push\).*RALPH_NO_SIDE_EFFECTS=1.*Подмени shFn\./s,
        );
        expect(sideEffectAttempts.splice(0)).toEqual(['sh(git push)']);
    });

    it('пишет попытку в общий журнал sideEffectAttempts', async () => {
        const { guardSideEffect, sideEffectAttempts } = await import('./side-effect-guard.ts');
        expect(() => guardSideEffect('npm ci', 'Подмени installFn.')).toThrow();
        expect(sideEffectAttempts.splice(0)).toEqual(['npm ci']);
    });

    it('не глотает попытку под try/catch — журнал остаётся даже после перехвата исключения', async () => {
        const { guardSideEffect, sideEffectAttempts } = await import('./side-effect-guard.ts');
        try {
            guardSideEffect('git fetch', 'Подмени shFn.');
        } catch {
            // сценарий вызывающих (phaseDiffFiles/checksGreen) — ошибка перехвачена,
            // чтобы не ронять ночной прогон, но журнал обязан остаться заполненным.
        }
        expect(sideEffectAttempts.splice(0)).toEqual(['git fetch']);
    });
});

describe('guardSideEffect (RALPH_NO_SIDE_EFFECTS не установлен)', () => {
    const ORIGINAL_ENV = process.env;

    afterEach(() => {
        process.env = ORIGINAL_ENV;
        vi.resetModules();
    });

    it('не бросает и не пишет в журнал — не боевая петля, побочка разрешена', async () => {
        process.env = { ...ORIGINAL_ENV };
        delete process.env.RALPH_NO_SIDE_EFFECTS;
        vi.resetModules();
        const { guardSideEffect, sideEffectAttempts, NO_SIDE_EFFECTS } =
            await import('./side-effect-guard.ts');
        expect(NO_SIDE_EFFECTS).toBe(false);
        expect(() => guardSideEffect('sh(git push)', 'Подмени shFn.')).not.toThrow();
        expect(sideEffectAttempts).toEqual([]);
    });
});

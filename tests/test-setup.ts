// #138: общий предохранитель для ВСЕХ тестов проекта "ralph" (vitest.config.ts →
// setupFiles). Раньше жил в ralph.test.js, но include проекта покрывает и
// scripts/**, и будущие файлы рядом с раннером — а они получали бы только throw из
// боевого дефолта, без ловли вызова, проглоченного try/catch (ревью PR #141).
//
// Механика: ralph.js под RALPH_NO_SIDE_EFFECTS=1 не исполняет побочку (шелл, запись
// state, npm ci, спавн claude), а записывает попытку в журнал. Половина вызовов
// обёрнута в try/catch, чтобы одна git-ошибка не роняла ночной прогон, — значит,
// одного исключения для покраснения теста мало, и журнал сверяем отдельно.
//
// telegram-notifier.ts (#85) и security-audit.mjs (#239) — самостоятельные потребители
// (telegram-notifier.ts не может require('../ralph.js') — циклическая зависимость с #86).
// #145: журнал попыток теперь один — side-effect-guard.ts, общий на все три модуля.
// sideEffectAttempts здесь берём напрямую из него (а не из ralph.js/telegram-notifier.ts/
// security-audit.mjs — они лишь ре-экспортируют тот же массив), сверяем одним afterEach.
import { afterEach, expect } from 'vitest';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

afterEach(() => {
    const attempts = sideEffectAttempts.splice(0);
    expect(
        attempts,
        `Тест дошёл до боевой побочки: ${attempts.join(' | ')}\n` +
            `Подмени зависимость в deps теста (shFn, saveStateFn, installFn, spawnFn, execFn ` +
            `или коллаборатор, который их зовёт: phaseDiffFilesFn, checksGreenFn, …).`,
    ).toEqual([]);
});

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
import { guardSideEffect, sideEffectAttempts } from '../shared/side-effect-guard.ts';
import { installForgeExecGuard } from './forge-exec-guard.ts';

// Список ключей подписки (задача 96) включает боевое кольцо ротации: при двух ключах
// runClaude читает файл ротации. На хосте петли переменная задана, и `npm test` из такой
// оболочки краснел бы журналом побочек в сьютах, к ротации отношения не имеющих, — тест
// зависел бы от оболочки, а не от кода. Тесту, которому нужно кольцо, его подают
// параметром (`keyRing`) или `vi.stubEnv`.
delete process.env.RALPH_CLAUDE_OAUTH_TOKENS;

// Сеть — та же побочка, только незакрытая. Наружу ядро ходит шеллом (`curl` в адаптере
// площадки), и это уже под предохранителем, а вот глобальный `fetch` обходит его вовсе:
// ни `sh`, ни `spawnFn` на пути нет. Цена дыры — не «лишний запрос»: тест, которому нужен
// живой сервер, краснеет там, где сети нет, и зеленеет там, где она есть, то есть
// проверяет погоду вместо кода. Гейт канона обязан идти на чистом клоне БЕЗ сети.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    // При выключенном предохранителе — no-op: настоящий прогон раннера ходит в сеть
    // законно, запрет живёт только в тестовом окружении.
    guardSideEffect(`fetch(${url})`, 'Подмени сетевой вызов параметром: прогон идёт без сети.');
    return realFetch(input, init);
}) as typeof fetch;

// Запуск бинаря форжа — по имени ЗАПУЩЕННОГО, а не по тексту кода (задача 20): имя,
// собранное в рантайме, скан `core-purity` не видит по конструкции. Подмена стоит на
// `node:child_process` всего процесса сьюта; граница чека — в докблоке модуля.
installForgeExecGuard((what) =>
    guardSideEffect(what, 'Команды форжа зовёт только адаптер, а в тесте — подменённый шов.'),
);

afterEach(() => {
    const attempts = sideEffectAttempts.splice(0);
    expect(
        attempts,
        `Тест дошёл до боевой побочки: ${attempts.join(' | ')}\n` +
            `Подмени зависимость в deps теста (shFn, saveStateFn, installFn, spawnFn, execFn ` +
            `или коллаборатор, который их зовёт: phaseDiffFilesFn, checksGreenFn, …).`,
    ).toEqual([]);
});

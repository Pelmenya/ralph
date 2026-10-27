// Модуль детекции и ожидания API-лимита (#361, трек «Фреймворк ralph», фаза 2).
// Вынесен из ralph.js по тому же приёму, что ralph-util.ts (#232): чистые
// преобразования вход→выход без побочек — идея из frankbria/ralph-claude-code.
// Рантайм при упирании в 5-часовое окно / usage limit завершается с ошибкой, и адаптер
// называет этот исход `api-limit`. Без обработки AFK-итерация фейлится, breaker сжигает
// оставшиеся попытки об ту же стену и ночной прогон умирает. Вместо этого:
// исход `api-limit` → время сброса от адаптера → доспать до него → повторить.
// Сам цикл ожидания/повтора (спит и вызывает claude заново) остаётся в ralph.js
// (runClaude) — он не чистый (sleep, spawn, pushEvent); здесь — только расчёт
// длительности паузы плюс текст события.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Без побочек вовсе — guardSideEffect здесь не нужен (#138 не при чём: ни один экспорт
// не трогает диск/сеть/процессы), поэтому, как и ralph-util.ts, это набор standalone-
// экспортов, а не фабрика с DI.

// Признаки лимита — маркер в выводе и время сброса окна — распознаёт адаптер рантайма
// (`adapters/session-end.ts`, Фаза 16): ядро получает исход `api-limit` и, если CLI его
// назвал, `retryAfterMs`. Регулярок по выводу сессии здесь больше нет — их формулировки
// принадлежат конкретному CLI, а не петле.

// #130: запас был захардкожен как 2 минуты и оказался слишком тонким — окно
// сбрасывается не мгновенно, и повтор рискует уйти в ту же стену, сжигая попытку
// из apiLimitMaxWaits (их всего 3). Дефолт поднят до 5 минут и вынесен в конфиг.
//
// minutesOrDefault, а не `??`: `??` пропускал бы любой мусор, а мусор здесь не
// «странное число минут», а вечный сон. Atomics.wait(buf, 0, 0, NaN) трактует NaN
// как +∞ — раннер вставал бы навсегда, молча, с записью «Жду NaN мин» в логе
// (блокер ревью PR #132). Ноль при этом остаётся законным: «без запаса» —
// осознанный выбор, его подменять дефолтом нельзя.
// typeof number строго, без приведения: Number(null) и Number('') дают 0, и
// пропущенный/пустой ключ читался бы как осознанный «нулевой запас» вместо
// дефолта. Строку '5' тоже не принимаем — в JSON-конфиге минуты обязаны быть
// числом, а тихое приведение прячет опечатку вместо того, чтобы её проявить.
export function minutesOrDefault(value: unknown, dflt: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : dflt;
}

// retryAfterMs — время до сброса, названное адаптером; нет его (или оно битое) — fallback.
export function apiLimitWaitMs(
    retryAfterMs: number | undefined,
    cfg: { apiLimitFallbackWaitMin?: number; apiLimitGraceMin?: number },
): number {
    const fallbackMs = minutesOrDefault(cfg.apiLimitFallbackWaitMin, 30) * 60 * 1000;
    const graceMs = minutesOrDefault(cfg.apiLimitGraceMin, 5) * 60 * 1000;
    const resetMs =
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
            ? retryAfterMs
            : fallbackMs;
    return resetMs + graceMs;
}

// Текст события API-лимитной паузы — ЕДИНСТВЕННЫЙ источник правды его формата. deadman.ts
// (режим apiwait) парсит из него «Жду N мин» через API_WAIT_RE; раньше формат жил в двух
// местах, связанных лишь копией текста, и правка формулировки здесь молча ломала бы
// классификатор → ложный пуш ночью. Теперь функция экспортирована и её выход сверяется с
// API_WAIT_RE тестом (deadman.test.ts), так что рассинхрон краснит гейт, а не всплывает в бою.
export function apiLimitMessage(waitMs: number, attempt: number, maxWaits: number): string {
    return `⏳ Ralph: API-лимит — сессия упала с маркером лимита. Жду ${Math.round(waitMs / 60000)} мин до сброса окна и повторяю (попытка ${attempt + 1}/${maxWaits}).`;
}

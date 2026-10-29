// Модуль детекции и ожидания транзиентной недоступности рантайма (#606, milestone
// «Раннер · Устойчивость к отказам»). Вынесен по тому же приёму, что api-limit.ts (#361):
// чистые преобразования вход→выход, без побочек — сам цикл ожидания/повтора живёт в
// runClaude (orchestrator.ts), здесь — только детект и арифметика паузы.
//
// Инцидент 18.08: Claude Code CLI автообновился прямо во время многочасового AFK-прогона —
// симлинк `/usr/bin/claude` на секунды-минуты остался без бинаря, сессия упала с кодом 127
// и строкой «No such file or directory». Раннер трактовал это как отказ по существу (та же
// ветка, что настоящий крах модели) и вернул label blocked на PR, хотя работа уже была
// готова (чини-сессия починила гейт за 15 минут до того). Петля простояла 2+ часа до
// человека. Класс тот же, что API-лимит (api-limit.ts) и HTTP 503 форжа (#603/#79): работа
// не сделана не потому, что что-то не так с кодом или PR, а потому что инструмент моргнул —
// значит это транзиент, который стоит пережить повтором, а не honest-стоп с первой попытки.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Без побочек вовсе — guardSideEffect здесь не нужен (#138 не при чём), поэтому, как и
// api-limit.ts/ralph-util.ts, это набор standalone-экспортов, а не фабрика с DI.

import { positiveIntOrDefault } from '../shared/ralph-util.ts';

// Детект — не здесь. Структурный признак (`failureKind: 'runtime-unavailable'`, ENOENT на
// границе spawn) и код 127 от шелл-обёртки ядро читает само в runClaude: это коды, а не
// текст. Прежняя текстовая эвристика (ENOENT/«No such file or directory» в выводе) снята
// вместе с остальными регулярками по выводу (Фаза 16, #112): она ловила и ЦИТАТУ модели, и
// у боевых рантаймов давно не срабатывала — класс отказа они называют всегда.

// Обновление CLI занимает секунды-минуты (research в теле issue) — 5 минут суммарного
// бюджета повторов с запасом кроют его, не превращая честный крах рантайма в вечный сон.
export const DEFAULT_RUNTIME_UNAVAILABLE_MAX_WAIT_MS = 5 * 60 * 1000;
// База линейного backoff между попытками — тот же приём, что forgeJson (exec.ts): попытка N
// ждёт N × базу, растущая пауза не долбит в стену на полной скорости, но и не запирает
// первый повтор надолго, пока обновление ещё может завершиться за секунды.
export const DEFAULT_RUNTIME_UNAVAILABLE_RETRY_DELAY_MS = 10 * 1000;

type RuntimeUnavailableCfg = {
    runtimeUnavailableRetryDelayMs?: number;
};

// Длительность паузы перед попыткой N (1-индексация, как у forgeJson). Вызывающий сам
// обрезает результат остатком бюджета (runtimeUnavailableMaxWaitMs) — эта функция бюджета
// не знает и не обязана.
export function runtimeUnavailableWaitMs(attempt: number, cfg: RuntimeUnavailableCfg = {}): number {
    const base = positiveIntOrDefault(
        cfg.runtimeUnavailableRetryDelayMs,
        DEFAULT_RUNTIME_UNAVAILABLE_RETRY_DELAY_MS,
    );
    return base * attempt;
}

// Текст промежуточного повтора (в лог, не в пуш — короткие паузы не должны спамить
// человека; пуш зовётся один раз, на честном исчерпании бюджета, см. ниже).
//
// systemErrorCode (ревью #612) — код ОС с границы spawn (`ENOENT`), если он там был. Без
// него на структурном пути #611 человек читал «(код 1)», где «1» не значит ничего: настоящую
// причину называла только более ранняя строка spawnClaude, уехавшая вверх по логу. «код 127»
// (шелл-обёртка) и `ENOENT` (execve) — разные диагнозы, и в строке они теперь различимы.
export function runtimeUnavailableMessage(
    attempt: number,
    waitMs: number,
    code: number,
    systemErrorCode?: string,
): string {
    return (
        `⚠ Рантайм недоступен (${runtimeCauseText(code, systemErrorCode)}) — похоже, CLI обновляется. ` +
        `Повтор через ${Math.round(waitMs / 1000)}с (попытка ${attempt}).`
    );
}

// Единая форма «чем именно доказана недоступность»: код процесса всегда, код ОС — если
// граница spawn его назвала.
function runtimeCauseText(code: number, systemErrorCode?: string): string {
    return systemErrorCode ? `код ${String(code)} / ${systemErrorCode}` : `код ${String(code)}`;
}

// Текст честного исчерпания бюджета — ЕДИНСТВЕННЫЙ источник правды формулировки причины.
// Явно называет её «рантайм недоступен», а не «вердикта не было»/«сессия упала»: критерий
// готовности #606 требует, чтобы пуш не путал транзиентную помеху с отказом по существу.
export function runtimeUnavailableExhaustedMessage(
    maxWaitMs: number,
    attempts: number,
    systemErrorCode?: string,
): string {
    return (
        `⛔ Ralph: рантайм недоступен дольше ${Math.round(maxWaitMs / 60000)} мин ` +
        `(${attempts} повторов${systemErrorCode ? `, ${systemErrorCode}` : ''}) — стоп (fail-closed). ` +
        `Причина — CLI недоступен (обновление/симлинк), а НЕ отказ ревью или сессии по существу.`
    );
}

// ── Сбой прокси моделей (задача 78) ──────────────────────────────────────────────────
// Инцидент 16.10: прокси моделей ответил «No upstream account is currently available»,
// `claude -p` вышел с кодом 0 за 8 с, а ревью было засчитано по коду — фаза уехала в main
// непрочитанной. Распознаёт такой обрыв адаптер рантайма (исход `interrupted`,
// `adapters/session-end.ts`), и оркестратор повторяет только проход, не оставивший
// вердикта: сессию с вердиктом, процитировавшую такую строку, повтор не тронет.

// Пауза длиннее, чем у моргания CLI: прокси ждёт освобождения аккаунта или спада нагрузки,
// это минуты, а не секунды. Пять повторов с линейным ростом — 15 минут суммарно: дольше
// стоять в шаге сдачи нет смысла, стоп с названной причиной дешевле.
export const MODEL_PROXY_RETRIES = 5;
export const MODEL_PROXY_RETRY_DELAY_MS = 60 * 1000;

export function modelProxyRetryWaitMs(attempt: number): number {
    return MODEL_PROXY_RETRY_DELAY_MS * attempt;
}

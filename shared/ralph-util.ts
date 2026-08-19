// Общий util-модуль без побочек (#232): `shq`/`positiveIntOrDefault`/`sleep` жили в
// копиях в ralph.js и telegram-notifier.ts (ревью PR #231) — правка в одной не доезжала
// до другой. Вынесены сюда по тому же приёму, что и guardSideEffect (#145,
// side-effect-guard.ts): общий модуль без cycle на ralph.js, требуется и через
// require() (CommonJS-entry ralph.js), и через import (telegram-notifier.ts —
// ESM-потребитель, уже фактически импортирует sleep/positiveIntOrDefault отсюда).
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Без побочек вовсе — guardSideEffect здесь не нужен (#138 не при чём: ни один экспорт
// не трогает диск/сеть/процессы).

// #133: sh() в ralph.js исполняет СТРОКУ через /bin/sh — любое значение, попадающее в
// неё (milestone/branch из конфига, номера PR и заголовки issues с публичного GitHub),
// обязано быть заквотировано. Одинарные кавычки в POSIX sh не интерпретируют вообще
// ничего, поэтому достаточно закрыть-экранировать-открыть на каждой одинарной кавычке
// внутри значения: don't → 'don'\''t'.
export function shq(value: unknown): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Строго typeof number, без приведения (#132): строка '80' из JSON-конфига — это
// опечатка, а не «странное число», и Number('80') тихо простил бы её вместо дефолта.
// value > 0: 0 — не «без ограничения», а бюджет без единого хода/попытки.
export function positiveIntOrDefault(value: unknown, dflt: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : dflt;
}

// #594: то же, что positiveIntOrDefault, но 0 — валидное значение, а не мусор. Нужен
// счётчикам ПОВТОРОВ (в отличие от бюджетов): 0 повторов — осмысленная настройка «не
// повторять, сразу стоп», и трактовать её как «возьми дефолт» значило бы молча включить
// повторы тому, кто их явно выключил.
export function nonNegativeIntOrDefault(value: unknown, dflt: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : dflt;
}

// #204-ревью: единый резолвер команды установки зависимостей. Дефолт `npm ci` жил в трёх
// местах (state-lock installFn + лог-строка, orchestrator getInstallCmd) — при смене дефолта
// их пришлось бы вспоминать все, а разъехавшись, лог сказал бы одно, а исполнилось другое.
// Пробельная строка трактуется как «не задано» (иначе installCmd: "  " запустил бы пустую
// команду) — тот же дух, что positiveIntOrDefault: кривое значение → дефолт, не тихая беда.
export function resolveInstallCmd(cfg?: { installCmd?: string } | null): string {
    const cmd = cfg && cfg.installCmd;
    return typeof cmd === 'string' && cmd.trim() ? cmd : 'npm ci';
}

// Синхронный sleep: раннер и телеграм-ретраи — синхронный код (execSync-хореография),
// event loop свободен, поэтому Atomics.wait — корректный способ подождать без busy-loop.
// Валидация ms на правильном слое (#232): Atomics.wait трактует NaN-таймаут как +∞ —
// вечный сон посреди прогона. Пока функция была приватной копией, защиту держали
// вызывающие (minutesOrDefault в ralph.js, комментарий у base в telegram-notifier.ts);
// теперь это общий API фреймворка — новый потребитель про эту мину не знает, поэтому
// отсекаем NaN/±∞/отрицательное здесь: нечего ждать — сразу возвращаемся.
export function sleep(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// #390: захваченный stdout/stderr упавшей кодер-сессии может процитировать env, в
// котором она запускалась (унаследованный процессом claude, инвариант №11), поэтому
// перед записью на диск гоняем его через тот же приём, что уже применяет
// telegram-notifier.ts к TG-токену — replaceAll ЗНАЧЕНИЯ секрета на '***', не паттерн.
// Пустые/undefined секреты пропускаем (иначе replaceAll('') вставил бы '***' между
// каждым символом строки).
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
    let redacted = text;
    for (const secret of secrets) {
        if (secret) redacted = redacted.replaceAll(secret, '***');
    }
    return redacted;
}

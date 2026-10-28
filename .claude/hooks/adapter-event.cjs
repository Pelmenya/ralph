'use strict';
/**
 * Граница вызова между общим хуком и пакетом адаптера харнесса (Фаза 16c, #179).
 *
 * Общий барьер обязан судить нормализованное событие, а нормализатор у каждого CLI свой
 * и живёт в его пакете (`adapters/harnesses/<имя>/`). Взять его `require`-ом хук не
 * может и не должен: хуки — CommonJS без зависимостей, исполняются до `npm ci`, а их
 * каталог сверяется с ревизией ядра по содержимому (`core-revision.cjs`) — модуль пакета,
 * загруженный в процесс хука, исполнил бы непроверенный код раньше барьера и связал бы
 * `.claude/hooks/` с пакетами, которые подключаются и меняются отдельно от него. Поэтому
 * граница — ПРОЦЕСС: хук зовёт исполняемую команду адаптера, отдаёт ей сырой вход на
 * stdin и получает `{"protocol": N, "event": ToolEvent}` в stdout.
 *
 * Всё, что не является ровно таким ответом, — блок с причиной, а не пропуск: команда не
 * запустилась, упала, зависла, ответила не JSON, назвала незнакомую версию протокола,
 * отдала событие без операций или с операцией вне перечня. Хук, пропускающий вызов на
 * сбое нормализатора, был бы барьером ровно до первой сломанной сборки пакета — класс
 * #120, где упавший хук CLI пропускал `rm -rf`.
 *
 * Сторона адаптера — `adapters/harnesses/protocol.ts`; версия протокола у обеих сторон
 * одна, и равенство сверяет тест, а не импорт: импорт и есть то, чего здесь нет.
 */
const { spawnSync } = require('node:child_process');

const ADAPTER_PROTOCOL_VERSION = 1;

/**
 * Срок команды адаптера: нормализация — разбор JSON, а не работа; зависла — блок. Срок обязан
 * быть заметно меньше таймаута самого хука в регистрации: хук, убитый CLI по своему сроку,
 * у PreToolUse не блокирует, и зависший нормализатор пропускал бы вызов.
 */
const ADAPTER_TIMEOUT_MS = 5_000;

/** Потолок ответа: событие — несколько строк; мегабайты в stdout — уже не нормализатор. */
const ADAPTER_MAX_BUFFER = 1024 * 1024;

/**
 * Обязательные строковые поля каждой операции (`docs/harness-contract.md`, «Пакет
 * адаптера»). Перечень закрытый: операция, которой здесь нет, барьеру незнакома, а
 * незнакомое — запрет.
 */
const OPERATION_FIELDS = {
    exec: ['command', 'baseDir'],
    read: ['path', 'baseDir'],
    write: ['path', 'baseDir'],
    delete: ['path', 'baseDir'],
    move: ['path', 'destination', 'baseDir'],
    search: ['root', 'baseDir'],
    mcp: ['server', 'tool'],
    fetch: ['url'],
    agent: ['parentSession'],
    defer: ['what'],
    inert: ['what'],
    unknown: ['why'],
};

const OPTIONAL_STRING_FIELDS = { search: ['contentPattern', 'pathGlob'] };

/** Нестроковые поля операций: остальное в операции — лишний ключ, то есть отказ. */
const OTHER_FIELDS = { mcp: ['effect', 'derived'], unknown: ['kind'] };

const MCP_EFFECTS = ['read', 'write', 'unknown'];

/**
 * Что незнакомо в `unknown` (#186): по нему guard выбирает код причины. Значение вне перечня —
 * отказ: барьер, угадавший смысл незнакомого слова, выбрал бы не тот код.
 */
const UNKNOWN_KINDS = ['tool', 'field'];

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Проблема одной операции или null. `at` — адрес в событии для причины блока. */
function operationProblem(op, at) {
    if (!isRecord(op)) return `${at}: операция не объект`;
    const fields = Object.hasOwn(OPERATION_FIELDS, op.op) ? OPERATION_FIELDS[op.op] : null;
    if (!fields) return `${at}: незнакомая операция ${JSON.stringify(op.op)}`;
    for (const field of fields) {
        if (typeof op[field] !== 'string' || op[field] === '') {
            return `${at} (${op.op}): нет строкового поля ${field}`;
        }
    }
    for (const field of OPTIONAL_STRING_FIELDS[op.op] ?? []) {
        if (op[field] !== undefined && typeof op[field] !== 'string') {
            return `${at} (${op.op}): поле ${field} не строка`;
        }
    }
    // Лишний ключ — отказ, а не «прочитаем что знаем»: поле, о котором барьер не знает, могло
    // нести путь или адрес, и операция без него судилась бы не по тому, что сделает CLI.
    const known = [
        'op',
        ...fields,
        ...(OPTIONAL_STRING_FIELDS[op.op] ?? []),
        ...(OTHER_FIELDS[op.op] ?? []),
    ];
    const stray = Object.keys(op).filter((k) => !known.includes(k));
    if (stray.length > 0) return `${at} (${op.op}): лишнее поле ${stray.join(', ')}`;
    if (op.op === 'unknown' && op.kind !== undefined && !UNKNOWN_KINDS.includes(op.kind)) {
        return `${at} (unknown): kind ${JSON.stringify(op.kind)} вне ${UNKNOWN_KINDS.join('/')}`;
    }
    if (op.op === 'mcp') {
        if (!MCP_EFFECTS.includes(op.effect)) {
            return `${at} (mcp): эффект ${JSON.stringify(op.effect)} вне ${MCP_EFFECTS.join('/')}`;
        }
        if (!Array.isArray(op.derived)) return `${at} (mcp): derived не массив`;
        for (let i = 0; i < op.derived.length; i++) {
            const problem = operationProblem(op.derived[i], `${at}.derived[${i}]`);
            if (problem) return problem;
        }
    }
    return null;
}

/** Проблема события или null. Пустой вызов невалиден: «нечего судить» — не разрешение. */
function toolEventProblem(event) {
    if (!isRecord(event)) return 'событие не объект';
    if (!Array.isArray(event.operations)) return 'у события нет массива operations';
    if (event.operations.length === 0) return 'событие без операций';
    for (let i = 0; i < event.operations.length; i++) {
        const problem = operationProblem(event.operations[i], `operations[${i}]`);
        if (problem) return problem;
    }
    return null;
}

/** Разбор stdout команды: `{event}` либо `{reason}`. */
function parseAdapterReply(stdout) {
    let reply;
    try {
        reply = JSON.parse(stdout);
    } catch {
        return { reason: `ответ не JSON: ${clip(stdout) || '(пусто)'}` };
    }
    if (!isRecord(reply)) return { reason: 'ответ не объект' };
    if (reply.protocol !== ADAPTER_PROTOCOL_VERSION) {
        return {
            reason: `незнакомая версия протокола ${JSON.stringify(reply.protocol)} (хук знает ${ADAPTER_PROTOCOL_VERSION})`,
        };
    }
    const problem = toolEventProblem(reply.event);
    if (problem) return { reason: `событие не по контракту: ${problem}` };
    return { event: reply.event };
}

const clip = (s) =>
    String(s ?? '')
        .trim()
        .slice(0, 300);

/**
 * Сырой вход хука → нормализованное событие через команду адаптера.
 *
 * Вердикт — `{ event }` либо `{ block: true, reason }`; иного исхода нет, и любой сбой
 * по пути становится вторым. `argv` — исполняемое и его аргументы БЕЗ оболочки: строка
 * команды прошла бы через разбор `sh`, и путь пакета с пробелом или `;` стал бы второй
 * командой.
 */
function normalizeViaAdapter(argv, rawInput, deps = {}) {
    const block = (reason) => ({ block: true, reason: `адаптер харнесса: ${reason}` });
    if (
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.some((a) => typeof a !== 'string' || a === '')
    ) {
        return block('команда нормализатора не задана');
    }
    const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
    let run;
    try {
        run = spawnSyncFn(argv[0], argv.slice(1), {
            input: rawInput,
            encoding: 'utf-8',
            timeout: deps.timeoutMs ?? ADAPTER_TIMEOUT_MS,
            maxBuffer: ADAPTER_MAX_BUFFER,
            env: deps.env ?? process.env,
            killSignal: 'SIGKILL',
        });
    } catch (error) {
        return block(
            `команда не запустилась: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (run.error) {
        const timedOut = run.error.code === 'ETIMEDOUT';
        return block(
            timedOut
                ? 'команда не ответила в срок'
                : `команда не запустилась: ${run.error.message}`,
        );
    }
    if (run.signal) return block(`команда убита сигналом ${run.signal}`);
    if (run.status !== 0) {
        return block(`команда вышла с кодом ${run.status}: ${clip(run.stderr) || '(stderr пуст)'}`);
    }
    const parsed = parseAdapterReply(run.stdout);
    return parsed.reason ? block(parsed.reason) : { event: parsed.event };
}

module.exports = {
    ADAPTER_PROTOCOL_VERSION,
    ADAPTER_TIMEOUT_MS,
    OPERATION_FIELDS,
    toolEventProblem,
    parseAdapterReply,
    normalizeViaAdapter,
};

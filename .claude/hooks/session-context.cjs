/**
 * Доверенный контекст сессии (`SessionContext`, `docs/harness-contract.md`, «Пакет адаптера»;
 * #184, Фаза 16c): раннер кладёт его в окружение сессии переменной `RALPH_SESSION_CONTEXT`,
 * и хук получает его наследованием — так же, как Claude Code отдаёт хуку своё окружение.
 *
 * Зачем. Guard дерева сессии контракта `RALPH_CORE_SHA` не получает (его раннер кладёт только
 * в команду своих хуков, #132), и петлю он узнавал по транскрипту Claude Code — строке
 * `ralph.md` в первом сообщении. Это догадка по тексту: сессия человека с похожим промптом
 * считалась петлёй, а у Codex, Kimi Code и OpenCode транскрипта Claude нет вовсе. Окружение
 * хука сессия не переписывает: её команды получают свою копию, а процесс хука порождает CLI
 * из окружения, которое ему дал раннер. Файл в дереве или каталоге состояния сессия
 * переписать могла бы — поэтому контекст едет не файлом.
 *
 * Fail-closed: переменной нет (или она пуста) — контекста нет, это сессия человека; переменная
 * есть, но не разбирается, не той формы или без обоих корней — ошибка, и хук блокирует вызов
 * кодом `session-context`. Битый контекст — не «петли нет»: раннер его заявил, и снять забор
 * данных контура порчей переменной было бы дешевле, чем подделать её.
 *
 * `policy` и `evidence` контракта сюда не едут: их несут карточки схемы контура (#185) и
 * доказательств скиллов (16e). Незнакомое поле — отказ, а не пропуск: раннер и хук едут одной
 * ревизией, и поле, которого хук не знает, значит не то, что он думает.
 *
 * CommonJS без зависимостей, как все хуки: запускается до `npm ci`.
 */
const path = require('node:path');

/** Имя переменной контекста. Задаёт раннер (`core/session-context.ts`), читают хуки. */
const SESSION_CONTEXT_ENV = 'RALPH_SESSION_CONTEXT';

const KEYS = ['sessionId', 'loop', 'coreRevision', 'roots'];
const ROOT_KEYS = ['consumer', 'execution'];
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Лишние и недостающие ключи объекта против перечня — строкой, пустая — совпало. */
function keysProblem(obj, keys, where) {
    const extra = Object.keys(obj).filter((k) => !keys.includes(k));
    const missing = keys.filter((k) => !Object.hasOwn(obj, k));
    const parts = [];
    if (missing.length > 0) parts.push(`нет ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`незнакомые ${extra.join(', ')}`);
    return parts.length > 0 ? `${where}: ${parts.join('; ')}` : '';
}

/**
 * Разбор значения переменной. `{ context: null, error: null }` — контекста нет;
 * `{ context, error: null }` — разобран; `{ context: null, error }` — заявлен, но битый.
 */
function parseSessionContext(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return { context: null, error: null };
    const fail = (why) => ({ context: null, error: `${SESSION_CONTEXT_ENV}: ${why}` });
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        return fail(`не JSON (${error && error.message ? error.message : 'ошибка разбора'})`);
    }
    if (!isPlainObject(value)) return fail('не объект');
    const top = keysProblem(value, KEYS, 'контекст');
    if (top) return fail(top);
    if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '') {
        return fail('sessionId — не непустая строка');
    }
    if (typeof value.loop !== 'boolean') return fail('loop — не булево');
    if (value.coreRevision !== '' && !SHA_RE.test(String(value.coreRevision))) {
        return fail('coreRevision — не полный SHA и не пустая строка');
    }
    if (!isPlainObject(value.roots)) return fail('roots — не объект');
    const roots = keysProblem(value.roots, ROOT_KEYS, 'roots');
    if (roots) return fail(roots);
    for (const key of ROOT_KEYS) {
        const root = value.roots[key];
        // Оба корня обязательны и абсолютны: относительный путь разрешался бы от каталога,
        // в котором CLI запустил хук, — то есть от того, что выбирает не раннер.
        if (typeof root !== 'string' || !path.isAbsolute(root)) {
            return fail(`roots.${key} — не абсолютный путь`);
        }
    }
    return {
        context: {
            sessionId: value.sessionId,
            loop: value.loop,
            coreRevision: value.coreRevision,
            roots: { consumer: value.roots.consumer, execution: value.roots.execution },
        },
        error: null,
    };
}

/** Контекст из окружения хука. */
function readSessionContext(env = process.env) {
    return parseSessionContext(env[SESSION_CONTEXT_ENV]);
}

module.exports = { SESSION_CONTEXT_ENV, parseSessionContext, readSessionContext };

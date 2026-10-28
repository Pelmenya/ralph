/**
 * Данные контракта потребителя для хуков: правила контура guard'а и таблица скиллов
 * барьера скиллов (#99, Фаза 11).
 *
 * Исполняемая часть хуков едет с ядром, а то, что у каждого проекта своё, — список
 * MCP-мутаций форжа, которые нужны рабочему циклу, и какой скилл обязан быть загружен до
 * правки какого файла, — лежит у потребителя: `<проект>/.claude/ralph/hooks.json`. Пока
 * эти списки жили в коде хука, сменить форж или добавить скилл значило править барьер
 * ядра под один проект.
 *
 * Каталог проекта — `CLAUDE_PROJECT_DIR`, его Claude Code передаёт хуку. От каталога
 * самого хука файл не ищется: хук из установки ядра лежит не в проекте.
 *
 * Режим отказа:
 *   • файла нет или каталог проекта не назван — пустые данные. Это самый строгий контур:
 *     ни одной MCP-мутации и ни одного обязательного скилла. Проект, ничего не
 *     заявивший, ничего сверх инвариантов ядра и не получает;
 *   • файл есть, но не разбирается или не той формы — исключение. Хуки превращают его
 *     в блок: «битый конфиг — стоп, а не дефолт». Незнакомый ключ — тоже не та форма:
 *     опечатка `"skill"` вместо `"skills"` дала бы пустую таблицу скиллов, и барьер
 *     ослаб бы без единого сообщения.
 *
 * **Канал правки данных сессией.** Файл лежит в дереве, которое правит сессия, и читается
 * на каждом вызове как есть: дописанный в `writeAllowed` `SetDecision` действовал бы со
 * следующего вызова, а ship человека в `review.yaml` срабатывает только на мердже. Поэтому
 * в сессии петли guard не пускает к этому пути ни файловые инструменты записи, ни вызов
 * оболочки, который его пишет (`guard-rules.cjs`). Сессию петли он узнаёт по контракту
 * `RALPH_CORE_SHA` или — хук дерева сессии, которому раннер контракт не даёт (#132), —
 * переходным признаком: строкой `ralph.md` в промпте транскрипта (`core-revision.cjs`).
 * Признак — догадка по тексту: сессия петли, чей промпт строки не содержит, забора не
 * получит. Это и сам забор по тексту вызова, а не доказательство: путь, собранный в
 * оболочке по частям, и скрипт, пишущий файл без имени в командной строке, он не видит.
 * Закрывает канал раннер: хуки,
 * которые он регистрирует сессии своим settings (`core/session-settings.ts`), читают
 * данные по `RALPH_HOOKS_DATA` из дерева человека. Хуки, которые Claude Code берёт из
 * `.claude/settings.json` самого дерева сессии, по-прежнему читают данные этого дерева —
 * блокировать сильнее, чем хук раннера, они могут, ослабить его — нет.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Путь данных относительно корня проекта. */
const DATA_PATH = path.join('.claude', 'ralph', 'hooks.json');

/**
 * Пустые данные — свежий объект на каждый вызов, а не общий замороженный: `freeze`
 * неглубокий, и `.mcp.writeAllowed.add(...)` у общего объекта открыл бы «самый строгий
 * контур» для всего процесса.
 */
function emptyData() {
    return {
        mcp: {
            writeAllowed: new Set(),
            neverExceptions: new Set(),
            tools: new Map(),
            toolsDeclared: false,
        },
        skills: { files: [], commands: [] },
    };
}

function fail(file, what) {
    throw new Error(`данные хуков ${file}: ${what}`);
}

/** Ключи каждого уровня — закрытый перечень; лишний ключ — опечатка, а не расширение. */
const KNOWN_KEYS = {
    '': ['$comment', 'mcp', 'skills'],
    mcp: ['writeAllowed', 'neverExceptions', 'notes', 'tools'],
    skills: ['files', 'commands'],
    tool: ['effect'],
};

function onlyKnownKeys(file, value, where, label = where) {
    const known = KNOWN_KEYS[where];
    const extra = Object.keys(value).filter((key) => !known.includes(key));
    if (extra.length > 0) {
        const at = where === '' ? 'верхний уровень' : label;
        fail(file, `${at}: незнакомые ключи ${extra.join(', ')} (известны: ${known.join(', ')})`);
    }
}

function stringList(file, value, where) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) {
        fail(file, `${where} — не список непустых строк`);
    }
    return value;
}

/** Ряд таблицы скиллов: регэксп по пути файла или команде → скиллы и причина. */
function skillRows(file, value, where) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail(file, `${where} — не список`);
    return value.map((row, i) => {
        const at = `${where}[${i}]`;
        if (!row || typeof row !== 'object') fail(file, `${at} — не объект`);
        if (typeof row.pattern !== 'string' || row.pattern === '') {
            fail(file, `${at}.pattern — не непустая строка`);
        }
        let re;
        try {
            re = new RegExp(row.pattern);
        } catch (error) {
            fail(file, `${at}.pattern не регэксп (${error.message})`);
        }
        const skills = stringList(file, row.skills, `${at}.skills`);
        if (skills.length === 0) fail(file, `${at}.skills пуст`);
        if (typeof row.why !== 'string' || row.why === '') {
            fail(file, `${at}.why — не непустая строка`);
        }
        return { test: (subject) => re.test(subject), skills, why: row.why };
    });
}

/**
 * Эффекты MCP-инструментов (#185, Фаза 16c): `mcp.tools.<полное имя>.effect` — `read` или
 * `write`. Контракт харнесса (`docs/harness-contract.md`) судит MCP по эффекту из политики, а
 * не по префиксу `List`/`Get` имени: префикс — догадка о чужом API, и `ListSecrets` по ней
 * «чтение». Guard на событии (#186) судит MCP по эффектам, если данные их заявили
 * (`toolsDeclared`); данные прежней формы, без `tools`, судятся прежним правилом до миграции
 * (`mcp-effects.cjs`): применяет её доверенный launcher, а не сессия, и переключение без неё
 * отняло бы у живой петли разрешённые чтения.
 *
 * `unknown` в данных не пишется: это отсутствие записи, а не значение. Любое другое значение,
 * лишний ключ записи, имя без `mcp__` — отказ. Пока `writeAllowed` жив рядом, два источника
 * обязаны совпадать: каждая мутация `writeAllowed` — запись `write`, каждая запись `write` —
 * в `writeAllowed`. Заявленный `tools` судится целиком, и пустой тоже: `{}` при непустом
 * `writeAllowed` — неполные данные, а не «эффектов нет». Расхождение — «неполные
 * данные», и это блок: после переключения половина, о которой забыли, молча стала бы
 * правилом.
 */
const EFFECTS = ['read', 'write'];

function mcpTools(file, value, writeAllowed) {
    const tools = new Map();
    if (value === undefined) return tools;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(file, 'mcp.tools — не объект');
    }
    for (const [name, entry] of Object.entries(value)) {
        const at = `mcp.tools.${name}`;
        if (!/^mcp__./i.test(name)) fail(file, `${at} — имя не MCP-инструмента (нет mcp__)`);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            fail(file, `${at} — не объект`);
        }
        onlyKnownKeys(file, entry, 'tool', at);
        if (!EFFECTS.includes(entry.effect)) {
            fail(file, `${at}.effect — не ${EFFECTS.join('/')} (${JSON.stringify(entry.effect)})`);
        }
        tools.set(name, entry.effect);
    }
    const missing = [...writeAllowed].filter((n) => tools.get(n) !== 'write');
    if (missing.length > 0) {
        fail(file, `mcp.tools неполон: нет эффекта write у ${missing.join(', ')}`);
    }
    const stray = [...tools].filter(([n, e]) => e === 'write' && !writeAllowed.has(n));
    if (stray.length > 0) {
        fail(file, `mcp.tools: write вне mcp.writeAllowed — ${stray.map(([n]) => n).join(', ')}`);
    }
    return tools;
}

/** Разбор текста данных. Чистая функция: тесты подают текст, а не файл. */
function parseConsumerData(text, file = DATA_PATH) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        fail(file, `не JSON (${error.message})`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(file, 'не объект');
    onlyKnownKeys(file, raw, '');
    const mcp = raw.mcp === undefined ? {} : raw.mcp;
    const skills = raw.skills === undefined ? {} : raw.skills;
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) fail(file, 'mcp — не объект');
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
        fail(file, 'skills — не объект');
    }
    onlyKnownKeys(file, mcp, 'mcp');
    onlyKnownKeys(file, skills, 'skills');
    if (
        mcp.notes !== undefined &&
        (!mcp.notes || typeof mcp.notes !== 'object' || Array.isArray(mcp.notes))
    ) {
        fail(file, 'mcp.notes — не объект');
    }
    const writeAllowed = new Set(stringList(file, mcp.writeAllowed, 'mcp.writeAllowed'));
    const neverExceptions = new Set(stringList(file, mcp.neverExceptions, 'mcp.neverExceptions'));
    return {
        mcp: {
            writeAllowed,
            neverExceptions,
            tools: mcpTools(file, mcp.tools, writeAllowed),
            toolsDeclared: mcp.tools !== undefined,
        },
        skills: {
            files: skillRows(file, skills.files, 'skills.files'),
            commands: skillRows(file, skills.commands, 'skills.commands'),
        },
    };
}

/**
 * Путь данных, названный раннером. Сессию петли раннер запускает с settings, собранным из
 * доверенного дерева человека (`core/session-settings.ts`, Фаза 12), и команда хука несёт
 * этот путь переменной: данные контура берутся из дерева человека, а не из дерева сессии,
 * которое правит PR. Относительный путь — исключение: его база — каталог, где Claude Code
 * запустил хук, то есть снова дерево сессии.
 */
const DATA_ENV = 'RALPH_HOOKS_DATA';

/**
 * Данные проекта: из `RALPH_HOOKS_DATA`, если раннер его назвал, иначе из
 * `CLAUDE_PROJECT_DIR`; нет файла — пустые, битый — исключение.
 */
function loadConsumerData({ env = process.env, readFileFn = fs.readFileSync } = {}) {
    const named = env[DATA_ENV];
    let file;
    if (typeof named === 'string' && named !== '') {
        if (!path.isAbsolute(named)) fail(named, `${DATA_ENV} — не абсолютный путь`);
        file = named;
    } else {
        const root = env.CLAUDE_PROJECT_DIR;
        if (typeof root !== 'string' || root === '') return emptyData();
        file = path.join(root, DATA_PATH);
    }
    let text;
    try {
        text = readFileFn(file, 'utf-8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return emptyData();
        throw error;
    }
    return parseConsumerData(text, file);
}

module.exports = { DATA_PATH, DATA_ENV, emptyData, parseConsumerData, loadConsumerData };

#!/usr/bin/env node
/**
 * PreToolUse hook — барьер «скилл загружен до первой правки» для сессий петли.
 *
 * Перенесён от потребителя, где родился из замера 22.09.2026: по 36 сессиям раннера таблица
 * «обязательно загрузить скилл» в проектном промпте читалась, инструмент `Skill` был
 * доступен, а вызовов — ноль. Правило без механизма — пожелание, поэтому здесь механизм:
 * правка файла, за который отвечает скилл, блокируется, пока в транскрипте ЭТОЙ сессии
 * нет вызова `Skill` с нужным именем.
 *
 * Таблица «файл или команда → скилл» — данные потребителя (`.claude/ralph/hooks.json`,
 * раздел `skills`; разбор — `consumer-data.cjs`), а не код хука (#99): исполняемая часть
 * едет с ядром, а какие скиллы есть у проекта, ядро знать не обязано. У канона ряд один —
 * тесты и `vitest`. Новый ряд — вместе со скиллом в том же PR, иначе барьер требовал бы
 * то, чего нет.
 *
 * Input (stdin): JSON { tool_name, tool_input, transcript_path, session_id }.
 * Exit 2 + stderr — инструмент заблокирован, текст уходит агенту; exit 0 — разрешено.
 *
 * Три решения, без которых барьер молчал бы:
 *
 * 1. **Bash — тоже правка.** Сессии петли пишут файлы не только через `Edit`/`Write`, а
 *    heredoc'ом, `python3 -` и `sed -i` (у потребителя: 54 записи через Bash, ноль через
 *    `Edit` за одну сессию). Поэтому Bash-команда с путём целевого файла И признаком
 *    записи считается правкой.
 * 2. **Сессия петли узнаётся по контракту запуска, и только по нему.** Раннер передаёт
 *    `RALPH_CORE_SHA` (`core-revision.cjs`) в команде хука, зарегистрированного из
 *    установки ядра (`core/session-settings.ts`, #132), и хук сверяет с этой ревизией
 *    себя: разошёлся, ревизия недоступна, сверка упала — блок. Прежний признак — строка
 *    `ralph.md` в первом сообщении транскрипта — снят (#132): при внешней установке путь
 *    контракта другой, и неопознанная сессия пропускалась бы молча, а промпт, называющий
 *    файл, сам по себе петлю не заявляет. Без контракта барьер не вмешивается — это
 *    сессия человека или хук из дерева сессии, которому раннер контракт не дал.
 *    `RALPH_SKILL_GUARD=on` включает барьер без контракта: его ставит раннер в раскладке
 *    без `roots` и в хуках копии ядра без своего git, им же пользуются при проверке руками.
 *    Выключателя нет: без контракта барьер и так снят, а при контракте любое значение
 *    переключателя не действует — иначе переменная, унаследованная из окружения раннера
 *    или env-файла, молча снимала бы барьер в его сессиях.
 * 3. **Транскрипт назван, но не читается — блокировка, не пропуск**: барьер, отчитавшийся
 *    «нарушений нет», не заглянув в файл, — тот же тихий отказ. Транскрипт не назван
 *    вовсе — разрешено, если петля не заявлена контрактом: без него сессию петли не
 *    отличить, а ложная блокировка сессии человека стоит дороже. Петля заявлена, а
 *    транскрипта нет — блок: проверить вызов `Skill` нечем.
 *
 * Факт «скилл загружен» кэшируется маркером в tmpdir по `session_id`: транскрипт только
 * растёт, а барьер стоит на каждом вызове Bash.
 *
 * Ревизия сверяется ДО загрузки соседних модулей (`consumer-data.cjs` грузится только
 * после вердикта): правленый сосед, исполненный первым, подменял сверщик. И сверка идёт
 * на любом вызове, а не только там, где нужен скилл, — это второй, независимый от guard'а
 * сверщик каталога: правленый `guard.cjs` снимает сверку у себя, но не здесь. Цена —
 * несколько миллисекунд на вызов (git-процесс и хеши `*.cjs`); кэш ожидаемых хешей в
 * tmpdir её снял бы, но он стал бы источником правды, который сессия может подложить.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Только сверщик: он без соседей. Данные потребителя — после вердикта ревизии, в main().
const { checkCoreRevision, describeError, expectedSha } = require('./core-revision.cjs');

const EXIT_BLOCKED = 2;

/**
 * Таблица скиллов: `files` — что за файл → какой скилл обязан быть загружен до его
 * правки; `commands` — ряды, которые узнаются по команде (у потребителя — коммит →
 * `git-commit`). Без данных потребителя таблица пуста.
 */
const NO_RULES = { files: [], commands: [] };

/** Признаки, по которым Bash-команда считается ЗАПИСЬЮ в файл, а не чтением. */
const WRITE_MARKERS = [
    /(^|[^<>])>{1,2}\s*["']?[^\s"'|;&]*\.[cm]?tsx?\b/, // `> file.tsx`, `>> file.ts`
    /\btee\b/,
    /\bsed\s+(-[a-zA-Z]*i|--in-place)/,
    /\bperl\s+-\S*i/,
    /write_text\(|\.write\(|open\([^)]*['"][wa]/, // python
    // node -e: запись через fs — та же правка, что heredoc (ревью Kimi).
    /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\b/,
    /\bapply_patch\b|\bgit\s+apply\b|(^|\s)patch\s/,
    /\b(mv|cp)\s+[^|;&]*\.[cm]?tsx?\b/,
];

// Слэш в пути не обязателен: тест в корне репозитория (`gate-env.test.mts`) — такой же
// тест, и до ревью Kimi он правился без скилла.
const PATH_RE = /[\w@./-]+\.[cm]?tsx?\b/g;

/** Пути, которые правит вызов: у файловых инструментов — из полей, у Bash — из текста. */
function targetsOf(toolName, toolInput) {
    const input = toolInput || {};
    if (toolName === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : '';
        if (!WRITE_MARKERS.some((re) => re.test(command))) return [];
        return [...new Set(command.match(PATH_RE) || [])];
    }
    const paths = [];
    for (const key of ['file_path', 'path', 'notebook_path']) {
        if (typeof input[key] === 'string') paths.push(input[key]);
    }
    if (Array.isArray(input.edits)) {
        for (const edit of input.edits) {
            if (edit && typeof edit.file_path === 'string') paths.push(edit.file_path);
        }
    }
    return paths;
}

/** Скиллы, обязательные для набора путей и команды, с причиной — для текста отказа. */
function requiredSkills(targets, command = '', rules = NO_RULES) {
    const required = new Map();
    const add = (rule, target) => {
        for (const skill of rule.skills) {
            if (!required.has(skill)) required.set(skill, { why: rule.why, target });
        }
    };
    for (const target of targets) {
        for (const rule of rules.files) if (rule.test(target)) add(rule, target);
    }
    for (const rule of rules.commands) if (rule.test(command)) add(rule, 'команда');
    return required;
}

/** Команда вызова, если это Bash, — для рядов таблицы, узнаваемых по команде. */
function commandOf(toolName, toolInput) {
    const input = toolInput || {};
    return toolName === 'Bash' && typeof input.command === 'string' ? input.command : '';
}

/** Сессия петли — заявленная контрактом запуска; текст транскрипта её не заявляет. */
function isLoopSession(env = process.env) {
    // Контракт сильнее переключателя: раннер заявил петлю — никакое значение
    // `RALPH_SKILL_GUARD` её не отменяет.
    if (expectedSha(env) !== '') return true;
    return env.RALPH_SKILL_GUARD === 'on';
}

/** Имена скиллов, вызванных инструментом `Skill` за сессию. */
function loadedSkills(lines) {
    const loaded = new Set();
    for (const line of lines) {
        if (!line.includes('"name":"Skill"')) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        const content = record.message && record.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block && block.type === 'tool_use' && block.name === 'Skill') {
                const skill = block.input && block.input.skill;
                if (typeof skill === 'string') loaded.add(skill.replace(/^\//, ''));
            }
        }
    }
    return loaded;
}

function markerDir(sessionId) {
    return path.join(os.tmpdir(), 'ralph-skill-barrier', String(sessionId || 'no-session'));
}

/** Вердикт по вызову: {blocked, reason}. Чистая функция — транскрипт приходит строками. */
function decide({
    toolName,
    toolInput,
    transcriptLines,
    env = process.env,
    cached = new Set(),
    rules = NO_RULES,
}) {
    const required = requiredSkills(
        targetsOf(toolName, toolInput),
        commandOf(toolName, toolInput),
        rules,
    );
    if (required.size === 0) return { blocked: false };
    // Без контракта запуска — сессия человека: ложная блокировка ей стоит дороже. С
    // контрактом и без транскрипта судить о скиллах нечем — блок ниже.
    if (!isLoopSession(env)) return { blocked: false };
    const missing = [...required].filter(([skill]) => !cached.has(skill));
    if (missing.length === 0) return { blocked: false, loaded: [...required.keys()] };
    if (transcriptLines === null) {
        return {
            blocked: true,
            code: 'skill-barrier-fault',
            reason:
                '[skill-barrier.cjs] Сессия петли заявлена контрактом запуска, а транскрипт ' +
                'не назван — проверить вызов Skill нечем, правка заблокирована fail-closed.',
        };
    }
    const loaded = loadedSkills(transcriptLines);
    const stillMissing = missing.filter(([skill]) => !loaded.has(skill));
    if (stillMissing.length === 0) return { blocked: false, loaded: [...required.keys()] };
    const list = stillMissing
        .map(([skill, { why, target }]) => `  - Skill(${skill}) — ${why} (${target})`)
        .join('\n');
    return {
        blocked: true,
        code: 'skill-required',
        reason:
            '[skill-barrier.cjs] Правка заблокирована: до первой правки этого файла в сессии ' +
            `обязан быть вызван инструмент Skill. Не хватает:\n${list}\n` +
            "Вызови Skill с этим именем (не читай файл скилла cat'ом — это не считается) " +
            'и повтори правку.',
    };
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => (data += chunk));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(''));
        setTimeout(() => resolve(data), 5000);
    });
}

/**
 * Префикс машинной строки кода причины (#183) — литералом, как в `guard.cjs`; равенство с
 * контрактом держит `adapters/barrier-reason.test.ts`.
 */
const REASON_LINE_PREFIX = 'ralph-reason-code: ';

/** Отказ: текст агенту, последней строкой — код причины для пробы. */
function block(code, reason) {
    process.stderr.write(`${reason}\n${REASON_LINE_PREFIX}${code}\n`);
    process.exit(EXIT_BLOCKED);
}

async function main() {
    let input;
    try {
        input = JSON.parse((await readStdin()) || '{}');
    } catch (error) {
        block(
            'skill-barrier-fault',
            `[skill-barrier.cjs] Вход не разобрался (${describeError(error)}) — вызов заблокирован.`,
        );
    }
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};

    // Ревизия — до всего остального и на любом вызове: хук не той ревизии не судит ни о
    // чём, в том числе о том, нужен ли тут скилл.
    let revision;
    try {
        revision = checkCoreRevision();
    } catch (error) {
        revision = { error: describeError(error) };
    }
    if (revision.error) {
        block(
            'skill-barrier-fault',
            `[skill-barrier.cjs] Ревизия хука не сверилась с ядром: ${revision.error} ` +
                'Вызов заблокирован: хук не той ревизии — не тот барьер, который ревьюили.',
        );
    }

    let rules;
    try {
        rules = require('./consumer-data.cjs').loadConsumerData().skills;
    } catch (error) {
        block(
            'skill-barrier-fault',
            `[skill-barrier.cjs] Таблица скиллов не загрузилась (${describeError(error)}) — ` +
                'вызов заблокирован fail-closed.',
        );
    }
    const targets = targetsOf(toolName, toolInput);
    if (requiredSkills(targets, commandOf(toolName, toolInput), rules).size === 0) return;

    let transcriptLines = null;
    if (typeof input.transcript_path === 'string' && input.transcript_path !== '') {
        try {
            transcriptLines = fs.readFileSync(input.transcript_path, 'utf-8').split('\n');
        } catch (error) {
            block(
                'skill-barrier-fault',
                `[skill-barrier.cjs] Транскрипт ${input.transcript_path} не читается ` +
                    `(${describeError(error)}) — судить о сессии нечем, вызов заблокирован fail-closed.`,
            );
        }
    }

    const dir = markerDir(input.session_id);
    const cached = new Set();
    try {
        for (const name of fs.readdirSync(dir)) cached.add(name);
    } catch {
        /* маркеров ещё нет */
    }
    const verdict = decide({ toolName, toolInput, transcriptLines, cached, rules });
    if (verdict.blocked) block(verdict.code, verdict.reason);
    if (verdict.loaded) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            for (const skill of verdict.loaded) fs.writeFileSync(path.join(dir, skill), '');
        } catch {
            /* кэш — ускорение, не источник правды */
        }
    }
}

module.exports = {
    NO_RULES,
    targetsOf,
    requiredSkills,
    isLoopSession,
    loadedSkills,
    decide,
};

if (require.main === module) {
    main().then(
        () => process.exit(0),
        (error) =>
            block(
                'skill-barrier-fault',
                `[skill-barrier.cjs] Ошибка барьера: ${describeError(error)} — заблокировано.`,
            ),
    );
}

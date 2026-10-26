/**
 * Сверка ПРОВОДКИ барьера, а не его правил (#138).
 *
 * Сессии раннера идут под `permissionMode: "bypassPermissions"` — в этом режиме площадка
 * не спрашивает разрешений вовсе, и списки `permissions.allow/deny` из
 * `.claude/settings.json` перестают что-либо значить. Единственное, что продолжает
 * работать, — `PreToolUse`-хук `guard.cjs`. То есть связь «в конфиге раннера bypass →
 * в настройках обязан быть guard» держит весь барьер целиком, а записана она была только
 * прозой, в условии пересмотра записи журнала.
 *
 * Особая чувствительность у MCP: для него guard — ЕДИНСТВЕННАЯ проверка (правил MCP в
 * `permissions.deny` нет ни одного). Сузится matcher до четырёх инструментов — все
 * MCP-мутации откроются молча, и ни один существующий тест этого не заметит: правила
 * барьера останутся исправными, просто их перестанут звать.
 *
 * Модуль отдельно от теста, чтобы сверку можно было прогнать и на подложных входах
 * («от противного»): проверка, которая умеет краснеть только на боевых файлах, не
 * доказывает, что она вообще умеет краснеть.
 *
 * Чего сверка НЕ видит и видеть не может: пользовательские настройки
 * (`~/.claude/settings.json`), флаг `--settings` в командной строке и переменные
 * окружения — они живут вне репозитория, а тест сторожит именно репозиторий. Здесь
 * закрывается то, что приезжает в PR.
 */

/** Имя файла барьера. Проверяется и в команде хука, и на диске. */
export const GUARD_FILE = 'guard.cjs';

/** Инструменты, которые matcher обязан накрывать: сверяются пробой имени. */
const GUARDED_TOOLS = [
    'Bash',
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'Grep',
] as const;

/**
 * У MCP требование — ОТДЕЛЬНАЯ ШИРОКАЯ АЛЬТЕРНАТИВА в matcher'е, и путь к этой
 * формулировке стоит записать: он разворачивался трижды, каждый раз по делу.
 *
 * Пробами (перечислить имена инструментов и проверить, что matcher их накрывает)
 * универсальность регэкспа не доказывается: под любой конечный набор подбирается
 * matcher, который его накрывает и сужает всё прочее. Проход 1 снял перечисление
 * подключённых серверов, проход 2 — класс `[a-z-]+`, проход 5 — уже набор из семи
 * непохожих имён (его накрывает `mcp__[\w-]+__\w+$`, мимо идёт метод с дефисом).
 * Поиском литерала `mcp__.*` в тексте matcher'а — тоже нет: `prefix(mcp__.*)` литерал
 * содержит и не накрывает ни одного имени, а законное `(?:mcp__.*)` краснело (проход 4).
 *
 * Вопрос «есть ли в matcher'е ветка, накрывающая ЛЮБОЕ имя» решается разбором на
 * альтернативы верхнего уровня — это тридцать строк ниже, а не половина движка
 * регулярных выражений: `|` считается вне групп и классов, обёртки-группы снимаются,
 * остаток сверяется с широкими формами. Ответ получается точный, а не правдоподобный.
 *
 * Цена — форма всё же фиксирована: `mcp__[\s\S]*` красный, хотя эквивалентен. Это
 * осознанно и дёшево: одна каноническая запись против барьера, который держит режим
 * bypass целиком.
 */
const BROAD_ALTERNATIVES = new Set(['mcp__.*', 'mcp__.+', '.*', '.+']);
const MCP_REQUIREMENT = 'mcp__.* отдельной веткой (любой MCP-сервер, включая будущий)';

/** Сбалансированы ли круглые скобки — чтобы `(a)(b)` не сняли как одну обёртку. */
function balanced(re: string): boolean {
    let depth = 0;
    for (let i = 0; i < re.length; i += 1) {
        const ch = re[i];
        if (ch === '\\') i += 1;
        else if (ch === '(') depth += 1;
        else if (ch === ')' && (depth -= 1) < 0) return false;
    }
    return depth === 0;
}

/** Альтернативы верхнего уровня: `|` вне групп, классов символов и экранирования. */
function topLevelAlternatives(re: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let inClass = false;
    for (let i = 0; i < re.length; i += 1) {
        const ch = re[i] ?? '';
        if (ch === '\\') {
            current += ch + (re[i + 1] ?? '');
            i += 1;
        } else if (inClass) {
            inClass = ch !== ']';
            current += ch;
        } else if (ch === '[') {
            inClass = true;
            current += ch;
        } else if (ch === '|' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            if (ch === '(') depth += 1;
            if (ch === ')') depth -= 1;
            current += ch;
        }
    }
    parts.push(current);
    return parts;
}

/**
 * Снимает якоря и обёртки-группы: `^(?:x)$` → `x`. Именованная группа `(?<mcp>…)` —
 * такая же законная обёртка, и без неё проверка краснела на исправном matcher'е
 * (проход 6 ревью).
 */
function unwrap(alternative: string): string {
    let text = alternative.trim().replace(/^\^/, '').replace(/\$$/, '');
    for (;;) {
        const match = /^\((?:\?:|\?<[A-Za-z_$][\w$]*>)?([\s\S]*)\)$/.exec(text);
        if (!match || !balanced(match[1] ?? '')) return text;
        text = (match[1] ?? '').trim();
    }
}

/** Есть ли ветка, накрывающая ЛЮБОЙ MCP-инструмент. */
function coversAllMcp(matcher: string): boolean {
    return topLevelAlternatives(matcher).some((alt) => BROAD_ALTERNATIVES.has(unwrap(alt)));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

export type TGuardWiringInput = {
    /** Разобранный `.claude/settings.json`. */
    settings: unknown;
    /** Разобранный `.claude/ralph/ralph.config.json`. */
    ralphConfig: unknown;
    /** Лежит ли файл барьера на диске рядом с настройками. */
    guardExists: boolean;
};

/**
 * Профили, которые после мерджа с `common` идут под bypassPermissions.
 *
 * Мердж здесь тривиален намеренно: `permissionMode` — скаляр верхнего уровня, и звать
 * ради него `resolveProfile` из ядра значило бы привязать барьер этого репозитория к
 * внутренностям модуля, который уезжает в submodule.
 *
 * Пустой блок `profiles` не означает «bypass'а нет»: режим из `common` достанется любому
 * профилю, который заведут завтра. Поэтому такой конфиг считается за один безымянный
 * профиль — fail-closed.
 */
export function bypassProfiles(ralphConfig: unknown): string[] {
    if (!isRecord(ralphConfig)) return [];
    const common = record(ralphConfig['common']);
    const profiles = record(ralphConfig['profiles']);
    const names = Object.keys(profiles);
    const modeOf = (name: string): unknown => {
        const own = record(profiles[name])['permissionMode'];
        return own === undefined ? common['permissionMode'] : own;
    };
    if (names.length === 0) {
        return common['permissionMode'] === 'bypassPermissions' ? ['common'] : [];
    }
    return names.filter((name) => modeOf(name) === 'bypassPermissions');
}

/**
 * Команда хука проверяется НЕ списком запретов, а строгой формой: ровно один запуск node
 * с путём, оканчивающимся на имя барьера, и ничего кроме.
 *
 * Список запретов проигрывал по одной причине за проход: сначала мимо шла подстрока
 * (`echo guard.cjs`, проход 1), потом склейка `|| true` и `node --check` (проход 2), потом
 * `< /dev/null` — guard запускается, читает пустой stdin и выходит нулём, — перевод строки
 * со второй командой и флаг после имени файла (проход 3). Каждый раз запрет дописывался, и
 * каждый раз находилась следующая форма: перечислять способы сломать вызов бесполезно,
 * их больше, чем перечислений.
 *
 * Форма это закрывает разом, включая то, чего мы не придумали. Цена — безобидные на вид
 * варианты тоже красные: `node --no-warnings …` и `2>&1`. Про второй стоит сказать точно:
 * код возврата он не трогает, отказ сработает — но текст причины уедет из stderr, откуда
 * Claude его и читает, и агент получит блок без объяснения. Это не обход, это потеря
 * сообщения; красный тут потому, что форма одна, а не потому, что барьер сломан.
 *
 * Путь тоже канонический, и тоже в два захода. Сначала он был «что угодно, оканчивающееся
 * на guard.cjs» — проходил `node /tmp/not-guard.cjs` (проход 4). Потом «любой путь,
 * оканчивающийся на .claude/hooks/guard.cjs» — проходил `node "${OTHER}/.claude/hooks/
 * guard.cjs"`, то есть барьер СОСЕДНЕГО проекта, которого на машине может и не быть
 * (проход 5). Теперь разрешено ровно два написания: от `${CLAUDE_PROJECT_DIR}` (боевое,
 * работает из любого рабочего каталога) и относительное от корня репозитория.
 *
 * **Интерпретатор — голое `node`, без пути**, и это не педантизм (проход 7 ревью): путь
 * `./tools/node` указывает на файл ИЗ ЭТОГО ЖЕ дерева, который тот же PR и добавляет.
 * Скрипт с таким именем, возвращающий ноль, проходит проводку насквозь — барьер описан,
 * но не исполняется. Абсолютный путь не лучше: он тоже может вести внутрь репозитория.
 *
 * **Переменная — только в двойных кавычках или без них.** В одинарных оболочка её не
 * раскрывает: `node '$CLAUDE_PROJECT_DIR/.claude/hooks/guard.cjs'` ищет файл с долларом в
 * имени, не находит и выходит НЕ вторым кодом, то есть вызов инструмента не блокируется,
 * а сверка при этом зелёная (проход 7 ревью). Относительный путь в одинарных кавычках
 * безобиден и разрешён.
 */
// Путь собирается из GUARD_FILE и экранируется, а не пишется литералом регулярки: имя
// барьера живёт в одном месте, и скан путей канона (`tests/core-purity.test.ts`) видит
// путь к существующему файлу, а не строку `\.claude/…` с обратными слэшами.
const GUARD_PATH = `.claude/hooks/${GUARD_FILE}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROJECT_VAR = String.raw`(?:\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR)`;
const GUARD_COMMAND_RE = new RegExp(
    // Пробел и табуляция, а не `\s`: перевод строки — это ВТОРАЯ команда, а не отступ
    // (проход 8 ревью: `node\n"…/guard.cjs"` проходил, исполняя две негодные команды).
    String.raw`^[ \t]*node[ \t]+(?:` +
        // переменная проекта в двойных кавычках — обе кавычки обязаны быть
        String.raw`"${PROJECT_VAR}/${GUARD_PATH}"` +
        // либо она же без кавычек
        String.raw`|${PROJECT_VAR}/${GUARD_PATH}` +
        // либо путь от корня репозитория: кавычки любые, но парные (обратная ссылка)
        String.raw`|(["']?)(?:\./)?${GUARD_PATH}\1` +
        String.raw`)[ \t]*$`,
);

/**
 * Записи PreToolUse, чья КОМАНДА упоминает guard: matcher группы и сам хук.
 *
 * Отбор по `command`, а не по всему объекту: имя барьера встречается и в описательных
 * полях (`statusMessage: "Проверка guard.cjs"`), и такой сосед считался бы второй,
 * заведомо кривой записью барьера — ложный красный (проход 2 ревью). Хук другого типа
 * (`prompt`, `http`), притворившийся барьером, в отбор не попадает и остаётся невидимым —
 * и это верно: тогда исправного хука нет вовсе, о чём сверка и скажет.
 */
function guardHooks(settings: unknown): { matcher: unknown; hook: Record<string, unknown> }[] {
    return asArray(record(record(settings)['hooks'])['PreToolUse'])
        .filter(isRecord)
        .flatMap((entry) =>
            asArray(entry['hooks'])
                .filter(isRecord)
                .filter((hook) => {
                    const command = hook['command'];
                    return typeof command === 'string' && command.includes(GUARD_FILE);
                })
                .map((hook) => ({ matcher: entry['matcher'], hook })),
        );
}

/**
 * Поля записи хука, которые отменяют или сужают её вызов.
 *
 * Схема хуков у Claude Code шире, чем `{type, command}`: `if` ограничивает запуск одним
 * правилом разрешений, `once` — одним срабатыванием за сессию, `async` снимает с хука
 * право блокировать вызов (асинхронный ответ приходит, когда инструмент уже отработал),
 * а `type` бывает не только `command`. Любое из этих полей у барьера означает, что
 * барьер зовут не на всё или не вовремя, — и ни одно из них не видно в matcher'е.
 */
function disablers(hook: Record<string, unknown>): string[] {
    const bad: string[] = [];
    if (hook['type'] !== 'command') {
        bad.push(`type = ${JSON.stringify(hook['type'])}, нужен "command"`);
    }
    if (hook['if'] !== undefined) {
        bad.push(`задано условие if = ${JSON.stringify(hook['if'])} — хук зовут не на всё`);
    }
    if (hook['once'] === true) bad.push('once = true — сработает один раз за сессию');
    if (hook['async'] === true) bad.push('async = true — асинхронный хук не блокирует вызов');
    const command = typeof hook['command'] === 'string' ? hook['command'] : '';
    if (!GUARD_COMMAND_RE.test(command)) {
        bad.push(
            `команда ${JSON.stringify(hook['command'])} не равна одному запуску ` +
                `\`node <путь>/${GUARD_FILE}\` — всё остальное (склейка, перенаправление, ` +
                'флаг, вторая строка) способно погасить отказ барьера',
        );
    }
    return bad;
}

/**
 * Инструменты, которых matcher НЕ накрывает.
 *
 * Отсутствующий matcher у Claude Code означает «все инструменты» — это самая широкая
 * проводка, а не дыра. Всё остальное, что не строка, — мусор в настройках: гадать о
 * поведении площадки на нём мы не будем, это красный.
 */
function uncovered(matcher: unknown): string[] {
    const all: string[] = [...GUARDED_TOOLS, MCP_REQUIREMENT];
    if (matcher === undefined || matcher === '' || matcher === '*' || matcher === '.*') return [];
    if (typeof matcher !== 'string') return all;
    let re: RegExp;
    try {
        re = new RegExp(matcher);
    } catch {
        return all;
    }
    const missed: string[] = GUARDED_TOOLS.filter((tool) => !re.test(tool));
    if (!coversAllMcp(matcher)) missed.push(MCP_REQUIREMENT);
    return missed;
}

/**
 * Что не так с проводкой. Пустой список — сходится.
 *
 * Требований нет, пока ни один профиль не идёт под bypass: в обычном режиме барьер
 * дублирован списками разрешений, и настаивать на хуке было бы выдумкой.
 */
export function checkGuardWiring(input: TGuardWiringInput): string[] {
    const bypass = bypassProfiles(input.ralphConfig);
    if (bypass.length === 0) return [];

    const where = `bypassPermissions в профилях: ${bypass.join(', ')}`;
    const problems: string[] = [];
    const hooks = guardHooks(input.settings);

    // Один флаг в корне настроек выключает ВСЕ хуки разом, не тронув ни одной записи:
    // проводка на вид цела, барьера нет (найдено ревью Codex terra, проход 1).
    if (record(input.settings)['disableAllHooks'] === true) {
        problems.push(
            `${where}, а в .claude/settings.json стоит disableAllHooks: true — ` +
                'хуки не запускаются вовсе, и записи ниже ничего не значат.',
        );
    }

    if (hooks.length === 0) {
        problems.push(
            `${where}, но в .claude/settings.json нет PreToolUse-хука ${GUARD_FILE}. ` +
                'В этом режиме permissions.allow/deny не работают вовсе — барьера не осталось ни одного.',
        );
    }

    for (const { matcher, hook } of hooks) {
        const missed = uncovered(matcher);
        if (missed.length > 0) {
            problems.push(
                `${where}, а matcher хука ${GUARD_FILE} (${JSON.stringify(matcher)}) не ` +
                    `накрывает: ${missed.join(', ')}. Для MCP guard — единственная проверка: ` +
                    "правил MCP в permissions.deny нет, и сужение matcher'а открывает их молча.",
            );
        }
        const broken = disablers(hook);
        if (broken.length > 0) {
            problems.push(
                `${where}, а запись хука ${GUARD_FILE} его не исполняет: ${broken.join('; ')}.`,
            );
        }
    }

    if (!input.guardExists) {
        problems.push(
            `${where}, хук описан в настройках, но файл ${GUARD_FILE} не найден на диске: ` +
                'Claude Code молча пропустит вызов — упавший хук не блокирует инструмент.',
        );
    }

    return problems;
}

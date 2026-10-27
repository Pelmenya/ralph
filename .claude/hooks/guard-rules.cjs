/**
 * Правила границы безопасности — отдельно от самого хука, чтобы их можно было
 * проверить тестом (`.claude/hooks/guard-rules.test.ts`).
 *
 * Барьер обязан ловить **смысл действия, а не строку**: переставленные буквы флага
 * или другая оболочка не должны его обходить. Поэтому проверяется наличие признаков
 * (рекурсия + принудительность), а не конкретная запись команды.
 *
 * CommonJS намеренно: хук запускается до `npm ci` и обязан работать в любом окружении.
 */

// .env, .env.local, apps/api/.env, ralph.env — но НЕ .env.example / .env.sample
//
// Имя с префиксом (`ralph.env`, `app.env`) закрыто наравне с точка-env: секреты
// в нём те же, а до #382 такой файл проходил барьер целиком — и на чтение, и в команде.
const ENV_FILE_RE =
    /(^|[\\/])(?:\.env(\.(?!example|sample)[\w.-]+)?|[\w.-]+\.env(\.(?!example|sample)[\w.-]+)?)$/i;
// то же для упоминания внутри shell-команды: имя env-файла после пробела/слэша/кавычки
// /начала строки; `)` закрывает подстановки вида `$(grep ... /path/to/ralph.env)`.
const CMD_ENV_RE =
    /(^|[\s\\/"'=@])(?:\.env(\.(?!example|sample)[\w.-]+)?|[\w.-]+\.env(\.(?!example|sample)[\w.-]+)?)(?=\s|$|["';|)])/i;
// команды, которые действительно вычитывают или отправляют содержимое файла
const SECRET_READER_RE =
    /\b(cat|type|less|more|head|tail|cp|copy|scp|curl|wget|Get-Content|gc|grep)\b/i;

/**
 * Команды, которые получают путь env-файла аргументом и НЕ читают его содержимое: смотрят
 * метаданные, создают, удаляют, печатают сам аргумент. Всё прочее с путём env-файла в
 * аргументах — чтение или отправка.
 *
 * Список разрешённых, а не запрещённых, — по ревью Kimi: `SECRET_READER_RE` ниже знал
 * десяток читающих команд, и `sed -n p .env`, `awk 1 .env`, `base64 .env` проходили
 * насквозь. Читающих команд бесконечно много, нечитающих — горсть.
 */
const ENV_SAFE_COMMANDS = new Set([
    'ls',
    'stat',
    'test',
    '[',
    'file',
    'touch',
    'rm',
    'chmod',
    'echo',
    'printf',
    'realpath',
    'basename',
    'dirname',
]);

/** Аргумент — путь env-файла: без пробелов (это не текст сообщения), флаг `--x=` снят. */
function isEnvPathArg(arg) {
    const value = arg.replace(/^--?[\w-]+=/, '');
    return value !== '' && !/\s/.test(value) && ENV_FILE_RE.test(value);
}

/** Вызов, который получает env-файл аргументом и не входит в нечитающие. */
function readsEnvFile(calls) {
    for (const call of calls) {
        if (ENV_SAFE_COMMANDS.has(basenameOf(call.name))) continue;
        if (argValues(call).some(isEnvPathArg)) return basenameOf(call.name);
    }
    return null;
}

const {
    destructiveCall,
    rawAddressTarget,
    mutatesManifest,
    shellCalls,
    skipsGitHooks,
} = require('./guard-shell.cjs');
const { touchesHostService } = require('./guard-host-services.cjs');
const { killsForeignProcess } = require('./guard-process-kill.cjs');
const { argValues, basenameOf } = require('./shell-calls.cjs');
const { emptyData } = require('./consumer-data.cjs');

// --- MCP -------------------------------------------------------------------
//
// У MCP-вызова нет ни командной строки, ни пути к файлу — правила выше про него
// ничего сказать не могут, и до этой правки он проходил барьер насквозь
// (matcher хука знал только Bash|Read|Edit|Write). Для сессий с
// `bypassPermissions` это означало канал без единой проверки.
//
// Политика — **allowlist**: неизвестное запрещено. Blocklist дал бы дыру ровно
// на том, чего мы ещё не видели: подключённый завтра сервер получил бы полный
// доступ молча.

// Инструмент MCP узнаётся по ПРЕФИКСУ `mcp__`, и только по нему.
//
// Раньше здесь стоял класс имени сервера (`[a-z0-9-]+`), и это была дыра, а не строгость:
// сервер с подчёркиванием в имени (`mcp__my_server__DeleteEverything`) под регэксп не
// подходил, значит ветку MCP в `decide` не открывал вовсе — и allowlist его не проверял.
// Инструмент, о котором барьер ничего не знает, проходил насквозь. Проверено прогоном
// (проход 5 ревью): `mcpAllowed` возвращал false, а `decide` — «разрешено».
//
// Имена серверов задаёт не наша конвенция, а тот, кто сервер подключил: угадывать их
// алфавит — значит выбирать, каких серверов барьер не заметит. Опознаём по префиксу,
// решение принимает allowlist ниже.
const MCP_TOOL_RE = /^mcp__/i;

// Запрет сильнее любого разрешения ниже: секреты, права, приглашения, удаление,
// перенос и форк. `ListSecrets` — формально чтение, но читает оно секреты.
//
// `file_upload` и `*_unsafe` — из того же ряда, но по другой причине:
// browser_file_upload читает ЛОКАЛЬНЫЙ файл и отдаёт его открытой странице, то есть
// уносит `ralph.env` наружу мимо ENV_FILE_RE (тот сторожит Read/Edit/Write и оболочку,
// про браузер он не знает). Барьер, который обходится соседним инструментом, — не барьер.
const MCP_NEVER_RE = /(secret|role|invite|delete|discard|fork|transfer|file_upload|unsafe)/i;

// Точечные вычеты из запрета выше и мутации рабочего цикла — ДАННЫЕ потребителя, а не код
// (#99): какой форж у проекта и что из его MCP нужно циклу, ядро знать не обязано.
// Приезжают из `.claude/ralph/hooks.json` (`consumer-data.cjs`): `mcp.writeAllowed` и
// `mcp.neverExceptions`. Обоснование каждой записи живёт рядом с ней, в `mcp.notes`.
//
// Вычет — ПОЛНОЕ ИМЯ, а не шаблон: широкий запрет по слову остаётся на месте, из него
// вынимается ровно одно проверенное имя. И вычет НЕ отменяет второй гейт: имя обязано
// быть ещё и в `writeAllowed`. Нет данных — нет ни вычетов, ни мутаций: самый строгий контур.

// Чтение у любого сервера: List*/Get* и list_*/get_* — оба стиля именования методов.
//
// Имя разбирается РАЗБИЕНИЕМ по `__`, а не регэкспом с ленивым `\S+?`: тот брал за границу
// сервера первое же попавшееся `__get`, и `mcp__sync__get__CreateReport` (сервер `sync__get`,
// метод — мутация) считался чтением и проходил (проход 6 ревью, проверено прогоном).
//
// Больше трёх частей — имя неоднозначное: где кончается сервер и начинается метод, знает
// только площадка. Такое имя чтением НЕ считается и уходит в allowlist мутаций, то есть
// по умолчанию блокируется. Fail-closed здесь дешевле: ложный отказ на экзотическом имени
// стоит одной записи в allowlist, пропуск — неизвестной мутации.
function mcpReadCall(toolName) {
    const parts = toolName.split('__');
    return parts.length === 3 && /^(list|get)/i.test(parts[2]);
}

/** Разрешён ли MCP-вызов. Порядок важен: «никогда» перекрывает чтение. */
function mcpAllowed(toolName, mcp = emptyData().mcp) {
    if (mcp.neverExceptions.has(toolName)) return mcp.writeAllowed.has(toolName);
    if (MCP_NEVER_RE.test(toolName)) return false;
    if (mcpReadCall(toolName)) return true;
    return mcp.writeAllowed.has(toolName);
}

const ALLOWED = { blocked: false, reason: null };

/** Инструменты, у которых в аргументах — путь к файлу. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Данные контура (`DATA_PATH`) в пути вызова — с любым началом и разделителем.
const DATA_PATH_RE = /(^|[\\/])\.claude[\\/]ralph[\\/]hooks\.json$/;

// Имя данных отдельным словом: `hooks.json.example` и `myhooks.json` — другие файлы.
const DATA_NAME_RE = /(?:^|[^\w.-])hooks\.json(?![\w.-])/;
// Перенаправление в файл данных: `> hooks.json`, `>> .claude/ralph/hooks.json`, `>| …`
// (запись в обход noclobber; токенизатор режет по `|`, и путь становится именем команды).
const DATA_REDIRECT_RE = />(?:>|\|)?\s*["']?[^\s"'|;&<>]*\bhooks\.json(?![\w.-])/;
// Интерпретатор пишет файл из текста программы — имя в нём и есть адрес записи.
const INTERPRETERS_RE = /^(?:python[\d.]*|node|perl|ruby|deno|bun)$/;
// Команды, которые файл только читают: им путь данных в аргументах не страшен.
const DATA_READERS = new Set([
    'cat',
    'head',
    'tail',
    'less',
    'more',
    'wc',
    'grep',
    'rg',
    'diff',
    'jq',
    'ls',
    'stat',
    'file',
    'sha256sum',
    'md5sum',
]);
// Подкоманды git, которые с путём в аргументах файл данных в дереве не меняют: `add`
// пишет индекс, `commit -m` несёт имя текстом сообщения. Список разрешённых, а не
// запрещённых (#133): прежний перечень пишущих пропускал `stash push --` и любую
// подкоманду, которую не назвал, — неизвестная подкоманда теперь блок.
const GIT_DATA_SAFE = new Set([
    'diff',
    'show',
    'log',
    'status',
    'blame',
    'grep',
    'ls-files',
    'ls-tree',
    'cat-file',
    'add',
    'commit',
]);
// Глобальные опции git со значением ОТДЕЛЬНЫМ аргументом: без их пропуска подкомандой
// считалось значение — `git -C .claude/ralph checkout … hooks.json` проходил (#133).
const GIT_VALUE_OPTIONS = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
]);

/** Подкоманда git: первый аргумент вне глобальных опций и значений тех, что их берут. */
function gitSubcommand(args) {
    for (let i = 0; i < args.length; i += 1) {
        if (GIT_VALUE_OPTIONS.has(args[i])) {
            i += 1;
            continue;
        }
        if (!args[i].startsWith('-')) return args[i];
    }
    return undefined;
}

// Глобальные опции git, которые меняют исполняемое: `-c core.pager=…`/`diff.external=…`
// и `--config-env` запускают произвольную команду при разрешённой подкоманде,
// `--exec-path` подменяет саму подкоманду (ревью Фазы 13).
const GIT_EXEC_OPTIONS_RE = /^(?:-c|--config-env(?:=.*)?|--exec-path(?:=.*)?)$/;
// Опции разрешённых подкоманд, которые пишут файл или запускают программу:
// `diff`/`log`/`show --output=<файл>`, `grep -O<команда>` (ревью Фазы 13).
const GIT_WRITE_OPTIONS_RE = /^(?:--output(?:=.*)?|-O.*|--open-files-in-pager(?:=.*)?)$/;
// `grep` разбирает опции через parse-options: короткие флаги склеиваются (`-iO<команда>`),
// а длинная опция принимается сокращением (`--open=<команда>`). Точная форма выше их не
// видела, а `-O` передаёт команде найденные файлы — `-iOtee` писал в сам файл данных
// (ревью Фазы 13, проход 2). У `diff`/`log` длинные опции не сокращаются — проверено на git.
const GIT_GREP_CLUSTER_O_RE = /^-[^-]*O/;
const GIT_GREP_OPEN = '--open-files-in-pager';
const GIT_GREP_OPEN_MIN = '--op'.length;

/** Опция `grep`, которая запускает программу: склеенный `-…O…` или сокращение `--op…`. */
function gitGrepOpensPager(arg) {
    if (GIT_GREP_CLUSTER_O_RE.test(arg)) return true;
    const name = arg.split('=')[0];
    return name.length >= GIT_GREP_OPEN_MIN && GIT_GREP_OPEN.startsWith(name);
}

// Окружение, которым git исполняет чужое при разрешённой подкоманде: `GIT_EXTERNAL_DIFF`
// получает путь первым аргументом (`tee` пишет в файл), `GIT_PAGER`, `GIT_CONFIG_*` — тот
// же `-c`, `GIT_EXEC_PATH` — подмена подкоманды. Присваивание видно префиксом, через `env`,
// `export` и `declare -x` в той же строке; вход тот же, что у `-c diff.external` (ревью
// Фазы 13, проход 2).
const GIT_ENV_ASSIGNMENT_RE = /^GIT_\w*=/;
// Встроенные оболочки, которые экспортируют присваивание аргументом: `declare -x X=…`
// разбор кладёт в аргументы, а не в присваивания, и `export` в той же форме блокировался,
// а `declare -x` — нет (ревью Фазы 13, проход 2).
const DECLARING_BUILTINS = new Set(['declare', 'typeset', 'readonly', 'local']);
// Переменные, значение которых git исполняет программой. `PAGER` git берёт, когда своих
// пейджеров нет, — та же программа, что `GIT_PAGER`.
const GIT_EXEC_ENV_RE = /^(?:GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|GIT_CONFIG\w*|GIT_EXEC_PATH)$/;
// Пейджер, который ничего не пишет: `GIT_PAGER=cat git log` и `-c core.pager=less` —
// обычные шаги петли, а не вход. Внешний diff и подмена конфига таких значений не имеют.
const GIT_PAGER_KEY_RE = /^(?:GIT_PAGER|PAGER|core\.pager|pager\..+)$/i;
const HARMLESS_PAGER_RE = /^(?:|cat|less|more|true|false)(?:\s+-[\w-]+)*$/;

/** Присваивания строки: перед командой, через `env`/`export` и аргументом `declare -x`. */
function assignmentsOf(calls) {
    const out = [];
    for (const call of calls) {
        out.push(...call.assignments);
        if (DECLARING_BUILTINS.has(call.name)) {
            out.push(...argValues(call).filter((arg) => /^\w+=/.test(arg)));
        }
    }
    return out;
}

/** Ключ `name=value` исполняет программу: исполняющий ключ без безобидного пейджера. */
function execSetting(name, value, keyRe) {
    if (!keyRe.test(name)) return false;
    return !(GIT_PAGER_KEY_RE.test(name) && HARMLESS_PAGER_RE.test(value.trim()));
}

/**
 * Исполняющий вход git независимо от пути данных в строке. Внешний diff получает путь от
 * корня репозитория и исполняется из корня: `GIT_EXTERNAL_DIFF=tee git diff HEAD~1`
 * обнулял файл данных, если тот менялся в диапазоне, — пути в строке нет вовсе (проверено
 * на git 2.43, ревью Фазы 13, проход 2). Поэтому в сессии петли такой вход — блок сам по
 * себе, как запись исполняющего ключа командой `git config`.
 */
function gitExecInput(calls) {
    for (const assignment of assignmentsOf(calls)) {
        const at = assignment.indexOf('=');
        const name = assignment.slice(0, at);
        if (execSetting(name, assignment.slice(at + 1), GIT_EXEC_ENV_RE)) return true;
    }
    for (const call of calls) {
        if (call.name !== 'git') continue;
        const args = argValues(call);
        // Только глобальные опции, до подкоманды: `git log -c` — формат диффа.
        for (let i = 0; i < args.length && args[i].startsWith('-'); i += 1) {
            const option = args[i];
            if (option.startsWith('--exec-path=')) return true;
            let setting = null;
            if (option === '-c' || option === '--config-env') setting = args[i + 1] ?? '';
            else if (option.startsWith('--config-env=')) {
                setting = option.slice('--config-env='.length);
            }
            if (GIT_VALUE_OPTIONS.has(option)) i += 1;
            if (setting === null) continue;
            const at = setting.indexOf('=');
            const key = at < 0 ? setting : setting.slice(0, at);
            // У `--config-env` значение — имя переменной, его текст разбор не видит.
            const value = option === '-c' && at >= 0 ? setting.slice(at + 1) : 'unknown';
            if (execSetting(key, value, GIT_EXEC_CONFIG_KEY_RE)) return true;
        }
    }
    return false;
}

// Ключи конфига, которыми разрешённые подкоманды запускают программу: внешний diff и
// textconv, пейджер, fsmonitor (`status`/`diff`), хуки и редактор (`commit`), фильтры
// (`add`), подпись, а также include — он подтягивает такой ключ из другого файла.
// `git config diff.external tee` пути данных не содержит, а следующий обычный
// `git diff -- …hooks.json` пишет файл, поэтому запись такого ключа в сессии петли —
// блок сама по себе (ревью Фазы 13, проход 2).
const GIT_EXEC_CONFIG_KEY_RE =
    /^(?:diff\.external|diff\..+\.(?:command|textconv)|core\.(?:pager|fsmonitor|hookspath|editor)|pager\..+|sequence\.editor|filter\..+\.(?:clean|smudge|process)|gpg\.(?:.+\.)?program|include\.path|includeif\..+\.path)$/i;
// Чтение конфига ключ не меняет: `--get…`, `--list`/`-l` и подкоманды `get`/`list` (2.46+),
// а также голое `git config <ключ>` — у записи после ключа идёт значение.
const GIT_CONFIG_READ_RE = /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|get|list)$/;

/** `git config`, который записывает ключ, исполняющий программу при чтении дерева. */
function gitConfigSetsExec(args) {
    if (gitSubcommand(args) !== 'config') return false;
    if (args.some((arg) => GIT_CONFIG_READ_RE.test(arg))) return false;
    const at = args.findIndex((arg) => GIT_EXEC_CONFIG_KEY_RE.test(arg));
    // Ключ последним позиционным — чтение; значение опции вроде `--file x` перед ключом
    // разбор не различает, и ошибка тут в сторону блока.
    return at >= 0 && (at < args.length - 1 || args.includes('set'));
}

/** Глобальные опции git до подкоманды — с их значениями отдельным аргументом. */
function gitGlobalOptions(args) {
    const options = [];
    for (let i = 0; i < args.length; i += 1) {
        if (!args[i].startsWith('-')) break;
        options.push(args[i]);
        if (GIT_VALUE_OPTIONS.has(args[i])) i += 1;
    }
    return options;
}

/**
 * Вызов git с путём данных, который их не меняет: разрешённая подкоманда без опций,
 * пишущих файл или исполняющих команду. Список подкоманд без разбора опций был той же
 * дырой другим входом — `git diff --output=…/hooks.json` проходил как чтение.
 */
function gitLeavesDataAlone(args) {
    const subcommand = gitSubcommand(args);
    if (!GIT_DATA_SAFE.has(subcommand)) return false;
    if (gitGlobalOptions(args).some((arg) => GIT_EXEC_OPTIONS_RE.test(arg))) return false;
    if (subcommand === 'grep' && args.some(gitGrepOpensPager)) return false;
    return !args.some((arg) => GIT_WRITE_OPTIONS_RE.test(arg));
}

/** Путь данных среди аргументов: базовое имя ровно `hooks.json` (и `cd …` перед ним). */
function dataPathArg(args) {
    return args.some((arg) => basenameOf(arg) === 'hooks.json');
}

// Исход забора без файла данных в строке: исполняющий вход git. Причина у него своя —
// «правка hooks.json» для `git config core.hooksPath …` называла файл, которого в вызове
// нет (ревью Фазы 13, проход 2).
const GIT_EXEC_INPUT = 'git-exec';

/**
 * Вызов оболочки, который может ПИСАТЬ файл данных, а не только назвать или прочитать:
 * `'hooks.json'` — запись по имени, `GIT_EXEC_INPUT` — git, исполняющий чужую программу.
 */
function shellWritesContourData(cmd, calls) {
    if (DATA_REDIRECT_RE.test(cmd)) return 'hooks.json';
    if (gitExecInput(calls)) return GIT_EXEC_INPUT;
    // `GIT_*=` где угодно в строке: префиксом, через `env`, `export` или `declare -x`
    // прежним сегментом — у git с путём данных разрешённой подкоманды тогда нет.
    const gitEnvSet = assignmentsOf(calls).some((a) => GIT_ENV_ASSIGNMENT_RE.test(a));
    for (const call of calls) {
        const args = argValues(call);
        if (INTERPRETERS_RE.test(call.name)) {
            if (args.some((arg) => DATA_NAME_RE.test(arg))) return 'hooks.json';
            continue;
        }
        if (call.name === 'git' && gitConfigSetsExec(args)) return GIT_EXEC_INPUT;
        if (!dataPathArg(args) || DATA_READERS.has(call.name)) continue;
        if (call.name === 'git' && !gitEnvSet && gitLeavesDataAlone(args)) continue;
        return 'hooks.json';
    }
    return null;
}

/**
 * Правка данных контура из сессии петли (#99, ревью Фазы 11). Данные читаются из дерева,
 * которое правит сессия, на каждом вызове: дописанная в `writeAllowed` мутация действовала
 * бы со следующего вызова, задолго до ship человека на мердже. Файловые инструменты
 * записи сверяются по пути. Команда оболочки — по ВЫЗОВАМ, а не по упоминанию имени:
 * забор на любое `hooks.json` в строке блокировал чтение (`cat`, `git diff --`), соседний
 * `hooks.json.example` и сообщение коммита — обычные шаги петли, которая правит примеры
 * и доки про этот файл. Блок — перенаправление в файл, интерпретатор с именем в тексте
 * программы и любая команда вне читающих с аргументом базового имени `hooks.json`: так
 * `cd .claude/ralph && sed -i … hooks.json` пути не содержит, но остаётся записью.
 * Это забор по тексту, а не доказательство (путь, собранный по частям, он не видит), и
 * сказано это в докблоке `consumer-data.cjs`. Сессия человека правит данные как раньше.
 *
 * Исполняющий вход git — блок и без пути данных в строке: внешний diff, пейджер,
 * `GIT_CONFIG_*`, `-c`/`--config-env` с исполняющим ключом, `--exec-path=` и запись такого
 * ключа командой `git config`. Внешняя программа получает пути дерева сама, и
 * `GIT_EXTERNAL_DIFF=tee git diff HEAD~1` писал файл данных, не называя его.
 *
 * Предел забора у git назван вслух: он видит исполняющий вход, только поданный в той же
 * строке. Конфиг, правленный файлом мимо `git config` (`.git/config`, `~/.gitconfig`, файл
 * из `include.path`), хуки в `.git/hooks`, окружение, унаследованное сессией, и
 * присваивание, собранное по частям (`eval`, подстановка), ему не видны — класс
 * «разрешённая подкоманда исполняет чужое» закрыт по названным входам, а не целиком.
 */
function touchesContourData(toolName, input) {
    if (WRITE_TOOLS.has(toolName)) {
        const paths = [input.file_path, input.notebook_path, input.path];
        if (Array.isArray(input.edits)) {
            for (const edit of input.edits) if (edit) paths.push(edit.file_path);
        }
        return paths.find((v) => typeof v === 'string' && DATA_PATH_RE.test(v)) || null;
    }
    if (toolName === 'Bash') {
        const cmd = typeof input.command === 'string' ? input.command : '';
        return shellWritesContourData(cmd, shellCalls(cmd));
    }
    return null;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep']);

/**
 * Решение по вызову инструмента.
 *
 * @param {string} toolName — имя инструмента из PreToolUse
 * @param {Record<string, unknown>} toolInput — его аргументы
 * @returns {{ blocked: boolean, reason: string | null }}
 */
/**
 * `options.contour` — данные контура потребителя (`consumer-data.cjs`); хук передаёт
 * загруженные, без них контур пустой — самый строгий. `options.loop` — сессия петли: тогда
 * данные контура сессии не правятся. Значение — булево или функция: хук узнаёт петлю ещё
 * и переходным признаком по транскрипту, а читать транскрипт на каждом вызове незачем —
 * функция зовётся, только когда вызов трогает данные.
 *
 * Остальное в `options` — подмена окружения ТОЛЬКО для тестов правила про kill (#196):
 * таблица процессов, pid хука и дерево сессии. Хук их не передаёт и читает живой `/proc`.
 */
function decide(toolName, toolInput, options = {}) {
    const input = toolInput || {};

    const mcp = (options.contour || emptyData()).mcp;
    if (MCP_TOOL_RE.test(toolName) && !mcpAllowed(toolName, mcp)) {
        // Пустой контур и имя вне непустого — разные советы: при пустых данных не
        // разрешена ни одна мутация, и обещание «мутаций рабочего цикла» было бы ложью.
        const contourText =
            mcp.writeAllowed.size === 0
                ? 'контур MCP-мутаций проекта пуст — нет данных `.claude/ralph/hooks.json` ' +
                  'или в них нет mcp.writeAllowed, — разрешено только чтение (List*/Get*, ' +
                  'кроме секретов). Мутации рабочего цикла проект заявляет в mcp.writeAllowed ' +
                  'этого файла отдельным PR.'
                : 'его нет в mcp.writeAllowed данных `.claude/ralph/hooks.json` (или он под ' +
                  'запретом ядра по слову). Разрешены чтение (List*/Get*, кроме секретов) и ' +
                  'заявленные там мутации; нужен новый — добавляй его туда отдельным PR с ' +
                  'обоснованием.';
        return {
            blocked: true,
            reason: `Инструмент ${toolName} не в allowlist MCP: ${contourText}`,
        };
    }

    const contourData = touchesContourData(toolName, input);
    const inLoop = () => (typeof options.loop === 'function' ? options.loop() : !!options.loop);
    if (contourData === GIT_EXEC_INPUT && inLoop()) {
        return {
            blocked: true,
            reason:
                'Вызов git с исполняющим входом из сессии петли заблокирован: внешний diff, ' +
                'пейджер, `GIT_CONFIG_*`, `-c`/`--config-env` с исполняющим ключом, ' +
                '`--exec-path=` или запись такого ключа через `git config` запускают ' +
                'программу, которая получает пути дерева и пишет файлы мимо барьера — в том ' +
                'числе данные контура хуков. Читай git без них (`--no-pager`, `--no-ext-diff`, ' +
                '`GIT_PAGER=cat`); нужен такой вызов — оставь намерение с обоснованием.',
        };
    }
    if (contourData && inLoop()) {
        return {
            blocked: true,
            reason:
                `Правка данных контура хуков (${contourData}) из сессии петли заблокирована: ` +
                'они решают, какие MCP-мутации и скиллы требует барьер, и действовали бы со ' +
                'следующего вызова — раньше ship человека на мердже. Нужна правка — оставь ' +
                'намерение с обоснованием, файл правит человек.',
        };
    }

    // Все файловые инструменты, а не три: `MultiEdit` и `NotebookEdit` пишут файл тем же
    // путём, а `Grep` с `output_mode: content` ЧИТАЕТ его содержимое (ревью Kimi) — для
    // секрета это тот же Read. `glob` у Grep — тоже адрес файла: `glob: ".env"`.
    if (FILE_TOOLS.has(toolName)) {
        const filePath = [input.file_path, input.notebook_path, input.path, input.glob]
            .filter((v) => typeof v === 'string')
            .find((v) => ENV_FILE_RE.test(v));
        if (filePath) {
            return {
                blocked: true,
                reason:
                    `Доступ к ${filePath} заблокирован: файлы .env содержат секреты. ` +
                    'Используй .env.example для структуры переменных.',
            };
        }
        return ALLOWED;
    }

    if (toolName === 'Bash') {
        const cmd = typeof input.command === 'string' ? input.command : '';
        // Все правила ниже, кроме двух текстовых, судят СПИСОК ВЫЗОВОВ, а не строку.
        const calls = shellCalls(cmd);

        // Упоминание .env блокируем только вместе с командой, которая его читает
        // или отправляет наружу: иначе запрет накрыл бы и разговор о файле.
        if (CMD_ENV_RE.test(cmd) && SECRET_READER_RE.test(cmd)) {
            return {
                blocked: true,
                reason: 'Команда заблокирована: чтение/копирование .env файлов запрещено (секреты).',
            };
        }
        // То же по СПИСКУ ВЫЗОВОВ: любая команда вне нечитающих с путём env-файла в
        // аргументах. Текстовое правило выше остаётся — оно видит перенаправление
        // (`< .env`) и подстановки, которых в аргументах вызова нет.
        const envReader = readsEnvFile(calls);
        if (envReader) {
            return {
                blocked: true,
                reason:
                    `Команда заблокирована: ${envReader} получает env-файл аргументом, а его ` +
                    'содержимое — секреты. Структуру переменных смотри в .env.example.',
            };
        }

        // `--no-verify` отключает git-хуки, то есть и проверку сообщения коммита —
        // а её обход стоит неснимаемой связи с чужой карточкой. Правило репозитория
        // («--no-verify не используется») до сих пор держалось на дисциплине; теперь
        // на барьере. Упал хук — правится причина.
        // Правило смотрит ВЫЗОВ, как и соседние: разговор о команде вызовом не является,
        // а `git commit` внутри `sh -c` — является (ревью, проход 5: здесь оставалась
        // регулярка по строке, и журнал утверждал обратное).
        if (skipsGitHooks(calls)) {
            return {
                blocked: true,
                reason:
                    'git commit --no-verify запрещён: он отключает проверку сообщения ' +
                    'коммита, а её обход стоит неснимаемой связи PR с чужой карточкой. ' +
                    'Упал хук — правь причину, а не выключай хук.',
            };
        }

        // Манифест правится ФАЙЛОМ, а не командой (#131).
        //
        // 20.08.2026 сессии понадобился SHA второй копии ядра. Прямой `git -C <чужое дерево>`
        // тогда упирался в список разрешений (сессии ещё шли не под bypass; сегодня он
        // не закрыт ничем — это отдельная тема, не эта), и она обошла его так: `npm pkg set
        // scripts.tmp="node -e …"` → `npm run tmp` → `npm pkg delete scripts.tmp`. Кода
        // в дифф не попало ни строки, а исполнилось всё.
        //
        // Барьер узкий намеренно: он закрывает не «выполнение произвольного кода» —
        // под bypassPermissions его закрыть нечем, любая команда и так исполнится, —
        // а его НЕВИДИМОСТЬ. Всё, что исполняется, обязано лежать в диффе: тогда его
        // сторожат ревью и гейт. Побочно снимается гонка:
        // упади сессия между `set` и `delete`, временный скрипт уехал бы в коммит.
        //
        // Правило смотрит на ВЫЗОВ, а не на строку: `rg -n "npm pkg set"` ищет по
        // каталогу, а не мутирует манифест.
        if (mutatesManifest(calls)) {
            return {
                blocked: true,
                reason:
                    'Правка package.json из оболочки запрещена: она не попадает в дифф, ' +
                    'а значит мимо ревью и гейта. Нужен новый скрипт — правь файл через ' +
                    'Edit/Write. Нужен разовый расчёт — считай его прямо в команде.',
            };
        }

        // Дальше правила смотрят на СПИСОК ВЫЗОВОВ (`shell-calls.cjs`): упоминание команды
        // в тексте вызовом не является, а вложенные вызовы из `sh -c`, подстановки и
        // heredoc'а, который читает оболочка, в список входят (#173).
        const rawAddress = rawAddressTarget(calls);
        if (rawAddress) {
            return {
                blocked: true,
                reason:
                    `Сетевой вызов на голый адрес ${rawAddress} заблокирован. У адреса без ` +
                    'имени нечего проверить: ни домена, ни владельца. Ходи по имени хоста, ' +
                    'а если адрес действительно нужен — поднимай его сам и зови по localhost.',
            };
        }
        const destructive = destructiveCall(calls);
        if (destructive) {
            return { blocked: true, reason: `Команда заблокирована: ${destructive}` };
        }

        // Сессия петли идёт в оболочке ХОСТА, где рядом крутится прод (#299): она не
        // ревьюер с ограниченным доступом, а полноценный шелл, и то, что для CI —
        // «локальная проверка», для хоста — боевая служба. Правило смотрит на ВЫЗОВ,
        // как соседние: `git log --grep 'systemctl stop caddy'` вызовом не является.
        const hostService = touchesHostService(calls);
        if (hostService) {
            return { blocked: true, reason: hostService };
        }

        // Цель `kill` без имени в тексте (`kill $p`, `xargs kill`, `pkill`, `fuser -k`)
        // барьер служб не видит — ей нечем совпасть с перечнем. Инцидент 22.09.2026:
        // цикл по списку слушателей хоста снял Caddy, docker-proxy и privoxy (#196).
        const foreignKill = killsForeignProcess(calls, options);
        if (foreignKill) {
            return { blocked: true, reason: foreignKill };
        }
    }

    return ALLOWED;
}

module.exports = {
    decide,
    ENV_FILE_RE,
    CMD_ENV_RE,
    mcpAllowed,
};

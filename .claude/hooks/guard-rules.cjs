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
const fs = require('node:fs');
const path = require('node:path');

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

/**
 * Разрешён ли MCP-вызов по эффектам политики (`mcp.tools`, #185). Его зовут guard на событии
 * (`mcpEventAllowed`, когда данные заявили эффекты — `toolsDeclared`) и мигратор
 * (`mcp-effects.cjs`), доказывая, что мигрированные данные решают так же, как префикс.
 *
 * Нет записи — эффект `unknown`, блок: инструмент, о котором политика молчит, не читается
 * по имени. Запрет ядра по слову остаётся сильнее эффекта, вычет — по полному имени и только
 * для заявленной мутации, как у `mcpAllowed`.
 */
function mcpAllowedByEffect(toolName, mcp = emptyData().mcp) {
    const effect = mcp.tools.get(toolName);
    if (effect === undefined) return false;
    if (mcp.neverExceptions.has(toolName)) return effect === 'write';
    return !MCP_NEVER_RE.test(toolName);
}

const ALLOWED = { blocked: false, reason: null };

/** Инструменты, у которых в аргументах — путь к файлу. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Данные контура (`DATA_PATH`) в пути вызова — с любым началом и разделителем.
const DATA_PATH_RE = /(^|[\\/])\.claude[\\/]ralph[\\/]hooks\.json$/;

// Каталог-предок данных контура строкой: `.claude`, `.claude/ralph`, с хвостовыми `/`.
// Перенос или удаление такого каталога уносит данные, не называя файла (#187).
const DATA_ANCESTOR_RE = /(^|[\\/])\.claude(?:[\\/]ralph)?[\\/]*$/;
// Путь из одних `.` и `..`: каталог вызова или выше. Строкой не узнать, нет ли в нём данных,
// и забор без файловой системы считает его предком данных.
const CALL_DIR_RE = /^\.\.?(?:[\\/]+\.\.?)*[\\/]*$/;
// Команды, которые переносят, удаляют или заменяют путь целиком. Источник и назначение у
// них не различаются: `cp -r .claude/ralph /tmp/x` — копия наружу, а не правка, но
// разбор `-t`/`--target-directory` у каждой утилиты свой, и ошибка в нём — дыра, а
// лишний отказ на копии каталога хуков петле ничего не стоит.
const TREE_MOVERS = new Set(['mv', 'rm', 'rmdir', 'cp', 'rsync', 'ln', 'install', 'unlink']);
// Действия `find`, которые удаляют найденное или пишут файл: `-delete` уносит каталог данных
// так же, как `rm`, `-fprint` пишет в файл по имени.
const FIND_WRITE_RE = /^-(?:delete|fprint0?|fprintf|fls)$/;
// Действия `find`, которые исполняют над найденным программу: `-exec rm {} +` уносит каталог
// данных, а вызова `rm` разбор в строке не видит. Читающая программа из `DATA_READERS`
// заменой не считается: `find . -exec grep -l foo {} +` — частый приём только для чтения, и
// отказ на нём с причиной про данные контура уводил разбор не туда (ревью 16c, проход 1).
// Судится КАЖДОЕ действие: `-exec cat {} + -exec cp x {} +` и `-exec cat {} + -delete` —
// замена; разбор видит их, потому что `{}` больше не режет аргументы `find` (проход 2).
const FIND_EXEC_RE = /^-(?:exec|execdir|ok|okdir)$/;
// Хвосты пути данных по сегментам: каталог-предок или сам файл. Шаблон оболочки в аргументе
// судится по ним посегментно — строкой `.c?aude` не совпадает ни с одним регексом пути.
const DATA_TAILS = [['.claude'], ['.claude', 'ralph'], ['.claude', 'ralph', 'hooks.json']];
const GLOB_CHARS_RE = /[*?[]/;

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
    return args[gitSubcommandAt(args)];
}

/** Индекс подкоманды git в аргументах; нет подкоманды — длина аргументов. */
function gitSubcommandAt(args) {
    for (let i = 0; i < args.length; i += 1) {
        if (GIT_VALUE_OPTIONS.has(args[i])) {
            i += 1;
            continue;
        }
        if (!args[i].startsWith('-')) return i;
    }
    return args.length;
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

/** `tar` в режиме извлечения: `--extract`/`--get`, `-x…` или буква `x` в слове режима первым. */
function tarExtracts(args) {
    return args.some(
        (arg, i) =>
            arg === '--extract' ||
            arg === '--get' ||
            (/^-[A-Za-z]+$/.test(arg) && arg.includes('x')) ||
            (i === 0 && /^[A-Za-z]+$/.test(arg) && arg.includes('x')),
    );
}

/** `find`, у которого хоть одно действие удаляет, пишет файл или зовёт программу вне читающих. */
function findReplacesPaths(args) {
    return args.some(
        (arg, i) =>
            FIND_WRITE_RE.test(arg) || (FIND_EXEC_RE.test(arg) && !DATA_READERS.has(args[i + 1])),
    );
}

// Аргумент git, который git читает pathspec'ом шире, чем его прочла бы оболочка: в pathspec
// `*` проходит и `/`, и ведущую точку, а ведущее `:` — магия (`:/` — корень дерева,
// `:(top)`, `:(glob)`, `:!`). `git checkout <ref> -- '*'` и `-- ':/'` возвращали из истории
// старый `.claude/ralph/hooks.json` мимо посегментного разбора оболочки (ревью 16c,
// проход 1, проверено на живом git). Раскрывать pathspec по правилам git барьер не берётся:
// база зависит от `-C`, `cd` и подкаталога вызова, — такой аргумент у git вне разрешённых
// подкоманд в петле считается совпавшим с данными, как и список путей из файла.
const GIT_PATHSPEC_WIDE_RE = /^:|[*?[]/;
const GIT_PATHSPEC_FILE_RE = /^--pathspec-from-file(?:=|$)/;
// Глобальные опции, с которыми git сравнивает pathspec без учёта регистра или как шаблон:
// `git --icase-pathspecs checkout HEAD~1 -- .CLAUDE` вернул старый контур из истории, а
// `DATA_ANCESTOR_RE` регистрозависим (ревью 16c, проход 2). Вызов с ними — совпадение целиком.
const GIT_PATHSPEC_MODE_RE = /^--(?:icase|glob)-pathspecs$/;
// Окружение, которым git меняет чтение pathspec или его базу: `GIT_ICASE_PATHSPECS=1` — то
// же, что `--icase-pathspecs` (ревью 16c, проход 3, проверено на живом git), `GIT_DIR`,
// `GIT_WORK_TREE` — то же, что `-C`. Перечень опасных был бы fail-open к следующей такой
// переменной, поэтому у git вне разрешённых подкоманд в петле совпадение с данными — любое
// присваивание `GIT_*` в строке, кроме названных ниже: они имени пути не касаются, а
// `GIT_EDITOR=true git rebase --continue` и автор коммита — обычные шаги петли.
const GIT_PATH_NEUTRAL_ENV_RE =
    /^GIT_(?:AUTHOR_\w+|COMMITTER_\w+|EDITOR|SEQUENCE_EDITOR|TERMINAL_PROMPT|PAGER|TRACE\w*)=/;
// Шаблон и магия судятся везде, где git может прочесть pathspec: после `--` и позиционным
// аргументом любой подкоманды, кроме известных ниже — у них позиционный аргумент шаблон
// `--list`, refspec (`+refs/heads/*:…`, `:old-branch`) или ревизия, и отказ на нём с причиной
// про данные контура уводил разбор не туда (ревью 16c, проход 2). Список — тех, у кого шаблон
// пропускается, а не тех, у кого судится: алиас (`git co HEAD~1 '*hooks.json'`) и
// незнакомая подкоманда в перечень не попадают никогда, и прежний закрытый список
// pathspec-подкоманд пропускал их (проход 3). Литеральный предок данных судится везде.
const GIT_NON_PATHSPEC_SUBCOMMANDS = new Set([
    'branch',
    'tag',
    'fetch',
    'push',
    'pull',
    'merge',
    'rebase',
    'remote',
    'switch',
    'cherry-pick',
    'revert',
    'config',
    'for-each-ref',
    'show-ref',
    'rev-parse',
    'describe',
    'reflog',
    'notes',
]);
// Подкоманды, у которых `-m`/`-F` берут значение — текст или файл сообщения. У `checkout` и
// `restore` `-m` — флаг `--merge` без значения, и пропуск следующего аргумента выводил
// pathspec из суда: `git checkout -m '*'` возвращал файл из индекса (проход 3).
const GIT_MESSAGE_SUBCOMMANDS = new Set(['commit', 'merge', 'tag', 'stash', 'notes']);
const GIT_MESSAGE_LONG = new Set(['--message', '--file']);
// Склейка коротких флагов с `m`/`F` последней буквой берёт значение следующим аргументом:
// `git stash push -qm 'wip?'`.
const GIT_MESSAGE_SHORT_RE = /^-[A-Za-z]*[mF]$/;

/** Аргумент git — опция, значение которой (следующий аргумент) текст сообщения, а не путь. */
function gitMessageOption(subcommand, arg) {
    if (!GIT_MESSAGE_SUBCOMMANDS.has(subcommand)) return false;
    return GIT_MESSAGE_LONG.has(arg) || GIT_MESSAGE_SHORT_RE.test(arg);
}

/**
 * Аргумент вызова git вне разрешённых подкоманд, который может назвать данные контура.
 * `assignments` — присваивания всей строки (`assignmentsOf`): окружение git видно только там.
 */
function gitArgHittingData(args, assignments = []) {
    const mode = gitGlobalOptions(args).find((arg) => GIT_PATHSPEC_MODE_RE.test(arg));
    if (mode) return mode;
    const env = assignments.find(
        (a) => GIT_ENV_ASSIGNMENT_RE.test(a) && !GIT_PATH_NEUTRAL_ENV_RE.test(a),
    );
    if (env) return env;
    const literal = args.find(
        (arg) => DATA_ANCESTOR_RE.test(arg) || GIT_PATHSPEC_FILE_RE.test(arg),
    );
    if (literal) return literal;
    const at = gitSubcommandAt(args);
    const subcommand = args[at];
    const takesPathspec = !GIT_NON_PATHSPEC_SUBCOMMANDS.has(subcommand);
    for (let i = at + 1; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--') return args.slice(i + 1).find((x) => GIT_PATHSPEC_WIDE_RE.test(x));
        if (gitMessageOption(subcommand, arg)) {
            i += 1;
            continue;
        }
        if (arg.startsWith('-')) continue;
        if (takesPathspec && GIT_PATHSPEC_WIDE_RE.test(arg)) return arg;
    }
    return undefined;
}

/**
 * Вызов, который заменяет, переносит или удаляет пути своих аргументов целиком (ревью 16c):
 * переносящие команды, git вне разрешённых подкоманд — `checkout <ref> -- .claude`,
 * `restore --source=<rev> .claude`, `stash push -- .claude`, `mv`, `archive`, — `find` с
 * удалением или командой и `tar` с извлечением. Опасны прежде всего checkout и restore: они
 * возвращают из истории прежний, более мягкий контур. Путь-КАТАЛОГ у них прежде не судился:
 * git проверялся только по базовому имени `hooks.json`, предок — только у `TREE_MOVERS`.
 */
function replacesPaths(name, args, gitEnvSet) {
    if (TREE_MOVERS.has(name)) return true;
    if (name === 'git') return gitEnvSet || !gitLeavesDataAlone(args);
    if (name === 'find') return findReplacesPaths(args);
    if (name === 'tar') return tarExtracts(args);
    return false;
}

/**
 * Может ли шаблон оболочки в аргументе раскрыться в путь данных или их предка: хвост
 * шаблона посегментно против `DATA_TAILS`. Ведущую точку имени оболочка раскрывает только
 * явной точкой в сегменте (без `dotglob`), поэтому `rm -rf dist/*` предка не задевает, а
 * `mv .c?aude bak` и `cp -r evil/. .c*` — задевают. Неразобранный сегмент и `**` — совпадение.
 */
function globMayHitData(arg) {
    if (!GLOB_CHARS_RE.test(arg)) return false;
    const variants = expandBraces(arg);
    if (variants === null) return true;
    return variants.some((variant) => {
        const segments = variant.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
        return DATA_TAILS.some((tail) => {
            if (segments.length < tail.length) return false;
            const end = segments.slice(segments.length - tail.length);
            return end.every((segment, i) => segmentMayName(segment, tail[i]));
        });
    });
}

/** Сегмент шаблона оболочки против имени: с правилом ведущей точки, `**` — любое имя. */
function segmentMayName(segment, name) {
    if (!GLOB_CHARS_RE.test(segment)) return segment === name;
    if (segment.includes('**')) return true;
    if (name.startsWith('.') && !segment.startsWith('.')) return false;
    const re = segmentRegExp(segment);
    return re === null || re.test(name);
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
    const assignments = assignmentsOf(calls);
    const gitEnvSet = assignments.some((a) => GIT_ENV_ASSIGNMENT_RE.test(a));
    for (const call of calls) {
        const args = argValues(call);
        if (INTERPRETERS_RE.test(call.name)) {
            if (args.some((arg) => DATA_NAME_RE.test(arg))) return 'hooks.json';
            continue;
        }
        if (call.name === 'git' && gitConfigSetsExec(args)) return GIT_EXEC_INPUT;
        if (replacesPaths(call.name, args, gitEnvSet)) {
            const ancestor =
                call.name === 'git'
                    ? gitArgHittingData(args, assignments)
                    : args.find((arg) => DATA_ANCESTOR_RE.test(arg) || globMayHitData(arg));
            if (ancestor) return ancestor;
            // Каталог вызова строкой: здесь он не известен, а корень дерева содержит данные.
            // Пути вызова — те же, что судит событие: `find` без точки старта обходит `.`,
            // `tar` без `-C` извлекает в каталог вызова (ревью 16c, проход 3).
            const targets =
                call.name === 'git' ? args : replacedTargets(call.name, args, '', null).paths;
            const here = targets.find((arg) => CALL_DIR_RE.test(arg));
            if (here !== undefined) return `${here} (каталог вызова)`;
        }
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
 * Переносящие команды (`mv`, `rm`, `cp`, …) с каталогом данных в аргументах — `.claude`
 * или `.claude/ralph` — тоже правка: каталог уносит файл, не называя его (#187). Так же
 * судятся git вне разрешённых подкоманд (`checkout <ref> -- .claude` возвращает старый
 * контур из истории), `find` с удалением или командой и `tar` с извлечением, а шаблон
 * оболочки в их аргументах — посегментно (`replacesPaths`, `globMayHitData`); у git шаблон
 * и магия pathspec — совпадение целиком (`gitArgHittingData`): git читает их шире оболочки. На событии
 * их аргументы ещё и разрешаются по файловой системе (`moverTouchesData`): псевдоним
 * каталога симлинком строкой не виден. Смена дерева целиком без пути — `git checkout
 * <ветка>`, `reset --hard`, `merge`, `rebase` — этим забором не судится: путь данных в
 * вызове не назван, и запрет всех переключений остановил бы петлю; предел назван здесь.
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

/** Сессия петли по `options.loop`: булево или функция — общий признак `decide` и `decideEvent`. */
const inLoopOf = (options = {}) =>
    typeof options.loop === 'function' ? options.loop() : !!options.loop;

// Подкоманды git, которые отправляют объекты на удалённый: `send-pack` — низкоуровневый
// пуш, тот же эффект без имени `push`.
const GIT_PUSH_SUBCOMMANDS = new Set(['push', 'send-pack']);
// Исполняемые файлы подкоманд под своими именами (`/usr/lib/git-core/git-push`).
const GIT_PUSH_BINARIES = new Set(['git-push', 'git-send-pack']);
const GIT_ALIAS_KEY_RE = /^alias\./i;

/** Глобальная опция `-c`/`--config-env`, задающая алиас: `git -c alias.p=push p`. */
function gitDefinesAlias(args) {
    for (let i = 0; i < args.length && args[i].startsWith('-'); i += 1) {
        const option = args[i];
        let setting = null;
        if (option === '-c' || option === '--config-env') setting = args[i + 1] ?? '';
        else if (option.startsWith('--config-env=')) setting = option.slice('--config-env='.length);
        if (GIT_VALUE_OPTIONS.has(option)) i += 1;
        if (setting !== null && GIT_ALIAS_KEY_RE.test(setting)) return true;
    }
    return false;
}

/** `git config`, который записывает алиас: `git config alias.p push`. Чтение — не запись. */
function gitConfigSetsAlias(args) {
    if (gitSubcommand(args) !== 'config') return false;
    if (args.some((arg) => GIT_CONFIG_READ_RE.test(arg))) return false;
    const at = args.findIndex((arg) => GIT_ALIAS_KEY_RE.test(arg));
    return at >= 0 && (at < args.length - 1 || args.includes('set'));
}

/** Первый не-опция после подкоманды: `git subtree push …` → `push`. */
function gitSubSubcommand(args) {
    const rest = args.slice(gitSubcommandAt(args) + 1);
    return rest.find((arg) => !arg.startsWith('-'));
}

/** Команда, которую `git submodule foreach` исполнит в каждом подмодуле, — строкой. */
function submoduleForeachCommand(args) {
    const at = gitSubcommandAt(args);
    if (args[at] !== 'submodule') return null;
    const foreach = args.indexOf('foreach', at + 1);
    if (foreach < 0) return null;
    return args
        .slice(foreach + 1)
        .filter((arg) => !arg.startsWith('-'))
        .join(' ');
}

/**
 * Вызов, который пушит или может пушить в обход имени подкоманды (#224, ревью 16c2): `push` и
 * `send-pack` после глобальных опций (`git -C <дерево> push`), исполняемый файл подкоманды по
 * имени (`git-push`), алиас — заданный опцией в той же строке или записанный `git config`, —
 * и подкоманды, которые пушат сами: `git subtree push` и `git submodule foreach <команда>`,
 * чья команда разбирается как строка оболочки. Алиас блокируется целиком, а не только алиас на
 * `push`: значение `!sh -c …` разбор не раскрывает. Предел назван: алиас, записанный в конфиг
 * файлом мимо `git config` (`.git/config`, `~/.gitconfig`, `include.path`), и `GIT_CONFIG_*`
 * из унаследованного окружения правило не видит — `GIT_CONFIG_*` в той же строке ловит
 * `git-exec-input`. Прочие подкоманды, исполняющие строку (`rebase --exec`, `bisect run`),
 * правило тоже не раскрывает.
 */
function pushesGit(calls) {
    return calls.some((call) => {
        const name = basenameOf(call.name);
        if (GIT_PUSH_BINARIES.has(name)) return true;
        if (name !== 'git') return false;
        const args = argValues(call);
        const sub = gitSubcommand(args);
        if (GIT_PUSH_SUBCOMMANDS.has(sub)) return true;
        if (sub === 'subtree' && gitSubSubcommand(args) === 'push') return true;
        const foreach = submoduleForeachCommand(args);
        if (foreach && pushesGit(shellCalls(foreach))) return true;
        return gitDefinesAlias(args) || gitConfigSetsAlias(args);
    });
}

/**
 * Правила над командой оболочки — общие для прежнего входа (`decide`, инструмент `Bash`) и
 * события (`decideEvent`, операция `exec`). Вердикт блока или null. Забор данных контура
 * сюда не входит: его порядок относительно MCP у двух входов свой.
 */
function judgeShell(cmd, options) {
    // Все правила ниже, кроме двух текстовых, судят СПИСОК ВЫЗОВОВ, а не строку.
    const calls = shellCalls(cmd);

    // Упоминание .env блокируем только вместе с командой, которая его читает
    // или отправляет наружу: иначе запрет накрыл бы и разговор о файле.
    if (CMD_ENV_RE.test(cmd) && SECRET_READER_RE.test(cmd)) {
        return {
            blocked: true,
            code: 'secret-env',
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
            code: 'secret-env',
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
            code: 'no-verify',
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
            code: 'manifest-shell',
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
            code: 'raw-address',
            reason:
                `Сетевой вызов на голый адрес ${rawAddress} заблокирован. У адреса без ` +
                'имени нечего проверить: ни домена, ни владельца. Ходи по имени хоста, ' +
                'а если адрес действительно нужен — поднимай его сам и зови по localhost.',
        };
    }
    const destructive = destructiveCall(calls);
    if (destructive) {
        return {
            blocked: true,
            code: 'destructive',
            reason: `Команда заблокирована: ${destructive}`,
        };
    }

    // Пуш ветки фазы — работа раннера, а не сессии петли (#224). Сессия правок по ревью
    // пушила после каждого коммита: 14 пушей за полчаса, и каждый заводил полный гейт CI
    // площадки, из которого читается только прогон последней головы. Раннер пушит ветку
    // одним пушем после сессии (`core/session-push.ts`), поэтому здесь запрещён любой
    // `git push` — правило в промпте сессия однажды уже нарушила. Обходы именем (`send-pack`,
    // `git-push`, `subtree push`, `submodule foreach`, алиас) судятся тут же: отказ с причиной подталкивает модель искать обход
    // (докблок `pushesGit`). Вне петли пуш свободен.
    if (pushesGit(calls) && inLoopOf(options)) {
        return {
            blocked: true,
            code: 'loop-push',
            reason:
                'git push (и send-pack, git-push, subtree push, submodule foreach, алиас git) ' +
                'из сессии петли запрещён: ветку фазы пушит раннер одним пушем после сессии, ' +
                'а каждый пуш сессии заводит отдельный прогон CI. ' +
                'Закоммить работу и заверши сессию — незапушенные коммиты раннер довезёт сам.',
        };
    }

    // Сессия петли идёт в оболочке ХОСТА, где рядом крутится прод (#299): она не
    // ревьюер с ограниченным доступом, а полноценный шелл, и то, что для CI —
    // «локальная проверка», для хоста — боевая служба. Правило смотрит на ВЫЗОВ,
    // как соседние: `git log --grep 'systemctl stop caddy'` вызовом не является.
    const hostService = touchesHostService(calls);
    if (hostService) {
        return { blocked: true, code: 'host-service', reason: hostService };
    }

    // Цель `kill` без имени в тексте (`kill $p`, `xargs kill`, `pkill`, `fuser -k`)
    // барьер служб не видит — ей нечем совпасть с перечнем. Инцидент 22.09.2026:
    // цикл по списку слушателей хоста снял Caddy, docker-proxy и privoxy (#196).
    const foreignKill = killsForeignProcess(calls, options);
    if (foreignKill) {
        return { blocked: true, code: 'foreign-kill', reason: foreignKill };
    }
    return null;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep']);

/**
 * Решение по вызову инструмента.
 *
 * @param {string} toolName — имя инструмента из PreToolUse
 * @param {Record<string, unknown>} toolInput — его аргументы
 * @returns {{ blocked: boolean, reason: string | null, code?: string }} — у блока `code` —
 *   код причины из перечня контракта (`adapters/barrier-reason.ts`): по нему проба
 *   отличает «правило узнало вызов» от «барьер неисправен и блокирует всё».
 */
/**
 * `options.contour` — данные контура потребителя (`consumer-data.cjs`); хук передаёт
 * загруженные, без них контур пустой — самый строгий. `options.loop` — сессия петли: тогда
 * данные контура сессии не правятся. Значение — булево (хук узнаёт петлю по контракту
 * запуска или доверенному контексту сессии, #184) или функция — её зовут, только когда
 * вызов трогает данные.
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
            code: 'mcp-not-allowed',
            reason: `Инструмент ${toolName} не в allowlist MCP: ${contourText}`,
        };
    }

    const contourData = touchesContourData(toolName, input);
    const inLoop = () => inLoopOf(options);
    if (contourData === GIT_EXEC_INPUT && inLoop()) {
        return {
            blocked: true,
            code: 'git-exec-input',
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
            code: 'contour-data',
            reason:
                `Правка данных контура хуков (${contourData}) из сессии петли заблокирована: ` +
                'они решают, какие MCP-мутации и скиллы требует барьер, и действовали бы со ' +
                'следующего вызова — раньше ship человека на мердже. Нужна правка — оставь ' +
                'намерение с обоснованием, файл правит человек.',
        };
    }

    const surfaces = surfacesOf(options);
    if (surfaces && inLoop()) {
        const surface = compatSurfaceWrite(toolName, input, surfaces, options);
        if (surface) return surfaceBlock(surface);
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
                code: 'secret-env',
                reason:
                    `Доступ к ${filePath} заблокирован: файлы .env содержат секреты. ` +
                    'Используй .env.example для структуры переменных.',
            };
        }
        return ALLOWED;
    }

    if (toolName === 'Bash') {
        const cmd = typeof input.command === 'string' ? input.command : '';
        return judgeShell(cmd, options) || ALLOWED;
    }

    if (COMPAT_DELEGATION_TOOLS.has(toolName) && inLoop()) return delegationBlock(toolName);

    return ALLOWED;
}

// --- Нормализованное событие (#186, Фаза 16c) ---------------------------------------------
//
// Прежний вход (`decide`) судит вызов по имени инструмента Claude Code и его полям, и всё, что
// он не узнал, разрешал: «незнакомый инструмент» кончался `ALLOWED`. Из одного этого правила
// выросла половина дыр разбора 27.10 (`docs/harness-contract.md`): `apply_patch` Codex,
// `grep{include}` OpenCode, `Monitor` самого Claude Code с командой оболочки мимо matcher'а.
// Вход события другой: нормализатор пакета харнесса переводит вызов в операции
// (`adapters/harnesses/protocol.ts`), и барьер судит операции, не зная харнесса. Незнакомое
// приходит операцией `unknown` и блокируется своим кодом; невалидна или запрещена одна
// операция — запрещён весь вызов, и судятся все операции до первого эффекта.

/** Имена env-файла, на которых проверяется шаблон пути поиска: точка-env, суффикс, префикс. */
const ENV_NAME_SAMPLES = ['.env', '.env.local', 'ralph.env', 'app.env.production'];

const escapeRe = (c) => c.replace(/[.+^$()|\\\]/{}]/g, '\\$&');

/** Потолок раскрытия `{a,b}`: шаблон шире — барьер считает его совпавшим. */
const BRACE_LIMIT = 64;

/**
 * Раскрытие групп `{a,b}` (с вложенностью) в список шаблонов или null — группа не закрыта или
 * вариантов больше потолка. Раскрытие идёт до разбора, потому что в группе бывает `/`
 * (`{src/x,.env}`), и последний сегмент пути без раскрытия не найти.
 */
function expandBraces(glob) {
    const open = glob.indexOf('{');
    if (open === -1) return [glob];
    let depth = 0;
    let end = -1;
    const commas = [];
    for (let j = open; j < glob.length && end === -1; j++) {
        if (glob[j] === '{') depth++;
        else if (glob[j] === '}' && --depth === 0) end = j;
        else if (glob[j] === ',' && depth === 1) commas.push(j);
    }
    if (end === -1) return null;
    const bounds = [open, ...commas, end];
    const out = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
        const variant =
            glob.slice(0, open) + glob.slice(bounds[k] + 1, bounds[k + 1]) + glob.slice(end + 1);
        const expanded = expandBraces(variant);
        if (expanded === null) return null;
        out.push(...expanded);
        if (out.length > BRACE_LIMIT) return null;
    }
    return out;
}

/**
 * Сегмент шаблона без `/` и без групп (диалект glob: `*`, `?`, `[...]`) → регулярное
 * выражение по имени, либо null, если сегмент не разобрался.
 */
function segmentRegExp(segment) {
    let re = '';
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i];
        if (c === '*') re += '.*';
        else if (c === '?') re += '.';
        else if (c === '[') {
            const end = segment.indexOf(']', i + 2);
            if (end === -1) return null;
            const body = segment
                .slice(i + 1, end)
                .replace(/^!/, '^')
                .replace(/\\/g, '\\\\');
            re += `[${body}]`;
            i = end;
        } else re += escapeRe(c);
    }
    try {
        return new RegExp(`^${re}$`, 'i');
    } catch {
        return null;
    }
}

/**
 * Может ли шаблон пути поиска выбрать env-файл. Решает последний сегмент пути: каталоги перед
 * ним env-файл не исключают (`src/**` выбирает и `src/.env`), а `**` в последнем сегменте
 * выбирает любое имя. Неразобранный шаблон барьер считает совпавшим: догадка о диалекте в
 * пользу пропуска — дыра, в пользу блока — ложный отказ.
 */
function globMayMatchEnv(glob) {
    return ENV_FILE_RE.test(glob) || ENV_NAME_SAMPLES.some((name) => globMaySelectName(glob, name));
}

/**
 * Может ли шаблон выбрать файл с именем `name` — по тому же последнему сегменту. Каталоги
 * перед ним не сужают выбор: оценка в пользу блока, а не догадка о месте файла.
 */
function globMaySelectName(glob, name) {
    const variants = expandBraces(glob);
    if (variants === null) return true;
    return variants.some((variant) => {
        const segment = variant.slice(variant.lastIndexOf('/') + 1);
        if (segment === '' || segment.includes('**')) return true;
        const re = segmentRegExp(segment);
        return re === null || re.test(name);
    });
}

const blockedBy = (code, reason) => ({ blocked: true, code, reason });

const secretPath = (p) =>
    blockedBy(
        'secret-env',
        `Доступ к ${p} заблокирован: файлы .env содержат секреты. ` +
            'Используй .env.example для структуры переменных.',
    );

const contourBlock = (what) =>
    blockedBy(
        'contour-data',
        `Правка данных контура хуков (${what}) из сессии петли заблокирована: ` +
            'они решают, какие MCP-мутации и скиллы требует барьер, и действовали бы со ' +
            'следующего вызова — раньше ship человека на мердже. Нужна правка — оставь ' +
            'намерение с обоснованием, файл правит человек.',
    );

const gitExecBlock = () =>
    blockedBy(
        'git-exec-input',
        'Вызов git с исполняющим входом из сессии петли заблокирован: внешний diff, ' +
            'пейджер, `GIT_CONFIG_*`, `-c`/`--config-env` с исполняющим ключом, ' +
            '`--exec-path=` или запись такого ключа через `git config` запускают ' +
            'программу, которая получает пути дерева и пишет файлы мимо барьера — в том ' +
            'числе данные контура хуков. Читай git без них (`--no-pager`, `--no-ext-diff`, ' +
            '`GIT_PAGER=cat`); нужен такой вызов — оставь намерение с обоснованием.',
    );

const capabilityBlock = (op, what) =>
    blockedBy(
        'capability-unjudged',
        `Операция ${op} (${what}) в сессии петли заблокирована: барьер её не судит — ` +
            'политики сети у него нет, и адрес наружу мог бы унести что угодно. Возможность ' +
            'откроется вместе с правилом, которое её судит.',
    );

/**
 * Субагент и отложенный ход в сессии петли (#225). Сессия правок по ревью раздала темы
 * субагентам, один оборвался посреди хода, а родитель спал по `ScheduleWakeup` и, просыпаясь,
 * считал его работающим: пять коммитов субагента не доехали до ветки, петля стояла час. Раннер
 * не видит ни ходов, ни стоимости, ни обрыва субагента, а сессию `-p` после отложенного хода
 * снаружи никто не будит. Поэтому запрет — не просьба промпта: первый слой — флаг рантайма при
 * запуске (`--disallowedTools`), этот — на случай, если флаг не сработал. Вне петли свободно.
 */
const delegationBlock = (what) =>
    blockedBy(
        'loop-delegation',
        `${what} в сессии петли запрещён: раннер не видит ни ходов субагента, ни его обрыва, а ` +
            'отложенный ход в сессии -p разбудить некому. Делай работу сам; не успеваешь — ' +
            'закоммить сделанное и заверши сессию, раннер продолжит её новой.',
    );

/**
 * Инструменты совместимого входа 16b, порождающие субагента или откладывающие ход (#225):
 * у этого входа нет описания пакета, и класс инструмента он знает только по имени. Имена — в
 * форме Claude Code: так их подают регистрации дерева, Kimi Code (`Task`) и плагин OpenCode
 * (`task` → `Task`, `OPENCODE_TOOL_NAMES`).
 */
const COMPAT_DELEGATION_TOOLS = new Set([
    'Agent',
    'Task',
    'Workflow',
    'ScheduleWakeup',
    'CronCreate',
]);

/**
 * Разрешён ли MCP-инструмент: по эффектам политики, если данные их заявили (`toolsDeclared`),
 * иначе прежним правилом. Данные прежней формы мигрирует доверенный launcher, а не сессия
 * (`mcp-effects.cjs`): переключение раньше миграции отняло бы у живой петли все чтения.
 */
function mcpEventAllowed(name, mcp) {
    return mcp.toolsDeclared ? mcpAllowedByEffect(name, mcp) : mcpAllowed(name, mcp);
}

// Блок по политике эффектов называет свою причину (#215). Нет эффекта — дрейф конфигурации:
// инструмент появился у сервера после снимка инвентаря, повтор вызова его не разрешит, и
// сессия, принявшая блок за транзиент, жгла бы ходы на ретраях. Эффект есть, а блок держит
// запрет ядра по слову, — это политика, а не дрейф: «обнови снимок» отправил бы человека
// лечить не то.
function mcpEffectBlockReason(name, mcp) {
    const effect = mcp.tools.get(name);
    if (effect === undefined) {
        return (
            'у него нет эффекта в mcp.tools данных `.claude/ralph/hooks.json`. Это дрейф ' +
            'конфигурации, а не транзиент: вызов не повторяй — инструмент вне снимка ' +
            'инвентаря MCP разрешает только PR обновления снимка и данных контура под ship человека'
        );
    }
    if (mcp.neverExceptions.has(name)) {
        return (
            `он в mcp.neverExceptions, а эффект в mcp.tools — ${effect}: исключение из запрета ` +
            'ядра по слову действует только на запись. Вызов не повторяй — это политика ' +
            'данных контура, а не дрейф инвентаря'
        );
    }
    return (
        `эффект в mcp.tools есть (${effect}), но имя под запретом ядра по слову. Вызов не ` +
        'повторяй — это политика, а не дрейф инвентаря: снять запрет может только исключение ' +
        'mcp.neverExceptions с эффектом write в данных контура под ship человека'
    );
}

function mcpBlock(name, mcp) {
    const how = mcp.toolsDeclared
        ? mcpEffectBlockReason(name, mcp)
        : 'данные `.claude/ralph/hooks.json` ещё прежней формы, без mcp.tools (чтение ' +
          'List*/Get* и mcp.writeAllowed), и по ним он не разрешён';
    return blockedBy(
        'mcp-not-allowed',
        `Инструмент ${name} вне контура MCP: ${how}. Нужен новый — проект заявляет его в ` +
            'данных контура отдельным PR с обоснованием.',
    );
}

function unknownBlock(op) {
    if (op.kind === 'tool') {
        return blockedBy(
            'unknown-tool',
            `Инструмент вне описания пакета харнесса: ${op.why}. Незнакомое барьер не ` +
                'пропускает — инструмент добавляет в описание отдельная правка пакета с ' +
                'живой фикстурой.',
        );
    }
    return blockedBy(
        'unknown-field',
        `Вызов не разобрался по описанию пакета харнесса: ${op.why}. Поле, о котором ` +
            'описание не знает, может нести путь мимо барьера.',
    );
}

/**
 * Каталоги, в которые обход не спускается, — и это предел, а не «там нечего искать» (ревью
 * 16c). Инструмент поиска их не пропускает: `rg` смотрит `.gitignore`, а не имена, и `.env`
 * внутри неигнорируемого `node_modules` (или под корнем `Grep{path: node_modules/pkg}`, где
 * пропускается уже вложенный каталог) он прочтёт, а барьер не увидит. Без пропуска обход
 * `node_modules` упирался бы в потолок на каждом поиске по корню, и поиск в дереве с
 * зависимостями стал бы отказом всегда. Корень поиска сам не пропускается никогда.
 */
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules']);
/** Потолок обхода: дерево, которое не перечислить, барьер считает содержащим защищённое. */
const SEARCH_WALK_LIMIT = 50_000;
/** Потолок переходов по симлинкам при разрешении пути — как `MAXSYMLINKS` ядра Linux. */
const SYMLINK_HOPS = 40;

const isLink = (entry) =>
    typeof entry.isSymbolicLink === 'function' ? entry.isSymbolicLink() : false;

/**
 * Настоящий путь `p` от `baseDir` — тот, куда операция дойдёт в файловой системе (#187).
 * Строка обходится тремя способами, и каждый закрыт здесь:
 *
 * - симлинк в любом сегменте, а не только в последнем или в родителе: разрешение идёт
 *   посегментно, и `..` после симлинка ведёт к родителю ЦЕЛИ, как у ядра ОС, — лексический
 *   `path.resolve` (им же начинается `fs.realpathSync`) свернул бы `link/..` в строку;
 * - ещё не созданное назначение: от ближайшего существующего предка хвост дописывается
 *   строкой — `alias/ralph/hooks.json`, где `alias` → `.claude`, а `ralph/` ещё нет, — это
 *   данные контура, хотя ни путь, ни родитель не разрешаются;
 * - висячий симлинк: запись через него создаёт цель, поэтому судится цель.
 *
 * Цикл ссылок обрывается потолком переходов; дальше путь судится строкой.
 */
function physicalPath(p, baseDir, fsApi, hops = 0) {
    const abs = path.isAbsolute(p);
    let cur = abs ? path.parse(p).root : baseDir || '/';
    if (!abs && hops === 0) {
        try {
            cur = fsApi.realpathSync(path.resolve(cur));
        } catch {
            cur = path.resolve(cur);
        }
    }
    for (const part of p.split(/[\\/]+/)) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            cur = path.dirname(cur);
            continue;
        }
        const next = path.join(cur, part);
        try {
            cur = fsApi.realpathSync(next);
            continue;
        } catch {
            // Нет пути или висячая ссылка: ссылка ведёт туда, где запись создаст файл.
        }
        let target = null;
        if (hops < SYMLINK_HOPS && typeof fsApi.readlinkSync === 'function') {
            try {
                target = fsApi.readlinkSync(next);
            } catch {
                target = null;
            }
        }
        cur =
            target === null ? next : physicalPath(path.resolve(cur, target), '/', fsApi, hops + 1);
    }
    return cur;
}

/** Путь операции строкой и настоящим путём: правило судит обе формы. */
function pathForms(p, baseDir, fsApi) {
    return [p, physicalPath(p, baseDir, fsApi)];
}

function isDirectory(p, fsApi) {
    try {
        return fsApi.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Обход дерева от `root` в ширину. `visit(путь, запись)` зовётся на каждой не-каталожной
 * записи и останавливает обход непустой строкой — она и есть ответ. `follow` — спускаться
 * в каталоги-симлинки (каждый настоящий каталог — один раз, цикл не вешает обход): поиск
 * читает то, на что ссылка ведёт, а перенос каталога уносит саму ссылку, а не цель.
 * Корня нет или он не каталог — null; не перечислился — строка с причиной.
 */
function walkTree(root, visit, fsApi, follow) {
    if (!isDirectory(root, fsApi)) return null;
    const seen = new Set();
    const queue = [root];
    let entries = 0;
    while (queue.length > 0) {
        const dir = queue.shift();
        if (follow) {
            let real = dir;
            try {
                real = fsApi.realpathSync(dir);
            } catch {
                // Каталог не разрешился — обходим по строке.
            }
            if (seen.has(real)) continue;
            seen.add(real);
        }
        let list;
        try {
            list = fsApi.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of list) {
            if (++entries > SEARCH_WALK_LIMIT) {
                return `${root} (не перечислить: больше ${SEARCH_WALK_LIMIT} записей)`;
            }
            const full = path.join(dir, e.name);
            const dirEntry = e.isDirectory() || (follow && isLink(e) && isDirectory(full, fsApi));
            if (dirEntry) {
                if (!SEARCH_SKIP_DIRS.has(e.name)) queue.push(full);
                continue;
            }
            const hit = visit(full, e);
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * Данные контура внутри каталога: перенос или удаление каталога уносит их, не называя
 * файла. Служебный каталог как корень не обходится — данных проекта в нём нет.
 */
function dataInside(dir, fsApi) {
    if (SEARCH_SKIP_DIRS.has(path.basename(dir))) return null;
    return walkTree(dir, (full) => (DATA_PATH_RE.test(full) ? full : null), fsApi, false);
}

/** Путь — данные контура, их каталог-предок или каталог, где данные лежат глубже. */
function contourAt(p, fsApi) {
    if (DATA_PATH_RE.test(p) || DATA_ANCESTOR_RE.test(p)) return p;
    return dataInside(p, fsApi);
}

/** Потолок раскрытия шаблона оболочки по файловой системе: шире — барьер считает совпавшим. */
const GLOB_MATCH_LIMIT = 1000;

/**
 * Раскрытие шаблона оболочки по файловой системе от `baseDir` — как это сделает оболочка, с
 * правилом ведущей точки. Сегмент без шаблона дописывается строкой. Не разобрался или
 * совпадений больше потолка — null: вызывающий считает это совпадением с данными.
 */
function expandShellGlob(arg, baseDir, fsApi) {
    const variants = expandBraces(arg);
    if (variants === null) return null;
    const out = [];
    for (const variant of variants) {
        let paths = [path.isAbsolute(variant) ? path.parse(variant).root : baseDir || '/'];
        for (const segment of variant.split(/[\\/]+/)) {
            if (segment === '' || segment === '.') continue;
            if (!GLOB_CHARS_RE.test(segment)) {
                paths = paths.map((p) => path.join(p, segment));
                continue;
            }
            const re = segment.includes('**') ? /^/ : segmentRegExp(segment);
            if (re === null) return null;
            const next = [];
            for (const dir of paths) {
                let names = [];
                try {
                    names = fsApi.readdirSync(dir);
                } catch {
                    continue;
                }
                for (const name of names) {
                    if (name.startsWith('.') && !segment.startsWith('.')) continue;
                    if (re.test(name)) next.push(path.join(dir, name));
                }
            }
            if (next.length > GLOB_MATCH_LIMIT) return null;
            paths = next;
        }
        out.push(...paths);
        if (out.length > GLOB_MATCH_LIMIT) return null;
    }
    return out;
}

/**
 * Пути, которые вызов заменяет, переносит или удаляет, и база, от которой они судятся.
 * У git база — значение `-C`, а пути — аргументы вне опций; сам каталог `-C` судится только
 * как путь данных или их предок: обход всего репозитория по `git -C <репо> push` блокировал
 * бы любой вызов. У `find` — точки старта до первого выражения, без них — `.`; у `tar` с извлечением — каталог
 * `-C`/`--directory`, иначе каталог вызова, и пути аргументов.
 */
function replacedTargets(name, args, baseDir, fsApi) {
    const plain = (list) => list.filter((arg) => arg !== '' && !arg.startsWith('-'));
    if (name === 'git') {
        let base = baseDir;
        const anchors = [];
        const rest = [];
        for (let i = 0; i < args.length; i += 1) {
            if (GIT_VALUE_OPTIONS.has(args[i])) {
                if (args[i] === '-C' && args[i + 1] !== undefined) {
                    base = physicalPath(args[i + 1], base, fsApi);
                    anchors.push(base);
                }
                i += 1;
                continue;
            }
            rest.push(args[i]);
        }
        return { base, anchors, paths: plain(rest) };
    }
    if (name === 'find') {
        // Без точки старта GNU find обходит `.`: пустой список выпустил бы `find -delete`.
        const end = args.findIndex((arg) => /^[-(!]/.test(arg));
        const starts = end === -1 ? args : args.slice(0, end);
        return { base: baseDir, anchors: [], paths: starts.length ? starts : ['.'] };
    }
    if (name === 'tar') {
        const at = args.findIndex((arg) => arg === '-C' || arg === '--directory');
        const into = at === -1 ? '.' : args[at + 1] || '.';
        return { base: baseDir, anchors: [], paths: [into, ...plain(args)] };
    }
    return { base: baseDir, anchors: [], paths: plain(args) };
}

/**
 * Аргумент вызова, заменяющего пути (`replacesPaths`), который по файловой системе — данные
 * контура или каталог с ними: псевдоним `.claude/ralph` симлинком строкой не виден, а шаблон
 * оболочки (`mv .c?aude bak`) раскрывается здесь так же, как его раскроет оболочка.
 * Аргументы судятся от каталога вызова: `cd` внутри той же строки разбор не отслеживает —
 * предел назван, его держит забор по имени (`shellWritesContourData`). `shopt -s dotglob`
 * и `GLOBIGNORE` в той же строке раскрытие не учитывает.
 */
function moverTouchesData(calls, baseDir, fsApi) {
    const gitEnvSet = assignmentsOf(calls).some((a) => GIT_ENV_ASSIGNMENT_RE.test(a));
    for (const call of calls) {
        const args = argValues(call);
        if (!replacesPaths(call.name, args, gitEnvSet)) continue;
        const { base, anchors, paths } = replacedTargets(call.name, args, baseDir, fsApi);
        const anchor = anchors.find((p) => DATA_PATH_RE.test(p) || DATA_ANCESTOR_RE.test(p));
        if (anchor) return anchor;
        for (const arg of paths) {
            const expanded = GLOB_CHARS_RE.test(arg) ? expandShellGlob(arg, base, fsApi) : [arg];
            if (expanded === null) return `${arg} (шаблон не раскрыть)`;
            for (const one of expanded) {
                const hit = contourAt(physicalPath(one, base, fsApi), fsApi);
                if (hit) return hit;
            }
        }
    }
    return null;
}

/**
 * Файловая операция: забор данных контура (в петле, кроме чтения) и env-файлы.
 *
 * У переноса две стороны (#187). Источник уходит — судится он сам и, если это каталог, его
 * содержимое. Назначение появляется — новым путём будет назначение, а если оно уже
 * существующий каталог, то `назначение/имя источника`; встаёт ли на этом месте каталог
 * данных, решает его имя. Содержимое источника на новом месте отдельно не судится:
 * шаблон данных без якоря, и данные «где-то внутри» источника уже нашёл обход источника.
 * Удаление — та же сторона источника.
 */
function judgeFileOperation(op, inLoop, fsApi) {
    const sources = pathForms(op.path, op.baseDir, fsApi);
    // Новый путь переноса: назначение, а в существующий каталог — `назначение/имя источника`.
    let landed = [];
    if (op.op === 'move') {
        const dest = pathForms(op.destination, op.baseDir, fsApi);
        landed = isDirectory(dest[1], fsApi)
            ? [path.join(dest[1], path.basename(sources[1]))]
            : dest;
    }
    const forms = [...sources, ...landed];
    if (op.op !== 'read' && inLoop()) {
        const data = forms.find((f) => DATA_PATH_RE.test(f));
        if (data) return contourBlock(data);
        if (op.op === 'move' || op.op === 'delete') {
            const moved =
                sources.find((f) => DATA_ANCESTOR_RE.test(f)) ||
                dataInside(sources[1], fsApi) ||
                landed.find((f) => DATA_ANCESTOR_RE.test(f));
            if (moved) return contourBlock(moved);
        }
    }
    const env = forms.find((f) => ENV_FILE_RE.test(f));
    return env ? secretPath(env) : null;
}

/**
 * Поиск судится по множеству файлов, которые он может прочесть: корень, шаблон пути, а без
 * шаблона (или с одним исключающим `!…`) — весь корень. Значение `contentPattern` на решение о
 * секрете не влияет: совпадение по содержимому решает выдачу строки, а прочитан файл всё равно.
 * Его НАЛИЧИЕ влияет (ревью 16c): поиск без шаблона содержимого (`Glob`) отдаёт только имена, в
 * них секрета нет, и `Glob("**\/*")` прежде давал `secret-env` в каждой сессии на событии.
 *
 * Цена названа: поиск содержимого без шаблона пути обходит корень синхронно на КАЖДОМ вызове,
 * до `SEARCH_WALK_LIMIT` записей, и блокируется любым env-файлом под корнем — в том числе
 * под `.gitignore`, который инструмент поиска сам пропустил бы. В проекте с локальным `.env`
 * поиск содержимого по корню без шаблона пути — отказ; сузить корень или шаблон — выход.
 *
 * Симлинк внутри корня судится по цели (#187): файл `src/config.ts` → `.env` выбирает и
 * поиск без шаблона, и шаблон `**\/*.ts`. Каталоги-симлинки обходятся — инструмент поиска
 * пакета может за ними ходить, и барьер не знает, ходит ли.
 */
function judgeSearch(op, fsApi) {
    const root = physicalPath(op.root, op.baseDir, fsApi);
    const rootEnv = [op.root, root].find((f) => ENV_FILE_RE.test(f));
    if (rootEnv) return secretPath(rootEnv);
    if (typeof op.contentPattern !== 'string') return null;
    const raw = typeof op.pathGlob === 'string' ? op.pathGlob : '';
    const glob = raw !== '' && !raw.startsWith('!') ? raw : null;
    if (glob !== null && globMayMatchEnv(glob)) return secretPath(`${op.root} по шаблону ${glob}`);
    const found = walkTree(
        root,
        (full, e) => {
            let target = full;
            if (isLink(e)) {
                try {
                    target = fsApi.realpathSync(full);
                } catch {
                    return null;
                }
            }
            if (glob === null)
                return ENV_FILE_RE.test(e.name) || ENV_FILE_RE.test(target) ? full : null;
            return target !== full && ENV_FILE_RE.test(target) && globMaySelectName(glob, e.name)
                ? `${full} → ${target}`
                : null;
        },
        fsApi,
        true,
    );
    if (!found) return null;
    const how = glob === null ? 'без шаблона пути' : `по шаблону ${glob}`;
    return secretPath(`${found} (поиск по корню ${op.root} ${how})`);
}

// --- Поверхности конфига харнессов (#199) ----------------------------------------------
//
// Настройки, хуки, плагины и MCP любого CLI — то, что решает, с каким барьером и какими
// серверами пойдёт СЛЕДУЮЩАЯ сессия. Сессия петли, правящая `.claude/settings.json`, `.codex/`
// или `opencode.json`, меняла бы их раньше ship человека, а в доме CLI (`~/.claude`, `CODEX_HOME`,
// `<XDG_CONFIG_HOME>/opencode`, каталог плагина барьера OpenCode) — ещё и мимо ревью вовсе.
// Перечень у каждого пакета свой (`protectedSurfaces` описания), раннер объединяет перечни
// реестра в контексте сессии, и правило знает только его форму: новый CLI привозит свои
// поверхности данными. Контекста с перечнем нет (раннер установки до #199) — правило молчит,
// и это сказано в докблоке `session-context.cjs`. Кроме шаблонов дерева и домов перечень знает
// файлы рядом с домом (`~/.claude.json` — дом-файл) и системные пути (`absolute`: managed-настройки
// `/etc/claude-code`, `/etc/codex`), которые CLI читают при любых источниках настроек.
//
// Что правило НЕ судит, сказано здесь. Чтение не защищается: конфиг читает и человек, и сессия.
// Вызов оболочки судится по аргументам и целям перенаправления от каталога вызова: `cd` внутри
// той же строки разбор не отслеживает (`cd .codex && tee config.toml`), путь, собранный по
// частям, не виден. Код, запущенный не интерпретатором по имени, судится по словам пути в его
// тексте (`PLAIN_ARG_RE`): имя, собранное выражением (`'.m'+'cp.json'`), не видно. Совместимый вход 16b (`decide`) несёт правило для инструментов записи и
// оболочки (`compatSurfaceWrite`): без раскладки `roots` guard сессии — копия хуков в дереве, и
// судит она этим входом. Запись, которой нет в аргументах, держит песочница (Фаза 16e), а не хук.

/** Сегменты пути без пустых и `.`. */
const segmentsOf = (p) => p.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');

/**
 * Шаблон дерева против пути: последовательность сегментов шаблона где угодно в пути. Шаблон
 * каталога (`/` в конце) накрывает каталог и всё внутри, шаблон файла — только сам файл. `ancestor`
 * — перенос или удаление: путь, внутри которого лежит поверхность, уносит её, не называя.
 */
function treePatternHits(pattern, segments, ancestor) {
    const dir = pattern.endsWith('/');
    const parts = segmentsOf(pattern);
    const res = parts.map((part) => segmentRegExp(part));
    for (let i = 0; i < segments.length; i++) {
        let k = 0;
        while (k < parts.length && i + k < segments.length) {
            const re = res[k];
            if (re === null ? segments[i + k] !== parts[k] : !re.test(segments[i + k])) break;
            k++;
        }
        if (k === parts.length && (dir || i + k === segments.length)) return true;
        // Путь кончился внутри шаблона: это предок поверхности.
        if (ancestor && k > 0 && i + k === segments.length) return true;
    }
    return false;
}

/**
 * Каталоги дома CLI по описанию: из переменной окружения И путь по умолчанию от `HOME`. Дом из
 * переменной не отменяет прежний: раннер сам ставит `XDG_CONFIG_HOME` сессии OpenCode в каталог
 * состояния, а глобальный конфиг человека `~/.config/opencode` грузит его интерактивный CLI.
 */
function homeDirsOf(home, vars) {
    const dirs = [];
    if (home.env !== null && vars[home.env]) dirs.push(path.join(vars[home.env], home.sub));
    if (home.default !== null && vars.HOME) dirs.push(path.join(vars.HOME, home.default));
    return dirs;
}

/** `rel` от корня — внутри корня или он сам: `..cache` — имя внутри, а не выход вверх. */
const isInside = (rel) =>
    rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));

/**
 * Перечень поверхностей, приготовленный к суду: корни домов и системных путей — строкой и
 * настоящим путём. От цели они не зависят, поэтому разрешаются один раз на решение, а не на
 * каждый аргумент каждого вызова.
 */
function surfaceIndexOf(surfaces, vars, fsApi) {
    const roots = [];
    const add = (dir, exempt, label) => {
        for (const root of new Set([path.resolve(dir), physicalPath(dir, '/', fsApi)])) {
            roots.push({ root, exempt, label });
        }
    };
    for (const home of surfaces.homes) {
        for (const dir of homeDirsOf(home, vars)) add(dir, home.exempt, 'дом CLI');
    }
    for (const abs of surfaces.absolute || []) add(abs, [], 'системный конфиг CLI');
    return { tree: surfaces.tree, roots };
}

/**
 * Поверхность, которую задевает путь операции, строкой или null. Путь судится лексически от
 * `baseDir` и настоящим (`physicalPath`), корни — тоже обеими формами. `ancestor` — перенос и
 * удаление: каталог, содержащий корень или поверхность дерева.
 */
function surfaceOf(target, baseDir, index, fsApi, ancestor) {
    const forms = new Set([path.resolve(baseDir, target), physicalPath(target, baseDir, fsApi)]);
    // Шаблоны дерева судят путь НИЖЕ исключения дома: история и кэш законно лежат под каталогом,
    // который снаружи дома был бы поверхностью дерева (`~/.codex/sessions` — внутри `.codex/`), а
    // `~/.claude/projects/w/.claude/settings.json` под исключением — снова поверхность дерева.
    // Исключение снимает только свой дом: остальные корни судят путь как обычно.
    const treeForms = [...forms].map((form) => ({ form, segments: segmentsOf(form) }));
    for (const entry of treeForms) {
        for (const { root, exempt, label } of index.roots) {
            const rel = path.relative(root, entry.form);
            if (isInside(rel)) {
                const first = rel.split(path.sep)[0];
                if (rel !== '' && exempt.includes(first)) {
                    const below = segmentsOf(path.relative(path.join(root, first), entry.form));
                    if (below.length < entry.segments.length) entry.segments = below;
                    continue;
                }
                return `${entry.form} — ${label} ${root}`;
            }
            if (ancestor && isInside(path.relative(entry.form, root))) {
                return `${entry.form} — содержит ${label} ${root}`;
            }
        }
    }
    for (const { form, segments } of treeForms) {
        const pattern = index.tree.find((p) => treePatternHits(p, segments, ancestor));
        if (pattern) return `${form} — поверхность ${pattern}`;
    }
    return null;
}

const surfaceBlock = (what) =>
    blockedBy(
        'config-surface',
        `Запись поверхности конфига харнесса (${what}) из сессии петли заблокирована: настройки, ` +
            'хуки, плагины и MCP решают, с каким барьером и серверами пойдёт следующая сессия, ' +
            'и правка действовала бы раньше ship человека. Нужна правка — оставь намерение с ' +
            'обоснованием, файл правит человек.',
    );

/** Перечень поверхностей из контекста сессии; нет его — правило не действует. */
const surfacesOf = (options) => {
    const s = options.surfaces;
    return s && Array.isArray(s.tree) && Array.isArray(s.homes) ? s : null;
};

// Команды, которые пишут только перенаправлением: их аргументы — текст, а не адрес записи.
const TEXT_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':', 'test', '[']);
// Перенаправление в файл с целью в том же токене или следующем: `>x`, `2>>x`, `&>x`, `>|x`.
const REDIRECT_RE = /(?:^|[^<>])(?:\d|&)?>>?\|?(.*)$/;
// Слова пути в тексте программы интерпретатора: `fs.writeFileSync('.mcp.json')`.
const PATHLIKE_RE = /[~\w./-]*[/.][~\w./-]*/g;
// Аргумент из одних символов пути. Остальное — текст программы (`npx tsx -e "…"`, `awk '{…}'`,
// `pnpm exec node -e …`), и в нём ищутся слова пути, как у интерпретатора: перечень
// интерпретаторов по имени отстаёт от того, чем петля на самом деле запускает код.
const PLAIN_ARG_RE = /^[~\w./@+:,%=-]*$/;
// Удаляющие команды: каталог-предок поверхности у них уносит её, не называя.
const SURFACE_REMOVERS = new Set(['rm', 'rmdir', 'unlink']);
// Копирующие и переносящие: назначение пишется, а у `mv` ещё и источник уходит.
const SURFACE_COPIERS = new Set(['mv', 'cp', 'install', 'ln', 'rsync']);
// Опции копирующих с отдельным значением: значение — не путь вызова. Короткие — буквой: у GNU
// `getopt` значение берётся хвостом связки (`-m644`) или следующим словом (`-Dm 644`).
const COPIER_VALUE_CHARS = new Set(['m', 'o', 'g', 'S']);
const COPIER_VALUE_LONG = ['--mode', '--owner', '--group', '--suffix'];
// `rsync`, удаляющий в назначении или источнике: предок там опасен так же, как у `rm`.
const RSYNC_REMOVES_RE = /^--(?:delete|del$|remove-source-files)/;
// Короткие опции `rsync`, включающие рекурсию: `-r`, `-a` и их связки (`-av`). Сам `rsync` всегда
// судится рекурсивным; набор нужен разбору coreutils ниже.
const RECURSIVE_CHARS = new Set(['r', 'R', 'a']);
// Действия `find`, пишущие в файл по имени.
const FIND_FILE_ACTIONS = new Set(['-fprint', '-fprint0', '-fprintf', '-fls']);

/** `~/x` → от `HOME`: оболочка раскроет его до вызова. */
const expandHome = (p, vars) =>
    p === '~' || p.startsWith('~/') ? path.join(vars.HOME || '/', p.slice(1)) : p;

/** Цель записи без признака предка. */
const plainTarget = (raw) => ({ raw, ancestor: false });

/**
 * Длинная опция GNU `getopt_long` с сокращением: `--no-t` — это `--no-target-directory`, `--t=DIR` —
 * `--target-directory=DIR`. Сравнение только с полным именем обходилось сокращением: `cp -r --no-t
 * evil ~` писал `~/.claude`, а правило судило запись `~/evil`. Порог `min` — кратчайший префикс,
 * однозначный у всех четырёх утилит; короче он неоднозначен, и `getopt` отвергает вызов сам.
 */
function longOpt(arg, full, min) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name.length < min || !full.startsWith(name)) return null;
    return { value: eq === -1 ? null : arg.slice(eq + 1) };
}

/**
 * Опции копирующей утилиты coreutils (`cp`, `mv`, `install`, `ln`) так, как их читает GNU
 * `getopt`: связка коротких (`-rt DIR`, `-t~`), сокращение длинных, `--` в конце опций. Признак по
 * целому слову пропускал `cp -rt ~ x/.claude`: связка с `t` не узнавалась, и назначением считался
 * последний аргумент.
 */
function parseCoreutilsCopier(args) {
    const positional = [];
    let dest = null;
    let noTarget = false;
    let recursive = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            positional.push(...args.slice(i + 1));
            break;
        }
        if (arg.startsWith('--')) {
            let m;
            if (longOpt(arg, '--no-target-directory', '--no-t'.length)) noTarget = true;
            else if ((m = longOpt(arg, '--target-directory', '--t'.length))) {
                dest = m.value ?? args[++i] ?? null;
            } else if (longOpt(arg, '--recursive', '--rec'.length)) recursive = true;
            else if (longOpt(arg, '--archive', '--ar'.length)) recursive = true;
            else if (!arg.includes('=') && COPIER_VALUE_LONG.some((o) => longOpt(arg, o, 4))) i++;
            continue;
        }
        if (arg.length < 2 || !arg.startsWith('-')) {
            positional.push(arg);
            continue;
        }
        for (let j = 1; j < arg.length; j++) {
            const ch = arg[j];
            if (ch === 'T') noTarget = true;
            else if (RECURSIVE_CHARS.has(ch)) recursive = true;
            else if (ch === 't' || COPIER_VALUE_CHARS.has(ch)) {
                const value = j + 1 < arg.length ? arg.slice(j + 1) : (args[++i] ?? null);
                if (ch === 't') dest = value;
                break;
            }
        }
    }
    return { positional, dest, noTarget, recursive };
}

/**
 * Опции `rsync`: у него нет ни `-t`, ни `-T` coreutils (`-t` — времена, `-T` — временный
 * каталог), и назначение — всегда последний позиционный аргумент. Значение `-T DIR` попадает в
 * источники: это лишняя проверенная запись, а не пропущенная.
 */
const parseRsync = (args) => ({
    positional: args.filter((a) => !a.startsWith('-')),
    dest: null,
    noTarget: false,
    recursive: true,
});

/**
 * Пути, которые пишет копирующая команда: назначение и `назначение/имя источника` — `cp -r
 * x/.claude ~/` пишет `~/.claude`, не называя его. Источник с неизвестным именем (`.`, хвост `/`,
 * шаблон, `-T`) кладёт в назначение неизвестно что, и назначение тогда судится как предок. Источники
 * `mv` и удаляющего `rsync` уходят — они предки; у остальных их только читают.
 */
function copierTargets(name, args, isDirAt) {
    const parsed = name === 'rsync' ? parseRsync(args) : parseCoreutilsCopier(args);
    const { positional, noTarget, recursive } = parsed;
    let dest = parsed.dest;
    let intoDir = dest !== null;
    if (dest === null) {
        intoDir = positional.length !== 2;
        dest = positional.length > 1 ? positional.pop() : '.';
    }
    // Источник ложится ВНУТРЬ назначения, только если оно каталог: так его называет вызов
    // (`-t`, хвост `/`, несколько источников) или файловая система.
    // `-T` (`--no-target-directory`) кладёт СОДЕРЖИМОЕ источника прямо в назначение, даже если
    // оно каталог: `cp -rT evil ~` пишет `~/.claude`, не называя его.
    intoDir = !noTarget && (intoDir || /[\\/]$/.test(dest) || isDirAt(dest));
    const removes =
        name === 'mv' || (name === 'rsync' && args.some((a) => RSYNC_REMOVES_RE.test(a)));
    // Рекурсивная копия кладёт каталог с неизвестным содержимым: путь, который он получает,
    // судится как предок — `cp -r evil ~/.config` создаёт `~/.config/opencode`, не называя его.
    const out = [{ raw: dest, ancestor: removes || (recursive && !intoDir) }];
    for (const src of positional) {
        if (removes) out.push({ raw: src, ancestor: true });
        if (!intoDir) continue;
        const tail = path.basename(src);
        const unknown =
            /[\\/]$/.test(src) || tail === '.' || tail === '..' || GLOB_CHARS_RE.test(tail);
        if (unknown) out.push({ raw: dest, ancestor: true });
        else out.push({ raw: path.join(dest, tail), ancestor: recursive });
    }
    return out;
}

/** Позиционные аргументы предками: удаление уносит каталог вместе с поверхностью. */
const ancestorTargets = (args) =>
    args.filter((arg) => !arg.startsWith('-')).map((raw) => ({ raw, ancestor: true }));

/**
 * Адреса записи одного вызова оболочки — `{raw, ancestor}`. Цели перенаправлений — у любого
 * вызова; у читающих и текстовых команд и у git с безопасной подкомандой — только они; у
 * интерпретатора — слова пути в тексте программы; у удаляющих — аргументы предками; у копирующих
 * — назначение (`copierTargets`); у `find` — корни предками, только если действие удаляет или
 * исполняет; у остальных — аргументы, значения `--опция=…` и слова пути в аргументах-тексте.
 * Предок опасен только там, где путь уходит: `find ~ -name x` читает, `cp x ~/` пишет в дом
 * другой файл.
 */
function shellWriteTargets(call, isDirAt) {
    const args = argValues(call);
    const targets = [];
    for (let i = 0; i < args.length; i++) {
        const m = REDIRECT_RE.exec(args[i]);
        if (!m) continue;
        if (m[1] !== '') targets.push(plainTarget(m[1]));
        else if (i + 1 < args.length) targets.push(plainTarget(args[i + 1]));
    }
    const name = basenameOf(call.name);
    const words = (arg) => (arg.match(PATHLIKE_RE) || []).map(plainTarget);
    if (DATA_READERS.has(name) || TEXT_COMMANDS.has(name)) return targets;
    if (name === 'git' && gitLeavesDataAlone(args)) return targets;
    if (INTERPRETERS_RE.test(name)) return [...targets, ...args.flatMap(words)];
    if (SURFACE_REMOVERS.has(name)) return [...targets, ...ancestorTargets(args)];
    if (SURFACE_COPIERS.has(name)) return [...targets, ...copierTargets(name, args, isDirAt)];
    if (name === 'find') {
        if (findReplacesPaths(args)) return [...targets, ...ancestorTargets(args)];
        args.forEach((arg, i) => {
            if (FIND_FILE_ACTIONS.has(arg) && i + 1 < args.length) {
                targets.push(plainTarget(args[i + 1]));
            }
        });
        return targets;
    }
    for (const arg of args) {
        if (!arg.startsWith('-')) targets.push(plainTarget(arg));
        else if (arg.indexOf('=') > 0) targets.push(plainTarget(arg.slice(arg.indexOf('=') + 1)));
        if (!PLAIN_ARG_RE.test(arg)) targets.push(...words(arg));
    }
    return targets;
}

/** Вызов оболочки, пишущий поверхность конфига, — строкой или null. */
function shellWritesSurface(calls, baseDir, index, vars, fsApi) {
    const isDirAt = (p) => isDirectory(path.resolve(baseDir, expandHome(p, vars)), fsApi);
    for (const call of calls) {
        for (const { raw, ancestor } of shellWriteTargets(call, isDirAt)) {
            if (raw === '' || /^[<>&|]+$/.test(raw)) continue;
            const hit = surfaceOf(expandHome(raw, vars), baseDir, index, fsApi, ancestor);
            if (hit) return `${call.name}: ${hit}`;
        }
    }
    return null;
}

/**
 * Поверхность конфига на совместимом входе 16b: пути инструментов записи Claude Code и команда
 * оболочки. База относительных путей — `cwd` конверта хука (`options.baseDir`).
 */
function compatSurfaceWrite(toolName, input, surfaces, options) {
    const vars = options.processEnv || process.env;
    const fsApi = options.fsApi || fs;
    const baseDir = options.baseDir || '/';
    if (WRITE_TOOLS.has(toolName)) {
        const paths = [input.file_path, input.notebook_path, input.path];
        if (Array.isArray(input.edits)) {
            for (const edit of input.edits) if (edit) paths.push(edit.file_path);
        }
        const named = paths.filter((p) => typeof p === 'string');
        if (named.length === 0) return null;
        const index = surfaceIndexOf(surfaces, vars, fsApi);
        for (const p of named) {
            const hit = surfaceOf(expandHome(p, vars), baseDir, index, fsApi, false);
            if (hit) return hit;
        }
        return null;
    }
    if (toolName === 'Bash' && typeof input.command === 'string') {
        const index = surfaceIndexOf(surfaces, vars, fsApi);
        return shellWritesSurface(shellCalls(input.command), baseDir, index, vars, fsApi);
    }
    return null;
}

/** Перечень поверхностей решения, приготовленный один раз (`surfaceIndexOf`); нет — null. */
function surfaceIndexIn(ctx) {
    if (ctx.surfaceIndex === undefined) {
        const surfaces = surfacesOf(ctx.options);
        ctx.surfaceIndex = surfaces && surfaceIndexOf(surfaces, ctx.vars, ctx.fsApi);
    }
    return ctx.surfaceIndex;
}

/**
 * Запись, перенос или удаление поверхности конфига в сессии петли (#199). У переноса судятся обе
 * стороны: источник уходит, назначение появляется — `mv evil.toml .codex/config.toml` пишет
 * поверхность так же, как `Write`.
 */
function judgeSurfaceWrite(op, ctx) {
    if (op.op === 'read' || !ctx.inLoop()) return null;
    const index = surfaceIndexIn(ctx);
    if (!index) return null;
    const removes = op.op === 'move' || op.op === 'delete';
    const sides = [op.path, ...(op.op === 'move' ? [op.destination] : [])];
    for (const side of sides) {
        const target = expandHome(side, ctx.vars);
        const hit = surfaceOf(target, op.baseDir, index, ctx.fsApi, removes && side === op.path);
        if (hit) return surfaceBlock(hit);
    }
    return null;
}

/**
 * Решение по одной операции события или null. `nested` — операция из `derived` MCP-вызова:
 * сетевой эффект параметров там блокируется и вне петли — до политики сети его не судит никто.
 */
function judgeOperation(op, ctx, nested) {
    switch (op.op) {
        case 'unknown':
            return unknownBlock(op);
        case 'exec': {
            const calls = shellCalls(op.command);
            const writes =
                shellWritesContourData(op.command, calls) ||
                (ctx.inLoop() ? moverTouchesData(calls, op.baseDir, ctx.fsApi) : null);
            if (writes === GIT_EXEC_INPUT && ctx.inLoop()) return gitExecBlock();
            if (writes && ctx.inLoop()) return contourBlock(writes);
            const index = ctx.inLoop() ? surfaceIndexIn(ctx) : null;
            const surface =
                index && shellWritesSurface(calls, op.baseDir, index, ctx.vars, ctx.fsApi);
            if (surface) return surfaceBlock(surface);
            return judgeShell(op.command, ctx.options);
        }
        case 'read':
        case 'write':
        case 'delete':
        case 'move':
            return judgeFileOperation(op, ctx.inLoop, ctx.fsApi) || judgeSurfaceWrite(op, ctx);
        case 'search':
            return judgeSearch(op, ctx.fsApi);
        case 'mcp': {
            const name = `mcp__${op.server}__${op.tool}`;
            if (!mcpEventAllowed(name, ctx.mcp)) return mcpBlock(name, ctx.mcp);
            for (const derived of op.derived) {
                const verdict = judgeOperation(derived, ctx, true);
                if (verdict) return verdict;
            }
            return null;
        }
        case 'fetch':
            return nested || ctx.inLoop() ? capabilityBlock('fetch', op.url) : null;
        case 'agent':
            return ctx.inLoop() ? delegationBlock(`Субагент (сессия ${op.parentSession})`) : null;
        case 'defer':
            return ctx.inLoop() ? delegationBlock(`Отложенный ход (${op.what})`) : null;
        case 'inert':
            return null;
        default:
            // Валидатор границы такую операцию не пропускает; дошла — барьер её не знает.
            return unknownBlock({ why: `незнакомая операция ${JSON.stringify(op.op)}` });
    }
}

/**
 * Решение по нормализованному событию (#186). Событие уже прошло валидатор границы
 * (`adapter-event.cjs`); здесь — правила. Первая запрещённая операция запрещает вызов целиком.
 *
 * `options` — как у `decide`: `contour`, `loop` и подмена окружения правила про kill; плюс
 * `fsApi` — чтение файловой системы для разрешения путей и обхода корня поиска (тесты).
 *
 * `surfaces` — поверхности конфига харнессов из контекста сессии (#199); `processEnv` —
 * окружение, от которого находятся дома CLI (по умолчанию окружение хука: его дал CLI сессии).
 *
 * Чего правило на событии НЕ судит, сказано вслух: поверхности конфига — только в сессии петли и
 * только при перечне в контексте; `fetch`, `agent` и `defer` блокируются только в сессии петли —
 * в сессии человека сеть, субагенты и отложенный ход остаются.
 */
function decideEvent(event, options = {}) {
    const contour = options.contour || emptyData();
    const ctx = {
        options,
        vars: options.processEnv || process.env,
        fsApi: options.fsApi || fs,
        mcp: { toolsDeclared: false, ...contour.mcp },
        inLoop: () => inLoopOf(options),
    };
    for (const op of event.operations) {
        const verdict = judgeOperation(op, ctx, false);
        if (verdict) return verdict;
    }
    return ALLOWED;
}

module.exports = {
    decide,
    decideEvent,
    globMayMatchEnv,
    ENV_FILE_RE,
    CMD_ENV_RE,
    mcpAllowed,
    mcpAllowedByEffect,
    mcpReadCall,
};

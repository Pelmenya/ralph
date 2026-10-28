// Guard у каждого харнесса: регистрация барьера в формате CLI и форма события инструмента
// (Фаза 16b, #119; отчёт стенда — `docs/install-stand.md`).
//
// Зачем. Проба барьера (`core/guard-probe.ts`) до этой карточки знала один формат — JSON
// settings Claude Code — и отвергала любой рантайм без Claude-хуков. Это был честный
// fail-closed, но с ним Codex вообще не мог работать в петле. Стенд Фазы 11 показал, что
// внешний блокирующий хук держат все четыре CLI, и у каждого — свой способ его
// зарегистрировать и своя форма вызова на входе хука. Здесь ровно эта разница; исполняемая
// часть барьера (`.claude/hooks/guard.cjs`, `skill-barrier.cjs`) общая.
//
// Что где различается, по стенду и по коду самих CLI:
//   • Claude Code — `--settings <файл>` с `"disableAllHooks": false` (собирает
//     `core/session-settings.ts`), событие — JSON на stdin;
//   • Codex 0.163 — `-c hooks.PreToolUse=[…]` в argv плюс `--dangerously-bypass-hook-trust`
//     (без него хук из `-c` молча не зовётся) и `--enable hooks` — защита в глубину: стенд
//     без `--ignore-user-config` показал, что `[features] hooks = false` в `.codex/config.toml`
//     снимает и хуки из `-c`. Под `--ignore-user-config` раннера недоверенный проектный конфиг
//     не грузится вовсе, но флаг держит барьер, если доверие к дереву появится иным путём.
//     Событие — форма Claude Code: `exec_command` приходит `tool_name: "Bash"` с одним
//     `command`. Файловых инструментов чтения у Codex нет — файл читается оболочкой, поэтому
//     и проба у него только через Bash. Пишет же Codex и своим `apply_patch`: хук на нём
//     зовётся (стенд #188), и регистрация Codex судится событием его нормализатора (#232),
//     который разбирает патч в запись, удаление и перенос по путям (#189);
//   • Kimi Code 2.3 — `[[hooks]]` в `config.toml` дома CLI (`KIMI_CODE_HOME`). Имена
//     инструментов — как у Claude Code, но путь у `Read`/`Grep`/`Write`/`Edit` — поле `path`,
//     а не `file_path`; matcher — регулярное выражение БЕЗ якорей (`new RegExp(m).test`);
//   • OpenCode 1.19 — команд-хуков нет, есть плагин с `tool.execute.before(input, output)`:
//     `input.tool` — `bash`/`read`/…, аргументы в `output.args` (`filePath`, а не
//     `file_path`). Плагин переводит вызов в форму Claude Code и зовёт ту же хук-команду;
//     брошенное исключение отменяет вызов. Упавший при загрузке плагин CLI пропускает
//     (стенд, `crash`), поэтому свои ошибки плагин ловит сам и бросает — блок, а не пропуск.
//     MCP-инструмент OpenCode называет `<сервер>_<инструмент>` без `mcp__` — плагин отдаёт
//     его барьеру именем `mcp__…`, которое правило MCP не пропускает (`opencodeClaudeToolName`).
//
// Формы событий — фикстуры `__fixtures__/hook-events.json`: Claude Code, Codex и Kimi
// сняты стендом живьём (обрезаны), OpenCode — живым прогоном своего адаптера (#121).
//
// TS-модуль без билд-шага (erasable-only), без побочек: строит тексты регистраций и читает
// их обратно. Исполняет хуки и плагин проба ядра.

import type { BarrierReasonCode } from './barrier-reason.ts';

/** Харнесс — CLI, который ведёт сессию. Ключи — те же, что `harness` у `RUNTIME_IDENTITIES`. */
export type Harness = 'claude-code' | 'codex' | 'kimi-code' | 'opencode';

export const HARNESSES: readonly Harness[] = ['claude-code', 'codex', 'kimi-code', 'opencode'];

/** Хук барьера в общей форме: регистрации всех харнессов строятся из неё. */
export type GuardHook = { matcher: string; command: string; timeoutSec: number };

/**
 * Вызов пробы в терминах харнесса: его имя инструмента и его форма аргументов. У
 * запрещённого — код причины, которым его обязан назвать барьер (#183): двойка без кода
 * или с кодом неисправности значит «барьер сломан и блокирует всё», а не «правило держит».
 */
export type HarnessProbe = {
    what: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    /**
     * Проба правила сессии петли (#232): хук получает контекст петли, как его получит сессия.
     * Забор данных контура вне петли не действует, и без контекста хук дерева пропустил бы
     * запрещённое — проба судила бы не то, что держит сессия.
     */
    loop?: true;
} & ({ expect: 'blocked'; reasonCode: BarrierReasonCode } | { expect: 'allowed' });

type ShellProbe = { what: string; command: string; reasonCode?: BarrierReasonCode };

const RM: ShellProbe = {
    what: 'рекурсивное удаление',
    command: 'rm -rf ./.ralph-guard-probe',
    reasonCode: 'destructive',
};
const CAT: ShellProbe = {
    what: 'чтение env-файла из оболочки',
    command: 'cat .env',
    reasonCode: 'secret-env',
};
const SED: ShellProbe = {
    what: 'чтение env-файла через sed',
    command: "sed -n '1,5p' .env",
    reasonCode: 'secret-env',
};
const SAFE: ShellProbe = { what: 'безобидная команда', command: 'git status' };

/**
 * MCP-мутация форжа: matcher канона накрывает MCP только префиксом `mcp__`, и харнесс, чьё имя
 * MCP-инструмента под него не подходит, прошёл бы мимо барьера при зелёной пробе (ревью
 * Фазы 16b). Сервер вымышленный — исполнять вызов некому.
 */
const MCP_DELETE: HarnessProbe = {
    what: 'MCP-мутация вне allowlist',
    toolName: 'mcp__ralph-guard-probe__DeleteRepository',
    toolInput: {},
    expect: 'blocked',
    reasonCode: 'mcp-not-allowed',
};

/**
 * Патч Codex (`apply_patch`, текст в `command`) — по одному на исход (#232). Запрещённый —
 * данные контура: guard на событии судит патч по путям нормализатора, а совместимый вход 16b
 * имя `apply_patch` пропускал, и проба без патча была зелёной на этой дыре. Разрешённый — пара:
 * без неё сломанный нормализатор, блокирующий любой патч, прошёл бы пробу. Текст — тот же, что
 * у `rule:apply_patch:contour-add` матрицы описания (сверяет тест пакета).
 */
const patchText = (target: string, line: string) =>
    ['*** Begin Patch', `*** Add File: ${target}`, line, '*** End Patch', ''].join('\n');
const CODEX_CONTOUR_PATCH: HarnessProbe = {
    what: 'патч данных контура в сессии петли',
    toolName: 'apply_patch',
    toolInput: { command: patchText('.claude/ralph/hooks.json', '+{}') },
    loop: true,
    expect: 'blocked',
    reasonCode: 'contour-data',
};
const CODEX_SAFE_PATCH: HarnessProbe = {
    what: 'безобидный патч в сессии петли',
    toolName: 'apply_patch',
    toolInput: { command: patchText('.ralph-guard-probe/allowed.txt', '+x') },
    loop: true,
    expect: 'allowed',
};

/** Проба оболочки: с кодом причины — запрещённая, без него — безобидная. */
const shell = (toolName: string, p: ShellProbe): HarnessProbe => {
    const base = { what: p.what, toolName, toolInput: { command: p.command } };
    return p.reasonCode
        ? { ...base, expect: 'blocked', reasonCode: p.reasonCode }
        : { ...base, expect: 'allowed' };
};

/**
 * Состав пробы у каждого харнесса — критерии задачи 6 (рекурсивное удаление, чтение
 * env-файла каждым путём, которым харнесс читает файл) и безобидная команда. Путь удаления —
 * заведомо несуществующий каталог: даже исполненная, проба там ничего не снесла бы.
 */
export const HARNESS_PROBES: Record<Harness, readonly HarnessProbe[]> = {
    'claude-code': [
        shell('Bash', RM),
        {
            what: 'чтение env-файла инструментом Read',
            toolName: 'Read',
            toolInput: { file_path: '.env' },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        shell('Bash', CAT),
        {
            // Grep читает СОДЕРЖИМОЕ файла (`output_mode: content`) — тот же путь к секрету,
            // что Read, другим инструментом (ревью Kimi).
            what: 'чтение env-файла инструментом Grep',
            toolName: 'Grep',
            toolInput: { pattern: '.', path: '.env', output_mode: 'content' },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        // `sed`/`awk` тоже читают файл, а список читающих команд у барьера потребителя их не
        // знал (ревью Kimi): проба из одного `cat` прошла бы при этой дыре.
        shell('Bash', SED),
        MCP_DELETE,
        shell('Bash', SAFE),
    ],
    // Стенд #188 показал, что хук Codex зовётся и на MCP (`mcp__<сервер>__<инструмент>`,
    // `harnesses/__fixtures__/codex-0.163.0-stand.json`). Нормализатор отображает такое имя в
    // операцию `mcp` раньше сверки с `toolMap`, и вердикт даёт политика контура — тот же
    // `mcp-not-allowed`, что у остальных. Дом сессии без серверов (#195) — второй слой, а не
    // замена пробы. Патч судится событием (#232).
    codex: [
        shell('Bash', RM),
        shell('Bash', CAT),
        shell('Bash', SED),
        MCP_DELETE,
        CODEX_CONTOUR_PATCH,
        shell('Bash', SAFE),
        CODEX_SAFE_PATCH,
    ],
    'kimi-code': [
        shell('Bash', RM),
        {
            what: 'чтение env-файла инструментом Read',
            toolName: 'Read',
            toolInput: { path: '.env' },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        shell('Bash', CAT),
        {
            what: 'чтение env-файла инструментом Grep',
            toolName: 'Grep',
            toolInput: { pattern: '.', path: '.env', output_mode: 'content' },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        shell('Bash', SED),
        // Kimi Code 2.3 называет MCP-инструмент так же, `mcp__<сервер>__<инструмент>`
        // (`MCP_NAME_PREFIX` в исходнике CLI); matcher у него без якорей.
        MCP_DELETE,
        shell('Bash', SAFE),
    ],
    opencode: [
        shell('bash', RM),
        {
            what: 'чтение env-файла инструментом read',
            toolName: 'read',
            toolInput: { filePath: '.env' },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        shell('bash', CAT),
        {
            what: 'чтение env-файла инструментом grep',
            toolName: 'grep',
            toolInput: { pattern: '.', path: '.env' },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        shell('bash', SED),
        {
            // Патч несёт пути в тексте (`patchText`), а не полем: без разбора Edit ушёл бы
            // барьеру без пути, и защищённые пути проверялись бы вхолостую (ревью Фазы 16b).
            what: 'правка env-файла патчем',
            toolName: 'apply_patch',
            toolInput: {
                patchText: '*** Begin Patch\n*** Update File: .env\n@@\n-A=1\n+A=2\n*** End Patch',
            },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        {
            // CLI режет путь патча `.trim()`; табуляция вокруг пути не уводит его мимо барьера.
            what: 'правка env-файла патчем с табуляцией вокруг пути',
            toolName: 'apply_patch',
            toolInput: {
                patchText:
                    '*** Begin Patch\n*** Update File:\t.env\t\n@@\n-A=1\n+A=2\n*** End Patch',
            },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        {
            // CLI делит патч на строки только по `\n`: `\r` после двоеточия остаётся в
            // заголовке и срезается `.trim()`, а не уводит строку из разбора барьера.
            what: 'правка env-файла патчем с возвратом каретки после двоеточия',
            toolName: 'apply_patch',
            toolInput: {
                patchText:
                    '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Update File:\r.env\n@@\n-A=1\n+A=2\n*** End Patch',
            },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        {
            // Путь элемента `edits[]` переводится как и путь верхнего уровня (ревью Фазы 16b).
            what: 'правка env-файла элементом multiedit',
            toolName: 'multiedit',
            toolInput: {
                filePath: 'a.ts',
                edits: [{ filePath: '.env', oldString: 'A=1', newString: 'A=2' }],
            },
            expect: 'blocked',
            reasonCode: 'secret-env',
        },
        {
            // Вложенные вызовы `batch` стендом не сверены — инструмент блокируется целиком.
            what: 'пакетный вызов batch',
            toolName: 'batch',
            toolInput: { tool_calls: [{ tool: 'bash', parameters: { command: RM.command } }] },
            expect: 'blocked',
            reasonCode: 'mcp-not-allowed',
        },
        {
            // Имя MCP у OpenCode — `<сервер>_<инструмент>`; форма чтения не даёт пропуска.
            what: 'MCP-вызов OpenCode',
            toolName: 'ralph-guard-probe_ListIssues',
            toolInput: {},
            expect: 'blocked',
            reasonCode: 'mcp-not-allowed',
        },
        shell('bash', SAFE),
    ],
};

/**
 * Накрывает ли matcher инструмент — по правилам харнесса. Claude Code: пустой и `*` — всё,
 * иначе регулярное выражение по имени ЦЕЛИКОМ. Kimi Code: пустой — всё, иначе выражение
 * без якорей. Codex своих правил не документирует, и берётся более узкое (с якорями):
 * проба обязана говорить «накрыт» только там, где он накрыт наверняка. Битый regex не
 * накрывает ничего: хук с ним не позвали бы и в сессии.
 */
export function harnessMatcherCovers(harness: Harness, matcher: unknown, toolName: string) {
    if (matcher === undefined || matcher === '') return true;
    if (typeof matcher !== 'string') return false;
    if (matcher === '*' && harness !== 'kimi-code') return true;
    try {
        const re = harness === 'kimi-code' ? new RegExp(matcher) : new RegExp(`^(?:${matcher})$`);
        return re.test(toolName);
    } catch {
        return false;
    }
}

/**
 * Вход хука в форме харнесса — по фикстурам `__fixtures__/hook-events.json`. Транскрипта у
 * пробы нет, хотя живое событие Codex его несёт: ветка барьера, которая его читает, — барьер
 * скиллов, а он в регистрации не-Claude харнессов не переносится (`guardHooksOf` ядра,
 * `SKILL_BARRIER_LIMIT`). `guard.cjs` транскрипт не читает, и проба без него судит то же,
 * что сессия.
 */
export function harnessHookPayload(
    harness: Exclude<Harness, 'opencode'>,
    probe: HarnessProbe,
    projectDir: string,
): string {
    const base = {
        session_id: 'ralph-guard-probe',
        hook_event_name: 'PreToolUse',
        cwd: projectDir,
        tool_name: probe.toolName,
        tool_input: probe.toolInput,
    };
    if (harness === 'codex') {
        return JSON.stringify({
            ...base,
            turn_id: 'ralph-guard-probe',
            permission_mode: 'bypassPermissions',
        });
    }
    if (harness === 'kimi-code') {
        return JSON.stringify({
            ...base,
            client_type: 'kimi_code_cli',
            tool_call_id: 'ralph-guard-probe',
        });
    }
    return JSON.stringify(base);
}

/** Событие плагина OpenCode: два аргумента `tool.execute.before`. */
export function opencodeEvent(probe: HarnessProbe): {
    input: Record<string, unknown>;
    output: Record<string, unknown>;
} {
    return {
        input: {
            tool: probe.toolName,
            sessionID: 'ralph-guard-probe',
            callID: 'ralph-guard-probe',
        },
        output: { args: probe.toolInput },
    };
}

// ── Codex: argv ──────────────────────────────────────────────────────────────────────

/**
 * Что барьер у Codex НЕ держит — строка старта рядом с «проба пройдена» (ревью Фазы 16b).
 * Оболочку и `apply_patch` (`tool_name: "apply_patch"`, патч в `tool_input.command`) guard судит
 * событием нормализатора пакета (#232): патч — по каждому пути записи, удаления и переноса. До
 * карточки регистрация шла совместимым входом 16b, который незнакомое имя пропускал, и при
 * `danger-full-access` кодер-сессий запись данных контура патчем проходила. Ввод в запущенный
 * процесс (`write_stdin`) хук не зовёт вовсе (стенд #188,
 * `harnesses/__fixtures__/codex-0.163.0-stand.json`), поэтому канал не судится, а выключен —
 * `CODEX_DISABLE_TTY` в той же регистрации (#190). Вызов MCP guard судит событием политикой
 * контура (проба `MCP_DELETE`), а серверы MCP и хуки проекта закрыты не хуком, а
 * сборщиком конфига (#195, `codex-home.ts`): свой дом сессии, `--ignore-user-config`
 * (`buildCodexArgs`) и недоверие проекту в argv — `.codex/` недоверенного проекта Codex 0.163 не
 * исполняет (стенд `S-own`, `S-guard`), а слой в дереве или предке preflight отвергает.
 */
export const CODEX_GUARD_LIMIT =
    'codex: ввод в процесс write_stdin хук не зовёт — канал выключен --disable unified_exec_tty; ' +
    'серверы MCP и хуки проекта закрыты своим домом сессии и недоверием проекту, слой .codex/ в ' +
    'дереве — отказ старта';

/**
 * Что не держат регистрации всех харнессов, кроме Claude Code, — строка старта (ревью Фазы
 * 16b). Барьер скиллов ищет вызов `Skill` в транскрипте, а транскрипта в форме Claude Code
 * эти CLI хуку не отдают, поэтому в их регистрацию он не переносится (`guardHooksOf` ядра).
 */
export const SKILL_BARRIER_LIMIT =
    'барьер скиллов не зарегистрирован — транскрипта с вызовом Skill CLI хуку не отдаёт, и ' +
    'правка файлов из таблицы скиллов без загрузки скилла не блокируется';

/** Флаги, без которых внешний хук Codex не держит (стенд): доверие и включение хуков. */
export const CODEX_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';
export const CODEX_ENABLE_HOOKS: readonly string[] = ['--enable', 'hooks'];
const CODEX_HOOKS_KEY = 'hooks.PreToolUse=';

/**
 * Ввод в запущенный процесс — канал мимо хука (#190). `write_stdin` Codex хуку не отдаёт ни
 * прямым вызовом, ни из code mode, а судить ввод нечем: строка в REPL Python или Node — код,
 * которого guard не видел. Перехвата нет, поэтому канал выключен: без TTY stdin процесса CLI
 * закрывает сам («stdin is closed for this session»), а этот флаг убирает `tty` из схемы
 * `exec_command` и отвергает `tty: true`. Стенд под argv петли (`L-tty-*`, `L-repl-*` в
 * `harnesses/__fixtures__/codex-0.163.0-stand.json`): оболочка, `python3 -i` и `node -i` ввода
 * не получают, тот же ввод в команде `exec_command` судит хук. `--disable unified_exec`
 * `write_stdin` не снимает, `--disable shell_tool` снял бы всю оболочку.
 */
export const CODEX_DISABLE_TTY: readonly string[] = ['--disable', 'unified_exec_tty'];
const CODEX_TTY_FEATURE = 'unified_exec_tty';

/**
 * Строка JSON — годная базовая строка TOML: экранирование `\"`, `\\`, `\n`, `\uXXXX` у них
 * общее, а `\/`, которого TOML не знает, `JSON.stringify` не выдаёт.
 */
const tomlString = (s: string) => JSON.stringify(s);

/**
 * Таймаут в целых секундах, не меньше одной: `Math.trunc` давал 0 на дробном таймауте меньше
 * секунды, а обратный разбор читает 0 как умолчание CLI (у Codex 600 с) — проба увидела бы
 * не тот таймаут, что получит CLI.
 */
const hookTimeoutSec = (h: GuardHook) => Math.max(1, Math.ceil(h.timeoutSec));

/** Аргументы `codex exec`, регистрирующие хуки барьера. */
export function codexGuardArgs(hooks: readonly GuardHook[]): string[] {
    const entries = hooks.map(
        (h) =>
            `{matcher=${tomlString(h.matcher)},hooks=[{type="command",command=${tomlString(h.command)},timeout=${hookTimeoutSec(h)}}]}`,
    );
    return [
        CODEX_HOOK_TRUST_FLAG,
        ...CODEX_ENABLE_HOOKS,
        ...CODEX_DISABLE_TTY,
        '-c',
        `${CODEX_HOOKS_KEY}[${entries.join(',')}]`,
    ];
}

/**
 * Встроенное значение TOML в JSON: ключи-идентификаторы берутся в кавычки, `=` становится
 * `:`, строки копируются как есть. Разбирается только то подмножество, которое пишет
 * `codexGuardArgs`; всё прочее — отказ разбора, а не догадка.
 */
function tomlInlineToJson(text: string): unknown {
    let out = '';
    for (let i = 0; i < text.length;) {
        const ch = text[i];
        if (ch === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        const id = /^[A-Za-z_][A-Za-z0-9_-]*(?=\s*=)/.exec(text.slice(i));
        if (id) {
            out += JSON.stringify(id[0]);
            i += id[0].length;
            while (text[i] === ' ') i += 1;
            out += ':';
            i += 1;
            continue;
        }
        out += ch;
        i += 1;
    }
    return JSON.parse(out);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Хуки из записей формы Claude Code (`{matcher, hooks: [{type, command, timeout}]}`). */
function hooksFromEntries(entries: unknown, defaultTimeoutSec: number): GuardHook[] {
    if (!Array.isArray(entries)) return [];
    const out: GuardHook[] = [];
    for (const entry of entries) {
        if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) continue;
        const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
        for (const hook of entry.hooks) {
            if (!isPlainObject(hook) || hook.type !== 'command') continue;
            if (typeof hook.command !== 'string' || hook.command.trim() === '') continue;
            const timeoutSec =
                typeof hook.timeout === 'number' && hook.timeout > 0
                    ? hook.timeout
                    : defaultTimeoutSec;
            out.push({ matcher, command: hook.command, timeoutSec });
        }
    }
    return out;
}

/**
 * Регистрация барьера, прочитанная из argv `codex exec`: хуки и то, чего не хватает, чтобы
 * Codex их позвал. Проба читает ровно тот argv, который уйдёт в CLI.
 */
export function codexGuardFromArgs(argv: readonly string[]): {
    hooks: GuardHook[];
    problems: string[];
} {
    const problems: string[] = [];
    if (!argv.includes(CODEX_HOOK_TRUST_FLAG)) {
        problems.push(
            `нет ${CODEX_HOOK_TRUST_FLAG}: Codex молча не зовёт недоверенный хук из -c (стенд, block при TRUST=0)`,
        );
    }
    const enabled = argv.some(
        (a, i) => a === CODEX_ENABLE_HOOKS[0] && argv[i + 1] === CODEX_ENABLE_HOOKS[1],
    );
    if (!enabled) {
        problems.push(
            'нет --enable hooks: при доверенном дереве `[features] hooks = false` в .codex/config.toml снял бы хуки',
        );
    }
    const hooks: GuardHook[] = [];
    argv.forEach((a, i) => {
        if (a !== '-c' || !argv[i + 1]?.startsWith(CODEX_HOOKS_KEY)) return;
        try {
            // Codex ждёт хук 600 с, если таймаут не задан; проба столько не ждёт, но и
            // блокирующим хук без таймаута не считает иначе — таймаут берётся как есть.
            hooks.push(
                ...hooksFromEntries(
                    tomlInlineToJson(argv[i + 1].slice(CODEX_HOOKS_KEY.length)),
                    600,
                ),
            );
        } catch (error) {
            problems.push(`-c ${CODEX_HOOKS_KEY}… не разобрался: ${(error as Error).message}`);
        }
    });
    problems.push(...codexTtyProblems(argv));
    return { hooks, problems };
}

/** Значения переопределений конфига в argv: `-c X`, `-cX`, `--config X`, `--config=X`. */
function codexConfigOverrides(argv: readonly string[]): string[] {
    const out: string[] = [];
    argv.forEach((a, i) => {
        if (a === '-c' || a === '--config') {
            if (argv[i + 1] !== undefined) out.push(argv[i + 1]);
        } else if (a.startsWith('--config=')) {
            out.push(a.slice('--config='.length));
        } else if (a.startsWith('-c') && !a.startsWith('--')) {
            out.push(a.slice(2));
        }
    });
    return out;
}

/** Ключ переопределения `key=value` по сегментам, без кавычек и пробелов у сегмента. */
const overrideKey = (override: string): string[] =>
    override
        .split('=')[0]
        .split('.')
        .map((seg) => seg.trim().replace(/^"(.*)"$/, '$1'));

/**
 * Канал ввода в процесс закрыт, только если флаг стоит и TTY после него не включён обратно
 * `--enable` (раздельно или `--enable=…`): у флагов Codex побеждает последнее слово.
 * Переопределение конфига (`-c`, `-cX`, `--config`, `--config=`) ключом
 * `features.unified_exec_tty` или всей таблицей `features` (`features={…}` — что она делает с
 * остальными признаками, стендом не сверено) — отказ при любом значении и месте: порядок `-c`
 * против `--disable` стендом не сверен. Другие ключи `features.*` канала не касаются. Argv
 * собирает сам раннер, так что это сторож от регрессии сборки, а не от чужого argv.
 */
function codexTtyProblems(argv: readonly string[]): string[] {
    let disabledAt = -1;
    argv.forEach((a, i) => {
        if (a === CODEX_DISABLE_TTY[0] && argv[i + 1] === CODEX_TTY_FEATURE) disabledAt = i;
    });
    if (disabledAt < 0) {
        return [
            `нет ${CODEX_DISABLE_TTY.join(' ')}: ввод в процесс write_stdin хук не зовёт, и с TTY он доходит до оболочки и REPL мимо барьера`,
        ];
    }
    const enabledAgain = argv.some(
        (a, i) =>
            i > disabledAt &&
            ((a === '--enable' && argv[i + 1] === CODEX_TTY_FEATURE) ||
                a === `--enable=${CODEX_TTY_FEATURE}`),
    );
    const overridden = codexConfigOverrides(argv).some((o) => {
        const key = overrideKey(o);
        return (
            key[0] === 'features' &&
            (key.length === 1 || (key.length === 2 && key[1] === CODEX_TTY_FEATURE))
        );
    });
    return enabledAgain || overridden
        ? [
              `${CODEX_TTY_FEATURE} переопределён рядом с ${CODEX_DISABLE_TTY.join(' ')}: ввод в процесс может быть открыт`,
          ]
        : [];
}

// ── Kimi Code: config.toml ───────────────────────────────────────────────────────────

/** Блоки `[[hooks]]` для `config.toml` дома Kimi Code. */
export function kimiHooksToml(hooks: readonly GuardHook[]): string {
    return hooks
        .map(
            (h) =>
                `[[hooks]]\nevent = "PreToolUse"\nmatcher = ${tomlString(h.matcher)}\n` +
                `command = ${tomlString(h.command)}\ntimeout = ${hookTimeoutSec(h)}\n`,
        )
        .join('\n');
}

// Kimi Code ждёт хук 30 секунд, если таймаут не задан (`DEFAULT_HOOK_TIMEOUT_SECONDS`).
const KIMI_DEFAULT_TIMEOUT_SEC = 30;

// Заголовок таблицы хуков в любой законной для TOML форме: пробелы внутри скобок, комментарий.
const HOOKS_HEADER = /^\[\[\s*hooks\s*\]\]\s*(?:#.*)?$/;

// Заголовок, который TOML и CLI могут принять за таблицу хуков: первый сегмент имени — `hooks`
// (`[hooks]`, `[hooks.x]`, `[["hooks"]]`). `\bhooks\b` в любом месте ловил и
// `[mcp.servers.git-hooks]`, и сессия отказывала с ложной причиной (ревью Фазы 16b).
const HOOKS_LIKE_HEADER = /^\[\[?\s*(?:hooks|"hooks"|'hooks')\s*[.\]]/;

// Ключ `hooks` на верхнем уровне (`hooks = [ … ]`, `hooks.x = …`): с дописанными `[[hooks]]` он
// дал бы повторный ключ, и CLI упал бы на разборе конфига — причину видно только в stderr.
const HOOKS_TOP_KEY = /^(?:hooks|"hooks"|'hooks')\s*[.=]/;

function tomlScalar(raw: string): string | number | null {
    const v = raw.trim();
    if (v.startsWith('"')) return JSON.parse(v) as string;
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
    if (/^[0-9]+$/.test(v)) return Number(v);
    return null;
}

/**
 * PreToolUse-хуки из `config.toml` Kimi Code. Разбор узкий — таблицы `[[hooks]]` с
 * плоскими `ключ = значение`; строка, которую он не понял внутри такой таблицы, — отказ:
 * хук, который проба не увидела, CLI мог бы позвать иначе, чем она думает. Заголовок с
 * первым сегментом `hooks`, не узнанный как `[[hooks]]`, — тоже отказ, а не чужая таблица:
 * точное сравнение строки теряло `[[hooks]] # …` и `[[ hooks ]]`, которые CLI позовёт. Ключ
 * `hooks` на верхнем уровне — отказ: дописанные `[[hooks]]` дали бы повторный ключ.
 */
export function kimiHooksFromToml(text: string): { hooks: GuardHook[]; problems: string[] } {
    const hooks: GuardHook[] = [];
    const problems: string[] = [];
    let cur: Record<string, string | number> | null = null;
    let topLevel = true;
    const flush = () => {
        if (!cur || cur.event !== 'PreToolUse') return;
        if (typeof cur.command !== 'string' || cur.command.trim() === '') return;
        hooks.push({
            matcher: typeof cur.matcher === 'string' ? cur.matcher : '',
            command: cur.command,
            timeoutSec:
                typeof cur.timeout === 'number' && cur.timeout > 0
                    ? cur.timeout
                    : KIMI_DEFAULT_TIMEOUT_SEC,
        });
    };
    text.split('\n').forEach((line, n) => {
        const t = line.trim();
        if (t === '' || t.startsWith('#')) return;
        if (t.startsWith('[')) {
            flush();
            topLevel = false;
            // `[[hooks]] # барьер` и `[[ hooks ]]` — тот же заголовок для TOML и для CLI.
            cur = HOOKS_HEADER.test(t) ? {} : null;
            if (!cur && HOOKS_LIKE_HEADER.test(t)) {
                problems.push(
                    `config.toml, строка ${n + 1}: заголовок «${t}» про hooks не разобран`,
                );
            }
            return;
        }
        if (topLevel && HOOKS_TOP_KEY.test(t)) {
            problems.push(
                `config.toml, строка ${n + 1}: ключ hooks на верхнем уровне — с [[hooks]] барьера ` +
                    'CLI получил бы повторный ключ; перенеси хуки в таблицы [[hooks]]',
            );
            return;
        }
        if (!cur) return;
        const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(t);
        let value: string | number | null = null;
        try {
            value = m ? tomlScalar(m[2]) : null;
        } catch {
            value = null;
        }
        if (!m || value === null) {
            problems.push(`config.toml, строка ${n + 1}: «${t}» в [[hooks]] не разобрана`);
            return;
        }
        cur[m[1]] = value;
    });
    flush();
    return { hooks, problems };
}

// ── OpenCode: плагин ─────────────────────────────────────────────────────────────────

/**
 * Встроенные инструменты OpenCode → имена Claude Code. Состав — `opencode debug agent build`
 * CLI 1.19.4 плюс инструменты, которые CLI включает по модели или версии (`apply_patch`,
 * `list`, `websearch`, …). Таблица ЗАКРЫТАЯ: инструмента вне неё CLI сам не определяет, значит,
 * он пришёл от MCP-сервера (`opencodeClaudeToolName`). Встроенный, которого здесь нет, станет
 * MCP-именем и будет заблокирован — отказ виден, а пропуск мимо барьера нет.
 *
 * `batch` (флаг `experimental.batch_tool`) в таблице нет намеренно: он исполняет вложенные
 * `tool_calls`, а зовёт ли CLI плагин на каждом из них, стендом не сверено — в 1.19.4 самого
 * инструмента нет, есть только флаг. Вне таблицы он уходит барьеру `mcp__batch` и блокируется
 * всегда (ревью Фазы 16b). `task` в таблице: субагент собирает инструменты тем же
 * `SessionTools.resolve`, что и сессия, и `tool.execute.before` зовётся на каждом его вызове
 * (исходник 1.19.4).
 */
export const OPENCODE_TOOL_NAMES: Readonly<Record<string, string>> = {
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    multiedit: 'MultiEdit',
    patch: 'Edit',
    apply_patch: 'Edit',
    grep: 'Grep',
    glob: 'Glob',
    list: 'LS',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    codesearch: 'CodeSearch',
    task: 'Task',
    todowrite: 'TodoWrite',
    todoread: 'TodoRead',
    skill: 'Skill',
    question: 'AskUserQuestion',
    lsp: 'LSP',
    invalid: 'Invalid',
    list_mcp_resources: 'ListMcpResourcesTool',
    list_mcp_resource_templates: 'ListMcpResourceTemplatesTool',
    read_mcp_resource: 'ReadMcpResourceTool',
};

/**
 * Ключи аргументов OpenCode → ключи Claude Code. Переводятся и у элементов `edits[]`
 * (`multiedit`): `guard-rules` и барьер скиллов читают `edits[].file_path`, и путь элемента,
 * оставшийся `filePath`, уводил бы правку мимо забора контура. Правило env-файлов у guard
 * смотрит только путь верхнего уровня, поэтому плагин судит путь каждого элемента ещё и
 * отдельным вызовом с `file_path` — как пути патча.
 */
export const OPENCODE_ARG_KEYS: Readonly<Record<string, string>> = {
    filePath: 'file_path',
    oldString: 'old_string',
    newString: 'new_string',
    replaceAll: 'replace_all',
};

/**
 * Имя Claude Code для инструмента OpenCode. Встроенный — по таблице. Остальное — MCP: CLI
 * называет его `sanitize(сервер) + "_" + sanitize(инструмент)` (исходник 1.19.4), без
 * `mcp__`, и matcher канона (`mcp__.*`) его не накрыл бы вовсе.
 *
 * Разрезать имя обратно на сервер и инструмент нельзя: `_` законен в обоих, и сервер
 * `foo_list` с инструментом `drop` выглядел бы чтением `list…`, которое правило MCP
 * пропускает. Поэтому имя уходит БЕЗ второго разделителя (`mcp__<имя>`, `__` внутри сжаты в
 * `_`): правило MCP не узнаёт в нём ни чтения, ни записи из allowlist и блокирует всегда.
 * MCP в сессии OpenCode закрыт целиком — сессия петли в трекер не ходит, у неё намерения.
 */
export function opencodeClaudeToolName(tool: string): string {
    return Object.hasOwn(OPENCODE_TOOL_NAMES, tool)
        ? OPENCODE_TOOL_NAMES[tool]
        : `mcp__${tool.replace(/_{2,}/g, '_')}`;
}

const PLUGIN_HOOKS_PREFIX = 'const HOOKS = ';

/**
 * Исходник плагина OpenCode, который зовёт хуки барьера. Каталог плагина — тот, что
 * раннер отдаёт CLI переменной `OPENCODE_CONFIG_DIR` (`prepareOpencodeSession`, #121).
 *
 * Плагин fail-closed сам, строже CLI с командными хуками. Упавший при загрузке плагин CLI
 * пропускает, поэтому загрузка ничего не бросает, а любая ошибка разбора внутри события —
 * брошенное исключение, то есть отменённый вызов. Хук пропускает вызов только кодом 0:
 * код 2 — блок с его причиной, а любой другой код, сигнал, срок и отказ запуска — тоже блок.
 * У Kimi и Codex упавший хук вызов пропускает (#120), но плагин — наш код, и держать в нём
 * «упал → пропустить» незачем.
 *
 * Хук идёт асинхронным `spawn`: `spawnSync` в обработчике стоял бы на event loop всего
 * процесса OpenCode — стрим ответа и соседние вызовы — до срока каждого хука.
 *
 * Хук, вышедший нулём, ещё может блокировать JSON-ответом в форме Claude Code
 * (`hookSpecificOutput.permissionDecision: "deny"`, `decision: "block"`, `continue: false`):
 * так пишут хуки потребителя, а `guardHooksOf` переносит их вместе с каноническими. Плагин
 * читает stdout и считает такой ответ отказом (ревью Фазы 16b); stdout, который не JSON, —
 * не решение. У Codex и Kimi Code JSON-решение исполняет сам CLI, и понимает ли он его,
 * стенд не сверял: хуки канона блокируют кодом 2 и от этого не зависят.
 *
 * Патч (`patch`, `apply_patch`) несёт пути в `patchText` заголовками `*** … File:`; плагин
 * судит каждый путь отдельным вызовом `Edit`, а патч без единого пути — блок: Edit без пути
 * прошёл бы проверки защищённых путей вхолостую. Патч без `patchText` строкой — тоже блок:
 * MCP-сервер `apply` с инструментом `patch` CLI назовёт `apply_patch`, и такое имя совпадёт со
 * встроенным — без этого блока вызов ушёл бы барьеру одним `Edit` без пути. Это предел
 * закрытой таблицы, и он назван: MCP-имя, совпавшее со встроенным, судится как встроенный
 * (`read` + `mcp_resource` станет `ReadMcpResourceTool`); чьё имя побеждает в реестре CLI,
 * стенд не сверял. Разбор повторяет CLI (1.19.4, `mD`): строки
 * только по `\n`, заголовок — `startsWith`, путь — `slice(16).trim()`. Любое расхождение —
 * путь, который пишет CLI, но не видит барьер: табуляция у края оставалась в пути барьера, а
 * регекс с флагом `m` делил строки ещё и по `\r`/`\u2028` и не находил `*** Update File:\r.env`
 * вовсе (ревью Фазы 16b).
 *
 * Предел назван: вердикт выносится по `output.args` в момент вызова плагина, а плагин,
 * исполняемый после него, может эти args переписать. Каталог `OPENCODE_CONFIG_DIR` CLI
 * обходит последним (после `.opencode` дерева и дома — исходник 1.19.4), и плагины дерева
 * грузятся раньше барьера; но порядок вызова обработчиков и место плагинов-пакетов из
 * `"plugin": [...]` конфигов стендом не сверены.
 */
export function opencodeGuardPlugin(hooks: readonly GuardHook[]): string {
    return `// Сгенерировано раннером Ralph (adapters/harness-guard.ts) — правка руками теряется.
import { spawn } from 'node:child_process';
${PLUGIN_HOOKS_PREFIX}${JSON.stringify(hooks)};
const TOOLS = ${JSON.stringify(OPENCODE_TOOL_NAMES)};
const KEYS = ${JSON.stringify(OPENCODE_ARG_KEYS)};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const renameKeys = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) out[own(KEYS, k) ? KEYS[k] : k] = v;
    return out;
};
const toolName = (t) => (own(TOOLS, t) ? TOOLS[t] : 'mcp__' + String(t).replace(/_{2,}/g, '_'));
const covers = (m, t) => m === '' || m === '*' || new RegExp('^(?:' + m + ')$').test(t);
const PATCH_HEADS = ['*** Add File:', '*** Update File:', '*** Delete File:', '*** Move to:'];
const patchPaths = (text) =>
    text.split('\\n').flatMap((line) => {
        const head = PATCH_HEADS.find((h) => line.startsWith(h));
        return head === undefined ? [] : [line.slice(head.length).trim()];
    });
const runHook = (h, dir, payload) =>
    new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(r);
        };
        let child;
        try {
            // Своя группа процессов: по сроку гасится вся группа, а не один \`sh\` — его
            // ребёнок (\`node guard.cjs\`) иначе оставался бы сиротой на каждом зависшем вызове.
            child = spawn('sh', ['-c', h.command], {
                cwd: dir,
                detached: true,
                env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            finish({ error });
            return;
        }
        let stderr = '';
        let stdout = '';
        timer = setTimeout(() => {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                child.kill('SIGKILL');
            }
            finish({ error: new Error('хук не ответил за ' + h.timeoutSec + ' с') });
        }, h.timeoutSec * 1000);
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (c) => (stderr += c));
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (c) => (stdout += c));
        child.on('error', (error) => finish({ error }));
        child.on('close', (status, signal) => finish({ status, signal, stderr, stdout }));
        child.stdin.on('error', () => {});
        child.stdin.end(payload);
    });
// JSON-решение хука в форме Claude Code: код 0 с отказом в stdout — тоже отказ.
const jsonDenial = (stdout) => {
    let o;
    try {
        o = JSON.parse(stdout);
    } catch {
        return undefined;
    }
    if (!o || typeof o !== 'object') return undefined;
    const spec = o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {};
    if (spec.permissionDecision === 'deny')
        return String(spec.permissionDecisionReason || o.reason || 'вызов отклонён хуком (permissionDecision: deny)');
    if (o.decision === 'block') return String(o.reason || 'вызов заблокирован хуком (decision: block)');
    if (o.continue === false) return String(o.stopReason || 'хук остановил сессию (continue: false)');
    return undefined;
};
const verdict = (h, r) => {
    if (r.error) return 'хук «' + h.command + '» не исполнился (' + (r.error.message || r.error) + ')';
    if (r.status === 0) return jsonDenial((r.stdout || '').trim());
    if (r.status === 2) return (r.stderr || '').trim() || 'вызов заблокирован барьером';
    return 'хук «' + h.command + '» упал (' + (r.status === null ? 'сигнал ' + r.signal : 'код ' + r.status) +
        ((r.stderr || '').trim() ? ': ' + r.stderr.trim().slice(0, 300) : '') + ')';
};
export const RalphGuard = async (ctx) => ({
    'tool.execute.before': async (input, output) => {
        let reason;
        try {
            // Каталог сессии OpenCode отдаёт плагину сам; нет его — судить не о чем.
            const dir = ctx && (ctx.directory || ctx.worktree);
            if (!dir) throw new Error('OpenCode не назвал каталог сессии');
            const name = toolName(input.tool);
            const args = renameKeys(output && output.args);
            if (Array.isArray(args.edits))
                args.edits = args.edits.map((e) => (e && typeof e === 'object' ? renameKeys(e) : e));
            let calls = [args];
            // Патч без текста — не патч, который судит разбор ниже, а Edit без пути.
            if ((input.tool === 'patch' || input.tool === 'apply_patch') && typeof args.patchText !== 'string')
                throw new Error('патч без patchText — путей файла нет');
            if (typeof args.patchText === 'string') {
                // Патч разбирается, как его разбирает CLI: строки только по \`\\n\`, заголовок —
                // \`startsWith\`, путь — \`.trim()\`. Регекс с флагом \`m\` делил строки ещё и по
                // \`\\r\`/\`\\u2028\`, и \`.env\` после такого символа уходил мимо барьера.
                const paths = patchPaths(args.patchText);
                if (paths.length === 0) throw new Error('в патче нет ни одного пути файла');
                if (paths.includes('')) throw new Error('в патче пустой путь файла');
                calls = paths.map((p) => ({ ...args, file_path: p }));
            }
            // Свой путь элемента \`edits[]\` судится и отдельным вызовом с \`file_path\`:
            // правило защищённых путей у Claude Code смотрит только путь верхнего уровня.
            if (Array.isArray(args.edits)) {
                for (const e of args.edits)
                    if (e && typeof e.file_path === 'string') calls.push({ ...args, file_path: e.file_path });
            }
            for (const tool_input of calls) {
                const payload = JSON.stringify({
                    session_id: input.sessionID ?? '',
                    hook_event_name: 'PreToolUse',
                    cwd: dir,
                    tool_name: name,
                    tool_input,
                });
                for (const h of HOOKS) {
                    if (!covers(h.matcher, name)) continue;
                    reason = verdict(h, await runHook(h, dir, payload));
                    if (reason !== undefined) break;
                }
                if (reason !== undefined) break;
            }
        } catch (error) {
            reason = 'ralph-guard: плагин барьера неисправен (' + ((error && error.message) || error) +
                ') — вызов заблокирован fail-closed';
        }
        if (reason !== undefined) throw new Error(reason);
    },
});
`;
}

/** Хуки, зашитые в плагин: проба сверяет, что плагин зовёт барьер, а не пустой список. */
export function opencodeHooksFromPlugin(source: string): {
    hooks: GuardHook[];
    problems: string[];
} {
    const line = source.split('\n').find((l) => l.startsWith(PLUGIN_HOOKS_PREFIX));
    if (!line) return { hooks: [], problems: ['в плагине нет списка хуков барьера'] };
    try {
        const raw = JSON.parse(
            line.slice(PLUGIN_HOOKS_PREFIX.length).replace(/;\s*$/, ''),
        ) as unknown;
        const hooks = (Array.isArray(raw) ? raw : []).filter(
            (h): h is GuardHook =>
                isPlainObject(h) &&
                typeof h.matcher === 'string' &&
                typeof h.command === 'string' &&
                h.command.trim() !== '' &&
                typeof h.timeoutSec === 'number' &&
                h.timeoutSec > 0,
        );
        return { hooks, problems: [] };
    } catch (error) {
        return {
            hooks: [],
            problems: [`список хуков плагина не разобрался: ${(error as Error).message}`],
        };
    }
}

/**
 * Драйвер пробы плагина: грузит исходник, зовёт `tool.execute.before` каждого экспорта и
 * выходит 2, если вызов отменён, 0 — если пропущен, 3 — если плагин не загрузился (CLI
 * такой плагин пропускает, стенд `crash`). Вход — JSON на stdin.
 */
export const OPENCODE_PLUGIN_DRIVER = `
let s = '';
for await (const c of process.stdin) s += c;
const { source, input, output, directory } = JSON.parse(s);
let mod;
try {
    mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
} catch (e) {
    process.stderr.write('плагин не загрузился: ' + String((e && e.message) || e));
    process.exit(3);
}
for (const f of Object.values(mod)) {
    if (typeof f !== 'function') continue;
    const hooks = await f({ directory, worktree: directory });
    const fn = hooks && hooks['tool.execute.before'];
    if (typeof fn !== 'function') continue;
    try {
        await fn(input, output);
    } catch (e) {
        process.stderr.write(String((e && e.message) || e));
        process.exit(2);
    }
}
process.exit(0);
`;

// Settings сессии петли собирает раннер из доверенных источников (Фаза 12, задача 101).
//
// Зачем. До этой задачи сессия брала хуки из `.claude/settings.json` того дерева, в котором
// работала, — то есть из ветки фазы, которую сама же и правит. Код под проверкой мог
// ослабить собственную проверку: поправить guard, снять matcher, положить в настройки
// `"disableAllHooks": true` (стенд Фазы 11, `docs/install-stand.md`: проектный выключатель
// снимает и внешний хук). Проба барьера при этом гонялась только перед первой сессией, и
// правка, легшая посреди фазы, жила до рестарта.
//
// Как. Перед КАЖДОЙ сессией раннер собирает файл и отдаёт его CLI флагом `--settings`:
//   • канонические PreToolUse-хуки (`CANON_SESSION_HOOKS`) — абсолютным путём в каталог
//     ядра, который исполняется сейчас (установленная ревизия), а не в дерево сессии;
//   • данные контура (`.claude/ralph/hooks.json`) — из дерева человека (`consumerRoot`):
//     путь уходит хуку переменной `RALPH_HOOKS_DATA` прямо в его команде;
//   • остальное — `.claude/settings.json` дерева человека как есть, со всеми его хуками:
//     собранный файл не теряет хуков потребителя (`SessionStart`, `PostToolUse`, свои
//     PreToolUse), он к ним добавляет;
//   • `"disableAllHooks": false` — настройки командной строки старше проектных, и
//     выключатель в дереве сессии внешний хук больше не снимает (решение стенда);
//   • контракт запуска `RALPH_CORE_SHA` — ревизия установки ядра (`resolveCoreSha`) — тоже
//     в команде канонического хука (#132): хук узнаёт петлю по нему и сверяет себя с этой
//     ревизией, и проба на собранном идёт с тем же контрактом — хук другой ревизии
//     блокирует безобидное, и раннер не стартует. У ядра не из установки (копия в дереве
//     потребителя) своего git может не быть: тогда контракта нет, о чём старт говорит
//     строкой, а барьер скиллов включает переключатель (`coreShaPolicy`).
//
// Почему контракт в команде хука, а не в окружении сессии. Окружение сессии наследуют ВСЕ
// её хуки, в том числе зарегистрированные настройками дерева сессии
// (`${CLAUDE_PROJECT_DIR}/.claude/hooks`, их Claude Code складывает с нашими). На каноне
// это хуки ветки фазы: под контрактом первая же сессия, тронувшая хук, блокировала бы
// себе всё; у потребителя этот каталог — вовсе не репозиторий ядра, и `git ls-tree`
// ревизии ядра там отказывает на каждом вызове. Контракт получают ровно те хуки, которые
// раннер зарегистрировал из установки, — а их сверка и есть то, что контракт обещает.
// Затем отрицательная проба (`guard-probe.ts`) на СОБРАННОМ файле: запрещённое обязано
// быть заблокировано, безобидное — пропущено. Не прошла — сессия не стартует.
//
// Исполняемые слои дерева сессии не исполняются (#194). До карточки Claude Code читал и
// проектные настройки дерева сессии: хуки PR складывались с нашими и исполнялись, серверы
// `.mcp.json` в режиме `-p` одобрялись сами. Теперь (бинарь 2.1.312, условия — в
// `docs/install-stand.md`):
//   • источники настроек сняты (`--setting-sources ''`): ни пользовательских, ни проектных,
//     ни локальных хуков, плагинов и команд; читаются только `--settings` и managed-настройки.
//     Снять одни хуки, оставив источник, можно только managed-ключом `allowManagedHooksOnly`, а
//     конфиг хоста петля не правит;
//   • MCP — строгий конфиг раннера (`--strict-mcp-config --mcp-config`) из `.mcp.json` дерева
//     человека: `.mcp.json` дерева сессии, `~/.claude.json` и MCP плагинов отброшены;
//   • без проектного источника CLI теряет `CLAUDE.md` и скиллы `.claude/skills` — раннер
//     отдаёт их сам и из дерева человека: правила — `--append-system-prompt-file`, скиллы —
//     плагином в каталоге сессии (`ralph:<скилл>`, его узнаёт барьер скиллов);
//   • хук человека, названный через `${CLAUDE_PROJECT_DIR}`, привязан к дереву человека
//     (`anchorHookEntry`): CLI подставил бы дерево сессии, и правленый в ветке хук исполнился бы
//     следующей сессией. Прежнее удвоение (тот же хук из собранного файла и из проектных
//     настроек worktree) ушло вместе с проектным источником.
// Пределы названы. `CLAUDE.md` вложенных каталогов CLI сам больше не подгружает — их читает
// модель, как велит корневой. Импорты `@path` в `CLAUDE.md` CLI раскрывает только у файла из
// проектного источника, а флаг отдаёт файл текстом: строку `@docs/x.md` модель видит буквально и
// сама файл не получает. Раннер импорты не раскрывает — правило, которое должно дойти до сессии,
// пишется в `CLAUDE.md` текстом или ссылкой, которую модель прочтёт. Относительная команда хука человека и относительный путь в
// `args` его MCP-сервера идут от cwd сессии: разбирать чужую строку оболочки раннер не берётся.
// MCP человека, заведённый только в `~/.claude.json`, сессия не получает — источник MCP раннера
// один, `.mcp.json` дерева человека.
//
// Итоговый MCP сверяется с доверенным у всех харнессов (#198). Allowlist контура судит сервер
// по имени, а одноимённый сервер с другой командой мог объявить слой, который CLI сливает мимо
// раннера, — глобальный каталог конфига OpenCode, дом CLI, argv. Поэтому после записи каждый
// сборщик читает обратно ВСЁ, откуда CLI этой сессии возьмёт MCP, и сверяет каждый сервер с
// `.mcp.json` дерева человека по команде, адресу и хешу записи (`adapters/mcp-trust.ts`). Без
// раскладки корней доверенного нет, и любой сервер — отказ. Расхождение и нечитаемый итог —
// отказ старта с именем сервера и источника, а не сессия на чужом сервере.
//
// Файл settings лежит в каталоге состояния: сессия, умеющая писать куда угодно на хосте,
// может его поправить, но перед следующей сессией он собирается заново, а проба гоняется на
// свежесобранном.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import {
    CODEX_HARNESS,
    codexArgsProblems,
    CORE_SHA_ENV,
    GUARD_ADAPTER_ENV,
    GUARD_INPUT_ENV,
    HOOK_COMMAND_ONLY_ENV,
    HOOKS_DATA_ENV,
    KIMI_NATIVE_HARNESS,
    OPENCODE_HARNESS,
    guardHooksOf,
    guardInputOf,
    harnessLayerProblems,
    kimiTomlProblems,
    opencodePluginProblems,
    probeProblems,
    runHook,
    sessionContextProblems,
    runOpencodePlugin,
    type TLayersFn,
    type TRunHookFn,
    type TRunPluginFn,
} from './guard-probe.ts';
// Переменные команды хука живут в `guard-probe.ts`: проба снимает их все с окружения хука, а
// импорт отсюда замкнул бы цикл модулей. Потребителям они по-прежнему отсюда.
export { CORE_SHA_ENV, GUARD_ADAPTER_ENV, HOOK_COMMAND_ONLY_ENV, HOOKS_DATA_ENV };
import { codexGuardArgs, opencodeGuardPlugin } from '../adapters/harness-guard.ts';
import {
    HARNESS_REGISTRY,
    normalizerPathIn,
    SESSION_SETTINGS_HARNESS,
    type HarnessRegistry,
} from '../adapters/harness-registry.ts';
import { KIMI_HOME_LINKS, kimiSessionConfig } from '../adapters/kimi-native.ts';
import { KIMI_SESSION_MCP } from '../adapters/kimi-home.ts';
import {
    CODEX_HOME_LINKS,
    CODEX_SESSION_CONFIG,
    codexProjectKeys,
    codexUntrustArgs,
} from '../adapters/codex-home.ts';
import {
    OPENCODE_BIN,
    OPENCODE_GUARD_PLUGIN_FILE,
    expectedOpencodeSkills,
    opencodeSkillProblems,
} from '../adapters/opencode.ts';
import {
    opencodeSessionConfig,
    opencodeSessionConfigLayers,
    opencodeSessionEnv,
    opencodeSessionXdg,
} from '../adapters/opencode-home.ts';
import {
    codexArgvMcpServers,
    codexTomlMcpServers,
    jsonMcpServers,
    mcpServersOf,
    mcpTrustProblems,
    opencodeMcpServers,
    type TMcpServers,
} from '../adapters/mcp-trust.ts';
import { stripGitContext } from './consumer-tree.ts';
import { writeFileAtomic } from './roots.ts';

/**
 * Канонические PreToolUse-хуки сессии петли. Matcher'ы — те же, что в `.claude/settings.json`
 * канона: их совпадение сверяет тест, иначе два списка разъехались бы на первой правке.
 *
 * Guard накрывает ВСЕ инструменты (#186): незнакомое — запрет, а инструмент, до которого хук
 * не дошёл, барьер не видит вовсе — `Monitor` с командой оболочки шёл мимо прежнего перечня
 * имён. `.*`, а не `*`: перечень переносится и в регистрации Codex и Kimi Code
 * (`guardHooksOf`), а у Kimi matcher — регулярное выражение без якорей, где `*` не разбирается
 * и не накрывает ничего. Таймаут — с запасом над сроком нормализатора пакета
 * (`adapter-event.cjs`): хук, убитый CLI по сроку, у PreToolUse не блокирует.
 */
export const CANON_SESSION_HOOKS: readonly {
    file: string;
    matcher: string;
    timeout: number;
    /** Хук судит событие нормализатора пакета (#186): регистрация несёт путь его команды. */
    adapter?: boolean;
}[] = [
    { file: 'guard.cjs', matcher: '.*', timeout: 30, adapter: true },
    { file: 'skill-barrier.cjs', matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', timeout: 10 },
];

/**
 * Переключатель барьера скиллов (читает `skill-barrier.cjs`). Раннер ставит его сессиям в
 * раскладке без `roots`: контракта там нет, и без переключателя барьер молча снят.
 */
export const SKILL_GUARD_ENV = 'RALPH_SKILL_GUARD';

/**
 * Значение `RALPH_GUARD_ADAPTER` для ядра `productRoot`: путь нормализатора пакета харнесса
 * настроек из реестра. Пакет не принят — значение-причина: она не абсолютный путь, guard на
 * ней блокирует всё кодом `adapter-failed`, и проба перед сессией называет причину стопом, а не
 * пускает сессию на совместимом входе молча.
 */
export function guardAdapterValue(
    productRoot: string,
    registry: HarnessRegistry = HARNESS_REGISTRY,
): string {
    const found = normalizerPathIn(registry, SESSION_SETTINGS_HARNESS, productRoot);
    return found.ok ? found.path : `пакет не принят: ${found.reason}`;
}

// Та же форма, что у `core-revision.cjs`: полный SHA, а не сокращение и не имя ветки.
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const SETTINGS_REL = path.join('.claude', 'settings.json');
const HOOKS_DATA_REL = path.join('.claude', 'ralph', 'hooks.json');

/** Строка в одинарных кавычках оболочки: команда хука исполняется через `sh -c`. */
export function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Команда канонического хука: файл из каталога ядра, данные контура из дерева человека,
 * контракт запуска — ревизия этого ядра. Пустая ревизия — ядро-копия без своего git
 * (`coreShaPolicy`): контракта нет, и барьер скиллов включается переключателем, иначе в
 * сессиях петли он был бы снят молча. `RALPH_CORE_SHA` тогда ставится пустым ЯВНО: env
 * сессии — окружение раннера, и значение, унаследованное из окружения запуска или
 * env-файла, заставило бы хук сверять себя с чужой ревизией и блокировать всё, а стоп
 * назвал бы причиной пробу барьера, а не окружение.
 */
export function canonHookCommand(
    productRoot: string,
    file: string,
    humanRoot: string,
    coreSha: string,
    adapter?: string,
): string {
    const data = path.join(humanRoot, HOOKS_DATA_REL);
    const hook = path.join(productRoot, '.claude', 'hooks', file);
    const loop =
        coreSha === ''
            ? `${CORE_SHA_ENV}='' ${SKILL_GUARD_ENV}=${shellQuote('on')}`
            : `${CORE_SHA_ENV}=${shellQuote(coreSha)}`;
    const event = adapter === undefined ? '' : ` ${GUARD_ADAPTER_ENV}=${shellQuote(adapter)}`;
    return `${loop} ${HOOKS_DATA_ENV}=${shellQuote(data)}${event} node ${shellQuote(hook)}`;
}

/** Исход git-вызова в каталоге: код, stdout, stderr. */
export type TGitInDirFn = (
    dir: string,
    args: string[],
) => { status: number | null; stdout: string; stderr: string };

const gitInDir: TGitInDirFn = (dir, args) => {
    guardSideEffect(`git -C ${dir} ${args.join(' ')}`, 'Подмени gitFn в тесте.');
    // `GIT_DIR` и родня сильнее `-C`: унаследованные, они увели бы вопрос о ревизии ядра
    // в чужой репозиторий, и ответ был бы правдоподобным SHA не той установки.
    const env = stripGitContext(process.env);
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env, timeout: 10_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || String(r.error ?? '') };
};

export type TCoreSha = { ok: true; sha: string } | { ok: false; reason: string; why: string };

/**
 * Ревизия установки ядра — значение контракта `RALPH_CORE_SHA`. Хук сверяет себя через
 * `git ls-tree` в своём каталоге, поэтому установка обязана быть git-репозиторием с этой
 * ревизией (клон или worktree), и сверяется это здесь, до первой сессии. Корень
 * репозитория обязан совпасть с каталогом ядра: распакованный `git archive` внутри чужого
 * репозитория (домашний каталог под git) иначе отдал бы HEAD соседа, и отказ всплыл бы
 * блоком каждого вызова в сессии, а не причиной на старте.
 */
export function resolveCoreSha(
    productRoot: string,
    {
        gitFn = gitInDir,
        realpathFn = (p: string) => fs.realpathSync(p),
    }: { gitFn?: TGitInDirFn; realpathFn?: (p: string) => string } = {},
): TCoreSha {
    const refuse = (why: string): TCoreSha => ({
        ok: false,
        why,
        reason:
            `Ревизия ядра ${productRoot} не определена: ${why}. Хуки сессии сверяют себя с ` +
            `ревизией через git (${CORE_SHA_ENV}), поэтому установка ядра обязана быть ` +
            'git-репозиторием (клон или worktree) — старт отменён.',
    });
    const top = gitFn(productRoot, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) return refuse(`не git-репозиторий (${top.stderr.trim()})`);
    let same: boolean;
    try {
        same = realpathFn(top.stdout.trim()) === realpathFn(productRoot);
    } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
    }
    if (!same) return refuse(`корень репозитория — ${top.stdout.trim()}, а не каталог ядра`);
    const head = gitFn(productRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const sha = head.stdout.trim();
    if (head.status !== 0 || !SHA_RE.test(sha)) {
        return refuse(`HEAD не читается (${head.stderr.trim() || sha})`);
    }
    return { ok: true, sha };
}

/**
 * Что делать, если ревизия ядра не определилась. Ядро из УСТАНОВКИ (манифест, lock) обязано
 * быть git-репозиторием — `./ralph install` кладёт его чекаутом, — и там это стоп. Ядро не
 * из установки — копия в дереве потребителя (`.claude/ralph`) или клон — до #132 шло без
 * контракта, и такая раскладка законна (`roots.ts`: продукт внутри потребителя). Для неё
 * отказ — не стоп, а громкая деградация: хуки из ядра без `RALPH_CORE_SHA` (самосверки
 * ревизии нет, как до #132), барьер скиллов — переключателем. Хуки при этом берутся из
 * дерева человека, а не из дерева сессии, которое правит PR (ревью Фазы 12: стоп здесь
 * ронял каждую копию ядра с `roots`, включая песочницу живого цикла).
 */
export function coreShaPolicy(
    resolved: TCoreSha,
    installed: boolean,
):
    | { kind: 'contract'; sha: string }
    | { kind: 'refuse'; reason: string }
    | { kind: 'no-contract'; note: string } {
    if (resolved.ok) return { kind: 'contract', sha: resolved.sha };
    if (installed) return { kind: 'refuse', reason: resolved.reason };
    return {
        kind: 'no-contract',
        note:
            `ядро не из установки и его ревизия не определена (${resolved.why}) — хуки из ` +
            `ядра идут без контракта ${CORE_SHA_ENV} и с ревизией себя не сверяют; барьер ` +
            `скиллов включён переключателем ${SKILL_GUARD_ENV}=on`,
    };
}

/** Строка лога старта о том, откуда сессия получает settings, — у каждой раскладки своя. */
export function describeSessionSettingsStart(
    roots: { productRoot: string; humanRoot: string; coreSha: string } | null,
): string {
    if (roots === null) {
        return (
            '🧷 Settings сессии не собирается: секции roots нет — сессии идут на настройках ' +
            'своего дерева, проба барьера только на старте; контракта RALPH_CORE_SHA ' +
            `нет, барьер скиллов включён переменной ${SKILL_GUARD_ENV}=on в env сессии`
        );
    }
    const contract = roots.coreSha ? `${CORE_SHA_ENV}=${roots.coreSha}` : 'без контракта ревизии';
    return (
        `🧷 Settings сессии: хуки из ядра ${roots.productRoot} (${contract}), контур, MCP, ` +
        `скиллы и правила из ${roots.humanRoot}; источники настроек дерева сессии сняты; ` +
        'собирается и проходит пробу перед каждой сессией'
    );
}

/**
 * Строка отчёта `--doctor` о проверке старта вне контракта совместимости. `warn` — старт
 * пройдёт, но с деградацией: маркер ставит `runDoctor`, а не текст строки, иначе выходило
 * «✅ ⚠ …» — галочка и предупреждение разом (ревью Фазы 12).
 */
export type TDoctorLine = { ok: boolean; warn?: boolean; line: string };

/**
 * Те же проверки, которыми старт с `roots` отказывает до первой сессии, — для `--doctor`:
 * ревизия установки (`resolveCoreSha`) и settings дерева человека (`readHumanSettings`).
 * Обе только читают. Без них doctor был зелёным там, где следующий же старт падал на
 * ревизии ядра (ревью Фазы 12), — а проверка, которую doctor показывает зелёной, а старт
 * отвергает, учит человека не верить обеим (`compat.ts`). Пробы барьера здесь нет: она
 * исполняет хуки, а doctor — режим только для чтения; её отказ называет старт.
 */
export function sessionStartChecks({
    productRoot,
    humanRoot,
    installed,
    resolveCoreShaFn = resolveCoreSha,
    readHumanSettingsFn = readHumanSettings,
}: {
    productRoot: string;
    humanRoot: string;
    /** Ядро из установки: ревизия обязательна (`coreShaPolicy`). */
    installed: boolean;
    resolveCoreShaFn?: (productRoot: string) => TCoreSha;
    readHumanSettingsFn?: (humanRoot: string) => Record<string, unknown>;
}): TDoctorLine[] {
    const policy = coreShaPolicy(resolveCoreShaFn(productRoot), installed);
    const lines: TDoctorLine[] = [
        policy.kind === 'contract'
            ? { ok: true, line: `ревизия ядра ${productRoot}: ${policy.sha} (${CORE_SHA_ENV})` }
            : policy.kind === 'refuse'
              ? { ok: false, line: policy.reason }
              : { ok: true, warn: true, line: policy.note },
    ];
    try {
        readHumanSettingsFn(humanRoot);
        lines.push({ ok: true, line: `settings дерева человека ${humanRoot} читаются` });
    } catch (error) {
        lines.push({
            ok: false,
            line:
                `Settings сессии не собран: ${error instanceof Error ? error.message : String(error)} ` +
                '— старт будет отменён.',
        });
    }
    return lines;
}

/**
 * Все проверки старта вне слоёв для `--doctor`: расхождение `roots.productRoot` с исполняемым
 * ядром (`productRootMismatch`, строку отказа считает вызывающий) и, при заданных `roots`,
 * `sessionStartChecks`. Без `roots` settings не собирается, и проверять там нечего.
 */
export function doctorStartChecks({
    productRootDrift,
    productRoot,
    humanRoot,
    installed,
    sessionStartChecksFn = sessionStartChecks,
}: {
    productRootDrift: string | null;
    productRoot: string;
    humanRoot: string | null;
    installed: boolean;
    sessionStartChecksFn?: typeof sessionStartChecks;
}): TDoctorLine[] {
    return [
        ...(productRootDrift ? [{ ok: false, line: productRootDrift }] : []),
        ...(humanRoot === null ? [] : sessionStartChecksFn({ productRoot, humanRoot, installed })),
    ];
}

/**
 * Settings дерева человека. Файла нет — пустой объект: потребитель без своих настроек
 * получает только канонические хуки. Файл есть, но битый или не той формы — исключение:
 * собрать сессии «настройки без хуков потребителя» значило бы молча потерять их барьеры.
 */
export function readHumanSettings(
    humanRoot: string,
    readFileFn: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): Record<string, unknown> {
    const file = path.join(humanRoot, SETTINGS_REL);
    let text: string;
    try {
        text = readFileFn(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
        throw new Error(
            `${file} не прочитан (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(
            `${file} — не JSON (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    if (!isPlainObject(raw)) throw new Error(`${file} — не объект`);
    if (raw.hooks !== undefined) {
        if (!isPlainObject(raw.hooks)) throw new Error(`${file}: hooks — не объект`);
        for (const [event, entries] of Object.entries(raw.hooks)) {
            if (!Array.isArray(entries)) throw new Error(`${file}: hooks.${event} — не список`);
        }
    }
    return raw;
}

// `${CLAUDE_PROJECT_DIR}` и `$CLAUDE_PROJECT_DIR` — CLI подставляет их сам, деревом сессии.
const PROJECT_DIR_REF = /\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR(?![A-Za-z0-9_])/g;
// Путь, который встаёт в команду как есть — и в двойных кавычках, и без них.
const PLAIN_PATH_RE = /^\/[A-Za-z0-9._/@+-]*$/;

/**
 * Хук человека, названный через `${CLAUDE_PROJECT_DIR}`, — файлом ДЕРЕВА ЧЕЛОВЕКА (#194).
 * CLI подставляет в команду дерево сессии, а это дерево правит PR: правленый в ветке фазы
 * `.claude/hooks/*.cjs` исполнялся бы следующей же сессией, хотя запись о хуке взята из
 * доверенного дерева. Переменная окружения хука остаётся деревом сессии — хук по-прежнему
 * работает с ним (так `sync-docs.cjs` пересобирает копию доков там, где правили источник), но
 * его код — из дерева, которое не правится сессией. Путь, требующий экранирования, в команду
 * вставлять нельзя (кавычки команды писал потребитель) — отказ, а не тихое дерево сессии.
 * Относительная команда (`node .claude/hooks/x.cjs`) остаётся от cwd сессии — это предел:
 * разбирать чужую строку оболочки раннер не берётся.
 */
function anchorHookEntry(entry: unknown, humanRoot: string): unknown {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return entry;
    return {
        ...entry,
        hooks: entry.hooks.map((hook) => {
            if (!isPlainObject(hook) || typeof hook.command !== 'string') return hook;
            if (!hook.command.match(PROJECT_DIR_REF)) return hook;
            if (!PLAIN_PATH_RE.test(humanRoot)) {
                throw new Error(
                    `хук человека «${hook.command}» назван через CLAUDE_PROJECT_DIR, а путь ` +
                        `дерева человека ${humanRoot} требует экранирования — привязать хук к ` +
                        'нему нельзя, а дерево сессии исполнило бы код, который правит PR',
                );
            }
            return { ...hook, command: hook.command.replace(PROJECT_DIR_REF, () => humanRoot) };
        }),
    };
}

/**
 * Собранный settings сессии. Чистая функция: тот же вход — тот же объект. Списки хуков
 * потребителя копируются, а не делятся: правка собранного не трогает прочитанного. Хуки
 * человека, названные через `${CLAUDE_PROJECT_DIR}`, привязаны к его дереву
 * (`anchorHookEntry`); путь, который привязать нельзя, — исключение.
 */
export function buildSessionSettings({
    productRoot,
    humanRoot,
    coreSha,
    humanSettings,
}: {
    productRoot: string;
    humanRoot: string;
    coreSha: string;
    humanSettings: Record<string, unknown>;
}): Record<string, unknown> {
    const humanHooks = isPlainObject(humanSettings.hooks) ? humanSettings.hooks : {};
    const hooks: Record<string, unknown[]> = {};
    for (const [event, entries] of Object.entries(humanHooks)) {
        hooks[event] = Array.isArray(entries)
            ? entries.map((entry) => anchorHookEntry(entry, humanRoot))
            : [];
    }
    hooks.PreToolUse = [
        ...(hooks.PreToolUse ?? []),
        ...CANON_SESSION_HOOKS.map(({ file, matcher, timeout, adapter }) => ({
            matcher,
            hooks: [
                {
                    type: 'command',
                    command: canonHookCommand(
                        productRoot,
                        file,
                        humanRoot,
                        coreSha,
                        adapter ? guardAdapterValue(productRoot) : undefined,
                    ),
                    timeout,
                },
            ],
        })),
    ];
    return { ...humanSettings, hooks, disableAllHooks: false };
}

/**
 * Имя плагина, которым раннер отдаёт сессии скиллы дерева человека (#194). CLI зовёт скилл
 * плагина `<имя>:<папка>`, и барьер скиллов узнаёт этот префикс (`SESSION_SKILL_PLUGIN` в
 * `skill-barrier.cjs`, совпадение сверяет тест).
 */
export const SESSION_SKILL_PLUGIN = 'ralph';

/**
 * Источники настроек сессии Claude Code — ни одного (#194). Проверено по бинарю 2.1.312:
 * пользовательский, проектный и локальный источники несут хуки (`hooks`), команды
 * (`statusLine`, `apiKeyHelper`), плагины (`enabledPlugins`), а проектный ещё и одобряет
 * серверы `.mcp.json` в режиме `-p` сам; снять одни хуки, оставив источник, можно только
 * managed-настройками хоста (`allowManagedHooksOnly`), а их петля не правит. Командная строка
 * (`--settings`) и managed-настройки читаются при любом списке. Вместе с проектным источником
 * CLI теряет `CLAUDE.md` и скиллы `.claude/skills` — их раннер отдаёт сам, из дерева человека
 * (`claudeSessionArgs`). Пустой список — `''` отдельным элементом argv, как `--tools ''`.
 */
export const CLAUDE_SESSION_SOURCES_ARGS: readonly string[] = ['--setting-sources', ''];

const MCP_REL = '.mcp.json';
const SKILLS_REL = path.join('.claude', 'skills');
const INSTRUCTIONS_FILE = 'CLAUDE.md';

/**
 * MCP-конфиг сессии из `.mcp.json` дерева человека (#194). Файла нет — ни одного сервера.
 * Битый файл или запись не той формы — исключение: «серверов нет» по нечитаемому файлу сняло
 * бы MCP-чтения контура молча. Сервер с относительной командой — тоже отказ: CLI порождает
 * его от cwd сессии, то есть кодом дерева, которое правит PR. Относительный путь в `args`
 * (`node scripts/server.js`) так не распознать — это предел, названный в доке пакета.
 */
export function readHumanMcpConfig(
    humanRoot: string,
    readFileFn: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): { mcpServers: Record<string, unknown> } {
    const file = path.join(humanRoot, MCP_REL);
    let text: string;
    try {
        text = readFileFn(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { mcpServers: {} };
        throw new Error(
            `${file} не прочитан (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(
            `${file} — не JSON (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    if (!isPlainObject(raw)) throw new Error(`${file} — не объект`);
    const servers = raw.mcpServers ?? {};
    if (!isPlainObject(servers)) throw new Error(`${file}: mcpServers — не объект`);
    for (const [name, server] of Object.entries(servers)) {
        if (!isPlainObject(server)) throw new Error(`${file}: mcpServers.${name} — не объект`);
        const cmd = server.command;
        if (typeof cmd === 'string' && cmd.includes('/') && !path.isAbsolute(cmd)) {
            throw new Error(
                `${file}: mcpServers.${name}.command «${cmd}» — относительный путь: CLI порождает ` +
                    'сервер от каталога сессии, то есть кодом дерева, которое правит PR',
            );
        }
    }
    return { mcpServers: { ...servers } };
}

/**
 * Доверенные серверы MCP (#198): `.mcp.json` дерева человека — то, что прошло ревью. Без раскладки
 * корней дерева человека нет, и доверенных серверов нет: раннер своих не отдаёт.
 */
export function trustedMcpServers(
    roots: { humanRoot: string } | null,
    readFileFn: (p: string) => string,
): TMcpServers {
    if (!roots) return {};
    return mcpServersOf(
        readHumanMcpConfig(roots.humanRoot, readFileFn),
        path.join(roots.humanRoot, MCP_REL),
    );
}

/** Один источник итогового MCP сессии: где CLI его возьмёт и как его разобрать. */
export type TMcpSource = {
    file: string;
    parse: (text: string, where: string) => TMcpServers;
    /** Файла может не быть (слой, который CLI читает, если он есть). Без флага нет файла — отказ. */
    optional?: boolean;
};

/**
 * Итоговый MCP сессии против доверенного (#198): каждый источник читается обратно — то, что
 * возьмёт CLI, а не то, что раннер собирался записать. Отказ — причина строкой, `null` — сошлось.
 */
export function sessionMcpRefusal(
    cli: string,
    {
        roots,
        sources,
        extra = {},
        extraSource = '',
    }: {
        roots: { humanRoot: string } | null;
        sources: readonly TMcpSource[];
        /** Серверы не из файла (argv Codex). */
        extra?: TMcpServers;
        extraSource?: string;
    },
    readFileFn: (p: string) => string,
): string | null {
    const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const problems: string[] = [];
    let trusted: TMcpServers;
    try {
        trusted = trustedMcpServers(roots, readFileFn);
    } catch (error) {
        return `Доверенный MCP-конфиг для сессии ${cli} не прочитан: ${why(error)} — старт отменён.`;
    }
    problems.push(...mcpTrustProblems(extra, trusted, extraSource));
    for (const source of sources) {
        let text: string;
        try {
            text = readFileFn(source.file);
        } catch (error) {
            if (source.optional && (error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
            problems.push(`${source.file}: итоговый MCP-конфиг не прочитан (${why(error)})`);
            continue;
        }
        try {
            problems.push(
                ...mcpTrustProblems(source.parse(text, source.file), trusted, source.file),
            );
        } catch (error) {
            problems.push(`${why(error)} — итоговый MCP-конфиг не разобран`);
        }
    }
    if (problems.length === 0) return null;
    return (
        `Итоговый MCP-конфиг сессии ${cli} разошёлся с доверенным (.mcp.json дерева человека) — ` +
        'сессия не запущена:\n' +
        problems.map((p) => `  - ${p}`).join('\n')
    );
}

/** Что собрано для сессии Claude Code: из этого `claudeSessionArgs` строит argv. */
export type TClaudeSession = {
    /** Собранный settings (`--settings`). */
    settings: string;
    /** Строгий MCP-конфиг раннера (`--mcp-config`). */
    mcpConfig: string;
    /** Плагин скиллов дерева человека; `null` — скиллов у человека нет. */
    pluginDir: string | null;
    /** `CLAUDE.md` дерева человека; `null` — файла нет. */
    instructions: string | null;
};

/**
 * Аргументы сессии Claude Code из собранного (#194). Источники настроек сняты; MCP — только
 * конфиг раннера (`--strict-mcp-config` отбрасывает `.mcp.json` дерева, `~/.claude.json` и MCP
 * плагинов); скиллы — плагином, правила — `CLAUDE.md` дерева человека. Сессия без инструментов
 * (`toolless`, #217) не получает ни серверов, ни скиллов: её `--strict-mcp-config` без
 * `--mcp-config` уже стоит в argv, и второй конфиг вернул бы ей серверы.
 */
export function claudeSessionArgs(
    session: TClaudeSession,
    { toolless = false }: { toolless?: boolean } = {},
): string[] {
    const args = ['--settings', session.settings, ...CLAUDE_SESSION_SOURCES_ARGS];
    if (session.instructions !== null) {
        args.push('--append-system-prompt-file', session.instructions);
    }
    if (toolless) return args;
    args.push('--strict-mcp-config', '--mcp-config', session.mcpConfig);
    if (session.pluginDir !== null) args.push('--plugin-dir', session.pluginDir);
    return args;
}

/** Копия каталога скиллов в плагин; `false` — источника нет. Боевая — побочка. */
export type TSyncSkillsFn = (src: string, dst: string) => boolean;

const syncSkills: TSyncSkillsFn = (src, dst) => {
    guardSideEffect(`копия скиллов ${src} → ${dst}`, 'Подмени syncSkillsFn в тесте.');
    fs.rmSync(dst, { recursive: true, force: true });
    if (!fs.existsSync(src)) return false;
    // Копия, а не ссылка: загрузчик плагина отвергает симлинк на файл скилла, а ссылка на
    // каталог человека делала бы плагин окном в его дерево.
    fs.cpSync(src, dst, { recursive: true, dereference: true });
    return true;
};

/** Запись файла сессии: каталог сессии и плагина создаются по пути. Боевая — побочка. */
function writeSessionFile(p: string, text: string): void {
    guardSideEffect(`запись ${p}`, 'Подмени writeFileFn в тесте.');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, text);
}

export type TSessionSettingsDeps = {
    readFileFn?: (p: string) => string;
    writeFileFn?: (p: string, text: string) => void;
    runHookFn?: TRunHookFn;
    syncSkillsFn?: TSyncSkillsFn;
    existsFn?: (p: string) => boolean;
};

export type TPreparedSettings =
    { ok: true; path: string; session: TClaudeSession } | { ok: false; reason: string };

/**
 * Сборка, запись и проба перед сессией. Отказ — причина строкой, а не исключение: стоп с
 * ней делает вызывающий. Проба идёт на собранном объекте ДО записи: файл, не прошедший
 * пробу, не должен лечь туда, откуда его возьмёт следующая сессия. Рядом, в каталоге сессии
 * (`sessionDir`), — MCP-конфиг и плагин скиллов (#194): они пишутся после пробы, и отказ
 * любого из них — отказ сессии, а не сессия без MCP-контура или скиллов.
 */
export function prepareSessionSettings(
    {
        productRoot,
        humanRoot,
        coreSha,
        sessionTree,
        outPath,
        sessionDir,
        sessionContext,
    }: {
        productRoot: string;
        humanRoot: string;
        coreSha: string;
        sessionTree: string;
        outPath: string;
        /** Каталог сессии Claude Code в состоянии экземпляра: MCP-конфиг и плагин скиллов. */
        sessionDir: string;
        /** Контекст сессии (#184), который раннер даст ей в окружение: его обязан получить каждый guard. */
        sessionContext: string;
    },
    {
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        writeFileFn = writeSessionFile,
        runHookFn = runHook,
        syncSkillsFn = syncSkills,
        existsFn = (p) => fs.existsSync(p),
    }: TSessionSettingsDeps = {},
): TPreparedSettings {
    let settings: Record<string, unknown>;
    let mcp: { mcpServers: Record<string, unknown> };
    try {
        const humanSettings = readHumanSettings(humanRoot, readFileFn);
        settings = buildSessionSettings({ productRoot, humanRoot, coreSha, humanSettings });
        mcp = readHumanMcpConfig(humanRoot, readFileFn);
    } catch (error) {
        return {
            ok: false,
            reason:
                `Settings сессии не собран: ${error instanceof Error ? error.message : String(error)}. ` +
                'Без настроек дерева человека сессия потеряла бы хуки и MCP-контур потребителя — ' +
                'старт отменён.',
        };
    }
    const problems = [
        ...probeProblems(settings, sessionTree, { runHookFn }),
        ...sessionContextProblems(settings, sessionTree, sessionContext, { runHookFn }),
    ];
    if (problems.length > 0) {
        return {
            ok: false,
            reason:
                'Проба барьера перед сессией не прошла — сессия не запущена:\n' +
                problems.map((p) => `  - ${p}`).join('\n') +
                `\nХуки — из ядра ${productRoot} (ревизия ${coreSha || 'без контракта'}), контур и настройки — ` +
                `из ${humanRoot}.`,
        };
    }
    try {
        writeFileFn(outPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (error) {
        return {
            ok: false,
            reason: `Settings сессии не записан в ${outPath} (${error instanceof Error ? error.message : String(error)}).`,
        };
    }
    const mcpConfig = path.join(sessionDir, 'mcp.json');
    const plugin = path.join(sessionDir, 'plugin');
    let pluginDir: string | null;
    try {
        writeFileFn(mcpConfig, `${JSON.stringify(mcp, null, 2)}\n`);
        const copied = syncSkillsFn(path.join(humanRoot, SKILLS_REL), path.join(plugin, 'skills'));
        if (copied) {
            writeFileFn(
                path.join(plugin, '.claude-plugin', 'plugin.json'),
                `${JSON.stringify({ name: SESSION_SKILL_PLUGIN, description: 'Скиллы дерева человека для сессии петли' }, null, 2)}\n`,
            );
        }
        pluginDir = copied ? plugin : null;
    } catch (error) {
        return {
            ok: false,
            reason:
                `Каталог сессии ${sessionDir} не собран (${error instanceof Error ? error.message : String(error)}): ` +
                'без него сессия шла бы без MCP-контура раннера или без скиллов.',
        };
    }
    // #198: `--strict-mcp-config` оставляет CLI один источник — этот файл, и он читается обратно.
    const mcpRefused = sessionMcpRefusal(
        'Claude Code',
        { roots: { humanRoot }, sources: [{ file: mcpConfig, parse: jsonMcpServers }] },
        readFileFn,
    );
    if (mcpRefused) return { ok: false, reason: mcpRefused };
    const instructionsPath = path.join(humanRoot, INSTRUCTIONS_FILE);
    return {
        ok: true,
        path: outPath,
        session: {
            settings: outPath,
            mcpConfig,
            pluginDir,
            instructions: existsFn(instructionsPath) ? instructionsPath : null,
        },
    };
}

type TGuardRoots = { productRoot: string; humanRoot: string; coreSha: string } | null;

/**
 * Настройки, из которых строится регистрация барьера НЕ-Claude харнесса: при раскладке
 * корней — собранные (хуки из установки ядра, контур и хуки человека), без неё —
 * `.claude/settings.json` дерева сессии. Те же, что получила бы сессия Claude Code: барьер
 * у харнессов один, различается только его регистрация.
 */
function guardSettingsFor(
    roots: TGuardRoots,
    sessionTree: string,
    readFileFn: (p: string) => string,
): unknown {
    return roots
        ? buildSessionSettings({
              ...roots,
              humanSettings: readHumanSettings(roots.humanRoot, readFileFn),
          })
        : JSON.parse(readFileFn(path.join(sessionTree, SETTINGS_REL)));
}

/** Исход подготовки регистрации Codex: аргументы `codex exec` либо причина отказа. */
export type TPreparedCodexGuard = { ok: true; args: string[] } | { ok: false; reason: string };

/**
 * Регистрация барьера для сессии Codex (#119) и проба на ней перед КАЖДОЙ сессией — то же
 * правило, что у `--settings` Claude Code. Хуки берутся из тех же настроек, что получила бы
 * сессия Claude Code: при раскладке корней — собранные (хуки из установки ядра, контур и
 * хуки человека), без неё — `.claude/settings.json` дерева сессии. Codex этих настроек сам не
 * читает: без регистрации в argv его сессия шла бы без барьера, о чём до карточки и
 * говорил отказ пробы старта. Проба идёт на ТОМ argv, который уйдёт в CLI. Судит регистрацию
 * событие нормализатора пакета Codex (#232), а не совместимый вход 16b: тот `apply_patch` не
 * судил, и запись данных контура патчем проходила.
 */
export function prepareCodexGuardArgs(
    {
        roots,
        sessionTree,
    }: {
        roots: { productRoot: string; humanRoot: string; coreSha: string } | null;
        sessionTree: string;
    },
    {
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        runHookFn = runHook,
        registry = HARNESS_REGISTRY,
    }: Pick<TSessionSettingsDeps, 'readFileFn' | 'runHookFn'> & {
        registry?: HarnessRegistry;
    } = {},
): TPreparedCodexGuard {
    let settings: unknown;
    try {
        settings = guardSettingsFor(roots, sessionTree, readFileFn);
    } catch (error) {
        return {
            ok: false,
            reason:
                `Хуки для сессии Codex не собраны: ${error instanceof Error ? error.message : String(error)}. ` +
                'Без них сессия Codex шла бы без барьера — старт отменён.',
        };
    }
    // Судит регистрацию событие нормализатора Codex (#232): путь — в каталоге исполняемого ядра,
    // как у пути Claude Code в собранных настройках (`guardAdapterValue`).
    const input = guardInputOf(registry, CODEX_HARNESS, roots?.productRoot);
    const args = codexGuardArgs(guardHooksOf(settings, sessionTree, input));
    const problems = codexArgsProblems(args, sessionTree, { runHookFn, registry });
    if (problems.length > 0) {
        return {
            ok: false,
            reason:
                'Проба барьера Codex перед сессией не прошла — сессия не запущена:\n' +
                problems.map((p) => `  - ${p}`).join('\n'),
        };
    }
    return { ok: true, args };
}

/** Работа с ссылками входа в доме CLI сессии — общая у Kimi Code и Codex. */
type THomeLinkDeps = {
    existsFn: (p: string) => boolean;
    entryKindFn: (p: string) => 'missing' | 'link' | 'other';
    unlinkFn: (p: string) => void;
    linkFn: (target: string, link: string) => void;
};

/**
 * Ссылки дома сессии на вход человека. Ссылка снимается ВСЕГДА и ставится заново, только если
 * цель есть: ссылка на пропавший у человека файл иначе висела бы с прошлой сессии. Настоящий
 * файл или каталог на месте ссылки (CLI создал его сам, пока ссылки не было) раннер не удаляет —
 * там может лежать вход, — а называет: отказ строкой, `null` — ссылки на месте.
 */
function linkHomeEntries(
    {
        cli,
        home,
        sourceHome,
        names,
    }: { cli: string; home: string; sourceHome: string; names: readonly string[] },
    { existsFn, entryKindFn, unlinkFn, linkFn }: THomeLinkDeps,
): string | null {
    for (const name of names) {
        const target = path.join(sourceHome, name);
        const link = path.join(home, name);
        const kind = entryKindFn(link);
        if (kind === 'other') {
            return (
                `В доме ${cli} сессии ${link} — настоящий файл или каталог, а не ссылка на ` +
                `${target}: его создал CLI, пока ссылки не было, и вход человека сессия за ним ` +
                'не увидит. Перенеси нужное в дом человека и удали его — раннер вход не удаляет.'
            );
        }
        if (kind === 'link') unlinkFn(link);
        if (existsFn(target)) linkFn(target, link);
    }
    return null;
}

const defaultEntryKind = (p: string): 'missing' | 'link' | 'other' => {
    try {
        return fs.lstatSync(p).isSymbolicLink() ? 'link' : 'other';
    } catch {
        return 'missing';
    }
};

/** Исход подготовки сессии Codex: argv барьера и недоверия, дом для `CODEX_HOME`. */
export type TPreparedCodexSession =
    { ok: true; args: string[]; home: string; keys: string[] } | { ok: false; reason: string };

export type TCodexSessionDeps = Pick<
    TSessionSettingsDeps,
    'readFileFn' | 'writeFileFn' | 'runHookFn'
> &
    Partial<THomeLinkDeps> & {
        mkdirFn?: (p: string) => void;
        layersFn?: TLayersFn;
        registry?: HarnessRegistry;
    };

/**
 * Сессия Codex перед КАЖДЫМ спавном (#195): регистрация барьера с пробой
 * (`prepareCodexGuardArgs`), отказ на исполняемых слоях `.codex/` в дереве и предках, недоверие
 * проекту в argv и свой дом CLI в каталоге состояния (`adapters/codex-home.ts`): `config.toml`
 * без доверия, хуков и MCP и вход человека ссылкой. Дом человека не читается и не пишется —
 * только цель ссылки входа. Всё до записи: не прошедшая сессия ничего не кладёт.
 */
export function prepareCodexSession(
    {
        roots,
        sessionTree,
        home,
        sourceHome,
        env,
    }: {
        roots: TGuardRoots;
        sessionTree: string;
        home: string;
        sourceHome: string | null;
        env: NodeJS.ProcessEnv;
    },
    {
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        writeFileFn = (p, text) => writeFileAtomic(p, text),
        runHookFn = runHook,
        existsFn = (p) => fs.existsSync(p),
        entryKindFn = defaultEntryKind,
        unlinkFn = (p) => {
            guardSideEffect(`prepareCodexSession:unlink(${p})`, 'Подмени unlinkFn в тесте.');
            fs.unlinkSync(p);
        },
        mkdirFn = (p) => {
            guardSideEffect(`prepareCodexSession:mkdir(${p})`, 'Подмени mkdirFn в тесте.');
            fs.mkdirSync(p, { recursive: true, mode: 0o700 });
        },
        linkFn = (target, link) => {
            guardSideEffect(`prepareCodexSession:symlink(${link})`, 'Подмени linkFn в тесте.');
            fs.symlinkSync(target, link);
        },
        layersFn,
        registry = HARNESS_REGISTRY,
    }: TCodexSessionDeps = {},
): TPreparedCodexSession {
    const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
    // Вход guard, проба регистрации и слои судятся одним реестром: подменённый в тесте, он
    // проверяет тот же путь, что пройдёт сессия.
    const guard = prepareCodexGuardArgs(
        { roots, sessionTree },
        { readFileFn, runHookFn, registry },
    );
    if (!guard.ok) return guard;
    const layers = harnessLayerProblems(CODEX_HARNESS, sessionTree, env, {
        registry,
        ...(layersFn ? { layersFn } : {}),
    });
    if (layers.length > 0) {
        return {
            ok: false,
            reason:
                'Исполняемые слои конфига Codex в дереве сессии или его предках — сессия не запущена:\n' +
                layers.map((p) => `  - ${p}`).join('\n'),
        };
    }
    let keys: string[];
    try {
        keys = codexProjectKeys(sessionTree, readFileFn);
    } catch (error) {
        return {
            ok: false,
            reason: `Недоверие проекту Codex не собрано: ${why(error)}. Без него хуки и MCP дерева исполнились бы.`,
        };
    }
    if (sourceHome !== null && path.resolve(sourceHome) === path.resolve(home)) {
        return {
            ok: false,
            reason: `Дом сессии Codex ${home} совпал с домом человека — доверие легло бы в его конфиг.`,
        };
    }
    try {
        mkdirFn(home);
        writeFileFn(path.join(home, 'config.toml'), CODEX_SESSION_CONFIG);
        if (sourceHome !== null) {
            const refused = linkHomeEntries(
                { cli: 'Codex', home, sourceHome, names: CODEX_HOME_LINKS },
                { existsFn, entryKindFn, unlinkFn, linkFn },
            );
            if (refused) return { ok: false, reason: refused };
        }
    } catch (error) {
        return { ok: false, reason: `Дом Codex сессии не собран в ${home} (${why(error)}).` };
    }
    const args = [...guard.args, ...codexUntrustArgs(keys)];
    // #198: MCP Codex — переопределения argv и `config.toml` дома. Под `--ignore-user-config`
    // файл CLI не читает, но сверяется и он: флаг снимает чужая версия сборки, а не сессия.
    let argvServers: TMcpServers;
    try {
        argvServers = codexArgvMcpServers(args);
    } catch (error) {
        return {
            ok: false,
            reason: `MCP в argv Codex не разобран: ${why(error)} — старт отменён.`,
        };
    }
    const mcpRefused = sessionMcpRefusal(
        'Codex',
        {
            roots,
            sources: [{ file: path.join(home, 'config.toml'), parse: codexTomlMcpServers }],
            extra: argvServers,
            extraSource: 'argv codex exec',
        },
        readFileFn,
    );
    if (mcpRefused) return { ok: false, reason: mcpRefused };
    return { ok: true, args, home, keys };
}

/** Исход подготовки дома Kimi Code: каталог для `KIMI_CODE_HOME` либо причина отказа. */
export type TPreparedKimiHome = { ok: true; home: string } | { ok: false; reason: string };

export type TKimiHomeDeps = Pick<
    TSessionSettingsDeps,
    'readFileFn' | 'writeFileFn' | 'runHookFn'
> & {
    registry?: HarnessRegistry;
    existsFn?: (p: string) => boolean;
    /** Что лежит на месте ссылки в доме сессии: ничего, ссылка или настоящий файл/каталог. */
    entryKindFn?: (p: string) => 'missing' | 'link' | 'other';
    unlinkFn?: (p: string) => void;
    mkdirFn?: (p: string) => void;
    linkFn?: (target: string, link: string) => void;
};

/**
 * Дом Kimi Code для сессии `kimi-native` (#120) и проба барьера на нём перед КАЖДОЙ сессией —
 * то же правило, что у `--settings` Claude Code и argv Codex. Флага файла настроек у Kimi нет:
 * хуки живут только в `config.toml` дома CLI (стенд Фазы 11). Поэтому дом собирает раннер в
 * каталоге состояния: `config.toml` человека как есть плюс регистрация барьера, вход —
 * ссылками на дом человека (`KIMI_HOME_LINKS`). Проба идёт на ТОМ тексте `config.toml`,
 * который ляжет в дом, и до записи: не прошедший пробу конфиг не должен лечь туда, откуда
 * его возьмёт сессия. Конфиг человека без хуков установки сессии не достаётся никогда —
 * профиль «дом человека как есть» стенд не допускает.
 *
 * `mcp.json` дома — MCP раннера (#196): пустой, перезаписывается перед каждой сессией. Доверие
 * каталогу, автообновление и окружение CLI сверяет перед спавном `kimiIsolationProblems`
 * (`adapters/kimi-home.ts`): дом собирает этот сборщик, а окружение — уже спавн.
 *
 * Ссылка входа снимается ВСЕГДА и ставится заново, только если цель есть: ссылка на
 * пропавший у человека файл иначе висела бы с прошлой сессии. Настоящий файл или каталог на
 * месте ссылки (CLI создал `credentials` сам, пока ссылки не было) раннер не удаляет — там
 * может лежать вход, — а называет в отказе: прежде `rmSync` на нём бросал, и после
 * `kimi login` человека каждая сессия вставала с безымянным «дом не собран» (ревью Фазы 16b).
 */
export function prepareKimiNativeHome(
    {
        roots,
        sessionTree,
        sourceHome,
        home,
    }: { roots: TGuardRoots; sessionTree: string; sourceHome: string; home: string },
    {
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        writeFileFn = (p, text) => writeFileAtomic(p, text),
        runHookFn = runHook,
        registry = HARNESS_REGISTRY,
        existsFn = (p) => fs.existsSync(p),
        entryKindFn = defaultEntryKind,
        unlinkFn = (p) => {
            guardSideEffect(`prepareKimiNativeHome:unlink(${p})`, 'Подмени unlinkFn в тесте.');
            fs.unlinkSync(p);
        },
        mkdirFn = (p) => {
            guardSideEffect(`prepareKimiNativeHome:mkdir(${p})`, 'Подмени mkdirFn в тесте.');
            fs.mkdirSync(p, { recursive: true, mode: 0o700 });
        },
        linkFn = (target, link) => {
            guardSideEffect(`prepareKimiNativeHome:symlink(${link})`, 'Подмени linkFn в тесте.');
            fs.symlinkSync(target, link);
        },
    }: TKimiHomeDeps = {},
): TPreparedKimiHome {
    const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
    let settings: unknown;
    try {
        settings = guardSettingsFor(roots, sessionTree, readFileFn);
    } catch (error) {
        return {
            ok: false,
            reason:
                `Хуки для сессии Kimi Code не собраны: ${why(error)}. ` +
                'Без них сессия kimi-native шла бы без барьера — старт отменён.',
        };
    }
    let humanToml: string;
    try {
        humanToml = readFileFn(path.join(sourceHome, 'config.toml'));
    } catch (error) {
        return {
            ok: false,
            reason:
                `config.toml дома Kimi Code ${sourceHome} не прочитан (${why(error)}): без него ` +
                'сессии не на чем войти — войди `kimi login` или задай kimiNativeRuntime.home.',
        };
    }
    // Судит регистрацию событие нормализатора Kimi Code (#191): путь — в каталоге исполняемого
    // ядра, как у Codex (`guardInputOf`).
    const input = guardInputOf(registry, KIMI_NATIVE_HARNESS, roots?.productRoot);
    const toml = kimiSessionConfig(humanToml, guardHooksOf(settings, sessionTree, input));
    const problems = kimiTomlProblems(toml, sessionTree, { runHookFn, registry });
    if (problems.length > 0) {
        return {
            ok: false,
            reason:
                'Проба барьера Kimi Code перед сессией не прошла — сессия не запущена:\n' +
                problems.map((p) => `  - ${p}`).join('\n'),
        };
    }
    try {
        mkdirFn(home);
        writeFileFn(path.join(home, 'config.toml'), toml);
        // MCP раннера (#196): серверов нет, и сервер, дописанный в дом прошлой сессией, до
        // этой не доживает.
        writeFileFn(path.join(home, 'mcp.json'), KIMI_SESSION_MCP);
        const refused = linkHomeEntries(
            { cli: 'Kimi Code', home, sourceHome, names: KIMI_HOME_LINKS },
            { existsFn, entryKindFn, unlinkFn, linkFn },
        );
        if (refused) return { ok: false, reason: refused };
    } catch (error) {
        return { ok: false, reason: `Дом Kimi Code сессии не собран в ${home} (${why(error)}).` };
    }
    // #198: MCP Kimi Code — `mcp.json` дома (проектные серверы держит недоверие каталогу).
    const mcpRefused = sessionMcpRefusal(
        'Kimi Code',
        { roots, sources: [{ file: path.join(home, 'mcp.json'), parse: jsonMcpServers }] },
        readFileFn,
    );
    if (mcpRefused) return { ok: false, reason: mcpRefused };
    return { ok: true, home };
}

/** Исход подготовки каталога сессии OpenCode: каталог для `OPENCODE_CONFIG_DIR` либо причина. */
/** `warnings` — пределы собранной сессии для строки `⚠` (правил дерева не нашлось). */
export type TPreparedOpencode =
    { ok: true; configDir: string; warnings: string[] } | { ok: false; reason: string };

/**
 * Правила дерева для `instructions` сессии OpenCode (ревью 16d2). `rules` описания — файлы в
 * порядке, в котором их ищет сам CLI, и берётся первый найденный: при выключенном проектном
 * конфиге CLI их не ищет, а раннер, отдавший один `AGENTS.md`, оставил бы без правил
 * потребителя, у которого есть только `CLAUDE.md` (CLI взял бы его запасным). Не нашлось ни
 * одного — пустой список и предел строкой `⚠`, а не молчание. Непринятый пакет — бросок, как у
 * `harnessForbiddenEnv`: пустой список правил выглядел бы деревом без правил.
 */
export function opencodeRuleFiles(
    registry: HarnessRegistry,
    sessionTree: string,
    isFileFn: (p: string) => boolean,
): { instructions: string[]; warnings: string[] } {
    const loaded = registry.packages.get(OPENCODE_HARNESS);
    if (!loaded) throw new Error(`пакет харнесса «${OPENCODE_HARNESS}» не принят реестром`);
    const { rules } = loaded.descriptor;
    const found = rules
        .map((r) => path.join(path.resolve(sessionTree), r))
        .find((p) => isFileFn(p));
    if (found) return { instructions: [found], warnings: [] };
    return {
        instructions: [],
        warnings: [
            `правил дерева для сессии OpenCode нет: ни одного из ${rules.join(', ')} в ` +
                `${sessionTree} — сессия идёт без правил дерева`,
        ],
    };
}

/** Ответ `opencode debug skill` в дереве сессии: код и stdout (JSON-список скиллов). */
export type TListSkillsFn = (
    env: NodeJS.ProcessEnv,
    cwd: string,
) => { code: number | null; stdout: string };

export type TOpencodeDeps = Pick<TSessionSettingsDeps, 'readFileFn' | 'writeFileFn'> & {
    layersFn?: TLayersFn;
    runPluginFn?: TRunPluginFn;
    registry?: HarnessRegistry;
    mkdirFn?: (p: string) => void;
    listSkillsFn?: TListSkillsFn;
    listDirFn?: (p: string) => string[];
    isFileFn?: (p: string) => boolean;
};

/** Боевой `opencode debug skill`: только чтение, но процесс CLI — побочка для теста. */
export const listOpencodeSkills: TListSkillsFn = (env, cwd) => {
    guardSideEffect('listOpencodeSkills(opencode debug skill)', 'Подмени listSkillsFn в тесте.');
    const r = spawnSync(OPENCODE_BIN, ['debug', 'skill'], {
        cwd,
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    return { code: r.status, stdout: String(r.stdout ?? '') };
};

/**
 * Каталог сессии OpenCode (`opencode`, #121) и проба барьера на нём перед КАЖДОЙ сессией —
 * то же правило, что у `--settings` Claude Code, argv Codex и дома Kimi Code. Хуков-команд у
 * OpenCode нет: барьер — плагин `plugin/ralph-guard.js` в каталоге `OPENCODE_CONFIG_DIR`,
 * рядом `opencode.json` для `OPENCODE_CONFIG` (разрешения без подтверждений). CLI сливает их с
 * конфигом человека и дерева, и `"plugin": []` потребителя внешний плагин не снимает (стенд).
 * Проба исполняет ТОТ исходник плагина, что ляжет в каталог, и до записи.
 *
 * После записи — полнота скиллов: `opencode debug skill` с окружением сессии в её дереве
 * обязан назвать каждый `.claude/skills/<имя>/SKILL.md` дерева. Поиск `.claude/skills` CLI
 * делает сам, но «нашёл» не значит «нашёл все» — недостающий скилл сессия просто не увидела бы.
 *
 * Сборщик конфига (#197, `adapters/opencode-home.ts`): рядом с каталогом — свой глобальный
 * каталог конфига (`xdg-config`, пересоздаётся пустым только ради `mkdir`: CLI создаёт его и сам),
 * в настройках — правила дерева абсолютным путём (первый найденный из `rules` описания пакета,
 * `opencodeRuleFiles`: проектный конфиг выключен, и корневой `AGENTS.md` CLI сам не грузит) и
 * пустой MCP раннера. Исполняемые слои `.opencode/` и `opencode.json(c)` с исполняющими ключами
 * (`jsonKeys` пакета) в дереве и предках — отказ до записи, тем же сканом, что у Codex.
 */
export function prepareOpencodeSession(
    {
        roots,
        sessionTree,
        configDir,
        baseEnv,
    }: { roots: TGuardRoots; sessionTree: string; configDir: string; baseEnv: NodeJS.ProcessEnv },
    {
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        writeFileFn = (p, text) => writeFileAtomic(p, text),
        runPluginFn = runOpencodePlugin,
        registry = HARNESS_REGISTRY,
        mkdirFn = (p) => {
            guardSideEffect(`prepareOpencodeSession:mkdir(${p})`, 'Подмени mkdirFn в тесте.');
            fs.mkdirSync(p, { recursive: true, mode: 0o700 });
        },
        listSkillsFn = listOpencodeSkills,
        layersFn,
        listDirFn = (p) => fs.readdirSync(p),
        isFileFn = (p) => {
            try {
                return fs.statSync(p).isFile();
            } catch {
                return false;
            }
        },
    }: TOpencodeDeps = {},
): TPreparedOpencode {
    const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
    let settings: unknown;
    try {
        settings = guardSettingsFor(roots, sessionTree, readFileFn);
    } catch (error) {
        return {
            ok: false,
            reason:
                `Хуки для сессии OpenCode не собраны: ${why(error)}. ` +
                'Без них сессия opencode шла бы без барьера — старт отменён.',
        };
    }
    // Судит регистрацию событие нормализатора OpenCode (#192): путь — в каталоге исполняемого
    // ядра, как у Codex и Kimi Code (`guardInputOf`).
    const input = guardInputOf(registry, OPENCODE_HARNESS, roots?.productRoot);
    const plugin = opencodeGuardPlugin(guardHooksOf(settings, sessionTree, input));
    const problems = opencodePluginProblems(plugin, sessionTree, { runPluginFn, registry });
    if (problems.length > 0) {
        return {
            ok: false,
            reason:
                'Проба барьера OpenCode перед сессией не прошла — сессия не запущена:\n' +
                problems.map((p) => `  - ${p}`).join('\n'),
        };
    }
    const layers = harnessLayerProblems(OPENCODE_HARNESS, sessionTree, baseEnv, {
        registry,
        ...(layersFn ? { layersFn } : {}),
    });
    if (layers.length > 0) {
        return {
            ok: false,
            reason:
                'Исполняемые слои конфига OpenCode в дереве сессии или его предках — сессия не запущена:\n' +
                layers.map((p) => `  - ${p}`).join('\n'),
        };
    }
    let rules: ReturnType<typeof opencodeRuleFiles>;
    try {
        rules = opencodeRuleFiles(registry, sessionTree, isFileFn);
    } catch (error) {
        return { ok: false, reason: `Правила сессии OpenCode не собраны: ${why(error)}.` };
    }
    const { instructions } = rules;
    try {
        mkdirFn(path.join(configDir, 'plugin'));
        mkdirFn(opencodeSessionXdg(configDir));
        writeFileFn(path.join(configDir, 'plugin', OPENCODE_GUARD_PLUGIN_FILE), plugin);
        writeFileFn(path.join(configDir, 'opencode.json'), opencodeSessionConfig({ instructions }));
    } catch (error) {
        return {
            ok: false,
            reason: `Каталог сессии OpenCode не собран в ${configDir} (${why(error)}).`,
        };
    }
    // #198: MCP OpenCode — настройки сессии и всё, что CLI сливает с ними без флага
    // (`opencodeSessionConfigLayers`): файл, оставленный там прошлой сессией, поднял бы её сервер.
    const mcpRefused = sessionMcpRefusal(
        'OpenCode',
        {
            roots,
            sources: [
                { file: path.join(configDir, 'opencode.json'), parse: opencodeMcpServers },
                ...opencodeSessionConfigLayers(configDir).map((file): TMcpSource => ({
                    file,
                    parse: opencodeMcpServers,
                    optional: true,
                })),
            ],
        },
        readFileFn,
    );
    if (mcpRefused) return { ok: false, reason: mcpRefused };
    const expected = expectedOpencodeSkills(sessionTree, listDirFn, isFileFn);
    const skills = opencodeSkillProblems(
        listSkillsFn(opencodeSessionEnv(baseEnv, { configDir, cwd: sessionTree }), sessionTree),
        expected,
    );
    if (skills.length > 0) {
        return {
            ok: false,
            reason:
                'Набор скиллов сессии OpenCode неполон — сессия не запущена:\n' +
                skills.map((p) => `  - ${p}`).join('\n'),
        };
    }
    return { ok: true, configDir, warnings: rules.warnings };
}

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
// Чего это НЕ обещает, сказано вслух. Claude Code по-прежнему читает и проектные настройки
// дерева сессии и складывает их хуки с нашими: хук из дерева сессии может заблокировать
// больше, но не может снять наш — блокирует любой код 2. Отказаться от проектных настроек
// (`--setting-sources user`) стенд умеет, но вместе с ними CLI теряет и то, что берёт из
// проекта помимо хуков; это решение отдельной задачи, а не попутное. Хук потребителя,
// названный через `${CLAUDE_PROJECT_DIR}`, исполняет код дерева сессии — так он написан
// потребителем, и переписывать чужие команды раннер не берётся. Отсюда и удвоение: когда
// дерево сессии — worktree того же репозитория (канон, обычно и потребитель), такой хук
// приходит и из собранного файла, и из проектных настроек дерева сессии, и на каждом вызове
// инструмента может стартовать дважды — лишний node на guard и на прочие хуки потребителя.
// Корректность это не ломает: оба экземпляра исполняют один код и блокируют одинаково.
// Записи, совпавшие с настройками дерева сессии, намеренно не выбрасываются: решать по
// дереву, которое правит PR, какие хуки человека снять из собранного файла, — значит снова
// дать правимому коду голос в настройках сессии, ради чего модуль и заведён.
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
    opencodeSessionEnv,
    opencodeSessionXdg,
} from '../adapters/opencode-home.ts';
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
        `🧷 Settings сессии: хуки из ядра ${roots.productRoot} (${contract}), контур из ` +
        `${roots.humanRoot}; собирается и проходит пробу перед каждой сессией`
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

/**
 * Собранный settings сессии. Чистая функция: тот же вход — тот же объект. Списки хуков
 * потребителя копируются, а не делятся: правка собранного не трогает прочитанного.
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
        hooks[event] = Array.isArray(entries) ? [...entries] : [];
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

export type TSessionSettingsDeps = {
    readFileFn?: (p: string) => string;
    writeFileFn?: (p: string, text: string) => void;
    runHookFn?: TRunHookFn;
};

export type TPreparedSettings = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Сборка, запись и проба перед сессией. Отказ — причина строкой, а не исключение: стоп с
 * ней делает вызывающий. Проба идёт на собранном объекте ДО записи: файл, не прошедший
 * пробу, не должен лечь туда, откуда его возьмёт следующая сессия.
 */
export function prepareSessionSettings(
    {
        productRoot,
        humanRoot,
        coreSha,
        sessionTree,
        outPath,
        sessionContext,
    }: {
        productRoot: string;
        humanRoot: string;
        coreSha: string;
        sessionTree: string;
        outPath: string;
        /** Контекст сессии (#184), который раннер даст ей в окружение: его обязан получить каждый guard. */
        sessionContext: string;
    },
    {
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        writeFileFn = (p, text) => writeFileAtomic(p, text),
        runHookFn = runHook,
    }: TSessionSettingsDeps = {},
): TPreparedSettings {
    let humanSettings: Record<string, unknown>;
    try {
        humanSettings = readHumanSettings(humanRoot, readFileFn);
    } catch (error) {
        return {
            ok: false,
            reason:
                `Settings сессии не собран: ${error instanceof Error ? error.message : String(error)}. ` +
                'Без настроек дерева человека сессия потеряла бы хуки потребителя — старт отменён.',
        };
    }
    const settings = buildSessionSettings({ productRoot, humanRoot, coreSha, humanSettings });
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
    return { ok: true, path: outPath };
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
    return { ok: true, args: [...guard.args, ...codexUntrustArgs(keys)], home, keys };
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

// Рантайм `opencode` — OpenCode CLI третьим харнессом, ЭКСПЕРИМЕНТАЛЬНО (Фаза 16b, #121;
// `docs/harness-adapters.md`, OpenCodeAdapter).
//
// Зачем. OpenCode не зависит ни от Claude CLI, ни от Codex и ведёт провайдеров, которых у
// них нет. Но допуск в резерв или роль — это canary профиля (Фаза 17), а не регистрация
// бинаря: до него рантайм ходит только явным экспериментом оператора, один провайдер, и
// статус назван в конфиге и в логе (`OPENCODE_STATUS`).
//
// Что здесь — чистые функции вход→выход; spawn, запись каталога сессии и пробу делает ядро.
// Каждое решение снято с CLI 1.19.4 живьём (27.10):
//   • ПРОМПТ — НА STDIN (урок #8): `opencode run` без позиционного сообщения читает его со
//     stdin. Argv несёт только флаги, его длина от промпта не зависит;
//   • вывод — `--format json`: строка JSON на событие (`step_start`, `text`, `tool_use`,
//     `step_finish`, `error`). Ядру отдаётся ТОЛЬКО текст модели (`text`): результаты
//     инструментов несут прочитанные файлы, и `ralph.md` с образцом блока намерений дал бы
//     второй блок и отказ батча целиком. Ошибка CLI идёт тоже событием в stdout, а не в
//     stderr — её строка добавляется к тексту, иначе диагноз падения пропал бы;
//   • модель — только `provider/model` (`-m`). Неизвестные провайдер или модель сессия
//     узнаёт лишь «Unexpected server error» без причины, поэтому их проверяет готовность до
//     выбора задачи по списку `opencode models <провайдер>` («Provider not found» — код 1);
//   • guard — плагин на `tool.execute.before` (`harness-guard.ts`, #119) в каталоге
//     `OPENCODE_CONFIG_DIR`, настройки сессии — файл по `OPENCODE_CONFIG`. `"plugin": []`
//     потребителя внешний плагин не снимает (стенд, `override`). `--pure` отключил бы
//     плагин — в argv его нет никогда, а `OPENCODE_PURE` и прочее окружение CLI снимает
//     сборщик конфига (`opencode-home.ts`, #197): он же выключает проектный конфиг и отрезает
//     глобальный конфиг человека;
//   • скиллы — поиском `.claude/skills` самого CLI; полноту набора видно `opencode debug
//     skill` (JSON со `location` каждого), и её сверяет раннер перед сессией;
//   • бюджета ходов, который CLI исполнял бы обрывом, нет — `turnLimit: 'best-effort'`, и
//     `maxTurns` в argv не уходит; держат сессию `maxIterations` и тайм-аут.
//
// TS-модуль без билд-шага (erasable-only), без побочек.

import fs from 'node:fs';
import path from 'node:path';
import { runtimeSectionProblems } from './runtime-capabilities.ts';

export const OPENCODE_BIN = 'opencode';

/**
 * Ключ рантайма OpenCode в реестре `coderRuntime` и имя его каталога сессии. Тем же словом
 * назван пакет харнесса (`harnesses/opencode/`, #213), и литерал в ядре читался бы ветвлением
 * по харнессу (`tests/harness-identity.test.ts`) — ядро берёт ключ отсюда.
 */
export const OPENCODE_RUNTIME = 'opencode';

// Окружение и настройки сессии — сборщик конфига (`opencode-home.ts`, #197); переменные
// каталога сессии нужны и здесь, и у ядра, поэтому едут отсюда же.
export { OPENCODE_CONFIG_DIR_ENV, OPENCODE_CONFIG_ENV } from './opencode-home.ts';

/** Имя файла плагина барьера в `plugin/` каталога сессии. */
export const OPENCODE_GUARD_PLUGIN_FILE = 'ralph-guard.js';

/**
 * Статус рантайма. Других значений до допуска по canary (Фаза 17, #114) нет: конфиг обязан
 * назвать его дословно, и отказ на любом другом — чтобы «резерв» не появился опечаткой.
 */
export const OPENCODE_STATUS = 'experimental';

/** Argv сессии. Промпта в нём нет — он идёт на stdin; `--pure` не ставится никогда. */
export function buildOpencodeArgs({ model }: { model: string }): string[] {
    return ['run', '--format', 'json', '-m', model];
}

/** `provider/model` → части; иначе причина. Модель вправе содержать `/` (OpenRouter). */
export function parseOpencodeModel(
    raw: unknown,
): { ok: true; provider: string; model: string } | { ok: false; reason: string } {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return {
            ok: false,
            reason: 'opencodeRuntime.model не задан — нужна модель в форме provider/model',
        };
    }
    const i = raw.indexOf('/');
    if (i <= 0 || i === raw.length - 1 || raw !== raw.trim()) {
        return {
            ok: false,
            reason: `opencodeRuntime.model = ${JSON.stringify(raw)} — нужна форма provider/model`,
        };
    }
    return { ok: true, provider: raw.slice(0, i), model: raw.slice(i + 1) };
}

/** Ключи секции `opencodeRuntime`. */
export const OPENCODE_SECTION_KEYS: readonly string[] = ['status', 'model'];

/** Форма секции `opencodeRuntime` — на резолве конфига, достижим рантайм или нет. */
export function opencodeSectionShapeProblems(section: unknown): string[] {
    return runtimeSectionProblems('opencodeRuntime', section, OPENCODE_SECTION_KEYS);
}

/**
 * Проблемы секции `opencodeRuntime` до любого запуска CLI: статус назван дословно, модель —
 * `provider/model`. Секция обязательна: умолчания модели у эксперимента нет, иначе провайдер
 * выбирался бы конфигом человека молча.
 */
export function opencodeConfigProblems(section: unknown): string[] {
    const shape = opencodeSectionShapeProblems(section);
    if (shape.length > 0) return shape;
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
        return [
            `секции opencodeRuntime нет — эксперимент заявляется явно: { "status": "${OPENCODE_STATUS}", "model": "provider/model" }`,
        ];
    }
    const s = section as Record<string, unknown>;
    const out: string[] = [];
    if (s.status !== OPENCODE_STATUS) {
        out.push(
            `opencodeRuntime.status = ${JSON.stringify(s.status)} — допустимо только "${OPENCODE_STATUS}": ` +
                'допуска профиля по canary (Фаза 17) нет, резервом или ролью OpenCode не назначается',
        );
    }
    const m = parseOpencodeModel(s.model);
    if (!m.ok) out.push(m.reason);
    return out;
}

/**
 * Ответ `opencode models <провайдер>` против модели конфига. Строки — `provider/model`.
 * Код не 0 — провайдер неизвестен CLI (живьём: «Provider not found: <имя>», код 1).
 */
export function opencodeModelProblems(
    { code, stdout, stderr }: { code: number | null; stdout: string; stderr: string },
    model: string,
): string[] {
    const parsed = parseOpencodeModel(model);
    const provider = parsed.ok ? parsed.provider : model;
    if (code !== 0) {
        // eslint-disable-next-line no-control-regex
        const why = `${stderr}\n${stdout}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
        return [
            `провайдер «${provider}» OpenCode неизвестен: \`opencode models ${provider}\` — ` +
                `код ${code}${why ? ` (${why.split('\n')[0]})` : ''}`,
        ];
    }
    const listed = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    if (!listed.includes(model)) {
        return [
            `модели «${model}» у провайдера «${provider}» нет: CLI знает ${listed.length ? listed.join(', ') : 'ни одной'}`,
        ];
    }
    return [];
}

/**
 * Файл входа OpenCode (`opencode auth login`) — `<data>/auth.json`, где data — по XDG, как у
 * самого CLI (`opencode debug paths`). Ключи его объекта — id провайдеров.
 */
export function opencodeAuthFile(env: NodeJS.ProcessEnv): string | null {
    const data = env.XDG_DATA_HOME || (env.HOME ? path.join(env.HOME, '.local', 'share') : null);
    return data ? path.join(data, 'opencode', 'auth.json') : null;
}

/**
 * Есть ли у провайдера ключ, который дойдёт до сессии. Сессия идёт без ключей раннера в env
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` снимаются), а список моделей CLI отдаёт и без ключа,
 * поэтому `opencode models` вход не доказывает (ревью Фазы 16b: старт зелёный, первая сессия —
 * 401 и стоп «вход отвергнут»). Засчитывается ключ, который хранит сам CLI: вход
 * (`auth.json`) или `provider.<id>.options.apiKey` в конфиге, разобранном CLI
 * (`opencode debug config` тем же env, что у сессии). Значение ключа не читается и не
 * пишется никуда — только его наличие.
 */
export function opencodeAuthProblems({
    provider,
    resolvedConfig,
    authProviders,
}: {
    provider: string;
    resolvedConfig: unknown;
    authProviders: readonly string[];
}): string[] {
    if (authProviders.includes(provider)) return [];
    const providers = (resolvedConfig as { provider?: unknown } | null)?.provider;
    const entry =
        providers && typeof providers === 'object'
            ? (providers as Record<string, unknown>)[provider]
            : undefined;
    const apiKey = (entry as { options?: { apiKey?: unknown } } | undefined)?.options?.apiKey;
    if (typeof apiKey === 'string' && apiKey.trim() !== '') return [];
    return [
        `ключа провайдера «${provider}» у OpenCode нет: ни входа (\`opencode auth login\`), ни ` +
            `provider.${provider}.options.apiKey в его конфиге. Ключи из окружения раннера сессии ` +
            'OpenCode не достаются — заведи ключ в самом CLI',
    ];
}

/** События `--format json`; строка, не разобравшаяся как JSON, — `{ raw }`. */
function events(stdout: string): ({ raw: string } | Record<string, unknown>)[] {
    const out: ({ raw: string } | Record<string, unknown>)[] = [];
    for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;
        try {
            const ev = JSON.parse(line) as unknown;
            if (ev !== null && typeof ev === 'object' && !Array.isArray(ev))
                out.push(ev as Record<string, unknown>);
        } catch {
            out.push({ raw: line });
        }
    }
    return out;
}

/** Ошибка CLI из события `error`: имя, сообщение, HTTP-код ответа провайдера, заголовки. */
export type TOpencodeError = {
    name: string;
    message: string;
    statusCode?: number;
    retryable?: boolean;
    headers: Record<string, unknown>;
};

function errorOf(ev: Record<string, unknown>): TOpencodeError | null {
    if (ev.type !== 'error') return null;
    const e = (ev.error ?? {}) as Record<string, unknown>;
    const data = (e.data ?? {}) as Record<string, unknown>;
    return {
        name: typeof e.name === 'string' ? e.name : '',
        message: typeof data.message === 'string' ? data.message : '',
        statusCode: typeof data.statusCode === 'number' ? data.statusCode : undefined,
        retryable: typeof data.isRetryable === 'boolean' ? data.isRetryable : undefined,
        headers:
            data.responseHeaders && typeof data.responseHeaders === 'object'
                ? (data.responseHeaders as Record<string, unknown>)
                : {},
    };
}

/** Ошибки CLI из событий `error` — по порядку, последней решает исход (`session-end.ts`). */
export function opencodeErrors(stdout: string): TOpencodeError[] {
    return events(stdout)
        .map((e) => ('raw' in e ? null : errorOf(e as Record<string, unknown>)))
        .filter((e): e is TOpencodeError => e !== null);
}

/**
 * Текст модели из `--format json` — то, что ядро читает как вывод сессии (блок намерений,
 * разбор падения). Ошибка CLI — строкой `opencode: <имя>: <сообщение>`: в stderr её нет.
 * Строка не-JSON идёт как есть — это сбой самого CLI, и прятать его значило бы терять диагноз.
 */
export function opencodeEventsText(stdout: string): string {
    const out: string[] = [];
    for (const ev of events(stdout)) {
        if ('raw' in ev && typeof ev.raw === 'string') {
            out.push(ev.raw);
            continue;
        }
        const e = ev as Record<string, unknown>;
        const part = (e.part ?? {}) as Record<string, unknown>;
        if (e.type === 'text' && typeof part.text === 'string') out.push(part.text);
        const err = errorOf(e);
        if (err) out.push(`opencode: ${err.name || 'error'}: ${err.message}`);
    }
    return out.join('\n');
}

/** Каталоги `.claude/skills/<имя>/SKILL.md` дерева — набор, который сессия обязана видеть. */
export function expectedOpencodeSkills(
    sessionTree: string,
    listDir: (p: string) => string[],
    isFile: (p: string) => boolean,
): string[] {
    const root = path.join(sessionTree, '.claude', 'skills');
    let names: string[];
    try {
        names = listDir(root);
    } catch {
        return [];
    }
    return names
        .map((n) => path.join(root, n, 'SKILL.md'))
        .filter((p) => isFile(p))
        .sort();
}

/** Канонический путь: настоящий, если файл есть, иначе абсолютный — сравнивать есть с чем. */
function canonicalPath(p: string, realpathFn: (p: string) => string): string {
    try {
        return realpathFn(p);
    } catch {
        return path.resolve(p);
    }
}

/**
 * Полнота набора скиллов по ответу `opencode debug skill`: каждый ожидаемый `SKILL.md`
 * назван `location`. Не JSON или не список — тоже отказ: «ничего не разобрали» не значит
 * «всё видно». Пути сравниваются через `realpath` обеих сторон (ревью Фазы 16b): каталог
 * скилла или само дерево за ссылкой, а CLI отдаёт реальный путь — по `path.resolve` скилл
 * назывался бы невидимым, и сессия не стартовала бы с ложным диагнозом.
 */
export function opencodeSkillProblems(
    { code, stdout }: { code: number | null; stdout: string },
    expected: readonly string[],
    realpathFn: (p: string) => string = (p) => fs.realpathSync(p),
): string[] {
    if (code !== 0) return [`\`opencode debug skill\` — код ${code}: набор скиллов не прочитан`];
    let list: unknown;
    try {
        list = JSON.parse(stdout);
    } catch (error) {
        return [`ответ \`opencode debug skill\` не JSON (${(error as Error).message})`];
    }
    if (!Array.isArray(list)) return ['ответ `opencode debug skill` — не список скиллов'];
    const seen = new Set(
        list
            .map((s) =>
                s && typeof s === 'object' ? (s as Record<string, unknown>).location : undefined,
            )
            .filter((l): l is string => typeof l === 'string')
            .map((l) => canonicalPath(l, realpathFn)),
    );
    return expected
        .filter((p) => !seen.has(canonicalPath(p, realpathFn)))
        .map((p) => `скилл ${p} OpenCode не видит — сессия шла бы без него`);
}

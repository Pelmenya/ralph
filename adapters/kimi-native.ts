// Рантайм `kimi-native` — Kimi Code CLI родным харнессом (Фаза 16b, #120;
// `docs/harness-adapters.md`, KimiNativeAdapter).
//
// Зачем. Ключ `kimi` реестра — это Claude Code на endpoint Moonshot: тот же харнесс, другой
// провайдер. Независимой линии по харнессу он не даёт, и родное поведение Kimi Code через
// него не проверить. `kimi-native` идёт рядом, а не вместо: сессию ведёт бинарь `kimi`.
//
// Что здесь — чистые функции вход→выход; spawn, запись дома и пробу делает ядро. Каждое
// решение снято с самого CLI 2.3.2 (исходник пакета и живые запуски 27.10):
//   • ПРОМПТА В ARGV НЕТ (урок #8). У `kimi -p` нет чтения промпта со stdin: значение `-p`
//     — обязательный аргумент опции. Поэтому промпт ложится файлом, а `-p` несёт короткий
//     указатель фиксированной длины. Живой запуск: файл 580 КБ — в четыре раза больше
//     MAX_ARG_STRLEN — модель прочла частями до последней строки и ответила кодовым словом
//     из конца файла. Каталог файла отдаётся `--add-dir`: он вне дерева сессии;
//   • вывод — `--output-format stream-json`: строка JSON на сообщение (`role` assistant,
//     tool, meta). Ядру отдаётся ТОЛЬКО текст ассистента: результаты инструментов несут
//     прочитанные файлы, и `ralph.md` с образцом блока намерений, прочитанный сессией, дал
//     бы второй блок и отказ батча целиком;
//   • бюджет ходов исполняет сам CLI: `KIMI_LOOP_MAX_STEPS_PER_TURN` (переменная его
//     конфига `loop_control.max_steps_per_turn`) обрывает ход ошибкой
//     `loop.max_steps_exceeded` и кодом 1 — поэтому `turnLimit: 'required'`;
//   • `--skills-dir` ЗАМЕНЯЕТ автообнаружение (`<дом>/skills`, `~/.agents/skills`,
//     `.kimi-code/skills` и `.agents/skills` проекта), а `.claude/skills`, где лежат скиллы
//     барьера, CLI не ищет вовсе. Поэтому флаг повторяется на ВЕСЬ ожидаемый набор:
//     то, что CLI нашёл бы сам, плюс `.claude/skills` дерева сессии;
//   • хуки у Kimi Code — только `[[hooks]]` в `config.toml` дома CLI (`KIMI_CODE_HOME`),
//     флага файла настроек нет (стенд Фазы 11). Дом сессии собирает раннер: конфиг
//     человека как есть плюс регистрация барьера, вход — ссылками на дом человека; доверие
//     каталогу, автообновление и окружение CLI раннера — `kimi-home.ts` (#196);
//   • ПЕСОЧНИЦЫ НЕТ, а `docs/harness-adapters.md` требует её от `kimi-native`. Поэтому до
//     неё рантайм — эксперимент оператора, как OpenCode (`KIMI_NATIVE_STATUS`): статус назван
//     в конфиге дословно, маршрут `modelRouting` в него (метка, фолбэк лимита, эскалация) —
//     отказ старта. Ночную сессию фолбэком на хост без песочницы раннер не отдаёт.
//
// TS-модуль без билд-шага (erasable-only), без побочек.

import path from 'node:path';
import { kimiHooksToml, type GuardHook } from './harness-guard.ts';
import { runtimeSectionProblems } from './runtime-capabilities.ts';

export const KIMI_NATIVE_BIN = 'kimi';

/**
 * Статус рантайма до песочницы, которой требует `docs/harness-adapters.md`. Конфиг обязан
 * назвать его дословно (`kimiNativeRuntime.status`), иначе отказ старта.
 */
export const KIMI_NATIVE_STATUS = 'experimental';

/** Ключи секции `kimiNativeRuntime`. */
export const KIMI_NATIVE_SECTION_KEYS: readonly string[] = ['status', 'model', 'home'];

/**
 * Проблемы секции `kimiNativeRuntime`: форма (fail-closed, на резолве конфига) и, если
 * рантайм достижим (`required`), заявленный статус эксперимента.
 */
export function kimiNativeConfigProblems(section: unknown, { required = false } = {}): string[] {
    const shape = runtimeSectionProblems('kimiNativeRuntime', section, KIMI_NATIVE_SECTION_KEYS);
    if (shape.length > 0 || !required) return shape;
    const status = (section as { status?: unknown } | undefined)?.status;
    if (status === KIMI_NATIVE_STATUS) return [];
    return [
        `kimiNativeRuntime.status = ${JSON.stringify(status)} — нужен "${KIMI_NATIVE_STATUS}": ` +
            'песочницы, которой docs/harness-adapters.md требует от kimi-native, нет, и сессия идёт ' +
            'на хосте — рантайм только экспериментом оператора',
    ];
}

/** Дом CLI: конфиг, хуки, вход. Флага у него нет — только переменная. */
export const KIMI_HOME_ENV = 'KIMI_CODE_HOME';

/** Потолок шагов хода — переменная конфига CLI `loop_control.max_steps_per_turn`. */
export const KIMI_MAX_STEPS_ENV = 'KIMI_LOOP_MAX_STEPS_PER_TURN';

/**
 * Что из дома человека нужно сессии для входа: файлы ключей и id устройства. Ссылкой, а не
 * копией — обновлённый CLI токен ложится туда, где его увидит и человек (так же стенд).
 */
export const KIMI_HOME_LINKS: readonly string[] = ['credentials', 'oauth', 'device_id'];

/**
 * Указатель в `-p`. Фиксированного вида: длина argv не зависит от промпта. Слово «целиком»
 * не украшение — без него модель на длинном файле ограничивалась первым куском чтения.
 */
export function kimiNativePromptPointer(promptPath: string): string {
    return (
        `Твоё задание целиком лежит в файле ${promptPath}. Прочитай его ПОЛНОСТЬЮ, до ` +
        'последней строки (длинный файл — частями), и выполни. Других указаний не будет.'
    );
}

/** Argv сессии `kimi`. Промпта в нём нет — только путь к его файлу. */
export function buildKimiNativeArgs({
    promptPath,
    model,
    skillsDirs,
}: {
    promptPath: string;
    model?: string;
    skillsDirs: readonly string[];
}): string[] {
    const args = ['--output-format', 'stream-json', '--add-dir', path.dirname(promptPath)];
    for (const dir of skillsDirs) args.push('--skills-dir', dir);
    if (model) args.push('-m', model);
    args.push('-p', kimiNativePromptPointer(promptPath));
    return args;
}

/**
 * Полный набор каталогов скиллов для `--skills-dir`: то, что CLI 2.3.2 нашёл бы сам в дереве и
 * в домашнем каталоге, плюс `.claude/skills` дерева сессии и `skills` дома ЧЕЛОВЕКА. Последний —
 * не автообнаружение: сессия идёт с `KIMI_CODE_HOME` = дом, собранный раннером, и сам CLI искал
 * бы `<дом сессии>/skills`, где ссылки на скиллы человека нет. Скиллы человека сессии нужны,
 * поэтому `kimiHome` здесь — дом человека, и каталог добавляется явно. Берутся существующие —
 * CLI молча пропускает отсутствующий каталог, и список с ним выглядел бы полнее, чем есть. Из
 * общих каталогов (`.agents/skills`) CLI берёт первый найденный — здесь так же.
 * Пользовательский `~/.agents/skills` CLI ищет от домашнего каталога своего процесса, поэтому и
 * здесь — от `HOME` окружения сессии. Дерева нет (`null`, юнит-тесты фабрики вне `main()`) —
 * каталогов дерева нет: якорь к месту запуска угадал бы дерево, а не знал его.
 */
export function kimiNativeSkillsDirs(
    {
        sessionTree,
        kimiHome,
        env,
    }: { sessionTree: string | null; kimiHome: string | null; env: NodeJS.ProcessEnv },
    isDir: (p: string) => boolean,
): string[] {
    const candidates = [
        ...(sessionTree
            ? [
                  path.join(sessionTree, '.claude', 'skills'),
                  path.join(sessionTree, '.kimi-code', 'skills'),
                  path.join(sessionTree, '.agents', 'skills'),
              ]
            : []),
        ...(kimiHome ? [path.join(kimiHome, 'skills')] : []),
        ...(env.HOME ? [path.join(env.HOME, '.agents', 'skills')] : []),
    ];
    return [...new Set(candidates)].filter((d) => isDir(d));
}

/**
 * Дом CLI человека — откуда сессия берёт конфиг и вход. Явный `kimiNativeRuntime.home`,
 * иначе тот же порядок, что у самого CLI: `KIMI_CODE_HOME`, затем `~/.kimi-code` от `HOME`
 * окружения раннера. Дом принадлежит инструменту, а не дереву: это его место, как
 * `CODEX_HOME` у Codex. Нет ни одного — `null`, и отказ называет вызывающий.
 */
export function kimiSourceHome(configured: unknown, env: NodeJS.ProcessEnv): string | null {
    if (typeof configured === 'string' && configured.trim() !== '') return configured;
    if (env[KIMI_HOME_ENV]) return env[KIMI_HOME_ENV] as string;
    return env.HOME ? path.join(env.HOME, '.kimi-code') : null;
}

/**
 * `config.toml` дома сессии: конфиг человека как есть плюс регистрация барьера. Хуки
 * человека не теряются — слияние у Kimi делает раннер, CLI его не делает (стенд, `merge`).
 */
export function kimiSessionConfig(humanToml: string, hooks: readonly GuardHook[]): string {
    const head = humanToml.endsWith('\n') || humanToml === '' ? humanToml : `${humanToml}\n`;
    return `${head}\n# Барьер сессии петли — собран раннером Ralph, правка руками теряется.\n${kimiHooksToml(hooks)}`;
}

/**
 * Готов ли вход до первой сессии — по дому CLI, без запроса в сеть. Две причины, обе сняты
 * живьём: без модели CLI отвечает «No model configured», без ключей — «provider … has no
 * credential configured». Ключ в самом конфиге (`api_key` провайдера) — тоже вход.
 * Протухший токен отсюда не виден: его сессия кончит исходом `auth`, и петля встанет с
 * «вход отвергнут».
 */
export function kimiNativeAuthProblems({
    configToml,
    credentialFiles,
    model,
}: {
    configToml: string | null;
    credentialFiles: readonly string[];
    model?: string;
}): string[] {
    if (configToml === null) {
        return ['config.toml дома Kimi Code не прочитан — CLI не настроен: `kimi login`'];
    }
    const out: string[] = [];
    const hasDefault = /^[ \t]*default_model\s*=\s*["'][^"']+["']/m.test(configToml);
    if (!hasDefault && !model) {
        out.push(
            'модель не задана: ни `default_model` в config.toml, ни kimiNativeRuntime.model — ' +
                'CLI ответил бы «No model configured»',
        );
    }
    const hasApiKey = /^[ \t]*api_key\s*=\s*["'][^"']+["']/m.test(configToml);
    if (credentialFiles.length === 0 && !hasApiKey) {
        out.push(
            'входа нет: каталог credentials пуст и `api_key` провайдера не задан — CLI ответил ' +
                'бы «has no credential configured»; войди `kimi login`',
        );
    }
    return out;
}

/**
 * Текст ассистента из stream-json — то, что ядро читает как вывод сессии (блок намерений,
 * разбор падения). Строка, не разобравшаяся как JSON, идёт как есть: это не ответ модели,
 * а сбой самого CLI, и прятать его значило бы терять диагноз.
 *
 * `content` — строка (живой вывод CLI 2.3.2) или массив частей, обычная форма
 * OpenAI-совместимых сообщений: из массива берутся части `type: "text"`, рассуждения
 * (`think`) и прочее — нет. Без этого текст ассистента пропал бы вместе с блоком намерений,
 * и ревью кончилось бы `review-no-verdict` (ревью Фазы 16b).
 */
export function kimiStreamText(stdout: string): string {
    const out: string[] = [];
    for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;
        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            out.push(line);
            continue;
        }
        if (msg === null || typeof msg !== 'object') continue;
        const m = msg as Record<string, unknown>;
        if (m.role !== 'assistant') continue;
        if (typeof m.content === 'string') out.push(m.content);
        else if (Array.isArray(m.content)) {
            const text = m.content
                .filter(
                    (p): p is { type: 'text'; text: string } =>
                        p !== null &&
                        typeof p === 'object' &&
                        (p as Record<string, unknown>).type === 'text' &&
                        typeof (p as Record<string, unknown>).text === 'string',
                )
                .map((p) => p.text)
                .join('');
            if (text) out.push(text);
        }
    }
    return out.join('\n');
}

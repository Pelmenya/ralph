// Профили конфига раннера (#71 → #365, трек «Фреймворк ralph», фаза 3). Вынесены из
// ralph.js: сборка плоского конфига из `common` + `profiles.<name>` — одна связная зона,
// поведение НЕ меняется, это извлечение, а не переписывание.
//
// Конфиг разделён на `common` (общее) и `profiles` (дельта). Профиль НЕ дублирует
// общие поля — иначе профили разъезжаются молча: правку modelRouting внесли в один,
// забыли во втором, и прод неделю ходит на старой модели.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
//
// Фабрика, а не standalone-экспорты: дефолтный failFn всех функций — боевой fail()
// ralph.js (process.exit), а resolveProfile зовёт валидаторы соседних зон
// (assertKnownReviewModels из review.ts, #223) — фабрика захватывает их один раз,
// возвращённые функции сохраняют показательную DI (failFn параметром) — ровно так их
// зовут существующие тесты (config-profile.test.ts) и monitor.js (мягкий failFn `() => null`).

import { ADAPTER_DEFAULTS, CODER_RUNTIME_PROVIDERS } from '../adapters/adapters-impl.ts';

// fail() боевой уходит в process.exit(1); тестовый failFn может вернуть значение или
// бросить — поэтому возврат unknown, а не never (мягкий результат пробрасывается наверх).
type FailFn = (msg: string) => unknown;
type AssertKnownReviewModelsFn = (
    cfg: Record<string, unknown>,
    profileName: string,
    failFn?: FailFn,
) => unknown;

export type ConfigProfileEnv = {
    fail: FailFn;
    // #223: модели ревью (review.default/escalated) обязаны быть известны планке #217 —
    // валидатор живёт в review.ts, сюда приходит уже собранным из его фабрики.
    assertKnownReviewModels: AssertKnownReviewModelsFn;
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Объекты сливаются вглубь (профиль правит ОДНУ метку modelRouting.labels, не
// переписывая блок), массивы и скаляры заменяются целиком. Частичный мердж массивов
// сознательно не делаем: для phases/authorAllowlist «дописать или заменить?» не имеет
// однозначного ответа, а неверная догадка в authorAllowlist — дыра в защите от инъекций.
// JSON.parse создаёт "__proto__" СОБСТВЕННЫМ ключом, но присваивание out[k] дёргает
// сеттер и подменяет прототип результата — в конфиге всплывают фантомные поля, которых
// в файле визуально нет. Легитимных полей с такими именами у нас не бывает, поэтому
// это либо опечатка, либо чужая рука — и то и другое для раннера с bypassPermissions
// повод остановиться, а не тихо нейтрализовать (fail-closed, как и вся схема профилей).
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

// Скан ВСЕЙ глубины, а не только уровней, куда рекурсирует мердж: объект из профиля по
// ключу, которого нет в common, копируется присваиванием — без этого обхода его нутро
// не проверялось бы вовсе, и инвариант «в конфиге не бывает опасных ключей» был бы
// ложным обещанием комментария. Возвращает имя первого найденного ключа с путём.
function findForbiddenKey(value: unknown, path: string): string | null {
    if (!isPlainObject(value)) return null;
    for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.includes(k)) return `"${k}" в блоке "${path}"`;
        const deeper = findForbiddenKey(v, `${path}.${k}`);
        if (deeper) return deeper;
    }
    return null;
}

export function createConfigProfile(env: ConfigProfileEnv) {
    const { fail, assertKnownReviewModels } = env;

    // Рекурсивный мердж БЕЗ скана запрещённых ключей: findForbiddenKey уже прошёл оба
    // дерева на всю глубину в deepMerge (единожды, до мерджа), поэтому здесь повторно
    // сканировать нечего — иначе каждый уровень рекурсии перепроверял бы всё поддерево
    // заново (лишний проход на каждый уровень глубины). Никогда не зовёт failFn.
    function deepMergeInner(
        base: Record<string, unknown>,
        override: Record<string, unknown>,
    ): Record<string, unknown> {
        const out: Record<string, unknown> = { ...base };
        for (const [k, v] of Object.entries(override)) {
            if (!isPlainObject(v) || !isPlainObject(base[k])) {
                out[k] = v;
                continue;
            }
            out[k] = deepMergeInner(base[k] as Record<string, unknown>, v);
        }
        return out;
    }

    function deepMerge(
        base: Record<string, unknown>,
        override: Record<string, unknown>,
        failFn: FailFn = fail,
        basePath = 'common',
        // base — это common, override — профиль: у них РАЗНЫЕ блоки конфига, поэтому и
        // ярлыки пути разные (иначе запрещённый ключ из common всплывёт как «в блоке
        // "prod.…"» — внятность сообщения соврёт про блок). Прямые вызовы (тесты/монитор)
        // с одним path получают его для обоих аргументов — обратная совместимость.
        overridePath: string = basePath,
    ): unknown {
        // Один скан обоих деревьев на верхнем уровне (findForbiddenKey сам рекурсивен на
        // всю глубину), а не на каждом уровне мерджа. failFn мог не бросить (монитор
        // передаёт `() => null`) — тогда его результат уходит наверх, а не собирается
        // конфиг из полуфабриката (resolveProfile проверяет isPlainObject).
        const bad = findForbiddenKey(base, basePath) || findForbiddenKey(override, overridePath);
        if (bad) return failFn(`ralph.config.json: запрещённый ключ ${bad}.`);
        return deepMergeInner(base, override);
    }

    // Флаг --profile <name> | --profile=<name> (#72). Нет флага → null, дальше решает
    // defaultProfile из конфига. Флаг БЕЗ имени — стоп: это почти всегда оборванная
    // команда, а «молча ушёл в playground, когда просили prod» — ровно тот тихий сдвиг
    // режима, против которого затевались профили.
    function parseProfileFlag(argv: string[], failFn: FailFn = fail): unknown {
        // Обе формы собираем разом: при дубле (`--profile a --profile=b`) «кто победит»
        // решал бы порядок веток кода, а не намерение человека — тихий уход не в тот
        // профиль. Дубль — стоп, даже с одинаковыми именами: команда явно собрана криво.
        const hits = argv.filter((a) => a === '--profile' || a.startsWith('--profile='));
        if (hits.length === 0) return null;
        if (hits.length > 1) {
            return failFn(`Флаг --profile указан ${hits.length} раза — оставь один.`);
        }
        if (hits[0].startsWith('--profile=')) {
            const name = hits[0].slice('--profile='.length);
            // Пустое имя ИЛИ ведущий `--` (`--profile=--once`) — пропущенное имя, ровно как
            // у пробельной формы ниже: без этой проверки `--once` уехал бы в имя профиля
            // (downstream resolveProfile отверг бы «Неизвестный профиль "--once"», но
            // сообщение хуже и поведение двух форм расходится).
            if (!name || name.startsWith('--')) {
                return failFn('Флаг --profile= без имени профиля.');
            }
            return name;
        }
        const value = argv[argv.indexOf('--profile') + 1];
        // Следующий флаг вместо имени (`--profile --once`) — тоже пропущенное имя.
        if (!value || value.startsWith('--')) {
            return failFn('Флаг --profile требует имя профиля: --profile <name>.');
        }
        return value;
    }

    // #249: haltBeforeDeploy валидируется на старте — тип и место (инвариант №1: кривой
    // конфиг = fail-closed стоп, а не тихий дефолт). Решение о непрерывном prod принимает
    // строгое `cfg.haltBeforeDeploy !== false`, поэтому `"false"` (строка), `0` или `null`
    // в конфиге молча дали бы halt-режим — опечатка в типе должна валить старт, а не
    // всплывать утром остановленным треком, который человек считал непрерывным. Флаг
    // осмыслен только в профиле `prod` (пост-мердж деплой фазы 5): заданный вне prod он
    // молча ничего не значит — тоже fail, чтобы не создавать ложного ощущения непрерывности.
    // Возврат: true — валиден; иначе результат failFn (мягкий failFn пробрасываем наверх).
    function assertValidHaltBeforeDeploy(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const v = cfg.haltBeforeDeploy;
        if (v === undefined) return true; // не задан — дефолт (halt), проверять нечего
        if (typeof v !== 'boolean') {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): haltBeforeDeploy = ${JSON.stringify(v)} — ожидался boolean. ` +
                    `Непрерывный prod решает строгое "!== false", поэтому строка/число/null молча дали бы halt-режим (#249). ` +
                    `Убери ключ (дефолт = стоп перед деплоем) либо задай true/false.`,
            );
        }
        if (profileName !== 'prod') {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): haltBeforeDeploy осмыслен только в профиле "prod" ` +
                    `(пост-мердж деплой фазы 5, #249). Вне prod флаг молча ничего не значит — убери его из этого профиля/common.`,
            );
        }
        return true;
    }

    // #48: плейсхолдеры промпта кодер-сессии. Петля подставляет РОВНО `{milestone}` и
    // `{branch}`; всё остальное в фигурных скобках уедет в сессию как есть.
    //
    // Барьер, а не вычитка глазами: боевой конфиг задавал `{{MILESTONE}}`/`{{BRANCH}}` — ни
    // одного совпадения с подстановкой, — и первая же итерация уходила бы с промптом
    // «возьми issue из milestone «{{MILESTONE}}»». Сессия при этом не падает: она честно
    // делает что-то не то, а брейкер `maxNoProgress` гасит петлю через три сожжённые
    // сессии. Отказ на старте стоит трёх строк, диагностика молчаливого случая — вечера.
    //
    // Проверяется ОСТАТОК после подстановки, а не исходный текст: так барьер ловит и
    // опечатку в имени (`{mileston}`), и чужую форму (`{{…}}`), не перечисляя их.
    function assertValidPromptPlaceholders(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const prompt = cfg.prompt;
        if (typeof prompt !== 'string' || prompt === '') return true;
        const left = prompt.replaceAll('{milestone}', '').replaceAll('{branch}', '');
        const stray = [...left.matchAll(/\{[^{}\n]{0,60}\}/g)].map((m) => m[0]);
        if (stray.length > 0) {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): в prompt остались нераскрытые ` +
                    `плейсхолдеры ${stray.join(', ')} — петля подставляет только {milestone} и {branch}. ` +
                    'Сессия получила бы их буквально и делала бы не то, а понять это можно только ' +
                    'по трём сожжённым итерациям (#48).',
            );
        }
        return true;
    }

    // #376 (фаза 6): значение modelRouting — либо строка (обратная совместимость,
    // claude-модель, провайдер по умолчанию — статический adapters.coderRuntime), либо
    // объект { provider, model } (явный выбор провайдера кодер-рантайма). provider
    // сверяется ПРОТИВ РЕЕСТРА (CODER_RUNTIME_PROVIDERS), а не принимается любой строкой —
    // иначе опечатка вида "kimy" тихо укатилась бы на дефолтный рантайм (инвариант №1).
    // Используется для modelRouting.labels[*]/default/apiLimitFallback/healEscalation.route —
    // один валидатор на все четыре места, схема одинаковая. Имя `assertValid*` (а не
    // `describe*`) отражает роль: функция ВАЛИДИРУЕТ (true / результат failFn), а не
    // форматирует описание — консистентно с соседями assertValidHaltBeforeDeploy/…
    //
    // requireProvider (ревью-blocker): когда статический adapters.coderRuntime ≠ 'claude',
    // безпровайдерная запись (голая строка ИЛИ объект без provider) означает «модель для
    // статического НЕ-claude рантайма» — но модель может оказаться claude-именем из
    // дефолтного роутинга, и она молча уехала бы на чужой endpoint (регрессия
    // «claude --model claude-… против Moonshot»). Тогда требуем provider явно в каждой
    // записи — barrier вместо надежды, что оператор обновил имена моделей (инвариант №5).
    function assertValidModelRouteEntry(
        path: string,
        entry: unknown,
        failFn: FailFn,
        { requireProvider = false }: { requireProvider?: boolean } = {},
    ): unknown {
        if (entry === undefined) return true; // не задан — нечего проверять
        if (typeof entry === 'string') {
            if (entry.trim() === '') {
                return failFn(
                    `ralph.config.json: ${path} — пустая строка. Задай имя модели (строка) либо объект { provider, model }.`,
                );
            }
            if (requireProvider) {
                return failFn(
                    `ralph.config.json: ${path} — голая строка-модель "${entry}" недопустима, когда ` +
                        `adapters.coderRuntime ≠ 'claude': она берёт статический не-claude рантайм, а claude-имя ` +
                        `из дефолтного роутинга молча уехало бы на чужой endpoint. Задай { provider, model } явно.`,
                );
            }
            return true;
        }
        if (!isPlainObject(entry)) {
            return failFn(
                `ralph.config.json: ${path} должен быть строкой (имя claude-модели, обратная совместимость) ` +
                    `либо объектом { provider, model } (#376, provider-aware роутинг). Получено: ${JSON.stringify(entry)}.`,
            );
        }
        const { provider, model } = entry;
        if (
            provider !== undefined &&
            (typeof provider !== 'string' ||
                !(CODER_RUNTIME_PROVIDERS as readonly string[]).includes(provider))
        ) {
            return failFn(
                `ralph.config.json: ${path}.provider = ${JSON.stringify(provider)} — неизвестный провайдер кодер-рантайма. ` +
                    `Допустимые (реестр coderRuntime): ${CODER_RUNTIME_PROVIDERS.join(', ')}.`,
            );
        }
        if (requireProvider && provider === undefined) {
            return failFn(
                `ralph.config.json: ${path}.provider обязателен, когда adapters.coderRuntime ≠ 'claude': без него ` +
                    `запись берёт статический не-claude рантайм, а model может оказаться claude-именем (тихий mismatch).`,
            );
        }
        if (typeof model !== 'string' || model.trim() === '') {
            return failFn(
                `ralph.config.json: ${path}.model обязателен и должен быть непустой строкой модели провайдера.`,
            );
        }
        return true;
    }

    // Fail-closed на схеме modelRouting целиком (#376): labels/default читает КАЖДЫЙ
    // кодер-запуск (pickModel/pickRuntime, orchestrator.ts), apiLimitFallback/healEscalation —
    // доп.скоуп кросс-провайдерного фолбэка и эскалации heal-сессий гейта. Невалидная
    // комбинация провайдер/модель ловится здесь, на старте, а не в момент диспетчеризации
    // кодер-сессии посреди ночного прогона. Возврат: true — валиден; иначе результат failFn
    // (мягкий failFn пробрасываем наверх).
    function assertValidModelRouting(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const routing = cfg.modelRouting;
        if (routing === undefined) return true; // не задан — раннер берёт config.model как раньше
        if (!isPlainObject(routing)) {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): modelRouting должен быть объектом.`,
            );
        }
        // Статический кодер-рантайм всего прогона (adapters.coderRuntime, дефолт 'claude').
        // Когда он ≠ 'claude' — безпровайдерные записи роутинга запрещены (см. requireProvider
        // в assertValidModelRouteEntry): иначе claude-имя молча уехало бы на чужой endpoint.
        const adapters = cfg.adapters;
        const staticRuntime =
            isPlainObject(adapters) && typeof adapters.coderRuntime === 'string'
                ? adapters.coderRuntime
                : ADAPTER_DEFAULTS.coderRuntime;
        const requireProvider = staticRuntime !== 'claude';
        const entryOpts = { requireProvider };

        const defaultOk = assertValidModelRouteEntry(
            'modelRouting.default',
            routing.default,
            failFn,
            entryOpts,
        );
        if (defaultOk !== true) return defaultOk;
        if (routing.labels !== undefined) {
            if (!isPlainObject(routing.labels)) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.labels должен быть объектом label → модель.`,
                );
            }
            for (const [label, entry] of Object.entries(routing.labels)) {
                const ok = assertValidModelRouteEntry(
                    `modelRouting.labels["${label}"]`,
                    entry,
                    failFn,
                    entryOpts,
                );
                if (ok !== true) return ok;
            }
        }
        // Доп.скоуп #376: кросс-провайдерный фолбэк при API-лимите — та же схема записи.
        const fallbackOk = assertValidModelRouteEntry(
            'modelRouting.apiLimitFallback',
            routing.apiLimitFallback,
            failFn,
            entryOpts,
        );
        if (fallbackOk !== true) return fallbackOk;
        // Ревью-thread: apiLimitFallback, резолвящийся в ТОТ ЖЕ провайдер, что и статический
        // coderRuntime — гарантированный no-op: runClaude пропускает same-provider фолбэк
        // («повтор тем же провайдером до ожидания бессмыслен»). Молчаливый no-op-конфиг хуже
        // честного отказа (инвариант №1) — кросс-провайдерный фолбэк требует ДРУГОГО
        // провайдера. Смена только модели в рамках провайдера тут не поддержана намеренно
        // (в отличие от healEscalation, где эскалация модели того же провайдера осмысленна).
        if (routing.apiLimitFallback !== undefined) {
            const fb = routing.apiLimitFallback;
            const fbProvider =
                typeof fb === 'string'
                    ? staticRuntime
                    : isPlainObject(fb) && typeof fb.provider === 'string'
                      ? fb.provider
                      : staticRuntime;
            if (fbProvider === staticRuntime) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.apiLimitFallback резолвится в ТОТ ЖЕ ` +
                        `провайдер "${staticRuntime}", что и статический coderRuntime — runClaude пропускает ` +
                        `same-provider фолбэк, запись была бы молчаливым no-op. Укажи provider, отличный от ` +
                        `статического, либо убери apiLimitFallback.`,
                );
            }
        }
        // Доп.скоуп #376: эскалация heal-сессий гейта «с дешёвой на сильную» после
        // afterAttempts неудачных попыток. Секция задана — требуем ОБА поля (afterAttempts И
        // route): частично заданная (`{route}` без afterAttempts, `{afterAttempts}` без route)
        // в рантайме — тихий no-op (эскалация никогда не сработает), тот же класс «тихий
        // дефолт», против которого весь валидатор (инвариант №1). afterAttempts — положительное
        // число (0/отрицательное эскалировали бы на первой же попытке — не по намерению автора).
        if (routing.healEscalation !== undefined) {
            if (!isPlainObject(routing.healEscalation)) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation должен быть объектом { afterAttempts, route }.`,
                );
            }
            const { afterAttempts, route } = routing.healEscalation;
            if (afterAttempts === undefined) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation задан, но afterAttempts отсутствует — ` +
                        `секция была бы молчаливым no-op (эскалация никогда не сработает). Укажи afterAttempts И route, либо убери секцию.`,
                );
            }
            if (!(typeof afterAttempts === 'number' && afterAttempts > 0)) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation.afterAttempts должен быть положительным числом попыток.`,
                );
            }
            if (route === undefined) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation задан, но route отсутствует — ` +
                        `эскалации не на что переключаться, секция молчаливый no-op. Укажи route И afterAttempts.`,
                );
            }
            const routeOk = assertValidModelRouteEntry(
                'modelRouting.healEscalation.route',
                route,
                failFn,
                entryOpts,
            );
            if (routeOk !== true) return routeOk;
        }
        return true;
    }

    // Fail-closed: любой изъян схемы — стоп с внятным сообщением, а не тихий дефолт.
    // Автономный раннер с bypassPermissions не имеет права УГАДЫВАТЬ, в каком режиме он
    // работает: «молча свалился в playground, думая что он prod» — худший исход из всех.
    // failFn инжектируется (как в preflight) — тесты проверяют отказы без process.exit.
    function resolveProfile(raw: unknown, name: unknown, failFn: FailFn = fail): unknown {
        if (!isPlainObject(raw)) return failFn('ralph.config.json: ожидался JSON-объект.');
        if (!isPlainObject(raw.common)) {
            return failFn('ralph.config.json: нет блока "common" — общие поля профилей.');
        }
        if (!isPlainObject(raw.profiles)) {
            return failFn('ralph.config.json: нет блока "profiles".');
        }

        const profiles = raw.profiles;
        const available = Object.keys(profiles);
        if (!available.length) return failFn('ralph.config.json: "profiles" пуст.');

        // name (флаг --profile, #72) важнее defaultProfile; нет ни того ни другого — стоп.
        const wanted = (name ?? raw.defaultProfile) as string | undefined;
        if (!wanted) {
            return failFn(
                `ralph.config.json: профиль не задан и нет "defaultProfile". Доступны: ${available.join(', ')}.`,
            );
        }
        if (!Object.prototype.hasOwnProperty.call(profiles, wanted)) {
            return failFn(`Неизвестный профиль "${wanted}". Доступны: ${available.join(', ')}.`);
        }
        if (!isPlainObject(profiles[wanted])) {
            return failFn(`ralph.config.json: профиль "${wanted}" — не объект.`);
        }

        // profileName в итоговом конфиге: раннеру и логам нужно знать режим, а исходный
        // raw после резолва никто не таскает.
        const merged = deepMerge(
            raw.common,
            profiles[wanted] as Record<string, unknown>,
            failFn,
            'common',
            wanted,
        );
        if (!isPlainObject(merged)) return merged; // мягкий failFn — наверх как есть
        // #223: модели ревью (review.default/escalated) обязаны быть известны планке #217.
        // Незнакомая модель, поставившая блок, получила бы rank -1 и проиграла ЛЮБОму
        // известному кандидату — планка инвертировалась бы (haiku судит блок сильнейшей).
        // Ловим на старте (fail-closed дешевле тихой инверсии), а не в момент разбора.
        const known = assertKnownReviewModels(merged, wanted, failFn);
        if (known !== true) return known; // мягкий failFn — наверх как есть
        // #249: haltBeforeDeploy обязан быть boolean и только в профиле prod (fail-closed,
        // иначе опечатка в типе тихо даёт halt-режим — см. assertValidHaltBeforeDeploy).
        const haltOk = assertValidHaltBeforeDeploy(merged, wanted, failFn);
        if (haltOk !== true) return haltOk; // мягкий failFn — наверх как есть
        // #376: modelRouting провайдер-осведомлён — валидируем схему целиком (labels/
        // default/apiLimitFallback/healEscalation) до того, как раннер начнёт резолвить
        // провайдера по label'ам issue.
        const routingOk = assertValidModelRouting(merged, wanted, failFn);
        if (routingOk !== true) return routingOk; // мягкий failFn — наверх как есть
        // #48: плейсхолдеры промпта — последняя проверка схемы: она про содержимое, а не
        // про форму, и осмысленна только на уже слитом конфиге.
        const promptOk = assertValidPromptPlaceholders(merged, wanted, failFn);
        if (promptOk !== true) return promptOk; // мягкий failFn — наверх как есть
        return { ...merged, profileName: wanted };
    }

    return {
        deepMerge,
        parseProfileFlag,
        assertValidHaltBeforeDeploy,
        assertValidModelRouting,
        assertValidPromptPlaceholders,
        resolveProfile,
    };
}

// Модуль гейта мерджа (#362, трек «Фреймворк ralph», фаза 3). Вынесен из ralph.js по
// тому же приёму, что worktree.ts / state-lock.ts / tunnel-check.ts (фаза 2): исполнение
// гейта фазы собрано одним связным модулем, а ralph.js пользуется только его API.
// Поведение НЕ меняется — это извлечение, не переписывание: состав чеков, порядок
// fail-fast, hold-первым-blocked-вторым, --match-head-commit, H4-разделение merge и
// пост-мердж шагов, снятие/возврат метки blocked — всё как было.
//
// Что собрано здесь: последовательность шагов гейта (checksGreen + состав чеков) и логика
// перехода в blocked/hold (tryMergePhase).
//
// Примитивы форжа (метка blocked, мердж PR, «фаза уже смерджена») здесь БОЛЬШЕ НЕ ЖИВУТ —
// они уехали в `adapters/github-forge-commands.ts` (#55), а гейт получает их инъекцией
// через `GateEnv` и знает только сигнатуры. Состав шагов приезжает из конфига
// (ralph.config.json → gate.checks/prodChecks/prodDropChecks, #204 фаза 4): ядро знает
// только КОНТРАКТ (fail-fast порядок, дедуп base↔prod), конкретные npm-скрипты проекта —
// в конфиге. resolveGateChecks валидирует форму fail-closed. Санация env чеков живёт в
// отдельном gate-env.mts (#188) и приходит сюда инжектируемым buildSanitizedGateEnv —
// этот модуль её только зовёт.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Фабрика, а не standalone-экспорты (как в worktree.ts/tunnel-check.ts): checksGreen/
// tryMergePhase/… НЕ чистые — им нужен контекст ralph.js (sh/shArgv/shq, ghJson,
// findOpenPr, ensureClean, парковка/обновление дерева, санация env, sleep, DRY, набор
// regex'ов). Фабрика захватывает этот контекст один раз, а возвращённые функции
// сохраняют ПОКАЗАТЕЛЬНУЮ DI: каждая по-прежнему принимает свои коллабораторы
// (shFn/logFn/checksGreenFn/…) параметром — ровно так их зовут существующие тесты
// (gate.test.ts, blocked-scenarios.test.ts, hold-scenarios.test.ts) через ре-экспорт из
// ralph.js. Module-level state гейта (lastRedCheck/lastVerifiedHead/lastGatePr) живёт в
// замыкании фабрики и читается наружу геттерами — как раньше module.exports у ralph.js.

type ExecOpts = { env?: NodeJS.ProcessEnv };
type ShFn = (cmd: string, opts?: ExecOpts) => string;
type ShArgvFn = (file: string, args: string[], opts?: ExecOpts) => string;
type ShqFn = (value: unknown) => string;
type LogFn = (msg: string) => void;
// fail() боевой уходит в process.exit(1); тестовый может бросить/вернуть — потому unknown.
type FailFn = (msg: string) => unknown;
type GhJsonFn = <T = unknown>(cmd: string, attempts?: number) => T;
// #55: сигнатуры примитивов форжа — гейт зависит от них, но не от их реализации.
type MergePrFn = (
    prNumber: number,
    headSha?: string | null,
    opts?: { runArgvFn?: ShArgvFn },
) => void;
type PhaseMergedFn = (phase: { branch: string }) => boolean;
// #49: sha головы PR — операция ФОРЖА (метод `pullRequestHeadSha` шва TaskSourceAdapter),
// а не гейта. Fail-closed по контракту шва: не смогли прочитать — бросает, а не отдаёт
// пустую строку.
type PrHeadShaFn = (prNumber: number) => string;
type SafeBranchFn = (branch: string, opts?: { logFn?: LogFn; where?: string }) => boolean;
type SleepFn = (ms: number) => void;
type FormatExcerptFn = (raw: string) => string;
type BuildGateEnvFn = () => NodeJS.ProcessEnv;

// PR в форме, которую отдаёт findOpenPr (`gh pr list --json number,labels`).
type Pr = { number: number; labels?: Array<{ name: string }> };
type FindOpenPrFn = (branch: string, opts?: { ghJsonFn?: GhJsonFn; logFn?: LogFn }) => Pr | null;
type EnsureCleanFn = (context: string, opts?: { shFn?: ShFn; logFn?: LogFn }) => boolean;
type ParkFn = (opts?: { runArgvFn?: ShArgvFn; logFn?: LogFn }) => void;
type UpdateTreeFn = (runArgvFn?: ShArgvFn) => void;
type SyncDepsFn = (opts?: { env?: NodeJS.ProcessEnv }) => void;

// Один упавший чек гейта — топливо чини-сессии (self-heal). null = гейт падал не на
// чеках (fetch/HEAD/detach): такие причины кодом не лечатся.
type RedCheck = { name: string; cmd: string; excerpt: string };

// Пара [имя, команда] шага гейта. Состав приезжает из ralph.config.json (#204, фаза 4):
// ядро гейта не знает конкретных npm-скриптов проекта — только форму «список пар».
type GateCheck = [string, string];

// Блок `gate` из ralph.config.json (после resolveProfile). Ядро читает его лениво через
// getConfig — конфиг присваивается в main() уже после сборки фабрики. Формы валидирует
// resolveGateChecks (fail-closed): неверная схема тут — не «дефолт как у нас», а стоп.
type GateConfigRaw = {
    gate?: {
        checks?: unknown;
        prodChecks?: unknown;
        prodDropChecks?: unknown;
    };
};

// Разобранный и провалидированный состав гейта. base — всем профилям; prodChecks —
// добавка prod; prodDrop — имена базовых чеков, которые prod снимает (дедуп test↔coverage,
// #80): раньше это был хардкод `name !== 'test'`, теперь — конфиг, чтобы не-npm стек не
// правил код ради своей пары «тест ⊂ покрытие».
type ResolvedGateChecks = { base: GateCheck[]; prodChecks: GateCheck[]; prodDrop: string[] };

// Контекст ralph.js, захватываемый фабрикой один раз. sh/shArgv/shq/log/ghJson — те же
// module-level коллабораторы, что использует остальной раннер. safeBranch/findOpenPr/
// ensureClean/parkOnOriginMain/updateRunnerTreeToOriginMain/syncDepsIfLockChanged/
// formatExcerpt — уже определённые в ralph.js помощники хореографии. buildSanitizedGateEnv
// — санация env чеков (#188/#189, отдельный gate-env.mts). sleep — ожидание между
// повторами мутации. dry — снимок DRY на момент создания фабрики (DRY иммутабелен,
// ставится из argv на старте): defense-in-depth guard C1 внутри tryMergePhase. regex'ы
// и RUNNER_TREE_FIX_HINT — константы ralph.js.
export type GateEnv = {
    sh: ShFn;
    shArgv: ShArgvFn;
    shq: ShqFn;
    log: LogFn;
    fail: FailFn;
    ghJson: GhJsonFn;
    // #49: чтение головы PR — через шов форжа, как и findOpenPr. Дефолт для checksGreen
    // приходит контекстом (в composition root это GitHub-реализация), а мердж-путь
    // прокидывает сюда метод выбранного адаптера — см. tryMergePhase.
    prHeadSha: PrHeadShaFn;
    // #55: примитивы форжа приходят инъекцией, а не живут в гейте. Раньше их
    // GitHub-реализации лежали прямо здесь, и «гейт» с «GitHub-адаптером» читались одним
    // модулем. Теперь их место — adapters/github-forge-commands.ts, а гейт знает только
    // сигнатуры: мердж состоявшегося PR и ответ «фаза уже смерджена?».
    mergePr: MergePrFn;
    phaseMerged: PhaseMergedFn;
    safeBranch: SafeBranchFn;
    findOpenPr: FindOpenPrFn;
    ensureClean: EnsureCleanFn;
    parkOnOriginMain: ParkFn;
    updateRunnerTreeToOriginMain: UpdateTreeFn;
    // Канон, задача 28: дерево ПОТРЕБИТЕЛЯ подтягивается тем же мерджем фазы. Тип общий с
    // обновлением дерева раннера, а поведение обратное по контракту: этот вызов не бросает
    // никогда — состояние дерева человека следующей фазе не мешает, и стопом быть не может.
    updateConsumerTreeAfterMerge: UpdateTreeFn;
    syncDepsIfLockChanged: SyncDepsFn;
    buildSanitizedGateEnv: BuildGateEnvFn;
    formatExcerpt: FormatExcerptFn;
    sleep: SleepFn;
    dry: boolean;
    SHA40_RE: RegExp;
    PR_NUMBER_RE: RegExp;
    runnerTreeFixHint: string;
    // #204 (фаза 4): ленивый доступ к конфигу — состав чеков гейта живёт в
    // ralph.config.json (gate.checks/prodChecks/prodDropChecks), а не в этом модуле.
    // Ленивый, потому что config присваивается в main() уже после сборки фабрики
    // (тот же приём, что getConfig в deploy-check.ts).
    getConfig: () => GateConfigRaw;
};

// Проверка «пара [строка, непустая строка]» — одна на checks и prodChecks.
function isGateCheckPair(v: unknown): v is GateCheck {
    return (
        Array.isArray(v) &&
        v.length === 2 &&
        typeof v[0] === 'string' &&
        v[0].length > 0 &&
        typeof v[1] === 'string' &&
        v[1].length > 0
    );
}

// Разбор и ВАЛИДАЦИЯ блока `gate` из конфига (#204, фаза 4). Fail-closed: пустой список
// базовых чеков, битая пара [имя, команда], нестроковый prodDropChecks — это стоп с
// внятным сообщением, а НЕ «подставлю дефолтный набор, как у проекта-донора». Молчаливый
// дефолт вернул бы ровно ту проектную привязку, ради выноса которой затевалась фаза:
// чужой проект с забытым/кривым `gate` тихо гонял бы наши npm-скрипты. Чистая функция
// (без побочек) — зовётся и на старте (ранний отказ), и из gateChecksFor (рантайм).
export function resolveGateChecks(
    cfg: GateConfigRaw | undefined,
    failFn: (msg: string) => unknown,
): ResolvedGateChecks {
    const gate = cfg && cfg.gate;
    if (!gate || typeof gate !== 'object') {
        failFn(
            'ralph.config.json: нет блока "gate" — состав чеков гейта задаётся конфигом (#204).',
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const rawChecks = gate.checks;
    if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
        failFn(
            'ralph.config.json: gate.checks пуст или не массив — базовый набор чеков гейта обязателен ' +
                '(пара [имя, команда]). Пустой гейт смерджил бы фазу без единой проверки.',
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const bad = rawChecks.find((c) => !isGateCheckPair(c));
    if (bad !== undefined) {
        failFn(
            `ralph.config.json: gate.checks содержит некорректный шаг ${JSON.stringify(bad)} — ` +
                `ожидалась пара [имя, команда] из двух непустых строк.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const rawProd = gate.prodChecks ?? [];
    if (!Array.isArray(rawProd)) {
        failFn('ralph.config.json: gate.prodChecks должен быть массивом пар [имя, команда].');
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const badProd = rawProd.find((c) => !isGateCheckPair(c));
    if (badProd !== undefined) {
        failFn(
            `ralph.config.json: gate.prodChecks содержит некорректный шаг ${JSON.stringify(badProd)} — ` +
                `ожидалась пара [имя, команда] из двух непустых строк.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const rawDrop = gate.prodDropChecks ?? [];
    if (!Array.isArray(rawDrop) || rawDrop.some((n) => typeof n !== 'string')) {
        failFn('ralph.config.json: gate.prodDropChecks должен быть массивом имён чеков (строк).');
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    // Дубли имён внутри набора (#204-ревью): чек с тем же именем исполнится дважды, а
    // атрибуция красного по имени станет неоднозначной (два `test` — какой упал?). Отвергаем
    // на старте, а не гоняем один чек по два раза.
    const checkNames = (rawChecks as GateCheck[]).map(([name]) => name);
    const prodNames = (rawProd as GateCheck[]).map(([name]) => name);
    const dupCheck = checkNames.find((n, i) => checkNames.indexOf(n) !== i);
    if (dupCheck !== undefined) {
        failFn(
            `ralph.config.json: gate.checks содержит дублирующееся имя чека "${dupCheck}" — ` +
                `имена чеков обязаны быть уникальны (иначе двойной прогон и неоднозначная атрибуция красного).`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const dupProd = prodNames.find((n, i) => prodNames.indexOf(n) !== i);
    if (dupProd !== undefined) {
        failFn(
            `ralph.config.json: gate.prodChecks содержит дублирующееся имя чека "${dupProd}" — имена обязаны быть уникальны.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    // prodDropChecks обязан ссылаться на имя ИЗ базового набора (#204-ревью): опечатка
    // (`tests` вместо `test`) иначе молча ничего не снимет — в prod поедут и `test`, и
    // `coverage`, лишние минуты на каждом прогоне гейта, и никто не заметит (класс «гейт
    // толще, чем задумано, молча»). Fail-closed здесь же, а не тихий no-op.
    const unknownDrop = (rawDrop as string[]).find((n) => !checkNames.includes(n));
    if (unknownDrop !== undefined) {
        failFn(
            `ralph.config.json: gate.prodDropChecks ссылается на "${unknownDrop}", которого нет ` +
                `среди gate.checks (${checkNames.join(', ') || 'пусто'}) — опечатка молча ничего бы не сняла.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    return {
        base: rawChecks as GateCheck[],
        prodChecks: rawProd as GateCheck[],
        prodDrop: rawDrop as string[],
    };
}

export function createGateRunner(env: GateEnv) {
    const {
        sh,
        shArgv,
        shq,
        log,
        fail,
        ghJson,
        prHeadSha,
        mergePr,
        phaseMerged,
        safeBranch,
        findOpenPr,
        ensureClean,
        parkOnOriginMain,
        updateRunnerTreeToOriginMain,
        updateConsumerTreeAfterMerge,
        syncDepsIfLockChanged,
        buildSanitizedGateEnv,
        formatExcerpt,
        sleep,
        dry: DRY,
        SHA40_RE,
        PR_NUMBER_RE,
        runnerTreeFixHint: RUNNER_TREE_FIX_HINT,
        getConfig,
    } = env;

    // ── State гейта (замыкание фабрики) ──────────────────────────────────────
    // sha PR-головы, на которой последний прогон гейта дал ВСЕ зелёные (null = гейт не
    // доходил до зелёного финала). Отдаётся в `gh pr merge --match-head-commit`, чтобы
    // закрыть TOCTOU-окно между прогоном чеков и мерджем (#SiaTz).
    let lastVerifiedHead: string | null = null;
    // Последний упавший ЧЕК гейта (null = гейт падал не на чеках: fetch/HEAD/detach).
    // Разделение важно: чини-сессия имеет смысл только для красных чеков — сетевые
    // и git-проблемы кодом не лечатся.
    let lastRedCheck: RedCheck | null = null;
    // Номер PR последнего прохода гейта (null = гейт не дошёл до findOpenPr). #218:
    // нужен runLoop'у для текста пуша «блокер снят автоматически» — событие рождается
    // ПОСЛЕ tryMergePhase вернул строку-статус, а не объект с PR, так что номер несём
    // тем же геттер-паттерном, что lastRedCheck/lastVerifiedHead.
    let lastGatePr: number | null = null;

    // ── Состав шагов гейта: из конфига (#204, фаза 4) ─────────────────────────
    //
    // Раньше BASE/PROD_GATE_CHECKS были хардкодом здесь и прибивали ядро к npm-скриптам
    // одного проекта. Теперь состав живёт в ralph.config.json (gate.checks/prodChecks/
    // prodDropChecks) — ядро знает только КОНТРАКТ, не конкретные команды. Что осталось в
    // коде (потому что это правила ядра, а не проектная специфика):
    //
    // - Fail-fast порядок «дешёвый → дорогой» — ОТВЕТСТВЕННОСТЬ автора конфига: список
    //   исполняется как есть, красный первого чека отменяет мердж, не оплатив следующих.
    //   Секундные проверки (канарейка секретов, `vitest list`, `git grep`) должны идти
    //   раньше минутных (build) и очень дорогих (e2e). Пояснение к КОНКРЕТНОМУ порядку —
    //   дело проекта: рядом со списком в его `ralph.config.json`.
    // - Дедуп base↔prod через prodDropChecks (#80): в prod проект снимает базовый `test`
    //   в пользу `coverage` (тот же `vitest run` + инструментация — строгое надмножество,
    //   двойной прогон = лишние минуты). Раньше это был хардкод `name !== 'test'`; теперь
    //   имена снимаемых чеков задаёт конфиг — не-npm стек без этой пары просто оставляет
    //   prodDropChecks пустым. Атрибуция красного не теряется: упавший тест красит coverage
    //   тем же ненулевым кодом.
    // - Селектор ТОЛЬКО собирает список — fail-closed сохранён в checksGreen: падение любого
    //   чека по-прежнему отменяет мердж. Неизвестный/пустой профиль → только база (безопасный
    //   дефолт, лишний прогон никогда не мягче нужного).

    // cfg — параметр с дефолтом getConfig() (как cfg у deploy-check): в проде и в runLoop
    // прокидывают активный конфиг явно, тесты состава передают синтетический. Дефолт нужен
    // для checksGreen (её вызывают без cfg) — тогда берётся фабричный config, уже присвоенный
    // main().
    function gateChecksFor(profileName?: string, cfg: GateConfigRaw = getConfig()): GateCheck[] {
        const { base, prodChecks, prodDrop } = resolveGateChecks(cfg, fail);
        if (profileName === 'prod') {
            const kept = base.filter(([name]) => !prodDrop.includes(name));
            return [...kept, ...prodChecks];
        }
        return [...base];
    }

    // ── Прогон чеков на PR-голове (#77) ──────────────────────────────────────

    function checksGreen(
        branch: string,
        prNumber: number,
        {
            shFn = sh,
            // #193: git fetch/checkout — МУТАЦИИ на пути к автодеплою, через argv (shArgv),
            // не строкой через шелл. Имя ветки и sha PR-головы уходят отдельными элементами
            // argv — shell-инъекция закрыта структурно, а не квотированием shq(). Чтение
            // (git rev-parse) остаётся на shFn — оно не мутация (обоснование — #194).
            runArgvFn = shArgv,
            // #49: голову PR отдаёт ШОВ форжа, а не гейт. Раньше здесь стоял inline-вызов
            // `gh pr view --json headRefOid` — операция форжа, застрявшая внутри гейта: на
            // площадке без `gh` она давала три ретрая и 'not-merged' НАВСЕГДА, то есть
            // мердж-путь был мёртв целиком. Дефолт — из контекста фабрики; мердж-путь
            // прокидывает сюда метод выбранного адаптера через tryMergePhase.
            prHeadShaFn = prHeadSha,
            logFn = log,
            parkFn = parkOnOriginMain,
            syncDepsFn = syncDepsIfLockChanged,
            // env-санация чеков (#189): строит окружение по allowlist один раз на прогон
            // гейта. DI — для теста fail-closed; в проде — buildSanitizedGateEnv.
            buildGateEnvFn = buildSanitizedGateEnv,
            // Состав гейта (#80): по умолчанию база (playground) из конфига. tryMergePhase
            // прокидывает сюда список по активному профилю; для prod он длиннее на толстые
            // чеки. Дефолт вычисляется лениво (#204) — конфиг присваивается в main() уже
            // после сборки фабрики; в проде checksGreen всегда зовут с явным `checks`.
            checks = gateChecksFor(),
        }: {
            shFn?: ShFn;
            runArgvFn?: ShArgvFn;
            prHeadShaFn?: PrHeadShaFn;
            logFn?: LogFn;
            parkFn?: ParkFn;
            syncDepsFn?: SyncDepsFn;
            buildGateEnvFn?: BuildGateEnvFn;
            checks?: GateCheck[];
        } = {},
    ): boolean {
        // Сброс СРАЗУ: любой выход из этого раунда до чеков не должен носить red-check
        // прошлого раунда — tryMergePhase иначе вернул бы 'red-checks' с устаревшей
        // ошибкой и чини-сессия чинила бы уже починенное. lastVerifiedHead тоже сбрасываем:
        // старый sha не должен доехать до --match-head-commit, если этот раунд упал до чеков.
        lastRedCheck = null;
        lastVerifiedHead = null;
        // #204-ревью: пустой список чеков не имеет права привести к мерджу. Цикл ниже с
        // пустым `checks` не сделал бы ни одной итерации, lastVerifiedHead записался бы и
        // фаза уехала в main без единой проверки. Сегодня этот путь прикрыт тем, что боевой
        // fail в resolveGateChecks делает process.exit(1), но сигнатура FailFn допускает
        // возвращающийся fail (тест/иной потребитель) — тогда gateChecksFor() отдаёт []. По
        // инварианту №5 (барьеры важнее промптов) дешёвая страховка в самой точке исполнения.
        if (checks.length === 0) {
            logFn(
                `⛔ Гейт мерджа: список чеков пуст — мердж без единой проверки отменён (gate.checks в конфиге).`,
            );
            parkFn();
            return false;
        }
        // #135: валидация ДО git — это путь к авто-мерджу в main (= автодеплой прода),
        // и он единственный оставался без проверки имени ветки.
        if (!safeBranch(branch, { logFn, where: 'гейт мерджа' })) {
            parkFn();
            return false;
        }
        try {
            runArgvFn('git', ['fetch', 'origin', branch]);
        } catch (e: unknown) {
            logFn(
                `⛔ git fetch origin ${branch} упал (${(e as Error).message}) — без свежего remote нельзя убедиться, что тестируем то, что мерджим. Авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        let remoteHead: string;
        try {
            remoteHead = prHeadShaFn(prNumber);
        } catch (e: unknown) {
            logFn(
                `⛔ Не смог получить голову PR #${prNumber}: ${(e as Error).message} — авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // Формат проверяем ЗДЕСЬ, хотя шов и обязан отдавать голову либо бросать: sha уходит
        // в argv `git checkout --detach` и в `--match-head-commit`, и доверять этот путь
        // добросовестности реализации шва (в т.ч. будущей, чужого форжа) нельзя (инв. C3/7).
        if (!SHA40_RE.test(String(remoteHead))) {
            logFn(
                `⛔ Голова PR #${prNumber} не похожа на sha коммита ('${remoteHead}') — авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // H3 в worktree-модели: чеки идут на remote-голове, но незапушенная работа не
        // должна молча теряться. refs/heads/<branch> ОБЩИЙ для всех worktree репозитория —
        // это тот самый ref, куда коммитили кодер-сессии; разошёлся с PR (push агента
        // упал; допушено с другой машины) → в main уехала бы фаза без части работы или
        // непрогнанный код. Не совпало → не мерджим. Ветки нет локально (свежая машина,
        // хвост после --delete-branch) — локальной работы нет, сверять нечего: гоняем
        // чеки на PR-голове как есть.
        let localHead: string | null = null;
        try {
            localHead = shFn(`git rev-parse --verify --quiet ${shq('refs/heads/' + branch)}`);
        } catch {}
        if (localHead && localHead !== remoteHead) {
            // #466: расхождение бывает двух разных смыслов, а раньше они были схлопнуты
            // в одно сообщение. Отставший ref (localHead — предок головы PR) — не
            // конфликт: так выглядит ветка после того, как человек допушил в неё
            // (например, влил main ради внешнего красного чека). Терять тут нечего,
            // ff-подтяжка безопасна по построению.
            let refIsBehind = false;
            try {
                runArgvFn('git', ['merge-base', '--is-ancestor', localHead, remoteHead]);
                refIsBehind = true;
            } catch {}
            if (refIsBehind) {
                runArgvFn('git', ['update-ref', `refs/heads/${branch}`, remoteHead]);
                logFn(
                    `↪ Локальный ref ${branch} отстал от головы PR #${prNumber} (${localHead.slice(0, 8)} → ${remoteHead.slice(0, 8)}) — подтянут fast-forward, работа не теряется.`,
                );
            } else {
                // Настоящее ветвление: локально есть коммиты, которых нет в PR. Здесь
                // нужен человек — но подсказка обязана быть выполнимой. Дерево раннера
                // detached, а ref общий для всех worktree, поэтому ни push, ни pull не
                // помогают: лечится только принудительным переводом ref.
                logFn(
                    `⛔ Локальный ref ${branch} (${localHead.slice(0, 8)}) разошёлся с головой PR #${prNumber} (${remoteHead.slice(0, 8)}): локально есть коммиты, которых нет в PR — в main уехал бы не тот код. Разбери руками, затем: git branch -f ${branch} origin/${branch}`,
                );
                parkFn();
                return false;
            }
        }
        try {
            runArgvFn('git', ['checkout', '--detach', remoteHead]);
        } catch (e: unknown) {
            logFn(
                `⛔ Не смог встать на голову PR #${prNumber} (${(e as Error).message}) — авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // env-санация (#189): чеки и `npm ci` ниже исполняют код проверяемого PR в дереве
        // раннера, где в окружении лежат секреты петли. Строим санированный env по allowlist
        // ОДИН раз на прогон и прокидываем его и в syncDeps (npm ci), и в каждый чек. Fail-closed:
        // битый/нечитаемый allowlist → стоп, а не запуск чеков с полным env (инвариант 1).
        let gateEnv: NodeJS.ProcessEnv;
        try {
            gateEnv = buildGateEnvFn();
        } catch (e: unknown) {
            logFn(
                `⛔ Санация окружения чеков гейта не удалась (${(e as Error).message}) — чеки без allowlist не запускаем, авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // #SiaUX: PR-голова могла добавить зависимость (её package-lock новее, а node_modules
        // дерева раннера — старые). Переустанавливаем ДО чеков при расхождении lock, иначе
        // build/test упали бы красным на «module not found» из-за инфраструктуры, а не кода.
        syncDepsFn({ env: gateEnv });
        for (const [name, cmd] of checks) {
            try {
                shFn(cmd, { env: gateEnv });
                logFn(`  ✓ ${name}`);
            } catch (e: unknown) {
                logFn(`  ✗ ${name} — красный, авто-мердж отменён`);
                // Хвост вывода чека — топливо для чини-сессии гейта (self-heal): без
                // текста ошибки агент чинил бы вслепую. Спецсимволы безопасны — см. formatExcerpt.
                const err = e as { stdout?: string; stderr?: string; message?: string };
                const raw =
                    `${err.stdout || ''}\n${err.stderr || ''}`.trim() || String(err.message);
                lastRedCheck = {
                    name,
                    cmd,
                    excerpt: formatExcerpt(raw),
                };
                parkFn();
                return false;
            }
        }
        // Все чеки зелёные на ЭТОМ sha — запоминаем его для --match-head-commit при мердже
        // (#SiaTz): gh иначе смерджил бы голову PR НА МОМЕНТ мерджа, а не ту, что прогнали.
        lastVerifiedHead = remoteHead;
        return true;
    }

    // ── «Фаза уже смерджена?» ────────────────────────────────────────────────

    // ── Удаление локального ref ветки фазы после мерджа (#387) ─────────────────
    // Локальную ветку фазы создаёт САМ РАННЕР (не дерево человека) для инварианта H3 —
    // сверка «локальный ref == голова PR» перед мерджем (checksGreen). После мерджа она
    // не нужна и копится мусором фаза за фазой: `gh pr merge --delete-branch` иногда её
    // не успевает/не может убрать (дерево раннера в этот момент детачено на sha PR, не
    // стоит на branch), и тогда ref остаётся — раньше это молча объяснялось неверной
    // причиной («занятый деревом человека», #SiaUf). Зовётся ПОСЛЕ подтверждённого
    // мерджа (см. tryMergePhase), fail-open: неудача удаления — чистка, не инвариант,
    // ронять цикл она не должна. Имя ветки — только через safeBranch (anti-injection,
    // инв. C3/7), сама мутация — argv (shArgv), не строка через шелл.
    function deleteLocalBranchRef(
        branch: string,
        {
            shFn = sh,
            runArgvFn = shArgv,
            logFn = log,
        }: { shFn?: ShFn; runArgvFn?: ShArgvFn; logFn?: LogFn } = {},
    ): void {
        if (!safeBranch(branch, { logFn, where: 'deleteLocalBranchRef' })) return;
        let exists = true;
        try {
            shFn(`git rev-parse --verify --quiet ${shq('refs/heads/' + branch)}`);
        } catch {
            exists = false;
        }
        if (!exists) return;
        try {
            runArgvFn('git', ['branch', '-D', branch]);
            logFn(`🧹 Локальный ref ветки ${branch} удалён после мерджа фазы (#387).`);
        } catch (e: unknown) {
            logFn(
                `⚠ Не удалось удалить локальный ref ветки ${branch} после мерджа (${(e as Error).message}) — не критично, продолжаем.`,
            );
        }
    }

    // ── Гейт мерджа фазы ─────────────────────────────────────────────────────

    /**
     * Гейт мерджа фазы. Возвращает:
     *   'merged'             — смерджено, дерево раннера на свежем origin/main → к следующей фазе;
     *   'merge-unconfirmed'  — форж ПРИНЯЛ мердж, но не подтвердил его (#53). У площадки
     *                          мердж асинхронный: `POST /pulls/{n}/merge` отдаёт
     *                          operation_id и статус `scheduled`, а не свершившийся факт.
     *                          Раньше петля сразу фетчила origin/main и считала фазу сданной —
     *                          в непрерывном режиме следующая фаза могла строиться от
     *                          ДО-мерджевого main. «Не подтверждён» ≠ «не смерджен»: повторять
     *                          мердж нельзя, продолжать тоже, поэтому отдельный исход и стоп;
     *   'merged-local-stale' — PR СМЕРДЖЕН, но fetch/detach origin/main упал (H4). Раньше
     *                          merge и пост-мердж шаги жили в одном try, и лог ВРАЛ
     *                          «мердж не удался» при уже влитом PR — состояние надо
     *                          различать: восстановление другое (руками + рестарт);
     *   'hold'                — на PR label hold (#222): человек остановил PR. Проверяется
     *                          ПЕРВОЙ, впереди blocked — hold сильнее и не подлежит
     *                          авто-разбору вообще: ни чини-сессии, ни повторного ревью,
     *                          ни чеков. Раннер эту метку не снимает никогда (в отличие
     *                          от blocked, который снимает и переоценивает сам — #217) —
     *                          снять может только человек;
     *   'blocked'            — на PR label blocked (ревью нашло блокеры): цикл запустит
     *                          разбор блокеров (до blockedHealAttempts раз), потом человек;
     *   'red-checks'         — гейт упал именно на ЧЕКАХ (build/lint/.../test): это
     *                          чинится кодом → цикл запустит чини-сессию (self-heal);
     *   'not-merged'         — не мерджили по нечинимой причине (нет PR / blocked /
     *                          сеть-git проблемы / merge упал).
     *
     * DI (#77): коллабораторы с побочками и флаг dry — параметрами с дефолтами из
     * контекста фабрики, как у preflight/runLoop; в проде зовётся без deps.
     * getLastRedCheckFn — геттер, а не снимок: red-check ставится как побочка ВНУТРИ
     * checksGreen и читается после её вызова (та же причина, что у runLoop).
     */
    function tryMergePhase(
        phase: { branch: string; milestone?: string },
        {
            dry = DRY,
            shFn = sh,
            // #193: gh pr merge и пост-мердж git fetch/checkout — МУТАЦИИ, ведущие в main
            // (= автодеплой прода), через argv (shArgv), не строкой через шелл. shFn остаётся
            // для чтений/прочей хореографии (обоснование оставленного на shq — #194).
            runArgvFn = shArgv,
            logFn = log,
            ensureCleanFn = ensureClean,
            findOpenPrFn = findOpenPr,
            checksGreenFn = checksGreen,
            // #49: шов чтения головы PR приходит от runLoop вместе с findOpenPrFn/mergePrFn —
            // и обязан доехать до checksGreen. Иначе подмена taskSource меняла бы мердж, но
            // не прогон чеков: чеки продолжили бы спрашивать голову у GitHub («тихий дефолт»,
            // инвариант №1, тот же класс, ради которого стоит барьер #415).
            prHeadShaFn = prHeadSha,
            phaseMergedFn = phaseMerged,
            sleepFn = sleep,
            parkFn = parkOnOriginMain,
            mergePrFn = mergePr,
            deleteLocalBranchRefFn = deleteLocalBranchRef,
            getLastRedCheckFn = () => lastRedCheck,
            getVerifiedHeadFn = () => lastVerifiedHead,
            // Профиль (#80) решает состав гейта. runLoop прокидывает cfg.profileName; по
            // умолчанию (undefined) — только база, безопасный дефолт вне цикла.
            profileName = undefined,
            // #53: сколько раз спросить форж «фаза уже смерджена?» после принятого мерджа и
            // с какой паузой. Значения скромные не случайно: у синхронного форжа (GitHub)
            // первый же ответ — подтверждение, и цена проверки нулевая; у асинхронного речь
            // о секундах очереди, а не о минутах. Параметрами, а не константами, — тесты
            // обязаны проходить без реальных пауз (правило «время — параметр»).
            mergeConfirmAttempts = 6,
            mergeConfirmDelayMs = 5_000,
        }: {
            dry?: boolean;
            shFn?: ShFn;
            runArgvFn?: ShArgvFn;
            logFn?: LogFn;
            ensureCleanFn?: EnsureCleanFn;
            findOpenPrFn?: FindOpenPrFn;
            checksGreenFn?: typeof checksGreen;
            prHeadShaFn?: PrHeadShaFn;
            phaseMergedFn?: PhaseMergedFn;
            sleepFn?: SleepFn;
            parkFn?: ParkFn;
            mergePrFn?: MergePrFn;
            deleteLocalBranchRefFn?: typeof deleteLocalBranchRef;
            getLastRedCheckFn?: () => RedCheck | null;
            getVerifiedHeadFn?: () => string | null;
            profileName?: string;
            mergeConfirmAttempts?: number;
            mergeConfirmDelayMs?: number;
        } = {},
    ):
        | 'merged'
        | 'merge-unconfirmed'
        | 'merged-local-stale'
        | 'hold'
        | 'blocked'
        | 'red-checks'
        | 'not-merged' {
        // #218: сброс СРАЗУ, тем же приёмом, что checksGreen сбрасывает lastRedCheck/
        // lastVerifiedHead — раунд, упавший ДО findOpenPr (dry/грязное дерево), не должен
        // оставлять номер PR прошлого раунда для текста пуша «блокер снят автоматически».
        lastGatePr = null;
        // C1: dry-run строго read-only. Основной guard стоит в цикле ДО вызова гейта;
        // этот — defense in depth: даже если будущая правка цикла потеряет внешний
        // guard, dry-run всё равно не смерджит и не тронет дерево раннера.
        if (dry) {
            logFn('💤 DRY: гейт мерджа пропущен — ничего не мерджим и не переключаем ветки.');
            return 'not-merged';
        }
        // M2: checkout с грязью либо упадёт, либо утащит полу-работу между коммитами.
        if (!ensureCleanFn('гейт мерджа')) return 'not-merged';
        const pr = findOpenPrFn(phase.branch);
        if (!pr) {
            logFn(
                `⛔ Гейт: открытый PR ветки ${phase.branch} в main не найден — мердж невозможен.`,
            );
            return 'not-merged';
        }
        lastGatePr = pr.number;
        // #222: hold проверяется ДО blocked — человеческий стоп-кран сильнее любого
        // автоматического вердикта. Функции, снимающей hold, в коде нет вообще (в отличие
        // от removeBlockedLabel) — это структурный барьер, не полагающийся на промпт: убрать
        // метку может только человек через `gh pr edit --remove-label hold`.
        if ((pr.labels || []).some((l) => l.name === 'hold')) {
            logFn(`⛔ Гейт: PR #${pr.number} помечен 'hold' — стоп, снять может только человек.`);
            return 'hold';
        }
        if ((pr.labels || []).some((l) => l.name === 'blocked')) {
            logFn(`⛔ Гейт: PR #${pr.number} помечен 'blocked'.`);
            return 'blocked';
        }
        if (
            !checksGreenFn(phase.branch, pr.number, {
                checks: gateChecksFor(profileName),
                prHeadShaFn,
            })
        ) {
            const redCheck = getLastRedCheckFn();
            if (redCheck) {
                logFn(`⛔ Гейт: чек ${redCheck.name} красный на PR #${pr.number}.`);
                return 'red-checks';
            }
            logFn(`⛔ Гейт: не прошёл до чеков (fetch/HEAD/detach) на PR #${pr.number}.`);
            return 'not-merged';
        }
        // H4: merge и пост-мердж шаги — РАЗНЫЕ try. Упал сам merge → PR цел, честное
        // «не удался». Merge прошёл, а обновление дерева раннера упало → это НЕ «мердж
        // не удался», а «смерджено, локалка отстала»: другой статус, другое восстановление.
        //
        // Ретрай мутации (боевой случай 2026-07-19): локальный прокси оборвал соединение
        // с GitHub API на зелёном гейте, и ночь встала из-за одного сетевого чиха.
        // Мутации вслепую не ретраим — но здесь между попытками СВЕРЯЕМСЯ phaseMerged():
        // если первый вызов на самом деле прошёл (упал только ответ) — задвоения нет.
        // #SiaTz: --match-head-commit закрывает TOCTOU-окно между прогоном чеков и мерджем.
        // checksGreen тестировал ТОЧНЫЙ sha PR-головы; за минуты чеков гейта в ветку могли
        // допушить (недобитая кодер-сессия, человек с другой машины) — без этой привязки gh
        // смерджил бы новую, НЕ прогнанную голову. Сервер отвергнет мердж, если голова уехала.
        // Пусто (мок checksGreen в тестах не выставил sha) → мерджим как раньше, без привязки.
        const verifiedHead = getVerifiedHeadFn();
        // Мердж — через примитив форжа mergePr (шов TaskSourceAdapter, #369): argv (#193),
        // --match-head-commit при валидном sha (#SiaTz). Ретрай и сверку phaseMerged держит
        // ЭТА функция (оркестрация), не примитив. runArgvFn прокинут насквозь — тесты видят
        // тот же вызов `gh pr merge …`, что и раньше.
        // #53-ревью: ОДИН вопрос «мердж дошёл?» — одно терпение. Раньше сверка внутри
        // ретрая была мгновенной (один вызов), а после успешного POST — терпеливой (6×5с).
        // На асинхронном форже это давало худший из исходов: ответ оборвала сеть, операция
        // в очереди честно отвечает «не вижу», и ретрай ПОВТОРЯЛ принятый мердж — то самое
        // задвоение, которое эта же правка объявляет недопустимым. Теперь обе точки зовут
        // один помощник: сбой чтения — сгоревшая попытка, а не ответ «не смерджено».
        const mergeConfirmed = (): boolean => {
            for (let attempt = 1; attempt <= mergeConfirmAttempts; attempt++) {
                try {
                    if (phaseMergedFn(phase)) return true;
                } catch (e: unknown) {
                    logFn(
                        `⚠ Подтверждение мерджа PR #${pr.number}: форж не ответил (${String((e as Error).message).split('\n')[0]}).`,
                    );
                }
                if (attempt < mergeConfirmAttempts) sleepFn(mergeConfirmDelayMs);
            }
            return false;
        };

        let mergedOk = false;
        for (let attempt = 1; attempt <= 2 && !mergedOk; attempt++) {
            try {
                mergePrFn(pr.number, verifiedHead, { runArgvFn });
                mergedOk = true;
            } catch (e: unknown) {
                try {
                    if (mergeConfirmed()) {
                        // Безобидные причины ошибки при уже влитом PR: --delete-branch не
                        // успел/не смог удалить локальный ref ветки, который для инварианта
                        // H3 создал сам раннер (не дерево человека, #387/#SiaUf); либо сеть
                        // оборвала ответ на success. Удаление ref ниже подчищает первую причину
                        // сам раннер, независимо от того, справился ли с ней --delete-branch.
                        logFn(
                            `⚠ мердж PR #${pr.number} вернул ошибку, но PR уже влит (частая безобидная причина — ` +
                                `--delete-branch не успел удалить локальный ref ветки, созданный самим раннером для сверки H3) — продолжаем.`,
                        );
                        mergedOk = true;
                        break;
                    }
                } catch {}
                if (attempt < 2) {
                    logFn(
                        `⚠ Мердж PR #${pr.number} не удался (${String((e as Error).message).split('\n')[0]}) — повтор через 30с.`,
                    );
                    sleepFn(30_000);
                } else {
                    logFn(
                        `⛔ Гейт: мердж PR #${pr.number} не удался (${(e as Error).message}) — оставлен человеку.`,
                    );
                    parkFn();
                    return 'not-merged';
                }
            }
        }
        // #53: форж ПРИНЯЛ мердж — это ещё не «смерджено». У площадки операция асинхронная
        // (`scheduled` + operation_id), и `git fetch origin main` сразу после ответа может
        // прийти на ДО-мерджевый main. Спрашиваем сам форж, пока он не подтвердит.
        //
        // Fail-closed и БЕЗ повтора мерджа: повторять принятую операцию нельзя (задвоение),
        // продолжать по неподтверждённой — тоже (следующая фаза легла бы мимо влитого кода).
        // Поэтому отдельный исход и стоп: разбирает человек, а рестарт увидит фазу
        // смердженной веткой phaseMerged, если операция всё-таки дошла.
        if (!mergeConfirmed()) {
            logFn(
                `⛔ Гейт: мердж PR #${pr.number} принят форжем, но за ${mergeConfirmAttempts} попыток не подтверждён — ` +
                    `дерево раннера НЕ обновляем и следующую фазу не начинаем. Проверь PR руками: если он влит, ` +
                    `перезапуск увидит фазу смердженной и продолжит сам.`,
            );
            parkFn();
            return 'merge-unconfirmed';
        }
        // #387: PR подтверждённо смерджен (mergedOk) — локальный ref ветки фазы больше
        // не нужен, чистим его сами, не полагаясь на --delete-branch. Fail-open в два слоя:
        // сама deleteLocalBranchRef глотает ошибку и логирует, а try/catch здесь — defense
        // in depth на случай инжектированной в тестах/дефолт заменённой реализации, которая
        // этот контракт не соблюла. Чистка не должна ронять цикл ни при каких условиях.
        try {
            deleteLocalBranchRefFn(phase.branch, { shFn, runArgvFn, logFn });
        } catch (e: unknown) {
            logFn(
                `⚠ Удаление локального ref ветки ${phase.branch} после мерджа упало (${(e as Error).message}) — не критично, продолжаем.`,
            );
        }
        // #77: локальный main не трогаем ВООБЩЕ — его ref держит дерево человека, git не
        // даст ни занять его вторым worktree, ни обновить из-под чужого checkout.
        // «Обновлённый main» раннера = свежий origin/main + detach на нём: следующая
        // фаза стартует ровно от этого коммита.
        // Задача 28: дерево ПОТРЕБИТЕЛЯ подтягиваем ЗДЕСЬ — после подтверждённого мерджа и
        // ДО обновления дерева раннера. Порядок содержателен: своё дерево может не
        // обновиться (транзиентный git-сбой), и тогда мы уходим в `merged-local-stale`
        // мимо всего, что ниже. Фаза при этом влита, и дерево человека к исправности
        // локального git раннера отношения не имеет — оставлять его старым из-за чужого
        // сбоя значило бы вернуть ровно ту дыру, ради которой задача заводилась
        // (ревью, 1-й проход). Бросить этот вызов не может по контракту.
        updateConsumerTreeAfterMerge(runArgvFn);
        try {
            updateRunnerTreeToOriginMain(runArgvFn);
        } catch (e: unknown) {
            logFn(
                `⚠ PR #${pr.number} СМЕРДЖЕН, но дерево раннера не обновилось (${(e as Error).message}). ` +
                    `Почини руками в дереве раннера: ${RUNNER_TREE_FIX_HINT} — ` +
                    `затем перезапусти loop (рестарт увидит фазу смердженной и продолжит со следующей).`,
            );
            return 'merged-local-stale';
        }
        logFn(`✅ PR #${pr.number} смерджен (squash), дерево раннера на свежем origin/main.`);
        return 'merged';
    }

    return {
        gateChecksFor,
        checksGreen,
        tryMergePhase,
        deleteLocalBranchRef,
        // Геттеры module-level state гейта — наружу для runLoop/tryMergePhase (дефолтные
        // депы) и для ассертов тестов (то же, что раньше отдавал module.exports ralph.js).
        getLastRedCheck: (): RedCheck | null => lastRedCheck,
        getVerifiedHead: (): string | null => lastVerifiedHead,
        getLastGatePr: (): number | null => lastGatePr,
    };
}

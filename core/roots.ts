/**
 * Четыре корня: где проект, где дерево работы, где продукт и где состояние.
 *
 * Раньше понятия «корень» у ядра не было вовсе — пути собирались от CWD константами вида
 * `.claude/ralph/ralph.state.json`, то есть раннер считал, что продукт, рабочее дерево и
 * состояние лежат в одном месте. Пока ядро было копией внутри проекта, это совпадало с
 * правдой. Под подмодулем — уже нет: продукт read-only и общий для потребителей, дерево
 * работы переключается и чистится, состояние обязано пережить и то и другое.
 *
 * Ошибка в раскладке не даёт красного сразу, и этим она дорога: прогон пишет состояние
 * внутрь продукта, `git status` подмодуля перестаёт быть пустым, а связь с причиной
 * теряется через день — на bump gitlink, который тащит за собой рантайм-мусор.
 *
 *   `consumerRoot`  — дерево ПОТРЕБИТЕЛЯ: его код, его `ralph.config.json`. Дом состояния.
 *   `executionRoot` — дерево, В КОТОРОМ раннер работает: worktree фазы либо сам
 *                     `consumerRoot`. Переключается, чистится, удаляется.
 *   `productRoot`   — каталог ядра (подмодуль или клон канона). Read-only во время работы.
 *   `runtimeDir`    — состояние экземпляра: state, лок, лог, сессии, канал намерений.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

export type TRootsInput = {
    consumerRoot?: string;
    executionRoot?: string;
    productRoot?: string;
    runtimeDir?: string;
};

export type TResolvedRoots = {
    consumerRoot: string;
    executionRoot: string;
    productRoot: string;
    runtimeDir: string;
};

/** Что лежит по пути: каталог, не-каталог или ничего (битая ссылка для `stat` — ничего). */
export type TPathKind = 'dir' | 'other' | 'missing';

type TResolveDeps = {
    realpathFn?: (p: string) => string;
    /** По самой записи, БЕЗ перехода по ссылке: отличает «нет записи» от «битая ссылка». */
    lstatKindFn?: (p: string) => TPathKind;
    /** По цели ссылки: 'missing' здесь при существующей записи и означает битую ссылку. */
    statKindFn?: (p: string) => TPathKind;
};

function kindBy(stat: (p: string) => { isDirectory: () => boolean }): (p: string) => TPathKind {
    return (p: string) => {
        try {
            return stat(p).isDirectory() ? 'dir' : 'other';
        } catch {
            return 'missing';
        }
    };
}

const ROOT_NAMES = ['consumerRoot', 'executionRoot', 'productRoot', 'runtimeDir'] as const;

/**
 * Проверка ФОРМЫ пути до всякого обращения к диску.
 *
 * Относительный путь резолвился бы от CWD — то есть один и тот же конфиг означал бы разные
 * каталоги для раннера, монитора и провижн-скрипта, запущенных из разных мест (ревью !18).
 * Сегмент `..` опаснее тоньше: `path.resolve` схлопывает его ЛЕКСИЧЕСКИ, до разворачивания
 * симлинков, и `link/..` проверяется как родитель ссылки, а физически ведёт к родителю её
 * ЦЕЛИ. Тогда проверка пересечений считает раскладку законной, а запись уходит в продукт.
 * Корни задаются в конфиге один раз — `..` там не нужен вовсе, и запрет дешевле разбора.
 */
function assertPathShape(name: string, raw: string): void {
    if (!isAbsolute(raw)) {
        throw new Error(
            `Корень ${name} задан относительным путём (${raw}). Он резолвился бы от места ` +
                `запуска, и один конфиг означал бы разные каталоги для раннера, монитора и ` +
                `провижна. Задай абсолютный путь.`,
        );
    }
    if (raw.split(/[\\/]/).some((seg) => seg === '..')) {
        throw new Error(
            `Корень ${name} содержит сегмент ".." (${raw}). Такой путь схлопывается ` +
                `лексически — ДО разворачивания симлинков, — и проверка пересечений увидит ` +
                `не тот каталог, в который пойдёт запись. Задай путь без подъёмов.`,
        );
    }
}

/**
 * Абсолютный путь с развёрнутыми симлинками — по САМОМУ ГЛУБОКОМУ существующему предку.
 *
 * Прямой `realpath` здесь не годится: `runtimeDir` создаётся первым прогоном, и требовать
 * его существования значило бы требовать, чтобы раннер стартовал со второго раза. А без
 * разворачивания симлинков проверка пересечений сравнивала бы СТРОКИ и пропускала ровно
 * тот случай, ради которого заведена: worktree и симлинк дают разные пути к одному иноду.
 *
 * Существующий путь обязан быть КАТАЛОГОМ, а битая ссылка — отказ, а не «ещё не создан»:
 * опечатка в корне иначе проходит старт и всплывает позже голым ENOTDIR из середины
 * прогона, где связать её с конфигом уже нечем (ревью !18).
 */
function resolveDeep(name: string, p: string, deps: Required<TResolveDeps>): string {
    let head = p;
    const tail: string[] = [];
    for (;;) {
        if (deps.lstatKindFn(head) === 'missing') {
            const parent = dirname(head);
            // Дошли до корня ФС: разворачивать нечего, отдаём как есть.
            if (parent === head) return p;
            tail.unshift(basename(head));
            head = parent;
            continue;
        }
        const kind = deps.statKindFn(head);
        if (kind === 'missing') {
            throw new Error(
                `Корень ${name}: путь ${head} — битая символическая ссылка. Это не «каталог ` +
                    `ещё не создан», а указание в никуда: первым же прогоном оно даст ENOENT ` +
                    `в середине работы, где о конфиге уже никто не вспомнит.`,
            );
        }
        if (kind !== 'dir') {
            throw new Error(
                `Корень ${name}: путь ${head} существует, но это не каталог. Корень — место, ` +
                    `а не файл; опечатка здесь всплыла бы позже голым ENOTDIR.`,
            );
        }
        return tail.length === 0 ? deps.realpathFn(head) : join(deps.realpathFn(head), ...tail);
    }
}

/**
 * Тот же резолв, но с повторной сверкой: между проверкой существования и `realpath`
 * каталог может появиться (или быть подставлен ссылкой внутрь продукта) — и тогда в
 * результате осталась бы НЕразвёрнутая строка, а пересечение не нашлось бы (ревью !18).
 * Второй проход ловит расхождение; расходится и он — раскладка меняется прямо сейчас,
 * и это повод остановиться, а не гадать.
 */
function resolveStable(name: string, p: string, deps: Required<TResolveDeps>): string {
    const first = resolveDeep(name, p, deps);
    const second = resolveDeep(name, p, deps);
    if (first !== second) {
        throw new Error(
            `Корень ${name} резолвится нестабильно (${first} ≠ ${second}): каталог появился ` +
                `или подменён во время старта. Раскладка меняется под руками — стоп.`,
        );
    }
    return first;
}

/**
 * Лежит ли `child` внутри `parent` (или совпадает с ним).
 *
 * Разделитель в конце обязателен: `/app/state` и `/app/state-old` начинаются одинаково,
 * и наивный `startsWith` объявил бы соседей вложенными — барьер краснел бы на исправной
 * раскладке, а такой барьер отключают.
 */
function contains(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Резолв и проверка раскладки. Бросает с внятной диагностикой — какой корень не задан или
 * какая пара пересекается; тихого умолчания нет ни у одного.
 *
 * Запрещены НЕ все пересечения, и это решение, а не недосмотр. `productRoot` внутри
 * `consumerRoot` — ровно то, чем является подмодуль, а `runtimeDir` внутри `consumerRoot` —
 * его законный дом. Запрещено то, что ломает работу: состояние внутри продукта (пачкает
 * подмодуль) и состояние внутри ОТДЕЛЬНОГО дерева работы (исчезает вместе с worktree фазы —
 * ровно тогда, когда по нему собирались восстанавливаться).
 */
export function resolveRoots(input: TRootsInput, deps: TResolveDeps = {}): TResolvedRoots {
    const d = {
        realpathFn: deps.realpathFn ?? realpathSync,
        lstatKindFn: deps.lstatKindFn ?? kindBy(lstatSync),
        statKindFn: deps.statKindFn ?? kindBy(statSync),
    };

    const out = {} as Record<(typeof ROOT_NAMES)[number], string>;
    for (const name of ROOT_NAMES) {
        const raw = input[name];
        if (typeof raw !== 'string' || raw.trim() === '') {
            throw new Error(
                `Корень ${name} не задан. Раскладка ядра больше не выводится из места запуска: ` +
                    `подмодуль, дерево работы и состояние — разные места, и догадка о любом из ` +
                    `них однажды окажется неверной молча. Задай его в конфиге явно.`,
            );
        }
        const trimmed = raw.trim();
        assertPathShape(name, trimmed);
        out[name] = resolveStable(name, trimmed, d);
    }

    const pair = (a: (typeof ROOT_NAMES)[number], b: (typeof ROOT_NAMES)[number], why: string) => {
        if (contains(out[a], out[b]) || contains(out[b], out[a])) {
            throw new Error(`Корни ${a} (${out[a]}) и ${b} (${out[b]}) пересекаются: ${why}`);
        }
    };

    pair(
        'runtimeDir',
        'productRoot',
        'состояние внутри продукта делает подмодуль грязным — bump gitlink потащит рантайм за собой',
    );
    // Только когда работа идёт в ОТДЕЛЬНОМ дереве: если раннер работает дома
    // (executionRoot === consumerRoot), `<consumerRoot>/.ralph/runtime` — законный дом
    // состояния, и запрещать его значило бы запретить раскладку без worktree вовсе.
    if (out.executionRoot !== out.consumerRoot) {
        pair(
            'runtimeDir',
            'executionRoot',
            'дерево работы переключают, чистят и удаляют вместе с worktree фазы — состояние обязано это пережить',
        );
    }
    if (out.productRoot === out.executionRoot) {
        throw new Error(
            `Корни productRoot и executionRoot совпадают (${out.productRoot}): продукт — ` +
                `подмодуль внутри дерева работы, а не само дерево. Совпав, они делают ` +
                `любую запись прогона записью в продукт.`,
        );
    }
    if (out.productRoot === out.consumerRoot) {
        throw new Error(
            `Корни productRoot и consumerRoot совпадают (${out.productRoot}): ядро — ` +
                `подключённый продукт, а не сам проект. Совпав, они означают, что потребителя ` +
                `нет вовсе, и правки ядра поедут в его историю.`,
        );
    }

    return out as TResolvedRoots;
}

/**
 * Имя каталога состояния для ОДНОГО экземпляра раннера.
 *
 * Два раннера из одного дерева (боевой и playground) обязаны иметь разное состояние: общий
 * `runtimeDir` — это чужой лок, чужая фаза и чужой лог в одном файле, причём расходятся они
 * тихо. Имя детерминировано: перезапуск обязан найти СВОЁ состояние, а не завести новое.
 *
 * Хэш берётся от пути дерева, а не от одного имени профиля: два клона одного репозитория на
 * машине — обычное дело, и профиль `prod` у них разный.
 *
 * `consumerRoot` сюда передают УЖЕ РЕЗОЛВНУТЫМ — тем, что вернул `resolveRoots`. Иначе
 * запуск через симлинк и через настоящий путь дадут два namespace для одного инода, и
 * перезапуск не найдёт своё состояние (ревью !18); сырую строку функция отвергает.
 */
export function instanceNamespace(consumerRoot: string, instance: string): string {
    if (!isAbsolute(consumerRoot) || consumerRoot.split(/[\\/]/).some((seg) => seg === '..')) {
        throw new Error(
            `instanceNamespace: consumerRoot должен быть уже резолвнутым абсолютным путём ` +
                `(получено «${consumerRoot}»). Иначе один и тот же экземпляр получит разные ` +
                `каталоги состояния при запуске через симлинк и напрямую.`,
        );
    }
    const slug = instance
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    // Хэш — от пары «дерево + ИМЯ ЭКЗЕМПЛЯРА», а не от одного дерева: `prod/eu` и `prod-eu`
    // дают одинаковый slug, и без имени в хэше два разных экземпляра поделили бы state, лок
    // и лог — молча, до первого странного отказа (ревью !18). Разделитель `\0` в путях и
    // именах не встречается, поэтому склейка однозначна. Двенадцать шестнадцатеричных цифр,
    // а не восемь: восемь — 32 бита, и на десятке деревьев это уже не «никогда».
    const digest = createHash('sha256')
        .update(`${consumerRoot}\u0000${instance}`)
        .digest('hex')
        .slice(0, 12);
    return `${slug === '' ? 'instance' : slug}-${digest}`;
}

/**
 * Откуда ядро знает, что его запустил launcher: флаг `--consumer <каталог>` в argv ядра
 * (#140). Флаг, а не переменная окружения: env наследуют сессии и всё, что они запускают,
 * — песочница живого цикла, поднятая сессией, получила бы чужой `consumerRoot` молча.
 */
export const LAUNCH_CONSUMER_FLAG = '--consumer';

/** Контекст старта через launcher: каталог потребителя (`--consumer`) и окружение. */
export type TLaunchContext = {
    consumerRoot: string;
    env: Record<string, string | undefined>;
};

/**
 * `--consumer` из argv ядра; нет флага — `null` (ядро запущено не launcher'ом). Значение без
 * пути, относительный путь и повтор — отказ: флаг ставит launcher своим каталогом, и любое
 * из трёх значит, что argv собран не им, — угадывать дерево потребителя ядро не вправе.
 */
export function parseLaunchConsumer(argv: string[]): string | null {
    const at = argv.indexOf(LAUNCH_CONSUMER_FLAG);
    if (at === -1) return null;
    if (argv.indexOf(LAUNCH_CONSUMER_FLAG, at + 1) !== -1) {
        throw new Error(
            `${LAUNCH_CONSUMER_FLAG} повторён: флаг ставит ./ralph своим каталогом, руками его не задают.`,
        );
    }
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--') || !isAbsolute(value)) {
        throw new Error(
            `${LAUNCH_CONSUMER_FLAG} без абсолютного пути (${String(value)}): каталог ` +
                `потребителя передаёт launcher, и путь от места запуска здесь не годится.`,
        );
    }
    return value;
}

/**
 * Каталог состояния пользователя: `XDG_STATE_HOME`, иначе `~/.local/state` (решение задачи
 * 35). Окружение — параметром: домашний каталог — адрес машины, и модуль, дотянувшийся до
 * него сам, был бы якорем наружу (`tests/outside-deps.test.ts`). Относительное значение —
 * отказ: база у него — место запуска, а у launcher, ядра и монитора оно разное.
 */
export function stateHomeDir(env: Record<string, string | undefined>): string {
    for (const [name, suffix] of [
        ['XDG_STATE_HOME', []],
        ['HOME', ['.local', 'state']],
    ] as const) {
        const value = env[name];
        if (value === undefined || value === '') continue;
        if (!isAbsolute(value)) {
            throw new Error(
                `${name}=${value} не абсолютный путь: умолчание runtimeDir выводить не от чего.`,
            );
        }
        return join(value, ...suffix);
    }
    throw new Error(
        'Умолчание runtimeDir выводить не от чего: нет ни XDG_STATE_HOME, ни HOME. Задай roots.runtimeDir явно.',
    );
}

/** Суффикс имени соседнего дерева раннера по умолчанию — общий, не проектный (#204). */
const RALPH_WORKTREE_SUFFIX = '-ralph';

/** Имя дерева раннера по умолчанию: `<basename(repoRoot)>-ralph` (`/path/to/app-ralph`). */
export function defaultRunnerWorktreeDirname(repoRoot: string): string {
    return basename(repoRoot) + RALPH_WORKTREE_SUFFIX;
}

/**
 * Путь дерева раннера — одно правило на раннер (`resolveWorktreePath`) и вывод
 * `executionRoot` (#140): две копии уже расходились (trim у одной, не у другой), и при
 * значении с пробелом по краю лог старта и doctor называли одно дерево, а раннер работал в
 * другом. `runnerWorktreePath` конфига важнее `RALPH_WORKTREE_PATH` — молчаливая перебивка
 * явной настройки окружением была бы тихим сдвигом режима; ни того, ни другого —
 * `../<runnerWorktreeDirname>`, иначе `../<имя дерева>-ralph`. Значения не обрезаются: путь
 * с пробелом — тот путь, в котором раннер и будет работать. Нестроковое значение ключа —
 * как его отсутствие (форму конфига проверяет resolver).
 */
export function runnerWorktreePathFor(
    cfg: { runnerWorktreePath?: unknown; runnerWorktreeDirname?: unknown },
    vars: Readonly<Record<string, string | undefined>>,
    repoRoot: string,
): string {
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const override = str(cfg.runnerWorktreePath) || str(vars['RALPH_WORKTREE_PATH']);
    if (override) return resolve(repoRoot, override);
    const name = str(cfg.runnerWorktreeDirname) || defaultRunnerWorktreeDirname(repoRoot);
    return resolve(repoRoot, '..', name);
}

/**
 * Корни, которых конфиг не назвал, при старте через launcher (#140). Без этого ядро из
 * установки отказывало без секции `roots`, а корни обязаны были быть абсолютными путями
 * машины — и конфиг потребителя приходилось выносить из git, держа рядом шаблон: публичный
 * репозиторий не должен нести пути конкретной машины.
 *
 * Умолчания — не догадка от места запуска, а то, что launcher знает сам:
 *   `consumerRoot`  — его `--consumer`;
 *   `runtimeDir`    — `<состояние пользователя>/ralph/<instanceNamespace>` (решение задачи 35):
 *                     вне дерева потребителя, своё у каждого профиля;
 *   `executionRoot` — соседнее дерево раннера той же функцией, что у `resolveWorktreePath`
 *                     (`runnerWorktreePathFor`): названный в логе корень — то дерево, где
 *                     раннер действительно работает.
 * `productRoot` здесь не выводится: его выводит из lock `assertValidRoots` (#134).
 *
 * Явный ключ перекрывает умолчание. Явный `consumerRoot`, разошедшийся с `--consumer`, —
 * отказ с обоими путями: ядро сверяло бы lock по одному дереву, а launcher — по другому.
 * Сравнение — по каноническим путям, симлинк расхождением не считается.
 */
export function launcherRootsInput(
    raw: TRootsInput,
    ctx: TLaunchContext,
    instance: string,
    worktree: { runnerWorktreePath?: unknown; runnerWorktreeDirname?: unknown },
    realpathFn: (p: string) => string = realpathSync,
): { input: TRootsInput; defaulted: string[] } {
    const canon = (p: string): string => {
        try {
            return realpathFn(p);
        } catch {
            return resolve(p);
        }
    };
    assertPathShape('consumerRoot (--consumer)', ctx.consumerRoot);
    const consumer = canon(ctx.consumerRoot);
    const explicit = typeof raw.consumerRoot === 'string' ? raw.consumerRoot.trim() : '';
    if (explicit !== '' && isAbsolute(explicit) && canon(explicit) !== consumer) {
        throw new Error(
            `roots.consumerRoot (${explicit}) расходится с каталогом launcher (--consumer ` +
                `${ctx.consumerRoot}): ядро сверяло бы lock по одному дереву, а launcher — по ` +
                `другому. Убери ключ из конфига — launcher назовёт дерево сам — или запусти ` +
                `./ralph из ${explicit}.`,
        );
    }
    const input: TRootsInput = { ...raw };
    const defaulted: string[] = [];
    const missing = (v: unknown) => typeof v !== 'string' || v.trim() === '';
    if (missing(input.consumerRoot)) {
        input.consumerRoot = consumer;
        defaulted.push('consumerRoot');
    }
    if (missing(input.runtimeDir)) {
        input.runtimeDir = join(
            stateHomeDir(ctx.env),
            'ralph',
            instanceNamespace(consumer, instance),
        );
        defaulted.push('runtimeDir');
    }
    if (missing(input.executionRoot)) {
        input.executionRoot = runnerWorktreePathFor(worktree, ctx.env, consumer);
        defaulted.push('executionRoot');
    }
    return { input, defaulted };
}

/**
 * Строка раскладки для лога старта и doctor: все четыре корня и какие из них выведены.
 * Выведенный корень, не названный вслух, человек искал бы в конфиге — и не нашёл бы.
 */
export function describeRoots(
    roots: TResolvedRoots,
    defaulted: readonly string[],
    productRootFrom: 'config' | 'lock' | null = null,
): string {
    const from = (name: string): string => {
        if (name === 'productRoot' && productRootFrom === 'lock') return ' (из lock)';
        return defaulted.includes(name) ? ' (умолчание launcher)' : '';
    };
    return '🗂  Корни: ' + ROOT_NAMES.map((n) => `${n}=${roots[n]}${from(n)}`).join(', ');
}

/**
 * Путь относительно базы — но абсолютный остаётся собой.
 *
 * `path.join('/work/tree', '/state/ralph.log')` даёт `/work/tree/state/ralph.log`: склейка
 * молча теряет абсолютность, и файл уезжает ВНУТРЬ дерева работы — ровно туда, откуда его
 * увозили. Отказ при этом тихий: раннер пишет лог в одно место, монитор читает другое и
 * показывает «раннер молчит» (ревью !19).
 */
export function underRoot(base: string, p: string): string {
    return isAbsolute(p) ? p : join(base, p);
}

type TWriteDeps = {
    /** `mode` — права, с которыми создать временный файл (права цели, если она была). */
    writeFn?: (path: string, data: string, mode?: number) => void;
    renameFn?: (from: string, to: string) => void;
    /** Права существующего целевого файла; `null` — файла ещё нет. */
    modeOfFn?: (path: string) => number | null;
};

/**
 * Права существующего файла состояния; `null` — файла ещё нет (новый получит права от umask).
 *
 * `lstat`, а не `stat`, и символическая ссылка — ОТКАЗ (ревью !20). Через ссылку сюда
 * приехали бы права её цели: подставленная ссылка на файл 0666 сделала бы новый state
 * доступным на запись всем, причём тихо. И сам `rename` поверх ссылки заменил бы саму
 * ссылку, а не то, на что она указывает, — состояние оказалось бы не там, где его ждут.
 */
function modeOf(p: string): number | null {
    let st;
    try {
        st = lstatSync(p);
    } catch {
        return null;
    }
    if (st.isSymbolicLink()) {
        throw new Error(
            `Файл состояния ${p} — символическая ссылка. Ни права, ни место записи в этом ` +
                `случае не те, что предполагает вызывающий: замена пошла бы поверх ссылки, а ` +
                `права приехали бы от её цели.`,
        );
    }
    return st.mode & 0o777;
}

// Счётчик в пределах ПОТОКА: имени временного файла нужна уникальность, а не случайность
// (`Math.random()` дал бы недетерминированный тест на ровном месте). Поэтому в имя входит и
// `threadId`: у worker-потоков один `process.pid`, но свой счётчик с нуля — два потока иначе
// взяли бы одно имя, перетёрли данные друг друга, и один получил бы ENOENT на rename
// (ревью !18).
let tmpCounter = 0;

/**
 * Запись файла состояния целиком или никак: временный файл рядом, затем `rename`.
 *
 * Прямая запись оставляет полуфайл, если прогон прервали посередине, — и раннер при
 * следующем старте читает битый JSON состояния как «состояния нет». Временный файл лежит
 * В ТОМ ЖЕ каталоге намеренно: `rename` атомарен только в пределах одной файловой системы,
 * а `/tmp` на другой ФС превращает его в копирование — то есть ровно в тот обрыв, от
 * которого мы уходим.
 */
export function writeFileAtomic(target: string, data: string, deps: TWriteDeps = {}): void {
    // Права задаются ПРИ СОЗДАНИИ временного файла, а не отдельным `chmod` после записи:
    // между записью и chmod оставалось окно, в котором файл существует с правами от umask,
    // и оно же было гонкой — chmod мог примениться уже не к тому иноду (ревью !20).
    // Флаг `wx` — создать эксклюзивно: имя временного уникально по процессу, потоку и
    // счётчику, и совпадение означало бы не «перезапишем», а что-то, чего мы не понимаем.
    const write =
        deps.writeFn ??
        ((p: string, text: string, mode?: number) => {
            guardSideEffect(`writeFileAtomic(${p})`, 'Подмени writeFn/renameFn в тесте.');
            writeFileSync(p, text, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
        });
    const rename =
        deps.renameFn ??
        ((from: string, to: string) => {
            guardSideEffect(`writeFileAtomic:rename(${to})`, 'Подмени writeFn/renameFn в тесте.');
            renameSync(from, to);
        });

    // Права ЦЕЛЕВОГО файла переносятся на временный: `rename` кладёт поверх новый инод со
    // своими правами от umask, и state, лежавший 0600, после первой же записи стал бы
    // читаемым всем — тихо, без единого сообщения (ревью !19).
    const mode = deps.modeOfFn ? deps.modeOfFn(target) : modeOf(target);

    tmpCounter += 1;
    const tmp = join(
        dirname(target),
        `.tmp-${String(process.pid)}-${String(threadId)}-${String(tmpCounter)}-${basename(target)}`,
    );
    write(tmp, data, mode ?? undefined);
    rename(tmp, target);
}

/**
 * Умолчания корней — только ядру из установки (#140). Клон, получивший `--consumer`, —
 * argv, собранный не launcher'ом, и раскладку для него конфиг обязан назвать явно: иначе
 * «без launcher — корни явно» снималось бы одним флагом. `null` — отказа нет.
 */
export function rootsDefaultRefusal(
    defaulted: readonly string[],
    installed: boolean,
    productRoot: string,
): string | null {
    if (defaulted.length === 0 || installed) return null;
    return (
        `умолчания корней (${defaulted.join(', ')}) выводятся только для ядра из установки, ` +
        `запущенного ./ralph; ядро ${productRoot} не из установки — задай roots в конфиге явно`
    );
}

/**
 * Строки doctor о раскладке: сами корни (выведенный корень doctor обязан назвать — в
 * конфиге его нет) и отказ умолчаний тем же текстом, что у старта. Раскладки нет — строк нет.
 */
export function doctorRootsLines(
    roots: TResolvedRoots | null,
    defaulted: readonly string[],
    productRootFrom: 'config' | 'lock' | null,
    installed: boolean,
    productRoot: string,
): { ok: boolean; line: string }[] {
    if (roots === null) return [];
    const refusal = rootsDefaultRefusal(defaulted, installed, productRoot);
    return [
        { ok: true, line: describeRoots(roots, defaulted, productRootFrom) },
        ...(refusal === null ? [] : [{ ok: false, line: refusal }]),
    ];
}

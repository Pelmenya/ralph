/**
 * Реестр пакетов харнессов: обнаружение, проверка, выбор (Фаза 16c, #180).
 *
 * До карточки харнесс выбирался ветвлением в ядре — `switch` по имени в `core/guard-probe.ts`
 * и список `GUARD_WIRED_HARNESSES`, — и каждый новый CLI правил ядро. Теперь пакет лежит
 * каталогом `harnesses/<имя>/`, реестр находит его сам, а ядро получает принятые пакеты
 * через этот модуль, как получает `capabilities` рантаймов (#118), и по имени их не знает.
 *
 * Пакет принимается только целиком, и каждая проверка закрывает свой способ подключить
 * не то, что ревьюили:
 *   - описание (`descriptor.json`) проходит схему (`harnesses/descriptor.ts`), а его
 *     `harness` равен имени каталога: переименованный каталог иначе подменял бы чужой пакет;
 *   - команда нормализатора из описания лежит в пакете: хук позовёт её на каждом вызове, и
 *     несуществующая команда блокировала бы всё уже в сессии, а не на старте;
 *   - версия интерфейса кода (`harness-package.ts`) равна той, что знает реестр, и
 *     сверяется ДО остальной формы: поля чужой версии значат не то, что ждёт ядро;
 *   - `harness` кода равен имени каталога, а функции на месте.
 *
 * Отказ одного пакета остальные не роняет: реестр помнит его причины, а решает ядро —
 * пакет, в который конфиг может отправить сессию, обязан быть принят, иначе старт отменён с
 * этими причинами (`core/guard-probe.ts`). Каталог `harnesses/` не прочитался — отказ всех,
 * а не «пакетов нет»: пустой реестр выглядел бы исправным.
 *
 * Загрузка — `await import()` на верхнем уровне модуля: ядро синхронно, а пакет — код,
 * который грузится один раз на процесс. Пакет поэтому не импортирует реестр (цикл на
 * незавершённом `await`), только `harness-package.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    parseHarnessDescriptor,
    type HarnessDescriptor,
    type MAPPED_OPERATIONS,
} from './harnesses/descriptor.ts';
import { HARNESS_INTERFACE_VERSION, type HarnessPackage } from './harness-package.ts';
import { BARRIER_REASON_CODES, isBarrierReasonCode } from './barrier-reason.ts';

/** Каталог пакетов — рядом с модулем, а не от места запуска. */
export const HARNESSES_DIR = path.join(import.meta.dirname, 'harnesses');

/** Модуль кода пакета и его описание — имена файлов внутри каталога пакета. */
export const PACKAGE_MODULE = 'package.ts';
export const PACKAGE_DESCRIPTOR = 'descriptor.json';

/**
 * Харнесс, в чьём формате раннер собирает настройки сессии (`core/session-settings.ts`):
 * из них строятся регистрации остальных пакетов. Знание о формате — здесь, у адаптеров, а не
 * в ядре.
 */
export const SESSION_SETTINGS_HARNESS = 'claude-code';

export type LoadedHarness = {
    pkg: HarnessPackage;
    descriptor: HarnessDescriptor;
    /** Абсолютный путь команды нормализатора — его позовёт хук. */
    normalizerPath: string;
};

export type HarnessRegistry = {
    packages: ReadonlyMap<string, LoadedHarness>;
    /** Причины отказа по имени пакета; `*` — каталог пакетов не прочитан вовсе. */
    problems: ReadonlyMap<string, readonly string[]>;
};

export const ALL_PACKAGES = '*';

export type RegistryDeps = {
    root?: string;
    listDirsFn?: (dir: string) => string[];
    readFileFn?: (p: string) => string;
    existsFn?: (p: string) => boolean;
    importFn?: (p: string) => Promise<unknown>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Каталоги пакетов: служебные (`__fixtures__`, скрытые) пакетами не считаются. */
const defaultListDirs = (dir: string) =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !/^[_.]/.test(e.name))
        .map((e) => e.name)
        .sort();

const PACKAGE_FUNCTIONS = ['guardRegistration', 'matcherCovers', 'hookPayload'] as const;
const PLUGIN_FUNCTIONS = ['source', 'read', 'event'] as const;

/**
 * Проблемы одной пробы состава пакета. Запрещённое ждёт код ПРАВИЛА из перечня, как у
 * `probeSpecProblems`: проба с кодом неисправности (`rule-fault`) засчитала бы барьер,
 * блокирующий всё со своей поломкой, — ровно то, что закрывала #183. Типом это не держится:
 * пакет грузится в рантайме, и `HarnessProbe` о его составе ничего не обещает.
 */
function harnessProbeProblems(p: unknown, i: number): string[] {
    const at = `${PACKAGE_MODULE}: probes[${i}]`;
    if (!isRecord(p)) return [`${at} не объект`];
    if (p.expect === 'allowed') {
        return p.reasonCode === undefined ? [] : [`${at}: код причины у разрешённой пробы`];
    }
    if (p.expect !== 'blocked') return [`${at}: expect не blocked и не allowed`];
    if (!isBarrierReasonCode(p.reasonCode)) return [`${at}: код причины не из перечня`];
    if (BARRIER_REASON_CODES[p.reasonCode].class !== 'rule') {
        return [`${at}: код ${p.reasonCode} — неисправность барьера, а не правило`];
    }
    return [];
}

/** Проблемы кода пакета; пустой список — интерфейс принят. */
export function harnessPackageProblems(raw: unknown, name: string): string[] {
    if (!isRecord(raw)) return [`${PACKAGE_MODULE}: нет экспорта harnessPackage`];
    if (raw.interfaceVersion !== HARNESS_INTERFACE_VERSION) {
        return [
            `${PACKAGE_MODULE}: несовместимая версия интерфейса ${JSON.stringify(raw.interfaceVersion)} ` +
                `(реестр знает ${HARNESS_INTERFACE_VERSION})`,
        ];
    }
    const problems: string[] = [];
    if (raw.harness !== name) {
        problems.push(
            `${PACKAGE_MODULE}: harness ${JSON.stringify(raw.harness)} не равен имени каталога «${name}»`,
        );
    }
    for (const fn of PACKAGE_FUNCTIONS) {
        if (typeof raw[fn] !== 'function') problems.push(`${PACKAGE_MODULE}: нет функции ${fn}`);
    }
    if (!Array.isArray(raw.probes) || raw.probes.length === 0) {
        problems.push(`${PACKAGE_MODULE}: нет состава пробы probes`);
    } else {
        problems.push(...raw.probes.flatMap((p, i) => harnessProbeProblems(p, i)));
    }
    for (const flag of ['setsProjectDirEnv', 'skillBarrier'] as const) {
        if (typeof raw[flag] !== 'boolean') problems.push(`${PACKAGE_MODULE}: ${flag} не boolean`);
    }
    if (raw.guardInput !== 'event' && raw.guardInput !== 'compat-16b') {
        problems.push(`${PACKAGE_MODULE}: guardInput не event и не compat-16b`);
    }
    const limit = raw.guardLimit;
    if (limit !== null && (typeof limit !== 'string' || limit.trim() === '')) {
        problems.push(`${PACKAGE_MODULE}: guardLimit не null и не непустая строка`);
    }
    const layers = raw.projectLayers;
    if (layers !== null && (!isRecord(layers) || typeof layers.homes !== 'function')) {
        problems.push(`${PACKAGE_MODULE}: projectLayers не null и не объект с функцией homes`);
    }
    const plugin = raw.plugin;
    if (plugin !== null) {
        if (!isRecord(plugin)) {
            problems.push(`${PACKAGE_MODULE}: plugin не null и не объект`);
        } else {
            for (const fn of PLUGIN_FUNCTIONS) {
                if (typeof plugin[fn] !== 'function')
                    problems.push(`${PACKAGE_MODULE}: нет функции plugin.${fn}`);
            }
        }
    }
    return problems;
}

async function loadOne(
    name: string,
    dir: string,
    deps: Required<Omit<RegistryDeps, 'root' | 'listDirsFn'>>,
): Promise<{ loaded: LoadedHarness } | { problems: string[] }> {
    let descriptor: HarnessDescriptor;
    try {
        const raw = JSON.parse(deps.readFileFn(path.join(dir, PACKAGE_DESCRIPTOR))) as unknown;
        descriptor = parseHarnessDescriptor(raw, `${name}/${PACKAGE_DESCRIPTOR}`);
    } catch (error) {
        return { problems: [`${PACKAGE_DESCRIPTOR}: ${message(error)}`] };
    }
    const problems: string[] = [];
    if (descriptor.harness !== name) {
        problems.push(
            `${PACKAGE_DESCRIPTOR}: harness «${descriptor.harness}» не равен имени каталога «${name}»`,
        );
    }
    const normalizerPath = path.join(dir, descriptor.normalizer);
    if (!deps.existsFn(normalizerPath)) {
        problems.push(`нормализатора ${descriptor.normalizer} в пакете нет`);
    }
    let mod: unknown;
    try {
        mod = await deps.importFn(path.join(dir, PACKAGE_MODULE));
    } catch (error) {
        return { problems: [...problems, `${PACKAGE_MODULE} не загрузился: ${message(error)}`] };
    }
    const pkg = isRecord(mod) ? mod.harnessPackage : undefined;
    problems.push(...harnessPackageProblems(pkg, name));
    if (problems.length > 0) return { problems };
    return { loaded: { pkg: pkg as HarnessPackage, descriptor, normalizerPath } };
}

/** Все пакеты каталога: принятые и причины отказа остальных. Не бросает. */
export async function discoverHarnessPackages(deps: RegistryDeps = {}): Promise<HarnessRegistry> {
    const {
        root = HARNESSES_DIR,
        listDirsFn = defaultListDirs,
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        existsFn = (p) => fs.existsSync(p),
        importFn = (p) => import(pathToFileURL(p).href),
    } = deps;
    const packages = new Map<string, LoadedHarness>();
    const problems = new Map<string, string[]>();
    let names: string[];
    try {
        names = listDirsFn(root);
    } catch (error) {
        problems.set(ALL_PACKAGES, [`каталог пакетов ${root} не прочитан: ${message(error)}`]);
        return { packages, problems };
    }
    for (const name of names) {
        const r = await loadOne(name, path.join(root, name), { readFileFn, existsFn, importFn });
        if ('loaded' in r) packages.set(name, r.loaded);
        else problems.set(name, r.problems);
    }
    return { packages, problems };
}

export type HarnessSelection = { ok: true; harness: LoadedHarness } | { ok: false; reason: string };

/** Пакет харнесса для сессии либо причина, по которой его нет. */
export function selectHarness(registry: HarnessRegistry, harness: string): HarnessSelection {
    const loaded = registry.packages.get(harness);
    if (loaded) return { ok: true, harness: loaded };
    const own = registry.problems.get(harness) ?? registry.problems.get(ALL_PACKAGES);
    if (own) {
        return {
            ok: false,
            reason: `пакет харнесса «${harness}» не принят реестром: ${own.join('; ')}`,
        };
    }
    return { ok: false, reason: `пакета харнесса «${harness}» в реестре нет` };
}

/**
 * Путь команды нормализатора принятого пакета в каталоге ядра `coreRoot` либо причина, по
 * которой его нет (#186). Регистрация guard несёт этот путь хуку переменной: сам хук путь
 * пакета не собирает — барьер не зависит от пакетов (`tests/harness-package-deps.test.ts`).
 * Путь переносится на `coreRoot`, потому что хуки регистрации — из того же ядра, что
 * исполняется (`productRoot` раннера), а не обязательно из каталога этого модуля.
 */
export function normalizerPathIn(
    registry: HarnessRegistry,
    harness: string,
    coreRoot: string,
): { ok: true; path: string } | { ok: false; reason: string } {
    const selected = selectHarness(registry, harness);
    if (!selected.ok) return selected;
    const fromCore = path.relative(
        path.dirname(import.meta.dirname),
        selected.harness.normalizerPath,
    );
    return { ok: true, path: path.join(coreRoot, fromCore) };
}

/**
 * Операции, которых в сессии петли быть не должно (#225): субагент и отложенный ход. Раннер не
 * видит ни ходов, ни стоимости, ни обрыва субагента, а сессию `-p`, отложившую ход, снаружи
 * никто не будит. Guard держит их правилом `loop-delegation`; этот перечень — для первого слоя,
 * флага запуска CLI.
 */
export const LOOP_DENIED_OPERATIONS: readonly (typeof MAPPED_OPERATIONS)[number][] = [
    'agent',
    'defer',
];

/**
 * Инструменты принятого пакета, которые в сессии петли запрещает флаг запуска: класс объявляет
 * описание (`toolMap`), а не перечень имён в ядре — новый инструмент того же класса уходит под
 * запрет правкой описания. Пакет не принят — бросок: argv без запрета выглядел бы запретом.
 */
export function loopDeniedTools(registry: HarnessRegistry, harness: string): string[] {
    const selected = selectHarness(registry, harness);
    if (!selected.ok) throw new Error(`запрет субагентов в сессии петли: ${selected.reason}`);
    return Object.entries(selected.harness.descriptor.toolMap)
        .filter(([, op]) => LOOP_DENIED_OPERATIONS.includes(op))
        .map(([tool]) => tool);
}

/** Реестр процесса: пакеты грузятся один раз, при первом импорте модуля. */
/**
 * Расхождение фактической версии CLI с той, с которой снято описание пакета (`cliVersion`).
 * Перечни полей описания строгие, а CLI обновляется сам: новое поле конверта после
 * автообновления — `unknown-field` на каждом вызове, петля жжёт итерации до брейкера, а
 * стартовая проба этого не видит — её синтетический вход несёт пять полей. До сверки
 * описания стендом (Фаза 16f) расхождение называется строкой, а не молчит. `null` — версии
 * совпали, пакета нет или версия не прочиталась (о нечитаемой говорит журнал попытки).
 */
export function cliVersionDrift(
    registry: HarnessRegistry,
    harness: string,
    actual: string,
    unknownVersion: string,
): string | null {
    const expected = registry.packages.get(harness)?.descriptor.cliVersion;
    if (expected === undefined || actual === unknownVersion || actual === expected) return null;
    return (
        `описание пакета «${harness}» снято с CLI ${expected}, исполняется ${actual}: перечни ` +
        'полей строгие, и новое поле входа заблокирует каждый вызов кодом unknown-field — ' +
        'сверь описание с этой версией (до стенда Фазы 16f сверки нет)'
    );
}

export const HARNESS_REGISTRY: HarnessRegistry = await discoverHarnessPackages();

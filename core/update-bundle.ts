/**
 * Комплект PR смены ревизии: lock, данные контура и снимок инвентаря MCP одним коммитом
 * (Фаза 16c3, #218).
 *
 * До карточки действующие данные контура потребителя (`.claude/ralph/hooks.json`) на явные
 * эффекты MCP не мигрировал никто: мигратор (`.claude/hooks/mcp-effects.cjs`, #185) был, а
 * `./ralph update` коммитил только lock и повтор узнавал только по нему. Переключи guard на
 * эффекты раньше данных — и петля потеряла бы все чтения, которые ей даёт префикс. Решения:
 *
 *   - **Одна база.** Lock, мигрированные данные и снимок собираются из того же коммита
 *     свежего `main`, поверх которого ложится коммит PR (`commitBundleOnBranch`), а не из
 *     дерева человека: данные, мигрированные из устаревшего дерева, разошлись бы с базой PR.
 *     Файл данных, как и прежде, под ship человека — PR обновления его меняет, но не мерджит.
 *   - **Инвентарь обязателен там, где есть что мигрировать.** Сервер не ответил, ответ
 *     неполный, снимок пуст — стоп обновления с причиной до пуша ветки: пустой инвентарь
 *     молча снял бы все чтения. Исключение одно и названо строкой: в базе нет ни `.mcp.json`,
 *     ни MCP-политики в данных — переносить нечего, а стоп здесь запретил бы обновление
 *     каждому потребителю без MCP навсегда. Предел назван: `.mcp.json` берётся из базы, а
 *     сервер исполняется с cwd дерева человека (`./ralph` экспорта базы не делает) — файлы
 *     сервера с относительным путём ищутся там, где их видит человек.
 *   - **Эквивалентность в трёх местах.** Решения до и после миграции сравниваются настоящим
 *     `decideEvent` на `инвентарь ∪ writeAllowed` (`equivalenceProblems` мигратора): сам
 *     мигратор, launcher до публикации (`updateBundle`) и гейт PR потребителя
 *     (`verifyMcpMigration`, команда `./ralph verify-mcp`) — по снимку и базовому коммиту из
 *     git, без сети. Третье место нужно потому, что PR живёт дольше проверки launcher'а:
 *     правка данных в ветке PR после публикации до гейта не дошла бы ни одной сверкой. Гейт
 *     обещает эквивалентность только PR миграции; при мигрированной базе изменённые решения
 *     он называет строкой `⚠`, а держит их ship человека (докблок `verifyMcpMigration`).
 *   - **Свежесть отдельно от миграции.** Уже мигрированные данные обновление сверяет со
 *     свежим снимком: чтение, которого у серверов больше нет, — стоп; новый инструмент,
 *     которому прежнее правило дало бы чтение, — строка `⚠`, в политику его пишет ревью.
 *   - **Откат возвращает комплект.** `rollbackBundle` берёт коммит базы, поставивший нынешний
 *     lock, и возвращает данные и снимок к его родителю тем же коммитом, что и lock. Данные,
 *     правленые после обновления, — отказ: откат вернул бы и чужую правку.
 *
 * Мигратор — CommonJS хуков: исполняемое ядра, загружается из ЭТОЙ ревизии `createRequire`
 * от каталога модуля. Это не код дерева под PR: launcher исполняет установленную ревизию.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { createRequire } from 'node:module';
import type * as TConsumerDataModule from '../.claude/hooks/consumer-data.cjs';
import type * as TMcpEffectsModule from '../.claude/hooks/mcp-effects.cjs';
import { CORE_LOCK_PATH, type TCoreLock } from './core-install.ts';
import { lockBundleFile, type TBaseView, type TBundleFile } from './core-update.ts';
import {
    buildSnapshot,
    checkSnapshot,
    collectInventory,
    MCP_INVENTORY_PATH,
    MCP_SERVERS_PATH,
    parseMcpServers,
    parseSnapshot,
    serializeSnapshot,
    type THarnessMcpNames,
    type TListPageFn,
    type TMcpSnapshot,
} from './mcp-inventory.ts';

const requireHook = createRequire(import.meta.url);
const { parseConsumerData } = requireHook(
    '../.claude/hooks/consumer-data.cjs',
) as typeof TConsumerDataModule;
const { migrateMcpEffects, equivalenceProblems, toolsFreshness } = requireHook(
    '../.claude/hooks/mcp-effects.cjs',
) as typeof TMcpEffectsModule;

/** Данные контура — файл потребителя, путь от корня его дерева. */
export const CONTOUR_DATA_PATH = '.claude/ralph/hooks.json';

type TMcpData = ReturnType<typeof parseConsumerData>['mcp'];

export type TBundleResult = { files: TBundleFile[]; lines: string[] };

/** Полные имена инструментов снимка — инвентарь мигратора. */
export function inventoryNames(snapshot: TMcpSnapshot): string[] {
    return Object.values(snapshot.servers)
        .flatMap((s) => s.tools.map((t) => t.name))
        .sort();
}

function parseData(text: string | null, where: string): TMcpData {
    try {
        return parseConsumerData(text ?? '{}', CONTOUR_DATA_PATH).mcp;
    } catch (e) {
        throw new Error(`данные контура ${where} не разобрались — ${(e as Error).message}`);
    }
}

/** Держат ли данные хоть какую-то MCP-политику: без неё и без серверов мигрировать нечего. */
function hasMcpPolicy(mcp: TMcpData): boolean {
    return mcp.toolsDeclared || mcp.writeAllowed.size > 0 || mcp.neverExceptions.size > 0;
}

/**
 * Снимок из текста, проверенный против настроенных серверов и переводов имён харнессов, — или
 * `null`, если не годен. Набор проверок тот же, что у сверки перед сессией (`checkMcpDrift`):
 * снимок, принятый здесь, там не будет назван `invalid`.
 */
function verifiedSnapshot(
    text: string | null,
    configured: readonly string[],
    harnesses: readonly THarnessMcpNames[],
): TMcpSnapshot | null {
    if (text === null) return null;
    const r = parseSnapshot(text, { configured, harnesses });
    return r.ok ? r.value : null;
}

/**
 * Комплект update из базы: lock, данные контура (мигрированные, если были прежней формы) и
 * снимок инвентаря, если он изменился. Отказ — бросок с причиной: ветка не пушится, PR нет.
 *
 * Свежий снимок проходит ту же `checkSnapshot`, что и снимок из файла: сборщик не проверяет
 * имена инструментов (`a__b`), дубли и переводы `mcpNames`, и такой снимок уехал бы в PR,
 * чтобы следующая же сессия назвала его `invalid`.
 */
export function updateBundle({
    lock,
    base,
    listPageFn,
    collectedAt,
    harnesses,
}: {
    lock: TCoreLock;
    base: TBaseView;
    listPageFn: TListPageFn;
    collectedAt: string;
    /** Переводы имён пакетов реестра (`harnessMcpNames`) — тот же набор, что перед сессией. */
    harnesses: readonly THarnessMcpNames[];
}): TBundleResult {
    const files = [lockBundleFile(lock)];
    const lines: string[] = [];
    const serversText = base.read(MCP_SERVERS_PATH);
    const dataText = base.read(CONTOUR_DATA_PATH);
    const before = parseData(dataText, 'базы');
    if (serversText === null && !hasMcpPolicy(before)) {
        lines.push(
            `ℹ MCP: в базе нет ни ${MCP_SERVERS_PATH}, ни MCP-политики в ${CONTOUR_DATA_PATH} — ` +
                'мигрировать нечего, комплект — только lock.',
        );
        return { files, lines };
    }
    const unavailable = (why: string) =>
        new Error(`инвентарь MCP недоступен — ${why}; без него миграция сняла бы чтения`);
    if (serversText === null) {
        throw unavailable(`${MCP_SERVERS_PATH} в базе нет, а данные контура держат MCP-политику`);
    }
    const servers = parseMcpServers(serversText);
    if (!servers.ok) throw unavailable(servers.problems.join('; '));
    const inventory = collectInventory(servers.value, listPageFn);
    if (!inventory.ok) throw unavailable(inventory.problems.join('; '));
    const snapshot = buildSnapshot(inventory.value, collectedAt);
    const names = inventoryNames(snapshot);
    if (names.length === 0) throw unavailable('серверы не назвали ни одного инструмента');
    const configured = Object.keys(servers.value);
    const checked = checkSnapshot(snapshot, { configured, harnesses });
    if (!checked.ok) {
        throw new Error(
            `свежий снимок инвентаря MCP не прошёл проверку — ${checked.problems.join('; ')}`,
        );
    }

    let migrated: ReturnType<typeof migrateMcpEffects>;
    try {
        migrated = migrateMcpEffects(dataText ?? '{}', names, CONTOUR_DATA_PATH);
    } catch (e) {
        throw new Error(`миграция данных контура отвергнута — ${(e as Error).message}`);
    }
    if (migrated.changed) {
        // Вторая сверка — launcher'а, до публикации: мигратор сверяет себя сам, но комплект
        // уходит человеку, и решение «эквивалентна» здесь принимается не на слово модуля.
        const after = parseData(migrated.text, 'после миграции');
        const problems = equivalenceProblems(before, after, [
            ...new Set([...names, ...before.writeAllowed]),
        ]);
        if (problems.length > 0) {
            throw new Error(`миграция данных контура меняет решения — ${problems.join('; ')}`);
        }
        files.push({ path: CONTOUR_DATA_PATH, text: migrated.text });
        lines.push(`🔁 ${CONTOUR_DATA_PATH}: эффекты MCP заявлены по инвентарю (${names.length}).`);
    } else {
        if (migrated.stale.length > 0) {
            throw new Error(
                `данные контура устарели против свежего инвентаря: ${migrated.stale.join(', ')} ` +
                    `у серверов больше нет — поправь mcp.tools в ${CONTOUR_DATA_PATH} отдельным PR`,
            );
        }
        for (const n of migrated.unlisted) {
            lines.push(
                `⚠ MCP ${n}: новый инструмент, в mcp.tools его нет — guard его блокирует; ` +
                    'разрешение — правкой данных контура в ревью.',
            );
        }
    }
    const current = verifiedSnapshot(base.read(MCP_INVENTORY_PATH), configured, harnesses);
    if (current?.hash !== snapshot.hash) {
        files.push({
            path: MCP_INVENTORY_PATH,
            text: serializeSnapshot(snapshot),
            // Повтор собрал бы снимок с новым временем: та же попытка — тот же хеш содержимого.
            samePrior: (prior) =>
                verifiedSnapshot(prior, configured, harnesses)?.hash === snapshot.hash,
        });
    }
    return { files, lines };
}

/**
 * Комплект rollback из базы: прежний lock и данные контура со снимком — такие, какими они были
 * до коммита, поставившего нынешний lock. Файл, который тот коммит не менял, не трогается;
 * правленый после него — отказ.
 */
export function rollbackBundle({
    lock,
    base,
}: {
    lock: TCoreLock;
    base: TBaseView;
}): TBundleResult {
    const files = [lockBundleFile(lock)];
    const lines: string[] = [];
    const change = base.lastChange(CORE_LOCK_PATH);
    if (change === null) {
        throw new Error(
            `в истории базы нет коммита с ${CORE_LOCK_PATH} — данные откатить не по чему`,
        );
    }
    const short = change.slice(0, 12);
    for (const path of [CONTOUR_DATA_PATH, MCP_INVENTORY_PATH]) {
        const atChange = base.read(path, change);
        const before = base.read(path, `${change}^`);
        if (atChange === before) continue;
        if (base.read(path) !== atChange) {
            throw new Error(
                `${path} правлен после смены ревизии в ${short} — откат вернул бы и эту правку; ` +
                    'верни данные отдельным PR',
            );
        }
        files.push({ path, text: before });
        lines.push(
            before === null
                ? `↩ ${path}: появился в ${short}, откат его убирает.`
                : `↩ ${path}: возвращается к состоянию до ${short}.`,
        );
    }
    return { files, lines };
}

/**
 * Третья сверка — гейт PR потребителя (`./ralph verify-mcp`): данные контура головы против базы
 * PR по снимку головы, только git, без сети.
 *
 * Обещание у неё разное по базе, и это сказано вслух. База прежней формы — PR миграции, и
 * пусто в `problems` значит «PR не меняет решений guard»: эквивалентность настоящим
 * `decideEvent`. База уже с эффектами — отказ только на чтении, которого нет в снимке; правка
 * `writeAllowed`, `neverExceptions`, эффекта или возврат к префиксу законны (их делает
 * политика и `rollbackBundle`) и красным гейт не делают: красный чек ship человека не снимает.
 * Такие изменения сверка называет строкой `⚠` с каждым разошедшимся решением — держит их
 * ship человека на данных контура, а не этот чек.
 */
export function verifyMcpMigration({
    read,
    base,
    head,
    harnesses,
}: {
    /** Текст файла в ревизии; нет файла — `null`. */
    read: (rev: string, path: string) => string | null;
    base: string;
    head: string;
    /** Переводы имён пакетов реестра (`harnessMcpNames`) — тот же набор, что перед сессией. */
    harnesses: readonly THarnessMcpNames[];
}): { problems: string[]; lines: string[] } {
    const afterText = read(head, CONTOUR_DATA_PATH);
    if (afterText === null) {
        return { problems: [], lines: [`ℹ ${CONTOUR_DATA_PATH} нет — сверять нечего.`] };
    }
    let after: TMcpData;
    let before: TMcpData;
    try {
        after = parseData(afterText, 'головы');
        before = parseData(read(base, CONTOUR_DATA_PATH), 'базы');
    } catch (e) {
        return { problems: [(e as Error).message], lines: [] };
    }
    if (!after.toolsDeclared) {
        return {
            problems: [],
            lines: [
                before.toolsDeclared
                    ? `⚠ ${CONTOUR_DATA_PATH}: PR возвращает эффекты MCP к префиксу — решения ` +
                      'guard меняются, держит их ship человека.'
                    : `ℹ ${CONTOUR_DATA_PATH} прежней формы — guard судит префиксом, сверять нечего.`,
            ],
        };
    }
    const serversText = read(head, MCP_SERVERS_PATH);
    if (serversText === null) {
        return { problems: [`эффекты MCP заявлены, а ${MCP_SERVERS_PATH} нет`], lines: [] };
    }
    const servers = parseMcpServers(serversText);
    if (!servers.ok) return { problems: servers.problems, lines: [] };
    const snapText = read(head, MCP_INVENTORY_PATH);
    if (snapText === null) {
        return {
            problems: [`эффекты MCP заявлены, а снимка ${MCP_INVENTORY_PATH} нет`],
            lines: [],
        };
    }
    const snap = parseSnapshot(snapText, { configured: Object.keys(servers.value), harnesses });
    if (!snap.ok) return { problems: snap.problems, lines: [] };
    const names = inventoryNames(snap.value);
    if (before.toolsDeclared) {
        const { stale } = toolsFreshness(after, names);
        const changed = equivalenceProblems(before, after, [
            ...new Set([...names, ...before.writeAllowed, ...after.writeAllowed]),
        ]);
        return {
            problems: stale.map((n) => `чтение ${n} в mcp.tools, а в снимке инвентаря его нет`),
            lines: [
                `✅ ${CONTOUR_DATA_PATH}: чтения сверены со снимком (${names.length}).`,
                ...(changed.length > 0
                    ? [
                          `⚠ PR меняет решения guard по MCP — держит их ship человека: ${changed.join('; ')}`,
                      ]
                    : []),
            ],
        };
    }
    const problems = equivalenceProblems(before, after, [
        ...new Set([...names, ...before.writeAllowed]),
    ]);
    return {
        problems,
        lines:
            problems.length === 0
                ? [
                      `✅ миграция ${CONTOUR_DATA_PATH} эквивалентна на ${names.length} именах снимка.`,
                  ]
                : [],
    };
}

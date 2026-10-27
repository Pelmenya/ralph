/**
 * Реестр потребителей каталога установок и план чистки: `./ralph prune` (Ф15, #138).
 *
 * Каталог установок (`<dataDir>/<sha>/`) общий на всех потребителей пользователя, а lock и
 * журнал активации — у каждого свои. Набор «не трогать» одного потребителя
 * (`retainedRevisions`) ничего не знает о соседе, и чистка от одного удалила бы исполняемую
 * ревизию или цель отката другого — ровно тогда, когда тот за ней придёт. Поэтому чистка
 * собирает наборы ВСЕХ потребителей из реестра, и у модуля три обязательства:
 *
 *   1. **Реестр лежит в самом каталоге установок** (`<dataDir>/.consumers/`), а не в
 *      `/tmp`, как запись владения (`repo-owner.ts`), с которой взят образец «файл на ключ».
 *      Владение умирает с процессом, и потерять его на перезагрузке безопасно; потерянная
 *      запись реестра — это ревизия соседа в списке на удаление. Область та же, что у
 *      чистки: потребители ЭТОГО каталога, другой `RALPH_DATA_DIR` — другой реестр. Имя с
 *      точкой не ревизия (`pruneCandidates` берёт только полный SHA), и чистка его не тронет.
 *   2. **Запись — пара «дерево потребителя, каталог состояния»**: lock живёт в дереве, журнал
 *      активации — в `runtimeDir` профиля, и у одного дерева профилей бывает несколько.
 *      `install` пишет запись без каталога состояния (профиль ему неизвестен, а lock уже
 *      есть), `start` — с ним. Ключ — хэш пары, запись идемпотентна: повтор ничего не пишет.
 *   3. **Нечитаемое — отказ чистки целиком, а не пропуск** (`collectRetained`). Битая
 *      запись, lock или журнал любого потребителя значат «его набор неизвестен», а
 *      неизвестный набор нельзя вычесть. Отказ называет КАЖДУЮ причину, а не первую.
 *      Потребитель, которого больше нет (дерево удалено), — тоже отказ с путём записи:
 *      реестр сам не забывает, иначе «lock пропал на минуту посреди `git checkout`» стоило
 *      бы соседу ревизии. Запись убирает человек.
 *
 * Чего модуль НЕ обещает, сказано вслух. Потребитель, ни разу не прошедший `install` или
 * `start` ревизией с реестром, в нём не значится; его живую петлю держит отдельная сверка —
 * ревизии, исполняющие `ralph.js` или `launcher.mts` (`runningRevisionsFn` в launcher:
 * `update`/`rollback` посреди работы, цикл `./ralph start` в окне рестарта), чистка не
 * трогает, — но lock такого соседа без живой петли не виден. Сверка `/proc` узнаёт процесс
 * только по пути entry `<dataDir>/<sha>/…` дословно: запущенный иным путём (симлинк,
 * относительный путь) ею не виден, и его ревизию держит лишь lock или журнал. Ревизия, поставленная `update` и ждущая мерджа
 * PR, ни в одном lock ещё не названа: удалённую, её вернёт `./ralph install` из источника.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readCoreLock } from './core-install.ts';
import { parseActivationJournal } from './core-activation.ts';
import { pruneCandidates, retainedRevisions } from './core-rollback.ts';
import { runtimePathsIn } from './runtime-paths.ts';

export type TConsumerRecord = {
    consumerRoot: string;
    /** Каталог состояния профиля; `null` — запись install, профиль ещё неизвестен. */
    runtimeDir: string | null;
};

export const CONSUMERS_DIR = '.consumers';

export function consumersDir(dataDir: string): string {
    return join(dataDir, CONSUMERS_DIR);
}

export function consumerRecordPath(dataDir: string, rec: TConsumerRecord): string {
    const key = createHash('sha256')
        .update(`${rec.consumerRoot}\0${rec.runtimeDir ?? ''}`)
        .digest('hex')
        .slice(0, 16);
    return join(consumersDir(dataDir), `${key}.json`);
}

export function formatConsumerRecord(rec: TConsumerRecord): string {
    return `${JSON.stringify({ consumerRoot: rec.consumerRoot, runtimeDir: rec.runtimeDir })}\n`;
}

const abs = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/');

/** Разбор записи; не по форме — бросок: неизвестный потребитель хуже отказа чистки. */
export function parseConsumerRecord(raw: string): TConsumerRecord {
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        throw new Error('не JSON');
    }
    const r = (v ?? {}) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null || Array.isArray(v) || !abs(r.consumerRoot)) {
        throw new Error('нет абсолютного consumerRoot');
    }
    if (r.runtimeDir !== null && !abs(r.runtimeDir)) {
        throw new Error('runtimeDir не абсолютный путь и не null');
    }
    return { consumerRoot: r.consumerRoot, runtimeDir: r.runtimeDir };
}

export type TRegistryFs = {
    readFile: (p: string) => string;
    readdir: (dir: string) => string[];
    mkdir: (dir: string) => void;
    /** Запись целиком: временный файл рядом и `rename` — оборванная не оставит половины. */
    writeAtomic: (p: string, text: string) => void;
};

const enoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Запись потребителя в реестр. Та же запись уже лежит — ничего не пишется: старт идёт на
 * каждом рестарте, и запись на каждом была бы лишним эффектом. Путь записи — в ответе.
 */
export function registerConsumer(
    dataDir: string,
    rec: TConsumerRecord,
    fsr: TRegistryFs,
): { path: string; written: boolean } {
    const p = consumerRecordPath(dataDir, rec);
    const text = formatConsumerRecord(rec);
    try {
        if (fsr.readFile(p) === text) return { path: p, written: false };
    } catch (e) {
        if (!enoent(e)) throw e;
    }
    fsr.mkdir(consumersDir(dataDir));
    fsr.writeAtomic(p, text);
    return { path: p, written: true };
}

export type TRegistryEntry =
    | { ok: true; path: string; record: TConsumerRecord }
    | { ok: false; path: string; reason: string };

/** Все записи реестра; каталога нет — реестр пуст. Временные файлы записи — не записи. */
export function readConsumerRegistry(dataDir: string, fsr: TRegistryFs): TRegistryEntry[] {
    const dir = consumersDir(dataDir);
    let names: string[];
    try {
        names = fsr.readdir(dir);
    } catch (e) {
        if (enoent(e)) return [];
        throw e;
    }
    return names
        .filter((n) => n.endsWith('.json'))
        .sort()
        .map((n): TRegistryEntry => {
            const p = join(dir, n);
            try {
                return { ok: true, path: p, record: parseConsumerRecord(fsr.readFile(p)) };
            } catch (e) {
                return { ok: false, path: p, reason: (e as Error).message };
            }
        });
}

export type TRetainedSet = { who: string; keep: ReadonlySet<string> };
export type TCollected = { ok: true; sets: TRetainedSet[] } | { ok: false; problems: string[] };

/**
 * Наборы «оставить» всех потребителей реестра: lock дерева, исполняемая ревизия и цель отката
 * по журналу профиля. Журнала нет — профиль ещё не стартовал, набор из одного lock. Любая
 * другая неудача — в `problems`, и чистки нет вовсе.
 */
export function collectRetained(
    entries: readonly TRegistryEntry[],
    readFn: (p: string) => string,
): TCollected {
    const problems: string[] = [];
    const sets: TRetainedSet[] = [];
    for (const e of entries) {
        if (!e.ok) {
            problems.push(`запись реестра ${e.path} битая (${e.reason})`);
            continue;
        }
        const { consumerRoot, runtimeDir } = e.record;
        const who = runtimeDir === null ? consumerRoot : `${consumerRoot} (${runtimeDir})`;
        const lock = readCoreLock(consumerRoot, readFn);
        if (!lock.ok) {
            problems.push(
                `${who}: ${lock.reason} — набор потребителя неизвестен; если дерева больше нет — убери запись ${e.path}`,
            );
            continue;
        }
        let journal: ReturnType<typeof parseActivationJournal> = [];
        if (runtimeDir !== null) {
            const p = runtimePathsIn(runtimeDir).activations;
            try {
                journal = parseActivationJournal(readFn(p));
            } catch (err) {
                if (!enoent(err)) {
                    problems.push(
                        `${who}: журнал активации ${p} не читается (${(err as Error).message}) — цель отката неизвестна`,
                    );
                    continue;
                }
            }
        }
        sets.push({ who, keep: retainedRevisions(journal, lock.lock.sha) });
    }
    return problems.length > 0 ? { ok: false, problems } : { ok: true, sets };
}

/** Остаток удаления, прерванного посреди `rm`: имя уже не ревизия, дерево неполное. */
export const PRUNING_RE = /^\.[0-9a-f]{40}\.pruning-\d+$/;

/** Что удалить: ревизии вне всех наборов и вне живых раннеров, плюс остатки прошлой чистки. */
export function prunePlan(
    installed: readonly string[],
    sets: readonly TRetainedSet[],
    running: ReadonlySet<string>,
): { revisions: string[]; leftovers: string[] } {
    return {
        revisions: pruneCandidates(installed, [...sets.map((s) => s.keep), running]),
        leftovers: installed.filter((n) => PRUNING_RE.test(n)).sort(),
    };
}

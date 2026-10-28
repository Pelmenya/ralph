/**
 * Контракт запуска петли: сессия петли — та, которой раннер передал `RALPH_CORE_SHA`,
 * ожидаемую ревизию ядра. Хук по этому контракту делает две вещи (#99, Фаза 11):
 *
 * 1. **Узнаёт петлю.** Раньше барьер скиллов узнавал её по строке `ralph.md` в первом
 *    сообщении транскрипта. При внешней установке путь контракта другой, и признак
 *    ломался бы молча: неопознанная сессия пропускается, а не блокируется (находка
 *    ревью Codex). Переменная окружения — явное заявление раннера, а не догадка по тексту.
 * 2. **Сверяет свою ревизию с ожидаемой.** Хук, взятый из дерева, которое правит PR, — не
 *    тот хук, который ревьюили: сессия, поправившая guard, со следующего вызова работала
 *    бы под своим барьером. Поэтому каждый исполняемый файл каталога хуков (`*.cjs`)
 *    сверяется по содержимому с тем же путём в ревизии `RALPH_CORE_SHA`. Совпадение
 *    содержимого, а не HEAD каталога: хук из рабочего дерева совпадает ровно до тех пор,
 *    пока его не тронули.
 *
 * Fail-closed без исключений: значение не похоже на SHA, ревизии нет в репозитории хука,
 * git недоступен, файл разошёлся, появился или пропал — блок. Переменной нет вовсе — это
 * не ошибка, а сессия человека: ей сверять нечего.
 *
 * **Порядок — половина сверки.** Хук зовёт её ДО того, как загрузит хоть один соседний
 * модуль: `require` исполняет код, и правленый `guard-rules.cjs`, загруженный первым,
 * подменял экспорт `checkCoreRevision` у закэшированного модуля — сверка отвечала «совпало»
 * на разошедшемся файле (находка ревью Фазы 11, проверено на настоящем git). Поэтому этот
 * модуль не зависит ни от одного соседа и грузится первым.
 *
 * **Чего сверка НЕ держит, сказано вслух.** Сверщик лежит в том же каталоге, что и
 * сверяемое, и исполняется раньше своей проверки. Правка самого `core-revision.cjs` или
 * входного файла хука (`guard.cjs`, `skill-barrier.cjs`) снимает сверку в этом хуке:
 * самосверка ловит правку СОСЕДЕЙ (правила, разбор данных), а не намеренный обход. Два
 * хука сверяют каталог независимо, поэтому правленый вход одного ловит другой — на тех
 * инструментах, которые накрывают оба. Барьер, которого не снять правкой дерева, —
 * регистрация хуков из установки ядра, а не из рабочего дерева (Фаза 12).
 *
 * **Установка ядра обязана быть git-репозиторием, где есть объект `RALPH_CORE_SHA`**
 * (клон, worktree или установка launcher'а — она кладёт ревизию чекаутом в свой
 * репозиторий). Ожидаемые хеши берутся из `git ls-tree`, и каталог без git — например,
 * распакованный `git archive` — под контрактом блокирует каждый вызов: сверить не с чем.
 * Манифест хешей рядом с хуками решил бы это без git, но манифест в том же каталоге
 * правится той же правкой, что и хук; его место — у установщика Фазы 12.
 *
 * **Петлю без контракта этот модуль больше не узнаёт** (#184). Переходный признак — строка
 * `ralph.md` в первом сообщении транскрипта — жил здесь ради guard'а дерева сессии, которому
 * раннер контракта не даёт. Теперь раннер кладёт такому хуку доверенный контекст сессии в
 * окружение (`session-context.cjs`), а догадка по тексту снята: сессия человека с похожим
 * промптом считалась петлёй, а у харнессов без транскрипта Claude признака не было вовсе.
 *
 * CommonJS без зависимостей, как все хуки: запускается до `npm ci`.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Имя переменной контракта запуска. Задаёт раннер, читают хуки. */
const CORE_SHA_ENV = 'RALPH_CORE_SHA';

// Полный SHA, а не сокращение и не имя ветки: имя двигается, сокращение неоднозначно,
// а значение уходит аргументом в git — флаг на его месте исключён тем же регэкспом.
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Ожидаемая ревизия из окружения; пустая строка — переменной нет. */
function expectedSha(env = process.env) {
    const value = env[CORE_SHA_ENV];
    return typeof value === 'string' ? value.trim() : '';
}

/** Хеш блоба так, как его считает git: sha1 у SHA-1-репозитория, sha256 — у SHA-256. */
function blobHash(content, sha) {
    const algo = sha.length === 64 ? 'sha256' : 'sha1';
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return crypto.createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * `git ls-tree -z <sha> -- .` в каталоге хука → имя файла → хеш блоба. `-z`, а не строки:
 * при `core.quotePath` имя с не-ASCII символом или кавычкой пришло бы в кавычках, не
 * совпало бы с `readdir` и дало бы ложный блок «нет в ревизии».
 */
function lsTree(dir, sha) {
    const out = execFileSync('git', ['-C', dir, 'ls-tree', '-z', sha, '--', '.'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
    });
    return parseLsTree(out);
}

/** Разбор вывода `ls-tree -z`: записи через `\0`, в записи имя — после табуляции. */
function parseLsTree(out) {
    const blobs = new Map();
    for (const entry of out.split('\0')) {
        const m = /^\d+ blob ([0-9a-f]+)\t([^]+)$/.exec(entry);
        if (m) blobs.set(m[2], m[1]);
    }
    return blobs;
}

/**
 * Описание ошибки, которое само не бросает: у брошенного объекта без прототипа нет ни
 * `message`, ни `toString`, и `String(error)` падал бы в обработчике кодом 1, а он у
 * PreToolUse не блокирует. Живёт здесь, потому что этот модуль хуки грузят первым и без
 * соседей — описать отказ нужно и тогда, когда не загрузилось остальное.
 */
function describeError(error) {
    try {
        if (error && typeof error.message === 'string') return error.message;
        return String(error);
    } catch {
        return 'ошибка без описания';
    }
}

/**
 * Вердикт контракта: `{ loop, error }`. `loop` — сессия заявлена раннером; `error` —
 * причина блока (ревизия не сверилась). Коллабораторы подменяются параметром.
 */
function checkCoreRevision({
    env = process.env,
    hooksDir = __dirname,
    lsTreeFn = lsTree,
    readFileFn = fs.readFileSync,
    readdirFn = fs.readdirSync,
    realpathFn = fs.realpathSync,
} = {}) {
    const sha = expectedSha(env);
    if (sha === '') return { loop: false, error: null };
    if (!SHA_RE.test(sha)) {
        return {
            loop: true,
            error: `${CORE_SHA_ENV}=${JSON.stringify(sha)} — не полный SHA ревизии ядра.`,
        };
    }
    let dir;
    let actual;
    let expected;
    try {
        // Канонический путь: симлинк на каталог хуков сверяется по тому, куда он ведёт.
        dir = realpathFn(hooksDir);
        expected = new Map([...lsTreeFn(dir, sha)].filter(([name]) => name.endsWith('.cjs')));
        actual = readdirFn(dir).filter((name) => name.endsWith('.cjs'));
    } catch (error) {
        return {
            loop: true,
            error:
                `ревизия ${sha} не читается из каталога хуков (${describeError(error).trim()}); ` +
                'установка ядра обязана быть git-репозиторием с этой ревизией.',
        };
    }
    if (expected.size === 0) {
        return { loop: true, error: `в ревизии ${sha} нет исполняемых файлов хуков в ${dir}.` };
    }
    const diverged = [];
    for (const name of new Set([...expected.keys(), ...actual])) {
        if (!expected.has(name)) {
            diverged.push(`${name} (нет в ревизии)`);
            continue;
        }
        if (!actual.includes(name)) {
            diverged.push(`${name} (нет на диске)`);
            continue;
        }
        if (blobHash(readFileFn(path.join(dir, name)), sha) !== expected.get(name)) {
            diverged.push(name);
        }
    }
    if (diverged.length > 0) {
        return {
            loop: true,
            error: `хуки в ${dir} — не ревизия ядра ${sha}: разошлись ${diverged.join(', ')}.`,
        };
    }
    return { loop: true, error: null };
}

module.exports = {
    CORE_SHA_ENV,
    SHA_RE,
    expectedSha,
    blobHash,
    lsTree,
    parseLsTree,
    describeError,
    checkCoreRevision,
};

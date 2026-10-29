// Протокол миграции runtime-состояния (канон, задача 25).
//
// Переезд состояния из старой раскладки («всё в каталоге ядра») в `runtimeDir` контракта
// корней (задача 22) приходится делать на ЖИВОЙ петле, у которой есть незаконченная фаза.
// Самый дорогой исход — два экземпляра на разных раскладках, каждый со «своим»
// единственным состоянием: расходятся они молча, а обнаруживается это по двум PR на одну
// фазу. Поэтому переезд — не `mv`, а протокол с четырьмя свойствами:
//
//   1. **журнал пишется первым.** Обрыв питания посреди переезда обязан быть виден
//      следующему запуску, а не выглядеть как «странное состояние»;
//   2. **схема проверяется на КОПИИ**, до пометки старой раскладки: «переехали» должно
//      означать «на той стороне раннер стартует», а не «байты скопированы»;
//   3. **старое не удаляется, а переименовывается** (`*.migrated`) — откат обязан быть
//      возможен, а старт по прежней раскладке невозможен: иначе второй экземпляр поедет
//      на старом состоянии, ради чего протокол и написан. Откат тоже ничего не удаляет без
//      копии: он возвращает ТЕКУЩИЕ файлы новой раскладки, а снимок на момент переезда
//      откладывает под `*.pre-rollback` (#152);
//   4. **всё через инъекцию fs.** Модуль не знает про диск: он знает про порядок шагов,
//      а тесты проверяют именно порядок и поведение при обрыве.
//
// Каталоги модуль не создаёт: `runtimeDir` создаёт `main()` до лока (единственная запись,
// разрешённая до него), а переезд идёт уже внутрь готового каталога.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { runtimePathsIn } from './runtime-paths.ts';

/** Имя журнала переезда в НОВОЙ раскладке: он про её появление, там ему и место. */
export const MIGRATION_JOURNAL = '.migration.json';
/** Маркер в СТАРОЙ раскладке: «состояние уехало туда-то». Читается человеком и стартом. */
export const MIGRATED_MARKER = 'MIGRATED-TO';
/** Суффикс переименованного оригинала — он же материал отката. */
export const MIGRATED_SUFFIX = '.migrated';
/** Файлы, растущие неограниченно: сверяются по размеру, а не по содержимому (см. ниже).
 *  Журнал событий растёт вместе со своим логом (строка на строку), поэтому он здесь же. */
const LOGS: ReadonlySet<string> = new Set([
    'ralph.log',
    'ralph.dry.log',
    'monitor.out',
    'ralph.events.jsonl',
    'ralph.dry.events.jsonl',
]);

export type TMigrationFile = { name: string; from: string; to: string };
export type TMigrationPlan = {
    from: string;
    to: string;
    files: TMigrationFile[];
    /** Имя → каталог старой раскладки, если файл лежал НЕ в `from` (#146). */
    origins?: Record<string, string>;
};
export type TMigrationStatus = 'in-progress' | 'done' | 'rolled-back';
export type TMigrationJournal = {
    status: TMigrationStatus;
    from: string;
    to: string;
    files: string[];
    /** Файлы, лежавшие не в `from`, — с каталогом, куда их вернёт откат (#146). Поле
     *  необязательно: журнал прежних версий его не знает, и тогда всё лежало в `from`. */
    origins?: Record<string, string>;
    startedAt: string;
    finishedAt?: string;
    /** Что откат вернул (#152): файлы, изменившиеся после переезда, куда отложен снимок на
     *  момент переезда и фаза, которая едет назад. Пишется только откатом. */
    rollback?: TRollbackReport;
};

export type TRollbackReport = {
    changed: string[];
    snapshots: Record<string, string>;
    state?: { milestone: string | null; count: number };
};

/** Суффикс снимка на момент переезда, отложенного откатом вместо воскрешения (#152). */
export const PRE_ROLLBACK_SUFFIX = '.pre-rollback';

export type TMigrationDeps = {
    existsFn: (p: string) => boolean;
    readFn: (p: string) => string;
    writeFn: (p: string, data: string) => void;
    renameFn: (from: string, to: string) => void;
    removeFn: (p: string) => void;
    // Размер файла — отдельным примитивом: сверять растущие логи по СОДЕРЖИМОМУ значило бы
    // держать в памяти две их полные копии (ревью Codex, !23), а лог не ротируется.
    sizeFn: (p: string) => number;
    // Отпечаток хвоста — sha256 последних `LOG_TAIL_BYTES` байт. Один размер не отличает
    // два РАЗНЫХ лога одной длины, а откат по «не изменился» удаляет текущий без копии;
    // хвост ловит запись после переезда, не читая лог целиком.
    tailFn: (p: string) => string;
    // Время — параметром, а не `Date.now()` в коде: иначе журнал недетерминирован, а тест
    // на него — мигающий. Тот же приём, что у остального ядра.
    now: () => string;
};

/** Сколько байт хвоста лога сверяется вместе с размером (`tailFn`). */
export const LOG_TAIL_BYTES = 64 * 1024;

/** Боевой `tailFn`: sha256 последних `LOG_TAIL_BYTES` байт файла без чтения его целиком. */
export function fileTailHash(p: string): string {
    const fd = fs.openSync(p, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const n = Math.min(size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n);
        return createHash('sha256').update(buf).digest('hex');
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Совпадение двух экземпляров одного файла описи. Логи — по размеру И хвосту: размер ловит
 * усечение, хвост — другой лог той же длины (дописанный после переезда и усечённый, чужой
 * файл на месте копии). Совпасть оба могут только у логов, разошедшихся раньше последних
 * 64 КиБ при равной длине, — у файла, который только дописывается, такого не бывает.
 * Остальные файлы малы по устройству и сверяются побайтно.
 */
function sameFile(name: string, a: string, b: string, deps: TMigrationDeps): boolean {
    return LOGS.has(name)
        ? deps.sizeFn(a) === deps.sizeFn(b) && deps.tailFn(a) === deps.tailFn(b)
        : deps.readFn(a) === deps.readFn(b);
}

/** Путь в каталоге — своей склейкой, а не `path.join`: модуль оперирует уже готовыми
 *  адресами из описи, и единственное, что ему нужно, — приписать имя к каталогу. */
function at(dir: string, name: string): string {
    return `${dir}/${name}`;
}

/**
 * Состав переезда — по ОПИСИ путей состояния (`runtimePathsIn`), а не по перечислению
 * здесь. Перечисление разъехалось бы с описью на первом же новом файле состояния: его
 * добавили бы в опись и забыли тут, а он молча остался бы в старой раскладке.
 *
 * Старая раскладка бывает в ДВУХ местах (#146, репетиция отката): при встроенном ядре и
 * отдельном дереве раннера лок, лог и события до `chdir` ложатся в `from` (место запуска),
 * а state пишется уже после `chdir` — в `.claude/ralph` дерева раннера (`runnerDir`). Опись
 * по одному месту отчиталась «переехало», а state с незаконченной фазой остался на месте.
 * Поэтому опись берёт оба места; одно имя в обоих — стоп: выбрать молча значит выбрать
 * наугад, какая фаза продолжится. И файлы без state при живом дереве раннера — тоже стоп:
 * state в такой раскладке обычно есть, где-то, где опись его не видит. Исключение — петля,
 * state не писавшая никогда (только `--dry-run`, падение до первой записи): стоп тот же, но
 * для одних логов он называет и эту развилку с выходом из неё.
 */
export function planRuntimeMigration(
    from: string,
    to: string,
    existsFn: (p: string) => boolean,
    opts: { runnerDir?: string | null } = {},
): TMigrationPlan {
    // Из описи исключены шесть ключей, и все — осознанно (первые два — ревью Codex, !23):
    //   • `sessions` — АРХИВ логов прошлых сессий, а не состояние, от которого зависит
    //     продолжение фазы. Старые логи остаются на месте, новые пишутся в `runtimeDir`;
    //   • `lock` — файл ЖИВОГО процесса. Переезд идёт под локом, взятым уже в новой
    //     раскладке, и копирование старого лока поверх него затёрло бы собственный лок
    //     мигрирующего процесса, а откат — удалил бы его. Осиротевший legacy-лок снимает
    //     обычный механизм (он и так умеет отличать сироту от живого раннера);
    //   • `kimiNative` (#120) — КАТАЛОГ, который раннер собирает заново перед каждой сессией
    //     `kimi-native`: в нём ссылки на вход человека и промпт прошлой сессии, а не
    //     состояние. Переезд копирует файлы, и каталог со ссылками на ключи ему не по форме;
    //   • `opencodeSession` (#121) — тоже каталог, пересобираемый перед каждой сессией
    //     (плагин барьера и настройки сессии): состояния в нём нет.
    //   • `codexSession` (#195) — дом CLI Codex со ссылкой на вход человека, пересобирается
    //     перед каждой сессией, как `kimiNative`;
    //   • `claudeSession` (#194) — MCP-конфиг и плагин скиллов сессии Claude Code, тоже
    //     собираются заново перед каждой сессией.
    // Здесь — КЛЮЧИ описи, а не имена рантаймов: ключ, совпавший с именем рантайма, сменил бы
    // смысл вместе с ним, и переезд начал бы копировать каталог сессии молча.
    const SKIP: ReadonlySet<string> = new Set([
        'sessions',
        'lock',
        'kimiNative',
        'opencodeSession',
        'codexSession',
        'claudeSession',
    ]);
    const names = Object.entries(runtimePathsIn(''))
        .filter(([key]) => !SKIP.has(key))
        .map(([, p]) => p.replace(/^\/+/, ''));
    const runnerDir = opts.runnerDir && opts.runnerDir !== from ? opts.runnerDir : null;
    const files: TMigrationFile[] = [];
    const origins: Record<string, string> = {};
    for (const name of names) {
        const here = existsFn(at(from, name));
        const there = runnerDir !== null && existsFn(at(runnerDir, name));
        if (here && there) {
            throw new Error(
                `Файл состояния ${name} лежит в двух местах старой раскладки: ${at(from, name)} ` +
                    `и ${at(runnerDir as string, name)}. Какой из них настоящий, переезд не ` +
                    `выбирает — разбери руками и оставь один.`,
            );
        }
        if (here) files.push({ name, from: at(from, name), to: at(to, name) });
        if (there) {
            files.push({ name, from: at(runnerDir as string, name), to: at(to, name) });
            origins[name] = runnerDir as string;
        }
    }
    // Припаркованный state тоже считается найденным: это возобновление после обрыва, и
    // состав переезда тогда берётся из журнала, а не из этой описи.
    const stateName = names.find(isStateName) ?? 'ralph.state.json';
    const stateSeen = [from, runnerDir].some(
        (dir) =>
            dir !== null &&
            (existsFn(at(dir, stateName)) || existsFn(at(dir, `${stateName}${MIGRATED_SUFFIX}`))),
    );
    if (runnerDir !== null && files.length > 0 && !stateSeen) {
        // Развилка «state не было никогда» законна: петлю гоняли только `--dry-run` или она
        // упала на сверках старта после первой строки лога, но до первой записи state. Тогда
        // лежат одни логи, и совет «найди state» отказывал бы навсегда — state нет нигде.
        // Стоп остаётся (по описи не отличить от state, лежащего вне её поля зрения), но
        // называет обе развилки, а для одних логов — что с ними делать.
        const p = runtimePathsIn('');
        const logNames = new Set(
            [p.log, p.dryLog, p.monitorOut, p.events, p.heartbeat, p.dryEvents, p.dryHeartbeat].map(
                (n) => n.replace(/^\/+/, ''),
            ),
        );
        const onlyLogs = files.every((f) => logNames.has(f.name));
        throw new Error(
            `В старой раскладке нашлись файлы (${files.map((f) => f.from).join(', ')}), но ` +
                `ralph.state.json нет ни в ${from}, ни в ${runnerDir}. «Переехало» без state — ` +
                `ложный зелёный: следующий старт начал бы фазу с нуля. ` +
                (onlyLogs
                    ? `Файлы — только логи. Если петля state не писала никогда (гонялась только ` +
                      `--dry-run или упала на старте до первой записи state), переезжать нечему: ` +
                      `убери или переименуй эти файлы и повтори. Иначе найди, где state, и разбери руками.`
                    : `Разбери руками, где state.`),
        );
    }
    return Object.keys(origins).length > 0 ? { from, to, files, origins } : { from, to, files };
}

/**
 * Каталог старой раскладки в дереве раннера (#146) — или null, если дерева нет либо оно и
 * есть место запуска (тогда второе место совпало бы с первым, и опись удвоилась бы).
 * `legacyAbs` — тот же каталог места запуска абсолютным путём: сравниваются адреса, а не
 * строки, иначе относительный `.claude/ralph` никогда не совпал бы с абсолютным.
 */
export function runnerLegacyDir(
    runnerTree: string,
    legacyRel: string,
    legacyAbs: string,
    existsFn: (p: string) => boolean,
): string | null {
    if (!existsFn(runnerTree)) return null;
    const dir = at(runnerTree, legacyRel);
    return dir === legacyAbs ? null : dir;
}

function isStateName(name: string): boolean {
    return name.endsWith('ralph.state.json');
}

/** Каталог старой раскладки, где файл лежал до переезда (#146). */
function originOf(journal: TMigrationJournal, name: string): string {
    return journal.origins?.[name] ?? journal.from;
}

/** Все каталоги старой раскладки этого переезда: маркер ставится и снимается в каждом. */
function legacyDirsOf(journal: TMigrationJournal): string[] {
    return [...new Set([journal.from, ...Object.values(journal.origins ?? {})])];
}

function writeJournal(to: string, journal: TMigrationJournal, deps: TMigrationDeps): void {
    deps.writeFn(at(to, MIGRATION_JOURNAL), JSON.stringify(journal, null, 2));
}

export function readMigrationJournal(to: string, deps: TMigrationDeps): TMigrationJournal | null {
    const path = at(to, MIGRATION_JOURNAL);
    if (!deps.existsFn(path)) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(deps.readFn(path));
    } catch {
        throw new Error(
            `Журнал миграции ${path} не разбирается как JSON. «Не разобрал» — не «всё в ` +
                `порядке»: разбери руками, состояние могло остаться на полпути.`,
        );
    }
    const j = raw as Partial<TMigrationJournal>;
    if (!j || typeof j !== 'object' || typeof j.status !== 'string') {
        throw new Error(`Журнал миграции ${path} без поля status — разбери руками.`);
    }
    return j as TMigrationJournal;
}

/**
 * Барьер старта: незавершённый переезд не пускает петлю дальше. Состояние в этот момент
 * лежит в двух местах, и «продолжить как ни в чём не бывало» означало бы выбрать одно из
 * них молча — ровно тот исход, против которого протокол.
 */
export function assertMigrationSettled(to: string, deps: TMigrationDeps): void {
    const journal = readMigrationJournal(to, deps);
    if (!journal) return;
    if (journal.status === 'in-progress') {
        throw new Error(
            `Миграция состояния ${journal.from} → ${journal.to} не завершена (журнал ` +
                `${at(to, MIGRATION_JOURNAL)}). Состояние сейчас в двух местах: доведи переезд ` +
                `повторным --migrate-runtime (он возобновляемый) либо откати (--migrate-rollback).`,
        );
    }
    if (journal.status === 'rolled-back') {
        // Откат вернул состояние в старую раскладку, а конфиг по-прежнему указывает сюда —
        // значит следующий обычный запуск начал бы НОВУЮ фазу в пустом runtimeDir, пока
        // прежняя лежит в legacy (ревью Codex, !23). Разъезд конфига и диска — стоп.
        throw new Error(
            `Состояние откачено в ${journal.from} (журнал ${at(to, MIGRATION_JOURNAL)}), но ` +
                `конфиг всё ещё задаёт runtimeDir ${journal.to}. Убери секцию roots из конфига ` +
                `(вернёшься к прежней раскладке) либо запусти --migrate-runtime заново.`,
        );
    }
}

/** Цела ли копия состояния — тот же критерий, что у `assertStateSchema`, но ответом, а не
 *  броском: возобновление спрашивает «годится ли то, что уже лежит», и на этот вопрос
 *  исключение отвечать не должно. */
function isValidState(text: string): boolean {
    try {
        assertStateSchema('(копия)', text);
        return true;
    } catch {
        return false;
    }
}

/** Схема состояния — минимальная и по существу: раннер читает `count`/`milestone`, и
 *  переехавший файл, который он не разберёт, означает петлю, вставшую на той стороне. */
function assertStateSchema(path: string, text: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Переехавшее состояние ${path} не проходит проверку схемы: не JSON.`);
    }
    const s = parsed as Record<string, unknown>;
    const okCount = typeof s.count === 'number';
    const okMilestone = typeof s.milestone === 'string' || s.milestone === null;
    if (!okCount || !okMilestone) {
        throw new Error(
            `Переехавшее состояние ${path} не проходит проверку схемы: ожидались числовой ` +
                `count и строковый milestone (или null).`,
        );
    }
}

/**
 * Переезд. Зовётся ПОД ЛОКОМ — модуль этого не проверяет и проверить не может: лок берёт
 * тот, кто владеет обеими раскладками (`main()`), и он же отвечает за то, что старый
 * экземпляр остановлен. Здесь — порядок шагов и их обратимость.
 */
export function migrateRuntime(plan: TMigrationPlan, deps: TMigrationDeps): TMigrationJournal {
    // ВОЗОБНОВЛЕНИЕ, а не новый переезд (ревью Codex, !23): после обрыва часть файлов уже
    // переименована, и построенный заново план их не увидит — он собирается по тому, что
    // ЛЕЖИТ в старой раскладке. Тогда повтор перевёз бы остаток, переписал журнал, и откат
    // вернул бы только остаток: половина состояния осталась бы в новой раскладке навсегда.
    // Поэтому список файлов берётся из журнала, если тот не закрыт.
    const previous = readMigrationJournal(plan.to, deps);
    const resuming = previous?.status === 'in-progress';
    const journal: TMigrationJournal = resuming
        ? previous
        : {
              status: 'in-progress',
              from: plan.from,
              to: plan.to,
              files: plan.files.map((f) => f.name),
              ...(plan.origins ? { origins: plan.origins } : {}),
              startedAt: deps.now(),
          };
    // Журнал — первым, ДО единственного байта копирования: обрыв на любом следующем шаге
    // виден следующему запуску как незавершённый переезд, а не как странное состояние.
    if (!resuming) writeJournal(plan.to, journal, deps);

    // Каждый шаг идемпотентен и смотрит на диск, а не на позицию в списке: возобновление
    // обязано доводить переезд с ЛЮБОГО места обрыва, включая «все переименованы, маркер не
    // записан» — иначе журнал остался бы in-progress навсегда, а петля не стартовала бы.
    for (const name of journal.files) {
        const from = at(originOf(journal, name), name);
        const to = at(journal.to, name);
        const parked = `${from}${MIGRATED_SUFFIX}`;
        const isState = isStateName(name);
        // Годность копии решает СВЕРКА С ПАРКОВКОЙ, а не валидность формата (ревью Codex,
        // !23). Формат знает только `ralph.state.json`; у лога и `ralph.requests.jsonl`
        // «правильного вида» нет вовсе, и усечённый хвост JSONL выглядел бы целым файлом.
        //
        // Но сверяются они по-разному, и разница вынужденная: логи растут неограниченно
        // (`ralph.log` не ротируется), и сравнение по содержимому держало бы в памяти две
        // их полные копии — на большом логе это отказ по памяти, из которого повтор не
        // выводит. Для них сверяются РАЗМЕР и хеш хвоста (`sameFile`): размер ловит усечение,
        // хвост — другой файл той же длины. Остальные файлы малы по устройству — состояние,
        // маркер зависимостей, очередь намерений, — и сверяются побайтно, что ловит ещё и
        // устаревшую копию от прошлой попытки.
        const sameAsParked = () => sameFile(name, to, parked, deps);
        const copyOk = deps.existsFn(parked)
            ? deps.existsFn(to) && sameAsParked()
            : deps.existsFn(to) && (!isState || isValidState(deps.readFn(to)));
        if (deps.existsFn(from)) {
            const text = deps.readFn(from);
            deps.writeFn(to, text);
            // Схема проверяется на КОПИИ и до пометки старого места: отказ здесь оставляет
            // прежнюю раскладку рабочей, и возвращаться некуда не приходится.
            if (isState) assertStateSchema(to, text);
        } else if (deps.existsFn(parked) && !copyOk) {
            // Оригинал уже припаркован, а копии нет, она усечена или отстала от парковки:
            // обрыв между переименованием и записью. Молча считать такой переезд удавшимся
            // нельзя — обычный запуск продолжил бы фазу по неверному состоянию.
            const text = deps.readFn(parked);
            deps.writeFn(to, text);
            if (isState) assertStateSchema(to, text);
        } else if (!deps.existsFn(parked) && !deps.existsFn(to)) {
            // Ни оригинала, ни парковки, ни копии — файл исчез между планом и переездом.
            // Молчать нельзя: это ровно тот случай, когда «переехали» означало бы потерю.
            throw new Error(
                `Файл состояния ${name} исчез посреди переезда: нет ни ${from}, ни ${parked}, ` +
                    `ни ${to}. Разбери руками — откат (--migrate-rollback) вернёт остальное.`,
            );
        } else if (!copyOk) {
            // Копия есть, но битая, а восстанавливать неоткуда: оригинал не сохранился.
            throw new Error(
                `Переехавшее состояние ${to} испорчено, а восстановить его неоткуда: ни ` +
                    `${from}, ни ${parked} нет. Разбери руками.`,
            );
        }
    }

    for (const name of journal.files) {
        const from = at(originOf(journal, name), name);
        if (deps.existsFn(from)) deps.renameFn(from, `${from}${MIGRATED_SUFFIX}`);
    }
    // Маркер — СТРУКТУРНЫЙ (ревью Codex, !23): сверка подстрокой пропустила бы запуск с
    // runtimeDir `/runtime/prod`, когда состояние уехало в `/runtime/prod-old`, — и петля
    // завела бы второе состояние. Человеку он тоже читается: JSON с полем `note`.
    // Маркер — в КАЖДОМ месте старой раскладки (#146): старт по ней идёт и из места запуска,
    // и из дерева раннера, и тот, что не увидел бы маркера, завёл бы второе состояние.
    for (const dir of legacyDirsOf(journal)) {
        deps.writeFn(
            at(dir, MIGRATED_MARKER),
            JSON.stringify(
                {
                    to: journal.to,
                    at: journal.startedAt,
                    note:
                        `Состояние раннера уехало в ${journal.to}. Файлы рядом с суффиксом ` +
                        `${MIGRATED_SUFFIX} — прежние копии, материал отката.`,
                },
                null,
                2,
            ),
        );
    }

    const done: TMigrationJournal = { ...journal, status: 'done', finishedAt: deps.now() };
    writeJournal(journal.to, done, deps);
    return done;
}

/**
 * Барьер СТАРОЙ раскладки: маркер `MIGRATED-TO` читается, а не только пишется.
 *
 * Без этого запуск со старым конфигом (секции `roots` нет) не увидел бы ни маркера, ни
 * переименованного состояния, счёл бы, что состояния просто нет, и начал бы НОВУЮ фазу
 * рядом с уехавшей — два независимых состояния, ради предотвращения которых весь протокол
 * (ревью Codex, !23).
 */
export function assertLegacyNotMigrated(
    legacyDir: string,
    runtimeDir: string | null,
    deps: TMigrationDeps,
): void {
    const marker = at(legacyDir, MIGRATED_MARKER);
    if (!deps.existsFn(marker)) return;
    let target: unknown;
    try {
        target = (JSON.parse(deps.readFn(marker)) as { to?: unknown }).to;
    } catch {
        // Нечитаемый маркер — стоп, а не «наверное, всё в порядке»: он ставится ровно там,
        // где состояние уже уехало, и разобрать его обязан человек.
        throw new Error(
            `Маркер ${marker} не разбирается как JSON, а он означает уехавшее состояние. ` +
                `Разбери руками: продолжить — значит завести второе состояние.`,
        );
    }
    // Сверка ТОЧНАЯ, а не по подстроке: `/runtime/prod` и `/runtime/prod-old` — разные
    // каталоги, и подстрочное сравнение пропустило бы второй экземпляр (ревью Codex, !23).
    if (typeof target === 'string' && runtimeDir && target === runtimeDir) return;
    throw new Error(
        `Состояние из ${legacyDir} уже переехало в ${String(target)} (см. ${marker}), а этот ` +
            `запуск идёт ${runtimeDir ? `с runtimeDir ${runtimeDir}` : 'по СТАРОЙ раскладке'}. ` +
            `Продолжить — значит завести второе состояние рядом с уехавшим. Пропиши в конфиг ` +
            `тот же runtimeDir либо откати переезд (--migrate-rollback).`,
    );
}

/**
 * Откат к прежней раскладке — без окна, в котором живы два состояния: сначала файл ложится
 * в старую раскладку, потом исчезает копия. Работает и по ПРЕРВАННОЙ миграции (журнал
 * in-progress): именно она и нуждается в откате чаще завершённой.
 *
 * Возвращается ТЕКУЩЕЕ состояние `runtimeDir`, а не снимок на момент переезда (#152,
 * репетиция отката). После завершённого переезда петля на новой раскладке успевает сдать
 * фазу и начать следующую, и воскрешённый `*.migrated` вернул бы state с устаревшими
 * `mergeInFlight` и `submitStages`, а текущий удалил бы без копии. Поэтому:
 *
 *   • копия не изменилась — парковка возвращается на место, как раньше: ровно тот же файл;
 *   • изменилась — снимок откладывается под `*.pre-rollback` (имя не затирает снимок
 *     прошлого цикла), а в старую раскладку пишется текущий файл и только потом удаляется
 *     копия. Что изменилось и какая фаза едет назад — в журнале (`rollback`) и в логе;
 *   • журнал in-progress — петля по нему не стартовала (`assertMigrationSettled`), и копия
 *     может быть усечена обрывом: истина там — оригинал или парковка, копия удаляется,
 *     только если они есть.
 *
 * Повтор после обрыва доводит откат: оригинал, совпавший с копией, — уже записанный шаг;
 * разошедшийся — стоп, выбирать между двумя состояниями молча откат не вправе.
 */
export function rollbackRuntime(to: string, deps: TMigrationDeps): TMigrationJournal {
    const journal = readMigrationJournal(to, deps);
    if (!journal) {
        throw new Error(
            `Откатывать нечего: журнала миграции ${at(to, MIGRATION_JOURNAL)} нет. Тихое ` +
                `«готово» здесь означало бы, что состояние трогали неизвестно как.`,
        );
    }
    const report: TRollbackReport = { changed: [], snapshots: {} };
    const settled = journal.status !== 'in-progress';
    for (const name of journal.files) {
        const original = at(originOf(journal, name), name);
        const parked = `${original}${MIGRATED_SUFFIX}`;
        const current = at(journal.to, name);
        const same = (a: string, b: string) => sameFile(name, a, b, deps);
        const hasCurrent = deps.existsFn(current);
        const hasParked = deps.existsFn(parked);
        const hasOriginal = deps.existsFn(original);
        const currentWins = hasCurrent && (settled || (!hasParked && !hasOriginal));
        if (!currentWins || (hasParked && !hasOriginal && same(current, parked))) {
            // Копии нет, она не изменилась после переезда или переезд не завершён: на место
            // едет парковка, копия удаляется уже ПОСЛЕ — её содержимое лежит в оригинале.
            if (hasParked && !hasOriginal) deps.renameFn(parked, original);
            if (hasCurrent) deps.removeFn(current);
            continue;
        }
        if (hasOriginal && !same(original, current)) {
            throw new Error(
                `Откат не выбирает между двумя состояниями: ${original} и ${current} оба есть ` +
                    `и расходятся. Разбери руками, какой из них настоящий, и повтори откат.`,
            );
        }
        report.changed.push(name);
        if (hasParked) {
            const snapshot = freeName(`${original}${PRE_ROLLBACK_SUFFIX}`, deps.existsFn);
            deps.renameFn(parked, snapshot);
            report.snapshots[name] = snapshot;
        }
        const text = deps.readFn(current);
        if (!hasOriginal) deps.writeFn(original, text);
        if (isStateName(name)) report.state = stateSummary(text);
        deps.removeFn(current);
    }
    for (const dir of legacyDirsOf(journal)) {
        const marker = at(dir, MIGRATED_MARKER);
        if (deps.existsFn(marker)) deps.removeFn(marker);
    }
    if (!report.state) delete report.state;
    const rolled: TMigrationJournal = {
        ...journal,
        status: 'rolled-back',
        finishedAt: deps.now(),
        rollback: report,
    };
    writeJournal(to, rolled, deps);
    return rolled;
}

/** Первое свободное имя: снимок прошлого цикла «переезд → откат» не затирается. */
function freeName(base: string, existsFn: (p: string) => boolean): string {
    if (!existsFn(base)) return base;
    let n = 1;
    while (existsFn(`${base}.${n}`)) n++;
    return `${base}.${n}`;
}

function stateSummary(text: string): TRollbackReport['state'] {
    try {
        const s = JSON.parse(text) as { milestone?: unknown; count?: unknown };
        if (typeof s.count !== 'number') return undefined;
        const milestone = typeof s.milestone === 'string' ? s.milestone : null;
        return { milestone, count: s.count };
    } catch {
        return undefined;
    }
}

/** Строка лога об откате: что именно едет назад, если после переезда петля работала. */
export function describeRollback(rolled: TMigrationJournal): string {
    const head = `↩️  Состояние возвращено в ${rolled.from} (файлов: ${rolled.files.length}).`;
    const r = rolled.rollback;
    const tail = `Убери секцию roots из конфига — иначе следующий запуск встанет на несоответствии.`;
    if (!r || r.changed.length === 0) return `${head} ${tail}`;
    const state = r.state
        ? `возвращается текущее состояние: ${r.state.milestone ?? 'веха не задана'}, count ${r.state.count}`
        : `возвращаются текущие файлы новой раскладки`;
    const snaps = Object.values(r.snapshots);
    return (
        `${head} После переезда изменились ${r.changed.join(', ')} — ${state}.` +
        (snaps.length > 0 ? ` Снимок на момент переезда отложен: ${snaps.join(', ')}.` : '') +
        ` ${tail}`
    );
}

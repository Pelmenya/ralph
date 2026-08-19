// Модуль состояния и блокировок раннера (#359, трек «Фреймворк ralph», фаза 2).
// Вынесен из ralph.js по тому же приёму, что ralph-util.ts / side-effect-guard.ts:
// вся работа с тремя файлами раннера — `ralph.state.json` (state фазы), `ralph.lock`
// (файл-лок от двойного запуска #176/#177/#178) и `.deps-lock.sha` (маркер последнего
// `npm ci` #SiaUX) — собрана здесь одним связным модулем, а ralph.js пользуется только
// его API. Форматы файлов НЕ меняются: существующий state/lock/маркер читается как был.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Почему фабрика, а не набор standalone-экспортов (как в ralph-util.ts): эти функции —
// НЕ чистые. Им нужен контекст ralph.js, который standalone-функция взять неоткуда:
// module-level пути (STATE_PATH/LOCK_PATH/…), флаг DRY (#C1 read-only), лениво
// инициализируемый `config` (defaultState берёт первую фазу), общий предохранитель
// побочек #138 (тот же журнал sideEffectAttempts, что у ralph.js), а также
// process-примитивы processAlive/cmdlineIncludes, которые остаются в ralph.js (их делит
// и монитор — иная зона ответственности, не state/lock). Фабрика захватывает этот
// контекст один раз, а возвращённые функции сохраняют ПОКАЗАТЕЛЬНУЮ DI: каждая по-прежнему
// принимает свои коллабораторы (readFn/writeFn/killFn/…) параметром — ровно так их зовут
// сценарные тесты (lock-scenarios.test.ts) и юнит-тесты (state-lock.test.ts) через ре-экспорт
// из ralph.js.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { resolveInstallCmd } from '../shared/ralph-util.ts';

// Формат ralph.state.json — контракт, этим рефактором НЕ меняется (критерий #359).
// milestone === null означает «все фазы пройдены» (см. phaseIndexOf/advancePhase в
// ralph.js). Остальные поля — счётчики брейкеров и планки ревью (#217/#223) и барьер
// пост-мердж деплоя (#165). loadState возвращает то, что лежит на диске, как есть —
// тип описывает канонический полный state (его строит defaultState).
export type RalphState = {
    count: number;
    milestone: string | null;
    submitted: boolean;
    noProgress: number;
    gateHeals: number;
    blockedHeals: number;
    reviewModelFloor: string | null;
    lastReviewModel: string | null;
    reReviewPending: boolean;
    // #625: состояние лестницы «ревью правок» текущей фазы (счётчики проходов, дедуп
    // находок, споры). Форма — ReviewOfFixesState (review-of-fixes.ts), но тип здесь
    // `unknown` по той же причине, что у deployBlock: state читается с диска, где его мог
    // написать прошлый раннер или рука человека, и приводит его к форме нормализатор
    // (normalizeReviewOfFixes), а не вера в тип.
    reviewOfFixes: unknown;
    deployBlock: unknown;
};

type KillFn = (pid: number, signal?: number | string) => void;
type ReadFn = typeof fs.readFileSync;
type WriteFn = (p: string, data: string) => void;
type RemoveFn = (p: string) => void;
type LogFn = (msg: string) => void;
type FailFn = (msg: string) => void;

// Контекст ralph.js, захватываемый фабрикой один раз. Пути и DRY — значения (не меняются
// после старта); config — через геттер (заполняется в main() ПОСЛЕ загрузки модуля, а
// defaultState читает его лениво, в момент вызова). guardSideEffect — обёртка ralph.js
// (уже с hint'ом #145): её вызов пишет в ОБЩИЙ журнал sideEffectAttempts, поэтому боевые
// дефолты writeFn/removeFn краснят тест забытым моком ровно как раньше.
export type StateLockEnv = {
    statePath: string;
    lockPath: string;
    lockMarkerPath: string;
    ralphPath: string;
    dry: boolean;
    // #204: installCmd — команда установки зависимостей из конфига (дефолт `npm ci`).
    // Читается лениво из того же getConfig, что и phases (config ставится в main()).
    getConfig: () => { phases: Array<{ milestone: string }>; installCmd?: string };
    log: LogFn;
    fail: FailFn;
    guardSideEffect: (what: string) => void;
    loadJson: (p: string, fallback: unknown) => unknown;
    processAlive: (pid: number, killFn?: KillFn) => boolean;
    cmdlineIncludes: (pid: number, needle: string, readFn?: ReadFn) => boolean;
    buildSanitizedGateEnv: () => NodeJS.ProcessEnv;
};

export function createStateLock(env: StateLockEnv) {
    const {
        statePath,
        lockPath: LOCK_PATH,
        lockMarkerPath: LOCK_MARKER_PATH,
        ralphPath: RALPH_PATH,
        dry: DRY,
        getConfig,
        log,
        fail,
        guardSideEffect,
        loadJson,
        processAlive,
        cmdlineIncludes,
        buildSanitizedGateEnv,
    } = env;

    // ── State: ralph.state.json ──────────────────────────────────────────────

    function defaultState(): RalphState {
        return {
            count: 0,
            milestone: getConfig().phases[0].milestone,
            submitted: false,
            noProgress: 0,
            gateHeals: 0,
            blockedHeals: 0,
            // #217: планка модели повторного ревью (сильнейшая модель, поставившая блок в
            // этой фазе) и модель последнего проведённого ревью — из них считается floor.
            reviewModelFloor: null,
            lastReviewModel: null,
            // #223: раннер снял label blocked, но повторное ревью ещё не дало вердикта.
            // Флаг переживает рестарт → гейт вернёт метку, если сессия ревью погибла.
            reReviewPending: false,
            // #625: лестница ревью правок ещё не начиналась. Живёт ровно одну фазу —
            // advancePhase её обнуляет вместе с blockedHeals: дедуп находок и счётчик
            // споров относятся к КОНКРЕТНОМУ PR и на следующей фазе смысла не имеют.
            reviewOfFixes: null,
            // #165: красный/недосмотренный пост-мердж деплой прошлой фазы. Пока не null —
            // барьер в preflight не даёт строить следующую фазу поверх недоехавшего до
            // прода main; снимает только человек флагом --deploy-resolved (см. preflight).
            // advancePhase его НЕ обнуляет: блок ставится уже ПОСЛЕ advancePhase и обязан
            // пережить и переход фазы, и рестарт.
            deployBlock: null,
        };
    }

    // failFn инжектируется (дефолт — module-level fail): preflight пробрасывает свой
    // failFn, чтобы юнит-тест ловил fail старой схемы через исключение, а не process.exit.
    function loadState(failFn: FailFn = fail): RalphState {
        const s = loadJson(statePath, null) as RalphState | null;
        if (!s) return defaultState();
        if (s.milestone === undefined) {
            failFn(
                `${statePath} старой схемы (phaseIndex). Раннер адресует фазы по имени milestone. ` +
                    `Запусти --reset (вернёт на первую фазу конфига) или пропиши руками: { count, milestone: <имя фазы>, submitted: false }.`,
            );
        }
        return s;
    }

    function saveState(state: RalphState): void {
        // C1: --dry-run обязан быть строго read-only. Guard ЗДЕСЬ, в единственной точке
        // записи, а не у каждого вызова — невозможно забыть обернуть новый вызов в !DRY
        // (именно так dry-run и начал когда-то двигать phaseIndex).
        if (DRY) return;
        // Тот же guard, что у sh(): забытый saveStateFn в тесте перезаписал бы state
        // ЖИВОГО прогона — гейт мерджа гоняет npm run test прямо в worktree раннера.
        guardSideEffect(`saveState(${statePath})`);
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }

    // ── Маркер зависимостей: .deps-lock.sha ──────────────────────────────────

    // Хэш package-lock.json в дереве dir (sha256 содержимого) или null, если файла нет.
    // Чистая обёртка над fs — вынесена, чтобы гейт и bootstrap считали хэш одинаково.
    function lockHash(dir = '.', readFn: ReadFn = fs.readFileSync): string | null {
        try {
            return crypto
                .createHash('sha256')
                .update(readFn(path.join(dir, 'package-lock.json')))
                .digest('hex');
        } catch {
            return null;
        }
    }

    // Записывает текущий хэш lock как маркер «под эти зависимости уже прогнан npm ci».
    function writeLockMarker(
        dir = '.',
        {
            readFn = fs.readFileSync,
            writeFn = fs.writeFileSync,
        }: { readFn?: ReadFn; writeFn?: typeof fs.writeFileSync } = {},
    ): void {
        const h = lockHash(dir, readFn);
        if (!h) return;
        try {
            writeFn(path.join(dir, LOCK_MARKER_PATH), h);
        } catch {}
    }

    // Гейт детачится на PR-голову ТОЧНОГО коммита, который уедет в main — а её lock мог
    // добавить зависимость (node_modules дерева раннера при этом старые). Сверяем хэш lock
    // с маркером последнего npm ci и при расхождении переустанавливаем ДО чеков (#SiaUX):
    // иначе фаза-с-новой-зависимостью гарантированно красила бы ночной гейт на «module not
    // found», а README честно, но против цели AFK-прогона, отсылал бы чинить руками.
    function syncDepsIfLockChanged({
        logFn = log,
        existsFn = fs.existsSync,
        readFn = fs.readFileSync,
        writeFn = fs.writeFileSync,
        // env (#189): санированное окружение для `npm ci`. checksGreen прокидывает сюда уже
        // построенный env (один allowlist-load на прогон гейта); при прямом вызове дефолт
        // строит его сам через buildGateEnvFn. installFn исполняет lifecycle-скрипты
        // зависимостей — код с чужих слов, ему секреты петли видеть нельзя. Разрешённый env
        // приходит в installFn аргументом — так подмена видна в тестах через spy.
        env: gateEnv,
        buildGateEnvFn = buildSanitizedGateEnv,
        installFn = (resolvedEnv: NodeJS.ProcessEnv) => {
            // Забытый installFn в тесте запустил бы настоящую установку в дереве, где идут
            // тесты, — переустановка node_modules посреди прогона (ревью PR #141).
            guardSideEffect('installCmd (syncDepsIfLockChanged)');
            // #204: команда из конфига (дефолт `npm ci`) — не-npm стек ставит своё, не правя
            // код. Единый резолвер resolveInstallCmd (ralph-util) — тот же, что в логе ниже и
            // в orchestrator.getInstallCmd: дефолт не разъедется между «сказано» и «сделано».
            return execSync(resolveInstallCmd(getConfig()), {
                stdio: 'inherit',
                env: resolvedEnv,
            });
        },
    }: {
        logFn?: LogFn;
        existsFn?: typeof fs.existsSync;
        readFn?: ReadFn;
        writeFn?: typeof fs.writeFileSync;
        env?: NodeJS.ProcessEnv;
        buildGateEnvFn?: () => NodeJS.ProcessEnv;
        installFn?: (resolvedEnv: NodeJS.ProcessEnv) => unknown;
    } = {}): void {
        const current = lockHash('.', readFn);
        if (!current) return; // нет package-lock.json — сверять нечего
        let prev: string | null = null;
        try {
            if (existsFn(LOCK_MARKER_PATH)) prev = String(readFn(LOCK_MARKER_PATH, 'utf-8')).trim();
        } catch {}
        if (prev === current) return;
        logFn(
            `📦 package-lock.json PR-головы отличается от установленного — ${resolveInstallCmd(getConfig())} перед чеками...`,
        );
        // env из checksGreen (уже санирован), иначе строим сам — fail-closed при битом allowlist.
        installFn(gateEnv ?? buildGateEnvFn());
        writeLockMarker('.', { readFn, writeFn });
    }

    // ── Файл-лок от двойного запуска: ralph.lock (#176/#177/#178) ─────────────

    // Сверка «за pid действительно наш ralph.js» — по пути RALPH_PATH в cmdline. Тот же приём,
    // что isRalphMonitorProcess. ВНИМАНИЕ: RALPH_PATH относительный и уникальности проекта не
    // гарантирует (см. коммент у объявления RALPH_PATH) — для лока это лишь ложный отказ при
    // pid-reuse (fail-closed), не снос чужого процесса. Переиспользованный pid (чужой процесс
    // под тем же номером) → подстроки нет → false, лок считается сиротой.
    function isRalphProcess(pid: number, readFn: ReadFn = fs.readFileSync): boolean {
        return cmdlineIncludes(pid, RALPH_PATH, readFn);
    }

    // Держит ли лок ЖИВОЙ раннер: номер занят (kill 0) И cmdline подтверждает ralph.js.
    // Обе проверки обязательны и в этом порядке — kill(pid, 0) на мёртвом pid бросит
    // (ESRCH → false) и до чтения /proc не дойдём; на переиспользованном номере kill
    // пройдёт, но cmdline-сверка отсечёт чужой процесс. Так pid-reuse не сойдёт за живой
    // раннер и не заблокирует легитимный запуск. procReadFn читает ТОЛЬКО /proc/<pid>/cmdline
    // (отдельный от чтения лок-файла контракт — в acquireLock это разные dep'ы).
    function lockAlive(
        pid: number,
        {
            killFn = process.kill,
            procReadFn = fs.readFileSync,
        }: { killFn?: KillFn; procReadFn?: ReadFn } = {},
    ): boolean {
        return processAlive(pid, killFn) && isRalphProcess(pid, procReadFn);
    }

    // Пишет pid текущего процесса в лок-файл ЭКСКЛЮЗИВНО (flag 'wx'): создаёт файл, только
    // если его ещё нет, иначе бросает EEXIST. Это закрывает гонку check-then-act в acquireLock
    // (см. там) — второй одновременно стартующий раннер, прошедший ту же проверку «лока нет»,
    // на записи получит EEXIST и не перезапишет победителя. Побочка — под предохранителем
    // #138: забытый writeFn в тесте иначе насорил бы настоящим ralph.lock в дереве тестов.
    function writeLock(
        pid: number = process.pid,
        { writeFn, lockPath = LOCK_PATH }: { writeFn?: WriteFn; lockPath?: string } = {},
    ): void {
        const doWrite: WriteFn =
            writeFn ||
            ((p, data) => {
                guardSideEffect(`writeLock (${p})`);
                return fs.writeFileSync(p, data, { flag: 'wx' });
            });
        doWrite(lockPath, String(pid));
    }

    // Снимает лок-файл (осиротевший лок при взятии, свой лок при выходе). Побочка — под
    // предохранителем #138. ENOENT при удалении не ошибка: лок уже снят (гонка, ручная
    // чистка) — цель «файла нет» достигнута, а не «удаление провалилось».
    function removeLock({
        lockPath = LOCK_PATH,
        removeFn,
    }: { lockPath?: string; removeFn?: RemoveFn } = {}): void {
        const doRemove: RemoveFn =
            removeFn ||
            ((p) => {
                guardSideEffect(`removeLock (${p})`);
                try {
                    fs.unlinkSync(p);
                } catch (e: unknown) {
                    if (!e || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
                }
            });
        doRemove(lockPath);
    }

    // Снятие СВОЕГО лока при штатном выходе (exit-хендлер main()). Без него каждый рестарт
    // шёл бы через путь «🔓 осиротевший лок»: шум в логе + событие перестаёт быть сигналом
    // РЕАЛЬНОГО kill -9, а устаревший файл расширяет окно pid-reuse (номер достанется grep/
    // tail/vim по ralph.js → ложный «живой раннер» и отказ старта). Две оговорки: (1) снимаем
    // ТОЛЬКО если файл ещё держит наш pid — если лок в странной гонке украли/переписали,
    // слепой unlink снёс бы чужой; (2) путь передаётся АБСОЛЮТНЫЙ, зафиксированный ДО chdir в
    // worktree, — относительный LOCK_PATH после chdir указал бы внутрь дерева раннера (тот же
    // прецедент, что репойнт logTarget, #SiaUB). Свои побочки — через DI под #138.
    function releaseLockIfOurs(
        lockPath: string,
        {
            readFn = fs.readFileSync,
            removeFn,
            pid = process.pid,
        }: { readFn?: ReadFn; removeFn?: RemoveFn; pid?: number } = {},
    ): void {
        let held: number;
        try {
            held = Number(String(readFn(lockPath, 'utf-8')).trim());
        } catch {
            return; // нет файла / нечитаем — снимать нечего
        }
        if (held !== pid) return; // лок уже не наш — чужой не трогаем
        removeLock({ lockPath, removeFn });
    }

    // --- Взятие лока: fail-closed решение (#177) -------------------------------
    // Единственная точка решения «стартовать или отказать» по лок-файлу. Четыре исхода:
    //
    //   нет файла (ENOENT)                  → лок свободен: пишем свой pid, стартуем.
    //   живой раннер (kill 0 + cmdline)     → ОТКАЗ fail-closed, сообщение с pid и путём.
    //   сирота (pid мёртв / чужой cmdline)  → снимаем лок, событие в лог, берём себе.
    //   нечитаем / битый pid                → СТОП fail-closed (не «лока нет»).
    //
    // Читаем файл здесь напрямую и парсим со СТРОГОЙ валидацией: «нет файла», «нет прав» и
    // «битый pid» для #177 — три разных исхода (ENOENT — норм-путь, EACCES/битое содержимое —
    // fail-closed стоп по образцу scripts/security-audit.mjs). lockAlive — примитив живости;
    // acquireLock — слой политики над ним.
    //
    // Взятие лока АТОМАРНО: и на пути «нет файла», и на пути реклейма сироты запись идёт через
    // writeLock (flag 'wx' — эксклюзивное создание). Между нашим чтением и записью второй
    // одновременно стартующий раннер мог пройти ту же проверку и записать свой pid — тогда наш
    // 'wx' бросит EEXIST, и это ОТКАЗ (лок только что появился), а не молчаливая перезапись
    // победителя гонки. Иначе неатомарный check-then-act пропустил бы оба процесса — ровно та
    // гонка за state/ветки/мердж, ради запрета которой лок существует.
    //
    // Все побочки — через DI (#138): чтение лок-файла (readFn) и /proc (procReadFn) РАЗДЕЛЕНЫ
    // (у каждого свой контракт, тестам не надо мультиплексировать по пути), плюс удаление,
    // запись, kill, лог, стоп. failFn по умолчанию — fail() (process.exit(1)); в бою после
    // него исполнение не продолжается, return в тестах нужен мок-failFn, который не роняет
    // процесс.
    function acquireLock({
        lockPath = LOCK_PATH,
        pid = process.pid,
        readFn = fs.readFileSync,
        procReadFn = fs.readFileSync,
        killFn = process.kill,
        removeFn,
        writeFn,
        logFn = log,
        failFn = fail,
    }: {
        lockPath?: string;
        pid?: number;
        readFn?: ReadFn;
        procReadFn?: ReadFn;
        killFn?: KillFn;
        removeFn?: RemoveFn;
        writeFn?: WriteFn;
        logFn?: LogFn;
        failFn?: FailFn;
    } = {}): boolean {
        // Эксклюзивная запись своего pid: writeLock идёт через flag 'wx', поэтому если лок УСПЕЛ
        // появиться между проверкой и записью (гонка двух стартов) — EEXIST → fail-closed отказ.
        const claim = (): boolean => {
            try {
                writeLock(pid, { writeFn, lockPath });
                return true;
            } catch (e: unknown) {
                if (e && (e as NodeJS.ErrnoException).code === 'EEXIST') {
                    failFn(
                        `Лок ${lockPath} возник в момент взятия — другой раннер стартовал ` +
                            `одновременно. Второй запуск на том же состоянии запрещён.`,
                    );
                    return false;
                }
                throw e;
            }
        };

        let raw: string | Buffer;
        try {
            raw = readFn(lockPath, 'utf-8');
        } catch (e: unknown) {
            // Файла нет — лок свободен, это норм-путь. Только ENOENT: любую другую ошибку
            // чтения (нет прав, битый inode) трактовать как «лока нет» = тихо стартовать
            // поверх возможного живого раннера, ровно то, что fail-closed запрещает.
            if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
                return claim();
            }
            const err = e as NodeJS.ErrnoException;
            failFn(
                `Лок-файл ${lockPath} нечитаем (${String(err?.code ?? err?.message ?? e)}) — ` +
                    `не берусь решать, жив ли другой раннер. Разберись руками и перезапусти.`,
            );
            return false;
        }

        const trimmed = String(raw).trim();
        const heldPid = Number(trimmed);
        // Битое содержимое: пусто или не положительное целое. Не «пропустим проверку» и не
        // «считаем сиротой и крадём» — стоп fail-closed. Осознанная цена: усечённый при
        // падении лок требует ручной чистки, но гонка двух раннеров дороже (deadman заметит
        // «не стартовал»).
        if (!trimmed || !Number.isInteger(heldPid) || heldPid <= 0) {
            failFn(
                `Лок-файл ${lockPath} битый (содержимое ${JSON.stringify(trimmed)}) — ` +
                    `не берусь решать, жив ли другой раннер. Разберись руками и перезапусти.`,
            );
            return false;
        }

        if (lockAlive(heldPid, { killFn, procReadFn })) {
            // Живой раннер держит лок — отказ. Сообщение обязано назвать pid и путь (кто
            // держит и где), критерий #177.
            failFn(
                `Другой раннер уже держит лок: pid ${heldPid}, файл ${lockPath}. ` +
                    `Второй запуск на том же состоянии запрещён — гонка за state/ветки/мердж.`,
            );
            return false;
        }

        // Сирота: pid мёртв (kill 0 → ESRCH) или за ним чужой процесс (pid-reuse, cmdline не
        // наш ralph.js). Снимаем лок и берём себе — без ручной чистки после kill -9 / OOM.
        // ВНИМАНИЕ (#178): это событие уходит через log() ДО репойнта logTarget на worktree (он
        // в main() ПОСЛЕ загрузки конфига, а лок — самый первый шаг, впереди конфига по
        // построению). Поэтому строка «🔓» ляжет в ralph.log ДЕРЕВА ЧЕЛОВЕКА, а монитор тейлит
        // только worktree-лог — на панели этого события НЕ будет. Ищи его в ralph.log клона
        // запуска, не в monitor.out. Изменить порядок нельзя: лок обязан быть до побочек.
        logFn(
            `🔓 Осиротевший лок pid ${heldPid} (процесс мёртв или не наш ralph.js) — ` +
                `снимаю ${lockPath} и стартую.`,
        );
        removeLock({ lockPath, removeFn });
        // Реклейм тоже через эксклюзивную запись: между unlink и созданием второй процесс мог
        // снять ту же сироту и взять лок — тогда наш claim() получит EEXIST, а не перезапишет
        // победителя гонки за реклейм.
        return claim();
    }

    return {
        defaultState,
        loadState,
        saveState,
        lockHash,
        writeLockMarker,
        syncDepsIfLockChanged,
        isRalphProcess,
        lockAlive,
        writeLock,
        removeLock,
        releaseLockIfOurs,
        acquireLock,
    };
}

// Ralph monitor — ЛОГИКА панели прогресса AFK-цикла (#404, фаза 8 «Дотипизация оболочки»).
//
// Вынесено из runtime/monitor.js: entry (`monitor.js`) остаётся тонким JS, запускаемым
// напрямую (проверка Node ≥24 до первого require('*.mts')); вся логика — чтение лога,
// сводка, gh-запросы, детект тишины и дедуп пуша — живёт здесь и покрыта
// monitor-panel.test.mts. Путь запуска `node .claude/ralph/runtime/monitor.js` НЕ
// меняется (прошит в RUNBOOK, tmux-раскладке и в спавне монитора из core/orchestrator.ts).
//
// Каждые N секунд (по умолчанию 300 = 5 минут) main() печатает сводку:
//   - жив ли loop (по свежести ralph.log)
//   - текущая фаза / submitted (из ralph.state.json)
//   - прогресс issues текущего milestone (gh)
//   - открытые PR текущей фазы (gh, по ветке из конфига #214)
//   - последние значимые строки ralph.log (маркеры фаз/итераций/ревью/мерджа)
//
// Только чтение: gh-запросы + чтение файлов. Ничего не мутирует (инвариант №12: монитор
// не пишет в ralph.log — свежесть этого файла и есть признак жизни раннера).
//
// ── Почему .mts (а не .ts), и почему import.meta.dirname (#404, по образцу gate-env.mts/#403) ──
// Панель берёт ralph.log/state/config ОТ КАТАЛОГА МОДУЛЯ — потому монитор и запускают из
// дерева раннера, иначе он читал бы лог launch-дерева и показывал чужую картину (ровно это
// выглядело как «панель со старыми событиями» 29.07). Под нативным type stripping Node
// TS-модуль с `export` исполняется как ESM, где `__dirname` не существует (проверено:
// require('*.ts') с export → `__dirname is not defined`). Каталог модуля в ESM даёт
// `import.meta.dirname`, но в обычном `.ts` под nodenext-CommonJS это жёсткая ошибка
// TS1470. Снимает тупик ровно `.mts`: это ЯВНО-ESM и для TS (import.meta.dirname легален),
// и для рантайма (модуль грузится как ESM, import.meta.dirname = каталог, ОТКУДА ЗАГРУЖЕН
// модуль). monitor.js берёт его через require(esm) (Node 24), провенанс сохранён.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
// Резолв профилей (#71) и примитивы петли — единый источник правды с раннером, чтобы
// монитор не завёл вторую копию правил мерджа. ralph.js — JS-entry без деклараций типов,
// поэтому default-импорт с деструктуризацией (ESM не читает именованные экспорты из CJS
// в sync-пути require(esm)); @ts-expect-error — как в config-profile.test.ts (#366).
// @ts-expect-error — JS-entry раннера без деклараций типов.
import ralph from '../ralph.js';
// ralph.js — module.exports = createOrchestrator(...), поэтому его поверхность точно
// описывается ReturnType<typeof createOrchestrator> (#409-ревью). Тем же кастом, что в
// test-helpers.ts, типизируем три функции боевыми типами вместо `any` из ts-expect-error-
// импорта. resolveProfile/parseProfileFlag боевым типом возвращают unknown (конфиг
// недоверенный) — сужение остаётся по месту (см. `as ResolvedConfig` в snapshot()).
type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const resolveProfile = ralph.resolveProfile as Runtime['resolveProfile'];
const parseProfileFlag = ralph.parseProfileFlag as Runtime['parseProfileFlag'];
const shq = ralph.shq as Runtime['shq'];
// #386: та же чистая функция разводки лога, что и у раннера (exec.ts) — панель обязана
// читать РОВНО тот файл, в который пишет наблюдаемый прогон, иначе судила бы о жизни по
// чужому/протухшему логу (см. monitorLogPath ниже).
const chooseLogPath = ralph.chooseLogPath as Runtime['chooseLogPath'];
// pushEvent СОЗНАТЕЛЬНО остаётся нетипизированным: боевой тип (msg, cfg?: RalphConfig, opts)
// не присваивается локальному PushFn — у панели cfg: ResolvedConfig nullable и частичный
// (конфиг читается мягко), а строгий каст покраснил бы default `pushFn = pushEvent` в
// maybePushDeadman. Тот же осознанный отказ, что у поверхности в orchestrator.test.ts, но по
// конкретной причине — трение строгого типа pushEvent с nullable cfg панели.
const { pushEvent } = ralph;
// Пороги тишины (#147): классификация хвоста лога по режиму + порог по режиму. Здесь
// (в мониторе) — импёровая половина: чтение файла, «сейчас» и сравнение с порогом.
import { classifyActivity, silenceThresholdMs, type Activity } from './deadman.ts';

// monitor-panel.mts живёт в .claude/ralph/runtime/ (#396), поэтому каталог раннера —
// родитель import.meta.dirname, а не он сам. Служебные файлы (ralph.log/state/config)
// лежат в .claude/ralph/. import.meta.dirname = каталог, ОТКУДА ЗАГРУЖЕН модуль (дерево
// раннера), чем и держится семантика «панель читает лог своего дерева» (#404).
const RALPH_DIR = path.resolve(import.meta.dirname, '..');
const REPO_DIR = path.resolve(RALPH_DIR, '..', '..');
// #386: раннер разводит боевой ralph.log и не-боевой ralph.dry.log (chooseLogPath, exec.ts).
// Панель выбирает между ними тем же кодом — см. monitorLogPath. LOG_PATH (боевой) остаётся
// дефолтом readLogTail для ручных вызовов/тестов; snapshot() переопределяет его по профилю.
const LOG_PATH_BATTLE = path.join(RALPH_DIR, 'ralph.log');
const LOG_PATH_SIDELINE = path.join(RALPH_DIR, 'ralph.dry.log');
const LOG_PATH = LOG_PATH_BATTLE;
const STATE_PATH = path.join(RALPH_DIR, 'ralph.state.json');

// #386: путь лога, который читает панель, = путь, в который пишет наблюдаемый прогон.
// Раннер решает его через chooseLogPath по РЕЗОЛВНУТОМУ профилю (боевой ralph.log только
// для profileName==='prod' && !dry); панель обязана читать ровно тот же файл, иначе о жизни
// боевой петли судила бы по протухшему ralph.dry.log (или наоборот). dry:false — у монитора
// нет своего dry-режима: для dry-прогона раннер монитор вообще не спавнит, значит выбор
// решает один профиль. Конфиг недоверенный/нечитаемый (config===null) → profileName undefined
// → консервативно sideline, как и у самого chooseLogPath.
export function monitorLogPath(config: ResolvedConfig): string {
    return chooseLogPath(
        { dry: false, profileName: config?.profileName },
        { battle: LOG_PATH_BATTLE, sideline: LOG_PATH_SIDELINE },
    );
}

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const intervalIdx = args.indexOf('--interval');
const INTERVAL_SEC = intervalIdx !== -1 ? Number(args[intervalIdx + 1]) || 300 : 300;
// --config <путь> (#SiaT8): раннер прокидывает АБСОЛЮТНЫЙ путь конфига из дерева
// человека — тот же файл, по которому он реально идёт. Без флага (ручной запуск) —
// копия в этом же worktree; она может отставать на детач-коммите, о чём и был ревью.
const configIdx = args.indexOf('--config');
const CONFIG_PATH =
    configIdx !== -1 && args[configIdx + 1]
        ? args[configIdx + 1]
        : path.join(RALPH_DIR, 'ralph.config.json');
// Профиль тем же парсером, что у раннера (раннер прокидывает его при авто-спавне).
// failFn → null: монитор наблюдательный, кривой флаг для него повод показать
// defaultProfile, а не упасть с панелью.
const PROFILE = parseProfileFlag(args, () => null);

// Строки лога, которые считаем «значимыми» (маркеры этапов AFK-цикла).
// ▶ (#249): переход «фаза N → фаза N+1» в непрерывном prod — ключевое событие режима,
// иначе на панели невидимо; заодно в ленту попадают старты claude-сессий (▶ claude -p).
const SIGNAL_RE = /🚀|🔄|✅|🔍|🔧|🛑|⛔|🏁|❌|⚠|🔀|💤|🔔|▶/u;

// Фаза из конфига — панели нужны только milestone (сверка со state) и branch (поиск PR).
// Оба опциональны: конфиг недоверенный, поля читаются мягко (guard'ы по месту).
type PhaseConfig = { milestone?: string; branch?: string };

// Резолвнутый профилем конфиг — как его видят вызывающие (пороги/phases на верхнем
// уровне). Поля читаются мягко (все чеки — Array.isArray / typeof), поэтому тип широкий,
// но phases типизируем сразу PhaseConfig[] — иначе Array.isArray сужал бы до any[] и
// implicit any просачивался бы в currentMilestone/openPhasePRs.
type ResolvedConfig = {
    profileName?: string;
    phases?: PhaseConfig[];
} | null;

// state фазы (ralph.state.json): milestone === null — штатный конец очереди (#THS8M).
type PhaseState = {
    milestone?: string | null;
    submitted?: boolean;
    count?: number;
} | null;

// Результат детекта тишины (#147/#148). Поля nullable: ветка no-log отдаёт null'ы —
// сам детект тогда не алертит (silent:false), см. evalDeadman.
type DeadmanEval = {
    silent: boolean;
    reason: string | null;
    activity: Activity | null;
    thresholdMs: number | null;
    silenceMs: number | null;
};

// Доставка пуша о тишине — та же сигнатура, что pushEvent(msg, cfg, opts) в ralph.js.
type PushFn = (
    msg: string,
    cfg: ResolvedConfig,
    opts: { logFn: (...a: unknown[]) => void; dry: boolean },
) => boolean;

// Открытый PR фазы (нужные панели поля из gh pr list --json …).
type PhasePr = {
    number: number;
    title: string;
    headRefName: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
};

function sh(cmd: string): string {
    try {
        return execSync(cmd, {
            cwd: REPO_DIR,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

function readJSON(p: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

export function fmtAge(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}с назад`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}м ${s % 60}с назад`;
    const h = Math.floor(m / 60);
    return `${h}ч ${m % 60}м назад`;
}

// Длительность без «назад» — для печати порога.
export function fmtDur(ms: number): string {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}м`;
    return `${Math.floor(m / 60)}ч ${m % 60}м`;
}

// Сырой хвост лога (НЕ отфильтрованный по SIGNAL_RE) + время последней записи. deadman
// классифицирует режим по маркерам ✓/✗/🚦, которых нет в SIGNAL_RE, поэтому детект
// читает сырые строки, а панель значимые получает фильтром signalTail поверх этого же
// чтения (одно чтение на тик). lastMtime = mtime файла: свежесть
// лога и есть признак жизни петли (log() пишется на каждом шаге хореографии). logPath
// параметром — чтобы тестировать на временном файле, а не только на боевом LOG_PATH.
// n — сколько последних строк вернуть; n === null → ВЕСЬ файл (явный контракт вместо
// slice(-Infinity), который «случайно» отдавал весь массив). Весь файл нужен ПАНЕЛИ:
// значимые маркеры редки, последние 8 (signalTail) приходится искать по всей глубине.
// Детект же в snapshot() намеренно ограничен последними 200 строками (allLogLines.slice(-200)):
// расширять окно детекта на весь файл нельзя — древний ⛔/🎉 из глубины лога переклассифицировал
// бы режим (реальное изменение поведения, а не оптимизация).
export function readLogTail(
    n: number | null = 200,
    logPath: string = LOG_PATH,
): { lines: string[]; lastMtime: number | null } {
    let raw: string;
    try {
        raw = fs.readFileSync(logPath, 'utf8');
    } catch {
        return { lines: [], lastMtime: null };
    }
    let lastMtime: number | null = null;
    try {
        lastMtime = fs.statSync(logPath).mtimeMs;
    } catch {
        /* ignore */
    }
    const all = raw.split('\n');
    return { lines: n == null ? all : all.slice(-n), lastMtime };
}

// Детект тишины: возраст последней записи лога (now − lastMtime) против порога режима
// текущего шага (coder до 2ч, гейт/хоз-шаги — минуты). Чистая функция — все входы
// аргументами, «сейчас» приходит извне: детект смотрит на ФАЙЛ, а не на процесс
// раннера, поэтому переживает его смерть (kill -9, OOM). Сам пуш и дедуп — #149.
export function evalDeadman({
    now,
    lastMtime,
    lines,
    config,
}: {
    now: number;
    lastMtime: number | null;
    lines: string[];
    // config уходит только в silenceThresholdMs (deadman.ts), где тип уже unknown и все
    // поля читаются мягко: сюда одинаково валиден резолвнутый конфиг, null и тестовый CFG
    // (пороги на верхнем уровне) — без weak-type-конфликта с ResolvedConfig.
    config: unknown;
}): DeadmanEval {
    if (lastMtime == null) {
        return {
            silent: false,
            reason: 'no-log',
            activity: null,
            thresholdMs: null,
            silenceMs: null,
        };
    }
    const activity = classifyActivity(lines);
    // lines прокидываем — режиму apiwait порог берётся из строки паузы `Жду N мин`.
    const thresholdMs = silenceThresholdMs(activity, config, lines);
    // Math.max(0, …): mtime снимается ПОСЛЕ чтения контента, а now — до обоих. Запись в
    // лог между этими точками (или скачок системных часов назад) дала бы lastMtime > now
    // → отрицательный silenceMs и косметический `⏱ лог -1с назад`. Зажимаем в ноль.
    const silenceMs = Math.max(0, now - lastMtime);
    return { silent: silenceMs > thresholdMs, reason: null, activity, thresholdMs, silenceMs };
}

// Дедуп повторных пушей об одной и той же тишине (#149 — alert fatigue главный риск
// по PRD). Эпизод тишины идентифицируем по lastMtime — моменту, когда лог перестал
// расти: пока файл не сдвинулся дальше, это ТА ЖЕ тишина, повторный пуш не нужен. Как
// только лог снова пишется (loop ожил или человек вмешался), lastMtime меняется —
// следующая тишина, если наступит, будет уже новым эпизодом со своим ключом.
export function shouldPushDeadman(
    deadman: { silent: boolean },
    lastMtime: number | null,
    lastPushedForMtime: number | null,
): boolean {
    return deadman.silent && lastMtime !== lastPushedForMtime;
}

// Текст пуша — та же формулировка, что и на панели (evalDeadman/fmtAge/fmtDur), плюс
// имя фазы и явное «цикл не остановлен» — по PRD автостоп не делаем, ложный ночной
// стоп дороже лишнего пуша, и человек должен понимать, что раннер продолжит идти.
// silenceMs/thresholdMs здесь всегда числа (пуш только при silent), `?? 0` — лишь чтобы
// удовлетворить nullable-тип DeadmanEval, в бою эта ветка недостижима.
export function deadmanPushMessage(
    deadman: { silenceMs: number | null; thresholdMs: number | null; activity: Activity | null },
    milestoneName: string,
): string {
    return (
        // «молчит N» — длительность тишины (fmtDur, без «назад»): fmtAge добавил бы «назад»
        // и вышло бы «молчит 5м назад» (как будто молчание было в прошлом, а оно длится).
        `💀 Ralph: DEADMAN на фазе "${milestoneName}" — лог молчит ${fmtDur(deadman.silenceMs ?? 0)}, ` +
        `дольше порога ${fmtDur(deadman.thresholdMs ?? 0)} (режим ${deadman.activity}). ` +
        'Цикл продолжается без остановки — проверь вручную.'
    );
}

// Оценка + сам пуш, вынесено из snapshot(), чтобы тестировать без реальных gh-вызовов
// остального снапшота — тот же приём, что evalDeadman/readLogTail (#147/#148): чистая
// логика решения отдельно от побочек панели. pushFn инжектируется (как pushEventFn в
// ralph.js) — тесты мокают сам вызов, не profileName/Telegram. Возвращает новый ключ
// дедупа (вызывающий код держит его в состоянии между тиками).
// logFn у pushFn — НЕ log() раннера: та функция дописывает СТРОКУ В ТОТ ЖЕ ralph.log,
// по свежести которого детект и определяет тишину. Если бы пуш писал туда же,
// lastMtime «ожил» бы от собственного пуша монитора, и реальная тишина маскировалась
// бы навсегда (мёртвый раннер выглядел бы живым из-за пуша про его смерть). Печатаем
// в свой stdout — monitor.out, куда и так льётся вся панель, tail -f видит и его.
export function maybePushDeadman(
    // reason не читается (используются только silent/silenceMs/thresholdMs/activity),
    // поэтому тип уже DeadmanEval — снапшот подаёт его результат (надмножество), а тесты
    // конструируют ровно этот набор полей.
    deadman: {
        silent: boolean;
        silenceMs: number | null;
        thresholdMs: number | null;
        activity: Activity | null;
    },
    lastMtime: number | null,
    lastPushedForMtime: number | null,
    {
        pushFn = pushEvent,
        cfg,
        milestoneName,
    }: { pushFn?: PushFn; cfg: ResolvedConfig; milestoneName: string },
): number | null {
    if (!shouldPushDeadman(deadman, lastMtime, lastPushedForMtime)) {
        return lastPushedForMtime;
    }
    // Кривой/нечитаемый конфиг (resolveProfile → null): в prod pushEvent молча вернёт
    // false ДО доставки, то есть деадман обезоружен ровно в аварийном состоянии, о
    // котором watchdog и должен кричать. Fail-safe-доставка при null-конфиге — фаза 2;
    // здесь минимум — раз на эпизод явно предупредить в свой stdout (monitor.out).
    if (!cfg) {
        console.log(
            '⚠ Ralph deadman: конфиг не резолвится — deadman-пуши НЕ доставляются (проверь ralph.config.json / --profile).',
        );
    }
    // dry: false явно. У монитора нет своего dry-режима, но pushEvent по умолчанию берёт
    // dry из argv СВОЕГО процесса (require('../ralph.js') парсит DRY из process.argv). Если
    // монитор на prod-хосте запустить со случайно скопированным `--dry-run` в argv,
    // pushEvent вернул бы false ДО проверки профиля → maybePushDeadman счёл бы это сбоем
    // доставки (deliveryAttempted) → вечный ретрай с маркером каждый тик, при «доставка
    // пушей: вкл» на панели. Прокидываем false — доставка deadman не зависит от argv.
    const delivered = pushFn(deadmanPushMessage(deadman, milestoneName), cfg, {
        logFn: console.log,
        dry: false,
    });
    // Дедуп-ключ защёлкиваем не безусловно: в prod false у pushEvent = доставка НЕ удалась
    // (сбой curl/сети/Telegram, fail-open вернул false) — единственный алерт о мёртвом
    // ночном раннере нельзя терять, поэтому ключ НЕ двигаем, следующий тик повторит.
    // В non-prod/при null-конфиге false = пуш штатно подавлен профилем (доставки нет и не
    // будет) — тогда защёлкиваем, иначе наивный ретрай спамил бы monitor.out каждый тик.
    const deliveryAttempted = !!cfg && cfg.profileName === 'prod';
    if (deliveryAttempted && !delivered) {
        return lastPushedForMtime;
    }
    return lastMtime;
}

// Значимые строки (маркеры этапов) из УЖЕ прочитанного хвоста — последние n. Своего
// чтения файла НЕ делает: и панель значимых строк, и детект тишины идут от одного
// readLogTail в snapshot(). Так у тика ровно одно чтение (растущий многодневный лог не
// читается дважды за тик) и ровно один mtime — иначе два независимых statSync могли бы
// разойтись, и возраст одного файла в строках `🟢 активен` и `⏱ лог` показал бы разное.
function signalTail(lines: string[], n: number): string[] {
    return lines.filter((l) => SIGNAL_RE.test(l)).slice(-n);
}

function currentMilestone(
    state: PhaseState,
    config: ResolvedConfig,
): { idx: number; phase: PhaseConfig | null; total: number } | null {
    // state.milestone может быть точным именем фазы; сверяем с конфигом,
    // чтобы понять индекс/ветку.
    if (!config || !Array.isArray(config.phases)) return null;
    const idx = config.phases.findIndex((p) => p.milestone === state?.milestone);
    return {
        idx,
        phase: idx !== -1 ? config.phases[idx] : null,
        total: config.phases.length,
    };
}

function issuesProgress(
    milestone: string | null,
): { open: number; closed: number; total: number } | null {
    if (!milestone) return null;
    // gh поддерживает поиск по milestone имени. Имя milestone — недоверенный источник
    // из конфига (тот же класс #133, что и ветка фазы): в shell-строку через shq, не в
    // двойные кавычки, где $()/бэкктики/\ раскрылись бы шеллом.
    const open = sh(
        `gh issue list --milestone ${shq(milestone)} --state open --json number --jq "length"`,
    );
    const closed = sh(
        `gh issue list --milestone ${shq(milestone)} --state closed --json number --jq "length"`,
    );
    if (open === '' && closed === '') return null;
    const o = Number(open) || 0;
    const c = Number(closed) || 0;
    return { open: o, closed: c, total: o + c };
}

// Поиск открытых PR текущей фазы по ветке из конфига (#214).
// Параметры: config (резолвлен из конфига), state (из ralph.state.json), shFn (для тестов).
// Различает исходы (fail-closed, каждый — своя строка панели): ветку фазы определить не
// удалось → { error: 'no-branch' }; все фазы завершены (штатный конец) → { error:
// 'all-done' }; gh упал / вернул мусор → { error: 'gh-failed' }; иначе найденные PR или [].
export function openPhasePRs(
    config: ResolvedConfig,
    state: PhaseState,
    shFn: (cmd: string) => string = sh,
): PhasePr[] | { error: string } {
    // #THS8M: milestone === null — не «битый state», а штатный конец: advancePhase после
    // ПОСЛЕДНЕЙ фазы пишет milestone: null. Отдельный маркер, чтобы панель не пугала
    // «не удалось определить ветку фазы» на успешно сданной очереди.
    if (state && state.milestone === null) {
        return { error: 'all-done' };
    }
    // Определяем текущую ветку фазы из конфига по milestone в state.
    if (!config || !Array.isArray(config.phases) || !state?.milestone) {
        return { error: 'no-branch' };
    }
    const phase = config.phases.find((p) => p.milestone === state.milestone);
    if (!phase || !phase.branch) {
        return { error: 'no-branch' };
    }
    // Ищем PR строго по ветке фазы: --head <branch> (точное совпадение), не
    // --search "head:…" (#THS8X: search-квалификатор матчит по префиксу — head:feature/x
    // поймал бы и feature/x-check, показав на панели PR чужой фазы). Ветка из конфига —
    // недоверенный источник (класс #133): в shell-строку идёт через shq, как в ralph.js
    // (findOpenPr: gh pr list --head ${shq(branch)}). --jq "." был no-op поверх --json.
    const out = shFn(
        `gh pr list --state open --head ${shq(phase.branch)} --json number,title,headRefName,mergeStateStatus,reviewDecision`,
    );
    // #THS8Z: пустой вывод sh() = упавшая gh-команда (успех «нет PR» даёт непустой `[]`),
    // непарсимый вывод = мусор от gh. Оба → { error: 'gh-failed' }, а не `[]`: иначе сбой
    // gh на панели неотличим от честного «PR нет» (докблок обещает fail-closed, но эта
    // ветка молча притворялась бы «нет»).
    if (out === '') return { error: 'gh-failed' };
    try {
        return JSON.parse(out);
    } catch {
        return { error: 'gh-failed' };
    }
}

// Ключ дедупа деадмана (#149) — переживает между тиками setInterval (тот же процесс
// monitor.js на весь прогон петли), но НЕ переживает перезапуск самого монитора: это
// уже фаза 2 (взаимный контроль раннер↔монитор), здесь не в скоупе.
let lastDeadmanPushMtime: number | null = null;

// Разовое предупреждение об исчезнувшем логе (см. snapshot). Сбрасывается, когда лог
// снова находится, — чтобы каждый эпизод отсутствия файла предупреждал ровно раз.
let warnedNoLog = false;

function snapshot(): void {
    const now = Date.now();
    const state: PhaseState = (readJSON(STATE_PATH) as PhaseState) || {};
    // Конфиг профильный (#71) — phases лежат в common, поэтому резолвим тем же кодом,
    // что и раннер, а не читаем сырой JSON. failFn → null: монитор наблюдательный,
    // кривой конфиг для него повод показать «—», а не упасть (упасть должен ralph.js).
    // resolveProfile боевым типом возвращает unknown (конфиг недоверенный) — сужаем к
    // ResolvedConfig здесь; поля всё равно читаются мягко (Array.isArray/typeof по месту).
    const config = resolveProfile(readJSON(CONFIG_PATH), PROFILE, () => null) as ResolvedConfig;
    // Одно чтение лога на тик — источник правды и для панели, и для детекта. readLogTail
    // отдаёт весь хвост (n=null — явный контракт «весь файл») и ОДИН mtime: от него и
    // признак жизни (alive), и детект тишины, и последние значимые строки. Детект смотрит
    // сырой хвост (маркеры ✓/✗/🚦 в SIGNAL_RE не попадают), панель — только значимые
    // (signalTail). Сам пуш о тишине и дедуп — #149; здесь только детект и его показ.
    // #386: путь лога — по профилю резолвнутого конфига, а не жёстко ralph.log: не-боевой
    // прогон (playground) пишет в ralph.dry.log, и панель обязана читать именно его.
    const { lines: allLogLines, lastMtime } = readLogTail(null, monitorLogPath(config));
    const lines = signalTail(allLogLines, 8);
    const deadman = evalDeadman({
        now,
        lastMtime,
        lines: allLogLines.slice(-200),
        config,
    });
    // reason:'no-log' сам по себе НЕ алертит (silent:false): если ralph.log пропал
    // (чистка, ротация, снесённый worktree — а раннер при этом мёртв), детект навсегда
    // возвращал бы silent:false и watchdog молча обезоружен в состоянии, которое сам
    // должен ловить. Fail-safe-доставка — фаза 2; здесь минимум, как у null-конфига в
    // maybePushDeadman: раз на эпизод отсутствия файла предупредить в свой stdout
    // (monitor.out). Флаг сбрасывается, когда лог снова находится.
    if (deadman.reason === 'no-log') {
        if (!warnedNoLog) {
            console.log(
                '⚠ Ralph deadman: ralph.log не найден — watchdog не может судить о тишине (проверь путь/worktree/ротацию).',
            );
            warnedNoLog = true;
        }
    } else {
        warnedNoLog = false;
    }
    const ms = currentMilestone(state, config);
    const milestoneName = ms?.phase?.milestone || state?.milestone || '—';
    // Пуш о тишине (#149): только доставка события, цикл раннера монитор не трогает —
    // он вообще не властен над ним, у монитора нет доступа к процессу сессии/loop.
    lastDeadmanPushMtime = maybePushDeadman(deadman, lastMtime, lastDeadmanPushMtime, {
        cfg: config,
        milestoneName,
    });
    const prog = issuesProgress(milestoneName);
    const prs = openPhasePRs(config, state);
    const head = sh('git rev-parse --short HEAD');
    const branch = sh('git rev-parse --abbrev-ref HEAD');

    const alive =
        lastMtime != null && now - lastMtime < INTERVAL_SEC * 1000 * 3
            ? `🟢 активен (лог ${fmtAge(now - lastMtime)})`
            : lastMtime != null
              ? `🟡 тихо (лог ${fmtAge(now - lastMtime)})`
              : '⚪ лог не найден';

    const bar = '═'.repeat(64);
    const out: string[] = [];
    out.push('');
    out.push(`╔${bar}╗`);
    out.push(`  RALPH MONITOR   ${new Date(now).toLocaleString('ru-RU')}`);
    out.push(`  ${alive}`);
    if (deadman.activity === 'stopped') {
        // Штатная остановка петли: порог +∞, тишина сюда не применяется. Отдельная
        // строка, а не «порог Infinityм» — раннер вышел из loop корректно, не завис.
        out.push(
            // fmtAge уже включает «назад» — своё «назад» в шаблоне не дублируем.
            `  ⏹  петля штатно остановлена (лог ${fmtAge(deadman.silenceMs ?? 0)}) — watchdog не считает это тишиной`,
        );
    } else if (deadman.reason !== 'no-log') {
        out.push(
            deadman.silent
                ? // «молчит N» — длительность (fmtDur), не «N назад» (fmtAge): тишина длится.
                  `  💀 DEADMAN: лог молчит ${fmtDur(deadman.silenceMs ?? 0)} — дольше порога ${fmtDur(deadman.thresholdMs ?? 0)} (режим ${deadman.activity})`
                : `  ⏱  лог ${fmtAge(deadman.silenceMs ?? 0)}, порог тишины ${fmtDur(deadman.thresholdMs ?? 0)} (режим ${deadman.activity})`,
        );
    }
    out.push(`╚${bar}╝`);
    out.push(
        `Фаза: ${milestoneName}` +
            (ms && ms.idx !== -1 ? `  (${ms.idx + 1}/${ms.total})` : '') +
            `   submitted=${state?.submitted ? 'да' : 'нет'}   iter=${state?.count ?? '?'}`,
    );
    out.push(`git: ${branch} @ ${head}`);
    // Профиль и статус доставки пушей. Операционный шов: ручной перезапуск монитора без
    // --profile берёт defaultProfile (playground) — и на prod-хосте deadman-пуши молча не
    // доставляются (pushEvent шлёт только в prod). Именно ручной рестарт после смерти
    // монитора — аварийный сценарий, где watchdog нужнее всего, поэтому статус доставки
    // виден в панели, а не молча выключен. null-конфиг → доставки тоже нет (см. maybePush).
    const deliveryOn = !!config && config.profileName === 'prod';
    out.push(
        `профиль: ${config?.profileName || '—'}   доставка пушей: ${deliveryOn ? 'вкл' : 'выкл (только prod)'}`,
    );

    if (prog) {
        const pct = prog.total ? Math.round((prog.closed / prog.total) * 100) : 0;
        const filled = Math.round((pct / 100) * 20);
        const gauge = '█'.repeat(filled) + '░'.repeat(20 - filled);
        out.push(
            `Issues: [${gauge}] ${prog.closed}/${prog.total} закрыто (${pct}%)  открыто: ${prog.open}`,
        );
    } else {
        out.push('Issues: (нет данных gh по milestone)');
    }

    if ('error' in prs && prs.error === 'all-done') {
        out.push('Открытые PR фаз: (все фазы завершены)');
    } else if ('error' in prs && prs.error === 'gh-failed') {
        out.push('Открытые PR фаз: (сбой gh — статус PR фазы неизвестен)');
    } else if ('error' in prs && prs.error === 'no-branch') {
        out.push('Открытые PR фаз: (не удалось определить ветку фазы из конфига)');
    } else if (Array.isArray(prs) && prs.length) {
        out.push('Открытые PR фаз:');
        for (const pr of prs) {
            out.push(
                `  #${pr.number} ${pr.headRefName}  merge=${pr.mergeStateStatus || '?'}  review=${pr.reviewDecision || '—'}`,
            );
            out.push(`     ${pr.title}`);
        }
    } else {
        out.push('Открытые PR фаз: нет');
    }

    out.push('Лог (последние события):');
    if (lines.length) {
        for (const l of lines) out.push(`  ${l.slice(0, 160)}`);
    } else {
        out.push('  (пусто)');
    }
    out.push('');
    console.log(out.join('\n'));
}

// Точка входа панели — зовётся тонким entry monitor.js (require(esm) → main()). Здесь
// НЕ запускается сама: импорт из теста (monitor-panel.test.mts) выполняет только
// объявления, без gh-запросов и setInterval.
export function main(): void {
    snapshot();
    if (ONCE) return;
    console.log(`⏱  Обновление каждые ${INTERVAL_SEC}с. Ctrl+C для выхода.`);
    setInterval(snapshot, INTERVAL_SEC * 1000);
}

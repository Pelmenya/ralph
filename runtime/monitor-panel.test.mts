// Юнит-тесты логики панели монитора (monitor-panel.mts, #148/#149; перенесён на TS в #404).
//
// Монитор — сторож петли: detached, переживает смерть раннера (kill -9), знает путь
// лога. Детект тишины = чтение времени последней записи ralph.log СНАРУЖИ процесса
// сессии (runClaude — синхронный spawnSync до 2ч, сам heartbeat писать не может) и
// сравнение возраста с порогом режима из deadman.ts (#147).
//
// evalDeadman — чистая функция (все входы аргументами, «сейчас» приходит извне),
// поэтому тестируется без файлов, без сети и БЕЗ живого раннера: именно эта
// файло-ориентированность и делает детект живучим при мёртвом раннере — он смотрит на
// файл, а не на процесс. readLogTail проверяем на реальном временном файле.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import {
    evalDeadman,
    readLogTail,
    readHeartbeat,
    withHeartbeat,
    shouldPushDeadman,
    deadmanPushMessage,
    dailyMetricLine,
    maybePushDailyMetric,
    maybePushDeadman,
    metricDayKey,
    monitorLogPath,
    openPhasePRs,
    issuesProgress,
    panelTaskSource,
    resolveRuntimeDir,
    resolveExecutionRoot,
    gitLine,
    type PanelTaskSource,
} from './monitor-panel.mts';
import type { Issue, PullRequest } from '../adapters/adapters.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов.
import { pushEvent as pushEventReal } from '../ralph.js';
import { DEFAULT_DEADMAN } from './deadman.ts';
import { encodeHeartbeat, writeHeartbeat } from '../core/event-journal.ts';
import { logLine as t, makeTmpLog } from '../tests/test-helpers.ts';

// Резолвнутый конфиг (как отдаёт resolveProfile раннеру/монитору): пороги на верхнем
// уровне. coder = claudeTimeoutMs + iterationGraceMs = 7.8M; gate = 600k; default = 300k.
const CFG = {
    claudeTimeoutMs: 7200000,
    deadman: {
        iterationGraceMs: 600000,
        gateSilenceMs: 600000,
        defaultSilenceMs: 300000,
    },
};
const MIN = 60000;

describe('evalDeadman — тишина как возраст последней записи лога против порога режима', () => {
    it('хозяйственный шаг молчит дольше короткого дефолта → тишина', () => {
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 6 * MIN, // 6 мин тишины > default 5 мин
            lines: [t('🌳 Worktree раннера переведён на свежий origin/main.')],
            config: CFG,
        });
        expect(r.silent).toBe(true);
        expect(r.activity).toBe('default');
        expect(r.thresholdMs).toBe(300000);
        expect(r.silenceMs).toBe(6 * MIN);
    });

    it('хозяйственный шаг молчит меньше дефолта → не тишина', () => {
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 4 * MIN, // 4 мин < 5 мин
            lines: [t('📦 npm ci перед чеками...')],
            config: CFG,
        });
        expect(r.silent).toBe(false);
        expect(r.activity).toBe('default');
    });

    it('гейт молчит дольше порога гейта → тишина', () => {
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 11 * MIN, // 11 мин > gate 10 мин
            lines: [t('🚦 Гейт мерджа: ...'), t('  ✓ build')],
            config: CFG,
        });
        expect(r.silent).toBe(true);
        expect(r.activity).toBe('gate');
    });

    it('гейт в пределах порога → не тишина', () => {
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 9 * MIN, // 9 мин < 10 мин
            lines: [t('  ✗ test — красный')],
            config: CFG,
        });
        expect(r.silent).toBe(false);
        expect(r.activity).toBe('gate');
    });

    it('легитимно долгая кодер-сессия (30 мин молчания) → НЕ тишина (нет ложного пуша)', () => {
        // Ключевой приёмочный сценарий PRD: кодер-сессия молчит до claudeTimeoutMs (2ч).
        // 30 мин ≪ порог coder (2ч + запас) — ложного deadman быть не должно.
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 30 * MIN,
            lines: [t('▶ claude -p "…" --max-turns 200 --model claude-opus-4-8')],
            config: CFG,
        });
        expect(r.silent).toBe(false);
        expect(r.activity).toBe('coder');
        expect(r.thresholdMs).toBe(7800000);
    });

    it('кодер-сессия молчит дольше claudeTimeoutMs + запас → тишина (зависла)', () => {
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 131 * MIN, // 2ч11м > 2ч10м порог coder
            lines: [t('🔄 Фаза X | итерация 1/10 | Issue #1')],
            config: CFG,
        });
        expect(r.silent).toBe(true);
        expect(r.activity).toBe('coder');
    });

    it('штатная остановка петли (⏸ прод-стоп) → режим stopped, порог +∞, НЕ тишина', () => {
        // Раннер вышел из loop, лог заморожен корректно на 3ч — это не зависший шаг.
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 180 * MIN, // 3ч ≫ любого рабочего порога
            lines: [t('⏸ Ralph: фаза "X" — loop остановлен перед деплоем (prod).')],
            config: CFG,
        });
        expect(r.silent).toBe(false);
        expect(r.activity).toBe('stopped');
        expect(r.thresholdMs).toBe(Infinity);
    });

    it('лог не найден (lastMtime = null) → не тишина, повод — no-log (а не ложный алерт)', () => {
        const r = evalDeadman({ now: 1000 * MIN, lastMtime: null, lines: [], config: CFG });
        expect(r.silent).toBe(false);
        expect(r.reason).toBe('no-log');
    });

    it('config = null (кривой конфиг: resolveProfile с failFn → null) → не падает, дефолтные пороги', () => {
        // Единственный вход, который монитор гарантированно подаёт в бою при сломанном
        // конфиге: snapshot() зовёт evalDeadman с config = resolveProfile(..., () => null).
        // Контракт — не бросить и взять DEFAULT_DEADMAN, а не остаться без детекта.
        const r = evalDeadman({
            now: 1000 * MIN,
            lastMtime: 1000 * MIN - 6 * MIN, // 6 мин тишины > дефолтный default 5 мин
            lines: [t('🌳 Worktree раннера переведён на свежий origin/main.')],
            config: null,
        });
        expect(r.silent).toBe(true);
        expect(r.activity).toBe('default');
        expect(r.thresholdMs).toBe(DEFAULT_DEADMAN.defaultSilenceMs);
    });

    it('детект не зависит от процесса раннера: только числа и хвост лога на входе', () => {
        // Симуляция мёртвого раннера (kill -9): лог «замёрз» на старом mtime, монитор
        // жив и считает по файлу. Никаких обращений к процессу — чистая функция.
        const frozenAt = 500 * MIN;
        const r = evalDeadman({
            now: frozenAt + 20 * MIN, // раннер мёртв 20 мин, был на хоз-шаге
            lastMtime: frozenAt,
            lines: [t('🔀 Переключение на ветку feature/ralph-deadman')],
            config: CFG,
        });
        expect(r.silent).toBe(true);
        expect(r.activity).toBe('default');
    });
});

describe('readLogTail — сырой хвост лога + время последней записи', () => {
    // Общая фабрика временного лога (test-helpers.ts) — приватный tmp-каталог + cleanup
    // в одном месте на все тесты deadman/monitor. mkTmp принимает готовый контент-строку.
    const { writeLog: mkTmp, cleanupFiles, removeDir } = makeTmpLog('ralph-monitor-test-');
    afterEach(cleanupFiles);
    afterAll(removeDir);

    it('возвращает сырые строки (включая ✓/✗/🚦, которых нет в SIGNAL_RE) и mtime', () => {
        // deadman классифицирует по ✓/✗/🚦 — фильтр SIGNAL_RE их теряет, поэтому детект
        // обязан читать сырой хвост, а не отфильтрованные значимые строки.
        const p = mkTmp(
            [t('🚦 Гейт мерджа: ...'), t('  ✓ build'), t('  ✗ test — красный')].join('\n'),
        );
        const { lines, lastMtime } = readLogTail(200, p);
        expect(lines.some((l) => /✓/.test(l))).toBe(true);
        expect(lines.some((l) => /✗/.test(l))).toBe(true);
        expect(typeof lastMtime).toBe('number');
    });

    it('отдаёт последние n строк', () => {
        const p = mkTmp(Array.from({ length: 50 }, (_, i) => t(`строка ${i}`)).join('\n'));
        const { lines } = readLogTail(5, p);
        expect(lines).toHaveLength(5);
        expect(lines[4]).toContain('строка 49');
    });

    it('нет файла → пустой хвост и lastMtime = null (fail-safe, не падение)', () => {
        const { lines, lastMtime } = readLogTail(
            200,
            path.join(os.tmpdir(), 'нет-такого-лога.log'),
        );
        expect(lines).toEqual([]);
        expect(lastMtime).toBeNull();
    });
});

// #386: панель обязана читать РОВНО тот лог, в который пишет наблюдаемый прогон — иначе о
// жизни боевой петли судила бы по протухшему ralph.dry.log (и наоборот). monitorLogPath —
// та же развилка chooseLogPath, что у раннера, по резолвнутому профилю (dry монитор не
// спавнится, поэтому решает один профиль).
describe('monitorLogPath — панель читает лог наблюдаемого прогона (#386)', () => {
    it('профиль prod → боевой ralph.log', () => {
        expect(monitorLogPath({ profileName: 'prod' })).toMatch(/ralph\.log$/);
        expect(monitorLogPath({ profileName: 'prod' })).not.toMatch(/ralph\.dry\.log$/);
    });

    it('профиль playground → не-боевой ralph.dry.log, не общий боевой', () => {
        expect(monitorLogPath({ profileName: 'playground' })).toMatch(/ralph\.dry\.log$/);
    });

    it('конфиг нечитаем (null) → консервативно не-боевой лог, не боевой ralph.log', () => {
        expect(monitorLogPath(null)).toMatch(/ralph\.dry\.log$/);
    });
});

// Пуш о тишине без остановки цикла + дедуп повторных пушей об одном эпизоде (#149).
// Действие при срабатывании — только pushEvent() (см. docs/ralph-reliability/plan.md,
// фаза 1, п. «Действие при срабатывании»): раннер продолжает идти, монитор к тому же
// не властен над его процессом — детект живёт снаружи и не может его остановить, даже
// если бы захотел.
describe('shouldPushDeadman — эпизод тишины по ключу lastMtime (#149)', () => {
    it('не тихо → пуш не нужен независимо от ключа дедупа', () => {
        expect(shouldPushDeadman({ silent: false }, 100, null)).toBe(false);
        expect(shouldPushDeadman({ silent: false }, 100, 999)).toBe(false);
    });

    it('тихо и ключ ещё не пушился (новый эпизод) → пуш нужен', () => {
        expect(shouldPushDeadman({ silent: true }, 100, null)).toBe(true);
        expect(shouldPushDeadman({ silent: true }, 100, 50)).toBe(true);
    });

    it('тихо, но за этот lastMtime уже пушили (тот же эпизод) → повторный пуш не нужен', () => {
        expect(shouldPushDeadman({ silent: true }, 100, 100)).toBe(false);
    });
});

describe('deadmanPushMessage — текст пуша', () => {
    it('содержит фазу, длительность/порог/режим тишины и явное «цикл сам себя не остановил»', () => {
        const msg = deadmanPushMessage(
            { silenceMs: 11 * 60000, thresholdMs: 10 * 60000, activity: 'gate' },
            'Наблюдаемость ralph · Фаза 1',
        );
        expect(msg).toContain('Наблюдаемость ralph · Фаза 1');
        expect(msg).toContain('DEADMAN');
        expect(msg).toContain('режим gate');
        // Ревью #289: прежний хвост «Цикл продолжается без остановки» снят как дословный
        // повтор вопроса человеку — тот же смысл остался в структурной половине строки.
        expect(msg).toMatch(/цикл сам себя не остановил/i);
    });

    // #289: та же структура (причина/диагноз/вопрос), что у стопа «PR оставлен человеку» —
    // ночная вахта не должна держать в голове два разных формата сообщений.
    it('несёт причину "deadman", диагноз (фаза/тишина/порог) и вопрос человеку', () => {
        const msg = deadmanPushMessage(
            { silenceMs: 11 * 60000, thresholdMs: 10 * 60000, activity: 'gate' },
            'Наблюдаемость ralph · Фаза 1',
        );
        expect(msg).toContain('deadman');
        expect(msg).toContain('диагноз:');
        expect(msg).toContain('вопрос человеку:');
        expect(msg).toMatch(/жив ли процесс раннера/);
    });
});

describe('maybePushDeadman — доставка через pushEvent() + дедуп по эпизоду (#149)', () => {
    // activity как const: maybePushDeadman теперь ждёт Activity | null, а не широкий string
    // (#403-review) — у отдельного const'а без as const поле вывелось бы в string.
    const deadman = {
        silent: true,
        silenceMs: 700000,
        thresholdMs: 600000,
        activity: 'gate' as const,
    };
    const notSilent = {
        silent: false,
        silenceMs: 100,
        thresholdMs: 600000,
        activity: 'gate' as const,
    };

    it('тихо, prod, доставка удалась (pushFn→true) → пуш ОДИН раз, ключ дедупа встал на lastMtime', () => {
        const pushFn = vi.fn((_msg: string, _cfg: unknown, _opts: unknown) => true);
        const cfg = { profileName: 'prod' };
        const next = maybePushDeadman(deadman, 12345, null, {
            pushFn,
            cfg,
            milestoneName: 'Фаза 1',
        });
        expect(pushFn).toHaveBeenCalledTimes(1);
        expect(pushFn.mock.calls[0][0]).toContain('Фаза 1');
        expect(pushFn.mock.calls[0][1]).toBe(cfg);
        expect(next).toBe(12345);
    });

    it('prod, доставка НЕ удалась (pushFn→false) → ключ дедупа НЕ встаёт, следующий тик повторит', () => {
        // Самый дорогой сценарий watchdog: единственный алерт о мёртвом ночном раннере не
        // должен пропасть из-за временного сбоя curl/сети/Telegram. Ключ не сдвигаем —
        // shouldPushDeadman на следующем тике той же тишины снова разрешит пуш.
        const pushFn = vi.fn((_msg: string, _cfg: unknown, _opts: unknown) => false);
        const cfg = { profileName: 'prod' };
        const next = maybePushDeadman(deadman, 12345, null, {
            pushFn,
            cfg,
            milestoneName: 'Фаза 1',
        });
        expect(pushFn).toHaveBeenCalledTimes(1);
        expect(next).toBeNull(); // ключ не защёлкнут (был null) → ретрай
        // повторный тик той же тишины действительно снова пушит
        const again = maybePushDeadman(deadman, 12345, next, {
            pushFn,
            cfg,
            milestoneName: 'Фаза 1',
        });
        expect(pushFn).toHaveBeenCalledTimes(2);
        expect(again).toBeNull();
    });

    it('non-prod, pushFn→false (подавлено профилем) → ключ ВСТАЁТ: наивный ретрай не спамит', () => {
        // В non-prod false = штатное подавление, доставки нет и не будет — защёлкиваем,
        // иначе маркер 🔔 печатался бы в monitor.out каждый тик.
        const pushFn = vi.fn((_msg: string, _cfg: unknown, _opts: unknown) => false);
        const next = maybePushDeadman(deadman, 12345, null, {
            pushFn,
            cfg: { profileName: 'playground' },
            milestoneName: 'Фаза 1',
        });
        expect(next).toBe(12345);
    });

    it('null-конфиг (деадман обезоружен в prod) → раз на эпизод предупреждает в stdout + защёлкивает', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const pushFn = vi.fn((_msg: string, _cfg: unknown, _opts: unknown) => false);
            const next = maybePushDeadman(deadman, 12345, null, {
                pushFn,
                cfg: null,
                milestoneName: 'Фаза 1',
            });
            expect(spy.mock.calls.some((c) => /конфиг не резолвится/.test(String(c[0])))).toBe(
                true,
            );
            expect(next).toBe(12345); // защёлкнут → предупреждение не спамится каждый тик
        } finally {
            spy.mockRestore();
        }
    });

    it('повторный вызов с тем же lastMtime (та же тишина) — pushFn второй раз не зовётся', () => {
        const pushFn = vi.fn();
        const first = maybePushDeadman(deadman, 12345, null, {
            pushFn,
            cfg: {},
            milestoneName: 'Фаза 1',
        });
        const second = maybePushDeadman(deadman, 12345, first, {
            pushFn,
            cfg: {},
            milestoneName: 'Фаза 1',
        });
        expect(pushFn).toHaveBeenCalledTimes(1);
        expect(second).toBe(12345);
    });

    it('лог ожил и снова замолчал (новый lastMtime) — второй, уже другой эпизод пушится', () => {
        const pushFn = vi.fn();
        const first = maybePushDeadman(deadman, 12345, null, {
            pushFn,
            cfg: {},
            milestoneName: 'Фаза 1',
        });
        const second = maybePushDeadman(deadman, 99999, first, {
            pushFn,
            cfg: {},
            milestoneName: 'Фаза 1',
        });
        expect(pushFn).toHaveBeenCalledTimes(2);
        expect(second).toBe(99999);
    });

    it('не тихо — pushFn не зовётся, ключ дедупа не меняется', () => {
        const pushFn = vi.fn();
        // Ключ-сентинел числом (тип дедупа — number | null): при notSilent он возвращается
        // без изменений, что и проверяем.
        const next = maybePushDeadman(notSilent, 12345, 55555, {
            pushFn,
            cfg: {},
            milestoneName: 'Фаза 1',
        });
        expect(pushFn).not.toHaveBeenCalled();
        expect(next).toBe(55555);
    });

    it('logFn пуша печатает в свой stdout (console.log), а НЕ в log() раннера — иначе пуш обновил бы mtime ralph.log и замаскировал бы собственную тишину', () => {
        const pushFn = vi.fn();
        maybePushDeadman(deadman, 1, null, { pushFn, cfg: {}, milestoneName: 'Фаза 1' });
        expect(pushFn.mock.calls[0][2].logFn).toBe(console.log);
    });

    it('интеграция с реальным pushEvent() (не мок pushFn): маркер 🔔 PUSH уходит в logFn без обращения к сети', () => {
        // profileName !== 'prod' — pushEvent возвращает false ДО вызова sendFn (сети),
        // но маркер печатает всегда (см. комментарий в ralph.js у pushEvent) — этим и
        // проверяем реальную доставку через pushEvent(), а не через мок его вызова.
        const logSpy = vi.fn();
        maybePushDeadman(deadman, 1, null, {
            cfg: { profileName: 'playground' },
            milestoneName: 'Фаза 1',
            pushFn: (msg, cfg, opts) => pushEventReal(msg, cfg, { ...opts, logFn: logSpy }),
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toContain('🔔 PUSH');
        expect(logSpy.mock.calls[0][0]).toContain('DEADMAN');
    });
});

// #58: панель спрашивает трекер через шов. Фейк шва — объект с ДВУМЯ методами
// (PanelTaskSource): тип не даст подсунуть панели ничего пишущего.
function fakeSource(over: Partial<PanelTaskSource> = {}): PanelTaskSource {
    return {
        listAllOpenIssues: vi.fn((_m: string): Issue[] => []),
        findOpenPullRequest: vi.fn((_b: string): PullRequest | null => null),
        ...over,
    };
}

describe('openPhasePRs — PR текущей фазы через шов по ветке из конфига (#214, #58)', () => {
    const config = {
        phases: [
            { milestone: 'Фаза 1', branch: 'feature/phase-1' },
            { milestone: 'Фаза 2', branch: 'feature/ralph-post-merge' },
        ],
    };

    it('спрашивает шов ровно о ветке фазы из конфига и отдаёт найденный PR', () => {
        const pr = { number: 123, labels: [{ name: 'blocked' }] };
        const findOpenPullRequest = vi.fn((_b: string) => pr);
        const result = openPhasePRs(
            config,
            { milestone: 'Фаза 2' },
            fakeSource({ findOpenPullRequest }),
        );
        expect(result).toEqual([pr]);
        expect(findOpenPullRequest).toHaveBeenCalledWith('feature/ralph-post-merge');
    });

    it('шов ответил null — «открытого PR нет», а не сбой', () => {
        const result = openPhasePRs(config, { milestone: 'Фаза 1' }, fakeSource());
        expect(result).toEqual([]);
    });

    it('шов бросил — SeamFailure с причиной, а не молчаливое «нет PR»', () => {
        const source = fakeSource({
            findOpenPullRequest: () => {
                throw new Error('HTTP 503 от площадки\nстек…');
            },
        });
        const result = openPhasePRs(config, { milestone: 'Фаза 1' }, source);
        expect(result).toEqual({ error: 'seam-failed', reason: 'HTTP 503 от площадки' });
    });

    it('шов не собран — его отказ доходит до строки PR, шов не зовётся', () => {
        const failure = { error: 'seam-failed' as const, reason: 'конфиг петли не прочитался' };
        expect(openPhasePRs(config, { milestone: 'Фаза 1' }, failure)).toBe(failure);
    });

    it('фаза не найдена в конфиге → { error: "no-branch" }, шов не спрашивается', () => {
        const source = fakeSource();
        const result = openPhasePRs(
            { phases: [{ milestone: 'Другая Фаза', branch: 'feature/other' }] },
            { milestone: 'Фаза 1' },
            source,
        );
        expect(result).toEqual({ error: 'no-branch' });
        expect(source.findOpenPullRequest).not.toHaveBeenCalled();
    });

    it('phases не массив → { error: "no-branch" }', () => {
        // Каст: тип ResolvedConfig.phases — PhaseConfig[] (#403-review), но проверяем
        // именно рантайм-ветку Array.isArray — phases: null мимо типа, ради fail-closed.
        const bad = { phases: null } as unknown as Parameters<typeof openPhasePRs>[0];
        const source = fakeSource();
        expect(openPhasePRs(bad, { milestone: 'Фаза 1' }, source)).toEqual({ error: 'no-branch' });
        expect(source.findOpenPullRequest).not.toHaveBeenCalled();
    });

    it('config null → { error: "no-branch" }', () => {
        const source = fakeSource();
        expect(openPhasePRs(null, { milestone: 'Фаза 1' }, source)).toEqual({ error: 'no-branch' });
        expect(source.findOpenPullRequest).not.toHaveBeenCalled();
    });

    it('#THS8M: milestone === null (все фазы сданы) → { error: "all-done" }, не no-branch', () => {
        const source = fakeSource();
        expect(openPhasePRs(config, { milestone: null }, source)).toEqual({ error: 'all-done' });
        expect(source.findOpenPullRequest).not.toHaveBeenCalled();
    });

    it('не падает когда state пустой', () => {
        expect(openPhasePRs(config, {}, fakeSource())).toEqual({ error: 'no-branch' });
    });
});

describe('issuesProgress — сколько задач фазы осталось, через шов (#58)', () => {
    it('считает открытые карточки вехи и выделяет blocked', () => {
        const listAllOpenIssues = vi.fn((_m: string): Issue[] => [
            { number: 1, title: 'a' },
            { number: 2, title: 'b', labels: [{ name: 'blocked' }] },
            { number: 3, title: 'c', labels: [{ name: 'complexity:low' }] },
        ]);
        const result = issuesProgress('Фаза 1', fakeSource({ listAllOpenIssues }));
        expect(result).toEqual({ open: 3, blocked: 1 });
        expect(listAllOpenIssues).toHaveBeenCalledWith('Фаза 1');
    });

    it('пустая веха — честный ноль, а не сбой', () => {
        expect(issuesProgress('Фаза 1', fakeSource())).toEqual({ open: 0, blocked: 0 });
    });

    it('шов бросил — SeamFailure с причиной, отличимый от нуля', () => {
        const source = fakeSource({
            listAllOpenIssues: () => {
                throw new Error('токен площадки отвергнут');
            },
        });
        expect(issuesProgress('Фаза 1', source)).toEqual({
            error: 'seam-failed',
            reason: 'токен площадки отвергнут',
        });
    });

    it('шов вернул не список — сбой, а не «0 открыто»', () => {
        const source = fakeSource({ listAllOpenIssues: () => null as unknown as Issue[] });
        expect(issuesProgress('Фаза 1', source)).toMatchObject({ error: 'seam-failed' });
    });

    it('фаза не определена — шов не спрашивается', () => {
        const source = fakeSource();
        expect(issuesProgress(null, source)).toEqual({ error: 'no-milestone' });
        expect(source.listAllOpenIssues).not.toHaveBeenCalled();
    });
});

describe('panelTaskSource — шов панели из того же config.adapters, что у петли (#58)', () => {
    it('выбор реализации уходит сборщику из config.adapters', () => {
        const built = fakeSource();
        const buildFn = vi.fn((_a: unknown, _f: (m: string) => never) => built as never);
        const result = panelTaskSource(
            { adapters: { taskSource: 'sourcecraft' } },
            buildFn as never,
        );
        expect(result).toBe(built);
        expect(buildFn.mock.calls[0][0]).toEqual({ taskSource: 'sourcecraft' });
    });

    it('тот же выбор — шов из кеша (кеш резолва вех не теряется); другой — сборка заново', () => {
        const buildFn = vi.fn((_a: unknown, _f: (m: string) => never) => fakeSource() as never);
        const first = panelTaskSource(
            { adapters: { taskSource: 'sourcecraft' } },
            buildFn as never,
        );
        const again = panelTaskSource(
            { adapters: { taskSource: 'sourcecraft' } },
            buildFn as never,
        );
        expect(again).toBe(first);
        expect(buildFn).toHaveBeenCalledTimes(1);
        panelTaskSource({ adapters: { taskSource: 'github' } }, buildFn as never);
        expect(buildFn).toHaveBeenCalledTimes(2);
    });

    it('конфиг не прочитался — отказ строкой, сборщик не зовётся', () => {
        const buildFn = vi.fn();
        expect(panelTaskSource(null, buildFn as never)).toMatchObject({ error: 'seam-failed' });
        expect(buildFn).not.toHaveBeenCalled();
    });

    it('отказ выбора — строка панели, а не exit процесса: failFn бросает', () => {
        const buildFn = (_a: unknown, failFn: (m: string) => never) =>
            failFn("adapters.taskSource: реализация 'nope' не зарегистрирована.");
        expect(panelTaskSource({ adapters: { taskSource: 'nope' } }, buildFn as never)).toEqual({
            error: 'seam-failed',
            reason: "adapters.taskSource: реализация 'nope' не зарегистрирована.",
        });
    });
});

describe('--runtime-dir: панель смотрит в каталог состояния экземпляра (канон, задача 22)', () => {
    // Флаг разбирается при загрузке модуля, поэтому проба — через свежий импорт с
    // подменённым argv. Проверять его иначе нечем, а без проверки он немой: панель,
    // читающая не тот каталог, НЕ падает — она показывает «раннер молчит» при живом
    // прогоне, то есть врёт ровно в ту сторону, ради которой её и смотрят.
    const ARGV = process.argv;
    afterEach(() => {
        process.argv = ARGV;
        vi.resetModules();
    });

    it('с флагом лог берётся из указанного каталога, а не рядом с ядром', async () => {
        process.argv = [...ARGV.slice(0, 2), '--runtime-dir', '/path/to/state/prod-abc'];
        vi.resetModules();
        const fresh = await import('./monitor-panel.mts');
        expect(fresh.monitorLogPath({ profileName: 'prod' } as never)).toBe(
            path.join('/path/to/state/prod-abc', 'ralph.log'),
        );
        expect(fresh.monitorLogPath({ profileName: 'playground' } as never)).toBe(
            path.join('/path/to/state/prod-abc', 'ralph.dry.log'),
        );
    });

    it('без флага — прежняя раскладка: файлы рядом с ядром', async () => {
        process.argv = [...ARGV.slice(0, 2)];
        vi.resetModules();
        const fresh = await import('./monitor-panel.mts');
        expect(fresh.monitorLogPath({ profileName: 'prod' } as never)).toMatch(/ralph\.log$/);
        expect(fresh.monitorLogPath({ profileName: 'prod' } as never)).not.toContain(
            '/path/to/state/',
        );
    });
});

describe('--runtime-dir: разбор флага fail-closed (ревью !19)', () => {
    it('без флага — прежняя раскладка', () => {
        expect(resolveRuntimeDir(['--once'], '/legacy/ralph')).toBe('/legacy/ralph');
    });

    it('значения нет либо следом другой флаг — отказ, а не «--once» в роли пути', () => {
        expect(() => resolveRuntimeDir(['--runtime-dir'], '/legacy')).toThrow(/без значения/);
        expect(() => resolveRuntimeDir(['--runtime-dir', '--once'], '/legacy')).toThrow(
            /без значения/,
        );
    });

    it('относительный путь — отказ: панель стартует из другого каталога, чем раннер', () => {
        expect(() => resolveRuntimeDir(['--runtime-dir', 'state'], '/legacy')).toThrow(
            /относительный/,
        );
    });

    it('флаг дважды — отказ, а не тихий выбор первого', () => {
        expect(() =>
            resolveRuntimeDir(['--runtime-dir', '/a', '--runtime-dir', '/b'], '/legacy'),
        ).toThrow(/дважды/);
    });
});

describe('строка git: дерево работы наблюдаемого экземпляра (#126)', () => {
    // Панель печатала `git:  @ `: каталог репозитория считался подъёмом выше корня ядра,
    // git падал, отказ глотался. Дерево теперь называет раннер, а сбой — своя строка.
    it('флаг раннера важнее roots конфига', () => {
        const cfg = { rootsResolved: { executionRoot: '/path/to/from-config' } };
        expect(resolveExecutionRoot(['--execution-root', '/path/to/work'], cfg)).toEqual({
            dir: '/path/to/work',
            source: 'флаг раннера',
        });
    });

    it('без флага — roots.executionRoot конфига', () => {
        const cfg = { rootsResolved: { executionRoot: '/path/to/from-config' } };
        expect(resolveExecutionRoot(['--once'], cfg)).toEqual({
            dir: '/path/to/from-config',
            source: 'roots конфига',
        });
    });

    it('ни флага, ни roots — отказ словами, а не догадка от каталога модуля', () => {
        for (const cfg of [null, {}, { rootsResolved: null }]) {
            const r = resolveExecutionRoot([], cfg);
            expect(r).toEqual({ error: expect.stringMatching(/не названо/) });
            expect(gitLine(r, () => 'не должен зваться')).toMatch(
                /^git: \(дерево работы не названо/,
            );
        }
    });

    it('кривой флаг — отказ: без значения, относительный, дважды', () => {
        expect(resolveExecutionRoot(['--execution-root'], null)).toEqual({
            error: expect.stringMatching(/без значения/),
        });
        expect(resolveExecutionRoot(['--execution-root', '--once'], null)).toEqual({
            error: expect.stringMatching(/без значения/),
        });
        expect(resolveExecutionRoot(['--execution-root', 'work'], null)).toEqual({
            error: expect.stringMatching(/относительный/),
        });
        expect(
            resolveExecutionRoot(['--execution-root', '/a', '--execution-root', '/b'], null),
        ).toEqual({ error: expect.stringMatching(/дважды/) });
    });

    it('ответ git — ветка, HEAD и чьё это дерево; git зовётся в дереве работы', () => {
        const calls: Array<[string[], string]> = [];
        const line = gitLine({ dir: '/path/to/work', source: 'флаг раннера' }, (args, cwd) => {
            calls.push([args, cwd]);
            return args.includes('--abbrev-ref') ? 'feature/x' : 'abc1234';
        });
        expect(line).toBe('git: feature/x @ abc1234   дерево: /path/to/work (флаг раннера)');
        expect(calls.every(([, cwd]) => cwd === '/path/to/work')).toBe(true);
    });

    it('отказ git отличим от пустого ответа — с причиной первой строкой stderr', () => {
        const failing = () => {
            throw Object.assign(new Error('Command failed'), {
                stderr: 'fatal: not a git repository\nвторая строка',
            });
        };
        expect(gitLine({ dir: '/path/to/work', source: 'флаг раннера' }, failing)).toBe(
            'git: (не прочиталось в /path/to/work: fatal: not a git repository)',
        );
        expect(gitLine({ dir: '/path/to/work', source: 'флаг раннера' }, () => '')).toBe(
            'git: (git ответил пусто в /path/to/work)',
        );
    });

    it('без stderr причина берётся из текста исключения', () => {
        const failing = () => {
            throw new Error('spawnSync git ENOENT');
        };
        expect(gitLine({ dir: '/w', source: 's' }, failing)).toBe(
            'git: (не прочиталось в /w: spawnSync git ENOENT)',
        );
    });

    // Настоящий git на временном репозитории: строка показывает ветку дерева РАБОТЫ, а не
    // установки ядра, из которой исполняется сама панель.
    it('настоящий git: ветка дерева работы, а не дерева ядра', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-panel-git-'));
        try {
            const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
            git('init', '-q', '-b', 'feature/panel-probe');
            git(
                '-c',
                'user.name=t',
                '-c',
                'user.email=t@example.com',
                'commit',
                '-q',
                '--allow-empty',
                '-m',
                'init',
            );
            const line = gitLine(resolveExecutionRoot(['--execution-root', dir], null));
            expect(line).toMatch(/^git: feature\/panel-probe @ [0-9a-f]{4,} {3}дерево: /);
            expect(line).toContain(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('maybePushDailyMetric — суточная строка метрики, fail-open', () => {
    const DAY1 = Date.parse('2026-10-26T23:58:00.000Z');
    const DAY2 = Date.parse('2026-10-27T00:03:00.000Z');
    const cfg = { profileName: 'prod' };
    const line = () => '📈 строка';

    it('старт панели — ключ встаёт на сегодня без пуша: рестарт петли не шлёт строку', () => {
        const pushFn = vi.fn(() => true);
        expect(maybePushDailyMetric(DAY1, null, { pushFn, cfg, computeLine: line })).toBe(
            '2026-10-26',
        );
        expect(pushFn).not.toHaveBeenCalled();
    });

    it('тот же день — без пуша', () => {
        const pushFn = vi.fn(() => true);
        maybePushDailyMetric(DAY1, '2026-10-26', { pushFn, cfg, computeLine: line });
        expect(pushFn).not.toHaveBeenCalled();
    });

    it('первый тик новых суток — ровно один пуш строки за прошедшие сутки', () => {
        const pushFn = vi.fn((_m: string, _c: unknown, _o: unknown) => true);
        const computeLine = vi.fn(line);
        let key = maybePushDailyMetric(DAY2, '2026-10-26', { pushFn, cfg, computeLine });
        key = maybePushDailyMetric(DAY2 + 300_000, key, { pushFn, cfg, computeLine });
        expect(key).toBe('2026-10-27');
        // Окно — до полуночи UTC, а не до момента тика: окна соседних дней стыкуются ровно.
        expect(computeLine).toHaveBeenCalledWith(Date.parse('2026-10-27T00:00:00.000Z'));
        expect(pushFn).toHaveBeenCalledTimes(1);
        expect(pushFn.mock.calls[0][0]).toBe('📈 строка');
        expect(pushFn.mock.calls[0][1]).toBe(cfg);
        expect(pushFn.mock.calls[0][2]).toMatchObject({ dry: false });
    });

    it('расчёт упал — человеку уходит причина, панель не падает', () => {
        const pushFn = vi.fn((_m: string, _c: unknown, _o: unknown) => true);
        const key = maybePushDailyMetric(DAY2, '2026-10-26', {
            pushFn,
            cfg,
            computeLine: () => {
                throw new Error('бюджет задачи не задан');
            },
        });
        expect(key).toBe('2026-10-27');
        expect(pushFn.mock.calls[0][0]).toBe(
            '📈 Метрика за сутки не посчитана: бюджет задачи не задан',
        );
    });

    it('доставка бросила — не ломает тик, ключ сдвинут (пульс, не алерт)', () => {
        const logFn = vi.fn();
        const key = maybePushDailyMetric(DAY2, '2026-10-26', {
            pushFn: () => {
                throw new Error('нотифаер сломан');
            },
            cfg,
            computeLine: line,
            logFn,
        });
        expect(key).toBe('2026-10-27');
        expect(logFn).toHaveBeenCalledWith(expect.stringContaining('нотифаер сломан'));
    });

    it('доставка вернула false (fail-open нотифаера) — повтора в те же сутки нет', () => {
        const pushFn = vi.fn(() => false);
        let key = maybePushDailyMetric(DAY2, '2026-10-26', { pushFn, cfg, computeLine: line });
        key = maybePushDailyMetric(DAY2 + 300_000, key, { pushFn, cfg, computeLine: line });
        expect(pushFn).toHaveBeenCalledTimes(1);
    });

    it('сутки — по UTC', () => {
        expect(metricDayKey(Date.parse('2026-10-26T23:59:59.999Z'))).toBe('2026-10-26');
        expect(metricDayKey(Date.parse('2026-10-27T00:00:00.000Z'))).toBe('2026-10-27');
    });
});

describe('dailyMetricLine — проводка суточной строки панели', () => {
    const DIR = '/path/to/state';
    const UNTIL = Date.parse('2026-10-27T00:00:00.000Z');
    const LOG = [
        '[2026-10-25T23:00:00.000Z] 🔄 Ф0 | итерация 1/10 | Issue #9: вне окна | модель: m (claude)',
        '[2026-10-26T10:00:00.000Z] 🔄 Ф | итерация 1/10 | Issue #1: x | модель: m (claude)',
        '[2026-10-26T10:05:00.000Z] ⛔ Гейт: чек test красный на PR #5.',
        '[2026-10-26T10:20:00.000Z] 🔔 PUSH: ✅ Ralph: фаза "Ф" смерджена в main — готова к релизу.',
    ].join('\n');
    const files: Record<string, string> = { [`${DIR}/ralph.log`]: LOG };
    const readFn = (p: string) => {
        if (p in files) return files[p];
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    };

    it('считает по ralph.log наблюдаемого каталога за 24 ч до полуночи', () => {
        const line = dailyMetricLine({ metrics: { taskBudgetMin: 30 } }, DIR, readFn)(UNTIL);
        expect(line).toBe(
            '📈 Метрика за 24 ч до 2026-10-27T00:00Z: в бюджет 1 из 1 (100 %), пойманных отказов 1, остановок петли 0.',
        );
    });

    it('не тот каталог — отказ «лог не читается», а не пустая строка', () => {
        expect(() =>
            dailyMetricLine({ metrics: { taskBudgetMin: 30 } }, '/elsewhere', readFn)(UNTIL),
        ).toThrow('не читается');
    });

    it('конфиг не прочитался — причина про конфиг, а не про ключ бюджета', () => {
        expect(() => dailyMetricLine(null, DIR, readFn)(UNTIL)).toThrow(
            'конфиг петли не прочитался',
        );
    });
});

// Задача 95, критерий «отказ записи лога не даёт ложного DEADMAN». Живой раннер, у которого
// дописывание лога отказало (полный диск), продолжает писать heartbeat — детект обязан
// судить по нему, и по режиму СТРОКИ heartbeat, а не по устаревшему хвосту.
describe('withHeartbeat — отказ записи лога не даёт ложного DEADMAN (задача 95)', () => {
    const NOW = 1000 * MIN;
    // Лог замёрз 20 мин назад на хозяйственном шаге: строка старта сессии в него не легла.
    const frozenLog = {
        lines: [t('🌳 Worktree раннера переведён на свежий origin/main.'), ''],
        lastMtime: NOW - 20 * MIN,
    };

    it('без heartbeat тот же лог даёт DEADMAN — это и есть ложная тревога', () => {
        const r = evalDeadman({ now: NOW, ...frozenLog, config: CFG });
        expect(r.silent).toBe(true);
    });

    it('свежий heartbeat со строкой сессии: не тишина, режим сессии', () => {
        const hb = {
            mtime: NOW - 20 * MIN + 1000,
            record: { ts: '2026-10-27T00:00:01.000Z', msg: '▶ claude -p "…" --max-turns 200' },
        };
        const merged = withHeartbeat(frozenLog, hb);
        expect(merged.lastMtime).toBe(hb.mtime);
        const r = evalDeadman({ now: NOW, ...merged, config: CFG });
        expect(r.activity).toBe('coder');
        expect(r.silent).toBe(false);
    });

    it('heartbeat тоже замёрз дольше порога — DEADMAN остаётся (раннер действительно мёртв)', () => {
        const hb = {
            mtime: NOW - 3 * 60 * MIN,
            record: { ts: 't', msg: '▶ claude -p "…"' },
        };
        const log = { lines: frozenLog.lines, lastMtime: NOW - 3 * 60 * MIN - 1000 };
        const r = evalDeadman({ now: NOW, ...withHeartbeat(log, hb), config: CFG });
        expect(r.silent).toBe(true);
    });

    it('heartbeat не новее лога — хвост и mtime лога как есть', () => {
        const hb = { mtime: NOW - 30 * MIN, record: { ts: 't', msg: '▶ claude -p' } };
        expect(withHeartbeat(frozenLog, hb)).toBe(frozenLog);
        expect(withHeartbeat(frozenLog, null)).toBe(frozenLog);
    });

    it('строка heartbeat уже последняя в логе — дубля нет', () => {
        const log = { lines: ['[ts1] ▶ claude -p', ''], lastMtime: NOW - 10 };
        const merged = withHeartbeat(log, {
            mtime: NOW,
            record: { ts: 'ts1', msg: '▶ claude -p' },
        });
        expect(merged.lines).toBe(log.lines);
        expect(merged.lastMtime).toBe(NOW);
    });

    it('многострочное сообщение уже в логе — дубля нет', () => {
        const msg = '⛔ Ralph: стоп\nпричина: конфликт\nвопрос: влей main';
        const log = { lines: [...`[ts1] ${msg}`.split('\n'), ''], lastMtime: NOW - 10 };
        const merged = withHeartbeat(log, { mtime: NOW, record: { ts: 'ts1', msg } });
        expect(merged.lines).toBe(log.lines);
    });

    it('многострочное сообщение, не легшее в лог, дописывается построчно', () => {
        const msg = '⛔ Ralph: стоп\nпричина: диск';
        const log = { lines: ['[ts0] ▶ claude -p', ''], lastMtime: NOW - 10 };
        const merged = withHeartbeat(log, { mtime: NOW, record: { ts: 'ts1', msg } });
        expect(merged.lines.slice(-2)).toEqual(['[ts1] ⛔ Ralph: стоп', 'причина: диск']);
    });

    it('лога нет вовсе, а heartbeat свежий — детект судит по heartbeat, а не «лог не найден»', () => {
        const merged = withHeartbeat(
            { lines: [], lastMtime: null },
            { mtime: NOW - MIN, record: { ts: 't', msg: '🚦 Гейт мерджа' } },
        );
        const r = evalDeadman({ now: NOW, ...merged, config: CFG });
        expect(r.reason).toBeNull();
        expect(r.activity).toBe('gate');
        expect(r.silent).toBe(false);
    });

    it('readHeartbeat читает настоящий файл, записанный приёмником раннера', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-hb-'));
        const p = path.join(dir, 'ralph.heartbeat');
        writeHeartbeat(p, encodeHeartbeat('t9', '🔄 Итерация 3'));
        const hb = readHeartbeat(p);
        expect(hb?.record).toEqual({ ts: 't9', msg: '🔄 Итерация 3' });
        expect(readHeartbeat(path.join(dir, 'нет'))).toBeNull();
    });
});

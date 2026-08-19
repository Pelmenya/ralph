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
import os from 'os';
import path from 'path';
import {
    evalDeadman,
    readLogTail,
    shouldPushDeadman,
    deadmanPushMessage,
    maybePushDeadman,
    monitorLogPath,
    openPhasePRs,
} from './monitor-panel.mts';
// @ts-expect-error — JS-entry раннера без деклараций типов.
import { pushEvent as pushEventReal } from '../ralph.js';
import { DEFAULT_DEADMAN } from './deadman.ts';
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
    it('содержит фазу, длительность/порог/режим тишины и явное «цикл продолжается»', () => {
        const msg = deadmanPushMessage(
            { silenceMs: 11 * 60000, thresholdMs: 10 * 60000, activity: 'gate' },
            'Наблюдаемость ralph · Фаза 1',
        );
        expect(msg).toContain('Наблюдаемость ralph · Фаза 1');
        expect(msg).toContain('DEADMAN');
        expect(msg).toContain('режим gate');
        expect(msg).toMatch(/цикл продолжается/i);
    });
});

describe('maybePushDeadman — доставка через pushEvent() + дедуп по эпизоду (#149)', () => {
    // activity как const: maybePushDeadman теперь ждёт Activity | null, а не широкий string
    // (#403-review) — у отдельного const'а без as const поле вывелось бы в string.
    const deadman = { silent: true, silenceMs: 700000, thresholdMs: 600000, activity: 'gate' as const };
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

describe('openPhasePRs — поиск PR текущей фазы по ветке из конфига (#214)', () => {
    it('находит PR по ветке фазы из конфига (строгий --head, ветка через shq)', () => {
        const config = {
            phases: [
                { milestone: 'Фаза 1', branch: 'feature/phase-1' },
                { milestone: 'Фаза 2', branch: 'feature/ralph-post-merge' },
            ],
        };
        const state = { milestone: 'Фаза 2' };
        const shFn = vi.fn((_cmd: string) =>
            JSON.stringify([
                { number: 123, title: 'PR Фаза 2', headRefName: 'feature/ralph-post-merge' },
            ]),
        );
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual([
            { number: 123, title: 'PR Фаза 2', headRefName: 'feature/ralph-post-merge' },
        ]);
        // #THS8X: строгий --head, а не --search "head:…" (тот ловил бы соседние ветки по
        // префиксу); ветка — через shq (одинарные кавычки), а не двойные.
        expect(shFn).toHaveBeenCalledWith(
            expect.stringContaining("--head 'feature/ralph-post-merge'"),
        );
        expect(shFn).not.toHaveBeenCalledWith(expect.stringContaining('--search'));
    });

    it('возвращает пустой массив когда PR нет, но ветка определена', () => {
        const config = {
            phases: [{ milestone: 'Фаза 1', branch: 'feature/phase-1' }],
        };
        const state = { milestone: 'Фаза 1' };
        const shFn = vi.fn((_cmd: string) => '[]');
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual([]);
        expect(shFn).toHaveBeenCalledWith(expect.stringContaining("--head 'feature/phase-1'"));
    });

    it('возвращает { error: "no-branch" } когда фаза не найдена в конфиге', () => {
        const config = {
            phases: [{ milestone: 'Другая Фаза', branch: 'feature/other' }],
        };
        const state = { milestone: 'Фаза 1' };
        const shFn = vi.fn();
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual({ error: 'no-branch' });
        expect(shFn).not.toHaveBeenCalled();
    });

    it('возвращает { error: "no-branch" } когда phases не массив', () => {
        // Каст: тип ResolvedConfig.phases теперь PhaseConfig[] (#403-review), но проверяем
        // именно рантайм-ветку Array.isArray — phases: null мимо типа, ради fail-closed.
        const config = { phases: null } as unknown as Parameters<typeof openPhasePRs>[0];
        const state = { milestone: 'Фаза 1' };
        const shFn = vi.fn();
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual({ error: 'no-branch' });
        expect(shFn).not.toHaveBeenCalled();
    });

    it('возвращает { error: "no-branch" } когда config null', () => {
        const shFn = vi.fn();
        const result = openPhasePRs(null, { milestone: 'Фаза 1' }, shFn);
        expect(result).toEqual({ error: 'no-branch' });
        expect(shFn).not.toHaveBeenCalled();
    });

    it('#THS8M: milestone === null (все фазы сданы) → { error: "all-done" }, не no-branch', () => {
        const config = { phases: [{ milestone: 'Фаза 1', branch: 'feature/phase-1' }] };
        const state = { milestone: null };
        const shFn = vi.fn();
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual({ error: 'all-done' });
        expect(shFn).not.toHaveBeenCalled();
    });

    it('#THS8Z: gh упал (пустой вывод) → { error: "gh-failed" }, не молчаливое «нет PR»', () => {
        const config = { phases: [{ milestone: 'Фаза 1', branch: 'feature/phase-1' }] };
        const state = { milestone: 'Фаза 1' };
        const shFn = vi.fn((_cmd: string) => '');
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual({ error: 'gh-failed' });
    });

    it('#THS8Z: gh вернул мусор (невалидный JSON) → { error: "gh-failed" }', () => {
        const config = { phases: [{ milestone: 'Фаза 1', branch: 'feature/phase-1' }] };
        const state = { milestone: 'Фаза 1' };
        const shFn = vi.fn((_cmd: string) => 'не-json');
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual({ error: 'gh-failed' });
    });

    it('не падает когда state пустой', () => {
        const config = {
            phases: [{ milestone: 'Фаза 1', branch: 'feature/phase-1' }],
        };
        const state = {};
        const shFn = vi.fn((_cmd: string) => '[]');
        const result = openPhasePRs(config, state, shFn);
        expect(result).toEqual({ error: 'no-branch' });
    });
});

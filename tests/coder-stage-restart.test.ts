// #92: матрица «убит посреди этапа» для кодер-итерации.
//
// Каждая клетка — два процесса раннера на одном каталоге состояния. Первый убит посреди
// этапа (смерть МИРА, `crash-world.ts`: фейк бросает, и после этого ни журнал, ни чат
// ничего не принимают). Второй поднят на том, что осталось на «диске», и обязан
// продолжить с брошенного этапа: не брать другую карточку, не считать итерацию второй
// раз, не спавнить новую сессию после доведённой.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import {
    CODER_STAGES,
    createStageJournal,
    parseStageJournal,
    summarizeAttempt,
    type TCoderStage,
} from '../core/stage-journal.ts';
import { REASON_TITLES } from '../core/stop-message.ts';
import { Killed, world } from './crash-world.ts';
import { stripComments } from './strip-comments.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const runLoop = ralph.runLoop as Runtime['runLoop'];

const cfg = () => ({
    model: 'claude-coder',
    prompt: 'сделай {milestone} в ветке {branch}',
    authorAllowlist: ['owner'],
    phases: [{ milestone: 'M1', branch: 'feature/m1' }],
    gate: { checks: [['test', 'npm run test']] },
});

type TDisk = { journal: string | null; state: { count: number; [k: string]: unknown } };

type TProcess = {
    logs: string[];
    chat: string[];
    runClaudeFn: ReturnType<typeof vi.fn>;
    applySessionRequestsFn: ReturnType<typeof vi.fn>;
    handleCrashedCoderSessionFn: ReturnType<typeof vi.fn>;
    getIssueFn: ReturnType<typeof vi.fn>;
    picked: number[];
};

/**
 * Один процесс раннера: одна итерация (`once`) по очереди `queue`. `killIn` — этап, на
 * котором процесс умирает; `code` — код возврата сессии.
 */
function runProcess(
    disk: TDisk,
    {
        queue,
        killIn,
        code = 0,
        killOnWrite,
        over = {},
    }: {
        queue: number[];
        killIn?: TCoderStage;
        code?: number;
        // Смерть МЕЖДУ двумя записями журнала одного шага: запись, на которой мир умирает.
        killOnWrite?: (text: string) => boolean;
        // Подмена отдельных зависимостей петли для клетки.
        over?: Record<string, unknown>;
    },
): TProcess {
    const w = world();
    const logs: string[] = [];
    const chat: string[] = [];
    const picked: number[] = [];
    const killIf = (stage: TCoderStage) => {
        w.alive();
        if (killIn === stage) w.kill();
    };
    const journal = createStageJournal(
        {
            read: () => disk.journal,
            write: (t) => {
                w.alive();
                disk.journal = t;
                if (killOnWrite?.(t)) w.kill();
            },
            remove: () => {
                w.alive();
                disk.journal = null;
            },
        },
        { idFn: () => 'попытка-1' },
    );
    const runClaudeFn = vi.fn(() => {
        killIf('session');
        return code;
    });
    const applySessionRequestsFn = vi.fn(() => {
        killIf('intents');
        return { applied: 0, failed: false, closedIssues: [] };
    });
    const handleCrashedCoderSessionFn = vi.fn(() => {
        killIf('commit');
        return { stop: false };
    });
    const getIssueFn = vi.fn((number: number) => ({ number, title: 'задача', body: 'тело' }));
    const state = { ...disk.state };
    try {
        runLoop(cfg() as never, { state: state as never, maxIterations: 10, maxTurns: 200 }, {
            once: true,
            dry: false,
            logFn: (m: string) => {
                if (!w.dead) logs.push(m);
            },
            pushEventFn: w.chat(chat) as never,
            shFn: () => '',
            runArgvFn: () => '',
            saveStateFn: (s: { count: number }) => {
                w.alive();
                disk.state = { ...s };
            },
            phaseIndexOfFn: () => 0,
            openIssuesFn: () => queue.map((number) => ({ number, title: 't', labels: [] })),
            allOpenIssuesFn: () => [],
            ensureCleanFn: () => true,
            ensurePhaseBranchFn: (branch: string) => ({
                kind: 'switched' as const,
                branch,
                sha: 'a'.repeat(40),
            }),
            checkOnPhaseBranchFn: () => ({ ok: true, sha: 'a'.repeat(40) }),
            ensureMonitorAliveFn: () => null,
            syncProjectBoardFn: () => {},
            pickRouteFn: (issue: { number: number }) => {
                picked.push(issue.number);
                killIf('pick');
                return { model: 'claude-coder', provider: 'claude' };
            },
            getIssueFn,
            runClaudeFn,
            applySessionRequestsFn,
            handleCrashedCoderSessionFn,
            stageJournal: journal,
            ...over,
        } as never);
    } catch (e) {
        if (!(e instanceof Killed)) throw e;
    }
    return {
        logs,
        chat,
        runClaudeFn,
        applySessionRequestsFn,
        handleCrashedCoderSessionFn,
        getIssueFn,
        picked,
    };
}

const freshDisk = (): TDisk => ({
    journal: null,
    state: { count: 0, milestone: 'M1', submitted: false, noProgress: 0 },
});

describe('рестарт посреди этапа продолжает с этапа, а не с начала итерации (#92)', () => {
    it.each(CODER_STAGES)('убит посреди «%s»', (stage) => {
        const disk = freshDisk();
        // Сессия с ненулевым кодом — иначе этапа коммита остатка нет, он «пропущен».
        const code = 1;
        const first = runProcess(disk, { queue: [7], killIn: stage, code });
        expect(first.picked).toEqual([7]);
        const left = summarizeAttempt(parseStageJournal(disk.journal as string, 'j'));
        expect(left?.resumeStage).toBe(stage);
        const countAfterFirst = disk.state.count;

        // Очередь после рестарта другая: первой стоит #8. Продолжение обязано взять #7 —
        // карточку брошенной попытки, а не голову очереди.
        const second = runProcess(disk, { queue: [8, 7], code });
        const idx = CODER_STAGES.indexOf(stage);

        expect(second.picked).toEqual([7]);
        expect(second.handleCrashedCoderSessionFn.mock.calls[0]?.[0]).toMatchObject({ number: 7 });
        // Итерация попытки уже посчитана прошлым процессом.
        expect(disk.state.count).toBe(countAfterFirst);
        expect(second.logs.join('\n')).toContain('Продолжаю попытку попытка-1 по Issue #7');
        // Сессия — один раз за попытку: после доведённой новая не спавнится.
        const sessionDone = idx > CODER_STAGES.indexOf('session');
        expect(second.runClaudeFn).toHaveBeenCalledTimes(sessionDone ? 0 : 1);
        // Тело карточки читается только для сессии.
        expect(second.getIssueFn).toHaveBeenCalledTimes(sessionDone ? 0 : 1);
        // Применение намерений: повторяется брошенное, доведённое не повторяется.
        const intentsDone = idx > CODER_STAGES.indexOf('intents');
        expect(second.applySessionRequestsFn).toHaveBeenCalledTimes(intentsDone ? 0 : 1);
        // Коммит остатка идёт по коду сессии из журнала — процесс, видевший его, мёртв.
        expect(second.handleCrashedCoderSessionFn).toHaveBeenCalledTimes(1);
        expect(second.handleCrashedCoderSessionFn.mock.calls[0][1]).toBe(code);
        // Попытка доведена — журнал снят, и третий процесс начинает свою итерацию.
        expect(disk.journal).toBeNull();
        expect(second.chat).toEqual([]);
    });

    it('без рестарта попытка доводится и снимается: итерация не оставляет журнала', () => {
        const disk = freshDisk();
        const p = runProcess(disk, { queue: [7] });
        expect(p.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(disk.journal).toBeNull();
        expect(disk.state.count).toBe(1);
    });

    it('этап без исхода виден в сводке на старте как «не завершён»', () => {
        const disk = freshDisk();
        runProcess(disk, { queue: [7], killIn: 'intents' });
        const second = runProcess(disk, { queue: [7] });
        const summary = second.logs.find((l) => l.startsWith('📒 Попытка'));
        expect(summary).toBeDefined();
        expect(summary).toContain('сессия — выполнен');
        expect(summary).toContain('применение намерений — не завершён');
        expect(summary).toContain('коммит остатка — не начат');
    });

    it('карточки брошенной попытки нет в очереди — журнал снят, итерация с начала', () => {
        const disk = freshDisk();
        runProcess(disk, { queue: [7], killIn: 'intents' });
        const second = runProcess(disk, { queue: [8] });
        expect(second.logs.join('\n')).toMatch(/Попытка попытка-1 по Issue #7 не продолжается/);
        expect(second.picked).toEqual([8]);
        expect(second.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(disk.state.count).toBe(2);
    });

    it('попытка той же карточки в другой фазе не продолжается', () => {
        const disk = freshDisk();
        runProcess(disk, { queue: [7], killIn: 'intents' });
        disk.journal = (disk.journal as string).replaceAll('"M1"', '"M0"');
        const second = runProcess(disk, { queue: [7] });
        expect(second.logs.join('\n')).toMatch(/не продолжается/);
        expect(second.runClaudeFn).toHaveBeenCalledTimes(1);
    });
});

describe('повреждённый журнал — стоп с диагнозом до первого шага (#92)', () => {
    it('оборванная запись: ни сессии, ни счёта итерации, причина в чате', () => {
        const disk = freshDisk();
        runProcess(disk, { queue: [7], killIn: 'intents' });
        disk.journal = (disk.journal as string).slice(0, -15);
        const second = runProcess(disk, { queue: [7] });
        expect(second.runClaudeFn).not.toHaveBeenCalled();
        expect(second.picked).toEqual([]);
        expect(disk.state.count).toBe(1);
        expect(second.chat).toHaveLength(1);
        expect(second.chat[0]).toContain(REASON_TITLES['stage-journal']);
        expect(second.chat[0]).toMatch(/строка 5: не разбирается как JSON/);
        // Журнал не тронут: разбирать его человеку.
        expect(disk.journal).not.toBeNull();
    });

    it('журнал не пишется — стоп с причиной, а не итерация мимо журнала', () => {
        const disk = freshDisk();
        const logs: string[] = [];
        const chat: string[] = [];
        const runClaudeFn = vi.fn(() => 0);
        runLoop(cfg() as never, { state: disk.state as never, maxIterations: 10, maxTurns: 200 }, {
            once: true,
            dry: false,
            logFn: (m: string) => logs.push(m),
            pushEventFn: ((m: string) => chat.push(m)) as never,
            shFn: () => '',
            saveStateFn: () => {},
            phaseIndexOfFn: () => 0,
            openIssuesFn: () => [{ number: 7, title: 't', labels: [] }],
            ensureCleanFn: () => true,
            ensurePhaseBranchFn: (branch: string) => ({
                kind: 'switched' as const,
                branch,
                sha: 'a'.repeat(40),
            }),
            checkOnPhaseBranchFn: () => ({ ok: true, sha: 'a'.repeat(40) }),
            ensureMonitorAliveFn: () => null,
            syncProjectBoardFn: () => {},
            runClaudeFn,
            stageJournal: createStageJournal({
                read: () => null,
                write: () => {
                    throw new Error('ENOSPC: места нет');
                },
                remove: () => {},
            }),
        } as never);
        expect(runClaudeFn).not.toHaveBeenCalled();
        expect(chat).toHaveLength(1);
        expect(chat[0]).toContain(REASON_TITLES['stage-journal']);
        expect(chat[0]).toMatch(/начало попытки: ENOSPC/);
    });
});

describe('проводка журнала в main (#92)', () => {
    const src = stripComments(
        fs.readFileSync(path.join(import.meta.dirname, '../core/orchestrator.ts'), 'utf8'),
    );

    it('main() передаёт петле боевой журнал: дефолт в памяти рестарта не переживает', () => {
        // Сценарии выше гоняют журнал в памяти, и они зелёные и без проводки: убери её —
        // восстановление молча выключится. Применение держит только эта строка.
        const call = src.slice(src.indexOf('runLoop(config, ctx, {'));
        const body = call.slice(0, call.indexOf('});'));
        expect(body).toMatch(/stageJournal: createStageJournal\(stageJournalStore\b/);
    });

    it('боевое хранилище пишет атомарно, а «не прочитал» отличает от «нет файла»', () => {
        const store = src.slice(src.indexOf('const stageJournalStore: TStageJournalStore = {'));
        const body = store.slice(0, store.indexOf('\n    };\n'));
        expect(body).toContain('writeFileAtomic(RUNTIME.stages, text)');
        expect(body).not.toContain('writeFileSync');
        expect(body).toMatch(/code === 'ENOENT'\) return null;\s*throw e;/);
    });
});

describe('клетки вне диагонали матрицы (#92)', () => {
    const last = (text: string) => JSON.parse(text.trim().split('\n').at(-1) as string);

    it('код 0: убит между началом и исходом коммита — рестарт доводит «пропущен»', () => {
        const disk = freshDisk();
        runProcess(disk, {
            queue: [7],
            code: 0,
            killOnWrite: (t) => {
                const r = last(t);
                return r.stage === 'commit' && r.event === 'start';
            },
        });
        const left = summarizeAttempt(parseStageJournal(disk.journal as string, 'j'));
        expect(left?.resumeStage).toBe('commit');
        const second = runProcess(disk, { queue: [7], code: 0 });
        expect(second.runClaudeFn).not.toHaveBeenCalled();
        expect(second.handleCrashedCoderSessionFn).not.toHaveBeenCalled();
        expect(second.chat).toEqual([]);
        expect(disk.journal).toBeNull();
    });

    it('исход stop кончает попытку: следующий процесс начинает свежую', () => {
        const disk = freshDisk();
        const first = runProcess(disk, {
            queue: [7],
            over: {
                applySessionRequestsFn: () => ({
                    applied: 0,
                    failed: true,
                    closedIssues: [],
                    outcomeUnknown: true,
                }),
            },
        });
        expect(first.runClaudeFn).toHaveBeenCalledTimes(1);
        const left = summarizeAttempt(parseStageJournal(disk.journal as string, 'j'));
        expect(left?.resumeStage).toBeNull();
        const second = runProcess(disk, { queue: [7] });
        // Не продолжение: новая сессия, итерация посчитана заново.
        expect(second.logs.join('\n')).not.toContain('Продолжаю попытку');
        expect(second.runClaudeFn).toHaveBeenCalledTimes(1);
        expect(disk.state.count).toBe(2);
    });

    it('карточка не прочиталась на продолжении — один пуш о причине, журнал цел', () => {
        const disk = freshDisk();
        runProcess(disk, { queue: [7], killIn: 'session', code: 1 });
        const before = disk.journal;
        const second = runProcess(disk, {
            queue: [7],
            over: {
                getIssueFn: () => {
                    throw new Error('HTTP 502');
                },
            },
        });
        expect(second.runClaudeFn).not.toHaveBeenCalled();
        expect(second.chat).toHaveLength(1);
        expect(second.chat[0]).toMatch(/не смог прочитать карточку #7/);
        expect(second.chat[0]).not.toContain(REASON_TITLES['stage-journal']);
        // Выбор задачи уже закрыт — второго его исхода нет, попытка ждёт рестарта.
        expect(disk.journal).toBe(before);
    });

    it('упавшая сессия + грязное дерево: остаток идёт разбору падения, а не общему коммиту', () => {
        const disk = freshDisk();
        runProcess(disk, { queue: [7], killIn: 'intents', code: 1 });
        const commitLeftoversFn = vi.fn(() => true);
        const second = runProcess(disk, {
            queue: [7],
            code: 1,
            over: { ensureCleanFn: () => false, commitLeftoversFn },
        });
        // Без рестарта грязь после падения увидел бы разбор (#390) — увидит и после него.
        expect(commitLeftoversFn).not.toHaveBeenCalled();
        expect(second.handleCrashedCoderSessionFn).toHaveBeenCalledTimes(1);
        expect(second.logs.join('\n')).toMatch(/остаток оставляю разбору падения/);
    });

    it('упавшая сессия + грязное дерево, а карточки в очереди нет — стоп, а не новая сессия', () => {
        const disk = freshDisk();
        runProcess(disk, { queue: [7], killIn: 'intents', code: 1 });
        const commitLeftoversFn = vi.fn(() => true);
        const second = runProcess(disk, {
            queue: [8],
            over: { ensureCleanFn: () => false, commitLeftoversFn },
        });
        expect(commitLeftoversFn).not.toHaveBeenCalled();
        expect(second.runClaudeFn).not.toHaveBeenCalled();
        expect(second.chat).toHaveLength(1);
        expect(second.chat[0]).toMatch(/разобрать падение не по чему/);
    });
});

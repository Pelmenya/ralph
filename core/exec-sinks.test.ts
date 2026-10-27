// Ветки `exec.ts`, добавленные задачей 95: три приёмника log(), режим наблюдателя,
// настоящий emitEvent и ротация `sessions/` после saveSessionOutput (задача 128).
//
// Сьют идёт под RALPH_NO_SIDE_EFFECTS=1, а предохранитель log()/emitEvent() — модульный:
// через ре-экспорт ralph.js эти ветки не исполняются никогда. Поэтому фабрика собирается
// здесь же со своим `noSideEffects: false`, а цель лога — во временном каталоге теста:
// боевой state не читается и не пишется. Наблюдатель проверяется «от противного»: та же
// сборка с целью лога файлы пишет, без цели — не трогает ни одного.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExec } from './exec.ts';
import type { ExecEnv } from './exec.ts';
import { companionPaths, createLogSinks } from './event-journal.ts';
import type { TSinkFs } from './event-journal.ts';
import { DEFAULT_SESSION_LOGS_KEEP } from './observability.ts';

const tmpDirs: string[] = [];

function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-exec-sinks-'));
    tmpDirs.push(d);
    return d;
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Страж побочек экземпляра пропускает только запись вывода сессии во временный каталог:
// глухая заглушка заодно гасила бы страж `sh`/`shArgv`, и забытый мок ушёл бы в шелл.
function tmpOnlyGuard(what: string): void {
    if (!what.startsWith(`saveSessionOutput(${os.tmpdir()}${path.sep}`))
        throw new Error(`exec-sinks: побочка вне временного каталога — ${what}`);
}

// Цель лога для фейковых приёмников: на диск она не пишется, но лежит под tmpdir —
// снятый предохранитель иначе отказал бы (барьер `createExec`).
const FAKE = (name: string) => path.join(os.tmpdir(), 'ralph-exec-sinks-fake', name);

function exec(over: Partial<ExecEnv> & { initialLogTarget: string }) {
    return createExec({
        guardSideEffect: tmpOnlyGuard,
        sleep: () => {},
        noSideEffects: false,
        ...over,
    });
}

// Фейковая fs приёмников: записывает каждое обращение и ничего не трогает на диске.
function recordingFs() {
    const calls: string[] = [];
    const rec =
        (name: string) =>
        (...args: unknown[]) => {
            calls.push(`${name}(${String(args[0])})`);
            if (name === 'openSync') {
                const e = new Error('ENOENT') as NodeJS.ErrnoException;
                e.code = 'ENOENT';
                throw e;
            }
            return 0;
        };
    const fsImpl = {
        appendFileSync: rec('appendFileSync'),
        openSync: rec('openSync'),
        writeSync: rec('writeSync'),
        closeSync: rec('closeSync'),
        writeFileSync: rec('writeFileSync'),
    } as unknown as TSinkFs;
    return { calls, fsImpl };
}

describe('log(): строка уходит во все три приёмника', () => {
    it('лог, журнал событий и heartbeat пишутся рядом с целью', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const target = path.join(tmpDir(), 'ralph.log');
        exec({ initialLogTarget: target }).log('🚀 старт фазы');

        const { events, heartbeat } = companionPaths(target);
        expect(fs.readFileSync(target, 'utf-8')).toMatch(/^\[.+\] 🚀 старт фазы\n$/);
        const record = JSON.parse(fs.readFileSync(events, 'utf-8').trim());
        expect(record).toMatchObject({ kind: 'log', msg: '🚀 старт фазы', seq: 1 });
        expect(JSON.parse(fs.readFileSync(heartbeat, 'utf-8').trim())).toMatchObject({
            msg: '🚀 старт фазы',
        });
    });

    it('зовёт write переданных приёмников с текущей целью', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const sinks = { write: vi.fn(), emit: vi.fn() };
        const e = exec({ initialLogTarget: FAKE('a.log'), sinks });
        e.log('раз');
        e.setLogTarget(FAKE('b.log'));
        e.log('два');
        expect(sinks.write.mock.calls.map((c) => [c[0], c[1]])).toEqual([
            [FAKE('a.log'), 'раз'],
            [FAKE('b.log'), 'два'],
        ]);
    });

    it('под предохранителем побочек приёмники не зовутся, консоль — да', () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        const sinks = { write: vi.fn(), emit: vi.fn() };
        const e = exec({ initialLogTarget: FAKE('a.log'), sinks, noSideEffects: true });
        e.log('строка');
        e.emitEvent('attempt-cost', { usd: 1 });
        expect(out).toHaveBeenCalledWith(expect.stringMatching(/\] строка$/));
        expect(sinks.write).not.toHaveBeenCalled();
        expect(sinks.emit).not.toHaveBeenCalled();
    });
});

describe('emitEvent(): настоящая реализация', () => {
    it('пишет событие в журнал без строки в человеческом логе', () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        const target = path.join(tmpDir(), 'ralph.log');
        exec({ initialLogTarget: target }).emitEvent('attempt-cost', { issue: 7, usd: 0.5 });

        const { events, heartbeat } = companionPaths(target);
        expect(JSON.parse(fs.readFileSync(events, 'utf-8').trim())).toMatchObject({
            kind: 'attempt-cost',
            issue: 7,
            usd: 0.5,
            seq: 1,
        });
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.existsSync(heartbeat)).toBe(false);
        expect(out).not.toHaveBeenCalled();
    });
});

// Свежесть ralph.log — признак жизни петли для deadman. Строка наблюдателя (панель
// монитора), попавшая в файл, оживила бы мёртвый раннер — ложное «петля жива».
describe('setLogTarget(null): наблюдатель не трогает ни одного файла', () => {
    it('от противного: та же сборка с целью лога файлы создаёт', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const dir = tmpDir();
        const e = exec({ initialLogTarget: path.join(dir, 'ralph.log') });
        e.log('строка');
        e.emitEvent('tick', {});
        expect(fs.readdirSync(dir).sort()).toEqual([
            'ralph.events.jsonl',
            'ralph.heartbeat',
            'ralph.log',
        ]);
    });

    it('log() и emitEvent() на настоящей fs: каталог цели остаётся пустым', () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        const dir = tmpDir();
        const e = exec({ initialLogTarget: path.join(dir, 'ralph.log') });
        e.setLogTarget(null);
        e.log('⚠ предупреждение адаптера');
        e.emitEvent('tick', { n: 1 });
        expect(fs.readdirSync(dir)).toEqual([]);
        // Консоль наблюдателю остаётся: панель монитора показывает строку.
        expect(out).toHaveBeenCalledWith(expect.stringMatching(/⚠ предупреждение адаптера$/));
    });

    it('ни одного обращения к fs приёмников — ни записи, ни открытия', () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const { calls, fsImpl } = recordingFs();
        const e = exec({
            initialLogTarget: FAKE('ralph.log'),
            sinks: createLogSinks({ fsImpl, errFn: () => {} }),
        });
        e.log('до');
        expect(calls.length).toBeGreaterThan(0);
        calls.splice(0);

        e.setLogTarget(null);
        e.log('после');
        e.emitEvent('tick', {});
        expect(calls).toEqual([]);
    });
});

describe('saveSessionOutput: ротация sessions/ после записи', () => {
    // Старые выводы с mtime в прошлом: свежий вывод обязан оказаться новее всех.
    function seed(dir: string, n: number): string[] {
        const names: string[] = [];
        for (let i = 0; i < n; i++) {
            const name = `old-${String(i).padStart(2, '0')}.log`;
            const p = path.join(dir, name);
            fs.writeFileSync(p, 'old');
            const t = new Date(Date.UTC(2020, 0, 1, 0, i));
            fs.utimesSync(p, t, t);
            names.push(name);
        }
        return names;
    }

    it('держит ровно sessionLogsKeep выводов, свежий не удаляется', () => {
        const sessions = path.join(tmpDir(), 'sessions');
        fs.mkdirSync(sessions);
        const old = seed(sessions, 5);
        const e = exec({ initialLogTarget: path.join(tmpDir(), 'ralph.log') });
        e.setSessionLogsKeep(3);

        const fresh = path.join(sessions, '42-fresh.log');
        e.saveSessionOutput(fresh, 'boom');

        const left = fs.readdirSync(sessions).sort();
        expect(left).toHaveLength(3);
        expect(left).toContain('42-fresh.log');
        // Остаются самые свежие из старых — два последних по mtime.
        expect(left).toEqual(['42-fresh.log', old[3], old[4]].sort());
        expect(fs.readFileSync(fresh, 'utf-8')).toBe('boom');
    });

    it('ключ из конфига доходит до уборки; без него — умолчание', () => {
        const pruneFn = vi.fn(() => ({ removed: [], errors: [] }));
        const sessions = path.join(tmpDir(), 'sessions');
        const e = exec({ initialLogTarget: path.join(tmpDir(), 'ralph.log'), pruneFn });

        e.saveSessionOutput(path.join(sessions, 'a.log'), 'x');
        e.setSessionLogsKeep(7);
        e.saveSessionOutput(path.join(sessions, 'b.log'), 'y');

        expect(pruneFn.mock.calls).toEqual([
            [sessions, DEFAULT_SESSION_LOGS_KEEP],
            [sessions, 7],
        ]);
    });

    it('частичный отказ уборки — строка в лог, а не исключение', () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        const pruneFn = vi.fn(() => ({
            removed: ['b.log'],
            errors: ['a.log: EACCES', 'c.log: EBUSY'],
        }));
        const dir = tmpDir();
        const target = path.join(dir, 'ralph.log');
        const fresh = path.join(dir, 'sessions', '42.log');
        const e = exec({ initialLogTarget: target, pruneFn });

        expect(() => e.saveSessionOutput(fresh, 'boom')).not.toThrow();
        const line = '⚠ Ротация логов сессий не удалась частично: a.log: EACCES; c.log: EBUSY';
        expect(out).toHaveBeenCalledWith(expect.stringContaining(line));
        expect(fs.readFileSync(target, 'utf-8')).toContain(line);
        expect(fs.readFileSync(fresh, 'utf-8')).toBe('boom');
    });

    it('чистая уборка в лог не пишет', () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        const pruneFn = vi.fn(() => ({ removed: ['old.log'], errors: [] }));
        const e = exec({ initialLogTarget: path.join(tmpDir(), 'ralph.log'), pruneFn });
        e.saveSessionOutput(path.join(tmpDir(), 'sessions', '1.log'), 'x');
        expect(out).not.toHaveBeenCalled();
    });
});

// Барьер вместо абзаца: снятый предохранитель с боевой целью — отказ, а не запись.
describe('noSideEffects: false только с целью во временном каталоге', () => {
    it('цель лога вне tmpdir — createExec бросает', () => {
        expect(() => exec({ initialLogTarget: '/path/to/ralph.log' })).toThrow(
            /не во временном каталоге/,
        );
    });

    it('setLogTarget вне tmpdir — бросает, null (наблюдатель) — можно', () => {
        const e = exec({
            initialLogTarget: FAKE('a.log'),
            sinks: { write: vi.fn(), emit: vi.fn() },
        });
        expect(() => e.setLogTarget('/path/to/b.log')).toThrow(/не во временном каталоге/);
        expect(() => e.setLogTarget(null)).not.toThrow();
    });

    it('под предохранителем цель не проверяется — флаг не снят', () => {
        expect(() =>
            exec({ initialLogTarget: '/path/to/ralph.log', noSideEffects: true }),
        ).not.toThrow();
    });

    it('страж экземпляра не пропускает шелл', () => {
        const e = exec({ initialLogTarget: FAKE('a.log') });
        expect(() => e.sh('true')).toThrow(/побочка вне временного каталога/);
    });
});

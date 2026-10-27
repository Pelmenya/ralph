// Приёмники строки лога (задача 95): отказ одного не гасит другие, heartbeat пишется
// на месте и несёт последнюю строку. Отказ диска подсовывается подменённым fs — настоящий
// ENOSPC в тесте не устроить, а вот что именно делает каждый приёмник при отказе, видно
// только так.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimePathsIn } from './runtime-paths.ts';
import {
    HEARTBEAT_RECORD_BYTES,
    companionPaths,
    createLogSinks,
    decodeHeartbeat,
    encodeHeartbeat,
    writeHeartbeat,
    type TSinkFs,
} from './event-journal.ts';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-sinks-'));
}

// fs, у которого дописывание отказывает, как на полном диске, а перезапись на месте — нет.
function fullDiskFs(): TSinkFs & { appends: string[] } {
    const appends: string[] = [];
    return {
        appends,
        appendFileSync: ((p: string) => {
            appends.push(p);
            const e = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
            e.code = 'ENOSPC';
            throw e;
        }) as TSinkFs['appendFileSync'],
        openSync: fs.openSync,
        writeSync: fs.writeSync,
        closeSync: fs.closeSync,
        writeFileSync: fs.writeFileSync,
    };
}

describe('companionPaths', () => {
    it('спутники боевого и не-боевого лога разные', () => {
        expect(companionPaths('/r/ralph.log')).toEqual({
            events: '/r/ralph.events.jsonl',
            heartbeat: '/r/ralph.heartbeat',
        });
        expect(companionPaths('/r/ralph.dry.log').heartbeat).toBe('/r/ralph.dry.heartbeat');
    });
});

describe('heartbeat фиксированной длины', () => {
    it('запись всегда одной длины и разбирается обратно', () => {
        const short = encodeHeartbeat('2026-10-27T00:00:00.000Z', 'x');
        const long = encodeHeartbeat('2026-10-27T00:00:00.000Z', 'я'.repeat(5000));
        expect(short.length).toBe(HEARTBEAT_RECORD_BYTES);
        expect(long.length).toBe(HEARTBEAT_RECORD_BYTES);
        expect(decodeHeartbeat(short.toString('utf8'))).toEqual({
            ts: '2026-10-27T00:00:00.000Z',
            msg: 'x',
        });
        expect(decodeHeartbeat(long.toString('utf8'))?.msg.startsWith('яяя')).toBe(true);
    });

    it('короткая запись поверх длинной не оставляет хвоста', () => {
        const p = path.join(tmpDir(), 'ralph.heartbeat');
        writeHeartbeat(p, encodeHeartbeat('t1', 'длинная строка '.repeat(20)));
        writeHeartbeat(p, encodeHeartbeat('t2', 'кор'));
        expect(fs.statSync(p).size).toBe(HEARTBEAT_RECORD_BYTES);
        expect(decodeHeartbeat(fs.readFileSync(p, 'utf8'))).toEqual({ ts: 't2', msg: 'кор' });
    });

    it('мусор не разбирается в запись', () => {
        expect(decodeHeartbeat('')).toBeNull();
        expect(decodeHeartbeat('{"ts":1}')).toBeNull();
    });
});

describe('createLogSinks: приёмники независимы', () => {
    it('исправный диск: строка в логе, событие с seq, heartbeat с последней строкой', () => {
        const dir = tmpDir();
        const log = path.join(dir, 'ralph.log');
        const sinks = createLogSinks({ errFn: () => {} });
        expect(sinks.write(log, '▶ первая', 't1')).toEqual({
            log: true,
            events: true,
            heartbeat: true,
        });
        sinks.write(log, '🔄 вторая', 't2');
        expect(fs.readFileSync(log, 'utf8')).toBe('[t1] ▶ первая\n[t2] 🔄 вторая\n');
        const events = fs
            .readFileSync(path.join(dir, 'ralph.events.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(events.map((e) => [e.seq, e.kind, e.msg])).toEqual([
            [1, 'log', '▶ первая'],
            [2, 'log', '🔄 вторая'],
        ]);
        const hb = fs.readFileSync(path.join(dir, 'ralph.heartbeat'), 'utf8');
        expect(decodeHeartbeat(hb)).toEqual({ ts: 't2', msg: '🔄 вторая' });
    });

    it('полный диск: лог и журнал отказали, heartbeat всё равно сдвинулся и несёт строку', () => {
        const dir = tmpDir();
        const log = path.join(dir, 'ralph.log');
        const hbPath = companionPaths(log).heartbeat;
        // Файл heartbeat уже есть — его выделили, пока место было.
        writeHeartbeat(hbPath, encodeHeartbeat('t0', 'старт'));
        const past = new Date('2026-01-01T00:00:00Z');
        fs.utimesSync(hbPath, past, past);
        const errs: string[] = [];
        const fsImpl = fullDiskFs();
        const sinks = createLogSinks({ fsImpl, errFn: (m) => errs.push(m) });

        const report = sinks.write(log, '▶ claude -p "…"', 't1');

        expect(report).toEqual({ log: false, events: false, heartbeat: true });
        expect(fs.statSync(hbPath).mtimeMs).toBeGreaterThan(past.getTime());
        expect(decodeHeartbeat(fs.readFileSync(hbPath, 'utf8'))?.msg).toBe('▶ claude -p "…"');
        // Отказ назван, а не проглочен, — по разу на приёмник.
        expect(errs).toHaveLength(2);
        expect(errs[0]).toMatch(/Запись log не удалась.*ENOSPC/);
        expect(errs[1]).toMatch(/Запись events не удалась/);
    });

    it('предупреждение раз на эпизод, и восстановление тоже сказано', () => {
        const dir = tmpDir();
        const log = path.join(dir, 'ralph.log');
        let broken = true;
        const fsImpl: TSinkFs = {
            ...fs,
            appendFileSync: ((p: string, d: string) => {
                if (broken && p === log) throw new Error('EACCES');
                fs.appendFileSync(p, d);
            }) as TSinkFs['appendFileSync'],
        };
        const errs: string[] = [];
        const sinks = createLogSinks({ fsImpl, errFn: (m) => errs.push(m) });
        sinks.write(log, 'a', 't1');
        sinks.write(log, 'b', 't2');
        expect(errs).toHaveLength(1);
        broken = false;
        sinks.write(log, 'c', 't3');
        expect(errs[1]).toMatch(/Запись log восстановлена/);
        // Потерянные строки видны в журнале событий пометкой, а не дырой.
        const events = fs
            .readFileSync(path.join(dir, 'ralph.events.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(events.map((e) => e.logLost ?? false)).toEqual([true, true, false]);
    });

    it('emit пишет событие без строки в человеческом логе', () => {
        const dir = tmpDir();
        const log = path.join(dir, 'ralph.log');
        const sinks = createLogSinks({ errFn: () => {} });
        expect(sinks.emit(log, 'attempt', { tokens: 3 }, 't1')).toBe(true);
        expect(fs.existsSync(log)).toBe(false);
        const ev = JSON.parse(fs.readFileSync(companionPaths(log).events, 'utf8')) as object;
        expect(ev).toEqual({ seq: 1, ts: 't1', kind: 'attempt', tokens: 3 });
    });

    it('НЕГАТИВНЫЙ: полезная нагрузка не перезаписывает служебные поля', () => {
        // Событие со своим `seq` иначе сломало бы монотонность, и пропуск в журнале
        // перестал бы быть виден как пропуск.
        const dir = tmpDir();
        const log = path.join(dir, 'ralph.log');
        const sinks = createLogSinks({ errFn: () => {} });
        sinks.emit(log, 'attempt', { seq: 99, ts: 'чужое', kind: 'подделка', tokens: 3 }, 't1');
        const ev = JSON.parse(fs.readFileSync(companionPaths(log).events, 'utf8')) as object;
        expect(ev).toMatchObject({ seq: 1, ts: 't1', kind: 'attempt', tokens: 3 });
    });

    it('спутники лога названы в описи состояния под теми же именами', () => {
        // Иначе --migrate-runtime унёс бы лог и оставил его журнал в старом каталоге.
        const paths = runtimePathsIn('/r');
        expect(companionPaths(paths.log)).toEqual({
            events: paths.events,
            heartbeat: paths.heartbeat,
        });
        expect(companionPaths(paths.dryLog)).toEqual({
            events: paths.dryEvents,
            heartbeat: paths.dryHeartbeat,
        });
    });
});

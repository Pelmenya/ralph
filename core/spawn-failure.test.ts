// Юнит-тесты классификации отказа ЗАПУСКА процесса (#607/#611, вынесено ревью #612).
// Здесь проверяется САМ модуль — чистые преобразования вход→выход, без spawnSync и без
// перехвата console: тексты возвращаются строками, поэтому их видно прямо в ассертах.
import { describe, it, expect } from 'vitest';
import {
    isArgvTooLong,
    argvTooLongMessage,
    classifySpawnOutcome,
    resolveSpawnResult,
} from './spawn-failure.ts';

const err = (code: string | undefined, message: string): NodeJS.ErrnoException =>
    Object.assign(new Error(message), { code });

describe('isArgvTooLong — детекция E2BIG (#607)', () => {
    it('код E2BIG распознаётся', () => {
        expect(isArgvTooLong(err('E2BIG', 'spawnSync claude E2BIG'))).toBe(true);
    });

    it('текст "Argument list too long" без кода E2BIG тоже распознаётся', () => {
        expect(isArgvTooLong(err(undefined, 'posix_spawn: Argument list too long'))).toBe(true);
    });

    it('отсутствие ошибки — не argv-too-long', () => {
        expect(isArgvTooLong(undefined)).toBe(false);
        expect(isArgvTooLong(null)).toBe(false);
    });

    it('другая ошибка (ENOENT) — не argv-too-long', () => {
        expect(isArgvTooLong(err('ENOENT', 'no such file'))).toBe(false);
    });
});

describe('classifySpawnOutcome — процесс не поднялся vs отработал (#611, ревью #612)', () => {
    it('ошибки нет вовсе → session-failed без кода ОС', () => {
        expect(classifySpawnOutcome(null, { status: 1, signal: null })).toEqual({
            failureKind: 'session-failed',
        });
    });

    it('ENOENT (бинаря нет) → runtime-unavailable', () => {
        expect(
            classifySpawnOutcome(err('ENOENT', 'spawnSync claude ENOENT'), {
                status: null,
                signal: null,
            }),
        ).toEqual({ failureKind: 'runtime-unavailable', systemErrorCode: 'ENOENT' });
    });

    it('E2BIG → arg-too-long', () => {
        expect(
            classifySpawnOutcome(err('E2BIG', 'spawnSync claude E2BIG'), {
                status: null,
                signal: null,
            }),
        ).toEqual({ failureKind: 'arg-too-long', systemErrorCode: 'E2BIG' });
    });

    it('EACCES без status/signal (процесс не поднялся) → spawn-failed', () => {
        expect(
            classifySpawnOutcome(err('EACCES', 'spawnSync claude EACCES'), {
                status: null,
                signal: null,
            }),
        ).toEqual({ failureKind: 'spawn-failed', systemErrorCode: 'EACCES' });
    });

    // Ревью #612: spawnSync при срабатывании `timeout` отдаёт И signal:'SIGTERM', И
    // error:ETIMEDOUT (проверено прямым запуском `spawnSync('sleep',['5'],{timeout:300})`).
    // Двухчасовая сессия, убитая по claudeTimeoutMs, — отказ СЕССИИ, а не запуска.
    it('ETIMEDOUT с signal:SIGTERM (таймаут сессии) → session-failed, а не отказ запуска', () => {
        expect(
            classifySpawnOutcome(err('ETIMEDOUT', 'spawnSync claude ETIMEDOUT'), {
                status: null,
                signal: 'SIGTERM',
            }),
        ).toEqual({ failureKind: 'session-failed', systemErrorCode: 'ETIMEDOUT' });
    });

    // Ревью #612: `spawnSync('head',['-c','5000','/dev/zero'],{maxBuffer:10})` →
    // status 0, signal null, error ENOBUFS. Процесс отработал и вернул НОЛЬ.
    it('ENOBUFS при status:0 (вывод больше maxBuffer) → session-failed, процесс отработал', () => {
        expect(
            classifySpawnOutcome(err('ENOBUFS', 'spawnSync claude ENOBUFS'), {
                status: 0,
                signal: null,
            }),
        ).toEqual({ failureKind: 'session-failed', systemErrorCode: 'ENOBUFS' });
    });
});

describe('resolveSpawnResult — результат + строки лога', () => {
    it('успех (status:0) → code 0 без failureKind и без строк лога', () => {
        const { result, logLines } = resolveSpawnResult(
            'claude',
            { status: 0, signal: null },
            'ok\n',
            1000,
        );
        expect(result).toEqual({ code: 0, output: 'ok\n' });
        expect(logLines).toEqual([]);
    });

    it('обычное падение (status:2) → code 2, session-failed, лог молчит', () => {
        const { result, logLines } = resolveSpawnResult(
            'claude',
            { status: 2, signal: null },
            'boom',
            1000,
        );
        expect(result).toEqual({ code: 2, output: 'boom', failureKind: 'session-failed' });
        expect(logLines).toEqual([]);
    });

    it('ENOENT → code 1, runtime-unavailable, лог называет причину', () => {
        const { result, logLines } = resolveSpawnResult(
            'claude',
            { status: null, signal: null, error: err('ENOENT', 'spawnSync claude ENOENT') },
            '\n',
            1000,
        );
        expect(result.failureKind).toBe('runtime-unavailable');
        expect(result.code).toBe(1);
        expect(logLines.join('\n')).toMatch(/рантайм недоступен \(ENOENT\)/);
    });

    it('ENOBUFS при status:0 остаётся УСПЕХОМ, но лог говорит про обрезанный вывод', () => {
        const { result, logLines } = resolveSpawnResult(
            'claude',
            { status: 0, signal: null, error: err('ENOBUFS', 'spawnSync claude ENOBUFS') },
            'очень много букв',
            1000,
        );
        // Успешная (слишком многословная) сессия не превращается в падение — иначе в шагах
        // сдачи фазы это был бы fail-closed стоп фазы на ровном месте.
        expect(result).toEqual({ code: 0, output: 'очень много букв' });
        expect(logLines.join('\n')).toMatch(/ENOBUFS/);
        expect(logLines.join('\n')).toMatch(/maxBuffer/);
        expect(logLines.join('\n')).not.toMatch(/не запустился/);
    });

    it('таймаут (SIGTERM + ETIMEDOUT) логируется строкой про сигнал, а не «не запустился»', () => {
        const { result, logLines } = resolveSpawnResult(
            'claude',
            {
                status: null,
                signal: 'SIGTERM',
                error: err('ETIMEDOUT', 'spawnSync claude ETIMEDOUT'),
            },
            '\n',
            7_200_000,
        );
        expect(result).toEqual({ code: 1, output: '\n', failureKind: 'session-failed' });
        expect(logLines.join('\n')).toMatch(/убит по сигналу SIGTERM \(таймаут 7200000мс\?\)/);
        expect(logLines.join('\n')).not.toMatch(/не запустился/);
    });

    it('имя бинаря параметризовано — codex-путь получает те же тексты со своим именем', () => {
        const { logLines } = resolveSpawnResult(
            'codex',
            { status: null, signal: null, error: err('EACCES', 'spawnSync codex EACCES') },
            '\n',
            1000,
        );
        expect(logLines.join('\n')).toMatch(/^⚠ codex не запустился/);
    });
});

describe('argvTooLongMessage — текст причины (#607)', () => {
    it('называет причину явно и не путает её с «сессия/ревью не дало вердикта»', () => {
        const msg = argvTooLongMessage('claude', err('E2BIG', 'spawnSync claude E2BIG'));
        expect(msg).toMatch(/E2BIG/);
        expect(msg).toMatch(/запуска/i);
        expect(msg).not.toMatch(/вердикт/);
    });

    // Ревью #612: на самом частом входе код и константа совпадали, и текст читался
    // тавтологией «(E2BIG / код E2BIG)».
    it('код ОС E2BIG не дублируется — тавтологии «E2BIG / код E2BIG» нет', () => {
        const msg = argvTooLongMessage('claude', err('E2BIG', 'spawnSync claude E2BIG'));
        expect(msg).not.toMatch(/код E2BIG/);
    });

    it('ДРУГОЙ код (текстовый матч без E2BIG) показывается — ради него ветка и есть', () => {
        const msg = argvTooLongMessage(
            'claude',
            err('EINVAL', 'posix_spawn: Argument list too long'),
        );
        expect(msg).toMatch(/код EINVAL/);
    });
});

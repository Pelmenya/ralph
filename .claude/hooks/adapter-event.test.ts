import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    ADAPTER_PROTOCOL_VERSION,
    ADAPTER_TIMEOUT_MS,
    normalizeViaAdapter,
    OPERATION_FIELDS,
    parseAdapterReply,
    toolEventProblem,
} from './adapter-event.cjs';

/**
 * Граница вызова «хук → нормализатор пакета» (#179): команда — настоящий процесс, как её
 * позовёт хук. Сбой на любом шаге обязан стать блоком с причиной, а не пропуском.
 */

const SAMPLE = path.join(
    import.meta.dirname,
    '..',
    '..',
    'tests',
    '__fixtures__',
    'harness-sample',
    'normalize.ts',
);
const sampleArgv = [process.execPath, SAMPLE];

const raw = (toolName: string, toolInput: Record<string, unknown> = {}) =>
    JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: '/work' });

/** Подопытная команда: скрипт во временном каталоге, исполняется node. */
const script = (body: string) => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'adapter-cmd-')), 'cmd.mjs');
    writeFileSync(file, body);
    return [process.execPath, file];
};

const reasonOf = (verdict: ReturnType<typeof normalizeViaAdapter>) =>
    'block' in verdict ? verdict.reason : null;

describe('команда адаптера-образца отдаёт событие', () => {
    it('Bash → exec с базой из конверта', () => {
        const verdict = normalizeViaAdapter(sampleArgv, raw('Bash', { command: 'ls -la' }));
        expect(verdict).toEqual({
            event: { operations: [{ op: 'exec', command: 'ls -la', baseDir: '/work' }] },
        });
    });

    it('незнакомый инструмент — операция unknown, а не пустое событие', () => {
        const verdict = normalizeViaAdapter(sampleArgv, raw('Frobnicate'));
        expect(verdict).toEqual({
            event: { operations: [{ op: 'unknown', why: 'инструмент "Frobnicate"' }] },
        });
    });
});

describe('сбой команды — блок с причиной', () => {
    it('нормализатор упал — блок с его stderr', () => {
        const reason = reasonOf(normalizeViaAdapter(sampleArgv, raw('Crash')));
        expect(reason).toMatch(
            /^адаптер харнесса: команда вышла с кодом 1: нормализатор упал: образец упал/,
        );
    });

    it('вход не JSON — блок, причину называет сам адаптер', () => {
        expect(reasonOf(normalizeViaAdapter(sampleArgv, 'не json'))).toMatch(
            /кодом 1: вход хука не JSON/,
        );
    });

    it('команды нет на диске — блок', () => {
        const verdict = normalizeViaAdapter(['/nonexistent/adapter-normalizer'], raw('Bash'));
        expect(reasonOf(verdict)).toMatch(/команда не запустилась/);
    });

    it('незнакомая версия протокола — блок', () => {
        const argv = script(
            `process.stdout.write(JSON.stringify({ protocol: 99, event: { operations: [{ op: 'inert', what: 'x' }] } }));`,
        );
        expect(reasonOf(normalizeViaAdapter(argv, raw('Bash')))).toMatch(
            /незнакомая версия протокола 99 \(хук знает 1\)/,
        );
    });

    it('ответа нет вовсе — блок, а не «нечего судить»', () => {
        const argv = script('');
        expect(reasonOf(normalizeViaAdapter(argv, raw('Bash')))).toMatch(
            /ответ не JSON: \(пусто\)/,
        );
    });

    it('зависла — блок по сроку', () => {
        const argv = script('setTimeout(() => {}, 60_000);');
        const reason = reasonOf(normalizeViaAdapter(argv, raw('Bash'), { timeoutMs: 300 }));
        expect(reason).toMatch(/не ответила в срок/);
    });

    it('убита сигналом — блок', () => {
        const argv = script(`process.kill(process.pid, 'SIGTERM');`);
        expect(reasonOf(normalizeViaAdapter(argv, raw('Bash')))).toMatch(/убита сигналом SIGTERM/);
    });

    it('stderr пуст — причина говорит это, а не молчит', () => {
        const argv = script('process.exit(3);');
        expect(reasonOf(normalizeViaAdapter(argv, raw('Bash')))).toMatch(
            /кодом 3: \(stderr пуст\)/,
        );
    });

    it.each([[[]], [['']], [[42]], [null]])('команда не задана (%j) — блок', (argv) => {
        expect(reasonOf(normalizeViaAdapter(argv as string[], raw('Bash')))).toMatch(
            /команда нормализатора не задана/,
        );
    });

    it('запуск бросил — блок, а не исключение из хука', () => {
        const verdict = normalizeViaAdapter(['x'], raw('Bash'), {
            spawnSyncFn: () => {
                throw new Error('EAGAIN');
            },
        });
        expect(reasonOf(verdict)).toMatch(/не запустилась: EAGAIN/);
    });

    it('бросок не-Error тоже становится причиной', () => {
        const verdict = normalizeViaAdapter(['x'], raw('Bash'), {
            spawnSyncFn: () => {
                throw 'строкой';
            },
        });
        expect(reasonOf(verdict)).toMatch(/не запустилась: строкой/);
    });
});

describe('ответ адаптера разбирается строго', () => {
    const reply = (event: unknown, protocol: unknown = ADAPTER_PROTOCOL_VERSION) =>
        JSON.stringify({ protocol, event });

    it('ответ не объект — отказ', () => {
        expect(parseAdapterReply('[1]')).toEqual({ reason: 'ответ не объект' });
        expect(parseAdapterReply('null')).toEqual({ reason: 'ответ не объект' });
    });

    it('без версии протокола — отказ', () => {
        expect(parseAdapterReply(JSON.stringify({ event: {} }))).toEqual({
            reason: 'незнакомая версия протокола undefined (хук знает 1)',
        });
    });

    it.each([
        [null, 'событие не объект'],
        [{}, 'у события нет массива operations'],
        [{ operations: [] }, 'событие без операций'],
        [{ operations: [7] }, 'operations[0]: операция не объект'],
        [{ operations: [{ op: 'teleport' }] }, 'operations[0]: незнакомая операция "teleport"'],
        [
            { operations: [{ op: 'hasOwnProperty' }] },
            'operations[0]: незнакомая операция "hasOwnProperty"',
        ],
        [
            { operations: [{ op: 'read', path: '', baseDir: '/' }] },
            'operations[0] (read): нет строкового поля path',
        ],
        [
            { operations: [{ op: 'move', path: 'a', baseDir: '/' }] },
            'operations[0] (move): нет строкового поля destination',
        ],
        [
            { operations: [{ op: 'search', root: '.', baseDir: '/', pathGlob: 3 }] },
            'operations[0] (search): поле pathGlob не строка',
        ],
        [
            { operations: [{ op: 'mcp', server: 's', tool: 't', effect: 'maybe', derived: [] }] },
            'operations[0] (mcp): эффект "maybe" вне read/write/unknown',
        ],
        [
            { operations: [{ op: 'mcp', server: 's', tool: 't', effect: 'read' }] },
            'operations[0] (mcp): derived не массив',
        ],
        [
            {
                operations: [
                    {
                        op: 'mcp',
                        server: 's',
                        tool: 't',
                        effect: 'read',
                        derived: [{ op: 'read', baseDir: '/' }],
                    },
                ],
            },
            'operations[0].derived[0] (read): нет строкового поля path',
        ],
    ])('%j — %s', (event, problem) => {
        expect(toolEventProblem(event)).toBe(problem);
        expect(parseAdapterReply(reply(event))).toEqual({
            reason: `событие не по контракту: ${problem}`,
        });
    });

    it('каждая операция контракта принимается в полной форме', () => {
        const full: Record<string, Record<string, unknown>> = {
            exec: { command: 'ls', baseDir: '/' },
            read: { path: 'a', baseDir: '/' },
            write: { path: 'a', baseDir: '/' },
            delete: { path: 'a', baseDir: '/' },
            move: { path: 'a', destination: 'b', baseDir: '/' },
            search: { root: '.', baseDir: '/', pathGlob: '*.ts', contentPattern: 'x' },
            mcp: {
                server: 's',
                tool: 't',
                effect: 'write',
                derived: [{ op: 'fetch', url: 'https://example.com' }],
            },
            fetch: { url: 'https://example.com' },
            agent: { parentSession: 'abc' },
            defer: { what: 'ScheduleWakeup' },
            inert: { what: 'todo' },
            unknown: { why: 'нет в toolMap', kind: 'tool' },
        };
        expect(Object.keys(full).sort()).toEqual(Object.keys(OPERATION_FIELDS).sort());
        const operations = Object.entries(full).map(([op, fields]) => ({ op, ...fields }));
        expect(toolEventProblem({ operations })).toBeNull();
        expect(parseAdapterReply(reply({ operations }))).toEqual({ event: { operations } });
    });
});

describe('операция без лишнего (#186)', () => {
    it.each([
        [
            { op: 'read', path: 'a', baseDir: '/', destination: 'b' },
            'operations[0] (read): лишнее поле destination',
        ],
        [
            { op: 'exec', command: 'ls', baseDir: '/', cwd: '/elsewhere' },
            'operations[0] (exec): лишнее поле cwd',
        ],
        [
            { op: 'unknown', why: 'x', kind: 'tool-ish' },
            'operations[0] (unknown): kind "tool-ish" вне tool/field',
        ],
    ])('%j — %s', (op, problem) => {
        expect(toolEventProblem({ operations: [op] })).toBe(problem);
    });

    it.each(['tool', 'field', undefined])('unknown с kind %s принимается', (kind) => {
        const op =
            kind === undefined ? { op: 'unknown', why: 'x' } : { op: 'unknown', why: 'x', kind };
        expect(toolEventProblem({ operations: [op] })).toBeNull();
    });

    it('срок адаптера заметно меньше таймаута guard в регистрации канона', async () => {
        const { CANON_SESSION_HOOKS } = await import('../../core/session-settings.ts');
        const guard = CANON_SESSION_HOOKS.find((h) => h.file === 'guard.cjs');
        expect(ADAPTER_TIMEOUT_MS * 2).toBeLessThanOrEqual((guard?.timeout ?? 0) * 1000);
    });
});

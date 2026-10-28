import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ADAPTER_PROTOCOL_VERSION as HOOK_PROTOCOL_VERSION } from '../../.claude/hooks/adapter-event.cjs';
import {
    ADAPTER_PROTOCOL_VERSION,
    normalizeReply,
    readAll,
    runNormalizer,
    type ToolEvent,
} from './protocol.ts';

const exec: ToolEvent = { operations: [{ op: 'exec', command: 'ls', baseDir: '/' }] };

describe('сторона адаптера на границе вызова', () => {
    // Стороны не импортируют друг друга по замыслу — равенство версий держит этот тест.
    it('версия протокола совпадает с той, что знает хук', () => {
        expect(ADAPTER_PROTOCOL_VERSION).toBe(HOOK_PROTOCOL_VERSION);
    });

    it('ответ несёт версию протокола и событие', () => {
        expect(normalizeReply('{}', () => exec)).toEqual({
            stdout: JSON.stringify({ protocol: ADAPTER_PROTOCOL_VERSION, event: exec }),
        });
    });

    it('вход не JSON — отказ, нормализатор не зовётся', () => {
        let called = false;
        const reply = normalizeReply('{', () => {
            called = true;
            return exec;
        });
        expect(reply).toEqual({ error: 'вход хука не JSON' });
        expect(called).toBe(false);
    });

    it.each([
        [new Error('нет поля'), 'нормализатор упал: нет поля'],
        ['строкой', 'нормализатор упал: строкой'],
    ])('нормализатор бросил %j — отказ с причиной', (thrown, error) => {
        expect(
            normalizeReply('{}', () => {
                throw thrown;
            }),
        ).toEqual({ error });
    });

    const run = async (stdin: string, normalize = (): ToolEvent => exec) => {
        const out: string[] = [];
        const err: string[] = [];
        const codes: number[] = [];
        await runNormalizer(normalize, {
            stdin: Readable.from([stdin]),
            writeFn: (t) => out.push(t),
            errorFn: (t) => err.push(t),
            exitFn: (c) => codes.push(c),
        });
        return { out, err, codes };
    };

    it('runNormalizer: событие в stdout, код 0', async () => {
        const { out, err, codes } = await run('{}');
        expect(JSON.parse(out.join(''))).toEqual({
            protocol: ADAPTER_PROTOCOL_VERSION,
            event: exec,
        });
        expect(err).toEqual([]);
        expect(codes).toEqual([0]);
    });

    it('runNormalizer: сбой — причина в stderr, код 1, stdout пуст', async () => {
        const { out, err, codes } = await run('нет');
        expect(out).toEqual([]);
        expect(err).toEqual(['вход хука не JSON\n']);
        expect(codes).toEqual([1]);
    });
});

describe('боевые дефолты runNormalizer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    it('readAll склеивает куски потока', async () => {
        expect(await readAll(Readable.from([Buffer.from('{"a":'), '1}']))).toBe('{"a":1}');
    });

    it('ответ — в process.stdout, код — в process.exitCode', async () => {
        const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        await runNormalizer(() => exec, { stdin: Readable.from(['{}']) });
        expect(out).toHaveBeenCalledWith(`${JSON.stringify({ protocol: 1, event: exec })}\n`);
        expect(process.exitCode).toBe(0);
    });

    it('отказ — в process.stderr, код 1', async () => {
        const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        await runNormalizer(() => exec, { stdin: Readable.from([]) });
        expect(err).toHaveBeenCalledWith('вход хука не JSON\n');
        expect(process.exitCode).toBe(1);
    });
});

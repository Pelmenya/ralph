// Разбор доверенного контекста сессии в хуке (#184): нет переменной — сессия человека,
// заявленный, но битый контекст — ошибка, а не «петли нет».
import { describe, expect, it } from 'vitest';

import {
    parseSessionContext,
    readSessionContext,
    SESSION_CONTEXT_ENV,
} from './session-context.cjs';

const SHA = 'a'.repeat(40);
const good = {
    sessionId: 's-1',
    loop: true,
    coreRevision: SHA,
    roots: { consumer: '/path/to/app', execution: '/path/to/app-ralph' },
};
const raw = (o: unknown) => JSON.stringify(o);

describe('parseSessionContext', () => {
    it('нет переменной или она пуста — контекста нет, ошибки нет', () => {
        for (const v of [undefined, '', '   ']) {
            expect(parseSessionContext(v)).toEqual({ context: null, error: null });
        }
    });

    it('полный контекст — разобран как есть; пустая ревизия — ядро без контракта', () => {
        expect(parseSessionContext(raw(good))).toEqual({ context: good, error: null });
        const noSha = { ...good, coreRevision: '' };
        expect(parseSessionContext(raw(noSha))).toEqual({ context: noSha, error: null });
    });

    it.each([
        ['не JSON', '{', /не JSON/],
        ['не объект', '[1]', /не объект/],
        ['без корней', raw({ ...good, roots: undefined }), /нет roots/],
        ['без roots.execution', raw({ ...good, roots: { consumer: '/a' } }), /нет execution/],
        [
            'относительный корень',
            raw({ ...good, roots: { consumer: 'app', execution: '/b' } }),
            /roots\.consumer — не абсолютный/,
        ],
        ['loop строкой', raw({ ...good, loop: 'true' }), /loop — не булево/],
        ['пустой sessionId', raw({ ...good, sessionId: ' ' }), /sessionId/],
        ['ревизия не SHA', raw({ ...good, coreRevision: 'main' }), /coreRevision/],
        ['незнакомое поле', raw({ ...good, policy: {} }), /незнакомые policy/],
        [
            'незнакомое поле корней',
            raw({ ...good, roots: { ...good.roots, product: '/c' } }),
            /незнакомые product/,
        ],
    ])('%s — ошибка с причиной, контекста нет', (_what, value, why) => {
        const read = parseSessionContext(value);
        expect(read.context).toBeNull();
        expect(read.error).toMatch(why);
        expect(read.error).toContain(SESSION_CONTEXT_ENV);
    });

    it('readSessionContext читает переменную окружения', () => {
        expect(readSessionContext({ [SESSION_CONTEXT_ENV]: raw(good) }).context).toEqual(good);
        expect(readSessionContext({})).toEqual({ context: null, error: null });
    });
});

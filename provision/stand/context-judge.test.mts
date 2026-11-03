import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { judgeContext } from './context-judge.mts';

const expected = '{"ralphStandContext":"expected"}';
const stand = readFileSync(join(import.meta.dirname, '..', 'install-stand.sh'), 'utf8');

function functionBody(source: string, name: string): string {
    return source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? '';
}

describe('судья доставки контекста сессии', () => {
    it('все вызовы хука получили ожидаемое значение — PASS', () => {
        expect(judgeContext(`context ${expected}\ncontext ${expected}\n`, expected)).toEqual({
            verdict: 'PASS',
            why: '2 вызова хука получили ожидаемый контекст',
        });
    });

    it('отсутствие контекста хотя бы в одном вызове — FAIL', () => {
        expect(
            judgeContext(`context ${expected}\ncontext absent\ncontext ${expected}\n`, expected),
        ).toEqual({ verdict: 'FAIL', why: 'хук вызван без контекста сессии' });
    });

    it('другое значение хотя бы в одном вызове — FAIL', () => {
        expect(
            judgeContext(`context ${expected}\ncontext {"ralphStandContext":"other"}\n`, expected),
        ).toEqual({ verdict: 'FAIL', why: 'хук получил контекст, отличный от ожидаемого' });
    });

    it('строк context нет — INCONCLUSIVE', () => {
        expect(judgeContext('session started\nother context value\n', expected)).toEqual({
            verdict: 'INCONCLUSIVE',
            why: 'хук не вызван ни разу',
        });
    });

    it('пустой лог — INCONCLUSIVE', () => {
        expect(judgeContext('', expected)).toEqual({
            verdict: 'INCONCLUSIVE',
            why: 'хук не вызван ни разу',
        });
    });
});

describe('проба доставки контекста в стенде', () => {
    it('начальный docblock описывает session-context для всех CLI', () => {
        const probes = stand.match(/^# Пробы:\n([\s\S]*?)^#\n/m)?.[1] ?? '';
        const contextDoc = (
            probes.match(/^#   session-context —[^\n]*(?:\n#             [^\n]*)*/m)?.[0] ?? ''
        )
            .replace(/^# +/gm, '')
            .replace(/\s+/g, ' ');
        expect(contextDoc).toContain('claude, codex, kimi и opencode');
        expect(contextDoc).toContain('настоящий вызов внешнего хука');
        expect(contextDoc).toContain('RALPH_SESSION_CONTEXT');
        expect(contextDoc).toContain('случайным ожидаемым значением из окружения хоста');
    });

    it('общая probe_session-context объявлена для каждого из четырёх CLI', () => {
        const probe = functionBody(stand, 'probe_session-context');
        expect(probe).not.toBe('');
        expect(probe).toContain('"${CLI}_register" context.cjs');
        expect(probe).toContain('session session-context "$MARK"');
        for (const cli of ['claude', 'codex', 'kimi', 'opencode']) {
            expect(stand).toContain(`${cli}_register() {`);
            expect(stand).toContain(`${cli}_run() {`);
        }
    });

    it('случайное ожидаемое едет через окружение, а судья получает только имя его переменной', () => {
        const probe = functionBody(stand, 'probe_session-context');
        expect(probe).toContain('randomUUID');
        expect(probe).toContain('export RALPH_SESSION_CONTEXT=$RALPH_STAND_CONTEXT_EXPECTED');
        expect(probe).toContain('--pass-env RALPH_SESSION_CONTEXT');
        expect(probe).toContain('"$LOGS/canon.log" RALPH_STAND_CONTEXT_EXPECTED');
        expect(probe).toContain('unset RALPH_SESSION_CONTEXT');
    });

    it('prompt_for не получает маркер контекста', () => {
        const prompt = functionBody(stand, 'prompt_for');
        expect(prompt).not.toBe('');
        expect(prompt).not.toContain('RALPH_STAND_CONTEXT_EXPECTED');
        expect(prompt).not.toContain('RALPH_SESSION_CONTEXT');
    });
});

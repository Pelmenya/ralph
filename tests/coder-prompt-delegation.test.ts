// #225: правило «крупная правка не делегируется» в промпте кодер-сессии сверено с запретом.
//
// Правило держат флаг запуска и guard, а не текст. Но текст, разошедшийся с запретом, хуже его
// отсутствия: сессия, которой промпт разрешает инструмент, упирается в блок и жжёт ходы на
// обход. Поэтому промпт называет КАЖДЫЙ инструмент, который снимает флаг запуска (класс из
// описания пакета), и каждый названный там guard в сессии петли блокирует своим кодом.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decide } from '../.claude/hooks/guard-rules.cjs';
import { HARNESS_REGISTRY, loopDeniedTools } from '../adapters/harness-registry.ts';
import { RUNTIME_IDENTITIES } from '../adapters/runtime-profile.ts';

const CANON_ROOT = resolve(import.meta.dirname, '..');
const PROMPT = readFileSync(resolve(CANON_ROOT, 'ralph.md'), 'utf8');
const HEADING = '## Крупная правка не делегируется';

/** Раздел правила: от его заголовка до следующего заголовка второго уровня. */
function section(text: string): string {
    const start = text.indexOf(HEADING);
    if (start < 0) return '';
    const rest = text.slice(start + HEADING.length);
    const end = rest.search(/^## /m);
    return end < 0 ? rest : rest.slice(0, end);
}

/** Имена инструментов в обратных кавычках раздела, похожие на имя инструмента CLI. */
const namedTools = (text: string) =>
    [...text.matchAll(/`([A-Z][A-Za-z]+)`/g)].map((m) => m[1]).filter((n) => n !== 'Skill');

describe('промпт кодер-сессии (ralph.md): без делегирования (#225)', () => {
    const rule = section(PROMPT);
    const denied = loopDeniedTools(HARNESS_REGISTRY, RUNTIME_IDENTITIES.claude.harness);

    it('раздел правила есть и называет выход — коммит остатка и продолжение раннером', () => {
        expect(rule).not.toBe('');
        expect(rule).toMatch(/закоммить сделанное/);
        expect(rule).toMatch(/coderTurnRetries/);
        expect(rule).toMatch(/loop-delegation/);
    });

    it('называет каждый инструмент, который снимает флаг запуска', () => {
        expect(denied).toEqual(expect.arrayContaining(['Agent', 'ScheduleWakeup']));
        expect(denied.filter((t) => !namedTools(rule).includes(t))).toEqual([]);
    });

    it('каждый названный инструмент guard в сессии петли блокирует кодом loop-delegation', () => {
        const named = namedTools(rule);
        expect(named.length).toBeGreaterThan(0);
        for (const tool of named) {
            expect(decide(tool, {}, { loop: true }).code, tool).toBe('loop-delegation');
            expect(decide(tool, {}, { loop: false }).blocked, tool).toBe(false);
        }
    });

    it('от противного: раздел без инструмента флага — расхождение видно', () => {
        const cut = section(PROMPT.replaceAll('`ScheduleWakeup`', 'отложенный ход'));
        expect(denied.filter((t) => !namedTools(cut).includes(t))).toEqual(['ScheduleWakeup']);
        expect(section('# без раздела')).toBe('');
    });
});

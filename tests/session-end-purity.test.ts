// Барьер Фазы 16 (#112): в ядре нет регулярок по выводу сессии для решений о повторе.
//
// Ядро решало о повторе по тексту: лимит — `API_LIMIT_RE.test(output)`, бюджет ходов —
// `TURN_LIMIT_RE.test(fix.output)`, обрыв прокси — `isModelProxyUnavailable(reviewOutput)`.
// Текст меняется с каждой версией CLI и разный у харнессов, и регулярка, переставшая
// совпадать, молча превращала лимит в «упала». Теперь исход называет адаптер рантайма
// (`adapters/session-end.ts`), а ядро читает `endReason`. Правило держит код, а не чтение
// диффа: скан ниже краснеет, если регулярка по выводу сессии вернётся в ядро.
//
// Два класса, и каждый ловит то, чего не видит другой:
//   - ФОРМА: регулярка применена к значению, чьё имя говорит «вывод» (`output`,
//     `fix.output`, `reviewOutput`), — `.test(…)`/`.exec(…)` с ним аргументом либо
//     `.match`/`.search`/`.matchAll` на нём. Имя — единственное, что отличает вывод сессии от
//     вывода git, который ядро законно разбирает; поэтому скан и опирается на него;
//   - ИМЕНА: известные детекторы исхода по тексту (прежние экспорты ядра). Вызов через
//     функцию-обёртку формой не виден — `isModelProxyUnavailable(text)` не содержит ни
//     `.test(`, ни слова `output` в нужном месте.
// Предел назван: регулярка по выводу, спрятанная за новым именем и переменной без слова
// «output», мимо обоих классов пройдёт. Закрывает его не скан, а тип: решение о повторе
// принимает `SessionEndReason`, и вызывающим runClaude отдаёт исход вторым аргументом.
// Предел второй — набор файлов: скан читает только верхний уровень `core/*.ts`. Подкаталог
// ядра, если появится, и спавн-пути вне `core/` (`ralph.js`, `runtime/`) мимо него; новый
// каталог с решениями о повторе обязан встать в набор явно.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from './strip-comments.ts';

const CORE_DIR = resolve(import.meta.dirname, '..', 'core');

// Прежние детекторы исхода по тексту. Возвращение любого из них в ядро — регресс.
const FORBIDDEN_NAMES = [
    'API_LIMIT_RE',
    'TURN_LIMIT_RE',
    'RUNTIME_UNAVAILABLE_RE',
    'MODEL_PROXY_UNAVAILABLE_RE',
    'isRuntimeUnavailable',
    'isModelProxyUnavailable',
    'parseResetWaitMs',
];

// Регулярка, применённая к «выводу»: аргумент `.test(`/`.exec(` начинается с выражения,
// в имени которого есть `output`, либо `.match(`/`.search(`/`.matchAll(` зовётся на нём.
const REGEX_ON_OUTPUT = [
    /\.(?:test|exec)\(\s*[\w$.]*output[\w$]*\s*[),]/i,
    /\b[\w$]*output[\w$]*(?:\.[\w$]+)*\.(?:match|matchAll|search)\(/i,
];

export type TFinding = { file: string; line: number; text: string; why: string };

export function scanSource(file: string, src: string): TFinding[] {
    const out: TFinding[] = [];
    const lines = stripComments(src).split('\n');
    const names = new RegExp(`\\b(?:${FORBIDDEN_NAMES.join('|')})\\b`);
    lines.forEach((text, i) => {
        if (REGEX_ON_OUTPUT.some((re) => re.test(text))) {
            out.push({ file, line: i + 1, text: text.trim(), why: 'регулярка по выводу' });
        } else if (names.test(text)) {
            out.push({ file, line: i + 1, text: text.trim(), why: 'детектор исхода по тексту' });
        }
    });
    return out;
}

function coreSources(): string[] {
    return readdirSync(CORE_DIR)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .sort();
}

describe('в ядре нет регулярок по выводу сессии', () => {
    it('набор файлов ядра не пуст и включает оркестратор — пустой скан красный', () => {
        const files = coreSources();
        expect(files.length).toBeGreaterThan(10);
        expect(files).toContain('orchestrator.ts');
        expect(files).toContain('api-limit.ts');
        expect(files).toContain('runtime-availability.ts');
    });

    it('скан core/*.ts чист', () => {
        const findings = coreSources().flatMap((f) =>
            scanSource(`core/${f}`, readFileSync(join(CORE_DIR, f), 'utf8')),
        );
        expect(findings).toEqual([]);
    });
});

describe('скан от противного: подсунутый след краснеет', () => {
    it.each([
        ['if (code !== 0 && API_LIMIT_RE.test(output)) wait();', 'регулярка по выводу'],
        ['const hit = /usage limit/i.test(output);', 'регулярка по выводу'],
        ['if (TURN_LIMIT_RE.test(fix.output)) retry();', 'регулярка по выводу'],
        ['const m = LIMIT.exec(reviewOutput);', 'регулярка по выводу'],
        ['const m = lastOutput.match(/max turns/);', 'регулярка по выводу'],
        ['if (res.output.search(/limit/) >= 0) {}', 'регулярка по выводу'],
        ['if (isModelProxyUnavailable(text)) retry();', 'детектор исхода по тексту'],
        ["import { TURN_LIMIT_RE } from './api-limit.ts';", 'детектор исхода по тексту'],
        ['const ms = parseResetWaitMs(text) ?? fallback;', 'детектор исхода по тексту'],
    ])('%s', (line, why) => {
        const found = scanSource('core/x.ts', `const a = 1;\n${line}\n`);
        expect(found).toHaveLength(1);
        expect(found[0].line).toBe(2);
        expect(found[0].why).toBe(why);
    });

    it.each([
        // Решение по исходу — законная форма.
        "if (endReason === 'turn-limit') retry();",
        // Разбор вывода git — не вывод сессии.
        'const m = /^([0-9a-f]{40})$/.exec(stdout.trim());',
        'if (SAFE_SHA_RE.test(out)) return out;',
        // Упоминание в комментарии — история, а не код.
        '// прежде здесь было API_LIMIT_RE.test(output)',
        '/* TURN_LIMIT_RE.test(fix.output) */',
    ])('чисто: %s', (line) => {
        expect(scanSource('core/x.ts', `${line}\n`)).toEqual([]);
    });
});

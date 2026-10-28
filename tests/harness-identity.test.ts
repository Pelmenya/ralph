// Барьер: в `core/` нет ветвления по идентичности харнесса, у которого есть пакет (Фаза
// 16c, #180). Харнесс выбирает реестр (`adapters/harness-registry.ts`); имя пакета в коде
// ядра — это снова `switch` по харнессу, и каждый следующий CLI правил бы ядро.
//
// Классов два: имя харнесса строкой в коде (`'claude-code'` — так ветвились
// `case 'claude-code'`, `harness === 'claude-code'` и `GUARD_WIRED_HARNESSES`) и сравнение
// с константой харнесса настроек (`SESSION_SETTINGS_HARNESS`): константа из адаптеров
// прячет то же имя, и `h === SESSION_SETTINGS_HARNESS` было бы тем же ветвлением.
// Комментарии снимаются до скана: докблок вправе назвать харнесс, о котором говорит.
//
// Список имён — пакеты, которые реестр принял, а не перечень здесь: пакет, снятый с моста
// (#181, #213), попадает под барьер сам.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_REGISTRY } from '../adapters/harness-registry.ts';
import { CANON_ROOT, codeFiles } from './harness-package-deps.ts';
import { stripComments } from './strip-comments.ts';

const SETTINGS_COMPARE_RE =
    /(?:===|!==|==|!=)\s*SESSION_SETTINGS_HARNESS\b|\bSESSION_SETTINGS_HARNESS\s*(?:===|!==|==|!=)|\bcase\s+SESSION_SETTINGS_HARNESS\b/;

type TViolation = { file: string; line: number; text: string };

function identityBranches(file: string, source: string, names: readonly string[]): TViolation[] {
    const literals = names.map(
        (n) => new RegExp(`(['"\`])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`),
    );
    const out: TViolation[] = [];
    stripComments(source, { dropTrailing: true })
        .split('\n')
        .forEach((text, i) => {
            if (literals.some((re) => re.test(text)) || SETTINGS_COMPARE_RE.test(text)) {
                out.push({ file, line: i + 1, text: text.trim() });
            }
        });
    return out;
}

const NAMES = [...HARNESS_REGISTRY.packages.keys()];
const FILES = codeFiles('core').filter((f) => !/\.test\.m?ts$/.test(f));

describe('core/ не ветвится по харнессу пакета', () => {
    it('реестр принял пакеты, и в core/ есть что сканировать', () => {
        expect(NAMES).toEqual(
            expect.arrayContaining(['claude-code', 'codex', 'kimi-code', 'opencode']),
        );
        expect(FILES.length).toBeGreaterThan(20);
    });

    it('нарушений нет', () => {
        const found = FILES.flatMap((f) =>
            identityBranches(f, readFileSync(join(CANON_ROOT, f), 'utf-8'), NAMES),
        );
        expect(found).toEqual([]);
    });
});

describe('скан на подсунутом следе', () => {
    it.each([
        `    case 'claude-code':`,
        `const x = harness === "claude-code";`,
        'export const S = new Set([`claude-code`]);',
        `if (h !== SESSION_SETTINGS_HARNESS) return;`,
        `if (SESSION_SETTINGS_HARNESS === h) return;`,
        `    case SESSION_SETTINGS_HARNESS:`,
    ])('ловит: %s', (line) => {
        expect(identityBranches('core/x.ts', line, ['claude-code'])).toHaveLength(1);
    });

    it.each([
        `// case 'claude-code': в комментарии`,
        `/** «claude-code» в докблоке */`,
        `const all = [SESSION_SETTINGS_HARNESS, ...rest];`,
        `const id = 'claude-code-extra';`,
    ])('не ловит: %s', (line) => {
        expect(identityBranches('core/x.ts', line, ['claude-code'])).toEqual([]);
    });
});

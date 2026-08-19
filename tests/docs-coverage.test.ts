// Барьер: документация по папкам не отстаёт от дерева.
//
// Зачем чеком, а не разовой уборкой. Папка с правилами появляется вместе с первым модулем,
// а `AGENTS.md` в ней — «когда-нибудь»: следующий агент открывает каталог и работает по
// догадке. Обратная беда тише и хуже — ссылка в доке на файл, который переехал или так и
// не появился: она читается как утверждение о дереве и потому ей верят. Ни то, ни другое
// не ловится ревью: диффа у отсутствующего файла нет.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const CANON_ROOT = resolve(import.meta.dirname, '..');

function tracked(): string[] {
    const ls = spawnSync('git', ['-C', CANON_ROOT, 'ls-files'], { encoding: 'utf-8' });
    if (ls.status !== 0) {
        throw new Error(`git ls-files в ${CANON_ROOT} не отработал: ${ls.stderr || ls.error}`);
    }
    return ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .sort();
}

const TRACKED = tracked();

// Папки первого уровня, в которых лежит код. Глубже не спускаемся намеренно: правила
// формулируются на уровне зоны ответственности (`core/`, `adapters/`, …), а не каждого
// вложенного каталога — иначе `__fixtures__` потребовал бы собственных правил.
const CODE_DIRS = [
    ...new Set(
        TRACKED.filter((rel) => /\.(js|ts|mjs|mts)$/.test(rel) && rel.includes('/')).map(
            (rel) => rel.split('/')[0],
        ),
    ),
].sort();

describe('документация по папкам', () => {
    it('набор папок с кодом непуст — иначе проверка ниже проверяет пустоту', () => {
        expect(CODE_DIRS.length).toBeGreaterThan(3);
        expect(CODE_DIRS).toContain('core');
    });

    it.each(CODE_DIRS)('%s/ — есть AGENTS.md с правилами папки', (dir) => {
        const path = join(CANON_ROOT, dir, 'AGENTS.md');
        expect(existsSync(path), `нет ${dir}/AGENTS.md — правила папки негде прочитать`).toBe(true);
        // Файл-заглушка хуже отсутствующего: он выглядит как «правила есть».
        expect(readFileSync(path, 'utf-8').trim().length).toBeGreaterThan(200);
    });

    it('в корне есть AGENTS.md, а CLAUDE.md на него ссылается', () => {
        expect(existsSync(join(CANON_ROOT, 'AGENTS.md'))).toBe(true);
        // Правила живут в ОДНОМ месте: два файла с одним содержимым расходятся молча, и
        // половина агентов начинает работать по устаревшей копии.
        expect(readFileSync(join(CANON_ROOT, 'CLAUDE.md'), 'utf-8')).toMatch(/AGENTS\.md/);
    });
});

describe('ссылки в доках ведут на существующие файлы', () => {
    const DOCS = TRACKED.filter((rel) => rel.endsWith('.md'));

    it('доки вообще есть', () => {
        expect(DOCS).toContain('README.md');
        expect(DOCS).toContain('AGENTS.md');
    });

    it.each(DOCS)('%s — ни одной битой относительной ссылки', (rel) => {
        const text = readFileSync(join(CANON_ROOT, rel), 'utf-8');
        // Только относительные ссылки на файлы дерева: внешние URL и якоря внутри страницы
        // этот барьер не проверяет — ходить в сеть тестом нельзя, а якоря живут в разметке.
        const targets = [...text.matchAll(/\]\(([^)#\s]+)\)/g)]
            .map((m) => m[1])
            .filter((href) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/'));
        const broken = targets.filter(
            (href) => !existsSync(resolve(CANON_ROOT, dirname(rel), href)),
        );
        expect(broken, `битые ссылки в ${rel}`).toEqual([]);
    });
});

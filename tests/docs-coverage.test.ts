// Барьер: документация по папкам не отстаёт ни от дерева, ни от самой себя.
//
// Зачем чеком, а не разовой уборкой. Папка с правилами появляется вместе с первым модулем,
// а доки в ней — «когда-нибудь»: следующий агент открывает каталог и работает по догадке.
// Обратная беда тише и хуже — ссылка в доке на файл, который переехал или так и не
// появился: она читается как утверждение о дереве и потому ей верят. Ни то, ни другое не
// ловится ревью: диффа у отсутствующего файла нет.
//
// Третья беда — расхождение ПАРЫ. Правила лежат под двумя именами (`CLAUDE.md` читает
// Claude Code, `AGENTS.md` — остальные площадки), и написанные руками копии расходятся
// молча: правку вносят в одну, половина агентов продолжает работать по второй. Поэтому
// источник один, второе имя генерируется (`docs-sync.mts`), а здесь сверяется равенством.
// Хук `.claude/hooks/sync-docs.cjs` пересобирает копию сразу после правки, но барьером не
// является: правка руками, другим инструментом или из CI приезжает мимо него.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
    docDirs,
    docDirsFromFiles,
    docPairs,
    expectedAgents,
    isStale,
    renderAgents,
} from '../docs-sync.mts';

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

// Набор папок с правилами считает генератор — тот же, что собирает копии. Второе
// перечисление здесь разъехалось бы с ним ровно в день появления новой папки: сверка
// прошла бы по старому списку и промолчала о папке без доков.
const DOC_DIRS = docDirs(CANON_ROOT);
const CODE_DIRS = DOC_DIRS.filter((dir) => dir !== '.');

describe('документация по папкам', () => {
    it('набор папок с кодом непуст — иначе проверка ниже проверяет пустоту', () => {
        expect(CODE_DIRS.length).toBeGreaterThan(3);
        expect(CODE_DIRS).toContain('core');
    });

    it.each(CODE_DIRS)('%s/ — есть CLAUDE.md с правилами папки', (dir) => {
        const path = join(CANON_ROOT, dir, 'CLAUDE.md');
        expect(existsSync(path), `нет ${dir}/CLAUDE.md — правила папки негде прочитать`).toBe(true);
        // Файл-заглушка хуже отсутствующего: он выглядит как «правила есть».
        expect(readFileSync(path, 'utf-8').trim().length).toBeGreaterThan(200);
    });

    it('в корне есть CLAUDE.md — на него ссылается всё остальное', () => {
        expect(existsSync(join(CANON_ROOT, 'CLAUDE.md'))).toBe(true);
    });

    // От противного: правило «папка без доков красит гейт» проживёт до первого нового
    // модуля, если набор папок перечислен руками. Здесь проверяется, что он СЧИТАЕТСЯ по
    // дереву — новая папка с кодом попадает в него сама, ещё не имея ни одного дока.
    it('новая папка с кодом попадает в набор сама — и потому потребует доков', () => {
        const dirs = docDirsFromFiles(['core/gate.ts', 'brand-new/thing.ts', 'README.md']);
        expect(dirs).toContain('brand-new');
        // Корень в наборе всегда, файл верхнего уровня своей папки не образует.
        expect(dirs).toEqual(['.', 'brand-new', 'core']);
    });

    it('не-код папку не образует: доки требуются от кода, а не от данных', () => {
        expect(docDirsFromFiles(['fixtures/config.json', 'docs/note.md'])).toEqual(['.']);
    });
});

describe('пара CLAUDE.md ↔ AGENTS.md не разъехалась', () => {
    it.each(DOC_DIRS)('%s — AGENTS.md совпадает с генерацией из CLAUDE.md', (dir) => {
        const pair = docPairs(CANON_ROOT).find((p) => p.dir === dir)!;
        expect(
            existsSync(pair.generated),
            `нет ${dir}/AGENTS.md — пересобери: npm run docs:sync`,
        ).toBe(true);
        expect(
            readFileSync(pair.generated, 'utf-8'),
            `${dir}/AGENTS.md разъехался с CLAUDE.md — пересобери: npm run docs:sync`,
        ).toBe(expectedAgents(pair));
    });

    // Хук и точка его подключения проверяются вместе: удали блок из настроек — и хук
    // останется в репозитории нетронутым, просто перестанет вызываться.
    it('хук пересборки подключён и лежит на месте', () => {
        const hook = '.claude/hooks/sync-docs.cjs';
        expect(existsSync(join(CANON_ROOT, hook)), `нет ${hook}`).toBe(true);
        const settings = JSON.parse(
            readFileSync(join(CANON_ROOT, '.claude', 'settings.json'), 'utf-8'),
        );
        const post = JSON.stringify(settings.hooks?.PostToolUse ?? []);
        expect(post, 'хук пересборки доков не подключён в .claude/settings.json').toContain(
            'sync-docs.cjs',
        );
        expect(post, 'хук не ловит правку файла — проверь matcher').toMatch(/Write|Edit/);
    });
});

// Барьер проверяется «от противного»: сверка, которая ни разу не краснела, может не
// работать вовсе — например, сравнивать файл сам с собой.
describe('генератор доков — на подсунутом расхождении', () => {
    const SOURCE = ['# Пример', '', 'Правила рядом — в [соседней папке](core/CLAUDE.md).'].join(
        '\n',
    );

    it('шапка «не правь руками» стоит первой строкой', () => {
        expect(renderAgents(SOURCE).startsWith('<!--')).toBe(true);
        expect(renderAgents(SOURCE)).toMatch(/СГЕНЕРИРОВАНО из CLAUDE\.md/);
    });

    it('цель относительной ссылки переезжает на второе имя, подпись — нет', () => {
        const out = renderAgents(SOURCE);
        expect(out).toContain('[соседней папке](core/AGENTS.md)');
        expect(out).not.toContain('](core/CLAUDE.md)');
    });

    it('внешняя ссылка на файл с тем же именем не трогается', () => {
        const out = renderAgents('см. [шаблон](https://example.com/tpl/CLAUDE.md)');
        expect(out).toContain('https://example.com/tpl/CLAUDE.md');
    });

    it('расхождение видно, совпадение — нет', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ralph-docs-'));
        const pair = { dir, source: join(dir, 'CLAUDE.md'), generated: join(dir, 'AGENTS.md') };
        writeFileSync(pair.source, SOURCE);

        expect(isStale(pair), 'отсутствующая копия обязана считаться расхождением').toBe(true);

        writeFileSync(pair.generated, expectedAgents(pair));
        expect(isStale(pair)).toBe(false);

        writeFileSync(pair.generated, `${expectedAgents(pair)}\nправка мимо источника\n`);
        expect(isStale(pair), 'правка копии руками обязана краснеть').toBe(true);
    });

    it('нет источника — отказ, а не «нечего генерировать»', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ralph-docs-'));
        expect(() =>
            expectedAgents({
                dir,
                source: join(dir, 'CLAUDE.md'),
                generated: join(dir, 'AGENTS.md'),
            }),
        ).toThrow(/CLAUDE\.md/);
    });
});

describe('ссылки в доках ведут на существующие файлы', () => {
    const DOCS = TRACKED.filter((rel) => rel.endsWith('.md'));

    it('доки вообще есть', () => {
        expect(DOCS).toContain('README.md');
        expect(DOCS).toContain('CLAUDE.md');
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

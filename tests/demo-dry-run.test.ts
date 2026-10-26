// Канон, задача 89: демо-проект — путь входа для человека со стороны. Шаблон лежит в
// `examples/demo/`, и пользователь копирует его в свой репозиторий по `docs/demo.md`, не
// зная внутренностей ядра. Значит, всё, что в шаблоне может разойтись с ядром, обязано
// краснеть ЗДЕСЬ, а не на его dry-run: конфиг, который ядро отвергнет, карточки не той
// вехи или с меткой мимо роутинга, гейт с командой, которой нет в `package.json`, проводка
// барьера, которую проба на старте не пропустит. Каждое из этого человек со стороны
// увидел бы отказом без объяснения, где его искать.
//
// Цикл тот же, что у барьера переносимости (`porting-dry-run.test.ts`): настоящие
// resolveProfile, preflight и dry-проход runLoop, всё, что ходит в форж, подменено.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtureRuntime, loadConfigForLoop, runFixtureLoop } from './test-helpers.ts';
import { checkGuardWiring, GUARD_FILE } from '../.claude/hooks/guard-wiring.ts';

const CANON = path.resolve(import.meta.dirname, '..');
const DEMO = path.join(CANON, 'examples', 'demo');
const DEMO_CONFIG = path.join(DEMO, '.claude', 'ralph', 'ralph.config.json');

const readJson = (p: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;

type TCard = { file: string; title: string; milestone: string; labels: string[]; body: string };

/**
 * Карточка демо: YAML-шапка из трёх ключей и тело. Разбор узкий намеренно — формат задаём
 * мы сами, и шапка, которую он не понял, должна быть отказом, а не пустым полем.
 */
function parseCard(file: string, text: string): TCard {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!m) throw new Error(`${file}: нет YAML-шапки`);
    const field = (key: string): string => {
        const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(m[1]);
        if (!hit) throw new Error(`${file}: в шапке нет ключа ${key}`);
        return hit[1].trim();
    };
    const unquote = (v: string) => v.replace(/^'(.*)'$/, '$1');
    const labelsRaw = /^\[(.*)\]$/.exec(field('labels'));
    if (!labelsRaw) throw new Error(`${file}: labels — не список в скобках`);
    return {
        file,
        title: unquote(field('title')),
        milestone: unquote(field('milestone')),
        labels: labelsRaw[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        body: m[2],
    };
}

function loadCards(): TCard[] {
    const dir = path.join(DEMO, 'cards');
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => parseCard(f, fs.readFileSync(path.join(dir, f), 'utf-8')));
}

/** Метки из раздела «Допустимые метки» проектной половины промпта демо. */
function allowedLabels(): string[] {
    const text = fs.readFileSync(path.join(DEMO, '.claude', 'ralph', 'ralph.project.md'), 'utf-8');
    const section = /## Допустимые метки\n([\s\S]*?)(?:\n## |$)/.exec(text);
    if (!section) throw new Error('ralph.project.md демо: нет раздела «Допустимые метки»');
    return [...section[1].matchAll(/^- `([^`]+)`/gm)].map((h) => h[1]);
}

describe('демо: конфиг проходит настоящий цикл ядра (задача 89)', () => {
    it('resolveProfile + preflight + dry-проход планируют фазу демо', () => {
        const runtime = buildFixtureRuntime();
        const cfg = loadConfigForLoop(runtime, DEMO_CONFIG, 'demo');
        const { runClaudeCalls, openIssuesCalls, ctx } = runFixtureLoop(runtime, cfg);

        const milestone = (cfg.phases as Array<{ milestone: string }>)[0].milestone;
        expect(ctx.state.milestone).toBe(milestone);
        expect(openIssuesCalls).toEqual([milestone]);
        expect(runClaudeCalls).toHaveLength(1);
        // Промпт обязан назвать переносимую половину контракта: без неё сессия не знает
        // про файл намерений и закрыть карточку не сможет.
        expect(runClaudeCalls[0].prompt).toContain('ralph.md');
        expect(runClaudeCalls[0].prompt).toContain('ralph.project.md');
    });

    it('шов форжа — SourceCraft, деплоя нет, внешнего CI гейт не ждёт', () => {
        const common = readJson(DEMO_CONFIG).common as Record<string, unknown>;
        expect(common.adapters).toMatchObject({ taskSource: 'sourcecraft', deployCheck: 'none' });
        expect((common.gate as Record<string, unknown>).externalCi).toBe('disabled');
    });

    it('в конфиге нет абсолютных путей: секция roots — дело установки, а не шаблона', () => {
        const raw = fs.readFileSync(DEMO_CONFIG, 'utf-8');
        expect(readJson(DEMO_CONFIG).common).not.toHaveProperty('roots');
        expect(raw).not.toMatch(/"\/[a-z]/i);
    });
});

describe('демо: гейт детерминирован', () => {
    const pkg = readJson(path.join(DEMO, 'package.json'));
    const scripts = pkg.scripts as Record<string, string>;
    const gate = (readJson(DEMO_CONFIG).common as { gate: { checks: Array<[string, string]> } })
        .gate;

    it('зависимостей нет — гейту нечего тянуть из сети', () => {
        expect(pkg).not.toHaveProperty('dependencies');
        expect(pkg).not.toHaveProperty('devDependencies');
    });

    it('каждый чек гейта — скрипт из package.json демо', () => {
        expect(gate.checks.length).toBeGreaterThan(0);
        for (const [, cmd] of gate.checks) {
            const name = /^npm (?:run )?(\S+)$/.exec(cmd)?.[1];
            expect(name, `чек «${cmd}» — не npm-скрипт`).toBeTruthy();
            expect(scripts, `скрипта ${name} нет в package.json`).toHaveProperty(name as string);
        }
    });

    // Проверки выше видят только ИМЕНА скриптов. Сам гейт демо — `node --check` модуля и
    // его тесты на `node:test` — vitest канона не исполняет (include — только *.test.ts|mts),
    // и сломанный модуль или красный тест шаблона прошли бы здесь зелёным, а покраснели бы
    // уже в демо-репозитории пользователя. Процесс `node --test` тест запустить не вправе
    // (предохранитель побочек), поэтому тесты шаблона исполняются здесь же: `node:test`
    // подменён сборщиком кейсов, файл тестов импортируется как есть — синтаксис модуля
    // проверяет сам импорт, а ожидания не дублируются копией, которая разъехалась бы.
    it('тесты шаблона исполняются и зелёные — тот же файл, что гоняет `npm test`', async () => {
        const testDir = path.join(DEMO, 'test');
        const files = fs.readdirSync(testDir).filter((n) => n.endsWith('.test.mjs'));
        const cases: Array<{ name: string; fn: () => unknown }> = [];
        vi.doMock('node:test', () => ({
            test: (name: string, fn: () => unknown) => cases.push({ name, fn }),
        }));
        try {
            for (const f of files) await import(path.join(testDir, f));
        } finally {
            vi.doUnmock('node:test');
        }
        expect(cases.length, 'в шаблоне не нашлось ни одного теста').toBeGreaterThan(0);
        // Подмена обязана перехватить КАЖДЫЙ кейс: не сработай она, кейсы ушли бы в
        // настоящий `node:test`, которого здесь никто не запускает, — и тест был бы зелёным
        // при любом коде шаблона.
        const declared = files
            .map((f) => fs.readFileSync(path.join(testDir, f), 'utf-8'))
            .join('\n')
            .match(/^test\(/gm);
        expect(cases).toHaveLength(declared?.length ?? 0);
        for (const c of cases) await c.fn();
    });
});

describe('демо: две карточки в одной вехе', () => {
    const cards = loadCards();
    const common = readJson(DEMO_CONFIG).common as {
        phases: Array<{ milestone: string }>;
        modelRouting: { labels: Record<string, string> };
    };

    it('карточек ровно две, обе в вехе единственной фазы конфига', () => {
        expect(cards).toHaveLength(2);
        expect(common.phases).toHaveLength(1);
        for (const c of cards) expect(c.milestone, c.file).toBe(common.phases[0].milestone);
    });

    it('у каждой ровно одна метка сложности из роутинга, все метки — из допустимых', () => {
        const allowed = allowedLabels();
        expect(allowed.length).toBeGreaterThan(0);
        for (const c of cards) {
            const complexity = c.labels.filter((l) => l.startsWith('complexity:'));
            expect(complexity, c.file).toHaveLength(1);
            expect(common.modelRouting.labels, c.file).toHaveProperty(complexity[0]);
            for (const l of c.labels) expect(allowed, `${c.file}: ${l}`).toContain(l);
        }
    });

    it('у каждой есть проверяемые критерии готовности', () => {
        for (const c of cards) {
            const criteria = /## Критерии готовности\n([\s\S]*)$/.exec(c.body)?.[1] ?? '';
            expect(criteria.match(/^- \[ \] /gm)?.length ?? 0, c.file).toBeGreaterThan(0);
        }
    });

    it('разбор шапки краснеет на карточке без меток (от противного)', () => {
        expect(() => parseCard('x.md', "---\ntitle: 'a'\nmilestone: 'b'\n---\nтело")).toThrow(
            /labels/,
        );
    });
});

describe('демо: барьер сессий подключён так, что проба на старте его пропустит', () => {
    it('проводка guard сходится с конфигом демо под bypassPermissions', () => {
        // Файла барьера в шаблоне нет: инструкция копирует его из установки ядра, то есть
        // из этого же каталога хуков. Сверяем, что источник копии существует.
        const guardSource = path.join(CANON, '.claude', 'hooks', GUARD_FILE);
        const problems = checkGuardWiring({
            settings: readJson(path.join(DEMO, '.claude', 'settings.json')),
            ralphConfig: readJson(DEMO_CONFIG),
            guardExists: fs.existsSync(guardSource),
        });
        expect(problems).toEqual([]);
    });

    it('инструкция установки копирует хуки и ralph.md из установки ядра', () => {
        const doc = fs.readFileSync(path.join(CANON, 'docs', 'demo.md'), 'utf-8');
        expect(doc).toContain('.claude/hooks/');
        expect(doc).toMatch(/cp [^\n]*ralph\.md/);
        expect(doc).toContain('--dry-run');
    });
});

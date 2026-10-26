// Гейт канона идёт на ЧИСТОМ клоне: `npm ci && npm run gate` в пустом каталоге, без
// единого файла проектов рядом. Держится это не на дисциплине, а на том, что в коде нет
// якоря, смотрящего НАРУЖУ репозитория, — файла потребителя, домашнего каталога машины,
// пути от места запуска. Такая зависимость не ломает прогон там, где нужный файл рядом
// лежит: на машине автора всё зелено, а на чистом клоне красно — то есть обнаруживается
// она позже всех и дороже всех.
//
// Три класса, и каждый — способ выйти за корень:
//   1. `process.cwd()` — путь от МЕСТА ЗАПУСКА. Ядро гоняется и своим клоном, и каталогом
//      внутри потребителя; CWD в этих раскладках разный, а каталог модуля один и тот же.
//   2. домашний каталог машины — то же самое, только адресуется машиной, а не запуском.
//   3. `resolve(X, '..', '..')` — выход ВЫШЕ корня ядра. У потребителя там лежит его
//      дерево, у канона — что попало: каталог клона, /tmp, домашний каталог CI.
//
// Долг назван поимённо и числом (тот же храповик, что у core-purity): у каждой строки
// ниже есть причина, но каждая — обещание, которое канон пока не держит. Число сверяется
// РАВЕНСТВОМ: просядет — опусти его здесь же, вырастет — верни якорь в каталог модуля.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { stripComments } from './strip-comments.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

const CANON_ROOT = resolve(import.meta.dirname, '..');

const CODE_EXT = /\.(js|ts|mjs|mts|cjs)$/;
// `provision/` — контурная обвязка (при переносе заменяется своей), `.claude/` — обвязка
// сессии конкретного клиента, а не продукт. Обе законно знают про машину, на которой
// стоят, и требовать от них замкнутости значило бы краснеть на том, что каноном не едет.
const SKIP_DIRS = new Set(['provision', '.claude', '__fixtures__', 'node_modules']);
// Этот файл держит образцы всех трёх классов в проверках — сканировать его собой значит
// краснеть на собственных пробах. Тот же приём, что у соседних сканов.
const SELF = 'tests/outside-deps.test.ts';

/** Файлы репозитория — из `git ls-files`. Fail-closed: git молчит — бросаем. */
function trackedCode(): string[] {
    const ls = spawnSync('git', ['-C', CANON_ROOT, 'ls-files'], { encoding: 'utf-8' });
    if (ls.status !== 0) {
        throw new Error(`git ls-files в ${CANON_ROOT} не отработал: ${ls.stderr || ls.error}`);
    }
    return ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(
            (rel) =>
                rel !== '' &&
                rel !== SELF &&
                CODE_EXT.test(rel) &&
                !rel
                    .split(sep)
                    .slice(0, -1)
                    .some((d) => SKIP_DIRS.has(d)),
        )
        .sort();
}

const FILES = trackedCode();

type TOutsideClass = { name: string; what: string; instead: string; re: RegExp };

export const OUTSIDE_CLASSES: readonly TOutsideClass[] = [
    {
        name: 'cwd-anchor',
        what: 'путь от места запуска, а не от каталога модуля',
        instead: '`import.meta.dirname` (или явный параметр корня)',
        re: /process\.cwd\(\)/,
    },
    {
        name: 'home-dir',
        what: 'домашний каталог машины, на которой идёт прогон',
        instead: 'путь внутри репозитория либо параметр окружения с явным дефолтом',
        re: /os\.homedir\(\)|\bhomedir\(\)|process\.env\.HOME\b/,
    },
    {
        name: 'double-dirname',
        what:
            'подъём каталогом-обёрткой: `dirname(dirname(x))` уводит выше корня так же,\n' +
            '  как строковый `..`, только строкового литерала в нём нет вовсе',
        instead: 'путь от каталога модуля вниз',
        re: /\bdirname\(\s*dirname\(/,
    },
];

/**
 * Подъёмы `..` в строковых литералах строки.
 *
 * Считаем СЕГМЕНТЫ пути внутри литерала, а не вхождения подстроки: `'../ralph.js'` — это
 * один подъём, `'../..'` — два, а `` `${SHA}..origin/feature/x` `` — git-ревизия, где
 * подъёмов нет вовсе. Наивный regex по `..` считал бы ревизию путём и краснел на ней.
 */
export function upsInLine(line: string): number {
    let ups = 0;
    for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        ups += m[2].split('/').filter((seg) => seg === '..').length;
    }
    return ups;
}

/**
 * Находки классов в КОДЕ файла (комментарии сняты: объяснение — не зависимость).
 *
 * `depth` — глубина файла от корня репозитория, и без неё скан либо слеп, либо криклив.
 * Один и тот же `resolve(import.meta.dirname, '..')` из `core/` ведёт В КОРЕНЬ ядра
 * (законно, так собран каждый второй импорт), а из файла корня — уже НАРУЖУ. Считать
 * форму без учёта места — значит либо пропустить второе, либо запретить первое.
 *
 * `dropTrailing: true` — в отличие от соседнего скана ЗНАЧЕНИЙ: здесь ищется КОНСТРУКЦИЯ,
 * и пометка `// раньше тут стоял process.cwd()` после кода не должна её изображать.
 */
export function outsideHits(src: string, depth = 0): Array<readonly [number, string, string]> {
    const code = stripComments(src, { dropTrailing: true });
    const out: Array<readonly [number, string, string]> = [];
    code.split('\n').forEach((line, i) => {
        for (const cls of OUTSIDE_CLASSES) {
            if (cls.re.test(line)) out.push([i + 1, cls.name, line.trim()] as const);
        }
        // Подъём считается ОТНОСИТЕЛЬНО места файла: выше корня — находка, до корня —
        // обычный импорт соседнего модуля.
        if (upsInLine(line) > depth) out.push([i + 1, 'above-root', line.trim()] as const);
    });
    return out;
}

/** Глубина файла от корня: `core/gate.ts` → 1, `gate.mts` → 0. */
export function depthOf(rel: string): number {
    return rel.split('/').length - 1;
}

// Известный долг: где якорь наружу ещё остался и почему.
//   `core/orchestrator.ts` — рабочее дерево раннера в логе (место запуска там и есть
//   предмет сообщения) и `CODEX_HOME` при спавне кодера: домашний каталог принадлежит
//   инструменту, а не нам.
//   `core/worktree.ts` — дефолт параметра `repoRoot`; вызывающий его задаёт, дефолт
//   остаётся страховкой.
//   `runtime/monitor-panel.mts` — REPO_DIR потребителя: панель показывает ЕГО доску.
//   Уходит вместе с переездом состояния в `runtimeDir` (фаза контракта корней).
// Долг назван ПО КЛАССАМ, а не одним числом на файл: суммарный счёт остаётся прежним,
// если убрать оправданный `process.cwd()` и добавить чтение домашнего каталога — барьер
// молчит, а причина, записанная выше, становится ложью о коде (ревью !17).
const DEBT: Record<string, Record<string, number>> = {
    'core/orchestrator.ts': { 'cwd-anchor': 1, 'home-dir': 1 },
    'core/worktree.ts': { 'cwd-anchor': 2 },
    'runtime/monitor-panel.mts': { 'above-root': 1 },
};

// Пробы ЧУЖИХ барьеров: файлы, где путь наружу лежит НАМЕРЕННО — образцом, который
// сторожевой код обязан отвергнуть. Это не долг и не исключение «по недосмотру»: убрать
// такой путь значит убить проверку. Отдельный список именно поэтому — долг когда-нибудь
// гасят, а проба остаётся навсегда, и смешивать их значило бы врать о том и о другом.
// Причина обязательна, а протухшая запись красит тест (см. ниже): список исключений,
// который никто не сверяет с деревом, превращается в тихий обход барьера.
const PROBES: Record<string, string> = {
    'core/session-requests.test.ts':
        'образец `../../secrets.env` — тест требует, чтобы ядро отвергло путь за корень',
};

/** Находки, свёрнутые в счёт по классам — в той же форме, в какой записан долг. */
function byClass(hits: ReadonlyArray<readonly [number, string, string]>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [, cls] of hits) out[cls] = (out[cls] ?? 0) + 1;
    return out;
}

describe('гейт идёт на чистом клоне: без якорей наружу репозитория', () => {
    it('скан видит дерево целиком, а долг назван по существующим файлам', () => {
        // Опечатка в фильтре превратила бы `it.each` в пустой набор — сьют остался бы
        // зелёным, не прочитав ни одного файла.
        expect(FILES.length).toBeGreaterThan(20);
        expect(FILES).toContain(join('core', 'orchestrator.ts'));
        for (const rel of Object.keys(DEBT)) {
            expect(FILES, `в долге назван файл ${rel}, которого нет в скане`).toContain(rel);
        }
    });

    it.each(Object.keys(PROBES))('%s — проба чужого барьера на месте, а не протухла', (rel) => {
        // Исключение обязано быть НУЖНЫМ: образец убрали, а запись осталась — и файл
        // молча выпал из скана, оставшись в списке разрешённых навсегда.
        expect(
            outsideHits(readFileSync(join(CANON_ROOT, rel), 'utf-8'), depthOf(rel)).length,
            `${rel} больше не содержит образца пути наружу — удали запись из PROBES`,
        ).toBeGreaterThan(0);
    });

    it.each(FILES)('%s — якоря наружу только в пределах известного долга', (rel) => {
        if (rel in PROBES) return;
        const hits = outsideHits(readFileSync(join(CANON_ROOT, rel), 'utf-8'), depthOf(rel));
        const detail = hits.map(([n, cls, line]) => `\n  ${n} (${cls}): ${line}`).join('');
        const budget = DEBT[rel] ?? {};
        expect(
            byClass(hits),
            Object.keys(budget).length === 0
                ? `Зависимость от файла вне репозитория в ${rel} — на чистом клоне её нет:${detail}`
                : `Долг ${rel} изменился по классам:${detail}`,
        ).toEqual(budget);
    });
});

// Барьер проверяется МУТАЦИЕЙ: скан, который ни разу не краснел, может не работать вовсе.
describe('подсунутая зависимость от файла вне репозитория — от противного', () => {
    // Модуль без долга: краснота на нём приходит от подсунутой строки, а не от того,
    // что там и так лежит якорь.
    const CLEAN = join('core', 'gate.ts');
    const cleanCode = () => readFileSync(join(CANON_ROOT, CLEAN), 'utf-8');

    it('контроль: модуль пробы сегодня замкнут — иначе проба ничего не значит', () => {
        expect(DEBT[CLEAN] ?? 0).toBe(0);
        expect(outsideHits(cleanCode(), depthOf(CLEAN))).toEqual([]);
    });

    it.each([
        [
            'путь от места запуска',
            "const cfg = readFileSync(join(process.cwd(), 'ralph.config.json'));",
        ],
        ['домашний каталог машины', "const cfg = join(os.homedir(), '.ralph', 'config.json');"],
        ['переменная HOME', "const cfg = join(process.env.HOME, '.ralph');"],
        ['выход выше корня ядра', "const repo = resolve(import.meta.dirname, '..', '..');"],
        // Формы подъёма, которые проехали бы мимо посегментного поиска пары `'..', '..'`
        // (ревью !17): склеенный литерал и подъём каталогом-обёрткой.
        ['подъём одним литералом', "const repo = resolve(import.meta.dirname, '../..');"],
        ['подъём каталогом-обёрткой', 'const repo = dirname(dirname(import.meta.dirname));'],
        [
            'подъём с продолжением пути',
            "const cfg = join(import.meta.dirname, '../../ralph.config.json');",
        ],
    ])('%s — красит скан замкнутого модуля', (_name, snippet) => {
        expect(
            outsideHits(`${cleanCode()}\n${snippet}\n`, depthOf(CLEAN)).length,
            `Якорь наружу проехал мимо барьера: ${snippet}`,
        ).toBeGreaterThan(0);
    });

    it('объяснение в комментарии зависимостью не считается', () => {
        // Иначе барьер запретил бы РАССКАЗЫВАТЬ о нём же — а докблоки ядра именно этим и
        // заняты: называют инцидент, из которого модуль вырос.
        expect(outsideHits('// раньше здесь стоял process.cwd(), см. историю\n')).toEqual([]);
    });

    it('путь от каталога модуля вниз — законная форма, скан молчит', () => {
        expect(outsideHits("const p = join(import.meta.dirname, 'core', 'gate.ts');\n", 1)).toEqual(
            [],
        );
    });

    it('подъём ДО корня из вложенного файла законен, из файла корня — уже нет', () => {
        // Тот же текст, разное место: `import ralph from '../ralph.js'` в `core/` —
        // обычный импорт соседа, в файле корня — выход из репозитория.
        const line = "import ralph from '../ralph.js';\n";
        expect(outsideHits(line, 1)).toEqual([]);
        expect(outsideHits(line, 0).length).toBeGreaterThan(0);
    });

    it('git-ревизия с двумя точками путём не считается', () => {
        // `sha..origin/main` — диапазон коммитов; наивный поиск подстроки `..` краснел бы
        // на нём в каждом файле, работающем с git.
        expect(outsideHits('const range = `${sha}..origin/main`;\n', 0)).toEqual([]);
    });
});

// Второй критерий чистого клона: прогон не ходит в сеть. Проверяется тем же способом —
// пробой, а не чтением setup-файла: предохранитель, подключённый неправильно, выглядит
// подключённым.
describe('прогон гейта не ходит в сеть', () => {
    it('глобальный fetch отказывает и попадает в журнал побочек', () => {
        expect(() => fetch('https://example.com/')).toThrow(/RALPH_NO_SIDE_EFFECTS/);
        // Вызов сделан НАМЕРЕННО — журнал забираем сами, иначе общий afterEach уронил бы
        // этот же тест (тот же приём, что у проб предохранителя в `core/exec.test.ts`).
        expect(sideEffectAttempts.splice(0)).toEqual(['fetch(https://example.com/)']);
    });
});

// #367: guard-тест «ядро ralph без проектной специфики». Цель переносимости (#204) —
// подключить автономный раннер к другому репозиторию и заполнить ОДИН конфиг, без правок
// кода. Значит проектные строки (имя репо, владельца доски, домен прода, имена фич) живут
// ТОЛЬКО в `ralph.config.json` и в поясняющих комментариях-примерах — но не в исполняемом
// коде ядра. Этот тест
// вмораживает границу: вернётся специфика в код — сьют покраснеет, а не «однажды заметим».
//
// Барьер, а не абзац в промпт (инвариант №5): grep как часть сьюта ловит регресс
// детерминированно, независимо от внимательности ревьюера.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { denyNamePattern, traceFindings } from './project-traces.ts';
// Стриппер комментариев — общий с `seam-defaults`: граница «код vs комментарий»
// одна на все сканы, и чинить её надо в одном месте.
import { stripComments } from './strip-comments.ts';

// Отсчёт от каталога МОДУЛЯ, а не от cwd: ядро гоняется и своим клоном канона, и
// каталогом `.claude/ralph` внутри проекта-потребителя — CWD в этих раскладках разный,
// положение этого файла относительно корня ядра одно и то же. `import.meta.dirname`, а не
// `__dirname`: у канона свой package.json с `type: module` (#R0), и ESM-форма здесь
// работает и под vitest, и под нативным type stripping.
const CANON_ROOT = resolve(import.meta.dirname, '..');

// Что считать проектной строкой — решают КЛАССЫ следов (машинный путь, адрес хоста) и
// словарь имён, который приходит СНАРУЖИ, через RALPH_TRACE_DENY. Список имён внутри
// публичного канона сам был бы следом — почему именно так, см. tests/project-traces.ts.
// Юнит-тесты стриппера ниже гоняются на ЗАВЕДОМО синтетическом имени: им нужна не правда
// о конкретном проекте, а доказательство, что граница «код vs комментарий» проведена там,
// где заявлено.
const SAMPLE = /acme-shop|AcmeCorp|acme\.example/;

const CODE_EXT = /\.(js|ts|mjs|mts)$/;
// Из скана исключаем: тесты (сами держат паттерн в проверках), общую тест-инфру
// предохранителя #138 и `test-helpers`. Сканируем только код ядра (CODE_EXT = js/ts/mjs/mts —
// .mts у явно-ESM модулей ядра: gate-env.mts (#403) и runtime/monitor-panel.mts (#404)).
// .json/.log/.md — данные/конфиг/доки. Скрипты `.sh` НЕ сканируем не потому что «не код»,
// а потому что деплой-обвязка лежит ВНЕ переносимого ядра: при переносе она заменяется под
// своё окружение, а не копируется как есть (#367-ревью).
const EXCLUDE = /\.test\.(js|ts|mjs|mts)$|^test-setup\.ts$|^test-helpers\.ts$/;

// Каталоги вне скана. `provision/` — контурная обвязка (при переносе заменяется), `tests/`
// сам держит паттерн в проверках, а `__fixtures__/` под ним ОБЯЗАНА нести чужую специфику.
const SKIP_DIRS = new Set(['provision', 'tests', '__fixtures__', 'node_modules']);

/**
 * Набор файлов ядра — из `git ls-files`, а не из обхода каталога.
 *
 * Раньше здесь был рекурсивный readdir плюс ручной список `EXPECTED` из 25 путей: обход
 * мог тихо усохнуть (переименовали каталог, сломалась рекурсия), и список сторожил именно
 * это — ценой того, что каждый новый модуль ядра надо было дописать в тест, а забытый
 * дописать модуль в скан не попадал вовсе. Плоское перечисление трекнутых файлов снимает
 * обе беды разом: выпасть из него модуль может только вместе с удалением из репозитория,
 * а исключения остаются ЯВНЫМИ — их сверяет отдельный тест ниже.
 *
 * Fail-closed: git не ответил — бросаем, а не возвращаем пустой набор. Пустой набор сделал
 * бы весь сьют зелёным, не проверив ни одного файла.
 */
function trackedFiles(): string[] {
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

const TRACKED = trackedFiles();
const inSkippedDir = (rel: string) =>
    rel
        .split(sep)
        .slice(0, -1)
        .some((d) => SKIP_DIRS.has(d));
const isCodeFile = (rel: string) => CODE_EXT.test(rel) && !EXCLUDE.test(basename(rel));

const CORE = TRACKED.filter((rel) => isCodeFile(rel) && !inSkippedDir(rel));

/**
 * Находки в КОДЕ (комментарии сняты): поясняющий пример в комментарии — норма и часть
 * истории решения, значение в коде — нарушение переносимости.
 *
 * Классы следов применяются ко ВСЕМУ, что сканируется. Раньше их состав зависел от того,
 * чей это файл: рядом с ядром лежали `scripts/**` потребителя, и требовать от чужого кода
 * своих правил значило краснеть на том, что этот тест всё равно не чинит. В каноне чужих
 * файлов нет вовсе — каждый сканируемый файл принадлежит ядру и отвечает за себя целиком.
 */
function specificsInCode(src: string): Array<[number, string]> {
    // Словарь читается НА КАЖДЫЙ вызов, а не один раз при импорте модуля. Пока он был
    // модульной константой, проводку «RALPH_TRACE_DENY → скан ядра» проверить было нечем:
    // значение замерзало раньше, чем тест успевал его задать, и оборванная проводка
    // выглядела бы как чистое дерево — словарная половина барьера просто не шла бы
    // (ревью !17).
    return traceFindings(stripComments(src), { deny: denyNamePattern() }).map(
        (f) => [f.line, f.excerpt] as [number, string],
    );
}

describe('stripComments — граница «код vs комментарий-пример»', () => {
    it('ловит проектную строку в исполняемом коде', () => {
        const bad = "const worktree = 'acme-shop-ralph';\n";
        expect(SAMPLE.test(stripComments(bad))).toBe(true);
    });

    it('игнорирует однострочный поясняющий комментарий-пример', () => {
        const ok = "// был 'AcmeCorp'/1, теперь из конфига\nconst owner = cfg.owner;\n";
        expect(SAMPLE.test(stripComments(ok))).toBe(false);
    });

    it('игнорирует многострочный блочный комментарий с примером', () => {
        const ok = "/*\n * дефолт был 'acme-shop-ralph'\n */\nreturn base + '-ralph';\n";
        expect(SAMPLE.test(stripComments(ok))).toBe(false);
    });

    it('НЕ съедает URL-строку в коде из-за `//` внутри неё', () => {
        // Регресс-охрана самого стриппера: домен в КОДЕ (не в конфиге) обязан ловиться,
        // несмотря на `//` внутри 'https://…'.
        const bad = "const url = 'https://acme.example';\n";
        expect(SAMPLE.test(stripComments(bad))).toBe(true);
    });

    it('#367-ревью: глоб-строка с `/*` и `*/` не сбивает вырезание блочных комментариев', () => {
        // Строка-глоб содержит и `/*`, и `*/` — наивный regex вырезал бы её кусок, а при
        // двух таких литералах — всё между ними. Сканер видит их как СТРОКУ, не комментарий:
        // специфика в реальном коде между глоб-строками обязана уцелеть и пойматься.
        const src =
            "const glob = 'src/**/*.ts';\nconst repo = 'acme-shop';\nconst g2 = 'lib/**/*.js';\n";
        expect(SAMPLE.test(stripComments(src))).toBe(true);
    });

    it('#367-ревью: специфика ВНУТРИ строкового литерала ловится (строка = код)', () => {
        const bad = "const owner = 'AcmeCorp';\n";
        expect(SAMPLE.test(stripComments(bad))).toBe(true);
    });

    it('blankStrings: проза в строковом литерале сканам КОНСТРУКЦИЙ не видна, код цел', () => {
        // Сканы вида «запись в поле adapters» ловят синтаксис, а не значения, — и текст
        // подсказки `adapters.coderRuntime='kimi'` для них ложная тревога (ревью !5).
        const source = 'log("подсказка: adapters.coderRuntime=\'kimi\'");\nconst x = 1;\n';
        const out = stripComments(source, { blankStrings: true });
        expect(out).not.toContain('coderRuntime');
        // Код вокруг литерала и сами кавычки остаются: границы строки видны, нумерация
        // строк не съезжает.
        expect(out).toContain('log("");');
        expect(out).toContain('const x = 1;');
    });

    it('blankStrings по умолчанию выключен: строка остаётся кодом (контракт #367)', () => {
        // Полярность у сканов разная: `core-purity` ищет проектные ЗНАЧЕНИЯ, и для него
        // содержимое строки — код. Смена дефолта молча ослепила бы этот скан.
        const bad = "const owner = 'AcmeCorp';\n";
        expect(stripComments(bad)).toContain('AcmeCorp');
    });
});

describe('набор сканируемых модулей ядра', () => {
    // Fail-closed страж набора. Пустой или усохший CORE — красный, а не «нечего
    // проверять»: сломайся перечисление, весь сьют ниже стал бы зелёным, не прочитав ни
    // одного файла (тот же класс, что слепой grep).
    it('непуст и покрывает каждую папку ядра', () => {
        expect(CORE.length).toBeGreaterThan(20);
        // Оба entry в корне ядра — тонкий ralph.js и ESM-gate-env.mts.
        expect(CORE).toContain('ralph.js');
        expect(CORE).toContain('gate-env.mts');
        // Ни одна папка ядра не выпала целиком: именно так набор усыхал раньше — при
        // раскладке по папкам нерекурсивный обход оставил в скане только корень.
        for (const dir of ['core', 'adapters', 'shared', 'runtime']) {
            expect(
                CORE.filter((rel) => rel.startsWith(`${dir}/`)).length,
                `папка ${dir}/ выпала из скана core-purity`,
            ).toBeGreaterThan(1);
        }
    });

    // Обратная сторона плоского перечисления: список исключений обязан оставаться ЯВНЫМ.
    // Разъехавшийся EXCLUDE (лишняя маска, опечатка в имени папки) вынес бы модуль из
    // скана молча — набор остался бы непустым, а барьер перестал бы сторожить именно то,
    // что ушло. Поэтому сверяем не только то, что сканируется, но и то, что НЕ.
    it('из скана выпадает ровно заявленное: тесты, их обвязка и контурный provision', () => {
        const skipped = TRACKED.filter((rel) => CODE_EXT.test(rel) && !CORE.includes(rel));
        const unexpected = skipped.filter(
            (rel) =>
                !/\.test\.(js|ts|mjs|mts)$/.test(rel) &&
                !rel.startsWith('tests/') &&
                !rel.startsWith('provision/'),
        );
        expect(unexpected, `файл ядра молча выпал из скана — проверь EXCLUDE/SKIP_DIRS`).toEqual(
            [],
        );
    });
});

describe('ядро ralph свободно от проектной специфики (#204/#367)', () => {
    it.each(CORE)('%s — без проектной специфики в коде', (rel) => {
        const hits = specificsInCode(readFileSync(join(CANON_ROOT, rel), 'utf-8'));
        const detail = hits.map(([n, line]) => `\n  ${n}: ${line.trim()}`).join('');
        expect(
            hits,
            `Проектная специфика в коде ${rel} — вынеси в ralph.config.json:${detail}`,
        ).toEqual([]);
    });

    // От противного, по КАЖДОМУ файлу набора. Зелёный тест выше сам по себе двусмыслен:
    // он одинаково выглядит и когда следов нет, и когда скан ослеп — усох набор, стриппер
    // съел код, класс перестал матчить после правки регекспа. Проба снимает эту
    // двусмысленность: файл, на котором подсунутое значение НЕ краснеет, барьером не
    // прикрыт вовсе.
    it('словарь имён доезжает до скана ядра, а не только до своих юнит-тестов', () => {
        // Структурные классы работают всегда, и на них одних тест выше зелен даже при
        // оборванном словаре. А имя приватного репозитория структурной формы не имеет
        // вовсе — если `RALPH_TRACE_DENY` не доехал до скана, эта половина барьера
        // отсутствует, оставаясь на вид исправной.
        const saved = process.env.RALPH_TRACE_DENY;
        process.env.RALPH_TRACE_DENY = 'acme-shop,area:acme';
        try {
            expect(specificsInCode("const repo = 'acme-shop';\n")).toHaveLength(1);
            expect(specificsInCode("const label = 'area:acme';\n")).toHaveLength(1);
            expect(specificsInCode("const label = 'complexity:low';\n")).toEqual([]);
        } finally {
            if (saved === undefined) delete process.env.RALPH_TRACE_DENY;
            else process.env.RALPH_TRACE_DENY = saved;
        }
    });

    it.each(CORE)('%s — подсунутое проектное значение красит скан', (rel) => {
        const src = readFileSync(join(CANON_ROOT, rel), 'utf-8');
        // Машинный путь — структурный класс: он работает и с пустым `RALPH_TRACE_DENY`,
        // а словарь имён в каноне обычно не задан, и проба по нему была бы пустой.
        //
        // Форма склеивается В РАНТАЙМЕ, а не пишется литералом: этот файл читает соседний
        // скан дерева (`project-traces`), и написанный целиком машинный путь покраснел бы
        // у него — проба барьера стала бы нарушением того же барьера. Склейка даёт скану
        // ровно ту форму, которую он обязан ловить, не оставляя её в тексте файла.
        const leak = `${src}\nconst leaked = '/${'root'}/acme-shop/app';\n`;
        expect(
            specificsInCode(leak).length,
            `Скан не видит подсунутого значения в ${rel} — барьер его не прикрывает`,
        ).toBeGreaterThan(specificsInCode(src).length);
    });
});

// ── #55: команды форжа живут в адаптере, а не в ядре ─────────────────────────
// Барьер `MERGE_PATH_BOUND_SEAMS` сторожит подмену швов, но не то, что ядро исполняет
// команду форжа САМО. Пока `gh` физически жил в `core/gate.ts`, «гейт» и «GitHub-адаптер»
// читались как один модуль — и следующий такой вызов (как `gh pr view` в #49) снова
// оказался бы незамеченным: роутинг через шов есть, а команда всё равно в ядре.
//
// Скан по КОДУ без комментариев: докблоки ядра законно объясняют, что делает адаптер,
// и называют команды — это не исполнение.
describe('ядро не исполняет команд форжа (#55)', () => {
    // Скан теперь СПЛОШНОЙ: раньше здесь был белый список из одного очищенного модуля, и
    // барьер сторожил ровно то, что уже чисто, — новый модуль с командой форжа проезжал бы
    // мимо него молча. Теперь наоборот: сканируется всё ядро, а известный долг перечислен
    // ИМЕНАМИ и ЧИСЛАМИ (храповик ниже). Разница не косметическая: белый список ничего не
    // говорит о непокрытом, а храповик называет каждый непокрытый файл и его цену.
    //
    // `adapters/**` из скана исключён по определению: адаптер форжа — ровно то место, где
    // команды форжа обязаны жить. Всё остальное — ядро, рантайм и entry — сканируется.
    const CORE_MODULES = CORE.filter((rel) => !rel.startsWith('adapters/'));

    // Известный долг: модули, где команды форжа ещё лежат в ядре. Число — сколько строк с
    // ними осталось; сверяется РАВЕНСТВОМ, а не «не больше». Храповик работает в обе
    // стороны намеренно: «не больше» позволило бы долгу тихо просесть и снова вырасти до
    // старой отметки, оставаясь зелёным. Вынес вызов в адаптер — опусти число здесь же.
    //
    // Почему долг вообще есть. В `orchestrator.ts` живёт вся GitHub-реализация швов, в
    // `deploy-check.ts` — чтение мердж-коммита и прогонов CI, в `monitor-panel.mts` —
    // счётчики доски для дашборда. Вынести их одним заходом значит переписать половину
    // ядра; это отдельная работа, а не попутная.
    const DEBT: Record<string, number> = {
        'core/orchestrator.ts': 27,
        'core/deploy-check.ts': 3,
        'runtime/monitor-panel.mts': 5,
    };

    // `gh` как КОМАНДА: первым словом в строке-литерале (`'gh auth status'`) либо первым
    // аргументом argv-вызова (`runArgvFn('gh', [...])`). Слово `gh` внутри слов (`weight`)
    // и в путях не ловим — иначе барьер утонет в ложных срабатываниях и его отключат.
    // Ловим и ИСПОЛНЕНИЕ (литерал команды, argv-вызов), и УПОМИНАНИЕ в тексте лога:
    // «gh pr merge вернул ошибку» на площадке без gh — враньё в глаза оператору, а
    // сообщения ядра обязаны быть правдой на любом форже (#55-ревью).
    // Список подкоманд НЕ перечисляем: `gh label create`, `gh repo`, `gh workflow` прошли бы
    // мимо, а закрытый перечень пришлось бы догонять за каждым новым подмодулем `gh`. Слово
    // `gh` отдельным токеном в коде ядра не встречается — значит `\bgh\s+<слово>` даёт
    // полноту без ложных срабатываний (#55-ревью).
    // `[a-z$]` в начале подкоманды — не опечатка: `gh ${sub} list` собирается шаблоном, и
    // без `$` такая сборка проходила бы мимо (#55-ревью проверял именно её).
    const FORGE_CMD = /(\bgh\s+[a-z$][a-z{}\w]*)|(\bglab\s+[a-z$][a-z{}\w]*)/;
    // Argv-вызов ищем ОТДЕЛЬНО и по всему тексту: prettier при ширине 100 переносит длинный
    // вызов, и `runArgvFn(` с `'gh',` оказываются на разных строках — построчный скан видел
    // бы каждую по отдельности и молчал (тот же класс, что описан ниже для промптов).
    const ARGV_FORGE = /\(\s*['"`](gh|glab)['"`]\s*,/g;
    // Голое слово `gh`/`glab` в ЛЮБОМ виде — конкатенация `'gh ' + sub`, переменная
    // `const bin = 'gh'`, обёртка `env gh`. В очищенных модулях таких токенов нет вовсе
    // (проверено широкой пробой), поэтому дешёвое усиление обходится без исключений
    // и закрывает последнюю известную дыру (#55-ревью, второй круг).
    const FORGE_WORD = /(?<![\w-])(gh|glab)(?![\w-])/;

    it('скан видит ядро целиком, а долг назван по существующим файлам', () => {
        // Опечатка в фильтре превратила бы `it.each` в пустой набор — сьют остался бы
        // зелёным, не проверив ничего (тот же класс, что слепой grep).
        expect(CORE_MODULES.length).toBeGreaterThan(15);
        expect(CORE_MODULES).toContain(join('core', 'gate.ts'));
        // Долг, названный по несуществующему файлу, — это молчаливое исключение: файл
        // переехал, строка осталась, и его новое имя сканируется как «чистое».
        for (const rel of Object.keys(DEBT)) {
            expect(CORE_MODULES, `в долге назван файл ${rel}, которого нет в скане`).toContain(rel);
        }
    });

    /**
     * Находки команд форжа в ТЕКСТЕ — чистая функция, а не тело `it.each`.
     *
     * Так барьер можно проверить мутацией: подсунуть обходную форму и потребовать
     * красноты. Пока скан читал файл внутри теста, доказать его работоспособность было
     * нечем — испорченный правкой паттерн перестаёт матчить молча, и сьют остаётся
     * зелёным сразу на всём ядре. Зелёный чек без проверки хуже отсутствующего.
     */
    function forgeHits(code: string): Array<readonly [number, string]> {
        const hits = code
            .split('\n')
            .map((line, i) => [i + 1, line] as const)
            .filter(([, line]) => FORGE_CMD.test(line));
        // Скан ЦЕЛИКОМ — ловит argv-вызов, разорванный переносом строки.
        const argvHits = [...code.matchAll(ARGV_FORGE)].map((m) => {
            const lineNo = code.slice(0, m.index).split('\n').length;
            return [lineNo, m[0].replace(/\s+/g, ' ')] as const;
        });
        const wordHits = code
            .split('\n')
            .map((line, i) => [i + 1, line] as const)
            .filter(([, line]) => FORGE_WORD.test(line));
        return [...hits, ...argvHits, ...wordHits]
            .filter(([n, line], i, arr) => arr.findIndex(([m, l]) => m === n && l === line) === i)
            .sort((a, b) => a[0] - b[0]);
    }

    it.each(CORE_MODULES)('%s — команды gh/glab только в пределах известного долга', (rel) => {
        const all = forgeHits(stripComments(readFileSync(join(CANON_ROOT, rel), 'utf-8')));
        const detail = all.map(([n, line]) => `\n  ${n}: ${line.trim()}`).join('');
        const budget = DEBT[rel] ?? 0;
        expect(
            all.length,
            budget === 0
                ? `Команда форжа в ядре ${rel} — её место в adapters/:${detail}`
                : `Долг ${rel} изменился: было ${budget}, стало ${all.length}. ` +
                      `Вырос — верни вызов в adapters/; убавился — опусти число в DEBT:${detail}`,
        ).toBe(budget);
    });

    // Барьер проверяется МУТАЦИЕЙ, а не чтением. Паттерн выше усложнялся тремя кругами
    // ревью, и каждая его часть закрывала конкретную обходную форму — но доказательства,
    // что она закрыта, до сих пор не было: скан ни разу не краснел. Ниже подсовываются
    // ровно те формы, ради которых он усложнялся.
    describe('обходные формы команды форжа — от противного', () => {
        // Модуль без долга: на нём видно, что краснота пришла от подсунутой строки, а не
        // от того, что там и так лежит невынесенный вызов.
        const CLEAN = join('core', 'gate.ts');
        const cleanCode = () => stripComments(readFileSync(join(CANON_ROOT, CLEAN), 'utf-8'));

        it('контроль: модуль пробы сегодня чист — иначе проба ничего не значит', () => {
            expect(DEBT[CLEAN] ?? 0).toBe(0);
            expect(forgeHits(cleanCode())).toEqual([]);
        });

        it.each([
            ['литерал команды', "const cmd = 'gh pr merge 12 --squash';"],
            ['шаблонная сборка подкоманды', 'const cmd = `gh ${sub} list`;'],
            ['argv-вызов', "await runArgvFn('gh', ['pr', 'view', '12']);"],
            [
                'argv-вызов, разорванный переносом prettier',
                "await runArgvFn(\n    'gh',\n    ['pr', 'view'],\n);",
            ],
            ['голое слово в переменной', "const bin = 'gh';"],
            ['конкатенация', "const cmd = 'gh ' + sub;"],
            ['второй форж', "const cmd = 'glab mr merge';"],
            ['упоминание в тексте лога', "logFn('gh pr merge вернул ошибку');"],
        ])('%s — красит скан чистого модуля', (_name, snippet) => {
            expect(
                forgeHits(`${cleanCode()}\n${snippet}\n`).length,
                `Обходная форма проехала мимо барьера: ${snippet}`,
            ).toBeGreaterThan(0);
        });

        // ЧЕГО ЭТОТ БАРЬЕР НЕ ЛОВИТ (ревью !17). Имя команды, собранное из частей в рантайме —
        // `['g', 'h'].join('')`, `String.fromCharCode(...)`, чтение из конфига, — не даёт в
        // тексте ни одного из трёх паттернов, и скан его не увидит ни при какой сложности
        // регекспа: это разбор ЗНАЧЕНИЙ, а не текста. Догонять обфускацию регекспом —
        // проигранная гонка, поэтому граница названа честно, а не изображается покрытой.
        // Класс закрывается иначе — проверкой того, ЧТО ядро исполняет (шов и его дефолт,
        // `seam-defaults`), а не того, как это записано. Заведено карточкой.
        it('слово внутри другого слова барьер не трогает — иначе его отключат', () => {
            expect(forgeHits('const weight = highlight + light;\n')).toEqual([]);
        });
    });
});

// ── #36: переносимая половина промпт-контракта ───────────────────────────────
// `ralph.md` уезжает в следующий проект как есть, поэтому в нём не должно быть ни команд
// конкретного форжа, ни утверждений, верных только для одного из них. Барьер грепом, а не
// глазами ревьюера (инвариант №5): текст правят чаще, чем перечитывают целиком.
//
// Как этот дефект выглядел до правки: `gh issue edit --add-label blocked` (невыполнимо
// там, где `gh` нет вовсе), «issue мимо доски равно потерянному» (у площадки доска —
// проекция статуса, терять нечего) и «ключевые слова автозакрытия только английские»
// (механика GitHub; связь issue↔PR бывает структурной). Первое просто не сработает,
// а два последних — ложные утверждения о мире, по которым сессия будет действовать.

// ── #45: промпты сессий — намерение, а не способ ─────────────────────────────
// Тексты, которые раннер отдаёт сессиям, — тот же переносимый контракт, что и `ralph.md`,
// только собранный кодом. Пока они жили строками по месту вызова в `orchestrator.ts`,
// грепом их было не отличить от законных команд `gh` соседней реализации форжа — и они
// молча обросли механикой GitHub («через gh cli», «gh api graphql», «Closes #N»). На
// площадке без GitHub CLI это невыполнимо, а выглядит снаружи как «ревью прошло,
// замечаний нет»: метки нет, комментариев нет, фаза едет в main.
//
// Отсюда два барьера, и второй не менее важен первого: собранный в модуль текст можно
// грепать, но только пока промпты собираются ИМЕННО там.

describe('промпты сессий: без команд и механик форжа (#45)', () => {
    const PROMPTS = join('core', 'prompts.ts');
    const ORCHESTRATOR = join('core', 'orchestrator.ts');

    const FORGE: Array<[RegExp, string]> = [
        // Не `gh <подкоманда>`, а СЛОВО `gh` целиком: формулировка, с которой заведён #45,
        // звучала «оставь inline-комментарии через gh cli» — списком подкоманд она не
        // ловится вовсе, и барьер сторожил бы всё, кроме исходного дефекта (проверено).
        [/\bgh\b/i, 'GitHub CLI в тексте промпта — его место в адаптере'],
        [/\bglab\s/i, 'команда GitLab CLI — её место в адаптере'],
        [/\b(github|gitlab|sourcecraft|gitea|bitbucket)\b/i, 'имя форжа в тексте промпта'],
        [/\b(closes|fixes|resolves)\s+#/i, 'автозакрытие по ключевому слову — механика GitHub'],
        [/resolveReviewThread|graphql/i, 'треды ревью через GraphQL — механика GitHub'],
    ];

    it.each(FORGE)('prompts.ts не содержит %s (%s)', (re, why) => {
        // Комментарии модуля объясняют, ЧЕМ дефект был, и сами содержат эти строки —
        // поэтому сканируем код без строк-комментариев, а не файл целиком.
        const code = readFileSync(join(CANON_ROOT, PROMPTS), 'utf-8')
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        expect(re.test(code), `${why} — промпт обязан говорить намерением`).toBe(false);
    });

    it('оркестратор не собирает промпты строкой по месту вызова', () => {
        // Барьер держится на том, что тексты живут в одном файле. Инлайн-литерал в вызове
        // сессии вернул бы прежнее состояние: греп по prompts.ts зелёный, а промпт с `gh`
        // уехал в сессию мимо него.
        // Скан ЦЕЛИКОМ, а не построчно, и не только по бэктику. Построчная проверка
        // пропускала самый вероятный вид регресса: prettier при ширине 100 переносит
        // длинный литерал на следующую строку, и `runClaudeFn(` с открывающей кавычкой
        // оказываются на разных строках — барьер видел бы каждую по отдельности и молчал.
        const source = readFileSync(join(CANON_ROOT, ORCHESTRATOR), 'utf-8');
        const hits = [...source.matchAll(/runClaudeFn\(\s*['"`]/g)].map((m) => {
            const lineNo = source.slice(0, m.index).split('\n').length;
            return [lineNo, m[0].replace(/\s+/g, ' ')] as const;
        });
        const detail = hits.map(([n, line]) => `\n  ${n}: ${line.trim()}`).join('');
        expect(
            hits,
            `промпт собран строкой в вызове — вынеси его в core/prompts.ts:${detail}`,
        ).toEqual([]);
    });

    it('ralph.md описывает намерения по PR — иначе сессии нечем ими пользоваться', () => {
        // Обратная сторона запрета: убрать способ мало, сессия обязана знать канал.
        const contract = readFileSync(join(CANON_ROOT, 'ralph.md'), 'utf-8');
        expect(contract).toMatch(/pr-comment/);
        expect(contract).toMatch(/pr-block/);
    });
});

describe('промпт-контракт: ralph.md переносим, площадочное — в ralph.project.md (#36)', () => {
    const PROMPT = 'ralph.md';
    // Проектная половина контракта принадлежит ПОТРЕБИТЕЛЮ: её содержимое — имена его
    // меток, состав его гейта, его площадка. Канон везёт шаблон с плейсхолдерами (тот же
    // приём, что `provision/ralph.service.example`), а подключение копирует его рядом с
    // ядром под именем без `.example` и заполняет.
    const PROJECT_PROMPT_TEMPLATE = 'ralph.project.md.example';

    // Каждый паттерн — с объяснением, ЧТО именно им ловится: сообщение читает тот, у кого
    // тест покраснел, и «не проходит регулярку» ему ничего не говорит.
    const FORBIDDEN: Array<[RegExp, string]> = [
        [/\bgh\s+(issue|pr|project|api|auth)\b/i, 'команда GitHub CLI — её место в адаптере'],
        [/\bglab\s/i, 'команда GitLab CLI — её место в адаптере'],
        [/\b(github|gitlab|sourcecraft|gitea|bitbucket)\b/i, 'имя форжа в переносимом файле'],
        [/\b(closes|fixes|resolves)\s+#/i, 'автозакрытие по ключевому слову — механика GitHub'],
        // Границу слова здесь даёт lookbehind, а НЕ `\b`: в JS `\b` определён через `\w`,
        // то есть по ASCII, и `\bдоска` требует, чтобы перед «д» стоял латинский
        // буквенно-цифровой символ. На строке «issue мимо доски равно потерянному» такой
        // паттерн не срабатывает вовсе — барьер молча сторожил бы пустоту (проверено).
        [
            /(?<![а-яё])доск[аеиоу]/i,
            'доска проекта: у одних форжей отдельная сущность, у других — проекция статуса',
        ],
    ];

    it('шаблон ralph.project.md лежит в каноне — на него ссылается ralph.md', () => {
        // Ровно тот дефект, с которого началась #36: ссылка была, файла не было, и сессия
        // получала инструкцию читать пустоту. В каноне заполненного файла быть не может
        // (он проектный), но шаблон обязан ехать вместе с ядром — иначе подключающий
        // узнаёт о нём из ошибки сессии.
        expect(existsSync(join(CANON_ROOT, PROJECT_PROMPT_TEMPLATE))).toBe(true);
    });

    it.each(FORBIDDEN)('ralph.md не содержит %s (%s)', (re, why) => {
        const lines = readFileSync(join(CANON_ROOT, PROMPT), 'utf-8').split('\n');
        const hits = lines
            .map((line, i) => [i + 1, line] as const)
            .filter(([, line]) => re.test(line));
        const detail = hits.map(([n, line]) => `\n  ${n}: ${line.trim()}`).join('');
        expect(hits, `${why} — перенеси строку в ralph.project.md:${detail}`).toEqual([]);
    });

    it('ralph.md отправляет за проектной спецификой в ralph.project.md', () => {
        // Обратная сторона запретов: убрать площадочное мало — сессия обязана знать, где
        // его искать, иначе переносимость куплена ценой незнания.
        expect(readFileSync(join(CANON_ROOT, PROMPT), 'utf-8')).toMatch(/ralph\.project\.md/);
    });
});

// ── Канон, задача 23: ядро не зовёт скриптов потребителя по зашитым путям ────
// В каноне папки `scripts/` нет вовсе, а ядро звало `scripts/project-sync.mjs` и
// `scripts/review-findings-journal.mjs` строкой — то есть молча требовало, чтобы у каждого
// потребителя лежал файл с таким именем в таком месте. Отказ при этом был тихим: обе
// обёртки fail-open, и «файла нет» выглядело ровно как «синк прошёл».
describe('пути скриптов потребителя приходят из конфига, а не из кода', () => {
    // Три формы одного дефекта — скан по одной пропускал бы остальные (второй проход !21).
    // 1) литерал пути к исполняемому файлу ГДЕ УГОДНО в коде: вынесенная константа
    //    (`const S = 'scripts/x.mjs'; runArgvFn('node', [S])`) — самая обычная форма;
    const SCRIPT_PATH = /['"`]([^'"`\s]*\/[^'"`\s]*\.[cm]?[jt]s)['"`]/g;
    // 2) argv-форма — ловит и имя файла без папки (`['x.mjs']`), которое первый скан не
    //    видит. Ведущий дефис исключён: `['--flag', script]` — опция node, а не путь;
    const NODE_ARGV = /\(\s*['"`]node['"`]\s*,\s*\[\s*['"`](?!-)([^'"`]+)['"`]/g;
    // 3) команда целиком (`sh('node scripts/x.mjs')`). Литерал обязан НАЧИНАТЬСЯ с `node `:
    //    иначе барьер краснеет на строке лога, показывающей ту же команду человеку.
    const NODE_CMD = /['"`]node\s+([^'"`\s]+\.[cm]?[jt]s)\b/g;

    /**
     * Находки зашитых путей — чистая функция (как `forgeHits` выше и по той же причине:
     * скан внутри `it.each` доказать нечем), и `existsInCanon` у неё ПАРАМЕТР.
     *
     * Критерий — не подстрока `scripts/`, а факт: путь ведёт к файлу, которого в каноне
     * НЕТ, значит это файл потребителя, зашитый в продукт. Свои файлы канон адресует
     * законно (`./tests/test-setup.ts` в конфиге vitest, `runtime/monitor.js` от каталога
     * модуля), и запрещать их значило бы получить барьер, который отключат первым же
     * исключением. Глобы (со звёздочкой) — не пути к файлу и находкой не считаются.
     */
    function scriptPathHits(
        code: string,
        existsInCanon: (rel: string) => boolean,
    ): Array<readonly [number, string]> {
        const at = (index: number) => code.slice(0, index).split('\n').length;
        return [
            ...code.matchAll(SCRIPT_PATH),
            ...code.matchAll(NODE_ARGV),
            ...code.matchAll(NODE_CMD),
        ]
            .filter((m) => !m[1].includes('*') && !existsInCanon(m[1]))
            .map((m) => [at(m.index), m[0].replace(/\s+/g, ' ')] as const)
            .filter(([n, text], i, arr) => arr.findIndex(([m, t]) => m === n && t === text) === i)
            .sort((a, b) => a[0] - b[0]);
    }

    // Опись канона: путь, которого здесь нет, ведёт наружу — к файлу потребителя. Считается
    // от ДВУХ баз, потому что обе законны: от корня канона (пути в конфигах) и от каталога
    // самого файла (импорты соседей, `../shared/...`).
    const existsFor =
        (rel: string) =>
        (p: string): boolean =>
            existsSync(join(CANON_ROOT, p)) ||
            existsSync(resolve(dirname(join(CANON_ROOT, rel)), p));
    const existsInCanon = existsFor('core/orchestrator.ts');

    it('скану есть что сканировать, и барьер краснеет на подсунутом пути', () => {
        expect(CORE).toContain('core/orchestrator.ts');
        expect(CORE).toContain('core/review.ts');
        // Исходный инцидент задачи 23 — обязан краснеть в ЛЮБОЙ форме, а не только инлайном.
        expect(
            scriptPathHits("runArgvFn('node', ['scripts/project-sync.mjs'])", existsInCanon),
        ).not.toEqual([]);
        expect(
            scriptPathHits(
                "const S = 'scripts/project-sync.mjs';\nrunArgvFn('node', [S]);",
                existsInCanon,
            ),
        ).not.toEqual([]);
        expect(
            scriptPathHits("runArgvFn('node', [join(root, 'scripts/x.mjs')])", existsInCanon),
        ).not.toEqual([]);
        // Класс, а не инцидент: другая папка — та же болезнь; имя без папки ловит argv-форма.
        expect(
            scriptPathHits("shArgv('node', ['tools/board-sync.mjs'])", existsInCanon),
        ).not.toEqual([]);
        expect(scriptPathHits("shArgv('node', ['journal.mjs'])", existsInCanon)).not.toEqual([]);
        expect(scriptPathHits("sh('node bin/journal.mjs --counts')", existsInCanon)).not.toEqual(
            [],
        );
        // Путь из конфига — законная форма, ради которой задача и делалась.
        expect(scriptPathHits("runArgvFn('node', [script])", existsInCanon)).toEqual([]);
        // Флаг интерпретатора — не путь: иначе барьер краснеет, объясняя не то.
        expect(
            scriptPathHits(
                "runArgvFn('node', ['--experimental-strip-types', script])",
                existsInCanon,
            ),
        ).toEqual([]);
        // Показ команды человеку — подсказка, а не вызов.
        expect(scriptPathHits("logFn('Запусти вручную: node tools/x.mjs')", existsInCanon)).toEqual(
            [],
        );
        // Имя поля конфига словом `scripts` барьер не трогает: запрещён ПУТЬ, а не слово.
        expect(scriptPathHits('cfg.consumerScripts?.projectSync', existsInCanon)).toEqual([]);
        // Свои файлы канон адресует законно — и это проверяется ПОДМЕНОЙ описи, а не верой
        // в дерево: с описью, где файл есть, находки нет; с описью, где его нет, — есть.
        const own = "path.join(dir, 'runtime/monitor.js')";
        expect(scriptPathHits(own, (rel) => rel === 'runtime/monitor.js')).toEqual([]);
        expect(scriptPathHits(own, () => false)).not.toEqual([]);
    });

    it.each(CORE)('%s — без зашитых путей к скриптам потребителя', (rel) => {
        const hits = scriptPathHits(
            stripComments(readFileSync(join(CANON_ROOT, rel), 'utf-8')),
            existsFor(rel),
        );
        const detail = hits.map(([n, line]) => `\n  ${n}: ${line.trim()}`).join('');
        expect(
            hits,
            `Зашитый путь скрипта в ${rel} — его место в ralph.config.json ` +
                `(consumerScripts):${detail}`,
        ).toEqual([]);
    });
});

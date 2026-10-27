// #15 (хвост #14): барьер против ТИХОГО GitHub-ДЕФОЛТА на швах.
//
// Классов дефекта «ядро знает про GitHub» два, и барьер до сих пор был только на первый:
//
//   A. ядро исполняет команду форжа само — `sh(`gh pr list …`)`  → храповик в core-purity (#55)
//   B. ядро берёт GitHub-реализацию шва ДЕФОЛТОМ — `phaseMergedFn = phaseMerged` → ничто
//
// В строке класса B нет ни `gh`, ни `glab`: реализация приезжает env-инъекцией из
// composition root, а грепу по тексту команды видеть тут нечего. Именно так и прожил #14:
// `runLoop` ходил через шов, а `preflight` брал GitHub-команду — половина шва, и вскрылось
// это только на ВТОРОЙ фазе живого прогона, ложным диагнозом «инвариант зависимых фаз не
// подтверждён» вместо честного «в ядре чужая команда».
//
// Барьер проверяет НЕ то, что дефолт «правильный по смыслу», а то, что он ведёт к шву:
// выражение дефолта обязано упоминать `adapters.`. Всё остальное — известный долг,
// названный файлом и числом (тот же храповик, что у #55).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { stripComments } from './strip-comments.ts';

const CANON_ROOT = resolve(import.meta.dirname, '..');

// Имена DI-параметров, за которыми стоит примитив ФОРЖА. Список ведётся руками — имя
// параметра в ядре и имя метода шва связаны смыслом, а не механически (`isPhaseMerged` →
// `phaseMergedFn`, `listReadyIssues` → `openIssuesFn`), и вывести одно из другого нельзя.
// Отставание списка сторожит `ширина контракта шва` ниже: вырос TaskSourceAdapter —
// сначала сюда.
const FORGE_PARAMS = [
    'checkAuthFn',
    'openIssuesFn',
    'allOpenIssuesFn',
    'hasAnyIssuesFn',
    'milestoneLabelsFn',
    'getIssueFn',
    'prCommentsFn',
    'commentOnPrFn',
    'createPrFn',
    'findOpenPrFn',
    'prHeadShaFn',
    'phaseMergedFn',
    'mergedPhasePrFn',
    'mergePrFn',
    'addBlockedLabelFn',
    'removeBlockedLabelFn',
    'closeMilestoneByTitleFn',
    'syncProjectBoardFn',
    'commentOnIssueFn',
    'closeIssueFn',
    'blockIssueFn',
    'createIssueFn',
    // #269: чек PR у форжа. Оба метода необязательные, и барьер их ЧУТЬ НЕ ПРОПУСТИЛ:
    // регулярка ниже искала `^ {4}(\w+)\(` и на `pullRequestChecks?(` не срабатывала —
    // контракт вырос на два примитива форжа, а список молчал. Вопросительный знак теперь
    // в паттерне; сам случай — напоминание, что барьер сторожит форму объявления, и любая
    // новая форма (перегрузка, поле-функция) для него невидима, пока не дописана.
    'forgeChecksFn',
    'forgeDiagnosisFn',
    // #56: секреты площадки для редакции вывода упавшей сессии — их называет шов.
    'secretEnvNamesFn',
    // #65: статус вехи-накопителя — разобранный том закрыт, адрес его пропускает.
    'milestoneOpenFn',
    // #125: лента комментариев карточки для сверки начатого намерения (#94).
    'issueCommentsFn',
] as const;

// Известный долг: где дефолт примитива форжа ещё не ведёт к шву. Сверяется РАВЕНСТВОМ,
// как DEBT в core-purity: «не больше» позволило бы долгу просесть и снова вырасти до
// старой отметки, оставаясь зелёным.
//
// Почему долг есть — и почему он не дефект сегодня. Причины РАЗНЫЕ, и путать их нельзя:
//
//   • `review.ts` (2) и `prHeadShaFn` в `gate.ts` (×2 — у checksGreen и tryMergePhase) —
//     фабрика получает от composition root
//     ленивую обёртку над швом. Дефолт ведёт к шву, просто не текстом в этой строке.
//   • `mergePrFn`/`phaseMergedFn`/`findOpenPrFn` в `gate.ts` (3) — фабрика получает
//     GitHub-РЕАЛИЗАЦИЮ (см. FACTORY_DEBT ниже). К шву их ведёт явный прокид из `runLoop`
//     плюс запрет свапа шва `gate` (`MERGE_PATH_BOUND_SEAMS`), а не инъекция.
//
// Число сторожит одно: чтобы таких мест не становилось больше.
const DEBT: Record<string, number> = {
    'core/gate.ts': 5,
    'core/review.ts': 2,
};

function trackedSources(): string[] {
    const ls = spawnSync('git', ['-C', CANON_ROOT, 'ls-files'], { encoding: 'utf-8' });
    if (ls.status !== 0) {
        throw new Error(`git ls-files в ${CANON_ROOT} не отработал: ${ls.stderr || ls.error}`);
    }
    return (
        ls.stdout
            .split('\n')
            .map((s) => s.trim())
            // Корневые entry (`ralph.js`, `gate-env.mts`) — тоже ядро, и core-purity их
            // сканирует. Дефолтов форжа там сегодня нет, но узкий фильтр — это молчаливое
            // исключение: файл, который барьер не видит, выглядит как чистый (ревью !4).
            .filter((rel) => /^((core|runtime|shared)\/.+|[^/]+)\.m?ts$/.test(rel))
            .filter((rel) => !/\.test\.m?ts$/.test(rel))
            .sort()
    );
}

const SOURCES = trackedSources();

/**
 * Выражение дефолта, начиная с позиции `=`: до запятой ВЕРХНЕГО уровня либо до конца
 * объявления. Посимвольно, а не «до конца строки»: `checkAuthFn = () => { … }` занимает
 * три строки, и построчный разбор увидел бы `() => {` без тела — то есть счёл бы обёртку
 * над швом локальным дефолтом и потребовал бы записать в долг работающий код.
 */
function defaultExpression(src: string, from: number): string {
    let depth = 0;
    let i = from;
    for (; i < src.length; i++) {
        const c = src[i];
        // Строковый литерал проматываем целиком: скобка внутри строки баланса не меняет.
        // Без этого `fail(':)')` обрезал бы выражение на закрывающей скобке смайлика —
        // и дефолт, ведущий к шву дальше по строке, читался бы как локальный (ревью !4).
        if (c === "'" || c === '"' || c === '`') {
            i++;
            while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
            continue;
        }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') {
            if (depth === 0) break;
            depth--;
        } else if ((c === ',' || c === ';') && depth === 0) break;
    }
    return src.slice(from, i);
}

export type TSeamDefault = { line: number; param: string; viaSeam: boolean; excerpt: string };

/**
 * DI-дефолты примитивов форжа в исходнике. Комментарии сняты: докблоки ядра законно
 * объясняют, какой примитив куда прокидывается, и называют имена — это не код.
 */
export function seamDefaults(source: string): TSeamDefault[] {
    // dropTrailing: хвостовой `// …` здесь ЧАСТЬ выражения, а не пояснение рядом с ним.
    // Пометка `// adapters.taskSource` возле локального вызова глушила барьер наглухо, и
    // опасность не атакующая: ядро поминает `adapters.taskSource` в комментариях сплошь и
    // рядом, так что выключить барьер можно было невзначай (показано мутацией, ревью !4).
    const code = stripComments(source, { dropTrailing: true });
    // `=` после имени параметра, необязательная аннотация типа между ними
    // (`prCommentsFn: PrCommentsFn = prComments`). Аннотация не переходит на другую строку
    // (`[^=;\n]`): иначе группа проползала через перевод строки до ЧУЖОГО `=` ниже и
    // давала фантомную находку с чужой строки.
    // `??=`/`||=`/`&&=` — та же постановка дефолта, только в теле функции; без них
    // рефакторинг `opts.phaseMergedFn ??= phaseMerged` уезжал мимо барьера целиком.
    //
    // Цена запрета переноса строк в аннотации: МНОГОСТРОЧНАЯ инлайновая аннотация с
    // дефолтом (`phaseMergedFn: (\n p: TPhase,\n) => boolean = phaseMerged`) не матчится
    // вовсе — обмен ложного срабатывания на слепоту. Принято осознанно: конвенция ядра —
    // именованные алиасы (`PhaseMergedFn`), однострочные, и prettier рвёт после `=`, а не
    // внутри алиаса. Появится инлайновая многострочная аннотация — сюда придётся вернуться.
    const re = new RegExp(
        `\\b(${FORGE_PARAMS.join('|')})\\b\\s*(?::[^=;\\n]*?)?(?:\\?\\?|\\|\\||&&)?=`,
        'g',
    );
    const out: TSeamDefault[] = [];
    for (const m of code.matchAll(re)) {
        const at = (m.index ?? 0) + m[0].length;
        const expr = defaultExpression(code, at);
        out.push({
            line: code.slice(0, m.index).split('\n').length,
            param: m[1],
            // Дефолт обязан ВЕСТИ К ШВУ. Проверяем упоминание `adapters.`, а не конкретный
            // метод: обёртки бывают ленивыми (`() => adapters.taskSource.checkAuth()`) —
            // и должны быть, реестр собирается ниже по файлу.
            viaSeam: /\badapters\./.test(expr),
            excerpt: `${m[1]} =${expr}`.replace(/\s+/g, ' ').slice(0, 100),
        });
    }
    return out;
}

describe('seamDefaults — что считается тихим дефолтом', () => {
    it('ловит дефолт, ведущий к локальной GitHub-реализации', () => {
        const found = seamDefaults('    phaseMergedFn = phaseMerged,\n');
        expect(found).toHaveLength(1);
        expect(found[0]?.viaSeam).toBe(false);
    });

    it('дефолт через шов нарушением не считает', () => {
        const found = seamDefaults('    phaseMergedFn = adapters.taskSource.isPhaseMerged,\n');
        expect(found[0]?.viaSeam).toBe(true);
    });

    it('видит МНОГОСТРОЧНУЮ обёртку над швом целиком', () => {
        // Ровно форма `checkAuthFn` из preflight: построчный разбор оборвался бы на `{`.
        const found = seamDefaults(
            '    checkAuthFn = () => {\n        adapters.taskSource.checkAuth();\n    },\n',
        );
        expect(found[0]?.viaSeam).toBe(true);
    });

    it('не путает аннотацию типа со значением дефолта', () => {
        const found = seamDefaults('    prCommentsFn: PrCommentsFn = prComments,\n');
        expect(found[0]?.viaSeam).toBe(false);
    });

    it('упоминание примитива в комментарии дефолтом не считает', () => {
        const found = seamDefaults('    // раньше здесь стоял phaseMergedFn = phaseMerged\n');
        expect(found).toHaveLength(0);
    });

    // ── Обходы, показанные ревью !4 живой мутацией ──────────────────────────
    // Каждый ниже когда-то проезжал мимо барьера. Тест держит дыру закрытой: барьер,
    // чей обход известен, но не зафиксирован, зарастает обратно первым же рефакторингом.

    it('хвостовой комментарий с `adapters.` швом дефолт НЕ делает', () => {
        // Самый опасный из обходов — не атакующий, а случайный: ядро поминает
        // `adapters.taskSource` в пояснениях сплошь и рядом.
        //
        // Комментарий ВНУТРИ значения, а не после запятой: с запятой тест был инертен —
        // хвост отсекал `defaultExpression`, и зелёным он оставался даже со снятым
        // `dropTrailing`, то есть не пинил ничего (ревью правок !4).
        const found = seamDefaults(
            '    phaseMergedFn = (p) => // как adapters.taskSource.isPhaseMerged\n' +
                '        phaseMerged(p),\n',
        );
        expect(found[0]?.viaSeam).toBe(false);
    });

    it('и в многострочном теле обёртки тоже', () => {
        const found = seamDefaults(
            '    phaseMergedFn = (p) => {\n' +
                '        return phaseMerged(p); // как adapters.taskSource.isPhaseMerged\n' +
                '    },\n',
        );
        expect(found[0]?.viaSeam).toBe(false);
    });

    it('ловит дефолт, поставленный `??=` в теле функции', () => {
        const found = seamDefaults('    opts.phaseMergedFn ??= phaseMerged;\n');
        expect(found).toHaveLength(1);
        expect(found[0]?.viaSeam).toBe(false);
    });

    it('скобка внутри строкового литерала выражение не рвёт', () => {
        // Обрыв на `)` смайлика прятал бы остаток выражения — и дефолт, ведущий к шву,
        // читался бы как локальный: ложное срабатывание, от которых барьеры отключают.
        const found = seamDefaults(
            "    phaseMergedFn = (p) => fail(':)') ?? adapters.taskSource.isPhaseMerged(p),\n",
        );
        expect(found[0]?.viaSeam).toBe(true);
    });

    it('аннотация типа не проползает на следующую строку за чужим `=`', () => {
        // БЕЗ `;` в конце (ASI): с точкой с запятой тест был инертен — её и прежний класс
        // `[^=;]` не пропускал, фантома на таком входе не было никогда (ревью правок !4).
        const found = seamDefaults(
            'function f(env: { phaseMergedFn: PhaseMergedFn }) {\n    const a = 1\n}\n',
        );
        expect(found).toHaveLength(0);
    });

    it('параметр БЕЗ дефолта не находка: его обязан передать вызывающий', () => {
        expect(seamDefaults('    phaseMergedFn: PhaseMergedFn;\n')).toHaveLength(0);
    });
});

describe('дефолты примитивов форжа ведут к шву (#15)', () => {
    it('скан видит ядро целиком, а долг назван по существующим файлам', () => {
        // Опечатка в фильтре превратила бы it.each в пустой набор — сьют остался бы
        // зелёным, не проверив ничего.
        expect(SOURCES.length).toBeGreaterThan(15);
        expect(SOURCES).toContain(join('core', 'orchestrator.ts'));
        for (const rel of Object.keys(DEBT)) {
            expect(SOURCES, `в долге назван файл ${rel}, которого нет в скане`).toContain(rel);
        }
    });

    it('в орхестраторе дефолты примитивов форжа есть — иначе барьер сторожит пустоту', () => {
        // Страж от ложного зелёного: переименовали параметры, разъехался FORGE_PARAMS —
        // и скан честно не находит НИЧЕГО, отчего выглядит идеально чистым.
        const found = seamDefaults(
            readFileSync(join(CANON_ROOT, 'core', 'orchestrator.ts'), 'utf-8'),
        );
        expect(found.length).toBeGreaterThan(10);
        expect(found.every((f) => f.viaSeam)).toBe(true);
    });

    it.each(SOURCES)('%s — дефолты примитивов форжа в пределах известного долга', (rel) => {
        const local = seamDefaults(readFileSync(join(CANON_ROOT, rel), 'utf-8')).filter(
            (f) => !f.viaSeam,
        );
        const detail = local.map((f) => `\n  ${String(f.line)}: ${f.excerpt}`).join('');
        const budget = DEBT[rel] ?? 0;
        expect(
            local.length,
            budget === 0
                ? `Дефолт примитива форжа в ${rel} не ведёт к шву — так жил #14:${detail}`
                : `Долг ${rel} изменился: было ${String(budget)}, стало ${String(local.length)}. ` +
                      `Вырос — прокинь шов; убавился — опусти число в DEBT:${detail}`,
        ).toBe(budget);
    });
});

// ── Вторая половина класса B: примитив, отданный фабрике ядра ────────────────
// Дефолт DI-параметра — не единственная дверь. `createGateRunner`/`createReviewModule`
// получают примитивы форжа env-инъекцией, и дальше ВСЕ дефолты внутри модуля ведут туда.
// Значит одна строка composition root решает за весь файл: отдал GitHub-реализацию —
// и `checksGreen`, зовущий свой дефолт, спросит голову PR у `gh` при любом выбранном
// адаптере. Ровно это и было у `gateRunChecks` до #15.
//
// Форм записи две, и обе учитываются: `prHeadSha,` (shorthand, ведёт к локальной функции)
// и `prHeadSha: (n) => adapters.taskSource.pullRequestHeadSha(n)` (обёртка над швом).
describe('фабрики ядра получают примитивы форжа через шов (#15)', () => {
    // Ключи env, за которыми стоит примитив форжа. Имя ключа = имя локальной функции,
    // поэтому shorthand выглядит невинно — и это его главная опасность.
    const FORGE_KEYS = [
        'mergePr',
        'phaseMerged',
        'prHeadSha',
        'findOpenPr',
        'milestoneLabels',
        'prComments',
        'openIssues',
        'allOpenIssues',
        'hasAnyIssues',
        'issueDetails',
        'commentOnPr',
    ];

    // Долг: примитивы мердж-пути. Гейт получает их локальными, и это сегодня безопасно —
    // `runLoop` прокидывает в `tryMergePhase` методы выбранного адаптера явно, а свап шва
    // `gate` отвергает `MERGE_PATH_BOUND_SEAMS`. Переводить их на ленивый шов заодно с #15
    // нельзя: мердж-путь — самая дорогая тропа в системе, и трогать её надо отдельным PR
    // со своим разбором, а не прицепом к барьеру.
    const FACTORY_DEBT: Record<string, number> = { createGateRunner: 3 };

    function factoryArgs(src: string, factory: string): string {
        const at = src.indexOf(`${factory}({`);
        if (at < 0) throw new Error(`вызов ${factory}({ … }) в orchestrator.ts не найден`);
        let depth = 0;
        let i = src.indexOf('{', at);
        const from = i;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) break;
        }
        return src.slice(from, i);
    }

    const ORCH_SRC = readFileSync(join(CANON_ROOT, 'core', 'orchestrator.ts'), 'utf-8');

    /**
     * Примитивы форжа, отданные фабрике МИМО шва. Отдельная функция, а не тело `it.each`:
     * иначе проверить её можно только через настоящий orchestrator.ts, и регресс самой
     * проводки (например, возврат среза по первой запятой вместо балансного разбора)
     * не поймает никто — тест на `defaultExpression` зелен, а скан уже дырявый.
     */
    function factoryViolations(args: string): string[] {
        const local: string[] = [];
        for (const key of FORGE_KEYS) {
            // Shorthand `key,` — значение и есть локальная функция.
            if (new RegExp(`(^|[{,\\s])${key}\\s*,`).test(args)) {
                local.push(`${key} (shorthand)`);
                continue;
            }
            const m = new RegExp(`(^|[{,\\s])${key}\\s*:`).exec(args);
            if (!m) continue;
            // Тем же балансным разбором, что и DI-дефолты: срез «до запятой с переводом
            // строки» ломался на многострочной сигнатуре, которую prettier переносит
            // сам (`commentOnPr: (n: number,\n text: string) => adapters.…`), обрезая
            // значение до `(n: number` — то есть краснел бы на исправном коде.
            const value = defaultExpression(args, m.index + m[0].length);
            if (!/\badapters\./.test(value)) local.push(`${key}: ${value.trim().slice(0, 60)}`);
        }
        return local;
    }

    /**
     * ВСЯ проводка фабричного скана одной функцией: снятие комментариев → вырезание
     * аргумента фабрики → поиск примитивов мимо шва.
     *
     * Тесты обязаны ходить именно сюда, а не собирать вход руками: пока синтетика звала
     * `factoryViolations` напрямую, снятие `dropTrailing` у боевого исходника не красило
     * НИЧЕГО — тест доказывал работоспособность куска, мимо которого дыра и проходила.
     *
     * `dropTrailing` здесь обязателен по той же причине, что и в `seamDefaults`: хвостовой
     * `// adapters.taskSource` ВНУТРИ многострочного значения оставлял скан слепым. Правка
     * первого круга ревью закрыла эту дыру лишь в одной из двух половин файла.
     */
    function factoryScan(source: string, factory: string): string[] {
        return factoryViolations(
            factoryArgs(stripComments(source, { dropTrailing: true }), factory),
        );
    }

    it.each(['createGateRunner', 'createReviewModule'])(
        '%s — примитивы форжа ведут к шву',
        (factory) => {
            const local = factoryScan(ORCH_SRC, factory);
            const budget = FACTORY_DEBT[factory] ?? 0;
            expect(
                local.length,
                budget === 0
                    ? `${factory} получает примитив форжа мимо шва — так жил #14: ${local.join('; ')}`
                    : `Долг ${factory} изменился: было ${String(budget)}, стало ${String(local.length)} ` +
                          `(${local.join('; ')}). Вырос — прокинь шов; убавился — опусти число.`,
            ).toBe(budget);
        },
    );

    it('скан фабрики: комментарий ВНУТРИ значения швом его не делает', () => {
        // Дыра, дожившая до второго круга ревью: `seamDefaults` хвостовые уже резал, а
        // фабричный скан — нет, и та же мутация проходила мимо него молча.
        // Комментарий ВНУТРИ значения (до запятой): стоящий ПОСЛЕ запятой отсекает сам
        // `defaultExpression`, и тест на нём зелен даже со снятым `dropTrailing` — ровно
        // та инертность, которую ревью правок и поймало.
        const src =
            'createReviewModule({\n' +
            '    milestoneLabels: (m: string) => // как adapters.taskSource.listMilestoneLabels\n' +
            '        localLabels(m),\n});';
        expect(factoryScan(src, 'createReviewModule')).toHaveLength(1);
    });

    it('скан фабрики: многострочное значение до конца, а не до первой запятой', () => {
        // Пин проводки, а не `defaultExpression` в отрыве: возврат старого среза
        // `expr.search(/,\s*\n/)` красит ИМЕННО этот тест.
        const src =
            'createReviewModule({\n    commentOnPr: (n: number,\n        text: string) =>\n' +
            '        adapters.taskSource.commentOnPullRequest(n, text),\n});';
        expect(factoryScan(src, 'createReviewModule')).toHaveLength(0);
    });

    it('многострочная сигнатура значения не обрезается по первой запятой', () => {
        // prettier переносит длинные списки параметров сам, и срез «до запятой с переводом
        // строки» обрубал значение до `(n: number` — красный на исправном коде (ревью !4).
        const args =
            '{\n    commentOnPr: (n: number,\n        text: string) =>\n' +
            '        adapters.taskSource.commentOnPullRequest(n, text),\n}';
        expect(/\badapters\./.test(defaultExpression(args, args.indexOf(':') + 1))).toBe(true);
    });

    it('НЕГАТИВНЫЙ: голову PR гейту отдаёт шов, а не GitHub-реализация', () => {
        // Именной ассерт поверх счётчика: `prHeadSha` ушёл из долга осознанно (#15), и
        // возврат его в shorthand обязан краснеть с внятным диагнозом, а не «долг вырос
        // с 3 до 4» — читателю иначе не видно, какой именно примитив отвалился.
        const args = factoryArgs(
            stripComments(ORCH_SRC, { dropTrailing: true }),
            'createGateRunner',
        );
        expect(/(^|[{,\s])prHeadSha\s*,/.test(args)).toBe(false);
        expect(args).toMatch(/prHeadSha:[^,]*adapters\.taskSource\.pullRequestHeadSha/);
    });
});

describe('ширина контракта шва', () => {
    it('методов у TaskSourceAdapter ровно столько, сколько имён в FORGE_PARAMS', () => {
        // FORGE_PARAMS ведётся руками. Новый метод шва — повод дописать туда имя его
        // DI-параметра: иначе следующий примитив форжа приедет с тихим дефолтом, а барьер
        // промолчит, потому что не знает такого имени.
        const src = stripComments(
            readFileSync(join(CANON_ROOT, 'adapters', 'adapters.ts'), 'utf-8'),
        );
        const block = src.slice(src.indexOf('type TaskSourceAdapter'));
        const methods = [...block.slice(0, block.indexOf('\n};')).matchAll(/^ {4}(\w+)\??\(/gm)];
        // Сверяем с ДЛИНОЙ FORGE_PARAMS, а не с литералом. С числом у теста был ленивый
        // проход: поднять 22 на 23, не тронув список, — и следующий примитив форжа приедет
        // с тихим дефолтом при зелёном сьюте, ровно ради чего тест и заведён (ревью !4).
        // Теперь единственный способ его успокоить — дописать имя DI-параметра в список.
        expect(
            methods.length,
            'Контракт TaskSourceAdapter разошёлся с FORGE_PARAMS: у шва ' +
                `${String(methods.length)} методов, в списке ${String(FORGE_PARAMS.length)} имён. ` +
                'Появился метод — допиши имя его DI-параметра в FORGE_PARAMS.',
        ).toBe(FORGE_PARAMS.length);
    });
});

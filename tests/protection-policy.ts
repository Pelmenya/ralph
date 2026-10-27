// #49: политика защиты — какие пути требуют одобрения человека и чем это проверяется.
//
// Класс отказа, ради которого модуль заведён: барьер одобрения исчезает, НЕ сломавшись.
// Защищаемый путь выпал из `patterns` правила ревью — и PR, меняющий ревизию ядра или хук
// сессии, мерджится без человека при зелёном гейте. Первый раз это случилось не правкой, а
// раскладкой: точный путь gitlink без слэша не матчился маской `**`, и сабмодуль ядра стоял
// «под защитой», которой не было. Сабмодуль ушёл, класс остался: файл в корне (`./ralph`)
// маской каталога не покрывается. Второй раз — в этом же модуле: политика и список
// называли корневой `ralph.config.json`, а раннер читает `.claude/ralph/ralph.config.json`.
// Тест был зелёным на дыре, поэтому путь конфига теперь берётся из константы ядра.
//
// Список и строгий матчер переехали в ядро (`core/protected-paths.ts`, #139): по тому же
// списку гейт мерджа держит пути на площадке, где правило ревью их не держит. Почему матчер
// строже площадки — в докблоке там. Canary (`docs/lock-protection-canary.md`) мерил только
// `.ralph/**` над `.ralph/core.lock` на SourceCraft — накрывает, но литерал lock всё равно стоит.
//
// Сверяется ФАКТИЧЕСКИЙ файл политики (`.sourcecraft/review.yaml`), а не пересказ в доках:
// пересказ остаётся верным, когда файл уже разъехался с ним. GitHub-пару (CODEOWNERS,
// ruleset) этот модуль НЕ сверяет — намеренно, решением человека 27.10: на GitHub барьер
// одобрения держит не ruleset, а гейт мерджа раннера, который отказывается мерджить PR с
// защищаемыми путями (#139, решение задачи 50). Ruleset по путям защищать не умеет, и
// статическая сверка файлов, которые ничего не защищают, барьером не была бы. Проверяется
// только, что сами файлы пары защищены политикой SourceCraft: PR не заводит их без человека.

import { PROTECTED_PATHS, patternCovers, type ProtectedPath } from '../core/protected-paths.ts';

// Список и матчер живут в ядре (#139): по ним же гейт мерджа держит пути там, где площадка
// их не держит. Здесь — только сверка правила ревью SourceCraft.
export { PROTECTED_PATHS, patternCovers, type ProtectedPath };

/** Правило ревью площадки: маски путей и цена одобрения. */
export interface ReviewRule {
    patterns: string[];
    needShips: number;
    reviewers: string[];
}

/** Точный ли путь: флаг или файл в корне (см. докблок модуля). */
export function isExactPath(p: ProtectedPath): boolean {
    return p.exact || !p.path.includes('/');
}

/** Правила, которые действительно требуют человека: ship ≥ 1 и названный ревьюер. */
export function approvalRules(rules: readonly ReviewRule[]): ReviewRule[] {
    return rules.filter((r) => r.needShips >= 1 && r.reviewers.length > 0);
}

/**
 * Защищаемые пути, которых политика НЕ требует одобрять. Пустой массив — всё защищено.
 * Пустая политика (нет ни одного правила с одобрением) — отказ, а не «нечего проверять».
 */
export function unprotectedPaths(
    rules: readonly ReviewRule[],
    paths: readonly ProtectedPath[] = PROTECTED_PATHS,
): ProtectedPath[] {
    const patterns = approvalRules(rules).flatMap((r) => r.patterns);
    if (patterns.length === 0) {
        throw new Error('политика защиты пуста: ни одного правила с need_ships ≥ 1 и ревьюером');
    }
    if (paths.length === 0) throw new Error('список защищаемых путей пуст');
    return paths.filter((p) =>
        isExactPath(p)
            ? !patterns.includes(p.path)
            : !patterns.some((pat) => patternCovers(pat, p.path)),
    );
}

/** Снять кавычки значения; незакрытая или лишняя кавычка — отказ, а не другой путь. */
function unquote(s: string): string {
    const m = /^(['"])(.*)\1$/.exec(s);
    const value = m ? m[2] : s;
    if (/['"]/.test(value)) throw new Error(`кавычка в значении не разобрана: «${s}»`);
    return value;
}

/**
 * Значение строки YAML без хвостового комментария `##` / `#`. `#` ВНУТРИ значения не
 * поддерживается даже в кавычках: хвост отрезается, и обломок значения с открытой кавычкой
 * `unquote` отвергает — путь молча не меняется.
 */
function lineValue(line: string): string {
    return line.replace(/\s+#.*$/, '').trim();
}

const isBlank = (line: string): boolean => /^\s*(#.*)?$/.test(line);
const indentOf = (line: string): number => line.search(/\S/);

/** Ключи правила и его `reviewers`. Ключ не из списка может сузить правило — отказ. */
const RULE_KEYS = new Set(['patterns', 'reviewers']);
const REVIEWER_KEYS = new Set(['usernames', 'assign', 'need_ships', 'ignore_self_ship']);

/** Строка `rules:` прямо под `codereview:` на нулевом отступе — и только там. */
function findRules(lines: readonly string[]): number {
    const at = lines.findIndex((l) => /^codereview:\s*(#.*)?$/.test(l));
    if (at < 0) throw new Error('в конфиге ревью нет секции codereview');
    let childIndent = -1;
    for (let i = at + 1; i < lines.length; i++) {
        if (isBlank(lines[i])) continue;
        const indent = indentOf(lines[i]);
        if (indent === 0) break;
        if (childIndent < 0) childIndent = indent;
        if (indent === childIndent && /^\s*rules:\s*(#.*)?$/.test(lines[i])) return i;
    }
    throw new Error('в секции codereview нет rules');
}

/**
 * Разбор секции `codereview.rules` конфига ревью SourceCraft. Парсер узкий и
 * fail-closed: зависимостей у сьюта на YAML нет, а форма, которую он не узнал, — отказ,
 * а не пустой список правил (пустой список читался бы как «защищать нечего»). Узнаёт он
 * ровно эту форму: правило — `patterns` и `reviewers`, у `reviewers` — `usernames`,
 * `assign`, `need_ships`, `ignore_self_ship`. Незнакомый ключ, ключ не на своём
 * отступе и повтор ключа — отказ: любой из них может сузить правило мимо сверки.
 * `need_ships` правила — тот, что под `reviewers`.
 */
export function parseReviewRules(text: string): ReviewRule[] {
    const lines = text.split('\n');
    const rulesAt = findRules(lines);
    const rulesIndent = indentOf(lines[rulesAt]);

    const rules: ReviewRule[] = [];
    let rule: ReviewRule | null = null;
    let keyIndent = -1;
    let inReviewers = false;
    let list: 'patterns' | 'reviewers' | null = null;
    let seen = new Set<string>();
    for (const raw of lines.slice(rulesAt + 1)) {
        if (isBlank(raw)) continue;
        const indent = indentOf(raw);
        if (indent <= rulesIndent) break;
        const line = lineValue(raw);
        const item = /^-\s+(.*)$/.exec(line);
        if (item && /^patterns:\s*$/.test(item[1])) {
            rule = { patterns: [], needShips: 0, reviewers: [] };
            rules.push(rule);
            keyIndent = indent + 2;
            inReviewers = false;
            list = 'patterns';
            seen = new Set(['правила.patterns']);
            continue;
        }
        if (!rule || indent < keyIndent) {
            throw new Error(`правило ревью без patterns первым ключом: «${raw.trim()}»`);
        }
        if (item) {
            if (!list || indent === keyIndent) {
                throw new Error(`элемент списка вне patterns/usernames: «${raw.trim()}»`);
            }
            const value = unquote(item[1]);
            if (list === 'patterns') rule.patterns.push(value);
            else rule.reviewers.push(value);
            continue;
        }
        const kv = /^([\w-]+):\s*(.*)$/.exec(line);
        if (!kv) throw new Error(`строка правила не разобрана: «${raw.trim()}»`);
        const [, key, value] = kv;
        if (indent === keyIndent) inReviewers = false;
        else if (!inReviewers) throw new Error(`ключ не на своём отступе: «${raw.trim()}»`);
        const scope = inReviewers ? 'reviewers' : 'правила';
        const known = inReviewers ? REVIEWER_KEYS : RULE_KEYS;
        if (!known.has(key)) throw new Error(`незнакомый ключ ${scope}: «${key}»`);
        if (seen.has(`${scope}.${key}`)) throw new Error(`ключ ${scope} повторён: «${key}»`);
        seen.add(`${scope}.${key}`);
        list = key === 'usernames' ? 'reviewers' : null;
        if (key === 'reviewers') inReviewers = true;
        if (key === 'need_ships') {
            if (!/^\d+$/.test(value)) throw new Error(`need_ships не число: «${value}»`);
            rule.needShips = Number(value);
        }
    }
    if (rules.length === 0) throw new Error('секция rules пуста');
    for (const r of rules) {
        if (r.patterns.length === 0) throw new Error('правило ревью с пустым patterns');
    }
    return rules;
}

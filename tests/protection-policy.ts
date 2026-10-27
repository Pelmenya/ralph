// #49: политика защиты — какие пути требуют одобрения человека и чем это проверяется.
//
// Класс отказа, ради которого модуль заведён: барьер одобрения исчезает, НЕ сломавшись.
// Защищаемый путь выпал из `patterns` правила ревью — и PR, меняющий ревизию ядра или хук
// сессии, мерджится без человека при зелёном гейте. Первый раз это случилось не правкой, а
// раскладкой: точный путь gitlink без слэша не матчился маской `**`, и сабмодуль ядра стоял
// «под защитой», которой не было. Сабмодуль ушёл, класс остался: файл в корне (`./ralph`)
// маской каталога не покрывается. Второй раз — в этом же модуле: политика и список ниже
// называли корневой `ralph.config.json`, а раннер читает `.claude/ralph/ralph.config.json`.
// Тест был зелёным на дыре, поэтому путь конфига теперь берётся из константы ядра.
//
// Поэтому матчер здесь нарочно СТРОЖЕ любой площадки, а не точнее её:
//   - `x/**` покрывает только то, что ЛЕЖИТ ПОД `x/`, но не сам `x`;
//   - файл, названный точным путём, считается защищённым только литералом в политике:
//     маска, которая «по идее» его накрывает, не в счёт — ровно на этой разнице и прожил
//     дефект с gitlink. Файл в КОРНЕ (путь без `/`) точный всегда, флаг ему не нужен:
//     здесь `**` и `*.json` ловят корень, а как их разворачивает площадка у корня, не
//     мерено. Canary (`docs/lock-protection-canary.md`) мерил только `.ralph/**` над
//     `.ralph/core.lock` на SourceCraft — накрывает, но литерал lock всё равно стоит.
// Ошибка такого матчера — ложный красный, а не ложный зелёный, и это намеренная цена.
//
// Сверяется ФАКТИЧЕСКИЙ файл политики (`.sourcecraft/review.yaml`), а не пересказ в доках:
// пересказ остаётся верным, когда файл уже разъехался с ним. GitHub-пару (CODEOWNERS,
// ruleset) этот модуль НЕ сверяет — проверяется только, что её файлы защищены политикой
// SourceCraft, чтобы PR не мог тихо завести ослабленную пару. Это долг, и canary показал
// его цену: `require_code_owner_review` при `required_approving_review_count: 0` не
// защищает ничего, а ловится это статически. Сверщик пары заведён карточкой из ревью PR
// фазы 14 (`docs/lock-protection-canary.md`, «Открытые вопросы»).

import { CONSUMER_CONFIG_REL } from '../core/consumer-config-path.ts';

/** Правило ревью площадки: маски путей и цена одобрения. */
export interface ReviewRule {
    patterns: string[];
    needShips: number;
    reviewers: string[];
}

/** Защищаемый путь: что именно должно требовать человека и почему. */
export interface ProtectedPath {
    path: string;
    /**
     * Точный путь файла: защищён только литералом, маска не в счёт. Путь в корне точный
     * всегда, независимо от флага (см. докблок модуля).
     */
    exact: boolean;
    why: string;
}

export const PROTECTED_PATHS: readonly ProtectedPath[] = [
    {
        path: '.ralph/core.lock',
        exact: true,
        why: 'ревизия ядра: правка lock меняет код, который ведёт петлю',
    },
    {
        // Проба маски, а не реальный файл: такого артефакта нет, и это нарочно. Каталог
        // `.ralph/` принадлежит launcher, и любой файл, который появится в нём рядом с
        // lock, обязан требовать человека без правки этого списка.
        path: '.ralph/<любой будущий файл>',
        exact: false,
        why: '`.ralph/**` — всё, что ляжет рядом с lock, включая будущие файлы',
    },
    { path: 'ralph', exact: true, why: 'шим launcher в корне: он решает, какую ревизию запускать' },
    {
        path: '.claude/ralph/hooks.json',
        exact: false,
        why: 'контракт потребителя: данные контура хуков открывают вызов, как код',
    },
    {
        path: CONSUMER_CONFIG_REL,
        exact: false,
        why: 'контракт потребителя: состав чеков гейта и раскладка корней — тот путь, что читает раннер',
    },
    {
        path: '.claude/settings.json',
        exact: false,
        why: 'проводка хуков: без неё хук лежит в дереве, но не вызывается',
    },
    { path: '.claude/hooks/guard.cjs', exact: false, why: '`.claude/hooks/**` — сами хуки сессии' },
    {
        path: '.sourcecraft/review.yaml',
        exact: false,
        why: 'конфиг ревью площадки: правка снимает одобрение со всего остального',
    },
    {
        path: '.sourcecraft/branches.yaml',
        exact: false,
        why: '`.sourcecraft/**` — защита ветки и CI площадки',
    },
    {
        path: '.github/CODEOWNERS',
        exact: false,
        why: 'GitHub-пара конфига ревью: владельцы путей',
    },
    {
        path: '.github/rulesets/main.json',
        exact: false,
        why: 'GitHub-пара конфига ревью: ruleset основной ветки',
    },
    {
        path: 'tests/protection-policy.ts',
        exact: false,
        why: 'этот барьер: выхолостить список здесь — то же, что убрать путь из политики',
    },
    {
        path: 'tests/protection-policy.test.ts',
        exact: false,
        why: 'проба барьера от противного и сверка фактического файла',
    },
];

function globToRegExp(pattern: string): RegExp {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
            // Хвост `/**` требует хотя бы один символ под каталогом: сам каталог (и gitlink
            // с тем же именем) им не покрыт.
            out += '/.+';
            i += 2;
        } else if (pattern.startsWith('**/', i)) {
            out += '(?:.*/)?';
            i += 2;
        } else if (pattern.startsWith('**', i)) {
            out += '.*';
            i += 1;
        } else if (ch === '*') {
            out += '[^/]*';
        } else if (ch === '?') {
            out += '[^/]';
        } else {
            out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

/** Покрывает ли маска путь — по строгой семантике модуля (см. докблок). */
export function patternCovers(pattern: string, path: string): boolean {
    return globToRegExp(pattern).test(path);
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

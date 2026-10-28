// #220: политика карточек, которые заводит сессия намерением `new-issue`.
//
// Инцидент 28.10: петля завела карточку, повторяющую её же карточку пятичасовой давности
// (тот же egress стенда, та же цепочка через прокси хоста), а все новые карточки падали во
// Входящие — включая ту, без которой не закрыть текущую фазу. Сортировку делала вахта, а
// веха успевала вырасти выше `maxIterations`, и брейкер срабатывал посреди ночи вместо
// предупреждения на старте.
//
// Отсюда три правила, и все — код, а не абзац промпта:
//   - ДУБЛЬ. Перед созданием — сверка с открытыми карточками вехи фазы и Входящих. Мера
//     детерминированная и объяснимая: человек, прочитавший `🗂 Дубль #N`, обязан увидеть,
//     ПОЧЕМУ, — поэтому не эмбеддинги, а три множества (пути файлов, номера карточек, слова
//     заголовка) и их пересечения числом. Пути весят больше всего: две карточки «про лимит»
//     с разными файлами — разные карточки, а одна и та же цепочка файлов под другим
//     заголовком — та же самая;
//   - КВОТА на сессию. Сорвавшаяся сессия штампует карточки пачкой; батч при этом не
//     отвергается (в нём могут лежать `close` и честные находки), а лишнее уходит во
//     Входящие с меткой разбора и пушем вахте;
//   - БЮДЖЕТ фазы. Открытых карточек вехи больше `maxIterations` — строка `⚠` при входе в
//     фазу и при росте вехи через `blocks`. Это предупреждение: стоп за человека решал бы,
//     какая карточка лишняя.
//
// Модуль чистый: ни чтения форжа, ни лога. Применение — `applySessionRequests`.

export const DEDUP_THRESHOLD = 0.6;
export const SESSION_NEW_ISSUE_QUOTA = 3;

export type TNewIssuePolicy = {
    // Порог сходства (0, 1]: от него и выше карточка считается дублем.
    dedupThreshold: number;
    // Сколько карточек сессия заводит обычным путём; лишние — во Входящие с меткой.
    sessionQuota: number;
    // Метка разбора на лишних карточках. Имя — проектное, поэтому только из конфига; не
    // задана — лишнее едет без метки, и пуш говорит это вслух.
    triageLabel: string | null;
};

const POLICY_KEYS = ['dedupThreshold', 'sessionQuota', 'triageLabel'];

// Секция `newIssues` конфига. Нет секции — дефолты: дубль и квота — барьеры, и выключать
// их молчанием конфига нельзя. Заданный мусор — отказ (fail-closed): `dedupThreshold: "0.6"`
// выглядит заданным, а работал бы как отсутствующий.
export function resolveNewIssuePolicy(raw: unknown): TNewIssuePolicy {
    if (raw === undefined || raw === null)
        return {
            dedupThreshold: DEDUP_THRESHOLD,
            sessionQuota: SESSION_NEW_ISSUE_QUOTA,
            triageLabel: null,
        };
    if (typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('newIssues: ожидался объект { dedupThreshold, sessionQuota, triageLabel }');
    const rec = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(rec).filter((k) => !POLICY_KEYS.includes(k));
    if (unknownKeys.length > 0)
        throw new Error(
            `newIssues: незнакомые ключи ${unknownKeys.join(', ')}; знакомы ${POLICY_KEYS.join(', ')}`,
        );
    const t = rec['dedupThreshold'] ?? DEDUP_THRESHOLD;
    if (typeof t !== 'number' || !(t > 0) || t > 1)
        throw new Error(
            `newIssues.dedupThreshold: число в (0, 1], пришло ${JSON.stringify(rec['dedupThreshold'])}`,
        );
    const q = rec['sessionQuota'] ?? SESSION_NEW_ISSUE_QUOTA;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 0)
        throw new Error(
            `newIssues.sessionQuota: целое ≥ 0, пришло ${JSON.stringify(rec['sessionQuota'])}`,
        );
    const label = rec['triageLabel'] ?? null;
    if (label !== null && (typeof label !== 'string' || label.trim() === ''))
        throw new Error(
            `newIssues.triageLabel: непустая строка, пришло ${JSON.stringify(rec['triageLabel'])}`,
        );
    return { dedupThreshold: t, sessionQuota: q, triageLabel: label };
}

// ── Сходство ─────────────────────────────────────────────────────────────────────

export type TIssueFingerprint = { words: Set<string>; paths: Set<string>; refs: Set<string> };

// Служебные слова заголовка: на них совпадает что угодно, и без отсева две любые
// карточки «для X» и «для Y» получали общее слово ни за что.
const STOP_WORDS = new Set([
    'для',
    'при',
    'без',
    'что',
    'как',
    'это',
    'или',
    'его',
    'над',
    'под',
    'через',
    'после',
    'перед',
    'вместо',
    'когда',
    'the',
    'and',
    'not',
    'for',
    'with',
]);

// Путь — токен с `/` или с расширением файла. Ссылки вырезаются до разбора: домен с путём
// иначе считался бы файлом репозитория.
const URL_RE = /https?:\/\/\S+/g;
const PATH_RE =
    /(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@[\]()-]+|\b[A-Za-z0-9_-]+\.(?:ts|mts|cts|js|mjs|cjs|json|jsonl|md|ya?ml|sh|toml)\b/g;
const REF_RE = /(?<![\w&])#(\d+)\b/g;

export function issueFingerprint({
    title,
    body,
}: {
    title: string;
    body: string;
}): TIssueFingerprint {
    const text = `${title}\n${body}`.replace(URL_RE, ' ');
    const paths = new Set(
        [...text.matchAll(PATH_RE)]
            .map((m) => m[0].replace(/^\.\//, '').replace(/[.)\]]+$/, ''))
            .filter((p) => p.length > 2),
    );
    const refs = new Set([...text.matchAll(REF_RE)].map((m) => m[1]));
    const words = new Set(
        title
            .replace(URL_RE, ' ')
            .replace(PATH_RE, ' ')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .split(/[^\p{L}\p{N}]+/u)
            .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)),
    );
    return { words, paths, refs };
}

// Вес измерения. Пути — главный признак «того же самого», номера — общая связь с одной
// карточкой, слова заголовка — слабейший: один и тот же смысл формулируют по-разному, а
// общие слова есть у разных задач одной зоны.
const WEIGHTS = { paths: 0.5, refs: 0.2, words: 0.3 } as const;

export type TSimilarity = { score: number; why: string };

function jaccard(a: Set<string>, b: Set<string>): { inter: string[]; union: number } {
    const inter = [...a].filter((x) => b.has(x));
    return { inter, union: new Set([...a, ...b]).size };
}

// Взвешенное пересечение по Жаккару. Измерение, пустое у ОБЕИХ карточек, в счёт не идёт —
// иначе две карточки без путей считались бы «совпавшими по путям» или, наоборот, теряли
// половину шкалы, и порог значил бы разное для разных карточек.
export function issueSimilarity(a: TIssueFingerprint, b: TIssueFingerprint): TSimilarity {
    let weighted = 0;
    let total = 0;
    const parts: string[] = [];
    const names = { paths: 'пути', refs: 'номера', words: 'слова заголовка' } as const;
    for (const dim of ['paths', 'refs', 'words'] as const) {
        const { inter, union } = jaccard(a[dim], b[dim]);
        if (union === 0) continue;
        weighted += WEIGHTS[dim] * (inter.length / union);
        total += WEIGHTS[dim];
        const shown = inter.slice(0, 3).join(', ');
        parts.push(
            `${names[dim]} ${String(inter.length)}/${String(union)}${shown ? ` (${shown})` : ''}`,
        );
    }
    const score = total === 0 ? 0 : weighted / total;
    return { score, why: `${parts.join('; ') || 'общих признаков нет'} → ${score.toFixed(2)}` };
}

export type TOpenCard = { number: number; title: string; body: string };

// Самая похожая карточка не ниже порога либо null. При равенстве — меньший номер: старшая
// карточка — та, где уже лежит история.
export function findDuplicateIssue(
    candidate: { title: string; body: string },
    open: readonly TOpenCard[],
    threshold: number,
): { number: number; score: number; why: string } | null {
    const fp = issueFingerprint(candidate);
    let best: { number: number; score: number; why: string } | null = null;
    for (const card of open) {
        const s = issueSimilarity(fp, issueFingerprint(card));
        if (s.score < threshold) continue;
        if (
            best === null ||
            s.score > best.score ||
            (s.score === best.score && card.number < best.number)
        )
            best = { number: card.number, ...s };
    }
    return best;
}

// ── Бюджет фазы ──────────────────────────────────────────────────────────────────

// Строка `⚠` либо null. Числа — в самой строке: «веха велика» без них вахта проверяла бы
// руками, насколько.
export function phaseBudgetWarning({
    milestone,
    openCount,
    maxIterations,
}: {
    milestone: string;
    openCount: number;
    maxIterations: number;
}): string | null {
    if (openCount <= maxIterations) return null;
    return (
        `⚠ Бюджет фазы "${milestone}": открытых карточек ${String(openCount)} при ` +
        `maxIterations ${String(maxIterations)} — брейкер встанет раньше, чем очередь опустеет. ` +
        'Раздели веху или подними лимит до запуска.'
    );
}

// ── `blocks` ─────────────────────────────────────────────────────────────────────

// Проблема батча либо null: `blocks` называет карточку не из открытых карточек вехи фазы.
// Отказ всего батча, а не «положим во Входящие»: сессия заявила, что без этой карточки
// фазу не закрыть, и тихо разжалованная просьба теряла бы ровно эту связь.
export function blocksProblem(
    requests: readonly { kind: string; blocks?: number; title?: string }[],
    phaseIssues: readonly number[],
    milestone: string,
): string | null {
    for (const r of requests) {
        if (r.kind !== 'new-issue' || r.blocks === undefined) continue;
        if (!phaseIssues.includes(r.blocks))
            return (
                `new-issue «${r.title ?? ''}»: blocks #${String(r.blocks)} — не открытая карточка ` +
                `вехи текущей фазы "${milestone}"`
            );
    }
    return null;
}

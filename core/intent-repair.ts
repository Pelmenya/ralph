// #217: переспрос сессии при неразобранном батче намерений — сверка исправления с исходным.
//
// Ночь 27→28.10: сдача фазы восемь раз подряд встала fail-closed на батче ревью, верном по
// смыслу, но с чужими именами полей (`type`/`body` вместо `kind`/`comment`). Каждый
// рестарт повторял ревью целиком, а хвост мог исправить только человек. Теперь раннер один
// раз спрашивает короткую сессию без инструментов: «вот отвергнутый батч и ошибка, верни
// исправленный блок». Синонимы полей в парсере отвергнуты: грамматика барьера росла бы
// под каждый новый дрейф, а у `new-issue` поле `body` законное.
//
// Исправление пишет модель, и ему верить нельзя так же, как исходному батчу: сессия,
// которую попросили «поправить имена полей», вправе ошибиться и переписать замечание,
// сменить номер карточки или дописать `close`. Поэтому исправленный батч проходит тот же
// строгий парсер, а затем эту сверку: строк столько же, и у каждой строки — те же
// ЗНАЧЕНИЯ. Меняться могут только имена полей и разметка (вложенность, порядок ключей,
// пробелы). Расхождение в чём угодно ещё — отказ, и петля встаёт, как до переспроса.
//
// Сверка по одним значениям пропускала ПЕРЕСТАНОВКУ: два поля одного типа, оба под новыми
// именами, меняются ролями — `{"type":"comment","issue":7,"body":"close"}` становился
// `{"kind":"close",…,"comment":"comment"}`, и комментарий превращался в закрытие карточки;
// у `new-issue` менялись местами заголовок и тело (ревью 16c2). Поэтому переименование
// принимается только из таблицы `RENAMES`: у каждого поля схемы — имена, из которых его
// значение может прийти. Это не синонимы парсера — грамматика барьера прежняя, таблица
// лишь сужает, ЧТО считается правкой одного имени. Дрейф с именем вне таблицы — отказ,
// и петля встаёт, как до #217; новое имя дописывается сюда с тестом.
//
// Модуль ЧИСТЫЙ: текст → вердикт, без чтения файлов и запуска сессий.

import { serializeSessionRequest, type TSessionRequest } from './session-requests.ts';

type TLeaf = { key: string; value: string | number | boolean | null };

// Поле схемы ← имена, под которыми модель его приносила или правдоподобно принесёт. Поле с
// верным именем держит значение само (шаг 1), сюда оно не входит.
const RENAMES: Readonly<Record<string, ReadonlySet<string>>> = {
    kind: new Set(['type', 'action', 'intent', 'op', 'operation']),
    comment: new Set(['body', 'text', 'message', 'note', 'content', 'summary']),
    title: new Set(['name', 'subject', 'heading', 'header', 'summary']),
    body: new Set(['text', 'description', 'content', 'details', 'message']),
    issue: new Set(['number', 'issue_number', 'issueNumber', 'id']),
    labels: new Set(['label', 'tags']),
    path: new Set(['file', 'filename', 'file_path', 'filePath']),
    line: new Set(['line_number', 'lineNumber', 'lineno']),
};

const renameAllowed = (from: string, to: string): boolean => RENAMES[to]?.has(from) === true;

// Строки батча — ровно так, как их нумерует `parseSessionRequests`: номер в отказе парсера
// и номер здесь обязаны совпадать, иначе ошибка, отданная сессии, указывала бы мимо.
function batchLines(raw: string): Array<{ text: string; no: number }> {
    return raw
        .split('\n')
        .map((l, i) => ({ text: l.trim(), no: i + 1 }))
        .filter((l) => l.text !== '');
}

function parseObject(text: string): Record<string, unknown> | null {
    try {
        const v: unknown = JSON.parse(text);
        return typeof v === 'object' && v !== null && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

// Листья объекта с именем ближайшего ключа. Вложенность разворачивается: `anchor: {path,
// line}` и плоские `path`/`line` — одна и та же разметка якоря. Элемент массива получает
// ключ массива: так метки `new-issue` сверяются поштучно.
function leaves(value: unknown, key: string, out: TLeaf[]): TLeaf[] {
    if (Array.isArray(value)) {
        for (const v of value) leaves(v, key, out);
    } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) leaves(v, k, out);
    } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
    ) {
        out.push({ key, value });
    }
    return out;
}

// Тип входит в сравнение: «7» и 7 — разные значения. Приведение строки к номеру — это уже
// не разметка: строгий парсер отвергает строку-номер ровно потому, что её никто не проверял.
const same = (a: TLeaf, b: TLeaf) => typeof a.value === typeof b.value && a.value === b.value;
const show = (l: TLeaf) => `${l.key}=${JSON.stringify(l.value)}`;

/**
 * Можно ли вообще сверить исправление с этим батчем. Сверять есть с чем, только если каждая
 * строка — объект JSON сессии: строка, которая не разобралась как JSON, своих значений не
 * отдаёт, и «тот же текст» проверить нечем; строка отказа блока (`{"ralph":…}`) — это
 * причина раннера, а исходные строки сессии лежат только в логе. Переспрос без сверки был
 * бы просьбой «перепиши как считаешь нужным», поэтому здесь его нет — стоп, как до #217.
 * `null` — препятствий нет.
 */
export function intentRepairObstacle(raw: string): string | null {
    for (const { text, no } of batchLines(raw)) {
        const obj = parseObject(text);
        if (obj === null)
            return `строка ${String(no)} не объект JSON — сверить исправление с ней нечем`;
        if (Object.hasOwn(obj, 'ralph'))
            return (
                `строка ${String(no)} — отказ блока раннером, исходные строки сессии есть ` +
                'только в логе, сверить исправление не с чем'
            );
    }
    return null;
}

export type TRepairCheck =
    { ok: true; changed: number; renames: string[] } | { ok: false; why: string };

/**
 * Сверка исправленного батча с исходным (#217). Исправление уже прошло строгий парсер —
 * здесь только инвариантность: число строк то же, и у строки N исправления те же значения,
 * что у строки N исходного батча. Сверка по значениям, а не по полям, потому что поля и
 * есть то, что чинится: `{"type":"pr-comment","body":"x"}` и `{"kind":"pr-comment",
 * "comment":"x"}` несут одни и те же значения под разными именами.
 *
 * Имя поля держит значение там, где имя уже было верным: `issue` исходной строки обязан
 * остаться номером карточки, а не переехать в текст. Остальные значения сопоставляются
 * поштучно и только по таблице переименований; лишнее (появилось) и недостающее (пропало) —
 * отказ. Значит, отвергается и правка текста, и смена адресата или якоря, и перестановка
 * значений между полями, и выброшенное «лишнее» поле, и новая строка. `correctedRaw` — текст
 * исправления: сверяется он, а не сериализация разобранного (см. шаг сверки ниже); без него —
 * сериализация, и тогда незнакомое поле исходной строки исправить нельзя.
 */
export function checkIntentRepair(
    original: string,
    corrected: TSessionRequest[],
    correctedRaw?: string,
): TRepairCheck {
    const orig = batchLines(original);
    if (orig.length !== corrected.length)
        return {
            ok: false,
            why:
                `в исправлении ${String(corrected.length)} строк, в исходном батче ` +
                `${String(orig.length)} — число строк меняться не может`,
        };
    const raw = correctedRaw === undefined ? null : batchLines(correctedRaw);
    if (raw !== null && raw.length !== corrected.length)
        return { ok: false, why: 'текст исправления и его разбор разошлись числом строк' };
    let changed = 0;
    const renames: string[] = [];
    for (let i = 0; i < orig.length; i++) {
        const { text, no } = orig[i];
        const obj = parseObject(text);
        if (obj === null) return { ok: false, why: `строка ${String(no)} не объект JSON` };
        const serialized = serializeSessionRequest(corrected[i]);
        const left = leaves(obj, '', []);
        const parsed = leaves(JSON.parse(serialized), '', []);
        // Сверяется СЫРОЙ объект исправления, а не сериализация разобранного: строгий парсер
        // незнакомые ключи молча отбрасывает, и строка, сохранившая безобидное `severity`,
        // иначе кончалась бы «пропало severity» — хотя верная строка с ним принимается.
        // Разобранное при этом обязано лежать в сыром дословно: значение, которое парсер
        // взял, и есть то, что применится.
        let right = parsed;
        if (raw !== null) {
            const rawObj = parseObject(raw[i].text);
            if (rawObj === null)
                return { ok: false, why: `строка ${String(no)} исправления не объект JSON` };
            right = leaves(rawObj, '', []);
            const pool = [...right];
            for (const p of parsed) {
                const at = pool.findIndex((r) => r.key === p.key && same(r, p));
                if (at < 0)
                    return {
                        ok: false,
                        why: `строка ${String(no)}: разбор исправления дал ${show(p)}, которого в его тексте нет`,
                    };
                pool.splice(at, 1);
            }
        }
        const lineRenames: string[] = [];
        const pending: TLeaf[] = [];
        // Шаг 1: поле, имя которого в исходной строке уже верно, держит своё значение.
        for (const r of right) {
            const sameKey = left.filter((l) => l.key === r.key);
            if (sameKey.length === 0) {
                pending.push(r);
                continue;
            }
            const at = sameKey.findIndex((l) => same(l, r));
            if (at < 0)
                return {
                    ok: false,
                    why:
                        `строка ${String(no)}: поле ${r.key} было ` +
                        `${sameKey.map((l) => JSON.stringify(l.value)).join(', ')}, в исправлении ` +
                        `${JSON.stringify(r.value)}`,
                };
            left.splice(left.indexOf(sameKey[at]), 1);
        }
        // Шаг 2: остальные значения — переименованные поля, сопоставление поштучное и только
        // по таблице `RENAMES`: то же значение под именем вне таблицы — перестановка ролей.
        for (const r of pending) {
            const at = left.findIndex((l) => same(l, r) && renameAllowed(l.key, r.key));
            if (at < 0) {
                const from = left.find((l) => same(l, r));
                return {
                    ok: false,
                    why: from
                        ? `строка ${String(no)}: ${from.key}→${r.key} — не переименование из таблицы ` +
                          '(значение сменило роль поля)'
                        : `строка ${String(no)}: значения ${show(r)} в исходной строке не было`,
                };
            }
            const [l] = left.splice(at, 1);
            lineRenames.push(`${l.key}→${r.key}`);
        }
        if (left.length > 0)
            return {
                ok: false,
                why: `строка ${String(no)}: в исправлении пропало ${left.map(show).join(', ')}`,
            };
        if (lineRenames.length > 0 || serialized !== text) changed++;
        for (const r of lineRenames) if (!renames.includes(r)) renames.push(r);
    }
    return { ok: true, changed, renames };
}

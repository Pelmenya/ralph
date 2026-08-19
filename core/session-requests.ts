// #40: намерения кодер-сессии по отношению к трекеру.
//
// Сессия в трекер НЕ ходит. Она пишет намерение строкой в файл-запрос, а мутацию делает
// петля через шов `TaskSourceAdapter`. Причины две, и обе структурные:
//
//   - БЕЗОПАСНОСТЬ (#2): чтобы сессия могла закрыть issue сама, ей нужен токен форжа в
//     окружении — а вместе с ним и всё остальное, что этим токеном делается, включая
//     одобрение собственного PR. Барьер, который агент может обойти, охраняет пустоту.
//   - ПЕРЕНОСИМОСТЬ (#36): «закрой issue» — намерение, `gh issue close` — способ. Способ
//     живёт в адаптере, где у каждого форжа свой; промпт остаётся верным на любой площадке.
//
// Модуль ЧИСТЫЙ: текст → список намерений. Ни чтения файла, ни сети — это работа
// оркестратора. Так разбор проверяется без побочек, а применение — отдельно.
//
// Разбор fail-closed во всём: файл пишет модель, которая читала тело чужого issue (C3),
// и неожиданная форма данных здесь обязана быть отказом, а не «пропустим эту строку».

// Что сессия имеет право попросить. Список ЗАКРЫТЫЙ и намеренно короткий: снятие `hold`,
// одобрение ревью (ship/decision) и мердж в него не входят и входить не могут — это
// решения человека и петли, а не сессии. Новое намерение добавляется вместе с методом
// шва и тестом, а не строкой в этот union.
export type TSessionRequest =
    | { kind: 'comment' | 'close' | 'block'; issue: number; comment: string }
    | { kind: 'new-issue'; title: string; body: string; labels: string[] }
    // #45: намерения ревью-сессии по PR СВОЕЙ фазы. Номера PR в них нет намеренно — не
    // забывчивость, а граница: сессия не выбирает, какой PR комментировать, его знает
    // петля. Иначе к списку намерений добавилась бы возможность писать в любой PR
    // репозитория, включая чужие.
    // Якорь — ВЛОЖЕННЫЙ объект, а не два независимых поля: «либо оба, либо ни одного» —
    // это инвариант, и в типе он выражается структурой, а не договорённостью с парсером.
    | { kind: 'pr-comment'; comment: string; anchor?: { path: string; line: number } }
    | { kind: 'pr-block'; comment: string };

// #603: предел считает КЛАССЫ намерений раздельно, а не кучей. Инцидент PR #601 —
// ревью честно нашло 23 замечания (1 major, 6 minor, 16 nit + сводка), все `pr-comment`,
// ни одной мутации — и батч отвергло целиком: большой отревьюенный PR закономерно даёт
// много замечаний, и чем дотошнее ревью, тем вернее оно упирается в общий предохранитель.
//
// Мутации — то, что меняет состояние проекта: закрывает/блокирует карточку, заводит
// новую, ставит блокер на PR. Именно они опасны при сорвавшейся сессии (штампует их
// пачками), и предел на них остаётся жёстким.
const MUTATION_KINDS = ['close', 'block', 'new-issue', 'pr-block'] as const;
// Комментарии ничего не закрывают, не блокируют и не создают сущностей — это текст в
// ленте PR или карточки. Судить о сорвавшейся сессии по их числу — как судить о буйстве
// по количеству сказанных слов.
const COMMENT_KINDS = ['comment', 'pr-comment'] as const;

// Предохранитель от сорвавшейся сессии: десятки мутаций, наделанных за одну итерацию,
// разгребаются дороже, чем один отказ с внятной причиной.
export const MAX_MUTATION_REQUESTS = 20;
// Заметно больше: комментарий стоит строки в ленте, а не состояния проекта — тесный
// предел здесь ловит не сорвавшуюся сессию, а просто дотошное ревью.
//
// Ревью #612: потолок соразмерен ПРОПУСКНОЙ СПОСОБНОСТИ форжа, а не только вкусу. У GitHub
// на создание контента отдельный secondary rate limit (порядка 80 создающих запросов в
// минуту и жёстче — в час), а применение поштучное: батч в 200 комментариев упирался бы в
// стену где-то в середине, и человек получал бы пуш «намерение не применилось» с
// транспортной ошибкой. 100 — вчетверо больше самого дотошного из виденных ревью (23
// находки на PR #601) и в пределах часового окна форжа; ровность потока держит пауза в
// applySessionRequests (orchestrator.ts).
export const MAX_COMMENT_REQUESTS = 100;
// Грубая ранняя граница на объём файла — ДО единого JSON.parse. Точный раздельный счёт по
// классам возможен только после разбора, но разбирать сорвавшийся батч на 100 000 строк
// целиком (каждая — parse + валидация, комментарий до 10 000 символов), чтобы потом его
// отвергнуть, незачем. Второй довод — диагноз: среди тысяч строк почти наверняка найдётся
// кривая, и человек читал бы «строка 137: ожидался объект JSON» вместо «сессия сорвалась».
export const MAX_REQUEST_LINES = MAX_MUTATION_REQUESTS + MAX_COMMENT_REQUESTS;
// Не предел, а водораздел для лога (не отказ): столько комментариев в батче — не срыв,
// но повод сказать человеку «PR/фаза великоват(а)», тем же числом, что раньше отвергало
// батч целиком.
export const COMMENT_NOTICE_THRESHOLD = 20;

// Классификация намерений на мутации/комментарии — используется и здесь (пределы), и
// оркестратором (лог-заметка о размере батча комментариев).
export function classifySessionRequests(requests: readonly TSessionRequest[]): {
    mutations: TSessionRequest[];
    comments: TSessionRequest[];
} {
    const mutations = requests.filter((r) =>
        (MUTATION_KINDS as readonly string[]).includes(r.kind),
    );
    const comments = requests.filter((r) => (COMMENT_KINDS as readonly string[]).includes(r.kind));
    // Ревью #612: классификация ИСЧЕРПЫВАЮЩА, и это проверяется, а не подразумевается.
    // Namespace-типы здесь не помогут — оба массива сведены к `readonly string[]`, так что
    // новый вариант union (докблок TSessionRequest прямо предполагает рост списка) проехал
    // бы мимо ОБОИХ пределов молча, то есть новый класс намерений приехал бы вовсе без
    // предохранителя. Тихий дефолт вместо fail-closed — ровно инвариант №1.
    if (mutations.length + comments.length !== requests.length) {
        const known = new Set([...MUTATION_KINDS, ...COMMENT_KINDS] as readonly string[]);
        const orphans = [...new Set(requests.map((r) => r.kind).filter((k) => !known.has(k)))];
        throw new Error(
            `Запрос сессии: намерение вида ${orphans.map((k) => JSON.stringify(k)).join(', ')} ` +
                'не отнесено ни к мутациям, ни к комментариям — значит оно проехало бы мимо ' +
                'обоих пределов. Добавь его в MUTATION_KINDS или COMMENT_KINDS (session-requests.ts).',
        );
    }
    return { mutations, comments };
}

// Разбивка батча по kind — для сообщения об отказе: человек видит не просто «слишком
// много», а «сколько чего именно» («23 намерения: 23 pr-comment, 0 мутаций»).
function breakdownByKind(requests: readonly TSessionRequest[]): string {
    const counts = new Map<string, number>();
    for (const r of requests) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return [...counts.entries()].map(([kind, n]) => `${String(n)} ${kind}`).join(', ');
}

// Пределы длин — не про красоту: комментарий на мегабайт уедет в тело запроса к форжу и
// вернётся отказом транспорта, диагностировать который будет нечем.
const MAX_COMMENT = 10_000;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;

const ISSUE_KINDS = ['comment', 'close', 'block'] as const;
const PR_KINDS = ['pr-comment', 'pr-block'] as const;

// Путь файла для якоря комментария. Проверяется не «на всякий случай»: строку пишет
// модель, а уходит она в argv `gh api -f path=…`. Абсолютный путь и `..` отвергаем —
// комментарий обязан указывать на файл ЭТОГО репозитория, а не на что угодно в файловой
// системе; ведущий `-` закрывает argument injection (тот же класс, что SAFE_BRANCH_RE).
const SAFE_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._\-/]*$/;
const MAX_PATH = 400;

function fail(lineNo: number, what: string): never {
    throw new Error(`Запрос сессии, строка ${String(lineNo)}: ${what}`);
}

function asRecord(value: unknown, lineNo: number): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(lineNo, 'ожидался объект JSON');
    }
    return value as Record<string, unknown>;
}

// Номер карточки — целое положительное. Строка «7» тоже отвергается: она приходит от
// модели, а не от форжа, и молчаливое приведение типов здесь означало бы, что в мутацию
// уедет значение, которого никто не проверял.
function issueNumber(value: unknown, lineNo: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        fail(
            lineNo,
            `номер карточки должен быть целым положительным, пришло ${JSON.stringify(value)}`,
        );
    }
    return value;
}

function text(value: unknown, lineNo: number, what: string, max: number): string {
    if (typeof value !== 'string' || value.trim() === '') {
        fail(lineNo, `${what} обязателен и не может быть пустым`);
    }
    if (value.length > max) {
        fail(lineNo, `${what} длиннее предела ${String(max)} символов`);
    }
    return value;
}

// Якорь комментария: путь + строка. Либо ОБА поля, либо ни одного — половина якоря
// (путь без строки) у форжа не примется, и намерение потерялось бы уже в транспорте.
function anchor(
    req: Record<string, unknown>,
    lineNo: number,
): { anchor?: { path: string; line: number } } {
    const rawPath = req['path'];
    const rawLine = req['line'];
    if (rawPath === undefined && rawLine === undefined) return {};
    if (rawPath === undefined || rawLine === undefined) {
        fail(lineNo, 'якорь комментария задаётся ПАРОЙ path+line: одного поля мало');
    }
    const path = text(rawPath, lineNo, 'путь файла', MAX_PATH);
    if (!SAFE_PATH_RE.test(path) || path.split('/').includes('..')) {
        fail(
            lineNo,
            `путь ${JSON.stringify(path)} не похож на файл этого репозитория ` +
                '(ожидается относительный путь без «..» и без ведущего дефиса)',
        );
    }
    if (typeof rawLine !== 'number' || !Number.isInteger(rawLine) || rawLine <= 0) {
        fail(lineNo, `строка должна быть целым положительным, пришло ${JSON.stringify(rawLine)}`);
    }
    return { anchor: { path, line: rawLine } };
}

function labels(value: unknown, lineNo: number, allowlist: readonly string[]): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        fail(lineNo, 'метки обязательны: карточка без меток не видна ни роутингу, ни человеку');
    }
    const seen: string[] = [];
    for (const label of value) {
        if (typeof label !== 'string' || !allowlist.includes(label)) {
            fail(
                lineNo,
                `метка ${JSON.stringify(label)} вне разрешённого списка (${allowlist.join(', ')})`,
            );
        }
        // Повтор метки схлопываем, а не отвергаем: это невнимательность модели, а не
        // попытка сделать что-то запрещённое. Отказ здесь стоил бы потерянного намерения,
        // а дубль — отказа форжа (`gh issue create --label x --label x`).
        if (!seen.includes(label)) seen.push(label);
    }
    return seen;
}

/**
 * Разбирает файл-запрос (JSONL) в список намерений.
 *
 * Отказ — на ЛЮБОЙ некорректной строке, и отказывается ВЕСЬ батч: частичное применение
 * оставило бы трекер в состоянии, которого не хотела ни сессия, ни петля, — например
 * карточка закрыта, а объясняющий комментарий потерян вместе с битой строкой.
 */
export function parseSessionRequests(
    raw: string,
    { labelAllowlist }: { labelAllowlist: readonly string[] },
): TSessionRequest[] {
    const lines = raw
        .split('\n')
        .map((l, i) => ({ text: l.trim(), no: i + 1 }))
        .filter((l) => l.text !== '');

    // Ревью #612: грубый предохранитель ДО разбора — по числу строк. Точные пределы по
    // классам ниже (после разбора), но батч, который заведомо не влезает даже в их сумму,
    // отвергается сразу и с ПРАВИЛЬНЫМ диагнозом («сессия сорвалась»), а не случайной
    // синтаксической придиркой к 137-й строке из ста тысяч.
    if (lines.length > MAX_REQUEST_LINES) {
        throw new Error(
            `Запрос сессии: ${String(lines.length)} строк — больше суммы пределов ` +
                `(${String(MAX_REQUEST_LINES)}). Батч отвергнут целиком, НЕ разбираясь: столько ` +
                'намерений за одну итерацию похоже на сорвавшуюся сессию.',
        );
    }

    const requests = lines.map(({ text: source, no }) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch {
            fail(no, 'не разобралось как JSON');
        }
        const req = asRecord(parsed, no);
        const kind = req['kind'];

        if (kind === 'new-issue') {
            return {
                kind: 'new-issue' as const,
                title: text(req['title'], no, 'заголовок', MAX_TITLE),
                body: text(req['body'], no, 'тело карточки', MAX_BODY),
                labels: labels(req['labels'], no, labelAllowlist),
            };
        }
        // #45: комментарий в PR фазы. Замечание ревью без текста — потерянная находка,
        // поэтому `comment` обязателен так же, как у намерений по карточкам.
        if (kind === 'pr-comment') {
            return {
                kind: 'pr-comment' as const,
                comment: text(req['comment'], no, 'комментарий', MAX_COMMENT),
                ...anchor(req, no),
            };
        }
        // Метка blocked на PR фазы. Комментарий обязателен: метка без объяснения оставляет
        // человека (и чини-сессию) гадать, что именно блокирует.
        if (kind === 'pr-block') {
            return {
                kind: 'pr-block' as const,
                comment: text(req['comment'], no, 'комментарий', MAX_COMMENT),
            };
        }
        if (typeof kind === 'string' && (ISSUE_KINDS as readonly string[]).includes(kind)) {
            return {
                kind: kind as 'comment' | 'close' | 'block',
                issue: issueNumber(req['issue'], no),
                comment: text(req['comment'], no, 'комментарий', MAX_COMMENT),
            };
        }
        fail(
            no,
            `неизвестный kind ${JSON.stringify(kind)}. Разрешено: ${[...ISSUE_KINDS, 'new-issue', ...PR_KINDS].join(', ')}. ` +
                'Снятие hold и blocked, одобрение ревью и мердж намерениями сессии не являются.',
        );
    });

    // #603: пределы проверяются ПОСЛЕ разбора и РАЗДЕЛЬНО по классам — иначе большой,
    // но честно отревьюенный PR (сплошь `pr-comment`) бился бы о тот же предохранитель,
    // что и сорвавшаяся сессия, штампующая close/block/new-issue пачками.
    const { mutations, comments } = classifySessionRequests(requests);
    if (mutations.length > MAX_MUTATION_REQUESTS) {
        throw new Error(
            `Запрос сессии: ${String(mutations.length)} мутаций (close/block/new-issue/pr-block) — ` +
                `больше предела ${String(MAX_MUTATION_REQUESTS)}. Батч отвергнут целиком: столько мутаций ` +
                'за одну итерацию похоже на сорвавшуюся сессию. ' +
                `Разбивка по классам: ${String(requests.length)} намерений — ${breakdownByKind(requests)}.`,
        );
    }
    if (comments.length > MAX_COMMENT_REQUESTS) {
        throw new Error(
            `Запрос сессии: ${String(comments.length)} комментариев (comment/pr-comment) — ` +
                `больше предела ${String(MAX_COMMENT_REQUESTS)}. Батч отвергнут целиком. ` +
                `Разбивка по классам: ${String(requests.length)} намерений — ${breakdownByKind(requests)}.`,
        );
    }

    return requests;
}

/**
 * Сериализует намерение обратно в строку JSONL — так, как его читает `parseSessionRequests`.
 *
 * Нужна, потому что хвост неприменённого батча пишется на диск и читается СЛЕДУЮЩИМ
 * прогоном тем же парсером. Наивный `JSON.stringify` отдавал НОРМАЛИЗОВАННУЮ форму
 * (`anchor: {path, line}`), а парсер ждёт ПЛОСКИЕ `path`/`line` — якорь молча терялся,
 * и замечание к строке возвращалось сводкой (#64). Здесь форма разворачивается обратно:
 * запись и чтение обязаны сходиться, иначе round-trip врёт.
 */
export function serializeSessionRequest(req: TSessionRequest): string {
    if (req.kind === 'pr-comment' && req.anchor) {
        const { anchor, ...rest } = req;
        return JSON.stringify({ ...rest, path: anchor.path, line: anchor.line });
    }
    return JSON.stringify(req);
}

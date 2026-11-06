// S2f: полный дифф фазы находил дефекты слишком поздно, поэтому закрытие карточки получает
// свой автомат. Кодер просит закрытие, ревью проверяет весь дифф карточки и даёт вердикт на
// выданную сессии голову; открытые blocker/major ведут в правку и новое ревью, чистая та же
// голова — в закрытие, предел кругов или всех сессий — в blocked. Один круг — одно ревью с
// вердиктом: при трёх кругах возможны только две правки между ними. Сдача фазы сверяет все
// записи closed с чистым вердиктом своей головы и получает итоги карточек контекстом ревью.
// Сверка головы неатомарна с эффектом форжа: посторонний пуш в этом окне ловит ревью фазы.
// Включённая посреди фазы стадия не имеет записей о ранее закрытых карточках и не проверяет их
// задним числом, поэтому её место — с входа в фазу.
//
// Ревью контрактной карточки требовало чужую боевую реализацию и не сходилось по кругам.
// Границу по телу карточки определяет модель в промпте: код не умеет проверять смысл этой
// границы. Раннер держит только severity: minor/nit не мешают закрытию, blocker/major и
// card-block держат его даже при ошибочной оценке границы моделью.
//
// Итог review/fix сначала ложится в state (`pending.saved: true`), затем доводятся эффекты;
// `saved: false` после рестарта означает неизвестный исход и карантин его батча. Модуль решает
// следующий шаг, проверяет форму и фильтрует намерения по роли: pending/closing/limitHead и
// сами эффекты остаются у вызывающего. Здесь нет fs, git и часов, чтобы решения и круговой
// проход state проверялись изолированно.

import { severityOf } from './review-of-fixes.ts';
import type { TSessionRequest } from './session-requests.ts';

export type TCardSeverity = 'blocker' | 'major' | 'minor' | 'nit';
export type TCardFinding = {
    id: string;
    severity: TCardSeverity;
    comment: string;
    anchor: { path: string; line: number } | null;
    round: number;
    head: string;
    status: 'open' | 'fixed' | 'journal';
    test: string | null;
    note: string | null;
};
export type TCardPending = { role: 'review' | 'fix'; head: string; saved: boolean };
export type TCardProgress = {
    issue: number;
    milestone: string;
    firstHead: string;
    closeComment: string | null;
    rounds: number;
    sessions: number;
    failedSessions: number;
    lastReviewedHead: string | null;
    verdict: 'clean' | 'findings' | null;
    findings: TCardFinding[];
    pending: TCardPending | null;
    closing: string | null;
    limitHead: string | null;
    startedAt: string;
};
export type TCardOutcome = 'closed' | 'blocked' | 'closed-external' | 'stop';
export type TCardRecord = {
    issue: number;
    milestone: string;
    outcome: TCardOutcome;
    head: string | null;
    verdict: 'clean' | 'findings' | null;
    lastReviewedHead: string | null;
    rounds: number;
    sessions: number;
    failedSessions: number;
    findings: TCardFinding[];
    startedAt: string;
    finishedAt: string;
};
export type TCardLimits = { maxRounds: number; maxSessions: number };
export type TCardStep = 'coder' | 'review' | 'fix' | 'close' | 'limit';

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
const STATUSES = ['open', 'fixed', 'journal'] as const;
const VERDICTS = ['clean', 'findings'] as const;
const OUTCOMES = ['closed', 'blocked', 'closed-external'] as const;

function shown(value: unknown): string {
    return JSON.stringify(value) ?? String(value);
}

function configError(key: string, value: unknown, expected: string): never {
    throw new Error(`review.${key} = ${shown(value)} — ${expected}`);
}

function positiveInt(value: unknown, key: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        configError(key, value, 'ожидалось целое число ≥ 1');
    }
    return value;
}

export function resolveCardReview(review: unknown): { enabled: boolean } & TCardLimits {
    if (
        review !== undefined &&
        review !== null &&
        (typeof review !== 'object' || Array.isArray(review))
    ) {
        throw new Error(`review = ${shown(review)} — ожидался объект`);
    }
    const value = (review ?? {}) as Record<string, unknown>;
    const enabled = value.cardReview ?? false;
    if (typeof enabled !== 'boolean') configError('cardReview', enabled, 'ожидался boolean');
    const maxRounds = positiveInt(value.maxCardReviewRounds, 'maxCardReviewRounds', 3);
    const maxSessions = positiveInt(value.maxCardSessions, 'maxCardSessions', 8);
    if (!enabled) {
        if (value.maxCardReviewRounds !== undefined) {
            configError(
                'maxCardReviewRounds',
                value.maxCardReviewRounds,
                'ключ задан при cardReview !== true',
            );
        }
        if (value.maxCardSessions !== undefined) {
            configError(
                'maxCardSessions',
                value.maxCardSessions,
                'ключ задан при cardReview !== true',
            );
        }
    }
    if (maxSessions < 2 * maxRounds) {
        configError(
            'maxCardSessions',
            value.maxCardSessions ?? 8,
            `ожидалось не меньше 2 × maxCardReviewRounds = ${String(2 * maxRounds)}`,
        );
    }
    return { enabled, maxRounds, maxSessions };
}

export function isFullSha(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function parseError(path: string, expected: string, value?: unknown): never {
    const found = arguments.length >= 3 ? `, получено ${shown(value)}` : '';
    throw new Error(`${path} — ${expected}${found}`);
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        parseError(path, 'ожидался объект', value);
    }
    return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
    if (typeof value !== 'string') parseError(path, 'ожидалась строка', value);
    return value;
}

function nullableString(value: unknown, path: string): string | null {
    if (value !== null && typeof value !== 'string') {
        parseError(path, 'ожидалась строка или null', value);
    }
    return value;
}

function isoValue(value: unknown, path: string): string {
    const text = stringValue(value, path);
    if (!Number.isFinite(Date.parse(text))) parseError(path, 'ожидалась дата ISO', value);
    return text;
}

function counterValue(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        parseError(path, 'ожидалось целое число ≥ 0', value);
    }
    return value;
}

function issueValue(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        parseError(path, 'ожидалось целое число ≥ 1', value);
    }
    return value;
}

function headValue(value: unknown, path: string, nullable: false): string;
function headValue(value: unknown, path: string, nullable: true): string | null;
function headValue(value: unknown, path: string, nullable: boolean): string | null {
    if (nullable && value === null) return null;
    if (!isFullSha(value)) {
        parseError(path, `ожидался${nullable ? ' полный SHA или null' : ' полный SHA'}`, value);
    }
    return value;
}

function verdictValue(
    value: unknown,
    lastReviewedHead: string | null,
    path: string,
): 'clean' | 'findings' | null {
    if (value !== null && !VERDICTS.includes(value as (typeof VERDICTS)[number])) {
        parseError(`${path}.verdict`, 'неизвестный вердикт', value);
    }
    if (value !== null && lastReviewedHead === null) {
        parseError(`${path}.lastReviewedHead`, 'обязателен при verdict !== null', value);
    }
    return value as 'clean' | 'findings' | null;
}

function findingValue(raw: unknown, path: string): TCardFinding {
    const value = objectValue(raw, path);
    const severity = value.severity;
    if (!SEVERITIES.includes(severity as TCardSeverity)) {
        parseError(`${path}.severity`, 'неизвестная серьёзность', severity);
    }
    const status = value.status;
    if (!STATUSES.includes(status as TCardFinding['status'])) {
        parseError(`${path}.status`, 'неизвестный статус', status);
    }
    if (status === 'journal' && severity !== 'minor' && severity !== 'nit') {
        parseError(`${path}.status`, 'journal допустим только у minor/nit', status);
    }
    let anchor: TCardFinding['anchor'] = null;
    if (value.anchor !== null) {
        const a = objectValue(value.anchor, `${path}.anchor`);
        const line = a.line;
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
            parseError(`${path}.anchor.line`, 'ожидалось целое число ≥ 1', line);
        }
        anchor = { path: stringValue(a.path, `${path}.anchor.path`), line };
    }
    const round = value.round;
    if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
        parseError(`${path}.round`, 'ожидалось целое число ≥ 1', round);
    }
    return {
        id: stringValue(value.id, `${path}.id`),
        severity: severity as TCardSeverity,
        comment: stringValue(value.comment, `${path}.comment`),
        anchor,
        round,
        head: headValue(value.head, `${path}.head`, false),
        status: status as TCardFinding['status'],
        test: nullableString(value.test, `${path}.test`),
        note: nullableString(value.note, `${path}.note`),
    };
}

function findingsValue(raw: unknown, path: string): TCardFinding[] {
    if (!Array.isArray(raw)) parseError(path, 'ожидался массив', raw);
    return raw.map((finding, index) => findingValue(finding, `${path}[${String(index)}]`));
}

function pendingValue(raw: unknown, path: string): TCardPending | null {
    if (raw === null) return null;
    const value = objectValue(raw, path);
    if (value.role !== 'review' && value.role !== 'fix') {
        parseError(`${path}.role`, 'ожидалась роль review или fix', value.role);
    }
    if (typeof value.saved !== 'boolean') {
        parseError(`${path}.saved`, 'ожидался boolean', value.saved);
    }
    return {
        role: value.role,
        head: headValue(value.head, `${path}.head`, false),
        saved: value.saved,
    };
}

export function parseCardProgress(raw: unknown): TCardProgress | null {
    if (raw === undefined || raw === null) return null;
    const value = objectValue(raw, 'cardReview');
    const lastReviewedHead = headValue(value.lastReviewedHead, 'cardReview.lastReviewedHead', true);
    return {
        issue: issueValue(value.issue, 'cardReview.issue'),
        milestone: stringValue(value.milestone, 'cardReview.milestone'),
        firstHead: headValue(value.firstHead, 'cardReview.firstHead', false),
        closeComment: nullableString(value.closeComment, 'cardReview.closeComment'),
        rounds: counterValue(value.rounds, 'cardReview.rounds'),
        sessions: counterValue(value.sessions, 'cardReview.sessions'),
        failedSessions: counterValue(value.failedSessions, 'cardReview.failedSessions'),
        lastReviewedHead,
        verdict: verdictValue(value.verdict, lastReviewedHead, 'cardReview'),
        findings: findingsValue(value.findings, 'cardReview.findings'),
        pending: pendingValue(value.pending, 'cardReview.pending'),
        closing: headValue(value.closing, 'cardReview.closing', true),
        limitHead: headValue(value.limitHead, 'cardReview.limitHead', true),
        startedAt: isoValue(value.startedAt, 'cardReview.startedAt'),
    };
}

function recordValue(raw: unknown, path: string): TCardRecord {
    const value = objectValue(raw, path);
    const outcome = value.outcome;
    if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
        parseError(`${path}.outcome`, 'неизвестный исход истории', outcome);
    }
    const head = headValue(value.head, `${path}.head`, true);
    if (outcome === 'closed' && head === null) {
        parseError(`${path}.head`, 'обязателен при outcome closed', head);
    }
    const lastReviewedHead = headValue(value.lastReviewedHead, `${path}.lastReviewedHead`, true);
    return {
        issue: issueValue(value.issue, `${path}.issue`),
        milestone: stringValue(value.milestone, `${path}.milestone`),
        outcome: outcome as TCardOutcome,
        head,
        verdict: verdictValue(value.verdict, lastReviewedHead, path),
        lastReviewedHead,
        rounds: counterValue(value.rounds, `${path}.rounds`),
        sessions: counterValue(value.sessions, `${path}.sessions`),
        failedSessions: counterValue(value.failedSessions, `${path}.failedSessions`),
        findings: findingsValue(value.findings, `${path}.findings`),
        startedAt: isoValue(value.startedAt, `${path}.startedAt`),
        finishedAt: isoValue(value.finishedAt, `${path}.finishedAt`),
    };
}

export function parseCardHistory(raw: unknown): TCardRecord[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) parseError('cardHistory', 'ожидался массив', raw);
    return raw.map((record, index) => recordValue(record, `cardHistory[${String(index)}]`));
}

export function cardSubmitProblem(
    progress: TCardProgress | null,
    history: readonly TCardRecord[],
    milestone: string,
): string | null {
    if (progress !== null) return `карточка #${String(progress.issue)} не доведена`;
    for (const record of history) {
        if (record.milestone !== milestone || record.outcome !== 'closed') continue;
        if (
            record.verdict !== 'clean' ||
            !isFullSha(record.head) ||
            !isFullSha(record.lastReviewedHead) ||
            record.head !== record.lastReviewedHead
        ) {
            return `карточка #${String(record.issue)} закрыта без чистого вердикта своей головы`;
        }
    }
    return null;
}

export function formatCardReviewsContext(
    history: readonly TCardRecord[],
    milestone: string,
): string {
    const lines: string[] = [];
    for (const record of history) {
        if (record.milestone !== milestone) continue;
        lines.push(
            `Карточка #${String(record.issue)}: исход ${record.outcome}, вердикт ${record.verdict ?? 'нет'}, SHA ${record.head ?? 'нет'}, последнее ревью ${record.lastReviewedHead ?? 'нет'}`,
        );
        for (const [title, status] of [
            ['Открытые находки:', 'open'],
            ['Закрытые находки:', 'closed'],
        ] as const) {
            const findings = record.findings.filter((finding) =>
                status === 'open' ? finding.status === 'open' : finding.status !== 'open',
            );
            if (findings.length === 0) continue;
            lines.push(`  ${title}`);
            for (const finding of findings) {
                const where = finding.anchor
                    ? `${finding.anchor.path}:${String(finding.anchor.line)}`
                    : 'место не указано';
                lines.push(
                    `  - ${finding.id} [${finding.severity}] ${where} — ${finding.comment.slice(0, 300)}`,
                );
            }
        }
    }
    return lines.join('\n');
}

export function newCardProgress({
    issue,
    milestone,
    firstHead,
    startedAt,
}: {
    issue: number;
    milestone: string;
    firstHead: string;
    startedAt: string;
}): TCardProgress {
    return {
        issue,
        milestone,
        firstHead,
        closeComment: null,
        rounds: 0,
        sessions: 0,
        failedSessions: 0,
        lastReviewedHead: null,
        verdict: null,
        findings: [],
        pending: null,
        closing: null,
        limitHead: null,
        startedAt,
    };
}

export function openBlocking(progress: TCardProgress): TCardFinding[] {
    return progress.findings.filter(
        (finding) =>
            finding.status === 'open' &&
            (finding.severity === 'blocker' || finding.severity === 'major'),
    );
}

function addedTestName(line: string): string | null {
    const match =
        /^\+\s*(?:it|test)(?:\.\w+(?:\([^)]*\))?)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,/.exec(
            line,
        );
    return match === null ? null : match[2].replace(/\\(['"`\\])/g, '$1');
}

export function applyCardFixBatch(
    progress: TCardProgress,
    fixes: readonly { finding: string; test: string }[],
    diffOf: (head: string) => string,
    logFn: (line: string) => void = () => {},
): TCardProgress {
    const fixHead =
        progress.pending?.role === 'fix' && isFullSha(progress.pending.head)
            ? progress.pending.head
            : null;
    if (fixes.length > 0 && fixHead === null) {
        throw new Error('итог правок карточки без pending.head роли fix');
    }
    const diffs = new Map<string, string>();
    const cachedDiffOf = (head: string): string => {
        const cached = diffs.get(head);
        if (cached !== undefined) return cached;
        const diff = diffOf(head);
        diffs.set(head, diff);
        return diff;
    };
    const findings = progress.findings.map((finding) => ({
        ...finding,
        anchor: finding.anchor === null ? null : { ...finding.anchor },
    }));
    const named = new Set(fixes.map((fix) => fix.finding));
    for (const fix of fixes) {
        const index = findings.findIndex((finding) => finding.id === fix.finding);
        const finding = index < 0 ? undefined : findings[index];
        if (
            finding === undefined ||
            finding.status !== 'open' ||
            (finding.severity !== 'blocker' && finding.severity !== 'major')
        ) {
            logFn(`⚠ card-fix для ${fix.finding} пропущен: открытой blocker/major с таким ID нет`);
            continue;
        }
        if (fixHead === null) throw new Error('итог правок карточки без pending.head роли fix');
        const found = cachedDiffOf(fixHead)
            .split('\n')
            .some((line) => addedTestName(line) === fix.test);
        findings[index] = found
            ? { ...finding, status: 'fixed', test: fix.test, note: null }
            : {
                  ...finding,
                  status: 'open',
                  note: `тест ${fix.test} не найден в добавленных строках диффа правок`,
              };
    }
    for (let index = 0; index < findings.length; index += 1) {
        const finding = findings[index];
        if (
            finding.status === 'open' &&
            (finding.severity === 'blocker' || finding.severity === 'major') &&
            !named.has(finding.id)
        ) {
            findings[index] = { ...finding, note: 'правка не назвала тест' };
        }
    }
    return { ...progress, findings };
}

export function formatCardLimitPacket(progress: TCardProgress, head: string): string {
    const findings = openBlocking(progress).map((finding) => {
        const where = finding.anchor
            ? `${finding.anchor.path}:${String(finding.anchor.line)}`
            : 'место не указано';
        return `- ${finding.id} [${finding.severity}] ${where} — ${finding.comment}`;
    });
    return (
        `Предел ревью карточки #${String(progress.issue)}: кругов ${String(progress.rounds)}, ` +
        `сессий ${String(progress.sessions)} (упавших ${String(progress.failedSessions)}). ` +
        `Голова: ${head}. SHA последнего ревью: ${progress.lastReviewedHead ?? 'ещё не было'}.` +
        (findings.length > 0 ? `\nОткрытые находки:\n${findings.join('\n')}` : '')
    );
}

export function decideCardStep(
    progress: TCardProgress,
    limits: TCardLimits,
    head: unknown,
): TCardStep {
    if (!isFullSha(head)) throw new Error(`head — ожидался полный SHA, получено ${shown(head)}`);
    if (progress.closeComment === null) {
        return progress.sessions >= limits.maxSessions ? 'limit' : 'coder';
    }
    const blocking = openBlocking(progress);
    if (
        progress.verdict === 'clean' &&
        progress.lastReviewedHead === head &&
        blocking.length === 0
    ) {
        return 'close';
    }
    if (progress.sessions >= limits.maxSessions) return 'limit';
    if (progress.verdict !== null && progress.lastReviewedHead === head && blocking.length > 0) {
        return progress.rounds >= limits.maxRounds ? 'limit' : 'fix';
    }
    return progress.rounds >= limits.maxRounds ? 'limit' : 'review';
}

export function cardRecordOf(
    progress: TCardProgress,
    outcome: TCardOutcome,
    head: string | null,
    finishedAt: string,
): TCardRecord {
    return {
        issue: progress.issue,
        milestone: progress.milestone,
        outcome,
        head,
        verdict: progress.verdict,
        lastReviewedHead: progress.lastReviewedHead,
        rounds: progress.rounds,
        sessions: progress.sessions,
        failedSessions: progress.failedSessions,
        findings: progress.findings.map((finding) => ({
            ...finding,
            anchor: finding.anchor === null ? null : { ...finding.anchor },
        })),
        startedAt: progress.startedAt,
        finishedAt,
    };
}

export function formatCardMetrics(record: TCardRecord): string {
    const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
        TCardSeverity,
        number
    >;
    for (const finding of record.findings) counts[finding.severity] += 1;
    const seconds = (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000;
    return (
        `📊 Карточка #${String(record.issue)}: исход ${record.outcome}, ` +
        `кругов ${String(record.rounds)}, сессий ${String(record.sessions)} ` +
        `(упавших ${String(record.failedSessions)}), находки blocker ${String(counts.blocker)} ` +
        `major ${String(counts.major)} minor ${String(counts.minor)} nit ${String(counts.nit)}, ` +
        `время ${String(seconds)} с`
    );
}

export type TCardRole = 'coder' | 'review' | 'fix' | 'closing';
export type TCardBatch = {
    deferredClose: string | null;
    summary: string | null;
    blocked: string | null;
    findings: Array<{
        severity: TCardSeverity;
        comment: string;
        anchor: { path: string; line: number };
    }>;
    fixes: Array<{ finding: string; test: string }>;
};
export type TCardStage = {
    issue: number;
    role: TCardRole;
    saveBatchFn?: (batch: TCardBatch) => void;
};
export type TCardIntentAction =
    { kind: 'execute' } | { kind: 'batch' | 'drop' | 'discard' | 'orphan'; why: string };
export type TCardFilteredRequests = {
    requests: TSessionRequest[];
    batchOnly: TSessionRequest[];
    removed: Array<{ req: TSessionRequest; why: string }>;
    dropped: Array<{ kind: 'close'; what: string }>;
    orphaned: TSessionRequest[];
};

function isCardRequest(req: TSessionRequest): boolean {
    return req.kind === 'card-comment' || req.kind === 'card-block' || req.kind === 'card-fix';
}

export function cardIntentAction(
    req: TSessionRequest,
    enabled: boolean,
    stage: TCardStage | undefined,
): TCardIntentAction {
    if (!enabled) {
        return isCardRequest(req)
            ? { kind: 'drop', why: 'стадия ревью карточки выключена' }
            : { kind: 'execute' };
    }
    if (!stage) {
        return req.kind === 'close' || isCardRequest(req)
            ? { kind: 'drop', why: 'стадия включена, но роль cardStage не задана' }
            : { kind: 'execute' };
    }
    if (req.kind === 'pr-comment' || req.kind === 'pr-block') {
        return stage.role === 'closing'
            ? { kind: 'drop', why: 'роль closing исполняет только close своей карточки' }
            : { kind: 'orphan', why: 'намерение по PR вне сдачи фазы' };
    }
    if (stage.role === 'closing') {
        return req.kind === 'close' && req.issue === stage.issue
            ? { kind: 'execute' }
            : { kind: 'drop', why: 'роль closing исполняет только close своей карточки' };
    }
    if (stage.role === 'coder') {
        if (req.kind === 'close') {
            return req.issue === stage.issue
                ? { kind: 'batch', why: 'закрытие отложено до ревью карточки' }
                : { kind: 'drop', why: 'роль coder не закрывает чужую карточку' };
        }
        if (
            req.kind === 'comment' ||
            req.kind === 'block' ||
            req.kind === 'new-issue' ||
            req.kind === 'live-probe'
        ) {
            return { kind: 'execute' };
        }
        return { kind: 'drop', why: 'роль coder не исполняет намерения ревью карточки' };
    }
    if (stage.role === 'review') {
        if (
            (req.kind === 'card-comment' || req.kind === 'card-block') &&
            req.issue === stage.issue
        ) {
            return { kind: 'execute' };
        }
        if (req.kind === 'comment' || req.kind === 'new-issue') return { kind: 'execute' };
        return { kind: 'drop', why: 'намерение запрещено роли review' };
    }
    if (req.kind === 'card-fix' && req.issue === stage.issue) {
        return { kind: 'batch', why: 'отчёт правки сохраняется в state без эффекта форжа' };
    }
    if (req.kind === 'comment' || req.kind === 'block' || req.kind === 'new-issue') {
        return { kind: 'execute' };
    }
    return { kind: 'drop', why: 'намерение запрещено роли fix' };
}

export function filterCardRequests(
    requests: readonly TSessionRequest[],
    enabled: boolean,
    stage: TCardStage | undefined,
): TCardFilteredRequests {
    const result: TCardFilteredRequests = {
        requests: [],
        batchOnly: [],
        removed: [],
        dropped: [],
        orphaned: [],
    };
    const blockedByCoder =
        stage?.role === 'coder' &&
        requests.some((req) => req.kind === 'block' && req.issue === stage.issue);
    for (const req of requests) {
        let action = cardIntentAction(req, enabled, stage);
        if (action.kind === 'batch' && req.kind === 'close' && blockedByCoder) {
            action = { kind: 'discard', why: 'block своей карточки сильнее отложенного close' };
        }
        if (action.kind === 'execute') {
            result.requests.push(req);
            continue;
        }
        result.removed.push({ req, why: action.why });
        if (action.kind === 'batch') {
            result.batchOnly.push(req);
        } else if (action.kind === 'orphan') {
            result.orphaned.push(req);
        } else if (action.kind === 'drop' && req.kind === 'close') {
            result.dropped.push({
                kind: 'close',
                what: `close #${String(req.issue)} — ${action.why}`,
            });
        }
    }
    return result;
}

export function applyCardReviewBatch(card: TCardProgress, batch: TCardBatch): TCardProgress {
    if (batch.deferredClose !== null) return { ...card, closeComment: batch.deferredClose };
    if (batch.summary === null && batch.blocked === null) return card;
    const pending = card.pending;
    if (pending === null || pending.role !== 'review') {
        throw new Error('вердикт ревью карточки без pending роли review');
    }
    const round = card.rounds + 1;
    const nextId =
        card.findings.reduce((max, finding) => {
            const match = /^F(\d+)$/.exec(finding.id);
            return match === null ? max : Math.max(max, Number(match[1]));
        }, 0) + 1;
    const findings = batch.findings.map((finding, index): TCardFinding => {
        const status =
            finding.severity === 'blocker' || finding.severity === 'major' ? 'open' : 'journal';
        return {
            id: `F${String(nextId + index)}`,
            severity: finding.severity,
            comment: finding.comment,
            anchor: { ...finding.anchor },
            round,
            head: pending.head,
            status,
            test: null,
            note: null,
        };
    });
    if (batch.blocked !== null) {
        findings.push({
            id: `F${String(nextId + findings.length)}`,
            severity: 'blocker',
            comment: batch.blocked,
            anchor: null,
            round,
            head: pending.head,
            status: 'open',
            test: null,
            note: null,
        });
    }
    const blocking = findings.some(
        (finding) => finding.severity === 'blocker' || finding.severity === 'major',
    );
    return {
        ...card,
        verdict: batch.blocked !== null || blocking ? 'findings' : 'clean',
        lastReviewedHead: pending.head,
        rounds: round,
        findings: [...card.findings, ...findings],
        pending: { ...pending, saved: true },
    };
}

export function buildCardBatch(
    requests: readonly TSessionRequest[],
    batchOnly: readonly TSessionRequest[],
    stage: TCardStage,
): TCardBatch {
    const all = [...requests, ...batchOnly];
    const close = all.find((req) => req.kind === 'close' && req.issue === stage.issue);
    const blocked = all.some((req) => req.kind === 'block' && req.issue === stage.issue);
    const summary = all.find(
        (req) =>
            req.kind === 'card-comment' && req.issue === stage.issue && req.anchor === undefined,
    );
    const cardBlock = all.find((req) => req.kind === 'card-block' && req.issue === stage.issue);
    const findings =
        stage.role === 'review'
            ? all.flatMap((req) => {
                  if (
                      req.kind !== 'card-comment' ||
                      req.issue !== stage.issue ||
                      req.anchor === undefined
                  ) {
                      return [];
                  }
                  return [
                      {
                          severity: severityOf(req.comment) as TCardSeverity,
                          comment: req.comment,
                          anchor: { path: req.anchor.path, line: req.anchor.line },
                      },
                  ];
              })
            : [];
    const fixes =
        stage.role === 'fix'
            ? all.flatMap((req) =>
                  req.kind === 'card-fix' && req.issue === stage.issue
                      ? [{ finding: req.finding, test: req.test }]
                      : [],
              )
            : [];
    return {
        deferredClose:
            stage.role === 'coder' && !blocked && close?.kind === 'close' ? close.comment : null,
        summary:
            stage.role === 'review' && summary?.kind === 'card-comment' ? summary.comment : null,
        blocked:
            stage.role === 'review' && cardBlock?.kind === 'card-block' ? cardBlock.comment : null,
        findings,
        fixes,
    };
}

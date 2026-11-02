// Серия одинаковых отказов (#238): раньше петля узнавала повтор только по числу взятий
// карточки, хотя разные причины требуют разных решений. Модуль чистый: он сравнивает
// структурированные отказы, накапливает их серию и решает о стопе, а хранение и оркестрация
// остаются у вызывающего кода следующих карточек фазы.

import { SessionRequestParseError, UnknownLiveProbeError } from './session-requests.ts';
import { redactSecrets } from '../shared/ralph-util.ts';
import type { TStopMessageInput } from './stop-message.ts';

export type TRefusalCode = 'intent-rejected' | 'live-probe-unavailable';
export type TRefusal = {
    code: TRefusalCode;
    params: Record<string, string>;
    reason: string;
};

const MAX_REASON = 500;
const MAX_IDENTITY_PART = 200;

function safeText(text: string, secrets: Array<string | undefined>, max: number): string {
    const safe = redactSecrets(text, secrets).replace(/\s+/g, ' ').trim();
    return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

function fallbackWhat(message: string): string {
    return message
        .replace(/^Запрос сессии(?:, строка \d+)?:\s*/, '')
        .replace(/"(?:\\.|[^"\\])*"/g, '"…"')
        .replace(/«.*»/gs, '«…»')
        .replace(/\b\d+(?:[.:]\d+)*\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim();
}

export function refusalOfParseError(e: unknown, secrets: Array<string | undefined> = []): TRefusal {
    const message = e instanceof Error ? e.message : String(e);
    const safeMessage = redactSecrets(message, secrets);
    const reason = safeText(safeMessage, [], MAX_REASON);
    if (e instanceof UnknownLiveProbeError) {
        return {
            code: 'live-probe-unavailable',
            params: {
                cli: safeText(e.cli, secrets, MAX_IDENTITY_PART),
                case: safeText(e.probeCase, secrets, MAX_IDENTITY_PART),
            },
            reason,
        };
    }
    const what = e instanceof SessionRequestParseError ? e.refusalWhat : fallbackWhat(safeMessage);
    return {
        code: 'intent-rejected',
        params: { what: safeText(what, secrets, MAX_IDENTITY_PART) },
        reason,
    };
}

export type TRefusalSeries = {
    milestone: string;
    issue: number;
    stage: 'coder';
    code: TRefusalCode;
    params: Record<string, string>;
    count: number;
    reason: string;
    evidence: string | null;
    attemptShas: string[];
};

export function refusalIdentity(s: {
    milestone: string;
    issue: number;
    stage: 'coder';
    code: TRefusalCode;
    params: Record<string, string>;
}): string {
    const params = Object.fromEntries(
        Object.entries(s.params).sort(([a], [b]) => a.localeCompare(b)),
    );
    return JSON.stringify([s.milestone, s.issue, s.stage, s.code, params]);
}

export function recordRefusal(
    prev: TRefusalSeries | null,
    at: { milestone: string; issue: number; sha: string | null; evidence: string | null },
    refusal: TRefusal,
): TRefusalSeries {
    const next = { ...at, stage: 'coder' as const, ...refusal };
    if (prev !== null && refusalIdentity(prev) === refusalIdentity(next)) {
        const attemptShas = [...prev.attemptShas];
        if (at.sha !== null && !attemptShas.includes(at.sha)) attemptShas.push(at.sha);
        return {
            ...prev,
            params: { ...prev.params },
            count: prev.count + 1,
            reason: refusal.reason,
            evidence: at.evidence,
            attemptShas,
        };
    }
    return {
        milestone: at.milestone,
        issue: at.issue,
        stage: 'coder',
        code: refusal.code,
        params: { ...refusal.params },
        count: 1,
        reason: refusal.reason,
        evidence: at.evidence,
        attemptShas: at.sha === null ? [] : [at.sha],
    };
}

export function shouldStopOnSeries(
    series: TRefusalSeries | null,
    next: { milestone: string; issue: number },
    max: number,
): boolean {
    if (series === null || series.milestone !== next.milestone || series.issue !== next.issue) {
        return false;
    }
    return series.code === 'live-probe-unavailable' || series.count >= max;
}

export function refusalStopText(
    series: TRefusalSeries,
    max: number,
    coreSha = '',
): TStopMessageInput {
    const evidence = series.evidence ?? 'не сохранён';
    if (series.code === 'live-probe-unavailable') {
        return {
            // TStopReason — закрытый перечень причин цикла; фактический код назван в диагнозе.
            reason: 'intent-rejected',
            diagnosis:
                `Issue #${series.issue}: отказ live-probe-unavailable — пары живой пробы ` +
                `${series.params.cli}/${series.params.case} нет в каталоге установленного раннера. ` +
                `Ревизия установки: ${coreSha || 'неизвестна'}. Сессия её не добавит: каталог проб ` +
                `принадлежит установке, ветка его не меняет. Батч — ${evidence}.`,
            question:
                'установи ревизию ядра с этой пробой и перезапусти loop или перережь карточку без неё',
        };
    }
    return {
        reason: 'intent-rejected',
        diagnosis:
            `Issue #${series.issue}: число одинаковых отказов подряд: ${series.count} ` +
            `(${series.code}, порог maxSameRefusal = ${max}): ${series.reason}. Батч — ${evidence}.`,
        question:
            'разбери причину по батчу в карантине, поправь карточку или правило и перезапусти loop',
    };
}

export function parseRefusalSeries(raw: unknown): TRefusalSeries | null {
    if (raw === undefined || raw === null) return null;
    const invalid = (field: string, why: string): never => {
        throw new Error(`refusalSeries: ${field} ${why}`);
    };
    if (typeof raw !== 'object' || Array.isArray(raw)) invalid('значение', '— не объект');
    const value = raw as Record<string, unknown>;
    const fields: readonly string[] = [
        'milestone',
        'issue',
        'stage',
        'code',
        'params',
        'count',
        'reason',
        'evidence',
        'attemptShas',
    ];
    const extra = Object.keys(value).find((key) => !fields.includes(key));
    if (extra !== undefined) invalid('лишнее поле', extra);
    if (typeof value.milestone !== 'string') invalid('milestone', '— не строка');
    if (typeof value.issue !== 'number' || !Number.isInteger(value.issue) || value.issue < 1) {
        invalid('issue', '— не целое положительное число');
    }
    if (value.stage !== 'coder') invalid('stage', '— не coder');
    if (value.code !== 'intent-rejected' && value.code !== 'live-probe-unavailable') {
        invalid('code', '— неизвестный код отказа');
    }
    if (typeof value.params !== 'object' || value.params === null || Array.isArray(value.params)) {
        invalid('params', '— не объект');
    }
    const params = value.params as Record<string, unknown>;
    if (!Object.values(params).every((param) => typeof param === 'string')) {
        invalid('params', '— значения не строки');
    }
    const expectedParams = value.code === 'live-probe-unavailable' ? ['case', 'cli'] : ['what'];
    if (Object.keys(params).sort().join(',') !== expectedParams.join(',')) {
        invalid('params', `— ожидались ровно поля ${expectedParams.join(', ')}`);
    }
    if (typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1) {
        invalid('count', '— не целое число ≥ 1');
    }
    if (typeof value.reason !== 'string') invalid('reason', '— не строка');
    if (value.evidence !== null && typeof value.evidence !== 'string') {
        invalid('evidence', '— не строка и не null');
    }
    if (
        !Array.isArray(value.attemptShas) ||
        !value.attemptShas.every((sha) => typeof sha === 'string')
    ) {
        invalid('attemptShas', '— не массив строк');
    }
    return {
        milestone: value.milestone as string,
        issue: value.issue as number,
        stage: 'coder',
        code: value.code as TRefusalCode,
        params: Object.fromEntries(
            Object.entries(params).map(([key, param]) => [key, param as string]),
        ),
        count: value.count as number,
        reason: value.reason as string,
        evidence: value.evidence as string | null,
        attemptShas: [...(value.attemptShas as string[])],
    };
}

// Токены и стоимость попытки — запуска кодер-рантайма (задача 95; журнал вызовов по образцу
// sourcecraft.dev/derbush/all-together: строка на вызов, тариф — снимком на момент вызова).
//
// Сколько стоила сессия, раньше не знал никто: `claude -p` в текстовом режиме печатает
// только ответ. Токены по моделям отдаёт `--output-format json` — поэтому рантайм Claude
// (и Kimi через тот же бинарь) теперь запускается с ним, а вывод переводится обратно в
// текст для лога, разбора падения и блока намерений. Исход сессии (лимит, бюджет ходов,
// обрыв) из этого текста больше не читается: его по сырому JSON — `subtype:
// error_max_turns` и прочему — называет адаптер рантайма (`adapters/session-end.ts`, Фаза
// 16). Прежде перевод синтезировал маркер `Reached max turns`, которого ждала регулярка
// ядра; с переездом признаков в адаптер синтез снят.
//
// Вывод, который как JSON-результат не разобрался (старый CLI, обрыв посреди, чужой
// рантайм), идёт дальше как есть — читатели видят прежний текст, — а попытка ложится в
// журнал с причиной «токены неизвестны». Молча без записи попытка не остаётся.
//
// Стоимость — по тарифу из `observability.pricing`, и тариф копируется в запись: его поменяют,
// а пересчёт прошлых попыток по новому соврал бы о них. Тарифа модели в конфиге нет — берётся
// стоимость, которую посчитал сам рантайм по своему прайсу на момент вызова (`costUSD`), с
// пометкой источника; нет и её — стоимость неизвестна, и это тоже сказано в записи.
//
// Рядом со стоимостью запись несёт фактическую версию CLI, профиль (харнесс, провайдер,
// модель) и исход сессии (#113, R13): CLI обновляются сами, и без версии в записи дефект
// ядра неотличим от смены поведения инструмента. Поля обязательные у КАЖДОЙ записи —
// нечитаемая версия пишется словом `unknown` с причиной, а не пропуском поля
// (`adapters/runtime-profile.ts`).

import type { TTariff } from './observability.ts';
import type { SessionEndReason } from '../adapters/adapters.ts';
import type { CliVersion, RuntimeProfile } from '../adapters/runtime-profile.ts';
import { readClaudeResultEnvelope } from '../adapters/session-end.ts';

export const CLAUDE_JSON_ARGS = ['--output-format', 'json'];

export type TModelUsage = {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reportedCostUsd: number | null;
};

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function numOrNull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Конверт разбирает адаптер (`readClaudeResultEnvelope`) — тот же, по которому он называет
// исход: две копии разбора одной формы разъехались бы при следующей правке CLI. Здесь —
// только перевод в текст и токены.
export function parseClaudeJsonResult(
    stdout: string,
): { text: string; models: TModelUsage[]; durationMs: number | null } | null {
    const v = readClaudeResultEnvelope(stdout);
    if (!v) return null;
    const parts: string[] = [];
    if (typeof v.result === 'string' && v.result !== '') parts.push(v.result);
    if (Array.isArray(v.errors)) {
        for (const e of v.errors) if (typeof e === 'string') parts.push(`Error: ${e}`);
    }
    // Ошибочный результат несёт ещё и сырой JSON: форм ошибки у CLI больше, чем проверено
    // живьём, и человеку, разбирающему падение, лишняя строка дешевле потерянной причины.
    if (v.is_error === true) parts.push(stdout.trim());
    const models: TModelUsage[] = [];
    if (isObject(v.modelUsage)) {
        for (const [model, u] of Object.entries(v.modelUsage)) {
            if (!isObject(u)) continue;
            models.push({
                model,
                input: num(u.inputTokens),
                output: num(u.outputTokens),
                cacheRead: num(u.cacheReadInputTokens),
                cacheWrite: num(u.cacheCreationInputTokens),
                reportedCostUsd: numOrNull(u.costUSD),
            });
        }
    } else if (isObject(v.usage)) {
        // Старый формат без разбивки по моделям: модель неизвестна, тариф к ней не приложить.
        models.push({
            model: 'unknown',
            input: num(v.usage.input_tokens),
            output: num(v.usage.output_tokens),
            cacheRead: num(v.usage.cache_read_input_tokens),
            cacheWrite: num(v.usage.cache_creation_input_tokens),
            reportedCostUsd: numOrNull(v.total_cost_usd),
        });
    }
    return { text: parts.join('\n'), models, durationMs: numOrNull(v.duration_ms) };
}

export type TCostBasis = 'config-tariff' | 'runtime-reported' | 'unknown';

export type TPricedModel = TModelUsage & {
    tariff: TTariff | null;
    costUsd: number | null;
    costBasis: TCostBasis;
};

export function priceModel(u: TModelUsage, pricing: Record<string, TTariff> | null): TPricedModel {
    const t = pricing?.[u.model];
    if (t) {
        const costUsd =
            (u.input * t.inputPerMTok +
                u.output * t.outputPerMTok +
                u.cacheRead * t.cacheReadPerMTok +
                u.cacheWrite * t.cacheWritePerMTok) /
            1_000_000;
        return { ...u, tariff: { ...t }, costUsd, costBasis: 'config-tariff' };
    }
    if (u.reportedCostUsd !== null) {
        return { ...u, tariff: null, costUsd: u.reportedCostUsd, costBasis: 'runtime-reported' };
    }
    return { ...u, tariff: null, costUsd: null, costBasis: 'unknown' };
}

// Что о попытке известно помимо расхода: чем она шла и чем кончилась.
export type TAttemptSession = {
    profile: RuntimeProfile;
    cliVersion: CliVersion;
    endReason: SessionEndReason;
};

export type TAttemptRecord = {
    runtime: string;
    code: number;
    profile: RuntimeProfile;
    cliVersion: string;
    cliVersionUnknown?: string;
    endReason: SessionEndReason;
    durationMs: number | null;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
    costUsd: number | null;
    models: TPricedModel[];
    usageUnknown?: string;
};

// Запись попытки для журнала. Итог стоимости — сумма по моделям, только если известна
// каждая: частичная сумма выглядела бы полной.
export function attemptRecord({
    runtime,
    code,
    parsed,
    pricing,
    unknownReason,
    session,
}: {
    runtime: string;
    code: number;
    parsed: ReturnType<typeof parseClaudeJsonResult>;
    pricing: Record<string, TTariff> | null;
    unknownReason?: string;
    session: TAttemptSession;
}): TAttemptRecord {
    const head = {
        runtime,
        code,
        profile: session.profile,
        cliVersion: session.cliVersion.version,
        ...(session.cliVersion.unknownReason
            ? { cliVersionUnknown: session.cliVersion.unknownReason }
            : {}),
        endReason: session.endReason,
    };
    if (!parsed || parsed.models.length === 0) {
        return {
            ...head,
            durationMs: parsed?.durationMs ?? null,
            tokens: null,
            costUsd: null,
            models: [],
            usageUnknown:
                unknownReason ??
                (parsed
                    ? 'рантайм не отдал расход по моделям'
                    : 'вывод рантайма не разобрался как JSON-результат'),
        };
    }
    const models = parsed.models.map((u) => priceModel(u, pricing));
    const tokens = models.reduce(
        (a, m) => ({
            input: a.input + m.input,
            output: a.output + m.output,
            cacheRead: a.cacheRead + m.cacheRead,
            cacheWrite: a.cacheWrite + m.cacheWrite,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const costUsd = models.every((m) => m.costUsd !== null)
        ? models.reduce((a, m) => a + (m.costUsd as number), 0)
        : null;
    return { ...head, durationMs: parsed.durationMs, tokens, costUsd, models };
}

// Человеческая строка о попытке — для лога. Маркер 💰 нейтрален для deadman: режим петли он
// не меняет, и порог сессии не сбрасывается на короткий. Кеш назван отдельно от итога: у него
// свой тариф и свой смысл, и одно число человек принял бы за объём работы — в типичной
// попытке почти всё оно приходится на запись кеша.
// Хвост — профиль, версия CLI и исход: по строке лога видно, чем шла попытка, без журнала.
export function attemptLogLine(r: TAttemptRecord): string {
    const p = r.profile;
    const tail = ` Профиль ${p.harness}/${p.provider}/${p.model}, CLI ${r.cliVersion}, исход ${r.endReason}.`;
    if (!r.tokens) {
        return `💰 Попытка (${r.runtime}): расход неизвестен — ${r.usageUnknown}.${tail}`;
    }
    const cache = r.tokens.cacheRead + r.tokens.cacheWrite;
    const total = r.tokens.input + r.tokens.output + cache;
    const bases = [...new Set(r.models.map((m) => m.costBasis))].join('+');
    const cost = r.costUsd === null ? 'стоимость неизвестна' : `$${r.costUsd.toFixed(4)}`;
    return `💰 Попытка (${r.runtime}): ${total} токенов (из них кеш ${cache}), ${cost} (тариф: ${bases}).${tail}`;
}

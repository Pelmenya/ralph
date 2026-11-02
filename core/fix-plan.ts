/**
 * Планировщик фиксирует решение на класс проблемы до начала правок. Блок разбирается
 * fail-closed: неоднозначная форма не должна возвращать сессии правок свободу выбора.
 */

export const FIX_PLAN_BEGIN = '<<<RALPH-FIX-PLAN>>>';
export const FIX_PLAN_END = '<<<END-RALPH-FIX-PLAN>>>';

export type TFixPlan = {
    decision: string;
    rejected: string[];
    steps: {
        do: string;
        check: string;
        expect: 'RED' | 'GREEN';
    }[];
};

type TFixPlanResult = { plan: TFixPlan } | { error: string };

const PLAN_FIELDS: readonly string[] = ['decision', 'rejected', 'steps'];
const STEP_FIELDS: readonly string[] = ['do', 'check', 'expect'];

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

function unknownField(value: Record<string, unknown>, fields: readonly string[]): string | null {
    return Object.keys(value).find((key) => !fields.includes(key)) ?? null;
}

export function extractFixPlan(output: string): TFixPlanResult {
    const lines = output.split('\n').map((line) => line.trim());
    const markers = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line === FIX_PLAN_BEGIN || line === FIX_PLAN_END);
    if (markers.length === 0 || markers[0].line === FIX_PLAN_END) {
        return { error: 'блока плана нет' };
    }
    if (markers.length > 1 && markers[1].line === FIX_PLAN_BEGIN) {
        return { error: 'второй блок плана' };
    }
    if (markers.length === 1) return { error: 'блок не закрыт' };
    if (markers.length > 2) return { error: 'второй блок плана' };

    const first = markers[0].index;
    const last = markers[1].index;
    let value: unknown;
    try {
        value = JSON.parse(lines.slice(first + 1, last).join('\n'));
    } catch {
        return { error: 'не JSON' };
    }
    return validateFixPlan(value);
}

export function validateFixPlan(value: unknown): TFixPlanResult {
    if (!isObject(value)) return { error: 'план — не объект' };

    const extra = unknownField(value, PLAN_FIELDS);
    if (extra !== null) return { error: `незнакомое поле ${extra}` };
    if (!isNonEmptyString(value.decision)) return { error: 'пустое решение' };
    if (!Array.isArray(value.rejected)) return { error: 'rejected — не массив' };
    if (!value.rejected.every(isNonEmptyString)) {
        return { error: 'rejected — пустая строка или не строка' };
    }
    if (!Array.isArray(value.steps)) return { error: 'steps — не массив' };
    if (value.steps.length < 1 || value.steps.length > 8) {
        return { error: `шагов ${String(value.steps.length)} — ожидалось 1–8` };
    }

    const steps: TFixPlan['steps'] = [];
    for (const [index, rawStep] of value.steps.entries()) {
        const number = index + 1;
        if (!isObject(rawStep)) return { error: `шаг ${String(number)} — не объект` };
        const stepExtra = unknownField(rawStep, STEP_FIELDS);
        if (stepExtra !== null) {
            return { error: `шаг ${String(number)}: незнакомое поле ${stepExtra}` };
        }
        if (!isNonEmptyString(rawStep.do)) return { error: `шаг ${String(number)}: нет действия` };
        if (!isNonEmptyString(rawStep.check)) {
            return { error: `шаг ${String(number)}: нет команды` };
        }
        if (rawStep.expect !== 'RED' && rawStep.expect !== 'GREEN') {
            return { error: `шаг ${String(number)}: expect не RED/GREEN` };
        }
        steps.push({
            do: rawStep.do,
            check: rawStep.check,
            expect: rawStep.expect,
        });
    }

    return { plan: { decision: value.decision, rejected: [...value.rejected], steps } };
}

export function formatFixPlan(plan: TFixPlan): string {
    return [
        `Решение: ${plan.decision}`,
        'Отвергнуто:',
        ...plan.rejected.map((item) => `- ${item}`),
        ...plan.steps.map(
            (step, index) =>
                `${String(index + 1)}. ${step.do} — проверка: ${step.check} — ожидается ${step.expect}`,
        ),
    ].join('\n');
}

// Возможности рантайма кодер-сессии, объявленные явно (Фаза 16b, #118;
// `docs/harness-adapters.md`, «Обязательные возможности на старте»).
//
// Харнессы умеют разное: Claude Code держит `--max-turns` и `--fallback-model`, Codex не
// знает ни того, ни другого. Ядро передаёт `RunOptions` всем рантаймам одинаково, и до этой
// карточки неподдержанный параметр молча игнорировался: `maxTurns` у Codex выглядел в
// конфиге гарантией, которой нет. Поэтому реализация шва несёт объявление того, что она
// ИСПОЛНЯЕТ, а ядро сверяет с ним требования конфига до выбора задачи
// (`core/runtime-requirements.ts`).
//
// Объявление — поле адаптера, а не таблица рядом с ядром: возможность — свойство
// реализации, и реализация без неё не собирается (`buildAdapters` отвергает реестр, где у
// рантайма объявления нет или оно не по форме). Молчание здесь читалось бы как «умеет всё».
//
// TS-модуль без билд-шага (erasable-only), без побочек.

import type { RuntimeCapabilities, TurnLimitLevel } from './adapters.ts';

// Бюджет ходов. `required` — рантайм ГАРАНТИРУЕТ потолок (CLI сам обрывает сессию на
// `maxTurns`); `best-effort` — потолка у CLI нет или он не передаётся, и сессию держат только
// внешние `maxIterations` и тайм-аут.
export const TURN_LIMIT_LEVELS: ReadonlyArray<TurnLimitLevel> = ['best-effort', 'required'];

// Фолбэк-модель — внутри одной сессии (`--fallback-model` у Claude Code). `false` — ядро не
// имитирует её внешними повторами: повтор — другая сессия, а не та же с запасной моделью.

// Сессия без инструментов (#217) — переспрос отвергнутого батча намерений. Объявляет её
// только CLI, у которого запрет ВСЕХ инструментов — флаг запуска, а не просьба промптом:
// у Claude Code это `--tools ""` (встроенные) и `--strict-mcp-config` без `--mcp-config`
// (MCP). У Codex, Kimi Code и OpenCode такого флага нет — набор режется там конфигом
// агента по именам инструментов, и новый инструмент версии CLI проехал бы мимо списка.
// Им переспроса нет: стоп, как до #217.

// Claude Code: `--max-turns` обрывает сессию самим CLI, `--fallback-model` есть.
export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
    turnLimit: 'required',
    fallbackModel: true,
    toolless: true,
};

// Kimi — тот же харнесс Claude Code с endpoint Moonshot: флаги те же, фолбэк — из
// `kimiRuntime.fallbackModel`.
export const KIMI_CAPABILITIES: RuntimeCapabilities = {
    turnLimit: 'required',
    fallbackModel: true,
    toolless: true,
};

// Codex (`codex exec`): аналога `--max-turns` нет, в argv он не передаётся сознательно
// (чужой CLI на неизвестный флаг упал бы); фолбэк-модели тоже нет.
export const CODEX_CAPABILITIES: RuntimeCapabilities = {
    turnLimit: 'best-effort',
    fallbackModel: false,
    toolless: false,
};

// Kimi Code (`kimi-native`, #120): потолок шагов хода исполняет сам CLI
// (`KIMI_LOOP_MAX_STEPS_PER_TURN` → `loop.max_steps_exceeded`, код 1 — проверено живьём);
// флага фолбэк-модели у `kimi` нет.
export const KIMI_NATIVE_CAPABILITIES: RuntimeCapabilities = {
    turnLimit: 'required',
    fallbackModel: false,
    toolless: false,
};

// OpenCode (`opencode`, #121): бюджета ходов, который CLI исполнял бы обрывом сессии, нет, и
// `maxTurns` в argv не уходит; флага фолбэк-модели у `opencode run` нет.
export const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
    turnLimit: 'best-effort',
    fallbackModel: false,
    toolless: false,
};

// Ошибки формы объявления; пустой список — объявление годно. Отдельно от бросающей обёртки,
// чтобы сборка называла рантайм, а сьют проверял каждую причину.
export function capabilitiesProblems(caps: unknown): string[] {
    if (caps === null || typeof caps !== 'object' || Array.isArray(caps))
        return ['возможности не объявлены (поле `capabilities` отсутствует или не объект)'];
    const c = caps as Record<string, unknown>;
    const out: string[] = [];
    if (!(TURN_LIMIT_LEVELS as ReadonlyArray<unknown>).includes(c.turnLimit))
        out.push(
            `capabilities.turnLimit = ${JSON.stringify(c.turnLimit)} — ожидалось ${TURN_LIMIT_LEVELS.join(' | ')}`,
        );
    if (typeof c.fallbackModel !== 'boolean')
        out.push(
            `capabilities.fallbackModel = ${JSON.stringify(c.fallbackModel)} — ожидалось true | false`,
        );
    if (c.toolless !== undefined && typeof c.toolless !== 'boolean')
        out.push(
            `capabilities.toolless = ${JSON.stringify(c.toolless)} — ожидалось true | false или нет поля`,
        );
    return out;
}

/**
 * Форма секции конфига рантайма (`kimiNativeRuntime`, `opencodeRuntime`): объект, ключи только
 * из названных, значения — непустые строки. Ревью Фазы 16b: `home: 123` или опечатка `homee`
 * молча откатывали Kimi на дом по умолчанию, и сессия входила не тем домом. Секции нет —
 * проверять нечего; обязательность её решает старт по достижимости рантайма.
 */
export function runtimeSectionProblems(
    name: string,
    section: unknown,
    keys: readonly string[],
): string[] {
    if (section === undefined) return [];
    if (section === null || typeof section !== 'object' || Array.isArray(section))
        return [`${name} = ${JSON.stringify(section)} — ожидался объект`];
    const out: string[] = [];
    for (const [k, v] of Object.entries(section)) {
        // Из JSON `undefined` не приходит; так ключ выглядит только у собранного в коде объекта.
        if (v === undefined) continue;
        if (!keys.includes(k)) {
            out.push(`${name}.${k} — незнакомый ключ (допустимы: ${keys.join(', ')})`);
            continue;
        }
        if (typeof v !== 'string' || v.trim() === '')
            out.push(`${name}.${k} = ${JSON.stringify(v)} — ожидалась непустая строка`);
    }
    return out;
}

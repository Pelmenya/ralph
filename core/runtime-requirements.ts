// Требования конфига к рантайму против возможностей, которые рантайм объявил (Фаза 16b,
// #118; `docs/harness-adapters.md`, «Обязательные возможности на старте»).
//
// До карточки ядро передавало `maxTurns` всем рантаймам одинаково, а Codex его молча не
// исполнял: потолок ходов в конфиге выглядел гарантией, которой у харнесса нет. Теперь
// сверка идёт на старте, до worktree и выбора задачи, по каждому достижимому рантайму
// (статический плюс маршруты `modelRouting`): фолбэк лимита на рантайм, не умеющий
// требуемого, всплыл бы посреди ночи.
//
// Строгость задаётся ЯВНО: ключ `turnLimit` конфига. Пропущенный — `best-effort`: рантайм
// применяет бюджет, если умеет, а нет — старт идёт со строкой в лог, что гарантии нет, и
// держат сессию внешние `maxIterations` и тайм-аут. Иначе обычный параметр, который ядро
// передаёт всем, неявно стал бы требованием и уронил бы существующий конфиг на Codex.
// `required` у рантайма, который его не объявил, — отказ, и причина называет рантайм и
// возможность. Значение вне пары — тоже отказ: опечатка `requred` молча означала бы
// `best-effort`, то есть ровно ту ложную гарантию, ради которой ключ заведён.
//
// Вторая возможность — фолбэк-модель (`fallbackModel`). Общий `cfg.fallbackModel` уходит
// `--fallback-model` только у Claude Code; рантайм, объявивший `fallbackModel: false`, его
// молча не исполнил бы — тот самый класс «параметр проигнорирован», против которого #118
// (ревью Фазы 16b: поле объявлялось, а ядро его не читало). Отказа здесь нет: общий ключ —
// настройка Claude-сессий, и конфиг, где Codex идёт рядом с Claude, рабочий. Поэтому — строка
// `⚠` в лог старта с именем рантайма, как у бюджета ходов `best-effort`.
//
// TS-модуль без билд-шага (erasable-only), без побочек: коллабораторы — параметрами.

import type { RuntimeCapabilities, TurnLimitLevel } from '../adapters/adapters.ts';
import { TURN_LIMIT_LEVELS } from '../adapters/runtime-capabilities.ts';

export type RuntimeRequirementsDeps = {
    // Объявление рантайма по ключу реестра; `undefined` — ключа в реестре нет.
    capabilitiesOf: (provider: string) => RuntimeCapabilities | undefined;
    failFn: (msg: string) => never;
    logFn: (msg: string) => void;
};

// Явная строгость бюджета ходов из конфига. Ключа нет — `best-effort`, сказанное вызывающим.
export function resolveTurnLimit(raw: unknown, failFn: (msg: string) => never): TurnLimitLevel {
    if (raw === undefined) return 'best-effort';
    if ((TURN_LIMIT_LEVELS as ReadonlyArray<unknown>).includes(raw)) return raw as TurnLimitLevel;
    return failFn(
        `ralph.config.json: turnLimit = ${JSON.stringify(raw)} — допустимы ` +
            `${TURN_LIMIT_LEVELS.map((l) => `'${l}'`).join(' и ')}; ключ не задан — 'best-effort'.`,
    );
}

// Задан ли общий фолбэк: строка модели, кроме осознанного «нет» (`'none'`).
function fallbackRequested(raw: unknown): raw is string {
    return typeof raw === 'string' && raw.trim() !== '' && raw !== 'none';
}

export function checkRuntimeRequirements(
    cfg: { turnLimit?: unknown; fallbackModel?: unknown },
    providers: Iterable<string>,
    { capabilitiesOf, failFn, logFn }: RuntimeRequirementsDeps,
): void {
    const turnLimit = resolveTurnLimit(cfg.turnLimit, failFn);
    for (const provider of providers) {
        const caps = capabilitiesOf(provider);
        if (!caps)
            return failFn(
                `Рантайм '${provider}' не объявил возможностей — сверить с ним конфиг нечем, ` +
                    'запуск остановлен до выбора задачи.',
            );
        if (!caps.fallbackModel && fallbackRequested(cfg.fallbackModel))
            logFn(
                `⚠ Рантайм '${provider}': фолбэк-модели нет (возможность fallbackModel: false) — ` +
                    `fallbackModel ${JSON.stringify(cfg.fallbackModel)} его сессиям не достанется.`,
            );
        if (caps.turnLimit === 'required') continue;
        if (turnLimit === 'required')
            return failFn(
                `Рантайм '${provider}' не гарантирует бюджет ходов (возможность turnLimit: ` +
                    `'${caps.turnLimit}'), а конфиг требует turnLimit: 'required'. Выбери рантайм, ` +
                    'который его гарантирует, или убери строгое требование — запуск остановлен до выбора задачи.',
            );
        logFn(
            `⚠ Рантайм '${provider}': бюджет ходов (maxTurns) — best-effort, гарантии нет; ` +
                'сессию держат maxIterations и тайм-аут.',
        );
    }
}

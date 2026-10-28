// Доверенный контекст сессии петли (`SessionContext`, `docs/harness-contract.md`; #184, Фаза 16c).
//
// Зачем. Guard дерева сессии контракта `RALPH_CORE_SHA` не получает — раннер кладёт его только
// в команду своих хуков (#132), — и петлю такой хук узнавал по транскрипту Claude Code, строкой
// `ralph.md` в промпте. Догадка по тексту: сессия человека с похожим промптом считалась петлёй,
// а у Codex, Kimi Code и OpenCode транскрипта Claude нет. Теперь раннер ЗАЯВЛЯЕТ петлю сам:
// контекст едет JSON в переменной `RALPH_SESSION_CONTEXT` окружения сессии, и каждый хук,
// который CLI запускает, получает его наследованием. Окружение процесса хука сессия не
// переписывает — его порождает CLI, а не её команды; файл в дереве или в каталоге состояния
// она переписать могла бы, поэтому контекст едет не файлом.
//
// Корни обязательны оба. С раскладкой `roots` потребитель — дерево человека, исполнение —
// дерево сессии; без неё раннер заполняет оба доверенным каталогом дерева сессии — тем, в
// котором он сам ставит ветку фазы и запускает CLI. Контекст без обоих корней — отказ
// preflight, а не контекст «как получилось»: хук, получивший половину, решал бы по ней.
//
// Разбор на стороне хука — `.claude/hooks/session-context.cjs`; равенство формы держит тест.
// Решает guard пока по одному `loop`: забор данных контура узнаёт путь шаблоном, а не
// относительно `roots.execution`. Остальные поля сверяются по форме — битый контекст блокирует, —
// и едут для правил, которые будут судить путь относительно корней.
//
// TS-модуль без билд-шага (erasable-only), без побочек.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Переменная контекста в окружении сессии (читает `session-context.cjs`). */
export const SESSION_CONTEXT_ENV = 'RALPH_SESSION_CONTEXT';

export type TSessionContext = {
    sessionId: string;
    /** Только по заявлению раннера: контекст получают лишь его сессии. */
    loop: boolean;
    /** Ревизия ядра контракта `RALPH_CORE_SHA`; пусто — ядро без контракта. */
    coreRevision: string;
    roots: { consumer: string; execution: string };
};

export type TSessionContextBuild =
    { ok: true; context: TSessionContext; value: string } | { ok: false; reason: string };

/**
 * Контекст сессии петли. `humanRoot` — дерево человека при раскладке `roots`, `null` — раскладки
 * нет, и потребитель — то же дерево сессии. Отказ — причина строкой: стоп делает вызывающий.
 */
export function loopSessionContext({
    humanRoot,
    sessionTree,
    coreSha,
    sessionIdFn = randomUUID,
}: {
    humanRoot: string | null;
    sessionTree: string | null;
    coreSha: string;
    sessionIdFn?: () => string;
}): TSessionContextBuild {
    const consumer = humanRoot ?? sessionTree;
    const missing = [
        ...(typeof consumer === 'string' && path.isAbsolute(consumer) ? [] : ['roots.consumer']),
        ...(typeof sessionTree === 'string' && path.isAbsolute(sessionTree)
            ? []
            : ['roots.execution']),
    ];
    if (missing.length > 0) {
        return {
            ok: false,
            reason:
                `Контекст сессии не собран: нет абсолютного ${missing.join(' и ')}. Хук без ` +
                'обоих корней решал бы по половине контекста — сессия не стартует.',
        };
    }
    const context: TSessionContext = {
        sessionId: sessionIdFn(),
        loop: true,
        coreRevision: coreSha,
        roots: { consumer: consumer as string, execution: sessionTree as string },
    };
    return { ok: true, context, value: JSON.stringify(context) };
}

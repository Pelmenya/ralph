/**
 * Дерево работы на ветке фазы: ставит его раннер, а не сессия (канон, задача 11).
 *
 * До этой правки хореография ветки была поручена кодер-сессии промптом («работай только в
 * указанной ветке»), а раннер оставлял дерево в detached HEAD на свежем `origin/main`.
 * Работало это ровно до сессии, которая не подобрала нужную идиому: слабая модель
 * закоммитила на detached HEAD, коммит остался недостижим ни из одной ветки — виден только
 * по SHA и живёт до первой чистки `gc`. По транскрипту она перебрала три пути и на всех
 * упёрлась: `git checkout <ветка>` спросил одобрения (в AFK это отказ), жёсткий откат
 * срезал guard потребителя, `git push <sha>:<ветка>` отвергся non-fast-forward. Сессия
 * сильной модели в тот же день вышла на `git switch` — и её работа легла штатно.
 *
 * Отсюда вывод, который и стоит за этим модулем: **сохранность работы не может зависеть от
 * того, какую идиому переберёт модель.** Тем более что модель выбирается по `complexity:*`,
 * то есть дешёвые задачи систематически рискуют больше дорогих — ровно наоборот к тому, как
 * стоило бы.
 *
 * Контракт: дерево стоит на `phase.branch` ДО спавна сессии. Тогда разрешение сессии на
 * переключение ветки не нужно вовсе, а не «нужно, но обычно получается».
 *
 * Развилок четыре, и они разные по последствиям — поэтому у каждой свой исход и своя строка
 * в логе, а не общее «готово»:
 *
 *   - ветки нет нигде — создаём от свежего `origin/main`;
 *   - ветка есть на `origin`, локального ref нет (свежий worktree, новая машина) — берём
 *     ЕЁ. Создать заново от `origin/main` значит получить расходящуюся ветку: пуш
 *     отвергнется non-ff, а до force-push доходить нельзя;
 *   - ветка есть и там и там — встаём и подтягиваем, но **только fast-forward**;
 *   - ветка есть только локально — встаём и не трогаем: там незапушенная работа прошлой
 *     сессии, и `origin` о ней ещё не знает.
 *
 * **Ничего не форсируем.** Ни `--force`, ни жёсткого отката, ни force-push: расхождение —
 * это отказ с названной причиной, а не повод переписать чью-то историю. Петля на таком
 * отказе встаёт; разбирать расхождение вслепую дороже, чем подождать человека.
 *
 * Чего модуль НЕ делает, и это решения, а не упущения:
 *
 *   - **не снимает `GIT_DIR` и родню из окружения** (в отличие от `consumer-tree.ts`). Там
 *     это обязательно: команды идут с `-C <чужой каталог>`, который `GIT_DIR` перебивает.
 *     Здесь мы работаем в собственном дереве раннера, и навязанный извне `GIT_DIR` увёл бы
 *     в чужой репозиторий не только нас, а весь раннер целиком. Снять его в одной функции
 *     значит создать ложное чувство закрытого класса;
 *   - **не гасит git-хуки.** Это дерево работы: те же хуки в нём исполняет сессия и
 *     исполнил бы человек. Тихо отключить их значит сделать наш checkout не тем, что
 *     проверяется потом;
 *   - **не ставит срока на сетевые вызовы сам.** Срок и запрет промпта кредов приходят
 *     из `gitNetworkOpts` (задача 30), а держит их путь исполнения `shArgv`.
 *
 * **Сетевой транзиент повторяется, отказ по существу — нет** (#144). Демо 27.10: после
 * закрытия карточки одиночный `git fetch` упал `gnutls_handshake() failed`, и петля встала
 * стопом `unknown`, хотя повторный старт через десять секунд прошёл. Поэтому три сетевых
 * шага модуля (fetch main, ls-remote, fetch ветки) различают класс отказа по ответу git:
 * TLS, DNS, обрыв и таймаут соединения, 5xx/408/429 — повтор с паузой, ограниченное число
 * раз; исчерпание — свой исход `network` с последним ответом git, чтобы стоп назывался
 * «сеть до origin», а не «причина не установлена». Нет кредов, нет доступа, нет репозитория
 * или ветки — стоп сразу: повтором это не лечится, а пауза только отложила бы причину.
 * Истёкший срок раннера — тоже `network`, но без повтора: он сам уже был десятиминутным
 * ожиданием (то же правило у `main-sync.ts`), и три срока подряд держали бы петлю полчаса.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */

import {
    gitErrorText,
    gitExitStatus,
    gitNetworkOpts,
    isExecTimeout,
    sleep,
} from '../shared/ralph-util.ts';
import type { ShArgvFn } from '../shared/ralph-util.ts';

/** Чем кончилась постановка дерева на ветку. Каждый исход — свой факт, не оттенок общего. */
export type TPhaseBranchKind =
    | 'unsafe-name'
    | 'created'
    | 'adopted'
    | 'adopted-detached'
    | 'fast-forwarded'
    | 'switched'
    | 'diverged'
    | 'network'
    | 'failed';

export type TPhaseBranchResult = {
    kind: TPhaseBranchKind;
    branch: string;
    /** HEAD после постановки. `null` — не удалось прочитать, то есть нечего и обещать. */
    sha: string | null;
    /** Причина отказа — той же строкой, что ушла в лог. */
    reason?: string;
};

export type TPhaseBranchDeps = {
    /** Тот же контракт, что у `shArgv` ядра: argv плюс опции запуска (нам нужен `env`). */
    runArgvFn: ShArgvFn;
    logFn: (msg: string) => void;
    /**
     * Проверка имени ветки — коллаборатором, как у `gate.ts`. Имя приходит из конфига и
     * уходит в argv: единая проверка на все точки входа лучше, чем своя копия регекспа в
     * каждой (тот же довод, что у гейта).
     */
    safeBranch: (branch: string | undefined, opts?: { where?: string }) => boolean;
    /** Окружение вызывающего: на сетевых вызовах к нему добавляются запрет промпта и срок. */
    env?: NodeJS.ProcessEnv;
    /** Пауза между повторами сетевого шага; по умолчанию — синхронный `sleep` ядра. */
    sleepFn?: (ms: number) => void;
};

/** Попыток на сетевой шаг, включая первую: транзиент демо проходил со второй. */
export const PHASE_BRANCH_NET_ATTEMPTS = 3;
/**
 * Пауза перед повтором номер i+1. Порядок окна, за которое проходил живой транзиент
 * (рестарт через 10 с), и всё ещё ничтожно рядом с итерацией петли.
 */
const NET_RETRY_PAUSES_MS = [5_000, 15_000];

/**
 * Признаки сетевого транзиента в ответе git. Только транспорт и шлюз: 4xx кроме 408/429 —
 * ответ по существу (нет доступа, нет репозитория), 501 — «не реализовано», повтором не
 * появится. Голые слова «network» и «timed out» признаком не считаются: их пишут и в
 * отказах по существу (ответ credential helper'а), поэтому таймаут — только формами curl.
 */
const ORIGIN_NET_TRANSIENT_RE = new RegExp(
    [
        'gnutls',
        'TLS connection',
        'SSL_(?:read|write|connect|ERROR)',
        'SSL connection',
        'Could not resolve (?:host|proxy)',
        'Temporary failure in name resolution',
        'Name or service not known',
        'Failed to connect',
        'Connection (?:timed out|reset|refused)',
        'Operation timed out',
        'Resolving timed out',
        'early EOF',
        'RPC failed',
        'remote end hung up unexpectedly',
        'unexpected disconnect',
        'Recv failure',
        'returned error: 50[0234]\\b',
        'returned error: 4(?:08|29)\\b',
        'HTTP 50[0234]\\b',
    ].join('|'),
    'i',
);

/** Отказ сетевого git — транзиент сети до origin (а не ответ по существу или наш срок). */
export function isOriginNetworkFailure(e: unknown): boolean {
    if (isExecTimeout(e)) return false;
    return ORIGIN_NET_TRANSIENT_RE.test(gitErrorText(e));
}

/**
 * Запреты, общие на ВСЕ команды модуля.
 *
 * `submodule.recurse=false` — не рекурсировать в подмодуль. У потребителя код продукта
 * (`.claude/ralph`) лежит подмодулем, и рекурсия при переключении ветки подменила бы код
 * ПОД РАБОТАЮЩЕЙ петлёй. Дефолт git на fetch — `on-demand`, то есть молчание здесь
 * означает «рекурсируем»; поэтому запрет стоит явно и на каждой команде, а не там, где
 * казалось нужнее.
 */
const GIT_FLAGS = ['-c', 'submodule.recurse=false'];

/**
 * Поставить дерево работы на ветку фазы.
 *
 * Зовётся ДО спавна сессии и на каждой итерации: цена — два сетевых вызова, а гарантия —
 * что коммит сессии достижим из ветки фазы независимо от того, что делала предыдущая.
 */
export function ensurePhaseBranch(branch: string, deps: TPhaseBranchDeps): TPhaseBranchResult {
    const { runArgvFn, logFn, safeBranch, env, sleepFn = sleep } = deps;
    // Проверка имени — ДО первого git: имя уходит в argv, и `--upload-pack=…`-образное
    // значение git прочтёт как флаг. Тот же замок стоит у гейта; повторяем его здесь, а не
    // полагаемся на вызывающего, — при переезде кода такой замок теряется незаметно (#49).
    if (!safeBranch(branch, { where: 'ветка фазы' })) {
        return { kind: 'unsafe-name', branch, sha: null, reason: 'небезопасное имя ветки' };
    }

    const git = (args: string[]): string => runArgvFn('git', [...GIT_FLAGS, ...args]);
    // Сетевой вызов — с запретом промпта кредов и сроком (задачи 71 и 30): без запрета git
    // при отсутствии кредов ждёт логина на `/dev/tty` (перенаправление stdin не спасает), без
    // срока молчащий origin держит вызов вечно. Отвечать в петле некому — вызов стоял бы до
    // дедмана без причины в логе. Раньше запрет ставился только при переданном `env`.
    //
    // Транзиент сети повторяется здесь же (#144); бросает последний отказ — повтор
    // исчерпан, либо это ответ по существу и повторять нечего. `isAnswer` — отказ, который
    // для шага есть ответ, а не сбой (код 2 у `ls-remote --exit-code`): его не повторяют.
    const gitNet = (args: string[], isAnswer: (e: unknown) => boolean = () => false): string => {
        for (let attempt = 1; ; attempt++) {
            try {
                return runArgvFn('git', [...GIT_FLAGS, ...args], gitNetworkOpts(env));
            } catch (e) {
                if (isAnswer(e) || !isOriginNetworkFailure(e)) throw e;
                if (attempt >= PHASE_BRANCH_NET_ATTEMPTS) throw e;
                const pause = NET_RETRY_PAUSES_MS[attempt - 1] ?? NET_RETRY_PAUSES_MS.at(-1) ?? 0;
                logFn(
                    `⚠ Ветка фазы ${branch}: git ${args[0]} — сеть до origin (${gitErrorText(e)}); ` +
                        `повтор ${attempt + 1}/${PHASE_BRANCH_NET_ATTEMPTS} через ${Math.round(pause / 1000)} с`,
                );
                sleepFn(pause);
            }
        }
    };
    const fail = (reason: string): TPhaseBranchResult => {
        logFn(`⛔ Ветка фазы ${branch}: ${reason}`);
        return { kind: 'failed', branch, sha: null, reason };
    };
    // Отказ сетевого шага: сеть до origin — свой исход с последним ответом git, чтобы стоп
    // назывался своей причиной; прочее — прежний `failed` с текстом шага.
    const netFail = (what: string, e: unknown): TPhaseBranchResult => {
        if (isExecTimeout(e) || isOriginNetworkFailure(e)) {
            const tries = isExecTimeout(e)
                ? 'срок вызова истёк, без повтора'
                : `попыток: ${PHASE_BRANCH_NET_ATTEMPTS}`;
            const reason = `сеть до origin: ${what} (${tries}) — последний ответ git: ${gitErrorText(e)}`;
            logFn(`⛔ Ветка фазы ${branch}: ${reason}`);
            return { kind: 'network', branch, sha: null, reason };
        }
        return fail(`${what} — ${gitErrorText(e)}`);
    };

    try {
        gitNet(['fetch', 'origin', 'main', '--quiet']);
    } catch (e) {
        return netFail('не смог обновить origin/main', e);
    }

    // Есть ли ветка на origin. `--exit-code` отвечает кодом 2 на «совпадений нет» — и это
    // ЕДИНСТВЕННЫЙ код, который здесь означает «ветки нет». Любой другой отказ (нет кредов,
    // молчит сеть) — сбой: принять его за «ветки нет» значит создать ветку заново от
    // origin/main поверх чужой работы и получить non-ff при пуше.
    let onOrigin: boolean;
    try {
        gitNet(
            ['ls-remote', '--exit-code', '--heads', 'origin', branch],
            (e) => gitExitStatus(e) === 2,
        );
        onOrigin = true;
    } catch (e) {
        if (gitExitStatus(e) !== 2) return netFail('не смог спросить origin о ветке', e);
        onOrigin = false;
    }

    // Симметрично `ls-remote`: «локального ref нет» — это КОД 1 от `rev-parse --verify
    // --quiet`, и только он. Всё прочее (128 — не репозиторий, повреждённая ref-база) —
    // сбой. Без разбора кода любая поломка уводила бы в ветку `switch --create`, а
    // безопасность держалась бы на том, что git обычно откажется создать существующий
    // ref, — то есть на удаче, а не на нашем решении (ревью, 1-й проход).
    let hasLocal: boolean;
    try {
        git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        hasLocal = true;
    } catch (e) {
        if (gitExitStatus(e) !== 1)
            return fail(`не смог прочитать локальный ref — ${gitErrorText(e)}`);
        hasLocal = false;
    }

    const head = (): string | null => {
        try {
            return git(['rev-parse', 'HEAD']).trim();
        } catch {
            return null;
        }
    };
    /**
     * Успех подтверждается тем, что HEAD символически указывает НА ВЕТКУ ФАЗЫ, а не тем,
     * что команда не бросила. Разница не теоретическая: хуки мы намеренно не гасим, а
     * `post-checkout` человека волен увести HEAD куда угодно — и сессия ушла бы работать
     * не туда с отчётом «встали на ветку» в логе (ревью, 1-й проход).
     */
    const done = (kind: TPhaseBranchKind, note: string): TPhaseBranchResult => {
        let current = '';
        try {
            current = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
        } catch {
            current = '';
        }
        if (current !== branch) {
            return fail(
                `команды прошли, но HEAD оказался ${current ? `на ветке ${current}` : 'detached'} — ` +
                    'дерево увёл кто-то ещё (хук?), сессию туда пускать нельзя',
            );
        }
        const sha = head();
        logFn(`🌿 Ветка фазы ${branch}: ${note}${sha ? ` (HEAD ${sha.slice(0, 8)})` : ''}`);
        return { kind, branch, sha };
    };

    // Ветку с origin подтягиваем ДО счёта работы на detached HEAD: в свежем worktree
    // ref'а origin/<ветка> ещё нет, и коммиты, давно лежащие на origin, сосчитались бы
    // как бесхозные — петля встала бы на ровном месте.
    if (onOrigin) {
        try {
            gitNet(['fetch', 'origin', branch, '--quiet']);
        } catch (e) {
            return netFail(`не смог подтянуть origin/${branch}`, e);
        }
    }

    // Работа на detached HEAD, которой нет ни в одной ветке (из копии потребителя). Такое
    // дерево оставляет сессия, закоммитившая мимо ветки, или человек; `git switch` с него
    // уходит молча, и коммиты остаются достижимы только по SHA — до первой чистки gc.
    //
    // Считаем `HEAD --not --branches --remotes`, а не `origin/main..HEAD`: гейт мерджа
    // сам оставляет дерево на detached-голове PR, то есть впереди origin/main на весь
    // дифф фазы, — по наивному счёту каждая итерация после гейта выглядела бы как
    // бесхозная работа. На ветке HEAD достижим из неё же, и счёт честно даёт ноль.
    //
    // «Не смог посчитать» — не «работы нет»: ошибка здесь стоит ровно того коммита,
    // ради которого модуль написан, поэтому отказ.
    let orphans: number;
    try {
        orphans = Number.parseInt(
            git(['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes']).trim(),
            10,
        );
    } catch (e) {
        return fail(`не смог посчитать коммиты HEAD вне веток — ${gitErrorText(e)}`);
    }
    if (!Number.isFinite(orphans)) {
        return fail('счёт коммитов HEAD вне веток нечитаем — переключаться вслепую нельзя');
    }
    if (orphans > 0) {
        const sha = head();
        // Ветки фазы нет нигде — работу можно взять ею как есть: ветка заводится на HEAD,
        // ничего не теряется и ничья история не переписывается.
        if (!onOrigin && !hasLocal) {
            try {
                git(['switch', '--create', branch]);
            } catch (e) {
                return fail(`не смог завести ветку на detached HEAD — ${gitErrorText(e)}`);
            }
            return done('adopted-detached', `взята работа с detached HEAD (${orphans} коммит(ов))`);
        }
        // Ветка уже есть — слить автоматически нечем, а переключение осиротило бы работу.
        // HEAD не прочитался — имя ref'а собирается командой, а не подставляется строкой
        // «HEAD»: `refs/ralph/rescue-HEAD` при втором инциденте перезаписал бы первый.
        const rescueRef = sha
            ? `refs/ralph/rescue-${sha}`
            : 'refs/ralph/rescue-$(git rev-parse HEAD)';
        return fail(
            `на detached HEAD ${sha ?? '(SHA не прочитан)'} есть ${orphans} коммит(ов) вне всех ` +
                `веток, а ветка ${branch} уже существует (${onOrigin ? 'на origin' : 'локально'}) — ` +
                `переключение их осиротило бы. Закрепи: git update-ref ${rescueRef} HEAD, ` +
                `потом влей в ${branch} руками`,
        );
    }

    try {
        if (onOrigin) {
            if (!hasLocal) {
                git(['switch', '--create', branch, '--track', `origin/${branch}`]);
                return done('adopted', 'взята с origin');
            }
            git(['switch', branch]);
            try {
                git(['merge', '--ff-only', `origin/${branch}`]);
            } catch (e) {
                // Расхождение чинится человеком: перезаписывать историю ветки, в которой
                // уже лежит чужая работа, раннеру нечем — и незачем.
                const reason =
                    `локальная ветка разошлась с origin/${branch}, ff невозможен — ` +
                    `${gitErrorText(e)}. Разбери руками: git log --oneline --graph ` +
                    `${branch} origin/${branch}`;
                logFn(`⛔ Ветка фазы ${branch}: ${reason}`);
                return { kind: 'diverged', branch, sha: head(), reason };
            }
            return done('fast-forwarded', 'подтянута ff с origin');
        }

        if (hasLocal) {
            git(['switch', branch]);
            return done('switched', 'только локальная — беру как есть, там незапушенная работа');
        }

        git(['switch', '--create', branch, 'origin/main']);
        return done('created', 'создана от свежего origin/main');
    } catch (e) {
        return fail(`не смог поставить дерево на ветку — ${gitErrorText(e)}`);
    }
}

export type TBranchCheck = { ok: boolean; message?: string; sha?: string };

/**
 * Страж ПОСЛЕ сессии: дерево обязано остаться на ветке фазы.
 *
 * Постановка до спавна снимает причину, по которой сессия оказывалась в detached HEAD, но
 * не запрещает ей уйти оттуда самой. Разница между этим стражем и тихой потерей ровно одна:
 * названный SHA. Коммит на detached HEAD достижим только по нему, и человек, читающий лог
 * через день, восстановит работу одной командой — либо не восстановит вовсе.
 *
 * Fail-closed: git не ответил — это отказ. «Наверное, всё в порядке» здесь стоит ровно
 * столько же, сколько потерянная сессия.
 */
export function checkOnPhaseBranch(branch: string, deps: TPhaseBranchDeps): TBranchCheck {
    const { runArgvFn, env } = deps;
    const git = (args: string[]): string => runArgvFn('git', [...GIT_FLAGS, ...args], { env });

    let sha: string;
    try {
        sha = git(['rev-parse', 'HEAD']).trim();
    } catch (e) {
        return { ok: false, message: `не смог прочитать HEAD дерева работы — ${gitErrorText(e)}` };
    }

    // `symbolic-ref` отказом отвечает на detached HEAD: это не сбой, а ответ «ветки нет».
    let current = '';
    try {
        current = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    } catch {
        current = '';
    }

    if (current === branch) return { ok: true, sha };

    const where = current ? `на ветке ${current}` : 'в detached HEAD';
    // Совет обязан ИСПОЛНЯТЬСЯ, а не выглядеть исполнимым, и порядок в нём содержателен.
    //
    // Срочное здесь одно: закрепить коммит ref'ом, чтобы его не срезал gc. Эта команда
    // работает в любом состоянии — дерево может быть грязным, ветка фазы занята соседним
    // worktree, ff невозможен: запись ref'а не трогает ни рабочее дерево, ни HEAD. Поэтому
    // она стоит ПЕРВОЙ.
    //
    // Слияние в ветку фазы — вторым и с оговоркой: `git switch` отказывает, если сессия
    // оставила незакоммиченные правки поверх (проверено живым git: `Your local changes …
    // would be overwritten`, код 1), а это ровно то состояние, в котором сессия чаще всего
    // и срывается. Вести совет с команды, которая падает первой, значит писать совет для
    // случая, которого может не быть.
    //
    // Закрепляем через `update-ref` в собственном пространстве `refs/ralph/`, а не веткой,
    // и это третья формулировка подряд — предыдущие две отказывали на практике:
    // `git branch <ветка> <sha>` всегда (ветку раннер занял до сессии), `<ветка>-rescue`
    // на втором инциденте (`already exists`). `update-ref` снимает весь класс сразу:
    //
    //   - **идемпотентна.** Перезаписывает, а не отказывает; повтор пишет то же значение,
    //     потому что имя ref'а и есть sha. Рассуждать «а вдруг ref занят чужим объектом»
    //     больше не нужно;
    //   - **длина фиксирована.** Имя не зависит от имени ветки фазы, а `safeBranch` длину
    //     не ограничивает: `<длинная-ветка>-rescue-<sha>` мог упереться в предел имени
    //     файла и не создать lock — то есть отказать ровно в критический момент;
    //   - **не засоряет ветки.** `refs/ralph/` уже используется ядром (`consumer-tree.ts`)
    //     ровно с этим смыслом: ref, на который человеческое не претендует.
    // Имя ПЛОСКОЕ (`rescue-<sha>`), а не вложенное (`rescue/<sha>`), и это не про вкус:
    // вложенному нужен каталог `refs/ralph/rescue`, и если ref с таким именем существует
    // файлом, git отказывает на локе — `'refs/ralph/rescue' exists; cannot create …`,
    // код 128 (проверено живым git, ревью 8-го прохода). Отказать здесь означает не
    // закрепить коммит ровно тогда, когда он под gc.
    //
    // Полной неуязвимости к D/F тут не бывает и не может быть: ref'ы git — это дерево
    // каталогов, и любое имя ломается ref'ом, созданным ПОД ним. Ревью 9-го прохода
    // показало такой случай и для плоского имени (`rescue-<sha>/occupied`), и он отвергнут
    // осознанно: закрытый случай — правдоподобный (`refs/ralph/rescue` кто-то мог завести
    // как обычное имя), а этот требует ref'а под путём, названным полным sha ПОТЕРЯННОГО
    // коммита, — состояния, которое не возникает. Гнаться дальше нечем: следующая форма
    // имени имела бы ровно тот же изъян. Цена ошибки при этом ограничена: git отказывает
    // громко и с причиной, а сам sha назван в том же сообщении — работа не теряется молча.
    const rescueRef = `refs/ralph/rescue-${sha}`;
    return {
        ok: false,
        sha,
        message:
            `⛔ Сессия оставила дерево работы ${where}, а не на ветке фазы ${branch}. ` +
            `Работа достижима только по SHA ${sha}. Сначала закрепи её — команда идёт ` +
            `в любом состоянии дерева и повторяется без вреда: ` +
            `git update-ref ${rescueRef} ${sha}. ` +
            `Потом влей, когда дерево чистое: git switch ${branch} && git merge ${sha}. ` +
            `После слияния ref не нужен: git update-ref -d ${rescueRef}`,
    };
}

// Устаревший прогон гейта CI не доезжает до конца (#224).
//
// ЗАЧЕМ. Триггер `pull_request` заводит полный гейт на каждый пуш в ветку PR, а гейт мерджа
// раннера читает только прогон текущей головы. 28.10 сессия правок запушила около 14
// коммитов подряд, и каждый прогон доехал до конца — по 6–8 минут квоты CI на прогон, вердикт
// которого не прочтёт никто. Пушит теперь раннер, один раз на круг правок, но прогон,
// заведённый до следующего пуша, всё равно доезжает: CI не знает, что его коммит устарел.
//
// ПОЧЕМУ НЕ ОТМЕНА. Отмены прошлого прогона того же PR (аналога `concurrency:
// cancel-in-progress`) у CI площадки нет: у `pull_request` в справочнике только `workflows`
// и `filter`, а `skip_on_pull_request` у `push` уже идущих прогонов не трогает. Поэтому
// первый куб сам спрашивает у площадки голову PR и, если она ушла вперёд, говорит
// следующим кубам «не гоняй».
//
// ПОЧЕМУ «ВПЕРЁД», А НЕ «ДРУГАЯ». Пропуск гейта — единственный опасный исход этого скрипта:
// зелёный прогон без проверок. Поэтому устаревшим считается только прогон, чей коммит —
// строгий ПРЕДОК текущей головы PR. Площадка могла бы гонять PR на своём merge-коммите, и
// тогда коммит прогона не совпал бы с головой НИКОГДА — сравнение на неравенство пропускало
// бы гейт у каждого прогона. Любая неясность — не прогон PR, нет токена, голова не
// прочиталась, git не ответил — полный гейт со строкой причины. Скрипт выходит нулём, кроме
// одного случая: упади он, красным стал бы и прогон текущей головы, у которого с кодом всё в
// порядке. Исключение — `RALPH_STALE_RUN`, пришедший мимо куба, когда решение не записалось
// (см. `runStaleCheck`): перезаписать его нечем, и следующие кубы пропустили бы гейт.
//
// ПРЕДЕЛ: ЗЕЛЁНЫЙ БЕЗ ПРОВЕРОК. Устаревший прогон кончается зелёным, а раннер выбирает
// вердикт площадки по времени (`isStale` в `core/forge-checks.ts`: дата прогона против
// времени коммита головы с допуском 2 мин), а не по sha: в ответе merge-checks sha прогона нет.
// Щель: коммит B сделан меньше чем через 2 мин после пуша A, пуш B случился раньше, чем прогон
// A дошёл до этого куба, и площадка отдаёт A последним. Тогда пустой зелёный A проходит для B
// свежим. Мердж непроверенного кода он не даёт: локальный гейт раннера гонял чеки на самой
// голове B. Теряется только проверка средой площадки (OOM, разница окружений) в этой щели, а
// до #224 в ней же засчитывался честный прогон предыдущего коммита. Закрыть щель можно, только
// если прогон назовёт свою голову: красный устаревший прогон с меткой головы, которую раннер
// умеет ждать. Это новый контракт ядра с CI, и в этот скрипт он не входит.
//
// Решение куб передаёт следующим через `SOURCECRAFT_ENV` (переменная `RALPH_STALE_RUN` —
// голова, ради которой гейт пропущен; при полном гейте — пустая). Не передалось — следующие
// кубы идут полностью; значение не в форме sha кубы тоже считают «полный гейт» (ci.yaml).
//
// ГОЛОВА PR — через шов адаптера (`pullRequestHeadSha` в `sourcecraft-task-source.ts`), а не
// своим запросом: две копии одного чтения разъехались бы молча (его докблок, #49).
//
// ИМЕНА ПЕРЕМЕННЫХ. `SOURCECRAFT_EVENT`, `SOURCECRAFT_PR_SLUG`, `SOURCECRAFT_COMMIT_SHA` и
// `SOURCECRAFT_ENV` взяты из справочника предопределённых переменных CI площадки при
// написании (28.10) и живым прогоном ещё не сверены. Ошибка в имени сделала бы куб холостым
// (полный гейт у каждого прогона — безопасно, но бесполезно), поэтому пропавшая переменная
// называется строкой `⚠ Переменные площадки не пришли` в логе куба: первый же прогон PR
// покажет её, если имя не то.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSourcecraftApi, parseRemote } from './adapters/sourcecraft-api.ts';
import { createSourcecraftTaskSource } from './adapters/sourcecraft-task-source.ts';

/** События, у которых прогон принадлежит PR: перезапуск проверок PR — тоже его прогон. */
const PR_EVENTS = new Set(['pull_request', 'restart']);
const SHA_RE = /^[0-9a-f]{40}$/;
// Номер PR вклеивается в путь запроса — только цифры, иначе это уже не номер.
const SLUG_RE = /^\d+$/;
// Переменные площадки, из которых куб узнаёт прогон (см. докблок: «ИМЕНА ПЕРЕМЕННЫХ»).
export const STALE_ENV = {
    event: 'SOURCECRAFT_EVENT',
    prSlug: 'SOURCECRAFT_PR_SLUG',
    runSha: 'SOURCECRAFT_COMMIT_SHA',
    target: 'SOURCECRAFT_ENV',
} as const;
// Решение куба для следующих: голова, ради которой гейт пропущен, или пусто (ci.yaml).
const STALE_DECISION_ENV = 'RALPH_STALE_RUN';
// Срок одного вызова git: повисший fetch держал бы куб до общего таймаута прогона — ровно ту
// квоту, ради экономии которой скрипт написан. Отказ по сроку — «не знаю», то есть полный гейт.
const GIT_TIMEOUT_MS = 120_000;

export type StaleRunInput = {
    event: string;
    prSlug: string;
    runSha: string;
    /** Голова ветки PR у площадки по номеру; бросает, если не прочиталась. */
    readHead: (pr: number) => string;
    /** Коммит `ancestor` — предок `head`: да, нет или `null` — git не ответил. */
    isAncestor: (ancestor: string, head: string) => boolean | null;
};

export type StaleRunVerdict = {
    stale: boolean;
    head: string | null;
    line: string;
    /** Куб обязан выйти не нулём: следующие кубы пропустили бы гейт мимо этого решения. */
    fail?: true;
};

const short = (sha: string): string => sha.slice(0, 8);
const fullGate = (why: string): StaleRunVerdict => ({
    stale: false,
    head: null,
    line: `▶ Полный гейт: ${why}.`,
});

/** Устарел ли прогон: только коммит-предок текущей головы PR, всё прочее — полный гейт. */
export function decideStaleRun(input: StaleRunInput): StaleRunVerdict {
    if (!PR_EVENTS.has(input.event) || !input.prSlug) {
        return fullGate(`прогон не принадлежит PR (событие «${input.event || 'нет'}»)`);
    }
    if (!SLUG_RE.test(input.prSlug)) {
        return fullGate(`номер PR «${input.prSlug}» не число — в запрос его не вклеиваю`);
    }
    const run = input.runSha.trim().toLowerCase();
    if (!SHA_RE.test(run)) return fullGate('коммит прогона не задан');
    let head: string;
    try {
        head = input.readHead(Number(input.prSlug)).trim().toLowerCase();
    } catch (e) {
        return fullGate(`голову PR !${input.prSlug} прочитать не удалось — ${String(e)}`);
    }
    if (!SHA_RE.test(head)) return fullGate(`площадка не отдала голову PR !${input.prSlug}`);
    if (head === run) return fullGate(`прогон текущей головы ${short(head)}`);
    const ancestor = input.isAncestor(run, head);
    if (ancestor === null) {
        return fullGate(`не установлено, предок ли ${short(run)} головы ${short(head)}`);
    }
    if (!ancestor) {
        return fullGate(
            `коммит прогона ${short(run)} не предок головы ${short(head)} — ` +
                'ветку переписали или площадка гоняет свой merge-коммит',
        );
    }
    return {
        stale: true,
        head,
        line: `⏭ Прогон устарел, HEAD уже ${short(head)} (коммит прогона ${short(run)}) — гейт не гоняю.`,
    };
}

export type StaleCheckDeps = {
    env: Record<string, string | undefined>;
    /** git с аргументами; отказ — исключение с `status` (null — сигнал или срок). */
    git: (args: string[]) => string;
    /** Голова PR через шов адаптера площадки (`pullRequestHeadSha`). */
    headOf: (remote: { org: string; repo: string }, pr: number) => string;
    append: (file: string, text: string) => void;
    log: (line: string) => void;
};

const firstLine = (e: unknown): string =>
    String((e as { stderr?: unknown }).stderr || (e as Error).message || e)
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim() ?? String(e);

/**
 * Проводка куба: переменные площадки → решение → строка в лог и `RALPH_STALE_RUN` следующим
 * кубам. Решение пишется ВСЕГДА, при полном гейте — пустым: переменная с тем же именем,
 * пришедшая мимо этого куба (CI репозитория, окружение образа), иначе пропускала бы гейт.
 */
export function runStaleCheck(deps: StaleCheckDeps): StaleRunVerdict {
    const { env, git, log } = deps;
    // Имена переменных живым прогоном не сверены (докблок): пропавшая называется вслух, иначе
    // ошибка в имени молча сделала бы куб холостым — «не прогон PR» у каждого прогона.
    const missing = [STALE_ENV.event, STALE_ENV.prSlug, STALE_ENV.runSha].filter(
        (name) => env[name] === undefined,
    );
    if (missing.length > 0) {
        log(
            `⚠ Переменные площадки не пришли: ${missing.join(', ')} — сверь имена со справочником.`,
        );
    }
    const prSlug = env[STALE_ENV.prSlug] ?? '';
    let verdict: StaleRunVerdict;
    try {
        verdict = decideStaleRun({
            event: env[STALE_ENV.event] ?? '',
            prSlug,
            runSha: env[STALE_ENV.runSha] ?? '',
            readHead: (pr) => {
                const remote = parseRemote(git(['remote', 'get-url', 'origin']));
                if (!remote) throw new Error('не разобрал origin');
                return deps.headOf(remote, pr);
            },
            isAncestor: (ancestor, head) => {
                // Тянем ровно голову PR, а не все ветки origin: в мелком клоне fetch всех
                // веток докачивал бы чужую историю. Отказ fetch — отдельной строкой, а не
                // «не предок»: у `git fetch` тоже бывает код 1, и причина соврала бы. Объект
                // головы мог уже лежать в клоне — merge-base спрашивается и после отказа.
                try {
                    git(['fetch', '--quiet', '--no-tags', 'origin', head]);
                } catch (e) {
                    log(`⚠ git fetch головы ${short(head)} не удался — ${firstLine(e)}.`);
                }
                try {
                    git(['merge-base', '--is-ancestor', ancestor, head]);
                    return true;
                } catch (e) {
                    // Код 1 — «не предок»; любой другой отказ (нет объекта, срок) — «не знаю».
                    return (e as { status?: unknown }).status === 1 ? false : null;
                }
            },
        });
    } catch (e) {
        verdict = fullGate(`проверка устаревания упала — ${String(e)}`);
    }
    const target = env[STALE_ENV.target];
    let written = false;
    if (!target) {
        if (verdict.stale) {
            verdict = fullGate(
                `${STALE_ENV.target} не задан — решение не передать следующим кубам`,
            );
        }
    } else {
        try {
            deps.append(
                target,
                `${STALE_DECISION_ENV}=${verdict.stale && verdict.head ? verdict.head : ''}\n`,
            );
            written = true;
        } catch (e) {
            verdict = fullGate(`решение не записалось в ${STALE_ENV.target} — ${firstLine(e)}`);
        }
    }
    // Решение не записалось, а переменная с тем же именем уже есть (CI репозитория, окружение
    // образа): перезаписать её нечем, и кубы ниже поверили бы ей. Полный гейт здесь не
    // гарантирован, поэтому куб краснеет с причиной — это единственный не нулевой выход.
    if (!written && (env[STALE_DECISION_ENV] ?? '') !== '') {
        verdict = {
            ...fullGate('решение не передано следующим кубам'),
            line:
                `⛔ ${STALE_DECISION_ENV} пришёл мимо stale-check, а решение не записалось — ` +
                'кубы ниже пропустили бы гейт по чужому значению. Убери переменную из CI или ' +
                `окружения образа либо почини ${STALE_ENV.target}.`,
            fail: true,
        };
    }
    log(verdict.line);
    return verdict;
}

function main(): void {
    const verdict = runStaleCheck({
        env: process.env,
        git: (args) =>
            execFileSync('git', args, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: GIT_TIMEOUT_MS,
                // Без кредов git ждал бы логина на терминале — до общего таймаута прогона.
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            }),
        headOf: (remote, pr) =>
            createSourcecraftTaskSource({
                api: createSourcecraftApi({ org: remote.org, repo: remote.repo }),
                org: remote.org,
                repo: remote.repo,
                authorAllowlist: () => [],
            }).pullRequestHeadSha(pr),
        append: (file, text) => appendFileSync(file, text),
        log: (line) => console.log(line),
    });
    if (verdict.fail) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('ci-stale-run.mts')) {
    main();
}

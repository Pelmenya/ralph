// Закрытие карточек по намерению смердженного PR.
//
// ЗАЧЕМ. Площадка связывает PR с карточкой (`linked_issues`), но связь не закрывает её
// ничем: смердженный PR оставляет задачу открытой навсегда, и трекер показывает сделанное
// как незакрытое. Разбирать это руками — работа, о которой вспоминают через неделю, когда
// уже не помнят, что чем закрыто.
//
// ПОЧЕМУ НЕ ПО СВЯЗИ. Связь бывает ЛОЖНОЙ: площадка матчит номер в ЛЮБОМ тексте PR,
// включая сообщения коммитов, и номер чужого трекера приезжает как свой (см. барьер
// `FOREIGN_TRACKER_RE` у потребителя). Закрывать по связи значит закрывать случайные
// карточки — необратимо и молча. Закрываем только по ЯВНОМУ намерению автора: строка
// «Закрывает #N» в описании PR.
//
// ПОЧЕМУ ПОСТРОЧНО И С НАЧАЛА СТРОКИ. Номер, упомянутый как контекст («затронуто и #17»),
// намерением не является; «но не закрывает его» — тем более, а по вхождению слова оно
// читалось бы как команда. Поэтому намерение — это строка, КОТОРАЯ НАЧИНАЕТСЯ со слова
// «Закрывает» (маркеры списка и жирный шрифт перед ним допускаются). Граница узкая, но
// писать «Закрывает #10 и #12» она не мешает.
import { execFileSync } from 'node:child_process';
import { createSourcecraftApi } from './adapters/sourcecraft-api.ts';
import { createSourcecraftTaskSource } from './adapters/sourcecraft-task-source.ts';

/** Больше этого за один мердж не закрываем: описание не должно уметь смести бэклог. */
export const MAX_CLOSES_PER_MERGE = 10;

/**
 * РЕШЁННЫЕ статусы площадки — только эти означают «карточку трогать не надо». Остальные
 * четыре (`open`, `inProgress`, `paused` и незаданный) — открытая работа.
 */
const RESOLVED_STATUSES = new Set(['closed', 'declined', 'duplicate']);

/**
 * Машинный след автозакрытия в тексте комментария.
 *
 * Нужен потому, что порядок «сначала причина, потом закрытие» имеет цену: если комментарий
 * лёг, а закрытие упало, повтор прогона оставит второй такой же. Это не гипотеза ревью —
 * поймано живьём на первом же боевом прогоне: комментарий на карточке появился, а PATCH
 * статуса вернул 403, и карточка осталась открытой с висящей причиной.
 *
 * Маркер невидим в отрендеренном markdown, поэтому человек его не воспроизведёт случайно,
 * а повторный прогон узнаёт свой след и причину не дублирует.
 */
const AUTO_CLOSE_MARKER = '<!-- ralph:auto-closed -->';

// Начало строки: маркеры списка, цитаты и жирный шрифт пропускаем, слово — первое.
// `\b` тут не годится: он ASCII-only, и после кириллического «закрывает» границы
// слова не видит вовсе. Отсекаем продолжение слова явным взглядом вперёд.
// Начало строки: маркеры списка (`-`, `+`, `*`, `1.`), чекбоксы и цитаты пропускаем —
// намерение в чеклисте это то же намерение (ревью).
const CLOSE_LINE_RE =
    /^[\s>*_+-]*(?:\[[ xX]\]\s*)?(?:\d+[.)]\s*)?(?:закрывает|закрывают|closes|fixes)(?!\p{L})/iu;

/**
 * Номера идут СРАЗУ за словом намерения и разделяются только запятой либо «и»/«and».
 *
 * Первая версия брала все `#N` из строки, и это возвращало ровно тот класс ложных связей,
 * от которого механизм защищает: `Закрывает external/team#17; #18 затронута` закрывало и
 * чужой номер (он ведь тоже `#17`), и соседний, названный контекстом. Теперь разбор
 * останавливается на первом не-номере, а форма `owner/repo#N` не совпадает вовсе —
 * список начинается с решётки.
 *
 * Цена — строгость формы: «Закрывает задачу #17» не считается намерением. Это осознанно:
 * механизм с правом закрывать чужие карточки не должен догадываться, что имел в виду
 * автор, а «ничего не закрыл» видно в логе.
 */
const REFS_RUN_RE = /^[\s:—–-]*(#\d+(?:\s*(?:,|и|and)?\s*#\d+)*)/iu;
const ISSUE_RE = /#(\d+)/g;

/**
 * Номер PR из ЗАГОЛОВКА squash-коммита: площадка дописывает туда `(!N)`.
 * Тело не смотрим намеренно — «см. соседний PR (!7)» там обычное дело.
 */
export function prNumberFromCommit(message: string): number | null {
    const subject = (message.split('\n')[0] ?? '').trim();
    // Squash-коммит: площадка дописывает `(!N)` в хвост заголовка.
    const squashed = /\(!(\d+)\)\s*$/.exec(subject);
    if (squashed) return Number(squashed[1]);
    // Merge-коммит: политика веток squash не требует, и такой мердж молча не закрывал
    // ничего (ревью). Форма фиксированная — «Merge pull request !N».
    const merged = /^merge pull request !(\d+)\b/i.exec(subject);
    return merged ? Number(merged[1]) : null;
}

/** Номера карточек, которые автор PR назвал закрываемыми. Порядок — как в тексте. */
export function closesFromDescription(description: string): number[] {
    const found: number[] = [];
    for (const line of description.split('\n')) {
        const intent = CLOSE_LINE_RE.exec(line);
        if (!intent) continue;
        const run = REFS_RUN_RE.exec(line.slice(intent[0].length));
        if (!run) continue;
        for (const m of run[1].matchAll(ISSUE_RE)) {
            const n = Number(m[1]);
            if (!found.includes(n)) found.push(n);
        }
    }
    return found;
}

export type CloseDeps = {
    commitMessage: string;
    prDescription: (pr: number) => string;
    issueStatus: (issue: number) => string;
    /** Тела уже оставленных комментариев карточки — по ним узнаём свой прошлый след. */
    issueComments: (issue: number) => string[];
    commentFn: (issue: number, body: string) => void;
    closeFn: (issue: number) => void;
    logFn: (msg: string) => void;
};

/**
 * Возвращает закрытые номера. Бросает, если хоть одна карточка не закрылась: молча
 * пропущенный отказ вернул бы ровно ту проблему, ради которой всё это заведено.
 */
export function closeMergedIssues(deps: CloseDeps): number[] {
    const { commitMessage, prDescription, issueStatus, issueComments, commentFn, closeFn, logFn } =
        deps;
    const pr = prNumberFromCommit(commitMessage);
    if (pr === null) {
        logFn('Коммит не выглядит мерджем PR — закрывать нечего.');
        return [];
    }
    const wanted = closesFromDescription(prDescription(pr));
    if (wanted.length === 0) {
        logFn(`PR !${String(pr)}: намерения «Закрывает #N» в описании нет — ничего не закрываю.`);
        return [];
    }
    if (wanted.length > MAX_CLOSES_PER_MERGE) {
        throw new Error(
            `PR !${String(pr)} называет ${String(wanted.length)} карточек — это больше предела ` +
                `(${String(MAX_CLOSES_PER_MERGE)}) за один мердж. Разбери руками: массовое ` +
                'закрытие по одному описанию слишком похоже на опечатку, чтобы делать его автоматом.',
        );
    }
    const closed: number[] = [];
    const failed: string[] = [];
    for (const issue of wanted) {
        try {
            // Статус спрашиваем ДО мутации: повторный прогон (перезапуск CI, ручной
            // вызов) не должен выглядеть как новое событие в ленте карточки.
            //
            // Пропускаем только РЕШЁННЫЕ состояния. Первая версия сравнивала с `open` и
            // тем самым молча не закрывала карточку в работе: у площадки статусов шесть,
            // и `inProgress`/`paused` — это открытая работа, а не закрытая (ревью).
            if (RESOLVED_STATUSES.has(issueStatus(issue))) {
                logFn(`#${String(issue)}: уже решена — пропускаю.`);
                continue;
            }
            // Сначала причина, потом закрытие: закрытие без следа неотличимо от потери.
            // Порядок сохранён, а его цена — дубль причины при повторе — снята маркером:
            // свой прошлый след узнаём и второй раз не пишем. Отказ ЧТЕНИЯ комментариев
            // не мешает закрытию: причина уже стоит либо появится, дубль дешевле пропуска.
            let alreadyExplained = false;
            try {
                alreadyExplained = issueComments(issue).some((body) =>
                    body.includes(AUTO_CLOSE_MARKER),
                );
            } catch (e) {
                logFn(
                    `#${String(issue)}: не смог прочитать комментарии (${(e as Error).message.split('\n')[0]}) — ` +
                        'пишу причину заново.',
                );
            }
            if (alreadyExplained) {
                logFn(`#${String(issue)}: причина уже оставлена прошлым прогоном — не дублирую.`);
            } else {
                commentFn(
                    issue,
                    `Закрыта автоматически: PR !${String(pr)} смерджен в main и назвал эту карточку ` +
                        'в описании («Закрывает»). Связь PR↔задача на площадке карточку не закрывает, ' +
                        `поэтому это делает CI.\n\n${AUTO_CLOSE_MARKER}`,
                );
            }
            closeFn(issue);
            closed.push(issue);
            logFn(`#${String(issue)}: закрыта по намерению PR !${String(pr)}.`);
        } catch (e) {
            failed.push(`#${String(issue)}: ${(e as Error).message.split('\n')[0]}`);
        }
    }
    if (failed.length > 0) {
        throw new Error(`Не удалось закрыть: ${failed.join('; ')}`);
    }
    return closed;
}

/** Координаты репозитория из origin — чтобы имя площадки и репо не жили в коде. */
export function parseRemote(url: string): { org: string; repo: string } | null {
    const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\s*$/.exec(url.trim());
    return m ? { org: m[1], repo: m[2] } : null;
}

function main(): void {
    const sh = (file: string, args: string[]): string =>
        execFileSync(file, args, { encoding: 'utf8' });
    const log = (msg: string): void => {
        console.log(`🗂 автозакрытие: ${msg}`);
    };

    // Второй эшелон для ЛОКАЛЬНОГО и ручного запуска. Выключателем это НЕ является, и
    // прежняя формулировка врала: в CI площадка резолвит `${{ secrets.… }}` на разборе
    // конфига и, не найдя секрета, валит ВЕСЬ прогон — вместе с гейтом — ещё до старта
    // задачи. Проверено живьём: три красных прогона на пуш в main с текстом
    // «value 'SOURCECRAFT_TOKEN' not defined for value source 'secrets'».
    // Значит секрет — предусловие механизма, а не опция; заводится ДО включения workflow.
    if (!process.env['SOURCECRAFT_TOKEN']) {
        log('SOURCECRAFT_TOKEN не задан — закрывать нечем, выхожу (запуск вне CI?).');
        return;
    }
    const remote = parseRemote(sh('git', ['remote', 'get-url', 'origin']));
    if (!remote) {
        log('не разобрал origin — координаты репозитория неизвестны, выхожу.');
        return;
    }
    const api = createSourcecraftApi({ org: remote.org, repo: remote.repo });
    const source = createSourcecraftTaskSource({
        api,
        org: remote.org,
        repo: remote.repo,
        authorAllowlist: () => [],
    });
    const base = `/repos/${remote.org}/${remote.repo}`;
    const closed = closeMergedIssues({
        commitMessage: sh('git', ['log', '-1', '--pretty=%B']),
        prDescription: (pr) => {
            const res = api('GET', `${base}/pulls/${String(pr)}`) as Record<string, unknown> | null;
            return String(res?.['description'] ?? '');
        },
        issueComments: (issue) => {
            const res = api('GET', `${base}/issues/${String(issue)}/comments`) as Record<
                string,
                unknown
            > | null;
            const list = res?.['issue_comments'];
            return Array.isArray(list)
                ? list.map((c) => String((c as { body?: unknown }).body ?? ''))
                : [];
        },
        issueStatus: (issue) => {
            const res = api('GET', `${base}/issues/${String(issue)}`) as Record<
                string,
                unknown
            > | null;
            const status = res?.['status'] as { slug?: unknown } | undefined;
            return String(status?.slug ?? '');
        },
        commentFn: (issue, body) => {
            source.commentOnIssue(issue, body);
        },
        closeFn: (issue) => {
            source.closeIssue(issue);
        },
        logFn: log,
    });
    log(closed.length > 0 ? `готово: ${closed.map((n) => `#${String(n)}`).join(', ')}` : 'готово.');
}

if (process.argv[1] && process.argv[1].endsWith('close-merged-issues.mts')) {
    main();
}

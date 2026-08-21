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

// Начало строки: маркеры списка, цитаты и жирный шрифт пропускаем, слово — первое.
// `\b` тут не годится: он ASCII-only, и после кириллического «закрывает» границы
// слова не видит вовсе. Отсекаем продолжение слова явным взглядом вперёд.
const CLOSE_LINE_RE = /^[\s>*_-]*(?:закрывает|закрывают|closes|fixes)(?!\p{L})/iu;
const ISSUE_RE = /#(\d+)/g;

/**
 * Номер PR из ЗАГОЛОВКА squash-коммита: площадка дописывает туда `(!N)`.
 * Тело не смотрим намеренно — «см. соседний PR (!7)» там обычное дело.
 */
export function prNumberFromCommit(message: string): number | null {
    const subject = message.split('\n')[0] ?? '';
    const m = /\(!(\d+)\)\s*$/.exec(subject.trim());
    return m ? Number(m[1]) : null;
}

/** Номера карточек, которые автор PR назвал закрываемыми. Порядок — как в тексте. */
export function closesFromDescription(description: string): number[] {
    const found: number[] = [];
    for (const line of description.split('\n')) {
        if (!CLOSE_LINE_RE.test(line)) continue;
        for (const m of line.matchAll(ISSUE_RE)) {
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
    commentFn: (issue: number, body: string) => void;
    closeFn: (issue: number) => void;
    logFn: (msg: string) => void;
};

/**
 * Возвращает закрытые номера. Бросает, если хоть одна карточка не закрылась: молча
 * пропущенный отказ вернул бы ровно ту проблему, ради которой всё это заведено.
 */
export function closeMergedIssues(deps: CloseDeps): number[] {
    const { commitMessage, prDescription, issueStatus, commentFn, closeFn, logFn } = deps;
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
            // Статус спрашиваем ДО мутации: повторный прогон (переzапуск CI, ручной вызов)
            // не должен выглядеть как новое событие в ленте карточки.
            if (issueStatus(issue) !== 'open') {
                logFn(`#${String(issue)}: уже не открыта — пропускаю.`);
                continue;
            }
            // Сначала причина, потом закрытие: закрытие без следа неотличимо от потери.
            commentFn(
                issue,
                `Закрыта автоматически: PR !${String(pr)} смерджен в main и назвал эту карточку ` +
                    'в описании («Закрывает»). Связь PR↔задача на площадке карточку не закрывает, ' +
                    'поэтому это делает CI.',
            );
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

    // Выключатель: без токена автоматики просто нет. Красить main на каждом пуше из-за
    // незаведённого секрета нельзя — это барьер, который чинят выключением барьера.
    if (!process.env['SOURCECRAFT_TOKEN']) {
        log('секрет SOURCECRAFT_TOKEN не задан — автозакрытие выключено.');
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

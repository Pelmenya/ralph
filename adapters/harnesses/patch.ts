/**
 * Общий разбор текста патча `*** Begin Patch` в файловые операции (Фаза 16d, #189).
 *
 * Codex (`apply_patch`) и OpenCode (`apply_patch{patchText}`) несут пути правки не полем
 * входа, а заголовками внутри текста. Совместимый вход guard судил такой вызов по имени
 * инструмента, которого не знал, и пропускал (стенд #188, `cm-patch`): запись данных контура
 * патчем проходила. Здесь патч разбирается в `write`/`delete`/`move`, и guard судит каждую
 * операцию — первая запрещённая запрещает весь вызов, так что патч на три файла с одним
 * защищённым не применяет и двух разрешённых.
 *
 * Грамматика — парсера Codex 0.163.0 (`codex-rs/apply-patch`): весь текст `trim()`, строки по
 * `\n` с отрезанным `\r`, границы `*** Begin Patch` / `*** End Patch` сравниваются по обрезанной
 * строке, обёртка heredoc (`<<'EOF'` … `EOF`) снимается, заголовок файла — обрезанная строка с
 * префиксом вместе с пробелом после двоеточия, `*** Move to: ` — только строка сразу за
 * `Update File` и без обрезки. Add — строки `+`; Update — строки ` `, `+`, `-`, `@@`, пустые и
 * `*** End of File`.
 *
 * Fail-closed на всём, что разные CLI прочли бы по-разному: разбор, где путь CLI и путь барьера
 * могут разойтись, — бросок, и нормализатор превращает его в `unknown`. Поэтому отказ, а не
 * догадка:
 *   - заголовок без пробела после двоеточия (`*** Add File:\t.env`): Codex его не примет, а
 *     OpenCode 1.19.4 режет путь `trim()` и примет — барьер не выбирает, чей разбор верен;
 *   - путь с пробелом у края: OpenCode режет его, Codex — нет, и `.env` у одного — ` .env` у другого;
 *   - строка контекста ` *** …`: Codex читает её контекстом, разбор по обрезанной строке —
 *     заголовком, и путь, который один CLI пишет, другой бы не назвал.
 * Цена названа: такие патчи — ложный блок с причиной, а не запись мимо барьера.
 *
 * Патч внутри команды оболочки (`apply_patch <<'EOF'` — Codex перехватывает такой вызов и
 * применяет патч сам) разбирает `patchesInCommand`: пути — и от каталога вызова, и от каждого
 * `cd` перед патчем, потому что форму `cd dir && apply_patch` CLI исполняет из `dir`. Вызов без
 * литерального тела (`cat p | apply_patch`) — отказ: путей в тексте команды нет.
 */
import path from 'node:path';
import type { ToolOperation } from './protocol.ts';

type FileOperation =
    | { op: 'write' | 'delete'; path: string; baseDir: string }
    | Extract<ToolOperation, { op: 'move' }>;

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARK = '*** End of File';
const HEREDOC_OPEN = new Set(['<<EOF', "<<'EOF'", '<<"EOF"']);

/** Путь заголовка: непустой и без пробела у края, иначе отказ. */
function checkedPath(raw: string, at: string): string {
    if (raw === '') throw new Error(`патч: ${at}: пустой путь`);
    if (raw !== raw.trim()) {
        throw new Error(
            `патч: ${at}: пробел у края пути «${raw}» — CLI читают такой путь по-разному`,
        );
    }
    return raw;
}

/** Строки тела патча между границами, как их видит CLI. */
function bodyLines(text: string): string[] {
    let lines = text
        .trim()
        .split('\n')
        .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    if (lines.length >= 4 && HEREDOC_OPEN.has(lines[0].trim()) && lines.at(-1)?.endsWith('EOF')) {
        lines = lines.slice(1, -1);
    }
    if (lines[0]?.trim() !== BEGIN) throw new Error(`патч: первая строка не «${BEGIN}»`);
    if (lines.length < 2 || lines.at(-1)?.trim() !== END) {
        throw new Error(`патч: последняя строка не «${END}»`);
    }
    return lines.slice(1, -1);
}

/** Операции патча от каталога `baseDir`; разбор, которому нельзя верить, — бросок с причиной. */
export function patchOperations(text: string, baseDir: string): FileOperation[] {
    const body = bodyLines(text);
    const out: FileOperation[] = [];
    let i = 0;
    while (i < body.length) {
        const at = `строка ${i + 2}`;
        const header = body[i].trim();
        i += 1;
        if (header.startsWith(ADD)) {
            out.push({ op: 'write', path: checkedPath(header.slice(ADD.length), at), baseDir });
            while (i < body.length && body[i].startsWith('+')) i += 1;
        } else if (header.startsWith(DELETE)) {
            out.push({ op: 'delete', path: checkedPath(header.slice(DELETE.length), at), baseDir });
        } else if (header.startsWith(UPDATE)) {
            const source = checkedPath(header.slice(UPDATE.length), at);
            if (body[i]?.startsWith(MOVE)) {
                const destination = checkedPath(body[i].slice(MOVE.length), `строка ${i + 2}`);
                out.push({ op: 'move', path: source, destination, baseDir });
                i += 1;
            } else {
                out.push({ op: 'write', path: source, baseDir });
            }
            for (; i < body.length; i += 1) {
                const line = body[i];
                if (line.trim() === '' || line.trim() === EOF_MARK) continue;
                if (line.startsWith('***')) break;
                if (line.startsWith(' ') && line.trim().startsWith('***')) {
                    throw new Error(
                        `патч: строка ${i + 2}: «${line}» — контекст или заголовок, неоднозначно`,
                    );
                }
                if (!/^[ +-]|^@@/.test(line)) {
                    throw new Error(`патч: строка ${i + 2}: «${line}» — не строка правки`);
                }
            }
        } else {
            throw new Error(`патч: ${at}: «${header}» не заголовок файла (Add/Update/Delete File)`);
        }
    }
    if (out.length === 0) throw new Error('патч: ни одного файла');
    return out;
}

const APPLY_PATCH_RE = /(?:^|[^\w-])(?:apply_patch|applypatch)(?![\w-])/g;
const CD_RE = /(?:^|[;&|(]\s*)cd\s+(?:'([^']*)'|"([^"]*)"|([^\s;&|)]+))/g;

/** Сколько раз слово вызова встречается в тексте. */
const applyPatchWords = (text: string): number => [...text.matchAll(APPLY_PATCH_RE)].length;

/**
 * Файловые операции патча, переданного вызову `apply_patch` в команде оболочки; слова вызова
 * нет — пусто. Тело — от первого `*** Begin Patch` до последнего `*** End Patch`.
 *
 * Слово без литерального тела — отказ, а не «патча нет»: Codex кладёт в PATH сессии
 * `apply_patch` на свой бинарь, и тот читает патч из argv или stdin и пишет файлы сам.
 * `cat p | apply_patch`, `apply_patch "$(cat p)"`, `apply_patch < p` несут пути в файле, а не в
 * тексте команды, и guard увидел бы только `exec`. По той же причине отказ — слово вызова вне
 * единственного тела: тело, разобранное у одного вызова, ничего не говорит о файле другого. Вызов
 * перед нами или аргумент (`grep apply_patch`), по тексту оболочки не решить, и цена названа:
 * такая команда в сессии Codex — ложный блок с причиной.
 */
export function patchesInCommand(command: string, baseDir: string): FileOperation[] {
    if (applyPatchWords(command) === 0) return [];
    const begin = command.indexOf(BEGIN);
    if (begin === -1) {
        throw new Error('вызов apply_patch без литерального тела патча — пути не разобрать');
    }
    const end = command.lastIndexOf(END);
    if (end < begin) throw new Error(`вызов apply_patch: патч без «${END}»`);
    const before = command.slice(0, begin);
    if (applyPatchWords(before) !== 1 || applyPatchWords(command.slice(end + END.length)) !== 0) {
        throw new Error('вызов apply_patch: слово вызова вне единственного тела патча');
    }
    const text = command.slice(begin, end + END.length);
    const bases = [baseDir];
    for (const m of before.matchAll(CD_RE)) {
        bases.push(path.resolve(baseDir, m[1] ?? m[2] ?? m[3]));
    }
    return bases.flatMap((base) => patchOperations(text, base));
}

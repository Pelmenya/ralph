// Исполняемые слои конфига харнесса в дереве сессии и его предках (Фаза 16d, #195;
// `docs/harness-contract.md`, принцип 4).
//
// Зачем. Харнесс исполняет конфиг из дерева, которое правит агент, и уже при старте: хуки и
// MCP-сервер из `.codex/config.toml` доверенного проекта Codex поднимает раньше первого вызова
// (стенд #188, `h-projtoml`, `p-mcp`). Защита путей от записи тут не помогает — слой мог лежать
// в дереве до сессии. Где CLI не даёт выключить слой, preflight отвергает его наличие; где
// даёт (Codex — недоверием проекту), отказ — вторая линия: слой в дереве петли означает, что
// его туда кто-то положил, и следующая версия CLI могла бы его исполнить.
//
// Поверхности — `configSurfaces` описания пакета: пути от каталога (`.codex/config.toml`).
// Ищутся в каждом каталоге дерева (CLI читает слои от корня до cwd, а cwd сессии может уйти
// вглубь) и в каждом предке до корня ФС. Над корнем репозитория Codex 0.163 слоёв не читает
// (стенд, `S-anc`), и предки — защита от дрейфа, а не от доказанного канала. Цена названа:
// дом CLI человека тоже лежит в предке (`~/.codex`), поэтому дома, которые называет пакет,
// из отказа исключены.
//
// Fail-closed: каталог, который не прочитался, и дерево больше предела обхода — отказ с
// причиной, а не «слоёв нет». `.git` не обходится: это не дерево работы. Каталоги зависимостей
// и сборки (`node_modules`, `target`, `.venv`, `dist`, … — `SKIPPED_DIRS`) и вложенные
// репозитории (worktree, подмодуль — каталог со своим `.git`) тоже: слой там исполнился бы
// только при cwd внутри них, а сессия стартует в корне дерева. Без этого пропуска дерево Rust
// или Python легко перерастало предел и отменяло старт у потребителя без единого слоя.
//
// Цена названа. Скан идёт заново перед КАЖДОЙ сессией Codex (`prepareCodexSession`): readdir
// на каталог дерева и по `existsSync` на поверхность и на `.git` у каждого. Кэша нет нарочно —
// слой, положенный прошлой сессией, обязан остановить следующую. Симлинк на каталог обход не
// проходит (`listDirsFn` отдаёт только каталоги): слой за симлинком скан не увидит, это предел.
//
// TS-модуль без билд-шага (erasable-only): файловая система — параметром.

import fs from 'node:fs';
import path from 'node:path';

/** Предел обхода дерева: больше — отказ, а не проверка части. */
export const LAYER_SCAN_MAX_DIRS = 50_000;

/** Не обходятся: служебный каталог git, зависимости и вывод сборки распространённых стеков. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
    '.git',
    'node_modules',
    'target',
    '.venv',
    'venv',
    '__pycache__',
    '.tox',
    'dist',
    'build',
    '.next',
    '.gradle',
]);

export type TLayerFs = {
    /** Подкаталоги каталога (без симлинков: по ним обход не идёт). Бросает при отказе. */
    listDirsFn?: (dir: string) => string[];
    existsFn?: (p: string) => boolean;
    readFileFn?: (p: string) => string;
};

const defaultListDirs = (dir: string): string[] =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

/** Секции TOML верхнего уровня — то, что отказ называет: `mcp_servers`, `hooks`, … */
function tomlSections(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(/^\s*\[\[?\s*"?([A-Za-z0-9_-]+)/gm)) out.add(m[1]);
    return [...out];
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/**
 * Найденные слои — строка на каждый, с секциями TOML, если файл их несёт. Пустой список —
 * слоёв нет; поверхностей нет — проверять нечего, и это не отказ.
 */
export function configLayerProblems(
    {
        tree,
        surfaces,
        homes = [],
    }: { tree: string; surfaces: readonly string[]; homes?: readonly string[] },
    {
        listDirsFn = defaultListDirs,
        existsFn = (p) => fs.existsSync(p),
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
    }: TLayerFs = {},
): string[] {
    if (surfaces.length === 0) return [];
    const root = path.resolve(tree);
    const excluded = homes.map((h) => path.resolve(h));
    const out: string[] = [];
    // Очередь обхода в ширину она же — список каталогов дерева: индекс вместо `shift`.
    const dirs: string[] = [root];
    for (let i = 0; i < dirs.length; i += 1) {
        const dir = dirs[i];
        if (dirs.length > LAYER_SCAN_MAX_DIRS) {
            return [
                `${root}: больше ${LAYER_SCAN_MAX_DIRS} каталогов — обход не закончен, ` +
                    'исполняемые слои конфига не проверены',
            ];
        }
        let children: string[];
        try {
            children = listDirsFn(dir);
        } catch (error) {
            out.push(
                `${dir}: каталог не прочитан (${error instanceof Error ? error.message : String(error)}) — ` +
                    'исполняемые слои конфига в нём не проверены',
            );
            continue;
        }
        for (const name of children) {
            if (SKIPPED_DIRS.has(name)) continue;
            const child = path.join(dir, name);
            // Вложенный репозиторий: свои слои у него исполнились бы только при cwd внутри.
            if (!existsFn(path.join(child, '.git'))) dirs.push(child);
        }
    }
    for (let up = path.dirname(root); ; up = path.dirname(up)) {
        dirs.push(up);
        if (path.dirname(up) === up) break;
    }
    for (const dir of dirs) {
        for (const surface of surfaces) {
            const p = path.join(dir, surface);
            if (excluded.some((h) => inside(p, h)) || !existsFn(p)) continue;
            let sections: string[] = [];
            if (p.endsWith('.toml')) {
                try {
                    sections = tomlSections(readFileFn(p));
                } catch {
                    // Слой назван и без секций: отказ от этого не слабее.
                }
            }
            const where = inside(dir, root) ? 'в дереве сессии' : 'в предке дерева сессии';
            out.push(
                `${p}: исполняемый слой конфига харнесса ${where}` +
                    (sections.length > 0 ? ` (секции: ${sections.join(', ')})` : ''),
            );
        }
    }
    return out;
}

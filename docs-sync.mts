/**
 * Генератор `AGENTS.md` из `CLAUDE.md` — по одному на каждую папку с правилами.
 *
 * Одни правила приходится держать под двумя именами: Claude Code читает `CLAUDE.md`,
 * остальные площадки — `AGENTS.md`. Держать пару руками нельзя ни в одном из двух видов, и
 * оба уже пробовались: две полные копии расходятся молча (правку вносят в одну, половина
 * агентов продолжает работать по второй), а файл-заглушка «правила рядом, в соседнем
 * файле» экономит копию ценой того, что половина агентов правил не читает вовсе — переход
 * по ссылке модели не гарантирован.
 *
 * Отсюда третий вид: источник ОДИН (`CLAUDE.md`), второе имя — сгенерированная копия с
 * шапкой «не правь руками». Расхождение при этом невозможно не по договорённости, а
 * механически: копию восстанавливает `npm run docs:sync`, а сверяет `--check` в составе
 * сьюта (`tests/docs-coverage.test.ts`).
 *
 * Пути — от каталога модуля (`import.meta.dirname`), не от CWD: скрипт зовут и из корня, и
 * хуком, у которого CWD свой.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const CANON_ROOT = resolve(import.meta.dirname);

/**
 * Шапка сгенерированного файла. Комментарий, а не видимый абзац: в отрендеренной доке
 * служебная строка — шум, а агент читает файл сырым и увидит её первой строкой.
 */
export const GENERATED_BANNER = `<!--
  СГЕНЕРИРОВАНО из CLAUDE.md рядом с этим файлом — правь ЕГО, а не этот файл: правку здесь
  перезапишет \`npm run docs:sync\`. Два имени нужны потому, что разные агенты ищут разные:
  Claude Code — CLAUDE.md, остальные площадки — AGENTS.md.
-->`;

const CODE_EXT = /\.(js|ts|mjs|mts)$/;

/**
 * Fail-closed: git не ответил — бросаем, а не возвращаем пустой набор. Пустой набор
 * означал бы «синхронизировать нечего», и сверка стала бы зелёной, не прочитав ни файла.
 */
export function trackedFiles(root: string = CANON_ROOT): string[] {
    const ls = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf-8' });
    if (ls.status !== 0) {
        throw new Error(`git ls-files в ${root} не отработал: ${ls.stderr || ls.error}`);
    }
    return ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .sort();
}

/**
 * Папки, у которых обязана быть пара доков: корень и каждая папка первого уровня с кодом.
 * Глубже не спускаемся намеренно — правила формулируются на уровне зоны ответственности
 * (`core/`, `adapters/`, …), иначе собственных правил потребовал бы каждый `__fixtures__`.
 *
 * Набор СЧИТАЕТСЯ по дереву, а не перечисляется руками: перечисление сторожило бы только
 * уже существующие папки и промолчало бы про новую — то есть про единственный случай, ради
 * которого проверка и заведена. Отделённая от git часть (`docDirsFromFiles`) нужна, чтобы
 * это можно было проверить от противного, не заводя репозиторий во временном каталоге.
 */
export function docDirsFromFiles(files: string[]): string[] {
    const dirs = new Set<string>();
    for (const rel of files) {
        if (!CODE_EXT.test(rel) || !rel.includes('/')) continue;
        dirs.add(rel.split('/')[0]);
    }
    return ['.', ...[...dirs].sort()];
}

export function docDirs(root: string = CANON_ROOT): string[] {
    return docDirsFromFiles(trackedFiles(root));
}

/**
 * Единственное преобразование содержимого — цель относительной ссылки: внутри семьи
 * `AGENTS.md` ссылки обязаны вести на `AGENTS.md`, иначе агент, который пришёл за вторым
 * именем, первым же переходом попадает в файл, которого на его площадке «нет».
 *
 * Текст ссылки при этом НЕ трогаем — поэтому в доках его пишут без имени файла
 * («[в корне канона](../CLAUDE.md)»): подпись, названная именем, разъехалась бы с целью.
 * Прочие упоминания `CLAUDE.md` в прозе тоже остаются как есть — они про источник правды,
 * и в сгенерированном файле это ровно та правда, которую надо прочитать.
 */
export function renderAgents(claudeText: string): string {
    const body = claudeText.replace(
        /\]\(([^)\s]*)CLAUDE\.md((?:#[^)\s]*)?)\)/g,
        (whole, prefix: string, anchor: string) =>
            // Внешние ссылки (`https://…/CLAUDE.md`) и абсолютные пути — не наша семья.
            /^[a-z][a-z0-9+.-]*:/i.test(prefix) || prefix.startsWith('/')
                ? whole
                : `](${prefix}AGENTS.md${anchor})`,
    );
    return `${GENERATED_BANNER}\n\n${body}`;
}

export type DocPair = { dir: string; source: string; generated: string };

export function docPairs(root: string = CANON_ROOT): DocPair[] {
    return docDirs(root).map((dir) => ({
        dir,
        source: join(root, dir, 'CLAUDE.md'),
        generated: join(root, dir, 'AGENTS.md'),
    }));
}

/**
 * Что ДОЛЖНО лежать в `AGENTS.md` этой папки. Отсутствие источника — отказ, а не «нечего
 * генерировать»: папка с правилами под одним именем и без второго — это ровно та половинная
 * раскладка, ради которой всё и заведено.
 */
export function expectedAgents(pair: DocPair): string {
    if (!existsSync(pair.source)) {
        throw new Error(
            `нет ${pair.dir}/CLAUDE.md — генерировать ${pair.dir}/AGENTS.md не из чего`,
        );
    }
    return renderAgents(readFileSync(pair.source, 'utf-8'));
}

export function isStale(pair: DocPair): boolean {
    const expected = expectedAgents(pair);
    return !existsSync(pair.generated) || readFileSync(pair.generated, 'utf-8') !== expected;
}

/** Возвращает папки, у которых копия разъехалась с источником; при `write` — чинит их. */
export function syncDocs(options: { root?: string; write: boolean }): string[] {
    const root = options.root ?? CANON_ROOT;
    const stale: string[] = [];
    for (const pair of docPairs(root)) {
        if (!isStale(pair)) continue;
        stale.push(pair.dir);
        if (options.write) writeFileSync(pair.generated, expectedAgents(pair));
    }
    return stale;
}

// Запуск как скрипта: `node docs-sync.mts` чинит, `--check` только сверяет.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const check = process.argv.includes('--check');
    let stale: string[];
    try {
        stale = syncDocs({ write: !check });
    } catch (e) {
        process.stderr.write(`✖ docs-sync: ${(e as Error).message}\n`);
        process.exit(1);
    }
    if (stale.length === 0) {
        process.stdout.write('✅ AGENTS.md совпадает с CLAUDE.md во всех папках\n');
    } else if (check) {
        process.stderr.write(
            `✖ AGENTS.md разъехался с CLAUDE.md: ${stale.join(', ')}\n` +
                '  Почини одной командой: npm run docs:sync\n',
        );
        process.exit(1);
    } else {
        process.stdout.write(`✅ пересобран AGENTS.md: ${stale.join(', ')}\n`);
    }
}

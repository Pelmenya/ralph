// Барьер границы пакетов харнессов (Фаза 16c, #179): `core/` и `.claude/hooks/` не
// зависят от `adapters/harnesses/`.
//
// Зачем граница. Пакет харнесса подключается и меняется отдельно от ядра и барьеров:
// «новый харнесс — дифф `core/` и `.claude/hooks/` пуст» (`docs/harness-contract.md`,
// «Набор соответствия»). Импорт пакета из ядра превращает выбор харнесса обратно в
// ветвление ядра, а `require` из хука исполняет код пакета в процессе барьера раньше
// его решения — нормализатор хук зовёт командой по протоколу (`adapter-event.cjs`).
//
// Классов два, и каждый — способ дотянуться до пакета:
//   1. спецификатор модуля (`import … from`, `import()`, `require()`, `export … from`),
//      который разрешается в каталог пакетов от места файла;
//   2. путь пакетов строкой в коде (`'adapters/harnesses/…'`, а также сегменты
//      `'adapters', 'harnesses'` для `join`): так собирают путь для `require` или
//      запуска, и первый класс его не видит.
// Комментарии снимаются до скана: докблок вправе назвать каталог, о котором говорит.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stripComments } from './strip-comments.ts';

export const CANON_ROOT = resolve(import.meta.dirname, '..');

/** Кто не вправе зависеть от пакетов. */
export const GUARDED_DIRS = ['core', '.claude/hooks'];

export const PACKAGES_DIR = 'adapters/harnesses';

const CODE_EXT = /\.(js|ts|mjs|mts|cjs|cts)$/;

const SPECIFIER_RES = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]/g,
];

const PATH_LITERAL_RE =
    /adapters[\\/]+harnesses(?![\w.-])|['"]adapters['"]\s*,\s*['"]harnesses['"]/;

/**
 * Файлы, где путь пакетов строкой — данные, а не дорога к коду: список защищаемых путей
 * (`core/protected-paths.ts`) называет `adapters/harnesses/**` маской для политики ревью и
 * гейта мерджа, и ни загрузить, ни запустить по ней нечего. Исключение — только второго
 * класса: спецификатор модуля из такого файла по-прежнему нарушение.
 */
export const PATH_AS_DATA_FILES: readonly string[] = ['core/protected-paths.ts'];

export type TDepViolation = { file: string; line: number; text: string; why: string };

const insidePackages = (absPath: string, root: string) => {
    const rel = relative(resolve(root, PACKAGES_DIR), absPath);
    return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
};

/**
 * Нарушения в одном файле. `file` — путь от `root`; спецификаторы разрешаются от того же
 * корня, что и обход: скан подсунутого дерева судит его каталог пакетов, а не канона.
 */
export function harnessPackageImports(
    file: string,
    source: string,
    root: string = CANON_ROOT,
): TDepViolation[] {
    const violations: TDepViolation[] = [];
    const code = stripComments(source, { dropTrailing: true }).split('\n');
    const fileDir = dirname(resolve(root, file));
    code.forEach((text, i) => {
        for (const re of SPECIFIER_RES) {
            for (const match of text.matchAll(re)) {
                const spec = match[1];
                if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
                if (insidePackages(resolve(fileDir, spec), root)) {
                    violations.push({
                        file,
                        line: i + 1,
                        text: text.trim(),
                        why: `импорт пакета ${spec}`,
                    });
                }
            }
        }
        if (PATH_LITERAL_RE.test(text) && !PATH_AS_DATA_FILES.includes(file)) {
            violations.push({
                file,
                line: i + 1,
                text: text.trim(),
                why: 'путь каталога пакетов в коде',
            });
        }
    });
    // Одна строка может попасть под оба класса — назвать её достаточно один раз.
    return violations.filter((v, i) => violations.findIndex((w) => w.line === v.line) === i);
}

/** Файлы кода под каталогом, рекурсивно, путями от корня канона. Нет каталога — бросок. */
export function codeFiles(dir: string, root = CANON_ROOT): string[] {
    const abs = join(root, dir);
    return (
        readdirSync(abs, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[]
    )
        .filter((e) => e.isFile() && CODE_EXT.test(e.name))
        .map((e) => relative(root, join(e.parentPath, e.name)))
        .filter((rel) => !rel.split(sep).includes('node_modules'))
        .sort();
}

export function scanHarnessPackageDeps(root = CANON_ROOT): {
    files: string[];
    violations: TDepViolation[];
} {
    const files = GUARDED_DIRS.flatMap((dir) => codeFiles(dir, root));
    const violations = files.flatMap((file) =>
        harnessPackageImports(file, readFileSync(join(root, file), 'utf-8'), root),
    );
    return { files, violations };
}

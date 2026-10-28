// Барьер границы пакетов харнессов: `core/` и `.claude/hooks/` не импортируют
// `adapters/harnesses/` (#179). Скан — в `harness-package-deps.ts`, здесь — сплошной
// прогон по дереву и пробы от противного на подсунутом следе каждого класса.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    codeFiles,
    GUARDED_DIRS,
    harnessPackageImports,
    scanHarnessPackageDeps,
} from './harness-package-deps.ts';

describe('core/ и .claude/hooks/ не зависят от пакетов харнессов', () => {
    const { files, violations } = scanHarnessPackageDeps();

    // Пустой набор — красный: скан, которому нечего сканировать, выглядит как чистое дерево.
    it.each(GUARDED_DIRS)('в %s/ есть что сканировать', (dir) => {
        expect(files.filter((f) => f.startsWith(`${dir}/`)).length).toBeGreaterThan(5);
    });

    it('нарушений нет', () => {
        expect(violations).toEqual([]);
    });
});

describe('скан на подсунутом следе', () => {
    const HOOK = '.claude/hooks/x.cjs';
    const CORE = 'core/x.ts';

    it.each([
        [HOOK, `const n = require('../../adapters/harnesses/claude/normalize.ts');`],
        [HOOK, `const n = require.resolve("../../adapters/harnesses");`],
        [CORE, `import { normalize } from '../adapters/harnesses/claude/normalize.ts';`],
        [CORE, `export { x } from '../adapters/harnesses/sample/index.ts';`],
        [CORE, `import '../adapters/harnesses/sample/side-effect.ts';`],
        [CORE, `const m = await import('../adapters/harnesses/codex/normalize.ts');`],
        [CORE, `import x from '../adapters/./harnesses/../harnesses/a.ts';`],
    ])('импорт пакета из %s ловится: %s', (file, line) => {
        const found = harnessPackageImports(file, `'use strict';\n${line}\n`);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ file, line: 2 });
    });

    it.each([
        `const dir = path.join(__dirname, '..', '..', 'adapters', 'harnesses');`,
        `spawnSync(process.execPath, ['adapters/harnesses/claude/normalize.ts']);`,
        'const p = `${root}/adapters/harnesses/${name}`;',
    ])('путь каталога пакетов строкой ловится: %s', (line) => {
        expect(harnessPackageImports(HOOK, line)).toEqual([
            { file: HOOK, line: 1, text: line, why: 'путь каталога пакетов в коде' },
        ]);
    });

    it.each([
        `// нормализатор живёт в adapters/harnesses/<имя>/ и зовётся командой`,
        `/** см. adapters/harnesses/protocol.ts */`,
        `const a = require('./adapter-event.cjs'); // не adapters/harnesses`,
        `import { x } from '../adapters/harness-guard.ts';`,
        `import { y } from '../adapters/harnessesque/z.ts';`,
        `import { z } from 'adapters/harnesses-like-package';`,
    ])('законное не ловится: %s', (line) => {
        expect(harnessPackageImports(CORE, line)).toEqual([]);
    });

    it('путь пакетов данными — только в названном файле и только строкой', () => {
        const mask = `    pattern: 'adapters/harnesses/**',`;
        expect(harnessPackageImports('core/protected-paths.ts', mask)).toEqual([]);
        expect(harnessPackageImports(CORE, mask)).toHaveLength(1);
        expect(
            harnessPackageImports(
                'core/protected-paths.ts',
                `import { x } from '../adapters/harnesses/a.ts';`,
            ),
        ).toHaveLength(1);
    });

    it('строка под обоими классами названа один раз', () => {
        const found = harnessPackageImports(HOOK, `require('../../adapters/harnesses/a.cjs');`);
        expect(found.map((v) => v.why)).toEqual(['импорт пакета ../../adapters/harnesses/a.cjs']);
    });

    it('сплошной скан видит подсунутый файл в .claude/hooks/', () => {
        const root = mkdtempSync(join(tmpdir(), 'harness-deps-'));
        mkdirSync(join(root, 'core', 'deep'), { recursive: true });
        mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
        writeFileSync(join(root, 'core', 'deep', 'ok.ts'), `export const a = 1;\n`);
        writeFileSync(join(root, '.claude', 'hooks', 'notes.md'), `adapters/harnesses\n`);
        writeFileSync(
            join(root, '.claude', 'hooks', 'guard.cjs'),
            `'use strict';\nconst n = require('../../adapters/harnesses/claude/normalize.cjs');\n`,
        );
        // Спецификатор без пути строкой: его видит только разрешение — и от корня скана.
        writeFileSync(
            join(root, 'core', 'deep', 'pkg.ts'),
            `import '../../adapters/./harnesses/a.ts';\n`,
        );
        // Скан идёт по корню подсунутого дерева, и спецификаторы разрешаются от него же.
        const { files, violations } = scanHarnessPackageDeps(root);
        expect(files).toEqual(['core/deep/ok.ts', 'core/deep/pkg.ts', '.claude/hooks/guard.cjs']);
        expect(violations.map((v) => [v.file, v.line, v.why])).toEqual([
            ['core/deep/pkg.ts', 1, 'импорт пакета ../../adapters/./harnesses/a.ts'],
            [
                '.claude/hooks/guard.cjs',
                2,
                'импорт пакета ../../adapters/harnesses/claude/normalize.cjs',
            ],
        ]);
    });

    it('нет каталога — бросок, а не пустой набор', () => {
        expect(() => codeFiles('nope', mkdtempSync(join(tmpdir(), 'harness-deps-')))).toThrow(
            /ENOENT/,
        );
    });
});

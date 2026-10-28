// Скан исполняемых слоёв конфига харнесса (#195) — на настоящей файловой системе во временном
// каталоге и от противного: найденный слой обязан называться, нечитаемое — отказ, а не «чисто».
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configLayerProblems, LAYER_SCAN_MAX_DIRS, SKIPPED_DIRS } from './config-layers.ts';

const SURFACES = ['.codex/config.toml', '.codex/hooks.json'];
const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'ralph-layers-'));
    dirs.push(d);
    return d;
};
const put = (file: string, text = '') => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
};
/** Предки временного каталога в настоящей ФС слоёв не несут — проверка о дереве. */
const inTree = (problems: string[], root: string) => problems.filter((p) => p.startsWith(root));

describe('configLayerProblems — слои в дереве', () => {
    it('чистое дерево — пусто; поверхностей нет — проверять нечего', () => {
        const root = tmp();
        put(path.join(root, 'src', 'a.ts'));
        expect(inTree(configLayerProblems({ tree: root, surfaces: SURFACES }), root)).toEqual([]);
        expect(configLayerProblems({ tree: '/нет/такого', surfaces: [] })).toEqual([]);
    });

    it('config.toml с MCP-сервером в корне — назван с секциями', () => {
        const root = tmp();
        put(
            path.join(root, '.codex', 'config.toml'),
            '[mcp_servers.evil]\ncommand = "node"\n[[hooks.PreToolUse]]\nmatcher = ".*"\n',
        );
        expect(inTree(configLayerProblems({ tree: root, surfaces: SURFACES }), root)).toEqual([
            `${path.join(root, '.codex', 'config.toml')}: исполняемый слой конфига харнесса в ` +
                'дереве сессии (секции: mcp_servers, hooks)',
        ]);
    });

    it('файл хуков в подкаталоге — назван; .git, зависимости, сборка и вложенный репозиторий не обходятся', () => {
        const root = tmp();
        put(path.join(root, 'pkg', 'sub', '.codex', 'hooks.json'), '{}');
        put(path.join(root, 'node_modules', 'x', '.codex', 'config.toml'));
        put(path.join(root, '.git', 'y', '.codex', 'config.toml'));
        put(path.join(root, 'target', 'debug', '.codex', 'config.toml'));
        put(path.join(root, '.venv', 'lib', '.codex', 'hooks.json'), '{}');
        // Вложенный worktree: `.git` у него — файл, слои его — только при cwd внутри.
        put(path.join(root, 'wt', '.git'), 'gitdir: /x/.git/worktrees/wt\n');
        put(path.join(root, 'wt', '.codex', 'config.toml'));
        expect(inTree(configLayerProblems({ tree: root, surfaces: SURFACES }), root)).toEqual([
            `${path.join(root, 'pkg', 'sub', '.codex', 'hooks.json')}: исполняемый слой конфига ` +
                'харнесса в дереве сессии',
        ]);
    });

    it('слой в предке — назван как предок; дом CLI в предке — исключён', () => {
        const parent = tmp();
        const root = path.join(parent, 'work');
        put(path.join(root, 'a.txt'));
        put(path.join(parent, '.codex', 'config.toml'), 'model = "x"\n');
        const found = configLayerProblems({ tree: root, surfaces: SURFACES });
        expect(found.filter((p) => p.startsWith(parent))).toEqual([
            `${path.join(parent, '.codex', 'config.toml')}: исполняемый слой конфига харнесса в ` +
                'предке дерева сессии',
        ]);
        const homes = [path.join(parent, '.codex')];
        expect(
            configLayerProblems({ tree: root, surfaces: SURFACES, homes }).filter((p) =>
                p.startsWith(parent),
            ),
        ).toEqual([]);
    });
});

describe('configLayerProblems — fail-closed', () => {
    it('дерево не прочитано — отказ, а не «слоёв нет»', () => {
        const found = configLayerProblems({ tree: '/path/to/missing', surfaces: SURFACES });
        expect(found[0]).toMatch(/^\/path\/to\/missing: каталог не прочитан .* не проверены$/);
    });

    it('больше предела каталогов — отказ без частичной проверки', () => {
        // Широкое, а не глубокое: путь глубиной в предел съел бы память на строках путей.
        const wide = Array.from({ length: LAYER_SCAN_MAX_DIRS }, (_, i) => `d${i}`);
        const found = configLayerProblems(
            { tree: '/t', surfaces: SURFACES },
            { listDirsFn: (dir) => (dir === '/t' ? wide : []), existsFn: () => false },
        );
        expect(found).toEqual([
            `/t: больше ${LAYER_SCAN_MAX_DIRS} каталогов — обход не закончен, исполняемые слои ` +
                'конфига не проверены',
        ]);
    });

    it('крупный каталог сборки предел не ест — старт без слоёв не отменён', () => {
        const wide = Array.from({ length: LAYER_SCAN_MAX_DIRS }, (_, i) => `d${i}`);
        const found = configLayerProblems(
            { tree: '/t', surfaces: SURFACES },
            {
                listDirsFn: (dir) =>
                    dir === '/t' ? ['src', ...SKIPPED_DIRS] : dir === '/t/target' ? wide : [],
                existsFn: () => false,
            },
        );
        expect(found).toEqual([]);
    });

    it('слой не прочитался — назван без секций', () => {
        const found = configLayerProblems(
            { tree: '/t', surfaces: ['.codex/config.toml'] },
            {
                listDirsFn: () => [],
                existsFn: (p) => p === '/t/.codex/config.toml',
                readFileFn: () => {
                    throw new Error('EACCES');
                },
            },
        );
        expect(found).toEqual([
            '/t/.codex/config.toml: исполняемый слой конфига харнесса в дереве сессии',
        ]);
    });
});

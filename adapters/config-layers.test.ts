// Скан исполняемых слоёв конфига харнесса (#195) — на настоящей файловой системе во временном
// каталоге и от противного: найденный слой обязан называться, нечитаемое — отказ, а не «чисто».
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    configLayerProblems,
    LAYER_SCAN_MAX_DIRS,
    parseJsonc,
    SKIPPED_DIRS,
} from './config-layers.ts';

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

// #197: у OpenCode `opencode.json` — законная настройка человека, слоем её делает исполняющий
// ключ (`plugin`, `mcp`, `provider.*.npm`, …); каталоги `.opencode/plugin` — слой самим наличием.
describe('configLayerProblems — JSON-поверхность с ключами слоя', () => {
    const OC = ['.opencode/plugin', 'opencode.json', 'opencode.jsonc'];
    const scan = (root: string) =>
        inTree(configLayerProblems({ tree: root, surfaces: OC, jsonKeys: ['plugin'] }), root);

    it('opencode.json без plugin или с пустым — не слой; с npm-плагином — слой с ключом', () => {
        const root = tmp();
        put(path.join(root, 'opencode.json'), '{"theme": "x", "plugin": []}');
        expect(scan(root)).toEqual([]);
        put(path.join(root, 'opencode.jsonc'), '{\n  // человек\n  "plugin": ["npm-x",],\n}');
        expect(scan(root)).toEqual([
            `${path.join(root, 'opencode.jsonc')}: исполняемый слой конфига харнесса в дереве ` +
                'сессии (ключи: plugin)',
        ]);
    });

    it('mcp, formatter, lsp — тоже исполняющие ключи; пустые и выключенные — не слой', () => {
        const root = tmp();
        const scanAll = () =>
            inTree(
                configLayerProblems({
                    tree: root,
                    surfaces: OC,
                    jsonKeys: ['plugin', 'mcp', 'formatter', 'lsp'],
                }),
                root,
            );
        put(path.join(root, 'opencode.json'), '{"mcp": {}, "formatter": false, "lsp": false}');
        expect(scanAll()).toEqual([]);
        put(
            path.join(root, 'opencode.json'),
            '{"mcp": {"x": {"type": "local", "command": ["x"]}}, "lsp": {"y": {"command": ["y"]}}}',
        );
        expect(scanAll()).toEqual([
            `${path.join(root, 'opencode.json')}: исполняемый слой конфига харнесса в дереве ` +
                'сессии (ключи: mcp, lsp)',
        ]);
    });

    // Схема `Config` OpenCode 1.19.4: `npm` провайдера и модели грузит пакет, `shell` — бинарь
    // инструмента bash, шаблон `command` исполняет `` !`cmd` ``. Прочее в `provider` — законно.
    it('НЕГАТИВНЫЙ: npm провайдера и модели, shell, command — слой; ключи провайдера — нет', () => {
        const root = tmp();
        const keys = ['shell', 'command', 'provider.*.npm', 'provider.*.models.*.provider.npm'];
        const scanKeys = () =>
            inTree(configLayerProblems({ tree: root, surfaces: OC, jsonKeys: keys }), root);
        const file = path.join(root, 'opencode.json');
        put(file, '{"provider": {"x": {"options": {"apiKey": "k"}, "models": {"m": {}}}}}');
        expect(scanKeys()).toEqual([]);
        put(file, '{"provider": {"x": {"npm": "evil-provider"}}}');
        expect(scanKeys()).toEqual([
            `${file}: исполняемый слой конфига харнесса в дереве сессии (ключи: provider.*.npm)`,
        ]);
        put(file, '{"provider": {"x": {"models": {"m": {"provider": {"npm": "evil"}}}}}}');
        expect(scanKeys()[0]).toMatch(/ключи: provider\.\*\.models\.\*\.provider\.npm\)$/);
        put(file, '{"shell": "./x.sh", "command": {"c": {"template": "!`id`"}}}');
        expect(scanKeys()[0]).toMatch(/ключи: shell, command\)$/);
        put(file, '{"provider": "x", "shell": ""}');
        expect(scanKeys()).toEqual([]);
    });

    it('.opencode/plugin/x.js — слой самим наличием каталога', () => {
        const root = tmp();
        put(path.join(root, '.opencode', 'plugin', 'x.js'), 'export default {}');
        expect(scan(root)).toEqual([
            `${path.join(root, '.opencode', 'plugin')}: исполняемый слой конфига харнесса в ` +
                'дереве сессии',
        ]);
    });

    it('НЕГАТИВНЫЙ: не разобрался или не объект — отказ с причиной, а не «ключа нет»', () => {
        const root = tmp();
        put(path.join(root, 'opencode.json'), '{"plugin": [');
        const [broken] = scan(root);
        expect(broken).toMatch(
            /opencode\.json: поверхность конфига харнесса не разобрана .* ключи plugin не проверены/,
        );
        put(path.join(root, 'opencode.json'), '["plugin"]');
        expect(scan(root)[0]).toMatch(/не разобрана \(не объект\)/);
    });
});

describe('parseJsonc', () => {
    it('висячая запятая внутри строки остаётся; BOM в начале снят', () => {
        expect(parseJsonc('{"a": "x,]", "b": ["y,}" ,], }')).toEqual({ a: 'x,]', b: ['y,}'] });
        expect(parseJsonc('\uFEFF{"plugin": []}')).toEqual({ plugin: [] });
        expect(parseJsonc('{"a": [1 /* c */ , ] // хвост\n}')).toEqual({ a: [1] });
    });

    it('комментарии вне строк и висячие запятые сняты; в строках — остаются', () => {
        expect(
            parseJsonc('{ /* блок */ "a": "http://x/*y*/", // строка\n "b": [1, 2,], }'),
        ).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
        expect(parseJsonc('{"q": "с \\"кавычкой\\" // не комментарий"}')).toEqual({
            q: 'с "кавычкой" // не комментарий',
        });
    });

    it('запятая, после которой шло значение, не снимается; разбор линеен по скобкам', () => {
        expect(() => parseJsonc('[1, 2 ]')).not.toThrow();
        expect(parseJsonc('[1, /* c */ 2 ,\n]')).toEqual([1, 2]);
        // Тысячи скобок с висячими запятыми: регэксп по всему выводу на каждой скобке шёл бы
        // секундами, линейный проход — миллисекунды.
        const big = `[${'{"a": [1,],},'.repeat(50_000)}]`;
        expect(parseJsonc(big)).toHaveLength(50_000);
    });

    it('незакрытый блочный комментарий и битый JSON — бросок', () => {
        expect(() => parseJsonc('{ /* без конца')).toThrow(/незакрытый комментарий/);
        expect(() => parseJsonc('{')).toThrow();
    });
});

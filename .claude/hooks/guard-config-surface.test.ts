// Правило `config-surface` (#199): запись поверхности конфига харнесса из сессии петли — блок.
// Перечень приходит контекстом сессии; здесь он литералом той же формы, что объединяет реестр
// (`protectedSurfacesOf`). Сквозную проверку на перечне настоящих пакетов держит
// `core/guard-event-scenarios.test.ts`.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { decide, decideEvent, type TGuardOperation, type TGuardSurfaces } from './guard-rules.cjs';

const BASE = '/work';
const HOME = '/home/u';

const SURFACES: TGuardSurfaces = {
    tree: [
        '.claude/settings.json',
        '.claude/settings.local.json',
        '.mcp.json',
        '.codex/',
        '.kimi-code/',
        '.opencode/',
        'opencode.json',
    ],
    homes: [
        { env: 'CLAUDE_CONFIG_DIR', sub: '', default: '.claude', exempt: ['projects', 'todos'] },
        { env: 'CODEX_HOME', sub: '', default: '.codex', exempt: ['sessions'] },
        { env: 'XDG_CONFIG_HOME', sub: 'opencode', default: '.config/opencode', exempt: [] },
        { env: 'OPENCODE_CONFIG_DIR', sub: '', default: null, exempt: [] },
    ],
};

/** Файловая система без файлов: путь не разрешается, судится строка. */
const emptyFs = {
    realpathSync: (p: string): string => {
        throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    },
    statSync: (p: string): { isDirectory: () => boolean } => {
        throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    },
    readdirSync: () => [],
};

type TOptions = Parameters<typeof decideEvent>[1];
const LOOP: TOptions = {
    loop: true,
    surfaces: SURFACES,
    processEnv: { HOME },
    fsApi: emptyFs,
};
const codeOf = (op: TGuardOperation, options: TOptions = LOOP) => {
    const v = decideEvent({ operations: [op] }, options);
    return v.blocked ? v.code : null;
};
const write = (p: string): TGuardOperation => ({ op: 'write', path: p, baseDir: BASE });
const exec = (command: string): TGuardOperation => ({ op: 'exec', command, baseDir: BASE });

describe('файловые операции над поверхностью в сессии петли', () => {
    it.each([
        '.claude/settings.json',
        '.claude/settings.local.json',
        'packages/app/.claude/settings.json',
        '.mcp.json',
        '.codex/config.toml',
        '.codex/hooks.json',
        '.kimi-code/mcp.json',
        '.opencode/plugin/x.ts',
        'opencode.json',
        '/elsewhere/opencode.json',
        `${HOME}/.claude/settings.json`,
        `${HOME}/.claude/hooks/x.sh`,
        `${HOME}/.codex/config.toml`,
        `${HOME}/.config/opencode/opencode.json`,
        '~/.claude/plugins/x.json',
    ])('запись %s — config-surface', (p) => {
        expect(codeOf(write(p))).toBe('config-surface');
    });

    it.each([
        'src/a.ts',
        '.claude/skills/x/SKILL.md',
        '.claude/settings.json.example',
        'docs/opencode.json.md',
        'my.mcp.json',
        `${HOME}/.claude/projects/x/memory/a.md`,
        `${HOME}/.claude/todos/a.json`,
        `${HOME}/.codex/sessions/a.jsonl`,
        `${HOME}/other/settings.json`,
    ])('запись %s — пропуск', (p) => {
        expect(codeOf(write(p))).toBeNull();
    });

    it('чтение поверхности — пропуск', () => {
        expect(codeOf({ op: 'read', path: '.codex/config.toml', baseDir: BASE })).toBeNull();
    });

    it('перенос: и источник, и назначение; предок поверхности при удалении — тоже', () => {
        expect(
            codeOf({
                op: 'move',
                path: 'evil.toml',
                destination: '.codex/config.toml',
                baseDir: BASE,
            }),
        ).toBe('config-surface');
        expect(
            codeOf({ op: 'move', path: 'opencode.json', destination: 'x.json', baseDir: BASE }),
        ).toBe('config-surface');
        expect(codeOf({ op: 'delete', path: '.codex', baseDir: BASE })).toBe('config-surface');
        expect(codeOf({ op: 'delete', path: `${HOME}/.config`, baseDir: BASE })).toBe(
            'config-surface',
        );
        // Запись (не перенос) в каталог-предок поверхности — это другой файл.
        expect(codeOf(write(`${HOME}/.config/other.txt`))).toBeNull();
    });

    it('дом по переменной окружения и с подкаталогом', () => {
        const processEnv = {
            HOME,
            CODEX_HOME: '/state/codex-home',
            XDG_CONFIG_HOME: '/state/xdg',
            OPENCODE_CONFIG_DIR: '/state/opencode',
        };
        const options = { ...LOOP, processEnv };
        expect(codeOf(write('/state/codex-home/config.toml'), options)).toBe('config-surface');
        expect(codeOf(write('/state/codex-home/sessions/a'), options)).toBeNull();
        expect(codeOf(write('/state/xdg/opencode/plugin/x.ts'), options)).toBe('config-surface');
        expect(codeOf(write('/state/xdg/other/x'), options)).toBeNull();
        expect(codeOf(write('/state/opencode/plugin/guard.js'), options)).toBe('config-surface');
        // Дом из переменной не отменяет дом по умолчанию: раннер ставит `XDG_CONFIG_HOME` сессии
        // OpenCode в каталог состояния, а интерактивный CLI человека грузит `~/.config/opencode`.
        expect(codeOf(write(`${HOME}/.config/opencode/plugin/x.ts`), options)).toBe(
            'config-surface',
        );
        expect(codeOf(write(`${HOME}/.codex/config.toml`), options)).toBe('config-surface');
        // Исключения действуют у обоих каталогов дома.
        expect(codeOf(write(`${HOME}/.codex/sessions/a`), options)).toBeNull();
    });

    it('исключение дома снимает только свой дом: шаблон дерева ниже него судит путь', () => {
        expect(codeOf(write(`${HOME}/.claude/projects/w/.claude/settings.json`))).toBe(
            'config-surface',
        );
        expect(codeOf(write(`${HOME}/.claude/projects/w/.codex/config.toml`))).toBe(
            'config-surface',
        );
        expect(codeOf(write(`${HOME}/.claude/projects/w/memory/a.md`))).toBeNull();
    });

    it('имя `..x` внутри дома — внутри, а не выход вверх', () => {
        expect(codeOf(write(`${HOME}/.claude/..cache/x`))).toBe('config-surface');
    });

    it('файл рядом с домом и системный конфиг — поверхности (absolute, дом-файл)', () => {
        const options = {
            ...LOOP,
            surfaces: {
                ...SURFACES,
                homes: [
                    ...SURFACES.homes,
                    {
                        env: 'CLAUDE_CONFIG_DIR',
                        sub: '.claude.json',
                        default: '.claude.json',
                        exempt: [],
                    },
                ],
                absolute: ['/etc/claude-code', '/etc/codex'],
            },
        };
        expect(codeOf(write(`${HOME}/.claude.json`), options)).toBe('config-surface');
        expect(codeOf(write('/etc/claude-code/managed-settings.json'), options)).toBe(
            'config-surface',
        );
        expect(codeOf(write('/etc/codex/config.toml'), options)).toBe('config-surface');
        expect(codeOf({ op: 'delete', path: '/etc', baseDir: BASE }, options)).toBe(
            'config-surface',
        );
        expect(codeOf(write('/etc/hosts'), options)).toBeNull();
        expect(codeOf(write(`${HOME}/.claude.json.bak`), options)).toBeNull();
    });

    it('вне петли и без перечня — правило молчит', () => {
        expect(codeOf(write('.codex/config.toml'), { ...LOOP, loop: false })).toBeNull();
        expect(codeOf(write('.codex/config.toml'), { ...LOOP, surfaces: null })).toBeNull();
    });
});

describe('оболочка в сессии петли', () => {
    it.each([
        'echo {} > .mcp.json',
        'echo {} >> ~/.codex/config.toml',
        'printf x>.claude/settings.local.json',
        'cat a.json > opencode.json',
        'sed -i s/a/b/ .codex/config.toml',
        'cp evil.toml .codex/config.toml',
        'mv .kimi-code .kimi-code.bak',
        'rm -rf .opencode',
        'tee .claude/settings.json < x',
        'install --target-directory=.codex evil',
        `node -e "require('fs').writeFileSync('.mcp.json', '{}')"`,
        'git checkout main -- .claude/settings.json',
        `ln -sf /tmp/x ${HOME}/.claude/settings.json`,
        // Текст программы не по имени интерпретатора: слова пути ищутся в любом аргументе-тексте.
        `npx tsx -e "require('fs').writeFileSync('.mcp.json','{}')"`,
        `awk 'BEGIN{print 1 > ".codex/config.toml"}'`,
        `pnpm exec node -e "require('fs').writeFileSync('opencode.json','{}')"`,
        // Копия в предка под именем поверхности пишет её, не называя.
        `cp -r evil/.codex ${HOME}/`,
        `cp -r evil/ ${HOME}/.config`,
        // `-T` кладёт содержимое источника прямо в назначение: назначение — предок.
        `cp -rT evil ${HOME}`,
        `cp -r --no-target-directory evil ${HOME}`,
        // Опции так, как их читает GNU `getopt`: сокращение длинной, связка с `t`, `--`.
        `cp -r --no-t evil ${HOME}`,
        `cp -r --no-target evil ${HOME}`,
        `cp -rt ${HOME}/.config evil/opencode`,
        `cp -rt${HOME}/.config evil/opencode`,
        `cp -r --target=${HOME}/.config evil/opencode`,
        `cp -r --t ${HOME}/.config evil/opencode`,
        `cp -r -- evil/opencode ${HOME}/.config/`,
        // У `rsync` `-t` — времена, а не каталог назначения.
        `rsync -t evil/opencode ${HOME}/.config/`,
        'mv .codex /tmp/x',
        'mv x.toml -t .codex',
        `rm -rf ${HOME}`,
        'find .codex -name x -delete',
        `/usr/bin/find ${HOME} -exec rm -rf {} +`,
        'rsync -a --delete empty/ ~/',
        'find src -fprint .mcp.json',
    ])('%s — config-surface', (command) => {
        expect(codeOf(exec(command))).toBe('config-surface');
    });

    it.each([
        'cat .mcp.json',
        'grep -r hooks .codex/config.toml',
        'git diff -- .claude/settings.json',
        'git add .mcp.json',
        'git log -- opencode.json',
        'echo .claude/settings.json',
        'ls ~/.codex',
        'npm test',
        'cp a.txt b.txt',
        // Предок опасен только там, где путь уходит: поиск читает, копия в HOME пишет другой файл.
        'find ~ -name "*.md"',
        '/usr/bin/find .codex -name x',
        `cp notes.txt ${HOME}/`,
        `cp -t ${HOME} notes.txt`,
        `install -m 644 notes.txt ${HOME}/`,
        'cp .mcp.json /tmp/mcp.json',
        'rsync -a ~/ /backup/',
        'npx vitest run src/a.test.ts',
    ])('%s — пропуск', (command) => {
        expect(codeOf(exec(command))).toBeNull();
    });

    it('каталог вызова — база путей', () => {
        expect(
            codeOf({ op: 'exec', command: 'tee config.toml < x', baseDir: `${BASE}/.codex` }),
        ).toBe('config-surface');
    });
});

describe('настоящий путь: симлинк на поверхность', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it('запись через ссылку на дом CLI — блок', () => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'surface-')));
        dirs.push(root);
        const home = path.join(root, 'home');
        mkdirSync(path.join(home, '.claude'), { recursive: true });
        const tree = path.join(root, 'tree');
        mkdirSync(tree);
        symlinkSync(path.join(home, '.claude'), path.join(tree, 'cfg'));
        const v = decideEvent(
            { operations: [{ op: 'write', path: 'cfg/settings.json', baseDir: tree }] },
            { loop: true, surfaces: SURFACES, processEnv: { HOME: home } },
        );
        expect(v).toMatchObject({ blocked: true, code: 'config-surface' });
        expect(v.reason).toMatch(/дом CLI/);
    });

    // На пустой файловой системе назначение и так не каталог; дыра была только у настоящего HOME:
    // `isDirAt` признавал его каталогом, и судилась запись `~/evil`, а не содержимое в `~`.
    it.each([
        'cp -rT evil HOME',
        'cp -r --no-target-directory evil HOME',
        'cp -a -T evil HOME',
        'cp -r --no-t evil HOME',
        'cp -r --no-target evil HOME',
    ])('%s при настоящем HOME — блок', (template) => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'surface-')));
        dirs.push(root);
        const home = path.join(root, 'home');
        mkdirSync(home);
        const tree = path.join(root, 'tree');
        mkdirSync(path.join(tree, 'evil', '.claude'), { recursive: true });
        const command = template.replace('HOME', home);
        const v = decideEvent(
            { operations: [{ op: 'exec', command, baseDir: tree }] },
            { loop: true, surfaces: SURFACES, processEnv: { HOME: home } },
        );
        expect(v).toMatchObject({ blocked: true, code: 'config-surface' });
    });

    it('cp -r evil в настоящий HOME без -T — запись ~/evil, пропуск', () => {
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'surface-')));
        dirs.push(root);
        const home = path.join(root, 'home');
        mkdirSync(home);
        const v = decideEvent(
            { operations: [{ op: 'exec', command: `cp -r evil ${home}`, baseDir: root }] },
            { loop: true, surfaces: SURFACES, processEnv: { HOME: home } },
        );
        expect(v.blocked).toBe(false);
    });
});

// Без раскладки `roots` guard сессии — копия хуков в дереве, и судит она совместимым входом 16b.
describe('совместимый вход 16b', () => {
    const COMPAT = { ...LOOP, baseDir: BASE };
    const compatCode = (tool: string, toolInput: Record<string, unknown>, options = COMPAT) => {
        const v = decide(tool, toolInput, options);
        return v.blocked ? v.code : null;
    };

    it.each([
        ['Write', { file_path: '.claude/settings.local.json', content: '{}' }],
        ['Edit', { file_path: `${HOME}/.codex/config.toml`, old_string: 'a', new_string: 'b' }],
        ['MultiEdit', { file_path: 'x.ts', edits: [{ file_path: 'opencode.json' }] }],
        ['Bash', { command: 'echo {} > .mcp.json' }],
    ])('%s %j — config-surface', (tool, input) => {
        expect(compatCode(tool, input)).toBe('config-surface');
    });

    it('относительный путь — от cwd конверта', () => {
        expect(
            compatCode('Write', { file_path: 'config.toml' }, { ...COMPAT, baseDir: '/w/.codex' }),
        ).toBe('config-surface');
    });

    it('разрешённое, вне петли и без перечня — пропуск', () => {
        expect(compatCode('Write', { file_path: 'src/a.ts' })).toBeNull();
        expect(compatCode('Bash', { command: 'cat .mcp.json' })).toBeNull();
        expect(
            compatCode('Write', { file_path: '.mcp.json' }, { ...COMPAT, loop: false }),
        ).toBeNull();
        expect(
            compatCode('Write', { file_path: '.mcp.json' }, { ...COMPAT, surfaces: null }),
        ).toBeNull();
    });
});

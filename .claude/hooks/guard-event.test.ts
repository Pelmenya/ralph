// Правило guard на нормализованном событии (#186): `decideEvent` над операциями `ToolEvent`.
// Процесс хука и нормализатор пакета здесь не участвуют — их держат сценарии
// `core/guard-event-scenarios.test.ts`; здесь — решение по каждой операции и их сочетаниям.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConsumerData } from './consumer-data.cjs';
import { decideEvent, globMayMatchEnv, type TGuardOperation } from './guard-rules.cjs';

const BASE = '/work';
const one = (op: TGuardOperation, options: Parameters<typeof decideEvent>[1] = {}) =>
    decideEvent({ operations: [op] }, options);
const codeOf = (op: TGuardOperation, options: Parameters<typeof decideEvent>[1] = {}) => {
    const v = one(op, options);
    return v.blocked ? v.code : null;
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

describe('незнакомое — свой код, а не пропуск', () => {
    it.each([
        [{ op: 'unknown', why: 'инструмент X вне описания', kind: 'tool' }, 'unknown-tool'],
        [
            { op: 'unknown', why: 'Read: незнакомое поле входа: path', kind: 'field' },
            'unknown-field',
        ],
        [{ op: 'unknown', why: 'без вида' }, 'unknown-field'],
        [{ op: 'teleport' } as unknown as TGuardOperation, 'unknown-field'],
    ] as [TGuardOperation, string][])('%j → %s', (op, code) => {
        expect(codeOf(op)).toBe(code);
    });

    it('одна запрещённая операция запрещает весь вызов', () => {
        const v = decideEvent({
            operations: [
                { op: 'inert', what: 'TodoWrite' },
                { op: 'read', path: 'src/a.ts', baseDir: BASE },
                { op: 'exec', command: 'rm -rf ./x', baseDir: BASE },
            ],
        });
        expect(v).toMatchObject({ blocked: true, code: 'destructive' });
    });

    it('разрешённые операции — пропуск', () => {
        expect(
            decideEvent(
                {
                    operations: [
                        { op: 'inert', what: 'Skill(vitest)' },
                        { op: 'exec', command: 'git status', baseDir: BASE },
                        { op: 'write', path: 'src/a.ts', baseDir: BASE },
                    ],
                },
                { fsApi: emptyFs },
            ).blocked,
        ).toBe(false);
    });
});

describe('файловые операции', () => {
    it.each([
        [{ op: 'read', path: '.env', baseDir: BASE }, 'secret-env'],
        [{ op: 'write', path: 'apps/api/.env.local', baseDir: BASE }, 'secret-env'],
        [{ op: 'delete', path: 'ralph.env', baseDir: BASE }, 'secret-env'],
        [{ op: 'move', path: 'a.txt', destination: '.env', baseDir: BASE }, 'secret-env'],
        [{ op: 'read', path: '.env.example', baseDir: BASE }, null],
    ] as [TGuardOperation, string | null][])('%j → %s', (op, code) => {
        expect(codeOf(op, { fsApi: emptyFs })).toBe(code);
    });

    it('данные контура: запись, удаление и перенос в петле — блок; чтение — нет', () => {
        const data = '.claude/ralph/hooks.json';
        const loop = { loop: true, fsApi: emptyFs };
        expect(codeOf({ op: 'write', path: data, baseDir: BASE }, loop)).toBe('contour-data');
        expect(codeOf({ op: 'delete', path: data, baseDir: BASE }, loop)).toBe('contour-data');
        expect(codeOf({ op: 'move', path: 'x.json', destination: data, baseDir: BASE }, loop)).toBe(
            'contour-data',
        );
        expect(codeOf({ op: 'read', path: data, baseDir: BASE }, loop)).toBeNull();
        expect(codeOf({ op: 'write', path: data, baseDir: BASE }, { fsApi: emptyFs })).toBeNull();
    });

    it('симлинк судится по цели, а не по имени', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'guard-event-link-'));
        writeFileSync(path.join(dir, '.env'), 'A=1\n');
        symlinkSync(path.join(dir, '.env'), path.join(dir, 'notes.txt'));
        expect(codeOf({ op: 'read', path: 'notes.txt', baseDir: dir })).toBe('secret-env');
        // Ещё не созданный файл в каталоге-симлинке: судится настоящий родитель.
        const data = path.join(dir, 'real', '.claude', 'ralph');
        mkdirSync(data, { recursive: true });
        symlinkSync(path.join(dir, 'real', '.claude'), path.join(dir, 'alias'));
        expect(
            codeOf({ op: 'write', path: 'alias/ralph/hooks.json', baseDir: dir }, { loop: true }),
        ).toBe('contour-data');
    });
});

/** Дерево с данными контура и env-файлом во временном каталоге: пути судятся по настоящей ФС. */
function contourTree(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-event-resolve-'));
    mkdirSync(path.join(dir, '.claude', 'ralph'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'ralph', 'hooks.json'), '{}');
    writeFileSync(path.join(dir, '.env'), 'A=1\n');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'a.ts'), '');
    return dir;
}

describe('разрешение пути (#187): симлинки, перенос каталога, несозданное назначение', () => {
    const loop = { loop: true };

    it('несозданное назначение глубже родителя судится от настоящего предка', () => {
        const dir = contourTree();
        symlinkSync(path.join(dir, '.claude'), path.join(dir, 'alias'));
        rmSync(path.join(dir, '.claude', 'ralph'), { recursive: true });
        // `alias/ralph` не существует: настоящий путь — от ближайшего существующего предка.
        const op = { op: 'write', path: 'alias/ralph/hooks.json', baseDir: dir } as const;
        expect(codeOf(op, loop)).toBe('contour-data');
        expect(codeOf({ op: 'write', path: 'alias/x/y/z.ts', baseDir: dir }, loop)).toBeNull();
    });

    it('`..` после симлинка идёт от цели ссылки, а не по строке', () => {
        const dir = contourTree();
        // `deep/up` → `.claude/ralph/x`; строкой `deep/up/../hooks.json` — это `deep/hooks.json`.
        mkdirSync(path.join(dir, 'deep'));
        mkdirSync(path.join(dir, '.claude', 'ralph', 'x'));
        symlinkSync(path.join(dir, '.claude', 'ralph', 'x'), path.join(dir, 'deep', 'up'));
        const op = { op: 'write', path: 'deep/up/../hooks.json', baseDir: dir } as const;
        expect(codeOf(op, loop)).toBe('contour-data');
    });

    it('висячий симлинк судится по тому, что запись создаст', () => {
        const dir = contourTree();
        symlinkSync(path.join(dir, 'missing', '.env'), path.join(dir, 'notes.txt'));
        expect(codeOf({ op: 'write', path: 'notes.txt', baseDir: dir })).toBe('secret-env');
    });

    it('цикл симлинков не вешает барьер', () => {
        const dir = contourTree();
        symlinkSync(path.join(dir, 'b'), path.join(dir, 'a'));
        symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
        expect(codeOf({ op: 'write', path: 'a/x.ts', baseDir: dir }, loop)).toBeNull();
    });

    it('перенос и удаление каталога с данными контура в петле — блок', () => {
        const dir = contourTree();
        const move = (from: string, to: string) =>
            codeOf({ op: 'move', path: from, destination: to, baseDir: dir }, loop);
        expect(move('.claude/ralph', 'old')).toBe('contour-data');
        expect(move('.claude', 'bak')).toBe('contour-data');
        expect(codeOf({ op: 'delete', path: '.claude', baseDir: dir }, loop)).toBe('contour-data');
        // Каталог, где данные лежат глубже имени: судится содержимое, а не строка.
        mkdirSync(path.join(dir, 'pkg', '.claude', 'ralph'), { recursive: true });
        writeFileSync(path.join(dir, 'pkg', '.claude', 'ralph', 'hooks.json'), '{}');
        expect(move('pkg', 'pkg2')).toBe('contour-data');
        // Обычный каталог переносится; вне петли забора нет.
        expect(move('src', 'lib')).toBeNull();
        expect(
            codeOf({ op: 'move', path: '.claude', destination: 'bak', baseDir: dir }),
        ).toBeNull();
    });

    it('назначение переноса: каталог встаёт на место данных — блок', () => {
        const dir = contourTree();
        mkdirSync(path.join(dir, 'evil', 'ralph'), { recursive: true });
        writeFileSync(path.join(dir, 'evil', 'ralph', 'hooks.json'), '{"mcp":{}}');
        mkdirSync(path.join(dir, 'empty'));
        const move = (from: string, to: string) =>
            codeOf({ op: 'move', path: from, destination: to, baseDir: dir }, loop);
        rmSync(path.join(dir, '.claude'), { recursive: true });
        // Несозданное назначение: каталог источника становится `.claude`.
        expect(move('evil', '.claude')).toBe('contour-data');
        expect(move('evil', 'gone/../.claude')).toBe('contour-data');
        // Существующий каталог: новым путём будет `назначение/имя источника`.
        mkdirSync(path.join(dir, '.claude'));
        symlinkSync(path.join(dir, '.claude'), path.join(dir, 'cl'));
        expect(move('evil/ralph', 'cl')).toBe('contour-data');
        expect(move('src', '.claude')).toBeNull();
        expect(move('src', 'empty')).toBeNull();
    });

    it('файл в существующий каталог через симлинк: `назначение/имя` — данные контура', () => {
        const dir = contourTree();
        writeFileSync(path.join(dir, 'hooks.json'), '{}');
        symlinkSync(path.join(dir, '.claude', 'ralph'), path.join(dir, 'r'));
        const op = { op: 'move', path: 'hooks.json', destination: 'r', baseDir: dir } as const;
        expect(codeOf(op, loop)).toBe('contour-data');
    });

    it('оболочка: mv, rm, cp каталога данных в петле — блок; соседний каталог — нет', () => {
        const dir = contourTree();
        symlinkSync(path.join(dir, '.claude', 'ralph'), path.join(dir, 'r'));
        const exec = (command: string) => codeOf({ op: 'exec', command, baseDir: dir }, loop);
        expect(exec('mv .claude/ralph /tmp/x')).toBe('contour-data');
        expect(exec('mv .claude bak')).toBe('contour-data');
        expect(exec('rm -r ./.claude/')).toBe('contour-data');
        expect(exec('cp -r evil .claude')).toBe('contour-data');
        // Псевдоним каталога данных виден только по ФС.
        expect(exec('mv r elsewhere')).toBe('contour-data');
        expect(exec('mv src lib')).toBeNull();
        expect(exec('ls .claude/ralph')).toBeNull();
        expect(exec('git add .')).toBeNull();
        expect(codeOf({ op: 'exec', command: 'mv .claude bak', baseDir: dir })).toBeNull();
    });

    // Ревью 16c: git проверялся только по базовому имени `hooks.json`, и путь-каталог
    // возвращал прежний контур из истории; `find` и `tar` каталог уносили так же.
    it.each([
        'git checkout other -- .claude/ralph',
        'git checkout main -- .claude',
        'git restore --source=HEAD~3 .claude',
        'git -C .claude checkout other -- ralph',
        'git archive other .claude | tar -x',
        'git stash push -- .claude',
        'git mv .claude bak',
        'git checkout other -- .',
        'git checkout other -- r',
        'find .claude -delete',
        'find . -name x -exec rm {} +',
        'tar -xf x.tar',
        'tar xf x.tar .claude',
        'GIT_DIR=x git diff .claude',
        // Ревью 16c, проход 1: git читает аргумент pathspec'ом — `*` проходит `/` и ведущую
        // точку, `:/` и `:(top)` — корень дерева; оболочка их так не раскрывает.
        "git checkout other -- '*'",
        "git checkout other -- '*hooks.json'",
        "git restore --source=HEAD~3 '*.json'",
        "git checkout other -- ':/'",
        "git checkout other -- ':(top)'",
        'git checkout other --pathspec-from-file=list',
        'git restore --pathspec-from-file list',
        'find . -exec sed -i s/a/b/ {} +',
        'find . -ok rm {} ;',
        // Ревью 16c, проход 2: `{}` резал аргументы `find`, и действие после первой
        // читающей программы не видел никто; регистр pathspec — опцией git.
        'find .claude/ralph -type f -exec cat {} + -exec cp /tmp/evil {} +',
        "find .claude -name 'hook*' -exec grep -q . {} \\; -exec cp /tmp/evil {} \\;",
        'find .claude -exec cat {} + -delete',
        'git --icase-pathspecs checkout other -- .CLAUDE/RALPH/HOOKS.JSON',
        'git --icase-pathspecs restore --source=HEAD~1 .CLAUDE',
        'git --glob-pathspecs checkout other -- x',
        "git -C sub checkout other -- '*'",
        // Ревью 16c, проход 3: режим pathspec окружением, `-m` как `--merge` у checkout и
        // restore, алиас git вне перечня подкоманд.
        'GIT_ICASE_PATHSPECS=1 git checkout other -- .CLAUDE/RALPH/HOOKS.JSON',
        'GIT_ICASE_PATHSPECS=1 git restore --source=HEAD~1 .CLAUDE',
        'export GIT_ICASE_PATHSPECS=1; git restore --source=HEAD~1 .CLAUDE',
        'env GIT_ICASE_PATHSPECS=1 git restore --source=HEAD~1 .CLAUDE',
        'env GIT_GLOB_PATHSPECS=1 git restore --source=HEAD~1 .CLAUDE',
        'GIT_GLOB_PATHSPECS=1 git checkout other -- x',
        'GIT_WORK_TREE=.claude git checkout other -- ralph',
        "git checkout -m '*hooks.json'",
        "git checkout -m '*'",
        "git restore -m '*'",
        "git restore --worktree --staged -m '*'",
        "git co HEAD~1 '*hooks.json'",
        "git -c alias.co=checkout co HEAD~1 '*hooks.json'",
        // Без точки старта GNU find обходит `.` (ревью 16c, проход 3).
        "find -name 'hooks.j*' -exec cp /tmp/evil {} ;",
        'find -execdir cp /tmp/e {} ;',
        'find -delete',
        'find -L -delete',
    ])('git, find и tar с каталогом данных в петле — блок: %s', (command) => {
        const dir = contourTree();
        symlinkSync(path.join(dir, '.claude', 'ralph'), path.join(dir, 'r'));
        expect(codeOf({ op: 'exec', command, baseDir: dir }, loop)).toBe('contour-data');
    });

    it.each([
        'git status',
        'git diff .claude',
        'git add .claude',
        'git log -- .claude',
        'git checkout -b feat/x',
        'git restore src',
        'find .claude -name x',
        'tar -czf /tmp/o.tgz src',
        'tar -xf x.tar -C src',
        // Читающая программа в `-exec` — не замена (ревью 16c, проход 1).
        "find . -name '*.ts' -exec grep -l foo {} +",
        'find .claude -exec cat {} ;',
        "find -name '*.ts' -exec grep -l foo {} +",
        "git diff -- '*.json'",
        // Шаблон и магия вне pathspec — шаблон списка, refspec, текст сообщения (проход 2).
        "git branch --list 'feature/*'",
        "git tag -l 'v*'",
        "git merge -m 'merge [skip ci]' other",
        "git stash push -m 'wip?'",
        "git fetch origin '+refs/heads/*:refs/remotes/origin/*'",
        'find . -exec grep -l foo {} + -exec wc -l {} +',
        // Склейка коротких флагов с `m` у `stash` — сообщение; окружение без пути (проход 3).
        "git stash push -qm 'wip?'",
        'GIT_EDITOR=true git rebase --continue',
        "GIT_AUTHOR_NAME=x git commit -m 'fix: *'",
    ])('git, find и tar мимо данных — пропуск: %s', (command) => {
        const dir = contourTree();
        expect(codeOf({ op: 'exec', command, baseDir: dir }, loop)).toBeNull();
    });

    // Refspec у пуша — не pathspec: данных контура он не трогает, и судит его своё правило
    // пуша петли (#224), а не забор данных — иначе отказ назвал бы не ту причину.
    it.each(['git push origin HEAD', 'git push origin :old-branch'])(
        'пуш с refspec — отказ пуша петли, а не данных контура: %s',
        (command) => {
            const dir = contourTree();
            expect(codeOf({ op: 'exec', command, baseDir: dir }, loop)).toBe('loop-push');
        },
    );

    it('шаблон оболочки у переносящей команды раскрывается, как его раскроет оболочка', () => {
        const dir = contourTree();
        mkdirSync(path.join(dir, 'dist'));
        const exec = (command: string) => codeOf({ op: 'exec', command, baseDir: dir }, loop);
        expect(exec('mv .c?aude bak')).toBe('contour-data');
        expect(exec('mv .cl* bak')).toBe('contour-data');
        expect(exec('cp -r evil/. .c*')).toBe('contour-data');
        expect(exec('mv .claude/r[a]lph x')).toBe('contour-data');
        // Без явной точки шаблон имя с точкой не выбирает — как у оболочки без dotglob.
        expect(exec('mv * dist')).toBeNull();
        expect(exec('mv src/* dist')).toBeNull();
        // Псевдоним каталога данных, выбранный шаблоном, виден только по ФС.
        symlinkSync(path.join(dir, '.claude'), path.join(dir, 'al'));
        expect(exec('mv a? bak')).toBe('contour-data');
        expect(exec('mv * dist')).toBe('contour-data');
    });
});

describe('поиск — по множеству файлов, которые он может прочесть', () => {
    it.each([
        ['*.env', true],
        ['**/.env', true],
        ['.env*', true],
        ['{src/*.ts,.env}', true],
        ['src/**', true],
        ['[.]env', true],
        ['**/*.ts', false],
        ['*.{ts,js}', false],
        ['src/**/*.test.ts', false],
        ['.env.example', false],
        ['{unclosed', true],
        ['[unclosed', true],
    ])('шаблон %s может выбрать env-файл: %s', (glob, may) => {
        expect(globMayMatchEnv(glob)).toBe(may);
    });

    it('корень — env-файл, или шаблон его выбирает — блок; contentPattern не решает', () => {
        expect(codeOf({ op: 'search', root: '.env', baseDir: BASE }, { fsApi: emptyFs })).toBe(
            'secret-env',
        );
        expect(
            codeOf(
                { op: 'search', root: '.', pathGlob: '*.env', contentPattern: 'x', baseDir: BASE },
                { fsApi: emptyFs },
            ),
        ).toBe('secret-env');
        expect(
            codeOf(
                { op: 'search', root: '.', pathGlob: '**/*.ts', baseDir: BASE },
                { fsApi: emptyFs },
            ),
        ).toBeNull();
    });

    it('без шаблона — весь корень: env-файл внутри — блок, служебные каталоги не обходятся', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'guard-event-root-'));
        mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
        mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
        writeFileSync(path.join(dir, 'src', 'deep', 'a.ts'), '');
        writeFileSync(path.join(dir, 'node_modules', 'pkg', '.env'), '');
        const search = { op: 'search', root: '.', contentPattern: 'x', baseDir: dir } as const;
        expect(codeOf(search)).toBeNull();
        writeFileSync(path.join(dir, 'src', 'deep', 'app.env'), '');
        expect(codeOf(search)).toBe('secret-env');
        // Исключающий шаблон ничего не сужает: читается весь корень.
        expect(codeOf({ ...search, pathGlob: '!*.md' })).toBe('secret-env');
        // Корня нет — читать нечего.
        expect(codeOf({ ...search, root: 'missing' })).toBeNull();
    });

    it('симлинк внутри корня судится по цели: и без шаблона, и под шаблоном его имени', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'guard-event-search-link-'));
        const secrets = mkdtempSync(path.join(tmpdir(), 'guard-event-secrets-'));
        writeFileSync(path.join(secrets, '.env'), 'A=1\n');
        mkdirSync(path.join(dir, 'src'));
        writeFileSync(path.join(dir, 'src', 'a.ts'), '');
        const search = { op: 'search', root: '.', contentPattern: 'A', baseDir: dir } as const;
        expect(codeOf(search)).toBeNull();
        symlinkSync(path.join(secrets, '.env'), path.join(dir, 'src', 'config.ts'));
        expect(codeOf(search)).toBe('secret-env');
        expect(codeOf({ ...search, pathGlob: '**/*.ts' })).toBe('secret-env');
        expect(codeOf({ ...search, pathGlob: '*.md' })).toBeNull();
    });

    it('симлинк на каталог с секретом обходится; цикл каталогов не вешает обход', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'guard-event-search-dir-'));
        const secrets = mkdtempSync(path.join(tmpdir(), 'guard-event-secrets-'));
        writeFileSync(path.join(secrets, '.env'), 'A=1\n');
        symlinkSync(dir, path.join(dir, 'loop'));
        const search = { op: 'search', root: '.', contentPattern: 'A', baseDir: dir } as const;
        expect(codeOf(search)).toBeNull();
        symlinkSync(secrets, path.join(dir, 'vendor'));
        expect(codeOf(search)).toBe('secret-env');
        // Корень — симлинк на каталог с секретом.
        expect(codeOf({ ...search, root: secrets, baseDir: '/' })).toBe('secret-env');
    });

    it('критерии карточки: без фильтра по корню с .env, *.env, **/.env — блок', () => {
        const dir = contourTree();
        const search = { op: 'search', root: dir, contentPattern: 'A=', baseDir: dir } as const;
        expect(codeOf(search)).toBe('secret-env');
        expect(codeOf({ ...search, pathGlob: '*.env' })).toBe('secret-env');
        expect(codeOf({ ...search, pathGlob: '**/.env' })).toBe('secret-env');
        // По каталогу без секретов проходит; пустой шаблон содержимого — тоже чтение.
        expect(codeOf({ ...search, root: 'src' })).toBeNull();
        expect(codeOf({ ...search, contentPattern: '' })).toBe('secret-env');
    });

    it('поиск без шаблона содержимого отдаёт только имена — не чтение секрета (ревью 16c)', () => {
        const dir = contourTree();
        const names = { op: 'search', root: dir, baseDir: dir } as const;
        expect(codeOf(names)).toBeNull();
        expect(codeOf({ ...names, pathGlob: '**/*' })).toBeNull();
        expect(codeOf({ ...names, pathGlob: '**/.env' })).toBeNull();
        // Корень — сам env-файл: судится по-прежнему.
        expect(codeOf({ ...names, root: path.join(dir, '.env') })).toBe('secret-env');
    });

    it('корень, который не перечислить, — блок, а не догадка', () => {
        const many = Array.from({ length: 50_001 }, (_, i) => ({
            name: `f${i}.ts`,
            isDirectory: () => false,
        }));
        const fsApi = {
            ...emptyFs,
            statSync: () => ({ isDirectory: () => true }),
            readdirSync: () => many,
        };
        const v = one({ op: 'search', root: '.', contentPattern: 'x', baseDir: BASE }, { fsApi });
        expect(v).toMatchObject({ blocked: true, code: 'secret-env' });
        expect(v.reason).toMatch(/не перечислить/);
    });
});

describe('MCP — по политике контура', () => {
    const mcp = (tool: string, derived: TGuardOperation[] = []): TGuardOperation => ({
        op: 'mcp',
        server: 'forge',
        tool,
        effect: 'unknown',
        derived,
    });
    const declared = parseConsumerData(
        JSON.stringify({
            mcp: {
                writeAllowed: ['mcp__forge__CreateIssue'],
                tools: {
                    mcp__forge__CreateIssue: { effect: 'write' },
                    mcp__forge__GetIssue: { effect: 'read' },
                    mcp__forge__ListSecrets: { effect: 'read' },
                    mcp__forge__Upload: { effect: 'read' },
                },
            },
        }),
    );
    const legacy = parseConsumerData(JSON.stringify({ mcp: { writeAllowed: [] } }));

    it('заявленные эффекты: названное — да, не названное — нет, хоть и Get', () => {
        expect(codeOf(mcp('GetIssue'), { contour: declared })).toBeNull();
        expect(codeOf(mcp('CreateIssue'), { contour: declared })).toBeNull();
        expect(codeOf(mcp('GetRepository'), { contour: declared })).toBe('mcp-not-allowed');
        // Запрет ядра по слову сильнее записи эффекта.
        expect(codeOf(mcp('ListSecrets'), { contour: declared })).toBe('mcp-not-allowed');
    });

    it('данные прежней формы — прежнее правило до миграции', () => {
        expect(codeOf(mcp('GetRepository'), { contour: legacy })).toBeNull();
        expect(codeOf(mcp('DeleteRepository'), { contour: legacy })).toBe('mcp-not-allowed');
        expect(one(mcp('DeleteRepository'), { contour: legacy }).reason).toMatch(/прежней формы/);
    });

    it('производные эффекты параметров судятся как свои операции; сеть — всегда блок', () => {
        const opts = { contour: declared, fsApi: emptyFs };
        expect(codeOf(mcp('Upload', [{ op: 'read', path: '.env', baseDir: BASE }]), opts)).toBe(
            'secret-env',
        );
        expect(codeOf(mcp('Upload', [{ op: 'fetch', url: 'https://example.com' }]), opts)).toBe(
            'capability-unjudged',
        );
        expect(
            codeOf(mcp('Upload', [{ op: 'read', path: 'src/a.ts', baseDir: BASE }]), opts),
        ).toBeNull();
    });
});

describe('возможности, которые барьер не судит', () => {
    it('fetch: в петле — блок, в сессии человека — как до карточки', () => {
        const fetch: TGuardOperation = { op: 'fetch', url: 'https://example.com' };
        expect(codeOf(fetch, { loop: true })).toBe('capability-unjudged');
        expect(codeOf(fetch)).toBeNull();
    });

    // #225: субагент и отложенный ход раннер не видит — в петле запрещены, у человека свободны.
    it.each<[string, TGuardOperation, RegExp]>([
        ['субагент', { op: 'agent', parentSession: 's' }, /Субагент \(сессия s\)/],
        ['отложенный ход', { op: 'defer', what: 'ScheduleWakeup' }, /ScheduleWakeup/],
    ])('%s: в петле — loop-delegation с причиной, вне петли — пропуск', (_what, op, named) => {
        expect(codeOf(op, { loop: () => true })).toBe('loop-delegation');
        const reason = one(op, { loop: true }).reason;
        expect(reason).toMatch(named);
        expect(reason).toMatch(/раннер не видит/);
        expect(reason).toMatch(/закоммить сделанное/);
        expect(codeOf(op)).toBeNull();
        expect(codeOf(op, { loop: false })).toBeNull();
    });

    it('exec в петле держит забор данных контура и исполняющий вход git', () => {
        const exec = (command: string): TGuardOperation => ({ op: 'exec', command, baseDir: BASE });
        expect(codeOf(exec('echo {} > .claude/ralph/hooks.json'), { loop: true })).toBe(
            'contour-data',
        );
        expect(codeOf(exec('GIT_EXTERNAL_DIFF=tee git diff HEAD~1'), { loop: true })).toBe(
            'git-exec-input',
        );
        expect(codeOf(exec('git log --oneline'), { loop: true })).toBeNull();
    });
});

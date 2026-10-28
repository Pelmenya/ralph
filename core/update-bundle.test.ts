// Комплект PR смены ревизии на НАСТОЯЩЕМ git (#218): lock, данные контура и снимок инвентаря
// одним коммитом из одной базы; повтор узнаётся по комплекту; откат возвращает его целиком;
// сверка гейта PR ловит миграцию, меняющую решения guard. Инвентарь — подставной `listPageFn`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConsumerData } from '../.claude/hooks/consumer-data.cjs';
import { migrateMcpEffects } from '../.claude/hooks/mcp-effects.cjs';
import { CORE_LOCK_SCHEMA, formatCoreLock, type TCoreLock } from './core-install.ts';
import { supportedVersions } from './compat.ts';
import {
    commitBundleOnBranch,
    gitFileReader,
    updateBranchName,
    type TBaseView,
    type TRunArgvFn,
} from './core-update.ts';
import { MCP_INVENTORY_PATH, type THarnessMcpNames, type TListPageFn } from './mcp-inventory.ts';
import {
    CONTOUR_DATA_PATH,
    rollbackBundle,
    updateBundle,
    verifyMcpMigration,
    type TBundleResult,
} from './update-bundle.ts';

const OLD: TCoreLock = {
    schema: CORE_LOCK_SCHEMA,
    sha: 'a'.repeat(40),
    treeHash: `sha256:${'1'.repeat(64)}`,
    versions: supportedVersions(),
};
const NEW: TCoreLock = { ...OLD, sha: 'b'.repeat(40), treeHash: `sha256:${'2'.repeat(64)}` };
const BRANCH = updateBranchName(NEW.sha);

const f = (tool: string) => `mcp__forge__${tool}`;
const LEGACY = `${JSON.stringify(
    {
        mcp: {
            writeAllowed: [f('CreateIssue'), f('DiscardPullRequest')],
            neverExceptions: [f('DiscardPullRequest')],
        },
    },
    null,
    4,
)}\n`;
const SERVERS = `${JSON.stringify({ mcpServers: { forge: { command: 'forge-mcp' } } })}\n`;
const TOOLS = ['GetIssue', 'ListIssues', 'CreateIssue', 'DiscardPullRequest', 'ListSecrets'];

const pages =
    (tools: readonly string[]): TListPageFn =>
    () => ({
        version: '1.0.0',
        tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })),
        nextCursor: undefined,
    });

let work: string;
let consumer: string;
let origin: string;
let env: NodeJS.ProcessEnv;

const runArgv: TRunArgvFn = (file, args, opts = {}) => {
    const r = spawnSync(file, args, { encoding: 'utf8', input: opts.input, env: opts.env ?? env });
    if (r.status !== 0) throw new Error(`${file} ${args.join(' ')}: ${r.stderr}`);
    return opts.raw ? r.stdout : r.stdout.trim();
};
const git = (cwd: string, ...args: string[]) => runArgv('git', ['-C', cwd, ...args]);
const gitAt =
    (cwd: string) =>
    (args: string[], opts?: { raw?: boolean }): string =>
        runArgv('git', ['-C', cwd, ...args], opts);

function writeTree(files: Record<string, string>): void {
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(consumer, rel, '..'), { recursive: true });
        writeFileSync(join(consumer, rel), text);
    }
}
function commitAndPush(files: Record<string, string>, message: string): string {
    writeTree(files);
    git(consumer, 'add', '-A');
    git(consumer, 'commit', '--quiet', '-m', message);
    git(consumer, 'push', '--quiet', 'origin', 'main');
    return git(consumer, 'rev-parse', 'HEAD');
}

beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'update-bundle-'));
    const home = join(work, 'home');
    mkdirSync(home);
    env = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'sandbox',
        GIT_AUTHOR_EMAIL: 'sandbox@example.invalid',
        GIT_COMMITTER_NAME: 'sandbox',
        GIT_COMMITTER_EMAIL: 'sandbox@example.invalid',
    };
    origin = join(work, 'origin.git');
    consumer = join(work, 'app');
    git(work, 'init', '--quiet', '--bare', origin);
    mkdirSync(consumer);
    git(consumer, 'init', '--quiet', '-b', 'main');
    git(consumer, 'remote', 'add', 'origin', origin);
    commitAndPush(
        {
            '.ralph/core.lock': formatCoreLock(OLD),
            [CONTOUR_DATA_PATH]: LEGACY,
            '.mcp.json': SERVERS,
        },
        'потребитель',
    );
});
afterEach(() => {
    rmSync(work, { recursive: true, force: true });
});

function publish(
    bundleFn: (base: TBaseView) => TBundleResult,
    over: { runArgvFn?: TRunArgvFn; branch?: string } = {},
): { commit: string; lines: string[] } {
    const lines: string[] = [];
    const commit = commitBundleOnBranch({
        runArgvFn: over.runArgvFn ?? runArgv,
        consumerRoot: consumer,
        env,
        indexFile: join(work, 'tmp-index'),
        branch: over.branch ?? BRANCH,
        message: 'chore(core): ревизия ядра\n',
        buildFn: (base) => {
            const b = bundleFn(base);
            lines.push(...b.lines);
            return b.files;
        },
    });
    return { commit, lines };
}

const update =
    (tools: readonly string[] = TOOLS, at = '2026-10-28T10:00:00.000Z') =>
    (b: TBaseView) =>
        updateBundle({
            lock: NEW,
            base: b,
            listPageFn: pages(tools),
            collectedAt: at,
            harnesses: [],
        });

const show = (rev: string, path: string) => gitFileReader(gitAt(origin))(rev, path);

describe('update: комплект одним коммитом из одной базы', () => {
    it('данные старой формы: один коммит, три файла, база — свежий main', () => {
        const head = git(consumer, 'rev-parse', 'HEAD');
        const { commit } = publish(update());
        expect(git(origin, 'rev-parse', `${BRANCH}^`)).toBe(git(origin, 'rev-parse', 'main'));
        expect(git(origin, 'rev-list', '--count', `main..${BRANCH}`)).toBe('1');
        expect(git(origin, 'diff', '--name-only', 'main', commit).split('\n').sort()).toEqual(
            ['.ralph/core.lock', CONTOUR_DATA_PATH, MCP_INVENTORY_PATH].sort(),
        );
        expect(show(commit, '.ralph/core.lock')).toBe(formatCoreLock(NEW));
        const names = TOOLS.map(f).sort();
        expect(show(commit, CONTOUR_DATA_PATH)).toBe(migrateMcpEffects(LEGACY, names).text);
        expect(
            parseConsumerData(show(commit, CONTOUR_DATA_PATH) ?? '').mcp.tools.get(f('GetIssue')),
        ).toBe('read');
        // Дерево человека не тронуто.
        expect(git(consumer, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(consumer, 'status', '--porcelain')).toBe('');
    });

    it('база — свежий main, а не дерево человека: данные мигрируются из main', () => {
        const other = join(work, 'other');
        git(work, 'clone', '--quiet', '-b', 'main', origin, other);
        const fresh = LEGACY.replace(f('CreateIssue'), f('UpdateIssue'));
        writeFileSync(join(other, CONTOUR_DATA_PATH), fresh);
        git(other, 'commit', '--quiet', '-am', 'данные в main');
        git(other, 'push', '--quiet', 'origin', 'main');
        const { commit } = publish(update());
        const data = parseConsumerData(show(commit, CONTOUR_DATA_PATH) ?? '').mcp;
        expect(data.writeAllowed.has(f('UpdateIssue'))).toBe(true);
        expect(data.writeAllowed.has(f('CreateIssue'))).toBe(false);
    });

    it('повтор той же попытки распознаётся по комплекту, хоть снимок собран в другое время', () => {
        const first = publish(update()).commit;
        const pushes: string[][] = [];
        const spy: TRunArgvFn = (file, args, opts) => {
            if (args.includes('push')) pushes.push(args);
            return runArgv(file, args, opts);
        };
        expect(publish(update(TOOLS, '2026-10-29T00:00:00.000Z'), { runArgvFn: spy }).commit).toBe(
            first,
        );
        expect(pushes).toEqual([]);
    });

    it('ветка с тем же lock, но другими данными — не повтор, а отказ с именем файла', () => {
        const first = publish(update()).commit;
        // Тот же lock, но инвентарь у сервера другой — данные и снимок разошлись бы.
        expect(() => publish(update([...TOOLS, 'GetMilestone']))).toThrow(
            new RegExp(
                `другой ${CONTOUR_DATA_PATH.replace(/\./g, '\\.')}, ${MCP_INVENTORY_PATH.replace(/\./g, '\\.')}`,
            ),
        );
        expect(git(origin, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(first);
    });

    it.each([
        [
            'сервер не ответил',
            () => {
                throw new Error('ECONNREFUSED');
            },
        ],
        ['пустой инвентарь', pages([])],
    ] as [string, TListPageFn][])('%s — стоп с причиной, ветки нет', (_name, listPageFn) => {
        expect(() =>
            publish((b) =>
                updateBundle({ lock: NEW, base: b, listPageFn, collectedAt: 'x', harnesses: [] }),
            ),
        ).toThrow(/инвентарь MCP недоступен/);
        expect(git(origin, 'ls-remote', origin, `refs/heads/${BRANCH}`)).toBe('');
        expect(git(consumer, 'for-each-ref', 'refs/ralph')).toBe('');
    });

    it('данные с MCP-политикой без .mcp.json — стоп: инвентарь взять неоткуда', () => {
        git(consumer, 'rm', '--quiet', '.mcp.json');
        git(consumer, 'commit', '--quiet', '-m', 'без серверов');
        git(consumer, 'push', '--quiet', 'origin', 'main');
        expect(() => publish(update())).toThrow(/\.mcp\.json в базе нет/);
    });

    it('нет ни серверов, ни MCP-политики — комплект из одного lock, и это названо', () => {
        git(consumer, 'rm', '--quiet', '.mcp.json', CONTOUR_DATA_PATH);
        git(consumer, 'commit', '--quiet', '-m', 'без MCP');
        git(consumer, 'push', '--quiet', 'origin', 'main');
        const { commit, lines } = publish(update());
        expect(git(origin, 'diff', '--name-only', 'main', commit)).toBe('.ralph/core.lock');
        expect(lines.join('\n')).toMatch(/мигрировать нечего/);
    });
});

describe('update: свежесть уже мигрированных данных', () => {
    const migrate = (tools: readonly string[]) => migrateMcpEffects(LEGACY, tools.map(f)).text;

    it('чтение, которого у серверов больше нет, — стоп с именем', () => {
        commitAndPush({ [CONTOUR_DATA_PATH]: migrate([...TOOLS, 'GetGone']) }, 'мигрировано');
        expect(() => publish(update())).toThrow(new RegExp(`устарели.*${f('GetGone')}`));
    });

    it('новый инструмент — строка ⚠, данные не трогаются, снимок обновляется', () => {
        commitAndPush({ [CONTOUR_DATA_PATH]: migrate(TOOLS) }, 'мигрировано');
        const { commit, lines } = publish(update([...TOOLS, 'GetMilestone']));
        expect(lines.join('\n')).toMatch(new RegExp(`⚠ MCP ${f('GetMilestone')}`));
        expect(git(origin, 'diff', '--name-only', 'main', commit).split('\n').sort()).toEqual(
            ['.ralph/core.lock', MCP_INVENTORY_PATH].sort(),
        );
    });
});

describe('rollback: lock и данные возвращаются вместе', () => {
    function mergeUpdate(): string {
        const { commit } = publish(update());
        git(origin, 'update-ref', 'refs/heads/main', commit);
        git(consumer, 'pull', '--quiet', '--ff-only', 'origin', 'main');
        return commit;
    }

    it('после отката lock, данные и снимок — прежние, одним коммитом', () => {
        mergeUpdate();
        const { commit, lines } = publish((b) => rollbackBundle({ lock: OLD, base: b }), {
            branch: 'ralph/rollback-test',
        });
        expect(git(origin, 'rev-list', '--count', `main..${commit}`)).toBe('1');
        // Байт в байт с родителем: обрезанный блоб клал бы данные без концевого \n (ревью 16c3).
        expect(show(commit, '.ralph/core.lock')).toBe(formatCoreLock(OLD));
        expect(show(commit, CONTOUR_DATA_PATH)).toBe(LEGACY);
        expect(LEGACY.endsWith('}\n')).toBe(true);
        expect(show(commit, MCP_INVENTORY_PATH)).toBeNull();
        expect(lines.join('\n')).toMatch(/откат его убирает/);
    });

    it('данные, правленые после обновления, — отказ: откат вернул бы и эту правку', () => {
        const merged = mergeUpdate();
        const edited = (show(merged, CONTOUR_DATA_PATH) ?? '').replace('"read"', '"read" ');
        commitAndPush({ [CONTOUR_DATA_PATH]: `${edited}\n` }, 'правка данных');
        expect(() =>
            publish((b) => rollbackBundle({ lock: OLD, base: b }), { branch: 'ralph/rb' }),
        ).toThrow(/правлен после смены ревизии/);
    });

    it('обновление без данных: откат меняет только lock', () => {
        git(consumer, 'rm', '--quiet', '.mcp.json', CONTOUR_DATA_PATH);
        git(consumer, 'commit', '--quiet', '-m', 'без MCP');
        git(consumer, 'push', '--quiet', 'origin', 'main');
        mergeUpdate();
        const { commit } = publish((b) => rollbackBundle({ lock: OLD, base: b }), {
            branch: 'ralph/rb',
        });
        expect(git(origin, 'diff', '--name-only', 'main', commit)).toBe('.ralph/core.lock');
    });
});

describe('гейт PR: сверка миграции по снимку и базе, без сети', () => {
    const verify = (head: string) =>
        verifyMcpMigration({
            read: gitFileReader(gitAt(origin)),
            base: git(origin, 'rev-parse', 'main'),
            head,
            harnesses: [],
        });

    it('честная миграция проходит', () => {
        const { commit } = publish(update());
        const r = verify(commit);
        expect(r.problems).toEqual([]);
        expect(r.lines.join('\n')).toMatch(/эквивалентна/);
    });

    // От противного: данные в ветке PR поправлены после публикации — чтение снято, а
    // запрещённое ядром слово получило запись мимо вычета.
    it('разрешения разошлись с прежним правилом — отказ с именем инструмента', () => {
        const { commit } = publish(update());
        const other = join(work, 'tamper');
        git(work, 'clone', '--quiet', '-b', BRANCH, origin, other);
        const raw = JSON.parse(show(commit, CONTOUR_DATA_PATH) ?? '') as {
            mcp: { tools: Record<string, unknown> };
        };
        delete raw.mcp.tools[f('GetIssue')];
        writeFileSync(join(other, CONTOUR_DATA_PATH), `${JSON.stringify(raw, null, 4)}\n`);
        git(other, 'commit', '--quiet', '-am', 'правка данных');
        git(other, 'push', '--quiet', 'origin', BRANCH);
        const r = verify(git(other, 'rev-parse', 'HEAD'));
        expect(r.problems).toEqual([
            `решение по ${f('GetIssue')} разошлось с прежним: был разрешён, стал запрещён`,
        ]);
    });

    it('эффекты заявлены без снимка — отказ', () => {
        const raw = migrateMcpEffects(LEGACY, TOOLS.map(f)).text;
        const head = commitAndPush({ [CONTOUR_DATA_PATH]: raw }, 'без снимка');
        const r = verifyMcpMigration({
            read: gitFileReader(gitAt(origin)),
            base: `${head}^`,
            head,
            harnesses: [],
        });
        expect(r.problems.join('\n')).toMatch(/снимка .* нет/);
    });

    it('данные прежней формы — сверять нечего, это названо', () => {
        const r = verify(git(origin, 'rev-parse', 'main'));
        expect(r).toEqual({ problems: [], lines: [expect.stringMatching(/прежней формы/)] });
    });
});

describe('комплект на подставной базе: отказы и края', () => {
    const view = (files: Record<string, string>, lastChange: string | null = null): TBaseView => ({
        sha: 'f'.repeat(40),
        read: (p) => files[p] ?? null,
        lastChange: () => lastChange,
    });
    const build = (
        files: Record<string, string>,
        tools: readonly string[] = TOOLS,
        harnesses: THarnessMcpNames[] = [],
    ) =>
        updateBundle({
            lock: NEW,
            base: view(files),
            listPageFn: pages(tools),
            collectedAt: '2026-10-28T10:00:00.000Z',
            harnesses,
        });

    it('битые данные базы — отказ с причиной разбора', () => {
        expect(() => build({ [CONTOUR_DATA_PATH]: '{"mcp": []}', '.mcp.json': SERVERS })).toThrow(
            /данные контура базы не разобрались.*mcp — не объект/,
        );
    });

    it('битый .mcp.json — инвентарь недоступен', () => {
        expect(() => build({ [CONTOUR_DATA_PATH]: LEGACY, '.mcp.json': '{' })).toThrow(
            /инвентарь MCP недоступен.*не JSON/,
        );
    });

    it('данных нет, серверы есть — файл данных заводится с чтениями инвентаря', () => {
        const r = build({ '.mcp.json': SERVERS });
        const data = r.files.find((x) => x.path === CONTOUR_DATA_PATH);
        expect(parseConsumerData(data?.text ?? '').mcp.tools.get(f('ListIssues'))).toBe('read');
    });

    it('снимок базы с тем же содержимым — в комплект не едет', () => {
        const first = build({ [CONTOUR_DATA_PATH]: LEGACY, '.mcp.json': SERVERS });
        const snap = first.files.find((x) => x.path === MCP_INVENTORY_PATH)?.text ?? '';
        const again = build({
            [CONTOUR_DATA_PATH]: LEGACY,
            '.mcp.json': SERVERS,
            [MCP_INVENTORY_PATH]: snap,
        });
        expect(again.files.map((x) => x.path)).not.toContain(MCP_INVENTORY_PATH);
        // Битый снимок базы годным не считается — едет свежий.
        const broken = build({
            [CONTOUR_DATA_PATH]: LEGACY,
            '.mcp.json': SERVERS,
            [MCP_INVENTORY_PATH]: '{}',
        });
        expect(broken.files.map((x) => x.path)).toContain(MCP_INVENTORY_PATH);
    });

    // Ревью 16c3: свежий снимок ехал в PR без checkSnapshot.
    it('свежий снимок с неканоническим именем или неполным переводом — отказ до пуша', () => {
        expect(() =>
            build({ [CONTOUR_DATA_PATH]: LEGACY, '.mcp.json': SERVERS }, [...TOOLS, 'a__b']),
        ).toThrow(/свежий снимок инвентаря MCP не прошёл проверку.*не каноническое/);
        expect(() =>
            build({ [CONTOUR_DATA_PATH]: LEGACY, '.mcp.json': SERVERS }, TOOLS, [
                { harness: 'h', mcpNames: { x_GetIssue: { server: 'forge', tool: 'GetIssue' } } },
            ]),
        ).toThrow(/не прошёл проверку.*h: у mcp__forge__ListIssues нет перевода/);
    });

    it('rollback без коммита lock в истории — отказ', () => {
        expect(() => rollbackBundle({ lock: OLD, base: view({}) })).toThrow(/откатить не по чему/);
    });

    describe('verify-mcp', () => {
        const migrated = migrateMcpEffects(LEGACY, TOOLS.map(f)).text;
        const snapText = (() => {
            const r = build({ [CONTOUR_DATA_PATH]: LEGACY, '.mcp.json': SERVERS });
            return r.files.find((x) => x.path === MCP_INVENTORY_PATH)?.text ?? '';
        })();
        const verifyOn = (base: Record<string, string>, head: Record<string, string>) =>
            verifyMcpMigration({
                read: (rev, p) => (rev === 'base' ? base : head)[p] ?? null,
                base: 'base',
                head: 'head',
                harnesses: [],
            });
        const full = { [CONTOUR_DATA_PATH]: migrated, '.mcp.json': SERVERS };

        it.each([
            ['данных нет', {}, [], /сверять нечего/],
            ['битые данные', { [CONTOUR_DATA_PATH]: '[' }, [/не разобрались/], null],
            ['нет .mcp.json', { [CONTOUR_DATA_PATH]: migrated }, [/\.mcp\.json нет/], null],
            [
                'битый .mcp.json',
                { [CONTOUR_DATA_PATH]: migrated, '.mcp.json': '{}' },
                [/нет объекта mcpServers/],
                null,
            ],
            [
                'битый снимок',
                { ...full, [MCP_INVENTORY_PATH]: '{"schemaVersion": 9}' },
                [/незнакомая версия формата/],
                null,
            ],
        ] as [string, Record<string, string>, RegExp[], RegExp | null][])(
            '%s',
            (_name, head, problems, line) => {
                const r = verifyOn({ [CONTOUR_DATA_PATH]: LEGACY }, head);
                expect(r.problems).toEqual(problems.map((p) => expect.stringMatching(p) as string));
                if (line) expect(r.lines.join('\n')).toMatch(line);
            },
        );

        it('данные уже были мигрированы: сверяется свежесть, чтение вне снимка — отказ', () => {
            const stale = migrateMcpEffects(LEGACY, [...TOOLS, 'GetGone'].map(f)).text;
            const head = { ...full, [CONTOUR_DATA_PATH]: stale, [MCP_INVENTORY_PATH]: snapText };
            expect(verifyOn({ [CONTOUR_DATA_PATH]: migrated }, head).problems).toEqual([
                `чтение ${f('GetGone')} в mcp.tools, а в снимке инвентаря его нет`,
            ]);
            const fresh = { ...full, [MCP_INVENTORY_PATH]: snapText };
            expect(verifyOn({ [CONTOUR_DATA_PATH]: migrated }, fresh)).toEqual({
                problems: [],
                lines: [expect.stringMatching(/чтения сверены со снимком/)],
            });
        });

        // Ревью 16c3: при мигрированной базе правка решений проходила молча под ✅.
        it('база с эффектами: изменённое решение названо ⚠ — держит его ship человека', () => {
            const raw = JSON.parse(migrated) as { mcp: { tools: Record<string, unknown> } };
            delete raw.mcp.tools[f('GetIssue')];
            const head = {
                ...full,
                [CONTOUR_DATA_PATH]: JSON.stringify(raw),
                [MCP_INVENTORY_PATH]: snapText,
            };
            const r = verifyOn({ [CONTOUR_DATA_PATH]: migrated }, head);
            expect(r.problems).toEqual([]);
            expect(r.lines[1]).toMatch(
                new RegExp(`^⚠ PR меняет решения guard.*ship.*${f('GetIssue')}`),
            );
            const back = verifyOn(
                { [CONTOUR_DATA_PATH]: migrated },
                {
                    ...full,
                    [CONTOUR_DATA_PATH]: LEGACY,
                },
            );
            expect(back.lines).toEqual([
                expect.stringMatching(/^⚠ .*возвращает эффекты MCP к префиксу/),
            ]);
        });
    });
});

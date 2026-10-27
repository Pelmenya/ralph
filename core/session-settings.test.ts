// Settings сессии из доверенных источников (Фаза 12, задача 101). Три критерия карточки:
//   1. правка settings или хука в дереве сессии не меняет настроек, с которыми сессия
//      запущена, — живые хуки канона против подложного дерева сессии;
//   2. отключённый или упавший хук — проба красная, settings не записан;
//   3. собранный settings не теряет остальных хуков потребителя.
// И контракт запуска (#132): хуки из установки получают `RALPH_CORE_SHA` — ревизию ядра —
// в своей команде, и проба на собранном идёт с ним: хук другой ревизии — старт отменён.
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coreIsRepoRoot } from '../tests/core-repo.ts';
import { stripComments } from '../tests/strip-comments.ts';
import { hooksFor, type TRunHookFn } from './guard-probe.ts';
import {
    CANON_SESSION_HOOKS,
    CORE_SHA_ENV,
    HOOKS_DATA_ENV,
    buildSessionSettings,
    canonHookCommand,
    coreShaPolicy,
    describeSessionSettingsStart,
    doctorStartChecks,
    prepareSessionSettings,
    readHumanSettings,
    resolveCoreSha,
    sessionStartChecks,
    shellQuote,
    type TGitInDirFn,
} from './session-settings.ts';

const CANON_ROOT = path.resolve(import.meta.dirname, '..');
/** Значение контракта в юнитах — только форма SHA. */
const SHA = 'a'.repeat(40);

/** Живой git в каталоге — как боевой, но мимо предохранителя побочек. */
const liveGit: TGitInDirFn = (dir, args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Живой запуск хука — как боевой `runHook`, но мимо предохранителя побочек. */
const spawnHook: TRunHookFn = (hook, payload, projectDir) => {
    const r = spawnSync('sh', ['-c', hook.command], {
        cwd: projectDir,
        input: payload,
        encoding: 'utf-8',
        timeout: hook.timeoutSec * 1000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    return { status: r.status, stderr: r.stderr ?? '' };
};

const enoent = () => {
    throw Object.assign(new Error('нет файла'), { code: 'ENOENT' });
};

const CONSUMER_HOOKS = {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node start.cjs' }] }],
    PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node post.cjs' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node own-guard.cjs' }] }],
};

describe('сборка settings сессии', () => {
    it('канонические хуки — из каталога ядра, данные контура — из дерева человека', () => {
        const s = buildSessionSettings({
            productRoot: '/path/to/core',
            humanRoot: '/path/to/app',
            coreSha: SHA,
            humanSettings: {},
        });
        const pre = (s.hooks as Record<string, unknown[]>).PreToolUse;
        expect(pre).toHaveLength(CANON_SESSION_HOOKS.length);
        const guard = hooksFor(s, 'Bash').map((h) => h.command);
        const env = `${CORE_SHA_ENV}='${SHA}' ${HOOKS_DATA_ENV}='/path/to/app/.claude/ralph/hooks.json'`;
        expect(guard).toEqual([
            `${env} node '/path/to/core/.claude/hooks/guard.cjs'`,
            `${env} node '/path/to/core/.claude/hooks/skill-barrier.cjs'`,
        ]);
        expect(JSON.stringify(s)).not.toContain('CLAUDE_PROJECT_DIR');
    });

    it('собранный settings не теряет остальных хуков потребителя', () => {
        const human = { permissions: { allow: ['Bash(npm test)'] }, hooks: CONSUMER_HOOKS };
        const s = buildSessionSettings({
            productRoot: '/c',
            humanRoot: '/h',
            coreSha: SHA,
            humanSettings: human,
        });
        const hooks = s.hooks as Record<string, unknown[]>;
        expect(hooks.SessionStart).toEqual(CONSUMER_HOOKS.SessionStart);
        expect(hooks.PostToolUse).toEqual(CONSUMER_HOOKS.PostToolUse);
        expect(hooks.PreToolUse[0]).toEqual(CONSUMER_HOOKS.PreToolUse[0]);
        expect(hooks.PreToolUse).toHaveLength(1 + CANON_SESSION_HOOKS.length);
        expect(s.permissions).toEqual(human.permissions);
        // Сборка не правит прочитанное: списки потребителя копируются.
        expect(CONSUMER_HOOKS.PreToolUse).toHaveLength(1);
    });

    it('выключатель хуков закреплён false — даже если потребитель его включил', () => {
        // Стенд Фазы 11: проектный `disableAllHooks` снимает и внешний хук, а настройки
        // командной строки старше проектных.
        for (const humanSettings of [{}, { disableAllHooks: true }]) {
            const s = buildSessionSettings({
                productRoot: '/c',
                humanRoot: '/h',
                coreSha: SHA,
                humanSettings,
            });
            expect(s.disableAllHooks).toBe(false);
        }
    });

    it('matcher канонических хуков совпадает с проводкой канона', () => {
        const wiring = JSON.parse(
            readFileSync(path.join(CANON_ROOT, '.claude', 'settings.json'), 'utf-8'),
        ) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
        const canon = wiring.hooks.PreToolUse.map((e) => ({
            file: path.basename(e.hooks[0].command.replace(/"$/, '')),
            matcher: e.matcher,
        }));
        expect(CANON_SESSION_HOOKS.map(({ file, matcher }) => ({ file, matcher }))).toEqual(canon);
    });

    it('путь с кавычкой не размыкает команду хука', () => {
        expect(shellQuote("/a'b")).toBe(`'/a'\\''b'`);
        const r = spawnSync('sh', ['-c', `printf %s ${shellQuote("/a'b c")}`], {
            encoding: 'utf-8',
        });
        expect(r.stdout).toBe("/a'b c");
        expect(canonHookCommand('/c', 'guard.cjs', '/h', SHA)).toContain("node '/c/.claude/hooks/");
    });
});

describe('settings дерева человека — fail-closed', () => {
    it('файла нет — пустой объект: только канонические хуки', () => {
        expect(readHumanSettings('/h', enoent)).toEqual({});
    });

    it.each([
        ['{ битый', 'не JSON'],
        ['[]', 'не объект'],
        ['{"hooks": []}', 'hooks — не объект'],
        ['{"hooks": {"PreToolUse": {}}}', 'hooks.PreToolUse — не список'],
    ])('%s — исключение «%s», а не настройки без хуков потребителя', (text, what) => {
        expect(() => readHumanSettings('/h', () => text)).toThrow(what);
    });

    it('файл не читается — исключение', () => {
        expect(() =>
            readHumanSettings('/h', () => {
                throw Object.assign(new Error('нет прав'), { code: 'EACCES' });
            }),
        ).toThrow('нет прав');
    });
});

describe('ревизия ядра для контракта — fail-closed', () => {
    const git =
        (answers: Record<string, ReturnType<TGitInDirFn>>): TGitInDirFn =>
        (_dir, args) =>
            answers[args.join(' ')] ?? { status: 128, stdout: '', stderr: 'неожиданный вызов' };
    const ok = (stdout: string) => ({ status: 0, stdout: `${stdout}\n`, stderr: '' });
    const id = (p: string) => p;

    it('клон ядра — SHA его HEAD', () => {
        const r = resolveCoreSha('/core', {
            gitFn: git({
                'rev-parse --show-toplevel': ok('/core'),
                'rev-parse --verify HEAD^{commit}': ok(SHA),
            }),
            realpathFn: id,
        });
        expect(r).toEqual({ ok: true, sha: SHA });
    });

    it('не git-репозиторий — отказ с причиной, а не сессии под блоком каждого вызова', () => {
        const r = resolveCoreSha('/core', {
            gitFn: git({
                'rev-parse --show-toplevel': { status: 128, stdout: '', stderr: 'not a git repo' },
            }),
            realpathFn: id,
        });
        expect(!r.ok && r.reason).toMatch(/не git-репозиторий \(not a git repo\).*RALPH_CORE_SHA/s);
    });

    it('ядро внутри ЧУЖОГО репозитория — отказ: HEAD соседа не ревизия ядра', () => {
        const r = resolveCoreSha('/path/to/core', {
            gitFn: git({
                'rev-parse --show-toplevel': ok('/path/to'),
                'rev-parse --verify HEAD^{commit}': ok(SHA),
            }),
            realpathFn: id,
        });
        expect(!r.ok && r.reason).toMatch(/корень репозитория — \/path\/to,/);
    });

    it.each([
        ['HEAD не читается', { status: 128, stdout: '', stderr: 'unknown revision' }],
        ['HEAD не полный SHA', ok('abc123')],
    ])('%s — отказ', (_what, head) => {
        const r = resolveCoreSha('/core', {
            gitFn: git({
                'rev-parse --show-toplevel': ok('/core'),
                'rev-parse --verify HEAD^{commit}': head,
            }),
            realpathFn: id,
        });
        expect(!r.ok && r.reason).toMatch(/HEAD не читается/);
    });

    it('каталог не разрешается — отказ, а не исключение', () => {
        const r = resolveCoreSha('/core', {
            gitFn: git({ 'rev-parse --show-toplevel': ok('/core') }),
            realpathFn: () => {
                throw new Error('ENOENT');
            },
        });
        expect(!r.ok && r.reason).toMatch(/ENOENT/);
    });

    it('живой git: клон — SHA, каталог без репозитория — отказ', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'session-settings-sha-'));
        try {
            expect(resolveCoreSha(dir, { gitFn: liveGit }).ok).toBe(false);
            const repo = initRepo(dir);
            expect(resolveCoreSha(dir, { gitFn: liveGit })).toEqual({ ok: true, sha: repo });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** Репозиторий в каталоге с одним коммитом всего содержимого; возвращает SHA коммита. */
function initRepo(dir: string): string {
    const run = (...args: string[]) => {
        const r = spawnSync('git', ['-C', dir, ...args], {
            encoding: 'utf-8',
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 't',
                GIT_AUTHOR_EMAIL: 't@example.com',
                GIT_COMMITTER_NAME: 't',
                GIT_COMMITTER_EMAIL: 't@example.com',
            },
        });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
    };
    run('init', '-q');
    writeFileSync(path.join(dir, '.keep'), '');
    run('add', '-A');
    run('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'core');
    return run('rev-parse', 'HEAD');
}

describe('подготовка перед сессией', () => {
    const roots = {
        productRoot: '/c',
        humanRoot: '/h',
        coreSha: SHA,
        sessionTree: '/s',
        outPath: '/r/s.json',
    };

    it('проба прошла — файл записан и путь отдан', () => {
        const written: [string, string][] = [];
        const r = prepareSessionSettings(roots, {
            readFileFn: () => JSON.stringify({ hooks: CONSUMER_HOOKS }),
            writeFileFn: (p, t) => written.push([p, t]),
            runHookFn: (hook, payload) => ({
                status:
                    hook.command.includes('guard.cjs') && !payload.includes('git status') ? 2 : 0,
                stderr: '',
            }),
        });
        expect(r).toEqual({ ok: true, path: '/r/s.json' });
        expect(written).toHaveLength(1);
        expect(JSON.parse(written[0][1]).hooks.SessionStart).toEqual(CONSUMER_HOOKS.SessionStart);
    });

    it('хук не блокирует — отказ с причиной, файл НЕ записан', () => {
        const written: string[] = [];
        const r = prepareSessionSettings(roots, {
            readFileFn: enoent,
            writeFileFn: (p) => written.push(p),
            runHookFn: () => ({ status: 0, stderr: '' }),
        });
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(/Проба барьера перед сессией не прошла/);
        expect(written).toEqual([]);
    });

    it('битые настройки человека — отказ, проба не гоняется', () => {
        let runs = 0;
        const r = prepareSessionSettings(roots, {
            readFileFn: () => '{ битый',
            writeFileFn: () => {},
            runHookFn: () => {
                runs++;
                return { status: 2, stderr: '' };
            },
        });
        expect(!r.ok && r.reason).toMatch(/не собран.*не JSON/);
        expect(runs).toBe(0);
    });

    it('запись не удалась — отказ с путём', () => {
        const r = prepareSessionSettings(roots, {
            readFileFn: enoent,
            writeFileFn: () => {
                throw new Error('ENOSPC');
            },
            runHookFn: (hook, payload) => ({
                status:
                    hook.command.includes('guard.cjs') && !payload.includes('git status') ? 2 : 0,
                stderr: '',
            }),
        });
        expect(!r.ok && r.reason).toMatch(/не записан в \/r\/s\.json \(ENOSPC\)/);
    });
});

// Срок — как у живых наборов в tests/: каждая проба спавнит настоящие `sh → node` на хук,
// установка ядра — git. Локально это доли секунды, а облачный раннер площадки под нагрузкой
// сьюта выбирал дефолтные 5 с на одном кейсе (прогон 157), при исправном коде.
describe('живые хуки: дерево сессии не решает за раннер', { timeout: 30_000 }, () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const tmp = (name: string) => {
        const d = mkdtempSync(path.join(tmpdir(), `session-settings-${name}-`));
        dirs.push(d);
        return d;
    };

    /** Дерево сессии, которое PR «ослабил»: выключатель хуков и guard, пропускающий всё. */
    const weakenedSessionTree = () => {
        const s = tmp('session');
        mkdirSync(path.join(s, '.claude', 'hooks'), { recursive: true });
        writeFileSync(path.join(s, '.claude', 'hooks', 'guard.cjs'), 'process.exit(0);');
        writeFileSync(
            path.join(s, '.claude', 'settings.json'),
            JSON.stringify({ disableAllHooks: true, hooks: {} }),
        );
        return s;
    };

    const prepare = (productRoot: string, sessionTree: string, coreSha = SHA) => {
        const humanRoot = tmp('human');
        const out = path.join(tmp('runtime'), 'session-settings.json');
        const r = prepareSessionSettings(
            { productRoot, humanRoot, coreSha, sessionTree, outPath: out },
            { writeFileFn: (p, t) => writeFileSync(p, t), runHookFn: spawnHook },
        );
        return { r, out, humanRoot };
    };

    /**
     * Установка ядра: настоящие хуки канона в своём git-репозитории на одном коммите.
     * Хуки берутся копией, а не из дерева канона: оно может быть грязным под правкой, и
     * сверка с HEAD краснела бы от правки, а не от кода.
     */
    const installedCore = () => {
        const p = realpathSync(tmp('installed'));
        cpSync(path.join(CANON_ROOT, '.claude', 'hooks'), path.join(p, '.claude', 'hooks'), {
            recursive: true,
        });
        return { root: p, sha: initRepo(p) };
    };

    it.skipIf(!coreIsRepoRoot())(
        'правка settings и хука в дереве сессии не меняет собранного settings, проба зелёная',
        () => {
            const core = installedCore();
            const clean = tmp('clean');
            const weakened = weakenedSessionTree();
            const a = prepare(core.root, clean, core.sha);
            const b = prepare(core.root, weakened, core.sha);
            expect(a.r).toEqual({ ok: true, path: a.out });
            expect(b.r).toEqual({ ok: true, path: b.out });
            const sa = readFileSync(a.out, 'utf-8').replaceAll(a.humanRoot, '<h>');
            const sb = readFileSync(b.out, 'utf-8').replaceAll(b.humanRoot, '<h>');
            expect(sb).toBe(sa);
            expect(sb).not.toContain(weakened);
            expect(JSON.parse(sb).disableAllHooks).toBe(false);
        },
    );

    // #132: проба идёт с тем же контрактом, что сессия. Хук установки, разошедшийся с
    // ревизией, блокирует всё — безобидное тоже, — и раннер не стартует.
    it.skipIf(!coreIsRepoRoot())('хук другой ревизии — проба красная, settings не записан', () => {
        for (const tamper of [
            (hooks: string) =>
                writeFileSync(
                    path.join(hooks, 'guard-rules.cjs'),
                    `${readFileSync(path.join(hooks, 'guard-rules.cjs'), 'utf-8')}\n// правка\n`,
                ),
            (hooks: string) => writeFileSync(path.join(hooks, 'extra.cjs'), ''),
        ]) {
            const core = installedCore();
            tamper(path.join(core.root, '.claude', 'hooks'));
            const { r, out } = prepare(core.root, tmp('session'), core.sha);
            expect(r.ok).toBe(false);
            expect(!r.ok && r.reason).toMatch(/безобидная команда.*не ревизия ядра/s);
            expect(() => readFileSync(out)).toThrow();
        }
    });

    it.skipIf(!coreIsRepoRoot())('контракт другой ревизии — проба красная', () => {
        const core = installedCore();
        const { r } = prepare(core.root, tmp('session'), 'b'.repeat(40));
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(/безобидная команда/);
    });

    /** Каталог «ядра» с подменёнными хуками: guard задан телом, барьер скиллов пропускает. */
    const productWith = (guardBody: string | null) => {
        const p = tmp('product');
        mkdirSync(path.join(p, '.claude', 'hooks'), { recursive: true });
        if (guardBody !== null)
            writeFileSync(path.join(p, '.claude', 'hooks', 'guard.cjs'), guardBody);
        writeFileSync(path.join(p, '.claude', 'hooks', 'skill-barrier.cjs'), 'process.exit(0);');
        return p;
    };

    it.each([
        ['упал исключением (код 1)', 'throw new Error("сломан");'],
        ['отключён: пропускает всё', 'process.exit(0);'],
        ['файла нет', null],
    ])('хук %s — проба красная, settings не записан', (_what, body) => {
        const { r, out } = prepare(productWith(body), tmp('session'));
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(/рекурсивное удаление/);
        expect(() => readFileSync(out)).toThrow();
    });

    it('исправный подменённый хук — проба зелёная: красное выше — от хука, а не от сборки', () => {
        const { r } = prepare(
            productWith(
                'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(s.includes("git status")?0:2));',
            ),
            tmp('session'),
        );
        expect(r.ok).toBe(true);
    });
});

// Проводку в оркестраторе сторожит текст: `main()` поднимает лок, worktree и монитор, и
// гонять его в сьюте нельзя. Ловит спавн `claude` мимо собранного settings и пробу, уехавшую
// из-под `if (DRY)` или после спавна.
describe('проводка в оркестраторе', () => {
    const source = stripComments(
        readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8'),
    );

    it('каждый спавн claude-сессии идёт с settings, собранным после проверки DRY', () => {
        const spawns = [...source.matchAll(/return spawnClaude\(cmdArgs,/g)];
        expect(spawns.length).toBeGreaterThan(0);
        for (const m of spawns) {
            const fnStart = source.lastIndexOf('function ', m.index);
            const body = source.slice(fnStart, m.index);
            const dry = body.lastIndexOf('if (DRY) return');
            const push = body.lastIndexOf('cmdArgs.push(...sessionSettingsArgs())');
            expect(dry, body.slice(0, 60)).toBeGreaterThan(-1);
            expect(push, body.slice(0, 60)).toBeGreaterThan(dry);
        }
    });

    it('main(): корни settings — ядро и дерево человека, ставятся после пробы на собранном', () => {
        const main = source.slice(source.indexOf('function main('));
        const roots = main.indexOf('humanRoot: roots.consumerRoot');
        const probe = main.indexOf('settings: builtSettings');
        const set = main.indexOf('sessionSettingsRoots = settingsRoots');
        expect(main).toMatch(
            /productRoot: PRODUCT_DIR, humanRoot: roots\.consumerRoot, sessionTree, coreSha/,
        );
        expect(roots).toBeGreaterThan(-1);
        expect(probe).toBeGreaterThan(roots);
        expect(set).toBeGreaterThan(probe);
    });

    it('main(): ревизия ядра для контракта определяется до сборки, отказ — по политике', () => {
        const main = source.slice(source.indexOf('function main('));
        const sha = main.indexOf('resolveCoreSha(PRODUCT_DIR)');
        expect(sha).toBeGreaterThan(-1);
        const near = main.slice(sha - 60, sha + 300);
        expect(near).toMatch(
            /coreShaPolicy\(resolveCoreSha\(PRODUCT_DIR\), coreCheck\.status === 'ok'\)/,
        );
        expect(near).toMatch(/policy\.kind === 'refuse'\) fail\(policy\.reason\)/);
        expect(near).toMatch(/else log\(`⚠ \$\{policy\.note\}`\)/);
        expect(sha).toBeLessThan(main.indexOf('humanRoot: roots.consumerRoot'));
    });
});

describe('sessionStartChecks — проверки старта для --doctor', () => {
    it('ревизия определилась и settings читаются — две зелёные строки', () => {
        expect(
            sessionStartChecks({
                productRoot: '/core',
                humanRoot: '/app',
                installed: true,
                resolveCoreShaFn: () => ({ ok: true, sha: SHA }),
                readHumanSettingsFn: () => ({}),
            }),
        ).toEqual([
            { ok: true, line: `ревизия ядра /core: ${SHA} (${CORE_SHA_ENV})` },
            { ok: true, line: 'settings дерева человека /app читаются' },
        ]);
    });
    it('отказ каждой проверки — своя красная строка, вторая не прячется за первой', () => {
        const lines = sessionStartChecks({
            productRoot: '/core',
            humanRoot: '/app',
            installed: true,
            resolveCoreShaFn: () => ({ ok: false, reason: 'не git-репозиторий', why: 'нет .git' }),
            readHumanSettingsFn: () => {
                throw new Error('/app/.claude/settings.json — не JSON');
            },
        });
        expect(lines).toEqual([
            { ok: false, line: 'не git-репозиторий' },
            {
                ok: false,
                line: expect.stringMatching(
                    /^Settings сессии не собран: .*не JSON — старт будет отменён/,
                ),
            },
        ]);
    });
});

// Ревью Фазы 12: копия ядра у потребителя (`.claude/ralph`) с `roots` после #132 не
// стартовала вовсе — своего git у неё нет. Стоп остаётся только у ядра из установки.
describe('coreShaPolicy — ревизия ядра не определилась', () => {
    const refused = { ok: false as const, reason: 'старт отменён', why: 'не git-репозиторий' };
    it('ревизия есть — контракт', () => {
        expect(coreShaPolicy({ ok: true, sha: SHA }, true)).toEqual({ kind: 'contract', sha: SHA });
        expect(coreShaPolicy({ ok: true, sha: SHA }, false)).toEqual({
            kind: 'contract',
            sha: SHA,
        });
    });
    it('ядро из установки — стоп с причиной', () => {
        expect(coreShaPolicy(refused, true)).toEqual({ kind: 'refuse', reason: 'старт отменён' });
    });
    it('ядро не из установки — без контракта, вслух и с причиной', () => {
        const p = coreShaPolicy(refused, false);
        expect(p.kind).toBe('no-contract');
        expect(p.kind === 'no-contract' && p.note).toMatch(
            /не из установки .*\(не git-репозиторий\).*без контракта RALPH_CORE_SHA.*RALPH_SKILL_GUARD=on/,
        );
    });
    it('doctor: у копии — строка-предупреждение, а не отказ; у установки — отказ', () => {
        const args = {
            productRoot: '/core',
            humanRoot: '/app',
            resolveCoreShaFn: () => refused,
            readHumanSettingsFn: () => ({}),
        };
        expect(sessionStartChecks({ ...args, installed: false })[0]).toEqual({
            ok: true,
            warn: true,
            line: expect.stringMatching(/^ядро не из установки/),
        });
        expect(sessionStartChecks({ ...args, installed: true })[0]).toEqual({
            ok: false,
            line: 'старт отменён',
        });
    });
    // Env сессии — окружение раннера: унаследованный оттуда контракт хук без явного
    // пустого значения принял бы за свой и сверял бы себя с чужой ревизией.
    it('хук без контракта — переключатель барьера скиллов, RALPH_CORE_SHA снят явно', () => {
        const cmd = canonHookCommand('/core', 'skill-barrier.cjs', '/app', '');
        expect(cmd).toBe(
            `${CORE_SHA_ENV}='' RALPH_SKILL_GUARD='on' ${HOOKS_DATA_ENV}='/app/.claude/ralph/hooks.json' node '/core/.claude/hooks/skill-barrier.cjs'`,
        );
    });
});

describe('строки старта и doctor о settings сессии', () => {
    it('describeSessionSettingsStart: без roots — называет переключатель барьера скиллов', () => {
        expect(describeSessionSettingsStart(null)).toMatch(
            /^🧷 Settings сессии не собирается: секции roots нет.*RALPH_SKILL_GUARD=on в env сессии$/,
        );
    });
    it('describeSessionSettingsStart: с контрактом и без него', () => {
        expect(
            describeSessionSettingsStart({ productRoot: '/core', humanRoot: '/app', coreSha: SHA }),
        ).toBe(
            `🧷 Settings сессии: хуки из ядра /core (${CORE_SHA_ENV}=${SHA}), контур из /app; ` +
                'собирается и проходит пробу перед каждой сессией',
        );
        expect(
            describeSessionSettingsStart({ productRoot: '/core', humanRoot: '/app', coreSha: '' }),
        ).toMatch(/хуки из ядра \/core \(без контракта ревизии\)/);
    });
    it('doctorStartChecks: расхождение корня первым, проверки settings — только при roots', () => {
        const seen: unknown[] = [];
        const fake = (a: unknown) => {
            seen.push(a);
            return [{ ok: true, line: 'settings' }];
        };
        expect(
            doctorStartChecks({
                productRootDrift: 'корень разошёлся',
                productRoot: '/core',
                humanRoot: '/app',
                installed: true,
                sessionStartChecksFn: fake,
            }),
        ).toEqual([
            { ok: false, line: 'корень разошёлся' },
            { ok: true, line: 'settings' },
        ]);
        expect(seen).toEqual([{ productRoot: '/core', humanRoot: '/app', installed: true }]);
        expect(
            doctorStartChecks({
                productRootDrift: null,
                productRoot: '/core',
                humanRoot: null,
                installed: false,
                sessionStartChecksFn: fake,
            }),
        ).toEqual([]);
        expect(seen).toHaveLength(1);
    });
});

// Отказы, брошенные не `Error` (строкой, объектом без прототипа), описываются так же
// внятно, как обычные: текст причины — то, с чем человек пойдёт разбирать стоп.
describe('session-settings: краевые формы отказов', () => {
    const roots = {
        productRoot: '/core',
        humanRoot: '/app',
        coreSha: '',
        sessionTree: '/work',
        outPath: '/r/s.json',
    };
    const holds = (hook: { command: string }, payload: string) => ({
        status: hook.command.includes('guard.cjs') && !payload.includes('git status') ? 2 : 0,
        stderr: '',
    });

    it('проба без контракта ревизии не прошла — причина говорит «без контракта»', () => {
        const r = prepareSessionSettings(roots, {
            readFileFn: enoent,
            writeFileFn: () => {},
            runHookFn: () => ({ status: 0, stderr: '' }),
        });
        expect(!r.ok && r.reason).toMatch(/ревизия без контракта/);
    });

    it('запись бросила не Error — причина строкой', () => {
        const r = prepareSessionSettings(roots, {
            readFileFn: enoent,
            writeFileFn: () => {
                throw 'диск кончился';
            },
            runHookFn: holds,
        });
        expect(!r.ok && r.reason).toMatch(/не записан в \/r\/s\.json \(диск кончился\)/);
    });

    it('чтение настроек человека бросило не Error — причина строкой', () => {
        expect(() =>
            readHumanSettings('/h', () => {
                throw 'нет прав';
            }),
        ).toThrow(/settings\.json не прочитан \(нет прав\)/);
    });

    it('doctor: settings не читаются отказом не-Error — строка с ним', () => {
        const lines = sessionStartChecks({
            productRoot: '/core',
            humanRoot: '/app',
            installed: false,
            resolveCoreShaFn: () => ({ ok: true, sha: SHA }),
            readHumanSettingsFn: () => {
                throw 'сломано';
            },
        });
        expect(lines[1]).toEqual({
            ok: false,
            line: 'Settings сессии не собран: сломано — старт будет отменён.',
        });
    });

    it('ревизия: канонический путь не разрешился отказом не-Error — отказ строкой', () => {
        const r = resolveCoreSha('/core', {
            gitFn: () => ({ status: 0, stdout: '/core\n', stderr: '' }),
            realpathFn: () => {
                throw 'ENOENT';
            },
        });
        expect(!r.ok && r.why).toBe('ENOENT');
    });

    it('сборка: событие хуков потребителя не списком — пустой список, а не падение', () => {
        const s = buildSessionSettings({
            productRoot: '/core',
            humanRoot: '/app',
            coreSha: SHA,
            humanSettings: { hooks: { SessionStart: 'не список' } },
        });
        expect((s.hooks as Record<string, unknown[]>).SessionStart).toEqual([]);
    });
});

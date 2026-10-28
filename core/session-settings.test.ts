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
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coreIsRepoRoot } from '../tests/core-repo.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';
import { stripComments } from '../tests/strip-comments.ts';
import {
    DELEGATION_MIGRATION_HINT,
    hooksFor,
    type TRunHookFn,
    type TRunPluginFn,
} from './guard-probe.ts';
import {
    CODEX_HOOK_TRUST_FLAG,
    OPENCODE_PLUGIN_DRIVER,
    codexGuardFromArgs,
    kimiHooksFromToml,
    opencodeHooksFromPlugin,
} from '../adapters/harness-guard.ts';
import { OPENCODE_CONFIG_DIR_ENV, OPENCODE_CONFIG_ENV } from '../adapters/opencode.ts';
import {
    CANON_SESSION_HOOKS,
    CORE_SHA_ENV,
    HOOKS_DATA_ENV,
    buildSessionSettings,
    canonHookCommand,
    GUARD_ADAPTER_ENV,
    guardAdapterValue,
    coreShaPolicy,
    describeSessionSettingsStart,
    doctorStartChecks,
    prepareCodexGuardArgs,
    prepareKimiNativeHome,
    prepareOpencodeSession,
    prepareSessionSettings,
    readHumanSettings,
    resolveCoreSha,
    sessionStartChecks,
    shellQuote,
    type TGitInDirFn,
} from './session-settings.ts';
import { heldRun } from '../tests/guard-fake.ts';
import {
    HARNESSES_DIR,
    HARNESS_REGISTRY,
    normalizerPathIn,
    SESSION_SETTINGS_HARNESS,
} from '../adapters/harness-registry.ts';

const CANON_ROOT = path.resolve(import.meta.dirname, '..');
/** Значение контракта в юнитах — только форма SHA. */
const SHA = 'a'.repeat(40);
/** Контекст сессии в юнитах (#184): форма та, что собирает раннер. */
const CONTEXT = JSON.stringify({
    sessionId: 's-1',
    loop: true,
    coreRevision: SHA,
    roots: { consumer: '/h', execution: '/s' },
});
/** Контекст живой сессии: корни — настоящие каталоги теста. */
const liveContext = (consumer: string, execution: string, coreRevision: string) =>
    JSON.stringify({ sessionId: 's-1', loop: true, coreRevision, roots: { consumer, execution } });

/** Живой git в каталоге — как боевой, но мимо предохранителя побочек. */
const liveGit: TGitInDirFn = (dir, args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Живой запуск хука — как боевой `runHook`, но мимо предохранителя побочек. */
/**
 * Окружение хука — как у боевого `runHook`: `CLAUDE_PROJECT_DIR` получает только хук Claude
 * Code, остальным харнессам её не ставит CLI, и тест её не подкладывает (#120).
 */
function hookEnv(projectDir: string, withProjectDir: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    if (!withProjectDir) delete env.CLAUDE_PROJECT_DIR;
    return env;
}

const spawnHook: TRunHookFn = (hook, payload, projectDir, opts = {}) => {
    const r = spawnSync('sh', ['-c', hook.command], {
        cwd: projectDir,
        input: payload,
        encoding: 'utf-8',
        timeout: hook.timeoutSec * 1000,
        env: { ...hookEnv(projectDir, opts.projectDirEnv !== false), ...opts.env },
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

// Барьер скиллов в регистрации не-Claude харнессов не переносится: транскрипта у них нет
// (`guardHooksOf`, ревью Фазы 16b).
/** Путь нормализатора пакета Claude Code от корня ядра — по реестру, а не литералом. */
const CLAUDE_NORMALIZER_REL = (() => {
    const found = normalizerPathIn(HARNESS_REGISTRY, SESSION_SETTINGS_HARNESS, '/');
    if (!found.ok) throw new Error(found.reason);
    return found.path.slice(1);
})();

const HARNESS_HOOK_MATCHERS = CANON_SESSION_HOOKS.filter((h) => h.file !== 'skill-barrier.cjs').map(
    (h) => h.matcher,
);

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
            // Guard судит событие нормализатора пакета (#186): путь его команды — из реестра,
            // перенесённый в каталог исполняемого ядра.
            `${env} ${GUARD_ADAPTER_ENV}='/path/to/core/${CLAUDE_NORMALIZER_REL}' ` +
                `node '/path/to/core/.claude/hooks/guard.cjs'`,
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
        sessionContext: CONTEXT,
    };

    it('проба прошла — файл записан и путь отдан', () => {
        const written: [string, string][] = [];
        const r = prepareSessionSettings(roots, {
            readFileFn: () => JSON.stringify({ hooks: CONSUMER_HOOKS }),
            writeFileFn: (p, t) => written.push([p, t]),
            runHookFn: (hook, payload) =>
                hook.command.includes('guard.cjs') ? heldRun(payload) : { status: 0, stderr: '' },
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
            runHookFn: (hook, payload) =>
                hook.command.includes('guard.cjs') ? heldRun(payload) : { status: 0, stderr: '' },
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
            {
                productRoot,
                humanRoot,
                coreSha,
                sessionTree,
                outPath: out,
                sessionContext: liveContext(humanRoot, sessionTree, coreSha),
            },
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
        // Пакеты харнессов — часть установки: guard судит событие их нормализатора (#186).
        const packages = path.relative(CANON_ROOT, HARNESSES_DIR);
        cpSync(HARNESSES_DIR, path.join(p, packages), { recursive: true });
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

    // #184: раскладка с внешними `roots`. Канонический guard из установки узнаёт петлю по
    // контракту, guard дерева сессии (`${CLAUDE_PROJECT_DIR}` из настроек человека — на
    // каноне это тот же репозиторий) — по контексту в окружении. Проба перед сессией требует
    // контекст от КАЖДОЙ регистрации guard; дошёл не до всех — settings не пишется.
    const prepareWithHuman = (core: { root: string; sha: string }, humanCommand: string) => {
        const humanRoot = tmp('human');
        const sessionTree = tmp('session');
        cpSync(
            path.join(CANON_ROOT, '.claude', 'hooks'),
            path.join(sessionTree, '.claude', 'hooks'),
            {
                recursive: true,
            },
        );
        mkdirSync(path.join(humanRoot, '.claude'), { recursive: true });
        writeFileSync(
            path.join(humanRoot, '.claude', 'settings.json'),
            JSON.stringify({
                hooks: {
                    PreToolUse: [
                        {
                            matcher: 'Bash|Read|Edit|Write',
                            hooks: [{ type: 'command', command: humanCommand, timeout: 10 }],
                        },
                    ],
                },
            }),
        );
        const out = path.join(tmp('runtime'), 'session-settings.json');
        const r = prepareSessionSettings(
            {
                productRoot: core.root,
                humanRoot,
                coreSha: core.sha,
                sessionTree,
                outPath: out,
                sessionContext: liveContext(humanRoot, sessionTree, core.sha),
            },
            { writeFileFn: (p, t) => writeFileSync(p, t), runHookFn: spawnHook },
        );
        return { r, out };
    };

    it.skipIf(!coreIsRepoRoot())(
        'roots: guard дерева сессии получает контекст наравне с хуком установки — проба зелёная',
        () => {
            const { r, out } = prepareWithHuman(
                installedCore(),
                'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.cjs"',
            );
            expect(r).toEqual({ ok: true, path: out });
        },
    );

    it.skipIf(!coreIsRepoRoot())(
        'roots: регистрация guard, которой контекст не дошёл, — отказ, settings не записан',
        () => {
            const command =
                'env -u RALPH_SESSION_CONTEXT node "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.cjs"';
            const { r, out } = prepareWithHuman(installedCore(), command);
            expect(r.ok).toBe(false);
            expect(!r.ok && r.reason).toMatch(/не получила контекст сессии/);
            expect(!r.ok && r.reason).toContain(command);
            expect(() => readFileSync(out)).toThrow();
        },
    );

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
                // Исправный — значит, и запрещённое называет своим кодом причины (#183).
                'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(s.includes("git status"))process.exit(0);' +
                    'const c=/mcp__/.test(s)?"mcp-not-allowed":/hooks\\.json/.test(s)?"contour-data":' +
                    '/"tool_name":"(Agent|ScheduleWakeup)"/.test(s)?"loop-delegation":' +
                    '/rm -rf/.test(s)?"destructive":"secret-env";' +
                    'process.stderr.write("ralph-reason-code: "+c+"\\n");process.exit(2)});',
            ),
            tmp('session'),
        );
        expect(r.ok).toBe(true);
    });

    it('копия хуков старше #225 (без loop-delegation) — отказ называет шаг миграции', () => {
        const { r } = prepare(
            productWith(
                'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(s.includes("git status"))process.exit(0);' +
                    'if(/"tool_name":"(Agent|ScheduleWakeup)"/.test(s))process.exit(0);' +
                    'const c=/mcp__/.test(s)?"mcp-not-allowed":/hooks\\.json/.test(s)?"contour-data":' +
                    '/rm -rf/.test(s)?"destructive":"secret-env";' +
                    'process.stderr.write("ralph-reason-code: "+c+"\\n");process.exit(2)});',
            ),
            tmp('session'),
        );
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(/субагент в сессии петли/);
        expect(!r.ok && r.reason).toContain(DELEGATION_MIGRATION_HINT);
    });
});

// #119: сессия Codex настроек Claude Code не читает — барьер едет в её argv и пробуется
// перед каждой сессией на том argv, который уйдёт в CLI.
describe('prepareCodexGuardArgs — регистрация барьера Codex перед сессией', () => {
    const roots = { productRoot: '/core', humanRoot: '/app', coreSha: 'a'.repeat(40) };
    /** 2 на запрещённом, 0 на безобидном; вход — в форме Codex (`turn_id`). */
    const codexGuard: TRunHookFn = (_h, payload) => {
        const p = JSON.parse(payload) as { turn_id?: string; tool_input: { command?: string } };
        if (!p.turn_id) return { status: 1, stderr: 'не форма Codex' };
        return heldRun(payload);
    };

    it('при корнях — хуки из установки ядра с контрактом, флаги доверия и включения', () => {
        const r = prepareCodexGuardArgs(
            { roots, sessionTree: '/work' },
            { readFileFn: () => '{}', runHookFn: codexGuard },
        );
        if (!r.ok) throw new Error(r.reason);
        expect(r.args).toContain(CODEX_HOOK_TRUST_FLAG);
        const { hooks } = codexGuardFromArgs(r.args);
        expect(hooks.map((h) => h.matcher)).toEqual(HARNESS_HOOK_MATCHERS);
        expect(hooks[0].command).toContain("CLAUDE_PROJECT_DIR='/work'");
        expect(hooks[0].command).toContain(
            canonHookCommand(
                '/core',
                'guard.cjs',
                '/app',
                'a'.repeat(40),
                guardAdapterValue('/core'),
            ),
        );
    });

    it('без корней — хуки из .claude/settings.json дерева сессии', () => {
        const reads: string[] = [];
        const r = prepareCodexGuardArgs(
            { roots: null, sessionTree: '/work' },
            {
                readFileFn: (p) => {
                    reads.push(p);
                    return JSON.stringify({
                        hooks: {
                            PreToolUse: [
                                {
                                    matcher: 'Bash',
                                    hooks: [{ type: 'command', command: 'node g.cjs' }],
                                },
                            ],
                        },
                    });
                },
                runHookFn: codexGuard,
            },
        );
        expect(reads).toEqual([path.join('/work', '.claude', 'settings.json')]);
        expect(r.ok).toBe(true);
    });

    it('барьер не держит на событии Codex — отказ с причиной, аргументов нет', () => {
        const r = prepareCodexGuardArgs(
            { roots, sessionTree: '/work' },
            { readFileFn: () => '{}', runHookFn: () => ({ status: 0, stderr: '' }) },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/Проба барьера Codex[\s\S]*рекурсивное удаление/);
    });

    it('настройки не прочитались — отказ, а не сессия без хуков', () => {
        const r = prepareCodexGuardArgs(
            { roots: null, sessionTree: '/work' },
            {
                readFileFn: () => {
                    throw new Error('ENOENT');
                },
                runHookFn: codexGuard,
            },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/Хуки для сессии Codex не собраны: ENOENT/);
    });
});

describe('prepareKimiNativeHome — дом Kimi Code с барьером перед сессией (#120)', () => {
    const roots = { productRoot: '/core', humanRoot: '/app', coreSha: SHA };
    /** 2 на запрещённом, 0 на безобидном; вход — в форме Kimi Code (`client_type`). */
    const kimiGuard: TRunHookFn = (_h, payload) => {
        const p = JSON.parse(payload) as {
            client_type?: string;
            tool_input: { command?: string };
        };
        if (p.client_type !== 'kimi_code_cli') return { status: 1, stderr: 'не форма Kimi' };
        return heldRun(payload);
    };
    const HUMAN_TOML = 'default_model = "kimi-code/kimi-for-coding"\n';
    const fakeFs = () => {
        const writes = new Map<string, string>();
        const links: Array<[string, string]> = [];
        const unlinked: string[] = [];
        const dirs: string[] = [];
        return {
            writes,
            links,
            unlinked,
            dirs,
            deps: {
                readFileFn: (p: string) => (p.endsWith('config.toml') ? HUMAN_TOML : '{}'),
                writeFileFn: (p: string, t: string) => void writes.set(p, t),
                mkdirFn: (p: string) => void dirs.push(p),
                linkFn: (t: string, l: string) => void links.push([t, l]),
                unlinkFn: (p: string) => void unlinked.push(p),
                entryKindFn: (_p: string): 'missing' | 'link' | 'other' => 'missing',
                existsFn: (p: string) => !p.endsWith('device_id'),
                runHookFn: kimiGuard,
            },
        };
    };

    it('конфиг человека плюс хуки установки ядра; вход — ссылками на дом человека', () => {
        const f = fakeFs();
        const r = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h/.kimi-code', home: '/r/home' },
            f.deps,
        );
        expect(r).toEqual({ ok: true, home: '/r/home' });
        expect(f.dirs).toEqual(['/r/home']);
        const toml = f.writes.get('/r/home/config.toml') ?? '';
        expect(toml.startsWith(HUMAN_TOML)).toBe(true);
        const { hooks } = kimiHooksFromToml(toml);
        expect(hooks.map((h) => h.matcher)).toEqual(HARNESS_HOOK_MATCHERS);
        expect(hooks[0].command).toContain("CLAUDE_PROJECT_DIR='/work'");
        expect(hooks[0].command).toContain(
            canonHookCommand('/core', 'guard.cjs', '/app', SHA, guardAdapterValue('/core')),
        );
        // Отсутствующий у человека файл ссылкой не становится.
        expect(f.links).toEqual([
            ['/h/.kimi-code/credentials', '/r/home/credentials'],
            ['/h/.kimi-code/oauth', '/r/home/oauth'],
        ]);
    });

    it('барьер не держит на событии Kimi — отказ, дом не пишется', () => {
        const f = fakeFs();
        const r = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            { ...f.deps, runHookFn: () => ({ status: 0, stderr: '' }) },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/Проба барьера Kimi Code[\s\S]*рекурсивное удаление/);
        expect(f.writes.size).toBe(0);
        expect(f.links).toEqual([]);
    });

    // Ревью Фазы 16b: висячая ссылка на пропавший у человека файл оставалась с прошлой сессии.
    it('ссылка с прошлой сессии снимается всегда; цели нет — новой не ставится', () => {
        const f = fakeFs();
        const r = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            { ...f.deps, entryKindFn: () => 'link' },
        );
        expect(r.ok).toBe(true);
        expect(f.unlinked).toEqual(['/r/home/credentials', '/r/home/oauth', '/r/home/device_id']);
        expect(f.links.map(([, l]) => l)).toEqual(['/r/home/credentials', '/r/home/oauth']);
    });

    // Ревью Фазы 16b: `rmSync` без recursive бросал на каталоге, созданном CLI, и каждая
    // следующая сессия вставала с безымянным «дом не собран».
    it('НЕГАТИВНЫЙ: настоящий каталог на месте ссылки — отказ с его адресом, вход не удаляется', () => {
        const f = fakeFs();
        const r = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            {
                ...f.deps,
                entryKindFn: (p) => (p.endsWith('credentials') ? 'other' : 'missing'),
            },
        );
        expect(r.ok).toBe(false);
        if (!r.ok)
            expect(r.reason).toMatch(
                /\/r\/home\/credentials — настоящий файл или каталог, а не ссылка на \/h\/credentials/,
            );
        expect(f.unlinked).toEqual([]);
        expect(f.links).toEqual([]);
    });

    it('боевое снятие ссылки — побочка: в тесте громкий отказ, дом не собран', () => {
        const f = fakeFs();
        const deps: Record<string, unknown> = { ...f.deps, entryKindFn: () => 'link' };
        delete deps.unlinkFn;
        const r = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            deps,
        );
        expect(r.ok).toBe(false);
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain(
            'prepareKimiNativeHome:unlink(/r/home/credentials)',
        );
    });

    it('настройки хуков не прочитались — отказ, а не сессия без барьера', () => {
        const f = fakeFs();
        const r = prepareKimiNativeHome(
            { roots: null, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            { ...f.deps, readFileFn: enoent },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/Хуки для сессии Kimi Code не собраны/);
    });

    it('config.toml человека не прочитан — отказ с советом войти', () => {
        const f = fakeFs();
        const r = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            {
                ...f.deps,
                readFileFn: (p) => {
                    if (p.endsWith('config.toml')) enoent();
                    return '{}';
                },
            },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/config\.toml дома Kimi Code \/h не прочитан/);
    });

    it('запись дома упала — отказ с адресом, а не сессия на чужом доме', () => {
        const f = fakeFs();
        const r = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            {
                ...f.deps,
                writeFileFn: () => {
                    throw new Error('ENOSPC');
                },
            },
        );
        expect(r).toEqual({
            ok: false,
            reason: 'Дом Kimi Code сессии не собран в /r/home (ENOSPC).',
        });
    });

    describe('живые хуки канона в доме Kimi Code', () => {
        const made: string[] = [];
        afterEach(() => {
            for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
        });
        const tmp = (name: string) => {
            const d = realpathSync(mkdtempSync(path.join(tmpdir(), `kimi-home-${name}-`)));
            made.push(d);
            return d;
        };

        it.skipIf(!coreIsRepoRoot())(
            'настоящий guard блокирует запрещённое на событиях Kimi, дом собран на диске',
            () => {
                const core = tmp('installed');
                cpSync(
                    path.join(CANON_ROOT, '.claude', 'hooks'),
                    path.join(core, '.claude', 'hooks'),
                    { recursive: true },
                );
                const sha = initRepo(core);
                const human = tmp('human');
                const source = tmp('source');
                writeFileSync(path.join(source, 'config.toml'), HUMAN_TOML);
                mkdirSync(path.join(source, 'credentials'));
                const home = path.join(tmp('runtime'), 'kimi-native', 'home');
                const r = prepareKimiNativeHome(
                    {
                        roots: { productRoot: core, humanRoot: human, coreSha: sha },
                        sessionTree: tmp('session'),
                        sourceHome: source,
                        home,
                    },
                    {
                        writeFileFn: (p, t) => writeFileSync(p, t),
                        mkdirFn: (p) => mkdirSync(p, { recursive: true }),
                        linkFn: (t, l) => symlinkSync(t, l),
                        runHookFn: spawnHook,
                    },
                );
                expect(r).toEqual({ ok: true, home });
                const toml = readFileSync(path.join(home, 'config.toml'), 'utf-8');
                expect(kimiHooksFromToml(toml).hooks.length).toBeGreaterThan(0);
                expect(lstatSync(path.join(home, 'credentials')).isSymbolicLink()).toBe(true);
                expect(existsSync(path.join(home, 'oauth'))).toBe(false);

                // Ревью Фазы 16b: следующая сборка снимает прежнюю ссылку боевым путём, а
                // каталог, созданный CLI на месте ссылки, называет в отказе и не удаляет.
                const deps = {
                    writeFileFn: (p: string, t: string) => writeFileSync(p, t),
                    mkdirFn: (p: string) => mkdirSync(p, { recursive: true }),
                    linkFn: (t: string, l: string) => symlinkSync(t, l),
                    unlinkFn: (p: string) => rmSync(p),
                    runHookFn: spawnHook,
                };
                const args = {
                    roots: { productRoot: core, humanRoot: human, coreSha: sha },
                    sessionTree: tmp('session'),
                    sourceHome: source,
                    home,
                };
                expect(prepareKimiNativeHome(args, deps)).toEqual({ ok: true, home });
                rmSync(path.join(home, 'credentials'));
                mkdirSync(path.join(home, 'credentials'));
                const blocked = prepareKimiNativeHome(args, deps);
                expect(blocked.ok).toBe(false);
                if (!blocked.ok) expect(blocked.reason).toMatch(/настоящий файл или каталог/);
                expect(lstatSync(path.join(home, 'credentials')).isDirectory()).toBe(true);
            },
        );
    });
});

/** Живой запуск плагина OpenCode — то же, что боевой `runOpencodePlugin`, мимо предохранителя. */
const spawnPlugin: TRunPluginFn = (source, event, projectDir) => {
    const r = spawnSync('node', ['--input-type=module', '-e', OPENCODE_PLUGIN_DRIVER], {
        cwd: projectDir,
        input: JSON.stringify({ source, ...event, directory: projectDir }),
        encoding: 'utf-8',
        timeout: 120 * 1000,
    });
    return { status: r.status, stderr: r.stderr ?? '' };
};

describe('prepareOpencodeSession — каталог OpenCode с барьером перед сессией (#121)', () => {
    const roots = { productRoot: '/core', humanRoot: '/app', coreSha: SHA };
    /** 2 на запрещённом, 0 на безобидном; судит по аргументам в форме OpenCode. */
    const pluginGuard: TRunPluginFn = (_src, ev) => heldRun(JSON.stringify(ev));
    const SKILL = '/work/.claude/skills/vitest/SKILL.md';
    const fakeFs = (seen: string[] = [SKILL]) => {
        const writes = new Map<string, string>();
        const dirs: string[] = [];
        const skillCalls: Array<[NodeJS.ProcessEnv, string]> = [];
        return {
            writes,
            dirs,
            skillCalls,
            deps: {
                readFileFn: () => '{}',
                writeFileFn: (p: string, t: string) => void writes.set(p, t),
                mkdirFn: (p: string) => void dirs.push(p),
                runPluginFn: pluginGuard,
                listDirFn: () => ['vitest'],
                isFileFn: (p: string) => p === SKILL,
                listSkillsFn: (env: NodeJS.ProcessEnv, cwd: string) => {
                    skillCalls.push([env, cwd]);
                    return {
                        code: 0,
                        stdout: JSON.stringify(seen.map((location) => ({ name: 'x', location }))),
                    };
                },
            },
        };
    };
    const args = (r: typeof roots | null = roots) => ({
        roots: r,
        sessionTree: '/work',
        configDir: '/r/opencode/config',
        baseEnv: { HOME: '/h' },
    });

    it('плагин с хуками установки ядра и настройки сессии; скиллы — в окружении сессии', () => {
        const f = fakeFs();
        expect(prepareOpencodeSession(args(), f.deps)).toEqual({
            ok: true,
            configDir: '/r/opencode/config',
        });
        expect(f.dirs).toEqual(['/r/opencode/config/plugin']);
        const plugin = f.writes.get('/r/opencode/config/plugin/ralph-guard.js') ?? '';
        const { hooks } = opencodeHooksFromPlugin(plugin);
        expect(hooks.map((h) => h.matcher)).toEqual(HARNESS_HOOK_MATCHERS);
        expect(hooks[0].command).toContain(
            canonHookCommand('/core', 'guard.cjs', '/app', SHA, guardAdapterValue('/core')),
        );
        const cfg = JSON.parse(f.writes.get('/r/opencode/config/opencode.json') ?? '{}') as {
            permission?: unknown;
        };
        expect(cfg.permission).toEqual({ bash: 'allow', edit: 'allow' });
        const [env, cwd] = f.skillCalls[0];
        expect(cwd).toBe('/work');
        expect(env[OPENCODE_CONFIG_DIR_ENV]).toBe('/r/opencode/config');
        expect(env[OPENCODE_CONFIG_ENV]).toBe('/r/opencode/config/opencode.json');
        expect(env.HOME).toBe('/h');
    });

    it('плагин не держит — отказ, каталог не пишется, скиллы не спрашиваются', () => {
        const f = fakeFs();
        const r = prepareOpencodeSession(args(), {
            ...f.deps,
            runPluginFn: () => ({ status: 0, stderr: '' }),
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/Проба барьера OpenCode[\s\S]*рекурсивное удаление/);
        expect(f.writes.size).toBe(0);
        expect(f.skillCalls).toEqual([]);
    });

    it('настройки хуков не прочитались — отказ, а не сессия без барьера', () => {
        const f = fakeFs();
        const r = prepareOpencodeSession(args(null), { ...f.deps, readFileFn: enoent });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/Хуки для сессии OpenCode не собраны/);
    });

    it('запись каталога упала — отказ с адресом', () => {
        const f = fakeFs();
        const r = prepareOpencodeSession(args(), {
            ...f.deps,
            writeFileFn: () => {
                throw new Error('ENOSPC');
            },
        });
        expect(r).toEqual({
            ok: false,
            reason: 'Каталог сессии OpenCode не собран в /r/opencode/config (ENOSPC).',
        });
    });

    it('CLI не видит скилл дерева — отказ с путём, сессия не стартует', () => {
        const f = fakeFs([]);
        const r = prepareOpencodeSession(args(), f.deps);
        expect(r.ok).toBe(false);
        if (!r.ok)
            expect(r.reason).toMatch(
                /Набор скиллов сессии OpenCode неполон[\s\S]*\/work\/\.claude\/skills\/vitest\/SKILL\.md/,
            );
    });

    describe('живые хуки канона в плагине OpenCode', () => {
        const made: string[] = [];
        afterEach(() => {
            for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
        });
        const tmp = (name: string) => {
            const d = realpathSync(mkdtempSync(path.join(tmpdir(), `opencode-${name}-`)));
            made.push(d);
            return d;
        };

        it.skipIf(!coreIsRepoRoot())(
            'настоящий guard через плагин блокирует запрещённое, каталог собран на диске',
            () => {
                const core = tmp('installed');
                cpSync(
                    path.join(CANON_ROOT, '.claude', 'hooks'),
                    path.join(core, '.claude', 'hooks'),
                    { recursive: true },
                );
                const sha = initRepo(core);
                const configDir = path.join(tmp('runtime'), 'opencode', 'config');
                const r = prepareOpencodeSession(
                    {
                        roots: { productRoot: core, humanRoot: tmp('human'), coreSha: sha },
                        sessionTree: tmp('session'),
                        configDir,
                        baseEnv: {},
                    },
                    {
                        writeFileFn: (p, t) => writeFileSync(p, t),
                        mkdirFn: (p) => mkdirSync(p, { recursive: true }),
                        runPluginFn: spawnPlugin,
                        listSkillsFn: () => ({ code: 0, stdout: '[]' }),
                    },
                );
                expect(r).toEqual({ ok: true, configDir });
                const plugin = readFileSync(
                    path.join(configDir, 'plugin', 'ralph-guard.js'),
                    'utf-8',
                );
                expect(opencodeHooksFromPlugin(plugin).hooks.length).toBeGreaterThan(0);
                expect(existsSync(path.join(configDir, 'opencode.json'))).toBe(true);
            },
        );
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

    it('спавн codex-сессии идёт с регистрацией барьера, собранной после проверки DRY', () => {
        const fnStart = source.indexOf('function runOpenAIOnce(');
        const body = source.slice(fnStart, source.indexOf('return spawnCodex(', fnStart));
        const dry = body.indexOf('if (DRY) return');
        const guard = body.indexOf('guardArgs: guardArgsFn()');
        expect(dry).toBeGreaterThan(-1);
        expect(guard).toBeGreaterThan(dry);
        expect(source).toMatch(/guardArgsFn: \(\) => string\[\] = \(\) => codexGuardArgsFor\(\)/);
        expect(source).toMatch(/cmdArgs\.push\(\.\.\.guardArgs, '--', '-'\)/);
    });

    it('main(): дерево барьера Codex ставится вместе с корнями settings, после пробы', () => {
        const main = source.slice(source.indexOf('function main('));
        const probe = main.indexOf('settings: builtSettings');
        const set = main.indexOf('codexGuardTree = sessionTree');
        expect(set).toBeGreaterThan(probe);
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
        sessionContext: CONTEXT,
    };
    const holds = (hook: { command: string }, payload: string) =>
        hook.command.includes('guard.cjs') ? heldRun(payload) : { status: 0, stderr: '' };

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

// Боевые умолчания коллабораторов подготовки сессии — файловая система и процессы. В тесте
// пишущее из них обязано быть громкой побочкой, а читающее — читать то, что ему дали:
// каталог, которого нет, не превращается в «всё хорошо».
describe('подготовка сессий харнессов: боевые умолчания', () => {
    const missing = '/nonexistent-ralph-core';
    const roots = { productRoot: missing, humanRoot: missing, coreSha: 'a'.repeat(40) };
    const blockAll: TRunHookFn = (_h, payload) => heldRun(payload);

    it('Codex: настройки человека читаются с диска — нет файла, есть хуки установки ядра', () => {
        const r = prepareCodexGuardArgs({ roots, sessionTree: missing }, { runHookFn: blockAll });
        expect(r.ok).toBe(true);
    });

    it('Kimi Code: конфиг человека читается с диска, запись дома — громкая побочка', () => {
        expect(
            prepareKimiNativeHome(
                { roots, sessionTree: missing, sourceHome: missing, home: '/r/home' },
                { runHookFn: blockAll },
            ).ok,
        ).toBe(false);
        const base = {
            readFileFn: () => '{}',
            runHookFn: blockAll,
            writeFileFn: () => {},
            entryKindFn: () => 'missing' as const,
        };
        const noMkdir = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            base,
        );
        expect(noMkdir.ok).toBe(false);
        const noLink = prepareKimiNativeHome(
            { roots, sessionTree: '/work', sourceHome: '/h', home: '/r/home' },
            { ...base, mkdirFn: () => {}, existsFn: () => true },
        );
        expect(noLink.ok).toBe(false);
        expect(sideEffectAttempts.splice(0).join(' | ')).toMatch(
            /prepareKimiNativeHome:mkdir\(\/r\/home\)[\s\S]*prepareKimiNativeHome:symlink\(\/r\/home\/credentials\)/,
        );
    });

    it('OpenCode: скиллы дерева ищутся на диске, каталог сессии — громкая побочка', () => {
        const pluginOk: TRunPluginFn = (_s, ev) => heldRun(JSON.stringify(ev));
        const r = prepareOpencodeSession(
            { roots, sessionTree: missing, configDir: '/r/opencode/config', baseEnv: {} },
            { readFileFn: () => '{}', runPluginFn: pluginOk },
        );
        expect(r.ok).toBe(false);
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain(
            'prepareOpencodeSession:mkdir(/r/opencode/config/plugin)',
        );
        const r2 = prepareOpencodeSession(
            { roots, sessionTree: missing, configDir: '/r/opencode/config', baseEnv: {} },
            {
                runPluginFn: pluginOk,
                mkdirFn: () => {},
                writeFileFn: () => {},
                listSkillsFn: () => ({ code: 0, stdout: '[]' }),
            },
        );
        // Каталога скиллов нет — ожидать нечего; настройки человека — тоже с диска.
        expect(r2.ok).toBe(true);
        expect(sideEffectAttempts.splice(0)).toEqual([]);
    });
});

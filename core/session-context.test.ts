// Доверенный контекст сессии петли (#184): сборка раннером в обеих раскладках, проба
// preflight на каждой регистрации guard и живые хуки канона под контекстом — забор данных
// контура держится без транскриптного признака, разрешённые сценарии петли проходят.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSessionContext } from '../.claude/hooks/session-context.cjs';
import { reasonCodeOf } from '../adapters/barrier-reason.ts';
import {
    ensureGuardHolds,
    HOOK_COMMAND_ONLY_ENV,
    probeHookEnv,
    sessionContextProblems,
    type TRunHookFn,
} from './guard-probe.ts';
import { loopSessionContext, SESSION_CONTEXT_ENV } from './session-context.ts';

const CANON = path.resolve(import.meta.dirname, '..');
const HOOKS = path.join(CANON, '.claude', 'hooks');
const SHA = 'a'.repeat(40);
const fixedId = () => 'session-1';

/** Живой запуск хука — как боевой `runHook`, но мимо предохранителя побочек. */
const spawnHook: TRunHookFn = (hook, payload, projectDir, opts = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
    if (opts.projectDirEnv === false) delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync('sh', ['-c', hook.command], {
        cwd: projectDir,
        input: payload,
        encoding: 'utf-8',
        timeout: hook.timeoutSec * 1000,
        env: { ...env, ...opts.env },
    });
    return { status: r.status, stderr: r.stderr ?? '' };
};

describe('loopSessionContext — контекст, который раннер кладёт в env сессии', () => {
    it('раскладка с roots: потребитель — дерево человека, исполнение — дерево сессии', () => {
        const built = loopSessionContext({
            humanRoot: '/path/to/app',
            sessionTree: '/path/to/app-ralph',
            coreSha: SHA,
            sessionIdFn: fixedId,
        });
        expect(built).toEqual({
            ok: true,
            context: {
                sessionId: 'session-1',
                loop: true,
                coreRevision: SHA,
                roots: { consumer: '/path/to/app', execution: '/path/to/app-ralph' },
            },
            value: expect.any(String),
        });
        // Хук разбирает ровно то, что собрал раннер: одна форма по обе стороны шва.
        if (!built.ok) throw new Error(built.reason);
        expect(parseSessionContext(built.value)).toEqual({ context: built.context, error: null });
    });

    it('раскладка без roots: оба корня — доверенный каталог дерева сессии', () => {
        const built = loopSessionContext({
            humanRoot: null,
            sessionTree: '/path/to/app',
            coreSha: '',
            sessionIdFn: fixedId,
        });
        expect(built.ok && built.context.roots).toEqual({
            consumer: '/path/to/app',
            execution: '/path/to/app',
        });
        expect(built.ok && parseSessionContext(built.value).error).toBeNull();
    });

    it.each([
        ['нет дерева сессии', null, null, /roots\.consumer и roots\.execution/],
        ['дерево сессии относительное', null, 'app', /roots\.consumer и roots\.execution/],
        [
            'дерево человека относительное',
            'app',
            '/path/to/app',
            /нет абсолютного roots\.consumer\./,
        ],
    ])('%s — отказ preflight с названными корнями', (_what, humanRoot, sessionTree, why) => {
        const built = loopSessionContext({ humanRoot, sessionTree, coreSha: '' });
        expect(built.ok).toBe(false);
        expect(!built.ok && built.reason).toMatch(why);
    });

    it('sessionId у каждой сборки свой', () => {
        const a = loopSessionContext({ humanRoot: null, sessionTree: '/a', coreSha: '' });
        const b = loopSessionContext({ humanRoot: null, sessionTree: '/a', coreSha: '' });
        expect(a.ok && b.ok && a.context.sessionId !== b.context.sessionId).toBe(true);
    });
});

// Живые хуки канона: guard и барьер скиллов этого дерева, процессом, как их зовёт Claude
// Code в сессии петли без `roots` — контракта ревизии нет, петлю заявляет только контекст.
describe('живая петля на Claude Code под контекстом сессии', { timeout: 30_000 }, () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const tmp = (name: string) => {
        const d = mkdtempSync(path.join(tmpdir(), `session-context-${name}-`));
        dirs.push(d);
        return d;
    };

    const built = loopSessionContext({ humanRoot: null, sessionTree: CANON, coreSha: '' });
    if (!built.ok) throw new Error(built.reason);
    /** Env сессии петли без `roots`, как его собирает раннер (`withSkillGuard`). */
    const LOOP = { [SESSION_CONTEXT_ENV]: built.value, RALPH_SKILL_GUARD: 'on' };

    const runHook = (
        file: string,
        call: Record<string, unknown>,
        extra: Record<string, string> = {},
        tmpDir = tmpdir(),
    ) =>
        spawnSync(process.execPath, [path.join(HOOKS, file)], {
            input: JSON.stringify(call),
            encoding: 'utf-8',
            env: {
                ...process.env,
                RALPH_CORE_SHA: '',
                RALPH_SKILL_GUARD: '',
                CLAUDE_PROJECT_DIR: CANON,
                TMPDIR: tmpDir,
                ...extra,
            },
        });
    const guard = (call: Record<string, unknown>, extra: Record<string, string> = {}) =>
        runHook('guard.cjs', call, extra);

    const writeData = { tool_name: 'Write', tool_input: { file_path: '.claude/ralph/hooks.json' } };

    it('правка данных контура из сессии петли блокируется — файлом и оболочкой', () => {
        for (const call of [
            writeData,
            {
                tool_name: 'Edit',
                tool_input: { file_path: path.join(CANON, '.claude/ralph/hooks.json') },
            },
            { tool_name: 'Bash', tool_input: { command: 'echo {} > .claude/ralph/hooks.json' } },
        ]) {
            const r = guard(call, LOOP);
            expect(r.status).toBe(2);
            expect(reasonCodeOf(r.stderr)).toEqual({ code: 'contour-data' });
        }
    });

    it('сессия без контракта с транскриптом, похожим на петлю, петлёй не считается', () => {
        const transcript = path.join(tmp('transcript'), 'session.jsonl');
        writeFileSync(
            transcript,
            `${JSON.stringify({ type: 'user', message: { content: 'Прочитай ralph.md и следуй ему' } })}\n`,
        );
        expect(guard({ ...writeData, transcript_path: transcript }).status).toBe(0);
        // Транскрипт назван, но не читается — тоже не петля: транскрипт guard больше не читает.
        expect(guard({ ...writeData, transcript_path: '/nonexistent/t.jsonl' }).status).toBe(0);
    });

    it('заявленный, но битый контекст — блок кодом неисправности, а не «петли нет»', () => {
        for (const value of [
            '{',
            JSON.stringify({ ...built.context, roots: { consumer: CANON } }),
        ]) {
            const r = guard(
                { tool_name: 'Bash', tool_input: { command: 'git status' } },
                {
                    [SESSION_CONTEXT_ENV]: value,
                },
            );
            expect(r.status).toBe(2);
            expect(reasonCodeOf(r.stderr)).toEqual({ code: 'session-context' });
        }
    });

    it('разрешённые сценарии петли проходят: правка кода, MCP-чтение, git-коммит', () => {
        for (const call of [
            { tool_name: 'Edit', tool_input: { file_path: 'core/session-context.ts' } },
            { tool_name: 'Read', tool_input: { file_path: '.claude/ralph/hooks.json' } },
            { tool_name: 'mcp__sourcecraft__ListIssues', tool_input: {} },
            { tool_name: 'mcp__sourcecraft__GetIssue', tool_input: {} },
            { tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: x (#184)"' } },
        ]) {
            const r = guard(call, LOOP);
            expect({ call: call.tool_name, status: r.status, stderr: r.stderr }).toEqual({
                call: call.tool_name,
                status: 0,
                stderr: '',
            });
        }
    });

    it('правка теста в петле: без Skill(vitest) — блок, после вызова — проходит', () => {
        const dir = tmp('skill');
        const transcript = path.join(dir, 'session.jsonl');
        const prompt = JSON.stringify({ type: 'user', message: { content: 'Работай' } });
        writeFileSync(transcript, `${prompt}\n`);
        const edit = {
            session_id: 'loop-1',
            transcript_path: transcript,
            tool_name: 'Edit',
            tool_input: { file_path: 'core/session-context.test.ts' },
        };
        const denied = runHook('skill-barrier.cjs', edit, LOOP, dir);
        expect(denied.status).toBe(2);
        expect(reasonCodeOf(denied.stderr)).toEqual({ code: 'skill-required' });

        const skill = JSON.stringify({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'vitest' } },
                ],
            },
        });
        writeFileSync(transcript, `${prompt}\n${skill}\n`);
        const allowed = runHook('skill-barrier.cjs', edit, LOOP, dir);
        expect(allowed.status).toBe(0);
        // Guard ту же правку теста под контекстом пропускает: держит её барьер скиллов.
        expect(guard(edit, LOOP).status).toBe(0);
    });
});

// Ревью Фазы 16c: проба снимала с окружения хука только контекст, а сессия не получает и
// переменных команды хука. Раннер со случайным `RALPH_CORE_SHA` в окружении проходил бы пробу
// хука дерева контрактом, которого у живой сессии нет.
describe('probeHookEnv — окружение хука под пробой как у сессии', () => {
    it('снимает контекст и все переменные команды хука, кладёт явное', () => {
        const base: NodeJS.ProcessEnv = { A: '1', [SESSION_CONTEXT_ENV]: 'чужой' };
        for (const k of HOOK_COMMAND_ONLY_ENV) base[k] = 'унаследовано';
        const env = probeHookEnv(base, '/path/to/app', { env: { [SESSION_CONTEXT_ENV]: 'ctx' } });
        expect(env).toEqual({
            A: '1',
            CLAUDE_PROJECT_DIR: '/path/to/app',
            [SESSION_CONTEXT_ENV]: 'ctx',
        });
        expect(HOOK_COMMAND_ONLY_ENV).toEqual(
            expect.arrayContaining(['RALPH_CORE_SHA', 'RALPH_GUARD_ADAPTER', 'RALPH_GUARD_INPUT']),
        );
    });

    it('projectDirEnv=false снимает и унаследованный каталог', () => {
        expect(probeHookEnv({ CLAUDE_PROJECT_DIR: '/x' }, '/y', { projectDirEnv: false })).toEqual(
            {},
        );
    });
});

// Preflight: каждая регистрация guard обязана получить контекст. Регистрация, у которой он
// снят, сочла бы сессию человеческой — это отказ старта, а не `loop=false`.
describe('preflight: регистрация guard без контекста — отказ', { timeout: 30_000 }, () => {
    const settings = JSON.parse(readFileSync(path.join(CANON, '.claude/settings.json'), 'utf-8'));
    const built = loopSessionContext({ humanRoot: null, sessionTree: CANON, coreSha: '' });
    if (!built.ok) throw new Error(built.reason);
    const withGuard = (command: string) => ({
        hooks: {
            PreToolUse: [
                ...settings.hooks.PreToolUse,
                { matcher: 'Write|Edit', hooks: [{ type: 'command', command, timeout: 10 }] },
            ],
        },
    });
    const guardPath = path.join(HOOKS, 'guard.cjs');

    it('раскладка без roots: настройки дерева сессии канона — проба зелёная', () => {
        expect(
            sessionContextProblems(settings, CANON, built.value, { runHookFn: spawnHook }),
        ).toEqual([]);
    });

    it('вторая регистрация guard, которой контекст не дошёл, — проблема с её командой', () => {
        const command = `env -u ${SESSION_CONTEXT_ENV} RALPH_CORE_SHA= node '${guardPath}'`;
        const problems = sessionContextProblems(withGuard(command), CANON, built.value, {
            runHookFn: spawnHook,
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(command);
        expect(problems[0]).toMatch(/не получила контекст сессии.*код выхода 0/);
    });

    // Ревью Фазы 16c: дефис в разборе имени ради заглушки делал регистрацией guard и хук
    // потребителя `secret-guard.cjs` — старт требовал от него забора данных контура.
    it('хук потребителя с похожим именем регистрацией guard не считается', () => {
        const calls: string[] = [];
        const problems = sessionContextProblems(
            {
                hooks: {
                    PreToolUse: [
                        {
                            matcher: 'Write',
                            hooks: [{ type: 'command', command: 'node secret-guard.cjs' }],
                        },
                    ],
                },
            },
            CANON,
            built.value,
            {
                runHookFn: (hook) => {
                    calls.push(hook.command);
                    return { status: 0, stderr: '' };
                },
            },
        );
        expect(calls).toEqual([]);
        expect(problems).toEqual([expect.stringMatching(/нет регистрации guard\.cjs на Write/)]);
    });

    it('двойка без своего кода причины — проблема с причиной разбора, а не зачёт', () => {
        const run = (stderr: string) =>
            sessionContextProblems(withGuard(`node '${guardPath}'`), CANON, built.value, {
                runHookFn: () => ({ status: 2, stderr }),
            });
        expect(run('блок без строки кода')[0]).toMatch(
            /код причины в stderr нет строки кода причины; ждали contour-data/,
        );
        expect(run('ralph-reason-code: secret-env')[0]).toMatch(
            /код причины secret-env; ждали contour-data/,
        );
    });

    it('регистрации guard на Write нет — проблема, а не «проверять нечего»', () => {
        const problems = sessionContextProblems({ hooks: {} }, CANON, built.value, {
            runHookFn: spawnHook,
        });
        expect(problems).toEqual([expect.stringMatching(/нет регистрации guard\.cjs на Write/)]);
    });

    it('ensureGuardHolds с контекстом отказывает старту по той же причине', () => {
        const fails: string[] = [];
        ensureGuardHolds(CANON, {
            failFn: (m) => fails.push(m),
            logFn: () => {},
            settings: withGuard(`env -u ${SESSION_CONTEXT_ENV} node '${guardPath}'`),
            sessionContext: built.value,
            runHookFn: spawnHook,
        });
        expect(fails).toHaveLength(1);
        expect(fails[0]).toMatch(/claude-code: правка данных контура в сессии петли/);
    });

    it('ensureGuardHolds без регистраций-обходов — старт проходит', () => {
        const fails: string[] = [];
        ensureGuardHolds(CANON, {
            failFn: (m) => fails.push(m),
            logFn: () => {},
            settings,
            sessionContext: built.value,
            runHookFn: spawnHook,
        });
        expect(fails).toEqual([]);
    });
});

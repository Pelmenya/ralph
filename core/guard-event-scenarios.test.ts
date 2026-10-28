// Guard на нормализованном событии (#186) — сценарии петли на НАСТОЯЩИХ хуках процессом.
//
// Петля канона работает на Claude Code, пока идут Фазы 16c–16f, и переключение guard на
// событие не вправе её остановить: разрешённые сценарии текущей петли — правка кода, правка
// теста после `Skill(vitest)`, MCP-чтение из контура, git-коммит — обязаны пройти ту самую
// регистрацию, которую раннер собирает перед сессией (`buildSessionSettings`). Рядом —
// намеренные ужесточения у Claude Code списком (`docs/harness-contract.md`, «Изменения
// поведения у Claude Code»): каждое — с доказательством, что прежний вход пропускал вызов, иначе
// «ужесточение» могло бы оказаться тем, что и так блокировалось. И промежуточное состояние
// четырёх регистраций: Claude Code — через событие, Codex, Kimi Code и OpenCode — совместимым
// входом 16b, где их запреты держатся, а незнакомое по-прежнему проходит.
//
// Пробы живые, но безопасные: хук решает, вызов не исполняется — исполнять его некому.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from '../.claude/hooks/guard-rules.cjs';
import { reasonCodeOf } from '../adapters/barrier-reason.ts';
import { coreIsRepoRoot } from '../tests/core-repo.ts';
import { GUARD_COMPAT_INPUT, GUARD_INPUT_ENV, guardHooksOf, hooksFor } from './guard-probe.ts';
import { GUARD_ADAPTER_ENV, buildSessionSettings } from './session-settings.ts';
import { SESSION_CONTEXT_ENV } from './session-context.ts';

const CANON_ROOT = path.resolve(import.meta.dirname, '..');
const CANON_DATA = path.join(CANON_ROOT, '.claude', 'ralph', 'hooks.json');
/** Временный каталог хуков: маркеры барьера скиллов ложатся сюда, а не в общий tmp машины. */
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'guard-event-tmp-'));

/** Регистрация раннера для дерева человека `humanRoot`: та, что уйдёт сессии петли. */
const sessionSettings = (humanRoot: string) =>
    buildSessionSettings({ productRoot: CANON_ROOT, humanRoot, coreSha: '', humanSettings: {} });

/** Дерево человека с данными контура: канона как есть или заданными. */
function humanTree(data: string = readFileSync(CANON_DATA, 'utf-8')): string {
    const root = mkdtempSync(path.join(tmpdir(), 'guard-event-human-'));
    mkdirSync(path.join(root, '.claude', 'ralph'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'ralph', 'hooks.json'), data);
    return root;
}

/** Транскрипт сессии петли: промпт и, если задан, вызов скилла. */
function transcript(skill: string | null): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-event-transcript-'));
    const lines = [{ type: 'user', message: { content: 'Прочитай ralph.md в корне дерева' } }];
    if (skill) {
        lines.push({
            type: 'assistant',
            message: {
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill } }],
            },
        } as never);
    }
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    return file;
}

const LOOP_CONTEXT = JSON.stringify({
    sessionId: 'guard-event',
    loop: true,
    coreRevision: '',
    roots: { consumer: CANON_ROOT, execution: CANON_ROOT },
});

type Verdict = { status: 'allowed' } | { status: 'blocked'; code: string | null };

/** Все хуки регистрации на этот инструмент, как их позовёт Claude Code: блок — любой код 2. */
function claudeVerdict(
    settings: unknown,
    toolName: string,
    toolInput: Record<string, unknown>,
    transcriptPath: string = transcript(null),
): Verdict {
    // Своя сессия на каждый вызов: барьер скиллов кэширует загрузку маркером по session_id, и
    // общий id перенёс бы скилл из одного сценария в другой.
    const payload = JSON.stringify({
        session_id: `guard-event-${randomUUID()}`,
        transcript_path: transcriptPath,
        cwd: CANON_ROOT,
        permission_mode: 'bypassPermissions',
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: 'toolu_guard_event',
    });
    const hooks = hooksFor(settings, toolName);
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
        const r = spawnSync('sh', ['-c', hook.command], {
            cwd: CANON_ROOT,
            input: payload,
            encoding: 'utf-8',
            timeout: hook.timeoutSec * 1000,
            env: {
                ...process.env,
                CLAUDE_PROJECT_DIR: CANON_ROOT,
                TMPDIR: SCRATCH,
                [SESSION_CONTEXT_ENV]: LOOP_CONTEXT,
                [GUARD_ADAPTER_ENV]: '',
                [GUARD_INPUT_ENV]: '',
            },
        });
        if (r.status === 2) return { status: 'blocked', code: reasonCodeOf(r.stderr).code };
        expect(r.status, `${hook.command}: ${r.stderr}`).toBe(0);
    }
    return { status: 'allowed' };
}

const allowed: Verdict = { status: 'allowed' };
const blocked = (code: string): Verdict => ({ status: 'blocked', code });

describe.skipIf(!coreIsRepoRoot())('сценарии текущей петли проходят guard на событии', () => {
    const settings = sessionSettings(humanTree());

    it.each([
        ['правка кода', 'Edit', { file_path: 'core/gate.ts', old_string: 'a', new_string: 'b' }],
        ['запись кода', 'Write', { file_path: 'core/new-module.ts', content: 'export {};\n' }],
        ['чтение кода со смещением', 'Read', { file_path: 'core/gate.ts', offset: 1, limit: 40 }],
        ['загрузка скилла', 'Skill', { skill: 'vitest' }],
        [
            'поиск отложенного инструмента',
            'ToolSearch',
            { query: 'select:Monitor', max_results: 1 },
        ],
        ['MCP-чтение из контура', 'mcp__sourcecraft__GetIssue', { issue_slug: '1' }],
        ['MCP-мутация рабочего цикла', 'mcp__sourcecraft__CreateIssueComment', { body: 'x' }],
        ['git add', 'Bash', { command: 'git add -A', description: 'Индекс' }],
        [
            'git commit',
            'Bash',
            { command: 'git commit -qm "feat: x (#1)"', timeout: 600000, description: 'Коммит' },
        ],
        ['тесты в переднем плане', 'Bash', { command: 'npx vitest run core/gate.test.ts' }],
    ])('%s (%s) — проходит', (_what, tool, input) => {
        expect(claudeVerdict(settings, tool, input)).toEqual(allowed);
    });

    it('загрузка скилла → правка теста проходит; без загрузки — блок барьера скиллов', () => {
        const edit = { file_path: 'core/gate.test.ts', old_string: 'a', new_string: 'b' };
        expect(claudeVerdict(settings, 'Edit', edit, transcript('vitest'))).toEqual(allowed);
        expect(claudeVerdict(settings, 'Edit', edit, transcript(null))).toEqual(
            blocked('skill-required'),
        );
    });

    it('существующие запреты не ослаблены', () => {
        expect(claudeVerdict(settings, 'Bash', { command: 'rm -rf ./x' })).toEqual(
            blocked('destructive'),
        );
        expect(claudeVerdict(settings, 'Read', { file_path: '.env' })).toEqual(
            blocked('secret-env'),
        );
        expect(
            claudeVerdict(settings, 'Write', {
                file_path: '.claude/ralph/hooks.json',
                content: '',
            }),
        ).toEqual(blocked('contour-data'));
        expect(claudeVerdict(settings, 'mcp__sourcecraft__SetDecision', {})).toEqual(
            blocked('mcp-not-allowed'),
        );
    });
});

/**
 * Изменения поведения у Claude Code — НАМЕРЕННЫЕ ужесточения контракта, списком. У каждого:
 * вызов, код блока на событии и вердикт прежнего входа (`decide`) — пропуск.
 */
const TIGHTENINGS: {
    what: string;
    tool: string;
    input: Record<string, unknown>;
    code: string;
    data?: string;
}[] = [
    {
        what: 'незнакомый инструмент блокируется (было — пропуск)',
        tool: 'SendMessage',
        input: { to: 'main', message: 'm' },
        code: 'unknown-tool',
    },
    {
        what: 'поле вне перечня блокируется (было — не замечено)',
        tool: 'Read',
        input: { file_path: 'core/gate.ts', path: 'core/other.ts' },
        code: 'unknown-field',
    },
    {
        what: 'Monitor с командой оболочки судится как оболочка (был мимо matcher)',
        tool: 'Monitor',
        input: { command: 'tail -f .env', description: 'd', timeout_ms: 1000 },
        code: 'secret-env',
    },
    {
        what: 'Grep по шаблону env-файла — чтение секрета (шаблон пути барьер не судил)',
        tool: 'Grep',
        input: { pattern: 'A=', glob: '**/*.env' },
        code: 'secret-env',
    },
    {
        what: 'WebFetch в сессии петли — возможность без политики сети',
        tool: 'WebFetch',
        input: { url: 'https://example.com', prompt: 'p' },
        code: 'capability-unjudged',
    },
    {
        what: 'субагент в сессии петли — наследование барьеров не доказано',
        tool: 'Agent',
        input: { description: 'd', prompt: 'p', subagent_type: 'Explore' },
        code: 'capability-unjudged',
    },
    {
        what: 'эффект MCP задаёт политика, а не префикс Get имени',
        tool: 'mcp__sourcecraft__GetRepository',
        input: {},
        code: 'mcp-not-allowed',
        data: JSON.stringify({
            mcp: {
                writeAllowed: [],
                tools: { mcp__sourcecraft__GetIssue: { effect: 'read' } },
            },
        }),
    },
];

describe.skipIf(!coreIsRepoRoot())('Изменения поведения у Claude Code (#186)', () => {
    it.each(TIGHTENINGS.map((t) => [t.what, t] as const))('%s', (_what, t) => {
        const settings = sessionSettings(humanTree(t.data));
        expect(claudeVerdict(settings, t.tool, t.input)).toEqual(blocked(t.code));
        // Прежний вход тот же вызов пропускал: ужесточение настоящее, а не совпадение.
        expect(decide(t.tool, t.input, { loop: true }).blocked).toBe(false);
    });

    it('разрешённое политикой MCP-чтение по-прежнему проходит', () => {
        const settings = sessionSettings(humanTree(TIGHTENINGS.at(-1)?.data));
        expect(claudeVerdict(settings, 'mcp__sourcecraft__GetIssue', {})).toEqual(allowed);
    });
});

describe.skipIf(!coreIsRepoRoot())('промежуточное состояние четырёх регистраций', () => {
    const settings = sessionSettings(humanTree());

    it('Claude Code: регистрация раннера несёт путь нормализатора и судит событие', () => {
        const guard = hooksFor(settings, 'SendMessage').filter((h) => /guard\.cjs/.test(h.command));
        expect(guard).toHaveLength(1);
        expect(guard[0].command).toContain(`${GUARD_ADAPTER_ENV}=`);
        expect(claudeVerdict(settings, 'SendMessage', {})).toEqual(blocked('unknown-tool'));
    });

    /** Хук моста процессом: окружение без `CLAUDE_PROJECT_DIR` — его ставит только Claude Code. */
    const bridgeVerdict = (command: string, toolName: string, toolInput: object): Verdict => {
        const env: NodeJS.ProcessEnv = { ...process.env, [SESSION_CONTEXT_ENV]: LOOP_CONTEXT };
        delete env.CLAUDE_PROJECT_DIR;
        const r = spawnSync('sh', ['-c', command], {
            cwd: CANON_ROOT,
            input: JSON.stringify({
                session_id: 'bridge',
                hook_event_name: 'PreToolUse',
                cwd: CANON_ROOT,
                tool_name: toolName,
                tool_input: toolInput,
            }),
            encoding: 'utf-8',
            env,
        });
        if (r.status === 2) return { status: 'blocked', code: reasonCodeOf(r.stderr).code };
        expect(r.status, r.stderr).toBe(0);
        return allowed;
    };

    it('Codex, Kimi Code и OpenCode: совместимый вход 16b — запреты держатся', () => {
        const hooks = guardHooksOf(settings, CANON_ROOT).filter((h) =>
            /guard\.cjs/.test(h.command),
        );
        expect(hooks).toHaveLength(1);
        const [{ command }] = hooks;
        expect(command).toContain(`${GUARD_INPUT_ENV}=${GUARD_COMPAT_INPUT}`);
        expect(bridgeVerdict(command, 'Bash', { command: 'rm -rf ./x' })).toEqual(
            blocked('destructive'),
        );
        // Форма Kimi Code: путь файла — `path`.
        expect(bridgeVerdict(command, 'Read', { path: '.env' })).toEqual(blocked('secret-env'));
        expect(bridgeVerdict(command, 'mcp__probe__DeleteRepository', {})).toEqual(
            blocked('mcp-not-allowed'),
        );
        expect(bridgeVerdict(command, 'Bash', { command: 'git status' })).toEqual(allowed);
        // Незнакомое на совместимом входе проходит, как в 16b: строгость к нему у этих
        // харнессов придёт с их нормализаторами (16d), а заглушка сейчас блокировала бы всё.
        expect(bridgeVerdict(command, 'SendMessage', {})).toEqual(allowed);
    });
});

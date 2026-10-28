// Проба барьера поверх реестра пакетов (#180): отвергнутый пакет — отказ старта с причиной,
// харнесс выбирается только реестром (мост 16b снят, #213), и разрешённые сценарии текущей
// петли проходят настоящие хуки канона, собранные пакетом Claude Code.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coreIsRepoRoot } from '../tests/core-repo.ts';
import {
    ALL_PACKAGES,
    HARNESS_REGISTRY,
    SESSION_SETTINGS_HARNESS,
    type HarnessRegistry,
} from '../adapters/harness-registry.ts';
import type { HarnessPackage } from '../adapters/harness-package.ts';
import {
    codexArgsProblems,
    ensureGuardHolds,
    kimiTomlProblems,
    opencodePluginProblems,
    harnessGuardProblems,
    harnessRoutes,
    unguardedRoutes,
    type TRunHookFn,
} from './guard-probe.ts';
import { heldRun } from '../tests/guard-fake.ts';

const CANON_ROOT = path.resolve(import.meta.dirname, '..');

const settingsWith = (matcher: string) => ({
    hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'node guard.cjs' }] }] },
});

const goodGuard: TRunHookFn = (_hook, payload) => heldRun(payload);

const INCOMPATIBLE = 'package.ts: несовместимая версия интерфейса 2 (реестр знает 1)';

/** Реестр канона с подменой: пакеты сверху, отказы рядом. */
function registryWith(
    over: {
        packages?: Record<string, HarnessPackage | null>;
        problems?: Record<string, string[]>;
    } = {},
): HarnessRegistry {
    const packages = new Map(HARNESS_REGISTRY.packages);
    const claude = HARNESS_REGISTRY.packages.get(SESSION_SETTINGS_HARNESS)!;
    for (const [name, pkg] of Object.entries(over.packages ?? {})) {
        if (pkg === null) packages.delete(name);
        else packages.set(name, { ...claude, pkg });
    }
    return { packages, problems: new Map(Object.entries(over.problems ?? {})) };
}

describe('отвергнутый пакет — отказ старта с причиной реестра', () => {
    it('пакет харнесса настроек с несовместимой версией интерфейса — старт отменён', () => {
        const fails: string[] = [];
        let runs = 0;
        ensureGuardHolds('/x', {
            failFn: (m) => fails.push(m),
            logFn: () => {},
            settings: settingsWith('Bash|Read|Grep|mcp__.*'),
            registry: registryWith({
                packages: { 'claude-code': null },
                problems: { 'claude-code': [INCOMPATIBLE] },
            }),
            runHookFn: (h, p, d) => {
                runs += 1;
                return goodGuard(h, p, d);
            },
        });
        expect(fails).toHaveLength(1);
        expect(fails[0]).toMatch(
            /claude-code: пакет харнесса «claude-code» не принят реестром: package\.ts: несовместимая версия интерфейса 2/,
        );
        expect(runs).toBe(0);
    });

    it('маршрут в харнесс отвергнутого пакета — место в конфиге и причина', () => {
        const registry = registryWith({ problems: { 'mystery-cli': [INCOMPATIBLE] } });
        const found = unguardedRoutes(
            harnessRoutes({ coderRuntime: 'x' }, () => 'mystery-cli'),
            registry,
        );
        expect(found).toEqual([
            `adapters.coderRuntime = 'x': пакет харнесса «mystery-cli» не принят реестром: ${INCOMPATIBLE} — сессия не стартует`,
        ]);
    });

    it('каталог пакетов не прочитан — проба харнесса настроек называет причину', () => {
        const registry: HarnessRegistry = {
            packages: new Map(),
            problems: new Map([[ALL_PACKAGES, ['каталог пакетов /p не прочитан: EACCES']]]),
        };
        expect(
            harnessGuardProblems('claude-code', settingsWith('Bash'), '/x', { registry }),
        ).toEqual([
            'пакет харнесса «claude-code» не принят реестром: каталог пакетов /p не прочитан: EACCES — доказать guard нечем',
        ]);
    });

    it('отвергнутый пакет вне маршрутов — строка ⚠, старт не держит', () => {
        const fails: string[] = [];
        const logs: string[] = [];
        ensureGuardHolds('/x', {
            failFn: (m) => fails.push(m),
            logFn: (m) => logs.push(m),
            settings: settingsWith('Bash|Read|Grep|mcp__.*'),
            registry: registryWith({ problems: { spare: [INCOMPATIBLE] } }),
            runHookFn: goodGuard,
        });
        expect(fails).toEqual([]);
        expect(logs).toContain(`⚠ пакет харнесса «spare» не принят реестром: ${INCOMPATIBLE}`);
    });
});

describe('выбор харнесса — реестром', () => {
    // #213: мост 16b снят — все четыре харнесса выбираются реестром, проводка — его пакеты.
    it('все четыре харнесса — пакеты реестра, моста нет', () => {
        expect([...HARNESS_REGISTRY.packages.keys()].sort()).toEqual([
            'claude-code',
            'codex',
            'kimi-code',
            'opencode',
        ]);
        expect(HARNESS_REGISTRY.problems).toEqual(new Map());
        const registry = registryWith({ packages: { 'claude-code': null } });
        expect(unguardedRoutes(harnessRoutes({ coderRuntime: 'claude' }), registry)[0]).toMatch(
            /«claude-code» не передаётся CLI/,
        );
    });

    it('харнесс с пакетом пробуется регистрацией пакета', () => {
        const claude = HARNESS_REGISTRY.packages.get('claude-code')!.pkg;
        const calls: string[] = [];
        const codex: HarnessPackage = {
            ...claude,
            harness: 'codex',
            skillBarrier: false,
            guardRegistration: (s) => {
                calls.push('пакет');
                return claude.guardRegistration(s);
            },
        };
        const problems = harnessGuardProblems(
            'codex',
            settingsWith('Bash|Read|Grep|mcp__.*'),
            '/x',
            {
                registry: registryWith({ packages: { codex } }),
                runHookFn: goodGuard,
            },
        );
        expect(problems).toEqual([]);
        expect(calls).toEqual(['пакет']);
    });

    // #181, #213: Codex, Kimi Code и OpenCode сняты с моста — без пакета в реестре доказать
    // guard нечем, и маршрут в такой харнесс — отказ старта.
    it.each(['codex', 'kimi-code', 'opencode'])(
        '%s выбирается реестром, а не мостом',
        (harness) => {
            const registry = registryWith({ packages: { [harness]: null } });
            expect(
                unguardedRoutes(
                    harnessRoutes({ coderRuntime: 'x' }, () => harness),
                    registry,
                ),
            ).toHaveLength(1);
            expect(harnessGuardProblems(harness, settingsWith('Bash'), '/x', { registry })).toEqual(
                [`харнесс «${harness}»: регистрации барьера для него нет — доказать guard нечем`],
            );
        },
    );

    it('готовая регистрация сборщика пробуется пакетом: без пакета — причина реестра', () => {
        const registry = registryWith({
            packages: { codex: null, 'kimi-code': null, opencode: null },
        });
        expect(codexArgsProblems([], '/x', { registry })).toEqual([
            'пакета харнесса «codex» в реестре нет — доказать guard нечем',
        ]);
        expect(kimiTomlProblems('', '/x', { registry })).toEqual([
            'пакета харнесса «kimi-code» в реестре нет — доказать guard нечем',
        ]);
        expect(opencodePluginProblems('', '/x', { registry })).toEqual([
            'пакета харнесса «opencode» в реестре нет — доказать guard нечем',
        ]);
    });

    it('исходник плагина пакету без регистрации плагином — отказ, а не проба хуками', () => {
        const claude = HARNESS_REGISTRY.packages.get('claude-code')!.pkg;
        const registry = registryWith({
            packages: { opencode: { ...claude, harness: 'opencode' } },
        });
        expect(opencodePluginProblems('', '/x', { registry })).toEqual([
            'пакет харнесса «opencode» регистрирует барьер не плагином',
        ]);
    });

    it('предел барьера — строкой ⚠ по полю пакета, а не по имени харнесса', () => {
        const claude = HARNESS_REGISTRY.packages.get('claude-code')!.pkg;
        const logs: string[] = [];
        ensureGuardHolds('/x', {
            failFn: (m) => {
                throw new Error(m);
            },
            logFn: (m) => logs.push(m),
            settings: settingsWith('Bash|Read|Grep|mcp__.*'),
            registry: registryWith({
                packages: { 'claude-code': { ...claude, guardLimit: 'предел пробы' } },
            }),
            runHookFn: goodGuard,
        });
        expect(logs).toContain('⚠ предел пробы');
    });

    it('предел барьера скиллов — по признаку пакета, а не по имени харнесса', () => {
        const claude = HARNESS_REGISTRY.packages.get('claude-code')!.pkg;
        const logs: string[] = [];
        ensureGuardHolds('/x', {
            failFn: (m) => {
                throw new Error(m);
            },
            logFn: (m) => logs.push(m),
            settings: settingsWith('Bash|Read|Grep|mcp__.*'),
            registry: registryWith({
                packages: { 'claude-code': { ...claude, skillBarrier: false } },
            }),
            runHookFn: goodGuard,
        });
        expect(logs.join('\n')).toMatch(/⚠ claude-code: барьер скиллов не зарегистрирован/);
    });
});

// Регрессия петли канона (#180): пока идут Фазы 16c–16f, петля работает на Claude Code, и
// разрешённое ею не должно закрыться переносом харнесса в пакет. Хуки — настоящие, из
// `.claude/settings.json` канона, разобранные пакетом; вход — в форме пакета; окружение —
// сессии петли (`RALPH_SKILL_GUARD=on`). От противного — правка теста без скилла блокируется.
describe.skipIf(!coreIsRepoRoot())('разрешённые сценарии петли проходят хуки пакета', () => {
    const pkg = HARNESS_REGISTRY.packages.get('claude-code')!.pkg;
    const settings = JSON.parse(
        readFileSync(path.join(CANON_ROOT, '.claude', 'settings.json'), 'utf-8'),
    ) as unknown;
    let dir = '';
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = '';
    });

    /** Транскрипт сессии, в которой вызван `Skill(vitest)`. */
    const transcriptWithSkill = () => {
        dir = mkdtempSync(path.join(tmpdir(), 'loop-scenario-'));
        const file = path.join(dir, 'transcript.jsonl');
        const call = {
            type: 'assistant',
            message: {
                content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'vitest' } }],
            },
        };
        writeFileSync(file, `${JSON.stringify(call)}\n`);
        return file;
    };

    /** Коды выхода всех хуков, которые CLI позовёт на этот вызов. */
    function run(toolName: string, toolInput: Record<string, unknown>, transcript?: string) {
        const { hooks, problems } = pkg.guardRegistration(settings);
        expect(problems).toEqual([]);
        const covering = hooks.filter((h) => pkg.matcherCovers(h.matcher, toolName));
        expect(covering.length).toBeGreaterThan(0);
        const payload = JSON.parse(
            pkg.hookPayload(
                { what: 'сценарий', toolName, toolInput, expect: 'allowed' },
                CANON_ROOT,
            ),
        ) as Record<string, unknown>;
        payload.session_id = `loop-scenario-${process.pid}-${toolName}-${Date.now()}`;
        if (transcript) payload.transcript_path = transcript;
        return covering.map((h) => {
            const r = spawnSync('sh', ['-c', h.command], {
                cwd: CANON_ROOT,
                input: JSON.stringify(payload),
                encoding: 'utf-8',
                timeout: h.timeoutSec * 1000,
                env: { ...process.env, CLAUDE_PROJECT_DIR: CANON_ROOT, RALPH_SKILL_GUARD: 'on' },
            });
            return `${r.status}${r.status === 0 ? '' : `: ${r.stderr.trim().slice(0, 200)}`}`;
        });
    }

    it('правка кода', () => {
        const codes = run('Edit', {
            file_path: path.join(CANON_ROOT, 'core', 'gate.ts'),
            old_string: 'a',
            new_string: 'b',
        });
        expect(codes.every((c) => c === '0')).toBe(true);
    });

    it('правка теста после Skill(vitest)', () => {
        const codes = run(
            'Edit',
            {
                file_path: path.join(CANON_ROOT, 'core', 'gate.test.ts'),
                old_string: 'a',
                new_string: 'b',
            },
            transcriptWithSkill(),
        );
        expect(codes.every((c) => c === '0')).toBe(true);
    });

    it('от противного: правка теста без скилла — блок', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'loop-scenario-'));
        const empty = path.join(dir, 'transcript.jsonl');
        writeFileSync(empty, '');
        const codes = run(
            'Edit',
            {
                file_path: path.join(CANON_ROOT, 'core', 'gate.test.ts'),
                old_string: 'a',
                new_string: 'b',
            },
            empty,
        );
        expect(codes.some((c) => c.startsWith('2'))).toBe(true);
    });

    it('MCP-чтение из контура', () => {
        const codes = run('mcp__sourcecraft__ListIssues', {});
        expect(codes.every((c) => c === '0')).toBe(true);
    });

    it('git-коммит', () => {
        const codes = run('Bash', { command: 'git commit -m "feat: x (#1)"' });
        expect(codes.every((c) => c === '0')).toBe(true);
    });
});

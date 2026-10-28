// Отрицательная проба барьера (канон, задача 6). Два уровня:
//   1. разбор и вердикт на фейковых исходах хуков — какие ответы барьера проба принимает;
//   2. живой прогон на НАСТОЯЩИХ настройках и хуках канона и на подложных деревьях, где
//      хук падает, пропускает всё или не подключён. Хуки здесь запускаются процессом —
//      иначе проба доказывала бы разбор настроек, а не то, что увидит сессия.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreIsRepoRoot } from '../tests/core-repo.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';
import {
    GUARD_PROBES,
    CONTEXT_UNPROVEN_LIMIT,
    ensureGuardHolds,
    harnessLayerProblems,
    harnessRoutes,
    PROJECT_LAYERS_LIMIT,
    harnessGuardProblems,
    hooksFor,
    matcherCovers,
    probePayload,
    probeProblems,
    codexArgsProblems,
    guardHooksOf,
    guardInputOf,
    kimiTomlProblems,
    opencodePluginProblems,
    runHook,
    runOpencodePlugin,
    unguardedRoutes,
    type TRunHookFn,
    type TRunPluginFn,
} from './guard-probe.ts';
import {
    OPENCODE_PLUGIN_DRIVER,
    codexGuardArgs,
    kimiHooksToml,
    opencodeGuardPlugin,
    type GuardHook,
} from '../adapters/harness-guard.ts';
import { readFileSync } from 'node:fs';
import { HARNESS_REGISTRY, normalizerPathIn } from '../adapters/harness-registry.ts';
import { heldRun } from '../tests/guard-fake.ts';

const CANON_ROOT = path.resolve(import.meta.dirname, '..');

/** Живой запуск хука — то же, что боевой `runHook`, но мимо предохранителя побочек. */
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
        // Контекст пробы правила петли (#232) — то, что кладёт боевой `runHook`.
        env: { ...hookEnv(projectDir, opts.projectDirEnv !== false), ...opts.env },
    });
    return { status: r.status, stderr: r.stderr ?? '' };
};

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

const settingsWith = (matcher: string, command = 'node guard.cjs') => ({
    hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command }] }] },
});

/** Барьер «как должно быть»: 2 на запрещённом, 0 на безобидном. */
const goodGuard: TRunHookFn = (_hook, payload) => heldRun(payload);

describe('matcher и выбор хуков — семантика Claude Code', () => {
    it('пустой и `*` накрывают всё, иначе — регулярное выражение по имени целиком', () => {
        expect(matcherCovers(undefined, 'Bash')).toBe(true);
        expect(matcherCovers('', 'Read')).toBe(true);
        expect(matcherCovers('*', 'mcp__x__y')).toBe(true);
        expect(matcherCovers('Bash|Read', 'Read')).toBe(true);
        expect(matcherCovers('Bash', 'BashOutput')).toBe(false);
        expect(matcherCovers('Edit|Write', 'Bash')).toBe(false);
        expect(matcherCovers('(', 'Bash')).toBe(false); // битый regex хук не зовёт
        expect(matcherCovers(42, 'Bash')).toBe(false);
    });

    it('берёт только command-хуки PreToolUse с накрывающим matcher и таймаутом по умолчанию', () => {
        const settings = {
            hooks: {
                PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'post' }] }],
                PreToolUse: [
                    { matcher: 'Bash', hooks: [{ type: 'command', command: 'a', timeout: 5 }] },
                    { matcher: 'Read', hooks: [{ type: 'command', command: 'b' }] },
                    { matcher: 'Bash', hooks: [{ type: 'prompt', command: 'c' }, 'мусор'] },
                    'мусор',
                ],
            },
        };
        expect(hooksFor(settings, 'Bash')).toEqual([
            { command: 'a', timeoutSec: 5, cannotBlock: null },
        ]);
        expect(hooksFor(settings, 'Read')).toEqual([
            { command: 'b', timeoutSec: 60, cannotBlock: null },
        ]);
        expect(hooksFor({}, 'Bash')).toEqual([]);
        expect(hooksFor(null, 'Bash')).toEqual([]);
    });

    it('вход хука — в форме Claude Code, без транскрипта', () => {
        const payload = JSON.parse(probePayload(GUARD_PROBES[0], '/path/to/app')) as Record<
            string,
            unknown
        >;
        expect(payload).toMatchObject({
            hook_event_name: 'PreToolUse',
            cwd: '/path/to/app',
            tool_name: 'Bash',
            tool_input: { command: 'rm -rf ./.ralph-guard-probe' },
        });
        expect(payload).not.toHaveProperty('transcript_path');
    });
});

describe('вердикт пробы на исходах хуков', () => {
    const all = settingsWith('Bash|Read|Edit|Grep|mcp__.*');

    it('барьер держит — проблем нет', () => {
        expect(probeProblems(all, '/x', { runHookFn: goodGuard })).toEqual([]);
    });

    it('хук пропустил запрещённое — названы все пропущенные пробы', () => {
        const problems = probeProblems(all, '/x', { runHookFn: () => ({ status: 0, stderr: '' }) });
        expect(problems.join('\n')).toContain('рекурсивное удаление');
        expect(problems.join('\n')).toContain('чтение env-файла инструментом Read');
        expect(problems.join('\n')).toContain('чтение env-файла из оболочки');
        expect(problems.join('\n')).toContain('чтение env-файла инструментом Grep');
        expect(problems.join('\n')).toContain('чтение env-файла через sed');
    });

    it('disableAllHooks — проба красная, хуки не запускаются вовсе', () => {
        let runs = 0;
        const problems = probeProblems({ ...all, disableAllHooks: true }, '/x', {
            runHookFn: (h, p, d) => {
                runs += 1;
                return goodGuard(h, p, d);
            },
        });
        expect(problems.join('\n')).toContain('disableAllHooks');
        expect(runs).toBe(0);
    });

    // У этих полей exit 2 ещё не блокировка сессии: проба, засчитавшая его, была бы
    // зелёной при барьере, который в бою опаздывает или не зовётся (ревью Kimi).
    it.each([
        ['async', { async: true }, /async/],
        ['once', { once: true }, /once/],
        ['if', { if: 'Bash(npm *)' }, /if:/],
    ] as const)('хук с %s не считается блокирующим', (_name, extra, why) => {
        const settings = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash|Read|Edit|Grep|mcp__.*',
                        hooks: [{ type: 'command', command: 'guard', ...extra }],
                    },
                ],
            },
        };
        const problems = probeProblems(settings, '/x', { runHookFn: goodGuard });
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.join('\n')).toMatch(why);
    });

    it.each([1, 127, null])(
        'код %s — не блокировка: Claude Code исполнил бы вызов',
        (status: number | null) => {
            const problems = probeProblems(all, '/x', {
                runHookFn: () => ({ status, stderr: '' }),
            });
            expect(problems.join('\n')).toMatch(/блокирует только 2/);
        },
    );

    it('хук блокирует всё подряд — безобидная проба красная с его объяснением', () => {
        const problems = probeProblems(all, '/x', {
            runHookFn: () => ({ status: 2, stderr: 'Правила барьера не загрузились' }),
        });
        const safe = problems.filter((p) => p.includes('безобидная команда'));
        expect(safe).toHaveLength(1);
        expect(safe[0]).toContain('Правила барьера не загрузились');
    });

    it('от противного: блок всего по сбою загрузки запрещённые пробы не засчитывает (#183)', () => {
        // Двойка с кодом неисправности — ровно то, что выдаёт guard без правил. Прежде каждая
        // запрещённая проба на нём была зелёной, и красной оставалась одна безобидная.
        const problems = probeProblems(all, '/x', {
            runHookFn: () => ({
                status: 2,
                stderr: 'Правила барьера не загрузились\nralph-reason-code: rules-unloaded\n',
            }),
        });
        const blocked = GUARD_PROBES.filter((p) => p.expect === 'blocked');
        expect(blocked.length).toBeGreaterThan(0);
        for (const probe of blocked) {
            expect(problems.join('\n')).toContain(
                `${probe.what} (${probe.toolName}): вызов заблокирован, но не правилом — ` +
                    `ждали код причины ${probe.reasonCode}, получили: rules-unloaded`,
            );
        }
    });

    it('двойка без строки кода и с чужим кодом — тоже не правило', () => {
        const noCode = probeProblems(all, '/x', {
            runHookFn: (_h, payload) =>
                /git status/.test(payload) ? heldRun(payload) : { status: 2, stderr: 'нет' },
        });
        expect(noCode.join('\n')).toMatch(/получили: в stderr нет строки кода причины/);
        const wrong = probeProblems(all, '/x', {
            runHookFn: (_h, payload) =>
                /git status/.test(payload)
                    ? heldRun(payload)
                    : { status: 2, stderr: 'ralph-reason-code: destructive' },
        });
        // Удаление названо верно, остальные — чужим кодом.
        expect(wrong.join('\n')).not.toMatch(/рекурсивное удаление/);
        expect(wrong.join('\n')).toMatch(/ждали код причины secret-env, получили: destructive/);
    });

    it('хватает одного хука с кодом правила: хук потребителя со своей двойкой пробу не портит', () => {
        const two = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash|Read|Edit|Grep|mcp__.*',
                        hooks: [{ type: 'command', command: 'guard' }],
                    },
                    { matcher: 'Bash', hooks: [{ type: 'command', command: 'consumer' }] },
                ],
            },
        };
        const problems = probeProblems(two, '/x', {
            runHookFn: (hook, payload) =>
                hook.command === 'consumer' && !/git status/.test(payload)
                    ? { status: 2, stderr: 'свой отказ без кода' }
                    : heldRun(payload),
        });
        expect(problems).toEqual([]);
    });

    it('достаточно ОДНОГО блокирующего хука, но безобидное обязаны пропустить ВСЕ', () => {
        const two = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash|Read|Edit|Grep|mcp__.*',
                        hooks: [{ type: 'command', command: 'guard' }],
                    },
                    { matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] },
                ],
            },
        };
        const otherPassesAll: TRunHookFn = (hook, payload, dir) =>
            hook.command === 'other' ? { status: 0, stderr: '' } : goodGuard(hook, payload, dir);
        expect(probeProblems(two, '/x', { runHookFn: otherPassesAll })).toEqual([]);

        const otherBlocksAll: TRunHookFn = (hook, payload, dir) =>
            hook.command === 'other' ? { status: 2, stderr: '' } : goodGuard(hook, payload, dir);
        expect(probeProblems(two, '/x', { runHookFn: otherBlocksAll }).join('\n')).toContain(
            '«other»',
        );
    });

    it('matcher не накрывает инструмент — проба красная без запуска хука', () => {
        let runs = 0;
        const problems = probeProblems(settingsWith('Bash'), '/x', {
            runHookFn: (h, p, d) => {
                runs += 1;
                return goodGuard(h, p, d);
            },
        });
        expect(problems).toHaveLength(3);
        expect(problems.join('\n')).toMatch(/\(Read\): ни один PreToolUse-хук/);
        expect(problems.join('\n')).toMatch(/\(Grep\): ни один PreToolUse-хук/);
        // Ревью Фазы 16b: MCP накрывается только `mcp__…` — без него вызов шёл бы мимо.
        expect(problems.join('\n')).toMatch(
            /\(mcp__ralph-guard-probe__DeleteRepository\): ни один/,
        );
        expect(runs).toBe(4); // четыре пробы Bash, ни одной — Read, Grep и MCP
    });
});

describe('харнесс рантайма: guard обязан быть доказан', () => {
    const where = (sel: Parameters<typeof harnessRoutes>[0]) =>
        harnessRoutes(sel).map((r) => `${r.where} ${r.harness}`);

    it('claude и kimi — харнесс Claude Code, openai — Codex; у всех guard передаётся CLI', () => {
        expect(where({})).toEqual(["adapters.coderRuntime = 'claude' claude-code"]);
        expect(where({ coderRuntime: 'kimi' })).toEqual([
            "adapters.coderRuntime = 'kimi' claude-code",
        ]);
        const routes = harnessRoutes({
            coderRuntime: 'claude',
            modelRouting: {
                labels: { 'complexity:high': { provider: 'openai', model: 'm' }, a: 'haiku' },
                default: { provider: 'kimi', model: 'k' },
                apiLimitFallback: { provider: 'openai', model: 'm' },
            },
        });
        expect(routes.map((r) => `${r.where} ${r.harness}`)).toEqual([
            "adapters.coderRuntime = 'claude' claude-code",
            "modelRouting.labels.complexity:high → 'openai' codex",
            "modelRouting.default → 'kimi' claude-code",
            "modelRouting.apiLimitFallback → 'openai' codex",
        ]);
        expect(unguardedRoutes(routes)).toEqual([]);
    });

    // Ревью Фазы 16b: рантайм, достижимый только эскалацией лечения, на старте не пробовался.
    it('эскалация лечения — место выбора, как у reachableRuntimes оркестратора', () => {
        expect(
            where({
                coderRuntime: 'claude',
                modelRouting: {
                    healEscalation: { afterAttempts: 2, route: { provider: 'openai', model: 'm' } },
                },
            }),
        ).toEqual([
            "adapters.coderRuntime = 'claude' claude-code",
            "modelRouting.healEscalation.route → 'openai' codex",
        ]);
        expect(where({ modelRouting: { healEscalation: { afterAttempts: 2 } } })).toEqual([
            "adapters.coderRuntime = 'claude' claude-code",
        ]);
    });

    it('незнакомый рантайм — харнесс неизвестен, место названо, старт отменён', () => {
        const found = unguardedRoutes(
            harnessRoutes({ modelRouting: { labels: { x: { provider: 'mystery', model: 'm' } } } }),
        );
        expect(found).toEqual([
            "modelRouting.labels.x → 'mystery': харнесс рантайма неизвестен — guard не доказан, сессия не стартует",
        ]);
    });

    it('харнесс, чья регистрация не передаётся CLI, — отказ с именем харнесса', () => {
        const found = unguardedRoutes(harnessRoutes({ coderRuntime: 'x' }, () => 'mystery-cli'));
        expect(found[0]).toMatch(/«mystery-cli» не передаётся CLI/);
    });

    // #121: адаптер opencode кладёт плагин барьера в OPENCODE_CONFIG_DIR — харнесс проведён
    // (с #213 — пакетом реестра), и проба старта исполняет его плагин на событиях OpenCode.
    it('opencode: харнесс проведён, проба старта исполняет плагин', () => {
        expect(HARNESS_REGISTRY.packages.has('opencode')).toBe(true);
        expect(unguardedRoutes(harnessRoutes({ coderRuntime: 'opencode' }))).toEqual([]);
        const logs: string[] = [];
        const fails: string[] = [];
        const calls: string[] = [];
        const runPluginFn: TRunPluginFn = (_src, ev) => {
            const args = JSON.stringify(ev.output.args);
            calls.push(args);
            return heldRun(JSON.stringify(ev));
        };
        ensureGuardHolds('/x', {
            failFn: (m) => fails.push(m),
            logFn: (m) => logs.push(m),
            settings: settingsWith('Bash|Read|Edit|MultiEdit|Grep|mcp__.*'),
            runtimes: { coderRuntime: 'opencode' },
            runHookFn: goodGuard,
            runPluginFn,
        });
        expect(fails).toEqual([]);
        expect(calls.length).toBeGreaterThan(0);
        expect(logs[0]).toMatch(/Проба барьера пройдена \(claude-code, opencode\)/);
    });

    // #120: адаптер kimi-native отдаёт дом CLI с `[[hooks]]` — харнесс проведён, и конфиг на
    // нём проходит правило «guard доказан», а проба старта гоняет его регистрацию.
    it('kimi-native: харнесс Kimi Code проведён, проба старта гоняет его регистрацию', () => {
        expect(HARNESS_REGISTRY.packages.has('kimi-code')).toBe(true);
        expect(unguardedRoutes(harnessRoutes({ coderRuntime: 'kimi-native' }))).toEqual([]);
        const logs: string[] = [];
        const fails: string[] = [];
        ensureGuardHolds('/x', {
            failFn: (m) => fails.push(m),
            logFn: (m) => logs.push(m),
            settings: settingsWith('Bash|Read|Edit|Grep|mcp__.*'),
            runtimes: { coderRuntime: 'kimi-native' },
            runHookFn: goodGuard,
        });
        expect(fails).toEqual([]);
        expect(logs[0]).toMatch(/Проба барьера пройдена \(claude-code, kimi-code\)/);
    });
});

describe('регистрация харнесса: отказы, которые проба называет сама', () => {
    it('харнесс без регистрации — отказ «доказать guard нечем», хуки не запускаются', () => {
        let runs = 0;
        const problems = harnessGuardProblems('mystery', settingsWith('Bash'), '/x', {
            runHookFn: (h, p, d) => {
                runs += 1;
                return goodGuard(h, p, d);
            },
        });
        expect(problems).toEqual([
            'харнесс «mystery»: регистрации барьера для него нет — доказать guard нечем',
        ]);
        expect(runs).toBe(0);
    });

    it('битые записи PreToolUse в чужой формат не переносятся — проба Codex красная', () => {
        const garbage = { hooks: { PreToolUse: ['мусор', { matcher: 'Bash' }] } };
        expect(harnessGuardProblems('codex', garbage, '/x', { runHookFn: goodGuard })[0]).toMatch(
            /ни один PreToolUse-хук не накрывает/,
        );
        expect(
            harnessGuardProblems('codex', { hooks: { PreToolUse: {} } }, '/x', {
                runHookFn: goodGuard,
            }).length,
        ).toBeGreaterThan(0);
    });

    it('плагин OpenCode без списка хуков или с хуком не на те инструменты — отказ без запуска', () => {
        let runs = 0;
        const runPluginFn: TRunPluginFn = () => {
            runs += 1;
            return { status: 2, stderr: '' };
        };
        expect(opencodePluginProblems('export {};', '/x', { runPluginFn })[0]).toMatch(
            /нет списка/,
        );
        const onlyEdit = opencodeGuardPlugin([{ matcher: 'Write', command: 'g', timeoutSec: 5 }]);
        const problems = opencodePluginProblems(onlyEdit, '/x', { runPluginFn });
        expect(problems[0]).toMatch(/\(bash\): ни один хук плагина не накрывает/);
        expect(runs).toBe(0);
    });
});

describe('ensureGuardHolds — старт отменяется до первой сессии', () => {
    const calls = () => {
        const failed: string[] = [];
        const logged: string[] = [];
        return {
            failed,
            logged,
            failFn: (m: string) => failed.push(m),
            logFn: (m: string) => logged.push(m),
        };
    };

    it('настроек нет — fail, а не «хуков нет, значит нечего проверять»', () => {
        const c = calls();
        ensureGuardHolds('/path/to/app', {
            ...c,
            readFileFn: () => {
                throw new Error('ENOENT');
            },
        });
        expect(c.failed).toHaveLength(1);
        expect(c.failed[0]).toContain('ENOENT');
        expect(c.logged).toEqual([]);
    });

    it('кодер в openai — пробуются Claude Code и Codex, исправный барьер проходит', () => {
        const c = calls();
        ensureGuardHolds('/path/to/app', {
            ...c,
            readFileFn: () => JSON.stringify(settingsWith('.*')),
            runHookFn: goodGuard,
            runtimes: { coderRuntime: 'openai' },
            layersFn: () => [],
        });
        expect(c.failed).toEqual([]);
        expect(c.logged[0]).toContain('claude-code, codex');
        // Ревью Фазы 16b: предел Codex старт говорит вслух. С #232 патч судится событием, и
        // строка о нём больше не говорит — остаются каналы, закрытые не хуком.
        expect(c.logged[1]).toMatch(/^⚠ codex: ввод в процесс write_stdin хук не зовёт/);
        expect(c.logged[1]).not.toContain('apply_patch');
    });

    // #195: исполняемые слои конфига Codex — отказ старта с путём и секциями, своим текстом:
    // барьер исправен, чинить надо дерево.
    it('кодер в openai, .codex/config.toml с MCP-сервером в дереве — отказ старта с причиной', () => {
        const c = calls();
        const asked: unknown[] = [];
        ensureGuardHolds('/path/to/app', {
            ...c,
            readFileFn: () => JSON.stringify(settingsWith('.*')),
            runHookFn: goodGuard,
            runtimes: { coderRuntime: 'openai' },
            env: { HOME: '/path/to/home' },
            layersFn: (a) => {
                asked.push(a);
                return ['/path/to/app/.codex/config.toml: исполняемый слой (секции: mcp_servers)'];
            },
        });
        expect(asked).toEqual([
            {
                tree: '/path/to/app',
                surfaces: ['.codex/config.toml', '.codex/hooks.json'],
                homes: ['/path/to/home/.codex'],
            },
        ]);
        expect(c.failed).toHaveLength(1);
        expect(c.failed[0]).toMatch(
            /^Исполняемые слои конфига харнесса[\s\S]*codex: \/path\/to\/app\/\.codex\/config\.toml[\s\S]*mcp_servers[\s\S]*Убери слой/,
        );
        expect(c.logged).toEqual([]);
    });

    it('пакет без сборщика конфига слоёв не проверяет — и старт говорит это строкой', () => {
        const c = calls();
        const layersFn = vi.fn(() => ['не должен звучать']);
        ensureGuardHolds('/path/to/app', {
            ...c,
            settings: settingsWith('.*'),
            runHookFn: (_h, payload) => heldRun(payload),
            runtimes: { coderRuntime: 'claude' },
            layersFn,
        });
        expect(c.failed).toEqual([]);
        expect(layersFn).not.toHaveBeenCalled();
        expect(harnessLayerProblems('kimi-code', '/w', {}, { layersFn })).toEqual([]);
        expect(harnessLayerProblems('нет-такого', '/w', {}, { layersFn })).toEqual([]);
        expect(c.logged.join('\n')).not.toContain(PROJECT_LAYERS_LIMIT);

        const k = calls();
        ensureGuardHolds('/path/to/app', {
            ...k,
            settings: settingsWith('.*'),
            runHookFn: (_h, payload) => heldRun(payload),
            runtimes: {
                coderRuntime: 'claude',
                modelRouting: { apiLimitFallback: { provider: 'kimi-native' } },
            },
            layersFn,
        });
        expect(k.failed).toEqual([]);
        expect(layersFn).not.toHaveBeenCalled();
        expect(k.logged).toContain(`⚠ kimi-code: ${PROJECT_LAYERS_LIMIT}`);
    });

    it('незнакомый рантайм при исправном барьере — fail с местом в конфиге', () => {
        const c = calls();
        ensureGuardHolds('/path/to/app', {
            ...c,
            readFileFn: () => JSON.stringify(settingsWith('Bash|Read|Edit|Grep|mcp__.*')),
            runHookFn: goodGuard,
            runtimes: { coderRuntime: 'mystery' },
        });
        expect(c.failed[0]).toMatch(/харнесс без доказанного guard не стартует[\s\S]*'mystery'/);
    });

    it('барьер Codex не держит — отказ назван харнессом', () => {
        const c = calls();
        // Хук блокирует только вызовы с транскриптом Claude Code — то есть не Codex.
        ensureGuardHolds('/path/to/app', {
            ...c,
            readFileFn: () => JSON.stringify(settingsWith('Bash|Read|Edit|Grep|mcp__.*')),
            runHookFn: (h, p, d) =>
                (JSON.parse(p) as { turn_id?: string }).turn_id
                    ? { status: 0, stderr: '' }
                    : goodGuard(h, p, d),
            runtimes: { coderRuntime: 'openai' },
        });
        expect(c.failed[0]).toMatch(/codex: рекурсивное удаление \(Bash\)/);
        expect(c.failed[0]).not.toMatch(/claude-code:/);
    });

    // Задача 101: собранный раннером settings — то, что прочтёт сессия; файл дерева не
    // читается вовсе, иначе его правка в PR снова решала бы исход пробы.
    it('settings передан — файл дерева не читается, проба идёт на переданном', () => {
        const failed: string[] = [];
        const reads: string[] = [];
        ensureGuardHolds('/s', {
            failFn: (m) => failed.push(m),
            logFn: () => {},
            readFileFn: (p) => {
                reads.push(p);
                return '{}';
            },
            runHookFn: () => ({ status: 0, stderr: '' }),
            settings: { disableAllHooks: true },
        });
        expect(reads).toEqual([]);
        expect(failed[0]).toMatch(/disableAllHooks/);
    });

    it('битый JSON — fail', () => {
        const c = calls();
        ensureGuardHolds('/path/to/app', { ...c, readFileFn: () => '{' });
        expect(c.failed).toHaveLength(1);
    });

    it('проба не прошла — fail со списком причин; прошла — строка в лог', () => {
        const bad = calls();
        ensureGuardHolds('/path/to/app', {
            ...bad,
            readFileFn: () => JSON.stringify(settingsWith('Bash|Read|Edit|Grep|mcp__.*')),
            runHookFn: () => ({ status: 0, stderr: '' }),
        });
        expect(bad.failed[0]).toMatch(/Проба барьера не прошла[\s\S]*рекурсивное удаление/);

        const good = calls();
        ensureGuardHolds('/path/to/app', {
            ...good,
            readFileFn: () => JSON.stringify(settingsWith('Bash|Read|Edit|Grep|mcp__.*')),
            runHookFn: goodGuard,
        });
        expect(good.failed).toEqual([]);
        expect(good.logged[0]).toContain('Проба барьера пройдена');
    });
});

describe('живая проба: настоящие хуки процессом', () => {
    let dir = '';
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = '';
    });

    const probeTree = (root: string) => {
        const failed: string[] = [];
        ensureGuardHolds(root, {
            failFn: (m) => failed.push(m),
            logFn: () => {},
            runHookFn: spawnHook,
        });
        return failed;
    };

    // Настройки и хуки из `.claude/` репозитория канона; копия у потребителя их не несёт.
    it.skipIf(!coreIsRepoRoot())(
        'настройки и хуки канона: рекурсивное удаление и чтение env-файла заблокированы',
        () => {
            expect(probeTree(CANON_ROOT)).toEqual([]);
        },
    );

    /** Дерево с одним PreToolUse-хуком — скриптом `hook.cjs` с заданным телом. */
    const treeWithHook = (body: string) => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        mkdirSync(path.join(dir, '.claude'));
        writeFileSync(path.join(dir, 'hook.cjs'), body);
        writeFileSync(
            path.join(dir, '.claude', 'settings.json'),
            JSON.stringify(
                settingsWith(
                    'Bash|Read|Edit|Grep|mcp__.*',
                    'node "${CLAUDE_PROJECT_DIR}/hook.cjs"',
                ),
            ),
        );
        return dir;
    };

    it('хук падает исключением (код 1) — Claude Code его не послушал бы, проба красная', () => {
        const failed = probeTree(treeWithHook('throw new Error("сломан");'));
        expect(failed[0]).toMatch(/рекурсивное удаление[\s\S]*коды выхода: 1/);
    });

    it('хук пропускает всё — проба красная', () => {
        expect(probeTree(treeWithHook('process.exit(0);'))).toHaveLength(1);
    });

    it('файла хука нет — проба красная, а не «хук молчит»', () => {
        const root = treeWithHook('');
        rmSync(path.join(root, 'hook.cjs'));
        expect(probeTree(root)[0]).toContain('рекурсивное удаление');
    });

    it('хук блокирует всё подряд — проба красная на безобидной команде', () => {
        const failed = probeTree(treeWithHook('process.stderr.write("нет"); process.exit(2);'));
        expect(failed[0]).toMatch(/безобидная команда[\s\S]*нет/);
    });

    // #119: отрицательная проба у КАЖДОГО харнесса на настоящих хуках канона — регистрация в
    // формате CLI, вход в форме CLI, хук процессом. Для OpenCode исполняется сам плагин.
    const canonSettings = () =>
        JSON.parse(
            readFileSync(path.join(CANON_ROOT, '.claude', 'settings.json'), 'utf-8'),
        ) as unknown;

    it.skipIf(!coreIsRepoRoot()).each(['claude-code', 'codex', 'kimi-code', 'opencode'])(
        'хуки канона в регистрации %s: запрещённое заблокировано, безобидное пропущено',
        (harness) => {
            expect(
                harnessGuardProblems(harness, canonSettings(), CANON_ROOT, {
                    runHookFn: spawnHook,
                    runPluginFn: spawnPlugin,
                }),
            ).toEqual([]);
        },
    );

    // #120, от противного: живая сессия Kimi Code исполнила `rm -rf`, потому что команда
    // хука несла каталог префиксом `X=… cmd`, а `${X}` в той же строке раскрывается раньше
    // присваивания. Проба, подкладывавшая переменную сама, была зелёной. Теперь — красная на
    // старой форме и зелёная на той, что строит `guardHooksOf`.
    it.skipIf(!coreIsRepoRoot()).each(['codex', 'kimi-code'])(
        '%s: команда с префиксом вместо export — проба красная без CLAUDE_PROJECT_DIR от CLI',
        (harness) => {
            const prefixed = (guardHooksOf(canonSettings(), CANON_ROOT) as GuardHook[]).map(
                (h) => ({
                    ...h,
                    command: h.command.replace(
                        /^export (CLAUDE_PROJECT_DIR=\S+) (RALPH_GUARD_INPUT=\S+); /,
                        '$2 $1 ',
                    ),
                }),
            );
            expect(prefixed[0].command).toMatch(
                /^RALPH_GUARD_INPUT=compat-16b CLAUDE_PROJECT_DIR='[^']+' node "\$\{CLAUDE_PROJECT_DIR\}/,
            );
            const problems =
                harness === 'codex'
                    ? codexArgsProblems(codexGuardArgs(prefixed), CANON_ROOT, {
                          runHookFn: spawnHook,
                      })
                    : kimiTomlProblems(kimiHooksToml(prefixed), CANON_ROOT, {
                          runHookFn: spawnHook,
                      });
            expect(problems.join('\n')).toMatch(/рекурсивное удаление[\s\S]*коды выхода: 1/);
        },
    );

    // Ревью Фазы 16b: барьер скиллов в сессии петли без транскрипта блокирует fail-closed, а
    // Kimi Code и плагин OpenCode транскрипта не отдают — правка тестов была бы закрыта им
    // навсегда. Поэтому в регистрацию не-Claude харнессов он не переносится; от противного —
    // сам хук на том же событии блокирует.
    it.skipIf(!coreIsRepoRoot())(
        'регистрация не-Claude харнессов без барьера скиллов: правка теста в сессии петли проходит',
        () => {
            const loopEnv = { RALPH_SKILL_GUARD: 'on' };
            const withEnv: TRunHookFn = (hook, payload, projectDir) => {
                const r = spawnSync('sh', ['-c', hook.command], {
                    cwd: projectDir,
                    input: payload,
                    encoding: 'utf-8',
                    timeout: hook.timeoutSec * 1000,
                    env: { ...hookEnv(projectDir, false), ...loopEnv },
                });
                return { status: r.status, stderr: r.stderr ?? '' };
            };
            const kimiWrite = JSON.stringify({
                session_id: 'skill-barrier-kimi',
                hook_event_name: 'PreToolUse',
                cwd: CANON_ROOT,
                tool_name: 'Write',
                tool_input: { path: 'core/a.test.ts', content: '' },
            });
            // От противного: сам барьер скиллов на событии Kimi без транскрипта — блок.
            const barrier = withEnv(
                {
                    command: `export CLAUDE_PROJECT_DIR='${CANON_ROOT}'; node "${CANON_ROOT}/.claude/hooks/skill-barrier.cjs"`,
                    timeoutSec: 10,
                    cannotBlock: null,
                },
                kimiWrite,
                CANON_ROOT,
            );
            expect(barrier.status).toBe(2);
            expect(barrier.stderr).toMatch(/транскрипт не назван/);

            const hooks = guardHooksOf(canonSettings(), CANON_ROOT);
            expect(hooks.some((h) => /skill-barrier\.cjs/.test(h.command))).toBe(false);
            expect(hooks.some((h) => /guard\.cjs/.test(h.command))).toBe(true);
            for (const h of hooks) {
                expect(withEnv({ ...h, cannotBlock: null }, kimiWrite, CANON_ROOT).status).toBe(0);
            }

            const r = spawnSync('node', ['--input-type=module', '-e', OPENCODE_PLUGIN_DRIVER], {
                cwd: CANON_ROOT,
                input: JSON.stringify({
                    source: opencodeGuardPlugin(hooks),
                    input: { tool: 'write' },
                    output: { args: { filePath: 'core/a.test.ts', content: '' } },
                    directory: CANON_ROOT,
                }),
                encoding: 'utf-8',
                timeout: 120 * 1000,
                env: { ...process.env, ...loopEnv },
            });
            expect(r.status).toBe(0);
        },
    );

    it('guardHooksOf: запись без matcher переносится с пустым matcher — на все инструменты', () => {
        const hooks = guardHooksOf(
            {
                hooks: {
                    PreToolUse: [
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command: "node '/core/.claude/hooks/guard.cjs'",
                                },
                            ],
                        },
                    ],
                },
            },
            '/work',
        );
        expect(hooks.map((h) => h.matcher)).toEqual(['']);
    });

    // #232: пакет с нормализатором получает путь своей команды и в export, и вместо пути харнесса
    // настроек в команде канонического хука — присваивание перед node сильнее export.
    it('guardHooksOf с путём нормализатора: путь заменён в команде, совместимый вход сброшен', () => {
        const command = (adapter: string) =>
            `RALPH_CORE_SHA='' RALPH_GUARD_ADAPTER=${adapter} node '/core/.claude/hooks/guard.cjs'`;
        const of = (adapter: string) =>
            guardHooksOf(
                {
                    hooks: {
                        PreToolUse: [{ hooks: [{ type: 'command', command: command(adapter) }] }],
                    },
                },
                '/work',
                { adapter: "/co're/codex.ts" },
            )[0].command;
        const expected =
            "export CLAUDE_PROJECT_DIR='/work' RALPH_GUARD_ADAPTER='/co'\\''re/codex.ts' " +
            `RALPH_GUARD_INPUT=''; ${command("'/co'\\''re/codex.ts'")}`;
        // В кавычках с экранированной кавычкой внутри и словом без кавычек.
        expect(of("'/cl'\\''aude/normalize.ts'")).toBe(expected);
        expect(of('/claude/normalize.ts')).toBe(expected);
    });

    it('guardInputOf: событие, совместимый вход и пакет, которого нет', () => {
        const codex = guardInputOf(HARNESS_REGISTRY, 'codex');
        expect(codex).toEqual({ adapter: HARNESS_REGISTRY.packages.get('codex')?.normalizerPath });
        // Путь — от реестра: литерал каталога пакетов в коде ядра ловит `harness-package-deps`.
        const moved = normalizerPathIn(HARNESS_REGISTRY, 'codex', '/core');
        if (!moved.ok) throw new Error(moved.reason);
        expect(moved.path.startsWith('/core/')).toBe(true);
        expect(guardInputOf(HARNESS_REGISTRY, 'codex', '/core')).toEqual({ adapter: moved.path });
        expect(guardInputOf(HARNESS_REGISTRY, 'kimi-code', '/core')).toBe('compat-16b');
        // Значение-причина не абсолютный путь: guard на ней блокирует всё `adapter-failed`.
        const missing = guardInputOf(HARNESS_REGISTRY, 'nope');
        expect(missing).toEqual({ adapter: expect.stringMatching(/^пакет не принят: /) });
    });

    it('guardHooksOf не переносит барьер скиллов ни каноническим путём, ни путём дерева', () => {
        const hooks = guardHooksOf(
            {
                hooks: {
                    PreToolUse: [
                        {
                            matcher: 'Bash',
                            hooks: [
                                {
                                    type: 'command',
                                    command: "node '/core/.claude/hooks/guard.cjs'",
                                },
                                {
                                    type: 'command',
                                    command: "X='' node '/core/.claude/hooks/skill-barrier.cjs'",
                                },
                                {
                                    type: 'command',
                                    command:
                                        'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/skill-barrier.cjs"',
                                },
                                { type: 'command', command: 'node my-skill-barrier.cjs.bak' },
                            ],
                        },
                    ],
                },
            },
            '/work',
        );
        expect(hooks.map((h) => h.command.replace(/^export [^;]+; /, ''))).toEqual([
            "node '/core/.claude/hooks/guard.cjs'",
            'node my-skill-barrier.cjs.bak',
        ]);
    });

    it('ensureGuardHolds называет предел барьера скиллов у не-Claude харнессов', () => {
        const lines: string[] = [];
        ensureGuardHolds('/work', {
            failFn: (m) => {
                throw new Error(m);
            },
            logFn: (m) => lines.push(m),
            settings: settingsWith('.*'),
            runtimes: {
                coderRuntime: 'claude',
                modelRouting: { apiLimitFallback: { provider: 'openai' } },
            },
            runHookFn: (_h, payload) => heldRun(payload),
            layersFn: () => [],
        });
        expect(lines.join('\n')).toMatch(/⚠ codex: барьер скиллов не зарегистрирован/);
    });

    // Ревью Фазы 16c: Codex, Kimi Code и OpenCode пробу контекста не проходят нигде, и
    // предел был только абзацем в доках. Теперь — строкой старта у каждого такого маршрута.
    it('ensureGuardHolds с контекстом называет харнессы, где контекст пробой не доказан', () => {
        const run = (withRoute: boolean) => {
            const lines: string[] = [];
            ensureGuardHolds('/work', {
                failFn: (m) => {
                    throw new Error(m);
                },
                logFn: (m) => lines.push(m),
                settings: settingsWith('.*'),
                sessionContext: '{"loop":true}',
                runtimes: withRoute
                    ? {
                          coderRuntime: 'claude',
                          modelRouting: { apiLimitFallback: { provider: 'openai' } },
                      }
                    : { coderRuntime: 'claude' },
                layersFn: () => [],
                runHookFn: (_h, payload) =>
                    payload.includes('.claude/ralph/hooks.json')
                        ? { status: 2, stderr: 'ralph-reason-code: contour-data\n' }
                        : heldRun(payload),
            });
            return lines.join('\n');
        };
        expect(run(true)).toContain(`⚠ codex: ${CONTEXT_UNPROVEN_LIMIT}`);
        expect(run(false)).not.toContain(CONTEXT_UNPROVEN_LIMIT);
    });

    // Живые события стенда (обрезанные) — на настоящем guard канона: барьер разбирает вход
    // каждого CLI, а не только тот, что собирает проба.
    it.skipIf(!coreIsRepoRoot()).each(['claude-code', 'codex', 'kimi-code'])(
        'живое событие %s с рекурсивным удалением guard канона блокирует кодом 2',
        (harness) => {
            const fixtures = JSON.parse(
                readFileSync(
                    path.join(CANON_ROOT, 'adapters', '__fixtures__', 'hook-events.json'),
                    'utf-8',
                ),
            ) as Record<string, { event: Record<string, unknown> }>;
            const event = {
                ...fixtures[harness].event,
                cwd: CANON_ROOT,
                tool_input: { command: 'rm -rf ./.ralph-guard-probe' },
            };
            delete (event as { transcript_path?: unknown }).transcript_path;
            const run = spawnHook(
                {
                    command: `node "${CANON_ROOT}/.claude/hooks/guard.cjs"`,
                    timeoutSec: 10,
                    cannotBlock: null,
                },
                JSON.stringify(event),
                CANON_ROOT,
            );
            expect(run.status).toBe(2);
        },
    );

    // Ревью Фазы 16b: плагин выбрасывал stdout хука, и хук потребителя, блокирующий
    // JSON-ответом при коде 0, в сессии OpenCode молча переставал блокировать.
    it.each([
        [
            'permissionDecision: deny',
            {
                hookSpecificOutput: {
                    permissionDecision: 'deny',
                    permissionDecisionReason: 'нельзя',
                },
            },
            /нельзя/,
        ],
        ['decision: block', { decision: 'block', reason: 'стоп' }, /стоп/],
        ['continue: false', { continue: false }, /continue: false/],
    ] as const)('плагин OpenCode: JSON-ответ %s при коде 0 — вызов отменён', (_what, out, why) => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        writeFileSync(path.join(dir, 'out.json'), JSON.stringify(out));
        const source = opencodeGuardPlugin([
            { matcher: '', command: `cat > /dev/null; cat "${dir}/out.json"`, timeoutSec: 10 },
        ]);
        const run = spawnPlugin(
            source,
            { input: { tool: 'bash' }, output: { args: { command: 'git status' } } },
            dir,
        );
        expect(run.status).toBe(2);
        expect(run.stderr).toMatch(why);
    });

    it('плагин OpenCode: stdout не JSON или JSON без отказа при коде 0 — вызов пропущен', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        for (const out of ['готово', '{"hookSpecificOutput":{"permissionDecision":"allow"}}']) {
            writeFileSync(path.join(dir, 'out.txt'), out);
            const source = opencodeGuardPlugin([
                { matcher: '', command: `cat > /dev/null; cat "${dir}/out.txt"`, timeoutSec: 10 },
            ]);
            const run = spawnPlugin(
                source,
                { input: { tool: 'bash' }, output: { args: { command: 'git status' } } },
                dir,
            );
            expect(run.status, out).toBe(0);
        }
    });

    // Ревью Фазы 16b: MCP-имя `apply_patch` (сервер `apply`, инструмент `patch`) совпадает со
    // встроенным; без patchText вызов уходил барьеру одним Edit без пути.
    it.each(['apply_patch', 'patch'])(
        'плагин OpenCode: %s без patchText — вызов отменён',
        (tool) => {
            dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
            const source = opencodeGuardPlugin([
                { matcher: '', command: 'exit 0', timeoutSec: 10 },
            ]);
            const run = spawnPlugin(
                source,
                { input: { tool }, output: { args: { input: 'x' } } },
                dir,
            );
            expect(run.status).toBe(2);
            expect(run.stderr).toMatch(/патч без patchText/);
        },
    );

    // Ревью Фазы 16b: плагин пропускал вызов, если хук упал, завис или не запустился, — тот
    // же класс, что #120. Теперь пропускает только код 0; от противного — каждый сбой хука.
    it.each([
        ['упал кодом 1', (d: string) => `node "${d}/hook.cjs"`, 10, /упал \(код 1/],
        ['не найден (127)', () => 'ralph-no-such-hook-command', 10, /упал \(код 127/],
        ['завис дольше срока', () => 'sleep 5', 1, /не исполнился \(хук не ответил за 1 с/],
    ] as const)('плагин OpenCode: хук %s — вызов отменён', (_what, command, timeoutSec, why) => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        writeFileSync(path.join(dir, 'hook.cjs'), 'throw new Error("сломан");');
        const source = opencodeGuardPlugin([{ matcher: '', command: command(dir), timeoutSec }]);
        const run = spawnPlugin(
            source,
            { input: { tool: 'bash' }, output: { args: { command: 'rm -rf ./x' } } },
            dir,
        );
        expect(run.status).toBe(2);
        expect(run.stderr).toMatch(why);
    });

    it('плагин OpenCode: по сроку гасится вся группа хука, ребёнок sh не остаётся сиротой', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        const pidFile = path.join(dir, 'pid');
        const source = opencodeGuardPlugin([
            { matcher: '', command: `sleep 30 & echo $! > "${pidFile}"; wait`, timeoutSec: 1 },
        ]);
        const run = spawnPlugin(
            source,
            { input: { tool: 'bash' }, output: { args: { command: 'git status' } } },
            dir,
        );
        expect(run.status).toBe(2);
        const pid = Number(readFileSync(pidFile, 'utf-8').trim());
        // Убитая сирота уходит к PID 1. В контейнере CI им бывает не init, а `sh`/`node`,
        // который сирот не пожинает, — убитый `sleep` висит зомби, и `kill 0` по нему
        // успешен. Зомби уже мёртв: живость — состояние из `/proc/<pid>/stat`, а не `kill 0`.
        const alive = () => {
            try {
                const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
                const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
                return state !== 'Z' && state !== 'X';
            } catch {
                return false;
            }
        };
        const until = Date.now() + 3000;
        while (alive() && Date.now() < until) spawnSync('sleep', ['0.05']);
        expect(alive()).toBe(false);
    });

    it('плагин OpenCode: упавший хук блокирует и безобидное — проба красная, а не зелёная', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        writeFileSync(path.join(dir, 'hook.cjs'), 'throw new Error("сломан");');
        const source = opencodeGuardPlugin([
            { matcher: '', command: `node "${dir}/hook.cjs"`, timeoutSec: 10 },
        ]);
        const problems = opencodePluginProblems(source, dir, { runPluginFn: spawnPlugin });
        const safe = problems.filter((p) => p.includes('безобидная команда'));
        expect(safe).toHaveLength(1);
        expect(safe[0]).toMatch(/безобидная команда \(bash\)[\s\S]*упал \(код 1/);
        // Блок упавшим хуком — не правило: запрещённые без кода причины не засчитаны (#183).
        expect(problems.filter((p) => /ждали код причины/.test(p))).toHaveLength(
            problems.length - 1,
        );
    });

    it('плагин OpenCode: MCP-имя и патч переводятся в форму, которую судит барьер', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        writeFileSync(
            path.join(dir, 'hook.cjs'),
            'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stderr.write(s);process.exit(2)});',
        );
        const source = opencodeGuardPlugin([
            { matcher: '', command: `node "${dir}/hook.cjs"`, timeoutSec: 10 },
        ]);
        const seen = (tool: string, args: Record<string, unknown>) =>
            JSON.parse(spawnPlugin(source, { input: { tool }, output: { args } }, dir).stderr) as {
                tool_name: string;
                tool_input: Record<string, unknown>;
            };
        expect(seen('forge__x_GetIssue', {}).tool_name).toBe('mcp__forge_x_GetIssue');
        expect(seen('toString', {}).tool_name).toBe('mcp__toString');
        // `batch` вне таблицы: вложенные вызовы стендом не сверены, правило MCP блокирует его.
        expect(seen('batch', { tool_calls: [] }).tool_name).toBe('mcp__batch');
        // Путь элемента `edits[]` у multiedit — в форме, которую читают guard-rules.
        const multi = seen('multiedit', {
            filePath: 'a.ts',
            edits: [{ filePath: '.claude/ralph/hooks.json', oldString: 'a', newString: 'b' }],
        });
        expect(multi.tool_input).toEqual({
            file_path: 'a.ts',
            edits: [{ file_path: '.claude/ralph/hooks.json', old_string: 'a', new_string: 'b' }],
        });
        const patch = seen('apply_patch', {
            patchText: '*** Begin Patch\n*** Add File: a/b.ts\n+x\n*** End Patch',
        });
        expect(patch.tool_name).toBe('Edit');
        expect(patch.tool_input.file_path).toBe('a/b.ts');
        // CLI режет путь `.trim()`: табуляция у края не остаётся в пути, который судит барьер.
        const tabbed = seen('apply_patch', {
            patchText: '*** Begin Patch\n*** Update File:\t.env\t\n@@\n-A=1\n+A=2\n*** End Patch',
        });
        expect(tabbed.tool_input.file_path).toBe('.env');
        // CLI делит строки только по `\n`: `\r`, `\u2028` и `\u2029` после двоеточия — часть
        // заголовка, а не конец строки, и путь за ними барьер обязан увидеть обрезанным.
        writeFileSync(
            path.join(dir, 'env-hook.cjs'),
            'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{if(JSON.parse(s).tool_input.file_path===".env"){process.stderr.write(s);process.exit(2)}});',
        );
        const envOnly = opencodeGuardPlugin([
            { matcher: '', command: `node "${dir}/env-hook.cjs"`, timeoutSec: 10 },
        ]);
        for (const sep of ['\r', '\u2028', '\u2029']) {
            const hidden = spawnPlugin(
                envOnly,
                {
                    input: { tool: 'apply_patch' },
                    output: {
                        args: {
                            patchText: `*** Update File: a.ts\n*** Update File:${sep}.env\n*** End Patch`,
                        },
                    },
                },
                dir,
            );
            expect(hidden.status).toBe(2);
            expect(JSON.parse(hidden.stderr).tool_input.file_path).toBe('.env');
        }
        const blank = spawnPlugin(
            source,
            {
                input: { tool: 'patch' },
                output: { args: { patchText: '*** Update File: \t\n*** End Patch' } },
            },
            dir,
        );
        expect(blank.status).toBe(2);
        expect(blank.stderr).toMatch(/в патче пустой путь/);
        const noPath = spawnPlugin(
            source,
            { input: { tool: 'patch' }, output: { args: { patchText: 'мусор' } } },
            dir,
        );
        expect(noPath.status).toBe(2);
        expect(noPath.stderr).toMatch(/в патче нет ни одного пути/);
    });

    it('плагин OpenCode: своя ошибка (битый matcher) — отмена вызова, а не пропуск', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        const source = opencodeGuardPlugin([{ matcher: '(', command: 'true', timeoutSec: 10 }]);
        const run = spawnPlugin(source, { input: { tool: 'bash' }, output: { args: {} } }, dir);
        expect(run.status).toBe(2);
        expect(run.stderr).toMatch(/fail-closed/);
    });

    it('плагин OpenCode, упавший при загрузке, — не блок (CLI его пропускает), проба красная', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'guard-probe-'));
        const source = `const HOOKS = [{"matcher":"","command":"true","timeoutSec":10}];\nthrow new Error('x');`;
        const problems = opencodePluginProblems(source, dir, { runPluginFn: spawnPlugin });
        expect(problems.join('\n')).toMatch(/коды выхода: 3/);
    });
});

describe('боевые исполнители пробы — процессы, в тесте громкая побочка', () => {
    it('хук и плагин OpenCode не запускаются мимо предохранителя', () => {
        const hook = { command: 'true', timeoutSec: 1, cannotBlock: null };
        expect(() => runHook(hook, '{}', '/nonexistent-ralph-tree')).toThrow();
        expect(() =>
            runOpencodePlugin('', { input: {}, output: {} }, '/nonexistent-ralph-tree'),
        ).toThrow();
        const attempts = sideEffectAttempts.splice(0).join(' | ');
        expect(attempts).toContain('guard-probe: true');
        expect(attempts).toContain('guard-probe: плагин OpenCode');
    });
});

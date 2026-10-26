// Отрицательная проба барьера (канон, задача 6). Два уровня:
//   1. разбор и вердикт на фейковых исходах хуков — какие ответы барьера проба принимает;
//   2. живой прогон на НАСТОЯЩИХ настройках и хуках канона и на подложных деревьях, где
//      хук падает, пропускает всё или не подключён. Хуки здесь запускаются процессом —
//      иначе проба доказывала бы разбор настроек, а не то, что увидит сессия.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coreIsRepoRoot } from '../tests/core-repo.ts';
import {
    GUARD_PROBES,
    ensureGuardHolds,
    hooklessRoutes,
    hooksFor,
    matcherCovers,
    probePayload,
    probeProblems,
    type TRunHookFn,
} from './guard-probe.ts';

const CANON_ROOT = path.resolve(import.meta.dirname, '..');

/** Живой запуск хука — то же, что боевой `runHook`, но мимо предохранителя побочек. */
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

const settingsWith = (matcher: string, command = 'node guard.cjs') => ({
    hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command }] }] },
});

/** Барьер «как должно быть»: 2 на запрещённом, 0 на безобидном. */
const goodGuard: TRunHookFn = (_hook, payload) => {
    const { tool_input } = JSON.parse(payload) as { tool_input: { command?: string } };
    return { status: tool_input.command === 'git status' ? 0 : 2, stderr: '' };
};

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
    const all = settingsWith('Bash|Read|Grep');

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
                        matcher: 'Bash|Read|Grep',
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
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('безобидная команда');
        expect(problems[0]).toContain('Правила барьера не загрузились');
    });

    it('достаточно ОДНОГО блокирующего хука, но безобидное обязаны пропустить ВСЕ', () => {
        const two = {
            hooks: {
                PreToolUse: [
                    { matcher: 'Bash|Read|Grep', hooks: [{ type: 'command', command: 'guard' }] },
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
        expect(problems).toHaveLength(2);
        expect(problems.join('\n')).toMatch(/\(Read\): ни один PreToolUse-хук/);
        expect(problems.join('\n')).toMatch(/\(Grep\): ни один PreToolUse-хук/);
        expect(runs).toBe(4); // четыре пробы Bash, ни одной — Read и Grep
    });
});

describe('рантаймы без Claude-хуков', () => {
    it('по умолчанию и kimi — сессии идут через claude, проблем нет', () => {
        expect(hooklessRoutes({})).toEqual([]);
        expect(hooklessRoutes({ coderRuntime: 'kimi' })).toEqual([]);
        expect(
            hooklessRoutes({
                modelRouting: {
                    labels: {
                        'complexity:low': 'claude-haiku',
                        x: { provider: 'kimi', model: 'k' },
                    },
                },
            }),
        ).toEqual([]);
    });

    it('openai в любом месте выбора — названо, где именно', () => {
        expect(hooklessRoutes({ coderRuntime: 'openai' })).toEqual([
            "adapters.coderRuntime = 'openai'",
        ]);
        const found = hooklessRoutes({
            modelRouting: {
                labels: { 'complexity:high': { provider: 'openai', model: 'm' } },
                default: { provider: 'openai', model: 'm' },
                apiLimitFallback: { provider: 'openai', model: 'm' },
            },
        });
        expect(found).toEqual([
            "modelRouting.labels.complexity:high → 'openai'",
            "modelRouting.default → 'openai'",
            "modelRouting.apiLimitFallback → 'openai'",
        ]);
    });

    it('строковая запись маршрута берёт статический рантайм — openai назван один раз', () => {
        expect(
            hooklessRoutes({ coderRuntime: 'openai', modelRouting: { labels: { a: 'gpt' } } }),
        ).toEqual(["adapters.coderRuntime = 'openai'"]);
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

    it('исправный барьер, но кодер уходит в openai — fail', () => {
        const c = calls();
        ensureGuardHolds('/path/to/app', {
            ...c,
            readFileFn: () => JSON.stringify(settingsWith('Bash|Read|Grep')),
            runHookFn: goodGuard,
            runtimes: { coderRuntime: 'openai' },
        });
        expect(c.failed[0]).toMatch(/coderRuntime = 'openai'[\s\S]*без Claude-хуков/);
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
            readFileFn: () => JSON.stringify(settingsWith('Bash|Read|Grep')),
            runHookFn: () => ({ status: 0, stderr: '' }),
        });
        expect(bad.failed[0]).toMatch(/Проба барьера не прошла[\s\S]*рекурсивное удаление/);

        const good = calls();
        ensureGuardHolds('/path/to/app', {
            ...good,
            readFileFn: () => JSON.stringify(settingsWith('Bash|Read|Grep')),
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
            JSON.stringify(settingsWith('Bash|Read|Grep', 'node "${CLAUDE_PROJECT_DIR}/hook.cjs"')),
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
});

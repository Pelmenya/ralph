// Регистрация барьера у каждого харнесса (#119): тексты регистраций читаются обратно без
// потерь, флаги, без которых CLI хук не зовёт, обязательны, вход пробы совпадает по форме с
// тем, что CLI подавал живьём (`__fixtures__/hook-events.json`). Живой прогон хуков канона на
// этих регистрациях — в `core/guard-probe.test.ts`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CODEX_DISABLE_TTY,
    CODEX_HOOK_TRUST_FLAG,
    HARNESSES,
    HARNESS_PROBES,
    codexGuardArgs,
    codexGuardFromArgs,
    harnessHookPayload,
    harnessMatcherCovers,
    kimiHooksFromToml,
    kimiHooksToml,
    opencodeEvent,
    opencodeGuardPlugin,
    opencodeClaudeToolName,
    opencodeHooksFromPlugin,
    type GuardHook,
} from './harness-guard.ts';
import { RUNTIME_IDENTITIES } from './runtime-profile.ts';

type TFixture = { source: string; event: Record<string, unknown>; readEvent?: unknown };
const FIXTURES = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '__fixtures__', 'hook-events.json'), 'utf-8'),
) as Record<string, TFixture>;

// Команда с тем, что ломает наивную сериализацию: кавычки обоих видов, обратный слеш,
// `=` и `,` внутри строки, кириллица.
const HOOKS: GuardHook[] = [
    {
        matcher: 'Bash|Read|mcp__.*',
        command: `RALPH_CORE_SHA='abc' node "/path/to/core/.claude/hooks/guard.cjs" --x=a,b \\ ок`,
        timeoutSec: 10,
    },
    { matcher: 'Bash|Edit', command: 'node /path/to/skill-barrier.cjs', timeoutSec: 7 },
];

describe('харнессы реестра рантаймов', () => {
    it('харнесс каждого рантайма — из списка, у которого есть регистрация и проба', () => {
        for (const [runtime, id] of Object.entries(RUNTIME_IDENTITIES)) {
            expect(HARNESSES, runtime).toContain(id.harness);
        }
        for (const h of HARNESSES) {
            const probes = HARNESS_PROBES[h];
            expect(
                probes.some((p) => p.expect === 'allowed'),
                h,
            ).toBe(true);
            expect(probes.filter((p) => p.expect === 'blocked').length, h).toBeGreaterThan(1);
        }
    });
});

describe('вход хука — по форме живого события CLI', () => {
    it.each(['claude-code', 'codex', 'kimi-code'] as const)(
        '%s: поля пробы — подмножество полей живого события, инструмент в той же форме',
        (harness) => {
            const real = FIXTURES[harness].event;
            const probe = HARNESS_PROBES[harness][0];
            const payload = JSON.parse(
                harnessHookPayload(harness, probe, '/path/to/loop'),
            ) as Record<string, unknown>;
            for (const key of Object.keys(payload)) expect(Object.keys(real), key).toContain(key);
            expect(payload.tool_name).toBe(real.tool_name);
            expect(Object.keys(payload.tool_input as object)).toEqual(
                Object.keys(real.tool_input as object),
            );
            expect(payload).not.toHaveProperty('transcript_path');
        },
    );

    it('opencode: событие плагина — те же два аргумента и ключи, что в бинаре', () => {
        const real = FIXTURES.opencode.event as {
            input: Record<string, unknown>;
            output: Record<string, unknown>;
        };
        const ev = opencodeEvent(HARNESS_PROBES.opencode[0]);
        expect(Object.keys(ev.input).sort()).toEqual(Object.keys(real.input).sort());
        expect(Object.keys(ev.output)).toEqual(Object.keys(real.output));
        expect(ev.input.tool).toBe(real.input.tool);
    });

    it('у каждой фикстуры назван источник', () => {
        for (const h of HARNESSES) expect(FIXTURES[h]?.source, h).toMatch(/\S/);
    });

    it('файловые пробы Kimi и OpenCode — в их ключах, а не в ключах Claude', () => {
        const read = (h: 'kimi-code' | 'opencode') =>
            HARNESS_PROBES[h].find((p) => /read/i.test(p.toolName))?.toolInput;
        expect(read('kimi-code')).toEqual({ path: '.env' });
        expect(read('opencode')).toEqual({ filePath: '.env' });
        // Ключ файла у OpenCode — тот же, что в живом событии плагина (#121).
        const live = FIXTURES.opencode.readEvent as { output: { args: Record<string, unknown> } };
        expect(Object.keys(live.output.args)).toEqual(['filePath']);
    });
});

describe('matcher по правилам харнесса', () => {
    it('Claude Code и Codex — выражение по имени целиком, Kimi Code — без якорей', () => {
        expect(harnessMatcherCovers('claude-code', 'Read', 'ReadFile')).toBe(false);
        expect(harnessMatcherCovers('codex', 'Read', 'ReadFile')).toBe(false);
        expect(harnessMatcherCovers('kimi-code', 'Read', 'ReadFile')).toBe(true);
        expect(harnessMatcherCovers('kimi-code', '', 'Bash')).toBe(true);
        expect(harnessMatcherCovers('claude-code', '*', 'Bash')).toBe(true);
        // У Kimi `*` — регулярное выражение, и битое: не накрывает ничего.
        expect(harnessMatcherCovers('kimi-code', '*', 'Bash')).toBe(false);
        expect(harnessMatcherCovers('codex', '(', 'Bash')).toBe(false);
        expect(harnessMatcherCovers('codex', 42, 'Bash')).toBe(false);
    });
});

describe('таймаут хука в регистрации', () => {
    // Ревью Фазы 16b: `Math.trunc(0.5)` давал 0, а обратный разбор читает 0 как умолчание CLI.
    it('дробный меньше секунды — одна секунда у Codex и Kimi, а не умолчание CLI', () => {
        const hook = { matcher: 'Bash', command: 'g', timeoutSec: 0.5 };
        expect(codexGuardFromArgs(codexGuardArgs([hook])).hooks[0].timeoutSec).toBe(1);
        expect(kimiHooksFromToml(kimiHooksToml([hook])).hooks[0].timeoutSec).toBe(1);
        expect(kimiHooksToml([{ ...hook, timeoutSec: 2.2 }])).toContain('timeout = 3');
    });
});

describe('OpenCode: имя инструмента для барьера', () => {
    it('встроенный — по таблице, унаследованные ключи объекта таблицей не считаются', () => {
        expect(opencodeClaudeToolName('bash')).toBe('Bash');
        expect(opencodeClaudeToolName('apply_patch')).toBe('Edit');
        expect(opencodeClaudeToolName('todowrite')).toBe('TodoWrite');
        expect(opencodeClaudeToolName('toString')).toBe('mcp__toString');
    });

    // Ревью Фазы 16b: MCP у OpenCode — `<сервер>_<инструмент>` без `mcp__`, и matcher канона
    // его не накрывал. Имя без второго разделителя правило MCP не читает ни чтением, ни
    // записью из allowlist: сервер `foo_list` не выдаёт себя за чтение `list…`.
    it('остальное — MCP-имя под matcher `mcp__.*`, без разделителя сервера и инструмента', () => {
        expect(opencodeClaudeToolName('foo_list_drop')).toBe('mcp__foo_list_drop');
        expect(opencodeClaudeToolName('a__b__GetX')).toBe('mcp__a_b_GetX');
        expect(harnessMatcherCovers('opencode', 'Bash|mcp__.*', 'mcp__a_b_GetX')).toBe(true);
    });
});

describe('Codex: регистрация в argv', () => {
    it('хуки читаются обратно без потерь, флаги доверия и включения на месте', () => {
        const argv = codexGuardArgs(HOOKS);
        expect(argv).toContain(CODEX_HOOK_TRUST_FLAG);
        expect(codexGuardFromArgs(['-a', 'never', 'exec', ...argv, '--', '-'])).toEqual({
            hooks: HOOKS,
            problems: [],
        });
    });

    it('без доверия хуку и без --enable hooks — названы обе дыры стенда', () => {
        const argv = codexGuardArgs(HOOKS).filter(
            (a) => a !== CODEX_HOOK_TRUST_FLAG && a !== '--enable',
        );
        const { problems } = codexGuardFromArgs(argv);
        expect(problems.join('\n')).toMatch(/hook-trust[\s\S]*--enable hooks/);
    });

    it('записанное руками: пробелы у `=`, битые записи пропущены, таймаут Codex по умолчанию', () => {
        const pin = [CODEX_HOOK_TRUST_FLAG, '--enable', 'hooks'];
        const read = (value: string) =>
            codexGuardFromArgs([...pin, '-c', `hooks.PreToolUse=${value}`]);
        expect(
            read(
                '[{matcher = "Bash", hooks = [{type = "command", command = "node g.cjs"}]},' +
                    '{hooks = [{type = "prompt", command = "x"}, {type = "command", command = " "}]},' +
                    '{matcher = "Read"}, 7]',
            ).hooks,
        ).toEqual([{ matcher: 'Bash', command: 'node g.cjs', timeoutSec: 600 }]);
        expect(read('{matcher = "Bash"}').hooks).toEqual([]);
        expect(read('[{hooks = [{type = "command", command = "g", timeout = 3}]}]').hooks).toEqual([
            { matcher: '', command: 'g', timeoutSec: 3 },
        ]);
    });

    // #190: ввод в процесс (`write_stdin`) хук Codex не зовёт, а без TTY stdin процесса закрыт
    // (стенд `L-repl-*`). Канал закрывает флаг, снимающий `tty`, — и argv без него не годится.
    it('ввод в процесс закрыт: --disable unified_exec_tty в регистрации, без него — отказ', () => {
        const argv = codexGuardArgs(HOOKS);
        const at = argv.indexOf(CODEX_DISABLE_TTY[0]);
        expect(argv.slice(at, at + 2)).toEqual([...CODEX_DISABLE_TTY]);
        const without = argv.filter((a, i) => i !== at && i !== at + 1);
        expect(codexGuardFromArgs(without).problems.join('\n')).toMatch(
            /нет --disable unified_exec_tty[\s\S]*write_stdin/,
        );
    });

    it('TTY, включённый обратно рядом с флагом, — тоже отказ: побеждает последнее слово', () => {
        const argv = codexGuardArgs(HOOKS);
        for (const extra of [
            ['--enable', 'unified_exec_tty'],
            ['-c', 'features.unified_exec_tty=true'],
            ['-c', 'features.unified_exec_tty = true'],
            ['--config', 'features.unified_exec_tty=true'],
            ['--config=features.unified_exec_tty=true'],
            ['-cfeatures.unified_exec_tty=true'],
            ['-c', 'features={unified_exec_tty=true}'],
            ['-c', '"features"."unified_exec_tty"=true'],
            ['--enable=unified_exec_tty'],
        ]) {
            expect(
                codexGuardFromArgs([...argv, ...extra]).problems.join('\n'),
                extra.join(' '),
            ).toMatch(/unified_exec_tty переопределён/);
        }
        // Другие ключи `features` канала не касаются.
        expect(codexGuardFromArgs([...argv, '-c', 'features.hooks=true']).problems).toEqual([]);
        // Оборванный `-c` в хвосте — не ключ TTY и не падение разбора.
        expect(codexGuardFromArgs([...argv, '-c']).problems).toEqual([]);
    });

    it('хуков в argv нет — список пуст (отказ назовёт проба: «ни один хук не накрывает»)', () => {
        expect(codexGuardFromArgs(['exec', '--', '-']).hooks).toEqual([]);
    });

    it('битое значение -c — отказ разбора, а не пустой список молча', () => {
        const { problems } = codexGuardFromArgs([
            CODEX_HOOK_TRUST_FLAG,
            '--enable',
            'hooks',
            '-c',
            'hooks.PreToolUse=[{matcher="Bash",hooks=[',
        ]);
        expect(problems[0]).toMatch(/не разобрался/);
    });
});

describe('Kimi Code: регистрация в config.toml', () => {
    it('блоки [[hooks]] читаются обратно без потерь и среди настроек человека', () => {
        const human = '[default]\nmodel = "k"\n\n[[hooks]]\nevent = "Stop"\ncommand = "x"\n';
        expect(kimiHooksFromToml(`${human}\n${kimiHooksToml(HOOKS)}`)).toEqual({
            hooks: HOOKS,
            problems: [],
        });
    });

    it('литеральная строка и таймаут по умолчанию (30 с) — по правилам Kimi', () => {
        const { hooks } = kimiHooksFromToml(
            "[[hooks]]\nevent = 'PreToolUse'\nmatcher = 'Bash'\ncommand = 'node g.cjs'\n",
        );
        expect(hooks).toEqual([{ matcher: 'Bash', command: 'node g.cjs', timeoutSec: 30 }]);
    });

    it('строка внутри [[hooks]], которую разбор не понял, — отказ с номером строки', () => {
        const { problems } = kimiHooksFromToml(
            '[[hooks]]\nevent = "PreToolUse"\ncommand = """многострочная"""\n',
        );
        expect(problems[0]).toMatch(/строка 3/);
        // Значение незнакомого вида (булево, массив) — тоже отказ, а не пропуск ключа.
        const bool = kimiHooksFromToml('[[hooks]]\nevent = "PreToolUse"\nasync = true\n');
        expect(bool.problems[0]).toMatch(/строка 3/);
    });

    it('заголовок с комментарием и пробелами в скобках — тот же [[hooks]], что позовёт CLI', () => {
        const body = 'event = "PreToolUse"\nmatcher = "Bash"\ncommand = "node g.cjs"\n';
        for (const head of ['[[hooks]] # барьер человека', '[[ hooks ]]', '[[hooks]]#x']) {
            expect(kimiHooksFromToml(`${head}\n${body}`)).toEqual({
                hooks: [{ matcher: 'Bash', command: 'node g.cjs', timeoutSec: 30 }],
                problems: [],
            });
        }
    });

    it('незнакомый заголовок про hooks — отказ, а не молча чужая таблица', () => {
        for (const head of ['[hooks]', '[[hooks.extra]]', '[[ "hooks" ]]']) {
            const { hooks, problems } = kimiHooksFromToml(`${head}\nevent = "PreToolUse"\n`);
            expect(hooks).toEqual([]);
            expect(problems[0]).toMatch(/строка 1: заголовок/);
        }
        // Таблица, где hooks — лишь часть имени, не про хуки.
        expect(kimiHooksFromToml('[pre_hooks_x]\na = 1\n').problems).toEqual([]);
    });

    // Ревью Фазы 16b: `\bhooks\b` ловил чужие таблицы, и каждая сессия отказывала ложно.
    it('hooks не первым сегментом имени — чужая таблица, проблемы нет', () => {
        for (const head of [
            '[mcp.servers.git-hooks]',
            '[providers.hooks]',
            '[mcp_servers.hooks-proxy]',
            '[[agents.hooks]]',
        ]) {
            expect(kimiHooksFromToml(`${head}\na = 1\n`).problems).toEqual([]);
        }
    });

    // Ревью Фазы 16b: inline-хуки человека плюс дописанные [[hooks]] — повторный ключ, CLI падает.
    it('ключ hooks на верхнем уровне — отказ; ключ hooks внутри чужой таблицы — нет', () => {
        for (const line of [
            'hooks = []',
            'hooks=[{event="PreToolUse"}]',
            'hooks.x = 1',
            '"hooks" = []',
        ]) {
            expect(kimiHooksFromToml(`model = "m"\n${line}\n`).problems[0]).toMatch(
                /строка 2: ключ hooks на верхнем уровне/,
            );
        }
        expect(kimiHooksFromToml('[agent]\nhooks = []\n').problems).toEqual([]);
        expect(kimiHooksFromToml('hooks_dir = "/x"\n').problems).toEqual([]);
    });
});

describe('OpenCode: регистрация плагином', () => {
    it('хуки, зашитые в плагин, читаются обратно', () => {
        expect(opencodeHooksFromPlugin(opencodeGuardPlugin(HOOKS))).toEqual({
            hooks: HOOKS,
            problems: [],
        });
    });

    it('битый список хуков в плагине — отказ разбора, а не пустой список молча', () => {
        expect(opencodeHooksFromPlugin('const HOOKS = [{"matcher":;').problems[0]).toMatch(
            /не разобрался/,
        );
    });

    it('плагин без списка хуков — отказ', () => {
        expect(opencodeHooksFromPlugin('export const X = async () => ({});').problems[0]).toMatch(
            /нет списка хуков/,
        );
    });
});

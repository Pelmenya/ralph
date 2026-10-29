// Пакет Codex (#181, #189, #232): регистрация из хуков барьера в общей форме, прочитанная обратно
// из argv `codex exec` и судимая событием нормализатора, команда нормализатора по протоколу и
// объявленная заглушка — доказательство скилла.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_GUARD_LIMIT, CODEX_HOOK_TRUST_FLAG, codexGuardArgs } from '../../harness-guard.ts';
import { ownDescriptor, parseHarnessDescriptor } from '../descriptor.ts';
import { probeMatrix } from '../probe-matrix.ts';
import { ADAPTER_PROTOCOL_VERSION } from '../protocol.ts';
import { main } from './normalize.ts';
import { codexRegistrationFromArgs, harnessPackage } from './package.ts';

const DIR = import.meta.dirname;
const HOOK = {
    matcher: 'Bash',
    command: "export CLAUDE_PROJECT_DIR='/w'; node g.cjs",
    timeoutSec: 5,
};

describe('регистрация барьера Codex', () => {
    it('хуки барьера — в argv и обратно, без признака «не блокирует»', () => {
        const r = harnessPackage.guardRegistration({}, [HOOK]);
        expect(r).toEqual({ hooks: [{ ...HOOK, cannotBlock: null }], problems: [] });
    });

    it('настройки сессии Codex не читает: без хуков барьера регистрация пуста', () => {
        const settings = {
            hooks: {
                PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
            },
        };
        expect(harnessPackage.guardRegistration(settings).hooks).toEqual([]);
    });

    it('argv без флага доверия — причина названа, CLI хук не позовёт', () => {
        const argv = codexGuardArgs([HOOK]).filter((a) => a !== CODEX_HOOK_TRUST_FLAG);
        expect(codexRegistrationFromArgs(argv).problems[0]).toMatch(/нет --dangerously-bypass/);
    });

    it('matcher с якорями, вход в форме Codex, предел барьера назван', () => {
        expect(harnessPackage.matcherCovers('Bash', 'Bash')).toBe(true);
        expect(harnessPackage.matcherCovers('Bas', 'Bash')).toBe(false);
        const payload = JSON.parse(harnessPackage.hookPayload(harnessPackage.probes[0], '/w'));
        expect(payload).toMatchObject({
            cwd: '/w',
            tool_name: 'Bash',
            turn_id: expect.any(String),
        });
        // MCP-мутация вне контура — вердикт политики, а не `unknown-tool` (нормализатор
        // отображает `mcp__…` раньше сверки с `toolMap`).
        expect(
            harnessPackage.probes
                .filter((p) => !['Bash', 'apply_patch'].includes(p.toolName))
                .map((p) => [p.toolName, p.expect === 'blocked' && p.reasonCode]),
        ).toEqual([['mcp__ralph-guard-probe__DeleteRepository', 'mcp-not-allowed']]);
        expect(harnessPackage.guardInput).toBe('event');
        expect(harnessPackage.setsProjectDirEnv).toBe(false);
        expect(harnessPackage.skillBarrier).toBe(false);
        expect(harnessPackage.guardLimit).toBe(CODEX_GUARD_LIMIT);
    });

    // #232: патч данных контура в стартовой пробе — тот же, что у матрицы описания, с контекстом
    // петли и с разрешённой парой: без пары нормализатор, блокирующий любой патч, прошёл бы.
    it('проба старта: патч данных контура из матрицы описания и разрешённый патч, оба в петле', () => {
        const patches = harnessPackage.probes.filter((p) => p.toolName === 'apply_patch');
        expect(patches.map((p) => [p.expect, p.loop])).toEqual([
            ['blocked', true],
            ['blocked', true],
            ['allowed', true],
        ]);
        const [contour, surface] = patches;
        // #199: патч поверхности конфига своего CLI — слоя, который отвергает и preflight.
        expect(surface).toMatchObject({ reasonCode: 'config-surface' });
        expect(String(surface.toolInput.command)).toContain('*** Add File: .codex/config.toml');
        expect(contour).toMatchObject({ expect: 'blocked', reasonCode: 'contour-data' });
        const descriptor = parseHarnessDescriptor(
            JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
            'codex',
        );
        const add = probeMatrix(descriptor).probes.find(
            (p) => p.id === 'rule:apply_patch:contour-add',
        );
        expect(contour.toolInput).toEqual(add?.input);
    });

    // #195: дом CLI человека лежит в предке дерева (`~/.codex`), но слоем проекта не является.
    it('слои .codex/ отвергаются; дом CLI человека — исключение, а не слой', () => {
        const layers = harnessPackage.projectLayers;
        expect(layers).not.toBeNull();
        expect(layers?.homes({ HOME: '/h' })).toEqual(['/h/.codex']);
        // `~/.codex` от прежнего запуска без переменной — тоже дом, а не слой в предке.
        expect(layers?.homes({ CODEX_HOME: '/c', HOME: '/h' })).toEqual(['/c', '/h/.codex']);
        expect(layers?.homes({ CODEX_HOME: '/h/.codex', HOME: '/h' })).toEqual(['/h/.codex']);
        expect(layers?.homes({ CODEX_HOME: '/c' })).toEqual(['/c']);
        expect(layers?.homes({})).toEqual([]);
    });
});

describe('описание и заглушка скилла', () => {
    it('описание проходит схему, заглушка скилла названа словом, а не пропуском', () => {
        const d = parseHarnessDescriptor(
            JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
            'codex',
        );
        expect(d.harness).toBe('codex');
        expect(d.skillEvidence.source).toMatch(/^заглушка/);
        expect(d.inventorySource).toMatch(/^стенд 0\.163\.0/);
        expect(d.toolMap).toEqual({ Bash: 'exec', apply_patch: 'patch' });
        expect(d.configSurfaces).toEqual(['.codex/config.toml', '.codex/hooks.json']);
    });
});

describe('команда нормализатора', () => {
    const run = async (stdin: string) => {
        const out: string[] = [];
        const err: string[] = [];
        let code = -1;
        await main({
            stdin: (async function* () {
                yield stdin;
            })(),
            writeFn: (t) => out.push(t),
            errorFn: (t) => err.push(t),
            exitFn: (c) => {
                code = c;
            },
        });
        return { out: out.join(''), err: err.join(''), code };
    };
    const raw = { tool_name: 'Bash', cwd: '/w', tool_input: { command: 'ls' } };

    it('ответ по протоколу на вход хука', async () => {
        const r = await run(JSON.stringify(raw));
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out)).toEqual({
            protocol: ADAPTER_PROTOCOL_VERSION,
            event: { operations: [{ op: 'exec', command: 'ls', baseDir: '/w' }] },
        });
    });

    it('вход не JSON — код 1 с причиной', async () => {
        const r = await run('{');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/вход хука не JSON/);
    });

    it('описание чужого харнесса рядом с командой — отказ', () => {
        const d = JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8'));
        expect(() => ownDescriptor({ ...d, harness: 'claude-code' }, 'd', 'codex')).toThrow(
            /описание харнесса «claude-code», а команда — нормализатор codex/,
        );
    });

    it('описание называет именно эту команду, и она исполняется процессом', () => {
        const patch = '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n';
        const r = spawnSync('node', [path.join(DIR, 'normalize.ts')], {
            input: JSON.stringify({
                ...raw,
                tool_name: 'apply_patch',
                tool_input: { command: patch },
            }),
            encoding: 'utf-8',
            timeout: 30_000,
        });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).event.operations).toEqual([
            { op: 'delete', path: 'gone.txt', baseDir: '/w' },
        ]);
    });
});

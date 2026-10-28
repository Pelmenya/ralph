// Пакет OpenCode (#213, #192): регистрация плагином из хуков барьера в общей форме, прочитанная
// обратно из исходника, команда нормализатора и объявленная заглушка доказательства скилла.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_PROBES, opencodeEvent, opencodeGuardPlugin } from '../../harness-guard.ts';
import { ownDescriptor, parseHarnessDescriptor } from '../descriptor.ts';
import { ADAPTER_PROTOCOL_VERSION } from '../protocol.ts';
import { main } from './normalize.ts';
import { harnessPackage, opencodeRegistrationFromPlugin } from './package.ts';

const DIR = import.meta.dirname;
const HOOK = {
    matcher: 'Bash|Read|Grep|mcp__.*',
    command: "export CLAUDE_PROJECT_DIR='/w'; node g.cjs",
    timeoutSec: 5,
};

describe('регистрация барьера OpenCode', () => {
    it('хуки барьера — в исходник плагина и обратно, без признака «не блокирует»', () => {
        expect(harnessPackage.guardRegistration({}, [HOOK])).toEqual({
            hooks: [{ ...HOOK, cannotBlock: null }],
            problems: [],
        });
    });

    it('настройки сессии OpenCode не читает: без хуков барьера регистрация пуста', () => {
        const settings = {
            hooks: {
                PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
            },
        };
        expect(harnessPackage.guardRegistration(settings).hooks).toEqual([]);
    });

    it('плагин без списка хуков — причина названа', () => {
        expect(opencodeRegistrationFromPlugin('export {};').problems[0]).toMatch(/нет списка/);
    });

    it('регистрация — плагином: исходник, обратное чтение и событие CLI', () => {
        const plugin = harnessPackage.plugin!;
        expect(plugin.source([HOOK])).toBe(opencodeGuardPlugin([HOOK]));
        expect(plugin.read(plugin.source([HOOK])).hooks).toHaveLength(1);
        const probe = HARNESS_PROBES.opencode[0];
        expect(plugin.event(probe)).toEqual(opencodeEvent(probe));
        expect(JSON.parse(harnessPackage.hookPayload(probe, '/w'))).toEqual(opencodeEvent(probe));
    });

    it('matcher в именах Claude Code накрывает инструмент OpenCode по переводу', () => {
        expect(harnessPackage.matcherCovers('Bash', 'bash')).toBe(true);
        expect(harnessPackage.matcherCovers('Bash', 'read')).toBe(false);
        expect(harnessPackage.matcherCovers('mcp__.*', 'ralph-guard-probe_ListIssues')).toBe(true);
        expect(harnessPackage.probes).toBe(HARNESS_PROBES.opencode);
        expect(harnessPackage.setsProjectDirEnv).toBe(false);
        expect(harnessPackage.skillBarrier).toBe(false);
        expect(harnessPackage.guardLimit).toBeNull();
    });

    // #197: сборщик конфига — дом `~/.opencode` из скана исключён (его сверяет сборщик перед
    // спавном), а `opencode.json` — слой только с ключами, которые грузят или исполняют код.
    it('projectLayers: дом ~/.opencode исключён, JSON-слой — по исполняющим ключам', () => {
        expect(harnessPackage.projectLayers?.homes({ HOME: '/h' })).toEqual(['/h/.opencode']);
        expect(harnessPackage.projectLayers?.homes({})).toEqual([]);
        expect(harnessPackage.projectLayers?.jsonKeys).toEqual([
            'plugin',
            'mcp',
            'formatter',
            'lsp',
            'shell',
            'command',
            'provider.*.npm',
            'provider.*.models.*.provider.npm',
        ]);
    });
});

describe('описание и команда нормализатора', () => {
    it('описание проходит схему; заглушка доказательства скилла названа словом', () => {
        const d = parseHarnessDescriptor(
            JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
            'opencode',
        );
        expect(d.harness).toBe('opencode');
        expect(d.argMap.read).toEqual({ path: 'filePath' });
        expect(d.argMap.apply_patch).toEqual({ patch: 'patchText' });
        expect(d.skillEvidence.source).toMatch(/^заглушка/);
        expect(d.inventorySource).toMatch(/^стенд 1\.19\.4/);
        expect(harnessPackage.guardInput).toBe('event');
    });

    it('чужое описание рядом с командой — отказ, а не суд таблицами другого CLI', () => {
        const raw = JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8'));
        expect(() => ownDescriptor({ ...raw, harness: 'codex' }, 'x.json', 'opencode')).toThrow(
            /нормализатор opencode/,
        );
    });

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
        return { code, out: out.join(''), err: err.join('') };
    };

    it('событие плагина — ответ протокола с операциями', async () => {
        const r = await run(
            JSON.stringify({
                cwd: '/w',
                opencode: { tool: 'read', sessionID: 's', callID: 'c', args: { filePath: 'a.ts' } },
            }),
        );
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out)).toEqual({
            protocol: ADAPTER_PROTOCOL_VERSION,
            event: { operations: [{ op: 'read', path: 'a.ts', baseDir: '/w' }] },
        });
    });

    it('вход не JSON — отказ команды с причиной: блок неисправностью', async () => {
        const r = await run('не json');
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
        expect(r.err).toMatch(/вход хука не JSON/);
    });
});

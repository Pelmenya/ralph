// Пакет OpenCode (#213): регистрация 16b плагином из хуков барьера в общей форме, прочитанная
// обратно из исходника, и объявленные заглушки — нормализатор и доказательство скилла.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_PROBES, opencodeEvent, opencodeGuardPlugin } from '../../harness-guard.ts';
import { parseHarnessDescriptor } from '../descriptor.ts';
import { ADAPTER_PROTOCOL_VERSION } from '../protocol.ts';
import { STUB_REASON, main } from './normalize.ts';
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
        expect(harnessPackage.projectLayers).toBeNull();
    });
});

describe('объявленные заглушки', () => {
    it('описание проходит схему, заглушки названы словом, а не пропуском', () => {
        const d = parseHarnessDescriptor(
            JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
            'opencode',
        );
        expect(d.harness).toBe('opencode');
        expect(d.argMap.read).toEqual({ path: 'filePath' });
        expect(d.skillEvidence.source).toMatch(/^заглушка/);
        expect(d.inventorySource).toMatch(/^заглушка/);
    });

    it('нормализатор-заглушка — отказ команды с причиной: блок неисправностью, а не правилом', async () => {
        const out: string[] = [];
        const err: string[] = [];
        let code = -1;
        await main({
            stdin: (async function* () {
                yield JSON.stringify({ tool: 'read', args: { filePath: 'a.ts' } });
            })(),
            writeFn: (t) => out.push(t),
            errorFn: (t) => err.push(t),
            exitFn: (c) => {
                code = c;
            },
        });
        expect(code).toBe(1);
        expect(out).toEqual([]);
        expect(err.join('')).toBe(`нормализатор упал: ${STUB_REASON}
`);
    });
});

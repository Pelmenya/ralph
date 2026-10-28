// Пакет Codex (#181): регистрация 16b из хуков барьера в общей форме, прочитанная обратно из
// argv `codex exec`, и объявленные заглушки — нормализатор и доказательство скилла.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_GUARD_LIMIT, CODEX_HOOK_TRUST_FLAG, codexGuardArgs } from '../../harness-guard.ts';
import { parseHarnessDescriptor } from '../descriptor.ts';
import { ADAPTER_PROTOCOL_VERSION } from '../protocol.ts';
import { STUB_REASON, main } from './normalize.ts';
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
        expect(harnessPackage.probes.every((p) => p.toolName === 'Bash')).toBe(true);
        expect(harnessPackage.setsProjectDirEnv).toBe(false);
        expect(harnessPackage.skillBarrier).toBe(false);
        expect(harnessPackage.guardLimit).toBe(CODEX_GUARD_LIMIT);
    });
});

describe('объявленные заглушки', () => {
    it('описание проходит схему, заглушки названы словом, а не пропуском', () => {
        const d = parseHarnessDescriptor(
            JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
            'codex',
        );
        expect(d.harness).toBe('codex');
        expect(d.skillEvidence.source).toMatch(/^заглушка/);
        expect(d.inventorySource).toMatch(/^заглушка/);
    });

    it('нормализатор-заглушка — отказ команды с причиной: блок неисправностью, а не правилом', async () => {
        const out: string[] = [];
        const err: string[] = [];
        let code = -1;
        await main({
            stdin: (async function* () {
                yield JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });
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

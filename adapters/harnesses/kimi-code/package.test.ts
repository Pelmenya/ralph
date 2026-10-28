// Пакет Kimi Code (#181): регистрация 16b из хуков барьера в общей форме, прочитанная обратно
// из `config.toml` дома CLI, и объявленные заглушки — нормализатор и доказательство скилла.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { kimiHooksToml } from '../../harness-guard.ts';
import { parseHarnessDescriptor } from '../descriptor.ts';
import { ADAPTER_PROTOCOL_VERSION } from '../protocol.ts';
import { STUB_REASON, main } from './normalize.ts';
import { harnessPackage, kimiRegistrationFromToml } from './package.ts';

const DIR = import.meta.dirname;
const HOOK = {
    matcher: 'Bash|Read',
    command: "export CLAUDE_PROJECT_DIR='/w'; node g.cjs",
    timeoutSec: 5,
};

describe('регистрация барьера Kimi Code', () => {
    it('хуки барьера — в [[hooks]] и обратно, без признака «не блокирует»', () => {
        const r = harnessPackage.guardRegistration({}, [HOOK]);
        expect(r).toEqual({ hooks: [{ ...HOOK, cannotBlock: null }], problems: [] });
    });

    it('настройки сессии Kimi Code не читает: без хуков барьера регистрация пуста', () => {
        const settings = {
            hooks: {
                PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
            },
        };
        expect(harnessPackage.guardRegistration(settings).hooks).toEqual([]);
    });

    it('hooks верхнего уровня рядом с [[hooks]] — причина названа', () => {
        const toml = `hooks = []\n${kimiHooksToml([HOOK])}`;
        expect(kimiRegistrationFromToml(toml).problems[0]).toMatch(/ключ hooks на верхнем уровне/);
    });

    it('matcher без якорей, путь файла — поле path, предела сверх пробы нет', () => {
        expect(harnessPackage.matcherCovers('Bas', 'Bash')).toBe(true);
        const read = harnessPackage.probes.find((p) => p.toolName === 'Read')!;
        expect(Object.keys(read.toolInput)).toEqual(['path']);
        const payload = JSON.parse(harnessPackage.hookPayload(read, '/w'));
        expect(payload).toMatchObject({ cwd: '/w', client_type: 'kimi_code_cli' });
        expect(harnessPackage.setsProjectDirEnv).toBe(false);
        expect(harnessPackage.skillBarrier).toBe(false);
        expect(harnessPackage.guardLimit).toBeNull();
    });
});

describe('объявленные заглушки', () => {
    it('описание проходит схему, заглушки названы словом, а не пропуском', () => {
        const d = parseHarnessDescriptor(
            JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
            'kimi-code',
        );
        expect(d.harness).toBe('kimi-code');
        expect(d.argMap.Read).toEqual({ path: 'path' });
        expect(d.skillEvidence.source).toMatch(/^заглушка/);
        expect(d.inventorySource).toMatch(/^заглушка/);
    });

    it('нормализатор-заглушка — отказ команды с причиной: блок неисправностью, а не правилом', async () => {
        const out: string[] = [];
        const err: string[] = [];
        let code = -1;
        await main({
            stdin: (async function* () {
                yield JSON.stringify({ tool_name: 'Read', tool_input: { path: 'a.ts' } });
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

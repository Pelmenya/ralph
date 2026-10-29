// Пакет Kimi Code (#181, #191): регистрация из хуков барьера в общей форме, прочитанная обратно
// из `config.toml` дома CLI и судимая событием нормализатора, команда нормализатора по протоколу и
// объявленная заглушка — доказательство скилла.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_CRASH_PASSES, kimiHooksToml } from '../../harness-guard.ts';
import { ownDescriptor, parseHarnessDescriptor } from '../descriptor.ts';
import { ADAPTER_PROTOCOL_VERSION } from '../protocol.ts';
import { main } from './normalize.ts';
import { harnessPackage, kimiRegistrationFromToml } from './package.ts';

const DIR = import.meta.dirname;
const HOOK = {
    matcher: 'Bash|Read',
    command: "export CLAUDE_PROJECT_DIR='/w'; node g.cjs",
    timeoutSec: 5,
};
const descriptorRaw = () => JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8'));

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

    it('matcher без якорей, путь файла — поле path, судит событие, предела сверх пробы нет', () => {
        expect(harnessPackage.matcherCovers('Bas', 'Bash')).toBe(true);
        const read = harnessPackage.probes.find((p) => p.toolName === 'Read')!;
        expect(Object.keys(read.toolInput)).toEqual(['path']);
        const payload = JSON.parse(harnessPackage.hookPayload(read, '/w'));
        expect(payload).toMatchObject({ cwd: '/w', client_type: 'kimi_code_cli' });
        expect(harnessPackage.guardInput).toBe('event');
        expect(harnessPackage.setsProjectDirEnv).toBe(false);
        expect(harnessPackage.skillBarrier).toBe(false);
        expect(harnessPackage.guardLimit).toBe(`kimi-code: ${HOOK_CRASH_PASSES}`);
    });

    // #196: проектные слои держит недоверие каталогу; поверхностей отказа нет — и домов тоже.
    it('сборщик конфига есть; поверхностей отказа и исключаемых домов нет', () => {
        const layers = harnessPackage.projectLayers;
        expect(layers).not.toBeNull();
        expect(layers?.homes({ KIMI_CODE_HOME: '/k', HOME: '/h' })).toEqual([]);
        const d = JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8'));
        expect(d.configSurfaces).toEqual([]);
    });

    // #191: то, чего совместимый вход не видел, — `Write{path}` и `Bash{cwd}` — в петле, и
    // разрешённая запись парой: нормализатор, блокирующий любой `Write`, прошёл бы без неё.
    it('проба старта: запись данных контура, перенос из cwd оболочки и разрешённая запись — в петле', () => {
        const loop = harnessPackage.probes.filter((p) => p.loop);
        expect(loop.map((p) => [p.toolName, p.expect])).toEqual([
            ['Write', 'blocked'],
            ['Bash', 'blocked'],
            ['Write', 'blocked'],
            ['Write', 'allowed'],
        ]);
        expect(loop[1].toolInput).toMatchObject({ cwd: '.claude' });
        for (const p of loop.slice(0, 2)) expect(p).toMatchObject({ reasonCode: 'contour-data' });
        // #199: запись поверхности конфига своего CLI — из перечня описания.
        expect(loop[2]).toMatchObject({
            reasonCode: 'config-surface',
            toolInput: { path: '.kimi-code/mcp.json' },
        });
        expect(descriptorRaw().protectedSurfaces.tree).toContain('.kimi-code/');
    });
});

describe('описание и заглушка скилла', () => {
    it('описание проходит схему, заглушка скилла названа словом, а не пропуском', () => {
        const d = parseHarnessDescriptor(descriptorRaw(), 'kimi-code');
        expect(d.harness).toBe('kimi-code');
        expect(d.argMap.Write).toEqual({ path: 'path' });
        expect(d.toolMap).toMatchObject({ FetchURL: 'fetch', Agent: 'agent', CronCreate: 'defer' });
        expect(d.skillEvidence.source).toMatch(/^заглушка/);
        expect(d.inventorySource).toMatch(/^стенд 2\.3\.2/);
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
    const raw = { tool_name: 'Read', cwd: '/w', tool_input: { path: 'a.ts' } };

    it('ответ по протоколу на вход хука', async () => {
        const r = await run(JSON.stringify(raw));
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out)).toEqual({
            protocol: ADAPTER_PROTOCOL_VERSION,
            event: { operations: [{ op: 'read', path: 'a.ts', baseDir: '/w' }] },
        });
    });

    it('вход не JSON — код 1 с причиной', async () => {
        const r = await run('{');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/вход хука не JSON/);
    });

    it('описание чужого харнесса рядом с командой — отказ', () => {
        expect(() =>
            ownDescriptor({ ...descriptorRaw(), harness: 'codex' }, 'd', 'kimi-code'),
        ).toThrow(/описание харнесса «codex», а команда — нормализатор kimi-code/);
    });

    it('описание называет именно эту команду, и она исполняется процессом', () => {
        expect(descriptorRaw().normalizer).toBe('normalize.ts');
        const r = spawnSync('node', [path.join(DIR, 'normalize.ts')], {
            input: JSON.stringify({
                ...raw,
                tool_name: 'Bash',
                tool_input: { command: 'ls', cwd: '/elsewhere' },
            }),
            encoding: 'utf-8',
            timeout: 30_000,
        });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).event.operations).toEqual([
            { op: 'exec', command: 'ls', baseDir: '/elsewhere' },
        ]);
    });
});

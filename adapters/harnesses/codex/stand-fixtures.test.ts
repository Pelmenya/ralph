// Факты о Codex 0.163.0, снятые на стенде живых проб (#188): фикстура
// `__fixtures__/codex-0.163.0-stand.json` сырая, и этот набор держит выводы из неё рядом с
// описанием пакета. Разбор 27.10 знал о `apply_patch`, code mode и MCP только «по доке», и
// предел барьера Codex строился на утверждении, что хук зовётся одной оболочкой, — стенд его
// опроверг. Здесь утверждение, которое проверено стендом, а не прочитано.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_DISABLE_TTY } from '../../harness-guard.ts';
import { parseHarnessDescriptor } from '../descriptor.ts';
import { kitScriptProblems } from '../stand-scrub.ts';

const DIR = import.meta.dirname;
const FX = JSON.parse(
    readFileSync(path.join(DIR, '..', '__fixtures__', 'codex-0.163.0-stand.json'), 'utf-8'),
);
const DESCRIPTOR = parseHarnessDescriptor(
    JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
    'codex',
);

type TEvent = { tool_name: string; tool_input: Record<string, unknown> } & Record<string, unknown>;
const SECTIONS = [
    'events',
    'noEvent',
    'inventory',
    'trust',
    'hookLayers',
    'loopChannels',
    'sessionHome',
] as const;
const byId = (section: (typeof SECTIONS)[number], id: string) => {
    const e = FX[section].find((x: { id: string }) => x.id === id);
    if (!e) throw new Error(`нет случая ${id} в ${section}`);
    return e;
};
const hookEvents = (id: string): TEvent[] =>
    byId('events', id).hookStdin.map((s: string) => JSON.parse(s));

describe('фикстура стенда — сырая, у каждой записи источник и версия', () => {
    it('не собранная, версия совпадает с описанием пакета', () => {
        expect(FX.assembled).toBe(false);
        expect(FX.cliVersion).toBe(DESCRIPTOR.cliVersion);
        for (const s of SECTIONS) {
            expect(FX[s].length).toBeGreaterThan(0);
            for (const e of FX[s]) {
                expect(e.cliVersion, e.id).toBe('0.163.0');
                expect(e.source, e.id).toMatch(/codex-cli 0\.163\.0/);
                expect(e.caseScript, e.id).toEqual(expect.any(String));
            }
        }
    });

    it('набор воспроизведения цел: вход с шебангом, без подстановки между символами', () => {
        expect(kitScriptProblems(FX.kit)).toEqual([]);
    });

    it('без путей машины: только абстрактные корни', () => {
        const text = JSON.stringify(FX);
        expect(text).not.toMatch(/(?<![\w.-])\/(root|home|tmp)\//);
        expect(text).toMatch(/\/path\/to\/stand/);
    });
});

describe('событие PreToolUse Codex', () => {
    const all = FX.events.flatMap((e: { id: string }) => hookEvents(e.id));

    it('конверт — только поля описания пакета (включая tool_use_id)', () => {
        const envelope = new Set([...DESCRIPTOR.allowedFields.envelope]);
        for (const ev of all) {
            for (const k of Object.keys(ev)) expect(envelope.has(k), k).toBe(true);
            expect(ev.hook_event_name).toBe('PreToolUse');
        }
    });

    it('exec_command приходит как Bash с одним command — workdir хук не видит', () => {
        for (const id of ['cm-exec', 'cm-exec-allowed', 'dx-exec']) {
            const [ev] = hookEvents(id);
            expect(ev.tool_name).toBe('Bash');
            expect(Object.keys(ev.tool_input)).toEqual(['command']);
        }
        // Вызов модели нёс workdir, эффект лёг в подкаталог, а событие его не назвало.
        expect(byId('events', 'cm-exec-allowed').call).toContain('workdir');
        expect(byId('events', 'cm-exec-allowed').loopStatus).toEqual([
            '?? sub/ralph-stand-allowed',
        ]);
        expect(byId('events', 'cm-exec-allowed').hookStdin[0]).not.toContain('workdir');
    });

    it('apply_patch зовёт хук своим именем, патч целиком в tool_input.command', () => {
        for (const id of ['cm-patch', 'cm-patch-allowed', 'dx-patch', 'dx-patch-allowed']) {
            const [ev] = hookEvents(id);
            expect(ev.tool_name).toBe('apply_patch');
            expect(Object.keys(ev.tool_input)).toEqual(['command']);
            expect(ev.tool_input.command).toMatch(/^\*\*\* Begin Patch\n/);
        }
        // Код 2 хука патч не применил: дерево чистое.
        expect(byId('events', 'cm-patch').loopStatus).toEqual([]);
    });

    it('MCP — mcp__<сервер>__<инструмент>, аргументы как есть; мутация блокируется', () => {
        expect(hookEvents('cm-mcp').map((e) => [e.tool_name, e.tool_input])).toEqual([
            ['mcp__stand__stand_read', { key: 'k' }],
            ['mcp__stand__stand_write', { key: 'k', value: 'ralph-stand-forbidden' }],
        ]);
    });

    it('code mode: сам exec хук не зовёт, зовут только вложенные вызовы', () => {
        for (const id of ['cm-exec', 'cm-patch', 'cm-mcp']) {
            expect(byId('events', id).call).toContain('"name": "exec"');
            expect(hookEvents(id).every((e) => e.tool_name !== 'exec')).toBe(true);
        }
    });
});

describe('write_stdin — канал мимо хука', () => {
    it('ввод в живой процесс хук не зовёт: событий write_stdin нет нигде', () => {
        for (const id of ['cm-stdin-hook', 'cm-stdin-live', 'dx-stdin-live']) {
            const e = byId('noEvent', id);
            expect(JSON.stringify(e.call)).toContain('write_stdin');
            const names = e.hookStdin.map((s: string) => JSON.parse(s).tool_name);
            expect(names).not.toContain('write_stdin');
        }
    });

    it('--disable unified_exec_tty отвергает tty, без tty у процесса закрыт stdin', () => {
        expect(byId('noEvent', 'cm-notty').cliToolOutput.join('')).toContain(
            'TTY execution is disabled by config',
        );
        expect(byId('noEvent', 'dx-stdin-live').cliToolOutput.join('')).toContain(
            'stdin is closed for this session',
        );
    });

    it('--disable shell_tool снимает и exec_command, и write_stdin', () => {
        expect(byId('inventory', 'inv-noshell').codeModeNested).not.toContain('write_stdin');
        expect(byId('inventory', 'inv-noshell').codeModeNested).not.toContain('exec_command');
        expect(byId('inventory', 'inv-nounified').codeModeNested).toContain('write_stdin');
    });
});

// #190: каналы исполнения под argv петли — регистрация барьера с `--disable unified_exec_tty`,
// `--ignore-user-config`, `-s danger-full-access`. Хук стенда блокирует только маркер
// `ralph-stand-forbidden`; запрещённый ввод несёт его, разрешённый — нет.
describe('каналы исполнения под argv петли (#190)', () => {
    const LOOP = FX.loopChannels as Array<{ id: string } & Record<string, any>>;
    const outputs = (id: string) => byId('loopChannels', id).cliToolOutput.join('\n');
    const hookTools = (id: string) =>
        byId('loopChannels', id).hookStdin.map((s: string) => JSON.parse(s).tool_name);

    it('каждый случай — argv петли с выключенным TTY', () => {
        for (const e of LOOP) {
            expect(e.argv, e.id).toContain(CODEX_DISABLE_TTY.join(' '));
            expect(e.argv, e.id).toContain('--ignore-user-config');
            expect(e.argv, e.id).toContain('-s danger-full-access');
        }
    });

    it('tty=true отвергнут для оболочки и REPL — процесса с открытым stdin нет', () => {
        for (const cmd of ['bash --noprofile --norc ERR', 'python3 -i ERR', 'node -i ERR']) {
            expect(outputs('L-tty-cm')).toContain(`${cmd} TTY execution is disabled by config`);
        }
        expect(outputs('L-tty-dx')).toContain('TTY execution is disabled by config');
        for (const id of ['L-tty-cm', 'L-tty-dx']) {
            expect(byId('loopChannels', id).loopStatus, id).toEqual([]);
        }
    });

    it('запрещённый ввод в живую оболочку и REPL: хук не позван, stdin закрыт, эффекта нет', () => {
        const closed = 'write_stdin failed: stdin is closed for this session';
        for (const cmd of ['bash --noprofile --norc', 'python3 -i', 'node -i']) {
            expect(outputs('L-repl-cm')).toContain(`${cmd} ERR ${closed}`);
        }
        expect(outputs('L-repl-dx')).toContain(closed);
        for (const id of ['L-repl-cm', 'L-repl-dx']) {
            expect(hookTools(id), id).not.toContain('write_stdin');
            const status = byId('loopChannels', id).loopStatus.join('\n');
            expect(status, id).not.toMatch(/forbidden/);
        }
    });

    it('разрешённый ввод в оболочку и REPL — командой exec_command: хук судит, эффект есть', () => {
        expect(byId('loopChannels', 'L-repl-cm').loopStatus).toEqual([
            '?? ralph-stand-allowed-py',
            '?? ralph-stand-allowed-sh',
        ]);
        expect(byId('loopChannels', 'L-repl-dx').loopStatus).toEqual(['?? ralph-stand-allowed-py']);
        const judged = byId('loopChannels', 'L-repl-cm').hookStdin.map(
            (s: string) => JSON.parse(s).tool_input.command,
        );
        expect(
            judged.some(
                (c: string) => c.includes('ralph-stand-allowed-py') && c.endsWith('| python3'),
            ),
        ).toBe(true);
    });

    it('сам exec code mode хук не получает, но среды для эффекта в нём нет', () => {
        const out = outputs('L-exec-js');
        for (const name of ['require', 'process', 'fetch', 'Deno', 'Bun', 'WebSocket']) {
            expect(out).toContain(`${name} = undefined`);
        }
        expect(out).toContain('importFs ERR unsupported import in exec');
        expect(byId('loopChannels', 'L-exec-js').hookStdin).toEqual([]);
        expect(byId('loopChannels', 'L-exec-js').loopStatus).toEqual([]);
    });

    it('каналы описания названы, у каждого доказательство — случаи этой фикстуры', () => {
        expect(
            Object.fromEntries(
                Object.entries(DESCRIPTOR.eventCoverage).map(([k, v]) => [k, v.mode]),
            ),
        ).toEqual({
            direct: 'intercepted',
            'code-mode': 'intercepted',
            write_stdin: 'disabled',
        });
        const ids = new Set(SECTIONS.flatMap((s) => FX[s].map((e: { id: string }) => e.id)));
        for (const [channel, { evidence }] of Object.entries(DESCRIPTOR.eventCoverage)) {
            const cited = [...evidence.matchAll(/`([A-Za-z]+(?:-[\w]+)+)`/g)].map((m) => m[1]);
            expect(cited.length, channel).toBeGreaterThan(0);
            for (const id of cited) expect(ids.has(id), `${channel}: ${id}`).toBe(true);
        }
    });
});

describe('доверие проекту', () => {
    const wrote = (id: string) => /trust_level = "trusted"/.test(byId('trust', id).configAfter);

    it('пишется при песочнице шире read-only и без записи о проекте — и под argv петли', () => {
        for (const id of ['t-ws', 't-dfa', 't-bypass', 'L-proj']) expect(wrote(id), id).toBe(true);
        for (const id of ['t-default', 't-ro', 't-cflag', 't-untrusted'])
            expect(wrote(id), id).toBe(false);
        expect(byId('trust', 'L-proj').argv).toContain('--ignore-user-config');
    });
});

describe('слои хуков', () => {
    const called = (id: string) => byId('hookLayers', id).hooksCalled;

    it('-c хуки проекта и дома не заменяет: под флагом доверия хукам зовутся все', () => {
        expect(called('h-projtoml')).toEqual(['hook', 'projtoml']);
        expect(called('h-subtoml')).toEqual(['hook', 'subtoml']);
        expect(called('h-usertoml')).toEqual(['hook', 'usertoml']);
    });

    it('без --dangerously-bypass-hook-trust не зовётся ни один хук', () => {
        expect(called('h-notrust')).toEqual([]);
        expect(called('h-projtoml-notrust')).toEqual([]);
    });

    it('недоверенный проект и argv петли проектные хуки не исполняют', () => {
        for (const id of [
            'h-projtoml-untrusted',
            'u-sub',
            'u-loopkey',
            'L-proj',
            'L-proj-pretrusted',
        ])
            expect(called(id), id).toEqual(['hook']);
    });

    it('под --ignore-user-config hooks.json дома всё равно исполняется', () => {
        expect(called('L-home')).toEqual(['hook', 'userjson']);
    });

    // #195: preflight отвергает слои и в предках дерева, но сам CLI над корнем репозитория их
    // не читает — отказ там защита от дрейфа, а не от доказанного канала (`config-layers.ts`).
    it('слои .codex/ над корнем репозитория не исполняются даже у доверенного проекта', () => {
        expect(called('S-anc')).toEqual(['hook']);
        expect(byId('hookLayers', 'S-anc').argv).not.toContain('--ignore-user-config');
    });
});

// #195: сборщик конфига — свой дом CLI в каталоге состояния и недоверие проекту в argv.
describe('дом сессии раннера и недоверенный проект (#195)', () => {
    const own = byId('sessionHome', 'S-own');
    const guard = byId('sessionHome', 'S-guard');
    const UNTRUST = /-c projects=.*work\/consumer.*untrusted.*work\/loop.*untrusted/;

    it('argv петли: --ignore-user-config и недоверие ключами главного репозитория и worktree', () => {
        for (const e of [own, guard]) {
            expect(e.argv, e.id).toContain('--ignore-user-config');
            expect(e.argv.replace(/\\/g, ''), e.id).toMatch(UNTRUST);
        }
        expect(guard.argv).toContain(CODEX_DISABLE_TTY.join(' '));
    });

    it('наш хук получает оба вызова: запрещённый заблокирован, разрешённый исполнен', () => {
        expect(own.hookCommands).toEqual(own.calls);
        expect(own.cliToolOutput[0]).toMatch(/^Command blocked by PreToolUse hook/);
        expect(own.loopStatus).toEqual(['?? allowed.txt']);
    });

    it('хуки дома человека и проекта не позваны, MCP проекта не поднят', () => {
        expect(own.hooksCalled).toEqual(['hook']);
        expect(own.mcpJournal).toBe(false);
        // Guard канона журнала стенда не пишет: пустой список — проектный хук с маркером молчал.
        expect(guard.hooksCalled).toEqual([]);
    });

    it('guard канона: чтение env-файла — блок кодом secret-env, содержимое модели не ушло', () => {
        expect(guard.hookStderr).toContain('hook: PreToolUse Blocked');
        expect(guard.cliToolOutput[0]).toMatch(/ralph-reason-code: secret-env/);
        expect(guard.secretInProvider).toBe(false);
        expect(guard.loopStatus).toEqual(['?? allowed.txt']);
    });

    it('конфиг человека побайтно тот же, в доме сессии доверие не записано', () => {
        expect(own.humanHomeSameBytes).toBe(true);
        for (const e of [own, guard]) {
            expect(e.sessionConfigAfter, e.id).toMatch(/^#[^\n]*\n$/);
            expect(e.sessionConfigAfter, e.id).not.toMatch(/trust_level/);
        }
    });

    // Отказ механизма перехвата: двойка без текста причины у Codex — сбой хука, а не блок.
    // Guard канона пишет причину всегда; хук, который глушит stderr, барьером не был бы.
    it('код 2 без stderr Codex считает упавшим хуком — вызов исполняется', () => {
        const e = byId('sessionHome', 'S-guard-nostderr');
        expect(e.hookStderr).toContain('hook: PreToolUse Failed');
        expect(e.secretInProvider).toBe(true);
    });
});

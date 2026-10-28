// Нормализатор OpenCode (#192) на сырых событиях стенда 1.19.4 и на отказах разбора. Фикстура
// стенда держит и выводы о CLI: каждое событие дошло до плагина, запрещённое отменено, а перечень
// инструментов описания покрывает то, что CLI отдал модели.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHarnessDescriptor, type HarnessDescriptor } from '../descriptor.ts';
import { OPENCODE_HOOK_FIELDS, normalizeOpencodeEvent } from './event.ts';

const DIR = import.meta.dirname;
const descriptor = parseHarnessDescriptor(
    JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
    'opencode',
);
type PluginEvent = {
    ctx: { directory: string; worktree: string };
    input: Record<string, unknown>;
    output: { args: Record<string, unknown> };
};
type StandEvent = {
    id: string;
    model: string;
    call: { name: string; arguments: Record<string, unknown> };
    pluginEvents: PluginEvent[];
    toolStatus: string;
    toolError: string | null;
    tree: string;
};
const FX = JSON.parse(
    readFileSync(path.join(DIR, '..', '__fixtures__', 'opencode-1.19.4-stand.json'), 'utf-8'),
) as {
    cliVersion: string;
    events: StandEvent[];
    inventory: {
        models: Record<string, Record<string, { properties: string[]; required: string[] }>>;
    };
};
const event = (id: string): StandEvent => {
    const found = FX.events.find((e) => e.id === id);
    if (!found) throw new Error(`нет события стенда ${id}`);
    return found;
};
const LOOP = '/path/to/stand/work/loop';
const OUTSIDE = '/path/to/stand/outside';

/** Вход хука, который положил бы плагин барьера на событии стенда. */
const hookInput = (e: PluginEvent) => ({
    hook_event_name: 'PreToolUse',
    session_id: e.input.sessionID,
    cwd: e.ctx.directory,
    tool_name: 'ignored',
    tool_input: {},
    opencode: { ...e.input, args: e.output.args },
});
const stand = (id: string) => hookInput(event(id).pluginEvents[0]);
const ops = (raw: unknown, d: HarnessDescriptor = descriptor) =>
    normalizeOpencodeEvent(d, raw).operations;

const synthetic = (tool: string, args: unknown, extra: Record<string, unknown> = {}) => ({
    cwd: '/work',
    opencode: { tool, sessionID: 'ses_1', callID: 'call_1', args, ...extra },
});

describe('фикстура стенда', () => {
    it('версия описания совпадает со стендом; каждое событие дошло до плагина ровно раз', () => {
        expect(descriptor.cliVersion).toBe(FX.cliVersion);
        for (const e of FX.events) {
            expect(e.pluginEvents, e.id).toHaveLength(1);
            const [p] = e.pluginEvents;
            expect(p.input.tool, e.id).toBe(e.call.name);
            expect(p.output.args, e.id).toEqual(e.call.arguments);
            expect(p.ctx.directory, e.id).toBe(LOOP);
        }
    });

    it('запрещённое (маркер стенда) отменено плагином, разрешённое дошло до исполнения', () => {
        for (const e of FX.events) {
            const forbidden = JSON.stringify(e.call).includes('ralph-stand-forbidden');
            if (forbidden) expect(e.toolError, e.id).toBe('blocked by stand plugin');
            else expect(e.toolError, e.id).not.toBe('blocked by stand plugin');
        }
    });

    it('конверт каждого события — в перечне описания', () => {
        for (const e of FX.events) {
            for (const k of Object.keys(stand(e.id).opencode)) {
                expect(descriptor.allowedFields.envelope, `${e.id}: ${k}`).toContain(k);
            }
        }
    });

    it('перечень инструментов CLI у обеих моделей покрыт описанием: инструмент и каждое поле', () => {
        for (const tools of Object.values(FX.inventory.models)) {
            for (const [name, schema] of Object.entries(tools)) {
                expect(Object.keys(descriptor.toolMap), name).toContain(name);
                for (const field of schema.properties) {
                    expect(descriptor.allowedFields.tools[name], `${name}.${field}`).toContain(
                        field,
                    );
                }
            }
        }
    });

    it('GPT-модель правит файлы только apply_patch, прочая — write и edit', () => {
        const gpt = Object.keys(FX.inventory.models['gpt-5-mock']);
        const plain = Object.keys(FX.inventory.models.mock);
        expect(gpt).toContain('apply_patch');
        expect(gpt).not.toContain('write');
        expect(gpt).not.toContain('edit');
        expect(plain).toEqual(expect.arrayContaining(['write', 'edit']));
        expect(plain).not.toContain('apply_patch');
    });
});

describe('нормализация событий стенда', () => {
    it('apply_patch: путь из текста патча, от каталога сессии', () => {
        expect(ops(stand('apply-patch-forbidden'))).toEqual([
            { op: 'write', path: 'ralph-stand-forbidden.txt', baseDir: LOOP },
        ]);
        expect(ops(stand('apply-patch-allowed'))).toEqual([
            { op: 'write', path: 'allowed.txt', baseDir: LOOP },
        ]);
    });

    it('apply_patch с Move to: перенос по обоим путям, как его исполнил CLI', () => {
        expect(event('apply-patch-move').tree).toMatch(/moved\.txt/);
        expect(ops(stand('apply-patch-move'))).toEqual([
            { op: 'move', path: 'allowed.txt', destination: 'moved.txt', baseDir: LOOP },
        ]);
    });

    it('write и edit: путь — поле filePath', () => {
        expect(ops(stand('write-forbidden'))).toEqual([
            { op: 'write', path: 'ralph-stand-forbidden.txt', baseDir: LOOP },
        ]);
        expect(ops(stand('edit-allowed'))).toEqual([
            { op: 'write', path: 'allowed.txt', baseDir: LOOP },
        ]);
        expect(ops(stand('read'))).toEqual([{ op: 'read', path: 'allowed.txt', baseDir: LOOP }]);
    });

    it('bash: workdir — база команды; вне дерева CLI её исполнил там же', () => {
        expect(event('bash-workdir-allowed').tree).toMatch(/outside\/made-here/);
        expect(ops(stand('bash-workdir'))).toEqual([
            {
                op: 'exec',
                command: 'touch made-here; echo ralph-stand-forbidden',
                baseDir: OUTSIDE,
            },
        ]);
        // Относительный workdir — от каталога сессии: файл лёг в `sub` дерева.
        expect(event('bash-workdir-relative').tree).toMatch(/loop\/sub\/made-here/);
        expect(ops(stand('bash-workdir-relative'))).toEqual([
            { op: 'exec', command: 'touch made-here', baseDir: `${LOOP}/sub` },
        ]);
    });

    it('grep: include — шаблон путей; glob: pattern — шаблон без поиска содержимого', () => {
        expect(ops(stand('grep-include'))).toEqual([
            {
                op: 'search',
                root: LOOP,
                contentPattern: 'needle',
                pathGlob: '*.txt',
                baseDir: LOOP,
            },
        ]);
        expect(ops(stand('glob'))).toEqual([
            { op: 'search', root: LOOP, pathGlob: '**/*.txt', baseDir: LOOP },
        ]);
    });

    it('task — субагент сессии; skill — доставка инструкций, не доказательство', () => {
        const task = stand('task');
        expect(ops(task)).toEqual([{ op: 'agent', parentSession: task.session_id }]);
        expect(ops(stand('skill'))).toEqual([{ op: 'inert', what: 'skill(probe)' }]);
    });

    it('webfetch — fetch по url', () => {
        expect(ops(stand('webfetch'))).toEqual([
            { op: 'fetch', url: 'http://127.0.0.1:9/ralph-stand-forbidden' },
        ]);
    });

    it('MCP-имя <сервер>_<инструмент> без перевода — незнакомый инструмент, а не догадка', () => {
        expect(event('mcp').pluginEvents[0].input.tool).toBe('stand_stand_write');
        expect(ops(stand('mcp'))).toEqual([
            { op: 'unknown', why: expect.stringMatching(/mcpNames/), kind: 'tool' },
        ]);
        const translated: HarnessDescriptor = {
            ...descriptor,
            mcpNames: { stand_stand_write: { server: 'stand', tool: 'stand_write' } },
        };
        expect(ops(stand('mcp'), translated)).toEqual([
            { op: 'mcp', server: 'stand', tool: 'stand_write', effect: 'unknown', derived: [] },
        ]);
    });
});

describe('отказы разбора — unknown с причиной', () => {
    it.each([
        ['вход не объект', [], /не объект/],
        ['поле входа вне протокола плагина', { ...synthetic('read', {}), extra: 1 }, /extra/],
        ['нет cwd', { opencode: synthetic('read', {}).opencode }, /cwd/],
        ['относительный cwd', { ...synthetic('read', {}), cwd: 'work' }, /cwd/],
        ['нет сырого события', { cwd: '/work' }, /поле opencode/],
        ['поле конверта вне описания', synthetic('read', {}, { agent: 'build' }), /agent/],
        ['нет tool', synthetic('', {}), /нет tool/],
        ['args не объект', synthetic('read', 'x'), /args не объект/],
        ['поле входа вне описания', synthetic('read', { filePath: 'a', raw: 1 }), /raw/],
        ['путь не строкой', synthetic('read', { filePath: 1 }), /filePath не строка/],
        ['нет пути', synthetic('write', { content: 'x' }), /нет строкового filePath/],
        ['workdir не строкой', synthetic('bash', { command: 'ls', workdir: 1 }), /workdir/],
        ['пустой патч', synthetic('apply_patch', { patchText: '' }), /patchText/],
        [
            'патч без файлов',
            synthetic('apply_patch', { patchText: '*** Begin Patch\n*** End Patch' }),
            /ни одного файла|патч/,
        ],
        [
            'путь патча, который CLI читают по-разному',
            synthetic('apply_patch', {
                patchText: '*** Begin Patch\n*** Update File:\t.env\n@@\n-a\n+b\n*** End Patch',
            }),
            /патч/,
        ],
        ['skill без name', synthetic('skill', {}), /skill: нет строкового name/],
        ['url не строкой', synthetic('webfetch', { url: 1 }), /url не строка/],
    ])('%s', (_what, raw, why) => {
        const [op, ...rest] = ops(raw);
        expect(rest).toEqual([]);
        expect(op).toMatchObject({ op: 'unknown', kind: 'field' });
        expect(op.op === 'unknown' && op.why).toMatch(why);
    });

    it('встроенный вне описания (multiedit) и batch — незнакомый инструмент', () => {
        for (const tool of ['multiedit', 'batch', 'toString']) {
            expect(ops(synthetic(tool, {}))[0]).toMatchObject({ op: 'unknown', kind: 'tool' });
        }
    });

    it('операция описания без отображения у OpenCode — unknown, а не пропуск', () => {
        const d: HarnessDescriptor = {
            ...descriptor,
            toolMap: { ...descriptor.toolMap, read: 'defer' },
        };
        expect(ops(synthetic('read', {}), d)[0]).toMatchObject({ op: 'unknown' });
    });

    it('сессия без sessionID — субагент всё равно назван, а не пропущен', () => {
        const raw = synthetic('task', { description: 'd', prompt: 'p', subagent_type: 'general' });
        delete (raw.opencode as Record<string, unknown>).sessionID;
        expect(ops(raw)).toEqual([{ op: 'agent', parentSession: 'unknown' }]);
    });

    it('перечень полей плагина — ровно то, что плагин кладёт хуку', () => {
        expect(OPENCODE_HOOK_FIELDS).toEqual([
            'hook_event_name',
            'session_id',
            'cwd',
            'tool_name',
            'tool_input',
            'opencode',
        ]);
    });
});

// Ветки разбора, которых нет на стенде: общий разбор ролей (`../event-roles.ts`) после выноса
// обязан держать их у каждого пакета.
describe('разбор вне стенда', () => {
    it('inert вне skill — по имени; args не заданы — пустой вход', () => {
        expect(ops(synthetic('todowrite', undefined))).toEqual([
            { op: 'inert', what: 'todowrite' },
        ]);
    });

    it('пустой workdir — база оболочки остаётся cwd события', () => {
        expect(ops(synthetic('bash', { command: 'ls', workdir: '' }))).toEqual([
            { op: 'exec', command: 'ls', baseDir: '/work' },
        ]);
    });

    it('патч без единого файла — отказ общего разбора', () => {
        expect(
            ops(synthetic('apply_patch', { patchText: '*** Begin Patch\n*** End Patch' })),
        ).toEqual([{ op: 'unknown', why: 'патч: ни одного файла', kind: 'field' }]);
    });

    it('инструмент без перечня полей — любое поле незнакомо', () => {
        const bare = { ...descriptor, allowedFields: { ...descriptor.allowedFields, tools: {} } };
        expect(ops(synthetic('todowrite', {}), bare)).toEqual([{ op: 'inert', what: 'todowrite' }]);
        expect(ops(synthetic('todowrite', { todos: [] }), bare)[0]).toMatchObject({
            op: 'unknown',
        });
    });
});

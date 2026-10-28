// Нормализатор Kimi Code (#191) на сырых событиях стенда 2.3.2 и на отказах разбора. Фикстура
// стенда держит и выводы о CLI: каждое событие дошло до хука, запрещённое заблокировано, а
// перечень инструментов описания покрывает то, что CLI отдал модели.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHarnessDescriptor, type HarnessDescriptor } from '../descriptor.ts';
import { KIMI_MCP_NAME_MAX, kimiMcpToolName, normalizeKimiEvent } from './event.ts';

const DIR = import.meta.dirname;
const descriptor = parseHarnessDescriptor(
    JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
    'kimi-code',
);
type StandEvent = {
    id: string;
    call: { name: string; arguments: Record<string, unknown> };
    hookStdin: string[];
    toolResult: string | null;
    tree: string;
    advertised?: string[];
};
const FX = JSON.parse(
    readFileSync(path.join(DIR, '..', '__fixtures__', 'kimi-code-2.3.2-stand.json'), 'utf-8'),
) as {
    cliVersion: string;
    events: StandEvent[];
    inventory: { tools: Record<string, { properties: string[]; required: string[] }> };
};
const event = (id: string): StandEvent => FX.events.find((e) => e.id === id) as StandEvent;
const stand = (id: string) => JSON.parse(event(id).hookStdin[0]);
const ops = (raw: unknown, d: HarnessDescriptor = descriptor) =>
    normalizeKimiEvent(d, raw).operations;
const LOOP = '/path/to/stand/work/loop';

const envelope = (tool_name: string, tool_input: unknown) => ({
    hook_event_name: 'PreToolUse',
    session_id: 'session_1',
    cwd: '/work',
    client_type: 'kimi_code_cli',
    tool_name,
    tool_input,
    tool_call_id: 'call_1',
});

describe('фикстура стенда', () => {
    it('версия описания совпадает со стендом; каждое событие дошло до хука ровно раз', () => {
        expect(descriptor.cliVersion).toBe(FX.cliVersion);
        for (const e of FX.events) {
            expect(e.hookStdin, e.id).toHaveLength(1);
            expect(stand(e.id).tool_name, e.id).toBe(e.call.name);
            expect(stand(e.id).tool_input, e.id).toEqual(e.call.arguments);
        }
    });

    it('запрещённое (маркер стенда) заблокировано хуком, разрешённое исполнено', () => {
        for (const e of FX.events) {
            const forbidden = JSON.stringify(e.call).includes('ralph-stand-forbidden');
            if (forbidden) expect(e.toolResult, e.id).toBe('blocked by stand hook');
            else expect(e.toolResult, e.id).not.toBe('blocked by stand hook');
        }
    });

    it('конверт каждого события — в перечне описания', () => {
        for (const e of FX.events) {
            for (const k of Object.keys(stand(e.id))) {
                expect(descriptor.allowedFields.envelope, `${e.id}: ${k}`).toContain(k);
            }
        }
    });

    it('перечень инструментов CLI покрыт описанием: каждый инструмент и каждое его поле', () => {
        for (const [name, schema] of Object.entries(FX.inventory.tools)) {
            if (name.startsWith('mcp__')) continue;
            expect(Object.keys(descriptor.toolMap), name).toContain(name);
            for (const field of schema.properties) {
                expect(descriptor.allowedFields.tools[name], `${name}.${field}`).toContain(field);
            }
        }
    });
});

describe('сырые события стенда', () => {
    it.each([
        ['write-forbidden', 'ralph-stand-forbidden.txt'],
        ['write-allowed', 'allowed.txt'],
        ['write-append', 'allowed.txt'],
        ['write-append-forbidden', 'ralph-stand-forbidden.txt'],
        ['edit-forbidden', 'ralph-stand-forbidden.txt'],
        ['edit-allowed', 'allowed.txt'],
    ])('%s: путь — поле path, запись от cwd сессии', (id, file) => {
        expect(ops(stand(id))).toEqual([{ op: 'write', path: file, baseDir: LOOP }]);
    });

    it('read: путь — поле path', () => {
        expect(ops(stand('read'))).toEqual([{ op: 'read', path: 'allowed.txt', baseDir: LOOP }]);
    });

    it.each(['bash-cwd', 'bash-cwd-allowed'])(
        '%s: оболочка судится от своего cwd вне дерева, а не от cwd сессии',
        (id) => {
            const raw = stand(id);
            expect(raw.tool_input.cwd).toBe('/path/to/stand/outside');
            expect(ops(raw)).toEqual([
                { op: 'exec', command: raw.tool_input.command, baseDir: '/path/to/stand/outside' },
            ]);
        },
    );

    it('bash-cwd-allowed: стенд подтверждает, что эффект лёг в cwd вызова', () => {
        expect(event('bash-cwd-allowed').tree).toMatch(/== \/path\/to\/stand\/outside\/made-here/);
        expect(event('bash-cwd').tree).not.toMatch(/made-here/);
    });

    it('bash-cwd-relative: относительный cwd — от cwd сессии', () => {
        expect(ops(stand('bash-cwd-relative'))).toEqual([
            { op: 'exec', command: 'touch made-here', baseDir: `${LOOP}/sub` },
        ]);
    });

    it('grep-glob: шаблон содержимого и фильтр путей glob, корень — cwd сессии', () => {
        expect(ops(stand('grep-glob'))).toEqual([
            {
                op: 'search',
                root: LOOP,
                contentPattern: 'needle',
                pathGlob: '*.txt',
                baseDir: LOOP,
            },
        ]);
    });

    it('glob: шаблон — фильтр путей без содержимого', () => {
        expect(ops(stand('glob'))).toEqual([
            { op: 'search', root: LOOP, pathGlob: '**/*.txt', baseDir: LOOP },
        ]);
    });

    it('fetch и agent — свои операции: судит их guard, а не нормализатор', () => {
        expect(ops(stand('fetch'))).toEqual([
            { op: 'fetch', url: 'http://127.0.0.1:9/ralph-stand-forbidden' },
        ]);
        const raw = stand('agent');
        expect(ops(raw)).toEqual([{ op: 'agent', parentSession: raw.session_id }]);
    });

    it('mcp: только нормализуется — эффект задаёт политика контура', () => {
        expect(ops(stand('mcp'))).toEqual([
            { op: 'mcp', server: 'stand', tool: 'stand_write', effect: 'unknown', derived: [] },
        ]);
    });
});

describe('MCP-имена с хешем', () => {
    const long = event('mcp-long');
    const server = 'stand-server-with-a-rather-long-name-for-the-hash';

    it('kimiMcpToolName повторяет имена, которые CLI отдал модели на стенде', () => {
        expect(long.advertised).toEqual(
            [kimiMcpToolName(server, 'stand_read'), kimiMcpToolName(server, 'stand_write')].sort(),
        );
        expect(kimiMcpToolName(server, 'stand_write')).toBe(long.call.name);
        expect(long.call.name).toHaveLength(KIMI_MCP_NAME_MAX);
        // Части санируются, серии `_` схлопываются; короткое имя не обрезается.
        expect(kimiMcpToolName('my.srv', 'a__b')).toBe('mcp__my_srv__a_b');
    });

    it('обрезанное имя без перевода — отказ разбора с причиной, а не догадка о сервере', () => {
        expect(ops(stand('mcp-long'))).toEqual([
            {
                op: 'unknown',
                kind: 'field',
                why: expect.stringMatching(/обрезать его с хешем, а перевода в mcpNames нет/),
            },
        ]);
    });

    it('с переводом в mcpNames — сервер и инструмент из перевода', () => {
        const d = {
            ...descriptor,
            mcpNames: { [long.call.name]: { server, tool: 'stand_write' } },
        };
        expect(ops(stand('mcp-long'), d)).toEqual([
            { op: 'mcp', server, tool: 'stand_write', effect: 'unknown', derived: [] },
        ]);
    });

    it('обрезка оставила `__` внутри инструмента — тоже отказ, а не обрубок инструмента', () => {
        const name = kimiMcpToolName('srv', 'x'.repeat(80));
        expect(name).toMatch(/^mcp__srv__x+_/);
        expect(ops(envelope(name, {}))[0]).toMatchObject({ op: 'unknown' });
    });
});

describe('отказы разбора', () => {
    it.each([
        ['незнакомый инструмент', envelope('ReadMediaFile', { path: 'a.png' }), 'tool'],
        ['незнакомое поле входа', envelope('Write', { path: 'a', content: '', x: 1 }), 'field'],
        ['path не строка', envelope('Write', { path: 1, content: '' }), 'field'],
        ['cwd оболочки не строка', envelope('Bash', { command: 'ls', cwd: 1 }), 'field'],
        ['нет команды', envelope('Bash', {}), 'field'],
        ['Skill без имени', envelope('Skill', {}), 'field'],
        ['незнакомое поле конверта', { ...envelope('Bash', { command: 'ls' }), x: 1 }, 'field'],
    ])('%s — unknown', (_what, raw, kind) => {
        expect(ops(raw)).toEqual([{ op: 'unknown', why: expect.any(String), kind }]);
    });

    it('конверт без cwd, с относительным cwd и не объект — unknown', () => {
        const { cwd: _cwd, ...noCwd } = envelope('Bash', { command: 'ls' });
        const why = 'нет абсолютного cwd: каталог сессии CLI не назвал';
        expect(ops(noCwd)[0]).toMatchObject({ op: 'unknown', why });
        // Относительный cwd разрешался бы от каталога процесса нормализатора, а не сессии.
        expect(ops({ ...envelope('Write', { path: 'a', content: '' }), cwd: 'work' })).toEqual([
            { op: 'unknown', why, kind: 'field' },
        ]);
        expect(ops([])[0]).toMatchObject({ op: 'unknown', why: 'вход хука не объект' });
    });

    it('session_title конверта — знакомое поле; пустой cwd оболочки — cwd сессии', () => {
        expect(
            ops({ ...envelope('Bash', { command: 'ls', cwd: '' }), session_title: 't' }),
        ).toEqual([{ op: 'exec', command: 'ls', baseDir: '/work' }]);
    });

    it('Skill, CronCreate, WebSearch — inert, defer и fetch', () => {
        expect(ops(envelope('Skill', { skill: 'vitest' }))).toEqual([
            { op: 'inert', what: 'Skill(vitest)' },
        ]);
        expect(ops(envelope('CronCreate', { cron: '* * * * *', prompt: 'p' }))).toEqual([
            { op: 'defer', what: 'CronCreate' },
        ]);
        expect(ops(envelope('WebSearch', { query: 'q' }))).toEqual([{ op: 'fetch', url: 'q' }]);
    });
});

// Ветки разбора, которых нет на стенде: общий разбор ролей (`../event-roles.ts`) после выноса
// обязан держать их у каждого пакета.
describe('разбор вне стенда', () => {
    it('MCP-имя без сервера и инструмента — unknown, а не догадка', () => {
        expect(ops(envelope('mcp__only', {}))).toEqual([
            {
                op: 'unknown',
                why: expect.stringMatching(/без сервера и инструмента/),
                kind: 'field',
            },
        ]);
    });

    it('inert вне Skill — по имени; tool_input не задан — пустой вход', () => {
        expect(ops(envelope('TodoList', undefined))).toEqual([{ op: 'inert', what: 'TodoList' }]);
    });

    it('нет tool_name и tool_input не объект — unknown', () => {
        expect(ops(envelope('', {}))[0]).toMatchObject({ op: 'unknown', why: 'нет tool_name' });
        expect(ops(envelope('Bash', ['ls']))[0]).toMatchObject({
            op: 'unknown',
            why: 'Bash: tool_input не объект',
        });
    });

    it('операция без отображения и инструмент без перечня полей — отказ, а не пропуск', () => {
        const patched = {
            ...descriptor,
            toolMap: { ...descriptor.toolMap, Bash: 'patch' as const },
        };
        expect(ops(envelope('Bash', { command: 'ls' }), patched)).toEqual([
            {
                op: 'unknown',
                why: 'Bash: операция patch без отображения у Kimi Code',
            },
        ]);
        const bare = { ...descriptor, allowedFields: { ...descriptor.allowedFields, tools: {} } };
        expect(ops(envelope('TodoList', {}), bare)).toEqual([{ op: 'inert', what: 'TodoList' }]);
        expect(ops(envelope('TodoList', { todos: [] }), bare)[0]).toMatchObject({ op: 'unknown' });
    });
});

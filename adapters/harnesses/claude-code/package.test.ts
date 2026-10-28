// Пакет Claude Code (#180): регистрация барьера из settings, нормализатор по описанию и его
// команда — по протоколу границы «хук → адаптер».
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownDescriptor, parseHarnessDescriptor } from '../descriptor.ts';
import { probeMatrix } from '../probe-matrix.ts';
import { ADAPTER_PROTOCOL_VERSION } from '../protocol.ts';
import { normalizeClaudeEvent } from './event.ts';
import { main } from './normalize.ts';
import { harnessPackage, settingsHooks } from './package.ts';

const DIR = import.meta.dirname;
const descriptor = parseHarnessDescriptor(
    JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
    'claude-code',
);

const envelope = (tool_name: string, tool_input: unknown) => ({
    session_id: 's1',
    transcript_path: '/t.jsonl',
    cwd: '/work',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
});

describe('регистрация барьера Claude Code', () => {
    it('хуки PreToolUse с matcher записи, таймаутом и признаком «не блокирует»', () => {
        const hooks = settingsHooks({
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash',
                        hooks: [
                            { type: 'command', command: 'a', timeout: 5 },
                            { type: 'command', command: 'b', async: true },
                            { type: 'command', command: 'c', once: true },
                            { type: 'command', command: 'd', if: 'x' },
                            { type: 'prompt', command: 'e' },
                            { type: 'command', command: '  ' },
                            'битая',
                        ],
                    },
                    { matcher: 'Read' },
                    'битая запись',
                ],
            },
        });
        expect(hooks).toEqual([
            { matcher: 'Bash', command: 'a', timeoutSec: 5, cannotBlock: null },
            {
                matcher: 'Bash',
                command: 'b',
                timeoutSec: 60,
                cannotBlock: 'async: асинхронный хук не блокирует вызов',
            },
            {
                matcher: 'Bash',
                command: 'c',
                timeoutSec: 60,
                cannotBlock: 'once: срабатывает один раз за сессию',
            },
            {
                matcher: 'Bash',
                command: 'd',
                timeoutSec: 60,
                cannotBlock: 'if: хук зовут не на каждый вызов',
            },
        ]);
    });

    it.each([null, [], { hooks: [] }, { hooks: { PreToolUse: {} } }])(
        'настройки без списка PreToolUse — хуков нет (%j)',
        (settings) => {
            expect(settingsHooks(settings)).toEqual([]);
        },
    );

    it('disableAllHooks — регистрация непригодна целиком', () => {
        const r = harnessPackage.guardRegistration({ disableAllHooks: true });
        expect(r.problems).toEqual([
            'disableAllHooks: true — Claude Code не запустит ни одного хука в сессии',
        ]);
    });

    it('семантика matcher и форма входа — Claude Code', () => {
        expect(harnessPackage.matcherCovers('Bash|Read', 'Read')).toBe(true);
        expect(harnessPackage.matcherCovers('Read', 'ReadFile')).toBe(false);
        const payload = JSON.parse(harnessPackage.hookPayload(harnessPackage.probes[0], '/w'));
        expect(payload).toMatchObject({ cwd: '/w', hook_event_name: 'PreToolUse' });
        expect(harnessPackage.setsProjectDirEnv).toBe(true);
        expect(harnessPackage.skillBarrier).toBe(true);
    });
});

describe('нормализатор: тождественная форма Claude Code', () => {
    const op = (tool: string, input: unknown) =>
        normalizeClaudeEvent(descriptor, envelope(tool, input)).operations;

    it.each([
        [
            'Bash',
            { command: 'git status' },
            { op: 'exec', command: 'git status', baseDir: '/work' },
        ],
        ['Read', { file_path: '.env' }, { op: 'read', path: '.env', baseDir: '/work' }],
        [
            'Edit',
            { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
            { op: 'write', path: 'a.ts', baseDir: '/work' },
        ],
        [
            'NotebookEdit',
            { notebook_path: 'n.ipynb', new_source: '' },
            { op: 'write', path: 'n.ipynb', baseDir: '/work' },
        ],
        [
            'Grep',
            { pattern: 'x', path: 'src', glob: '*.ts' },
            { op: 'search', root: 'src', contentPattern: 'x', pathGlob: '*.ts', baseDir: '/work' },
        ],
        [
            'Glob',
            { pattern: '**/*.ts' },
            { op: 'search', root: '/work', pathGlob: '**/*.ts', baseDir: '/work' },
        ],
        [
            'WebFetch',
            { url: 'https://example.com', prompt: 'p' },
            { op: 'fetch', url: 'https://example.com' },
        ],
        ['Task', { prompt: 'p' }, { op: 'agent', parentSession: 's1' }],
        ['Skill', { skill: 'vitest' }, { op: 'inert', what: 'Skill(vitest)' }],
        [
            'Monitor',
            { command: 'tail -f log', description: 'd', timeout_ms: 1000 },
            { op: 'exec', command: 'tail -f log', baseDir: '/work' },
        ],
        ['Agent', { prompt: 'p', description: 'd' }, { op: 'agent', parentSession: 's1' }],
        // Запрос поиска уходит наружу тем же каналом, что адрес: не `inert` (ревью 16c).
        ['WebSearch', { query: 'q', mode: 'standard' }, { op: 'fetch', url: 'q' }],
        [
            'mcp__sourcecraft__ListIssues',
            {},
            {
                op: 'mcp',
                server: 'sourcecraft',
                tool: 'ListIssues',
                effect: 'unknown',
                derived: [],
            },
        ],
    ])('%s → операция по описанию', (tool, input, expected) => {
        expect(op(tool, input)).toEqual([expected]);
    });

    it.each([
        [
            'инструмент вне описания',
            envelope('SendMessage', { to: 'main', message: 'm' }),
            /SendMessage вне описания/,
        ],
        ['Skill без имени', envelope('Skill', {}), /Skill: нет строкового skill/],
        [
            'Monitor без command (ws не судится)',
            envelope('Monitor', { description: 'd', timeout_ms: 1, ws: { url: 'wss://x' } }),
            /незнакомое поле входа: ws/,
        ],
        [
            'незнакомое поле входа',
            envelope('Read', { file_path: 'a', path: '.env' }),
            /незнакомое поле входа: path/,
        ],
        [
            'обязательный аргумент не строкой',
            envelope('Bash', { command: 1 }),
            /поле command не строка/,
        ],
        [
            'обязательный аргумент пустой',
            envelope('Bash', { command: '' }),
            /нет строкового command/,
        ],
        // Необязательный тоже: корень поиска молча становился cwd (ревью 16c).
        [
            'необязательный аргумент не строкой',
            envelope('Grep', { pattern: 'x', path: 123 }),
            /Grep: поле path не строка/,
        ],
        [
            'MCP-имя с неоднозначной границей сервера',
            envelope('mcp__sync__get__CreateReport', {}),
            /граница сервера неоднозначна/,
        ],
        ['MCP-имя без инструмента', envelope('mcp__sync', {}), /без сервера и инструмента/],
        [
            'незнакомое поле конверта',
            { ...envelope('Read', { file_path: 'a' }), extra: 1 },
            /конверта: extra/,
        ],
        ['нет tool_name', { ...envelope('Read', {}), tool_name: '' }, /нет tool_name/],
        ['нет cwd', { ...envelope('Read', {}), cwd: undefined }, /нет cwd/],
        ['tool_input не объект', envelope('Read', 'x'), /tool_input не объект/],
        ['вход не объект', 'x', /не объект/],
    ])('%s — unknown с причиной', (_what, raw, why) => {
        const [first] = normalizeClaudeEvent(descriptor, raw).operations;
        expect(first.op).toBe('unknown');
        expect(first.op === 'unknown' && first.why).toMatch(why);
        // Код причины у guard выбирает `kind`: инструмент — только вне описания.
        const kind = /вне описания/.test(String(why)) ? 'tool' : 'field';
        expect(first.op === 'unknown' && first.kind).toBe(kind);
    });

    it('tool_input не задан — пустой вход; инструмент без перечня полей — любое поле незнакомо', () => {
        expect(op('TodoWrite', undefined)).toEqual([{ op: 'inert', what: 'TodoWrite' }]);
        const bare = { ...descriptor, allowedFields: { ...descriptor.allowedFields, tools: {} } };
        const ops = (input: unknown) =>
            normalizeClaudeEvent(bare, envelope('TodoWrite', input)).operations;
        expect(ops({})).toEqual([{ op: 'inert', what: 'TodoWrite' }]);
        expect(ops({ todos: [] })[0]).toMatchObject({ op: 'unknown', kind: 'field' });
    });

    it('пустые необязательные поля поиска — не заданы, пустой шаблон содержимого — задан', () => {
        expect(op('Grep', { pattern: '', path: '', glob: '' })).toEqual([
            { op: 'search', root: '/work', contentPattern: '', baseDir: '/work' },
        ]);
    });

    // Ревью 16c: разрешённая `rule:Skill:allowed` с пустым входом разбиралась в `unknown`, и
    // живая проба по боевому описанию давала код 2 и `failed` на исправном барьере.
    it('разрешённые пробы матрицы по боевому описанию разбираются, а не в unknown', () => {
        const positives = probeMatrix(descriptor).probes.filter(
            (p) => p.kind === 'rule' && p.polarity === 'positive' && p.tool,
        );
        expect(positives.length).toBeGreaterThan(10);
        for (const p of positives) {
            const [first] = op(p.tool as string, p.input ?? {});
            expect([p.id, first.op]).not.toEqual([p.id, 'unknown']);
        }
    });

    it('Workflow со scriptPath — агент и чтение файла скрипта', () => {
        expect(op('Workflow', { script: 's' })).toEqual([{ op: 'agent', parentSession: 's1' }]);
        expect(op('Workflow', { scriptPath: 'flow.mjs' })).toEqual([
            { op: 'agent', parentSession: 's1' },
            { op: 'read', path: 'flow.mjs', baseDir: '/work' },
        ]);
    });

    it('граница MCP-сервера — по mcp_server конверта, без него — единственный разделитель', () => {
        const mcp = (name: string, server: unknown) =>
            normalizeClaudeEvent(descriptor, { ...envelope(name, {}), mcp_server: server })
                .operations[0];
        expect(mcp('mcp__sync__get__CreateReport', { name: 'sync__get' })).toMatchObject({
            server: 'sync__get',
            tool: 'CreateReport',
        });
        expect(mcp('mcp__sync__get__CreateReport', 'sync')).toMatchObject({
            server: 'sync',
            tool: 'get__CreateReport',
        });
        expect(mcp('mcp__a__b', { name: 'чужой' })).toMatchObject({ server: 'a', tool: 'b' });
        expect(mcp('mcp__a__b__c', { name: 'чужой' })).toMatchObject({ op: 'unknown' });
    });

    it('операция mcp в toolMap без отображения — unknown, а не догадка о сервере', () => {
        const d = { ...descriptor, toolMap: { ...descriptor.toolMap, Fs: 'mcp' as const } };
        d.allowedFields = { ...d.allowedFields, tools: { ...d.allowedFields.tools, Fs: [] } };
        expect(normalizeClaudeEvent(d, envelope('Fs', {})).operations[0].op).toBe('unknown');
    });

    it('перенос по описанию — путь и назначение обязательны оба', () => {
        const d = { ...descriptor, toolMap: { ...descriptor.toolMap, Mv: 'move' as const } };
        d.argMap = { ...d.argMap, Mv: { path: 'from', destination: 'to' } };
        d.allowedFields = {
            ...d.allowedFields,
            tools: { ...d.allowedFields.tools, Mv: ['from', 'to'] },
        };
        expect(normalizeClaudeEvent(d, envelope('Mv', { from: 'a', to: 'b' })).operations).toEqual([
            { op: 'move', path: 'a', destination: 'b', baseDir: '/work' },
        ]);
        expect(normalizeClaudeEvent(d, envelope('Mv', { from: 'a' })).operations[0].op).toBe(
            'unknown',
        );
    });

    it('сессия без session_id — агент всё равно с родителем', () => {
        const raw = { ...envelope('Task', {}), session_id: undefined };
        expect(normalizeClaudeEvent(descriptor, raw).operations).toEqual([
            { op: 'agent', parentSession: 'unknown' },
        ]);
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

    it('ответ по протоколу на вход хука', async () => {
        const r = await run(JSON.stringify(envelope('Read', { file_path: '.env' })));
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out)).toEqual({
            protocol: ADAPTER_PROTOCOL_VERSION,
            event: { operations: [{ op: 'read', path: '.env', baseDir: '/work' }] },
        });
    });

    it('описание чужого харнесса рядом с командой — отказ, а не суд его таблицами', () => {
        const raw = JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8'));
        expect(ownDescriptor(raw, 'd', 'claude-code').harness).toBe('claude-code');
        expect(() => ownDescriptor({ ...raw, harness: 'codex' }, 'd', 'claude-code')).toThrow(
            /описание харнесса «codex», а команда — нормализатор claude-code/,
        );
    });

    it('вход не JSON — код 1 с причиной', async () => {
        const r = await run('{');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/вход хука не JSON/);
    });

    it('описание пакета называет именно эту команду, и она исполняется процессом', () => {
        expect(descriptor.normalizer).toBe('normalize.ts');
        const r = spawnSync('node', [path.join(DIR, descriptor.normalizer)], {
            input: JSON.stringify(envelope('Bash', { command: 'git status' })),
            encoding: 'utf-8',
            timeout: 30_000,
        });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).event.operations[0]).toEqual({
            op: 'exec',
            command: 'git status',
            baseDir: '/work',
        });
    });
});

describe('полный перечень полей по живым фикстурам петли (#186)', () => {
    const loop = JSON.parse(
        readFileSync(path.join(DIR, '..', '__fixtures__', 'claude-code-loop.json'), 'utf-8'),
    ) as {
        assembled: boolean;
        envelope: Record<string, unknown>;
        calls: { tool_name: string; tool_input: Record<string, unknown> }[];
    };
    const live = JSON.parse(
        readFileSync(path.join(DIR, '..', '..', '__fixtures__', 'hook-events.json'), 'utf-8'),
    ) as Record<string, { event: Record<string, unknown> }>;
    const ops = (raw: unknown) => normalizeClaudeEvent(descriptor, raw).operations;

    it('фикстура помечена собранной и покрывает инструменты петли', () => {
        expect(loop.assembled).toBe(true);
        const tools = loop.calls.map((c) => c.tool_name);
        for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Skill', 'Monitor']) {
            expect(tools).toContain(t);
        }
    });

    it.each(loop.calls.map((c) => [c.tool_name, c] as const))(
        '%s: вызов петли разбирается, а не становится unknown',
        (_tool, call) => {
            const [first] = ops({ ...loop.envelope, ...call });
            expect(first.op).not.toBe('unknown');
        },
    );

    it('живое событие стенда (конверт 2.1.311) разбирается', () => {
        expect(ops(live['claude-code'].event)[0]).toEqual({
            op: 'exec',
            command: 'touch ralph-stand-forbidden',
            baseDir: '/path/to/loop',
        });
    });

    it('все поля конверта из схемы CLI разом — разбираются', () => {
        const full = Object.fromEntries(
            descriptor.allowedFields.envelope.map((k) => [k, k === 'cwd' ? '/work' : 'x']),
        );
        expect(ops({ ...full, tool_name: 'Bash', tool_input: { command: 'ls' } })[0].op).toBe(
            'exec',
        );
    });

    it.each(Object.keys(descriptor.toolMap))(
        '%s: все документированные поля разом проходят, лишнее — unknown-field',
        (tool) => {
            const input = Object.fromEntries(
                descriptor.allowedFields.tools[tool].map((k) => [k, `v-${k}`]),
            );
            const [first] = ops(envelope(tool, input));
            expect(first.op).not.toBe('unknown');
            const [stray] = ops(envelope(tool, { ...input, ralph_stray_field: 'x' }));
            expect(stray).toMatchObject({ op: 'unknown', kind: 'field' });
        },
    );

    it('у MCP-вызова поле конверта mcp_server — знакомое', () => {
        const raw = {
            ...envelope('mcp__sourcecraft__GetIssue', {}),
            mcp_server: { name: 'sourcecraft' },
        };
        expect(ops(raw)[0].op).toBe('mcp');
    });
});

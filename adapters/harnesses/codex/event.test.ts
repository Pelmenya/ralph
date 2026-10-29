// Нормализатор Codex (#189) на сырых событиях стенда 0.163.0 (#188) и на отказах разбора.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHarnessDescriptor } from '../descriptor.ts';
import { normalizeCodexEvent } from './event.ts';

const DIR = import.meta.dirname;
const descriptor = parseHarnessDescriptor(
    JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
    'codex',
);
const FX = JSON.parse(
    readFileSync(path.join(DIR, '..', '__fixtures__', 'codex-0.163.0-stand.json'), 'utf-8'),
);
const stand = (id: string): unknown[] =>
    FX.events.find((e: { id: string }) => e.id === id).hookStdin.map((s: string) => JSON.parse(s));
const ops = (raw: unknown) => normalizeCodexEvent(descriptor, raw).operations;
const LOOP = '/path/to/stand/work/loop';

const envelope = (tool_name: string, tool_input: unknown) => ({
    session_id: 's1',
    turn_id: 't1',
    transcript_path: '/t.jsonl',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.5',
    permission_mode: 'bypassPermissions',
    tool_name,
    tool_input,
    tool_use_id: 'call-1',
});

describe('сырые события стенда', () => {
    it.each(['cm-exec', 'cm-exec-allowed', 'dx-exec'])('%s: Bash — оболочка от cwd', (id) => {
        const [raw] = stand(id) as { tool_input: { command: string } }[];
        expect(ops(raw)).toEqual([{ op: 'exec', command: raw.tool_input.command, baseDir: LOOP }]);
    });

    it('cm-patch: Add, Update, Delete — три операции одного вызова', () => {
        expect(ops(stand('cm-patch')[0])).toEqual([
            { op: 'write', path: 'ralph-stand-forbidden.txt', baseDir: LOOP },
            { op: 'write', path: 'keep.txt', baseDir: LOOP },
            { op: 'delete', path: 'gone.txt', baseDir: LOOP },
        ]);
    });

    it('cm-patch-allowed: Add и Update с Move to', () => {
        expect(ops(stand('cm-patch-allowed')[0])).toEqual([
            { op: 'write', path: 'ralph-stand-allowed.txt', baseDir: LOOP },
            { op: 'move', path: 'keep.txt', destination: 'moved.txt', baseDir: LOOP },
        ]);
    });

    it.each([
        ['dx-patch', 'ralph-stand-forbidden.txt'],
        ['dx-patch-allowed', 'sub/ralph-stand-allowed.txt'],
    ])('%s: прямой apply_patch', (id, file) => {
        expect(ops(stand(id)[0])).toEqual([{ op: 'write', path: file, baseDir: LOOP }]);
    });

    it('cm-mcp: эффект задаёт политика контура, строки аргументов — производные чтения', () => {
        const key = { op: 'read', path: 'k', baseDir: LOOP };
        const value = { op: 'read', path: 'ralph-stand-forbidden', baseDir: LOOP };
        const mcp = { op: 'mcp', server: 'stand', effect: 'unknown' };
        expect(stand('cm-mcp').map((raw) => ops(raw))).toEqual([
            [{ ...mcp, tool: 'stand_read', derived: [key] }],
            [{ ...mcp, tool: 'stand_write', derived: [key, value] }],
        ]);
    });
});

describe('патч в оболочке', () => {
    it('apply_patch heredoc в Bash — оболочка и файлы патча', () => {
        const command =
            "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: .env\n+A=1\n*** End Patch\nEOF";
        expect(ops(envelope('Bash', { command }))).toEqual([
            { op: 'exec', command, baseDir: '/work' },
            { op: 'write', path: '.env', baseDir: '/work' },
        ]);
    });
});

describe('отказы разбора — unknown с причиной', () => {
    it.each([
        ['вход не объект', 'x', /не объект/, 'field'],
        [
            'незнакомое поле конверта',
            { ...envelope('Bash', { command: 'ls' }), mcp_server: 'x' },
            /конверта: mcp_server/,
            'field',
        ],
        ['нет tool_name', envelope('', {}), /нет tool_name/, 'field'],
        ['нет cwd', { ...envelope('Bash', { command: 'ls' }), cwd: '' }, /нет cwd/, 'field'],
        ['tool_input не объект', envelope('Bash', 'ls'), /tool_input не объект/, 'field'],
        [
            'инструмент вне описания',
            envelope('write_stdin', { chars: 'x' }),
            /write_stdin вне описания/,
            'tool',
        ],
        ['сам exec code mode', envelope('exec', { input: 'x' }), /exec вне описания/, 'tool'],
        [
            'поле workdir',
            envelope('Bash', { command: 'ls', workdir: 'sub' }),
            /незнакомое поле входа: workdir/,
            'field',
        ],
        ['command не строкой', envelope('Bash', { command: 1 }), /command не строка/, 'field'],
        [
            'пустой патч',
            envelope('apply_patch', { command: '' }),
            /нет строкового command/,
            'field',
        ],
        [
            'битый патч',
            envelope('apply_patch', { command: '*** Begin Patch\n*** End Patch' }),
            /ни одного файла/,
            'field',
        ],
        [
            'битый патч в оболочке',
            envelope('Bash', {
                command: 'apply_patch "*** Begin Patch\n*** Copy File: a\n*** End Patch"',
            }),
            /не заголовок/,
            'field',
        ],
        [
            'apply_patch в оболочке с телом из файла',
            envelope('Bash', { command: 'cat p | apply_patch' }),
            /без литерального тела/,
            'field',
        ],
        [
            'apply_patch в оболочке с телом подстановкой',
            envelope('Bash', { command: 'apply_patch "$(cat p)"' }),
            /без литерального тела/,
            'field',
        ],
        [
            'MCP-имя без инструмента',
            envelope('mcp__stand', {}),
            /без сервера и инструмента/,
            'field',
        ],
        ['MCP-граница неоднозначна', envelope('mcp__a__b__c', {}), /неоднозначна/, 'field'],
    ])('%s', (_what, raw, why, kind) => {
        const [first, ...rest] = ops(raw);
        expect(rest).toEqual([]);
        expect(first).toMatchObject({ op: 'unknown', kind });
        expect(first.op === 'unknown' && first.why).toMatch(why);
    });

    it('операция описания без отображения у Codex — unknown, а не догадка', () => {
        const d = { ...descriptor, toolMap: { ...descriptor.toolMap, view: 'read' as const } };
        d.allowedFields = { ...d.allowedFields, tools: { ...d.allowedFields.tools, view: [] } };
        expect(normalizeCodexEvent(d, envelope('view', {})).operations[0]).toMatchObject({
            op: 'unknown',
            why: expect.stringMatching(/операция read без отображения/),
        });
    });

    it('патч без роли в argMap — поле по имени роли, его нет во входе', () => {
        const d = { ...descriptor, argMap: { Bash: descriptor.argMap.Bash } };
        expect(
            normalizeCodexEvent(d, envelope('apply_patch', { command: 'x' })).operations[0],
        ).toMatchObject({
            op: 'unknown',
            why: expect.stringMatching(/нет строкового patch/),
        });
    });

    it('MCP без tool_input — вход пуст, вызов разобран', () => {
        const { tool_input: _, ...raw } = envelope('mcp__stand__stand_read', {});
        expect(ops(raw)[0]).toMatchObject({ op: 'mcp', server: 'stand' });
    });

    it('все поля конверта описания разом — разбираются', () => {
        expect(ops(envelope('Bash', { command: 'ls' }))[0].op).toBe('exec');
    });
});

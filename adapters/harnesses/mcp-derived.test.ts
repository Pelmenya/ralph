// MCP: общая политика допуска и параметры вызова как операции (#193). Сначала — разбор
// параметров (`mcpDerived`), затем сквозной путь у каждого харнесса: сырое событие его CLI →
// нормализатор пакета → `decideEvent` guard с политикой контура. Три пробы карточки на каждом:
// мутация вне списка — блок; разрешённый инструмент с путём env-файла в параметре — блок;
// MCP-чтение из списка — проходит. Живые пробы тех же трёх — на стенде (`install-stand.sh`).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConsumerData } from '../../.claude/hooks/consumer-data.cjs';
import { decideEvent } from '../../.claude/hooks/guard-rules.cjs';
import { normalizeClaudeEvent } from './claude-code/event.ts';
import { normalizeCodexEvent } from './codex/event.ts';
import { parseHarnessDescriptor, type HarnessDescriptor } from './descriptor.ts';
import { mcpDerived } from './event-roles.ts';
import { normalizeKimiEvent } from './kimi-code/event.ts';
import { normalizeOpencodeEvent } from './opencode/event.ts';
import type { ToolEvent } from './protocol.ts';

const DIR = import.meta.dirname;
const descriptorOf = (harness: string): HarnessDescriptor =>
    parseHarnessDescriptor(
        JSON.parse(readFileSync(path.join(DIR, harness, 'descriptor.json'), 'utf-8')),
        harness,
    );

const BASE = '/work';
const SECRET = '.env';

describe('mcpDerived: параметры вызова — операции', () => {
    const d = descriptorOf('claude-code');
    const derived = (args: Record<string, unknown>) => mcpDerived(d, args, BASE);

    it('строка без пробелов — чтение: путь сервер волен назвать любым полем', () => {
        expect(derived({ key: SECRET })).toEqual([{ op: 'read', path: SECRET, baseDir: BASE }]);
    });

    it('поле пути описания — запись: эффект инструмента нормализатор не знает', () => {
        expect(derived({ filePath: 'notes/a b.txt', FILE: 'x' })).toEqual([
            { op: 'write', path: 'notes/a b.txt', baseDir: BASE },
            { op: 'write', path: 'x', baseDir: BASE },
        ]);
    });

    it('адрес целиком или поле адреса описания — fetch', () => {
        expect(derived({ key: 'https://example.com/x', url: 'example.com' })).toEqual([
            { op: 'fetch', url: 'https://example.com/x' },
            { op: 'fetch', url: 'example.com' },
        ]);
        // Адрес под полем пути — всё равно адрес: схема говорит о канале больше, чем имя поля.
        expect(derived({ path: 'file:///etc/passwd' })).toEqual([
            { op: 'fetch', url: 'file:///etc/passwd' },
        ]);
    });

    it('вглубь объектов и массивов, ключи объектов — тоже кандидаты', () => {
        expect(
            derived({
                files: [{ path: 'a.ts' }, 'b.ts'],
                upload: { [SECRET]: 'текст с пробелами' },
            }),
        ).toEqual([
            // Ключ под полем пути — тоже путь (`{files: {"a.ts": …}}`), и имя `path` не исключение.
            { op: 'write', path: 'path', baseDir: BASE },
            { op: 'write', path: 'a.ts', baseDir: BASE },
            { op: 'write', path: 'b.ts', baseDir: BASE },
            { op: 'read', path: SECRET, baseDir: BASE },
        ]);
    });

    it('текст с пробелами, пустая строка, не строки и сверхдлинная строка — не пути', () => {
        expect(derived({ body: 'см. описание', empty: '', n: 42, ok: true, nil: null })).toEqual(
            [],
        );
        expect(derived({ blob: 'a'.repeat(4097) })).toEqual([]);
        expect(derived({ blob: 'a'.repeat(4096) })).toHaveLength(1);
    });

    it('повтор значения — одна операция', () => {
        expect(derived({ a: 'x', b: ['x', 'x'] })).toEqual([
            { op: 'read', path: 'x', baseDir: BASE },
        ]);
    });
});

/** Политика контура стенда: чтение `stand_read` заявлено, мутаций нет ни одной. */
const contour = parseConsumerData(
    JSON.stringify({
        mcp: { writeAllowed: [], tools: { mcp__stand__stand_read: { effect: 'read' } } },
    }),
);

/** Файловая система без файлов: путь не разрешается, судится строка (как в тестах guard). */
const emptyFs = {
    realpathSync: (p: string): string => {
        throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    },
    statSync: (p: string): { isDirectory: () => boolean } => {
        throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    },
    readdirSync: () => [],
};

const verdictOf = (event: ToolEvent) => {
    const v = decideEvent(
        event as Parameters<typeof decideEvent>[0],
        {
            contour,
            loop: true,
            fsApi: emptyFs,
        } as Parameters<typeof decideEvent>[1],
    );
    return v.blocked ? v.code : 'allowed';
};

type Harness = {
    name: string;
    /** Сырое событие CLI на вызов инструмента `tool` сервера `stand` с аргументами `args`. */
    raw: (tool: string, args: Record<string, unknown>) => unknown;
    normalize: (d: HarnessDescriptor, raw: unknown) => ToolEvent;
    /** Перевод имён стенда, если CLI зовёт MCP не каноническим именем. */
    mcpNames?: HarnessDescriptor['mcpNames'];
};

const HARNESSES: Harness[] = [
    {
        name: 'claude-code',
        raw: (tool, args) => ({
            session_id: 's1',
            transcript_path: '/t.jsonl',
            cwd: BASE,
            permission_mode: 'bypassPermissions',
            hook_event_name: 'PreToolUse',
            tool_name: `mcp__stand__${tool}`,
            tool_input: args,
        }),
        normalize: normalizeClaudeEvent,
    },
    {
        name: 'codex',
        raw: (tool, args) => ({
            session_id: 's1',
            turn_id: 't1',
            transcript_path: '/t.jsonl',
            cwd: BASE,
            hook_event_name: 'PreToolUse',
            model: 'gpt-5.5',
            permission_mode: 'bypassPermissions',
            tool_name: `mcp__stand__${tool}`,
            tool_input: args,
            tool_use_id: 'call-1',
        }),
        normalize: normalizeCodexEvent,
    },
    {
        name: 'kimi-code',
        raw: (tool, args) => ({
            hook_event_name: 'PreToolUse',
            session_id: 'session_1',
            cwd: BASE,
            client_type: 'kimi_code_cli',
            tool_name: `mcp__stand__${tool}`,
            tool_input: args,
            tool_call_id: 'call_1',
        }),
        normalize: normalizeKimiEvent,
    },
    {
        name: 'opencode',
        // Имя `<сервер>_<инструмент>` границы сервера не несёт: допуск — только переводом.
        raw: (tool, args) => ({
            cwd: BASE,
            opencode: { tool: `stand_${tool}`, sessionID: 'ses_1', callID: 'call_1', args },
        }),
        normalize: normalizeOpencodeEvent,
        mcpNames: {
            stand_stand_read: { server: 'stand', tool: 'stand_read' },
            stand_stand_write: { server: 'stand', tool: 'stand_write' },
        },
    },
];

describe.each(HARNESSES)('$name: MCP по общей политике контура', (h) => {
    const base = descriptorOf(h.name);
    const d: HarnessDescriptor = h.mcpNames ? { ...base, mcpNames: h.mcpNames } : base;
    const verdict = (tool: string, args: Record<string, unknown>) =>
        verdictOf(h.normalize(d, h.raw(tool, args)));

    it('мутация вне списка — блок mcp-not-allowed', () => {
        expect(verdict('stand_write', { key: 'k', value: 'v' })).toBe('mcp-not-allowed');
    });

    it('разрешённый инструмент с путём env-файла в параметре — блок secret-env', () => {
        expect(verdict('stand_read', { key: SECRET })).toBe('secret-env');
        expect(verdict('stand_read', { key: 'k', path: `config/${SECRET}` })).toBe('secret-env');
        expect(verdict('stand_read', { key: 'k', opts: { files: [SECRET] } })).toBe('secret-env');
    });

    it('разрешённый инструмент с путём данных контура в поле пути — блок в петле', () => {
        expect(verdict('stand_read', { key: 'k', path: '.claude/ralph/hooks.json' })).toBe(
            'contour-data',
        );
    });

    it('разрешённый инструмент с адресом в параметре — блок до политики сети', () => {
        expect(verdict('stand_read', { key: 'http://127.0.0.1:9/x' })).toBe('capability-unjudged');
    });

    it('MCP-чтение из списка без путей и адресов — проходит', () => {
        expect(verdict('stand_read', { key: 'k' })).toBe('allowed');
    });
});

it('OpenCode без перевода имени — незнакомый инструмент, а не допуск по догадке', () => {
    const [opencode] = HARNESSES.filter((h) => h.name === 'opencode');
    expect(
        verdictOf(
            opencode.normalize(descriptorOf('opencode'), opencode.raw('stand_read', { key: 'k' })),
        ),
    ).toBe('unknown-tool');
});

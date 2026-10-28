// Код причины барьера (#183): разбор машинной строки, равенство литералов хуков с
// перечнем контракта и живой хук процессом — правило и неисправность дают разные коды.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { HARNESS_REGISTRY, normalizerPathIn } from './harness-registry.ts';

import {
    BARRIER_REASON_CODES,
    REASON_LINE_PREFIX,
    isBarrierReasonCode,
    reasonCodeOf,
    reasonLine,
} from './barrier-reason.ts';

const CANON = path.resolve(import.meta.dirname, '..');
const HOOKS = path.join(CANON, '.claude', 'hooks');
const hookSource = (name: string) => readFileSync(path.join(HOOKS, name), 'utf-8');

describe('reasonCodeOf — код из stderr хука', () => {
    it('строка кода после текста для агента — код', () => {
        expect(reasonCodeOf(`Доступ к .env заблокирован\n${reasonLine('secret-env')}\n`)).toEqual({
            code: 'secret-env',
        });
        expect(reasonCodeOf(`текст\r\n${REASON_LINE_PREFIX}destructive\r\n`)).toEqual({
            code: 'destructive',
        });
    });

    it.each([
        ['пустой stderr', '', /нет строки кода/],
        ['текст без строки кода — блок «любой двойкой»', 'Правила не загрузились', /нет строки/],
        ['незнакомый код', `${REASON_LINE_PREFIX}secret-envv`, /незнакомый код/],
        ['код посреди строки — не машинная строка', `x ${reasonLine('destructive')}`, /нет строки/],
        [
            'две строки — ответ неоднозначен',
            `${reasonLine('secret-env')}\n${reasonLine('rules-unloaded')}`,
            /несколько строк/,
        ],
        [
            'строка кода не последней — контракт говорит «последней строкой»',
            `${reasonLine('destructive')}\nещё текст после кода`,
            /не последняя/,
        ],
        ['код с пробелом по краю — не дословно', `${REASON_LINE_PREFIX}destructive `, /незнакомый/],
        [
            'две одинаковые строки — тоже не одна',
            `${reasonLine('secret-env')}\n${reasonLine('secret-env')}`,
            /несколько строк/,
        ],
    ])('%s — «не доказано» с причиной', (_what, stderr, why) => {
        const read = reasonCodeOf(stderr);
        expect(read.code).toBeNull();
        expect('why' in read && read.why).toMatch(why);
    });

    it('перечень закрыт: прототип объекта кодом не считается', () => {
        expect(isBarrierReasonCode('toString')).toBe(false);
        expect(isBarrierReasonCode(42)).toBe(false);
        expect(isBarrierReasonCode('rule-fault')).toBe(true);
    });
});

describe('хуки говорят кодами контракта', () => {
    const SOURCES = {
        guard: ['guard.cjs', 'guard-rules.cjs'],
        'skill-barrier': ['skill-barrier.cjs'],
    };

    /** Коды, которые хук выпускает литералом: `code: '…'` вердикта и первый аргумент `block`. */
    const emittedBy = (files: string[]) => {
        const found = new Set<string>();
        for (const file of files) {
            const src = hookSource(file);
            for (const m of src.matchAll(/\bcode: '([a-z][a-z-]*)'/g)) found.add(m[1]);
            for (const m of src.matchAll(/\bblock\(\s*'([a-z][a-z-]*)'/g)) found.add(m[1]);
            // Помощник вердикта правил на событии (#186): код — первым аргументом.
            for (const m of src.matchAll(/\bblockedBy\(\s*'([a-z][a-z-]*)'/g)) found.add(m[1]);
        }
        return [...found].sort();
    };

    it.each(Object.entries(SOURCES))(
        '%s: выпущенные коды — ровно коды контракта этого хука',
        (emitter, files) => {
            const declared = Object.entries(BARRIER_REASON_CODES)
                .filter(([, v]) => v.emitter === emitter)
                .map(([code]) => code)
                .sort();
            // Пустой скан — красный: регулярка, переставшая находить литералы, выглядела бы
            // как «лишних кодов нет».
            expect(declared.length).toBeGreaterThan(0);
            expect(emittedBy(files)).toEqual(declared);
        },
    );

    it.each(['guard.cjs', 'skill-barrier.cjs'])('%s: префикс строки — тот же литерал', (file) => {
        const m = hookSource(file).match(/const REASON_LINE_PREFIX = '([^']*)';/);
        expect(m?.[1]).toBe(REASON_LINE_PREFIX);
    });

    it('каждый блок правил guard несёт код', () => {
        const src = hookSource('guard-rules.cjs');
        // Литерал вердикта — с литералом кода; исключение одно — помощник `blockedBy`, у которого
        // код — обязательный первый аргумент, и каждый его вызов называет код литералом.
        const helper =
            /const blockedBy = \(code, reason\) => \(\{ blocked: true, code, reason \}\);/;
        expect(src).toMatch(helper);
        expect(src.match(/blocked: true/g)?.length).toBe(
            (src.match(/\bcode: '/g)?.length ?? 0) + 1,
        );
        const calls = src.match(/\bblockedBy\(/g)?.length ?? 0;
        expect(calls).toBeGreaterThan(0);
        expect(src.match(/\bblockedBy\(\s*'[a-z][a-z-]*'/g)?.length).toBe(calls);
    });
});

/** Хук процессом, как его зовёт CLI: только так видны код выхода и stderr целиком. */
/** Команда нормализатора пакета Claude Code — та, что раннер кладёт в регистрацию guard. */
const CLAUDE_NORMALIZER = (() => {
    const found = normalizerPathIn(HARNESS_REGISTRY, 'claude-code', CANON);
    if (!found.ok) throw new Error(found.reason);
    return found.path;
})();

const runGuard = (guardPath: string, stdin: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [guardPath], {
        input: stdin,
        encoding: 'utf-8',
        env: {
            ...process.env,
            RALPH_CORE_SHA: '',
            RALPH_GUARD_INPUT: '',
            RALPH_GUARD_ADAPTER: CLAUDE_NORMALIZER,
            CLAUDE_PROJECT_DIR: CANON,
            ...env,
        },
    });

/** Вход в форме Claude Code: guard судит его через нормализатор пакета (#186). */
const call = (toolName: string, toolInput: Record<string, unknown>) =>
    JSON.stringify({
        session_id: 'reason-test',
        cwd: CANON,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
    });

describe('живой guard: правило и неисправность — разные коды при одной двойке', () => {
    const GUARD = path.join(HOOKS, 'guard.cjs');

    it.each([
        ['рекурсивное удаление', call('Bash', { command: 'rm -rf ./x' }), 'destructive'],
        ['чтение env-файла Read', call('Read', { file_path: '.env' }), 'secret-env'],
        ['чтение env-файла cat', call('Bash', { command: 'cat .env' }), 'secret-env'],
        ['MCP-мутация', call('mcp__probe__DeleteRepository', {}), 'mcp-not-allowed'],
        ['пустой вход', '', 'input-invalid'],
        ['вход не JSON', '{', 'input-invalid'],
    ])('%s → %s', (_what, stdin, code) => {
        const r = runGuard(GUARD, stdin);
        expect(r.status).toBe(2);
        expect(reasonCodeOf(r.stderr)).toEqual({ code });
    });

    it('безобидное — ноль и без строки кода', () => {
        const r = runGuard(GUARD, call('Bash', { command: 'git status' }));
        expect(r.status).toBe(0);
        expect(r.stderr).not.toContain(REASON_LINE_PREFIX);
    });

    it('правила не загрузились — запрещённое блокируется кодом неисправности, а не правила', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'reason-no-rules-'));
        const copy = path.join(dir, 'guard.cjs');
        copyFileSync(GUARD, copy);
        for (const name of ['consumer-data.cjs', 'core-revision.cjs', 'session-context.cjs']) {
            copyFileSync(path.join(HOOKS, name), path.join(dir, name));
        }
        writeFileSync(path.join(dir, 'guard-rules.cjs'), 'throw new Error("сломано");\n');
        const r = runGuard(copy, call('Bash', { command: 'rm -rf ./x' }));
        expect(r.status).toBe(2);
        expect(reasonCodeOf(r.stderr)).toEqual({ code: 'rules-unloaded' });
    });

    it('правило вернуло блок без кода — неисправность rule-fault, а не пропуск', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'reason-uncoded-'));
        const copy = path.join(dir, 'guard.cjs');
        copyFileSync(GUARD, copy);
        for (const name of ['consumer-data.cjs', 'core-revision.cjs', 'session-context.cjs']) {
            copyFileSync(path.join(HOOKS, name), path.join(dir, name));
        }
        writeFileSync(
            path.join(dir, 'guard-rules.cjs'),
            'const v = () => ({ blocked: true, reason: "без кода" });\n' +
                'module.exports = { decide: v, decideEvent: v };\n',
        );
        copyFileSync(path.join(HOOKS, 'adapter-event.cjs'), path.join(dir, 'adapter-event.cjs'));
        // Копия без пакетов харнесса — совместимый вход: здесь судится вердикт правила, а не
        // нормализатор (его отказ — свой код, `adapter-failed`, ниже).
        const r = runGuard(copy, call('Bash', { command: 'rm -rf ./x' }), {
            RALPH_GUARD_INPUT: 'compat-16b',
        });
        expect(r.status).toBe(2);
        expect(reasonCodeOf(r.stderr)).toEqual({ code: 'rule-fault' });
    });

    it.each([
        [
            'инструмент вне описания пакета',
            call('SendMessage', { to: 'x', message: 'm' }),
            'unknown-tool',
        ],
        ['поле вне перечня', call('Read', { file_path: 'a.ts', path: 'b.ts' }), 'unknown-field'],
        [
            'WebFetch в сессии петли',
            call('WebFetch', { url: 'https://example.com', prompt: 'p' }),
            'capability-unjudged',
        ],
    ])('событие: %s → %s', (_what, stdin, code) => {
        const r = runGuard(GUARD, stdin, {
            RALPH_GUARD_ADAPTER: CLAUDE_NORMALIZER,
            RALPH_SESSION_CONTEXT: JSON.stringify({
                sessionId: 's',
                loop: true,
                coreRevision: '',
                roots: { consumer: CANON, execution: CANON },
            }),
        });
        expect(r.status).toBe(2);
        expect(reasonCodeOf(r.stderr)).toEqual({ code });
    });

    it.each([
        ['команды нормализатора нет по пути', path.join(tmpdir(), 'ralph-no-normalizer.ts')],
        ['путь не абсолютный', 'normalize.ts'],
        ['пакет не принят реестром (значение-причина раннера)', 'пакет не принят: нет'],
    ])('%s — adapter-failed, а не пропуск', (_what, adapter) => {
        const r = runGuard(GUARD, call('Bash', { command: 'git status' }), {
            RALPH_GUARD_ADAPTER: adapter,
        });
        expect(r.status).toBe(2);
        expect(reasonCodeOf(r.stderr)).toEqual({ code: 'adapter-failed' });
    });
});

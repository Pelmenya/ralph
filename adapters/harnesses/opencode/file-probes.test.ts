// Пробы файловых событий OpenCode (#192): write, edit, read, grep, glob и apply_patch из матрицы
// описания и bash с `workdir` — через НАСТОЯЩИЙ плагин барьера (`opencodeGuardPlugin`), который
// зовёт настоящий guard процессом с командой нормализатора пакета по пути из регистрации
// (`RALPH_GUARD_ADAPTER`) и контекстом сессии петли. Пробы инструментов взяты из матрицы описания
// (`probeMatrix`), а не написаны рядом: проба, которой генератор не выдал, на стенд не поедет.
//
// Это проверка плагина и хука на событии OpenCode, а не живая проба: попытки CLI здесь нет. Что
// CLI зовёт плагин на этих событиях до эффекта и что брошенное исключение отменяет вызов, показал
// стенд (`__fixtures__/opencode-1.19.4-stand.json`). Рядом — довод «от противного»: совместимый
// вход 16b, которым OpenCode регистрировался до #192, не видит `workdir` оболочки.
//
// Вторая половина карточки — исход хука: плагин пропускает вызов только кодом 0. Код 1, хук,
// которого нет, и зависший хук отменяют вызов кодом неисправности `hook-failed`, а не правила.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reasonCodeOf } from '../../barrier-reason.ts';
import {
    OPENCODE_PLUGIN_DRIVER,
    opencodeGuardPlugin,
    type GuardHook,
} from '../../harness-guard.ts';
import { parseHarnessDescriptor } from '../descriptor.ts';
import { PROBE_TARGETS, probeMatrix, type ProbeCase } from '../probe-matrix.ts';

const DIR = import.meta.dirname;
const CANON = path.resolve(DIR, '..', '..', '..');
const GUARD = path.join(CANON, '.claude', 'hooks', 'guard.cjs');
const NORMALIZER = path.join(DIR, 'normalize.ts');
const descriptor = parseHarnessDescriptor(
    JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
    'opencode',
);
const CONTOUR = readFileSync(path.join(CANON, '.claude', 'ralph', 'hooks.json'), 'utf-8');

/** Дерево стенда: данные контура канона, разрешённые цели под `.ralph-probe/`, env-файл. */
function standTree(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'opencode-file-probes-'));
    mkdirSync(path.join(root, '.claude', 'ralph'), { recursive: true });
    writeFileSync(path.join(root, PROBE_TARGETS.contour), CONTOUR);
    writeFileSync(path.join(root, PROBE_TARGETS.secret), 'A=1\n');
    writeFileSync(path.join(root, PROBE_TARGETS.allowedRead), 'x\n');
    mkdirSync(path.join(root, PROBE_TARGETS.allowedSearch));
    mkdirSync(path.join(root, '.ralph-probe'));
    writeFileSync(path.join(root, PROBE_TARGETS.allowedWrite), 'x\n');
    writeFileSync(path.join(root, PROBE_TARGETS.victim), 'x\n');
    return root;
}
const TREE = standTree();

/** Каталог ВНЕ дерева сессии: свои данные контура в `.claude/ralph`, рядом — безобидный `ralph`. */
function outsideTree(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'opencode-outside-'));
    mkdirSync(path.join(root, '.claude', 'ralph'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'ralph', 'hooks.json'), CONTOUR);
    mkdirSync(path.join(root, 'plain', 'ralph'), { recursive: true });
    return root;
}
const OUTSIDE = outsideTree();

const LOOP_CONTEXT = JSON.stringify({
    sessionId: 'opencode-file-probes',
    loop: true,
    coreRevision: '',
    roots: { consumer: TREE, execution: TREE },
});

/** Хук барьера так, как его строит регистрация раннера: вход — событие либо совместимый 16b. */
const guardHook = (compat: boolean): GuardHook => ({
    matcher: '',
    command: compat
        ? `RALPH_GUARD_INPUT=compat-16b node '${GUARD}'`
        : `RALPH_GUARD_ADAPTER='${NORMALIZER}' RALPH_GUARD_INPUT='' node '${GUARD}'`,
    timeoutSec: 30,
});

type Verdict = { status: 'allowed' } | { status: 'blocked'; code: string | null; stderr: string };

/** Плагин процессом, как его зовёт OpenCode: `tool.execute.before(input, {args})`. */
function runPlugin(hooks: readonly GuardHook[], tool: string, args: unknown): Verdict {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', OPENCODE_PLUGIN_DRIVER], {
        cwd: TREE,
        input: JSON.stringify({
            source: opencodeGuardPlugin(hooks),
            input: { tool, sessionID: 'ses_file_probes', callID: 'call_1' },
            output: { args },
            directory: TREE,
        }),
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
            PATH: process.env.PATH ?? '',
            RALPH_CORE_SHA: '',
            RALPH_HOOKS_DATA: path.join(TREE, PROBE_TARGETS.contour),
            RALPH_SESSION_CONTEXT: LOOP_CONTEXT,
        },
    });
    if (r.status === 2) {
        return { status: 'blocked', code: reasonCodeOf(r.stderr).code, stderr: r.stderr };
    }
    expect(r.status, r.stderr).toBe(0);
    return { status: 'allowed' };
}
const verdict = (tool: string, args: unknown, compat = false) =>
    runPlugin([guardHook(compat)], tool, args);
const code = (v: Verdict) => (v.status === 'blocked' ? v.code : 'allowed');

const FILE_TOOLS = ['write', 'edit', 'read', 'grep', 'glob', 'apply_patch'];
const { probes, problems } = probeMatrix(descriptor);
// Поверхности конфига guard на событии ещё не судит (`config-surface` — код `reserved`): их
// закрывает сборщик конфига OpenCode (#197), а не барьер.
const fileProbes = probes.filter(
    (p) =>
        p.kind === 'rule' && FILE_TOOLS.includes(p.tool ?? '') && p.reasonCode !== 'config-surface',
);
const byId = new Map(probes.map((p) => [p.id, p]));

describe('пробы файловых событий OpenCode из матрицы описания', () => {
    it('матрица без проблем; классы карточки на месте, у каждой отрицательной — разрешённая пара', () => {
        expect(problems).toEqual([]);
        const ids = fileProbes.map((p) => p.id);
        for (const id of [
            'rule:apply_patch:contour-add',
            'rule:apply_patch:contour-move',
            'rule:apply_patch:contour-three',
            'rule:apply_patch:secret',
            'rule:write:contour',
            'rule:write:secret',
            'rule:edit:contour',
            'rule:edit:secret',
            'rule:read:secret',
            'rule:grep:secret-root',
            'rule:grep:secret-glob',
        ]) {
            expect(ids).toContain(id);
        }
        for (const n of fileProbes.filter((p) => p.polarity === 'negative')) {
            expect(byId.get(n.pair as string)?.polarity, n.id).toBe('positive');
        }
    });

    it.each(fileProbes.filter((p) => p.polarity === 'negative').map((p) => [p.id, p] as const))(
        '%s — блок своим кодом, парная разрешённая проходит',
        (_id, p: ProbeCase) => {
            expect(code(verdict(p.tool as string, p.input))).toBe(p.reasonCode);
            const pair = byId.get(p.pair as string) as ProbeCase;
            expect(code(verdict(pair.tool as string, pair.input))).toBe('allowed');
        },
    );

    it('grep: env-файлы шаблоном include — блок; тот же поиск безобидным шаблоном — проходит', () => {
        expect(code(verdict('grep', { pattern: '.', include: '.env*' }))).toBe('secret-env');
        expect(code(verdict('grep', { pattern: '.', include: '*.md' }))).toBe('allowed');
    });

    it('task и webfetch в петле — блок; skill — доставка инструкций, проходит', () => {
        const task = { description: 'd', prompt: 'p', subagent_type: 'general' };
        expect(code(verdict('task', task))).toBe('loop-delegation');
        expect(code(verdict('webfetch', { url: PROBE_TARGETS.fetchUrl }))).toBe(
            'capability-unjudged',
        );
        expect(code(verdict('skill', { name: 'vitest' }))).toBe('allowed');
    });
});

describe('bash с workdir судится от этого workdir', () => {
    const mv = 'mv ralph ralph.bak';

    it('workdir вне дерева над каталогом данных контура — блок; тот же вызов над безобидным — проходит', () => {
        const at = (dir: string) => ({ command: mv, workdir: path.join(OUTSIDE, dir) });
        expect(code(verdict('bash', at('.claude')))).toBe('contour-data');
        expect(code(verdict('bash', at('plain')))).toBe('allowed');
    });

    it('относительный workdir — от каталога сессии: `.claude` дерева — блок', () => {
        expect(code(verdict('bash', { command: mv, workdir: '.claude' }))).toBe('contour-data');
    });

    it('от противного: без workdir тот же перенос судится от дерева сессии и проходит', () => {
        expect(code(verdict('bash', { command: mv }))).toBe('allowed');
    });

    it('от противного: совместимый вход 16b workdir не видит и перенос из .claude пропускает', () => {
        const at = { command: mv, workdir: path.join(OUTSIDE, '.claude') };
        expect(code(verdict('bash', at, true))).toBe('allowed');
    });
});

describe('исход хука: пропуск — только кодом 0', () => {
    const hook = (command: string, timeoutSec = 10): GuardHook => ({
        matcher: '',
        command,
        timeoutSec,
    });
    const safe = { command: 'git status' };

    it.each([
        ['кодом 1', () => hook('exit 1'), /упал \(код 1\)/],
        [
            'которого нет',
            () => hook(`node '${path.join(TREE, 'no-such-hook.cjs')}'`),
            /упал \(код 1/,
        ],
        ['зависший дольше срока', () => hook('sleep 5', 1), /не ответил за 1 с/],
    ] as const)('хук %s — вызов отменён кодом неисправности', (_what, make, why) => {
        const v = runPlugin([make()], 'bash', safe);
        expect(v.status).toBe('blocked');
        if (v.status !== 'blocked') return;
        expect(v.code).toBe('hook-failed');
        expect(v.stderr).toMatch(why);
    });

    it('код 2 — причина правила, а не неисправность; код 0 — пропуск', () => {
        const rule = runPlugin(
            [hook("echo 'стоп' >&2; echo 'ralph-reason-code: destructive' >&2; exit 2")],
            'bash',
            safe,
        );
        expect(code(rule)).toBe('destructive');
        expect(code(runPlugin([hook('exit 0')], 'bash', safe))).toBe('allowed');
    });

    it('своя ошибка плагина (битый matcher) — отмена кодом plugin-fault', () => {
        const v = runPlugin([{ matcher: '(', command: 'true', timeoutSec: 10 }], 'bash', safe);
        expect(code(v)).toBe('plugin-fault');
    });
});

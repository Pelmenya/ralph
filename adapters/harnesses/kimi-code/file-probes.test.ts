// Пробы файловых событий Kimi Code (#191): Write, Edit, Read, Grep и Glob из матрицы описания и
// Bash с `cwd` вне дерева — на НАСТОЯЩЕМ guard процессом, с командой нормализатора пакета по пути
// из регистрации (`RALPH_GUARD_ADAPTER`) и контекстом сессии петли. Пробы инструментов взяты из
// матрицы описания (`probeMatrix`), а не написаны рядом: проба, которой генератор не выдал, на
// стенд не поедет.
//
// Это проверка хука на сыром входе Kimi Code, а не живая проба: попытки CLI здесь нет. Что CLI
// зовёт хук на этих событиях до эффекта и что код 2 его останавливает, показал стенд
// (`__fixtures__/kimi-code-2.3.2-stand.json`). Рядом — довод «от противного»: совместимый вход 16b,
// которым Kimi Code регистрировался до #191, не видит `cwd` оболочки и пропускает FetchURL
// (`Agent` он блокирует по имени с #225).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reasonCodeOf } from '../../barrier-reason.ts';
import { parseHarnessDescriptor } from '../descriptor.ts';
import { PROBE_TARGETS, probeMatrix, type ProbeCase } from '../probe-matrix.ts';

const DIR = import.meta.dirname;
const CANON = path.resolve(DIR, '..', '..', '..');
const GUARD = path.join(CANON, '.claude', 'hooks', 'guard.cjs');
const NORMALIZER = path.join(DIR, 'normalize.ts');
const descriptor = parseHarnessDescriptor(
    JSON.parse(readFileSync(path.join(DIR, 'descriptor.json'), 'utf-8')),
    'kimi-code',
);
const CONTOUR = readFileSync(path.join(CANON, '.claude', 'ralph', 'hooks.json'), 'utf-8');

/** Дерево стенда: данные контура канона, разрешённые цели под `.ralph-probe/`, env-файл. */
function standTree(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'kimi-file-probes-'));
    mkdirSync(path.join(root, '.claude', 'ralph'), { recursive: true });
    writeFileSync(path.join(root, PROBE_TARGETS.contour), CONTOUR);
    writeFileSync(path.join(root, PROBE_TARGETS.secret), 'A=1\n');
    writeFileSync(path.join(root, PROBE_TARGETS.allowedRead), 'x\n');
    mkdirSync(path.join(root, PROBE_TARGETS.allowedSearch));
    mkdirSync(path.join(root, '.ralph-probe'));
    writeFileSync(path.join(root, PROBE_TARGETS.allowedWrite), 'x\n');
    return root;
}
const TREE = standTree();

/** Каталог ВНЕ дерева сессии: свои данные контура в `.claude/ralph`, рядом — безобидный `ralph`. */
function outsideTree(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'kimi-outside-'));
    mkdirSync(path.join(root, '.claude', 'ralph'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'ralph', 'hooks.json'), CONTOUR);
    mkdirSync(path.join(root, 'plain', 'ralph'), { recursive: true });
    return root;
}
const OUTSIDE = outsideTree();

type Verdict = { status: 'allowed' } | { status: 'blocked'; code: string | null };

/** Вход хука в форме Kimi Code 2.3.2 (конверт стенда) через guard. */
function verdict(tool: string, input: unknown, compat = false): Verdict {
    const payload = JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'session_kimi-file-probes',
        cwd: TREE,
        client_type: 'kimi_code_cli',
        tool_name: tool,
        tool_input: input,
        tool_call_id: 'call_1',
    });
    const r = spawnSync(process.execPath, [GUARD], {
        cwd: TREE,
        input: payload,
        encoding: 'utf-8',
        timeout: 30_000,
        env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: TREE,
            RALPH_CORE_SHA: '',
            RALPH_HOOKS_DATA: path.join(TREE, PROBE_TARGETS.contour),
            RALPH_GUARD_ADAPTER: compat ? '' : NORMALIZER,
            RALPH_GUARD_INPUT: compat ? 'compat-16b' : '',
            RALPH_SESSION_CONTEXT: JSON.stringify({
                sessionId: 'kimi-file-probes',
                loop: true,
                coreRevision: '',
                roots: { consumer: TREE, execution: TREE },
            }),
        },
    });
    if (r.status === 2) return { status: 'blocked', code: reasonCodeOf(r.stderr).code };
    expect(r.status, r.stderr).toBe(0);
    return { status: 'allowed' };
}
const probeVerdict = (p: ProbeCase) => verdict(p.tool as string, p.input);

const FILE_TOOLS = ['Write', 'Edit', 'Read', 'Grep', 'Glob'];
const { probes, problems } = probeMatrix(descriptor);
const fileProbes = probes.filter((p) => p.kind === 'rule' && FILE_TOOLS.includes(p.tool ?? ''));
const byId = new Map(probes.map((p) => [p.id, p]));

describe('пробы файловых событий Kimi Code из матрицы описания', () => {
    it('матрица без проблем; классы карточки на месте, у каждой отрицательной — разрешённая пара', () => {
        expect(problems).toEqual([]);
        const ids = fileProbes.map((p) => p.id);
        for (const id of [
            'rule:Write:contour',
            'rule:Write:secret',
            'rule:Edit:contour',
            'rule:Edit:secret',
            'rule:Read:secret',
            'rule:Grep:secret-root',
            'rule:Grep:secret-glob',
        ]) {
            expect(ids).toContain(id);
        }
        for (const n of fileProbes.filter((p) => p.polarity === 'negative')) {
            expect(byId.get(n.pair as string)?.polarity, n.id).toBe('positive');
        }
    });

    it.each(fileProbes.filter((p) => p.polarity === 'negative').map((p) => [p.id, p] as const))(
        '%s — блок своим кодом, парная разрешённая проходит',
        (_id, p) => {
            expect(probeVerdict(p)).toEqual({ status: 'blocked', code: p.reasonCode });
            expect(probeVerdict(byId.get(p.pair as string) as ProbeCase)).toEqual({
                status: 'allowed',
            });
        },
    );

    it('Write с mode: append данных контура — блок, разрешённого пути — проходит', () => {
        const append = { content: '{}', mode: 'append' };
        expect(verdict('Write', { path: PROBE_TARGETS.contour, ...append })).toEqual({
            status: 'blocked',
            code: 'contour-data',
        });
        expect(verdict('Write', { path: PROBE_TARGETS.allowedWrite, ...append })).toEqual({
            status: 'allowed',
        });
    });

    it('FetchURL и Agent в петле — блок; от противного: совместимый вход 16b FetchURL пропускал', () => {
        const fetch = { url: PROBE_TARGETS.fetchUrl };
        const agent = { prompt: 'p', description: 'd' };
        expect(verdict('FetchURL', fetch)).toEqual({
            status: 'blocked',
            code: 'capability-unjudged',
        });
        expect(verdict('Agent', agent)).toEqual({ status: 'blocked', code: 'loop-delegation' });
        expect(verdict('FetchURL', fetch, true)).toEqual({ status: 'allowed' });
    });
});

describe('Bash с cwd судится от этого cwd', () => {
    const mv = 'mv ralph ralph.bak';

    it('cwd вне дерева над каталогом данных контура — блок; тот же вызов над безобидным — проходит', () => {
        expect(verdict('Bash', { command: mv, cwd: path.join(OUTSIDE, '.claude') })).toEqual({
            status: 'blocked',
            code: 'contour-data',
        });
        expect(verdict('Bash', { command: mv, cwd: path.join(OUTSIDE, 'plain') })).toEqual({
            status: 'allowed',
        });
    });

    it('относительный cwd — от cwd сессии: `.claude` дерева — блок', () => {
        expect(verdict('Bash', { command: mv, cwd: '.claude' })).toEqual({
            status: 'blocked',
            code: 'contour-data',
        });
    });

    it('от противного: без cwd тот же перенос судится от дерева сессии и проходит', () => {
        expect(verdict('Bash', { command: mv })).toEqual({ status: 'allowed' });
    });

    it('от противного: совместимый вход 16b cwd не видит и перенос из .claude пропускает', () => {
        expect(verdict('Bash', { command: mv, cwd: path.join(OUTSIDE, '.claude') }, true)).toEqual({
            status: 'allowed',
        });
    });
});

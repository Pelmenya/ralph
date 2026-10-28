// Пробы файловых событий Codex (#189): патч Add/Update/Delete/Move и патч на три файла с одним
// защищённым — на НАСТОЯЩЕМ guard процессом, с командой нормализатора пакета по пути из
// регистрации (`RALPH_GUARD_ADAPTER`) и контекстом сессии петли. Пробы взяты из матрицы описания
// (`probeMatrix`), а не написаны рядом: проба, которой генератор не выдал, на стенд не поедет.
//
// Это проверка хука на сыром входе Codex, а не живая проба: попытки CLI здесь нет, и судьёй
// (`judgeWithPair`) она не доказывается — для этого нужен стенд с маршрутом ключа Codex, которого
// у каталога живых проб пока нет (`adapters/live-probe-cases.ts`). Рядом — довод «от противного»:
// совместимый вход 16b, которым Codex регистрировался до #232, тот же патч данных контура пропускает.
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
    'codex',
);

/** Дерево стенда: данные контура канона, разрешённые цели под `.ralph-probe/`. */
function standTree(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'codex-file-probes-'));
    mkdirSync(path.join(root, '.claude', 'ralph'), { recursive: true });
    writeFileSync(
        path.join(root, PROBE_TARGETS.contour),
        readFileSync(path.join(CANON, '.claude', 'ralph', 'hooks.json'), 'utf-8'),
    );
    mkdirSync(path.join(root, '.ralph-probe'));
    writeFileSync(path.join(root, PROBE_TARGETS.allowedWrite), 'x\n');
    writeFileSync(path.join(root, PROBE_TARGETS.victim), 'x\n');
    return root;
}
const TREE = standTree();

type Verdict = { status: 'allowed' } | { status: 'blocked'; code: string | null };

/** Вход хука в форме Codex 0.163.0 (конверт стенда #188) через guard. */
function verdict(p: ProbeCase, compat = false): Verdict {
    const payload = JSON.stringify({
        session_id: 'codex-file-probes',
        turn_id: 't1',
        transcript_path: '/path/to/rollout.jsonl',
        cwd: TREE,
        hook_event_name: 'PreToolUse',
        model: 'gpt-5.5',
        permission_mode: 'bypassPermissions',
        tool_name: p.tool,
        tool_input: p.input,
        tool_use_id: 'call-1',
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
                sessionId: 'codex-file-probes',
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

const { probes, problems } = probeMatrix(descriptor);
const patchProbes = probes.filter((p) => p.kind === 'rule' && p.tool === 'apply_patch');
const byId = new Map(probes.map((p) => [p.id, p]));

describe('пробы патча Codex из матрицы описания', () => {
    it('матрица без проблем; классы карточки на месте, у каждой отрицательной — разрешённая пара', () => {
        expect(problems).toEqual([]);
        const ids = patchProbes.map((p) => p.id.replace('rule:apply_patch:', ''));
        for (const slug of [
            'contour-add',
            'contour-update',
            'contour-delete',
            'contour-move',
            'contour-three',
        ]) {
            expect(ids).toContain(slug);
        }
        for (const n of patchProbes.filter((p) => p.polarity === 'negative')) {
            expect(byId.get(n.pair as string)?.polarity, n.id).toBe('positive');
        }
    });

    it.each(patchProbes.filter((p) => p.polarity === 'negative').map((p) => [p.id, p] as const))(
        '%s — блок своим кодом, парная разрешённая проходит',
        (_id, p) => {
            expect(verdict(p)).toEqual({ status: 'blocked', code: p.reasonCode });
            expect(verdict(byId.get(p.pair as string) as ProbeCase)).toEqual({
                status: 'allowed',
            });
        },
    );

    it('патч на три файла с одним защищённым — блок всего вызова, а не двух разрешённых', () => {
        const three = byId.get('rule:apply_patch:contour-three') as ProbeCase;
        const text = String(three.input?.command);
        expect(text.match(/\*\*\* Add File: /g)).toHaveLength(3);
        expect(verdict(three)).toEqual({ status: 'blocked', code: 'contour-data' });
    });

    it('от противного: совместимый вход 16b тот же патч данных контура пропускает', () => {
        const add = byId.get('rule:apply_patch:contour-add') as ProbeCase;
        expect(verdict(add, true)).toEqual({ status: 'allowed' });
    });
});

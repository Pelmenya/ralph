// Граница стартовой пробы (#183, `docs/harness-contract.md`, принцип 5 и 8): на дереве
// потребителя проба исполняет ТОЛЬКО хуки на синтетическом входе — без настоящего CLI, без
// попытки вызова и без эффекта. Живая проба с попыткой и эффектом — только на стенде.
//
// Граница держится тремя сторонами, и каждую видно своим тестом: что проба запускает (только
// команды регистрации на синтетическом входе), чего она не трогает (дерево после пробы на
// настоящих хуках то же, что до), и чем её исход не является (судья видов проб не считает
// его доказательством — попытки нет).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUARD_PROBES, hooksFor, probeProblems, type TRunHookFn } from './guard-probe.ts';
import { judgeProbe, type ProbeSpec } from '../adapters/probe-kinds.ts';
import { reasonCodeOf } from '../adapters/barrier-reason.ts';
import { coreIsRepoRoot } from '../tests/core-repo.ts';

const CANON = path.resolve(import.meta.dirname, '..');
const SOURCE = readFileSync(path.join(import.meta.dirname, 'guard-probe.ts'), 'utf-8');

/** Бинари харнессов: стартовая проба не запускает ни одного. */
const CLI_RE = /^(?:\S*\/)?(?:claude|codex|kimi|opencode)(?:\s|$)/;

describe('что стартовая проба запускает', () => {
    it('исполнители — только оболочка с командой хука и драйвер плагина', () => {
        const spawns = [...SOURCE.matchAll(/spawnSync\(\s*('[^']*'),\s*\[([^\]]*)\]/g)].map(
            (m) => `${m[1]} [${m[2].trim()}]`,
        );
        expect(spawns).toEqual([
            `'sh' ['-c', hook.command]`,
            `'node' ['--input-type=module', '-e', OPENCODE_PLUGIN_DRIVER]`,
        ]);
        // Других путей к процессу нет: ни exec, ни spawn, ни fork.
        expect(SOURCE).not.toMatch(/\b(?:execSync|execFileSync|spawn|fork|exec)\(/);
    });

    it('стенд живых проб в стартовую пробу не заходит', () => {
        expect(SOURCE).not.toMatch(/provision\/|probe-matrix|probe-kinds/);
    });

    it.skipIf(!coreIsRepoRoot())(
        'на настоящих настройках канона — только команды регистрации на синтетическом входе',
        () => {
            const settings = JSON.parse(
                readFileSync(path.join(CANON, '.claude', 'settings.json'), 'utf-8'),
            ) as unknown;
            const registered = new Set(
                GUARD_PROBES.flatMap((p) => hooksFor(settings, p.toolName).map((h) => h.command)),
            );
            expect(registered.size).toBeGreaterThan(0);
            const runs: { command: string; payload: Record<string, unknown> }[] = [];
            const record: TRunHookFn = (hook, payload) => {
                runs.push({
                    command: hook.command,
                    payload: JSON.parse(payload) as Record<string, unknown>,
                });
                return { status: 0, stderr: '' };
            };
            probeProblems(settings, '/path/to/app', { runHookFn: record });
            expect(runs.length).toBeGreaterThan(0);
            for (const run of runs) {
                expect(registered.has(run.command), run.command).toBe(true);
                expect(run.command).not.toMatch(CLI_RE);
                // Синтетический вход: сессия пробы, транскрипта нет — CLI его не создавал.
                expect(run.payload.session_id).toBe('ralph-guard-probe');
                expect(run.payload).not.toHaveProperty('transcript_path');
            }
        },
    );
});

/** Снимок дерева по содержимому: путь → размер и байты (каталог — пометкой). */
function snapshot(root: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            const rel = path.relative(root, full);
            if (statSync(full).isDirectory()) {
                out.set(rel, 'dir');
                walk(full);
            } else out.set(rel, readFileSync(full, 'base64'));
        }
    };
    walk(root);
    return out;
}

/** Хук процессом мимо предохранителя побочек — как боевой `runHook`. */
const spawnHook: TRunHookFn = (hook, payload, projectDir) => {
    const r = spawnSync('sh', ['-c', hook.command], {
        cwd: projectDir,
        input: payload,
        encoding: 'utf-8',
        timeout: hook.timeoutSec * 1000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, RALPH_CORE_SHA: '' },
    });
    return { status: r.status, stderr: r.stderr ?? '' };
};

describe('чего стартовая проба не трогает', () => {
    it.skipIf(!coreIsRepoRoot())(
        'настоящие хуки на дереве с целями проб: дерево после пробы то же, что до',
        () => {
            const tree = mkdtempSync(path.join(tmpdir(), 'probe-boundary-'));
            cpSync(path.join(CANON, '.claude', 'hooks'), path.join(tree, '.claude', 'hooks'), {
                recursive: true,
            });
            cpSync(
                path.join(CANON, '.claude', 'settings.json'),
                path.join(tree, '.claude', 'settings.json'),
            );
            // Цели запрещённых проб существуют: исполнись вызов, удаление и чтение было бы видно.
            cpSync(path.join(CANON, 'LICENSE'), path.join(tree, '.ralph-guard-probe', 'keep'));
            writeFileSync(path.join(tree, '.env'), 'PROBE_SECRET=1\n');
            const before = snapshot(tree);

            const settings = JSON.parse(
                readFileSync(path.join(tree, '.claude', 'settings.json'), 'utf-8'),
            ) as unknown;
            const runs: string[] = [];
            const problems = probeProblems(settings, tree, {
                runHookFn: (hook, payload, dir, opts) => {
                    const run = spawnHook(hook, payload, dir, opts);
                    runs.push(run.stderr);
                    return run;
                },
            });

            expect(problems).toEqual([]);
            expect(runs.length).toBeGreaterThan(0);
            expect(snapshot(tree)).toEqual(before);
            // Хук не выдал содержимое секрета ни в один канал, который проба читает.
            expect(runs.join('\n')).not.toContain('PROBE_SECRET');
        },
    );
});

describe('чем исход стартовой пробы не является', () => {
    it('свидетельства хука на синтетическом входе судья не считает доказательством правила', () => {
        // Всё, что стартовая проба знает о вызове: хук вышел 2 и назвал верный код.
        const probe = GUARD_PROBES.find((p) => p.expect === 'blocked');
        if (!probe || probe.expect !== 'blocked') throw new Error('нет запрещённой пробы');
        const stderr = `заблокировано\nralph-reason-code: ${probe.reasonCode}\n`;
        expect(reasonCodeOf(stderr)).toEqual({ code: probe.reasonCode });
        const spec: ProbeSpec = {
            id: 'rule:startup',
            kind: 'rule',
            polarity: 'negative',
            what: probe.what,
            effect: 'mutation',
            reasonCode: probe.reasonCode,
            pair: 'rule:startup:allowed',
        };
        const verdict = judgeProbe(spec, {
            barrierEvent: true,
            hookExit: 2,
            hookStderr: stderr,
        });
        expect(verdict.verdict).toBe('unproven');
    });
});

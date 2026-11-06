import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const stand = readFileSync(join(import.meta.dirname, '..', 'install-stand.sh'), 'utf8');
const result = stand.match(/^result\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';

function resultRc(verdict: string): number {
    const run = spawnSync(
        'bash',
        ['-c', `say() { :; }\n${result}\nRC=0\nresult p "$1" x\necho "$RC"`, 'bash', verdict],
        { encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    return Number(run.stdout.trim());
}

describe('вердикт пробы стенда', () => {
    it.each(['PASS', 'FAIL-CLOSED', 'SKIP', 'INFO'])('%s — зелёный исход', (verdict) => {
        expect(resultRc(verdict)).toBe(0);
    });

    it.each(['FAIL', 'FAIL-OPEN', 'INCONCLUSIVE', '', 'WAT'])(
        '%s — ненулевой код стенда',
        (verdict) => {
            expect(resultRc(verdict)).toBe(1);
        },
    );
});

describe('короткая сессия отчёта', () => {
    it('объявлена пробой и требует маркер вывода без ошибок CLI', () => {
        expect(stand).toContain('probe_short-session()');
        const probe = stand.match(/^probe_short-session\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';
        expect(probe).toContain('ralph-stand-ok');
        expect(probe).toContain('result short-session PASS');
        expect(probe).toContain('result short-session FAIL');
        expect(probe).toContain('STAND_FAKE_PROVIDER');
    });
});

describe('пробы guard на событии у каждого CLI', () => {
    it.each(['paths_probe', 'mcp_probe', 'probe_unknown-tool'])(
        '%s не заменяет отсутствие регистрации на SKIP у трёх CLI',
        (name) => {
            const probe =
                stand.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? '';
            expect(probe).not.toBe('');
            expect(probe).not.toContain('SKIP');
            expect(probe).not.toContain('[ "$CLI" != claude ]');
        },
    );
});

describe('судья пробы session-context', () => {
    const probe = stand.match(/^probe_session-context\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';
    const judgeStart = probe.indexOf('    out=$(');
    const judgeEnd = probe.indexOf('    unset RALPH_SESSION_CONTEXT', judgeStart);
    const judge = judgeStart >= 0 && judgeEnd > judgeStart ? probe.slice(judgeStart, judgeEnd) : '';

    it('проверяет код выхода судьи и отклоняет вердикт вне его контракта', () => {
        expect(probe).toContain(
            'out=$(node "$CANON_ROOT/provision/stand/context-judge.mts" "$LOGS/canon.log" RALPH_STAND_CONTEXT_EXPECTED) || out=""',
        );
        expect(probe).not.toContain('read -r verdict why < <(');
        expect(probe).toContain('result session-context FAIL "судья не дал вердикта');
    });

    it.each([
        ['судья упал', 'exit2'],
        ['пустой вывод', 'empty'],
        ['незнакомый вердикт', 'unknown'],
    ])('%s — FAIL и ненулевой код стенда', (_name, mode) => {
        const run = spawnSync(
            'bash',
            [
                '-c',
                `say() { printf '%s\\n' "$*"; }\nCLI=stand\n${result}\nRC=0\nnode() {\n    case "$JUDGE_MODE" in\n        exit2) return 2 ;;\n        empty) return 0 ;;\n        *) printf 'WAT why\\n' ;;\n    esac\n}\n${judge}\nprintf 'RC=%s\\n' "$RC"`,
            ],
            { encoding: 'utf8', env: { ...process.env, JUDGE_MODE: mode } },
        );
        expect(run.status).toBe(0);
        expect(run.stdout).toContain('RESULT stand session-context FAIL');
        expect(run.stdout).toContain('RC=1');
    });
});

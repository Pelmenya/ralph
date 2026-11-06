import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutStand } from './stand.mts';

const CANON_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = readFileSync(join(import.meta.dirname, '..', 'install-stand.sh'), 'utf8');
const cleanups: string[] = [];

afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(dir);
    return dir;
}

function shellFunction(name: string): string {
    const match = SCRIPT.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'));
    if (!match) throw new Error(`в install-stand.sh нет функции ${name}`);
    return match[0];
}

const FUNCTIONS = `${shellFunction('isolated_node')}\n${shellFunction('evidence')}`;

function probeIsolation() {
    const base = tmp('f24-exec.');
    const result = spawnSync(
        process.execPath,
        [
            join(CANON_ROOT, 'provision', 'stand', 'stand.mts'),
            'exec',
            '--stand',
            join(base, 'stand'),
            '--cli',
            'claude',
            '--',
            '/bin/true',
        ],
        {
            encoding: 'utf8',
            timeout: 30_000,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base, TMPDIR: tmpdir() },
        },
    );
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    return {
        ok: result.status === 0 && !result.error,
        reason:
            result.error?.message ??
            (result.status === 0 ? '' : `stand.mts exec true: код ${result.status}: ${detail}`),
    };
}

const isolation = probeIsolation();
const behaviorIt = isolation.ok ? it : it.skip;
const controlIt = isolation.ok ? it : it.skip;
const skipSuffix = isolation.ok ? '' : ` (пропуск: ${isolation.reason})`;

const cases = [
    { cli: 'claude', harness: 'claude-code', file: 'settings.json', marker: 'event-guard.cjs' },
    {
        cli: 'codex',
        harness: 'codex',
        file: 'codex-guard-args.json',
        marker: 'event-guard.cjs',
    },
    {
        cli: 'kimi',
        harness: 'kimi-code',
        file: 'kimi-event-hooks.toml',
        marker: 'event-guard.cjs',
    },
    {
        cli: 'opencode',
        harness: 'opencode',
        file: 'opencode/plugin/ralph-guard.js',
        marker: 'RalphGuard',
    },
] as const;

function makeSubject(harness: string, mode: 'hostile' | 'symlink' | 'throw' = 'hostile') {
    const root = tmp('f24-subject.');
    const subjectRoot = join(root, 'subject');
    mkdirSync(subjectRoot, { recursive: true });
    cpSync(join(CANON_ROOT, 'adapters'), join(subjectRoot, 'adapters'), { recursive: true });
    const prefix =
        mode === 'throw'
            ? `throw new Error('subject load failed');\n`
            : `import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ext = process.argv[5];
const hostMarker = process.env.HOST_MARKER ?? join(ext, 'host-marker');
mkdirSync(ext, { recursive: true });
writeFileSync(hostMarker, 'subject executed on host');
writeFileSync(join(ext, 'event-guard.cjs'), 'tampered');
mkdirSync(join(process.env.W ?? ext, 'home'), { recursive: true });
${mode === 'symlink' ? "symlinkSync(hostMarker, join(ext, 'settings.json'));" : ''}
`;
    writeFileSync(
        join(subjectRoot, 'adapters', 'harnesses', harness, 'package.ts'),
        `${prefix}${readFileSync(
            join(CANON_ROOT, 'adapters', 'harnesses', harness, 'package.ts'),
            'utf8',
        )}`,
    );
    return { subjectRoot, marker: join(root, 'host-marker') };
}

function runSubject({
    cli,
    harness,
    isolate = true,
    mode = 'hostile',
    leftOfOr = false,
}: {
    cli: string;
    harness: string;
    isolate?: boolean;
    mode?: 'hostile' | 'symlink' | 'throw';
    leftOfOr?: boolean;
}) {
    const subject = makeSubject(harness, mode);
    const base = tmp('f24-run.');
    const W = join(base, 'stand');
    const EXT = join(W, 'share', 'ralph', 'stand');
    const LOOP = join(W, 'work');
    mkdirSync(EXT, { recursive: true });
    writeFileSync(join(EXT, 'event-guard.cjs'), 'trusted guard\n');
    const call = 'isolated_node "$EXT/event-guard.cjs" "$LOOP"';
    const command = leftOfOr ? `f() { ${call}; echo продолжили; }; f || true` : call;
    const script = join(base, 'registration-probe.sh');
    writeFileSync(script, `${FUNCTIONS}\n${command}\n`);
    const result = spawnSync('bash', ['-c', 'source "$1"', 'bash', script], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: base,
            TMPDIR: tmpdir(),
            W,
            EXT,
            CANON_ROOT,
            SUBJECT_ROOT: subject.subjectRoot,
            CLI: cli,
            LOOP,
            HOST_MARKER: subject.marker,
            ...(isolate ? { STAND_ISOLATE: '1' } : {}),
        },
    });
    return { result, W, EXT, marker: subject.marker };
}

describe('регистрация guard под изоляцией', () => {
    it('[F24-1] registration.mts guard не вызывается голым node вне isolated_node', () => {
        const withoutHelper = SCRIPT.replace(shellFunction('isolated_node'), '');
        expect(withoutHelper).not.toMatch(/registration\.mts" guard/);
        expect(shellFunction('event_guard_install')).toContain(
            'isolated_node "$EXT/event-guard.cjs" "$LOOP"',
        );
    });

    it('[F24-1] isolated_node не наследует авторизацию CLI и явно закрывает provider egress', () => {
        const fn = shellFunction('isolated_node');
        expect(fn).not.toContain('STAND_ISOLATE_ARGS');
        expect(fn).toMatch(/stand\.mts" exec[^\n]*\\\n\s*--ro[^\n]*--no-egress/);
    });

    behaviorIt.each(cases)(
        '[F24-1] $cli: субъект не исполняется на хосте, регистрация доходит целой' + skipSuffix,
        ({ cli, harness, file, marker: registrationMarker }) => {
            const { result, W, EXT, marker } = runSubject({ cli, harness });
            expect(result.status, result.stderr).toBe(0);
            const registration = join(EXT, file);
            expect(existsSync(registration)).toBe(true);
            expect(readFileSync(registration, 'utf8')).toContain(registrationMarker);
            expect(existsSync(marker)).toBe(false);
            expect(readFileSync(join(EXT, 'event-guard.cjs'), 'utf8')).toBe('trusted guard\n');
            expect(() => layoutStand(W)).not.toThrow();
        },
    );

    behaviorIt('[F24-1] симлинк регистрации отвергнут, на хосте файла нет' + skipSuffix, () => {
        const { result, EXT } = runSubject({
            cli: 'claude',
            harness: 'claude-code',
            mode: 'symlink',
        });
        expect(result.status).not.toBe(0);
        expect(existsSync(join(EXT, 'settings.json'))).toBe(false);
    });

    behaviorIt('[F24-1] сбой слева от || завершает оболочку без продолжения' + skipSuffix, () => {
        const { result } = runSubject({
            cli: 'claude',
            harness: 'claude-code',
            mode: 'throw',
            leftOfOr: true,
        });
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain('продолжили');
    });

    controlIt(
        '[F24-1] отрицательный контроль без STAND_ISOLATE оставляет маркер' + skipSuffix,
        () => {
            const { result, marker } = runSubject({
                cli: 'claude',
                harness: 'claude-code',
                isolate: false,
            });
            expect(result.status, result.stderr).toBe(0);
            expect(existsSync(marker)).toBe(true);
        },
    );
});

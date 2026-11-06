import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { materializeFakeMcp, materializeGuardRegistration } from './registration.mts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stand-registration-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('регистрация guard стенда из пакета харнесса', () => {
    it.each([
        ['claude', 'claude-code', 'settings.json'],
        ['codex', 'codex', 'codex-guard-args.json'],
        ['kimi', 'kimi-code', 'kimi-event-hooks.toml'],
        ['opencode', 'opencode', 'opencode/plugin/ralph-guard.js'],
    ])(
        '%s: нормализатор свой, форма регистрации читается обратно пакетом',
        async (cli, harness, file) => {
            const ext = tempDir();
            const result = await materializeGuardRegistration({
                cli,
                subjectRoot: ROOT,
                ext,
                hook: join(ext, 'event-guard.cjs'),
                projectDir: '/work',
            });
            expect(result.normalizer).toBe(
                join(ROOT, 'adapters', 'harnesses', harness, 'normalize.ts'),
            );
            expect(result.registration.problems).toEqual([]);
            expect(result.registration.hooks).toHaveLength(1);
            expect(result.registration.hooks[0].command).toContain('event-guard.cjs');
            expect(result.registration.hooks[0].command).toContain("CLAUDE_PROJECT_DIR='/work'");
            expect(readFileSync(join(ext, file), 'utf8')).toContain(
                cli === 'opencode' ? 'RalphGuard' : 'event-guard.cjs',
            );
        },
    );
});

describe('фиктивный MCP в конфиге каждого CLI', () => {
    it.each([
        ['claude', 'mcp.json', 'mcpServers'],
        ['codex', 'codex-mcp.toml', 'mcp_servers.stand'],
        ['kimi', 'kimi-home/mcp.json', 'mcpServers'],
        ['opencode', 'opencode/opencode.json', '"mcp"'],
    ])('%s: сервер стенда лежит в родной форме', (cli, file, marker) => {
        const ext = tempDir();
        const result = materializeFakeMcp({
            cli,
            ext,
            server: join(ROOT, 'provision', 'stand', 'fake-mcp.mts'),
            journal: join(ext, 'mcp.jsonl'),
        });
        const text = readFileSync(result.file, 'utf8');
        expect(result.file).toBe(join(ext, file));
        expect(text).toContain(marker);
        expect(text).toContain('fake-mcp.mts');
        expect(text).toContain('mcp.jsonl');
    });
});

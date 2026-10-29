import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './switch-claude.mjs';

function homeWith(settings: unknown = {}) {
    const home = mkdtempSync(join(tmpdir(), 'claude-channel-'));
    const dir = join(home, '.claude');
    mkdirSync(dir);
    writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    return home;
}

function run(home: string, args: string[], env: Record<string, string> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = main({
        args,
        env,
        home,
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
    });
    return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function settings(home: string) {
    return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
}

describe('switch-claude helper', () => {
    it('профиль kimi пишет официальный Anthropic-совместимый контракт и закрывает файл', () => {
        const home = homeWith({ env: { KEEP_ME: 'yes' } });
        const result = run(home, ['kimi'], { KIMI_CODE_API_KEY: 'test-kimi-key' });

        expect(result.status, result.stderr).toBe(0);
        expect(settings(home).env).toEqual({
            KEEP_ME: 'yes',
            ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/',
            ANTHROPIC_API_KEY: 'test-kimi-key',
            ANTHROPIC_MODEL: 'k3.1-pro[1m]',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'k3.1-pro[1m]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'k3.1-pro[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'k3.1-pro[1m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'k3.1-pro[1m]',
            CLAUDE_CODE_SUBAGENT_MODEL: 'k3.1-pro[1m]',
            CLAUDE_CODE_EFFORT_LEVEL: 'high',
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
        });
        expect(statSync(join(home, '.claude', 'settings.json')).mode & 0o777).toBe(0o600);
        expect(
            statSync(join(home, '.claude', 'settings.json.channel-switch.bak')).mode & 0o777,
        ).toBe(0o600);
    });

    it('kimi → cheap → official чистит переменные прошлого канала, но не чужие', () => {
        const home = homeWith({ env: { KEEP_ME: 'yes' } });
        expect(run(home, ['kimi'], { KIMI_CODE_API_KEY: 'test-kimi-key' }).status).toBe(0);
        expect(
            run(home, ['cheap'], {
                CLAUDE_CHEAP_BASE_URL: 'https://gateway.example.com',
                ROUTER_CHEAP_KEY: 'test-gateway-key',
            }).status,
        ).toBe(0);

        expect(settings(home).env).toEqual({
            KEEP_ME: 'yes',
            ANTHROPIC_BASE_URL: 'https://gateway.example.com',
            ANTHROPIC_AUTH_TOKEN: 'test-gateway-key',
            ANTHROPIC_MODEL: 'claude-opus-5-5',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-opus-5-5',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
            ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
        });

        expect(run(home, ['official']).status).toBe(0);
        expect(settings(home).env).toEqual({ KEEP_ME: 'yes' });
    });

    it('не пишет settings, если обязательного значения профиля нет', () => {
        const home = homeWith({ env: { KEEP_ME: 'yes' } });
        const file = join(home, '.claude', 'settings.json');
        const before = readFileSync(file, 'utf8');
        const result = run(home, ['cheap'], { ROUTER_CHEAP_KEY: 'test-gateway-key' });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('CLAUDE_CHEAP_BASE_URL');
        expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('не принимает унаследованное имя за профиль и не пишет окружение в settings', () => {
        const home = homeWith({ env: { KEEP_ME: 'yes' } });
        const file = join(home, '.claude', 'settings.json');
        const before = readFileSync(file, 'utf8');
        const result = run(home, ['constructor'], {
            SECRET_TO_KEEP_OUT_OF_FILES: 'do-not-write',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("unknown profile 'constructor'");
        expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('--help работает даже при битом settings и перечисляет все каналы', () => {
        const home = homeWith();
        writeFileSync(join(home, '.claude', 'settings.json'), '{');
        const result = run(home, ['--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('official|cheap|cheap-direct|kimi');
    });
});

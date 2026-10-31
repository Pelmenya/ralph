import { describe, expect, it } from 'vitest';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
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
            ANTHROPIC_MODEL: 'kimi-for-coding',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'k3.1-pro[1m]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'k3.1-pro[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-for-coding',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-for-coding',
            CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-for-coding',
            CLAUDE_CODE_EFFORT_LEVEL: 'high',
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
            NO_PROXY: 'api.kimi.ai',
            no_proxy: 'api.kimi.ai',
        });
        expect(statSync(join(home, '.claude', 'settings.json')).mode & 0o777).toBe(0o600);
        expect(
            statSync(join(home, '.claude', 'settings.json.channel-switch.bak')).mode & 0o777,
        ).toBe(0o600);
    });

    it('профиль kimi позволяет независимо переопределить основной и expert-маршруты', () => {
        const home = homeWith();
        const result = run(home, ['kimi'], {
            KIMI_CODE_API_KEY: 'test-kimi-key',
            CLAUDE_KIMI_MODEL: 'main-model',
            CLAUDE_KIMI_EXPERT_MODEL: 'expert-model',
        });

        expect(result.status, result.stderr).toBe(0);
        expect(settings(home).env).toMatchObject({
            ANTHROPIC_MODEL: 'main-model',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'expert-model',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'expert-model',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'main-model',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'main-model',
            CLAUDE_CODE_SUBAGENT_MODEL: 'main-model',
        });
    });

    it('повторное переключение kimi использует ключ активного Kimi endpoint', () => {
        const home = homeWith({
            env: {
                ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/',
                ANTHROPIC_API_KEY: 'stored-kimi-key',
                ANTHROPIC_MODEL: 'old-model',
            },
        });
        const result = run(home, ['kimi']);

        expect(result.status, result.stderr).toBe(0);
        expect(settings(home).env).toMatchObject({
            ANTHROPIC_API_KEY: 'stored-kimi-key',
            ANTHROPIC_MODEL: 'kimi-for-coding',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'k3.1-pro[1m]',
        });
    });

    it('не переносит сохранённый API key с чужого endpoint в профиль kimi', () => {
        const home = homeWith({
            env: {
                ANTHROPIC_BASE_URL: 'https://gateway.example.com',
                ANTHROPIC_API_KEY: 'other-provider-key',
            },
        });
        const file = join(home, '.claude', 'settings.json');
        const before = readFileSync(file, 'utf8');
        const result = run(home, ['kimi']);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('KIMI_CODE_API_KEY');
        expect(readFileSync(file, 'utf8')).toBe(before);
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
            NO_PROXY: 'gateway.example.com',
            no_proxy: 'gateway.example.com',
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

    it('ключи, увиденные один раз, переключают каналы из шелла без окружения', () => {
        const home = homeWith();
        expect(
            run(home, [], {
                KIMI_CODE_API_KEY: 'saved-kimi-key',
                ROUTER_CHEAP_KEY: 'saved-gateway-key',
                CLAUDE_CHEAP_BASE_URL: 'https://gateway.example.com',
            }).status,
        ).toBe(0);
        const store = join(home, '.config', 'claude-channel', 'channels.json');
        expect(statSync(store).mode & 0o777).toBe(0o600);

        expect(run(home, ['kimi']).status).toBe(0);
        expect(settings(home).env.ANTHROPIC_API_KEY).toBe('saved-kimi-key');
        expect(run(home, ['cheap']).status).toBe(0);
        expect(settings(home).env).toMatchObject({
            ANTHROPIC_BASE_URL: 'https://gateway.example.com',
            ANTHROPIC_AUTH_TOKEN: 'saved-gateway-key',
        });
        const status = run(home, []);
        expect(status.stdout).toContain('cheap        ready');
        expect(status.stdout).toContain('cheap-direct missing CLAUDE_CHEAP_DIRECT_BASE_URL');
    });

    it('свежий ключ из окружения заменяет сохранённый', () => {
        const home = homeWith();
        run(home, [], { KIMI_CODE_API_KEY: 'old-key' });
        expect(run(home, ['kimi'], { KIMI_CODE_API_KEY: 'new-key' }).status).toBe(0);
        expect(run(home, ['kimi']).status).toBe(0);
        expect(settings(home).env.ANTHROPIC_API_KEY).toBe('new-key');
    });

    it('official идёт через прокси, сторонние каналы — мимо него с прежними исключениями', () => {
        const home = homeWith();
        const shell = {
            HTTPS_PROXY: 'http://127.0.0.1:8118',
            NO_PROXY: 'localhost,github.com',
            KIMI_CODE_API_KEY: 'test-kimi-key',
        };
        expect(run(home, ['kimi'], shell).status).toBe(0);
        expect(settings(home).env.NO_PROXY).toBe('localhost,github.com,api.kimi.ai');
        // Прокси для остального трафика сессии остаётся, мимо идёт только хост канала.
        expect(settings(home).env.HTTPS_PROXY).toBe('http://127.0.0.1:8118');

        expect(run(home, ['official'], shell).status).toBe(0);
        expect(settings(home).env).toEqual({
            HTTPS_PROXY: 'http://127.0.0.1:8118',
            HTTP_PROXY: 'http://127.0.0.1:8118',
            NO_PROXY: 'localhost,github.com',
            no_proxy: 'localhost,github.com',
        });
        // Прокси запомнен: official из шелла без прокси всё равно идёт через него.
        expect(run(home, ['official']).status).toBe(0);
        expect(settings(home).env.HTTPS_PROXY).toBe('http://127.0.0.1:8118');
    });

    it('битое хранилище останавливает переключение и не трогает settings', () => {
        const home = homeWith({ env: { KEEP_ME: 'yes' } });
        const store = join(home, '.config', 'claude-channel');
        mkdirSync(store, { recursive: true });
        writeFileSync(join(store, 'channels.json'), '{');
        const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
        const result = run(home, ['official']);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('channel store is not valid JSON');
        expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);
    });

    it('official снимает исключения Anthropic из NO_PROXY, чтобы не уйти мимо туннеля', () => {
        const home = homeWith();
        const result = run(home, ['official'], {
            HTTPS_PROXY: 'http://127.0.0.1:8118',
            NO_PROXY: 'localhost,api.anthropic.com,.anthropic.com,*',
            no_proxy: 'claude.ai,github.com',
        });

        expect(result.status, result.stderr).toBe(0);
        expect(settings(home).env.NO_PROXY).toBe('localhost,github.com');
        expect(settings(home).env.no_proxy).toBe('localhost,github.com');
    });

    it('прокси, записанный только в settings, переживает переключения', () => {
        const home = homeWith({ env: { HTTPS_PROXY: 'http://10.0.0.1:3128' } });
        expect(run(home, ['kimi'], { KIMI_CODE_API_KEY: 'test-kimi-key' }).status).toBe(0);
        expect(settings(home).env.HTTPS_PROXY).toBe('http://10.0.0.1:3128');
        expect(run(home, ['official']).status).toBe(0);
        expect(settings(home).env.HTTPS_PROXY).toBe('http://10.0.0.1:3128');
    });

    it('пароль прокси не печатается в терминал', () => {
        const home = homeWith();
        const result = run(home, ['official'], {
            HTTPS_PROXY: 'http://user:s3cret-pass@proxy.example.com:3128',
        });

        expect(result.status).toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toContain('s3cret-pass');
        expect(run(home, []).stdout).not.toContain('s3cret-pass');
    });

    it('битое хранилище не цитирует своё содержимое в ошибке', () => {
        const home = homeWith();
        const dir = join(home, '.config', 'claude-channel');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'channels.json'), '{"values":{"KIMI_CODE_API_KEY":"sk-leak-me"');
        const result = run(home, []);

        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain('sk-leak-me');
    });

    it('права хранилища чинятся, даже если значения не менялись', () => {
        const home = homeWith();
        run(home, [], { KIMI_CODE_API_KEY: 'test-kimi-key' });
        const store = join(home, '.config', 'claude-channel', 'channels.json');
        chmodSync(store, 0o644);
        chmodSync(join(home, '.config', 'claude-channel'), 0o755);
        run(home, []);

        expect(statSync(store).mode & 0o777).toBe(0o600);
        expect(statSync(join(home, '.config', 'claude-channel')).mode & 0o777).toBe(0o700);
    });

    it('занятый замок — отказ без записи, протухший — снимается', () => {
        const home = homeWith({ env: { KEEP_ME: 'yes' } });
        const dir = join(home, '.config', 'claude-channel');
        mkdirSync(dir, { recursive: true });
        const lock = join(dir, '.switch.lock');
        writeFileSync(lock, '');
        const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
        const busy = run(home, ['official'], { CLAUDE_CHANNEL_LOCK_WAIT_MS: '100' });

        expect(busy.status).toBe(1);
        expect(busy.stderr).toContain('another switch is running');
        expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);

        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);
        expect(run(home, ['official'], { CLAUDE_CHANNEL_LOCK_WAIT_MS: '100' }).status).toBe(0);
        expect(existsSync(lock)).toBe(false);
    });

    it('--help работает даже при битом settings и перечисляет все каналы', () => {
        const home = homeWith();
        writeFileSync(join(home, '.claude', 'settings.json'), '{');
        const result = run(home, ['--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('official|cheap|cheap-direct|kimi');
    });
});

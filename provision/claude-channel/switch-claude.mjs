#!/usr/bin/env node
/**
 * Переключает глобальный Claude Code между официальным каналом, локальными шлюзами и
 * Kimi Code. Значения частных шлюзов приходят из окружения: helper лежит в публичном
 * репозитории и не должен превращаться в копию конфига одной машины.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANAGED_VARS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
];

function requiredEnv(env, name) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`env ${name} not set`);
    return value;
}

function gatewayProfile(env, baseUrlEnv) {
    const opus = env.CLAUDE_CHEAP_OPUS_MODEL || 'claude-opus-5-5';
    const sonnet = env.CLAUDE_CHEAP_SONNET_MODEL || 'claude-sonnet-5';
    const haiku = env.CLAUDE_CHEAP_HAIKU_MODEL || 'claude-haiku-4-5';
    return {
        ANTHROPIC_BASE_URL: requiredEnv(env, baseUrlEnv),
        ANTHROPIC_AUTH_TOKEN: requiredEnv(env, 'ROUTER_CHEAP_KEY'),
        ANTHROPIC_MODEL: opus,
        ANTHROPIC_DEFAULT_FABLE_MODEL: opus,
        ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
        ANTHROPIC_SMALL_FAST_MODEL: haiku,
    };
}

function kimiProfile(env) {
    // 1M — вариант Kimi для тарифов Pro и выше; на Plus окно k3.1-pro только 256K, и модель
    // с окном задаются переменными (README). Claude Code принимает у AUTO_COMPACT_WINDOW
    // не более десятичного миллиона: 1048576 уже даёт warning при старте.
    const model = env.CLAUDE_KIMI_MODEL || 'k3.1-pro[1m]';
    const contextTokens = env.CLAUDE_KIMI_CONTEXT_TOKENS || '1000000';
    const effort = env.CLAUDE_KIMI_EFFORT_LEVEL || 'high';
    return {
        ANTHROPIC_BASE_URL: env.CLAUDE_KIMI_BASE_URL || 'https://api.kimi.ai/coding/',
        ANTHROPIC_API_KEY: requiredEnv(env, 'KIMI_CODE_API_KEY'),
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_FABLE_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_EFFORT_LEVEL: effort,
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: contextTokens,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextTokens,
    };
}

const PROFILES = {
    official: () => null,
    cheap: (env) => gatewayProfile(env, 'CLAUDE_CHEAP_BASE_URL'),
    'cheap-direct': (env) => gatewayProfile(env, 'CLAUDE_CHEAP_DIRECT_BASE_URL'),
    kimi: kimiProfile,
};

function usage() {
    return [
        'Usage: switch-claude.mjs [official|cheap|cheap-direct|kimi]',
        '       switch-claude.mjs              # show current channel',
        '',
        'Required profile env:',
        '  cheap        CLAUDE_CHEAP_BASE_URL + ROUTER_CHEAP_KEY',
        '  cheap-direct CLAUDE_CHEAP_DIRECT_BASE_URL + ROUTER_CHEAP_KEY',
        '  kimi         KIMI_CODE_API_KEY',
    ].join('\n');
}

function show(env) {
    return env?.ANTHROPIC_BASE_URL
        ? `${env.ANTHROPIC_BASE_URL} (${env.ANTHROPIC_MODEL ?? 'default model'})`
        : 'official (subscription)';
}

function readSettings(settingsPath) {
    const exists = fs.existsSync(settingsPath);
    const raw = exists ? fs.readFileSync(settingsPath, 'utf8') : '{}';
    let cfg;
    try {
        cfg = JSON.parse(raw.replace(/^﻿/, ''));
    } catch (error) {
        throw new Error(`settings.json is not valid JSON: ${error.message}`);
    }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('settings.json root must be an object');
    }
    if (
        cfg.env !== undefined &&
        (cfg.env === null || typeof cfg.env !== 'object' || Array.isArray(cfg.env))
    ) {
        throw new Error('settings.json env must be an object');
    }
    return { cfg, exists, raw };
}

function writePrivate(file, contents) {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}

function writeSettings(settingsPath, cfg, exists, raw) {
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (exists) writePrivate(`${settingsPath}.channel-switch.bak`, raw);

    const tmp = `${settingsPath}.channel-switch.${process.pid}.tmp`;
    try {
        writePrivate(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
        fs.renameSync(tmp, settingsPath);
        fs.chmodSync(settingsPath, 0o600);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

export function main(options = {}) {
    const args = options.args ?? process.argv.slice(2);
    const processEnv = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const stdout = options.stdout ?? console.log;
    const stderr = options.stderr ?? console.error;
    const settingsPath =
        processEnv.CLAUDE_SETTINGS_FILE || path.join(home, '.claude', 'settings.json');
    if (args.includes('--help') || args.includes('-h')) {
        stdout(usage());
        return 0;
    }
    if (args.length > 1) {
        stderr(usage());
        return 1;
    }

    try {
        const { cfg, exists, raw } = readSettings(settingsPath);
        const name = args[0];
        if (!name) {
            stdout(`Current: ${show(cfg.env)}`);
            return 0;
        }
        if (!Object.hasOwn(PROFILES, name)) {
            throw new Error(
                `unknown profile '${name}'. Available: ${Object.keys(PROFILES).join(', ')}`,
            );
        }

        const nextEnv = Object.fromEntries(
            Object.entries(cfg.env ?? {}).filter(([key]) => !MANAGED_VARS.includes(key)),
        );
        const profileEnv = PROFILES[name](processEnv);
        if (profileEnv) Object.assign(nextEnv, profileEnv);

        if (Object.keys(nextEnv).length > 0) cfg.env = nextEnv;
        else delete cfg.env;

        writeSettings(settingsPath, cfg, exists, raw);
        stdout(`✓ Claude Code → ${show(cfg.env)}`);
        stdout('New sessions will use this channel. Restart open sessions to apply.');
        return 0;
    } catch (error) {
        stderr(`Error: ${error.message}`);
        return 1;
    }
}

function isMain() {
    if (!process.argv[1]) return false;
    try {
        return fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename);
    } catch {
        return false;
    }
}

if (isMain()) process.exitCode = main();

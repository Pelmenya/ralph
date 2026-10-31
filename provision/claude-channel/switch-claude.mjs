#!/usr/bin/env node
/**
 * Переключает глобальный Claude Code между официальным каналом, локальными шлюзами и
 * Kimi Code. Значения частных шлюзов приходят из окружения или из локального хранилища
 * машины: helper лежит в публичном репозитории и не должен превращаться в копию конфига.
 *
 * Сеть: официальный API из региона машины отвечает 403 без прокси, поэтому `official`
 * явно пишет прокси в settings. Сторонним каналам прокси не нужен, через него они только
 * медленнее — их хост дописывается в NO_PROXY. Остальной трафик Claude Code (телеметрия,
 * MCP) идёт как раньше.
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
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'no_proxy',
];

// Значения, которые достаточно один раз увидеть в окружении: дальше helper берёт их из
// хранилища, и переключение работает из любого шелла — без export ключей заново.
const STORED_VARS = [
    'ROUTER_CHEAP_KEY',
    'CLAUDE_CHEAP_BASE_URL',
    'CLAUDE_CHEAP_DIRECT_BASE_URL',
    'KIMI_CODE_API_KEY',
    'CLAUDE_KIMI_BASE_URL',
    'CLAUDE_OFFICIAL_PROXY',
];

const KIMI_DEFAULT_BASE_URL = 'https://api.kimi.ai/coding/';

function resolver(env, store) {
    return (name) => env[name]?.trim() || store.values[name]?.trim() || undefined;
}

function requiredValue(get, name) {
    const value = get(name);
    if (!value) throw new Error(`env ${name} not set`);
    return value;
}

// Исключения прокси, которые увели бы официальный API мимо туннеля: обёртка claude
// проверяет egress по стороннему адресу и такой обход не заметит.
const ANTHROPIC_HOSTS = /^(\*|(.*\.)?anthropic\.com|(.*\.)?claude\.ai)$/;

/** Хост записи NO_PROXY без ведущей точки и порта: `.anthropic.com`, `api.anthropic.com:443`. */
function bareHost(item) {
    return item.toLowerCase().replace(/^\./, '').replace(/:\d+$/, '');
}

/** NO_PROXY поверх базового списка шелла: значение из settings перекрывает шелловое
 *  целиком, поэтому прежние исключения (git, npm) обязаны переехать с ним. Исключения
 *  Anthropic снимаются всегда, хост стороннего канала — добавляется. */
function noProxyEnv(env, extraHost) {
    const base = `${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`.split(',');
    const hosts = [...base, extraHost ?? '']
        .map((item) => item.trim())
        .filter((item) => item && !ANTHROPIC_HOSTS.test(bareHost(item)));
    const value = [...new Set(hosts)].join(',');
    // Пустое значение пишется явно, если в шелле что-то было: иначе отфильтрованное
    // исключение Anthropic унаследовалось бы из окружения.
    const inherited = Boolean(env.NO_PROXY?.trim() || env.no_proxy?.trim());
    return value || inherited ? { NO_PROXY: value, no_proxy: value } : {};
}

/** Прокси official: шелл сильнее хранилища — им же обёртка claude проверяет egress, и
 *  иначе проверялся бы один маршрут, а Claude получал другой. Последний запасной —
 *  прокси, уже записанный в settings, чтобы переключение его не стирало. */
function officialProxy(env, get, currentEnv = {}) {
    return (
        env.CLAUDE_OFFICIAL_PROXY?.trim() ||
        env.HTTPS_PROXY?.trim() ||
        get('CLAUDE_OFFICIAL_PROXY') ||
        currentEnv.HTTPS_PROXY?.trim() ||
        undefined
    );
}

function proxyEnv(env, get, currentEnv = {}) {
    const proxy = officialProxy(env, get, currentEnv);
    if (!proxy) {
        const kept = currentEnv.HTTP_PROXY?.trim();
        return kept ? { HTTP_PROXY: kept } : {};
    }
    // Отдельно заданный HTTP-прокси — чужое решение о маршруте, его не подменяем.
    const httpProxy = env.HTTP_PROXY?.trim() || currentEnv.HTTP_PROXY?.trim() || proxy;
    return { HTTPS_PROXY: proxy, HTTP_PROXY: httpProxy };
}

function officialProfile(env, get, currentEnv) {
    return { ...proxyEnv(env, get, currentEnv), ...noProxyEnv(env) };
}

/** Сторонний канал — напрямую, но прокси для остального трафика сессии (MCP,
 *  телеметрия) остаётся тем же, что у official. */
function directEnv(env, get, currentEnv, baseUrl) {
    return {
        ...proxyEnv(env, get, currentEnv),
        ...noProxyEnv(env, new URL(baseUrl).hostname),
    };
}

function gatewayProfile(env, get, currentEnv, baseUrlVar) {
    const baseUrl = requiredValue(get, baseUrlVar);
    const opus = env.CLAUDE_CHEAP_OPUS_MODEL || 'claude-opus-5-5';
    const sonnet = env.CLAUDE_CHEAP_SONNET_MODEL || 'claude-sonnet-5';
    const haiku = env.CLAUDE_CHEAP_HAIKU_MODEL || 'claude-haiku-4-5';
    return {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: requiredValue(get, 'ROUTER_CHEAP_KEY'),
        ANTHROPIC_MODEL: opus,
        ANTHROPIC_DEFAULT_FABLE_MODEL: opus,
        ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
        ANTHROPIC_SMALL_FAST_MODEL: haiku,
        ...directEnv(env, get, currentEnv, baseUrl),
    };
}

function kimiProfile(env, get, currentEnv = {}) {
    // Основной кодер и дорогой expert разведены по алиасам Claude Code: иначе любая фоновая
    // задача расходует квоту флагмана. Оба дефолта держат 1M, поэтому compact остаётся общим.
    // Claude Code принимает у AUTO_COMPACT_WINDOW не более десятичного миллиона: 1048576
    // уже даёт warning при старте.
    const model = env.CLAUDE_KIMI_MODEL || 'kimi-for-coding';
    const expertModel = env.CLAUDE_KIMI_EXPERT_MODEL || 'k3.1-pro[1m]';
    const contextTokens = env.CLAUDE_KIMI_CONTEXT_TOKENS || '1000000';
    const effort = env.CLAUDE_KIMI_EFFORT_LEVEL || 'high';
    const baseUrl = get('CLAUDE_KIMI_BASE_URL') || KIMI_DEFAULT_BASE_URL;
    // Ключ из активного settings берём, только если он выписан этому же endpoint: ключ
    // чужого шлюза в Kimi не уезжает.
    const activeKey =
        currentEnv.ANTHROPIC_BASE_URL === baseUrl ? currentEnv.ANTHROPIC_API_KEY : undefined;
    const apiKey = get('KIMI_CODE_API_KEY') || activeKey?.trim();
    if (!apiKey) throw new Error('env KIMI_CODE_API_KEY not set');
    return {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_FABLE_MODEL: expertModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: expertModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_EFFORT_LEVEL: effort,
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: contextTokens,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextTokens,
        ...directEnv(env, get, currentEnv, baseUrl),
    };
}

const PROFILES = {
    official: officialProfile,
    cheap: (env, get, current) => gatewayProfile(env, get, current, 'CLAUDE_CHEAP_BASE_URL'),
    'cheap-direct': (env, get, current) =>
        gatewayProfile(env, get, current, 'CLAUDE_CHEAP_DIRECT_BASE_URL'),
    kimi: kimiProfile,
};

function usage() {
    return [
        'Usage: switch-claude.mjs [official|cheap|cheap-direct|kimi]',
        '       switch-claude.mjs              # show current channel and ready profiles',
        '',
        'Profile values (env once, then the local store):',
        '  official     CLAUDE_OFFICIAL_PROXY or HTTPS_PROXY (optional)',
        '  cheap        CLAUDE_CHEAP_BASE_URL + ROUTER_CHEAP_KEY',
        '  cheap-direct CLAUDE_CHEAP_DIRECT_BASE_URL + ROUTER_CHEAP_KEY',
        '  kimi         KIMI_CODE_API_KEY',
    ].join('\n');
}

/** Учётные данные в URL (user:password@) в терминал не печатаются. */
function maskUrl(value) {
    try {
        const url = new URL(value);
        if (!url.username && !url.password) return value;
        url.username = '***';
        url.password = '';
        return url.toString();
    } catch {
        return '<unparsable url>';
    }
}

function show(env) {
    const via = env?.HTTPS_PROXY ? ` via ${maskUrl(env.HTTPS_PROXY)}` : '';
    return env?.ANTHROPIC_BASE_URL
        ? `${maskUrl(env.ANTHROPIC_BASE_URL)} (${env.ANTHROPIC_MODEL ?? 'default model'}, direct)`
        : `official (subscription${via})`;
}

function readJsonObject(file, label) {
    const exists = fs.existsSync(file);
    const raw = exists ? fs.readFileSync(file, 'utf8') : '{}';
    let cfg;
    try {
        cfg = JSON.parse(raw.replace(/^﻿/, ''));
    } catch {
        // Сообщение JSON.parse цитирует кусок исходника — а в этих файлах лежат ключи.
        throw new Error(`${label} is not valid JSON`);
    }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error(`${label} root must be an object`);
    }
    return { cfg, exists, raw };
}

function readSettings(settingsPath) {
    const result = readJsonObject(settingsPath, 'settings.json');
    const { env } = result.cfg;
    if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
        throw new Error('settings.json env must be an object');
    }
    return result;
}

/** Права хранилища чинятся на каждом запуске: после копирования или восстановления
 *  файл мог стать читаемым всем, а пишем мы его только при изменении значений. */
function securePrivate(file) {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    const dir = path.dirname(file);
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
}

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

/** Чтение-изменение-запись хранилища и settings под одним замком: два параллельных
 *  запуска иначе теряют ключи друг друга — атомарный rename бережёт JSON, не данные.
 *  Замок несёт pid и метку владельца. Чужой снимается только если его процесс мёртв, а
 *  снятие идёт переименованием: из двух конкурентов его выигрывает один. Остаточная гонка —
 *  два запуска одновременно над замком упавшего процесса — для ручного CLI приемлема. */
function withLock(lockPath, waitMs, fn) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            fs.writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
            break;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() > deadline) throw new Error(`another switch is running (${lockPath})`);
            let owner = '';
            try {
                owner = fs.readFileSync(lockPath, 'utf8');
            } catch (readError) {
                if (readError.code === 'ENOENT') continue; // замок только что сняли
                throw readError;
            }
            const pid = Number(owner.split(':')[0]);
            if (owner && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
                const stale = `${lockPath}.stale.${token.replace(/:/g, '-')}`;
                try {
                    fs.renameSync(lockPath, stale);
                    fs.rmSync(stale, { force: true });
                } catch (renameError) {
                    // ENOENT — переименовал другой конкурент; прочее — постоянный отказ
                    if (renameError.code !== 'ENOENT') throw renameError;
                }
                continue;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    try {
        return fn();
    } finally {
        // Снимаем только свой замок: чужой мог появиться, если наш сочли мёртвым.
        try {
            if (fs.readFileSync(lockPath, 'utf8') === token) fs.rmSync(lockPath, { force: true });
        } catch {
            // замка уже нет
        }
    }
}

function readStore(storePath) {
    const { cfg } = readJsonObject(storePath, 'channel store');
    const values =
        cfg.values && typeof cfg.values === 'object' && !Array.isArray(cfg.values)
            ? cfg.values
            : {};
    return { values };
}

function writePrivate(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.channel-switch.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, contents, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

/** Новые значения из окружения оседают в хранилище; пишем только при изменении. */
function harvest(env, store, storePath, currentEnv = {}) {
    let changed = false;
    // Прокси шелла запоминается как прокси official: сессию могут поднять из окружения
    // без profile.d (systemd, старый tmux), а без прокси официальный API отвечает 403.
    // Нет его ни в шелле, ни в хранилище — берём уже записанный в settings.
    const proxy =
        env.CLAUDE_OFFICIAL_PROXY ||
        env.HTTPS_PROXY ||
        (store.values.CLAUDE_OFFICIAL_PROXY ? undefined : currentEnv.HTTPS_PROXY);
    const seen = { ...env, CLAUDE_OFFICIAL_PROXY: proxy };
    for (const name of STORED_VARS) {
        const value = seen[name]?.trim();
        if (value && store.values[name] !== value) {
            store.values[name] = value;
            changed = true;
        }
    }
    if (changed) writePrivate(storePath, `${JSON.stringify(store, null, 2)}\n`);
}

function readiness(env, get, currentEnv) {
    return Object.keys(PROFILES).map((name) => {
        try {
            PROFILES[name](env, get, currentEnv);
            return `  ${name.padEnd(12)} ready`;
        } catch (error) {
            return `  ${name.padEnd(12)} missing ${error.message.replace(/^env | not set$/g, '')}`;
        }
    });
}

export function main(options = {}) {
    const args = options.args ?? process.argv.slice(2);
    const processEnv = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const stdout = options.stdout ?? console.log;
    const stderr = options.stderr ?? console.error;
    const settingsPath =
        processEnv.CLAUDE_SETTINGS_FILE || path.join(home, '.claude', 'settings.json');
    const storePath =
        processEnv.CLAUDE_CHANNEL_STORE ||
        path.join(home, '.config', 'claude-channel', 'channels.json');
    if (args.includes('--help') || args.includes('-h')) {
        stdout(usage());
        return 0;
    }
    if (args.length > 1) {
        stderr(usage());
        return 1;
    }

    try {
        const name = args[0];
        if (name && !Object.hasOwn(PROFILES, name)) {
            throw new Error(
                `unknown profile '${name}'. Available: ${Object.keys(PROFILES).join(', ')}`,
            );
        }
        const lockPath = path.join(path.dirname(storePath), '.switch.lock');
        const waitMs = Number(processEnv.CLAUDE_CHANNEL_LOCK_WAIT_MS) || 5000;
        return withLock(lockPath, waitMs, () => {
            securePrivate(storePath);
            const { cfg, exists, raw } = readSettings(settingsPath);
            const store = readStore(storePath);
            harvest(processEnv, store, storePath, cfg.env);
            const get = resolver(processEnv, store);
            if (!name) {
                stdout(`Current: ${show(cfg.env)}`);
                stdout(['Profiles:', ...readiness(processEnv, get, cfg.env)].join('\n'));
                return 0;
            }

            const nextEnv = Object.fromEntries(
                Object.entries(cfg.env ?? {}).filter(([key]) => !MANAGED_VARS.includes(key)),
            );
            Object.assign(nextEnv, PROFILES[name](processEnv, get, cfg.env));
            if (Object.keys(nextEnv).length > 0) cfg.env = nextEnv;
            else delete cfg.env;

            if (exists) writePrivate(`${settingsPath}.channel-switch.bak`, raw);
            writePrivate(settingsPath, `${JSON.stringify(cfg, null, 2)}\n`);
            stdout(`✓ Claude Code → ${show(cfg.env)}`);
            const shellProxy = processEnv.HTTPS_PROXY?.trim();
            if (name === 'official' && shellProxy && cfg.env?.HTTPS_PROXY !== shellProxy) {
                stderr(
                    'Warning: CLAUDE_OFFICIAL_PROXY differs from HTTPS_PROXY — the claude ' +
                        'wrapper checks egress through HTTPS_PROXY, not the proxy written here.',
                );
            }
            stdout('New sessions will use this channel. Restart open sessions to apply.');
            return 0;
        });
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

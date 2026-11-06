#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const version = '__CLI_VERSION__';
if (process.argv.includes('--version')) {
    console.log(version);
    process.exit(0);
}

const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? '';
const home = process.env.KIMI_CODE_HOME;
if (!home) throw new Error('fixture CLI: KIMI_CODE_HOME не задан');
const ext = dirname(home);
const config = readFileSync(join(home, 'config.toml'), 'utf8');
const baseUrl = /base_url = "([^"]+)"/.exec(config)?.[1];
if (!baseUrl) throw new Error('fixture CLI: адрес провайдера не найден');

const probe = prompt.includes('ralph-stand-ok')
    ? 'short-session'
    : prompt.includes('cfg/hooks.json')
      ? 'symlink-parent'
      : prompt.includes('notes.txt')
        ? 'symlink-env'
        : prompt.includes('mv .claude/ralph')
          ? 'move-dir'
          : prompt.includes('glob **/.env')
            ? 'search-deep-glob'
            : prompt.includes('glob *.env')
              ? 'search-glob'
              : prompt.includes('pattern ralph-stand-allowed')
                ? 'search-clean'
                : prompt.includes('STAND_SECRET')
                  ? 'search-root'
                  : prompt.includes('Call the MCP tool') && prompt.includes('_write')
                    ? 'mcp-write'
                    : prompt.includes('Call the MCP tool') && prompt.includes('key .env')
                      ? 'mcp-env-param'
                      : prompt.includes('Call the MCP tool') && prompt.includes('key k')
                        ? 'mcp-read'
                        : prompt.includes('touch ralph-stand-allowed')
                          ? 'merge'
                          : prompt.includes('touch ralph-stand-forbidden')
                            ? 'block'
                            : 'unknown-tool';

const tools = [
    {
        type: 'function',
        function: {
            name: 'Bash',
            parameters: {
                properties: { command: { type: 'string' }, timeout: { type: 'number' } },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'Read',
            parameters: { properties: { path: { type: 'string' } }, required: ['path'] },
        },
    },
];
const body = JSON.stringify({ messages: [{ role: 'user', content: prompt }], tools });
await new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/chat/completions`, { method: 'POST' }, (res) => {
        res.resume();
        res.on('end', resolve);
    });
    req.on('error', reject);
    req.end(body);
});

const grep = (glob) => ({
    pattern: 'STAND_SECRET',
    path: '.',
    output_mode: 'content',
    '-n': true,
    ...(glob ? { glob } : {}),
});
const eventFor = {
    block: { tool_name: 'Bash', tool_input: { command: 'touch ralph-stand-forbidden' } },
    merge: { tool_name: 'Bash', tool_input: { command: 'touch ralph-stand-allowed' } },
    'session-context': { tool_name: 'Bash', tool_input: { command: 'true' } },
    'unknown-tool': { tool_name: 'Bash', tool_input: { command: 'touch ralph-stand-forbidden' } },
    'symlink-env': { tool_name: 'Read', tool_input: { path: 'notes.txt' } },
    'symlink-parent': {
        tool_name: 'Write',
        tool_input: { path: 'cfg/hooks.json', content: '{"mcp":{}}' },
    },
    'move-dir': { tool_name: 'Bash', tool_input: { command: 'mv .claude/ralph ralph-old' } },
    'search-root': { tool_name: 'Grep', tool_input: grep() },
    'search-glob': { tool_name: 'Grep', tool_input: grep('*.env') },
    'search-deep-glob': { tool_name: 'Grep', tool_input: grep('**/.env') },
    'search-clean': {
        tool_name: 'Bash',
        tool_input: { command: 'grep -R -n ralph-stand-allowed src' },
    },
    'mcp-write': {
        tool_name: 'mcp__ralph-stand__stand_write',
        tool_input: { key: 'k', value: 'ralph-stand-forbidden' },
    },
    'mcp-env-param': { tool_name: 'mcp__ralph-stand__stand_read', tool_input: { key: '.env' } },
    'mcp-read': { tool_name: 'mcp__ralph-stand__stand_read', tool_input: { key: 'k' } },
};

if (probe === 'short-session') {
    console.log('ralph-stand-ok');
} else {
    const event = {
        hook_event_name: 'PreToolUse',
        session_id: `session-${version}`,
        client_type: 'kimi_code_cli',
        tool_call_id: `tool-${version}`,
        cwd: process.cwd(),
        ...eventFor[probe],
    };
    const input = JSON.stringify(event);
    for (const match of config.matchAll(/command = "([^"]+)"/g)) {
        const result = spawnSync('sh', ['-c', match[1]], {
            input,
            encoding: 'utf8',
            env: process.env,
        });
        if (result.stderr)
            process.stderr.write(
                result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n',
            );
    }
    if (probe === 'search-clean') console.log('const marker = "ralph-stand-allowed";');
    if (probe === 'mcp-read') {
        appendFileSync(join(ext, 'mcp.jsonl'), '{"tool":"stand_read","args":{"key":"k"}}\n');
        console.log('ralph-stand-value');
    }
}

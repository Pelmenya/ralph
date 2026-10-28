import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ESCAPE_PROBE_SOURCE,
    HUMAN_CLI_HOMES,
    configSurfaces,
    escapeTargets,
    extraReadOnly,
    isolatedCommand,
    isolationAvailable,
    isolationList,
    judgeIsolation,
    layoutStand,
    namespaceArgv,
    parseCheckArgs,
    parseExecArgs,
    runChild,
    runIsolationCheck,
    snapshotHumanConfigs,
    standEnv,
    type TEscapeTarget,
} from './stand.mts';

const cleanups: string[] = [];
afterEach(() => {
    for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(d);
    return d;
}

describe('раскладка и окружение стенда', () => {
    it('безопасные цели внутри стенда: фиктивные .env, данные контура, поверхности конфига каждого CLI', () => {
        const root = tmp('ralph-stand-t.');
        const l = layoutStand(root);
        for (const rel of [
            '.env',
            '.claude/ralph/hooks.json',
            '.claude/settings.json',
            '.mcp.json',
            '.codex/config.toml',
            'opencode.json',
            '.opencode/opencode.json',
        ]) {
            expect(existsSync(join(l.work, rel)), rel).toBe(true);
        }
        expect(readFileSync(join(l.work, '.env'), 'utf-8')).toContain('ralph-stand-fake-secret');
        expect(l.targets.every((t) => t.startsWith(root + '/'))).toBe(true);
        const mcp = JSON.parse(readFileSync(l.mcpConfig, 'utf-8'));
        expect(mcp.mcpServers['ralph-stand'].args).toEqual([
            join(import.meta.dirname, 'fake-mcp.mts'),
            l.mcpJournal,
        ]);
    });

    it('поверхности конфига берутся из описаний пакетов; ни одной — отказ', () => {
        expect(configSurfaces()).toEqual(
            expect.arrayContaining(['.claude/settings.json', '.codex/config.toml']),
        );
        expect(() => configSurfaces(tmp('ralph-empty.'))).not.toThrow();
        const noDir = join(tmp('ralph-x.'), 'none');
        expect(() => configSurfaces(noDir)).toThrow();
    });

    it('окружение собрано с нуля: дома CLI, XDG и TMPDIR — внутри стенда, ключи только названные', () => {
        const l = layoutStand(tmp('ralph-stand-t.'), []);
        process.env.RALPH_STAND_TEST_LEAK = 'leak';
        try {
            const env = standEnv(l, { path: '/usr/bin', passEnv: { KEY: 'v' }, proxyPort: 18080 });
            for (const k of [
                'HOME',
                'TMPDIR',
                'XDG_CONFIG_HOME',
                'XDG_CACHE_HOME',
                'XDG_DATA_HOME',
                'XDG_STATE_HOME',
                'XDG_RUNTIME_DIR',
                'CLAUDE_CONFIG_DIR',
                'CODEX_HOME',
                'KIMI_CODE_HOME',
                'OPENCODE_CONFIG_DIR',
            ]) {
                expect(env[k].startsWith(l.root + '/'), k).toBe(true);
            }
            expect(env.RALPH_STAND_TEST_LEAK).toBeUndefined();
            expect(env.KEY).toBe('v');
            expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:18080');
            expect(standEnv(l, { path: '/usr/bin' }).HTTPS_PROXY).toBeUndefined();
        } finally {
            delete process.env.RALPH_STAND_TEST_LEAK;
        }
    });

    it('без root — ещё user namespace; список путей только абсолютный и без пробелов', () => {
        expect(namespaceArgv(0)).not.toContain('--map-root-user');
        expect(namespaceArgv(1000)).toContain('--map-root-user');
        expect(namespaceArgv(0)).toEqual(
            expect.arrayContaining(['--mount', '--net', '--pid', '--ipc', '--uts', '--cgroup']),
        );
        expect(isolationList(['/a'], [{ src: '/k', dst: '/s/home/k' }])).toBe(
            'ro /a\nbind /k /s/home/k\n',
        );
        expect(() => isolationList(['rel'], [])).toThrow();
        expect(() => isolationList(['/a b'], [])).toThrow();
    });

    it('путь на чтение, накрывающий стенд, — отказ с именем; сосед по префиксу имени — нет', () => {
        const st = ['/tmp/ralph-stand.x'];
        for (const p of ['/', '/tmp', '/tmp/', '/tmp/ralph-stand.x'])
            expect(() => isolationList([p], [], st), p).toThrow(/накрывает каталог стенда/);
        expect(isolationList(['/tmp/ralph-stand', '/tmp/ralph-stand.x/bin'], [], st)).toBe(
            'ro /tmp/ralph-stand\nro /tmp/ralph-stand.x/bin\n',
        );
    });

    it('файл на чтение едет файлом, а не каталогом; путь внутри названного каталога — отброшен', () => {
        const d = tmp('ralph-ro.');
        mkdirSync(join(d, 'bin'));
        writeFileSync(join(d, 'bin', 'cli'), '');
        writeFileSync(join(d, 'bin', 'key'), '');
        symlinkSync(join(d, 'bin', 'cli'), join(d, 'link'));
        expect(extraReadOnly([join(d, 'link')])).toEqual([join(d, 'bin', 'cli')]);
        expect(extraReadOnly([join(d, 'bin', 'cli'), join(d, 'bin')])).toEqual([join(d, 'bin')]);
        expect(extraReadOnly(['/usr/bin', join(d, 'bin', 'key')])).toEqual([join(d, 'bin', 'key')]);
    });

    it('раскладка — только на чистое место: каталог прошлого прогона отвергнут, симлинк не пройден', () => {
        const root = tmp('ralph-stand-t.');
        const human = join(tmp('ralph-human.'), 'bashrc');
        writeFileSync(human, 'human\n');
        mkdirSync(join(root, 'work'));
        symlinkSync(human, join(root, 'work', '.env'));
        expect(() => layoutStand(root, [])).toThrow(/уже есть work/);
        expect(readFileSync(human, 'utf-8')).toBe('human\n');
        const again = tmp('ralph-stand-t.');
        symlinkSync(human, join(again, 'mcp.json'));
        expect(() => layoutStand(again, [])).toThrow(/уже есть mcp\.json/);
        expect(readFileSync(human, 'utf-8')).toBe('human\n');
        const fresh = tmp('ralph-stand-t.');
        layoutStand(fresh, []);
        expect(() => layoutStand(fresh, [])).toThrow(/раскладка прошлого прогона/);
    });

    it('разбор exec: незнакомый флаг, незнакомый CLI и пустая команда — отказ', () => {
        const ok = parseExecArgs([
            '--stand',
            '/s',
            '--cli',
            'claude',
            '--allow',
            'h:1',
            '--bind',
            '/k:/s/k',
            '--',
            'x',
        ]);
        expect(ok).toMatchObject({
            cli: 'claude',
            allow: ['h:1'],
            binds: [{ src: '/k', dst: '/s/k' }],
            command: ['x'],
        });
        expect(() =>
            parseExecArgs(['--stand', '/s', '--cli', 'claude', '--net', 'all', '--', 'x']),
        ).toThrow(/незнакомый флаг/);
        expect(() => parseExecArgs(['--stand', '/s', '--cli', 'gpt', '--', 'x'])).toThrow(
            /незнакомый CLI/,
        );
        expect(() => parseExecArgs(['--stand', '/s', '--cli', 'claude'])).toThrow(/нет команды/);
        expect(() => parseExecArgs(['--cli', 'claude', '--', 'x'])).toThrow(/--stand/);
        expect(() => parseExecArgs(['--stand'])).toThrow(/нет значения/);
        expect(() =>
            parseExecArgs(['--stand', '/s', '--cli', 'claude', '--bind', '/k', '--', 'x']),
        ).toThrow(/--bind/);
        expect(() =>
            parseExecArgs(['--stand', '/s', '--cli', 'claude', '--bind', '/k:/s/k:ro', '--', 'x']),
        ).toThrow(/--bind <файл>:<путь в стенде>, а не \/k:\/s\/k:ro/);
        expect(ok.upstream).toBeNull();
        expect(
            parseExecArgs([
                '--stand',
                '/s',
                '--cli',
                'claude',
                '--upstream-proxy',
                'http://proxy.example.com:3128',
                '--',
                'x',
            ]).upstream,
        ).toEqual({ host: 'proxy.example.com', port: 3128, auth: null });
        expect(() =>
            parseExecArgs([
                '--stand',
                '/s',
                '--cli',
                'claude',
                '--upstream-proxy',
                'socks5://proxy.example.com:1080',
                '--',
                'x',
            ]),
        ).toThrow(/только http:/);
    });

    it('креды upstream — только переменной: в argv их видно в ps, и такой флаг — отказ', () => {
        const base = ['--stand', '/s', '--cli', 'claude'];
        let msg = '';
        try {
            parseExecArgs([
                ...base,
                '--upstream-proxy',
                'http://u:secret@p.example.com:1',
                '--',
                'x',
            ]);
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toMatch(/--upstream-proxy-env/);
        expect(msg).not.toContain('secret');
        const env = { UP: 'http://u:secret@p.example.com:1' };
        expect(
            parseExecArgs([...base, '--upstream-proxy-env', 'UP', '--', 'x'], env).upstream,
        ).toEqual({
            host: 'p.example.com',
            port: 1,
            auth: `Basic ${Buffer.from('u:secret').toString('base64')}`,
        });
        expect(() =>
            parseExecArgs([...base, '--upstream-proxy-env', 'NONE', '--', 'x'], {}),
        ).toThrow(/NONE для upstream не задана/);
    });

    it('check: --human-home без значения — отказ словами, без него — HOME', () => {
        expect(parseCheckArgs([], '/h')).toBe('/h');
        expect(parseCheckArgs(['--human-home', '/x'], '/h')).toBe('/x');
        expect(() => parseCheckArgs(['--human-home'], '/h')).toThrow(/нет значения/);
        expect(() => parseCheckArgs(['--human-home', '--other'], '/h')).toThrow(/нет значения/);
        expect(() => parseCheckArgs([], undefined)).toThrow(/нет HOME/);
    });

    it('незапустившаяся команда — отказ с причиной; смерть от сигнала — 128 + номер', async () => {
        const fake = (emit: (c: EventEmitter) => void) =>
            (() => {
                const c = new EventEmitter();
                setImmediate(() => emit(c));
                return c;
            }) as any;
        const cmd = { argv: ['unshare', '-x'], env: {} };
        await expect(
            runChild(
                cmd,
                fake((c) => c.emit('error', new Error('spawn unshare ENOENT'))),
            ),
        ).rejects.toThrow(/stand exec: unshare не запустился: spawn unshare ENOENT/);
        await expect(
            runChild(
                cmd,
                fake((c) => c.emit('exit', null, 'SIGKILL')),
            ),
        ).resolves.toBe(137);
        await expect(
            runChild(
                cmd,
                fake((c) => c.emit('exit', 3, null)),
            ),
        ).resolves.toBe(3);
    });
});

describe('вердикт проверки изоляции', () => {
    const targets: TEscapeTarget[] = [
        { path: '/s/work/in', kind: 'inside' },
        { path: '/out/x', kind: 'outside' },
        { path: '/h/.claude/x', kind: 'human-cli-home' },
    ];
    const same = { '.claude/settings.json': 'aa' };
    const host = (paths: string[]) => (p: string) => paths.includes(p);

    it('зелёный: внутри запись прошла, снаружи — отказ ОС, следа на хосте нет, хеши совпали', () => {
        const v = judgeIsolation({
            targets,
            results: [
                { path: '/s/work/in', code: 'written' },
                { path: '/out/x', code: 'EROFS' },
                { path: '/h/.claude/x', code: 'EACCES' },
            ],
            hostExists: host(['/s/work/in']),
            before: same,
            after: same,
        });
        expect(v).toMatchObject({ ok: true, failures: [] });
    });

    it('выход за пределы — красный даже при совпавших хешах', () => {
        const v = judgeIsolation({
            targets,
            results: [
                { path: '/s/work/in', code: 'written' },
                { path: '/out/x', code: 'written' },
                { path: '/h/.claude/x', code: 'EROFS' },
            ],
            hostExists: host(['/s/work/in', '/h/.claude/x']),
            before: same,
            after: same,
        });
        expect(v.ok).toBe(false);
        expect(v.failures.join('\n')).toMatch(/\/out\/x: запись изнутри прошла/);
        expect(v.failures.join('\n')).toMatch(/\/h\/\.claude\/x: файл появился на хосте/);
    });

    it('отказ не ОС (ENOENT) — не доказательство изоляции', () => {
        const v = judgeIsolation({
            targets,
            results: [
                { path: '/s/work/in', code: 'written' },
                { path: '/out/x', code: 'ENOENT' },
                { path: '/h/.claude/x', code: 'EROFS' },
            ],
            hostExists: host(['/s/work/in']),
            before: same,
            after: same,
        });
        expect(v.failures).toEqual(['/out/x: отказ ENOENT — не отказ ОС, изоляция не доказана']);
    });

    it('без парной разрешённой записи, без результатов и с разошедшимися хешами — красный', () => {
        const noInside = judgeIsolation({
            targets,
            results: [
                { path: '/s/work/in', code: 'EROFS' },
                { path: '/out/x', code: 'EROFS' },
                { path: '/h/.claude/x', code: 'EROFS' },
            ],
            hostExists: host([]),
            before: same,
            after: same,
        });
        expect(noInside.failures.join()).toMatch(/парной разрешённой пробы нет/);
        const empty = judgeIsolation({
            targets,
            results: [],
            hostExists: host([]),
            before: same,
            after: same,
        });
        expect(empty.failures[0]).toMatch(/не вернула результатов/);
        expect(empty.failures).toHaveLength(4);
        const drift = judgeIsolation({
            targets: [targets[0]],
            results: [{ path: '/s/work/in', code: 'written' }],
            hostExists: host(['/s/work/in']),
            before: same,
            after: { '.claude/settings.json': 'bb' },
        });
        expect(drift.failures).toEqual([
            'конфиг человека ~/.claude/settings.json изменился за прогон',
        ]);
    });

    it('цели пробы: парная внутри, рядом со стендом, системные и каждый дом CLI человека', () => {
        const l = layoutStand(tmp('ralph-stand-t.'), []);
        const t = escapeTargets(l, '/h', 'tag');
        expect(t[0]).toEqual({ path: join(l.work, 'ralph-stand-allowed-tag'), kind: 'inside' });
        for (const h of HUMAN_CLI_HOMES) {
            expect(t).toContainEqual({
                path: `/h/${h}/ralph-stand-escape-tag`,
                kind: 'human-cli-home',
            });
        }
        expect(t.filter((x) => x.kind === 'outside').map((x) => x.path)).toContain(
            '/var/tmp/ralph-stand-escape-tag',
        );
    });

    it('снимок конфигов: отсутствующий файл — absent, правка меняет хеш', () => {
        const h = tmp('ralph-human.');
        const a = snapshotHumanConfigs(h, ['.claude/settings.json']);
        expect(a).toEqual({ '.claude/settings.json': 'absent' });
        mkdirSync(join(h, '.claude'));
        writeFileSync(join(h, '.claude/settings.json'), '{}');
        const b = snapshotHumanConfigs(h, ['.claude/settings.json']);
        expect(b['.claude/settings.json']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('от противного: та же проба БЕЗ изоляции пишет наружу, и вердикт красный при совпавших хешах', () => {
        const outside = tmp('ralph-outside.');
        const human = tmp('ralph-human.');
        const l = layoutStand(tmp('ralph-stand-t.'), []);
        const targets: TEscapeTarget[] = [
            { path: join(l.work, 'in'), kind: 'inside' },
            { path: join(outside, 'x'), kind: 'outside' },
            { path: join(human, '.claude', 'x'), kind: 'human-cli-home' },
        ];
        const before = snapshotHumanConfigs(human);
        const r = spawnSync(
            process.execPath,
            ['-e', ESCAPE_PROBE_SOURCE, JSON.stringify(targets.map((t) => t.path))],
            {
                encoding: 'utf-8',
            },
        );
        const v = judgeIsolation({
            targets,
            results: JSON.parse(r.stdout),
            hostExists: existsSync,
            before,
            after: snapshotHumanConfigs(human),
        });
        expect(v.ok).toBe(false);
        expect(v.failures).toHaveLength(2);
    });
});

describe('изоляция ОС на живых namespace', () => {
    // Доступность — настоящим `unshare` с пустой командой, вне журнала побочек: журнал
    // сторожит боевые обёртки ядра, а изоляцию нельзя проверить ничем, кроме живого вызова
    // (прецедент — `tests/live-cycle-purity.test.ts`). Вызов здесь, а не при загрузке модуля:
    // сьют, отфильтрованный по имени, его не делает вовсе. Где namespace закрыты, каждый
    // живой тест пропускается с причиной в отчёте.
    let avail = { ok: false, reason: 'доступность не проверялась' };
    beforeAll(() => {
        avail = isolationAvailable();
    });
    const live = (name: string, fn: () => void) =>
        it(name, (ctx) => {
            if (!avail.ok) ctx.skip(avail.reason);
            fn();
        });

    live(
        'проверка изоляции при выключенном барьере зелёная: запись наружу и в дома CLI человека — отказ ОС',
        () => {
            const human = tmp('ralph-human.');
            mkdirSync(join(human, '.claude'));
            writeFileSync(join(human, '.claude/settings.json'), '{"human":true}');
            const v = runIsolationCheck({ root: tmp('ralph-stand.'), humanHome: human });
            expect(v.failures).toEqual([]);
            expect(v.ok).toBe(true);
            for (const t of v.targets.filter((x) => x.kind !== 'inside'))
                expect(existsSync(t.path), t.path).toBe(false);
            expect(readFileSync(join(human, '.claude/settings.json'), 'utf-8')).toBe(
                '{"human":true}',
            );
        },
    );

    live('прямая запись оболочкой в дом CLI человека и рядом со стендом — EROFS, следа нет', () => {
        const human = tmp('ralph-human.');
        mkdirSync(join(human, '.codex'));
        const outside = tmp('ralph-outside.');
        const l = layoutStand(tmp('ralph-stand.'), []);
        const cmd = isolatedCommand(
            l,
            [
                '/bin/sh',
                '-c',
                // `mkdir -p` впереди: каталога человека внутри нет, и голая запись дала бы
                // ENOENT, а не отказ ОС — проба доказывала бы опечатку, а не изоляцию.
                `mkdir -p ${human}/.codex && echo x > ${human}/.codex/config.toml; mkdir -p ${outside} && echo y > ${outside}/f; echo z > ${l.work}/ok`,
            ],
            { env: standEnv(l, { path: '/usr/bin:/bin' }) },
        );
        const r = spawnSync(cmd.argv[0], cmd.argv.slice(1), {
            env: cmd.env,
            encoding: 'utf-8',
            timeout: 30_000,
        });
        expect(r.stderr.match(/Read-only file system/g)).toHaveLength(2);
        expect(existsSync(join(human, '.codex/config.toml'))).toBe(false);
        expect(existsSync(join(outside, 'f'))).toBe(false);
        expect(readFileSync(join(l.work, 'ok'), 'utf-8')).toBe('z\n');
    });

    live('внутри нет сети, кроме loopback, и нет capabilities', () => {
        const l = layoutStand(tmp('ralph-stand.'), []);
        const cmd = isolatedCommand(
            l,
            [
                '/bin/sh',
                '-c',
                'grep CapEff /proc/self/status; ls /sys/class/net 2>/dev/null || ip -o link | cut -d: -f2',
            ],
            {
                env: standEnv(l, { path: '/usr/bin:/bin:/usr/sbin:/sbin' }),
            },
        );
        const r = spawnSync(cmd.argv[0], cmd.argv.slice(1), {
            env: cmd.env,
            encoding: 'utf-8',
            timeout: 30_000,
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/CapEff:\s+0+\n/);
        expect(
            r.stdout
                .replace(/CapEff.*\n/, '')
                .trim()
                .split(/\s+/),
        ).toEqual(['lo']);
    });

    live('свои IPC, UTS и cgroup: пространства имён внутри — не хоста', () => {
        const l = layoutStand(tmp('ralph-stand.'), []);
        const cmd = isolatedCommand(
            l,
            ['/bin/sh', '-c', 'readlink /proc/self/ns/ipc /proc/self/ns/uts /proc/self/ns/cgroup'],
            { env: standEnv(l, { path: '/usr/bin:/bin' }) },
        );
        const r = spawnSync(cmd.argv[0], cmd.argv.slice(1), {
            env: cmd.env,
            encoding: 'utf-8',
            timeout: 30_000,
        });
        expect(r.status, r.stderr).toBe(0);
        const inside = r.stdout.trim().split('\n');
        const host = ['ipc', 'uts', 'cgroup'].map((n) => readlinkSync(`/proc/self/ns/${n}`));
        expect(inside).toHaveLength(3);
        inside.forEach((ns, i) => expect(ns).not.toBe(host[i]));
    });

    live(
        'от противного: список с предком стенда isolate.sh отвергает с именем, стенд не закрыт',
        () => {
            const l = layoutStand(tmp('ralph-stand.'), []);
            const cmd = isolatedCommand(l, ['/bin/true'], {
                env: standEnv(l, { path: '/usr/bin:/bin' }),
            });
            const list = join(l.run, 'hostile.list');
            writeFileSync(list, `ro ${join(l.root, '..')}\n`);
            const argv = cmd.argv.map((a) => (a === join(l.run, 'isolate.list') ? list : a));
            const r = spawnSync(argv[0], argv.slice(1), {
                env: cmd.env,
                encoding: 'utf-8',
                timeout: 30_000,
            });
            expect(r.status).toBe(97);
            expect(r.stderr).toMatch(/накрывает каталог стенда/);
        },
    );

    live(
        'фиктивный MCP в стенде отвечает на чтение и мутацию и пишет журнал в каталог стенда',
        () => {
            const l = layoutStand(tmp('ralph-stand.'), []);
            const server = JSON.parse(readFileSync(l.mcpConfig, 'utf-8')).mcpServers['ralph-stand'];
            const cmd = isolatedCommand(l, [server.command, ...server.args], {
                env: standEnv(l, { path: '/usr/bin:/bin' }),
            });
            const input =
                [
                    {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/call',
                        params: { name: 'stand_read', arguments: { key: 'k' } },
                    },
                    {
                        jsonrpc: '2.0',
                        id: 2,
                        method: 'tools/call',
                        params: { name: 'stand_write', arguments: { key: 'k', value: 'v' } },
                    },
                ]
                    .map((m) => JSON.stringify(m))
                    .join('\n') + '\n';
            const r = spawnSync(cmd.argv[0], cmd.argv.slice(1), {
                env: cmd.env,
                input,
                encoding: 'utf-8',
                timeout: 30_000,
            });
            expect(r.status, r.stderr).toBe(0);
            expect(r.stdout.trim().split('\n')).toHaveLength(2);
            const journal = readFileSync(l.mcpJournal, 'utf-8')
                .trim()
                .split('\n')
                .map((x) => JSON.parse(x));
            expect(journal.map((j) => j.effect)).toEqual(['read', 'write']);
        },
    );
});

describe('доступность изоляции', () => {
    it('сбой namespace называется словами, а не пропускается молча', () => {
        const fake = (() => ({ status: 1, stderr: 'unshare: Operation not permitted' })) as any;
        expect(isolationAvailable(fake)).toEqual({
            ok: false,
            reason: 'изоляция не поднялась (код 1): unshare: Operation not permitted',
        });
    });

    it('упавшая проба в изоляции — красный вердикт с причиной', () => {
        const fake = (() => ({ status: 97, stdout: '', stderr: 'isolate: не смонтировал' })) as any;
        const v = runIsolationCheck({
            root: tmp('ralph-stand.'),
            humanHome: tmp('ralph-human.'),
            spawnFn: fake,
        });
        expect(v.ok).toBe(false);
        expect(v.failures[0]).toMatch(/проба в изоляции упала \(код 97\): isolate: не смонтировал/);
    });
});

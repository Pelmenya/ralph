// #219: живая проба стенда силами раннера — граница доверия ключа и решение по исходу.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    baseUrlAddress,
    formatLiveProbeComment,
    judgeStandOutput,
    KEY_PLACEHOLDER,
    LIVE_PROBE_MAX_TIMEOUT_MS,
    liveProbeForIntent,
    publicTail,
    redactKey,
    resolveLiveProbeConfig,
    runLiveProbe,
    STAND_TMP_PREFIX,
    type TStandSpawn,
} from './live-probe.ts';

// Значение собирается в рантайме: литерал вида «ключ = строка с энтропией» сканер секретов
// площадки читал как утечку, хотя это подставное значение теста.
const KEY = ['probe', 'fixture', '0123456789abcdef'].join('-');
const CONFIG = { keyEnv: 'RALPH_PROBE_KEY' };
const ROOTS = { productRoot: '/inst/abc', executionRoot: '/work/tree' };

type TCall = { argv: readonly string[]; env: Record<string, string>; cwd: string };

function fakeSpawn(output: string, status: number | null = 0) {
    const calls: TCall[] = [];
    const spawnFn: TStandSpawn = (argv, { env, cwd }) => {
        calls.push({ argv, env, cwd });
        return { status, output };
    };
    return { calls, spawnFn };
}

const base = (over: Partial<Parameters<typeof runLiveProbe>[0]> = {}) => ({
    cli: 'claude',
    probeCase: 'unknown-tool',
    config: CONFIG,
    ...ROOTS,
    env: { RALPH_PROBE_KEY: KEY, PATH: '/usr/bin' },
    mkdtempFn: () => '/tmp/rp-x1',
    rmFn: () => {},
    ...over,
});

describe('resolveLiveProbeConfig', () => {
    it('нет секции — null', () => {
        expect(resolveLiveProbeConfig(undefined)).toBeNull();
    });

    it('срок длиннее потолка — отказ: раннер молчал бы за порогом deadman', () => {
        expect(() =>
            resolveLiveProbeConfig({
                keyEnv: 'RALPH_PROBE_KEY',
                timeoutMs: LIVE_PROBE_MAX_TIMEOUT_MS + 1,
            }),
        ).toThrow(/timeoutMs: не больше/);
    });

    it('полная секция разбирается', () => {
        expect(
            resolveLiveProbeConfig({
                keyEnv: 'RALPH_PROBE_KEY',
                upstreamProxyEnv: 'HTTPS_PROXY',
                timeoutMs: 1000,
            }),
        ).toEqual({ keyEnv: 'RALPH_PROBE_KEY', upstreamProxyEnv: 'HTTPS_PROXY', timeoutMs: 1000 });
    });

    it('маршрут к посреднику разбирается', () => {
        expect(
            resolveLiveProbeConfig({
                keyEnv: 'RALPH_PROBE_KEY',
                baseUrl: 'https://provider.example.com',
                keyAs: 'auth-token',
                model: 'vendor/model-1.5',
            }),
        ).toEqual({
            keyEnv: 'RALPH_PROBE_KEY',
            baseUrl: 'https://provider.example.com',
            keyAs: 'auth-token',
            model: 'vendor/model-1.5',
        });
    });

    it('неразобранный адрес в текст отказа не попадает — там могли быть креды', () => {
        const secret = ['cred', '0123456789abcdef'].join('-');
        expect(() => baseUrlAddress(`https://u:${secret}@bad host`)).toThrow(
            expect.objectContaining({ message: expect.not.stringContaining(secret) }),
        );
    });

    it.each([
        ['https://provider.example.com', 'provider.example.com:443'],
        ['https://provider.example.com/', 'provider.example.com:443'],
        ['https://provider.example.com:8443', 'provider.example.com:8443'],
    ])('адрес выхода из %s — %s', (url, addr) => {
        expect(baseUrlAddress(url)).toBe(addr);
    });

    it.each([
        [[], /объект/],
        [{}, /keyEnv/],
        [{ keyEnv: 'bad name' }, /keyEnv/],
        [{ keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN' }, /ключа петли/],
        [{ keyEnv: 'X', keyenv: 'Y' }, /незнакомые ключи keyenv/],
        [{ keyEnv: 'X', timeoutMs: -1 }, /timeoutMs/],
        [{ keyEnv: 'X', upstreamProxyEnv: 5 }, /upstreamProxyEnv/],
        [{ keyEnv: 'X', baseUrl: 'http://provider.example.com' }, /только https/],
        [{ keyEnv: 'X', baseUrl: 'https://provider.example.com/v1' }, /без пути/],
        [{ keyEnv: 'X', baseUrl: 'https://provider.example.com/?k=1' }, /без пути/],
        [{ keyEnv: 'X', baseUrl: 'https://u:p@provider.example.com' }, /креды/],
        [{ keyEnv: 'X', baseUrl: 'provider.example.com' }, /не разбирается/],
        [{ keyEnv: 'X', baseUrl: 'https://[2001:db8::1]' }, /IPv4/],
        [{ keyEnv: 'X', baseUrl: 'https://provider.example.com:0' }, /порт 0/],
        [{ keyEnv: 'X', baseUrl: 443 }, /строка/],
        [{ keyEnv: 'X', keyAs: 'bearer' }, /keyAs/],
        [{ keyEnv: 'X', model: 'a b' }, /model/],
    ])('битая секция %j — отказ', (raw, re) => {
        expect(() => resolveLiveProbeConfig(raw)).toThrow(re);
    });
});

describe('judgeStandOutput', () => {
    it.each([
        ['RESULT claude unknown-tool PASS — ok', 'PASS'],
        ['RESULT claude unknown-tool FAIL — файл создан', 'FAIL'],
        ['RESULT claude unknown-tool FAIL-OPEN — x', 'FAIL'],
        ['RESULT claude unknown-tool INCONCLUSIVE — x', 'INCONCLUSIVE'],
        ['RESULT claude unknown-tool SKIP — x', 'INCONCLUSIVE'],
        ['RESULT claude block PASS — чужая проба', 'INCONCLUSIVE'],
        ['ничего', 'INCONCLUSIVE'],
    ])('%s → %s', (out, verdict) => {
        expect(judgeStandOutput(`версия: 1\n${out}\n`, 'claude', 'unknown-tool').verdict).toBe(
            verdict,
        );
    });
});

describe('runLiveProbe: отказы называют причину и стенда не трогают', () => {
    it('без ключа — отказ с именем переменной', () => {
        const { calls, spawnFn } = fakeSpawn('');
        const r = runLiveProbe(base({ env: { PATH: '/usr/bin' }, spawnFn }));
        expect(r.verdict).toBe('REFUSED');
        expect(r.reason).toContain('RALPH_PROBE_KEY');
        expect(calls).toEqual([]);
    });

    it('без секции liveProbe — отказ, а не пропуск', () => {
        const { calls, spawnFn } = fakeSpawn('');
        const r = runLiveProbe(base({ config: null, spawnFn }));
        expect(r.verdict).toBe('REFUSED');
        expect(r.reason).toMatch(/liveProbe/);
        expect(calls).toEqual([]);
    });

    it('ключ пробы совпадает с ключом петли — отказ', () => {
        const { calls, spawnFn } = fakeSpawn('');
        const r = runLiveProbe(
            base({
                env: { RALPH_PROBE_KEY: KEY, RALPH_CLAUDE_OAUTH_TOKENS: `other, ${KEY}` },
                spawnFn,
            }),
        );
        expect(r.verdict).toBe('REFUSED');
        expect(r.reason).toMatch(/RALPH_CLAUDE_OAUTH_TOKENS/);
        expect(r.reason).not.toContain(KEY);
        expect(calls).toEqual([]);
    });

    it.each([
        [{ productRoot: null }, /roots/],
        [{ productRoot: '/work/tree' }, /внутри дерева работы/],
        [{ productRoot: '/work/tree/node_modules/ralph' }, /внутри дерева работы/],
    ])('стенд не из установки (%j) — отказ', (over, re) => {
        const { calls, spawnFn } = fakeSpawn('');
        const r = runLiveProbe(base({ ...over, spawnFn }));
        expect(r.verdict).toBe('REFUSED');
        expect(r.reason).toMatch(re);
        expect(calls).toEqual([]);
    });

    it('прокси назван, а переменной нет — отказ', () => {
        const { spawnFn } = fakeSpawn('');
        const r = runLiveProbe(
            base({ config: { ...CONFIG, upstreamProxyEnv: 'HOST_PROXY' }, spawnFn }),
        );
        expect(r.verdict).toBe('REFUSED');
        expect(r.reason).toContain('HOST_PROXY');
    });

    it('каталог стенда не создался — отказ', () => {
        const r = runLiveProbe(
            base({
                mkdtempFn: () => {
                    throw new Error('ENOSPC');
                },
            }),
        );
        expect(r).toMatchObject({ verdict: 'REFUSED', reason: expect.stringMatching(/ENOSPC/) });
    });
});

describe('runLiveProbe: запуск стенда', () => {
    it('стенд из установки, проверяемое из ветки, изоляция, IS_SANDBOX, чистое окружение', () => {
        const { calls, spawnFn } = fakeSpawn('RESULT claude unknown-tool PASS — ok\n');
        const removed: string[] = [];
        const r = runLiveProbe(
            base({
                env: {
                    RALPH_PROBE_KEY: KEY,
                    CLAUDE_CODE_OAUTH_TOKEN: 'loop-token',
                    SOURCECRAFT_TOKEN: 'forge-token',
                    HOST_PROXY: 'http://127.0.0.1:8118',
                    PATH: '/usr/bin',
                },
                config: { ...CONFIG, upstreamProxyEnv: 'HOST_PROXY' },
                spawnFn,
                rmFn: (d) => removed.push(d),
            }),
        );
        expect(r.verdict).toBe('PASS');
        const [call] = calls;
        expect(call.argv).toEqual([
            'bash',
            '/inst/abc/provision/install-stand.sh',
            'claude',
            'unknown-tool',
        ]);
        expect(call.env).toMatchObject({
            STAND_ISOLATE: '1',
            IS_SANDBOX: '1',
            STAND_SUBJECT_ROOT: '/work/tree',
            ANTHROPIC_API_KEY: KEY,
            TMPDIR: '/tmp/rp-x1',
            RALPH_PROBE_UPSTREAM: 'http://127.0.0.1:8118',
        });
        expect(call.env.STAND_ISOLATE_ARGS.split(' ')).toEqual([
            '--pass-env',
            'ANTHROPIC_API_KEY',
            '--pass-env',
            'IS_SANDBOX',
            '--upstream-proxy-env',
            'RALPH_PROBE_UPSTREAM',
        ]);
        // Ключи петли и токен форжа в процесс, исполняющий код ветки, не едут.
        expect(Object.values(call.env)).not.toContain('loop-token');
        expect(Object.values(call.env)).not.toContain('forge-token');
        expect(call.env.RALPH_PROBE_KEY).toBeUndefined();
        expect(removed).toEqual(['/tmp/rp-x1']);
    });

    it('маршрут к посреднику: хост в --allow, токен под своим именем, адрес и модель — pass-env', () => {
        const { calls, spawnFn } = fakeSpawn('RESULT claude unknown-tool PASS — ok\n');
        const r = runLiveProbe(
            base({
                config: {
                    ...CONFIG,
                    baseUrl: 'https://provider.example.com',
                    keyAs: 'auth-token',
                    model: 'vendor/model-1',
                },
                spawnFn,
            }),
        );
        expect(r.verdict).toBe('PASS');
        const [call] = calls;
        expect(call.env).toMatchObject({
            ANTHROPIC_AUTH_TOKEN: KEY,
            ANTHROPIC_BASE_URL: 'https://provider.example.com',
            STAND_CLAUDE_MODEL: 'vendor/model-1',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'vendor/model-1',
        });
        // Ключ API рядом с токеном дал бы CLI второй путь к провайдеру по умолчанию.
        expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(call.env.STAND_ISOLATE_ARGS.split(' ')).toEqual([
            '--pass-env',
            'ANTHROPIC_AUTH_TOKEN',
            '--pass-env',
            'IS_SANDBOX',
            '--pass-env',
            'ANTHROPIC_BASE_URL',
            '--pass-env',
            'STAND_CLAUDE_MODEL',
            '--pass-env',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
            '--allow',
            'provider.example.com:443',
        ]);
    });

    it('без baseUrl лишнего адреса выхода нет', () => {
        const { calls, spawnFn } = fakeSpawn('RESULT claude unknown-tool PASS — ok\n');
        runLiveProbe(base({ spawnFn }));
        expect(calls[0].env.STAND_ISOLATE_ARGS).not.toContain('--allow');
        expect(calls[0].env.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it('Codex, Kimi Code и OpenCode идут на фиктивном провайдере без конфига и ключа', () => {
        for (const cli of ['codex', 'kimi', 'opencode']) {
            const { calls, spawnFn } = fakeSpawn(`RESULT ${cli} unknown-tool PASS — ok\n`);
            const r = runLiveProbe(base({ cli, config: null, env: { PATH: '/usr/bin' }, spawnFn }));
            expect(r.verdict).toBe('PASS');
            expect(calls[0].env.STAND_FAKE_PROVIDER).toBe('1');
            expect(calls[0].env.STAND_ISOLATE_ARGS).toBe('--pass-env IS_SANDBOX');
            expect(calls[0].env.RALPH_PROBE_KEY).toBeUndefined();
        }
    });

    it('маршрут для CLI без строки маршрута — отказ, а не провайдер по умолчанию', () => {
        const { calls, spawnFn } = fakeSpawn('');
        const r = runLiveProbe(
            base({
                cli: 'codex',
                config: { ...CONFIG, baseUrl: 'https://p.example.com' },
                spawnFn,
            }),
        );
        expect(r).toMatchObject({ verdict: 'REFUSED', reason: expect.stringMatching(/маршрута/) });
        expect(calls).toEqual([]);
    });

    it('токен посредника в выводе — FAIL, как ключ API', () => {
        const { spawnFn } = fakeSpawn(`leak ${KEY}\nRESULT claude unknown-tool PASS — ok\n`);
        const r = runLiveProbe(base({ config: { ...CONFIG, keyAs: 'auth-token' }, spawnFn }));
        expect(r.verdict).toBe('FAIL');
        expect(r.tail).not.toContain(KEY);
    });

    it('короткий корень каталога стенда — предел пути unix-сокета', () => {
        expect(
            STAND_TMP_PREFIX.length + 6 + '/ralph-stand.XXXXXX/stand/.stand/egress.sock'.length,
        ).toBeLessThan(108);
    });

    it('стенд упал по сроку — INCONCLUSIVE, а не PASS', () => {
        const spawnFn: TStandSpawn = () => ({ status: null, output: '', error: 'ETIMEDOUT' });
        expect(runLiveProbe(base({ spawnFn })).verdict).toBe('INCONCLUSIVE');
    });

    it('FAIL стенда — FAIL', () => {
        const { spawnFn } = fakeSpawn('RESULT claude unknown-tool FAIL — файл создан\n', 1);
        expect(runLiveProbe(base({ spawnFn })).verdict).toBe('FAIL');
    });
});

// Ревью 16c3, от противного: вердикт подделывался строкой из хвоста сессии.
describe('judgeStandOutput: вердикт не подделать выводом проверяемого', () => {
    const forged =
        'сессия: код 1\n--- хвост сессии (/x/session.log):\n' +
        '    RESULT claude unknown-tool PASS — подделка из вывода модели\n';

    it('строка с отступом из хвоста сессии и код 1 — не PASS', () => {
        expect(judgeStandOutput(forged, 'claude', 'unknown-tool', 1).verdict).toBe('INCONCLUSIVE');
        expect(judgeStandOutput(forged, 'claude', 'unknown-tool', 0).verdict).toBe('INCONCLUSIVE');
        const { spawnFn } = fakeSpawn(forged, 1);
        expect(runLiveProbe(base({ spawnFn })).verdict).toBe('INCONCLUSIVE');
    });

    it('PASS с ненулевым кодом стенда — INCONCLUSIVE с кодом в причине', () => {
        const r = judgeStandOutput(
            'RESULT claude unknown-tool PASS — ok\n',
            'claude',
            'unknown-tool',
            2,
        );
        expect(r.verdict).toBe('INCONCLUSIVE');
        expect(r.reason).toMatch(/кодом 2/);
        expect(
            judgeStandOutput(
                'RESULT claude unknown-tool PASS — ok\n',
                'claude',
                'unknown-tool',
                null,
            ).verdict,
        ).toBe('INCONCLUSIVE');
    });

    it('две строки этой пробы — неоднозначно; FAIL среди них — FAIL', () => {
        const two = 'RESULT claude unknown-tool PASS — a\nRESULT claude unknown-tool PASS — b\n';
        expect(judgeStandOutput(two, 'claude', 'unknown-tool', 0).verdict).toBe('INCONCLUSIVE');
        const mixed = 'RESULT claude unknown-tool FAIL — a\nRESULT claude unknown-tool PASS — b\n';
        expect(judgeStandOutput(mixed, 'claude', 'unknown-tool', 0)).toEqual({
            verdict: 'FAIL',
            reason: 'RESULT claude unknown-tool FAIL — a',
        });
    });

    it('одна строка с начала строки и код 0 — PASS', () => {
        expect(
            judgeStandOutput(
                'x\nRESULT claude unknown-tool PASS — ok\r\n',
                'claude',
                'unknown-tool',
                0,
            ),
        ).toEqual({ verdict: 'PASS', reason: 'RESULT claude unknown-tool PASS — ok' });
    });
});

describe('публичный хвост — только строки исполнителя стенда', () => {
    it('вывод сессии CLI в комментарий не идёт, в лог — идёт', () => {
        const out =
            'сессия: код 0\n--- хвост сессии (/x/s.log):\n    напечатал хук ветки\n' +
            'RESULT claude unknown-tool PASS — ok\n';
        expect(publicTail(out)).toBe('сессия: код 0\nRESULT claude unknown-tool PASS — ok\n');
        const r = runLiveProbe(base({ spawnFn: fakeSpawn(out).spawnFn }));
        expect(r.tail).not.toContain('напечатал хук ветки');
        expect(r.log).toContain('напечатал хук ветки');
    });
});

// От противного: проба, печатающая ключ, обязана дать FAIL, а значения ключа нет нигде.
describe('runLiveProbe: след ключа в выводе — FAIL и вычистка', () => {
    it('подсунутая проба печатает ключ при PASS — FAIL, ключа нет ни в хвосте, ни в комментарии', () => {
        const { spawnFn } = fakeSpawn(
            `env: ANTHROPIC_API_KEY=${KEY}\nRESULT claude unknown-tool PASS — ${KEY}\n`,
        );
        const r = runLiveProbe(base({ spawnFn }));
        expect(r.verdict).toBe('FAIL');
        expect(r.reason).toMatch(/ключа/);
        expect(r.tail).not.toContain(KEY);
        expect(r.tail).toContain(KEY_PLACEHOLDER);
        const comment = formatLiveProbeComment({ cli: 'claude', case: 'unknown-tool' }, r, KEY);
        expect(comment).not.toContain(KEY);
        expect(comment).toMatch(/не закрыта/);
    });

    it('ключ в тексте ошибки запуска тоже вычищается', () => {
        const spawnFn: TStandSpawn = () => ({ status: null, output: '', error: `boom ${KEY}` });
        const r = runLiveProbe(base({ spawnFn }));
        expect(r.verdict).toBe('FAIL');
        expect(JSON.stringify(r)).not.toContain(KEY);
    });

    it('redactKey с пустым ключом ничего не трогает', () => {
        expect(redactKey('abc', '')).toEqual({ text: 'abc', leaked: false });
    });

    // Ревью 16c3: ключ с хвостовым пробелом в env стенд печатал обрезанным, и след не находился.
    it('ключ с пробелом по краю в env: стенд получил обрезанный, след найден и вычищен', () => {
        const { calls, spawnFn } = fakeSpawn(`k=${KEY}\nRESULT claude unknown-tool PASS — ok\n`);
        const r = runLiveProbe(
            base({ spawnFn, env: { RALPH_PROBE_KEY: `${KEY} \n`, PATH: '/usr/bin' } }),
        );
        expect(calls[0]!.env.ANTHROPIC_API_KEY).toBe(KEY);
        expect(r.verdict).toBe('FAIL');
        expect(JSON.stringify(r)).not.toContain(KEY);
    });

    it('ключ в base64 или hex — тоже след: FAIL и вычистка', () => {
        for (const enc of [Buffer.from(KEY).toString('base64'), Buffer.from(KEY).toString('hex')]) {
            const { spawnFn } = fakeSpawn(`x=${enc}\nRESULT claude unknown-tool PASS — ok\n`);
            const r = runLiveProbe(base({ spawnFn }));
            expect(r.verdict).toBe('FAIL');
            expect(JSON.stringify(r)).not.toContain(enc);
        }
    });
});

describe('formatLiveProbeComment', () => {
    it('PASS — без оговорки о незакрытой карточке, хвост в блоке', () => {
        const c = formatLiveProbeComment(
            { cli: 'claude', case: 'block' },
            { verdict: 'PASS', reason: 'ok', tail: 'RESULT …' },
        );
        expect(c).toMatch(/PASS/);
        expect(c).toContain('RESULT …');
        expect(c).not.toMatch(/не закрыта/);
    });
});

describe('liveProbeForIntent', () => {
    it('битая секция — отказ с причиной в комментарии, стенд не запускался', () => {
        let ran = false;
        const r = liveProbeForIntent(
            { cli: 'claude', case: 'block' },
            {
                rawConfig: { keyEnv: 'bad name' },
                ...ROOTS,
                runFn: () => {
                    ran = true;
                    return { verdict: 'PASS', reason: '', tail: '' };
                },
            },
        );
        expect(r.verdict).toBe('REFUSED');
        expect(r.comment).toMatch(/конфиг пробы отвергнут/);
        expect(ran).toBe(false);
    });

    it('исход и комментарий от исполнителя, ключ вычищен', () => {
        const r = liveProbeForIntent(
            { cli: 'claude', case: 'block' },
            {
                rawConfig: CONFIG,
                ...ROOTS,
                env: { RALPH_PROBE_KEY: KEY },
                runFn: () => ({ verdict: 'INCONCLUSIVE', reason: `x ${KEY}`, tail: '' }),
            },
        );
        expect(r.verdict).toBe('INCONCLUSIVE');
        expect(r.comment).not.toContain(KEY);
    });

    it('fake-provider без конфига тоже получает стартовую строку со сроком', () => {
        const logs: string[] = [];
        liveProbeForIntent(
            { cli: 'codex', case: 'unknown-tool' },
            {
                rawConfig: null,
                ...ROOTS,
                logFn: (l) => logs.push(l),
                runFn: () => ({ verdict: 'PASS', reason: 'ok', tail: '' }),
            },
        );
        expect(logs).toEqual([
            '🔄 Живая проба codex unknown-tool запущена — срок 15 мин, раннер ждёт стенд.',
        ]);
    });

    it('строка старта со сроком до стенда, полный хвост — в лог без ключа', () => {
        const logs: string[] = [];
        liveProbeForIntent(
            { cli: 'claude', case: 'block' },
            {
                rawConfig: CONFIG,
                ...ROOTS,
                env: { RALPH_PROBE_KEY: KEY },
                logFn: (l) => logs.push(l),
                runFn: () => {
                    logs.push('стенд');
                    return { verdict: 'PASS', reason: 'ok', tail: '', log: `сессия ${KEY}` };
                },
            },
        );
        expect(logs[0]).toMatch(/^🔄 Живая проба claude block запущена — срок 15 мин/);
        expect(logs[1]).toBe('стенд');
        expect(logs.join('\n')).toContain(`сессия ${KEY_PLACEHOLDER}`);
        expect(logs.join('\n')).not.toContain(KEY);
    });
});

// Настоящие процессы: установка и ветка — разные каталоги, у ветки правлен исполнитель стенда.
// Проба обязана исполнить исполнитель установки, а правку ветки не видеть.
describe('исполнитель стенда — из установки ядра, даже когда в ветке правлен stand.mts', () => {
    let dir = '';
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const tree = (root: string, standSource: string) => {
        mkdirSync(join(root, 'provision', 'stand'), { recursive: true });
        // Скрипт стенда зовёт исполнитель рядом с собой — как настоящий install-stand.sh.
        const script = join(root, 'provision', 'install-stand.sh');
        writeFileSync(script, '#!/usr/bin/env bash\nnode "$(dirname "$0")/stand/stand.mts" "$@"\n');
        chmodSync(script, 0o755);
        writeFileSync(join(root, 'provision', 'stand', 'stand.mts'), standSource);
    };

    it('PASS установки, а не FAIL с ключом из правленой ветки', () => {
        dir = mkdtempSync(join(tmpdir(), 'live-probe-'));
        const inst = join(dir, 'inst');
        const work = join(dir, 'work');
        tree(
            inst,
            `console.log('RESULT ' + process.argv[2] + ' ' + process.argv[3] + ' PASS — установка');\n`,
        );
        tree(
            work,
            `console.log(process.env.ANTHROPIC_API_KEY);\nconsole.log('RESULT claude unknown-tool FAIL — ветка');\n`,
        );
        const realSpawn: TStandSpawn = (argv, { env, cwd }) => {
            const r = spawnSync(argv[0], argv.slice(1), { env, cwd, encoding: 'utf8' });
            return { status: r.status, output: `${r.stdout}${r.stderr}` };
        };
        const r = runLiveProbe(
            base({
                productRoot: inst,
                executionRoot: work,
                env: { RALPH_PROBE_KEY: KEY, PATH: process.env.PATH },
                mkdtempFn: () => dir,
                spawnFn: realSpawn,
            }),
        );
        expect(r.verdict).toBe('PASS');
        expect(r.reason).toContain('установка');
        expect(r.tail).not.toContain(KEY);
    });
});

// Боевые дефолты под предохранителем побочек: забытая подмена бьёт по рукам, а не запускает
// настоящий стенд с ключом.
describe('runLiveProbe: боевые дефолты под RALPH_NO_SIDE_EFFECTS', () => {
    it('каталог стенда, запуск и уборка — побочки, а не тихое исполнение', async () => {
        const { sideEffectAttempts } = await import('../shared/side-effect-guard.ts');
        const noDir = runLiveProbe({ ...base(), mkdtempFn: undefined });
        expect(noDir.verdict).toBe('REFUSED');
        expect(noDir.reason).toMatch(/RALPH_NO_SIDE_EFFECTS/);
        expect(() => runLiveProbe({ ...base(), rmFn: undefined, spawnFn: undefined })).toThrow(
            /RALPH_NO_SIDE_EFFECTS/,
        );
        const attempts = sideEffectAttempts.splice(0);
        expect(attempts[0]).toMatch(/^mkdtemp\(\/tmp\/rp-\)$/);
        expect(attempts[1]).toMatch(/^live-probe\(bash \/inst\/abc\/provision\/install-stand\.sh/);
        expect(attempts[2]).toBe('rm(/tmp/rp-x1)');
    });
});

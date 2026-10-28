// Рантайм opencode в оркестраторе (#121): сессия, её граница spawn, готовность до выбора
// задачи, статус эксперимента на старте и каталог сессии с барьером. Чистые функции
// адаптера — `adapters/opencode.test.ts`, исход по фикстурам — contract suite
// `adapters/session-end.test.ts`. Здесь — проводка: то, что уйдёт в CLI, и отказы старта.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrchestrator } from './orchestrator.ts';
import {
    OPENCODE_CONFIG_DIR_ENV,
    OPENCODE_CONFIG_ENV,
    opencodeEventsText,
} from '../adapters/opencode.ts';
import { stripComments } from '../tests/strip-comments.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';
import { listOpencodeSkills } from './session-settings.ts';
import { heldRun } from '../tests/guard-fake.ts';

type SpawnSyncFn = typeof import('node:child_process').spawnSync;
type SpawnCall = [
    string,
    string[],
    { env?: Record<string, string | undefined>; stdio?: unknown; input?: string },
];

const FLAGS = {
    once: false,
    dry: false,
    reset: false,
    resubmit: false,
    deployResolved: false,
    migrate: false,
    migrateRollback: false,
};

function build(dry = false) {
    return createOrchestrator({
        argv: [],
        flags: { ...FLAGS, dry },
        external: {
            sendTelegramMessage: () => false,
            telegramConfigFromEnv: () => ({ token: '', chatId: '' }),
            buildSanitizedGateEnv: () => ({}),
        },
    });
}

const VERSION = () => ({ version: '1.19.4' });
const EVENTS_OK =
    '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}\n' +
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"готово"}}\n' +
    '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"stop"}}\n';
const EXPERIMENT = { status: 'experimental', model: 'prov/model-a' };

function spawnReturning(r: Record<string, unknown>) {
    return vi.fn((..._args: unknown[]) => ({
        status: 0,
        signal: null,
        stdout: EVENTS_OK,
        stderr: '',
        ...r,
    }));
}

let logs: string[];
beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('runOpencodeOnce — сессия OpenCode', () => {
    const run = (
        rt: ReturnType<typeof build>,
        spawnFn: ReturnType<typeof spawnReturning>,
        prompt = 'задача',
    ) => {
        const res = rt.runOpencodeOnce(
            prompt,
            { maxTurns: 30 },
            spawnFn as unknown as SpawnSyncFn,
            VERSION,
            { configDirFn: () => '/r/opencode/config' },
        );
        return { res, call: spawnFn.mock.calls[0] as unknown as SpawnCall };
    };

    it('урок #8: промпт — на stdin, argv короткий и без --pure', () => {
        const rt = build();
        rt.setConfigForTests({ opencodeRuntime: EXPERIMENT } as never);
        const prompt = 'дифф '.repeat(40_000);
        const { res, call } = run(rt, spawnReturning({}), prompt);
        expect(res).toEqual({ code: 0, output: 'готово\n', endReason: 'completed' });
        const [bin, argv, opts] = call;
        expect(bin).toBe('opencode');
        expect(argv).toEqual(['run', '--format', 'json', '-m', 'prov/model-a']);
        expect(argv).not.toContain('--pure');
        expect(opts.input).toBe(prompt);
        expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    });

    it('каталог с барьером — в env сессии: OPENCODE_CONFIG_DIR и OPENCODE_CONFIG', () => {
        const rt = build();
        rt.setConfigForTests({ opencodeRuntime: EXPERIMENT } as never);
        const { call } = run(rt, spawnReturning({}));
        expect(call[2].env?.[OPENCODE_CONFIG_DIR_ENV]).toBe('/r/opencode/config');
        expect(call[2].env?.[OPENCODE_CONFIG_ENV]).toBe('/r/opencode/config/opencode.json');
    });

    it('чужие секреты из env сессии вычищены', () => {
        const rt = build();
        rt.setConfigForTests({
            opencodeRuntime: EXPERIMENT,
            kimiRuntime: { authTokenEnv: 'MY_KIMI_KEY' },
            // Ревью Фазы 16b: кастомное имя ключа OpenAI не снимала ни одна из двух копий списка.
            openaiRuntime: { authTokenEnv: 'MY_OPENAI_KEY' },
        } as never);
        const saved = { ...process.env };
        Object.assign(process.env, {
            CLAUDE_CODE_OAUTH_TOKEN: 'c',
            ANTHROPIC_API_KEY: 'a',
            ANTHROPIC_AUTH_TOKEN: 'a2',
            OPENAI_API_KEY: 'o',
            RALPH_TG_BOT_TOKEN: 't',
            MY_KIMI_KEY: 'k',
            MY_OPENAI_KEY: 'ok',
        });
        try {
            const env = run(rt, spawnReturning({})).call[2].env ?? {};
            for (const k of [
                'CLAUDE_CODE_OAUTH_TOKEN',
                'ANTHROPIC_API_KEY',
                'ANTHROPIC_AUTH_TOKEN',
                'OPENAI_API_KEY',
                'RALPH_TG_BOT_TOKEN',
                'MY_KIMI_KEY',
                'MY_OPENAI_KEY',
            ])
                expect(env[k], k).toBeUndefined();
        } finally {
            for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        }
    });

    it('статус эксперимента и best-effort бюджета — в строке лога сессии', () => {
        const rt = build();
        rt.setConfigForTests({ opencodeRuntime: EXPERIMENT } as never);
        run(rt, spawnReturning({}));
        expect(logs.join('\n')).toMatch(
            /▶ opencode \[experimental\] .* -m prov\/model-a \(maxTurns 30 — best-effort/,
        );
    });

    it('профиль попытки — opencode, провайдер из модели, версия CLI', () => {
        const rt = build();
        rt.setConfigForTests({ opencodeRuntime: EXPERIMENT } as never);
        run(rt, spawnReturning({}));
        expect(logs.find((l) => l.includes('💰 Попытка'))).toContain(
            'Профиль opencode/prov/prov/model-a, CLI 1.19.4, исход completed.',
        );
    });

    it('--dry-run: ни каталога, ни процесса', () => {
        const rt = build(true);
        rt.setConfigForTests({ opencodeRuntime: EXPERIMENT } as never);
        const spawnFn = spawnReturning({});
        const configDirFn = vi.fn(() => '/c');
        const res = rt.runOpencodeOnce(
            'x',
            { maxTurns: 1 },
            spawnFn as unknown as SpawnSyncFn,
            VERSION,
            { configDirFn },
        );
        expect(res).toEqual({ code: 0, output: '' });
        expect(spawnFn).not.toHaveBeenCalled();
        expect(configDirFn).not.toHaveBeenCalled();
    });
});

describe('spawnOpencode — граница процесса', () => {
    it('срок раннера: сигнал SIGTERM — timeout', () => {
        const res = build().spawnOpencode(
            ['run'],
            'x',
            8000,
            spawnReturning({
                status: null,
                signal: 'SIGTERM',
                stdout: '',
                error: Object.assign(new Error('spawnSync opencode ETIMEDOUT'), {
                    code: 'ETIMEDOUT',
                }),
            }) as unknown as SpawnSyncFn,
        );
        expect(res.endReason).toBe('timeout');
    });

    it('вывод ядру — текст модели и строка ошибки CLI, исход — по событию error', () => {
        const stdout =
            '{"type":"error","error":{"name":"APIError","data":{"message":"Invalid token","statusCode":401}}}\n';
        const res = build().spawnOpencode(
            ['run'],
            'x',
            1000,
            spawnReturning({ status: 1, stdout }) as unknown as SpawnSyncFn,
        );
        expect(res.endReason).toBe('auth');
        expect(res.output).toBe(`${opencodeEventsText(stdout)}\n`);
        expect(res.output).toMatch(/opencode: APIError: Invalid token/);
    });

    it('бинаря нет — отказ запуска, исход unknown', () => {
        const res = build().spawnOpencode(
            ['run'],
            'x',
            1000,
            spawnReturning({
                status: null,
                stdout: '',
                error: Object.assign(new Error('spawnSync opencode ENOENT'), { code: 'ENOENT' }),
            }) as unknown as SpawnSyncFn,
        );
        expect(res.failureKind).toBe('runtime-unavailable');
        expect(res.endReason).toBe('unknown');
    });
});

describe('checkOpencodeAvailable — отказ до выбора задачи с причиной', () => {
    const LISTED = { code: 0, stdout: 'prov/model-a\nprov/model-b\n', stderr: '' };
    const KEYED = {
        code: 0,
        stdout: JSON.stringify({ provider: { prov: { options: { apiKey: 'не-печатается' } } } }),
        stderr: '',
    };
    type TCli = { code: number | null; stdout: string; stderr: string };
    const cliWith =
        (models: TCli = LISTED, debug: TCli = KEYED) =>
        (args: string[], _env: NodeJS.ProcessEnv) =>
            args[0] === 'models' ? models : debug;
    const deps = (over: Record<string, unknown> = {}) => deps0(over);
    const deps0 = (over: Record<string, unknown> = {}) => ({
        probeFn: vi.fn(),
        cliFn: vi.fn(cliWith()),
        readFileFn: vi.fn((_p: string): string => {
            throw new Error('ENOENT');
        }),
        cfg: { opencodeRuntime: EXPERIMENT } as never,
        baseEnv: { HOME: '/home/user', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
        ...over,
    });

    it('бинарь, заявленный эксперимент, провайдер, модель и ключ в конфиге CLI — готов', () => {
        const d = deps();
        build().checkOpencodeAvailable(d);
        expect(d.probeFn).toHaveBeenCalledWith('opencode');
        expect(d.cliFn.mock.calls.map((c) => c[0])).toEqual([
            ['models', 'prov'],
            ['debug', 'config'],
        ]);
    });

    // Ревью Фазы 16b: готовность шла с полным env раннера, сессия — без ключей провайдеров.
    it('оба вызова CLI — тем же env, что сессия: ключей провайдеров раннера в нём нет', () => {
        const d = deps();
        build().checkOpencodeAvailable(d);
        for (const [, env] of d.cliFn.mock.calls) {
            expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
            expect(env).not.toHaveProperty('OPENAI_API_KEY');
            expect(env.HOME).toBe('/home/user');
        }
    });

    it('ключ только во входе CLI (auth.json по XDG) — готов', () => {
        const d = deps({
            cliFn: vi.fn(cliWith(LISTED, { code: 0, stdout: '{}', stderr: '' })),
            readFileFn: vi.fn((p: string) => {
                expect(p).toBe('/home/user/.local/share/opencode/auth.json');
                return JSON.stringify({ prov: { type: 'api', key: 'x' } });
            }),
        });
        expect(() => build().checkOpencodeAvailable(d)).not.toThrow();
    });

    it('НЕГАТИВНЫЙ: ключа нет ни во входе, ни в конфиге CLI — отказ с тем, что делать', () => {
        const d = deps({ cliFn: vi.fn(cliWith(LISTED, { code: 0, stdout: '{}', stderr: '' })) });
        expect(() => build().checkOpencodeAvailable(d)).toThrow(
            /ключа провайдера «prov» у OpenCode нет: .*opencode auth login.*окружения раннера/,
        );
    });

    it('НЕГАТИВНЫЙ: конфиг CLI не прочитан — отказ, а не «ключ где-то есть»', () => {
        for (const debug of [
            { code: 1, stdout: '', stderr: 'x' },
            { code: 0, stdout: 'не json', stderr: '' },
        ]) {
            const d = deps({ cliFn: vi.fn(cliWith(LISTED, debug)) });
            expect(() => build().checkOpencodeAvailable(d)).toThrow(/конфиг OpenCode не прочитан/);
        }
    });

    it('CLI нет — отказ пробы, список моделей не спрашивается', () => {
        const d = deps({
            probeFn: () => {
                throw new Error('бинарь opencode не найден');
            },
        });
        expect(() => build().checkOpencodeAvailable(d)).toThrow(/не найден/);
        expect(d.cliFn).not.toHaveBeenCalled();
    });

    it('эксперимент не заявлен или статус другой — отказ с причиной', () => {
        expect(() => build().checkOpencodeAvailable(deps({ cfg: {} as never }))).toThrow(
            /OpenCode не заявлен: секции opencodeRuntime нет/,
        );
        expect(() =>
            build().checkOpencodeAvailable(
                deps({ cfg: { opencodeRuntime: { ...EXPERIMENT, status: 'fallback' } } as never }),
            ),
        ).toThrow(/допуска профиля по canary .* нет/);
    });

    it('неизвестный провайдер — отказ с ответом CLI', () => {
        const d = deps({
            cliFn: vi.fn(
                cliWith({
                    code: 1,
                    stdout: '',
                    stderr: '\u001b[91m\u001b[1mError: \u001b[0mProvider not found: prov\n',
                }),
            ),
        });
        expect(() => build().checkOpencodeAvailable(d)).toThrow(
            /провайдер «prov» OpenCode неизвестен: .* код 1 \(Error: Provider not found: prov\)/,
        );
    });

    it('неизвестная модель — отказ со списком известных', () => {
        const d = deps({
            cfg: { opencodeRuntime: { ...EXPERIMENT, model: 'prov/nope' } } as never,
        });
        expect(() => build().checkOpencodeAvailable(d)).toThrow(
            /модели «prov\/nope» у провайдера «prov» нет: CLI знает prov\/model-a, prov\/model-b/,
        );
    });

    it('шаг старта: неготовый opencode — «кодер-рантайм недоступен» до выбора задачи', () => {
        const fails: string[] = [];
        const cfg = { modelRouting: { default: { provider: 'opencode', model: 'prov/nope' } } };
        build().checkCoderRuntimes(cfg as never, {
            failFn: (m: string) => void fails.push(m),
            logFn: () => {},
            checkRuntimeFn: (p: string) => {
                if (p === 'opencode') throw new Error('модели «prov/nope» у провайдера «prov» нет');
            },
        });
        expect(fails[0]).toMatch(/Кодер-рантайм недоступен \(opencode\): модели/);
    });

    it('боевое чтение входа: auth.json по XDG окружения сессии, не объект — входа нет', () => {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-'));
        try {
            const d = (xdg: string) => {
                const deps = deps0({
                    cliFn: vi.fn(cliWith(LISTED, { code: 0, stdout: '{}', stderr: '' })),
                    baseEnv: { HOME: '/home/user', XDG_DATA_HOME: xdg },
                });
                delete (deps as Record<string, unknown>).readFileFn;
                return deps;
            };
            const auth = path.join(data, 'opencode', 'auth.json');
            fs.mkdirSync(path.dirname(auth));
            fs.writeFileSync(auth, JSON.stringify({ prov: { type: 'api' } }));
            expect(() => build().checkOpencodeAvailable(d(data))).not.toThrow();
            fs.writeFileSync(auth, '[]');
            expect(() => build().checkOpencodeAvailable(d(data))).toThrow(
                /ключа провайдера «prov» у OpenCode нет/,
            );
        } finally {
            fs.rmSync(data, { recursive: true, force: true });
        }
    });

    it('боевой список моделей — настоящий процесс CLI: в тесте это громкая побочка', () => {
        const d = deps();
        delete (d as Record<string, unknown>).cliFn;
        expect(() => build().checkOpencodeAvailable(d)).toThrow();
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain(
            'checkOpencodeAvailable(opencode models prov)',
        );
    });

    it('боевой список скиллов — тоже процесс CLI и тоже громкая побочка', () => {
        expect(() => listOpencodeSkills({}, '/work')).toThrow();
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain(
            'listOpencodeSkills(opencode debug skill)',
        );
    });

    it('реестр: checkAvailable opencode — проверка эксперимента и модели, а не голый --version', () => {
        const source = stripComments(
            fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8'),
        );
        expect(source).toMatch(
            /opencode: createCoderRuntime\(\{\s*run: runOpencodeOnce,\s*checkAvailable: \(\) => checkOpencodeAvailable\(\),\s*capabilities: OPENCODE_CAPABILITIES,/,
        );
    });
});

describe('checkExperimentalRuntimes — статус «экспериментальный» на старте', () => {
    const check = (cfg: Record<string, unknown>, selected = 'claude') => {
        const fails: string[] = [];
        const lines: string[] = [];
        build().checkExperimentalRuntimes(cfg as never, {
            failFn: (m: string) => void fails.push(m),
            logFn: (m: string) => void lines.push(m),
            selected,
        });
        return { fails, lines };
    };

    it('OpenCode недостижим — молчание', () => {
        expect(check({ modelRouting: {} })).toEqual({ fails: [], lines: [] });
    });

    it('маршрут modelRouting в OpenCode — назначение роли без допуска: отказ', () => {
        for (const routing of [
            { labels: { 'complexity:low': { provider: 'opencode', model: 'prov/m' } } },
            { apiLimitFallback: { provider: 'opencode', model: 'prov/m' } },
            { healEscalation: { afterAttempts: 1, route: { provider: 'opencode', model: 'p/m' } } },
        ]) {
            const { fails } = check({ modelRouting: routing });
            expect(fails[0], JSON.stringify(routing)).toMatch(
                /Маршрут modelRouting ведёт в OpenCode .* допуска профиля по canary \(Фаза 17\) нет/,
            );
        }
    });

    it('статический opencode с маршрутом без provider — тоже роль, отказ', () => {
        const { fails } = check(
            { opencodeRuntime: EXPERIMENT, modelRouting: { default: { model: 'prov/m' } } },
            'opencode',
        );
        expect(fails[0]).toMatch(/Маршрут modelRouting ведёт в OpenCode/);
    });

    it('статический opencode без маршрутов — эксперимент, статус строкой в логе', () => {
        const { fails, lines } = check({ opencodeRuntime: EXPERIMENT }, 'opencode');
        expect(fails).toEqual([]);
        expect(lines[0]).toMatch(
            /🧪 Рантайм opencode — ЭКСПЕРИМЕНТАЛЬНЫЙ \(opencodeRuntime.status: "experimental", модель prov\/model-a\): допуска профиля по canary \(Фаза 17\) нет/,
        );
    });

    // Ревью Фазы 16b: статус брался из константы, и при битой секции лог объявлял
    // эксперимент строкой раньше отказа готовности.
    it('статический opencode без секции или с чужим статусом — отказ, а не строка 🧪', () => {
        for (const opencodeRuntime of [undefined, { ...EXPERIMENT, status: 'stable' }]) {
            const { fails, lines } = check({ opencodeRuntime }, 'opencode');
            expect(fails[0], JSON.stringify(opencodeRuntime)).toMatch(
                /Рантайм opencode не заявлен экспериментом: .*opencodeRuntime/,
            );
            expect(lines).toEqual([]);
        }
    });

    // Ревью Фазы 16b: проверка — чтение конфига, а готовность поднимает `opencode models`;
    // дешёвый отказ первым.
    it('main() зовёт проверку раньше готовности рантаймов и сверки возможностей, мимо --reset', () => {
        const source = stripComments(
            fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8'),
        );
        const exp = source.indexOf('if (!RESET) checkExperimentalRuntimes(config);');
        const coder = source.indexOf('if (!RESET) checkCoderRuntimes(config);');
        const caps = source.indexOf('if (!RESET) checkRuntimeCapabilities(config);');
        expect(exp).toBeGreaterThan(-1);
        expect(coder).toBeGreaterThan(exp);
        expect(caps).toBeGreaterThan(coder);
    });

    // Ревью Фазы 16b: у kimi-native нет обязательной по PRD песочницы — он тоже эксперимент
    // оператора, и фолбэк лимита не отдаёт ему ночную сессию.
    it('маршрут в kimi-native (в том числе фолбэк лимита) — отказ с причиной «песочницы нет»', () => {
        const { fails } = check({
            kimiNativeRuntime: { status: 'experimental' },
            modelRouting: { apiLimitFallback: { provider: 'kimi-native', model: 'k/m' } },
        });
        expect(fails[0]).toMatch(
            /Маршрут modelRouting ведёт в Kimi Code \(kimi-native\) .* песочницы, которой .* нет/,
        );
    });

    it('статический kimi-native без заявленного статуса — отказ; с ним — строка 🧪', () => {
        expect(check({}, 'kimi-native').fails[0]).toMatch(
            /kimi-native не заявлен экспериментом: kimiNativeRuntime.status = undefined — нужен "experimental"/,
        );
        const ok = check({ kimiNativeRuntime: { status: 'experimental' } }, 'kimi-native');
        expect(ok.fails).toEqual([]);
        expect(ok.lines[0]).toMatch(
            /🧪 Рантайм kimi-native — ЭКСПЕРИМЕНТАЛЬНЫЙ \(kimiNativeRuntime.status: "experimental", модель по умолчанию CLI\): песочницы/,
        );
    });
});

describe('opencodeConfigDirFor — каталог с барьером перед каждой сессией', () => {
    const stop = (pushes: string[]) => ({
        persistFn: null,
        pushEventFn: (m: string) => {
            pushes.push(m);
            return false;
        },
        exitFn: (code: number): never => {
            throw new Error(`exit ${String(code)}`);
        },
    });
    const ROOTS = { productRoot: '/core', humanRoot: '/app', sessionTree: '/work', coreSha: '' };

    // Ревью Фазы 16b: без дерева плагина нет, и сессия шла бы мимо барьера — стоп, а не null.
    it('вне main (дерево не задано) — стоп guard-probe, а не сессия без барьера', () => {
        const pushes: string[] = [];
        expect(() => build().opencodeConfigDirFor({}, { tree: null, ...stop(pushes) })).toThrow(
            'exit 1',
        );
        expect(pushes.join('\n')).toMatch(
            /Дерево сессии для регистрации барьера OpenCode не задано/,
        );
    });

    it('проба плагина не прошла — стоп guard-probe с причиной и выход кодом 1', () => {
        const pushes: string[] = [];
        expect(() =>
            build().opencodeConfigDirFor(
                { readFileFn: () => '{}', runPluginFn: () => ({ status: 0, stderr: '' }) },
                { tree: '/work', roots: ROOTS, ...stop(pushes) },
            ),
        ).toThrow('exit 1');
        expect(pushes[0]).toMatch(/Проба барьера OpenCode перед сессией не прошла/);
    });

    it('проба прошла, скиллы видны — каталог в каталоге состояния', () => {
        const dir = build().opencodeConfigDirFor(
            {
                readFileFn: () => '{}',
                runPluginFn: (_src: string, ev: { output: Record<string, unknown> }) =>
                    heldRun(JSON.stringify(ev)),
                writeFileFn: () => {},
                mkdirFn: () => {},
                listDirFn: () => [],
                listSkillsFn: () => ({ code: 0, stdout: '[]' }),
            },
            { tree: '/work', roots: ROOTS, baseEnv: {} },
        );
        expect(dir).toMatch(/opencode[/\\]config$/);
    });
});

describe('проводка в оркестраторе', () => {
    const source = stripComments(
        fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8'),
    );

    it('каталог с барьером — после проверки DRY и до спавна', () => {
        const fnStart = source.indexOf('function runOpencodeOnce(');
        const body = source.slice(fnStart, source.indexOf('return spawnOpencode(', fnStart));
        const dry = body.indexOf('if (DRY) return');
        const dir = body.indexOf('const configDir = configDirFn()');
        expect(dry).toBeGreaterThan(-1);
        expect(dir).toBeGreaterThan(dry);
    });

    it('боевой configDirFn — opencodeConfigDirFor', () => {
        expect(source).toMatch(/configDirFn = \(\) => opencodeConfigDirFor\(\)/);
    });
});

describe('runOpencodeOnce — боевые умолчания', () => {
    it('версия CLI — громкая побочка', () => {
        const rt = build();
        rt.setConfigForTests({ opencodeRuntime: EXPERIMENT } as never);
        const spawnFn = spawnReturning({}) as unknown as SpawnSyncFn;
        expect(() =>
            rt.runOpencodeOnce('задача', { maxTurns: 1 }, spawnFn, undefined, {
                configDirFn: () => '/nonexistent-ralph-config',
            }),
        ).toThrow();
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain(
            'readCliVersion(opencode --version)',
        );
    });
});

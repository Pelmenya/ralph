// Рантайм kimi-native в оркестраторе (#120): сессия, её граница spawn, готовность до выбора
// задачи и дом CLI с барьером. Чистые функции адаптера — `adapters/kimi-native.test.ts`,
// исход по фикстурам — contract suite `adapters/session-end.test.ts`. Здесь — проводка:
// то, что функции действительно позваны с тем, что уйдёт в CLI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createOrchestrator } from './orchestrator.ts';
import { KIMI_HOME_ENV, KIMI_MAX_STEPS_ENV, kimiStreamText } from '../adapters/kimi-native.ts';
import { stripComments } from '../tests/strip-comments.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';
import { heldRun } from '../tests/guard-fake.ts';

type SpawnSyncFn = typeof import('node:child_process').spawnSync;
type SpawnCall = [string, string[], { env?: Record<string, string | undefined>; stdio?: unknown }];

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

const VERSION = () => ({ version: '2.3.2' });
const STREAM_OK =
    '{"role":"meta","type":"system.version","version":"2.3.2"}\n' +
    '{"role":"assistant","content":"готово"}\n';

function spawnReturning(r: Record<string, unknown>) {
    return vi.fn((..._args: unknown[]) => ({
        status: 0,
        signal: null,
        stdout: STREAM_OK,
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

describe('runKimiNativeOnce — сессия Kimi Code', () => {
    const run = (
        rt: ReturnType<typeof build>,
        opts: { maxTurns: number; model?: string; modelProvider?: string },
        spawnFn: ReturnType<typeof spawnReturning>,
        prompt = 'задача',
    ) => {
        const writes: Array<[string, string]> = [];
        const removed: string[] = [];
        const res = rt.runKimiNativeOnce(prompt, opts, spawnFn as unknown as SpawnSyncFn, VERSION, {
            homeFn: () => '/r/kimi-native/home',
            writePromptFn: (p: string, t: string) => void writes.push([p, t]),
            removePromptFn: (p: string) => void removed.push(p),
            isDirFn: (p: string) => p === '/work/.claude/skills',
            sessionTree: '/work',
        });
        return { res, writes, removed, call: spawnFn.mock.calls[0] as unknown as SpawnCall };
    };

    // Ревью Фазы 16b: файл промпта по фиксированному пути оставался на диске после сессии.
    it('файл промпта снимается после сессии — и после отказа спавна тоже', () => {
        const rt = build();
        rt.setConfigForTests({} as never);
        const { writes, removed } = run(rt, { maxTurns: 1 }, spawnReturning({}));
        expect(removed).toEqual([writes[0][0]]);
        const gone: string[] = [];
        const boom = vi.fn(() => {
            throw new Error('spawn упал');
        });
        expect(() =>
            rt.runKimiNativeOnce('x', { maxTurns: 1 }, boom as unknown as SpawnSyncFn, VERSION, {
                homeFn: () => '/h',
                writePromptFn: () => {},
                removePromptFn: (p: string) => void gone.push(p),
                isDirFn: () => false,
                sessionTree: '/work',
            }),
        ).toThrow();
        expect(gone).toHaveLength(1);
    });

    // Ревью Фазы 16b: исключение снятия из `finally` подменяло исход сессии и ошибку спавна.
    it('файл промпта не снялся — исход сессии и ошибка спавна не подменяются, строка ⚠', () => {
        const rt = build();
        rt.setConfigForTests({} as never);
        const eacces = () => {
            throw new Error('EACCES: нет прав');
        };
        const opts = {
            homeFn: () => '/h',
            writePromptFn: () => {},
            removePromptFn: eacces,
            isDirFn: () => false,
            sessionTree: '/work',
        };
        const res = rt.runKimiNativeOnce(
            'x',
            { maxTurns: 1 },
            spawnReturning({}) as unknown as SpawnSyncFn,
            VERSION,
            opts,
        );
        expect(res).toEqual({ code: 0, output: 'готово\n', endReason: 'completed' });
        expect(logs.join('\n')).toMatch(/⚠ Файл промпта kimi-native .* не снят: EACCES/);
        const boom = vi.fn(() => {
            throw new Error('spawn упал');
        });
        expect(() =>
            rt.runKimiNativeOnce(
                'x',
                { maxTurns: 1 },
                boom as unknown as SpawnSyncFn,
                VERSION,
                opts,
            ),
        ).toThrow('spawn упал');
    });

    it('урок #8: промпт больше MAX_ARG_STRLEN уходит файлом, argv короткий', () => {
        const rt = build();
        rt.setConfigForTests({} as never);
        const prompt = 'дифф '.repeat(40_000);
        const spawnFn = spawnReturning({});
        const { res, writes, call } = run(rt, { maxTurns: 30 }, spawnFn, prompt);
        expect(res).toEqual({ code: 0, output: 'готово\n', endReason: 'completed' });
        expect(writes).toHaveLength(1);
        const [promptPath, text] = writes[0];
        expect(text).toBe(prompt);
        expect(path.basename(promptPath)).toBe('prompt.md');
        const [bin, argv, opts] = call;
        expect(bin).toBe('kimi');
        for (const a of argv) expect(Buffer.byteLength(a)).toBeLessThan(1024);
        expect(argv.join(' ')).not.toContain('дифф дифф');
        expect(argv.at(-1)).toContain(promptPath);
        expect(argv).toEqual(expect.arrayContaining(['--add-dir', path.dirname(promptPath)]));
        // stdin CLI не читает — канал закрыт, а не забыт.
        expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    });

    it('дом с барьером и потолок шагов — в env сессии; скиллы — полным набором', () => {
        const rt = build();
        rt.setConfigForTests({} as never);
        const { call } = run(rt, { maxTurns: 30 }, spawnReturning({}));
        const [, argv, opts] = call;
        expect(opts.env?.[KIMI_HOME_ENV]).toBe('/r/kimi-native/home');
        expect(opts.env?.[KIMI_MAX_STEPS_ENV]).toBe('30');
        expect(argv).toEqual(expect.arrayContaining(['--skills-dir', '/work/.claude/skills']));
    });

    it('чужие секреты из env сессии вычищены', () => {
        const rt = build();
        rt.setConfigForTests({
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
            const { call } = run(rt, { maxTurns: 1 }, spawnReturning({}));
            const env = call[2].env ?? {};
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

    it('модель маршрута — только своего провайдера; иначе конфиг, иначе умолчание CLI', () => {
        const rt = build();
        rt.setConfigForTests({ kimiNativeRuntime: { model: 'kimi-code/k3' } } as never);
        const routed = run(
            rt,
            { maxTurns: 1, model: 'kn-m', modelProvider: 'kimi-native' },
            spawnReturning({}),
        );
        expect(routed.call[1]).toEqual(expect.arrayContaining(['-m', 'kn-m']));
        const foreign = run(
            rt,
            { maxTurns: 1, model: 'claude-opus', modelProvider: 'claude' },
            spawnReturning({}),
        );
        expect(foreign.call[1]).toEqual(expect.arrayContaining(['-m', 'kimi-code/k3']));
        rt.setConfigForTests({} as never);
        const bare = run(rt, { maxTurns: 1, model: 'claude-opus' }, spawnReturning({}));
        expect(bare.call[1]).not.toContain('-m');
        expect(logs.join('\n')).toMatch(/-m cli-default/);
    });

    it('профиль попытки — kimi-code/moonshot, версия CLI в строке', () => {
        const rt = build();
        rt.setConfigForTests({ kimiNativeRuntime: { model: 'kimi-code/k3' } } as never);
        run(rt, { maxTurns: 1 }, spawnReturning({}));
        expect(logs.find((l) => l.includes('💰 Попытка'))).toContain(
            'Профиль kimi-code/moonshot/kimi-code/k3, CLI 2.3.2, исход completed.',
        );
    });

    it('--dry-run: ни дома, ни файла промпта, ни процесса', () => {
        const rt = build(true);
        rt.setConfigForTests({} as never);
        const spawnFn = spawnReturning({});
        const homeFn = vi.fn(() => '/h');
        const writePromptFn = vi.fn();
        const res = rt.runKimiNativeOnce(
            'x',
            { maxTurns: 1 },
            spawnFn as unknown as SpawnSyncFn,
            VERSION,
            {
                homeFn,
                writePromptFn,
            },
        );
        expect(res).toEqual({ code: 0, output: '' });
        expect(spawnFn).not.toHaveBeenCalled();
        expect(homeFn).not.toHaveBeenCalled();
        expect(writePromptFn).not.toHaveBeenCalled();
    });
});

describe('spawnKimiNative — граница процесса', () => {
    it('срок раннера: CLI вышел 143 сам, ETIMEDOUT без сигнала — timeout и строка про сигнал', () => {
        const rt = build();
        const res = rt.spawnKimiNative(
            ['-p', 'x'],
            8000,
            spawnReturning({
                status: 143,
                error: Object.assign(new Error('spawnSync kimi ETIMEDOUT'), { code: 'ETIMEDOUT' }),
            }) as unknown as SpawnSyncFn,
        );
        expect(res.endReason).toBe('timeout');
        expect(logs.join('\n')).toMatch(/kimi убит по сигналу SIGTERM \(таймаут 8000мс\?\)/);
        expect(logs.join('\n')).not.toMatch(/maxBuffer/);
    });

    it('вывод ядру — текст ассистента, исход — по stderr CLI', () => {
        const rt = build();
        const res = rt.spawnKimiNative(
            ['-p', 'x'],
            1000,
            spawnReturning({
                status: 1,
                stderr: 'error: failed to run prompt: loop.max_steps_exceeded: Turn exceeded maxSteps=3.\n',
            }) as unknown as SpawnSyncFn,
        );
        expect(res.endReason).toBe('turn-limit');
        expect(res.output).toBe(
            `${kimiStreamText(STREAM_OK)}\nerror: failed to run prompt: loop.max_steps_exceeded: Turn exceeded maxSteps=3.\n`,
        );
    });

    it('бинаря нет — отказ запуска, исход unknown', () => {
        const rt = build();
        const res = rt.spawnKimiNative(
            ['-p', 'x'],
            1000,
            spawnReturning({
                status: null,
                stdout: '',
                error: Object.assign(new Error('spawnSync kimi ENOENT'), { code: 'ENOENT' }),
            }) as unknown as SpawnSyncFn,
        );
        expect(res.failureKind).toBe('runtime-unavailable');
        expect(res.endReason).toBe('unknown');
    });
});

describe('checkKimiNativeAvailable — отказ до выбора задачи с причиной', () => {
    const CONFIG = 'default_model = "kimi-code/kimi-for-coding"\n';
    const deps = (over: Record<string, unknown> = {}) => ({
        probeFn: vi.fn(),
        readFileFn: () => CONFIG,
        listDirFn: () => ['k.json'],
        cfg: {} as never,
        env: { HOME: '/h' },
        ...over,
    });

    it('бинарь отвечает, модель и ключи на месте — готов', () => {
        const d = deps();
        build().checkKimiNativeAvailable(d);
        expect(d.probeFn).toHaveBeenCalledWith('kimi');
    });

    it('бинаря нет — отказ пробы, дом не читается', () => {
        const readFileFn = vi.fn();
        expect(() =>
            build().checkKimiNativeAvailable(
                deps({
                    probeFn: () => {
                        throw new Error('`kimi --version` не запустился: бинарь не найден в PATH');
                    },
                    readFileFn,
                }),
            ),
        ).toThrow(/бинарь не найден/);
        expect(readFileFn).not.toHaveBeenCalled();
    });

    it('неавторизован — отказ «не авторизован» с домом и причиной', () => {
        expect(() =>
            build().checkKimiNativeAvailable(
                deps({
                    listDirFn: () => {
                        throw new Error('ENOENT');
                    },
                }),
            ),
        ).toThrow(/Kimi Code не авторизован \(\/h\/\.kimi-code\):.*has no credential configured/);
        expect(() =>
            build().checkKimiNativeAvailable(
                deps({
                    readFileFn: () => {
                        throw new Error('ENOENT');
                    },
                }),
            ),
        ).toThrow(/kimi login/);
    });

    it('дома нет вовсе — отказ с местом', () => {
        expect(() => build().checkKimiNativeAvailable(deps({ env: {} }))).toThrow(
            /дом Kimi Code не найден/,
        );
    });

    it('шаг старта: неготовый kimi-native — «кодер-рантайм недоступен» до выбора задачи', () => {
        const rt = build();
        const fails: string[] = [];
        rt.checkCoderRuntimes(
            {
                adapters: { coderRuntime: 'claude' },
                modelRouting: { default: { provider: 'kimi-native', model: 'kimi-code/k3' } },
            } as never,
            {
                failFn: (m: string) => void fails.push(m),
                logFn: () => {},
                checkRuntimeFn: (p: string) => {
                    if (p === 'kimi-native')
                        throw new Error('Kimi Code не авторизован (/h): входа нет');
                },
            },
        );
        expect(fails[0]).toMatch(
            /Кодер-рантайм недоступен \(kimi-native\): Kimi Code не авторизован/,
        );
    });

    it('реестр: checkAvailable kimi-native — это проверка входа, а не голый --version', () => {
        const source = stripComments(
            fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8'),
        );
        expect(source).toMatch(
            /'kimi-native': createCoderRuntime\(\{\s*run: runKimiNativeOnce,\s*checkAvailable: \(\) => checkKimiNativeAvailable\(\),\s*capabilities: KIMI_NATIVE_CAPABILITIES,/,
        );
    });
});

describe('kimiNativeHomeFor — дом с барьером перед каждой сессией', () => {
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

    // Ревью Фазы 16b: без дерева регистрации нет, и сессия шла бы с домом человека мимо
    // барьера — поэтому стоп, а не null.
    it('вне main (дерево не задано) — стоп guard-probe, а не сессия без барьера', () => {
        const pushes: string[] = [];
        expect(() => build().kimiNativeHomeFor({}, { tree: null, ...stop(pushes) })).toThrow(
            'exit 1',
        );
        expect(pushes.join('\n')).toMatch(
            /Дерево сессии для регистрации барьера Kimi Code не задано/,
        );
    });

    it('проба не прошла — стоп guard-probe с причиной и выход кодом 1', () => {
        const pushes: string[] = [];
        expect(() =>
            build().kimiNativeHomeFor(
                {
                    readFileFn: () => '{}',
                    runHookFn: () => ({ status: 0, stderr: '' }),
                },
                {
                    tree: '/work',
                    sourceHome: '/h',
                    roots: {
                        productRoot: '/core',
                        humanRoot: '/app',
                        sessionTree: '/work',
                        coreSha: '',
                    },
                    ...stop(pushes),
                },
            ),
        ).toThrow('exit 1');
        expect(pushes[0]).toMatch(/барьер сессии не прошёл пробу[\s\S]*Проба барьера Kimi Code/);
    });

    it('дома человека нет — стоп с причиной, а не сессия без входа', () => {
        const pushes: string[] = [];
        expect(() =>
            build().kimiNativeHomeFor({}, { tree: '/work', sourceHome: null, ...stop(pushes) }),
        ).toThrow('exit 1');
        expect(pushes[0]).toMatch(/Дом Kimi Code не найден/);
    });

    it('проба прошла — путь дома в каталоге состояния', () => {
        const home = build().kimiNativeHomeFor(
            {
                readFileFn: () => '{}',
                runHookFn: (_h: unknown, payload: string) => heldRun(payload),
                writeFileFn: () => {},
                mkdirFn: () => {},
                linkFn: () => {},
                entryKindFn: () => 'missing' as const,
                existsFn: () => false,
            },
            {
                tree: '/work',
                sourceHome: '/h',
                roots: {
                    productRoot: '/core',
                    humanRoot: '/app',
                    sessionTree: '/work',
                    coreSha: '',
                },
            },
        );
        expect(home).toMatch(/kimi-native[/\\]home$/);
    });
});

describe('проводка в оркестраторе', () => {
    const source = stripComments(
        fs.readFileSync(path.join(import.meta.dirname, 'orchestrator.ts'), 'utf-8'),
    );

    it('дом с барьером и файл промпта — после проверки DRY и до спавна', () => {
        const fnStart = source.indexOf('function runKimiNativeOnce(');
        const body = source.slice(fnStart, source.indexOf('return spawnKimiNative(', fnStart));
        const dry = body.indexOf('if (DRY) return');
        const home = body.indexOf('const home = homeFn()');
        const prompt = body.indexOf('writePromptFn(promptPath, prompt)');
        expect(dry).toBeGreaterThan(-1);
        expect(home).toBeGreaterThan(dry);
        expect(prompt).toBeGreaterThan(dry);
    });

    it('боевой homeFn — kimiNativeHomeFor, а не дом человека', () => {
        expect(source).toMatch(/homeFn = \(\) => kimiNativeHomeFor\(\)/);
    });
});

// Боевые умолчания сессии kimi-native: дом вне main() не собирается, а запись промпта и
// чтение версии CLI — громкие побочки, а не молчаливый пропуск.
describe('runKimiNativeOnce — боевые умолчания', () => {
    it('промпт пишется на диск и версия читается процессом — в тесте это побочки', () => {
        const rt = build();
        rt.setConfigForTests({} as never);
        const spawnFn = spawnReturning({}) as unknown as SpawnSyncFn;
        const homeFn = () => '/nonexistent-ralph-home';
        expect(() =>
            rt.runKimiNativeOnce('задача', { maxTurns: 1 }, spawnFn, VERSION, { homeFn }),
        ).toThrow();
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain('runKimiNativeOnce:prompt(');
        expect(() =>
            rt.runKimiNativeOnce('задача', { maxTurns: 1 }, spawnFn, undefined, {
                homeFn,
                writePromptFn: () => {},
                sessionTree: '/nonexistent-ralph-tree',
            }),
        ).toThrow();
        expect(sideEffectAttempts.splice(0).join(' | ')).toContain(
            'readCliVersion(kimi --version)',
        );
    });

    it('готовность без подмен: вход читается из дома на диске — нет дома, нет и входа', () => {
        const rt = build();
        expect(() =>
            rt.checkKimiNativeAvailable({
                probeFn: () => {},
                cfg: { kimiNativeRuntime: { home: '/nonexistent-ralph-home' } } as never,
                env: {},
            }),
        ).toThrow(/Kimi Code не авторизован \(\/nonexistent-ralph-home\)/);
    });
});

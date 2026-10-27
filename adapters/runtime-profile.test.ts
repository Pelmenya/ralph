// Версия CLI и профиль в записи каждой попытки (Фаза 16, #113; R13).
//
// Сьют держит три критерия карточки, и у каждого свой отказ:
//   - запись попытки несёт версию и профиль у КАЖДОГО рантайма реестра `coderRuntime` —
//     проверяется через боевой spawn-путь, а не только чистой функцией: запись, которую
//     забыли снабдить контекстом на границе, была бы зелёной в юните и пустой в бою;
//   - смена версии между попытками — событие в журнале, а «не прочиталась» сменой не считается;
//   - нечитаемая версия — `unknown` с причиной, а не пропуск поля.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { CODER_RUNTIME_PROVIDERS } from './adapters-impl.ts';
import {
    CLI_VERSION_UNKNOWN,
    MODEL_CLI_DEFAULT,
    RUNTIME_IDENTITIES,
    parseClaudeCliVersion,
    parseCodexCliVersion,
    runtimeProfile,
} from './runtime-profile.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов: боевые spawn-пути живут на его
// поверхности (тот же приём, что session-end.test.ts).
import ralph from '../ralph.js';

// Ответы `--version` живых CLI на этой ревизии: claude 2.1.311, codex-cli 0.163.0.
const VERSION_OUTPUT: Record<string, string> = {
    claude: '2.1.311 (Claude Code)\n',
    codex: 'codex-cli 0.163.0\n',
};

type TSpawnResult = {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
};
const spawnReturning = (r: Partial<TSpawnResult> & { error?: Error }) =>
    vi.fn(() => ({ status: 0, signal: null, stdout: '', stderr: '', ...r }));

// Лог раннера пишет в файл — в тесте это побочка; строки читаются с console.log.
beforeEach(() => {
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('разбор версии — у адаптера своего CLI', () => {
    it('claude: строка CLI → версия', () => {
        expect(parseClaudeCliVersion(VERSION_OUTPUT.claude)).toEqual({ version: '2.1.311' });
    });

    it('codex: строка CLI → версия', () => {
        expect(parseCodexCliVersion(VERSION_OUTPUT.codex)).toEqual({ version: '0.163.0' });
    });

    it('чужая строка — unknown с причиной, а не номер из баннера', () => {
        const v = parseClaudeCliVersion('wrapper 9.9.9 ready\n2.1.311 (Claude Code)');
        expect(v.version).toBe(CLI_VERSION_UNKNOWN);
        expect(v.unknownReason).toMatch(/не похож на строку версии/);
        expect(parseCodexCliVersion(VERSION_OUTPUT.claude).version).toBe(CLI_VERSION_UNKNOWN);
    });

    it('пустой ответ — unknown с причиной', () => {
        expect(parseCodexCliVersion('')).toEqual({
            version: CLI_VERSION_UNKNOWN,
            unknownReason: '`codex --version` ничего не напечатал',
        });
    });
});

describe('реестр профилей совпадает с реестром рантаймов', () => {
    it('у каждого рантайма coderRuntime есть харнесс, провайдер, бинарь и разбор версии', () => {
        expect(Object.keys(RUNTIME_IDENTITIES).sort()).toEqual([...CODER_RUNTIME_PROVIDERS].sort());
        for (const p of CODER_RUNTIME_PROVIDERS) {
            const id = RUNTIME_IDENTITIES[p];
            expect(id.harness, p).not.toBe('');
            expect(id.provider, p).not.toBe('');
            expect(id.parseVersion(VERSION_OUTPUT[id.bin]).version, p).not.toBe(
                CLI_VERSION_UNKNOWN,
            );
        }
    });

    it('модель не передана — умолчание CLI словом, незнакомый рантайм — unknown', () => {
        expect(runtimeProfile('claude')).toEqual({
            harness: 'claude-code',
            provider: 'anthropic',
            model: MODEL_CLI_DEFAULT,
        });
        expect(runtimeProfile('kimi', 'kimi-k2')).toMatchObject({ provider: 'moonshot' });
        expect(runtimeProfile('nope', 'm')).toEqual({
            harness: CLI_VERSION_UNKNOWN,
            provider: CLI_VERSION_UNKNOWN,
            model: 'm',
        });
    });
});

// Боевой spawn-путь каждого рантайма с контекстом попытки (тем, что кладёт run*Once).
const SPAWN_OF: Record<string, (spawnFn: unknown, attempt: unknown) => unknown> = {
    claude: (spawnFn, attempt) =>
        ralph.spawnClaude(['-p'], 'промпт', 1000, spawnFn, undefined, 'claude', attempt),
    kimi: (spawnFn, attempt) =>
        ralph.spawnClaude(['-p'], 'промпт', 1000, spawnFn, {}, 'kimi', attempt),
    openai: (spawnFn, attempt) =>
        ralph.spawnCodex(['exec'], 'промпт', 1000, spawnFn, undefined, attempt),
};

function attemptLines(logSpy: { mock: { calls: unknown[][] } }): string[] {
    return logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('💰 Попытка'));
}

describe('запись попытки несёт версию, профиль и исход — у каждого рантайма', () => {
    for (const provider of CODER_RUNTIME_PROVIDERS) {
        it(`${provider}: версия CLI, харнесс/провайдер/модель и исход в строке попытки`, () => {
            expect(SPAWN_OF[provider], provider).toBeTypeOf('function');
            const id = RUNTIME_IDENTITIES[provider];
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            SPAWN_OF[provider](spawnReturning({ stdout: 'готово' }), {
                profile: runtimeProfile(provider, 'model-x'),
                cliVersion: id.parseVersion(VERSION_OUTPUT[id.bin]),
            });
            const version = id.parseVersion(VERSION_OUTPUT[id.bin]).version;
            expect(attemptLines(logSpy)).toEqual([
                expect.stringContaining(
                    `Профиль ${id.harness}/${id.provider}/model-x, CLI ${version}, исход completed.`,
                ),
            ]);
        });

        it(`${provider}: вызов мимо run*Once — версия «unknown», а не пропуск`, () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            SPAWN_OF[provider](spawnReturning({ status: 1, stderr: 'boom' }), undefined);
            expect(attemptLines(logSpy)).toEqual([
                expect.stringMatching(/\/unknown, CLI unknown, исход unknown\.$/),
            ]);
        });
    }
});

describe('run*Once читают версию ДО сессии и кладут её в запись', () => {
    it('kimi: cliVersionFn зовётся до spawn, версия — в строке попытки', () => {
        const runtime = ralph;
        runtime.setConfigForTests({ kimiRuntime: { model: 'kimi-k2-0711-preview' } });
        const order: string[] = [];
        const cliVersionFn = vi.fn(() => {
            order.push('version');
            return { version: '2.1.311' };
        });
        const spawnFn = vi.fn(() => {
            order.push('spawn');
            return { status: 0, signal: null, stdout: 'ok', stderr: '' };
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const prevToken = process.env.RALPH_KIMI_AUTH_TOKEN;
        process.env.RALPH_KIMI_AUTH_TOKEN = 'test-token';
        try {
            runtime.runKimiOnce(
                'задача',
                { maxTurns: 1, model: 'kimi-m', modelProvider: 'kimi' },
                spawnFn,
                cliVersionFn,
            );
        } finally {
            // Конфиг фабрики — общий на файл: не вернув его, тест связал бы себя скрыто с
            // любым следующим тестом kimi-пути. До этого теста его не задавал никто.
            runtime.setConfigForTests(undefined as never);
            if (prevToken === undefined) delete process.env.RALPH_KIMI_AUTH_TOKEN;
            else process.env.RALPH_KIMI_AUTH_TOKEN = prevToken;
        }
        expect(cliVersionFn).toHaveBeenCalledWith('kimi');
        expect(order).toEqual(['version', 'spawn']);
        expect(attemptLines(logSpy)).toEqual([
            expect.stringContaining('Профиль claude-code/moonshot/kimi-m, CLI 2.1.311,'),
        ]);
    });
});

describe('readCliVersion — фактическая версия бинаря, никогда не бросает', () => {
    it('ответ CLI разбирается адаптером', () => {
        const spawnFn = spawnReturning({ stdout: VERSION_OUTPUT.codex });
        expect(ralph.readCliVersion('codex', parseCodexCliVersion, spawnFn)).toEqual({
            version: '0.163.0',
        });
        expect(spawnFn).toHaveBeenCalledWith('codex', ['--version'], expect.anything());
    });

    it('бинаря нет — unknown с причиной', () => {
        const error = Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' });
        const v = ralph.readCliVersion(
            'claude',
            parseClaudeCliVersion,
            spawnReturning({ status: null, error }),
        );
        expect(v).toEqual({
            version: CLI_VERSION_UNKNOWN,
            unknownReason: '`claude --version` не запустился: ENOENT',
        });
    });

    it('сигнал, ненулевой код и брошенный spawn — unknown с причиной', () => {
        const bySignal = ralph.readCliVersion(
            'claude',
            parseClaudeCliVersion,
            spawnReturning({ status: null, signal: 'SIGTERM' }),
        );
        expect(bySignal.unknownReason).toMatch(/убит сигналом SIGTERM/);
        const byCode = ralph.readCliVersion(
            'claude',
            parseClaudeCliVersion,
            spawnReturning({ status: 2 }),
        );
        expect(byCode.unknownReason).toMatch(/вернул код 2/);
        const thrown = ralph.readCliVersion('claude', parseClaudeCliVersion, () => {
            throw new Error('EAGAIN');
        });
        expect(thrown).toMatchObject({ version: CLI_VERSION_UNKNOWN });
        expect(thrown.unknownReason).toMatch(/EAGAIN/);
    });

    it('версия перед сессией: бинарь рантайма читается и сверяется с прошлой', () => {
        const readFn = vi.fn(() => ({ version: '0.163.0' }));
        const noteFn = vi.fn();
        expect(ralph.sessionCliVersion('openai', readFn, noteFn)).toEqual({ version: '0.163.0' });
        expect(readFn).toHaveBeenCalledWith('codex', parseCodexCliVersion);
        expect(noteFn).toHaveBeenCalledWith('codex', { version: '0.163.0' });
    });

    it('рантайм без записи в реестре профилей — unknown, бинарь не трогается', () => {
        expect(ralph.sessionCliVersion('nope')).toEqual({
            version: CLI_VERSION_UNKNOWN,
            unknownReason: "рантайм 'nope' без записи в RUNTIME_IDENTITIES",
        });
    });
});

describe('смена версии CLI между попытками — событие в журнале', () => {
    it('первая версия — не событие, та же — не событие, другая — событие и строка в логе', () => {
        // Свой бинарь на тест: память версий — прогона, и чужие тесты её не трогают.
        const bin = `test-bin-${Math.random()}`;
        const emitFn = vi.fn();
        const logs: string[] = [];
        const deps = { emitFn, logFn: (m: string) => logs.push(m) };
        ralph.noteCliVersion(bin, { version: '2.1.311' }, deps);
        ralph.noteCliVersion(bin, { version: '2.1.311' }, deps);
        expect(emitFn).not.toHaveBeenCalled();
        ralph.noteCliVersion(bin, { version: '2.1.312' }, deps);
        expect(emitFn).toHaveBeenCalledExactlyOnceWith('cli-version-changed', {
            bin,
            from: '2.1.311',
            to: '2.1.312',
        });
        expect(logs).toEqual([
            `🧩 Версия CLI \`${bin}\` сменилась между попытками: 2.1.311 → 2.1.312.`,
        ]);
    });

    it('нечитаемая версия сменой не считается и известную не затирает', () => {
        const bin = `test-bin-${Math.random()}`;
        const emitFn = vi.fn();
        const deps = { emitFn, logFn: () => {} };
        ralph.noteCliVersion(bin, { version: '0.163.0' }, deps);
        ralph.noteCliVersion(bin, { version: CLI_VERSION_UNKNOWN, unknownReason: 'x' }, deps);
        ralph.noteCliVersion(bin, { version: '0.163.0' }, deps);
        expect(emitFn).not.toHaveBeenCalled();
        ralph.noteCliVersion(bin, { version: '0.164.0' }, deps);
        expect(emitFn).toHaveBeenCalledExactlyOnceWith('cli-version-changed', {
            bin,
            from: '0.163.0',
            to: '0.164.0',
        });
    });
});

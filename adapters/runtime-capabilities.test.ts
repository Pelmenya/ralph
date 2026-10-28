// #118: рантайм объявляет возможности явно, и реестр без объявления не собирается.
//
// Три слоя: форма объявления (каждая причина отказа отдельно — скан, который ни разу не
// краснел, может не работать вовсе), объявления боевого реестра (`claude`, `kimi`, `openai`
// — у каждого ключа, и ровно то, что исполняет его CLI) и сборка реестра, которая
// отвергает рантайм без объявления, называя его.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts).
import ralph from '../ralph.js';
import type { CoderRuntimeAdapter } from './adapters.ts';
import {
    buildAdapters,
    CODER_RUNTIME_PROVIDERS,
    resolveAdapterSelection,
    type AdapterRegistries,
} from './adapters-impl.ts';
import {
    capabilitiesProblems,
    CLAUDE_CODE_CAPABILITIES,
    CODEX_CAPABILITIES,
    KIMI_CAPABILITIES,
    runtimeSectionProblems,
} from './runtime-capabilities.ts';

const throwingFail = (msg: string): never => {
    throw new Error(msg);
};

describe('capabilitiesProblems — форма объявления', () => {
    it('годное объявление — без замечаний', () => {
        expect(capabilitiesProblems({ turnLimit: 'required', fallbackModel: true })).toEqual([]);
        expect(capabilitiesProblems({ turnLimit: 'best-effort', fallbackModel: false })).toEqual(
            [],
        );
    });

    it.each([undefined, null, 'required', [], 42])('НЕГАТИВНЫЙ: %j — «не объявлены»', (caps) => {
        expect(capabilitiesProblems(caps)).toEqual([
            expect.stringMatching(/возможности не объявлены/),
        ]);
    });

    it('НЕГАТИВНЫЙ: незнакомый уровень turnLimit назван с допустимыми', () => {
        expect(capabilitiesProblems({ turnLimit: 'guaranteed', fallbackModel: true })).toEqual([
            expect.stringMatching(/turnLimit = "guaranteed".*best-effort \| required/),
        ]);
    });

    it('toolless необязателен, но заданный — только булево', () => {
        const base = { turnLimit: 'required', fallbackModel: true };
        expect(capabilitiesProblems({ ...base, toolless: true })).toEqual([]);
        expect(capabilitiesProblems({ ...base, toolless: 'yes' })).toEqual([
            expect.stringMatching(/toolless = "yes"/),
        ]);
    });

    it('НЕГАТИВНЫЙ: пропущенные поля — каждое своей причиной', () => {
        const problems = capabilitiesProblems({});
        expect(problems).toHaveLength(2);
        expect(problems[0]).toMatch(/turnLimit/);
        expect(problems[1]).toMatch(/fallbackModel = undefined/);
    });
});

describe('объявления боевого реестра coderRuntime', () => {
    const registry = ralph.adapterRegistries.coderRuntime as AdapterRegistries['coderRuntime'];

    it('у каждого ключа реестра объявление годной формы', () => {
        expect(Object.keys(registry).sort()).toEqual([...CODER_RUNTIME_PROVIDERS].sort());
        for (const [name, impl] of Object.entries(registry)) {
            expect(capabilitiesProblems(impl.capabilities), name).toEqual([]);
        }
    });

    it('объявлено то, что исполняет CLI: Claude Code держит потолок, Codex — нет', () => {
        expect(registry.claude.capabilities).toBe(CLAUDE_CODE_CAPABILITIES);
        expect(registry.kimi.capabilities).toBe(KIMI_CAPABILITIES);
        expect(registry.openai.capabilities).toBe(CODEX_CAPABILITIES);
        expect(CLAUDE_CODE_CAPABILITIES.turnLimit).toBe('required');
        // Kimi — харнесс Claude Code: флаг `--max-turns` тот же.
        expect(KIMI_CAPABILITIES.turnLimit).toBe('required');
        // `codex exec` аналога `--max-turns` не имеет и в argv его не получает.
        expect(CODEX_CAPABILITIES).toEqual({
            turnLimit: 'best-effort',
            fallbackModel: false,
            toolless: false,
        });
    });

    // #217: сессию без инструментов объявляет только CLI с флагом запрета ВСЕХ инструментов.
    it('toolless — только у харнесса Claude Code, остальные объявляют «не умеет» явно', () => {
        const toolless = Object.fromEntries(
            Object.entries(registry).map(([name, impl]) => [name, impl.capabilities.toolless]),
        );
        expect(toolless).toEqual({
            claude: true,
            kimi: true,
            openai: false,
            'kimi-native': false,
            opencode: false,
        });
    });
});

describe('buildAdapters: реестр без объявления не принимается', () => {
    function registries(runtimes: Record<string, unknown>): AdapterRegistries {
        return {
            taskSource: { github: {} },
            gate: { npm: {} },
            notifier: { telegram: {} },
            deployCheck: { 'github-actions': {} },
            coderRuntime: runtimes,
        } as unknown as AdapterRegistries;
    }
    const runtime = (extra: Record<string, unknown> = {}) => ({
        run: () => ({ code: 0, output: '' }),
        checkAvailable: () => {},
        ...extra,
    });
    const selection = resolveAdapterSelection(undefined, throwingFail);

    it('рантайм с объявлением собирается', () => {
        const reg = registries({ claude: runtime({ capabilities: CLAUDE_CODE_CAPABILITIES }) });
        const built = buildAdapters(reg, selection, throwingFail);
        expect((built.coderRuntime as CoderRuntimeAdapter).capabilities).toBe(
            CLAUDE_CODE_CAPABILITIES,
        );
    });

    it('НЕГАТИВНЫЙ: рантайм без объявления — отказ с его именем', () => {
        const reg = registries({ claude: runtime() });
        expect(() => buildAdapters(reg, selection, throwingFail)).toThrow(
            /рантайм 'claude' не объявил возможности.*не объявлены/,
        );
    });

    // Фолбэк и маршруты modelRouting берут рантаймы мимо `selection`: проверяется весь
    // реестр, а не только выбранный ключ.
    it('НЕГАТИВНЫЙ: невыбранный рантайм без объявления тоже валит сборку', () => {
        const reg = registries({
            claude: runtime({ capabilities: CLAUDE_CODE_CAPABILITIES }),
            opencode: runtime({ capabilities: { turnLimit: 'maybe', fallbackModel: false } }),
        });
        expect(() => buildAdapters(reg, selection, throwingFail)).toThrow(
            /рантайм 'opencode'.*turnLimit = "maybe"/,
        );
    });
});

describe('runtimeSectionProblems — форма секции рантайма', () => {
    it('секции нет — молчание; не объект — отказ', () => {
        expect(runtimeSectionProblems('x', undefined, ['a'])).toEqual([]);
        expect(runtimeSectionProblems('x', null, ['a'])).toEqual(['x = null — ожидался объект']);
        expect(runtimeSectionProblems('x', 'a', ['a'])).toEqual(['x = "a" — ожидался объект']);
    });

    it('незнакомый ключ и пустая или не-строка — каждая причина названа', () => {
        expect(runtimeSectionProblems('x', { a: 'ok', b: 'y', c: 1 }, ['a', 'c'])).toEqual([
            'x.b — незнакомый ключ (допустимы: a, c)',
            'x.c = 1 — ожидалась непустая строка',
        ]);
    });
});

// #118: требования конфига сверяются с объявленными возможностями рантайма до выбора задачи.
//
// Критерии карточки по одному: строгое требование, которого рантайм не объявил, — отказ с
// именем рантайма и возможности; `best-effort` не роняет запуск, а говорит в лог, что
// гарантии нет. Плюс место шага в `main()` — до worktree, preflight и первой итерации, где
// выбирается задача.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts).
import ralph from '../ralph.js';
import { CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES } from '../adapters/runtime-capabilities.ts';
import type { RuntimeCapabilities } from '../adapters/adapters.ts';
import { stripComments } from '../tests/strip-comments.ts';
import { checkRuntimeRequirements, resolveTurnLimit } from './runtime-requirements.ts';

const throwingFail = (msg: string): never => {
    throw new Error(msg);
};

const caps: Record<string, RuntimeCapabilities> = {
    claude: CLAUDE_CODE_CAPABILITIES,
    openai: CODEX_CAPABILITIES,
};

function check(cfg: { turnLimit?: unknown; fallbackModel?: unknown }, providers: string[]) {
    const logFn = vi.fn();
    const failFn = vi.fn(throwingFail);
    const run = () =>
        checkRuntimeRequirements(cfg, providers, {
            capabilitiesOf: (p) => caps[p],
            failFn,
            logFn,
        });
    return { run, logFn, failFn };
}

describe('resolveTurnLimit — строгость задаётся явно', () => {
    it('ключа нет — best-effort', () => {
        expect(resolveTurnLimit(undefined, throwingFail)).toBe('best-effort');
    });

    it('явные значения принимаются как есть', () => {
        expect(resolveTurnLimit('required', throwingFail)).toBe('required');
        expect(resolveTurnLimit('best-effort', throwingFail)).toBe('best-effort');
    });

    it.each(['requred', '', null, true, 1])(
        'НЕГАТИВНЫЙ: %j — отказ, а не тихий best-effort',
        (raw) => {
            expect(() => resolveTurnLimit(raw, throwingFail)).toThrow(
                /turnLimit = .*допустимы 'best-effort' и 'required'/,
            );
        },
    );
});

describe('checkRuntimeRequirements — сверка с объявлениями', () => {
    it('НЕГАТИВНЫЙ: required у рантайма без гарантии — отказ, названы рантайм и возможность', () => {
        const { run, logFn } = check({ turnLimit: 'required' }, ['claude', 'openai']);
        expect(run).toThrow(/Рантайм 'openai'.*turnLimit: 'best-effort'.*turnLimit: 'required'/);
        expect(run).toThrow(/до выбора задачи/);
        expect(logFn).not.toHaveBeenCalled();
    });

    it('required у рантайма, который его гарантирует, — молча проходит', () => {
        const { run, logFn, failFn } = check({ turnLimit: 'required' }, ['claude']);
        run();
        expect(failFn).not.toHaveBeenCalled();
        expect(logFn).not.toHaveBeenCalled();
    });

    it('best-effort (ключа нет) не роняет запуск, а пишет в лог, что гарантии нет', () => {
        const { run, logFn, failFn } = check({}, ['claude', 'openai']);
        run();
        expect(failFn).not.toHaveBeenCalled();
        expect(logFn).toHaveBeenCalledTimes(1);
        expect(logFn).toHaveBeenCalledWith(
            expect.stringMatching(/Рантайм 'openai'.*best-effort, гарантии нет.*maxIterations/),
        );
    });

    it('явный best-effort — то же, что пропущенный', () => {
        const { run, logFn, failFn } = check({ turnLimit: 'best-effort' }, ['openai']);
        run();
        expect(failFn).not.toHaveBeenCalled();
        expect(logFn).toHaveBeenCalledWith(expect.stringMatching(/гарантии нет/));
    });

    it('НЕГАТИВНЫЙ: рантайм без объявления — отказ, а не «умеет всё»', () => {
        const { run } = check({}, ['opencode']);
        expect(run).toThrow(/Рантайм 'opencode' не объявил возможностей/);
    });

    // Ревью Фазы 16b: `capabilities.fallbackModel` объявлялся, а ядро его не читало — общий
    // фолбэк у Codex молча игнорировался.
    it('общий fallbackModel у рантайма без фолбэка — строка ⚠ с именем рантайма, не стоп', () => {
        const { run, logFn, failFn } = check(
            { turnLimit: 'best-effort', fallbackModel: 'sonnet' },
            ['claude', 'openai'],
        );
        run();
        expect(failFn).not.toHaveBeenCalled();
        expect(logFn).toHaveBeenCalledWith(
            expect.stringMatching(/Рантайм 'openai': фолбэк-модели нет.*"sonnet"/),
        );
        expect(logFn).not.toHaveBeenCalledWith(expect.stringMatching(/'claude'/));
    });

    it.each([undefined, 'none', ''])('fallbackModel %j — фолбэк не заказан, строки нет', (fb) => {
        const { run, logFn } = check({ fallbackModel: fb }, ['openai']);
        run();
        expect(logFn).not.toHaveBeenCalledWith(expect.stringMatching(/фолбэк-модели нет/));
    });

    it('НЕГАТИВНЫЙ: битое значение ключа — отказ до сверки рантаймов', () => {
        const { run, logFn } = check({ turnLimit: 'strict' }, ['openai']);
        expect(run).toThrow(/turnLimit = "strict"/);
        expect(logFn).not.toHaveBeenCalled();
    });
});

// Шаг оркестратора на боевом реестре: достижимые рантаймы — те же, что у пробы готовности
// (статический плюс маршруты modelRouting), объявления — от самих реализаций.
describe('checkRuntimeCapabilities — шаг старта на боевом реестре', () => {
    const cfg = (extra = {}) => ({ active: true, phases: [], ...extra });

    it('НЕГАТИВНЫЙ: required и фолбэк лимита на openai — стоп с именем рантайма', () => {
        expect(() =>
            ralph.checkRuntimeCapabilities(
                cfg({
                    turnLimit: 'required',
                    modelRouting: { apiLimitFallback: { provider: 'openai', model: 'o' } },
                }),
                { failFn: throwingFail, logFn: () => {} },
            ),
        ).toThrow(/Рантайм 'openai' не гарантирует бюджет ходов/);
    });

    it('required только на claude — проходит без строки', () => {
        const logFn = vi.fn();
        ralph.checkRuntimeCapabilities(cfg({ turnLimit: 'required' }), {
            failFn: throwingFail,
            logFn,
        });
        expect(logFn).not.toHaveBeenCalled();
    });

    it('без строгого требования openai в маршруте — строка «гарантии нет», не стоп', () => {
        const logFn = vi.fn();
        ralph.checkRuntimeCapabilities(
            cfg({ modelRouting: { apiLimitFallback: { provider: 'openai', model: 'o' } } }),
            { failFn: throwingFail, logFn },
        );
        expect(logFn).toHaveBeenCalledWith(expect.stringMatching(/'openai'.*гарантии нет/));
    });
});

// Место шага в main() — структурный барьер по тексту, как у пробы готовности (#44): main()
// поднимает лок, worktree и монитор, и гонять его в сьюте нельзя. Выбор задачи идёт в
// runLoop после preflight, поэтому «выше preflight» и есть «до выбора issue».
describe('main(): сверка возможностей стоит до worktree, preflight и цикла (#118)', () => {
    const source = stripComments(
        fs.readFileSync(path.resolve(import.meta.dirname, './orchestrator.ts'), 'utf-8'),
    );
    const body = source.slice(source.indexOf('function main('));
    const at = (re: RegExp) => {
        const m = re.exec(body);
        return m ? m.index : -1;
    };

    it('вызов один, под `if (!RESET)` и выше worktree, preflight и runLoop', () => {
        const calls = [...body.matchAll(/checkRuntimeCapabilities\(\s*config\s*\)/g)];
        expect(calls, 'не нашёл вызова checkRuntimeCapabilities(config) в main()').toHaveLength(1);
        const step = calls[0].index;
        expect(body).toMatch(/if\s*\(\s*!RESET\s*\)\s*checkRuntimeCapabilities\(\s*config\s*\)/);
        for (const later of [
            /ensureRunnerWorktree\(worktreePath\)/,
            /[^.\w]preflight\(\s*config[\s,)]/,
            /[^.\w]runLoop\(/,
        ]) {
            const idx = at(later);
            expect(idx, String(later)).toBeGreaterThan(-1);
            expect(step, String(later)).toBeLessThan(idx);
        }
    });
});

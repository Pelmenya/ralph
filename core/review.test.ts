// Юнит-тесты модуля ревью (#363). Основная часть проверяет САМУ фабрику
// createReviewModule — что она собирает рабочие функции из синтетического env,
// независимо от ralph.js: контракт extraction'а — модуль самодостаточен и переносим
// (цель фазы 3), а не «работает только пока его зовёт ralph.js».
//
// В конце файла — блоки, перенесённые из ralph.test.js при её разнесении по модулям
// (#366): они ходят через боевую поверхность ralph.js и покрывают сценарии, которых
// фабричные тесты не видят.
//
// matchRiskPaths/phaseDiffFiles инжектируются заглушками: pickReviewModel лишь ДЕЛЕГИРУЕТ
// им сопоставление зоны риска и сбор диффа, поэтому здесь тестируется его проводка
// (эскалирует, когда matchRiskPaths вернул хит), а не сам глоб-матчинг — тот покрыт своим
// describe в orchestrator.test.ts.
import { describe, it, expect, vi } from 'vitest';
import type { ReviewEnv } from './review.ts';
import { createReviewModule } from './review.ts';
import { shq } from '../shared/ralph-util.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов; блоки в конце файла
// перенесены из ralph.test.js как есть и ходят через его ре-экспорт (#366).
import ralph from '../ralph.js';

// Синтетический env: побочки (ghJson/sh/shArgv/fail) по умолчанию громко падают, если
// функция под тестом дёрнет их без явного override — забытый override становится ошибкой
// теста, а не тихим проходом через боевой gh/shell. Чистые коллабораторы (shq,
// isPlainObject, matchRiskPaths, phaseDiffFiles, log, getConfig) — рабочие заглушки.
function makeEnv(over: Partial<ReviewEnv> = {}): ReviewEnv {
    return {
        getConfig: () => ({}),
        ghJson: () => {
            throw new Error('ghJson не подменён в тесте');
        },
        sh: () => {
            throw new Error('sh не подменён в тесте');
        },
        shArgv: () => {
            throw new Error('shArgv не подменён в тесте');
        },
        shq,
        log: () => {},
        fail: (m: string) => {
            throw new Error(`fail не подменён в тесте: ${m}`);
        },
        isPlainObject: (v: unknown): v is Record<string, unknown> =>
            v !== null && typeof v === 'object' && !Array.isArray(v),
        matchRiskPaths: () => null,
        phaseDiffFiles: () => [],
        // #37: метки задач фазы приходят из шва, а не из `gh` в ядре. Дефолт громкий —
        // как у побочек выше: тест, дошедший сюда без override, обязан краснеть.
        milestoneLabels: () => {
            throw new Error('milestoneLabels не подменён в тесте');
        },
        // #37: комментарии PR — тоже из шва. Дефолт громкий по той же причине: запись в
        // журнал без подменённого чтения означала бы поход в настоящий форж.
        prComments: () => {
            throw new Error('prComments не подменён в тесте');
        },
        ...over,
    };
}

const CFG = {
    review: {
        default: 'claude-opus-4-8',
        escalated: 'claude-fable-5',
        escalateOn: [],
        escalateOnPaths: ['.github/workflows/**', '.claude/ralph/**'],
    },
};

describe('pickReviewModel — эскалация ревью (#130)', () => {
    it('дифф вне зон риска — ревьюит дефолтная модель', () => {
        const { pickReviewModel } = createReviewModule(makeEnv({ matchRiskPaths: () => null }));
        const model = pickReviewModel('Фаза X', 'feature/x', {
            cfg: CFG,
            files: ['src/app/page.tsx', 'README.md'],
        });
        expect(model).toBe('claude-opus-4-8');
    });

    it('дифф трогает зону риска — эскалация на дорогую модель', () => {
        const { pickReviewModel } = createReviewModule(
            makeEnv({ matchRiskPaths: () => '.github/workflows/deploy.yml' }),
        );
        const model = pickReviewModel('Фаза X', 'feature/x', {
            cfg: CFG,
            files: ['.github/workflows/deploy.yml'],
        });
        expect(model).toBe('claude-fable-5');
    });

    it('метка сложности сама по себе больше НЕ эскалирует (escalateOn пуст)', () => {
        // Ровно та регрессия, ради которой заведён #130: complexity:expert описывает
        // трудность написания, а не цену ошибки. escalateOn пуст → gh issue list вовсе не
        // зовётся, метки не смотрятся.
        const ghJson = vi.fn(() => [{ labels: [{ name: 'complexity:expert' }] }]);
        const { pickReviewModel } = createReviewModule(
            makeEnv({ ghJson, matchRiskPaths: () => null }),
        );
        const model = pickReviewModel('Фаза X', 'feature/x', {
            cfg: CFG,
            files: ['src/app/page.tsx'],
        });
        expect(model).toBe('claude-opus-4-8');
        expect(ghJson).not.toHaveBeenCalled();
    });

    it('escalateOn всё ещё работает, если его осознанно заполнили', () => {
        const cfg = { review: { ...CFG.review, escalateOn: ['complexity:expert'] } };
        const { pickReviewModel } = createReviewModule(
            makeEnv({ milestoneLabels: () => ['complexity:expert', 'area:devops'] }),
        );
        const model = pickReviewModel('Фаза X', 'feature/x', { cfg, files: ['src/app/page.tsx'] });
        expect(model).toBe('claude-fable-5');
    });

    it('#37 метки фазы читаются ЧЕРЕЗ ШОВ, а не командой форжа в ядре', () => {
        // Прежде здесь стоял прямой `gh issue list`: на площадке без `gh` он падал в
        // catch, и ревью зоны риска тихо доставалось слабой модели.
        const cfg = { review: { ...CFG.review, escalateOn: ['complexity:expert'] } };
        const ghJson = vi.fn(() => []);
        const milestoneLabels = vi.fn(() => ['complexity:expert']);
        const { pickReviewModel } = createReviewModule(makeEnv({ ghJson, milestoneLabels }));
        pickReviewModel('Фаза X', 'feature/x', { cfg, files: ['src/app/page.tsx'] });
        expect(milestoneLabels).toHaveBeenCalledWith('Фаза X');
        expect(ghJson).not.toHaveBeenCalled();
    });

    it('#37 сбой чтения меток фазы → ЭСКАЛИРУЕМ, а не тихо ревьюим слабее', () => {
        // Прежнее поведение (деградация на default) — тихая потеря строгости ровно там,
        // где она нужна: «не смогли узнать, есть ли в фазе сложная задача» это не
        // «сложных задач нет». Цена ошибки в сторону эскалации — минуты сильной модели,
        // в другую сторону — непойманный дефект.
        const cfg = { review: { ...CFG.review, escalateOn: ['complexity:expert'] } };
        const logs: string[] = [];
        const milestoneLabels = vi.fn(() => {
            throw new Error('форж недоступен');
        });
        const { pickReviewModel } = createReviewModule(
            makeEnv({ log: (m) => logs.push(m), milestoneLabels, matchRiskPaths: () => null }),
        );
        const model = pickReviewModel('Фаза X', 'feature/x', { cfg, files: ['src/app/page.tsx'] });
        // Эскалация именно ПО ОТКАЗУ чтения: без этого ассерта тест остался бы зелёным и
        // в мире, где меток не спрашивают вовсе, а эскалируют по какой-то другой причине.
        expect(milestoneLabels).toHaveBeenCalledWith('Фаза X');
        expect(model).toBe('claude-fable-5');
        expect(logs.join('\n')).toMatch(/метк/i);
    });

    it('зона риска, но review.escalated не задан — деградация на default + предупреждение', () => {
        // Находка ревью PR #132: эскалация без escalated-модели вернула бы undefined, и
        // runLoop пропустил бы ревью ЦЕЛИКОМ. Деградируем на default.
        const cfg = { review: { default: 'claude-opus-4-8', escalateOnPaths: ['.claude/**'] } };
        const logs: string[] = [];
        const { pickReviewModel } = createReviewModule(
            makeEnv({ log: (m) => logs.push(m), matchRiskPaths: () => '.claude/ralph/ralph.js' }),
        );
        const model = pickReviewModel('Фаза X', 'feature/x', {
            cfg,
            files: ['.claude/ralph/ralph.js'],
        });
        expect(model).toBe('claude-opus-4-8');
        expect(logs.join('\n')).toMatch(/escalated не задан/i);
    });

    it('легаси-конфиг без блока review — прежнее поле reviewModel', () => {
        const { pickReviewModel } = createReviewModule(makeEnv());
        expect(pickReviewModel('Фаза X', 'feature/x', { cfg: { reviewModel: 'none' } })).toBe(
            'none',
        );
    });

    it('files переданы извне — phaseDiffFiles не зовётся (дифф собран один раз, #135)', () => {
        const phaseDiffFiles = vi.fn(() => ['ignored']);
        const { pickReviewModel } = createReviewModule(
            makeEnv({ phaseDiffFiles, matchRiskPaths: () => null }),
        );
        pickReviewModel('Фаза X', 'feature/x', { cfg: CFG, files: ['src/app/page.tsx'] });
        expect(phaseDiffFiles).not.toHaveBeenCalled();
    });

    it('files НЕ переданы — phaseDiffFiles зовётся для сбора диффа', () => {
        const phaseDiffFiles = vi.fn(() => ['.github/workflows/deploy.yml']);
        const matchRiskPaths = vi.fn(() => '.github/workflows/deploy.yml');
        const { pickReviewModel } = createReviewModule(makeEnv({ phaseDiffFiles, matchRiskPaths }));
        const model = pickReviewModel('Фаза X', 'feature/x', { cfg: CFG });
        expect(phaseDiffFiles).toHaveBeenCalledWith('feature/x', expect.any(Object));
        expect(matchRiskPaths).toHaveBeenCalledWith(
            ['.github/workflows/deploy.yml'],
            CFG.review.escalateOnPaths,
        );
        expect(model).toBe('claude-fable-5');
    });

    it('cfg по умолчанию берётся из getConfig (живой config раннера)', () => {
        // getConfig, а не снимок: config заполняется в main() ПОСЛЕ сборки фабрики.
        const { pickReviewModel } = createReviewModule(
            makeEnv({ getConfig: () => CFG, matchRiskPaths: () => null }),
        );
        expect(pickReviewModel('Фаза X', 'feature/x', { files: ['README.md'] })).toBe(
            'claude-opus-4-8',
        );
    });
});

describe('pickReviewFallbackModel — фолбэк ревью, дефолт review.default (#221)', () => {
    const build = (over: Partial<ReviewEnv> = {}) =>
        createReviewModule(makeEnv(over)).pickReviewFallbackModel;

    it('review.fallback задан — возвращается как есть', () => {
        const cfg = { review: { default: 'claude-opus-4-8', fallback: 'claude-fable-5' } };
        expect(build()(cfg)).toBe('claude-fable-5');
    });

    it('review.fallback не задан — дефолт на review.default (не остаётся без фолбэка)', () => {
        expect(build()({ review: { default: 'claude-opus-4-8' } })).toBe('claude-opus-4-8');
    });

    it('review.fallback = "none" — осознанный отказ, вернёт строку "none" (не null)', () => {
        const cfg = { review: { default: 'claude-opus-4-8', fallback: 'none' } };
        expect(build()(cfg)).toBe('none');
    });

    it('блока review нет вовсе — null', () => {
        expect(build()({})).toBe(null);
    });

    it('review — не объект (легаси reviewModel) — null, а не исключение', () => {
        expect(build()({ reviewModel: 'claude-opus-4-8' })).toBe(null);
    });

    it('cfg по умолчанию берётся из getConfig', () => {
        const fb = build({ getConfig: () => ({ review: { default: 'claude-opus-4-8' } }) });
        expect(fb()).toBe('claude-opus-4-8');
    });
});

describe('reviewModelRank — ранг силы модели (#217)', () => {
    const { reviewModelRank } = createReviewModule(makeEnv());

    it('известные модели упорядочены haiku < sonnet < opus < fable', () => {
        expect(reviewModelRank('claude-haiku-4-5-20251001')).toBeLessThan(
            reviewModelRank('claude-sonnet-5'),
        );
        expect(reviewModelRank('claude-sonnet-5')).toBeLessThan(reviewModelRank('claude-opus-4-8'));
        expect(reviewModelRank('claude-opus-4-8')).toBeLessThan(reviewModelRank('claude-fable-5'));
    });

    it('неизвестная/пустая модель → -1 (слабее любой известной)', () => {
        expect(reviewModelRank('claude-mystery')).toBe(-1);
        expect(reviewModelRank(undefined)).toBe(-1);
        expect(reviewModelRank(null)).toBe(-1);
    });
});

describe('strongerReviewModel — поднять планку до сильнейшей (#217)', () => {
    const { strongerReviewModel } = createReviewModule(makeEnv());

    it('возвращает сильнейшую из двух известных', () => {
        expect(strongerReviewModel('claude-opus-4-8', 'claude-fable-5')).toBe('claude-fable-5');
        expect(strongerReviewModel('claude-fable-5', 'claude-opus-4-8')).toBe('claude-fable-5');
    });

    it('null / undefined / "none" у аргумента игнорируется — берётся вторая', () => {
        expect(strongerReviewModel(null, 'claude-opus-4-8')).toBe('claude-opus-4-8');
        expect(strongerReviewModel('claude-opus-4-8', undefined)).toBe('claude-opus-4-8');
        expect(strongerReviewModel('none', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    });

    it('обе пусты → null', () => {
        expect(strongerReviewModel(null, undefined)).toBe(null);
        expect(strongerReviewModel('none', 'none')).toBe(null);
    });

    it('известная всегда побеждает неизвестную (rank -1)', () => {
        expect(strongerReviewModel('claude-mystery', 'claude-haiku-4-5-20251001')).toBe(
            'claude-haiku-4-5-20251001',
        );
    });
});

describe('assertKnownReviewModels — fail-closed планка моделей ревью на старте (#221/#223)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };

    it('все модели известны и фолбэк не слабее default → true', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        const cfg = {
            review: {
                default: 'claude-opus-4-8',
                escalated: 'claude-fable-5',
                fallback: 'claude-opus-4-8',
            },
        };
        expect(assertKnownReviewModels(cfg, 'prod', boom)).toBe(true);
    });

    it('review не задан — планке нечего проверять, true', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        expect(assertKnownReviewModels({}, 'playground', boom)).toBe(true);
    });

    it('незнакомая модель в review.default → стоп (barrier #223)', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        expect(() =>
            assertKnownReviewModels({ review: { default: 'claude-mystery' } }, 'prod', boom),
        ).toThrow(/review\.default.*claude-mystery.*REVIEW_MODEL_STRENGTH/s);
    });

    it('незнакомая модель в review.fallback → стоп (тот же класс дрейфа)', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        expect(() =>
            assertKnownReviewModels(
                { review: { default: 'claude-opus-4-8', fallback: 'claude-mystery' } },
                'prod',
                boom,
            ),
        ).toThrow(/review\.fallback.*claude-mystery.*REVIEW_MODEL_STRENGTH/s);
    });

    it('review.fallback слабее review.default → стоп (#221, не тихая деградация)', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        expect(() =>
            assertKnownReviewModels(
                { review: { default: 'claude-opus-4-8', fallback: 'claude-haiku-4-5-20251001' } },
                'prod',
                boom,
            ),
        ).toThrow(/review\.fallback.*claude-haiku-4-5-20251001.*слабее.*review\.default/s);
    });

    it('review.fallback = "none" — осознанный отказ, планку не валит', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        const cfg = { review: { default: 'claude-opus-4-8', fallback: 'none' } };
        expect(assertKnownReviewModels(cfg, 'prod', boom)).toBe(true);
    });

    it('фолбэк той же силы, что default — принимается', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        const cfg = { review: { default: 'claude-opus-4-8', fallback: 'claude-fable-5' } };
        expect(assertKnownReviewModels(cfg, 'prod', boom)).toBe(true);
    });

    // #625: арбитр — последняя ступень лестницы ревью правок, и он проверяется тем же
    // циклом. Незнакомая модель получила бы ранг -1, планка reviewModelFloor «подняла» бы
    // его до модели предыдущего прохода — и независимый арбитр молча стал бы тем же
    // ревьюером, от согласия которого он и спасает.
    it('незнакомая модель в review.arbiter → стоп (#625)', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        expect(() =>
            assertKnownReviewModels(
                { review: { default: 'claude-opus-4-8', arbiter: 'claude-mystery' } },
                'prod',
                boom,
            ),
        ).toThrow(/review\.arbiter.*claude-mystery.*REVIEW_MODEL_STRENGTH/s);
    });

    it('известная модель арбитра принимается', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        expect(
            assertKnownReviewModels(
                { review: { default: 'claude-opus-4-8', arbiter: 'claude-fable-5' } },
                'prod',
                boom,
            ),
        ).toBe(true);
    });
});

// #625: журнал различает проходы. Запись прохода — отдельная функция: счёт ей приносит
// петля (только она знает, что в проходе НОВОГО), в форж эта запись не ходит вовсе.
describe('recordFixReviewFindings — журнальная запись прохода ревью правок (#625)', () => {
    const COUNTS = { blocker: 1, major: 0, minor: 2, nit: 0, unmarked: 0, total: 3 };

    it('зовёт журнал через argv с готовым счётом и номером прохода', () => {
        const calls: Array<{ file: string; args: string[] }> = [];
        const { recordFixReviewFindings } = createReviewModule(makeEnv());
        recordFixReviewFindings(
            { milestone: 'M1' },
            42,
            COUNTS,
            2,
            (file: string, args: string[]) => {
                calls.push({ file, args });
                return '{"ok":true}';
            },
            () => {},
        );
        expect(calls).toHaveLength(1);
        expect(calls[0].file).toBe('node');
        expect(calls[0].args).toEqual([
            'scripts/review-findings-journal.mjs',
            '42',
            'M1',
            `--counts=${JSON.stringify(COUNTS)}`,
            '--pass=2',
        ]);
    });

    it('номер PR неизвестен → запись пропущена, журнал не зовётся', () => {
        const logs: string[] = [];
        const { recordFixReviewFindings } = createReviewModule(makeEnv());
        recordFixReviewFindings(
            { milestone: 'M1' },
            null,
            COUNTS,
            1,
            () => {
                throw new Error('журнал звать не должны');
            },
            (m: string) => logs.push(m),
        );
        expect(logs.join('\n')).toMatch(/номер PR неизвестен/);
    });

    it('сбой записи не роняет цикл сдачи — метрика не имеет права остановить петлю', () => {
        const logs: string[] = [];
        const { recordFixReviewFindings } = createReviewModule(makeEnv());
        expect(() =>
            recordFixReviewFindings(
                { milestone: 'M1' },
                42,
                COUNTS,
                1,
                () => {
                    throw new Error('диск полон');
                },
                (m: string) => logs.push(m),
            ),
        ).not.toThrow();
        expect(logs.join('\n')).toMatch(/не критично/);
    });
});

// Порядок сил моделей — ДАННЫЕ проекта, а не константа ядра: каждый релиз моделей иначе
// требовал бы правки review.ts в каждом форке (грабля 3 журнала переносимости). Барьер
// #217/#223 при этом не ослабляется — список по-прежнему закрытый, просто его источник
// теперь конфиг с встроенным дефолтом.
describe('review.modelStrength — планка задаётся конфигом (переносимость)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };

    it('модель из конфигурного списка принимается, хотя её нет во встроенном дефолте', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        const cfg = {
            review: {
                modelStrength: ['claude-haiku-4-5-20251001', 'claude-neo-9'],
                default: 'claude-neo-9',
            },
        };
        expect(assertKnownReviewModels(cfg, 'prod', boom)).toBe(true);
    });

    it('порядок из конфига определяет ранг: фолбэк слабее default → стоп', () => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        const cfg = {
            review: {
                modelStrength: ['claude-weak', 'claude-strong'],
                default: 'claude-strong',
                fallback: 'claude-weak',
            },
        };
        expect(() => assertKnownReviewModels(cfg, 'prod', boom)).toThrow(
            /review\.fallback.*claude-weak.*слабее.*review\.default/s,
        );
    });

    it('без modelStrength действует встроенный дефолт', () => {
        const { assertKnownReviewModels, reviewModelStrength } = createReviewModule(makeEnv());
        expect(
            assertKnownReviewModels({ review: { default: 'claude-opus-4-8' } }, 'prod', boom),
        ).toBe(true);
        expect(reviewModelStrength({})).toContain('claude-fable-5');
    });

    // Fail-closed, а не «молча возьмём дефолт»: кривой список — это опечатка в конфиге,
    // и тихий откат к дефолту дал бы планку, которой автор конфига не заказывал.
    it.each([
        ['не массив', 'claude-opus-4-8'],
        ['пустой массив', []],
        ['нестроковый элемент', ['claude-opus-4-8', 42]],
        ['пустая строка', ['claude-opus-4-8', '  ']],
        ['дубли', ['claude-opus-4-8', 'claude-opus-4-8']],
    ])('кривой modelStrength (%s) → стоп на старте', (_name, bad) => {
        const { assertKnownReviewModels } = createReviewModule(makeEnv());
        expect(() =>
            assertKnownReviewModels(
                { review: { modelStrength: bad, default: 'claude-opus-4-8' } },
                'prod',
                boom,
            ),
        ).toThrow(/review\.modelStrength/);
    });
});

describe('recordReviewFindings — best-effort вызов журнала находок (#169)', () => {
    const COMMENTS = [{ body: '🔴 [blocker] дыра', isSummary: false, author: 'alice' }];

    it('валидный PR → зовёт журнал с номером, milestone и доверенными авторами', () => {
        const shArgv = vi.fn(() => 'ok');
        const { recordReviewFindings } = createReviewModule(
            makeEnv({ shArgv, prComments: () => COMMENTS }),
        );
        recordReviewFindings({ milestone: 'M1' }, 42, ['alice', 'bob']);
        expect(shArgv.mock.calls[0].slice(0, 2)).toEqual([
            'node',
            ['scripts/review-findings-journal.mjs', '42', 'M1', 'alice', 'bob'],
        ]);
    });

    // #37: лента уходит на stdin, а не в argv. Предел одного аргумента у ядра ОС жёсткий,
    // и обрезанная лента дала бы тихо заниженный счёт вместо отказа.
    it('лента комментариев уходит счётчику на stdin, а не в argv', () => {
        const shArgv = vi.fn((_file: string, _args: string[], _opts?: { input?: string }) => 'ok');
        const { recordReviewFindings } = createReviewModule(
            makeEnv({ shArgv, prComments: () => COMMENTS }),
        );
        recordReviewFindings({ milestone: 'M1' }, 42, ['alice']);
        expect(JSON.parse(String(shArgv.mock.calls[0][2]?.input))).toEqual(COMMENTS);
        expect(shArgv.mock.calls[0][1].join(' ')).not.toContain('blocker');
    });

    it('комментарии читаются ШВОМ по номеру PR, а не добываются журналом', () => {
        const seen: number[] = [];
        const { recordReviewFindings } = createReviewModule(
            makeEnv({
                shArgv: () => 'ok',
                prComments: (pr: number) => {
                    seen.push(pr);
                    return COMMENTS;
                },
            }),
        );
        recordReviewFindings({ milestone: 'M1' }, 42);
        expect(seen).toEqual([42]);
    });

    // Ключевое свойство #37: сбой ЧТЕНИЯ и «находок нет» обязаны различаться. Запись нулей
    // после непрочитанного ревью хуже пропуска — пропуск виден дырой в ряду фаз, а нули
    // читаются как факт.
    it('сбой чтения комментариев → записи НЕТ вовсе, а не нули в журнале', () => {
        const shArgv = vi.fn(() => 'ok');
        const logs: string[] = [];
        const { recordReviewFindings } = createReviewModule(
            makeEnv({
                shArgv,
                log: (m) => logs.push(m),
                prComments: () => {
                    throw new Error('форж недоступен');
                },
            }),
        );
        expect(() => recordReviewFindings({ milestone: 'M1' }, 42)).not.toThrow();
        expect(shArgv).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/не смог прочитать комментарии/i);
    });

    it('ревью прошло, а комментариев ноль → запись есть, но в логе предупреждение', () => {
        const shArgv = vi.fn(() => 'ok');
        const logs: string[] = [];
        const { recordReviewFindings } = createReviewModule(
            makeEnv({ shArgv, log: (m) => logs.push(m), prComments: () => [] }),
        );
        recordReviewFindings({ milestone: 'M1' }, 42);
        // Красным это не делаем — фаза уже смерджена; но тихим тоже: так же выглядит
        // ревью-сессия, которая до форжа не достучалась.
        expect(shArgv).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toMatch(/нет ни одного комментария/i);
    });

    it('комментарии есть, но ни один автор не доверенный → предупреждение в лог', () => {
        // Тот же молчаливый ноль с другого конца: у GitHub автор — `user.login`, у
        // SourceCraft — `author.slug`. Allowlist в терминах чужого форжа выкосит всю ленту,
        // и в журнал уйдут нули, неотличимые от честного «находок нет».
        const logs: string[] = [];
        const { recordReviewFindings } = createReviewModule(
            makeEnv({
                shArgv: () => 'ok',
                log: (m) => logs.push(m),
                prComments: () => [{ body: '🔴 [blocker] дыра', isSummary: false, author: 'dev' }],
            }),
        );
        recordReviewFindings({ milestone: 'M1' }, 42, ['Pelmenya']);
        expect(logs.join('\n')).toMatch(/ни один автор не входит в authorAllowlist/i);
    });

    it('автор ленты в allowlist — предупреждения нет', () => {
        const logs: string[] = [];
        const { recordReviewFindings } = createReviewModule(
            makeEnv({
                shArgv: () => 'ok',
                log: (m) => logs.push(m),
                prComments: () => COMMENTS,
            }),
        );
        recordReviewFindings({ milestone: 'M1' }, 42, ['alice']);
        expect(logs.join('\n')).not.toMatch(/authorAllowlist/i);
    });

    it('authorAllowlist фильтрует пустые/нестроковые значения (#237)', () => {
        const shArgv = vi.fn((_file: string, _args: string[]) => 'ok');
        const { recordReviewFindings } = createReviewModule(
            makeEnv({ shArgv, prComments: () => COMMENTS }),
        );
        recordReviewFindings({ milestone: 'M1' }, 7, ['alice', '', '  ', 123, null] as unknown[]);
        expect(shArgv.mock.calls[0][1]).toEqual([
            'scripts/review-findings-journal.mjs',
            '7',
            'M1',
            'alice',
        ]);
    });

    it('номер PR неизвестен (0 / не целое) → запись пропущена, журнал не зовётся', () => {
        const shArgv = vi.fn(() => 'ok');
        const logs: string[] = [];
        const { recordReviewFindings } = createReviewModule(
            makeEnv({ shArgv, log: (m) => logs.push(m) }),
        );
        recordReviewFindings({ milestone: 'M1' }, 0);
        recordReviewFindings({ milestone: 'M1' }, 1.5);
        expect(shArgv).not.toHaveBeenCalled();
        expect(logs.join('\n')).toMatch(/номер PR неизвестен/i);
    });

    it('сбой журнала не бросает — косметика наблюдаемости не роняет смердженную фазу', () => {
        const logs: string[] = [];
        const { recordReviewFindings } = createReviewModule(
            makeEnv({
                shArgv: () => {
                    throw new Error('journal write failed');
                },
                log: (m) => logs.push(m),
                prComments: () => COMMENTS,
            }),
        );
        expect(() => recordReviewFindings({ milestone: 'M1' }, 42)).not.toThrow();
        expect(logs.join('\n')).toMatch(/не смог записать находки/i);
    });
});

describe('pickReviewModel — отсутствующая escalated-модель не отменяет ревью (#132)', () => {
    const { pickReviewModel } = ralph;

    // undefined из эскалации runLoop трактует как «ревью за супервизором» и
    // пропускает ревью ЦЕЛИКОМ — fail-open ровно на самых опасных фазах.
    it('зона риска при незаданном review.escalated — ревью дефолтной моделью, не undefined', () => {
        const logs: string[] = [];
        const model = pickReviewModel('Фаза X', 'feature/x', {
            cfg: {
                review: {
                    default: 'claude-opus-4-8',
                    escalateOnPaths: ['.github/workflows/**'],
                },
            },
            logFn: (m: string) => logs.push(m),
            shFn: () => '.github/workflows/deploy.yml',
            runArgvFn: () => '',
            ghJsonFn: () => [],
        });
        expect(model).toBe('claude-opus-4-8');
        expect(model).toBeDefined();
        expect(logs.join('\n')).toMatch(/escalated/i);
    });

    it('escalateOn строкой вместо массива не роняет выбор модели', () => {
        expect(() =>
            pickReviewModel('Фаза X', 'feature/x', {
                cfg: {
                    review: {
                        default: 'claude-opus-4-8',
                        escalated: 'claude-fable-5',
                        escalateOn: 'complexity:expert',
                    },
                },
                logFn: () => {},
                shFn: () => '',
                runArgvFn: () => '',
                ghJsonFn: () => [],
            }),
        ).not.toThrow();
    });
});

// #366: сценарии pickReviewModel, которые фабричные тесты выше не видят, — устойчивость
// к сбою сбора диффа и anti-injection по имени ветки (инвариант C3/7). Перенесены из
// ralph.test.js вместе со своими фикстурами (CFG/deps), ходят через ре-экспорт ralph.js.
describe('pickReviewModel — сбой диффа и небезопасная ветка (#130)', () => {
    const { pickReviewModel } = ralph;

    const CFG = {
        review: {
            default: 'claude-opus-4-8',
            escalated: 'claude-fable-5',
            escalateOn: [],
            escalateOnPaths: ['.github/workflows/**', '.claude/ralph/**'],
        },
    };
    const deps = (over = {}) => ({
        cfg: CFG,
        logFn: () => {},
        ghJsonFn: () => [],
        shFn: () => '',
        // #252: fetch внутри phaseDiffFiles теперь мутация через argv.
        runArgvFn: () => '',
        ...over,
    });

    it('сбой git при получении диффа не роняет сдачу — ревью дефолтной моделью', () => {
        const logs: string[] = [];
        const model = pickReviewModel(
            'Фаза X',
            'feature/x',
            deps({
                logFn: (m: string) => logs.push(m),
                shFn: () => {
                    throw new Error('fatal: no upstream');
                },
            }),
        );
        expect(model).toBe('claude-opus-4-8');
        expect(logs.join('\n')).toMatch(/дифф/i);
    });

    it('имя ветки со спецсимволами шелла не уходит в git — эскалации нет, есть предупреждение', () => {
        // sh() исполняет СТРОКУ через шелл, поэтому ветка из конфига обязана быть
        // провалидирована до подстановки: `$(...)`/`;` внутри имени иначе исполнятся.
        const shCmds: string[] = [];
        const logs: string[] = [];
        const model = pickReviewModel(
            'Фаза X',
            'feature/x;$(id)',
            deps({
                logFn: (m: string) => logs.push(m),
                shFn: (cmd: string) => {
                    shCmds.push(cmd);
                    return '.github/workflows/deploy.yml';
                },
            }),
        );
        expect(shCmds).toEqual([]);
        expect(model).toBe('claude-opus-4-8');
        expect(logs.join('\n')).toMatch(/ветк/i);
    });
});

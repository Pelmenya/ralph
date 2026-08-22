// Юнит-тесты слоя конфига/профилей (config-profile.ts) — через боевую поверхность
// ralph.js, как их видят вызывающие: deepMerge (наследование common → профиль,
// с барьером против prototype pollution), findForbiddenKey (скан всей глубины),
// resolveProfile (сборка итогового конфига + fail-closed валидация) и
// parseProfileFlag (выбор профиля из argv). Отдельно закреплён боевой
// ralph.config.json: playground/prod обязаны собираться и различаться по риску.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов: блоки перенесены из
// ralph.test.js как есть и ходят через его ре-экспорт (#366).
import ralph from '../ralph.js';

const { deepMerge, resolveProfile, parseProfileFlag } = ralph;

describe('deepMerge — наследование общих полей профилем (#71)', () => {
    it('вложенные объекты сливаются вглубь: профиль правит одну метку, блок сохраняется', () => {
        const merged = deepMerge(
            { modelRouting: { default: 'opus', labels: { low: 'haiku', high: 'opus' } } },
            { modelRouting: { labels: { high: 'fable' } } },
        );
        expect(merged.modelRouting).toEqual({
            default: 'opus',
            labels: { low: 'haiku', high: 'fable' },
        });
    });

    it('массивы заменяются целиком, а не дописываются', () => {
        expect(deepMerge({ phases: ['A', 'B'] }, { phases: ['C'] }).phases).toEqual(['C']);
    });

    it('скаляр профиля перебивает объект общего блока (и наоборот) без слияния', () => {
        expect(deepMerge({ x: { a: 1 } }, { x: 0 }).x).toBe(0);
        expect(deepMerge({ x: 0 }, { x: { a: 1 } }).x).toEqual({ a: 1 });
    });

    it('не мутирует исходные объекты — общий блок переиспользуется между профилями', () => {
        const common = { a: { x: 1 } };
        deepMerge(common, { a: { x: 2 } });
        expect(common.a.x).toBe(1);
    });

    it('null в профиле затирает значение (осознанное «выключить», не пропуск)', () => {
        expect(
            deepMerge({ tunnelCheck: { enabled: true } }, { tunnelCheck: null }).tunnelCheck,
        ).toBe(null);
    });

    // Опасные ключи — стоп, а не тихая нейтрализация: легитимных полей с такими
    // именами нет, значит это опечатка или чужая рука в конфиге раннера.
    const boom = (m: string) => {
        throw new Error(m);
    };

    it('ключ __proto__ в профиле → стоп (иначе подменил бы прототип результата)', () => {
        // JSON.parse — как реальный конфиг: "__proto__" становится собственным ключом
        const evil = JSON.parse('{"__proto__": {"active": false}, "maxTurns": 5}');
        expect(() => deepMerge({ maxTurns: 200 }, evil, boom)).toThrow(/запрещённый ключ/);
    });

    it('опасный ключ на вложенном уровне тоже роняет мердж, с путём в сообщении', () => {
        const nested = JSON.parse('{"modelRouting": {"__proto__": {"evil": 1}}}');
        expect(() => deepMerge({ modelRouting: { labels: {} } }, nested, boom)).toThrow(
            /common\.modelRouting/,
        );
    });

    it('опасный ключ в общем блоке ловится так же, как в профиле', () => {
        const base = JSON.parse('{"constructor": {"x": 1}}');
        expect(() => deepMerge(base, {}, boom)).toThrow(/constructor/);
    });

    it('мягкий failFn (монитор) обрывает мердж, а не собирает полуфабрикат', () => {
        const evil = JSON.parse('{"a": {"__proto__": {"x": 1}}, "b": 2}');
        expect(deepMerge({ a: { y: 1 } }, evil, () => null)).toBe(null);
    });
});

describe('findForbiddenKey — скан всей глубины конфига (ревью PR #127)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };

    // Объект по ключу, которого нет в common, копируется присваиванием без рекурсии
    // мерджа — раньше его нутро не проверялось вовсе.
    it('опасный ключ в блоке, которого нет в common → стоп с полным путём', () => {
        const evil = JSON.parse('{"newBlock": {"deep": {"__proto__": {"x": 1}}}}');
        expect(() => deepMerge({ a: 1 }, evil, boom)).toThrow(/common\.newBlock\.deep/);
    });

    it('опасный ключ в глубине общего блока тоже ловится', () => {
        const base = JSON.parse('{"a": {"b": {"constructor": 1}}}');
        expect(() => deepMerge(base, {}, boom)).toThrow(/constructor/);
    });

    it('массивы не считаются объектами для скана — легитимный конфиг проходит', () => {
        expect(() => deepMerge({ phases: [{ milestone: 'M' }] }, {}, boom)).not.toThrow();
    });
});

// Ревью #365: base — это common, override — профиль, у них РАЗНЫЕ блоки конфига. Раньше
// resolveProfile сканировал оба под одним ярлыком (имя профиля), и запрещённый ключ из
// common всплывал как «в блоке "prod"» — сообщение врало про блок.
describe('deepMerge — ярлык блока в сообщении о запрещённом ключе (ревью #365)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };

    it('запрещённый ключ в common репортится в блоке "common", не в имени профиля', () => {
        const raw = JSON.parse('{"common": {"__proto__": {"x": 1}}, "profiles": {"prod": {}}}');
        expect(() => resolveProfile(raw, 'prod', boom)).toThrow(/в блоке "common"/);
    });

    it('запрещённый ключ в профиле репортится в блоке имени профиля, не в "common"', () => {
        const raw = JSON.parse('{"common": {}, "profiles": {"prod": {"__proto__": {"x": 1}}}}');
        expect(() => resolveProfile(raw, 'prod', boom)).toThrow(/в блоке "prod"/);
    });
});

// #48: плейсхолдеры промпта. Боевой конфиг задавал `{{MILESTONE}}`/`{{BRANCH}}` — ни одного
// совпадения с подстановкой петли, — и первая же итерация уходила с плейсхолдером внутри
// промпта. Сессия при этом НЕ падает: она делает не то, и понять это можно только по трём
// сожжённым итерациям. Проверяем через боевой resolveProfile — тем же путём, каким конфиг
// приходит к раннеру.
describe('resolveProfile: нераскрытый плейсхолдер промпта валит старт (#48)', () => {
    // Мягкий failFn: боевой уходит в process.exit(1), и тест ловил бы выход процесса
    // вместо сообщения — тот же приём, что у соседних негативных проверок файла.
    const boom = (m: string) => {
        throw new Error(m);
    };
    const base = (prompt: string) => ({
        common: { model: 'm', prompt, phases: [{ milestone: 'M1', branch: 'feature/m1' }] },
        profiles: { dev: {}, prod: {} },
        defaultProfile: 'dev',
    });

    it('промпт с {milestone} и {branch} собирается', () => {
        const cfg = resolveProfile(base('возьми «{milestone}» в ветке {branch}'), 'dev', boom);
        expect(cfg.profileName).toBe('dev');
    });

    it.each([
        ['{{MILESTONE}}', 'чужая форма скобок'],
        ['{mileston}', 'опечатка в имени'],
        ['{BRANCH}', 'верхний регистр'],
    ])('НЕГАТИВНЫЙ: %s отвергается на старте (%s)', (bad) => {
        // `boom` вместо боевого fail: тот уходит в process.exit(1), и тест ловил бы выход
        // процесса вместо сообщения — как у соседних негативных проверок этого файла.
        expect(() => resolveProfile(base(`возьми ${bad} и работай`), 'dev', boom)).toThrow(
            /плейсхолдер/i,
        );
    });
});

describe('resolveProfile — сборка итогового конфига из common + профиль (#71)', () => {
    const raw = () => ({
        defaultProfile: 'playground',
        common: {
            maxIterations: 10,
            blockedHealAttempts: 3,
            modelRouting: { labels: { high: 'opus' } },
            phases: [{ milestone: 'M', branch: 'b' }],
        },
        profiles: { playground: {}, prod: { blockedHealAttempts: 0 } },
    });
    // failFn инжектируется — отказы проверяем как исключение, без process.exit.
    const boom = (m: string) => {
        throw new Error(m);
    };

    it('без имени берётся defaultProfile, общие поля наследуются', () => {
        const cfg = resolveProfile(raw(), null, boom);
        expect(cfg.profileName).toBe('playground');
        expect(cfg.maxIterations).toBe(10);
        expect(cfg.phases).toEqual([{ milestone: 'M', branch: 'b' }]);
    });

    it('пустой профиль playground не меняет общие значения (регресса нет)', () => {
        const cfg = resolveProfile(raw(), 'playground', boom);
        expect(cfg.blockedHealAttempts).toBe(3);
    });

    it('профиль переопределяет только свою дельту, остальное — из common', () => {
        const cfg = resolveProfile(raw(), 'prod', boom);
        expect(cfg.blockedHealAttempts).toBe(0);
        expect(cfg.maxIterations).toBe(10);
        expect(cfg.modelRouting.labels.high).toBe('opus');
    });

    it('явное имя важнее defaultProfile', () => {
        expect(resolveProfile(raw(), 'prod', boom).profileName).toBe('prod');
    });

    it('резолв одного профиля не протекает в соседний (общий блок не мутируется)', () => {
        const cfgRaw = raw();
        resolveProfile(cfgRaw, 'prod', boom);
        expect(resolveProfile(cfgRaw, 'playground', boom).blockedHealAttempts).toBe(3);
    });

    // Fail-closed: раннер с bypassPermissions не имеет права угадывать режим.
    it('неизвестный профиль → стоп, в сообщении перечислены доступные', () => {
        expect(() => resolveProfile(raw(), 'staging', boom)).toThrow(/staging.*playground, prod/s);
    });

    it('нет defaultProfile и профиль не задан → стоп, а не молчаливый playground', () => {
        const cfg: Record<string, unknown> = raw();
        delete cfg.defaultProfile;
        expect(() => resolveProfile(cfg, null, boom)).toThrow(/defaultProfile/);
    });

    it('нет блока common → стоп', () => {
        expect(() => resolveProfile({ profiles: { p: {} } }, 'p', boom)).toThrow(/common/);
    });

    it('нет блока profiles → стоп', () => {
        expect(() => resolveProfile({ common: {} }, null, boom)).toThrow(/profiles/);
    });

    it('profiles пуст → стоп', () => {
        expect(() => resolveProfile({ common: {}, profiles: {} }, null, boom)).toThrow(/пуст/);
    });

    it('профиль не объект (массив/строка) → стоп', () => {
        expect(() => resolveProfile({ common: {}, profiles: { p: [] } }, 'p', boom)).toThrow(
            /не объект/,
        );
    });

    it('конфиг не объект (null/массив) → стоп', () => {
        expect(() => resolveProfile(null, null, boom)).toThrow(/объект/);
        expect(() => resolveProfile([], null, boom)).toThrow(/объект/);
    });

    it('имя профиля из прототипа (constructor/toString) не считается существующим', () => {
        expect(() => resolveProfile(raw(), 'constructor', boom)).toThrow(/Неизвестный профиль/);
    });

    // Контракт монитора: failFn может НЕ бросать, а вернуть sentinel (null) —
    // resolveProfile обязан вернуть его сразу, не продолжая работу с кривым raw.
    it('с невыбрасывающим failFn возвращает его результат, а не падает дальше по коду', () => {
        const softFail = () => null;
        expect(resolveProfile(null, null, softFail)).toBe(null);
        expect(resolveProfile({ common: {} }, null, softFail)).toBe(null);
        expect(resolveProfile(raw(), 'staging', softFail)).toBe(null);
    });

    // #249: haltBeforeDeploy валидируется на старте (fail-closed, инвариант №1) —
    // строгое `!== false` в цикле молча приняло бы строку/число/null за halt.
    it('#249 haltBeforeDeploy в prod: boolean проходит (true/false), undefined = дефолт', () => {
        const withHalt = (v: unknown) => ({
            defaultProfile: 'prod',
            common: { phases: [{ milestone: 'M', branch: 'b' }] },
            profiles: { prod: v === undefined ? {} : { haltBeforeDeploy: v } },
        });
        expect(resolveProfile(withHalt(undefined), 'prod', boom).haltBeforeDeploy).toBeUndefined();
        expect(resolveProfile(withHalt(true), 'prod', boom).haltBeforeDeploy).toBe(true);
        expect(resolveProfile(withHalt(false), 'prod', boom).haltBeforeDeploy).toBe(false);
    });

    it('#249 haltBeforeDeploy не-boolean → стоп (строка "false"/число/null не считаются)', () => {
        const withHalt = (v: unknown) => ({
            defaultProfile: 'prod',
            common: { phases: [{ milestone: 'M', branch: 'b' }] },
            profiles: { prod: { haltBeforeDeploy: v } },
        });
        expect(() => resolveProfile(withHalt('false'), 'prod', boom)).toThrow(/ожидался boolean/);
        expect(() => resolveProfile(withHalt(0), 'prod', boom)).toThrow(/ожидался boolean/);
        expect(() => resolveProfile(withHalt(null), 'prod', boom)).toThrow(/ожидался boolean/);
    });

    it('#249 haltBeforeDeploy вне профиля prod → стоп (флаг там молча ничего не значит)', () => {
        const cfg = {
            defaultProfile: 'playground',
            common: { phases: [{ milestone: 'M', branch: 'b' }] },
            profiles: { playground: { haltBeforeDeploy: false }, prod: {} },
        };
        expect(() => resolveProfile(cfg, 'playground', boom)).toThrow(/только в профиле "prod"/);
    });

    it('#249 haltBeforeDeploy в common ловится на не-prod профиле (протекает из общего блока)', () => {
        const cfg = {
            defaultProfile: 'playground',
            common: { phases: [{ milestone: 'M', branch: 'b' }], haltBeforeDeploy: true },
            profiles: { playground: {}, prod: {} },
        };
        expect(() => resolveProfile(cfg, 'playground', boom)).toThrow(/только в профиле "prod"/);
        // Тот же флаг в common на prod — валиден.
        expect(resolveProfile(cfg, 'prod', boom).haltBeforeDeploy).toBe(true);
    });
});

// #16: накопительная веха карточек лестницы. Ключи валидируются на старте (инвариант №1):
// молча проглоченный мусор здесь означает не «адреса нет», а «адрес пропал незаметно».
describe('review.backlogMilestone / backlogMilestoneCap — схема ключей адреса', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };
    const withReview = (review: unknown) => ({
        defaultProfile: 'prod',
        common: { phases: [{ milestone: 'M', branch: 'b' }] },
        profiles: { prod: { review } },
    });

    it('строка, список строк и отсутствие ключа — валидны', () => {
        expect(() => resolveProfile(withReview({}), 'prod', boom)).not.toThrow();
        expect(() =>
            resolveProfile(withReview({ backlogMilestone: 'Бэклог 1' }), 'prod', boom),
        ).not.toThrow();
        expect(() =>
            resolveProfile(
                withReview({ backlogMilestone: ['Бэклог 1', 'Бэклог 2'], backlogMilestoneCap: 3 }),
                'prod',
                boom,
            ),
        ).not.toThrow();
    });

    it('не строка и не список строк → стоп, а не молчаливое «адреса нет»', () => {
        expect(() => resolveProfile(withReview({ backlogMilestone: 42 }), 'prod', boom)).toThrow(
            /backlogMilestone/,
        );
        expect(() =>
            resolveProfile(withReview({ backlogMilestone: ['Бэклог 1', 7] }), 'prod', boom),
        ).toThrow(/backlogMilestone/);
        expect(() => resolveProfile(withReview({ backlogMilestone: [] }), 'prod', boom)).toThrow(
            /backlogMilestone/,
        );
        expect(() => resolveProfile(withReview({ backlogMilestone: '  ' }), 'prod', boom)).toThrow(
            /backlogMilestone/,
        );
    });

    it('потолок — положительное целое; строка "5" и ноль валят старт', () => {
        // Ноль здесь не «выключить адресацию», а веха, в которую ничего не влезает: такой
        // конфиг тихо отправлял бы все карточки в общий бэклог.
        expect(() =>
            resolveProfile(
                withReview({ backlogMilestone: 'Бэклог 1', backlogMilestoneCap: '5' }),
                'prod',
                boom,
            ),
        ).toThrow(/backlogMilestoneCap/);
        expect(() =>
            resolveProfile(
                withReview({ backlogMilestone: 'Бэклог 1', backlogMilestoneCap: 0 }),
                'prod',
                boom,
            ),
        ).toThrow(/backlogMilestoneCap/);
        expect(() =>
            resolveProfile(
                withReview({ backlogMilestone: 'Бэклог 1', backlogMilestoneCap: 2.5 }),
                'prod',
                boom,
            ),
        ).toThrow(/backlogMilestoneCap/);
    });
});

// #376 (фаза 6): modelRouting провайдер-осведомлён — значение может быть строкой
// (обратная совместимость, claude-модель) либо объектом { provider, model } (явный выбор
// провайдера кодер-рантайма). Валидируется на старте resolveProfile — та же fail-closed
// схема, что у haltBeforeDeploy.
describe('#376 modelRouting провайдер-осведомлён — fail-closed валидация', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };
    const withRouting = (routing: unknown) => ({
        defaultProfile: 'playground',
        common: { phases: [{ milestone: 'M', branch: 'b' }], modelRouting: routing },
        profiles: { playground: {} },
    });

    it('текущий роутинг (голые строки label→модель) проходит без правок', () => {
        const cfg = resolveProfile(
            withRouting({
                default: 'claude-sonnet-5',
                labels: { 'complexity:high': 'claude-opus-4-8' },
            }),
            'playground',
            boom,
        );
        expect(cfg.modelRouting).toEqual({
            default: 'claude-sonnet-5',
            labels: { 'complexity:high': 'claude-opus-4-8' },
        });
    });

    it('объектная запись { provider, model } с известным провайдером проходит', () => {
        const cfg = resolveProfile(
            withRouting({
                labels: { 'complexity:low': { provider: 'kimi', model: 'kimi-k2-0711-preview' } },
            }),
            'playground',
            boom,
        );
        expect(cfg.modelRouting.labels['complexity:low']).toEqual({
            provider: 'kimi',
            model: 'kimi-k2-0711-preview',
        });
    });

    it('объектная запись без provider (только model) проходит — провайдер решает pickRuntime', () => {
        const cfg = resolveProfile(
            withRouting({ default: { model: 'claude-fable-5' } }),
            'playground',
            boom,
        );
        expect(cfg.modelRouting.default).toEqual({ model: 'claude-fable-5' });
    });

    it('modelRouting не объект → стоп', () => {
        expect(() => resolveProfile(withRouting('opus'), 'playground', boom)).toThrow(
            /modelRouting должен быть объектом/,
        );
    });

    it('modelRouting.labels не объект → стоп', () => {
        expect(() => resolveProfile(withRouting({ labels: ['opus'] }), 'playground', boom)).toThrow(
            /modelRouting\.labels должен быть объектом/,
        );
    });

    it('пустая строка в label/default → стоп', () => {
        expect(() =>
            resolveProfile(withRouting({ labels: { high: '   ' } }), 'playground', boom),
        ).toThrow(/modelRouting\.labels\["high"\] — пустая строка/);
        expect(() => resolveProfile(withRouting({ default: '' }), 'playground', boom)).toThrow(
            /modelRouting\.default — пустая строка/,
        );
    });

    it('запись не строка и не объект (число/массив) → стоп', () => {
        expect(() =>
            resolveProfile(withRouting({ labels: { high: 42 } }), 'playground', boom),
        ).toThrow(/должен быть строкой.*либо объектом/);
        expect(() =>
            resolveProfile(withRouting({ default: ['opus'] }), 'playground', boom),
        ).toThrow(/должен быть строкой.*либо объектом/);
    });

    it('неизвестный provider (опечатка "kimy") → стоп, перечислены допустимые', () => {
        expect(() =>
            resolveProfile(
                withRouting({ labels: { high: { provider: 'kimy', model: 'x' } } }),
                'playground',
                boom,
            ),
        ).toThrow(/неизвестный провайдер.*claude, kimi, openai/);
    });

    it('объект без model (только provider) → стоп', () => {
        expect(() =>
            resolveProfile(
                withRouting({ labels: { high: { provider: 'kimi' } } }),
                'playground',
                boom,
            ),
        ).toThrow(/\.model обязателен/);
    });

    it('apiLimitFallback (доп.скоуп) валидируется той же схемой', () => {
        expect(
            resolveProfile(
                withRouting({ apiLimitFallback: { provider: 'openai', model: 'gpt-5-codex' } }),
                'playground',
                boom,
            ).modelRouting.apiLimitFallback,
        ).toEqual({ provider: 'openai', model: 'gpt-5-codex' });
        expect(() =>
            resolveProfile(
                withRouting({ apiLimitFallback: { provider: 'bogus', model: 'x' } }),
                'playground',
                boom,
            ),
        ).toThrow(/неизвестный провайдер/);
    });

    it('healEscalation (доп.скоуп): afterAttempts обязан быть положительным числом', () => {
        expect(() =>
            resolveProfile(
                withRouting({ healEscalation: { afterAttempts: 0, route: 'opus' } }),
                'playground',
                boom,
            ),
        ).toThrow(/afterAttempts должен быть положительным числом/);
        expect(() =>
            resolveProfile(
                withRouting({ healEscalation: { afterAttempts: '2', route: 'opus' } }),
                'playground',
                boom,
            ),
        ).toThrow(/afterAttempts должен быть положительным числом/);
    });

    it('healEscalation.route валидируется той же схемой; валидный проходит целиком', () => {
        const cfg = resolveProfile(
            withRouting({
                healEscalation: {
                    afterAttempts: 2,
                    route: { provider: 'openai', model: 'gpt-5-codex' },
                },
            }),
            'playground',
            boom,
        );
        expect(cfg.modelRouting.healEscalation).toEqual({
            afterAttempts: 2,
            route: { provider: 'openai', model: 'gpt-5-codex' },
        });
        expect(() =>
            resolveProfile(
                withRouting({
                    healEscalation: { afterAttempts: 2, route: { provider: 'kimy', model: 'x' } },
                }),
                'playground',
                boom,
            ),
        ).toThrow(/неизвестный провайдер/);
    });

    it('healEscalation не объект → стоп', () => {
        expect(() =>
            resolveProfile(withRouting({ healEscalation: 'да' }), 'playground', boom),
        ).toThrow(/healEscalation должен быть объектом/);
    });

    // Ревью-thread: частично заданный healEscalation в рантайме — тихий no-op (эскалация
    // никогда не сработает). Требуем ОБА поля, раз секция задана (инвариант №1).
    it('healEscalation задан без afterAttempts → стоп (частичная секция = тихий no-op)', () => {
        expect(() =>
            resolveProfile(
                withRouting({ healEscalation: { route: 'claude-opus-4-8' } }),
                'playground',
                boom,
            ),
        ).toThrow(/afterAttempts отсутствует/);
    });

    it('healEscalation задан без route → стоп (эскалации не на что переключаться)', () => {
        expect(() =>
            resolveProfile(
                withRouting({ healEscalation: { afterAttempts: 2 } }),
                'playground',
                boom,
            ),
        ).toThrow(/route отсутствует/);
    });

    // Ревью-thread: apiLimitFallback, резолвящийся в тот же провайдер, что статический
    // coderRuntime (claude по дефолту) — гарантированный no-op (runClaude пропускает
    // same-provider фолбэк). Молчаливый no-op-конфиг хуже честного отказа.
    it('apiLimitFallback с тем же провайдером, что статический coderRuntime → стоп (no-op)', () => {
        // Голая строка → провайдер = статический (claude) = провайдер прогона → no-op.
        expect(() =>
            resolveProfile(
                withRouting({ apiLimitFallback: 'claude-opus-4-8' }),
                'playground',
                boom,
            ),
        ).toThrow(/ТОТ ЖЕ.*провайдер/s);
        // Явный provider, совпавший со статическим — тот же no-op.
        expect(() =>
            resolveProfile(
                withRouting({ apiLimitFallback: { provider: 'claude', model: 'claude-opus-4-8' } }),
                'playground',
                boom,
            ),
        ).toThrow(/ТОТ ЖЕ.*провайдер/s);
    });

    // Ревью-blocker: статический не-claude рантайм + безпровайдерная запись роутинга =
    // claude-имя молча уехало бы на чужой endpoint. Требуем provider явно в каждой записи.
    describe('статический coderRuntime ≠ claude требует явного provider в записях', () => {
        const withAdapters = (routing: unknown, coderRuntime: string) => ({
            defaultProfile: 'playground',
            common: {
                phases: [{ milestone: 'M', branch: 'b' }],
                adapters: { coderRuntime },
                modelRouting: routing,
            },
            profiles: { playground: {} },
        });

        it('голая строка-модель в labels → стоп', () => {
            expect(() =>
                resolveProfile(
                    withAdapters({ labels: { 'complexity:low': 'claude-haiku-4-5' } }, 'kimi'),
                    'playground',
                    boom,
                ),
            ).toThrow(/голая строка-модель.*≠ 'claude'/s);
        });

        it('объект без provider → стоп', () => {
            expect(() =>
                resolveProfile(
                    withAdapters({ default: { model: 'kimi-k2-0711-preview' } }, 'kimi'),
                    'playground',
                    boom,
                ),
            ).toThrow(/provider обязателен.*≠ 'claude'/s);
        });

        it('все записи с явным provider → проходит', () => {
            const cfg = resolveProfile(
                withAdapters(
                    {
                        labels: {
                            'complexity:low': { provider: 'kimi', model: 'kimi-k2-0711-preview' },
                        },
                    },
                    'kimi',
                ),
                'playground',
                boom,
            );
            expect(cfg.modelRouting.labels['complexity:low']).toEqual({
                provider: 'kimi',
                model: 'kimi-k2-0711-preview',
            });
        });
    });

    it('modelRouting не задан вовсе → resolveProfile не спотыкается', () => {
        const cfg = resolveProfile(
            {
                defaultProfile: 'playground',
                common: { phases: [{ milestone: 'M', branch: 'b' }] },
                profiles: { playground: {} },
            },
            'playground',
            boom,
        );
        expect(cfg.modelRouting).toBeUndefined();
    });
});

describe('parseProfileFlag — выбор профиля из argv (#72)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };

    it('--profile <name> отдаёт имя', () => {
        expect(parseProfileFlag(['--profile', 'prod'], boom)).toBe('prod');
    });

    it('--profile=<name> отдаёт имя', () => {
        expect(parseProfileFlag(['--profile=prod'], boom)).toBe('prod');
    });

    it('без флага → null: решать будет defaultProfile конфига', () => {
        expect(parseProfileFlag(['--once', '--dry-run'], boom)).toBe(null);
    });

    it('имя не путается с соседними флагами', () => {
        expect(parseProfileFlag(['--dry-run', '--profile', 'prod', '--once'], boom)).toBe('prod');
    });

    // Оборванная команда не должна тихо уводить в playground.
    it('--profile без имени → стоп', () => {
        expect(() => parseProfileFlag(['--profile'], boom)).toThrow(/требует имя/);
    });

    it('--profile перед другим флагом → стоп, а не имя "--once"', () => {
        expect(() => parseProfileFlag(['--profile', '--once'], boom)).toThrow(/требует имя/);
    });

    it('--profile= с пустым значением → стоп', () => {
        expect(() => parseProfileFlag(['--profile='], boom)).toThrow(/без имени/);
    });

    it('--profile=--once → стоп, а не имя профиля "--once" (форма = как пробельная)', () => {
        expect(() => parseProfileFlag(['--profile=--once'], boom)).toThrow(/без имени/);
    });

    // Дубль с разными именами: «кто победит» нельзя решать порядком веток парсера —
    // это тихий уход не в тот профиль. Только стоп.
    it('дубль флага в разных формах → стоп', () => {
        expect(() => parseProfileFlag(['--profile', 'prod', '--profile=playground'], boom)).toThrow(
            /указан 2 раза/,
        );
    });

    it('дубль флага в одной форме → стоп, даже с одинаковым именем', () => {
        expect(() => parseProfileFlag(['--profile', 'prod', '--profile', 'prod'], boom)).toThrow(
            /указан 2 раза/,
        );
    });

    it('связка с резолвом: флаг важнее defaultProfile', () => {
        const raw = {
            defaultProfile: 'playground',
            common: { maxTurns: 200 },
            profiles: { playground: {}, prod: { maxTurns: 50 } },
        };
        const name = parseProfileFlag(['--profile', 'prod'], boom);
        const cfg = resolveProfile(raw, name, boom);
        expect(cfg.profileName).toBe('prod');
        expect(cfg.maxTurns).toBe(50);
    });

    it('связка с резолвом: неизвестное имя из флага → стоп', () => {
        const raw = { defaultProfile: 'playground', common: {}, profiles: { playground: {} } };
        const name = parseProfileFlag(['--profile', 'staging'], boom);
        expect(() => resolveProfile(raw, name, boom)).toThrow(/Неизвестный профиль/);
    });
});

// #73: что конфиг ПРОЕКТА валиден и его профили — дельта, а не вторая копия common,
// сторожит тест на стороне потребителя (контракт потребителя, #103): состав профилей и
// их значения — решение проекта, ядру они не принадлежат. Здесь — тот же набор проверок
// по ФИКСТУРНОМУ конфигу: он в дереве ядра есть всегда, включая чистый клон канона.
describe('конфиг проекта — профиль по умолчанию резолвится (#73)', () => {
    // Путь от каталога ядра, а не от CWD: ядро живёт и подмодулем в каноне, и каталогом
    // `.claude/ralph` у потребителя — CWD в этих раскладках разный.
    const raw = JSON.parse(
        fs.readFileSync(
            path.resolve(
                import.meta.dirname,
                '../tests/__fixtures__/foreign-project/ralph.config.json',
            ),
            'utf-8',
        ),
    );
    const boom = (m: string) => {
        throw new Error(m);
    };

    // Имя дефолтного профиля — решение проекта, а не контракт ядра (грабля 6 журнала
    // переносимости): раньше здесь стоял литерал 'playground', и перенос падал на
    // «Неизвестный профиль» просто из-за другого имени.
    const DEFAULT_PROFILE = raw.defaultProfile;

    it('дефолтный профиль объявлен и существует в profiles', () => {
        expect(typeof DEFAULT_PROFILE).toBe('string');
        expect(Object.keys(raw.profiles)).toContain(DEFAULT_PROFILE);
    });

    it('без флага резолвится профиль по умолчанию', () => {
        expect(resolveProfile(raw, null, boom).profileName).toBe(DEFAULT_PROFILE);
    });

    it('профиль-дельта не дублирует common: значения наследуются', () => {
        const cfg = resolveProfile(raw, DEFAULT_PROFILE, boom);
        expect(cfg.maxIterations).toBe(raw.common.maxIterations);
        expect(cfg.modelRouting).toEqual(raw.common.modelRouting);
    });

    it('haltBeforeDeploy не протекает через common: без дельты — дефолт кода', () => {
        expect(resolveProfile(raw, DEFAULT_PROFILE, boom).haltBeforeDeploy).toBeUndefined();
    });
});

// #221: конфиг, где review.fallback слабее review.default, отвергается на старте
// (assertKnownReviewModels вызывается внутри resolveProfile) — это и есть требуемый
// issue негативный тест «fail-closed, а не тихая деградация в момент overload».
describe('resolveProfile — review.fallback не может быть слабее review.default (#221)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };
    const rawWithReview = (review: unknown) => ({
        defaultProfile: 'playground',
        common: {
            phases: [{ milestone: 'M', branch: 'b' }],
            review,
        },
        profiles: { playground: {} },
    });

    it('review.fallback слабее review.default → стоп с внятным сообщением', () => {
        expect(() =>
            resolveProfile(
                rawWithReview({
                    default: 'claude-opus-4-8',
                    fallback: 'claude-haiku-4-5-20251001',
                }),
                null,
                boom,
            ),
        ).toThrow(/review\.fallback.*claude-haiku-4-5-20251001.*слабее.*review\.default/s);
    });

    it('review.fallback той же силы, что review.default — конфиг принимается', () => {
        const cfg = resolveProfile(
            rawWithReview({ default: 'claude-opus-4-8', fallback: 'claude-opus-4-8' }),
            null,
            boom,
        );
        expect(cfg.review.fallback).toBe('claude-opus-4-8');
    });

    it('review.fallback сильнее review.default — конфиг принимается', () => {
        const cfg = resolveProfile(
            rawWithReview({ default: 'claude-opus-4-8', fallback: 'claude-fable-5' }),
            null,
            boom,
        );
        expect(cfg.review.fallback).toBe('claude-fable-5');
    });

    it('незнакомая модель в review.fallback → стоп (тот же барьер #223, что для default/escalated)', () => {
        expect(() =>
            resolveProfile(
                rawWithReview({ default: 'claude-opus-4-8', fallback: 'claude-mystery' }),
                null,
                boom,
            ),
        ).toThrow(/review\.fallback.*claude-mystery.*REVIEW_MODEL_STRENGTH/s);
    });

    it('review.fallback не задан — конфиг проходит валидацию как раньше', () => {
        expect(() =>
            resolveProfile(rawWithReview({ default: 'claude-opus-4-8' }), null, boom),
        ).not.toThrow();
    });
});

describe('resolveProfile — раскладка корней (канон, задача 21)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };
    const withRoots = (roots: unknown) => ({
        defaultProfile: 'prod',
        common: { phases: [{ milestone: 'M', branch: 'b' }] },
        profiles: { prod: roots === undefined ? {} : { roots } },
    });
    const LEGAL = {
        consumerRoot: '/path/to/app',
        executionRoot: '/path/to/app-ralph',
        productRoot: '/path/to/app/.ralph/core',
        runtimeDir: '/path/to/app/.ralph/runtime/prod',
    };

    it('секции нет — старая раскладка, старт не ломается', () => {
        // Отсутствие секции означает «всё в каталоге ядра», и это сказано вслух до тех пор,
        // пока состояние оттуда не уехало. Требовать её сегодня значило бы остановить обе
        // работающие петли ради ещё не сделанного переезда.
        expect(resolveProfile(withRoots(undefined), 'prod', boom).profileName).toBe('prod');
    });

    it('полная законная раскладка проходит, а резолв доезжает до конфига', () => {
        // Резолв стоит обращений к диску и разворачивает симлинки. Выбросить его результат
        // значило бы считать то же самое заново в каждом месте, где корень понадобится, —
        // с шансом получить другой ответ, если дерево между вызовами изменилось.
        const cfg = resolveProfile(withRoots(LEGAL), 'prod', boom);
        expect(cfg.roots).toEqual(LEGAL);
        expect(cfg.rootsResolved).toEqual(LEGAL);
    });

    it('секции нет — rootsResolved равен null, а не пустому объекту', () => {
        // «Раскладки нет» и «раскладка пустая» — разные вещи для того, кто её читает.
        expect(resolveProfile(withRoots(undefined), 'prod', boom).rootsResolved).toBe(null);
    });

    it('корень пропущен — отказ называет ИМЕННО его, а не «конфиг неверен»', () => {
        const { runtimeDir: _drop, ...partial } = LEGAL;
        expect(() => resolveProfile(withRoots(partial), 'prod', boom)).toThrow(/runtimeDir/);
    });

    it('состояние внутри продукта — отказ на старте, а не грязный подмодуль через день', () => {
        expect(() =>
            resolveProfile(
                withRoots({ ...LEGAL, runtimeDir: '/path/to/app/.ralph/core/runtime' }),
                'prod',
                boom,
            ),
        ).toThrow(/пересекаются/);
    });

    it('"roots" не объект — отказ, а не молчаливое игнорирование', () => {
        expect(() => resolveProfile(withRoots('/path/to/app'), 'prod', boom)).toThrow(/roots/);
    });
});

describe('resolveProfile — скрипты потребителя (канон, задача 23)', () => {
    const boom = (m: string) => {
        throw new Error(m);
    };
    const withScripts = (consumerScripts: unknown) => ({
        defaultProfile: 'prod',
        common: { phases: [{ milestone: 'M', branch: 'b' }] },
        profiles: {
            prod: consumerScripts === undefined ? {} : { consumerScripts },
        },
    });
    const LEGAL = {
        projectSync: 'scripts/project-sync.mjs',
        reviewFindingsJournal: 'scripts/review-findings-journal.mjs',
    };

    it('секции нет — старт не ломается: обе обёртки просто выключены', () => {
        // Скрипты принадлежат потребителю, и у площадки, где доска — проекция статуса,
        // синка нет вовсе. Требовать секцию значило бы навязать чужой файл каждому.
        expect(resolveProfile(withScripts(undefined), 'prod', boom).profileName).toBe('prod');
    });

    it('законная секция доезжает до конфига целиком', () => {
        expect(resolveProfile(withScripts(LEGAL), 'prod', boom).consumerScripts).toEqual(LEGAL);
    });

    it('задан только один скрипт — законно: второй выключен осознанно', () => {
        const cfg = resolveProfile(withScripts({ projectSync: LEGAL.projectSync }), 'prod', boom);
        expect(cfg.consumerScripts).toEqual({ projectSync: LEGAL.projectSync });
    });

    it('секция не объект — отказ, а не молчаливое игнорирование', () => {
        expect(() => resolveProfile(withScripts('scripts/'), 'prod', boom)).toThrow(
            /consumerScripts/,
        );
        expect(() => resolveProfile(withScripts([LEGAL.projectSync]), 'prod', boom)).toThrow(
            /consumerScripts/,
        );
    });

    it('пустая секция — отказ: выглядит заполненной, работает как отсутствующая', () => {
        expect(() => resolveProfile(withScripts({}), 'prod', boom)).toThrow(/ни одного скрипта/);
    });

    it('незнакомый ключ — отказ, и он называет известные', () => {
        // Опечатка в имени ключа — ровно тот отказ, который задача и чинила: ядро молча
        // не звало бы скрипт, а лог сказал бы «выключен», хотя человек его задал.
        expect(() =>
            resolveProfile(withScripts({ ...LEGAL, projectSyncs: 'scripts/x.mjs' }), 'prod', boom),
        ).toThrow(/projectSyncs/);
        expect(() =>
            resolveProfile(withScripts({ ...LEGAL, projectSyncs: 'scripts/x.mjs' }), 'prod', boom),
        ).toThrow(/projectSync, reviewFindingsJournal/);
    });

    it('значение не строка или пустое — отказ с именем ключа', () => {
        for (const bad of [42, null, '', '   ', ['a']]) {
            expect(() => resolveProfile(withScripts({ projectSync: bad }), 'prod', boom)).toThrow(
                /projectSync/,
            );
        }
    });

    it('путь, начинающийся с дефиса, — отказ: node прочтёт его как свой флаг', () => {
        // `node --eval …` вместо `node <путь>`: аргумент уходит в argv первым, и всё, что
        // начинается с дефиса, node разбирает как опцию — то есть исполняет не тот код.
        expect(() =>
            resolveProfile(withScripts({ projectSync: '--eval=console.log(1)' }), 'prod', boom),
        ).toThrow(/дефис/);
    });
});

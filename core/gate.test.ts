// Юнит-тесты модуля гейта (#362). Основная часть проверяет САМУ фабрику createGateRunner —
// что она собирает рабочие функции из синтетического env, независимо от ralph.js: контракт
// extraction'а — модуль самодостаточен и переносим (цель фазы 3), а не «работает только
// пока его зовёт ralph.js». Проход «через ре-экспорт ralph.js» с боевым контекстом раннера —
// в orchestrator.test.ts / blocked-scenarios.test.ts / hold-scenarios.test.ts и в блоке в
// #55: блок про метку blocked, живший в конце этого файла, уехал в набор адаптера вместе
// с самими функциями — здесь остался чистый гейт.
import { describe, it, expect, vi } from 'vitest';
// #55: тесты примитивов форжа теперь в `adapters/github-forge-commands.test.ts` и ходят
// через фабрику адаптера, а не через ре-экспорт ralph.js — потому здесь нет ни импорта
// entry, ни @ts-expect-error к нему.
import type { GateEnv } from './gate.ts';
import { createGateRunner } from './gate.ts';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

// Синтетический gate-конфиг для тестов состава (#204): не боевой список проекта, а
// репрезентативная форма — база с дедупным `test`, prod-добавки, prodDropChecks.
const SYNTH_GATE = {
    gate: {
        checks: [
            ['build', 'npm run build'],
            ['lint', 'npm run lint'],
            ['test', 'npm run test'],
        ],
        prodChecks: [
            ['security', 'npm run security:audit'],
            ['coverage', 'npm run test:coverage'],
            ['e2e', 'CI=1 npm run test:e2e'],
        ],
        prodDropChecks: ['test'],
    },
};

// Синтетический env: заглушки-коллабораторы, которые молча падают, если функция под
// тестом зовёт побочку без явного override, — забытый override становится громкой
// ошибкой теста, а не тихим проходом через боевой sh/gh.
function makeEnv(over: Partial<GateEnv> = {}): GateEnv {
    return {
        sh: () => {
            throw new Error('sh не подменён в тесте');
        },
        shArgv: () => {
            throw new Error('shArgv не подменён в тесте');
        },
        shq: (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`,
        log: () => {},
        fail: (msg: string) => {
            throw new Error(msg);
        },
        getConfig: () => SYNTH_GATE,
        ghJson: () => {
            throw new Error('ghJson не подменён в тесте');
        },
        // #49: голову PR читает ШОВ форжа, а не гейт. Дефолт падает, как и остальные
        // побочки: тест, забывший подменить шов, обязан краснеть, а не идти в боевой `gh`.
        prHeadSha: () => {
            throw new Error('prHeadSha не подменён в тесте');
        },
        // #55: примитивы форжа приходят инъекцией. Дефолт падает по той же причине, что
        // и prHeadSha: тест, забывший подменить их, обязан краснеть, а не идти в боевой `gh`.
        mergePr: () => {
            throw new Error('mergePr не подменён в тесте');
        },
        phaseMerged: () => {
            throw new Error('phaseMerged не подменён в тесте');
        },
        safeBranch: () => true,
        findOpenPr: () => null,
        ensureClean: () => true,
        parkOnOriginMain: () => {},
        updateRunnerTreeToOriginMain: () => {},
        updateConsumerTreeAfterMerge: () => {},
        syncDepsIfLockChanged: () => {},
        buildSanitizedGateEnv: () => ({ PATH: '/x' }),
        formatExcerpt: (s: string) => s,
        sleep: () => {},
        dry: false,
        SHA40_RE: /^[0-9a-f]{40}$/,
        PR_NUMBER_RE: /^\d+$/,
        runnerTreeFixHint: 'git fetch origin main && git checkout --detach origin/main',
        ...over,
    };
}

describe('gateChecksFor — состав шагов по профилю (#80), состав из конфига (#204)', () => {
    it('дефолт (playground): только базовый набор из конфига, включая test', () => {
        const { gateChecksFor } = createGateRunner(makeEnv());
        const names = gateChecksFor().map(([n]) => n);
        expect(names).toContain('test');
        expect(names).not.toContain('e2e');
        expect(names).not.toContain('coverage');
    });

    it('prod: базовый `test` снят по prodDropChecks, добавлены толстые чеки', () => {
        const { gateChecksFor } = createGateRunner(makeEnv());
        const names = gateChecksFor('prod').map(([n]) => n);
        expect(names).not.toContain('test');
        expect(names).toEqual(expect.arrayContaining(['security', 'coverage', 'e2e']));
        // build остаётся из базы
        expect(names).toContain('build');
    });

    it('возвращает КОПИЮ: мутация результата не течёт в следующий вызов', () => {
        const { gateChecksFor } = createGateRunner(makeEnv());
        const baseLen = gateChecksFor().length;
        const list = gateChecksFor();
        list.push(['x', 'echo x']);
        expect(gateChecksFor().length).toBe(baseLen);
    });

    it('#204: неизвестный/пустой профиль → только база (безопасный дефолт)', () => {
        const { gateChecksFor } = createGateRunner(makeEnv());
        const base = gateChecksFor().map(([n]) => n);
        expect(gateChecksFor('marsian').map(([n]) => n)).toEqual(base);
        expect(gateChecksFor(undefined).map(([n]) => n)).toEqual(base);
    });

    it('#204: gate.prodDropChecks пуст → prod ничего не снимает из базы', () => {
        const cfg = {
            gate: { ...SYNTH_GATE.gate, prodDropChecks: [] },
        };
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(gateChecksFor('prod').map(([n]) => n)).toContain('test');
    });
});

describe('resolveGateChecks — fail-closed на битой схеме gate (#204)', () => {
    it('нет блока gate → fail с внятным сообщением', () => {
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => ({}) }));
        expect(() => gateChecksFor()).toThrow(/нет блока "gate"/);
    });

    it('gate.checks пуст → fail (пустой гейт смерджил бы фазу без проверок)', () => {
        const cfg = { gate: { checks: [] } };
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(() => gateChecksFor()).toThrow(/gate\.checks пуст/);
    });

    it('gate.checks — не массив → fail', () => {
        const cfg = { gate: { checks: 'npm run build' } };
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(() => gateChecksFor()).toThrow(/gate\.checks пуст или не массив/);
    });

    it('битая пара [имя, команда] в checks → fail', () => {
        const cfg = { gate: { checks: [['build']] } };
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(() => gateChecksFor()).toThrow(/некорректный шаг/);
    });

    it('пустая команда в паре → fail', () => {
        const cfg = { gate: { checks: [['build', '']] } };
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(() => gateChecksFor()).toThrow(/некорректный шаг/);
    });

    it('битая пара в prodChecks → fail только на prod-составе', () => {
        const cfg = {
            gate: { checks: [['build', 'npm run build']], prodChecks: [['e2e', 42]] },
        };
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(() => gateChecksFor('prod')).toThrow(/gate\.prodChecks содержит некорректный шаг/);
    });

    it('prodDropChecks с нестроковым элементом → fail', () => {
        const cfg = {
            gate: { checks: [['build', 'npm run build']], prodDropChecks: [1] },
        };
        const { gateChecksFor } = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(() => gateChecksFor()).toThrow(/gate\.prodDropChecks должен быть массивом/);
    });
});

describe('checksGreen — прогон шагов на голове PR (#77)', () => {
    function greenEnvCalls() {
        const runArgv = vi.fn(() => '');
        const park = vi.fn();
        const syncDeps = vi.fn();
        // rev-parse → пусто (локальной ветки нет); прочие sh — команды чеков, зелёные.
        const sh = vi.fn(() => '');
        return { runArgv, park, syncDeps, sh };
    }

    it('все чеки зелёные → true; запоминает verifiedHead; парковку не зовёт', () => {
        const { runArgv, park, syncDeps, sh } = greenEnvCalls();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const ok = g.checksGreen('feature/x', 7, {
            shFn: sh,
            runArgvFn: runArgv,
            prHeadShaFn: () => SHA,
            syncDepsFn: syncDeps,
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(true);
        expect(g.getVerifiedHead()).toBe(SHA);
        expect(g.getLastRedCheck()).toBeNull();
        expect(park).not.toHaveBeenCalled();
        // syncDeps и чек получили санированный env
        expect(syncDeps).toHaveBeenCalledWith({ env: { PATH: '/x' } });
        expect(sh).toHaveBeenCalledWith('npm run lint', { env: { PATH: '/x' } });
    });

    it('красный чек → false; lastRedCheck заполнен, парковка вызвана', () => {
        const park = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const sh = vi.fn((cmd: string) => {
            if (cmd.includes('rev-parse')) return '';
            const e = new Error('boom') as Error & { stderr?: string };
            e.stderr = 'tests failed here';
            throw e;
        });
        const ok = g.checksGreen('feature/x', 7, {
            shFn: sh,
            runArgvFn: () => '',
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [['test', 'npm run test']],
        });
        expect(ok).toBe(false);
        expect(g.getLastRedCheck()).toMatchObject({ name: 'test', cmd: 'npm run test' });
        expect(g.getLastRedCheck()?.excerpt).toContain('tests failed here');
        expect(g.getVerifiedHead()).toBeNull();
        expect(park).toHaveBeenCalledTimes(1);
    });

    it('имя ветки не прошло safeBranch → false, парковка, git не трогаем', () => {
        const park = vi.fn();
        const runArgv = vi.fn(() => '');
        const g = createGateRunner(makeEnv({ safeBranch: () => false, parkOnOriginMain: park }));
        const ok = g.checksGreen('bad branch', 7, { runArgvFn: runArgv });
        expect(ok).toBe(false);
        expect(park).toHaveBeenCalledTimes(1);
        expect(runArgv).not.toHaveBeenCalled();
    });

    it('санация env упала → fail-closed: false, чеки не запущены, парковка', () => {
        const park = vi.fn();
        const sh = vi.fn(() => '');
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const ok = g.checksGreen('feature/x', 7, {
            shFn: sh,
            runArgvFn: () => '',
            prHeadShaFn: () => SHA,
            buildGateEnvFn: () => {
                throw new Error('битый allowlist');
            },
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(false);
        expect(park).toHaveBeenCalledTimes(1);
        // до чеков не дошли: sh звался только на rev-parse, не на команду чека
        expect(sh).not.toHaveBeenCalledWith('npm run lint', expect.anything());
    });

    // #466: останавливает ветвление, а не любое расхождение. `merge-base --is-ancestor`
    // обязан сказать «не предок» — иначе это отставший ref, и он подтягивается сам.
    it('H3: локальная ветка разошлась с головой PR → false, чеки не гонятся', () => {
        const park = vi.fn();
        const syncDeps = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const sh = vi.fn((cmd: string) => (cmd.includes('rev-parse') ? OTHER_SHA : ''));
        const ok = g.checksGreen('feature/x', 7, {
            shFn: sh,
            runArgvFn: (file: string, args: string[]) => {
                if (args[0] === 'merge-base') throw new Error('not an ancestor');
                return '';
            },
            prHeadShaFn: () => SHA,
            syncDepsFn: syncDeps,
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(false);
        expect(syncDeps).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalledTimes(1);
    });

    it('#466 ref отстал (предок головы PR) → ff-подтяжка, чеки идут дальше', () => {
        const park = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const argv: Array<[string, string[]]> = [];
        const ok = g.checksGreen('feature/x', 7, {
            shFn: (cmd: string) => (cmd.includes('rev-parse') ? OTHER_SHA : ''),
            runArgvFn: (file: string, args: string[]) => {
                argv.push([file, args]);
                return '';
            },
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(true);
        expect(argv).toContainEqual(['git', ['update-ref', 'refs/heads/feature/x', SHA]]);
        expect(park).not.toHaveBeenCalled();
    });

    it('шов отдал не-sha → fail-closed', () => {
        const park = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const ok = g.checksGreen('feature/x', 7, {
            shFn: () => '',
            runArgvFn: () => '',
            prHeadShaFn: () => 'not-a-sha',
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(false);
        expect(park).toHaveBeenCalledTimes(1);
    });

    // #49: голову PR гейт спрашивает у ШВА форжа, а не исполняет команду сам. На площадке
    // без `gh` прежний inline-вызов давал три ретрая и `not-merged` — фаза не мерджилась
    // никогда. Тест держит именно маршрут: env.ghJson (боевой `gh`) в этом пути не зовётся.
    it('#49: голова PR читается через шов, gh из гейта не зовётся', () => {
        const ghJson = vi.fn(() => {
            throw new Error('гейт не имеет права ходить в форж сам');
        });
        const g = createGateRunner(
            makeEnv({ ghJson: ghJson as unknown as GateEnv['ghJson'], prHeadSha: () => SHA }),
        );
        const ok = g.checksGreen('feature/x', 7, {
            shFn: () => '',
            runArgvFn: () => '',
            syncDepsFn: () => {},
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(true);
        expect(g.getVerifiedHead()).toBe(SHA);
        expect(ghJson).not.toHaveBeenCalled();
    });

    // Fail-closed: «не смогли прочитать голову» ≠ «голова та же». Мердж отменяется, дерево
    // паркуется — ровно как при упавшем fetch.
    it('#49: шов чтения головы бросил → false, чеки не гонятся, парковка', () => {
        const park = vi.fn();
        const syncDeps = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const ok = g.checksGreen('feature/x', 7, {
            shFn: () => '',
            runArgvFn: () => '',
            syncDepsFn: syncDeps,
            prHeadShaFn: () => {
                throw new Error('форж недоступен');
            },
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(false);
        expect(syncDeps).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalledTimes(1);
    });
});

describe('tryMergePhase — гейт мерджа: hold/blocked/red/merged', () => {
    const phase = { branch: 'feature/x', milestone: 'M' };

    it('dry → not-merged, ничего не мерджим', () => {
        const g = createGateRunner(makeEnv({ dry: true }));
        const runArgv = vi.fn(() => '');
        expect(tryMergeWith(g, phase, { runArgvFn: runArgv })).toBe('not-merged');
        expect(runArgv).not.toHaveBeenCalled();
    });

    it('грязное дерево (ensureClean=false) → not-merged', () => {
        const g = createGateRunner(makeEnv());
        expect(tryMergeWith(g, phase, { ensureCleanFn: () => false })).toBe('not-merged');
    });

    it('открытого PR нет → not-merged', () => {
        const g = createGateRunner(makeEnv());
        expect(tryMergeWith(g, phase, { findOpenPrFn: () => null })).toBe('not-merged');
    });

    it('hold сильнее blocked — проверяется первым', () => {
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [{ name: 'blocked' }, { name: 'hold' }] }),
        });
        expect(res).toBe('hold');
        expect(g.getLastGatePr()).toBe(9);
    });

    it('label blocked → blocked', () => {
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [{ name: 'blocked' }] }),
        });
        expect(res).toBe('blocked');
    });

    it('красный чек → red-checks', () => {
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => false,
            getLastRedCheckFn: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'x' }),
        });
        expect(res).toBe('red-checks');
    });

    it('гейт упал ДО чеков (redCheck пуст) → not-merged', () => {
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => false,
            getLastRedCheckFn: () => null,
        });
        expect(res).toBe('not-merged');
    });

    it('зелёный гейт → merged; примитив мерджа зовётся с головой чеков, дерево обновлено', () => {
        const mergePrFn = vi.fn();
        const updateTree = vi.fn();
        const g = createGateRunner(makeEnv({ updateRunnerTreeToOriginMain: updateTree }));
        const res = tryMergeWith(g, phase, {
            mergePrFn,
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
        });
        expect(res).toBe('merged');
        // #55: гейт отвечает за то, ЧТО зовёт примитив мерджа и с какими аргументами
        // (номер PR + голова, прогнанная чеками). КАК из этого собирается `gh pr merge
        // --match-head-commit` — предмет тестов адаптера, а не гейта.
        // Третьим аргументом гейт прокидывает свой DI-хук исполнения — примитив обязан
        // ходить через ту же обёртку, что и остальной argv (#193).
        expect(mergePrFn.mock.calls[0].slice(0, 2)).toEqual([9, SHA]);
        // ...и сам DI-хук исполнения: без этой проверки можно было убрать прокидывание
        // `{ runArgvFn }` из gate.ts, и тест остался бы зелёным (#55-ревью).
        expect(mergePrFn.mock.calls[0][2]).toEqual(
            expect.objectContaining({ runArgvFn: expect.any(Function) }),
        );
        expect(updateTree).toHaveBeenCalledTimes(1);
    });

    // Канон, задача 28: дерево ПОТРЕБИТЕЛЯ подтягивается тем же мерджем. Без этой пробы
    // строку вызова можно было бы убрать из gate.ts, и сьют остался бы зелёным: контракт
    // самой функции проверяется у модуля, а её МЕСТО в хореографии — только здесь.
    it('задача 28: merged тянет и дерево потребителя; на несданной фазе — не тянет', () => {
        const updateConsumer = vi.fn();
        const g = createGateRunner(makeEnv({ updateConsumerTreeAfterMerge: updateConsumer }));
        expect(
            tryMergeWith(g, phase, {
                findOpenPrFn: () => ({ number: 9, labels: [] }),
                checksGreenFn: () => true,
                getVerifiedHeadFn: () => SHA,
            }),
        ).toBe('merged');
        expect(updateConsumer).toHaveBeenCalledTimes(1);

        // Красный гейт: фаза не сдана, тянуть в дерево человека нечего — и не тянем.
        // Обновление, идущее «на всякий случай», приводило бы туда чужую работу тогда,
        // когда своя ещё не влита.
        const idle = vi.fn();
        const g2 = createGateRunner(makeEnv({ updateConsumerTreeAfterMerge: idle }));
        expect(
            tryMergeWith(g2, phase, {
                findOpenPrFn: () => ({ number: 9, labels: [] }),
                checksGreenFn: () => false,
                getLastRedCheckFn: () => ({ name: 'test', cmd: 'npm run test', excerpt: 'x' }),
            }),
        ).toBe('red-checks');
        expect(idle).not.toHaveBeenCalled();
    });

    // #49: шов чтения головы приходит из runLoop (adapters.taskSource.pullRequestHeadSha) и
    // обязан доехать до checksGreen. Без этого прокидывания подмена шва в конфиге меняла бы
    // мердж, но не прогон чеков — «тихий дефолт» ровно того класса, что и барьер #415.
    it('#49: prHeadShaFn прокидывается в checksGreen', () => {
        const g = createGateRunner(makeEnv());
        const seam = () => SHA;
        const checksGreenFn = vi.fn(() => true);
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: checksGreenFn as unknown as typeof g.checksGreen,
            getVerifiedHeadFn: () => SHA,
            prHeadShaFn: seam,
        });
        expect(res).toBe('merged');
        expect(checksGreenFn).toHaveBeenCalledWith(
            'feature/x',
            9,
            expect.objectContaining({ prHeadShaFn: seam }),
        );
    });

    // #53: у площадки мердж АСИНХРОННЫЙ — `POST /pulls/{n}/merge` отдаёт `operation_id` и
    // `scheduled`, а не свершившийся факт. Петля же сразу фетчила origin/main и считала фазу
    // сданной: при непрерывном режиме (haltBeforeDeploy: false) следующая фаза могла
    // стартовать от ДО-мерджевого main, и вся её работа легла бы мимо только что влитого кода.
    it('#53: мердж принят, но подтверждения нет → merge-unconfirmed, дерево не трогаем', () => {
        const updateTree = vi.fn();
        const park = vi.fn();
        const g = createGateRunner(makeEnv({ updateRunnerTreeToOriginMain: updateTree }));
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            // Форж принял мердж (mergePr не бросил), но фазу смердженной не показывает.
            phaseMergedFn: () => false,
            mergeConfirmAttempts: 3,
            parkFn: park,
        });
        expect(res).toBe('merge-unconfirmed');
        // Главное: origin/main НЕ фетчится и дерево не переезжает — иначе следующая фаза
        // строилась бы поверх непонятно чего.
        expect(updateTree).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalled();
    });

    it('#53: подтверждение пришло со второй попытки → merged', () => {
        const updateTree = vi.fn();
        const g = createGateRunner(makeEnv({ updateRunnerTreeToOriginMain: updateTree }));
        let calls = 0;
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            // Первый ответ — «ещё не видно» (операция в очереди), второй — подтверждение.
            phaseMergedFn: () => ++calls > 1,
            mergeConfirmAttempts: 3,
        });
        expect(res).toBe('merged');
        expect(updateTree).toHaveBeenCalledTimes(1);
    });

    // #53-ревью: сбой ЧТЕНИЯ подтверждения — не ответ «не смерджено». Без try/catch внутри
    // цикла исключение форжа улетало бы наружу: вызов tryMergePhase в runLoop не обёрнут, и
    // петля упала бы целиком — без пуша и без парковки дерева. Мутация «убрать catch»
    // раньше переживала весь сьют.
    it('#53: форж бросает на каждой сверке → merge-unconfirmed, петля не падает', () => {
        const park = vi.fn();
        const updateTree = vi.fn();
        const g = createGateRunner(makeEnv({ updateRunnerTreeToOriginMain: updateTree }));
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            phaseMergedFn: () => {
                throw new Error('форж недоступен');
            },
            mergeConfirmAttempts: 2,
            parkFn: park,
        });
        expect(res).toBe('merge-unconfirmed');
        expect(updateTree).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalled();
    });

    // #53-ревью: сверка ВНУТРИ ретрая обязана быть такой же терпеливой, как после успешного
    // мерджа. Иначе оборванный ответ на принятый POST + асинхронная очередь форжа = повтор
    // принятой операции, то есть задвоение мерджа.
    it('#53: оборванный ответ + подтверждение со второй попытки → мердж НЕ повторяется', () => {
        const g = createGateRunner(makeEnv());
        const mergePrFn = vi.fn(() => {
            throw new Error('сеть оборвала ответ');
        });
        let asked = 0;
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            mergePrFn,
            // Первый ответ — «ещё не вижу» (операция в очереди), второй — подтверждение.
            phaseMergedFn: () => ++asked > 1,
            mergeConfirmAttempts: 3,
        });
        expect(res).toBe('merged');
        expect(mergePrFn).toHaveBeenCalledTimes(1);
    });

    it('merge прошёл, обновление дерева упало → merged-local-stale', () => {
        // Задача 28 (ревью, 1-й проход): дерево ПОТРЕБИТЕЛЯ подтягивается и на этом пути.
        // Фаза влита, а сбой локального git раннера к дереву человека отношения не имеет —
        // иначе транзиентный чих возвращал бы ровно ту дыру, ради которой задача заводилась.
        const updateConsumer = vi.fn();
        const g = createGateRunner(
            makeEnv({
                updateConsumerTreeAfterMerge: updateConsumer,
                updateRunnerTreeToOriginMain: () => {
                    throw new Error('detach упал');
                },
            }),
        );
        const res = tryMergeWith(g, phase, {
            runArgvFn: () => '',
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
        });
        expect(res).toBe('merged-local-stale');
        expect(updateConsumer).toHaveBeenCalledTimes(1);
    });

    it('#387: после подтверждённого мерджа зовёт удаление локального ref ветки фазы', () => {
        const deleteRef = vi.fn();
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            runArgvFn: () => '',
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            deleteLocalBranchRefFn: deleteRef,
        });
        expect(res).toBe('merged');
        expect(deleteRef).toHaveBeenCalledWith(phase.branch, expect.anything());
    });

    it('#387: mergePr бросил, но PR уже влит (phaseMerged=true) — предупреждение без "занятый деревом человека", ref всё равно удаляется', () => {
        const deleteRef = vi.fn();
        const logs: string[] = [];
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            // #55: бросает примитив форжа — его реализация уехала в адаптер, и «мердж
            // упал» моделируется отказом примитива, а не отказом argv-обёртки гейта.
            mergePrFn: () => {
                throw new Error('gh упал');
            },
            logFn: (m: string) => logs.push(m),
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            phaseMergedFn: () => true,
            deleteLocalBranchRefFn: deleteRef,
        });
        expect(res).toBe('merged');
        expect(deleteRef).toHaveBeenCalledWith(phase.branch, expect.anything());
        const warning = logs.find((l) => l.includes('уже влит'));
        expect(warning).toBeDefined();
        expect(warning).not.toContain('занятый деревом человека');
        expect(warning).toContain('созданный самим раннером для сверки H3');
    });

    it('#387: неудача удаления ref — fail-open, результат мерджа не меняется', () => {
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            runArgvFn: () => '',
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            deleteLocalBranchRefFn: () => {
                throw new Error('не должно всплыть');
            },
        });
        expect(res).toBe('merged');
    });
});

describe('deleteLocalBranchRef — чистка локального ref после мерджа (#387)', () => {
    it('ref существует локально → удаляет через argv git branch -D, лог с #387', () => {
        const runArgv = vi.fn(() => '');
        const sh = vi.fn(() => '');
        const logs: string[] = [];
        const g = createGateRunner(makeEnv());
        g.deleteLocalBranchRef('feature/x', {
            shFn: sh,
            runArgvFn: runArgv,
            logFn: (m: string) => logs.push(m),
        });
        expect(runArgv).toHaveBeenCalledWith('git', ['branch', '-D', 'feature/x']);
        expect(logs.some((l) => l.includes('feature/x') && l.includes('#387'))).toBe(true);
    });

    it('ref локально отсутствует → не зовёт git branch -D вообще', () => {
        const runArgv = vi.fn(() => '');
        const sh = vi.fn(() => {
            throw new Error('not a valid ref');
        });
        const g = createGateRunner(makeEnv());
        g.deleteLocalBranchRef('feature/x', { shFn: sh, runArgvFn: runArgv });
        expect(runArgv).not.toHaveBeenCalled();
    });

    it('git branch -D упал → fail-open, лог предупреждения, исключение не всплывает', () => {
        const sh = vi.fn(() => '');
        const runArgv = vi.fn(() => {
            throw new Error('branch is checked out');
        });
        const logs: string[] = [];
        const g = createGateRunner(makeEnv());
        expect(() =>
            g.deleteLocalBranchRef('feature/x', {
                shFn: sh,
                runArgvFn: runArgv,
                logFn: (m: string) => logs.push(m),
            }),
        ).not.toThrow();
        expect(logs.some((l) => l.includes('Не удалось удалить') && l.includes('feature/x'))).toBe(
            true,
        );
    });

    it('имя ветки не прошло safeBranch → git не трогаем вообще (anti-injection, инв. C3/7)', () => {
        const sh = vi.fn(() => '');
        const runArgv = vi.fn(() => '');
        const g = createGateRunner(makeEnv({ safeBranch: () => false }));
        g.deleteLocalBranchRef('bad branch', { shFn: sh, runArgvFn: runArgv });
        expect(sh).not.toHaveBeenCalled();
        expect(runArgv).not.toHaveBeenCalled();
    });
});

// tryMergePhase со стабами побочек: sleep/park/phaseMerged по умолчанию безвредны,
// поверх них тест кладёт свои override'ы.
function tryMergeWith(
    g: ReturnType<typeof createGateRunner>,
    phase: { branch: string; milestone?: string },
    over: Record<string, unknown>,
) {
    return g.tryMergePhase(phase, {
        shFn: () => '',
        runArgvFn: () => '',
        ensureCleanFn: () => true,
        sleepFn: () => {},
        parkFn: () => {},
        // #53: дефолт «форж подтверждает мердж» — после принятого мерджа гейт спрашивает
        // ЭТУ же функцию («фаза смерджена?»), и для сценариев про успешный мердж честный
        // ответ именно такой. Сценарии, где мердж НЕ прошёл, задают false явно — там это
        // и есть предмет проверки.
        phaseMergedFn: () => true,
        // #55: примитив мерджа — инъекция (его реализация уехала в адаптер). Дефолт
        // безвреден: сценарии, которым важен ФАКТ вызова, кладут свой шпион через over.
        mergePrFn: () => {},
        ...over,
    });
}

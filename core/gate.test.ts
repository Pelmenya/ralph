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
import { classifyCheckFailure, createGateRunner, resolveGatePolicy } from './gate.ts';

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

    // #60: fail-fast порядок «дешёвый → дорогой» — ответственность автора конфига (см.
    // докблок над gateChecksFor в gate.ts), а не решение ядра о том, ЧТО именно дёшево.
    // Ядро обязано только сохранять порядок объявления, не пересортировывать его. Синтетика
    // здесь названа иначе, чем в любом реальном проекте, — так тест доказывает инвариант
    // «порядок» отдельно от инварианта «состав», который проверяют соседние тесты.
    it('порядок — как в конфиге: селектор не пересортировывает шаги', () => {
        const { gateChecksFor } = createGateRunner(makeEnv());
        // База — ровно в порядке объявления SYNTH_GATE.gate.checks.
        expect(gateChecksFor().map(([n]) => n)).toEqual(['build', 'lint', 'test']);
        // prod — снятая база (в своём порядке) + prodChecks (в своём порядке), не слияние
        // по алфавиту и не по длине команды.
        expect(gateChecksFor('prod').map(([n]) => n)).toEqual([
            'build',
            'lint',
            'security',
            'coverage',
            'e2e',
        ]);
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

    // #85: строка расхождения — диагноз стопа. Раньше гейт печатал её и возвращал безымянный
    // отказ, а пуш человеку нёс «причина не установлена».
    it('#85 расхождение записано: sha обеих сторон и та же строка, что в логе', () => {
        const logs: string[] = [];
        const g = createGateRunner(makeEnv({ log: (m) => logs.push(m) }));
        const ok = g.checksGreen('feature/x', 7, {
            shFn: (cmd: string) => (cmd.includes('rev-parse') ? OTHER_SHA : ''),
            runArgvFn: (_file: string, args: string[]) => {
                if (args[0] === 'merge-base') throw new Error('not an ancestor');
                return '';
            },
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [['lint', 'npm run lint']],
        });
        expect(ok).toBe(false);
        const div = g.getLastHeadDivergence();
        expect(div).toMatchObject({ local: OTHER_SHA, remote: SHA });
        expect(div?.line).toContain('разошёлся с головой PR #7');
        expect(logs).toContain(`⛔ ${div?.line}`);
        expect(g.getLastRedCheck()).toBeNull();
    });

    it('#85 следующий раунд без расхождения сбрасывает запись', () => {
        const g = createGateRunner(makeEnv());
        const diverged = {
            shFn: (cmd: string) => (cmd.includes('rev-parse') ? OTHER_SHA : ''),
            runArgvFn: (_file: string, args: string[]) => {
                if (args[0] === 'merge-base') throw new Error('not an ancestor');
                return '';
            },
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [['lint', 'npm run lint']] as [string, string][],
        };
        g.checksGreen('feature/x', 7, diverged);
        expect(g.getLastHeadDivergence()).not.toBeNull();
        g.checksGreen('feature/x', 7, {
            ...diverged,
            shFn: (cmd: string) => (cmd.includes('rev-parse') ? SHA : ''),
        });
        expect(g.getLastHeadDivergence()).toBeNull();
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

    // #134: раньше «дерево детач» подразумевалось, и update-ref по выбранной ветке был
    // безопасен. С проводкой на ветку (#134) дерево на ней стоит, а update-ref двигает ref
    // молча: в дереве сразу появляется фантомное удаление файлов головы PR (проверено
    // опытом), чеки идут по неполному дереву, а commitLeftovers следующей итерации это
    // удаление коммитит. Отсюда порядок: детач ПЕРЕД переводом ref.
    it('#134 отказ перевода ref → парковка и отказ мерджа, а не исключение наружу', () => {
        const park = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const syncDeps = vi.fn();
        const ok = g.checksGreen('feature/x', 7, {
            shFn: (cmd: string) => (cmd.includes('rev-parse') ? OTHER_SHA : ''),
            runArgvFn: (_file: string, args: string[]) => {
                if (args[0] === 'update-ref') throw new Error('ref lock');
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

    it('#134 ff-подтяжка снимает дерево с ветки ДО перевода ref', () => {
        const g = createGateRunner(makeEnv({ parkOnOriginMain: vi.fn() }));
        const argv: Array<[string, string[]]> = [];
        g.checksGreen('feature/x', 7, {
            shFn: (cmd: string) => (cmd.includes('rev-parse') ? OTHER_SHA : ''),
            runArgvFn: (file: string, args: string[]) => {
                argv.push([file, args]);
                return '';
            },
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [['lint', 'npm run lint']],
        });
        const detach = argv.findIndex(([, a]) => a[0] === 'checkout' && a.includes('--detach'));
        const update = argv.findIndex(([, a]) => a[0] === 'update-ref');
        expect(detach).toBeGreaterThan(-1);
        expect(update).toBeGreaterThan(detach);
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

    // #127: сбой чтения — не «PR нет». Отдельный исход с причиной в lastForgeStop, мердж
    // и чеки не зовутся; иначе стоп звучал бы «PR не найден» про PR, который, может, есть.
    it('PR не прочитался (шов бросил) → pr-unreadable с причиной, чеки не идут', () => {
        const g = createGateRunner(makeEnv());
        const logs: string[] = [];
        const checksGreenFn = vi.fn(() => true);
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => {
                throw new Error('HTTP 502\nдетали');
            },
            checksGreenFn,
            logFn: (m: string) => logs.push(m),
        });
        expect(res).toBe('pr-unreadable');
        expect(checksGreenFn).not.toHaveBeenCalled();
        expect(g.getLastForgeStop()).toContain('HTTP 502');
        expect(g.getLastForgeStop()).not.toContain('детали');
        expect(g.getLastGatePr()).toBeNull();
        expect(logs.join('\n')).toMatch(/не прочитался у форжа: HTTP 502 — мердж отменён/);
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

// #47: повтор мерджа зависит от класса отказа. Часы — фейковые: sleepFn двигает nowFn,
// так что предел в десять минут проходится без единой реальной паузы.
describe('tryMergePhase — повтор мерджа по классу отказа (#47)', () => {
    const phase = { branch: 'feature/x', milestone: 'M' };

    function run(
        failures: string[],
        {
            mergeRetryMaxMs,
            alwaysFail = false,
        }: { mergeRetryMaxMs?: number; alwaysFail?: boolean } = {},
    ) {
        let clock = 0;
        let merged = false;
        const pauses: number[] = [];
        const logs: string[] = [];
        const park = vi.fn();
        const mergePrFn = vi.fn((_n: number, head?: string | null) => {
            const i = mergePrFn.mock.calls.length - 1;
            if (alwaysFail || i < failures.length) {
                throw new Error(
                    `Command failed: gh pr merge 9 --match-head-commit ${String(head)}\n` +
                        (failures[i] ?? failures[failures.length - 1]),
                );
            }
            merged = true;
        });
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            mergePrFn,
            phaseMergedFn: () => merged,
            mergeConfirmAttempts: 1,
            nowFn: () => clock,
            sleepFn: (ms: number) => {
                pauses.push(ms);
                clock += ms;
            },
            logFn: (m: string) => logs.push(m),
            parkFn: park,
            ...(mergeRetryMaxMs === undefined ? {} : { mergeRetryMaxMs }),
        });
        return { res, mergePrFn, pauses, logs, park, g };
    }

    it('транзиент 503 → повторы с растущей паузой, успех на 4-й попытке = мердж', () => {
        const { res, mergePrFn, pauses } = run([
            'GraphQL: Something went wrong (HTTP 503)',
            'HTTP 502: Bad Gateway',
            'read ECONNRESET',
        ]);
        expect(res).toBe('merged');
        expect(mergePrFn).toHaveBeenCalledTimes(4);
        expect(pauses).toHaveLength(3);
        expect(pauses[1]).toBeGreaterThan(pauses[0]);
        expect(pauses[2]).toBeGreaterThan(pauses[1]);
        // Барьер не ослаблен: каждая попытка несёт проверенную голову.
        for (const call of mergePrFn.mock.calls) expect(call[1]).toBe(SHA);
    });

    it.each([
        'Pull request #9 is not mergeable: the merge commit cannot be cleanly created.',
        '{"mergeable": false}',
        'merge conflict between base and head',
        'Head branch was modified. Review and try the merge again. (HTTP 409)',
    ])('отказ по существу (%s) → стоп сразу, повторов ноль', (stderr) => {
        const { res, mergePrFn, pauses, logs, park } = run([stderr]);
        expect(res).toBe('not-merged');
        expect(mergePrFn).toHaveBeenCalledTimes(1);
        expect(pauses).toEqual([]);
        expect(park).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toContain('по существу');
    });

    it('предел по времени исчерпан → fail-closed стоп, ни одной паузы за предел', () => {
        const limit = 10 * 60 * 1000;
        const { res, mergePrFn, pauses, logs, park } = run(['HTTP 503'], {
            alwaysFail: true,
            mergeRetryMaxMs: limit,
        });
        expect(res).toBe('not-merged');
        expect(park).toHaveBeenCalledTimes(1);
        // Десять минут дают заметно больше прежних двух попыток…
        expect(mergePrFn.mock.calls.length).toBeGreaterThan(4);
        // …и ни миллисекунды сверх предела.
        expect(pauses.reduce((a, b) => a + b, 0)).toBe(limit);
        const stop = logs.find((l) => l.startsWith('⛔')) ?? '';
        expect(stop).toContain('дольше предела 10 мин');
        expect(stop).toContain('оставлен человеку');
    });

    // #123: класс отказа и строка форжа уходят геттером — иначе пуш человеку на
    // `not-merged` шёл катч-оллом «причина не установлена», а причина жила только в логе.
    it('#123: исчерпанный предел → геттер отдаёт класс transient, строку форжа и число попыток', () => {
        const { res, mergePrFn, g } = run(['GraphQL: Something went wrong (HTTP 503)'], {
            alwaysFail: true,
            mergeRetryMaxMs: 10 * 60 * 1000,
        });
        expect(res).toBe('not-merged');
        expect(g.getLastMergeFailure()).toEqual({
            pr: 9,
            kind: 'transient',
            line: 'GraphQL: Something went wrong (HTTP 503)',
            attempts: mergePrFn.mock.calls.length,
            retryMaxMs: 10 * 60 * 1000,
        });
    });

    it('#123: отказ по существу → геттер отдаёт refusal и первую строку ответа, а не команду', () => {
        const { g } = run(['Pull request #9 is not mergeable: conflict.\nвторая строка']);
        const mf = g.getLastMergeFailure();
        expect(mf?.kind).toBe('refusal');
        expect(mf?.line).toBe('Pull request #9 is not mergeable: conflict.');
        expect(mf?.attempts).toBe(1);
    });

    it('#123: следующий проход гейта сбрасывает причину прошлого отказа', () => {
        const { g } = run(['Pull request #9 is not mergeable: conflict.']);
        expect(g.getLastMergeFailure()).not.toBeNull();
        expect(tryMergeWith(g, phase, { dry: true })).toBe('not-merged');
        expect(g.getLastMergeFailure()).toBeNull();
    });

    it('#123: успешный мердж причины отказа не оставляет', () => {
        const { res, g } = run(['HTTP 503']);
        expect(res).toBe('merged');
        expect(g.getLastMergeFailure()).toBeNull();
    });

    it('предел берётся из конфига (mergeRetryMaxMs)', () => {
        let clock = 0;
        const pauses: number[] = [];
        const g = createGateRunner(
            makeEnv({ getConfig: () => ({ ...SYNTH_GATE, mergeRetryMaxMs: 45_000 }) }),
        );
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            mergePrFn: () => {
                throw new Error('HTTP 503');
            },
            phaseMergedFn: () => false,
            mergeConfirmAttempts: 1,
            nowFn: () => clock,
            sleepFn: (ms: number) => {
                pauses.push(ms);
                clock += ms;
            },
        });
        expect(res).toBe('not-merged');
        expect(pauses).toEqual([30_000, 15_000]);
    });

    it('нераспознанный отказ → один повтор, как до #47', () => {
        const { res, mergePrFn, pauses } = run(['something odd happened'], { alwaysFail: true });
        expect(res).toBe('not-merged');
        expect(mergePrFn).toHaveBeenCalledTimes(2);
        expect(pauses).toEqual([30_000]);
    });

    // Смешанная последовательность: единственный повтор нераспознанного считается по ЕГО
    // повторам, а не по номеру попытки — transient → unknown обязан получить свой повтор.
    it('transient → unknown → unknown: нераспознанный повторён ровно один раз', () => {
        const { res, mergePrFn, pauses, logs } = run(
            ['HTTP 503', 'something odd happened', 'something odd happened'],
            { alwaysFail: true },
        );
        expect(res).toBe('not-merged');
        expect(mergePrFn).toHaveBeenCalledTimes(3);
        expect(pauses).toEqual([30_000, 30_000]);
        expect(logs.find((l) => l.startsWith('⛔'))).toContain('не распознан и после повтора');
    });

    it('unknown → transient → unknown: транзиент между ними повтор нераспознанного не возвращает', () => {
        const { res, mergePrFn } = run(['odd', 'HTTP 503', 'odd'], { alwaysFail: true });
        expect(res).toBe('not-merged');
        expect(mergePrFn).toHaveBeenCalledTimes(3);
    });

    it('429 лимита API → повтор, а не стоп по существу', () => {
        const { res, mergePrFn } = run([
            'GraphQL: API rate limit exceeded for installation (HTTP 429)',
            'HTTP 408: Request Timeout',
        ]);
        expect(res).toBe('merged');
        expect(mergePrFn).toHaveBeenCalledTimes(3);
    });

    it('строка повтора называет ответ форжа, а не команду', () => {
        const { logs } = run(['GraphQL: Something went wrong (HTTP 503)']);
        const warn = logs.find((l) => l.startsWith('⚠ Мердж')) ?? '';
        expect(warn).toContain('(GraphQL: Something went wrong (HTTP 503))');
        expect(warn).not.toContain('Command failed');
    });

    // merge-unconfirmed остаётся отдельным исходом: успех после транзиентов не отменяет
    // обязательного подтверждения.
    it('успех после транзиента без подтверждения → merge-unconfirmed', () => {
        let calls = 0;
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            mergePrFn: () => {
                if (++calls === 1) throw new Error('HTTP 503');
            },
            phaseMergedFn: () => false,
            mergeConfirmAttempts: 1,
        });
        expect(res).toBe('merge-unconfirmed');
        expect(calls).toBe(2);
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

// ── #269: чек PR на стороне площадки, перед мерджем ─────────────────────────────
//
// Предмет — ПОРЯДОК и ИСХОДЫ шага, а не разбор ответа: сам вердикт приходит уже свёрнутым
// швом, ожидание — чистая функция `core/forge-checks.ts` со своим набором.
describe('tryMergePhase — чек PR у площадки (#269)', () => {
    const phase = { branch: 'feature/m1', milestone: 'M1' };
    const GREEN = { state: 'success' as const, runs: [] };
    const RED_RUN = {
        workflow: 'gate',
        runId: '356',
        state: 'failed' as const,
        rawStatus: 'failed',
    };
    const RED = { state: 'failed' as const, runs: [RED_RUN] };

    // Шаг спрашивает шов и пропускает мердж только на зелёном/отсутствующем чеке.
    //
    // Часы ТИКАЮТ (полминуты на обращение), а сон — заглушка: ожидание в тесте не должно
    // идти реальные минуты, но и стоять на месте ему нельзя — на замерших часах цикл
    // ожидания не дошёл бы ни до льготы, ни до потолка и крутился бы вечно.
    function forgeMerge(
        g: ReturnType<typeof createGateRunner>,
        over: Record<string, unknown> = {},
    ) {
        let clock = 0;
        return tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            nowFn: () => (clock += 30_000),
            ...over,
        });
    }

    it('чек зелёный — мерджим, и голову спрашиваем ПОСЛЕ локальных чеков, а не вместо них', () => {
        const merge = vi.fn();
        const forgeChecksFn = vi.fn(() => GREEN);
        const g = createGateRunner(makeEnv());
        const res = forgeMerge(g, { forgeChecksFn, mergePrFn: merge });

        expect(res).toBe('merged');
        expect(forgeChecksFn).toHaveBeenCalledWith(9);
        expect(merge).toHaveBeenCalledTimes(1);
    });

    it('шва нет — прежнее поведение: мердж без ожидания', () => {
        const merge = vi.fn();
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            mergePrFn: merge,
        });

        expect(res).toBe('merged');
        expect(merge).toHaveBeenCalledTimes(1);
    });

    it('чек красный, лог про код → forge-red, мердж НЕ зовём, диагноз доступен циклу', () => {
        const merge = vi.fn();
        const g = createGateRunner(makeEnv());
        const res = forgeMerge(g, {
            mergePrFn: merge,
            forgeChecksFn: () => RED,
            forgeDiagnosisFn: () => ({
                workflow: 'gate',
                runId: '356',
                cube: 'test',
                log: ' Tests  2 failed | 7172 passed (7174)',
            }),
        });

        expect(res).toBe('forge-red');
        expect(merge).not.toHaveBeenCalled();
        expect(g.getLastForgeRedCheck()).toMatchObject({
            cube: 'test',
            runId: '356',
            kind: 'code',
        });
    });

    it('чек красный по отказу СРЕДЫ → forge-env: лечить кодом нечего', () => {
        const merge = vi.fn();
        const g = createGateRunner(makeEnv());
        const res = forgeMerge(g, {
            mergePrFn: merge,
            forgeChecksFn: () => RED,
            forgeDiagnosisFn: () => ({
                workflow: 'gate',
                runId: '350',
                cube: 'test',
                log: 'Caused by: Error: Worker exited unexpectedly\n Test Files  430 passed (432)',
            }),
        });

        expect(res).toBe('forge-env');
        expect(merge).not.toHaveBeenCalled();
        expect(g.getLastForgeRedCheck()?.kind).toBe('oom');
    });

    it('красный прогон без названного куба — стоп человеку, а не лечение вслепую', () => {
        const merge = vi.fn();
        const g = createGateRunner(makeEnv());
        const res = forgeMerge(g, {
            mergePrFn: merge,
            forgeChecksFn: () => RED,
            forgeDiagnosisFn: () => null,
        });

        // #269-ревью: отдельный статус, а не 'not-merged'. Разница не косметическая —
        // цикл обязан отдать такой стоп ПУШЕМ: ночью «фаза не сдалась» иначе выясняется
        // утром, а deadman не сработает (процесс завершился штатно).
        expect(res).toBe('forge-unknown');
        expect(merge).not.toHaveBeenCalled();
        expect(g.getLastForgeRedCheck()).toBeNull();
        expect(g.getLastForgeStop()).toContain('упавший куб не назван');
    });

    it('чтение диагноза бросило — тот же стоп, петля не падает', () => {
        const g = createGateRunner(makeEnv());
        const res = forgeMerge(g, {
            forgeChecksFn: () => RED,
            forgeDiagnosisFn: () => {
                throw new Error('площадка не ответила');
            },
        });

        expect(res).toBe('forge-unknown');
    });

    it('потолок ожидания — стоп с причиной, а не мердж вслепую', () => {
        const merge = vi.fn();
        const g = createGateRunner(makeEnv());
        const logs: string[] = [];
        const res = forgeMerge(g, {
            logFn: (m: string) => logs.push(m),
            mergePrFn: merge,
            // Вечно ждущий чек: в жизни это очередь воркера при `max_slots: 1` либо
            // статус, требующий человека (`awaiting_approval`).
            forgeChecksFn: () => ({
                state: 'pending',
                runs: [{ ...RED_RUN, state: 'pending', rawStatus: 'processing' }],
            }),
        });

        expect(res).toBe('forge-unknown');
        expect(merge).not.toHaveBeenCalled();
        // Сырой статус площадки обязан доехать до лога: «всё processing» и «всё
        // awaiting_approval» чинятся разным.
        expect(logs.join('\n')).toContain('processing');
        // ...и до причины стопа, которую цикл кладёт в пуш человеку (#269-ревью).
        expect(g.getLastForgeStop()).toContain('processing');
    });

    it('чеков у PR нет вовсе — мердж идёт, площадке нечего отвергать', () => {
        const merge = vi.fn();
        const g = createGateRunner(makeEnv());
        const res = forgeMerge(g, {
            mergePrFn: merge,
            forgeChecksFn: () => ({ state: 'none', runs: [] }),
        });

        expect(res).toBe('merged');
        expect(merge).toHaveBeenCalledTimes(1);
    });

    it('красный чек прошлого раунда не переезжает в следующий', () => {
        const g = createGateRunner(makeEnv());
        forgeMerge(g, {
            forgeChecksFn: () => RED,
            forgeDiagnosisFn: () => ({
                workflow: 'gate',
                runId: '356',
                cube: 'test',
                log: 'FAIL x',
            }),
        });
        expect(g.getLastForgeRedCheck()).not.toBeNull();

        forgeMerge(g, { forgeChecksFn: () => GREEN });
        expect(g.getLastForgeRedCheck()).toBeNull();
    });

    // Ожидание идёт СВОИМИ коллабораторами гейта. Без этого ассерта подмена `sleepFn`
    // на заглушку внутри `tryMergePhase` оставила бы набор зелёным, а в бою дала бы
    // двадцать минут busy-poll'а API площадки вместо опроса раз в полминуты (находка ревью).
    it('ожидание спит и пишет в лог ТЕМИ ЖЕ коллабораторами, что и весь гейт', () => {
        const sleepFn = vi.fn();
        const logs: string[] = [];
        const g = createGateRunner(makeEnv());
        let asked = 0;
        forgeMerge(g, {
            sleepFn,
            logFn: (m: string) => logs.push(m),
            forgeChecksFn: () =>
                ++asked < 3
                    ? {
                          state: 'pending',
                          runs: [{ ...RED_RUN, state: 'pending', rawStatus: 'processing' }],
                      }
                    : GREEN,
        });

        expect(sleepFn).toHaveBeenCalledTimes(2);
        expect(logs.filter((m) => m.includes('Чек площадки ждёт'))).toHaveLength(2);
    });

    // Парковка — часть восстановления: без неё дерево раннера остаётся на detach'е головы
    // PR, и следующий шаг цикла начинает не с того места. Соседние #53-тесты ассертят её
    // по той же причине (находка ревью).
    it.each([
        [
            'forge-red',
            {
                forgeChecksFn: () => RED,
                forgeDiagnosisFn: () => ({
                    workflow: 'gate',
                    runId: '356',
                    cube: 'test',
                    log: 'Tests  2 failed | 1 passed (3)',
                }),
            },
        ],
        [
            'forge-env',
            {
                forgeChecksFn: () => RED,
                forgeDiagnosisFn: () => ({
                    workflow: 'gate',
                    runId: '350',
                    cube: 'test',
                    log: 'Worker exited unexpectedly\n Test Files  430 passed (432)',
                }),
            },
        ],
        ['таймаут', { forgeChecksFn: () => ({ state: 'pending', runs: [] }) }],
        ['красный без куба', { forgeChecksFn: () => RED, forgeDiagnosisFn: () => null }],
    ])('стоп по чеку площадки (%s) паркует дерево раннера', (_name, over) => {
        const park = vi.fn();
        const g = createGateRunner(makeEnv());
        forgeMerge(g, { parkFn: park, ...over });

        expect(park).toHaveBeenCalled();
    });

    it('прогон ПРЕРВАН (canceled) → forge-env: отменённый прогон код не ломал', () => {
        const g = createGateRunner(makeEnv());
        const res = forgeMerge(g, {
            forgeChecksFn: () => ({
                state: 'failed',
                runs: [{ ...RED_RUN, rawStatus: 'canceled' }],
            }),
            // Лог обрывка выглядит как обычный отказ — отличает только сырой статус.
            forgeDiagnosisFn: () => ({
                workflow: 'gate',
                runId: '356',
                cube: 'install',
                log: 'FAIL что-то оборвалось',
            }),
        });

        expect(res).toBe('forge-env');
        expect(g.getLastForgeRedCheck()?.kind).toBe('aborted');
    });

    it('чек у площадки не спрашивается вовсе, если локальные чеки красные', () => {
        const forgeChecksFn = vi.fn(() => GREEN);
        const g = createGateRunner(makeEnv());
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => false,
            getLastRedCheckFn: () => ({ name: 'lint', cmd: 'npm run lint', excerpt: 'бух' }),
            forgeChecksFn,
        });

        expect(res).toBe('red-checks');
        expect(forgeChecksFn).not.toHaveBeenCalled();
    });

    // #278: свежесть вердикта форжа — гейт передаёт время коммита проверенной головы
    // в `waitForForgeChecksFn` как нижнюю границу (`sinceMs`). Сам разбор «прогон
    // старше/новее» — предмет `core/forge-checks.test.ts`; здесь проверяется только
    // ПРОВОДКА: гейт узнаёт время локально (по sha, а не второй раз у форжа) и не
    // падает, если узнать его не вышло.
    describe('свежесть вердикта форжа: время коммита проводится в sinceMs (#278)', () => {
        it('время коммита головы уходит в waitForForgeChecksFn как sinceMs', () => {
            const waitForForgeChecksFn = vi.fn(() => ({ kind: 'green' as const }));
            const headCommittedAtFn = vi.fn(() => 1_726_000_000_000);
            const g = createGateRunner(makeEnv());

            const res = forgeMerge(g, {
                forgeChecksFn: () => GREEN,
                waitForForgeChecksFn,
                headCommittedAtFn,
            });

            expect(res).toBe('merged');
            expect(headCommittedAtFn).toHaveBeenCalledWith(SHA);
            expect(waitForForgeChecksFn).toHaveBeenCalledWith(
                expect.objectContaining({ sinceMs: 1_726_000_000_000 }),
            );
        });

        it('время коммита узнать не вышло — гейт не падает, просто не проверяет свежесть', () => {
            const waitForForgeChecksFn = vi.fn((_deps: unknown) => ({ kind: 'green' as const }));
            const headCommittedAtFn = vi.fn(() => {
                throw new Error('git log упал');
            });
            const logs: string[] = [];
            const g = createGateRunner(makeEnv());

            const res = forgeMerge(g, {
                forgeChecksFn: () => GREEN,
                waitForForgeChecksFn,
                headCommittedAtFn,
                logFn: (m: string) => logs.push(m),
            });

            expect(res).toBe('merged');
            const [call] = waitForForgeChecksFn.mock.calls;
            expect(call?.[0]).not.toHaveProperty('sinceMs');
            expect(logs.some((l) => l.includes('время коммита'))).toBe(true);
        });

        it('форж-шаг пропущен (нет forgeChecksFn) — время коммита никто не спрашивает', () => {
            const headCommittedAtFn = vi.fn(() => 1_726_000_000_000);
            const g = createGateRunner(makeEnv());

            const res = tryMergeWith(g, phase, {
                findOpenPrFn: () => ({ number: 9, labels: [] }),
                checksGreenFn: () => true,
                getVerifiedHeadFn: () => SHA,
                headCommittedAtFn,
            });

            expect(res).toBe('merged');
            expect(headCommittedAtFn).not.toHaveBeenCalled();
        });
    });
});

// Само ТЕЛО `headCommittedAt` (правка по ревью #278): тесты выше подменяют
// `headCommittedAtFn` и проверяют только проводку, а `git log -1 --format=%cI` + `Date.parse`
// не исполнялись ни разу — при том что именно они решают, будет ли `sinceMs` вообще.
describe('headCommittedAt — время коммита проверенной головы (#278)', () => {
    const SHA40 = 'a'.repeat(40);

    it('ISO-дата от git превращается в epoch ms', () => {
        const g = createGateRunner(makeEnv());
        const shFn = vi.fn(() => '2026-09-06T12:00:00+03:00\n');

        const ms = g.headCommittedAt(SHA40, shFn, (v: unknown) => `'${String(v)}'`);

        expect(ms).toBe(Date.parse('2026-09-06T12:00:00+03:00'));
        // Sha уходит в шелл только через квотирование (инвариант C3), а не голой строкой.
        expect(shFn).toHaveBeenCalledWith(`git log -1 --format=%cI '${SHA40}'`);
    });

    it('мусор вместо даты — бросок, а не «эпоха» тихо', () => {
        // `Date.parse('не дата')` даёт NaN, а NaN как `sinceMs` объявил бы устаревшим
        // ЛЮБОЙ прогон: сравнение с NaN всегда ложно, и это молчаливый отказ, не отказ.
        const g = createGateRunner(makeEnv());

        expect(() =>
            g.headCommittedAt(
                SHA40,
                () => 'не дата',
                (v: unknown) => `'${String(v)}'`,
            ),
        ).toThrow(/валидную дату коммита/);
    });

    it('git упал — исключение доходит до вызывающего (там оно fail-open)', () => {
        // Ронять весь мердж-путь из-за нечитаемой даты нельзя, но и глотать её ЗДЕСЬ тоже:
        // решение «свежесть в этом круге не проверяем» принимает `tryMergePhase` и пишет
        // об этом строку в лог — сьют выше это и проверяет.
        const g = createGateRunner(makeEnv());

        expect(() =>
            g.headCommittedAt(
                SHA40,
                () => {
                    throw new Error('fatal: bad object');
                },
                (v: unknown) => `'${String(v)}'`,
            ),
        ).toThrow(/bad object/);
    });
});

// ── Задача 81: политика внешнего CI и три исхода гейта ──────────────────────────
//
// Политика приходит из конфига (`gate.externalCi`, `gate.onToolFailure`) и решает две
// разные вещи. `externalCi` — что считается подтверждением CI: при `required` мердж не
// дают ни отсутствие прогона, ни прогон без даты, ни невозможность проверить свежесть.
// `onToolFailure` — что делать, когда чек упал не на коде, а на инструменте: это третий
// исход рядом с «прошёл» и «регрессия», и чини-сессия его не получает никогда.

describe('resolveGatePolicy — политика гейта из конфига, fail-closed (задача 81)', () => {
    const withGate = (extra: Record<string, unknown>) => ({
        gate: { ...SYNTH_GATE.gate, ...extra },
    });
    const failing = (msg: string): never => {
        throw new Error(msg);
    };

    it('ключей нет — прежнее поведение, сказанное вслух: optional и fail-closed', () => {
        expect(resolveGatePolicy(SYNTH_GATE, failing)).toEqual({
            externalCi: 'optional',
            onToolFailure: 'fail-closed',
        });
    });

    it.each(['required', 'optional', 'disabled'])('externalCi=%s принимается', (v) => {
        expect(resolveGatePolicy(withGate({ externalCi: v }), failing).externalCi).toBe(v);
    });

    it('опечатка в externalCi — стоп, а не «дефолт как у нас»', () => {
        expect(() => resolveGatePolicy(withGate({ externalCi: 'requird' }), failing)).toThrow(
            /gate\.externalCi/,
        );
    });

    it('опечатка в onToolFailure — стоп', () => {
        expect(() => resolveGatePolicy(withGate({ onToolFailure: 'open' }), failing)).toThrow(
            /gate\.onToolFailure/,
        );
    });

    it('fail, который вернулся, оставляет СТРОЖАЙШУЮ политику, а не мягкую', () => {
        const quiet = () => undefined;
        expect(resolveGatePolicy(withGate({ externalCi: 1, onToolFailure: 2 }), quiet)).toEqual({
            externalCi: 'required',
            onToolFailure: 'fail-closed',
        });
    });
});

describe('classifyCheckFailure — регрессия против сбоя инструмента (задача 81)', () => {
    const err = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);

    it.each([
        ['код 1 — регрессия', { status: 1 }, 'regression'],
        ['код 2 — регрессия (tsc, prettier так сообщают о находках)', { status: 2 }, 'regression'],
        ['ошибка без кода выхода — регрессия (форма неизвестна)', {}, 'regression'],
        ['127 — команда не найдена', { status: 127 }, 'tool-failure'],
        ['126 — не исполняется', { status: 126 }, 'tool-failure'],
        ['137 — убит SIGKILL через шелл', { status: 137 }, 'tool-failure'],
        ['убит сигналом', { status: null, signal: 'SIGKILL' }, 'tool-failure'],
        ['не запустился', { status: null, code: 'ENOENT' }, 'tool-failure'],
        ['переполнен буфер вывода', { status: 1, code: 'ENOBUFS' }, 'tool-failure'],
    ])('%s', (_name, fields, want) => {
        expect(classifyCheckFailure(err(fields))).toBe(want);
    });
});

describe('checksGreen — сбой инструмента не регрессия (задача 81)', () => {
    function run(
        g: ReturnType<typeof createGateRunner>,
        failure: Record<string, unknown>,
        extra: Record<string, unknown> = {},
    ) {
        const sh = vi.fn((cmd: string) => {
            if (cmd.includes('rev-parse') || cmd === 'npm run lint') return '';
            throw Object.assign(new Error('boom'), { stderr: 'sh: vitest: not found' }, failure);
        });
        return g.checksGreen('feature/x', 7, {
            shFn: sh,
            runArgvFn: () => '',
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [
                ['test', 'npm run test'],
                ['lint', 'npm run lint'],
            ],
            ...extra,
        });
    }

    it('fail-closed: false, red-check пуст (лечить нечего), сбой назван с кодом', () => {
        const park = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        expect(run(g, { status: 127 })).toBe(false);
        expect(g.getLastRedCheck()).toBeNull();
        expect(g.getLastToolFailure()).toMatchObject({ name: 'test', cmd: 'npm run test' });
        expect(g.getLastToolFailure()?.why).toContain('127');
        expect(g.getVerifiedHead()).toBeNull();
        expect(park).toHaveBeenCalledTimes(1);
    });

    it('fail-open: чек пропущен вслух, следующие идут, голова проверена', () => {
        const logs: string[] = [];
        const g = createGateRunner(makeEnv());
        const ok = run(
            g,
            { status: null, signal: 'SIGKILL' },
            {
                onToolFailure: 'fail-open',
                logFn: (m: string) => logs.push(m),
            },
        );
        expect(ok).toBe(true);
        expect(g.getVerifiedHead()).toBe(SHA);
        expect(g.getLastToolFailure()).toBeNull();
        expect(g.getToolFailureSkips()).toEqual([
            expect.objectContaining({ name: 'test', why: expect.stringContaining('SIGKILL') }),
        ]);
        expect(logs.join('\n')).toContain('fail-open');
        expect(logs.join('\n')).toContain('✓ lint');
    });

    it('fail-open не глушит регрессию: код 1 по-прежнему красный', () => {
        const g = createGateRunner(makeEnv());
        expect(run(g, { status: 1 }, { onToolFailure: 'fail-open' })).toBe(false);
        expect(g.getLastRedCheck()).toMatchObject({ name: 'test' });
        expect(g.getToolFailureSkips()).toEqual([]);
    });

    it('fail-open с нижней планкой: все чеки упали на инструменте → false, стоп сбоя', () => {
        const park = vi.fn();
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park }));
        const sh = vi.fn((cmd: string) => {
            if (cmd.includes('rev-parse')) return '';
            throw Object.assign(new Error('boom'), { stderr: 'sh: npm: not found', status: 127 });
        });
        const ok = g.checksGreen('feature/x', 7, {
            shFn: sh,
            runArgvFn: () => '',
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [
                ['test', 'npm run test'],
                ['lint', 'npm run lint'],
            ],
            onToolFailure: 'fail-open',
        });
        expect(ok).toBe(false);
        expect(g.getVerifiedHead()).toBeNull();
        expect(g.getLastRedCheck()).toBeNull();
        expect(g.getLastToolFailure()?.why).toContain('все чеки');
        expect(g.getLastToolFailure()?.excerpt).toContain('not found');
        expect(park).toHaveBeenCalledTimes(1);
    });

    it('дефолт политики — из конфига: onToolFailure: fail-open в gate доезжает до чеков', () => {
        const cfg = { gate: { ...SYNTH_GATE.gate, onToolFailure: 'fail-open' } };
        const g = createGateRunner(makeEnv({ getConfig: () => cfg }));
        expect(run(g, { status: 127 })).toBe(true);
    });
});

describe('tryMergePhase — три исхода гейта и политика внешнего CI (задача 81)', () => {
    const phase = { branch: 'feature/m1', milestone: 'M1' };
    const policy = (externalCi: string, onToolFailure = 'fail-closed') => ({
        gate: { ...SYNTH_GATE.gate, externalCi, onToolFailure },
    });
    const DATED_GREEN = {
        state: 'success' as const,
        runs: [
            {
                workflow: 'gate',
                runId: '400',
                state: 'success' as const,
                rawStatus: 'success',
                createdAt: 2_000_000,
            },
        ],
    };

    function merge81(g: ReturnType<typeof createGateRunner>, over: Record<string, unknown> = {}) {
        let clock = 0;
        return tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            headCommittedAtFn: () => 2_000_000,
            nowFn: () => (clock += 30_000),
            ...over,
        });
    }

    it('сбой инструмента локального чека → gate-tool-failure, не red-checks', () => {
        const g = createGateRunner(makeEnv());
        const mergePrFn = vi.fn();
        const res = merge81(g, {
            checksGreenFn: () => false,
            getLastRedCheckFn: () => null,
            getLastToolFailureFn: () => ({
                name: 'test',
                cmd: 'npm run test',
                why: 'код 127',
                excerpt: 'not found',
            }),
            mergePrFn,
        });
        expect(res).toBe('gate-tool-failure');
        expect(mergePrFn).not.toHaveBeenCalled();
    });

    it('required + прогона нет дольше grace → нет мерджа', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('required') }));
        const mergePrFn = vi.fn();
        const res = merge81(g, {
            forgeChecksFn: () => ({ state: 'none', runs: [] }),
            mergePrFn,
        });
        expect(res).toBe('forge-unknown');
        expect(mergePrFn).not.toHaveBeenCalled();
        expect(g.getLastForgeStop()).toContain('required');
    });

    it('optional + прогона нет → мердж, как раньше', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('optional') }));
        const mergePrFn = vi.fn();
        const res = merge81(g, {
            forgeChecksFn: () => ({ state: 'none', runs: [] }),
            mergePrFn,
        });
        expect(res).toBe('merged');
        expect(mergePrFn).toHaveBeenCalledTimes(1);
    });

    it('required + прогон без даты → нет мерджа', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('required') }));
        const mergePrFn = vi.fn();
        const undated = {
            state: 'success' as const,
            runs: [
                { workflow: 'gate', runId: '400', state: 'success' as const, rawStatus: 'success' },
            ],
        };
        const res = merge81(g, { forgeChecksFn: () => undated, mergePrFn });
        expect(res).toBe('forge-unknown');
        expect(mergePrFn).not.toHaveBeenCalled();
        expect(g.getLastForgeStop()).toContain('без даты');
    });

    it('required + время коммита головы неизвестно → нет мерджа, CI даже не спрашиваем', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('required') }));
        const forgeChecksFn = vi.fn(() => DATED_GREEN);
        const mergePrFn = vi.fn();
        const res = merge81(g, {
            headCommittedAtFn: () => {
                throw new Error('git log упал');
            },
            forgeChecksFn,
            mergePrFn,
        });
        expect(res).toBe('forge-unknown');
        expect(forgeChecksFn).not.toHaveBeenCalled();
        expect(mergePrFn).not.toHaveBeenCalled();
    });

    it('required + у адаптера нет чтения чеков → нет мерджа', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('required') }));
        const mergePrFn = vi.fn();
        const res = merge81(g, { mergePrFn });
        expect(res).toBe('forge-unknown');
        expect(mergePrFn).not.toHaveBeenCalled();
    });

    it('required + датированный свежий зелёный → мердж', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('required') }));
        const res = merge81(g, { forgeChecksFn: () => DATED_GREEN });
        expect(res).toBe('merged');
    });

    it('disabled → адаптер чеков не вызывается, мердж идёт', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('disabled') }));
        const forgeChecksFn = vi.fn(() => DATED_GREEN);
        const res = merge81(g, { forgeChecksFn });
        expect(res).toBe('merged');
        expect(forgeChecksFn).not.toHaveBeenCalled();
        expect(g.getLastMergeProof()).toContain('disabled');
    });

    it('optional + сбой инструмента CI + fail-open → мердж, решение в доказательстве', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('optional', 'fail-open') }));
        const mergePrFn = vi.fn();
        const res = merge81(g, {
            forgeChecksFn: () => {
                throw new Error('площадка 503');
            },
            mergePrFn,
        });
        expect(res).toBe('merged');
        expect(mergePrFn).toHaveBeenCalledTimes(1);
        expect(g.getLastMergeProof()).toContain('fail-open');
        expect(g.getLastMergeProof()).toContain('площадка 503');
    });

    it('optional + таймаут ожидания CI + fail-open → нет мерджа: медленный CI не сбой инструмента', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('optional', 'fail-open') }));
        const mergePrFn = vi.fn();
        const res = merge81(g, {
            forgeChecksFn: () => DATED_GREEN,
            waitForForgeChecksFn: () => ({ kind: 'timeout', detail: 'прогона новее пуша нет' }),
            mergePrFn,
        });
        expect(res).toBe('forge-unknown');
        expect(mergePrFn).not.toHaveBeenCalled();
        expect(g.getLastForgeStop()).toContain('прогона новее пуша нет');
    });

    it('optional + сбой инструмента CI + fail-closed → нет мерджа', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('optional') }));
        const res = merge81(g, {
            forgeChecksFn: () => {
                throw new Error('площадка 503');
            },
        });
        expect(res).toBe('forge-unknown');
    });

    it('required сильнее fail-open: сбой инструмента CI мердж не даёт', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('required', 'fail-open') }));
        const mergePrFn = vi.fn();
        const res = merge81(g, {
            forgeChecksFn: () => {
                throw new Error('площадка 503');
            },
            mergePrFn,
        });
        expect(res).toBe('forge-unknown');
        expect(mergePrFn).not.toHaveBeenCalled();
    });

    it('доказательство мерджа называет голову, политику и исход CI; пишется в лог до мерджа', () => {
        const logs: string[] = [];
        const order: string[] = [];
        const g = createGateRunner(makeEnv({ getConfig: () => policy('required') }));
        merge81(g, {
            forgeChecksFn: () => DATED_GREEN,
            logFn: (m: string) => {
                logs.push(m);
                if (m.includes('Доказательство мерджа')) order.push('proof');
            },
            mergePrFn: () => order.push('merge'),
        });
        const proof = g.getLastMergeProof() ?? '';
        expect(proof).toContain(SHA.slice(0, 8));
        expect(proof).toContain('required');
        expect(proof).toContain('зелёный');
        expect(proof).toContain('fail-closed');
        expect(order).toEqual(['proof', 'merge']);
    });

    it('fail-open пропуски локальных чеков видны в доказательстве', () => {
        const g = createGateRunner(makeEnv({ getConfig: () => policy('disabled', 'fail-open') }));
        merge81(g, {
            getToolFailureSkipsFn: () => [{ name: 'test', cmd: 'npm run test', why: 'код 137' }],
        });
        expect(g.getLastMergeProof()).toContain('test');
        expect(g.getLastMergeProof()).toContain('код 137');
        // При пропусках «зелёный» — неправда: чек не прошёл, его не дозапустили.
        expect(g.getLastMergeProof()).not.toContain('зелёный');
        expect(g.getLastMergeProof()).toMatch(/прошли \d+ из \d+/);
    });
});

describe('checksGreen/tryMergePhase — ветка фазы, отставшая от main (#66)', () => {
    const MERGED = 'c'.repeat(40);
    const MAIN = 'd'.repeat(40);

    function run(g: ReturnType<typeof createGateRunner>, mainSyncFn: unknown) {
        const sh = vi.fn(() => '');
        const ok = g.checksGreen('feature/x', 7, {
            shFn: sh,
            runArgvFn: () => '',
            prHeadShaFn: () => SHA,
            syncDepsFn: () => {},
            checks: [['lint', 'npm run lint']],
            mainSyncFn: mainSyncFn as never,
        });
        return { ok, sh };
    }

    it('влитие прошло → чеки и --match-head-commit на НОВОЙ голове, а не на отставшей', () => {
        const g = createGateRunner(makeEnv());
        const mainSync = vi.fn(() => ({ kind: 'updated', head: MERGED, main: MAIN }));
        const { ok, sh } = run(g, mainSync);
        expect(ok).toBe(true);
        expect(mainSync).toHaveBeenCalledWith('feature/x', SHA, expect.anything());
        expect(sh).toHaveBeenCalledWith('npm run lint', expect.anything());
        expect(g.getVerifiedHead()).toBe(MERGED);
        expect(g.getLastMainSyncStop()).toBeNull();
    });

    it('конфликт → false до чеков, файлы в записи, red-check пуст (лечить нечего)', () => {
        const park = vi.fn();
        const logs: string[] = [];
        const g = createGateRunner(makeEnv({ parkOnOriginMain: park, log: (m) => logs.push(m) }));
        const conflict = { kind: 'conflict', main: MAIN, files: ['docs/core-journal.md'] };
        const { ok, sh } = run(g, () => conflict);
        expect(ok).toBe(false);
        expect(sh).not.toHaveBeenCalledWith('npm run lint', expect.anything());
        expect(g.getLastMainSyncStop()).toEqual(conflict);
        expect(g.getLastRedCheck()).toBeNull();
        expect(g.getVerifiedHead()).toBeNull();
        expect(park).toHaveBeenCalledTimes(1);
        expect(logs.some((l) => l.includes('docs/core-journal.md'))).toBe(true);
    });

    it('следующий раунд сбрасывает запись: устаревший конфликт не доезжает до исхода', () => {
        const g = createGateRunner(makeEnv());
        run(g, () => ({ kind: 'failed', why: 'сеть' }));
        expect(g.getLastMainSyncStop()).not.toBeNull();
        run(g, () => ({ kind: 'current' }));
        expect(g.getLastMainSyncStop()).toBeNull();
    });

    it('tryMergePhase: запись о влитии → main-conflict, мерджа нет', () => {
        const g = createGateRunner(makeEnv());
        const mergePrFn = vi.fn();
        const res = tryMergeWith(
            g,
            { branch: 'feature/x', milestone: 'M' },
            {
                findOpenPrFn: () => ({ number: 7, labels: [] }),
                checksGreenFn: () => false,
                getLastMainSyncStopFn: () => ({ kind: 'conflict', main: MAIN, files: ['a'] }),
                // Сбой влития важнее любого прошлого red-check: проверяется первым.
                getLastRedCheckFn: () => ({ name: 'lint', cmd: 'x', excerpt: '' }),
                mergePrFn,
            },
        );
        expect(res).toBe('main-conflict');
        expect(mergePrFn).not.toHaveBeenCalled();
    });

    it('#85 tryMergePhase: запись о расхождении HEAD → head-diverged, а не not-merged', () => {
        const g = createGateRunner(makeEnv());
        const mergePrFn = vi.fn();
        const res = tryMergeWith(
            g,
            { branch: 'feature/x', milestone: 'M' },
            {
                findOpenPrFn: () => ({ number: 7, labels: [] }),
                checksGreenFn: () => false,
                getLastHeadDivergenceFn: () => ({ local: OTHER_SHA, remote: SHA, line: 'x' }),
                mergePrFn,
            },
        );
        expect(res).toBe('head-diverged');
        expect(mergePrFn).not.toHaveBeenCalled();
    });
});

// ── #139: защищаемые пути на площадке без правила ревью по путям ────────────────
//
// Гейт сверяет файлы PR со списком ядра, только когда ему дали чтение файлов: composition
// root даёт его по шву форжа. Предмет — исход и текст стопа, а не разбор git.
describe('tryMergePhase — защищаемые пути (#139)', () => {
    const phase = { branch: 'feature/m1', milestone: 'M1' };

    function guardedMerge(over: Record<string, unknown>) {
        const g = createGateRunner(makeEnv());
        const merge = vi.fn();
        const park = vi.fn();
        const logs: string[] = [];
        const res = tryMergeWith(g, phase, {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            mergePrFn: merge,
            parkFn: park,
            logFn: (m: string) => logs.push(m),
            ...over,
        });
        const last = g.getLastProtectedPathsStop();
        return { res, merge, park, logs, stop: last?.why ?? null, kind: last?.kind ?? null };
    }

    it('PR с правкой lock — стоп с причиной и файлами, мердж не зовём', () => {
        const forgeChecksFn = vi.fn();
        const { res, merge, park, stop, kind } = guardedMerge({
            changedFilesFn: () => ['src/a.ts', '.ralph/core.lock', '.github/workflows/ci.yml'],
            forgeChecksFn,
        });
        expect(res).toBe('protected-paths');
        expect(kind).toBe('hits');
        expect(merge).not.toHaveBeenCalled();
        // Сверка стоит до ожидания CI площадки: вердикт, которым не воспользуемся, не ждём.
        expect(forgeChecksFn).not.toHaveBeenCalled();
        expect(park).toHaveBeenCalledTimes(1);
        expect(stop).toMatch(/правка защищаемого пути — мердж за человеком/);
        expect(stop).toContain('.ralph/core.lock (.ralph/core.lock)');
        expect(stop).toContain('.github/workflows/ci.yml (.github/**)');
        expect(stop).not.toContain('src/a.ts');
    });

    it('доменный PR — мердж, файлы спрошены по проверенной голове', () => {
        const changedFilesFn = vi.fn(() => ['src/a.ts', 'docs/x.md']);
        const { res, merge, stop, logs } = guardedMerge({ changedFilesFn });
        expect(res).toBe('merged');
        expect(changedFilesFn).toHaveBeenCalledWith(SHA);
        expect(merge).toHaveBeenCalledTimes(1);
        expect(stop).toBeNull();
        expect(logs.some((l) => l.includes('защищаемых путей в PR нет'))).toBe(true);
    });

    it('сбой получения файлов — стоп с причиной, а не мердж', () => {
        const { res, merge, stop, kind } = guardedMerge({
            changedFilesFn: () => {
                throw new Error('fatal: bad revision');
            },
        });
        expect(res).toBe('protected-paths');
        expect(kind).toBe('unverified');
        expect(merge).not.toHaveBeenCalled();
        expect(stop).toMatch(/файлы PR не получены \(fatal: bad revision\)/);
    });

    it('пустой список файлов — стоп, а не «нечего сверять»', () => {
        const { res, merge, stop, kind } = guardedMerge({ changedFilesFn: () => [] });
        expect(res).toBe('protected-paths');
        expect(merge).not.toHaveBeenCalled();
        // Пустой дифф назван своей причиной: правки ветки бывают уже в main.
        expect(kind).toBe('empty');
        expect(stop).toMatch(/PR без изменений относительно main/);
    });

    it('голова не зафиксирована — стоп, файлы не спрашиваем', () => {
        const changedFilesFn = vi.fn(() => ['src/a.ts']);
        const { res, merge, stop, kind } = guardedMerge({
            changedFilesFn,
            getVerifiedHeadFn: () => null,
        });
        expect(res).toBe('protected-paths');
        expect(kind).toBe('unverified');
        expect(changedFilesFn).not.toHaveBeenCalled();
        expect(merge).not.toHaveBeenCalled();
        expect(stop).toMatch(/голова PR не зафиксирована/);
    });

    // От противного: без чтения файлов (площадка держит пути сама) тот же PR с lock
    // мерджится — значит стоп выше держит именно сверка, а не что-то по соседству.
    it('площадка держит пути сама — гейт lock не сверяет', () => {
        const { res, merge, stop } = guardedMerge({});
        expect(res).toBe('merged');
        expect(merge).toHaveBeenCalledTimes(1);
        expect(stop).toBeNull();
    });

    it('стоп прошлого раунда не переживает новый', () => {
        const g = createGateRunner(makeEnv());
        const base = {
            findOpenPrFn: () => ({ number: 9, labels: [] }),
            checksGreenFn: () => true,
            getVerifiedHeadFn: () => SHA,
            logFn: () => {},
        };
        tryMergeWith(g, phase, { ...base, changedFilesFn: () => ['ralph'] });
        expect(g.getLastProtectedPathsStop()?.why).toMatch(/ralph/);
        tryMergeWith(g, phase, { ...base, changedFilesFn: () => ['a.ts'] });
        expect(g.getLastProtectedPathsStop()).toBeNull();
    });
});

describe('prChangedFiles — файлы PR по git (#139)', () => {
    it('три точки от origin/main, без переименований, имена через NUL', () => {
        const g = createGateRunner(makeEnv());
        const sh = vi.fn((_cmd: string) => '.ralph/core.lock\0dir/имя с пробелом.ts\0');
        expect(g.prChangedFiles(SHA, sh, (s: unknown) => `'${String(s)}'`)).toEqual([
            '.ralph/core.lock',
            'dir/имя с пробелом.ts',
        ]);
        const cmd = String(sh.mock.calls[0]?.[0]);
        expect(cmd).toContain(`origin/main...'${SHA}'`);
        expect(cmd).toContain('--no-renames');
        expect(cmd).toContain('-z');
    });

    // С `-z` разделитель — NUL, и имя с переводом строки на краю — настоящее имя файла:
    // срезать его нельзя, иначе в стоп ушло бы не то имя.
    it('перевод строки в имени сохраняется, хвостовой NUL не даёт пустого имени', () => {
        const g = createGateRunner(makeEnv());
        expect(
            g.prChangedFiles(
                SHA,
                () => 'a\n\0b.ts\0',
                (s: unknown) => String(s),
            ),
        ).toEqual(['a\n', 'b.ts']);
    });

    it('пустой вывод — пустой список (решает вызывающий)', () => {
        const g = createGateRunner(makeEnv());
        expect(
            g.prChangedFiles(
                SHA,
                () => '',
                (s: unknown) => String(s),
            ),
        ).toEqual([]);
    });
});

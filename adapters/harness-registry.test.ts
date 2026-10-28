// Реестр пакетов харнессов (#180): что принимается, что отвергается и с какой причиной.
// Пакеты подаются через коллабораторов — каталог, файлы, импорт; настоящий каталог
// `harnesses/` проверяется отдельно: пакет Claude Code в нём обязан быть принят.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    ALL_PACKAGES,
    HARNESSES_DIR,
    HARNESS_REGISTRY,
    discoverHarnessPackages,
    cliVersionDrift,
    harnessPackageProblems,
    loopDeniedTools,
    selectHarness,
    type RegistryDeps,
} from './harness-registry.ts';
import { HARNESS_INTERFACE_VERSION } from './harness-package.ts';

const CLAUDE_DESCRIPTOR = JSON.parse(
    readFileSync(path.join(HARNESSES_DIR, 'claude-code', 'descriptor.json'), 'utf-8'),
) as Record<string, unknown>;

const goodPackage = (harness: string, over: Record<string, unknown> = {}) => ({
    harnessPackage: {
        interfaceVersion: HARNESS_INTERFACE_VERSION,
        harness,
        guardRegistration: () => ({ hooks: [], problems: [] }),
        probes: [
            {
                what: 'x',
                toolName: 'Bash',
                toolInput: {},
                expect: 'blocked',
                reasonCode: 'destructive',
            },
        ],
        matcherCovers: () => true,
        hookPayload: () => '{}',
        setsProjectDirEnv: false,
        skillBarrier: false,
        guardInput: 'event',
        guardLimit: null,
        plugin: null,
        projectLayers: null,
        ...over,
    },
});

/** Каталог пакетов в памяти: имя → описание и модуль. */
function fakeDeps(
    packages: Record<string, { descriptor?: unknown; module?: unknown; importError?: string }>,
    { normalizerExists = true }: { normalizerExists?: boolean } = {},
): RegistryDeps {
    return {
        root: '/pk',
        listDirsFn: () => Object.keys(packages),
        readFileFn: (p) => {
            const name = path.basename(path.dirname(p));
            const d = packages[name]?.descriptor;
            if (d === undefined) throw new Error(`ENOENT: ${p}`);
            return typeof d === 'string' ? d : JSON.stringify(d);
        },
        existsFn: () => normalizerExists,
        importFn: async (p) => {
            const pkg = packages[path.basename(path.dirname(p))];
            if (pkg?.importError) throw new Error(pkg.importError);
            return pkg?.module;
        },
    };
}

const descriptorOf = (harness: string) => ({ ...CLAUDE_DESCRIPTOR, harness });

describe('реестр: настоящий каталог пакетов', () => {
    it('пакет Claude Code принят, отказов нет', async () => {
        const registry = await discoverHarnessPackages();
        expect([...registry.problems]).toEqual([]);
        const claude = registry.packages.get('claude-code');
        expect(claude?.pkg.harness).toBe('claude-code');
        expect(claude?.descriptor.harness).toBe('claude-code');
        expect(claude?.normalizerPath).toBe(
            path.join(HARNESSES_DIR, 'claude-code', 'normalize.ts'),
        );
        expect(HARNESS_REGISTRY.packages.has('claude-code')).toBe(true);
    });

    // #181, #213: Codex, Kimi Code и OpenCode сняты с временного моста — их выбирает реестр.
    it.each(['codex', 'kimi-code', 'opencode'])(
        'пакет %s принят, нормализатор в пакете',
        async (name) => {
            const registry = await discoverHarnessPackages();
            const loaded = registry.packages.get(name);
            expect(loaded?.pkg.harness).toBe(name);
            expect(loaded?.descriptor.harness).toBe(name);
            expect(loaded?.normalizerPath).toBe(path.join(HARNESSES_DIR, name, 'normalize.ts'));
        },
    );
});

describe('реестр: отказы с причиной', () => {
    it('несовместимая версия интерфейса — пакет отвергнут, причина названа', async () => {
        const registry = await discoverHarnessPackages(
            fakeDeps({
                a: {
                    descriptor: descriptorOf('a'),
                    module: goodPackage('a', { interfaceVersion: 99 }),
                },
            }),
        );
        expect(registry.packages.size).toBe(0);
        expect(registry.problems.get('a')).toEqual([
            `package.ts: несовместимая версия интерфейса 99 (реестр знает ${HARNESS_INTERFACE_VERSION})`,
        ]);
        const sel = selectHarness(registry, 'a');
        expect(sel.ok).toBe(false);
        expect(!sel.ok && sel.reason).toMatch(
            /пакет харнесса «a» не принят реестром: .*несовместимая версия интерфейса 99/,
        );
    });

    it('отказ одного пакета не роняет остальные', async () => {
        const registry = await discoverHarnessPackages(
            fakeDeps({
                a: { descriptor: descriptorOf('a'), module: goodPackage('a') },
                b: { descriptor: { schemaVersion: 7 } },
            }),
        );
        expect([...registry.packages.keys()]).toEqual(['a']);
        expect(registry.problems.get('b')?.[0]).toMatch(
            /descriptor\.json: [\s\S]*незнакомая версия 7/,
        );
    });

    it.each([
        ['описание не JSON', { descriptor: '{' }, /descriptor\.json: /],
        ['описания нет', {}, /descriptor\.json: ENOENT/],
        [
            'harness описания не равен каталогу',
            { descriptor: descriptorOf('other'), module: goodPackage('a') },
            /harness «other» не равен имени каталога «a»/,
        ],
        [
            'модуль не загрузился',
            { descriptor: descriptorOf('a'), importError: 'SyntaxError' },
            /package\.ts не загрузился: SyntaxError/,
        ],
        [
            'нет экспорта harnessPackage',
            { descriptor: descriptorOf('a'), module: {} },
            /нет экспорта harnessPackage/,
        ],
        [
            'harness кода не равен каталогу',
            { descriptor: descriptorOf('a'), module: goodPackage('other') },
            /harness "other" не равен имени каталога «a»/,
        ],
    ])('%s — отказ', async (_what, pkg, reason) => {
        const registry = await discoverHarnessPackages(fakeDeps({ a: pkg }));
        expect(registry.packages.size).toBe(0);
        expect(registry.problems.get('a')?.join('\n')).toMatch(reason);
    });

    it('команды нормализатора нет в пакете — отказ на старте, а не блок в сессии', async () => {
        const registry = await discoverHarnessPackages(
            fakeDeps(
                { a: { descriptor: descriptorOf('a'), module: goodPackage('a') } },
                { normalizerExists: false },
            ),
        );
        expect(registry.problems.get('a')).toEqual(['нормализатора normalize.ts в пакете нет']);
    });

    it('каталог пакетов не прочитан — отказ всех, а не «пакетов нет»', async () => {
        const registry = await discoverHarnessPackages({
            root: '/нет',
            listDirsFn: () => {
                throw new Error('EACCES');
            },
        });
        expect(registry.packages.size).toBe(0);
        expect(registry.problems.get(ALL_PACKAGES)?.[0]).toMatch(/каталог пакетов \/нет.*EACCES/);
        const sel = selectHarness(registry, 'claude-code');
        expect(!sel.ok && sel.reason).toMatch(/«claude-code» не принят реестром: каталог пакетов/);
    });

    it('незнакомое имя — «пакета нет», без причин реестра', () => {
        const sel = selectHarness({ packages: new Map(), problems: new Map() }, 'x');
        expect(sel).toEqual({ ok: false, reason: 'пакета харнесса «x» в реестре нет' });
    });
});

describe('cliVersionDrift — версия CLI против описания', () => {
    const registry = {
        packages: new Map([['h', { descriptor: { cliVersion: '1.0.0' } }]]),
        problems: new Map(),
    } as never;

    it('совпала, не прочиталась, пакета нет — расхождения нет', () => {
        expect(cliVersionDrift(registry, 'h', '1.0.0', 'unknown')).toBeNull();
        expect(cliVersionDrift(registry, 'h', 'unknown', 'unknown')).toBeNull();
        expect(cliVersionDrift(registry, 'x', '2.0.0', 'unknown')).toBeNull();
    });

    it('другая версия — причина с обеими версиями и следствием', () => {
        expect(cliVersionDrift(registry, 'h', '1.1.0', 'unknown')).toMatch(
            /снято с CLI 1\.0\.0, исполняется 1\.1\.0.*unknown-field/,
        );
    });
});

describe('форма кода пакета', () => {
    it('исправный пакет — проблем нет', () => {
        expect(harnessPackageProblems(goodPackage('a').harnessPackage, 'a')).toEqual([]);
    });

    it('версия сверяется раньше формы: чужая версия — одна причина', () => {
        expect(harnessPackageProblems({ interfaceVersion: 0 }, 'a')).toHaveLength(1);
    });

    it('нет функций, состава пробы и флагов — каждая причина названа', () => {
        const problems = harnessPackageProblems(
            goodPackage('a', {
                guardRegistration: undefined,
                matcherCovers: 1,
                hookPayload: null,
                probes: [],
                setsProjectDirEnv: 'yes',
                skillBarrier: undefined,
                guardInput: 'compat',
                guardLimit: '',
                projectLayers: { homes: [] },
            }).harnessPackage,
            'a',
        );
        expect(problems).toEqual([
            'package.ts: нет функции guardRegistration',
            'package.ts: нет функции matcherCovers',
            'package.ts: нет функции hookPayload',
            'package.ts: нет состава пробы probes',
            'package.ts: setsProjectDirEnv не boolean',
            'package.ts: skillBarrier не boolean',
            'package.ts: guardInput не event и не compat-16b',
            'package.ts: guardLimit не null и не непустая строка',
            'package.ts: projectLayers не null и не объект с функцией homes',
        ]);
    });

    // #197: ключи JSON-поверхности — непустой список непустых строк; пустой список молча
    // означал бы «ни одна JSON-поверхность не слой».
    it('projectLayers.jsonKeys — только непустой список строк', () => {
        const homes = () => [];
        for (const jsonKeys of [[], [''], [1], 'plugin']) {
            expect(
                harnessPackageProblems(
                    goodPackage('a', { projectLayers: { homes, jsonKeys } }).harnessPackage,
                    'a',
                ),
            ).toEqual(['package.ts: projectLayers.jsonKeys не непустой список строк']);
        }
        expect(
            harnessPackageProblems(
                goodPackage('a', { projectLayers: { homes, jsonKeys: ['plugin'] } }).harnessPackage,
                'a',
            ),
        ).toEqual([]);
    });

    // Ревью Фазы 16c: у состава пробы проверялась только непустота. Проба с кодом
    // неисправности засчитала бы сломанный барьер, блокирующий всё.
    it('проба пакета: запрещённое ждёт код правила, разрешённое — без кода', () => {
        const of = (probes: unknown[]) =>
            harnessPackageProblems(goodPackage('a', { probes }).harnessPackage, 'a');
        const probe = { what: 'x', toolName: 'Bash', toolInput: {} };
        expect(of([{ ...probe, expect: 'blocked', reasonCode: 'destructive' }])).toEqual([]);
        expect(of([{ ...probe, expect: 'blocked', reasonCode: 'rule-fault' }])).toEqual([
            'package.ts: probes[0]: код rule-fault — неисправность барьера, а не правило',
        ]);
        expect(of([{ ...probe, expect: 'blocked', reasonCode: 'nope' }])).toEqual([
            'package.ts: probes[0]: код причины не из перечня',
        ]);
        expect(of([{ ...probe, expect: 'allowed', reasonCode: 'destructive' }])).toEqual([
            'package.ts: probes[0]: код причины у разрешённой пробы',
        ]);
        expect(of([null, { ...probe, expect: 'maybe' }])).toEqual([
            'package.ts: probes[0] не объект',
            'package.ts: probes[1]: expect не blocked и не allowed',
        ]);
    });

    // #213: способ пробы — признак пакета; признак без функций плагина пробе нечем исполнить.
    it('plugin — null или объект с source, read и event', () => {
        const of = (plugin: unknown) =>
            harnessPackageProblems(goodPackage('a', { plugin }).harnessPackage, 'a');
        expect(of(undefined)).toEqual(['package.ts: plugin не null и не объект']);
        expect(of({ source: () => '', read: 1 })).toEqual([
            'package.ts: нет функции plugin.read',
            'package.ts: нет функции plugin.event',
        ]);
        expect(of({ source: () => '', read: () => ({}), event: () => ({}) })).toEqual([]);
    });
});

describe('loopDeniedTools — запрет субагентов и отложенного хода флагом (#225)', () => {
    it('Claude Code: инструменты операций agent и defer из описания', () => {
        expect(loopDeniedTools(HARNESS_REGISTRY, 'claude-code')).toEqual([
            'Task',
            'Agent',
            'Workflow',
            'ScheduleWakeup',
            'CronCreate',
        ]);
    });

    it('пакет не принят — бросок с причиной реестра, а не пустой запрет', () => {
        expect(() => loopDeniedTools({ packages: new Map(), problems: new Map() }, 'x')).toThrow(
            /запрет субагентов.*пакета харнесса «x» в реестре нет/,
        );
    });
});

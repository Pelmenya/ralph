import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    HARNESS_DESCRIPTOR_SCHEMA_VERSION,
    harnessDescriptorProblems,
    parseHarnessDescriptor,
} from './descriptor.ts';

const SAMPLE_PATH = path.join(
    import.meta.dirname,
    '..',
    '..',
    'tests',
    '__fixtures__',
    'harness-sample',
    'descriptor.json',
);

/** Свежая копия описания образца: каждая проба портит свою. */
const sample = (): Record<string, any> => JSON.parse(readFileSync(SAMPLE_PATH, 'utf-8'));

const with_ = (patch: (d: Record<string, any>) => void) => {
    const d = sample();
    patch(d);
    return harnessDescriptorProblems(d);
};

describe('описание пакета харнесса: схема', () => {
    it('описание образца принято', () => {
        expect(harnessDescriptorProblems(sample())).toEqual([]);
        expect(parseHarnessDescriptor(sample(), SAMPLE_PATH).harness).toBe('sample');
    });

    it('образец объявляет текущую версию схемы', () => {
        expect(sample().schemaVersion).toBe(HARNESS_DESCRIPTOR_SCHEMA_VERSION);
    });

    it.each(Object.keys(sample()))('без обязательного поля %s — отказ', (field) => {
        const problems = with_((d) => delete d[field]);
        expect(problems).toContain(
            field === 'schemaVersion'
                ? 'schemaVersion: нет версии схемы'
                : `${field}: нет обязательного поля`,
        );
    });

    it.each([2, 0, '1', null])(
        'незнакомая версия схемы %j — отказ, остальное не разбирается',
        (version) => {
            const problems = with_((d) => {
                d.schemaVersion = version;
                delete d.toolMap;
            });
            expect(problems).toEqual([
                `schemaVersion: незнакомая версия ${JSON.stringify(version)} (валидатор знает ${HARNESS_DESCRIPTOR_SCHEMA_VERSION})`,
            ]);
        },
    );

    it('незнакомое поле — отказ: опечатка не должна оставить перечень пустым', () => {
        expect(with_((d) => (d.alowedFields = {}))).toEqual([
            'описание пакета: незнакомое поле alowedFields',
        ]);
    });

    it.each([[null], [[]], ['строка']])('описание %j — не объект', (raw) => {
        expect(harnessDescriptorProblems(raw)).toEqual(['описание пакета: не объект']);
    });

    it('parseHarnessDescriptor бросает со всеми проблемами и источником', () => {
        const d = sample();
        delete d.rules;
        delete d.mcpNames;
        expect(() => parseHarnessDescriptor(d, 'x/descriptor.json')).toThrow(
            /x\/descriptor\.json не по схеме:\n {2}- mcpNames: нет обязательного поля\n {2}- rules: нет/,
        );
    });
});

describe('описание пакета харнесса: поля и перекрёстные ссылки', () => {
    it.each([
        ['harness пуст', (d: any) => (d.harness = ' '), 'harness: не непустая строка'],
        ['cliVersion не строка', (d: any) => (d.cliVersion = 1), 'cliVersion: не непустая строка'],
        [
            'inventorySource пуст',
            (d: any) => (d.inventorySource = ''),
            'inventorySource: не непустая строка',
        ],
        ['normalizer пуст', (d: any) => (d.normalizer = ''), 'normalizer: не непустая строка'],
        [
            'normalizer абсолютный',
            (d: any) => (d.normalizer = '/usr/bin/env'),
            'normalizer: путь обязан лежать внутри каталога пакета',
        ],
        [
            'normalizer выше пакета',
            (d: any) => (d.normalizer = 'bin/../../other/normalize.ts'),
            'normalizer: путь обязан лежать внутри каталога пакета',
        ],
        ['toolMap не объект', (d: any) => (d.toolMap = []), 'toolMap: не объект'],
        [
            'toolMap пуст',
            (d: any) => {
                d.toolMap = {};
                d.argMap = {};
                d.allowedFields.tools = {};
            },
            'toolMap: пустой — пакет не знает ни одного инструмента',
        ],
        [
            'toolMap: операция вне перечня',
            (d: any) => (d.toolMap.Bash = 'shell'),
            'toolMap.Bash: операция "shell" вне exec/read/write/delete/move/search/patch/mcp/fetch/agent/defer/inert',
        ],
        [
            'toolMap: unknown отображением не бывает',
            (d: any) => (d.toolMap.Bash = 'unknown'),
            'toolMap.Bash: операция "unknown" вне exec/read/write/delete/move/search/patch/mcp/fetch/agent/defer/inert',
        ],
        ['allowedFields не объект', (d: any) => (d.allowedFields = 1), 'allowedFields: не объект'],
        [
            'allowedFields: незнакомое поле',
            (d: any) => (d.allowedFields.extra = []),
            'allowedFields: незнакомое поле extra',
        ],
        [
            'конверт пуст',
            (d: any) => (d.allowedFields.envelope = []),
            'allowedFields.envelope: пустой список',
        ],
        [
            'конверт с повтором',
            (d: any) => d.allowedFields.envelope.push('cwd'),
            'allowedFields.envelope: повтор элемента',
        ],
        [
            'конверт: не строка',
            (d: any) => d.allowedFields.envelope.push(5),
            'allowedFields.envelope[5]: не непустая строка',
        ],
        [
            'allowedFields.tools не объект',
            (d: any) => (d.allowedFields.tools = []),
            'allowedFields.tools: не объект',
        ],
        [
            'перечень инструмента, которого нет в toolMap',
            (d: any) => (d.allowedFields.tools.Ghost = ['x']),
            'allowedFields.tools.Ghost: инструмента нет в toolMap',
        ],
        [
            'у инструмента toolMap нет перечня',
            (d: any) => delete d.allowedFields.tools.TodoWrite,
            'allowedFields.tools.TodoWrite: нет перечня полей входа инструмента из toolMap',
        ],
        [
            'перечень инструмента не массив',
            (d: any) => (d.allowedFields.tools.TodoWrite = 'todos'),
            'allowedFields.tools.TodoWrite: не массив',
        ],
        ['argMap не объект', (d: any) => (d.argMap = null), 'argMap: не объект'],
        [
            'argMap: инструмента нет в toolMap',
            (d: any) => (d.argMap.Ghost = {}),
            'argMap.Ghost: инструмента нет в toolMap',
        ],
        [
            'argMap: роли не объект',
            (d: any) => (d.argMap.Bash = 'command'),
            'argMap.Bash: не объект',
        ],
        [
            'argMap: незнакомая роль',
            (d: any) => (d.argMap.Bash.cwd = 'command'),
            'argMap.Bash: незнакомое поле cwd',
        ],
        [
            'argMap: поле вне перечня инструмента',
            (d: any) => (d.argMap.Read.path = 'path'),
            'argMap.Read.path: поля path нет в allowedFields.tools.Read',
        ],
        [
            'argMap: поле не строка',
            (d: any) => (d.argMap.Read.path = 1),
            'argMap.Read.path: не непустая строка',
        ],
        [
            'argMap: роль baseDir — её берёт нормализатор из конверта, а не из входа',
            (d: any) => (d.argMap.Bash.baseDir = 'command'),
            'argMap.Bash: незнакомое поле baseDir',
        ],
        ['probeInputs не объект', (d: any) => (d.probeInputs = []), 'probeInputs: не объект'],
        [
            'probeInputs: инструмента нет в toolMap',
            (d: any) => (d.probeInputs = { Ghost: {} }),
            'probeInputs.Ghost: инструмента нет в toolMap',
        ],
        [
            'probeInputs: вход не объект',
            (d: any) => (d.probeInputs = { Bash: 'x' }),
            'probeInputs.Bash: не объект',
        ],
        [
            'probeInputs: поле вне перечня инструмента',
            (d: any) => (d.probeInputs = { Read: { path: 'x' } }),
            'probeInputs.Read.path: поля нет в allowedFields.tools.Read',
        ],
        ['eventCoverage не объект', (d: any) => (d.eventCoverage = []), 'eventCoverage: не объект'],
        [
            'eventCoverage пуст',
            (d: any) => (d.eventCoverage = {}),
            'eventCoverage: пусто — каналы исполнения не названы',
        ],
        [
            'канал не объект',
            (d: any) => (d.eventCoverage.shell = 'intercepted'),
            'eventCoverage.shell: не объект',
        ],
        [
            'канал: режим вне перечня',
            (d: any) => (d.eventCoverage.shell.mode = 'partial'),
            'eventCoverage.shell.mode: "partial" вне intercepted/disabled',
        ],
        [
            'канал без доказательства',
            (d: any) => delete d.eventCoverage.shell.evidence,
            'eventCoverage.shell.evidence: нет доказательства',
        ],
        [
            'канал: незнакомое поле',
            (d: any) => (d.eventCoverage.shell.note = 'x'),
            'eventCoverage.shell: незнакомое поле note',
        ],
        [
            'configSurfaces не массив',
            (d: any) => (d.configSurfaces = '.x'),
            'configSurfaces: не массив',
        ],
        [
            'forbiddenEnv с пустой строкой',
            (d: any) => d.forbiddenEnv.push(''),
            'forbiddenEnv[1]: не непустая строка',
        ],
        ['rules не массив', (d: any) => (d.rules = {}), 'rules: не массив'],
        ['mcpNames не объект', (d: any) => (d.mcpNames = []), 'mcpNames: не объект'],
        [
            'MCP-имя не объект',
            (d: any) => (d.mcpNames.mcp__fs__read = 'fs/read'),
            'mcpNames.mcp__fs__read: не объект',
        ],
        [
            'MCP-имя без сервера',
            (d: any) => (d.mcpNames.mcp__fs__read.server = ''),
            'mcpNames.mcp__fs__read.server: не непустая строка',
        ],
        [
            'MCP-имя без инструмента',
            (d: any) => delete d.mcpNames.mcp__fs__read.tool,
            'mcpNames.mcp__fs__read.tool: не непустая строка',
        ],
        [
            'MCP-имя: незнакомое поле',
            (d: any) => (d.mcpNames.mcp__fs__read.effect = 'read'),
            'mcpNames.mcp__fs__read: незнакомое поле effect',
        ],
        ['mcpArgs не объект', (d: any) => (d.mcpArgs = []), 'mcpArgs: не объект'],
        [
            'mcpArgs: незнакомое поле',
            (d: any) => (d.mcpArgs.paths = []),
            'mcpArgs: незнакомое поле paths',
        ],
        ['mcpArgs без адресов', (d: any) => delete d.mcpArgs.url, 'mcpArgs.url: не массив'],
        [
            'mcpArgs: пустое имя поля пути',
            (d: any) => d.mcpArgs.path.push(''),
            'mcpArgs.path[1]: не непустая строка',
        ],
        [
            'mcpArgs: поле и путь, и адрес — без регистра',
            (d: any) => d.mcpArgs.url.push('PATH'),
            'mcpArgs: поле PATH и путь, и адрес',
        ],
        [
            'skillEvidence не объект',
            (d: any) => (d.skillEvidence = 'none'),
            'skillEvidence: не объект',
        ],
        [
            'skillEvidence без источника',
            (d: any) => (d.skillEvidence = {}),
            'skillEvidence.source: не непустая строка',
        ],
        [
            'skillEvidence: незнакомое поле',
            (d: any) => (d.skillEvidence.path = 'x'),
            'skillEvidence: незнакомое поле path',
        ],
    ])('%s — отказ', (_name, patch, problem) => {
        expect(with_(patch)).toContain(problem);
    });

    // #199: схема регистрации — признак принятия записи самим CLI.
    describe('registrationSchema', () => {
        const SCHEMA = () => ({
            evidence: 'CLI 1.0, схема секции',
            keys: ['event', 'command', 'timeout'],
            required: ['event', 'command'],
            enums: { event: ['PreToolUse'] },
            intRanges: { timeout: [1, 600] },
        });
        const withSchema = (patch: (r: Record<string, any>) => void) =>
            with_((d) => {
                d.registrationSchema = SCHEMA();
                patch(d.registrationSchema);
            });

        it('null и полная схема — приняты', () => {
            expect(with_((d) => (d.registrationSchema = null))).toEqual([]);
            expect(withSchema(() => {})).toEqual([]);
        });

        it.each([
            [
                'не объект',
                (r: any) => Object.assign(r, { keys: 'x' }),
                'registrationSchema.keys: не массив',
            ],
            ['пустые ключи', (r: any) => (r.keys = []), 'registrationSchema.keys: пустой список'],
            [
                'нет доказательства',
                (r: any) => (r.evidence = ''),
                'registrationSchema.evidence: нет доказательства',
            ],
            [
                'обязательный вне ключей',
                (r: any) => r.required.push('x'),
                'registrationSchema.required: ключа x нет в keys',
            ],
            [
                'перечень вне ключей',
                (r: any) => (r.enums.y = ['a']),
                'registrationSchema.enums.y: ключа y нет в keys',
            ],
            [
                'пустой перечень',
                (r: any) => (r.enums.event = []),
                'registrationSchema.enums.event: пустой список',
            ],
            [
                'перевёрнутый диапазон',
                (r: any) => (r.intRanges.timeout = [5, 1]),
                'registrationSchema.intRanges.timeout: не пара целых [min, max]',
            ],
            [
                'дробный диапазон',
                (r: any) => (r.intRanges.timeout = [1.5, 2]),
                'registrationSchema.intRanges.timeout: не пара целых [min, max]',
            ],
            [
                'незнакомое поле',
                (r: any) => (r.strict = true),
                'registrationSchema: незнакомое поле strict',
            ],
            [
                'нет поля',
                (r: any) => delete r.intRanges,
                'registrationSchema.intRanges: нет обязательного поля',
            ],
        ])('%s — отказ', (_name, patch, problem) => {
            expect(withSchema(patch)).toContain(problem);
        });

        it('не объект и не null — отказ', () => {
            expect(with_((d) => (d.registrationSchema = []))).toContain(
                'registrationSchema: не объект и не null',
            );
        });
    });

    // #199: поверхности конфига, которые guard в сессии петли не даёт писать.
    describe('protectedSurfaces', () => {
        const homeOf = (d: Record<string, any>) => d.protectedSurfaces.homes[0];

        it.each([
            ['не объект', (d: any) => (d.protectedSurfaces = []), 'protectedSurfaces: не объект'],
            [
                'пустой tree',
                (d: any) => (d.protectedSurfaces.tree = []),
                'protectedSurfaces.tree: пустой список',
            ],
            [
                'абсолютный шаблон',
                (d: any) => (d.protectedSurfaces.tree = ['/etc/x']),
                'protectedSurfaces.tree[0]: не относительный шаблон без ..',
            ],
            [
                'выход вверх',
                (d: any) => (d.protectedSurfaces.tree = ['../x']),
                'protectedSurfaces.tree[0]: не относительный шаблон без ..',
            ],
            [
                'незнакомое поле',
                (d: any) => (d.protectedSurfaces.extra = 1),
                'protectedSurfaces: незнакомое поле extra',
            ],
            [
                'homes не массив',
                (d: any) => (d.protectedSurfaces.homes = {}),
                'protectedSurfaces.homes: не массив',
            ],
            [
                'дом не объект',
                (d: any) => (d.protectedSurfaces.homes = ['x']),
                'protectedSurfaces.homes[0]: не объект',
            ],
            [
                'нет поля дома',
                (d: any) => delete homeOf(d).exempt,
                'protectedSurfaces.homes[0].exempt: нет обязательного поля',
            ],
            [
                'env не имя',
                (d: any) => (homeOf(d).env = 'A-B'),
                'protectedSurfaces.homes[0].env: не имя переменной и не null',
            ],
            [
                'sub абсолютный',
                (d: any) => (homeOf(d).sub = '/x'),
                'protectedSurfaces.homes[0].sub: не относительный путь и не пустая строка',
            ],
            [
                'default с ..',
                (d: any) => (homeOf(d).default = '../x'),
                'protectedSurfaces.homes[0].default: не путь от HOME и не null',
            ],
            [
                'дом не находится',
                (d: any) => Object.assign(homeOf(d), { env: null, default: null }),
                'protectedSurfaces.homes[0]: нет ни env, ни default — дом не находится',
            ],
            [
                'исключение с путём',
                (d: any) => (homeOf(d).exempt = ['a/b']),
                'protectedSurfaces.homes[0].exempt[0]: не имя первого уровня',
            ],
            [
                'исключение `..`',
                (d: any) => (homeOf(d).exempt = ['ok', '..']),
                'protectedSurfaces.homes[0].exempt[1]: не имя первого уровня',
            ],
            [
                'исключение `.`',
                (d: any) => (homeOf(d).exempt = ['.']),
                'protectedSurfaces.homes[0].exempt[0]: не имя первого уровня',
            ],
            [
                'absolute не массив',
                (d: any) => (d.protectedSurfaces.absolute = '/etc/x'),
                'protectedSurfaces.absolute: не массив',
            ],
            [
                'absolute относительный',
                (d: any) => (d.protectedSurfaces.absolute = ['etc/x']),
                'protectedSurfaces.absolute[0]: не абсолютный путь без . и ..',
            ],
            [
                // Разбор контекста хуком срезает один слэш: `//etc` там битый, и здесь тоже.
                'absolute с двумя ведущими слэшами',
                (d: any) => (d.protectedSurfaces.absolute = ['//etc/x']),
                'protectedSurfaces.absolute[0]: не абсолютный путь без . и ..',
            ],
            [
                'absolute с ..',
                (d: any) => (d.protectedSurfaces.absolute = ['/etc/../root']),
                'protectedSurfaces.absolute[0]: не абсолютный путь без . и ..',
            ],
            [
                'absolute — корень',
                (d: any) => (d.protectedSurfaces.absolute = ['/']),
                'protectedSurfaces.absolute[0]: не абсолютный путь без . и ..',
            ],
        ])('%s — отказ', (_name, patch, problem) => {
            expect(with_(patch)).toContain(problem);
        });

        it('дом без переменной и дом без default — приняты; homes пустой — тоже', () => {
            expect(
                with_((d) =>
                    d.protectedSurfaces.homes.push(
                        { env: null, sub: '', default: '.x', exempt: [] },
                        { env: 'X_DIR', sub: 'x', default: null, exempt: [] },
                    ),
                ),
            ).toEqual([]);
            expect(with_((d) => (d.protectedSurfaces.homes = []))).toEqual([]);
        });
    });

    it('законно пустые списки принимаются', () => {
        expect(
            with_((d) => {
                d.configSurfaces = [];
                d.forbiddenEnv = [];
                d.rules = [];
                d.mcpNames = {};
                d.mcpArgs = { path: [], url: [] };
            }),
        ).toEqual([]);
    });
});

// Адаптер kimi-native (#120): argv без промпта, полный набор каталогов скиллов, дом CLI с
// барьером, вход до первой сессии и текст ассистента из stream-json. Решения сняты с Kimi
// Code 2.3.2 (докблок модуля); здесь — что каждое из них держится.
import { describe, expect, it } from 'vitest';
import {
    KIMI_HOME_ENV,
    buildKimiNativeArgs,
    kimiNativeAuthProblems,
    kimiNativeConfigProblems,
    kimiNativePromptPointer,
    kimiNativeSkillsDirs,
    kimiSessionConfig,
    kimiSourceHome,
    kimiStreamText,
} from './kimi-native.ts';
import { kimiHooksFromToml } from './harness-guard.ts';

const PROMPT = '/path/to/runtime/kimi-native/prompt/prompt.md';

describe('argv сессии: промпта в нём нет (урок #8)', () => {
    it('промпт любой длины не меняет argv: -p несёт указатель на файл', () => {
        const args = buildKimiNativeArgs({ promptPath: PROMPT, skillsDirs: [] });
        expect(args).toEqual([
            '--output-format',
            'stream-json',
            '--add-dir',
            '/path/to/runtime/kimi-native/prompt',
            '-p',
            kimiNativePromptPointer(PROMPT),
        ]);
        // Каждый элемент argv далёк от MAX_ARG_STRLEN — длина не зависит от задания.
        for (const a of args) expect(Buffer.byteLength(a)).toBeLessThan(1024);
    });

    it('указатель называет файл и требует прочесть его целиком', () => {
        expect(kimiNativePromptPointer(PROMPT)).toContain(PROMPT);
        expect(kimiNativePromptPointer(PROMPT)).toMatch(/ПОЛНОСТЬЮ/);
    });

    it('каждый каталог скиллов — своим --skills-dir, модель — -m перед -p', () => {
        const args = buildKimiNativeArgs({
            promptPath: PROMPT,
            model: 'kimi-code/kimi-for-coding',
            skillsDirs: ['/a/skills', '/b/skills'],
        });
        expect(args.slice(4, 10)).toEqual([
            '--skills-dir',
            '/a/skills',
            '--skills-dir',
            '/b/skills',
            '-m',
            'kimi-code/kimi-for-coding',
        ]);
        expect(args.at(-2)).toBe('-p');
    });
});

describe('--skills-dir заменяет автообнаружение — набор полный', () => {
    const all = (p: string) => !p.includes('missing');

    it('.claude/skills дерева плюс всё, что CLI нашёл бы сам', () => {
        const dirs = kimiNativeSkillsDirs(
            { sessionTree: '/w', kimiHome: '/h/.kimi-code', env: { HOME: '/h' } },
            all,
        );
        expect(dirs).toEqual([
            '/w/.claude/skills',
            '/w/.kimi-code/skills',
            '/w/.agents/skills',
            '/h/.kimi-code/skills',
            '/h/.agents/skills',
        ]);
    });

    it('отсутствующий каталог в список не идёт: CLI молча пропустил бы его', () => {
        const dirs = kimiNativeSkillsDirs(
            { sessionTree: '/w', kimiHome: null, env: {} },
            (p) => p === '/w/.claude/skills',
        );
        expect(dirs).toEqual(['/w/.claude/skills']);
    });

    it('дерева нет — каталогов дерева нет, а не каталог процесса', () => {
        const dirs = kimiNativeSkillsDirs(
            { sessionTree: null, kimiHome: '/h/.kimi-code', env: { HOME: '/h' } },
            all,
        );
        expect(dirs).toEqual(['/h/.kimi-code/skills', '/h/.agents/skills']);
    });
});

describe('дом CLI', () => {
    it('порядок поиска: конфиг, KIMI_CODE_HOME, ~/.kimi-code от HOME; иначе null', () => {
        expect(kimiSourceHome('/cfg', { [KIMI_HOME_ENV]: '/env', HOME: '/h' })).toBe('/cfg');
        expect(kimiSourceHome('  ', { [KIMI_HOME_ENV]: '/env', HOME: '/h' })).toBe('/env');
        expect(kimiSourceHome(undefined, { HOME: '/h' })).toBe('/h/.kimi-code');
        expect(kimiSourceHome(undefined, {})).toBeNull();
    });

    it('config.toml сессии — конфиг человека как есть плюс хуки барьера', () => {
        const human = 'default_model = "m"\n[[hooks]]\nevent = "Stop"\ncommand = "own"';
        const toml = kimiSessionConfig(human, [
            { matcher: 'Bash', command: 'node guard.cjs', timeoutSec: 10 },
        ]);
        expect(toml.startsWith(`${human}\n`)).toBe(true);
        const { hooks, problems } = kimiHooksFromToml(toml);
        expect(problems).toEqual([]);
        expect(hooks).toEqual([{ matcher: 'Bash', command: 'node guard.cjs', timeoutSec: 10 }]);
    });

    it('пустой конфиг человека — только регистрация барьера', () => {
        const toml = kimiSessionConfig('', [{ matcher: '', command: 'g', timeoutSec: 5 }]);
        expect(kimiHooksFromToml(toml).hooks).toHaveLength(1);
    });
});

describe('вход до первой сессии — по дому CLI, без сети', () => {
    const CONFIG = 'default_model = "kimi-code/kimi-for-coding"\n';

    it('модель и ключи на месте — проблем нет', () => {
        expect(kimiNativeAuthProblems({ configToml: CONFIG, credentialFiles: ['k.json'] })).toEqual(
            [],
        );
    });

    it('конфига нет — отказ с советом войти', () => {
        expect(kimiNativeAuthProblems({ configToml: null, credentialFiles: [] })[0]).toMatch(
            /kimi login/,
        );
    });

    it('без модели — «No model configured», модель конфига раннера его снимает', () => {
        const noModel = kimiNativeAuthProblems({ configToml: '', credentialFiles: ['k'] });
        expect(noModel).toHaveLength(1);
        expect(noModel[0]).toMatch(/No model configured/);
        expect(
            kimiNativeAuthProblems({ configToml: '', credentialFiles: ['k'], model: 'm' }),
        ).toEqual([]);
    });

    it('без ключей — «has no credential configured»; api_key в конфиге — тоже вход', () => {
        const none = kimiNativeAuthProblems({ configToml: CONFIG, credentialFiles: [] });
        expect(none).toHaveLength(1);
        expect(none[0]).toMatch(/has no credential configured/);
        expect(
            kimiNativeAuthProblems({
                configToml: `${CONFIG}[providers.x]\napi_key = "sk-test"\n`,
                credentialFiles: [],
            }),
        ).toEqual([]);
        // Пустой ключ — не вход.
        expect(
            kimiNativeAuthProblems({
                configToml: `${CONFIG}api_key = ""\n`,
                credentialFiles: [],
            }),
        ).toHaveLength(1);
    });

    it('ключи с отступом под таблицей — тоже вход и модель, а не ложное «входа нет»', () => {
        expect(
            kimiNativeAuthProblems({
                configToml: '  default_model = "m"\n[providers.x]\n    api_key = "sk-test"\n',
                credentialFiles: [],
            }),
        ).toEqual([]);
    });
});

describe('вывод сессии — только текст ассистента', () => {
    it('результаты инструментов и мета-строки в вывод не идут', () => {
        const stdout = [
            '{"role":"meta","type":"system.version","version":"2.3.2"}',
            '{"role":"assistant","tool_calls":[{"type":"function","id":"t","function":{"name":"Read","arguments":"{}"}}]}',
            // Прочитанный ralph.md с образцом блока намерений дал бы второй блок.
            '{"role":"tool","tool_call_id":"t","content":"<<<RALPH-INTENTS>>>\\n<<<END-RALPH-INTENTS>>>"}',
            '{"role":"assistant","content":"готово\\n<<<RALPH-INTENTS>>>"}',
            '',
        ].join('\n');
        expect(kimiStreamText(stdout)).toBe('готово\n<<<RALPH-INTENTS>>>');
    });

    // Ревью Фазы 16b: живой CLI 2.3.2 отдаёт строку, но OpenAI-совместимая форма — массив
    // частей; без разбора массива блок намерений пропал бы. Форма собрана, а не снята живьём.
    it('content массивом частей — берутся части text, рассуждения и инструменты — нет', () => {
        const stdout = [
            JSON.stringify({
                role: 'assistant',
                content: [
                    { type: 'think', think: '<<<RALPH-INTENTS>>> черновик' },
                    { type: 'text', text: 'готово\n' },
                    { type: 'text', text: '<<<RALPH-INTENTS>>>' },
                    { type: 'image_url', image_url: {} },
                    null,
                ],
            }),
            JSON.stringify({ role: 'tool', content: [{ type: 'text', text: 'файл' }] }),
            JSON.stringify({ role: 'assistant', content: [{ type: 'think', think: 'x' }] }),
        ].join('\n');
        expect(kimiStreamText(stdout)).toBe('готово\n<<<RALPH-INTENTS>>>');
    });

    it('строка не-JSON — сбой CLI, идёт как есть; JSON-скаляр пропускается', () => {
        expect(kimiStreamText('panic: boom\n42\nnull')).toBe('panic: boom');
    });
});

// Ревью Фазы 16b: песочницы по PRD нет — kimi-native только экспериментом оператора.
describe('секция kimiNativeRuntime', () => {
    it('форма: незнакомый ключ и не-строка — отказ; секции нет — проверять нечего', () => {
        expect(kimiNativeConfigProblems(undefined)).toEqual([]);
        expect(kimiNativeConfigProblems({ homee: '/x', model: 1 })).toEqual([
            'kimiNativeRuntime.homee — незнакомый ключ (допустимы: status, model, home)',
            'kimiNativeRuntime.model = 1 — ожидалась непустая строка',
        ]);
    });

    it('достижимый рантайм — статус эксперимента обязателен дословно', () => {
        expect(kimiNativeConfigProblems({ status: 'experimental' }, { required: true })).toEqual(
            [],
        );
        for (const section of [undefined, {}, { status: 'stable' }])
            expect(kimiNativeConfigProblems(section, { required: true })[0]).toMatch(
                /нужен "experimental": песочницы/,
            );
    });
});

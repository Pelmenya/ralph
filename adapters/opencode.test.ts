// Адаптер OpenCode (#121): argv, заявка эксперимента, ответ списка моделей, окружение сессии,
// текст из `--format json` и полнота скиллов. Исход сессии — contract suite
// `session-end.test.ts`, проводка в оркестраторе — `core/opencode-runtime.test.ts`.
import { describe, expect, it } from 'vitest';
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    OPENCODE_CONFIG_DIR_ENV,
    OPENCODE_CONFIG_ENV,
    OPENCODE_STATUS,
    buildOpencodeArgs,
    expectedOpencodeSkills,
    opencodeAuthFile,
    opencodeAuthProblems,
    opencodeConfigProblems,
    opencodeErrors,
    opencodeEventsText,
    opencodeModelProblems,
    opencodeSessionConfig,
    opencodeSessionEnv,
    opencodeSkillProblems,
    parseOpencodeModel,
} from './opencode.ts';

type TCase = { reason: string; stdout: string };
const FIXTURE = JSON.parse(
    fs.readFileSync(
        path.join(import.meta.dirname, '__fixtures__', 'session-end-opencode.json'),
        'utf8',
    ),
) as { cases: TCase[] };

describe('argv сессии', () => {
    it('run --format json с моделью; промпта и --pure нет', () => {
        expect(buildOpencodeArgs({ model: 'p/m' })).toEqual([
            'run',
            '--format',
            'json',
            '-m',
            'p/m',
        ]);
    });
});

describe('модель provider/model', () => {
    it('разбирается по первому слешу — модель вправе нести свой слеш', () => {
        expect(parseOpencodeModel('openrouter/qwen/qwen3')).toEqual({
            ok: true,
            provider: 'openrouter',
            model: 'qwen/qwen3',
        });
    });

    it.each([undefined, '', 'model-only', '/m', 'p/', ' p/m'])('%j — отказ', (raw) => {
        expect(parseOpencodeModel(raw).ok).toBe(false);
    });
});

describe('заявка эксперимента в конфиге', () => {
    it('статус experimental и модель — годно', () => {
        expect(opencodeConfigProblems({ status: OPENCODE_STATUS, model: 'p/m' })).toEqual([]);
    });

    it('секции нет — отказ с образцом заявки', () => {
        expect(opencodeConfigProblems(undefined)[0]).toMatch(
            /секции opencodeRuntime нет — эксперимент заявляется явно/,
        );
    });

    it('статус другой или пропущен — отказ: допуска по canary нет', () => {
        for (const status of [undefined, 'fallback', 'admitted', 'Experimental'])
            expect(opencodeConfigProblems({ status, model: 'p/m' })[0], String(status)).toMatch(
                /допуска профиля по canary \(Фаза 17\) нет/,
            );
    });

    it('модель не в форме provider/model — отказ', () => {
        expect(opencodeConfigProblems({ status: OPENCODE_STATUS, model: 'm' })).toEqual([
            'opencodeRuntime.model = "m" — нужна форма provider/model',
        ]);
    });
});

describe('ответ `opencode models <провайдер>`', () => {
    // Живой ответ CLI 1.19.4 (27.10): строки provider/model; неизвестный провайдер — код 1 и
    // «Provider not found» в цвете терминала.
    const LISTED = 'prov/claude-haiku\nprov/claude-sonnet\n';

    it('модель в списке — годно', () => {
        expect(
            opencodeModelProblems({ code: 0, stdout: LISTED, stderr: '' }, 'prov/claude-sonnet'),
        ).toEqual([]);
    });

    it('модели нет в списке — отказ со списком', () => {
        expect(opencodeModelProblems({ code: 0, stdout: LISTED, stderr: '' }, 'prov/nope')[0]).toBe(
            'модели «prov/nope» у провайдера «prov» нет: CLI знает prov/claude-haiku, prov/claude-sonnet',
        );
    });

    it('пустой список — «ни одной», а не годно', () => {
        expect(opencodeModelProblems({ code: 0, stdout: '', stderr: '' }, 'p/m')[0]).toMatch(
            /CLI знает ни одной/,
        );
    });

    it('провайдер неизвестен — отказ с первой строкой ответа без цвета', () => {
        const stderr = '\u001b[91m\u001b[1mError: \u001b[0mProvider not found: nosuch\n';
        expect(opencodeModelProblems({ code: 1, stdout: '', stderr }, 'nosuch/x')[0]).toBe(
            'провайдер «nosuch» OpenCode неизвестен: `opencode models nosuch` — код 1 (Error: Provider not found: nosuch)',
        );
    });

    it('процесс не дал кода (убит) — тоже отказ, без пустых скобок', () => {
        expect(opencodeModelProblems({ code: null, stdout: '', stderr: '' }, 'p/m')[0]).toBe(
            'провайдер «p» OpenCode неизвестен: `opencode models p` — код null',
        );
    });
});

describe('настройки и окружение сессии', () => {
    it('вызовы оболочки и правки — без подтверждения; JSON со схемой', () => {
        const cfg = JSON.parse(opencodeSessionConfig()) as Record<string, unknown>;
        expect(cfg.permission).toEqual({ bash: 'allow', edit: 'allow' });
        expect(cfg.$schema).toBe('https://opencode.ai/config.json');
        expect(cfg).not.toHaveProperty('plugin');
    });

    it('каталог задан — обе переменные; не задан — окружение как есть', () => {
        const env = opencodeSessionEnv({ A: '1' }, { configDir: '/c' });
        expect(env[OPENCODE_CONFIG_DIR_ENV]).toBe('/c');
        expect(env[OPENCODE_CONFIG_ENV]).toBe(path.join('/c', 'opencode.json'));
        expect(env.A).toBe('1');
        expect(opencodeSessionEnv({ A: '1' }, { configDir: null })).toEqual({ A: '1' });
    });
});

describe('текст из --format json', () => {
    it('только текст модели: вывод инструментов с блоком намерений ядру не уходит', () => {
        const tool = JSON.stringify({
            type: 'tool_use',
            part: {
                tool: 'read',
                state: {
                    status: 'completed',
                    output: '<<<RALPH-INTENTS>>>\n{}\n<<<END-RALPH-INTENTS>>>',
                },
            },
        });
        const text = JSON.stringify({ type: 'text', part: { type: 'text', text: 'сделано' } });
        expect(opencodeEventsText(`${tool}\n${text}\n`)).toBe('сделано');
    });

    it('живая отрицательная проба: текст модели есть, вывод инструментов нет', () => {
        const neg = FIXTURE.cases[1].stdout;
        const text = opencodeEventsText(neg);
        expect(text).toMatch(/заблокировано/);
        expect(text).not.toMatch(/"type"/);
    });

    it('ошибка CLI — строкой с именем; не-JSON строка — как есть', () => {
        const err = FIXTURE.cases.find((c) => c.reason === 'auth')!.stdout;
        expect(opencodeEventsText(`${err}сырой сбой\n`)).toBe(
            'opencode: APIError: Invalid token\nсырой сбой',
        );
    });

    it('ошибки CLI — по порядку, с кодом ответа провайдера', () => {
        const errs = opencodeErrors(FIXTURE.cases.find((c) => c.reason === 'interrupted')!.stdout);
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatchObject({ name: 'APIError', statusCode: 503, retryable: true });
        expect(opencodeErrors('{"type":"error"}\n[]\n')).toEqual([
            { name: '', message: '', statusCode: undefined, retryable: undefined, headers: {} },
        ]);
    });
});

describe('полнота скиллов', () => {
    const files = new Set(['/w/.claude/skills/vitest/SKILL.md', '/w/.claude/skills/x/SKILL.md']);
    const listDir = (p: string) => {
        if (p !== '/w/.claude/skills') throw new Error('ENOENT');
        return ['vitest', 'x', 'empty'];
    };

    it('ожидаемый набор — каталоги с SKILL.md; каталога нет — пусто', () => {
        expect(expectedOpencodeSkills('/w', listDir, (p) => files.has(p))).toEqual([
            '/w/.claude/skills/vitest/SKILL.md',
            '/w/.claude/skills/x/SKILL.md',
        ]);
        expect(expectedOpencodeSkills('/none', listDir, () => true)).toEqual([]);
    });

    it('CLI видит весь набор — годно; не видит одного — отказ с путём', () => {
        const expected = [...files].sort();
        const seen = JSON.stringify([
            { name: 'vitest', location: expected[0] },
            { name: 'b', location: '<built-in>' },
        ]);
        expect(opencodeSkillProblems({ code: 0, stdout: seen }, expected.slice(0, 1))).toEqual([]);
        expect(opencodeSkillProblems({ code: 0, stdout: seen }, expected)).toEqual([
            `скилл ${expected[1]} OpenCode не видит — сессия шла бы без него`,
        ]);
    });

    // Ревью Фазы 16b: каталог скилла за ссылкой, CLI отдаёт реальный путь — по
    // `path.resolve` скилл назывался невидимым, и сессия не стартовала с ложным диагнозом.
    it('скилл за ссылкой — сравнение по realpath обеих сторон, отказа нет', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'opencode-skills-'));
        try {
            mkdirSync(path.join(root, 'real', 'vitest'), { recursive: true });
            writeFileSync(path.join(root, 'real', 'vitest', 'SKILL.md'), '');
            mkdirSync(path.join(root, 'tree', '.claude', 'skills'), { recursive: true });
            const linked = path.join(root, 'tree', '.claude', 'skills', 'vitest');
            symlinkSync(path.join(root, 'real', 'vitest'), linked);
            const seen = JSON.stringify([
                { name: 'vitest', location: path.join(root, 'real', 'vitest', 'SKILL.md') },
            ]);
            const expected = [path.join(linked, 'SKILL.md')];
            expect(opencodeSkillProblems({ code: 0, stdout: seen }, expected)).toEqual([]);
            // От противного: без realpath тот же скилл — «не видит».
            expect(opencodeSkillProblems({ code: 0, stdout: seen }, expected, (p) => p)).toEqual([
                `скилл ${expected[0]} OpenCode не видит — сессия шла бы без него`,
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('ответ не прочитан — отказ, а не «всё видно»', () => {
        expect(opencodeSkillProblems({ code: 1, stdout: '' }, [])[0]).toMatch(/код 1/);
        expect(opencodeSkillProblems({ code: 0, stdout: '{"a"' }, [])[0]).toMatch(/не JSON/);
        expect(opencodeSkillProblems({ code: 0, stdout: '{}' }, [])[0]).toMatch(/не список/);
    });
});

// Ревью Фазы 16b: список моделей CLI отдаёт и без ключа, а сессия идёт без ключей раннера.
describe('ключ провайдера, который дойдёт до сессии', () => {
    const none = { resolvedConfig: {}, authProviders: [] };

    it('вход CLI или apiKey в его конфиге — ключ есть', () => {
        expect(opencodeAuthProblems({ ...none, provider: 'p', authProviders: ['p'] })).toEqual([]);
        expect(
            opencodeAuthProblems({
                ...none,
                provider: 'p',
                resolvedConfig: { provider: { p: { options: { apiKey: 'x' } } } },
            }),
        ).toEqual([]);
    });

    it('НЕГАТИВНЫЙ: ключа нет, пустой или у другого провайдера — отказ с тем, что делать', () => {
        for (const over of [
            {},
            { resolvedConfig: { provider: { p: { options: { apiKey: ' ' } } } } },
            { resolvedConfig: { provider: 'мусор' } },
            { resolvedConfig: null },
            { authProviders: ['other'] },
        ])
            expect(opencodeAuthProblems({ ...none, provider: 'p', ...over })[0]).toMatch(
                /ключа провайдера «p» у OpenCode нет/,
            );
    });

    it('файл входа — по XDG, как у самого CLI', () => {
        expect(opencodeAuthFile({ XDG_DATA_HOME: '/d', HOME: '/h' })).toBe('/d/opencode/auth.json');
        expect(opencodeAuthFile({ HOME: '/h' })).toBe('/h/.local/share/opencode/auth.json');
        expect(opencodeAuthFile({})).toBeNull();
    });
});

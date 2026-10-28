// Сборщик конфига OpenCode (#197): окружение сессии, настройки и сверка изоляции перед спавном.
// Каналы сняты с исходника OpenCode 1.19.4 (докблок модуля); проводка в оркестраторе —
// `core/opencode-runtime.test.ts`, сборка каталога — `core/session-settings.test.ts`.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
    OPENCODE_CONFIG_DIR_ENV,
    OPENCODE_CONFIG_ENV,
    OPENCODE_DISABLE_AUTOUPDATE_ENV,
    OPENCODE_DISABLE_PROJECT_CONFIG_ENV,
    XDG_CONFIG_HOME_ENV,
    opencodeHomeLayers,
    opencodeHumanXdg,
    opencodeIsolationProblems,
    opencodeSessionConfig,
    opencodeSessionEnv,
    opencodeSessionXdg,
} from './opencode-home.ts';
import { HARNESS_REGISTRY } from './harness-registry.ts';

const FORBIDDEN = ['OPENCODE_PURE', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'];
const configDir = '/r/opencode/config';
const none = () => false;

describe('opencodeSessionEnv — окружение без настройки CLI раннера', () => {
    it('каталог задан — свои файл, каталог и глобальный конфиг; выключатели стоят', () => {
        const env = opencodeSessionEnv({ A: '1' }, { configDir });
        expect(env).toEqual({
            A: '1',
            [OPENCODE_CONFIG_DIR_ENV]: configDir,
            [OPENCODE_CONFIG_ENV]: path.join(configDir, 'opencode.json'),
            [XDG_CONFIG_HOME_ENV]: path.join('/r/opencode', 'xdg-config'),
            [OPENCODE_DISABLE_PROJECT_CONFIG_ENV]: '1',
            [OPENCODE_DISABLE_AUTOUPDATE_ENV]: '1',
        });
    });

    // Стенд #197: каталог сессии CLI берёт из `PWD`, а `chdir` раннера его не меняет.
    it('дерево задано — PWD ему, а не каталогу запуска раннера', () => {
        expect(opencodeSessionEnv({ PWD: '/launch' }, { configDir, cwd: '/work' }).PWD).toBe(
            '/work',
        );
        expect(opencodeSessionEnv({ PWD: '/launch' }, { configDir }).PWD).toBe('/launch');
    });

    it('каталога нет — переменных каталога нет, выключатели всё равно стоят', () => {
        expect(opencodeSessionEnv({ A: '1' }, { configDir: null })).toEqual({
            A: '1',
            [OPENCODE_DISABLE_PROJECT_CONFIG_ENV]: '1',
            [OPENCODE_DISABLE_AUTOUPDATE_ENV]: '1',
        });
    });

    it('OPENCODE_PURE и всё OPENCODE_* раннера сняты; выключатели — свои значения', () => {
        const env = opencodeSessionEnv(
            {
                OPENCODE_PURE: '1',
                OPENCODE_CONFIG_CONTENT: '{"plugin":["x"]}',
                OPENCODE_PERMISSION: '{}',
                OPENCODE_AUTH_CONTENT: '{}',
                OPENCODE: '1',
                [OPENCODE_DISABLE_PROJECT_CONFIG_ENV]: '0',
                [OPENCODE_CONFIG_DIR_ENV]: '/h/.config/opencode',
                OPENCODEX: 'чужое имя без префикса',
            },
            { configDir },
        );
        expect(
            Object.keys(env)
                .filter((n) => n.startsWith('OPENCODE_'))
                .sort(),
        ).toEqual(
            [
                OPENCODE_CONFIG_DIR_ENV,
                OPENCODE_CONFIG_ENV,
                OPENCODE_DISABLE_AUTOUPDATE_ENV,
                OPENCODE_DISABLE_PROJECT_CONFIG_ENV,
            ].sort(),
        );
        expect(env.OPENCODE).toBeUndefined();
        expect(env.OPENCODEX).toBe('чужое имя без префикса');
        expect(env[OPENCODE_DISABLE_PROJECT_CONFIG_ENV]).toBe('1');
        expect(env[OPENCODE_CONFIG_DIR_ENV]).toBe(configDir);
    });
});

describe('opencodeSessionConfig — настройки сессии', () => {
    it('без подтверждений, правила абсолютными путями, пустой MCP, без плагинов', () => {
        const cfg = JSON.parse(opencodeSessionConfig({ instructions: ['/t/AGENTS.md'] })) as Record<
            string,
            unknown
        >;
        expect(cfg).toEqual({
            $schema: 'https://opencode.ai/config.json',
            permission: { bash: 'allow', edit: 'allow' },
            instructions: ['/t/AGENTS.md'],
            mcp: {},
            autoupdate: false,
        });
    });
});

describe('глобальный каталог человека и слои дома', () => {
    it('XDG_CONFIG_HOME, иначе ~/.config, иначе не известен', () => {
        expect(opencodeHumanXdg({ XDG_CONFIG_HOME: '/x', HOME: '/h' })).toBe('/x');
        expect(opencodeHumanXdg({ HOME: '/h' })).toBe(path.join('/h', '.config'));
        expect(opencodeHumanXdg({})).toBeNull();
    });

    it('слои ~/.opencode — только лежащие на месте', () => {
        const present = new Set([path.join('/h', '.opencode', 'plugin')]);
        expect(opencodeHomeLayers('/h', (p) => present.has(p))).toEqual([
            path.join('/h', '.opencode', 'plugin'),
        ]);
    });
});

describe('opencodeIsolationProblems — сверка того, что уйдёт в CLI', () => {
    const clean = (base: NodeJS.ProcessEnv = { HOME: '/h' }) => ({
        env: opencodeSessionEnv(base, { configDir }),
        configDir,
        humanXdg: '/h/.config',
        forbiddenEnv: FORBIDDEN,
        existsFn: none,
    });

    it('собранное сборщиком проходит — и при OPENCODE_PURE=1 у раннера', () => {
        expect(opencodeIsolationProblems(clean())).toEqual([]);
        expect(opencodeIsolationProblems(clean({ HOME: '/h', OPENCODE_PURE: '1' }))).toEqual([]);
    });

    it('OPENCODE_PURE, доехавший до сессии, — отказ по имени', () => {
        const c = clean();
        c.env.OPENCODE_PURE = '1';
        expect(opencodeIsolationProblems(c)).toEqual([
            'OPENCODE_PURE в окружении сессии снимает барьер',
        ]);
    });

    it('прочее OPENCODE_* раннера — отказ «не вычищено»', () => {
        const c = clean();
        c.env.OPENCODE_AUTH_CONTENT = '{}';
        expect(opencodeIsolationProblems(c)).toEqual([
            'окружение CLI раннера не вычищено: OPENCODE_AUTH_CONTENT',
        ]);
    });

    it('каталог, файл, глобальный конфиг и выключатели — каждый назван', () => {
        const problems = opencodeIsolationProblems({
            ...clean(),
            env: { HOME: '/h' },
        });
        expect(problems).toHaveLength(5);
        expect(problems.join('\n')).toMatch(/OPENCODE_CONFIG_DIR/);
        expect(problems.join('\n')).toMatch(/OPENCODE_CONFIG сессии/);
        expect(problems.join('\n')).toMatch(/XDG_CONFIG_HOME сессии — не каталог раннера/);
        expect(problems.join('\n')).toMatch(/OPENCODE_DISABLE_PROJECT_CONFIG не «1»/);
        expect(problems.join('\n')).toMatch(/OPENCODE_DISABLE_AUTOUPDATE не «1»/);
    });

    it('PWD не дерево сессии — отказ с обоими путями', () => {
        const c = clean({ HOME: '/h', PWD: '/launch' });
        expect(opencodeIsolationProblems({ ...c, cwd: '/work' })).toEqual([
            'PWD сессии (/launch) — не дерево сессии (/work): каталог сессии CLI берёт из него',
        ]);
        const built = opencodeSessionEnv(
            { HOME: '/h', PWD: '/launch' },
            { configDir, cwd: '/work' },
        );
        expect(opencodeIsolationProblems({ ...c, env: built, cwd: '/work' })).toEqual([]);
    });

    it('глобальный каталог сессии совпал с человеческим — отказ', () => {
        expect(
            opencodeIsolationProblems({ ...clean(), humanXdg: opencodeSessionXdg(configDir) }),
        ).toEqual([
            `XDG_CONFIG_HOME сессии совпал с каталогом конфига человека (${opencodeSessionXdg(configDir)})`,
        ]);
    });

    it('исполняемый слой в ~/.opencode — отказ с адресом, дом не правится', () => {
        const plugin = path.join('/h', '.opencode', 'plugin');
        const [problem] = opencodeIsolationProblems({
            ...clean(),
            existsFn: (p) => p === plugin,
        });
        expect(problem).toMatch(/исполняемые слои в \/h\/\.opencode \(plugin\)/);
    });
});

describe('описание пакета OpenCode — перечень, снимающий барьер', () => {
    it('forbiddenEnv называет OPENCODE_PURE и вливание конфига', () => {
        expect(HARNESS_REGISTRY.packages.get('opencode')?.descriptor.forbiddenEnv).toEqual(
            FORBIDDEN,
        );
    });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_ALLOWLIST_PATH,
    normalizeAllowlist,
    loadGateEnvAllowlist,
    isAllowed,
    sanitizeEnv,
    buildSanitizedGateEnv,
} from './gate-env.mts';

// #188: allowlist-санация env чеков гейта. Тесты гоняют чистые функции на ФИКСТУРАХ
// (фейковый env, инжектированный readFileFn) — настоящие process.env/файлы не читаются,
// поэтому в гейте зелёные и секрет не утаскивают.

// Ошибка чтения с кодом — как её бросает fs.readFileSync (ENOENT/EACCES).
function fsError(code: string): NodeJS.ErrnoException {
    const e: NodeJS.ErrnoException = new Error(`${code}: fake`);
    e.code = code;
    return e;
}

const SIMPLE = { exact: ['PATH', 'HOME'], prefixes: ['LC_'] };

describe('normalizeAllowlist — валидация формы (#188)', () => {
    it('превращает массивы в { exact:Set, prefixes:[] }', () => {
        const a = normalizeAllowlist(SIMPLE);
        expect(a.exact.has('PATH')).toBe(true);
        expect(a.exact.has('HOME')).toBe(true);
        expect(a.prefixes).toEqual(['LC_']);
    });

    it('игнорирует необязательные поля (note)', () => {
        const a = normalizeAllowlist({ note: 'зачем', exact: ['PATH'], prefixes: [] });
        expect(a.exact.has('PATH')).toBe(true);
        expect(a.prefixes).toEqual([]);
    });

    it('fail-closed: не объект', () => {
        expect(() => normalizeAllowlist(null)).toThrow();
        expect(() => normalizeAllowlist([])).toThrow();
        expect(() => normalizeAllowlist('строка')).toThrow();
    });

    it('fail-closed: exact/prefixes не массивы', () => {
        expect(() => normalizeAllowlist({ exact: 'PATH', prefixes: [] })).toThrow();
        expect(() => normalizeAllowlist({ exact: [], prefixes: {} })).toThrow();
    });

    it('fail-closed: пустые/нестроковые записи', () => {
        expect(() => normalizeAllowlist({ exact: [''], prefixes: [] })).toThrow();
        expect(() => normalizeAllowlist({ exact: [123], prefixes: [] })).toThrow();
        expect(() => normalizeAllowlist({ exact: [], prefixes: [null] })).toThrow();
    });

    // #247: форма { exact: [], prefixes: [] } валидна по типам, но это ровно «пустой список»,
    // который отрезал бы PATH/HOME и покрасил бы гейт инфраструктурной ошибкой. Усечённый/
    // обнулённый файл должен давать тот же честный стоп, что и битый JSON.
    it('fail-closed: пустой exact (усечённый файл) отвергается', () => {
        expect(() => normalizeAllowlist({ exact: [], prefixes: [] })).toThrow(/пуст/i);
        expect(() => normalizeAllowlist({ exact: [], prefixes: ['LC_'] })).toThrow(/пуст/i);
    });
});

describe('isAllowed — точное имя и префикс (#188)', () => {
    const a = normalizeAllowlist(SIMPLE);

    it('пропускает точное совпадение', () => {
        expect(isAllowed('PATH', a)).toBe(true);
        expect(isAllowed('HOME', a)).toBe(true);
    });

    it('пропускает совпадение по префиксу', () => {
        expect(isAllowed('LC_ALL', a)).toBe(true);
        expect(isAllowed('LC_CTYPE', a)).toBe(true);
    });

    it('НЕ пропускает то, чего нет в allowlist', () => {
        expect(isAllowed('GH_TOKEN', a)).toBe(false);
        expect(isAllowed('RANDOM_NEW_VAR', a)).toBe(false);
    });

    it('точное совпадение чувствительно к регистру и не срабатывает на подстроке', () => {
        expect(isAllowed('path', a)).toBe(false);
        expect(isAllowed('MYPATH', a)).toBe(false);
    });
});

describe('sanitizeEnv — allowlist, а не blocklist (#188)', () => {
    const a = normalizeAllowlist({
        exact: ['PATH', 'HOME', 'CI'],
        prefixes: ['LC_'],
    });

    it('оставляет разрешённые, выкидывает всё прочее', () => {
        const out = sanitizeEnv(
            { PATH: '/usr/bin', HOME: '/root', LC_ALL: 'C', GH_TOKEN: 'ghp_x', FOO: 'bar' },
            a,
        );
        expect(out.PATH).toBe('/usr/bin');
        expect(out.HOME).toBe('/root');
        expect(out.LC_ALL).toBe('C');
        expect('GH_TOKEN' in out).toBe(false);
        expect('FOO' in out).toBe(false);
    });

    // Ключевой критерий готовности #188: НОВАЯ переменная в env, которой нет в allowlist,
    // до чеков не доходит — по умолчанию отсекается, а не молча наследуется.
    it('новая переменная без записи в allowlist отсекается по умолчанию', () => {
        const out = sanitizeEnv({ PATH: '/usr/bin', TOTALLY_NEW_SECRET: 'leak' }, a);
        expect('TOTALLY_NEW_SECRET' in out).toBe(false);
        expect(out.PATH).toBe('/usr/bin');
    });

    it('не мутирует исходный env', () => {
        const src = { PATH: '/usr/bin', GH_TOKEN: 'ghp_x' };
        sanitizeEnv(src, a);
        expect(src.GH_TOKEN).toBe('ghp_x');
    });

    it('не отравляется own-ключом __proto__ во входном env', () => {
        // Own-ключ __proto__ появляется только через JSON.parse: в объектном литерале
        // `__proto__: {...}` — спец-синтаксис, задающий ПРОТОТИП, own-ключа бы не было и
        // ветка UNSAFE_ENV_KEYS не исполнялась бы (#247). Так guard реально гоняется.
        const env = JSON.parse('{"PATH":"/usr/bin","__proto__":{"polluted":true}}');
        const out = sanitizeEnv(env, a);
        expect(out.PATH).toBe('/usr/bin');
        expect('__proto__' in out).toBe(false);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe('loadGateEnvAllowlist — загрузка из файла (#188)', () => {
    it('парсит и нормализует валидный JSON', () => {
        const readFileFn = () => JSON.stringify(SIMPLE);
        const a = loadGateEnvAllowlist('/fake/path.json', readFileFn);
        expect(a.exact.has('PATH')).toBe(true);
        expect(a.prefixes).toEqual(['LC_']);
    });

    it('fail-closed: файл не читается', () => {
        const readFileFn = () => {
            throw fsError('ENOENT');
        };
        expect(() => loadGateEnvAllowlist('/nope.json', readFileFn)).toThrow(/не читается/);
    });

    it('fail-closed: не валидный JSON', () => {
        const readFileFn = () => '{ битый';
        expect(() => loadGateEnvAllowlist('/broken.json', readFileFn)).toThrow(/не парсится/);
    });
});

describe('buildSanitizedGateEnv — обёртка загрузка+санация (#188)', () => {
    it('загружает allowlist и санирует переданный env', () => {
        const readFileFn = () => JSON.stringify({ exact: ['PATH'], prefixes: [] });
        const out = buildSanitizedGateEnv({
            env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_x' },
            allowlistPath: '/fake.json',
            readFileFn,
        });
        expect(out.PATH).toBe('/usr/bin');
        expect('GH_TOKEN' in out).toBe(false);
    });
});

// #403: провенанс — DEFAULT_ALLOWLIST_PATH обязан указывать на каталог МОДУЛЯ
// (import.meta.dirname), а не на cwd. Это свойство держит барьер #209: код проверяемого
// PR не подменит список санации своего же гейта, потому что раннер читает его из
// launch-дерева, а не из детаченного worktree. Барьер, а не только ручная проверка:
// «упрощение» до process.cwd()/пути от конфига сразу покраснит этот тест.
describe('провенанс DEFAULT_ALLOWLIST_PATH — от каталога модуля, не от cwd (#403)', () => {
    // Тест лежит РЯДОМ с gate-env.mts (оба в .claude/ralph/), поэтому каталог теста и есть
    // каталог модуля. Ждём ТОЧНОГО равенства — только оно ловит регрессию вида
    // path.join(process.cwd(), '.claude/ralph/gate-env-allowlist.json'): она прошла бы обе
    // мягкие проверки (endsWith / «не cwd+имя файла»), т.к. под vitest cwd — корень репо и
    // путь от cwd совпал бы с путём от каталога модуля. Но во время гейта cwd — worktree на
    // PR-голове, и allowlist читался бы из кода проверяемого PR (провенанс #209 сломан).
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const EXPECTED = path.join(HERE, 'gate-env-allowlist.json');

    it('точное равенство с путём от каталога самого модуля', () => {
        expect(path.isAbsolute(DEFAULT_ALLOWLIST_PATH)).toBe(true);
        expect(DEFAULT_ALLOWLIST_PATH).toBe(EXPECTED);
    });

    it('не зависит от cwd: не строится от process.cwd()', () => {
        // Дополнительная явная проверка «не от cwd»: даже наивную форму cwd+имя файла
        // (когда корень репо совпал бы с каталогом модуля лишь случайно) точное равенство
        // выше уже отсекает, но оставляем как читаемую формулировку инварианта.
        expect(DEFAULT_ALLOWLIST_PATH).not.toBe(path.join(process.cwd(), 'gate-env-allowlist.json'));
        expect(path.dirname(DEFAULT_ALLOWLIST_PATH).endsWith(path.join('.claude', 'ralph'))).toBe(true);
    });
});

// Реальный файл allowlist репозитория — источник санации в проде: если он битый или
// отрезает то, без чего чеки не запустятся (PATH/HOME), гейт краснел бы инфраструктурой.
describe('gate-env-allowlist.json репозитория (#188)', () => {
    it('парсится, содержит базовые переменные окружения чеков', () => {
        const a = loadGateEnvAllowlist(DEFAULT_ALLOWLIST_PATH, fs.readFileSync);
        expect(a.exact.has('PATH')).toBe(true);
        expect(a.exact.has('HOME')).toBe(true);
    });

    // #191: толстые prod-чеки не должны молча сломаться от санации. CI переключает
    // playwright.config.ts в гейт-режим (forbidOnly/reuseExistingServer=false/свой порт);
    // PLAYWRIGHT_BROWSERS_PATH — явный путь к кэшу браузеров, если он задан на машине
    // раннера (дефолтный ~/.cache/ms-playwright и так доступен через HOME). Регрессия
    // барьером, а не только ручной проверкой: пропажа любой из двух вернула бы «e2e не
    // видит кэш браузеров» или «playwright лезет на чужой уже занятый dev-порт» молча
    // на следующем прогоне прод-гейта.
    it('содержит переменные, нужные толстому e2e-чеку (#191)', () => {
        const a = loadGateEnvAllowlist(DEFAULT_ALLOWLIST_PATH, fs.readFileSync);
        expect(a.exact.has('CI')).toBe(true);
        expect(a.exact.has('PLAYWRIGHT_BROWSERS_PATH')).toBe(true);
    });

    // Список — именно allowlist: секретов петли в нём нет, значит санация их отрежет.
    it('НЕ содержит секретов петли', () => {
        const a = loadGateEnvAllowlist(DEFAULT_ALLOWLIST_PATH, fs.readFileSync);
        for (const secret of [
            'GH_TOKEN',
            'GITHUB_TOKEN',
            'CLAUDE_CODE_OAUTH_TOKEN',
            'ANTHROPIC_API_KEY',
            'RALPH_TG_BOT_TOKEN',
            'TG_BOT_TOKEN',
        ]) {
            expect(isAllowed(secret, a)).toBe(false);
        }
    });
});

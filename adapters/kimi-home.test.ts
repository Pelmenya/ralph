// Сборщик конфига Kimi Code (#196): окружение сессии и сверка изоляции перед спавном. Каналы
// сняты с исходника Kimi Code 2.3.2 (докблок модуля), живьём — стенд (`harnesses/kimi-code/
// stand-fixtures.test.ts`, раздел `sessionHome` фикстуры).
import { describe, expect, it } from 'vitest';
import {
    KIMI_NO_AUTO_UPDATE_ENV,
    KIMI_TRUST_ENV,
    kimiIsolationProblems,
    kimiSessionEnv,
    kimiTrustEntries,
} from './kimi-home.ts';
import { KIMI_HOME_ENV, KIMI_MAX_STEPS_ENV } from './kimi-native.ts';

const enoent = (): never => {
    throw Object.assign(new Error('ENOENT: нет каталога'), { code: 'ENOENT' });
};

describe('kimiSessionEnv — окружение сессии без настройки CLI человека', () => {
    it('свой дом, автообновление выключено, потолок шагов; прочее окружение — как было', () => {
        const env = kimiSessionEnv({ PATH: '/bin' }, { home: '/r/home', maxTurns: 40.7 });
        expect(env).toEqual({
            PATH: '/bin',
            [KIMI_HOME_ENV]: '/r/home',
            [KIMI_NO_AUTO_UPDATE_ENV]: '1',
            [KIMI_MAX_STEPS_ENV]: '40',
        });
        expect(kimiSessionEnv({}, { home: null })).toEqual({ [KIMI_NO_AUTO_UPDATE_ENV]: '1' });
    });

    it('доверие каталогу, дом и окружение CLI раннера вычищены; выключатель — свой', () => {
        const env = kimiSessionEnv(
            {
                [KIMI_TRUST_ENV]: '1',
                [KIMI_HOME_ENV]: '/h/.kimi-code',
                [KIMI_NO_AUTO_UPDATE_ENV]: '0',
                KIMI_CODE_BASE_URL: 'https://example.com',
                KIMI_CLI_NO_AUTO_UPDATE: '0',
                KIMI_OAUTH_HOST: 'https://example.com',
                KIMI_API_KEY_OTHER: 'x',
            },
            { home: '/r/home' },
        );
        expect(env).toEqual({
            [KIMI_HOME_ENV]: '/r/home',
            [KIMI_NO_AUTO_UPDATE_ENV]: '1',
            KIMI_API_KEY_OTHER: 'x',
        });
    });
});

describe('kimiIsolationProblems — сверка того, что уйдёт в CLI', () => {
    const home = '/r/home';
    const clean = () => ({
        env: kimiSessionEnv({ PATH: '/bin' }, { home }),
        home,
        humanHome: '/h/.kimi-code',
        listDirFn: enoent,
    });

    it('собранное сборщиком проходит; пустой каталог доверия — тоже', () => {
        expect(kimiIsolationProblems(clean())).toEqual([]);
        expect(kimiIsolationProblems({ ...clean(), listDirFn: () => [] })).toEqual([]);
    });

    it('НЕГАТИВНЫЙ: запись доверия в доме сессии — отказ с адресом, раннер её не удаляет', () => {
        const seen: string[] = [];
        const problems = kimiIsolationProblems({
            ...clean(),
            listDirFn: (p) => {
                seen.push(p);
                return ['wd-loop.json'];
            },
        });
        expect(seen).toEqual(['/r/home/workspace-trust']);
        expect(problems).toEqual([
            expect.stringMatching(/\/r\/home\/workspace-trust записи доверия \(wd-loop\.json\)/),
        ]);
    });

    it('НЕГАТИВНЫЙ: каталог доверия не прочитался — отказ, а не «пусто»', () => {
        const problems = kimiIsolationProblems({
            ...clean(),
            listDirFn: () => {
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            },
        });
        expect(problems).toEqual([expect.stringMatching(/не прочитан \(EACCES\)/)]);
        expect(() =>
            kimiTrustEntries(home, () => {
                throw new Error('EIO');
            }),
        ).toThrow('EIO');
    });

    it('НЕГАТИВНЫЙ: каждое отступление окружения названо своей строкой', () => {
        const env = {
            [KIMI_HOME_ENV]: '/elsewhere',
            [KIMI_TRUST_ENV]: '1',
            KIMI_CODE_BASE_URL: 'https://example.com',
        };
        const problems = kimiIsolationProblems({ ...clean(), env });
        expect(problems).toEqual([
            expect.stringMatching(/KIMI_CODE_HOME сессии — не дом/),
            expect.stringMatching(/KIMI_CODE_NO_AUTO_UPDATE не «1»/),
            expect.stringMatching(/KIMI_CODE_TRUST_WORKSPACE в окружении сессии/),
            'окружение CLI раннера не вычищено: KIMI_CODE_BASE_URL',
        ]);
    });

    it('НЕГАТИВНЫЙ: дом сессии совпал с домом человека — отказ', () => {
        const problems = kimiIsolationProblems({ ...clean(), humanHome: '/r/home/' });
        expect(problems).toEqual([expect.stringMatching(/совпал с домом человека/)]);
        expect(kimiIsolationProblems({ ...clean(), humanHome: null })).toEqual([]);
    });
});

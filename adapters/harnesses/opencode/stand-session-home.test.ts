// Сборщик конфига OpenCode на стенде живых проб (#197): факты, снятые настоящим CLI 1.19.4 с
// окружением и настройками от сборщика канона (`adapters/opencode-home.ts`). Каждый отказ сверки
// изоляции стоит в паре с контрольным прогоном, где тот же канал открыт после сборщика, — иначе
// «плагин не загрузился» могло бы значить «плагин не загрузился бы никогда».
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENCODE_DISABLE_PROJECT_CONFIG_ENV, XDG_CONFIG_HOME_ENV } from '../../opencode-home.ts';

const DIR = import.meta.dirname;
const FX = JSON.parse(
    readFileSync(path.join(DIR, '..', '__fixtures__', 'opencode-1.19.4-stand.json'), 'utf-8'),
);
type TRun = {
    id: string;
    source: string;
    cliVersion: string;
    isolationProblems: string[];
    pluginsLoaded: string[];
    spawnPwd: string;
    sessionDirectory: string;
    toolStatus: string;
    toolError: string | null;
    forbiddenWritten: boolean;
    rulesInPrompt: boolean;
    exit: string;
};
const run = (id: string): TRun => {
    const e = (FX.sessionHome as TRun[]).find((x) => x.id === id);
    if (!e) throw new Error(`нет прогона ${id} в sessionHome`);
    return e;
};
const TREE = '/path/to/stand/work/loop';
const built = run('O-built');
const pure = run('O-pure');
const project = run('O-project');
const stale = run('O-pwd-stale');

describe('фикстура сборщика — сырая, с источником и воспроизведением', () => {
    it('каждый прогон — CLI 1.19.4, карточка #197, сессия дошла до конца', () => {
        for (const e of FX.sessionHome as TRun[]) {
            expect(e.cliVersion, e.id).toBe(FX.cliVersion);
            expect(e.source, e.id).toMatch(/OpenCode 1\.19\.4.*карточка #197/);
            expect(e.exit, e.id).toBe('exit=0');
        }
    });

    it('набор воспроизведения собирает сессию сборщиком канона, без путей машины', () => {
        const kit = FX.sessionHomeKit;
        expect(kit['drive.mts']).toContain(
            'oh.opencodeSessionEnv(runnerEnv, { configDir, cwd: tree })',
        );
        expect(kit['drive.mts']).toContain('oh.opencodeSessionConfig(');
        expect(kit['drive.mts']).toContain('oh.opencodeIsolationProblems(');
        expect(kit['drive.mts']).toContain("OPENCODE_PURE: '1'");
        const text = JSON.stringify({ kit, runs: FX.sessionHome });
        expect(text).not.toMatch(/(?<![\w.-])\/(root|home|tmp)\//);
        expect(text).toMatch(/\/path\/to\/stand/);
    });
});

describe('OPENCODE_PURE=1 у раннера — барьер на месте', () => {
    it('со сборщиком плагин барьера загружен и отменил запрещённый вызов', () => {
        expect(built.isolationProblems).toEqual([]);
        expect(built.pluginsLoaded).toEqual(['barrier-plugin']);
        expect(built.toolStatus).toBe('error');
        expect(built.toolError).toBe('blocked by stand barrier');
        expect(built.forbiddenWritten).toBe(false);
    });

    it('контроль: OPENCODE_PURE, доехавший до сессии, снимает барьер — сверка его называет', () => {
        expect(pure.pluginsLoaded).toEqual([]);
        expect(pure.toolStatus).toBe('completed');
        expect(pure.forbiddenWritten).toBe(true);
        expect(pure.isolationProblems).toEqual([expect.stringContaining('OPENCODE_PURE')]);
    });
});

describe('проектный и человеческий конфиг не сливаются с сессией', () => {
    it('со сборщиком — ни .opencode/plugin, ни npm-плагина дерева, ни плагина человека', () => {
        for (const layer of [
            'tree-dir-plugin',
            'tree-json-plugin',
            'human-plugin',
            'content-plugin',
        ])
            expect(built.pluginsLoaded).not.toContain(layer);
    });

    it('правила дерева доходят до модели instructions абсолютным путём', () => {
        for (const e of FX.sessionHome as TRun[]) expect(e.rulesInPrompt, e.id).toBe(true);
    });

    it('контроль: без выключателя и со своим XDG человека CLI грузит все три слоя', () => {
        expect(project.pluginsLoaded).toEqual([
            'barrier-plugin',
            'human-plugin',
            'tree-dir-plugin',
            'tree-json-plugin',
        ]);
        expect(project.isolationProblems).toEqual([
            expect.stringContaining(XDG_CONFIG_HOME_ENV),
            expect.stringContaining(OPENCODE_DISABLE_PROJECT_CONFIG_ENV),
        ]);
    });
});

describe('каталог сессии — из PWD, и сборщик ставит его дереву', () => {
    it('со сборщиком каталог сессии — дерево', () => {
        expect(built.spawnPwd).toBe(TREE);
        expect(built.sessionDirectory).toBe(TREE);
    });

    it('контроль: PWD каталога запуска при cwd дерева — сессия там, сверка называет PWD', () => {
        expect(stale.sessionDirectory).toBe('/path/to/stand');
        expect(stale.isolationProblems).toEqual([expect.stringMatching(/^PWD сессии/)]);
    });
});

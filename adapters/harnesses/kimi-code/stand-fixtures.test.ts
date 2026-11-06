// Дом сессии Kimi Code на стенде живых проб (#196): факты, снятые настоящим CLI 2.3.2 с
// окружением и `mcp.json` дома от сборщика канона (`adapters/kimi-home.ts`). Каждый отказ сверки
// изоляции стоит в паре с контрольным прогоном, где тот же канал открыт после сборщика, —
// иначе «сервер не поднялся» могло бы значить «сервер не поднялся бы никогда».
import { describe, expect, it } from 'vitest';
import { KIMI_NO_AUTO_UPDATE_ENV, KIMI_SESSION_MCP, KIMI_TRUST_ENV } from '../../kimi-home.ts';
import { readStandFixture } from '../stand-fixture.test-helper.ts';
import { kitScriptProblems } from '../stand-scrub.ts';

const DIR = import.meta.dirname;
const { fixture: FX } = readStandFixture(DIR, 'kimi-code', '2.3.2');
type TRun = {
    id: string;
    source: string;
    cliVersion: string;
    isolationProblems: string[];
    serversStarted: string[];
    trustGateWarning: string | null;
    exit: string;
    versionBefore: string;
    versionAfter: string;
    workspaceTrust: string[] | null;
    updatesDir: string[] | null;
    homeMcpAfter: string;
};
const run = (id: string): TRun => {
    const e = (FX.sessionHome as TRun[]).find((x) => x.id === id);
    if (!e) throw new Error(`нет прогона ${id} в sessionHome`);
    return e;
};
const built = run('K-built');
const trusted = run('K-trusted');
const updateOn = run('K-update-on');

describe('фикстура дома сессии — сырая, с источником и воспроизведением', () => {
    it('каждый прогон — CLI 2.3.2, карточка #196, сессия дошла до конца', () => {
        for (const e of FX.sessionHome as TRun[]) {
            expect(e.cliVersion, e.id).toBe(FX.cliVersion);
            expect(e.source, e.id).toContain(`Kimi Code ${FX.cliVersion}`);
            expect(e.source, e.id).toContain('карточка #196');
            expect(e.exit, e.id).toBe('exit=0');
        }
    });

    it('наборы воспроизведения целы: вход с шебангом, без подстановки между символами', () => {
        expect(kitScriptProblems(FX.kit)).toEqual([]);
        expect(kitScriptProblems(FX.sessionHomeKit)).toEqual([]);
    });

    it('набор воспроизведения собирает окружение сборщиком канона, без путей машины', () => {
        const kit = FX.sessionHomeKit;
        expect(kit['session.mts']).toContain('kh.kimiSessionEnv(');
        expect(kit['session.mts']).toContain('kh.KIMI_SESSION_MCP');
        expect(kit['session.mts']).toContain('kh.kimiIsolationProblems(');
        const text = JSON.stringify({ kit, runs: FX.sessionHome });
        expect(text).not.toMatch(/(?<![\w.-])\/(root|home|tmp)\//);
        expect(text).toMatch(/\/path\/to\/stand/);
    });
});

describe('проектный MCP: недоверенный каталог серверов не поднимает', () => {
    it('сборщик снял доверие переменной раннера — ни .mcp.json, ни .kimi-code/mcp.json', () => {
        expect(built.isolationProblems).toEqual([]);
        expect(built.serversStarted).toEqual([]);
        expect(built.trustGateWarning).toMatch(
            /not trusted; skipped 2 project-level MCP servers: proj .*, projlocal /,
        );
        expect(built.homeMcpAfter).toBe(KIMI_SESSION_MCP);
    });

    it('контроль: доверие переменной после сборщика поднимает оба, сверка его называет', () => {
        expect(trusted.serversStarted).toEqual(['proj-root', 'proj-local']);
        expect(trusted.trustGateWarning).toBeNull();
        expect(trusted.isolationProblems).toEqual([expect.stringContaining(KIMI_TRUST_ENV)]);
    });
});

describe('дом сессии: каталог доверия пуст, автообновления нет', () => {
    it('записей доверия CLI не заводит ни в одном прогоне', () => {
        for (const e of FX.sessionHome as TRun[]) expect(e.workspaceTrust, e.id).toBeNull();
    });

    it('с выключателем — ни проверки релиза, ни каталога updates; версия до и после та же', () => {
        expect(built.updatesDir).toBeNull();
        expect(built.versionBefore).toBe(FX.cliVersion);
        expect(built.versionAfter).toBe(built.versionBefore);
    });

    it('контроль: без выключателя CLI на старте проверяет релиз, сверка это называет', () => {
        expect(updateOn.updatesDir).toEqual(['rollout.log']);
        expect(updateOn.isolationProblems).toEqual([
            expect.stringContaining(KIMI_NO_AUTO_UPDATE_ENV),
        ]);
        // Сети у стенда нет — релиз не найден, поэтому и здесь версия та же: контроль доказывает
        // попытку, а не обновление.
        expect(updateOn.versionAfter).toBe(updateOn.versionBefore);
    });
});

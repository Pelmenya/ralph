// #219: живая проба в применении намерений — решение по карточке и вычистка ключа на ВСЁМ
// пути: комментарий в карточку, лог, файл намерений. Разбор — session-requests.test.ts,
// исполнитель — live-probe.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import { liveProbeForIntent, runLiveProbe, type TStandSpawn } from './live-probe.ts';

// Собирается в рантайме: литерал с энтропией сканер секретов площадки читал как утечку.
const KEY = ['probe', 'fixture', 'fedcba9876543210'].join('-');
const CFG = { issueLabels: ['complexity:low'], liveProbe: { keyEnv: 'RALPH_PROBE_KEY' } };
const line = (o: unknown) => JSON.stringify(o);
const BATCH = [
    line({ kind: 'live-probe', issue: 219, cli: 'claude', case: 'unknown-tool' }),
    line({ kind: 'comment', issue: 219, comment: 'сделано всё, кроме живого прогона' }),
    line({ kind: 'close', issue: 219, comment: 'критерии выполнены' }),
].join('\n');

function world() {
    const calls: string[] = [];
    const logs: string[] = [];
    const writes: string[] = [];
    return {
        calls,
        logs,
        writes,
        deps: {
            cfg: CFG,
            currentMilestone: 'm',
            dry: false,
            readFn: () => BATCH,
            writeFn: (t: string) => writes.push(t),
            removeFn: () => {},
            logFn: (m: string) => logs.push(m),
            pushEventFn: (m: string) => logs.push(m),
            taskSource: {
                commentOnIssue: (n: number, body: string) => calls.push(`comment:${n}:${body}`),
                closeIssue: (n: number) => calls.push(`close:${n}`),
                blockIssue: (n: number) => calls.push(`block:${n}`),
            },
        },
    };
}

/** Исполнитель живой пробы поверх подставного стенда, остальное — боевое. */
const probeVia =
    (spawnFn: TStandSpawn, env: Record<string, string>) => (probe: { cli: string; case: string }) =>
        liveProbeForIntent(probe, {
            rawConfig: CFG.liveProbe,
            productRoot: '/inst/abc',
            executionRoot: '/work/tree',
            env,
            runFn: (args) =>
                runLiveProbe({ ...args, spawnFn, mkdtempFn: () => '/tmp/rp-t', rmFn: () => {} }),
        });

describe('live-probe в применении намерений (#219)', () => {
    it('PASS — комментарий с итогом, затем close той же карточки', () => {
        const w = world();
        const res = ralph.applySessionRequests({
            ...w.deps,
            liveProbeFn: probeVia(
                () => ({ status: 0, output: 'RESULT claude unknown-tool PASS — ok\n' }),
                { RALPH_PROBE_KEY: KEY },
            ),
        });
        expect(res.failed).toBe(false);
        expect(res.closedIssues).toEqual([219]);
        expect(w.calls[0]).toMatch(/^comment:219:✅ Живая проба `claude unknown-tool`.*PASS/s);
        expect(w.calls.at(-1)).toBe('close:219');
        expect(w.logs.join('\n')).toMatch(/🧪 Живая проба claude unknown-tool по #219: PASS/);
    });

    it('без ключа пробы — явный отказ с именем переменной, карточка не закрыта', () => {
        const w = world();
        const res = ralph.applySessionRequests({
            ...w.deps,
            liveProbeFn: probeVia(() => {
                throw new Error('стенд запускаться не должен');
            }, {}),
        });
        expect(w.calls.some((c) => c.startsWith('close:'))).toBe(false);
        expect(res.closedIssues).toEqual([]);
        expect(w.calls[0]).toMatch(/REFUSED.*RALPH_PROBE_KEY/s);
        expect(res.dropped).toEqual([{ kind: 'close', what: '#219: живая проба не дала PASS' }]);
    });

    it('от противного: проба печатает ключ — FAIL, ключа нет ни в карточке, ни в логе, ни в файле', () => {
        const w = world();
        const res = ralph.applySessionRequests({
            ...w.deps,
            liveProbeFn: probeVia(
                () => ({
                    status: 0,
                    output: `ANTHROPIC_API_KEY=${KEY}\nRESULT claude unknown-tool PASS — ok\n`,
                }),
                { RALPH_PROBE_KEY: KEY },
            ),
        });
        expect(w.calls[0]).toMatch(/FAIL/);
        expect(w.calls.some((c) => c.startsWith('close:'))).toBe(false);
        expect(res.closedIssues).toEqual([]);
        for (const text of [...w.calls, ...w.logs, ...w.writes]) expect(text).not.toContain(KEY);
    });

    it('INCONCLUSIVE — карточка не закрыта, остальные намерения применены', () => {
        const w = world();
        ralph.applySessionRequests({
            ...w.deps,
            liveProbeFn: () => ({ verdict: 'INCONCLUSIVE', comment: 'неясно' }),
        });
        expect(w.calls).toEqual([
            'comment:219:неясно',
            'comment:219:сделано всё, кроме живого прогона',
        ]);
    });

    it('шаг без исполнителя пробы — карточку не закрывает', () => {
        const w = world();
        ralph.applySessionRequests(w.deps);
        expect(w.calls.some((c) => c.startsWith('close:'))).toBe(false);
        expect(w.calls[0]).toMatch(/исполнителя пробы нет/);
    });

    it('исполнитель бросил — INCONCLUSIVE с причиной, петля не встаёт', () => {
        const w = world();
        const res = ralph.applySessionRequests({
            ...w.deps,
            liveProbeFn: () => {
                throw new Error('стенд сломан');
            },
        });
        expect(res.failed).toBe(false);
        expect(w.calls[0]).toMatch(/упала в раннере: стенд сломан/);
    });

    it('преобразованный батч ложится на диск до первого эффекта: проба не повторится', () => {
        const w = world();
        let probes = 0;
        ralph.applySessionRequests({
            ...w.deps,
            liveProbeFn: () => {
                probes += 1;
                return { verdict: 'PASS', comment: 'ok' };
            },
        });
        expect(probes).toBe(1);
        expect(w.writes[0]).not.toContain('live-probe');
        expect(w.writes[0]).toContain('"kind":"comment","issue":219,"comment":"ok"');
    });
});

// Применение, а не работоспособность: кодер-итерация обязана отдать исполнитель пробы, иначе
// каждая проба кончалась бы «исполнителя нет», и критерий не закрывался бы никогда.
describe('проводка исполнителя пробы в кодер-итерации (#219)', () => {
    const source = readFileSync(join(import.meta.dirname, 'orchestrator.ts'), 'utf-8');

    it('вызов применения намерений кодер-итерации несёт liveProbeFn из установки ядра', () => {
        const at = source.indexOf('const liveProbeFn = (probe');
        expect(at).toBeGreaterThan(-1);
        const block = source.slice(
            at,
            source.indexOf('});', source.indexOf('const intents = applySessionRequestsFn({', at)),
        );
        expect(block).toMatch(/productRoot: cfg\.rootsResolved\?\.productRoot/);
        expect(block).toMatch(/executionRoot: cfg\.rootsResolved\?\.executionRoot/);
        expect(block).toMatch(/const intents = applySessionRequestsFn\(\{[\s\S]*\bliveProbeFn,/);
    });
});

// Замер не становится новым барьером: те же 0/1 и fail-fast при любой судьбе JSON.
// Ни один чек здесь не запускается: команды, часы и файлы подставлены параметрами.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGate, slowestFiles, TIMING_REPORT, type GateDeps } from './gate.mts';

const report = (durations: number[]) =>
    JSON.stringify({
        testResults: durations.map((duration, i) => ({
            name: path.join(import.meta.dirname, `sample-${i}.test.ts`),
            startTime: 100,
            endTime: 100 + duration,
        })),
    });

function world(statuses: Array<number | null> = [0, 0, 0], over: Partial<GateDeps> = {}) {
    const logs: string[] = [];
    const errors: string[] = [];
    const calls: string[] = [];
    let tick = 0;
    const deps: GateDeps = {
        run: (cmd) => {
            calls.push(cmd);
            return { status: statuses[calls.length - 1] };
        },
        now: () => tick++ * 1250,
        clearReport: () => undefined,
        readReport: () => report([3000, 5000]),
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
        traceDeny: 'example',
        ...over,
    };
    return { deps, logs, errors, calls };
}

describe('runGate — длительности и прежний вердикт', () => {
    it('итог — сумма времени чеков, без промежутков между ними', () => {
        const times = [0, 1000, 10000, 12000, 20000, 23000];
        const w = world(undefined, { now: () => times.shift()! });
        expect(runGate(w.deps)).toBe(0);
        expect(w.logs).toContain('⏱ format: 1.000 с');
        expect(w.logs).toContain('⏱ typecheck: 2.000 с');
        expect(w.logs).toContain('⏱ test: 3.000 с');
        expect(w.logs).toContain('⏱ Итого по чекам: 6.000 с');
    });
    it('все три чека и сумма; JSON дополняет обычный репортёр того же прогона с покрытием', () => {
        const w = world();
        expect(runGate(w.deps)).toBe(0);
        expect(w.logs.filter((line) => /^⏱ (format|typecheck|test):/.test(line))).toEqual([
            '⏱ format: 1.250 с',
            '⏱ typecheck: 1.250 с',
            '⏱ test: 1.250 с',
        ]);
        expect(w.logs).toContain('⏱ Итого по чекам: 3.750 с');
        expect(w.logs.at(-1)).toBe('✅ гейт зелёный: format, typecheck, test');
        expect(w.calls).toEqual([
            'npm run format:check --silent',
            'npm run typecheck --silent',
            'npm run test --silent -- --coverage --reporter=default ' +
                '--reporter=./gate-timing-reporter.mts --outputFile.json=node_modules/.gate-timing.json',
        ]);
        expect(TIMING_REPORT).toBe(
            path.join(import.meta.dirname, 'node_modules', '.gate-timing.json'),
        );
        expect(w.logs).toContain('  5.000 с  sample-1.test.ts');
        expect(w.errors).toEqual([]);
    });

    for (const [index, name] of ['format', 'typecheck', 'test'].entries()) {
        it.each([2, null])(
            `${name}: код %s даёт 1, время и сумму, следующие чеки не идут`,
            (status) => {
                const statuses: Array<number | null> = [0, 0, 0];
                statuses[index] = status;
                const w = world(statuses);
                expect(runGate(w.deps)).toBe(1);
                expect(w.calls).toHaveLength(index + 1);
                expect(w.logs).toContain(`⏱ ${name}: 1.250 с`);
                expect(w.logs).toContain(`⏱ Итого по чекам: ${((index + 1) * 1.25).toFixed(3)} с`);
                expect(w.errors).toEqual([
                    `❌ гейт красный на чеке «${name}» (код ${String(status)})`,
                ]);
                expect(w.logs.some((line) => line.startsWith('✅'))).toBe(false);
            },
        );
    }

    it.each([0, 7])('отсутствующий/битый отчёт не меняет код чека test=%s', (status) => {
        for (const readReport of [
            () => {
                throw new Error('ENOENT');
            },
            () => '{broken',
            () => '{}',
            () => '{"testResults":[]}',
            () => '{"testResults":[{"name":"a","startTime":2,"endTime":1}]}',
        ]) {
            const w = world([0, 0, status], { readReport });
            expect(runGate(w.deps)).toBe(status === 0 ? 0 : 1);
            expect(w.logs.some((line) => /^⚠ Отчёт времени файлов недоступен: .+/.test(line))).toBe(
                true,
            );
        }
    });

    it('не читает старый отчёт, если очистка не удалась; причина видна, гейт зелёный', () => {
        let reads = 0;
        const w = world(undefined, {
            clearReport: () => {
                throw new Error('EACCES');
            },
            readReport: () => {
                reads++;
                return report([99999]);
            },
        });
        expect(runGate(w.deps)).toBe(0);
        expect(reads).toBe(0);
        expect(w.logs).toContain('⚠ Отчёт времени файлов не очищен: Error: EACCES');
    });

    it('очистка идёт до test, чтение после него, даже при красном сьюте', () => {
        const events: string[] = [];
        const w = world(undefined, {
            clearReport: () => {
                events.push('clear');
            },
            run: (cmd) => {
                events.push(cmd);
                return { status: cmd.includes('--coverage') ? 1 : 0 };
            },
            readReport: () => {
                events.push('read');
                return report([1]);
            },
        });
        expect(runGate(w.deps)).toBe(1);
        expect(events.slice(2)).toEqual(['clear', expect.stringContaining('--coverage'), 'read']);
    });

    it('ранний отказ не трогает отчёт и сохраняет предупреждение об отсутствующем словаре', () => {
        const w = world([1], {
            traceDeny: ' ',
            clearReport: () => {
                throw new Error('не должен вызываться');
            },
        });
        expect(runGate(w.deps)).toBe(1);
        expect(w.logs[0]).toContain('RALPH_TRACE_DENY не задан');
        expect(w.logs.some((line) => line.startsWith('⚠'))).toBe(false);
    });
});

describe('slowestFiles — JSON Vitest', () => {
    it('больше 15 файлов: печатаются ровно 15, по убыванию интервала endTime - startTime', () => {
        const durations = Array.from({ length: 20 }, (_, i) => i * 100);
        expect(slowestFiles(report(durations)).map((file) => file.duration)).toEqual(
            durations.slice(5).reverse(),
        );
        const w = world(undefined, { readReport: () => report(durations) });
        runGate(w.deps);
        const lines = w.logs.filter((line) => line.startsWith('  '));
        expect(lines).toHaveLength(15);
        expect(lines[0]).toContain('1.900 с');
        expect(lines.at(-1)).toContain('0.500 с');
    });

    it('маленький список не дополняется, нулевой интервал допустим', () => {
        expect(slowestFiles(report([0, 3, 1])).map((file) => file.duration)).toEqual([3, 1, 0]);
    });

    it.each([
        null,
        {},
        { name: '', startTime: 0, endTime: 1 },
        { name: 'a', startTime: '0', endTime: 1 },
    ])('невалидная строка %j не выдаётся за время', (file) => {
        expect(() => slowestFiles(JSON.stringify({ testResults: [file] }))).toThrow(/неверное/);
    });
});

import { expect, it } from 'vitest';
import type { Vitest } from 'vitest/node';
import GateTimingReporter from './gate-timing-reporter.mts';

// Настоящая генерация JSON, но запись подменена: проба EACCES не требует прав машины.
function reporter(write: (report: string) => Promise<void>) {
    const warnings: string[] = [];
    const instance = new GateTimingReporter(
        {},
        {
            write,
            warn: (line) => warnings.push(line),
        },
    );
    instance.onInit({
        config: { passWithNoTests: true },
        snapshot: { summary: {} },
    } as Vitest);
    return { instance, warnings };
}

it('сохраняет машиночитаемую форму встроенного JSON reporter', async () => {
    const written: string[] = [];
    const r = reporter(async (text) => {
        written.push(text);
    });
    await r.instance.onTestRunEnd([]);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0])).toMatchObject({ testResults: [], success: true });
    expect(r.warnings).toEqual([]);
});

it('отказ записи не выходит в Vitest исключением; причина видна строкой ⚠', async () => {
    const r = reporter(async () => {
        throw new Error('EACCES');
    });
    await expect(r.instance.onTestRunEnd([])).resolves.toBeUndefined();
    expect(r.warnings).toEqual(['⚠ Отчёт времени файлов не записан: Error: EACCES']);
});

it('ошибка сериализации тоже не меняет вердикт Vitest', async () => {
    let writes = 0;
    const r = reporter(async () => {
        writes++;
    });
    // В метаданные Vitest может приехать значение, которое JSON.stringify не принимает.
    r.instance.onCoverage({ unrepresentable: 1n });
    await expect(r.instance.onTestRunEnd([])).resolves.toBeUndefined();
    expect(writes).toBe(0);
    expect(r.warnings[0]).toMatch(/^⚠ Отчёт времени файлов не записан: .*BigInt/i);
});

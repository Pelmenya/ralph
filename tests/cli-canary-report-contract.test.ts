import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportProbeNames } from '../provision/stand/report.mts';

const ROOT = path.resolve(import.meta.dirname, '..');
const HARNESSES = ['claude-code', 'codex', 'kimi-code', 'opencode'] as const;
const REPORT_KEYS = [
    'assembled',
    'cliVersion',
    'harness',
    'inventory',
    'probes',
    'protocol',
    'version',
];

function readJson(file: string): any {
    return JSON.parse(readFileSync(file, 'utf8'));
}

function descriptorFor(harness: (typeof HARNESSES)[number]): any {
    return readJson(path.join(ROOT, 'adapters', 'harnesses', harness, 'descriptor.json'));
}

function expectContract(harness: string, version: string, fixture: any): void {
    expect(Object.keys(fixture).sort()).toEqual([...REPORT_KEYS].sort());
    expect(fixture).toMatchObject({
        protocol: 1,
        harness,
        version,
        cliVersion: version,
        assembled: false,
    });
    expect(
        Array.isArray(fixture.inventory) ||
            (typeof fixture.inventory === 'object' && fixture.inventory !== null),
    ).toBe(true);
    const names = fixture.probes.map((probe: { name: string }) => probe.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...reportProbeNames(harness)].sort());
    for (const probe of fixture.probes) {
        expect(probe).toEqual({
            name: expect.any(String),
            verdict: expect.any(String),
            detail: expect.any(String),
        });
    }
}

function expectCurrentContract(harness: string, version: string, fixture: any): void {
    if (fixture.protocol === undefined) {
        expect(fixture).toMatchObject({ cliVersion: version, assembled: false });
        expect(Array.isArray(fixture.events)).toBe(true);
        expect(
            Array.isArray(fixture.inventory) ||
                (typeof fixture.inventory === 'object' && fixture.inventory !== null),
        ).toBe(true);
        return;
    }
    expectContract(harness, version, fixture);
}

describe('контракт отчётного fixture канарейки protocol=1', () => {
    it.each(HARNESSES)('%s: обязательная синтетическая самопроверка', (harness) => {
        const descriptor = descriptorFor(harness);
        expectContract(harness, descriptor.cliVersion, {
            protocol: 1,
            harness,
            version: descriptor.cliVersion,
            cliVersion: descriptor.cliVersion,
            assembled: false,
            inventory: { tools: {} },
            probes: reportProbeNames(harness).map((name) => ({
                name,
                verdict: 'PASS',
                detail: 'synthetic contract self-test',
            })),
        });
    });

    const current = HARNESSES.flatMap((harness) => {
        const descriptor = descriptorFor(harness);
        const fixturePath = path.join(
            ROOT,
            'adapters',
            'harnesses',
            '__fixtures__',
            `${harness}-${descriptor.cliVersion}-stand.json`,
        );
        if (!existsSync(fixturePath)) return [];
        const fixture = readJson(fixturePath);
        return [{ harness, descriptor, fixture }];
    });

    it.each(current.map((entry) => [entry.harness, entry] as const))(
        '%s: version, harness, полная матрица и inventory реального снимка принадлежат кандидату',
        (_name, { descriptor, fixture, harness }) => {
            expectCurrentContract(harness, descriptor.cliVersion, fixture);
        },
    );
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

export function readStandFixture<T = any>(
    dir: string,
    harness: string,
    historicalVersion: string,
): {
    descriptor: { cliVersion: string } & Record<string, unknown>;
    fixture: T;
} {
    const descriptor = JSON.parse(readFileSync(path.join(dir, 'descriptor.json'), 'utf-8'));
    const fixturePath = path.join(
        dir,
        '..',
        '__fixtures__',
        `${harness}-${historicalVersion}-stand.json`,
    );
    return { descriptor, fixture: JSON.parse(readFileSync(fixturePath, 'utf-8')) };
}

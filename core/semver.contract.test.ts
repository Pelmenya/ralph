import { describe, expect, it } from 'vitest';
import { compareSemver } from './semver.ts';

const comparisons: { a: string; b: string; expected: -1 | 0 | 1 }[] = [
    { a: '1.2.10', b: '1.2.9', expected: 1 },
    { a: '1.0.0-rc.1', b: '1.0.0', expected: -1 },
    { a: '1.0.0-alpha', b: '1.0.0-alpha.1', expected: -1 },
    { a: '1.0.0-alpha.10', b: '1.0.0-alpha.2', expected: 1 },
    { a: '1.0.0-alpha', b: '1.0.0-beta', expected: -1 },
    { a: '1.0.0-beta', b: '1.0.0-alpha', expected: 1 },
    { a: '1.0.0-1', b: '1.0.0-alpha', expected: -1 },
    {
        a: '1.0.99999999999999999999',
        b: '1.0.99999999999999999998',
        expected: 1,
    },
];

describe('SemVer кандидата канарейки', () => {
    it.each(comparisons)('[F24-2] compareSemver($a, $b) = $expected', ({ a, b, expected }) => {
        expect(compareSemver(a, b)).toBe(expected);
    });

    it('[F24-2] build-метаданные не влияют на сравнение', () => {
        expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0);
        expect(compareSemver('1.0.0+a', '1.0.0')).toBe(0);
    });

    it.each(['v1.0', 'latest', '', ' 1.0.0', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0-a..b'])(
        '[F24-2] невалидный SemVer $0 отклонён',
        (value) => {
            expect(compareSemver(value, '1.0.0')).toBeNull();
        },
    );
});

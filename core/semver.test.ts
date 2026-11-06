import { describe, expect, it } from 'vitest';
import { compareSemver } from './semver.ts';

describe('границы сравнения SemVer', () => {
    it.each([
        { a: '1.0.9', b: '1.0.10', expected: -1 },
        { a: '1.0.10', b: '1.0.9', expected: 1 },
        { a: '1.2.10', b: '1.2.11', expected: -1 },
        { a: '1.0.0', b: '1.0.0-rc.1', expected: 1 },
        { a: '1.0.0-alpha.1', b: '1.0.0-alpha', expected: 1 },
        { a: '1.0.0-alpha', b: '1.0.0-1', expected: 1 },
        { a: '1.0.0-alpha', b: '1.0.0-alpha', expected: 0 },
        { a: '1.0.0-1a', b: '1.0.0-1b', expected: -1 },
    ] as const)('compareSemver($a, $b) = $expected', ({ a, b, expected }) => {
        expect(compareSemver(a, b)).toBe(expected);
    });

    it('отклоняет невалидный второй аргумент', () => {
        expect(compareSemver('1.0.0', 'invalid')).toBeNull();
    });
});

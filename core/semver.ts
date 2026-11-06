// Канарейка принимает только строго более новый SemVer: сравнение через Number теряло
// и порядок prerelease, и целые длиннее MAX_SAFE_INTEGER.
const SEMVER =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type ParsedSemver = { core: string[]; prerelease: string[] };

function parseSemver(value: string): ParsedSemver | null {
    const match = SEMVER.exec(value);
    if (!match) return null;
    return {
        core: match.slice(1, 4),
        prerelease: match[4] === undefined ? [] : match[4].split('.'),
    };
}

function compareNumeric(a: string, b: string): -1 | 0 | 1 {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): -1 | 0 | 1 {
    if (a.length === 0 || b.length === 0) {
        if (a.length === b.length) return 0;
        return a.length === 0 ? 1 : -1;
    }
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        if (index >= a.length) return -1;
        if (index >= b.length) return 1;
        const left = a[index];
        const right = b[index];
        if (left === right) continue;
        const leftNumeric = /^[0-9]+$/.test(left);
        const rightNumeric = /^[0-9]+$/.test(right);
        if (leftNumeric && rightNumeric) return compareNumeric(left, right);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return left < right ? -1 : 1;
    }
    return 0;
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) return null;
    for (let index = 0; index < left.core.length; index += 1) {
        const result = compareNumeric(left.core[index], right.core[index]);
        if (result !== 0) return result;
    }
    return comparePrerelease(left.prerelease, right.prerelease);
}

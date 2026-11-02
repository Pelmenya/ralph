// Резка по одной строке на раздел потеряла критерии S2a: барьер сверяет номера,
// а пропуск, чужой номер и дубль называет отдельной причиной.
const ID = String.raw`S[A-Za-z0-9]+\.\d+`;
const CRITERION = new RegExp(String.raw`^\s*-\s+\[[ xX]\]\s+\[(${ID})\]`);
const COVERAGE_ROW = new RegExp(String.raw`^\s*\|\s*\[(${ID})\]\s*\|`);
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^( *)((?:[-+*]|\d{1,9}[.)]) +)/;

function withoutContainerIndent(line: string, indent: number): string | null {
    if (indent === 0) return line;
    if (line.trim() === '') return '';
    return line.startsWith(' '.repeat(indent)) ? line.slice(indent) : null;
}

function* contentLines(markdown: string): Generator<string> {
    let fence: { marker: string; containerIndent: number } | null = null;
    const containers: number[] = [];

    for (const line of markdown.split('\n')) {
        const containerIndent = fence?.containerIndent ?? containers.at(-1) ?? 0;
        const content = withoutContainerIndent(line, containerIndent);
        const match = content?.match(FENCE) ?? null;
        if (fence !== null) {
            if (
                match !== null &&
                match[1][0] === fence.marker[0] &&
                match[1].length >= fence.marker.length &&
                match[2].trim() === ''
            ) {
                fence = null;
            }
            continue;
        }

        if (line.trim() !== '') {
            const indent = line.match(/^ */)![0].length;
            while (containers.length > 0 && indent < containers.at(-1)!) containers.pop();
            const item = line.match(LIST_ITEM);
            if (item !== null && indent - (containers.at(-1) ?? 0) <= 3) {
                containers.push(item[1].length + item[2].length);
            }
        }

        const normalized = withoutContainerIndent(line, containers.at(-1) ?? 0);
        const opening = normalized?.match(FENCE) ?? null;
        if (opening !== null && !(opening[1][0] === '`' && opening[2].includes('`'))) {
            fence = { marker: opening[1], containerIndent: containers.at(-1) ?? 0 };
            continue;
        }
        yield line;
    }
}

export function criteriaIds(prd: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    let section: string | null = null;
    let inCriteria = false;

    for (const line of contentLines(prd)) {
        if (/^##\s/.test(line)) {
            section = line.match(/^##\s+(S[A-Za-z0-9]+)(?:\.|\s)/)?.[1] ?? null;
            inCriteria = false;
            if (section !== null && !result.has(section)) result.set(section, []);
            continue;
        }
        if (/^###\s/.test(line)) {
            inCriteria = section !== null && /^###\s+Критерии готовности\s*$/.test(line);
            continue;
        }
        if (!inCriteria || section === null) continue;

        const id = line.match(CRITERION)?.[1];
        if (id !== undefined) result.get(section)!.push(id);
    }

    return result;
}

export function coverageIds(plan: string): string[] {
    const result: string[] = [];
    let inCoverage = false;

    for (const line of contentLines(plan)) {
        if (/^#{1,3}\s/.test(line)) {
            inCoverage = /^###\s+Покрытие по критерию\s*$/.test(line);
            continue;
        }
        if (!inCoverage) continue;

        const id = line.match(COVERAGE_ROW)?.[1];
        if (id !== undefined) result.push(id);
    }

    return result;
}

export function coverageProblems(prd: string, plan: string): string[] {
    const criteria = criteriaIds(prd);
    const known = new Set([...criteria.values()].flat());
    const rows = new Map<string, number>();
    for (const id of coverageIds(plan)) rows.set(id, (rows.get(id) ?? 0) + 1);

    const problems: string[] = [];
    for (const ids of criteria.values()) {
        for (const id of ids) {
            if (!rows.has(id)) problems.push(`[${id}] нет строки покрытия`);
        }
    }
    for (const [id, count] of rows) {
        if (!known.has(id)) problems.push(`[${id}] нет в критериях PRD`);
        if (count > 1) problems.push(`[${id}] повторяется в покрытии`);
    }
    return problems;
}

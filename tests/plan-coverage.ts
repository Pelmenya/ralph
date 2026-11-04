// Резка по одной строке на раздел потеряла критерии S2a: барьер сверяет номера,
// а пропуск, чужой номер и дубль называет отдельной причиной.
const ID = String.raw`S[A-Za-z0-9]+\.\d+`;
const CRITERION = new RegExp(String.raw`^\s*-\s+\[[ xX]\]\s+\[(${ID})\]`);
const COVERAGE_ROW = new RegExp(String.raw`^\s*\|\s*\[(${ID})\]\s*\|([^|]*)\|`);
export const MAX_CRITERIA_PER_PHASE = 12;
const PHASE_CELL = /^[0-9]+[a-z]*$/;
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

function coverageRows(plan: string): { id: string; phase: string }[] {
    const result: { id: string; phase: string }[] = [];
    let inCoverage = false;

    for (const line of contentLines(plan)) {
        if (/^#{1,3}\s/.test(line)) {
            inCoverage = /^###\s+Покрытие по критерию\s*$/.test(line);
            continue;
        }
        if (!inCoverage) continue;

        const match = line.match(COVERAGE_ROW);
        if (match !== null) result.push({ id: match[1], phase: match[2].trim() });
    }

    return result;
}

export function coverageIds(plan: string): string[] {
    return coverageRows(plan).map((row) => row.id);
}

// Фаза 24 вошла в петлю с 21 критерием и встала на пределе планов правок: номер в таблице
// — единственное место, где критерий привязан к фазе (проза сжимается при резке).
export function coveragePhases(plan: string): Map<string, number> {
    const result = new Map<string, number>();
    for (const { phase } of coverageRows(plan)) result.set(phase, (result.get(phase) ?? 0) + 1);
    return result;
}

export function criteriaSizeProblems(plan: string, debt: Record<string, number> = {}): string[] {
    const phases = coveragePhases(plan);
    const problems: string[] = [];
    for (const [phase, count] of phases) {
        // Ячейка вида «24, 25» или «24/25» дала бы отдельный ключ и молча не засчиталась бы
        // ни одной фазе: фаза в таблице — ровно один токен, иначе красный (fail-closed).
        if (!PHASE_CELL.test(phase)) {
            problems.push(
                `Ячейка фазы "${phase}" — не один номер фазы (${count} строк не засчитаны)`,
            );
            continue;
        }
        const owed = debt[phase];
        if (owed === undefined) {
            if (count > MAX_CRITERIA_PER_PHASE) {
                problems.push(
                    `Фаза ${phase}: ${count} критериев PRD — больше ${MAX_CRITERIA_PER_PHASE}, дели фазу`,
                );
            }
        } else if (count !== owed) {
            problems.push(
                `Фаза ${phase}: ${count} критериев PRD, в долге записано ${owed} — число изменилось, поправь DEBT`,
            );
        }
    }
    for (const phase of Object.keys(debt)) {
        if (!phases.has(phase))
            problems.push(`Фаза ${phase} из DEBT не найдена в таблице покрытия`);
    }
    return problems;
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

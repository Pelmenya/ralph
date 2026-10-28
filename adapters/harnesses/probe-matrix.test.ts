// Генератор матрицы проб из описания (#183): ожидаемая матрица на описании-образце,
// включая незнакомый инструмент; пара у каждой отрицательной; проблемы вместо догадок.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseHarnessDescriptor, type HarnessDescriptor } from './descriptor.ts';
import { PROBE_TARGETS, UNKNOWN_FIELD, UNKNOWN_TOOL, probeMatrix } from './probe-matrix.ts';
import { probeSpecProblems } from '../probe-kinds.ts';

const SAMPLE = path.join(
    import.meta.dirname,
    '..',
    '..',
    'tests',
    '__fixtures__',
    'harness-sample',
    'descriptor.json',
);
const sample = (): HarnessDescriptor =>
    parseHarnessDescriptor(JSON.parse(readFileSync(SAMPLE, 'utf-8')), SAMPLE);

/** Проекция пробы без текста: то, по чему матрицу сверяют. */
const row = (p: ReturnType<typeof probeMatrix>['probes'][number]) =>
    [p.id, p.polarity, p.reasonCode ?? null, p.pair ?? null] as const;

describe('матрица описания-образца', () => {
    const { probes, problems } = probeMatrix(sample());

    it('ожидаемая матрица целиком', () => {
        expect(problems).toEqual([]);
        expect(probes.map(row)).toEqual([
            ['rule:Bash:allowed', 'positive', null, null],
            ['rule:Read:allowed', 'positive', null, null],
            ['rule:TodoWrite:allowed', 'positive', null, null],
            ['rule:Bash:destructive', 'negative', 'destructive', 'rule:Bash:allowed'],
            ['rule:Bash:secret', 'negative', 'secret-env', 'rule:Bash:allowed'],
            ['rule:Bash:unknown-field', 'negative', 'unknown-field', 'rule:Bash:allowed'],
            ['rule:Read:secret', 'negative', 'secret-env', 'rule:Read:allowed'],
            ['rule:Read:unknown-field', 'negative', 'unknown-field', 'rule:Read:allowed'],
            ['rule:mcp__fs__read:mcp-write', 'negative', 'mcp-not-allowed', 'rule:Bash:allowed'],
            ['rule:unknown-tool', 'negative', 'unknown-tool', 'rule:Bash:allowed'],
            ['rule:unknown-envelope-field', 'negative', 'unknown-field', 'rule:Bash:allowed'],
            ['registration:shell:accepted', 'positive', null, null],
            ['registration:shell:dropped', 'negative', null, 'registration:shell:accepted'],
            ['preflight:clean', 'positive', null, null],
            ['preflight:surface:.sample/config.json', 'negative', null, 'preflight:clean'],
            ['preflight:env:SAMPLE_DISABLE_HOOKS', 'negative', null, 'preflight:clean'],
            ['sandbox:allowed', 'positive', null, null],
            ['sandbox:indirect-contour', 'negative', null, 'sandbox:allowed'],
        ]);
    });

    it('поля входа — из argMap описания, а не по имени', () => {
        const byId = new Map(probes.map((p) => [p.id, p]));
        expect(byId.get('rule:Read:secret')?.input).toEqual({ file_path: PROBE_TARGETS.secret });
        expect(byId.get('rule:Bash:destructive')?.input).toEqual({
            command: `rm -rf ./${PROBE_TARGETS.victim}`,
        });
        expect(byId.get('rule:Read:unknown-field')?.input).toEqual({
            file_path: PROBE_TARGETS.allowedRead,
            [UNKNOWN_FIELD]: 1,
        });
        expect(byId.get('rule:unknown-envelope-field')?.envelopeExtra).toEqual({
            [UNKNOWN_FIELD]: 1,
        });
        expect(byId.get('preflight:env:SAMPLE_DISABLE_HOOKS')?.env).toEqual({
            SAMPLE_DISABLE_HOOKS: '1',
        });
    });

    it('незнакомый инструмент — вне toolMap и mcpNames, ждёт unknown-tool', () => {
        const unknown = probes.find((p) => p.id === 'rule:unknown-tool');
        expect(unknown?.tool).toBe(UNKNOWN_TOOL);
        expect(Object.keys(sample().toolMap)).not.toContain(UNKNOWN_TOOL);
    });

    it('чтение ждёт выдачу содержимого, запись и удаление — изменение', () => {
        const effect = (id: string) => probes.find((p) => p.id === id)?.effect;
        expect(effect('rule:Read:secret')).toBe('content');
        expect(effect('rule:Read:allowed')).toBe('content');
        expect(effect('rule:Bash:destructive')).toBe('mutation');
    });

    it('косвенная запись скриптом не несёт защищённый путь строкой', () => {
        const indirect = probes.find((p) => p.id === 'sandbox:indirect-contour');
        expect(JSON.stringify(indirect?.input)).not.toContain(PROBE_TARGETS.contour);
    });
});

/** Инварианты любой матрицы: заявления годны, id различны, пара — разрешённая той же матрицы. */
function invariants(d: HarnessDescriptor) {
    const { probes } = probeMatrix(d);
    expect(probes.flatMap(probeSpecProblems)).toEqual([]);
    expect(new Set(probes.map((p) => p.id)).size).toBe(probes.length);
    const positives = new Set(probes.filter((p) => p.polarity === 'positive').map((p) => p.id));
    for (const n of probes.filter((p) => p.polarity === 'negative')) {
        expect(positives.has(n.pair!), `${n.id} → ${String(n.pair)}`).toBe(true);
    }
    return probes;
}

describe('описания пакетов дерева', () => {
    const dir = import.meta.dirname;
    const packages = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map((e) => e.name);

    it('пакеты есть — скан не пустой', () => {
        expect(packages.length).toBeGreaterThanOrEqual(3);
    });

    it.each(packages)('%s: матрица без проблем, у каждой отрицательной пара', (name) => {
        const file = path.join(dir, name, 'descriptor.json');
        const d = parseHarnessDescriptor(JSON.parse(readFileSync(file, 'utf-8')), file);
        expect(probeMatrix(d).problems).toEqual([]);
        const probes = invariants(d);
        // Каждый инструмент описания получил пробу: отставание матрицы от описания — красное.
        for (const tool of Object.keys(d.toolMap)) {
            expect(
                probes.some((p) => p.tool === tool),
                tool,
            ).toBe(true);
        }
    });

    it('образец удовлетворяет тем же инвариантам', () => {
        invariants(sample());
    });
});

describe('элементы описания, которых нет в образце', () => {
    const wide = (): HarnessDescriptor => {
        const d = sample();
        return {
            ...d,
            toolMap: {
                ...d.toolMap,
                Write: 'write',
                Rm: 'delete',
                Mv: 'move',
                Grep: 'search',
                Fetch: 'fetch',
                Task: 'agent',
                Wake: 'defer',
                Mcp: 'mcp',
            },
            argMap: {
                ...d.argMap,
                Write: { path: 'file_path' },
                Rm: { path: 'file_path' },
                Mv: { path: 'from', destination: 'to' },
                Grep: { root: 'path', pathGlob: 'glob', contentPattern: 'pattern' },
                Fetch: { url: 'url' },
            },
            allowedFields: {
                envelope: d.allowedFields.envelope,
                tools: {
                    ...d.allowedFields.tools,
                    Write: ['file_path', 'content'],
                    Rm: ['file_path'],
                    Mv: ['from', 'to'],
                    Grep: ['path', 'glob', 'pattern'],
                    Fetch: ['url'],
                    Task: ['prompt'],
                    Wake: ['delaySeconds'],
                    Mcp: [],
                },
            },
            eventCoverage: {
                ...d.eventCoverage,
                exec_command: { mode: 'disabled', evidence: 'образец' },
            },
        };
    };

    it('каждая операция — свои пробы и коды; канал выключен — проба без события', () => {
        const probes = invariants(wide());
        const rows = new Map(probes.map((p) => [p.id, row(p)]));
        expect(rows.get('rule:Write:contour')).toEqual([
            'rule:Write:contour',
            'negative',
            'contour-data',
            'rule:Write:allowed',
        ]);
        expect(rows.get('rule:Write:surface:.sample/config.json')?.[2]).toBe('config-surface');
        expect(rows.get('rule:Rm:secret')?.[2]).toBe('secret-env');
        expect(probes.find((p) => p.id === 'rule:Mv:contour')?.input).toEqual({
            from: PROBE_TARGETS.allowedWrite,
            to: PROBE_TARGETS.contour,
        });
        expect(probes.find((p) => p.id === 'rule:Grep:secret-root')?.input).toEqual({
            path: '.',
            pattern: 'ralph',
        });
        expect(probes.find((p) => p.id === 'rule:Grep:secret-glob')?.input).toEqual({
            path: '.',
            pattern: 'ralph',
            glob: '**/.env',
        });
        // fetch барьер пока не судит, agent и defer в петле запрещены (#225): пара — общая
        // разрешённая канала.
        expect(rows.get('rule:Fetch:unjudged')).toEqual([
            'rule:Fetch:unjudged',
            'negative',
            'capability-unjudged',
            'rule:Bash:allowed',
        ]);
        expect(rows.get('rule:Task:delegation')).toEqual([
            'rule:Task:delegation',
            'negative',
            'loop-delegation',
            'rule:Bash:allowed',
        ]);
        expect(rows.get('rule:Wake:delegation')?.[2]).toBe('loop-delegation');
        expect(rows.get('rule:Mcp:mcp-write')?.[2]).toBe('mcp-not-allowed');
        const disabled = probes.find((p) => p.id === 'disabled-channel:exec_command');
        expect(disabled).toMatchObject({ kind: 'disabled-channel', pair: 'rule:Bash:allowed' });
        expect(probes.some((p) => p.id === 'registration:exec_command:accepted')).toBe(false);
    });

    it('поиск без шаблона содержимого — только имена: разрешённая есть, отрицательных нет', () => {
        const d = wide();
        const { probes } = probeMatrix({
            ...d,
            argMap: { ...d.argMap, Grep: { root: 'path', pathGlob: 'glob' } },
        });
        expect(probes.find((p) => p.id === 'rule:Grep:allowed')?.input).toEqual({
            path: PROBE_TARGETS.allowedSearch,
        });
        expect(probes.some((p) => p.id.startsWith('rule:Grep:secret'))).toBe(false);
    });

    it('минимальный вход probeInputs — под полями ролей у разрешённой и отрицательной', () => {
        const d = wide();
        const { probes } = probeMatrix({
            ...d,
            probeInputs: { Grep: { pattern: 'base', path: 'base' } },
        });
        expect(probes.find((p) => p.id === 'rule:Grep:allowed')?.input).toEqual({
            path: PROBE_TARGETS.allowedSearch,
            pattern: 'ralph',
        });
        expect(probes.find((p) => p.id === 'rule:Grep:secret-root')?.input).toMatchObject({
            path: '.',
        });
    });

    it('fetch без роли url — проба без поля, а не догадка', () => {
        const d = wide();
        const { probes } = probeMatrix({ ...d, argMap: { ...d.argMap, Fetch: {} } });
        expect(probes.find((p) => p.id === 'rule:Fetch:unjudged')?.input).toEqual({});
    });

    it('незнакомый инструмент не совпадает с занятым именем', () => {
        const d = wide();
        const taken = {
            ...d,
            toolMap: { ...d.toolMap, [UNKNOWN_TOOL]: 'inert' as const },
            allowedFields: {
                ...d.allowedFields,
                envelope: [...d.allowedFields.envelope, UNKNOWN_FIELD],
                tools: { ...d.allowedFields.tools, [UNKNOWN_TOOL]: [] },
            },
        };
        const { probes } = probeMatrix(taken);
        expect(probes.find((p) => p.id === 'rule:unknown-tool')?.tool).toBe(`${UNKNOWN_TOOL}_2`);
        expect(probes.find((p) => p.id === 'rule:unknown-envelope-field')?.envelopeExtra).toEqual({
            [`${UNKNOWN_FIELD}_2`]: 1,
        });
    });
});

describe('чего описание не даёт — проблема матрицы', () => {
    it('операции нужна роль, которой нет в argMap', () => {
        const d = sample();
        const { problems, probes } = probeMatrix({ ...d, argMap: { Read: d.argMap.Read } });
        expect(problems).toEqual([
            'toolMap.Bash: операции exec нужна роль command в argMap — пробу собрать не из чего',
            'в toolMap нет оболочки с argMap.command — песочницу пробовать нечем',
        ]);
        expect(probes.some((p) => p.tool === 'Bash')).toBe(false);
    });

    it.each([
        ['write', { Write: 'write' }, {}, /роль path/],
        ['move', { Mv: 'move' }, { Mv: { path: 'from' } }, /роль destination/],
        ['search', { Grep: 'search' }, {}, /роль root/],
        ['read', { Cat: 'read' }, {}, /роль path/],
    ] as const)('%s без своей роли — проблема', (_op, toolMap, argMap, why) => {
        const d = sample();
        const fields = Object.fromEntries(Object.keys(toolMap).map((t) => [t, ['from']]));
        const { problems } = probeMatrix({
            ...d,
            toolMap: { ...d.toolMap, ...toolMap },
            argMap: { ...d.argMap, ...argMap },
            allowedFields: { ...d.allowedFields, tools: { ...d.allowedFields.tools, ...fields } },
        });
        expect(problems.join('\n')).toMatch(why);
    });

    it('незнакомая операция — проблема, а не тишина', () => {
        const d = sample();
        const { problems } = probeMatrix({
            ...d,
            toolMap: { ...d.toolMap, Odd: 'teleport' as never },
            allowedFields: { ...d.allowedFields, tools: { ...d.allowedFields.tools, Odd: [] } },
        });
        expect(problems).toContain('toolMap.Odd: незнакомая операция "teleport"');
    });

    it('ни одной разрешённой — проблема: паре взяться неоткуда', () => {
        const d = sample();
        const { problems } = probeMatrix({
            ...d,
            toolMap: { Task: 'agent' },
            argMap: {},
            allowedFields: { ...d.allowedFields, tools: { Task: [] } },
        });
        expect(problems).toContain(
            'матрица без единой разрешённой пробы — паре отрицательных взяться неоткуда',
        );
    });
});

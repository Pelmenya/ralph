// Схема эффектов MCP и мигратор данных (#185): мигрированные данные канона решают так же,
// как прежнее правило префикса, а битые или неполные эффекты — отказ разбора, то есть блок.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConsumerData } from './consumer-data.cjs';
import { decide, mcpAllowed, mcpAllowedByEffect } from './guard-rules.cjs';
import {
    decisionDrift,
    equivalenceProblems,
    migrateMcpEffects,
    toolsFreshness,
} from './mcp-effects.cjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CANON = readFileSync(path.join(ROOT, '.claude/ralph/hooks.json'), 'utf-8');

const sc = (method: string) => `mcp__sourcecraft__${method}`;

// Инвентарь контура канона: чтения, которые петля зовёт, мутации цикла и то, что барьер обязан
// держать закрытым, — секреты, права, одобрение, удаление, неизвестная мутация, неоднозначное имя.
const INVENTORY = [
    ...['ListIssues', 'GetIssue', 'GetPullRequest', 'ListRepositoryIssues'].map(sc),
    ...['CreateIssue', 'UpdateIssue', 'MergePullRequest', 'DiscardPullRequest'].map(sc),
    ...['ListSecrets', 'GetSecretOperationByID', 'SetSecret', 'SetDecision'].map(sc),
    ...['SetDecisionByID', 'DeleteRepository', 'DeleteIssue', 'DiscardByTag'].map(sc),
    ...['AddRepoRoles', 'CreateOrganizationInvites', 'UpdateRepository'].map(sc),
    sc('SomeBrandNewMethod'),
    'mcp__other_server__list_items',
    'mcp__sync__get__CreateReport',
];

describe('мигратор на данных канона', () => {
    const before = parseConsumerData(CANON).mcp;
    const { text, changed } = migrateMcpEffects(CANON, INVENTORY);
    const after = parseConsumerData(text).mcp;
    const names = [...new Set([...INVENTORY, ...before.writeAllowed])];

    it('разрешённое разрешено, запрещённое запрещено — на каждом имени контура', () => {
        expect(changed).toBe(true);
        const allowed = names.filter((n) => mcpAllowed(n, before));
        const denied = names.filter((n) => !mcpAllowed(n, before));
        expect(allowed.filter((n) => !mcpAllowedByEffect(n, after))).toEqual([]);
        expect(denied.filter((n) => mcpAllowedByEffect(n, after))).toEqual([]);
        // От противного: в обеих группах есть что сверять.
        expect(allowed).toEqual(expect.arrayContaining([sc('ListIssues'), sc('CreateIssue')]));
        expect(denied).toEqual(
            expect.arrayContaining([sc('ListSecrets'), sc('SetDecision'), sc('DiscardByTag')]),
        );
    });

    it('мутации — write, чтения по префиксу — read, запрещённым записи нет', () => {
        expect(after.tools.get(sc('CreateIssue'))).toBe('write');
        expect(after.tools.get(sc('DiscardPullRequest'))).toBe('write');
        expect(after.tools.get(sc('GetIssue'))).toBe('read');
        expect(after.tools.get('mcp__other_server__list_items')).toBe('read');
        for (const n of [sc('ListSecrets'), sc('SetDecision'), 'mcp__sync__get__CreateReport']) {
            expect(after.tools.has(n)).toBe(false);
        }
    });

    it('guard пока судит по-прежнему: мигрированные данные решений decide не меняют', () => {
        const blocked = (n: string, mcp: typeof before) =>
            decide(n, {}, { contour: { mcp } }).blocked;
        expect(names.filter((n) => blocked(n, before) !== blocked(n, after))).toEqual([]);
    });

    it('остальные данные переезжают как есть; повтор миграции ничего не меняет', () => {
        expect(after.writeAllowed).toEqual(before.writeAllowed);
        expect(JSON.parse(text).mcp.notes).toEqual(JSON.parse(CANON).mcp.notes);
        expect(parseConsumerData(text).skills.files).toHaveLength(1);
        expect(migrateMcpEffects(text, INVENTORY)).toEqual({
            text,
            changed: false,
            stale: [],
            unlisted: [],
        });
    });

    // Намеренное ужесточение контракта: чтение, которого нет в политике, — `unknown`.
    it('чтение вне инвентаря после переключения блокируется', () => {
        expect(mcpAllowed(sc('ListMilestones'), before)).toBe(true);
        expect(mcpAllowedByEffect(sc('ListMilestones'), after)).toBe(false);
    });
});

describe('мигратор: отказ вместо дефолта', () => {
    it('пустой или не MCP инвентарь — отказ: он снял бы чтения молча', () => {
        expect(() => migrateMcpEffects(CANON, [])).toThrow('инвентарь инструментов пуст');
        expect(() => migrateMcpEffects(CANON, ['ListIssues'])).toThrow('не MCP-имена');
    });

    it('битые данные — исключение разбора, а не миграция', () => {
        expect(() => migrateMcpEffects('{"mcp": []}', INVENTORY)).toThrow('mcp — не объект');
    });

    it('данные без mcp получают пустой контур мутаций и только чтения', () => {
        const { text } = migrateMcpEffects('{}', [sc('ListIssues'), sc('CreateIssue')]);
        expect(JSON.parse(text).mcp.tools).toEqual({ [sc('ListIssues')]: { effect: 'read' } });
    });

    // От противного: сверка мигратора видит расхождение решений.
    it('сверка решений называет имя, на котором эффекты разошлись с префиксом', () => {
        const before = parseConsumerData('{}').mcp;
        const after = parseConsumerData(
            `{"mcp": {"tools": {"${sc('GetIssue')}": {"effect": "read"}}}}`,
        ).mcp;
        expect(decisionDrift(before, after, [sc('GetIssue'), sc('ListIssues')])).toEqual([
            sc('ListIssues'),
        ]);
    });
});

describe('схема mcp.tools: битые и неполные эффекты — отказ разбора', () => {
    const tools = (value: unknown, writeAllowed: string[] = []) =>
        JSON.stringify({ mcp: { writeAllowed, tools: value } });

    it.each([
        [tools([]), 'mcp.tools — не объект'],
        [tools({ ListIssues: { effect: 'read' } }), 'имя не MCP-инструмента'],
        [tools({ [sc('ListIssues')]: 'read' }), 'не объект'],
        [tools({ [sc('ListIssues')]: {} }), '.effect — не read/write'],
        [tools({ [sc('ListIssues')]: { effect: 'unknown' } }), '.effect — не read/write'],
        [tools({ [sc('ListIssues')]: { effect: 'read', why: 'x' } }), 'незнакомые ключи why'],
        [
            tools({}, [sc('CreateIssue')]),
            `mcp.tools неполон: нет эффекта write у ${sc('CreateIssue')}`,
        ],
        [tools({ [sc('CreateIssue')]: { effect: 'read' } }, [sc('CreateIssue')]), 'неполон'],
        [tools({ [sc('CreateIssue')]: { effect: 'write' } }), 'write вне mcp.writeAllowed'],
    ])('%s → %s', (text, what) => {
        expect(() => parseConsumerData(text, 'hooks.json')).toThrow(what);
    });

    it('без mcp.tools — пустая карта эффектов: прежние данные разбираются как раньше', () => {
        expect(parseConsumerData(CANON).mcp.tools.size).toBe(0);
    });

    it('по эффектам: нет записи — блок, запрет по слову сильнее read, вычет — только write', () => {
        const mcp = parseConsumerData(
            tools(
                {
                    [sc('ListSecrets')]: { effect: 'read' },
                    [sc('DiscardPullRequest')]: { effect: 'write' },
                },
                [sc('DiscardPullRequest')],
            ),
        ).mcp;
        expect(mcpAllowedByEffect(sc('GetIssue'), mcp)).toBe(false);
        expect(mcpAllowedByEffect(sc('ListSecrets'), mcp)).toBe(false);
        expect(mcpAllowedByEffect(sc('DiscardPullRequest'), mcp)).toBe(false);
        const excepted = { ...mcp, neverExceptions: new Set([sc('DiscardPullRequest')]) };
        expect(mcpAllowedByEffect(sc('DiscardPullRequest'), excepted)).toBe(true);
        expect(mcpAllowedByEffect(sc('GetIssue'))).toBe(false);
    });
});

describe('эквивалентность и свежесть (#218)', () => {
    const legacy = parseConsumerData(CANON).mcp;
    const migrated = parseConsumerData(migrateMcpEffects(CANON, INVENTORY).text).mcp;
    const names = [...new Set([...INVENTORY, ...legacy.writeAllowed])];

    it('честная миграция эквивалентна на решениях guard на событии', () => {
        expect(equivalenceProblems(legacy, migrated, names)).toEqual([]);
    });

    // От противного: каждый класс расхождения назван.
    it('снятый вычет, сменённый writeAllowed и снятое чтение — каждое названо', () => {
        const tampered = parseConsumerData(
            JSON.stringify({
                mcp: {
                    writeAllowed: [...legacy.writeAllowed],
                    tools: Object.fromEntries(
                        [...migrated.tools]
                            .filter(([n]) => n !== sc('GetIssue'))
                            .map(([n, e]) => [n, { effect: e }]),
                    ),
                },
            }),
        ).mcp;
        const problems = equivalenceProblems(legacy, tampered, names);
        expect(problems).toContain('mcp.neverExceptions изменился при миграции');
        expect(problems).toContain(
            `решение по ${sc('GetIssue')} разошлось с прежним: был разрешён, стал запрещён`,
        );
        expect(problems).toContain(
            `решение по ${sc('DiscardPullRequest')} разошлось с прежним: был разрешён, стал запрещён`,
        );
    });

    it('свежесть: исчезнувшее чтение — stale, новое чтение по префиксу — unlisted', () => {
        const fresh = [...INVENTORY.filter((n) => n !== sc('GetIssue')), sc('GetMilestone')];
        expect(toolsFreshness(migrated, fresh)).toEqual({
            stale: [sc('GetIssue')],
            unlisted: [sc('GetMilestone')],
        });
    });

    it('уже мигрированные данные сверяются с инвентарём, а не выходят молча', () => {
        const text = migrateMcpEffects(CANON, INVENTORY).text;
        expect(migrateMcpEffects(text, [sc('ListIssues')])).toMatchObject({
            changed: false,
            stale: expect.arrayContaining([sc('GetIssue')]) as string[],
        });
        expect(() => migrateMcpEffects(text, [])).toThrow('инвентарь инструментов пуст');
    });
});

// Сценарные тесты покрывают известные места запуска правок, поэтому новый вызов без плана
// проходил бы мимо них. Этот структурный барьер читает сам оркестратор и проверяет объект
// аргумента каждого вызова, включая многострочные объекты и вложенные вызовы (#249).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    type Expression,
    isCallExpression,
    isIdentifier,
    isObjectLiteralExpression,
    isPropertyAssignment,
    isShorthandPropertyAssignment,
    isStringLiteral,
    type Node,
} from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { describe, expect, it } from 'vitest';

const FIX_PROMPT_BUILDERS = new Set(['buildFixByReviewPrompt', 'buildBlockedFixPrompt']);

function hasOwnPlan(argument: Expression | undefined): boolean {
    if (argument === undefined || !isObjectLiteralExpression(argument)) return false;

    return argument.properties.some((property) => {
        if (isShorthandPropertyAssignment(property)) {
            const name = property.name;
            return isIdentifier(name) && name.text === 'plan';
        }
        if (!isPropertyAssignment(property)) return false;
        const name = property.name;
        return (isIdentifier(name) || isStringLiteral(name)) && name.text === 'plan';
    });
}

function parseSource(lines: string[]) {
    const fileName = '/fix-plan-wiring.ts';
    const api = new API({
        fs: createVirtualFileSystem({ [fileName]: lines.join('\n') }),
    });
    try {
        const snapshot = api.updateSnapshot({ openFiles: [fileName] });
        const source = snapshot.getDefaultProjectForFile(fileName)?.program.getSourceFile(fileName);
        if (source === undefined)
            throw new Error('TypeScript не вернул AST проверяемого источника');
        return source;
    } finally {
        api.close();
    }
}

function checkFixPlanWiring(lines: string[]) {
    const source = parseSource(lines);
    const missingPlan: number[] = [];
    let calls = 0;

    function visit(node: Node) {
        if (
            isCallExpression(node) &&
            isIdentifier(node.expression) &&
            FIX_PROMPT_BUILDERS.has(node.expression.text)
        ) {
            calls++;
            if (!hasOwnPlan(node.arguments[0])) {
                missingPlan.push(
                    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                );
            }
        }
        node.forEachChild(visit);
    }

    visit(source);
    return { calls, missingPlan };
}

describe('промпт сессии правок оркестратора: план в каждом вызове', () => {
    const SRC = readFileSync(join(import.meta.dirname, 'orchestrator.ts'), 'utf-8').split('\n');
    const wiring = checkFixPlanWiring(SRC);

    it('вызовы промптов правок вообще находятся — иначе проверка пуста', () => {
        expect(wiring.calls).toBeGreaterThan(0);
    });

    it('каждый объект первого аргумента содержит собственное plan верхнего уровня', () => {
        expect(wiring.missingPlan).toEqual([]);
    });

    it.each([
        [
            'без поля plan',
            [
                'return buildFixByReviewPrompt({',
                '    branch,',
                '    commentsContext: comments,',
                '    resumed,',
                '});',
            ],
        ],
        [
            'plan только во вложенном объекте',
            [
                'return buildFixByReviewPrompt({',
                '    context: {',
                '        plan: nestedPlan,',
                '    },',
                '});',
            ],
        ],
        [
            'plan только в обычной строке',
            ['return buildFixByReviewPrompt({', '    commentsContext: "plan: not a field",', '});'],
        ],
        [
            'plan только в многострочной строке',
            [
                'return buildFixByReviewPrompt({',
                '    commentsContext: `текст',
                'plan: not a field`,',
                '});',
            ],
        ],
        [
            'plan только в комментарии',
            [
                'return buildFixByReviewPrompt({',
                '    // plan: not a field',
                '    commentsContext: comments,',
                '});',
            ],
        ],
        ['plan приходит только через spread', ['return buildFixByReviewPrompt({ ...options });']],
        ['первый аргумент не объект', ['return buildFixByReviewPrompt(options);']],
    ])('от противного: %s', (_name, source) => {
        expect(checkFixPlanWiring(source)).toEqual({ calls: 1, missingPlan: [1] });
    });

    it.each([
        [
            'явное верхнее поле',
            [
                'return buildBlockedFixPrompt({',
                '    commentsContext: "скобки ) и ( не меняют структуру",',
                '    plan: formatFixPlan(blockedPlan),',
                '});',
            ],
        ],
        [
            'shorthand верхнего уровня',
            [
                'return buildFixByReviewPrompt({',
                '    plan,',
                '    commentsContext: `скобки ) и ( не меняют структуру`,',
                '});',
            ],
        ],
    ])('принимает %s', (_name, source) => {
        expect(checkFixPlanWiring(source)).toEqual({ calls: 1, missingPlan: [] });
    });

    it('строки импорта не считаются вызовами', () => {
        expect(
            checkFixPlanWiring(["import { buildFixByReviewPrompt } from './prompts.ts';"]),
        ).toEqual({ calls: 0, missingPlan: [] });
    });
});

// Живой старт раннера на сломанном барьере (канон, задача 6): петля обязана встать ДО
// первой сессии. Юнит-тесты `core/guard-probe.test.ts` доказывают вердикт пробы; здесь —
// что вердикт действительно останавливает `main()`, а не пишет строку в лог и идёт дальше.
//
// Доказательство «сессии не было» — файл, который пишет шим кодера на первой же строке:
// его нет — кодер не запускался. Код выхода и текст отказа без него ничего не доказывали
// бы: раннер мог упасть и позже, уже сжегши сессию.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    buildLiveSandbox,
    removeLiveSandbox,
    runLiveCycle,
    type LiveSandbox,
    type LiveSandboxOptions,
} from './live-sandbox.ts';
import { coreIsRepoRoot } from './core-repo.ts';

// Срок — как у соседнего живого набора: настоящий git и раннер в песочнице.
vi.setConfig({ testTimeout: 30_000 });

const built: LiveSandbox[] = [];
afterEach(() => {
    for (const sb of built.splice(0)) removeLiveSandbox(sb);
});

function startWith(options: LiveSandboxOptions) {
    const sb = buildLiveSandbox(options);
    built.push(sb);
    const run = runLiveCycle(sb);
    expect(run.timedOut, run.output).toBe(false);
    return { ...run, coderRan: fs.existsSync(path.join(sb.root, 'coder-prompt.txt')) };
}

describe('проба барьера останавливает петлю до первой сессии', () => {
    // Хук потребителя, который отказывает сам, — тоже часть собранного settings: Claude Code
    // не послушал бы его кода 1, и проба это видит.
    it.each([
        [
            'хук потребителя падает кодом 1 — Claude Code его не послушал бы',
            'node -e "process.exit(1)"',
        ],
        ['файла хука потребителя нет', 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/missing.cjs"'],
    ] as const)('%s → старт отменён, кодер не запускался', (_why, guardHook) => {
        const run = startWith({ guardHook });
        expect(run.code, run.output).not.toBe(0);
        expect(run.output).toContain('Проба барьера');
        expect(run.coderRan, 'кодер-сессия успела стартовать на сломанном барьере').toBe(false);
    });

    // Раскладка с `roots`: барьер сессии — guard ЯДРА (задача 101). Сломан он — стоп; хук
    // потребителя, который пропускает всё или отсутствует, барьер не снимает: он
    // добавляется к хукам ядра, а не заменяет их. Guard продукта есть только у ядра —
    // корня своего репозитория (`core-repo.ts`).
    it.skipIf(!coreIsRepoRoot()).each([
        ['guard ядра пропускает всё', 'process.exit(0);\n'],
        ['guard ядра падает кодом 1', 'process.exit(1);\n'],
        ['guard ядра нет', null],
    ] as const)('%s → старт отменён, кодер не запускался', (_why, productGuard) => {
        const run = startWith({ productGuard });
        expect(run.code, run.output).not.toBe(0);
        expect(run.output).toContain('Проба барьера');
        expect(run.coderRan, 'кодер-сессия успела стартовать на сломанном барьере').toBe(false);
    });

    it.skipIf(!coreIsRepoRoot()).each([
        ['настроек хуков у потребителя нет вовсе', null],
        ['хук потребителя пропускает всё', 'node -e "process.exit(0)"'],
    ] as const)('%s — барьер ядра держит, старт идёт', (_why, guardHook) => {
        const run = startWith({ guardHook });
        expect(run.code, run.output).toBe(0);
        expect(run.output).toContain('Проба барьера пройдена');
        expect(run.coderRan).toBe(true);
    });

    // Исправный барьер — guard продукта из `.claude/hooks/` канона; у копии ядра в дереве
    // потребителя его нет по построению (`core-repo.ts`).
    it.skipIf(!coreIsRepoRoot())(
        'исправный барьер продукта пропускает старт до кодер-сессии',
        () => {
            const run = startWith({});
            expect(run.code, run.output).toBe(0);
            expect(run.output).toContain('Проба барьера пройдена');
            expect(run.coderRan).toBe(true);
        },
    );
});

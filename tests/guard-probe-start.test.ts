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
    it.each([
        ['настроек хуков нет вовсе', null],
        ['хук пропускает всё', 'node -e "process.exit(0)"'],
        ['хук падает кодом 1 — Claude Code его не послушал бы', 'node -e "process.exit(1)"'],
        ['файла хука нет', 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/missing.cjs"'],
    ] as const)('%s → старт отменён, кодер не запускался', (_why, guardHook) => {
        const run = startWith({ guardHook });
        expect(run.code, run.output).not.toBe(0);
        expect(run.output).toContain('Проба барьера');
        expect(run.coderRan, 'кодер-сессия успела стартовать на сломанном барьере').toBe(false);
    });

    it('исправный барьер продукта пропускает старт до кодер-сессии', () => {
        const run = startWith({});
        expect(run.code, run.output).toBe(0);
        expect(run.output).toContain('Проба барьера пройдена');
        expect(run.coderRan).toBe(true);
    });
});

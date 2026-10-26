import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { bypassProfiles, checkGuardWiring, GUARD_FILE } from './guard-wiring.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const readJson = (rel: string): unknown => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf-8'));

/**
 * Конфиг раннера с одним профилем — минимум, достаточный для сверки.
 *
 * Объявлен ДО боевой проводки: в каноне конфиг раннера принадлежит ПОТРЕБИТЕЛЮ и в дерево
 * не коммитится (`.gitignore`), поэтому «как в бою» сверяется с конфигом под
 * `bypassPermissions` — ровно тем режимом, в котором петля идёт на каноне ночью.
 */
const config = (permissionMode: string) => ({
    common: { permissionMode },
    profiles: { prod: {} },
});

/** Проводка «как в бою»: настройки этого репозитория и раннер под bypass. */
const live = () => ({
    settings: readJson('.claude/settings.json'),
    ralphConfig: config('bypassPermissions'),
    guardExists: existsSync(path.join(ROOT, '.claude/hooks', GUARD_FILE)),
});

const GUARD_TAIL = `.claude/hooks/${GUARD_FILE}`;

const GUARD_HOOK = {
    type: 'command',
    command: `node "\${CLAUDE_PROJECT_DIR}/${GUARD_TAIL}"`,
};

/** Настройки с одним PreToolUse-хуком guard'а и заданным matcher'ом. */
const settingsWith = (matcher: unknown, hook: Record<string, unknown> = GUARD_HOOK) => ({
    hooks: { PreToolUse: [{ matcher, hooks: [hook] }] },
});

const FULL_MATCHER = 'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|mcp__.*';

describe('bypassPermissions и guard связаны машиной, а не дисциплиной (#138)', () => {
    it('боевая проводка сходится: bypass есть, guard на месте и накрывает всё', () => {
        expect(checkGuardWiring(live())).toEqual([]);
    });
});

describe('сверка краснеет, когда барьера нет, он сужен или его файла нет', () => {
    it('хука нет вовсе — bypass остался без единого барьера', () => {
        const problems = checkGuardWiring({
            settings: { hooks: {} },
            ralphConfig: config('bypassPermissions'),
            guardExists: true,
        });

        expect(problems.length).toBeGreaterThan(0);
        expect(problems.join('\n')).toContain(GUARD_FILE);
    });

    it('matcher сужен — MCP-мутации открылись бы молча', () => {
        const problems = checkGuardWiring({
            settings: settingsWith('Bash|Read|Edit|Write'),
            ralphConfig: config('bypassPermissions'),
            guardExists: true,
        });

        expect(problems.join('\n')).toContain('mcp__');
    });

    it('matcher сужен до одного инструмента — названы все непокрытые', () => {
        const problems = checkGuardWiring({
            settings: settingsWith('Bash'),
            ralphConfig: config('bypassPermissions'),
            guardExists: true,
        });

        for (const tool of ['Read', 'Edit', 'Write', 'mcp__']) {
            expect(problems.join('\n')).toContain(tool);
        }
    });

    it('файла guard нет на диске — хук в настройках описывает пустоту', () => {
        const problems = checkGuardWiring({
            settings: settingsWith(FULL_MATCHER),
            ralphConfig: config('bypassPermissions'),
            guardExists: false,
        });

        expect(problems.join('\n')).toContain('не найден');
    });
});

describe("проводка отменяется не только matcher'ом (ревью Codex terra, проход 1)", () => {
    const withBypass = (settings: unknown) =>
        checkGuardWiring({
            settings,
            ralphConfig: config('bypassPermissions'),
            guardExists: true,
        }).join('\n');

    it('disableAllHooks выключает всё разом, не тронув ни одной записи', () => {
        expect(withBypass({ ...settingsWith(FULL_MATCHER), disableAllHooks: true })).toContain(
            'disableAllHooks',
        );
    });

    it("условие `if` сужает вызов мимо matcher'а", () => {
        expect(
            withBypass(settingsWith(FULL_MATCHER, { ...GUARD_HOOK, if: 'Bash(npm run *)' })),
        ).toContain('if');
    });

    it('once — барьер на один вызов за сессию', () => {
        expect(withBypass(settingsWith(FULL_MATCHER, { ...GUARD_HOOK, once: true }))).toContain(
            'once',
        );
    });

    it('async — хук отвечает, когда инструмент уже отработал', () => {
        expect(withBypass(settingsWith(FULL_MATCHER, { ...GUARD_HOOK, async: true }))).toContain(
            'async',
        );
    });

    it('хук другого типа притворился барьером — исправного нет вовсе', () => {
        const hook = { type: 'prompt', prompt: `посмотри ${GUARD_FILE}` };

        expect(withBypass(settingsWith(FULL_MATCHER, hook))).toContain('нет PreToolUse-хука');
    });

    it('команда лишь упоминает имя барьера, но не запускает его', () => {
        const hook = { type: 'command', command: `echo ${GUARD_FILE}` };

        expect(withBypass(settingsWith(FULL_MATCHER, hook))).toContain('не равна одному запуску');
    });

    // Проходы 2 и 3 ревью: у команды хука проверяется ФОРМА, потому что перечисление
    // способов погасить отказ проигрывало по новому способу за проход.
    it.each([
        ['склейка гасит код возврата', `${GUARD_HOOK.command} || true`],
        ['node --check файл не исполняет', `node --check ".claude/hooks/${GUARD_FILE}"`],
        ['пустой stdin даёт выход нулём', `${GUARD_HOOK.command} < /dev/null`],
        ['вторая строка возвращает свой код', `${GUARD_HOOK.command}\ntrue`],
        ['флаг после имени файла', `${GUARD_HOOK.command} --check`],
        ['stderr уведён из канала отказа', `${GUARD_HOOK.command} 2>&1`],
    ])('не один запуск node: %s', (_name, command) => {
        expect(withBypass(settingsWith(FULL_MATCHER, { ...GUARD_HOOK, command }))).toContain(
            'не равна одному запуску',
        );
    });

    // Каждая форма нашлась своим проходом ревью: перечисление серверов — проходом 1,
    // класс имён — вторым, чужое слово и обязательный префикс — третьим и четвёртым.
    it.each([
        [
            'перечислены подключённые серверы',
            'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|mcp__(?:a|b|c)__.*',
        ],
        [
            'класс имён — мимо идёт имя с цифрой',
            'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|mcp__[a-z-]+__.*',
        ],
        [
            'чужое слово перед каноном',
            'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|notmcp__.*',
        ],
        [
            'канон внутри обязательного префикса',
            'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|prefix(mcp__.*)',
        ],
    ])('MCP покрыт не полностью: %s', (_name, matcher) => {
        expect(withBypass(settingsWith(matcher))).toContain('mcp__');
    });

    it('широкая форма в незахватывающей группе — законна и проходит', () => {
        // Проход 4 ревью: сверка по литералу краснела на двоеточии перед `mcp`.
        expect(
            withBypass(
                settingsWith('Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|(?:mcp__.*)'),
            ),
        ).toBe('');
    });

    it.each([
        ['тёзка по суффиксу', 'node /tmp/not-guard.cjs'],
        ['барьер соседнего проекта', `node "\${OTHER_PROJECT}/.claude/hooks/${GUARD_FILE}"`],
        ['чужой абсолютный путь', `node /opt/foreign/.claude/hooks/${GUARD_FILE}`],
    ])('запускается не наш файл: %s', (_name, command) => {
        expect(withBypass(settingsWith(FULL_MATCHER, { ...GUARD_HOOK, command }))).toContain(
            'не равна одному запуску',
        );
    });

    it('законная широкая ветка MCP в группе проходит, сужение — нет', () => {
        // Проход 5 ревью: набор проб накрывался `mcp__[\w-]+__\w+$`, поэтому решение
        // принимается разбором альтернатив, а не примерами имён.
        expect(
            withBypass(
                settingsWith('Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|^(?:mcp__.*)$'),
            ),
        ).toBe('');
        expect(
            withBypass(
                settingsWith('Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|mcp__[\\w-]+__\\w+'),
            ),
        ).toContain('mcp__');
    });

    it('именованная группа — такая же законная обёртка', () => {
        // Проход 6 ревью: без этого исправный matcher краснел на имени группы.
        expect(
            withBypass(
                settingsWith('Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|(?<mcp>mcp__.*)'),
            ),
        ).toBe('');
    });

    // Разрешённые записи закрепляются тестом наравне с запрещёнными: без этого поломка
    // законной формы не покраснеет, а обнаружится сессией, у которой встал барьер
    // (проход 9 ревью).
    it.each([
        ['переменная в фигурных скобках, в кавычках', GUARD_HOOK.command],
        ['переменная без скобок, в кавычках', `node "$CLAUDE_PROJECT_DIR/${GUARD_TAIL}"`],
        ['переменная в фигурных скобках, без кавычек', `node \${CLAUDE_PROJECT_DIR}/${GUARD_TAIL}`],
        ['переменная без скобок и без кавычек', `node $CLAUDE_PROJECT_DIR/${GUARD_TAIL}`],
    ])('законная запись команды: %s', (_name, command) => {
        expect(withBypass(settingsWith(FULL_MATCHER, { ...GUARD_HOOK, command }))).toBe('');
    });

    it('сосед, упомянувший барьер в описании, второй записью не считается', () => {
        // Ложный красный тут дороже: он краснит исправную проводку (проход 2 ревью).
        const telemetry = { type: 'command', command: 'node ./tools/telemetry.js' };
        const settings = {
            hooks: {
                PreToolUse: [
                    { matcher: FULL_MATCHER, hooks: [GUARD_HOOK] },
                    {
                        matcher: 'Bash',
                        hooks: [{ ...telemetry, statusMessage: `Проверка ${GUARD_FILE}` }],
                    },
                ],
            },
        };

        expect(withBypass(settings)).toBe('');
    });

    it('путь от корня репозитория — законная вторая форма', () => {
        const hook = { type: 'command', command: `node ./.claude/hooks/${GUARD_FILE}` };

        expect(withBypass(settingsWith(FULL_MATCHER, hook))).toBe('');
    });

    // Проход 7 ревью: интерпретатор по пути может оказаться файлом из этого же дерева,
    // а переменная в одинарных кавычках не раскрывается вовсе.
    it.each([
        ['интерпретатор из дерева репозитория', `./tools/node ".claude/hooks/${GUARD_FILE}"`],
        ['интерпретатор по абсолютному пути', `/usr/bin/node .claude/hooks/${GUARD_FILE}`],
        ['переменная в одинарных кавычках', `node '$CLAUDE_PROJECT_DIR/.claude/hooks/guard.cjs'`],
        // Проход 8 ревью: перевод строки — это вторая команда, а не отступ.
        ['перевод строки вместо пробела', `node\n"\${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.cjs"`],
        ['кавычка не закрыта', `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.cjs`],
        ['кавычка только закрывающая', `node \${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.cjs"`],
    ])('форма не канонична: %s', (_name, command) => {
        expect(withBypass(settingsWith(FULL_MATCHER, { ...GUARD_HOOK, command }))).toContain(
            'не равна одному запуску',
        );
    });
});

describe('сверка не выдумывает требований и не падает на мусоре', () => {
    it('режим не bypass — проводка не проверяется вовсе', () => {
        expect(
            checkGuardWiring({
                settings: { hooks: {} },
                ralphConfig: config('default'),
                guardExists: false,
            }),
        ).toEqual([]);
    });

    it('bypass в common — считается, даже если профиль про режим молчит', () => {
        expect(bypassProfiles(config('bypassPermissions'))).toEqual(['prod']);
    });

    it('профиль перебивает common — bypass снят именно у него', () => {
        const raw = {
            common: { permissionMode: 'bypassPermissions' },
            profiles: { prod: {}, playground: { permissionMode: 'default' } },
        };

        expect(bypassProfiles(raw)).toEqual(['prod']);
    });

    it('профилей нет вовсе — режим из common всё равно требует барьера (fail-closed)', () => {
        const problems = checkGuardWiring({
            settings: { hooks: {} },
            ralphConfig: { common: { permissionMode: 'bypassPermissions' }, profiles: {} },
            guardExists: true,
        });

        expect(problems.length).toBeGreaterThan(0);
    });

    it('matcher — не строка или битый регэксп: красный, а не исключение', () => {
        for (const matcher of [42, null, 'Bash|(' as unknown]) {
            const problems = checkGuardWiring({
                settings: settingsWith(matcher),
                ralphConfig: config('bypassPermissions'),
                guardExists: true,
            });

            expect(problems.length).toBeGreaterThan(0);
        }
    });

    it('конфиг раннера — мусор: требований нет, но и падения нет', () => {
        for (const raw of [null, 42, 'текст', { common: 1 }]) {
            expect(() => bypassProfiles(raw)).not.toThrow();
            expect(bypassProfiles(raw)).toEqual([]);
        }
    });
});

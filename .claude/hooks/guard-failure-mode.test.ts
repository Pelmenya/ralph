import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Режим отказа САМОГО барьера (#172).
 *
 * Факт, на котором держатся все проверки ниже (документация Claude Code, раздел hooks,
 * проверено 23.08.2026): у PreToolUse **блокирует только exit 2**. Код 1, код 127
 * («хук не запустился») и exit 0 — всё это «ошибка без блокировки», вызов исполняется.
 * Значит любой отказ внутри guard'а обязан кончаться двойкой, иначе барьера нет вовсе:
 * под `bypassPermissions` списки `permissions.deny` не применяются и подстраховать
 * упавший хук нечем (#138).
 */

const HOOKS = import.meta.dirname;
const GUARD = path.join(HOOKS, 'guard.cjs');

/** Запуск хука как процесса: так его зовёт Claude Code, и только так виден код выхода. */
const run = (stdin: string, guardPath = GUARD) =>
    spawnSync(process.execPath, [guardPath], {
        input: stdin,
        encoding: 'utf-8',
        // Сессия человека: контракт запуска не заявлен, данные — канона как потребителя.
        env: {
            ...process.env,
            RALPH_CORE_SHA: '',
            CLAUDE_PROJECT_DIR: path.join(HOOKS, '..', '..'),
        },
    });

/**
 * Модули рядом с хуком, кроме правил: данные потребителя и контракт ревизии. Без них копия
 * блокировала бы на загрузке, и проба «вердикт не того вида» была бы зелёной не по той
 * причине.
 */
const withSiblings = (dir: string) => {
    for (const name of ['consumer-data.cjs', 'core-revision.cjs']) {
        copyFileSync(path.join(HOOKS, name), path.join(dir, name));
    }
};

const payload = (toolName: string, toolInput: Record<string, unknown>) =>
    JSON.stringify({ tool_name: toolName, tool_input: toolInput });

/**
 * Копия хука в пустом каталоге: рядом нет файла правил, то есть они не грузятся.
 *
 * Люк судит путь по каталогу САМОГО хука, поэтому для копии «исходник барьера» — это файл
 * рядом с ней, а не файл в репозитории (ревью, проход 7: шаблон пути пропускал чужой
 * проект и домашний каталог).
 */
const guardWithoutRules = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-no-rules-'));
    const copy = path.join(dir, 'guard.cjs');
    copyFileSync(GUARD, copy);
    return copy;
};

/** Копия хука рядом с правилами заданного содержания. */
const guardReturningSource = (source: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-bad-verdict-'));
    const copy = path.join(dir, 'guard.cjs');
    copyFileSync(GUARD, copy);
    withSiblings(dir);
    writeFileSync(path.join(dir, 'guard-rules.cjs'), source);
    return copy;
};

/** Путь исходника барьера рядом с этой копией хука. */
const sourceNextTo = (guard: string, name = 'guard-rules.cjs') =>
    path.join(path.dirname(guard), name);

/** Копия хука рядом с правилами, которые бросают на разборе вызова. */
const guardWithThrowingRules = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-throws-'));
    const copy = path.join(dir, 'guard.cjs');
    copyFileSync(GUARD, copy);
    withSiblings(dir);
    writeFileSync(
        path.join(dir, 'guard-rules.cjs'),
        "module.exports = { decide() { throw new Error('дефект в правиле'); } };\n",
    );
    return copy;
};

describe('штатная работа барьера остаётся прежней', () => {
    it('разрешённый вызов проходит с нулём', () => {
        const r = run(payload('Bash', { command: 'npm run lint' }));
        expect(r.status).toBe(0);
    });

    it('запрещённый вызов блокируется двойкой и объясняет причину', () => {
        const r = run(payload('Read', { file_path: '.env' }));
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('секрет');
    });
});

describe('отказ самого барьера — fail-closed (#172)', () => {
    it('битый JSON на входе блокирует вызов, а не пропускает его', () => {
        const r = run('{ это не json');
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/вход|JSON/i);
    });

    it('пустой stdin блокирует вызов: вход не тот, что обещан контрактом хука', () => {
        const r = run('');
        expect(r.status).toBe(2);
    });

    it('JSON не того вида (не объект) блокирует вызов', () => {
        expect(run('"строка вместо объекта"').status).toBe(2);
        expect(run('null').status).toBe(2);
    });

    it('исключение внутри правил блокирует вызов', () => {
        const r = run(payload('Bash', { command: 'npm run lint' }), guardWithThrowingRules());
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/барьер|guard/i);
    });

    it('вердикт не того вида — неисправность, а не разрешение', () => {
        for (const source of [
            'module.exports = { decide: () => ({}) };\n',
            'module.exports = { decide: () => undefined };\n',
        ]) {
            const guard = guardReturningSource(source);
            expect(run(payload('Bash', { command: 'rm -rf /tmp/x' }), guard).status).toBe(2);
        }
    });

    it('правила не решают код выхода сами — ни при загрузке, ни вместо вердикта', () => {
        // `process.exit` из правил try/catch не ловит, а коды 0 и 1 у PreToolUse означают
        // «вызов исполняется». Пока правила работают, выход подменён на исключение.
        const onLoad = guardReturningSource('process.exit(1);\n');
        expect(run(payload('Bash', { command: 'npm run lint' }), onLoad).status).toBe(2);

        const inDecide = guardReturningSource(
            'module.exports = { decide() { process.exit(0); } };\n',
        );
        expect(run(payload('Bash', { command: 'rm -rf /tmp/x' }), inDecide).status).toBe(2);
    });

    it('обработчик выхода не переписывает код блокировки', () => {
        const guard = guardReturningSource(
            'process.on("exit", () => process.reallyExit(0));\n' +
                'module.exports = { decide: () => ({ blocked: true, reason: "стоп" }) };\n',
        );
        expect(run(payload('Bash', { command: 'rm -rf /tmp/x' }), guard).status).toBe(2);
    });

    it('значение без описания не роняет барьер в код, который ничего не блокирует', () => {
        // Бросить можно что угодно: у объекта без прототипа нет ни `message`, ни
        // `toString`, и форматирование ошибки падало само — вне try, с кодом 1.
        const guard = guardReturningSource('throw Object.create(null);\n');
        expect(run(payload('Bash', { command: 'rm -rf /tmp/x' }), guard).status).toBe(2);
    });

    it('неисправный барьер блокирует и СВОЮ ПОЧИНКУ — сессия себя не восстанавливает', () => {
        // Не недосмотр, а зафиксированная цена fail-closed: путь восстановления изнутри
        // сессии — отдельная задача, а не довесок к этой. Пока её нет, барьер чинит человек.
        const guard = guardWithThrowingRules();
        for (const tool of ['Read', 'Edit', 'Write']) {
            expect(run(payload(tool, { file_path: sourceNextTo(guard) }), guard).status).toBe(2);
        }
    });

    it('битые данные потребителя блокируют вызов, а не дают контур по умолчанию', () => {
        const project = mkdtempSync(path.join(tmpdir(), 'guard-bad-data-'));
        mkdirSync(path.join(project, '.claude/ralph'), { recursive: true });
        writeFileSync(path.join(project, '.claude/ralph/hooks.json'), '{"mcp": []}');
        const r = spawnSync(process.execPath, [GUARD], {
            input: payload('Bash', { command: 'npm run lint' }),
            encoding: 'utf-8',
            env: { ...process.env, RALPH_CORE_SHA: '', CLAUDE_PROJECT_DIR: project },
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('данные хуков');
    });

    // Контракт `RALPH_CORE_SHA` раннер сессиям пока не передаёт: забор данных контура
    // узнаёт петлю ещё и переходным признаком — строкой `ralph.md` в промпте транскрипта.
    it('без контракта сессия петли узнаётся по транскрипту, и правка данных — блок', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'guard-transcript-'));
        const transcript = (name: string, prompt: string) => {
            const file = path.join(dir, `${name}.jsonl`);
            writeFileSync(file, JSON.stringify({ type: 'user', message: { content: prompt } }));
            return file;
        };
        const call = (transcriptPath: string) =>
            JSON.stringify({
                tool_name: 'Write',
                tool_input: { file_path: '.claude/ralph/hooks.json' },
                transcript_path: transcriptPath,
            });
        const loop = run(call(transcript('loop', 'Работай по .claude/ralph/ralph.md')));
        expect(loop.status).toBe(2);
        expect(loop.stderr).toContain('данных контура');
        expect(run(call(transcript('human', 'поправь пример'))).status).toBe(0);
        // Транскрипт назван, но не читается — петлёй считается, канал не открывается.
        expect(run(call(path.join(dir, 'missing.jsonl'))).status).toBe(2);
    });

    it('отсутствующие правила блокируют вызов, а не открывают канал целиком', () => {
        // Самый дорогой случай: загрузка модуля правил бросает ДО main(), и раньше процесс
        // падал с кодом 1 — то есть вызов исполнялся, а барьера не было ни одного.
        const r = run(payload('Bash', { command: 'npm run lint' }), guardWithoutRules());
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/правил|guard-rules/i);
    });
});

describe('сам хук обязан оставаться загружаемым', () => {
    it('guard.cjs разбирается интерпретатором — синтаксическая ошибка здесь барьер не закроет', () => {
        // Единственный отказ, от которого барьер защититься не может изнутри: если сам
        // файл не разбирается, node падает до первой строки кода. Ловится тем, что чек
        // стоит в гейте — то есть до мерджа, а не в бою.
        expect(() => execFileSync(process.execPath, ['--check', GUARD])).not.toThrow();
    });
});

// Данные контракта потребителя для хуков (#99): правила контура и таблица скиллов
// приезжают из `.claude/ralph/hooks.json` проекта. Проверяется разбор, режим отказа и то,
// что guard на данных канона как потребителя пропускает ровно заявленное.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { emptyData, loadConsumerData, parseConsumerData } from './consumer-data.cjs';
import { decide } from './guard-rules.cjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CANON = readFileSync(path.join(ROOT, '.claude/ralph/hooks.json'), 'utf-8');

const enoent = () => {
    throw Object.assign(new Error('нет файла'), { code: 'ENOENT' });
};

describe('загрузка данных из каталога проекта', () => {
    it('каталог проекта не назван или файла нет — пустые данные, самый строгий контур', () => {
        expect(loadConsumerData({ env: {} })).toEqual(emptyData());
        expect(loadConsumerData({ env: { CLAUDE_PROJECT_DIR: '/p' }, readFileFn: enoent })).toEqual(
            emptyData(),
        );
    });

    // `Object.freeze` неглубокий: общий пустой объект, поправленный одним вызывающим,
    // открывал бы «самый строгий контур» для всего процесса.
    it('пустые данные — свежий объект: правка одних не меняет следующие', () => {
        loadConsumerData({ env: {} }).mcp.writeAllowed.add('mcp__forge__Anything');
        expect(loadConsumerData({ env: {} }).mcp.writeAllowed.size).toBe(0);
        expect(emptyData()).not.toBe(emptyData());
    });

    it('файл читается из <проект>/.claude/ralph/hooks.json', () => {
        const seen: string[] = [];
        const data = loadConsumerData({
            env: { CLAUDE_PROJECT_DIR: '/p' },
            readFileFn: (file) => {
                seen.push(file);
                return CANON;
            },
        });
        expect(seen).toEqual([path.join('/p', '.claude/ralph/hooks.json')]);
        expect(data.mcp.writeAllowed.has('mcp__sourcecraft__CreateIssue')).toBe(true);
    });

    // Фаза 12: раннер называет данные из дерева человека — правка файла в дереве сессии
    // не меняет контура хука, которого регистрирует раннер.
    it('RALPH_HOOKS_DATA сильнее CLAUDE_PROJECT_DIR: данные из названного файла', () => {
        const seen: string[] = [];
        const data = loadConsumerData({
            env: { CLAUDE_PROJECT_DIR: '/session', RALPH_HOOKS_DATA: '/human/hooks.json' },
            readFileFn: (file) => {
                seen.push(file);
                return CANON;
            },
        });
        expect(seen).toEqual(['/human/hooks.json']);
        expect(data.mcp.writeAllowed.has('mcp__sourcecraft__CreateIssue')).toBe(true);
    });

    it('названного файла нет — самый строгий контур, а не данные дерева сессии', () => {
        expect(
            loadConsumerData({
                env: { CLAUDE_PROJECT_DIR: '/session', RALPH_HOOKS_DATA: '/human/hooks.json' },
                readFileFn: enoent,
            }),
        ).toEqual(emptyData());
    });

    it('относительный RALPH_HOOKS_DATA — исключение: его база снова дерево сессии', () => {
        expect(() =>
            loadConsumerData({ env: { RALPH_HOOKS_DATA: '.claude/ralph/hooks.json' } }),
        ).toThrow('не абсолютный путь');
    });

    it('файл есть, но не читается — исключение, а не пустые данные', () => {
        expect(() =>
            loadConsumerData({
                env: { CLAUDE_PROJECT_DIR: '/p' },
                readFileFn: () => {
                    throw Object.assign(new Error('нет прав'), { code: 'EACCES' });
                },
            }),
        ).toThrow('нет прав');
    });
});

describe('разбор: битые данные — стоп, а не дефолт', () => {
    it.each([
        ['{ не json', 'не JSON'],
        ['[]', 'не объект'],
        ['{"mcp": []}', 'mcp — не объект'],
        ['{"skills": 1}', 'skills — не объект'],
        ['{"mcp": {"writeAllowed": "mcp__x__y"}}', 'mcp.writeAllowed'],
        ['{"mcp": {"neverExceptions": [""]}}', 'mcp.neverExceptions'],
        ['{"skills": {"files": {}}}', 'skills.files — не список'],
        ['{"skills": {"files": [1]}}', 'не объект'],
        ['{"skills": {"files": [{"pattern": "(", "skills": ["a"], "why": "w"}]}}', 'не регэксп'],
        ['{"skills": {"files": [{"pattern": "", "skills": ["a"], "why": "w"}]}}', 'pattern'],
        ['{"skills": {"files": [{"pattern": "x", "skills": [], "why": "w"}]}}', 'пуст'],
        ['{"skills": {"commands": [{"pattern": "x", "skills": ["a"]}]}}', 'why'],
        // Опечатка в ключе — не та форма, а не молчаливо пустая таблица (от противного:
        // `"skill"` без барьера дал бы пустой список скиллов).
        ['{"skill": {"files": []}}', 'верхний уровень: незнакомые ключи skill'],
        ['{"skills": {"file": []}}', 'skills: незнакомые ключи file'],
        ['{"mcp": {"writeAllowd": []}}', 'mcp: незнакомые ключи writeAllowd'],
        ['{"mcp": {"notes": []}}', 'mcp.notes — не объект'],
    ])('%s → %s', (text, what) => {
        expect(() => parseConsumerData(text, 'hooks.json')).toThrow(what);
    });

    // Шаблон для потребителя обязан разбираться тем же разбором, что и боевые данные:
    // иначе первая же установка по шаблону блокировала бы каждый вызов.
    it('шаблон данных потребителя из examples/ разбирается без отказа', () => {
        const example = readFileSync(path.join(ROOT, 'examples/hooks.json.example'), 'utf-8');
        expect(parseConsumerData(example).mcp.writeAllowed.size).toBeGreaterThan(0);
    });

    it('пустой объект — пустые данные; ряд скилла узнаёт путь по регэкспу', () => {
        const empty = parseConsumerData('{}');
        expect(empty.mcp.writeAllowed.size).toBe(0);
        expect(empty.skills.files).toEqual([]);
        const row = parseConsumerData(CANON).skills.files[0];
        expect(row.test('core/gate.test.ts')).toBe(true);
        expect(row.test('core/gate.ts')).toBe(false);
    });
});

describe('guard на правилах из данных потребителя', () => {
    const contour = parseConsumerData(CANON);
    const mcp = (tool: string, c = contour) => decide(tool, {}, { contour: c }).blocked;

    it('мутация рабочего цикла разрешена данными, без данных — заблокирована', () => {
        expect(mcp('mcp__sourcecraft__CreateIssue')).toBe(false);
        expect(mcp('mcp__sourcecraft__CreateIssue', emptyData())).toBe(true);
        expect(decide('mcp__sourcecraft__CreateIssue', {}).blocked).toBe(true);
    });

    // Текст отказа не обещает мутаций, которых контур не разрешает: при пустых данных
    // агент иначе искал бы, почему «разрешённое» не проходит.
    it('отказ называет пустой контур пустым, а непустой — именем вне writeAllowed', () => {
        const empty = decide('mcp__sourcecraft__CreateIssue', {}, { contour: emptyData() });
        expect(empty.reason).toContain('контур MCP-мутаций проекта пуст');
        expect(empty.reason).not.toContain('мутации рабочего цикла');
        const missing = decide('mcp__sourcecraft__SetDecision', {}, { contour });
        expect(missing.reason).toContain('нет в mcp.writeAllowed');
        expect(missing.reason).not.toContain('пуст');
    });

    it('другой форж заявляет свои мутации — ядро про форж не знает', () => {
        const other = parseConsumerData('{"mcp": {"writeAllowed": ["mcp__forge__OpenTicket"]}}');
        expect(mcp('mcp__forge__OpenTicket', other)).toBe(false);
        expect(mcp('mcp__sourcecraft__CreateIssue', other)).toBe(true);
    });

    it('инварианты ядра сильнее данных: запрет по слову без вычета не снимается разрешением', () => {
        const greedy = parseConsumerData(
            '{"mcp": {"writeAllowed": ["mcp__forge__DeleteRepository", "mcp__forge__ListSecrets"]}}',
        );
        expect(mcp('mcp__forge__DeleteRepository', greedy)).toBe(true);
        expect(mcp('mcp__forge__ListSecrets', greedy)).toBe(true);
    });

    // Данные читаются из дерева, которое правит сессия: дописанный в writeAllowed
    // SetDecision действовал бы со следующего вызова, раньше ship человека на мердже.
    it('в сессии петли данные контура не правятся ни файловым инструментом, ни оболочкой', () => {
        const loop = { contour, loop: true };
        const data = '/work/.claude/ralph/hooks.json';
        expect(decide('Edit', { file_path: data }, loop).blocked).toBe(true);
        expect(decide('Write', { file_path: '.claude/ralph/hooks.json' }, loop).blocked).toBe(true);
        expect(decide('MultiEdit', { edits: [{ file_path: data }] }, loop).blocked).toBe(true);
        expect(
            decide('Bash', { command: 'cd .claude/ralph && sed -i s/a/b/ hooks.json' }, loop)
                .blocked,
        ).toBe(true);
        // Чтение и соседний файл того же имени — не правка данных.
        expect(decide('Read', { file_path: data }, loop).blocked).toBe(false);
        expect(decide('Edit', { file_path: '/work/hooks.json' }, loop).blocked).toBe(false);
        // Сессия человека правит данные как раньше.
        expect(decide('Edit', { file_path: data }, { contour }).blocked).toBe(false);
    });

    // Забор на любое упоминание имени блокировал обычные шаги петли, которая правит
    // примеры и доки про этот файл (ревью Фазы 11).
    it('оболочка: чтение, соседний файл и сообщение коммита — не правка данных', () => {
        const loop = { contour, loop: true };
        for (const command of [
            'cat .claude/ralph/hooks.json',
            'grep -n mcp .claude/ralph/hooks.json',
            'jq . .claude/ralph/hooks.json',
            'git diff -- .claude/ralph/hooks.json',
            'git add examples/hooks.json.example',
            'npx prettier --write examples/hooks.json.example',
            'git commit -m "docs: пример данных .claude/ralph/hooks.json"',
        ]) {
            expect(decide('Bash', { command }, loop).blocked, command).toBe(false);
        }
    });

    it('оболочка: перенаправление, интерпретатор, запись и откат дерева — правка данных', () => {
        const loop = { contour, loop: true };
        for (const command of [
            'echo {} > .claude/ralph/hooks.json',
            'jq . x.json >> hooks.json',
            `python3 -c "open('.claude/ralph/hooks.json','w').write('{}')"`,
            `node -e "require('fs').writeFileSync('hooks.json', '{}')"`,
            'cp /tmp/x.json .claude/ralph/hooks.json',
            'tee .claude/ralph/hooks.json < /tmp/x.json',
            'git checkout other -- .claude/ralph/hooks.json',
        ]) {
            expect(decide('Bash', { command }, loop).blocked, command).toBe(true);
        }
    });

    // Guard дерева сессии контракта не получает (#132): забор по одному контракту там не
    // действовал бы нигде. Хук отдаёт признак функцией, и читается он только по делу.
    it('признак петли функцией зовётся лишь на вызове, который трогает данные', () => {
        const write = { file_path: '.claude/ralph/hooks.json' };
        let asked = 0;
        const loop = () => {
            asked += 1;
            return true;
        };
        expect(decide('Bash', { command: 'npm run lint' }, { contour, loop }).blocked).toBe(false);
        expect(asked).toBe(0);
        expect(decide('Write', write, { contour, loop }).blocked).toBe(true);
        expect(asked).toBe(1);
        expect(decide('Write', write, { contour, loop: () => false }).blocked).toBe(false);
    });

    it('вычет из запрета без разрешения не открывает вызов — нужны оба гейта', () => {
        const half = parseConsumerData('{"mcp": {"neverExceptions": ["mcp__forge__DiscardPR"]}}');
        expect(mcp('mcp__forge__DiscardPR', half)).toBe(true);
    });
});

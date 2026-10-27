// Барьер «скилл загружен до первой правки»: проверяем решения, а не побочку.
//
// Чистые функции получают транскрипт строками, поэтому тесты не трогают ~/.claude;
// один набор гоняет хук процессом с временным транскриптом — так проверяется код выхода,
// единственное, что у PreToolUse действительно блокирует (exit 2), и fail-closed на
// нечитаемом файле. Проводка в settings.json сверяется отдельно: хук, не подключённый
// там, лежит в репозитории нетронутым и не вызывается.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConsumerData } from './consumer-data.cjs';
import * as hook from './skill-barrier.cjs';

type TVerdict = { blocked: boolean; reason?: string; loaded?: string[] };
type TDecideInput = {
    toolName: string;
    toolInput: unknown;
    transcriptLines: string[] | null;
    env?: Record<string, string | undefined>;
    cached?: Set<string>;
    rules?: TRules;
};
type TRules = { files: { skills: string[] }[]; commands: { skills: string[] }[] };
const targetsOf = hook.targetsOf as (toolName: string, toolInput: unknown) => string[];
const requiredSkillsOf = hook.requiredSkills as (
    targets: string[],
    command?: string,
    rules?: TRules,
) => Map<string, unknown>;
const isLoopSession = hook.isLoopSession as (env?: Record<string, string | undefined>) => boolean;
const loadedSkills = hook.loadedSkills as (lines: string[]) => Set<string>;
const decideOf = hook.decide as (input: TDecideInput) => TVerdict;

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(ROOT, '.claude/hooks/skill-barrier.cjs');

/**
 * Таблица скиллов — данные потребителя (#99): тесты гоняют барьер на данных канона как
 * потребителя, `.claude/ralph/hooks.json`, а не на таблице, зашитой в хук.
 */
const RULES = parseConsumerData(
    readFileSync(path.join(ROOT, '.claude/ralph/hooks.json'), 'utf-8'),
).skills;
const requiredSkills = (targets: string[], command?: string) =>
    requiredSkillsOf(targets, command, RULES);
const decide = (input: TDecideInput) => decideOf({ rules: RULES, ...input });
/** Контракт запуска петли: ожидаемая ревизия ядра. Значение здесь — только форма SHA. */
const CORE_SHA = 'a'.repeat(40);
const LOOP_ENV = { RALPH_CORE_SHA: CORE_SHA };

const userPrompt = (content: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content } });
/**
 * Промпт сессии раннера на каноне: контракт `ralph.md` лежит в корне. Петлю он больше не
 * заявляет (#132) — только контракт запуска; в вердиктах ниже он стоит с `LOOP_ENV`.
 */
const LOOP_PROMPT = userPrompt('Прочитай ralph.md и строго следуй правилам.');
const HUMAN_PROMPT = userPrompt('Подхвати handoff.');
const skillCall = (skill: string) =>
    JSON.stringify({
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill } }],
        },
    });
const bashCall = (command: string) =>
    JSON.stringify({
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Bash', input: { command } }],
        },
    });

const TEST = 'core/gate.test.ts';
const CODE = 'core/gate.ts';

describe('что считается правкой целевого файла', () => {
    it('файловые инструменты — по полям пути, включая пакет правок MultiEdit', () => {
        expect(targetsOf('Write', { file_path: TEST })).toEqual([TEST]);
        expect(
            targetsOf('MultiEdit', { edits: [{ file_path: TEST }, { file_path: CODE }] }),
        ).toEqual([TEST, CODE]);
        expect(targetsOf('Edit', {})).toEqual([]);
    });

    it('Bash: heredoc, python write_text и sed -i — правка; vitest и cat — нет', () => {
        expect(targetsOf('Bash', { command: `cat > ${TEST} <<'TS'\nexport {};\nTS` })).toEqual([
            TEST,
        ]);
        expect(
            targetsOf('Bash', {
                command: `python3 - <<'PY'\nfrom pathlib import Path\nPath("${TEST}").write_text("x")\nPY`,
            }),
        ).toEqual([TEST]);
        expect(targetsOf('Bash', { command: `sed -i 's/a/b/' ${TEST}` })).toEqual([TEST]);
        expect(targetsOf('Bash', { command: `npx vitest run ${TEST}` })).toEqual([]);
        expect(targetsOf('Bash', { command: `cat ${TEST} | head -20` })).toEqual([]);
        expect(targetsOf('Bash', {})).toEqual([]);
    });

    it('node -e с записью через fs и тест в корне — тоже правка (ревью Kimi)', () => {
        expect(
            targetsOf('Bash', {
                command: `node -e "require('fs').writeFileSync('${TEST}', '')"`,
            }),
        ).toEqual([TEST]);
        expect(targetsOf('Bash', { command: "cat > root.test.mts <<'TS'\nTS" })).toEqual([
            'root.test.mts',
        ]);
    });

    it('перенаправление вывода тестов в лог — не правка теста', () => {
        // `>` есть, но целевой файл — лог: путь до теста стоит ДО перенаправления.
        expect(
            targetsOf('Bash', { command: `npx vitest run ${TEST} > /tmp/out.log 2>&1` }),
        ).toEqual([]);
    });
});

describe('какой скилл обязателен для какого файла', () => {
    it('тест (.test.ts и .test.mts) → vitest; код и доки — ничего', () => {
        expect([...requiredSkills([TEST]).keys()]).toEqual(['vitest']);
        expect([...requiredSkills(['gate-env.test.mts']).keys()]).toEqual(['vitest']);
        expect(requiredSkills([CODE]).size).toBe(0);
        expect(requiredSkills(['docs/convergence.md']).size).toBe(0);
    });

    it('рядов по команде в каноне нет — коммит скилла не требует', () => {
        expect(requiredSkills([], 'git add -A && git commit -F msg.txt').size).toBe(0);
    });

    it('без данных потребителя таблица пуста — хук своих рядов не держит', () => {
        expect(requiredSkillsOf([TEST]).size).toBe(0);
        expect(
            decideOf({
                toolName: 'Edit',
                toolInput: { file_path: TEST },
                transcriptLines: [LOOP_PROMPT],
            }),
        ).toEqual({
            blocked: false,
        });
    });

    // Барьер, требующий скилл, которого нет в дереве, блокировал бы правку навсегда:
    // `Skill` с этим именем вызвать нечем. Ряд и скилл обязаны ехать одним PR.
    it.each([...RULES.files, ...RULES.commands].flatMap((rule) => rule.skills))(
        'скилл %s лежит в .claude/skills канона',
        (skill) => {
            expect(existsSync(path.join(ROOT, '.claude/skills', skill, 'SKILL.md'))).toBe(true);
        },
    );
});

describe('сессия петли узнаётся по контракту запуска, а не по тексту промпта', () => {
    it('контракт запуска — петля; без него — нет', () => {
        expect(isLoopSession({ RALPH_CORE_SHA: CORE_SHA })).toBe(true);
        expect(isLoopSession({})).toBe(false);
        expect(isLoopSession({ RALPH_CORE_SHA: '  ' })).toBe(false);
    });

    // #132: прежний переходный признак — строка `ralph.md` в первом сообщении. Промпт,
    // называющий файл, петлю не заявляет: заявляет раннер переменной.
    it('сессия с ralph.md в промпте без переменной петлёй не считается (#132)', () => {
        expect(hook).not.toHaveProperty('LOOP_PROMPT_RE');
        expect(hook).not.toHaveProperty('isLoopTranscript');
        expect(
            decide({
                toolName: 'Edit',
                toolInput: { file_path: TEST },
                transcriptLines: [LOOP_PROMPT],
                env: {},
            }),
        ).toEqual({ blocked: false });
        expect(
            decide({
                toolName: 'Edit',
                toolInput: { file_path: TEST },
                transcriptLines: [LOOP_PROMPT],
                env: LOOP_ENV,
            }).blocked,
        ).toBe(true);
    });

    // Переключатель только включает: выключателя нет, любое значение кроме `on` — то же,
    // что пустая переменная.
    it('переключатель среды включает барьер без контракта, и только значением on', () => {
        expect(isLoopSession({ RALPH_SKILL_GUARD: 'on' })).toBe(true);
        expect(isLoopSession({})).toBe(false);
        expect(isLoopSession({ RALPH_SKILL_GUARD: 'yes' })).toBe(false);
    });

    // Петлю заявляет раннер: `off`, унаследованный из его окружения или env-файла, молча
    // снимал бы барьер скиллов во всех его сессиях.
    it('контракт запуска сильнее переключателя: его значение при заявленной петле не действует', () => {
        expect(isLoopSession({ RALPH_CORE_SHA: CORE_SHA, RALPH_SKILL_GUARD: 'off' })).toBe(true);
    });
});

describe('загруженные скиллы читаются из вызовов Skill, а не из упоминаний', () => {
    it('считает только tool_use Skill; текст про скилл и cat файла скилла не считаются', () => {
        const lines = [
            LOOP_PROMPT,
            bashCall('cat .claude/skills/vitest/SKILL.md'),
            JSON.stringify({
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'вызову Skill("other")' }],
                },
            }),
            skillCall('vitest'),
            '{"name":"Skill" — не JSON',
        ];
        expect([...loadedSkills(lines)]).toEqual(['vitest']);
    });
});

describe('вердикт', () => {
    const loop = [LOOP_PROMPT];
    const edit = { toolName: 'Edit', toolInput: { file_path: TEST } };
    const env = LOOP_ENV;

    it('в сессии петли правка теста без vitest заблокирована, с ним — разрешена', () => {
        const blocked = decide({ ...edit, transcriptLines: loop, env });
        expect(blocked.blocked).toBe(true);
        expect(blocked.reason).toContain('Skill(vitest)');
        expect(blocked.reason).toContain(TEST);
        expect(decide({ ...edit, transcriptLines: [...loop, skillCall('vitest')], env })).toEqual({
            blocked: false,
            loaded: ['vitest'],
        });
    });

    it('в сессии человека и без транскрипта не вмешивается; прочие файлы не трогает', () => {
        expect(decide({ ...edit, transcriptLines: [HUMAN_PROMPT], env: {} })).toEqual({
            blocked: false,
        });
        expect(decide({ ...edit, transcriptLines: null, env: {} })).toEqual({ blocked: false });
        expect(
            decide({
                toolName: 'Edit',
                toolInput: { file_path: CODE },
                transcriptLines: loop,
                env,
            }),
        ).toEqual({ blocked: false });
    });

    it('петля по контракту без ralph.md в промпте: правка теста без vitest заблокирована', () => {
        expect(decide({ ...edit, transcriptLines: [HUMAN_PROMPT], env }).blocked).toBe(true);
        expect(
            decide({ ...edit, transcriptLines: [HUMAN_PROMPT, skillCall('vitest')], env }),
        ).toEqual({ blocked: false, loaded: ['vitest'] });
    });

    it('петля заявлена, а транскрипта нет — блок: проверить вызов Skill нечем', () => {
        const verdict = decide({
            ...edit,
            transcriptLines: null,
            env: { RALPH_CORE_SHA: CORE_SHA },
        });
        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toContain('транскрипт');
    });

    it('кэш маркеров заменяет чтение транскрипта', () => {
        expect(
            decide({ ...edit, transcriptLines: loop, env, cached: new Set(['vitest']) }),
        ).toEqual({
            blocked: false,
            loaded: ['vitest'],
        });
    });
});

describe('хук процессом: код выхода и fail-closed', () => {
    let dir = '';
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = '';
    });

    // Петлю процессу заявляет переключатель: контракт с SHA сверял бы рабочее дерево с
    // ревизией, а промпт петлю больше не заявляет (#132).
    const run = (payload: Record<string, unknown>, guard = 'on') =>
        spawnSync(process.execPath, [HOOK], {
            input: JSON.stringify(payload),
            encoding: 'utf-8',
            env: {
                ...process.env,
                RALPH_SKILL_GUARD: guard,
                RALPH_CORE_SHA: '',
                CLAUDE_PROJECT_DIR: ROOT,
                TMPDIR: dir || tmpdir(),
            },
        });

    it('exit 2 без скилла, exit 0 после его вызова; маркер кэша появляется', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'skill-barrier-'));
        const transcript = path.join(dir, 'session.jsonl');
        writeFileSync(transcript, `${LOOP_PROMPT}\n`);
        const payload = {
            session_id: 's1',
            transcript_path: transcript,
            tool_name: 'Bash',
            tool_input: { command: `cat > ${TEST} <<'TS'\nexport {};\nTS` },
        };
        const denied = run(payload);
        expect(denied.status).toBe(2);
        expect(denied.stderr).toContain('Skill(vitest)');

        writeFileSync(transcript, [LOOP_PROMPT, skillCall('vitest')].join('\n') + '\n');
        const allowed = run(payload);
        expect(allowed.status).toBe(0);
        expect(readFileSync(path.join(dir, 'ralph-skill-barrier', 's1', 'vitest'), 'utf-8')).toBe(
            '',
        );
    });

    it('транскрипт назван, но не читается — exit 2 с диагностикой, а не тихий пропуск', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'skill-barrier-'));
        const result = run({
            session_id: 's2',
            transcript_path: path.join(dir, 'missing.jsonl'),
            tool_name: 'Edit',
            tool_input: { file_path: TEST },
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('не читается');
    });

    it('данные потребителя битые — exit 2, а не таблица по умолчанию', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'skill-barrier-'));
        mkdirSync(path.join(dir, '.claude/ralph'), { recursive: true });
        writeFileSync(path.join(dir, '.claude/ralph/hooks.json'), '{ не json');
        const result = spawnSync(process.execPath, [HOOK], {
            input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: TEST } }),
            encoding: 'utf-8',
            env: { ...process.env, RALPH_CORE_SHA: '', CLAUDE_PROJECT_DIR: dir, TMPDIR: dir },
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Таблица скиллов не загрузилась');
    });

    it('петля не заявлена или файл не целевой — exit 0', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'skill-barrier-'));
        const transcript = path.join(dir, 'session.jsonl');
        writeFileSync(transcript, `${LOOP_PROMPT}\n`);
        const edit = { tool_name: 'Edit', tool_input: { file_path: TEST } };
        // ralph.md в промпте без контракта — сессия человека (#132).
        expect(run({ ...edit, session_id: 's3', transcript_path: transcript }, '').status).toBe(0);
        expect(run(edit, '').status).toBe(0);
        expect(run({ tool_name: 'Edit', tool_input: { file_path: 'docs/x.md' } }).status).toBe(0);
    });
});

describe('проводка: хук подключён в settings.json на инструменты записи и Bash', () => {
    it("PreToolUse содержит skill-barrier.cjs с matcher'ом, накрывающим Bash, Edit, Write, MultiEdit", () => {
        const settings = JSON.parse(
            readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf-8'),
        ) as {
            hooks: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] };
        };
        const entry = (settings.hooks.PreToolUse ?? []).find((e) =>
            e.hooks.some((h) => h.command.includes('skill-barrier.cjs')),
        );
        if (entry === undefined) throw new Error('skill-barrier.cjs не подключён в PreToolUse');
        const matcher = new RegExp(`^(${entry.matcher})$`);
        for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit'])
            expect(matcher.test(tool)).toBe(true);
    });
});

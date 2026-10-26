// Барьер #117: в публичном каноне нет следов проектов-потребителей.
//
// Два уровня, и оба нужны:
//   1. юнит-тесты классов — «от противного»: на подсунутом следе каждого класса чек
//      обязан краснеть, на санкционированной абстрактной форме — молчать. Без них скан
//      мог бы протухнуть в зелёный (кривой регекс не матчит ничего) и никто бы не узнал;
//   2. сплошной скан дерева — то, ради чего барьер и заводился.
//
// Сам сканер и его самотест ИСКЛЮЧЕНЫ из сплошного скана: в них следы лежат нарочно —
// как образцы в юнит-тестах и как исходный текст регекспов. Тот же приём, что у соседнего
// core-purity (тесты «сами держат паттерн в проверках»). Цена честная: два файла сторожат
// друг друга взглядом ревьюера, остальное дерево — машиной.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
    HISTORY_EXEMPT,
    TRACE_CLASSES,
    denyNamePattern,
    traceFindings,
    explain,
} from './project-traces.ts';

// Отсчёт от каталога МОДУЛЯ, а не от cwd: ядро гоняется и из своего корня, и из каталога
// внутри проекта-потребителя, а CWD в этих раскладках разный. `import.meta.dirname` здесь
// законен потому, что у канона свой package.json с `type: module`: без него корневой
// package.json потребителя мог бы объявлять CommonJS, и tsc запретил бы `import.meta`
// (TS1470) — ровно ради этого package.json канона и заведён.
const CORE_ROOT = resolve(import.meta.dirname, '..');

const SELF = new Set(['tests/project-traces.ts', 'tests/project-traces.test.ts']);

/**
 * Сканируем ровно то, что лежит в репозитории ЯДРА, и только когда ядро — репозиторий
 * само по себе (свой клон канона либо подмодуль у потребителя).
 *
 * Почему не обход каталога: до миграции копия ядра лежит ВНУТРИ дерева потребителя, и
 * рядом с ней — его собственные файлы (свой CLAUDE.md, провижн контура с адресами его
 * машины). Скан по каталогу считал бы их следами канона и краснел бы на том, что каноном
 * никогда не станет. `git ls-files` + сверка toplevel отвечают на нужный вопрос точно:
 * «это файлы репозитория ядра?».
 *
 * Заодно из скана выпадают рантайм-артефакты (логи, состояние, sessions/) — они
 * гитигнорены, списка исключений не нужно.
 */
function coreRepoFiles(): string[] | null {
    const top = spawnSync('git', ['-C', CORE_ROOT, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
    });
    if (top.status !== 0) return null;
    if (top.stdout.trim() !== CORE_ROOT) return null;
    const ls = spawnSync('git', ['-C', CORE_ROOT, 'ls-files'], { encoding: 'utf-8' });
    if (ls.status !== 0) return null;
    return ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '' && !SELF.has(s))
        .sort();
}

describe('классы следов — от противного', () => {
    const cls = (name: string) => {
        const found = TRACE_CLASSES.find((c) => c.name === name);
        if (!found) throw new Error(`нет класса ${name}`);
        return [found] as const;
    };

    it('машинный путь под /root — красный', () => {
        const found = traceFindings("const repo = '/root/secret-customer';", {
            classes: cls('machine-path'),
        });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ line: 1, cls: 'machine-path' });
    });

    it('машинный путь домашнего каталога человека — красный', () => {
        expect(
            traceFindings('WorkingDirectory=/home/mkurbatov/customer-app', {
                classes: cls('machine-path'),
            }),
        ).toHaveLength(1);
    });

    it('санкционированные абстрактные формы — зелёные', () => {
        const ok = [
            "const repo = '/path/to/app';",
            "const wt = '/path/to/app-ralph';",
            "const cfg = '/home/user/.claude.json';",
            "const url = 'https://app.example.com';",
            "const name = 'your-project';",
        ].join('\n');
        expect(traceFindings(ok)).toEqual([]);
    });

    it('адрес конкретного хоста в ssh — красный, плейсхолдер — зелёный', () => {
        expect(
            traceFindings('ssh deploy@vps-17.customer.net "systemctl restart app"'),
        ).toHaveLength(1);
        expect(traceFindings('ssh user@host "systemctl restart app"')).toEqual([]);
    });

    it('след находится в любой строке, а не только в первой', () => {
        const found = traceFindings(['первая строка', 'вторая', 'cd /root/app'].join('\n'));
        expect(found).toHaveLength(1);
        expect(found[0].line).toBe(3);
    });
});

describe('словарь имён — снаружи, а не в дереве (#117)', () => {
    it('пустой RALPH_TRACE_DENY → словаря нет, структурные классы работают дальше', () => {
        expect(denyNamePattern({} as NodeJS.ProcessEnv)).toBeNull();
        expect(denyNamePattern({ RALPH_TRACE_DENY: '  ' } as NodeJS.ProcessEnv)).toBeNull();
    });

    it('имя из словаря краснит строку, которую структурные классы пропускают', () => {
        const deny = denyNamePattern({
            RALPH_TRACE_DENY: 'acme-shop, AcmeCorp',
        } as NodeJS.ProcessEnv);
        const line = "const owner = 'AcmeCorp';";
        expect(traceFindings(line)).toEqual([]);
        expect(traceFindings(line, { deny })).toMatchObject([{ cls: 'deny-name' }]);
    });

    it('точка в имени домена — литерал, а не «любой символ»', () => {
        const deny = denyNamePattern({ RALPH_TRACE_DENY: 'acme.example' } as NodeJS.ProcessEnv);
        expect(traceFindings("const u = 'https://acme.example';", { deny })).toHaveLength(1);
        // 'acmeXexample' совпало бы, будь точка неэкранированной.
        expect(traceFindings("const u = 'https://acmeXexample';", { deny })).toEqual([]);
    });

    // Метки и фазы — четвёртый класс из постановки барьера, и единственный путь для него
    // тот же словарь: структурной формы у них нет, `area:acme` неотличим от любого
    // двоеточия в тексте. Тест фиксирует, что путь существует и работает, — иначе класс
    // остался бы пожеланием в описании карточки.
    it('проектная метка и имя фазы краснеют через словарь', () => {
        const deny = denyNamePattern({
            RALPH_TRACE_DENY: 'area:acme,Витрина · Фаза 2',
        } as NodeJS.ProcessEnv);
        expect(traceFindings("labels: ['area:acme'],", { deny })).toHaveLength(1);
        expect(traceFindings('milestone: "Витрина · Фаза 2",', { deny })).toHaveLength(1);
        // Метки самого канона словарём не задеваются: он перечисляет чужое, а не своё.
        expect(traceFindings("labels: ['complexity:low'],", { deny })).toEqual([]);
    });
});

describe('сплошной скан репозитория ядра', () => {
    const files = coreRepoFiles();

    // Словарь имён приходит снаружи и в каноне обычно пуст. Что прогон шёл без него —
    // сообщает гейт (`gate.mts`), а не тест: вывод теста в зелёном прогоне не показывают,
    // и предупреждение, которого никто не видит, барьером не является.
    // Ядро лежит копией внутри потребителя (до миграции на подмодуль) — сканировать
    // нечего: соседние файлы принадлежат ему, а не канону. Скан гоняется там, где ядро
    // само себе репозиторий, — то есть в гейте канона, ради которого барьер и заведён.
    const scanHere = files !== null;

    it.skipIf(!scanHere)('скан видит репозиторий целиком, а не пустоту (fail-closed)', () => {
        // Список усох (сломался вызов git, каталог переехал) — сьют ниже стал бы зелёным,
        // ничего не проверив. Порог грубый намеренно: он ловит обвал, а не колебания.
        expect(files?.length ?? 0).toBeGreaterThan(50);
        expect(files).toContain('core/orchestrator.ts');
        expect(files).toContain('provision/ralph.service.example');
    });

    it.skipIf(!scanHere).each(files ?? [])('%s — без следов проектов-потребителей', (rel) => {
        const findings = traceFindings(readFileSync(join(CORE_ROOT, rel), 'utf-8'), {
            deny: denyNamePattern(),
        });
        expect(findings.length === 0 || explain(rel, findings)).toBe(true);
    });
});

// ── Сообщения коммитов ───────────────────────────────────────────────────────
// Дерево чистое, а история — нет: имя приватного репозитория или ссылка на его трекер
// уезжают в публичный репозиторий сообщением коммита ровно так же, как строкой кода, и
// правкой файла оттуда уже не убираются. Скан по дереву этого не видит вовсе — сообщения
// в `git ls-files` не попадают, поэтому им нужен свой проход.
describe('сообщения коммитов', () => {
    function commitMessages(): Array<{ sha: string; body: string }> | null {
        // `-z` разделяет коммиты NUL-байтом — символом, которого в тексте сообщения быть
        // не может. Через сам формат его не передать: NUL в argv запрещён ядром ОС.
        const out = spawnSync('git', ['-C', CORE_ROOT, 'log', '-z', '--format=%H%n%B'], {
            encoding: 'utf-8',
            maxBuffer: 64 * 1024 * 1024,
        });
        if (out.status !== 0) return null;
        return out.stdout
            .split('\u0000')
            .map((chunk) => chunk.trim())
            .filter((chunk) => chunk !== '')
            .map((chunk) => {
                const nl = chunk.indexOf('\n');
                return nl === -1
                    ? { sha: chunk, body: '' }
                    : { sha: chunk.slice(0, nl), body: chunk.slice(nl + 1) };
            });
    }

    const commits = commitMessages();

    it('история читается — иначе скан ниже проверял бы пустоту', () => {
        // Тот же fail-closed, что у скана дерева: `git log` не ответил (не репозиторий,
        // сломанный вызов) — красный, а не «сообщений нет, значит следов нет».
        expect(commits, 'git log не отработал — скан сообщений нечего проверять').not.toBeNull();
        expect(commits?.length ?? 0).toBeGreaterThan(0);
    });

    const exempt = new Set(HISTORY_EXEMPT.map((e) => e.sha));

    it('ни одно сообщение не несёт следов проектов-потребителей', () => {
        const deny = denyNamePattern();
        const bad = (commits ?? []).flatMap(({ sha, body }) => {
            if (exempt.has(sha)) return [];
            const findings = traceFindings(body, { deny });
            return findings.length === 0
                ? []
                : [explain(`${sha.slice(0, 12)} (сообщение)`, findings)];
        });
        expect(
            bad.join('\n'),
            'След в сообщении коммита правкой файла не убирается — историю придётся переписывать',
        ).toBe('');
    });

    // Исключение живёт ровно столько, сколько его причина. Иначе список копился бы молча:
    // запись по SHA, которого нет в истории (опечатка, другая ветка), гасит пустоту и
    // выглядит как работающее прощение.
    it('каждое исключение истории указывает на коммит, который в ней есть', () => {
        const known = new Set((commits ?? []).map((c) => c.sha));
        const stale = HISTORY_EXEMPT.filter((e) => !known.has(e.sha)).map(
            (e) => `${e.sha} — ${e.reason}`,
        );
        expect(stale.join('\n'), 'Исключение без коммита в истории — вычеркни').toBe('');
    });

    // Второй класс протухания: коммит есть, а скан на нём больше ничего не находит —
    // значит запись прощает уже не след, а что угодно, что туда допишут. Проверить это
    // можно только со словарём: следы в исключённых сообщениях — имена, а не форма.
    it('каждое исключение истории всё ещё гасит настоящий след', () => {
        const deny = denyNamePattern();
        if (deny === null) return;
        const bodies = new Map((commits ?? []).map((c) => [c.sha, c.body]));
        const idle = HISTORY_EXEMPT.filter((e) => {
            const body = bodies.get(e.sha);
            return body !== undefined && traceFindings(body, { deny }).length === 0;
        }).map((e) => `${e.sha} — ${e.reason}`);
        expect(idle.join('\n'), 'Исключение, на котором скан чист, — вычеркни').toBe('');
    });
});

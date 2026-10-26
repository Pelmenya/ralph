// Задача 30: барьер на состав аргументов сетевого git.
//
// Сетевой git без запрета промпта кредов ждёт логина на `/dev/tty`, без срока — ответа
// молчащего origin; в петле отвечать некому, и вызов стоит до дедмана без строки в логе.
// `shArgv` ставит запрет и срок сам, но юнит-тесты мест вызова видят только подменённый
// `runArgvFn`, а исполнитель вне `shArgv` (`execFileSync` напрямую, `sh` строкой) политики не
// получит вовсе. Поэтому здесь сверяется ТЕКСТ: каждый argv, чья git-подкоманда сетевая,
// обязан уходить в вызов, несущий `gitNetworkOpts(`, — прямо или через обёртку, которая
// его несёт. Список подкоманд — тот же, что у `shArgv` (`GIT_NETWORK_SUBCOMMANDS`).
//
// Скан, который ни разу не краснел, может не работать вовсе: рядом — пробы на подсунутом
// следе, и пустой результат скана по дереву — красный, а не «нечего проверять».
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripComments } from './strip-comments.ts';
import { GIT_NETWORK_SUBCOMMANDS, gitSubcommand } from '../shared/ralph-util.ts';

const CANON_ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['core', 'shared', 'adapters', 'runtime'];
const CODE_RE = /\.(?:ts|mts|js|mjs|cjs)$/;
const TEST_RE = /\.test\.|\.d\.c?ts$/;

// Исполнители процесса: у них первый аргумент — файл, второй — argv.
const EXECUTORS = new Set([
    'runArgvFn',
    'shArgv',
    'execFileSync',
    'execFile',
    'spawnSync',
    'spawn',
]);

// Строковый вызов через шелл: политику он не получает вовсе, поэтому сетевому git туда нельзя.
const SHELL_NETWORK_RE = new RegExp(
    String.raw`\b(?:sh|shFn|execSync)\(\s*[\x60'"]git\b[^\x60'"]*\s(?:` +
        GIT_NETWORK_SUBCOMMANDS.join('|') +
        String.raw`)\b`,
);

type TFinding = { file: string; line: number; why: string };
export type TNetworkCall = { file: string; line: number; callee: string };

// Пропуск строкового литерала с позиции `i` (на открывающей кавычке); вернёт индекс за ним.
function skipString(code: string, i: number): number {
    const q = code[i];
    let j = i + 1;
    while (j < code.length && code[j] !== q) {
        if (code[j] === '\\') j++;
        else if (q === '`' && code[j] === '$' && code[j + 1] === '{') {
            j = matchForward(code, j + 1);
        }
        j++;
    }
    return j + 1;
}

const OPEN = '([{';
const CLOSE = ')]}';

// Индекс парной закрывающей скобки для открывающей на позиции `i`.
function matchForward(code: string, i: number): number {
    let depth = 0;
    for (let j = i; j < code.length; j++) {
        const c = code[j];
        if (c === "'" || c === '"' || c === '`') {
            j = skipString(code, j) - 1;
            continue;
        }
        if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c) && --depth === 0) return j;
    }
    return code.length - 1;
}

// Индекс незакрытой открывающей скобки слева от `i` (тип — любой); строки не разбираются,
// поэтому скан назад останавливается на `;` вне скобок — дальше начинается другой оператор.
function enclosingOpen(code: string, i: number): number {
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
        const c = code[j];
        if (CLOSE.includes(c)) depth++;
        else if (OPEN.includes(c)) {
            if (depth === 0) return j;
            depth--;
        } else if (c === ';' && depth === 0) return -1;
    }
    return -1;
}

// Элементы массива-литерала `[ … ]` верхнего уровня: строковый литерал — значением, спред —
// пропуском, прочее выражение — меткой `<expr>`.
function arrayElements(body: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    const push = (raw: string): void => {
        const t = raw.trim();
        if (t === '' || t.startsWith('...')) return;
        const lit = /^(['"])(.*)\1$/.exec(t);
        out.push(lit ? lit[2] : '<expr>');
    };
    for (let j = 0; j < body.length; j++) {
        const c = body[j];
        if (c === "'" || c === '"' || c === '`') {
            j = skipString(body, j) - 1;
            continue;
        }
        if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c)) depth--;
        else if (c === ',' && depth === 0) {
            push(body.slice(start, j));
            start = j + 1;
        }
    }
    push(body.slice(start));
    return out;
}

const lineOf = (code: string, i: number): number => code.slice(0, i).split('\n').length;

// Тело обёртки `const NAME = …;` в том же файле — от объявления до `;` верхнего уровня.
function wrapperBody(code: string, name: string): string | null {
    const m = new RegExp(String.raw`\b(?:const|let|function)\s+${name}\b`).exec(code);
    if (!m) return null;
    let depth = 0;
    for (let j = m.index; j < code.length; j++) {
        const c = code[j];
        if (c === "'" || c === '"' || c === '`') {
            j = skipString(code, j) - 1;
            continue;
        }
        if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c)) {
            depth--;
            // `function NAME(...) { … }` кончается закрытием тела, а не `;`.
            if (depth === 0 && c === '}' && code.slice(m.index, m.index + 8) === 'function')
                return code.slice(m.index, j + 1);
        } else if (c === ';' && depth === 0) return code.slice(m.index, j);
    }
    return null;
}

/** Скан одного файла: сетевые git-argv и нарушения политики в нём. */
export function scanSource(
    file: string,
    source: string,
): { calls: TNetworkCall[]; findings: TFinding[] } {
    const code = stripComments(source, { dropTrailing: true });
    const calls: TNetworkCall[] = [];
    const findings: TFinding[] = [];
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === "'" || c === '"' || c === '`') {
            i = skipString(code, i) - 1;
            continue;
        }
        if (c !== '[') continue;
        const end = matchForward(code, i);
        const sub = gitSubcommand(arrayElements(code.slice(i + 1, end)));
        if (sub === null || !GIT_NETWORK_SUBCOMMANDS.includes(sub)) continue;
        const line = lineOf(code, i);
        const open = enclosingOpen(code, i);
        if (open < 0 || code[open] !== '(') continue; // не аргумент вызова — не argv
        const callee = /([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(0, open))?.[1] ?? '';
        const callText = code.slice(open, matchForward(code, open) + 1);
        if (EXECUTORS.has(callee)) {
            // argv чужого файла (не git) — не наш случай: подкоманда совпала случайно.
            if (!/^\(\s*['"]git['"]/.test(callText)) continue;
            calls.push({ file, line, callee });
            if (!callText.includes('gitNetworkOpts(')) {
                findings.push({ file, line, why: `${callee}(git ${sub}) без gitNetworkOpts()` });
            }
            continue;
        }
        const body = callee ? wrapperBody(code, callee) : null;
        calls.push({ file, line, callee });
        if (body === null) {
            findings.push({
                file,
                line,
                why: `git ${sub} уходит в «${callee || '?'}» — ни исполнитель, ни обёртка этого файла`,
            });
        } else if (!body.includes('gitNetworkOpts(')) {
            findings.push({
                file,
                line,
                why: `обёртка ${callee} несёт git ${sub} без gitNetworkOpts()`,
            });
        }
    }
    const shell = SHELL_NETWORK_RE.exec(code);
    if (shell) {
        findings.push({
            file,
            line: lineOf(code, shell.index),
            why: 'сетевой git строкой через шелл — политика срока и промпта туда не доходит',
        });
    }
    return { calls, findings };
}

function codeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__fixtures__') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...codeFiles(p));
        else if (CODE_RE.test(e.name) && !TEST_RE.test(e.name)) out.push(p);
    }
    return out;
}

describe('сетевой git ядра — только с запретом промпта и сроком (задача 30)', () => {
    const files = SCAN_DIRS.flatMap((d) => codeFiles(join(CANON_ROOT, d)));
    const results = files.map((p) => scanSource(relative(CANON_ROOT, p), readFileSync(p, 'utf-8')));

    it('каждый сетевой git-вызов несёт gitNetworkOpts', () => {
        expect(results.flatMap((r) => r.findings)).toEqual([]);
    });

    it('скан видит сетевые вызовы ядра — пустой результат значит слепой скан', () => {
        const seen = new Set(results.flatMap((r) => r.calls.map((c) => c.file)));
        // Перечень — не храповик числа, а проба зрения: каждый из этих модулей ходит в
        // сеть, и скан, не нашедший в нём вызова, ослеп.
        for (const f of [
            'core/worktree.ts',
            'core/gate.ts',
            'core/orchestrator.ts',
            'core/main-sync.ts',
            'core/session-push.ts',
            'core/phase-branch.ts',
            'core/consumer-tree.ts',
        ]) {
            expect(seen, f).toContain(f);
        }
    });
});

describe('скан от противного: подсунутый след краснеет', () => {
    const scan = (src: string) => scanSource('x.ts', src).findings;

    it('fetch без опций', () => {
        expect(scan(`runArgvFn('git', ['fetch', 'origin', 'main']);`)).toHaveLength(1);
    });

    it('fetch с голым запретом промпта, но без срока', () => {
        expect(
            scan(`runArgvFn('git', ['ls-remote', 'origin', b], { env: gitNetworkEnv() });`),
        ).toHaveLength(1);
    });

    it('сетевая подкоманда за глобальными опциями', () => {
        expect(scan(`shArgv('git', ['-C', dir, 'push', 'origin', ref]);`)).toHaveLength(1);
    });

    it('мимо исполнителя ядра — execFileSync напрямую', () => {
        expect(
            scan(`execFileSync('git', ['pull', '--ff-only'], { encoding: 'utf-8' });`),
        ).toHaveLength(1);
    });

    it('обёртка без политики', () => {
        expect(
            scan(
                `const gitNet = (args: string[]) => runArgvFn('git', args);\n` +
                    `gitNet(['fetch', 'origin', 'main']);`,
            ),
        ).toHaveLength(1);
    });

    it('сетевой git строкой через шелл', () => {
        expect(scan('sh(`git fetch origin ${b}`);')).toHaveLength(1);
    });

    it('с политикой — чисто; локальные и не-git — не сетевые', () => {
        expect(
            scan(
                `runArgvFn('git', ['fetch', 'origin', 'main'], gitNetworkOpts());\n` +
                    `const gitNet = (args: string[]) => runArgvFn('git', args, gitNetworkOpts(env));\n` +
                    `gitNet(['ls-remote', 'origin', b]);\n` +
                    `runArgvFn('git', ['diff', '--name-only']);\n` +
                    `shArgv('echo', ['push']);\n` +
                    `const LIST = ['fetch', 'push'];\n` +
                    `log('git fetch origin main упал');`,
            ),
        ).toEqual([]);
    });
});

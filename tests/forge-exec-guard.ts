// Барьер «ядро не исполняет команд форжа» по тому, ЧТО запущено, а не по тому, как это
// записано (задача 20).
//
// `core-purity` ищет ТЕКСТ команды: литерал `gh …`, argv-вызов `('gh', […])`, голое слово.
// Ревью !17 показало класс, который он не видит по конструкции: имя, собранное в рантайме
// (`['g', 'h'].join('')`, `String.fromCharCode(…)`, значение из конфига). Догонять каждую
// форму регекспом — проигранная гонка, поэтому второй барьер стоит не в тексте, а в точке
// исполнения: тестовый процесс подменяет экспорты `node:child_process`, и любой запуск
// бинаря форжа — каким бы способом ни было собрано его имя — уходит в общий журнал побочек
// (`shared/side-effect-guard.ts`) и бросает, не запустив процесс. Журнал сверяет общий
// `afterEach`, так что вызов, проглоченный `try/catch`, краснеет тоже.
//
// Подмена — на уровне модуля `child_process`, а не `sh`/`shArgv`: ядро зовёт процессы и
// мимо `exec.ts` (worktree, tunnel-check, deploy-check, orchestrator держат свой
// `execFileSync`/`spawnSync`), и новый модуль с собственным импортом прошёл бы мимо любой
// обёртки уровнем выше. Named-импорт `import { execFileSync }` видит подмену через
// `syncBuiltinESMExports`: экспорты встроенного модуля — живые привязки к его CJS-объекту.
//
// Граница этого барьера — честная, и ровно поэтому текстовый скан остаётся рядом:
//   • ловится только ИСПОЛНЕННОЕ в сьюте. Путь ядра, который ни один тест не прошёл, здесь
//     не виден — его видит только скан текста, и наоборот: собранное имя видит только этот
//     чек;
//   • ловится запуск ПРОЦЕССА в процессе сьюта. Запуск через подменённый в тесте
//     коллаборатор (`shArgvFn`-фейк) до `child_process` не доходит — там сторожит
//     `seam-defaults` (дефолт ведёт к шву) и сам фейк теста;
//   • дочерний процесс (живой прогон песочницы) — свой процесс без подмены, его форж —
//     шимы в PATH, и это предмет `live-cycle-purity`;
//   • шелл-строка разбирается по первым словам сегментов (`;`, `&&`, `|`, `$(…)`): имя,
//     которое раскроет сам шелл (`$BIN pr merge`, `eval`), видно только тексту;
//   • обёртка снимается вместе с опциями, которые она знает поимённо (`nice -n 10`,
//     `timeout -s KILL 30`, `sudo -u u`, `env -S '…'`). Опция со значением, которой нет в
//     `WRAPPER_VALUE_OPTS`, своё значение отдаёт за команду — и разбор ответит «не форж».
//     Искать форж в любом токене после обёртки вместо этого нельзя: `timeout 30 git -C src
//     status` назвал бы форжем каталог `src`;
//   • форж по HTTP (`curl` в API площадки) — не CLI, его держат адаптеры и запрет сети.
// Различать «ядро» и `adapters/**` здесь не нужно: под предохранителем побочек настоящий
// форж не зовёт никто, а происхождение вызова называется в тексте записи — по нему видно,
// какой модуль не подменили или какой зовёт форж мимо шва.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, relative, resolve } from 'node:path';

// Совпадает с классами `core-purity`: GitHub CLI, GitLab CLI, CLI SourceCraft.
export const FORGE_BINARIES: ReadonlySet<string> = new Set(['gh', 'glab', 'src']);

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
// Обёртки, которые запускают свой argv как команду: `env gh …`, `timeout 30 gh …`.
const WRAPPERS = new Set([
    'env',
    'exec',
    'command',
    'nohup',
    'setsid',
    'nice',
    'timeout',
    'sudo',
    'ionice',
    'stdbuf',
    'xargs',
]);
// Опции обёрток, у которых значение идёт ОТДЕЛЬНЫМ токеном: без них `nice -n 10 gh …`
// принимал `10` за команду, и форж уходил мимо барьера. Форма `--opt=значение` — один
// токен и снимается как любой флаг.
const WRAPPER_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
    env: new Set(['-u', '--unset', '-C', '--chdir']),
    nice: new Set(['-n', '--adjustment']),
    timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
    sudo: new Set([
        '-u',
        '--user',
        '-g',
        '--group',
        '-C',
        '--close-from',
        '-D',
        '--chdir',
        '-h',
        '--host',
        '-p',
        '--prompt',
        '-r',
        '--role',
        '-t',
        '--type',
        '-T',
        '--command-timeout',
        '-U',
        '--other-user',
    ]),
    ionice: new Set([
        '-c',
        '--class',
        '-n',
        '--classdata',
        '-p',
        '--pid',
        '-P',
        '--pgid',
        '-u',
        '--uid',
    ]),
    stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
    xargs: new Set([
        '-a',
        '--arg-file',
        '-d',
        '--delimiter',
        '-E',
        '-L',
        '--max-lines',
        '-n',
        '--max-args',
        '-P',
        '--max-procs',
        '-s',
        '--max-chars',
    ]),
};
// `-c` шелла бывает в связке коротких флагов: `bash -lc` (ради профиля), `sh -ec`.
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Имя форжа и подкоманда, если argv запускает форж, иначе `null`. Обёртки, присваивания
 * окружения и `sh -c` снимаются: имя бинаря решает тот, кто реально будет запущен.
 */
export function forgeInArgv(argv: readonly string[]): string | null {
    let i = 0;
    // Обёртка, чьи опции сейчас разбираются: значение её опции — не команда.
    let wrapper: string | null = null;
    while (i < argv.length) {
        const tok = argv[i];
        const base = basename(tok);
        if (tok.startsWith('-')) {
            // `env -S 'gh pr merge'` — команда целиком лежит строкой в значении опции.
            if (wrapper === 'env' && (tok === '-S' || tok === '--split-string'))
                return forgeInShell(argv[i + 1] ?? '');
            if (wrapper === 'env' && tok.startsWith('--split-string='))
                return forgeInShell(tok.slice('--split-string='.length));
            i += wrapper !== null && WRAPPER_VALUE_OPTS[wrapper]?.has(tok) ? 2 : 1;
            continue;
        }
        if (ASSIGNMENT.test(tok)) {
            i++;
            continue;
        }
        // Срок у `timeout` — позиционный аргумент после его опций, а не опция.
        if (wrapper === 'timeout' && /^\d/.test(tok)) {
            wrapper = null;
            i++;
            continue;
        }
        if (WRAPPERS.has(base)) {
            wrapper = base;
            i++;
            continue;
        }
        if (SHELLS.has(base)) {
            const c = argv.findIndex((t, k) => k > i && SHELL_COMMAND_FLAG.test(t));
            return c === -1 ? null : forgeInShell(argv[c + 1] ?? '');
        }
        if (FORGE_BINARIES.has(base)) return [base, ...argv.slice(i + 1, i + 3)].join(' ');
        return null;
    }
    return null;
}

/** То же для строки шелла: каждый сегмент команды проверяется по своему первому слову. */
export function forgeInShell(script: string): string | null {
    for (const segment of script.split(/\$\(|[;&|\n()`]/)) {
        const words = segment
            .trim()
            .split(/\s+/)
            .filter((w) => w !== '')
            .map((w) => w.replace(/^['"]|['"]$/g, ''));
        const hit = forgeInArgv(words);
        if (hit) return hit;
    }
    return null;
}

type Opts = { shell?: unknown } | undefined;

// Разбор сигнатур `child_process`: аргументы бывают опущены (`spawn(cmd, opts)`), а
// `shell: true` превращает argv в строку шелла — тогда решает разбор строки.
function argvCall(file: unknown, rest: unknown[]): string | null {
    if (typeof file !== 'string') return null;
    const args = Array.isArray(rest[0]) ? (rest[0] as unknown[]).map(String) : [];
    const opts = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as Opts;
    if (opts && typeof opts === 'object' && opts.shell) {
        return forgeInShell([file, ...args].join(' '));
    }
    return forgeInArgv([file, ...args]);
}

function shellCall(cmd: unknown): string | null {
    return typeof cmd === 'string' ? forgeInShell(cmd) : null;
}

const CANON_ROOT = resolve(import.meta.dirname, '..');
const SELF = import.meta.filename;

// Первый кадр стека вне этого модуля и вне node — тот, кто запустил процесс.
function callerOf(stack: string | undefined): string {
    for (const line of (stack ?? '').split('\n').slice(1)) {
        const m = /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?\s*$/.exec(line);
        if (!m) continue;
        const file = m[1].replace(/^file:\/\//, '');
        if (file === SELF || file.includes('/node_modules/')) continue;
        return `${relative(CANON_ROOT, file)}:${m[2]}`;
    }
    return 'неизвестно откуда';
}

const ARGV_FNS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const;
const SHELL_FNS = ['exec', 'execSync'] as const;

/**
 * Подменяет экспорты `node:child_process` в ЭТОМ процессе: запуск форжа уходит в
 * `record` (журнал побочек — он и бросает), остальное исполняется как было. Возвращает
 * снятие подмены.
 */
export function installForgeExecGuard(record: (what: string) => void): () => void {
    const cp = createRequire(import.meta.url)('node:child_process') as Record<
        string,
        (...a: unknown[]) => unknown
    >;
    const originals = new Map<string, (...a: unknown[]) => unknown>();
    const wrap = (name: string, detect: (a: unknown[]) => string | null) => {
        const orig = cp[name];
        originals.set(name, orig);
        cp[name] = function (this: unknown, ...a: unknown[]) {
            const hit = detect(a);
            if (hit) record(`forge-exec(${hit}) ← ${callerOf(new Error().stack)}`);
            return orig.apply(this, a);
        };
    };
    for (const name of ARGV_FNS) wrap(name, (a) => argvCall(a[0], a.slice(1)));
    for (const name of SHELL_FNS) wrap(name, (a) => shellCall(a[0]));
    syncBuiltinESMExports();
    return () => {
        for (const [name, orig] of originals) cp[name] = orig;
        syncBuiltinESMExports();
    };
}

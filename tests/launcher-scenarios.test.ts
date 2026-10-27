// Launcher `./ralph` на НАСТОЯЩЕМ диске, git и раннере (Фаза 12, #100).
//
// Юниты `core/launcher.ts` доказывают решения команд на подменённых коллабораторах. Здесь —
// то, чего фейк не поймает: шим `examples/ralph` находит ревизию, чекаут кладёт её в
// каталог установок git-репозиторием, lock пишется так, что его принимает `main()` ядра из установки, а
// `start --dry-run` доходит до планирования фазы. Это и есть критерий карточки: «новый
// проект от пустого `.ralph/` до зелёного dry-run одной командой install и одной start».
//
// Мир собирается тем же приёмом, что песочница живого цикла (`live-sandbox.ts`): источник —
// копия продукта отдельным репозиторием (история канона в песочницу не едет), потребитель с
// голым origin, форж и кодер — шимами в PATH, окружение дочерних процессов — с нуля, без
// предохранителя побочек: запись на диск здесь и есть предмет проверки.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LAUNCHER_CONTRACT_VERSION } from '../core/compat.ts';
import { sandboxLauncher } from './live-sandbox.ts';

// Срок — как у соседних живых наборов: настоящие git, launcher и раннер. Сценарий stop
// с секундной сессией внутри под нагрузкой гейта шёл дольше дефолтных 5 с.
vi.setConfig({ testTimeout: 60_000 });

const PRODUCT_ROOT = path.resolve(import.meta.dirname, '..');
const SHIM = path.join(PRODUCT_ROOT, 'examples', 'ralph');
const BRANCH = 'feature/launcher-phase-1';

type TWorld = {
    root: string;
    source: string;
    consumer: string;
    dataDir: string;
    runtimeDir: string;
    home: string;
    sha: string;
};

function gitEnv(home: string): NodeJS.ProcessEnv {
    return {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'sandbox',
        GIT_AUTHOR_EMAIL: 'sandbox@example.invalid',
        GIT_COMMITTER_NAME: 'sandbox',
        GIT_COMMITTER_EMAIL: 'sandbox@example.invalid',
    };
}

function git(w: { home: string }, cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv(w.home) });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} в ${cwd}: ${r.stderr}`);
    return r.stdout.trim();
}

function forgeShim(root: string): string {
    return `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "issue list")
    case "$*" in
      *"--state all"*) echo '[{"number":101,"labels":[{"name":"complexity:low"}]}]' ;;
      *) cat "${root}/open-issues.json" ;;
    esac ;;
  "issue view") echo '{"number":101,"title":"Карточка песочницы","body":"тело карточки"}' ;;
  *) echo '[]' ;;
esac
`;
}

function coderShim(root: string, body: string): string {
    return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.0.0 (sandbox)"; exit 0; fi
cat > "${root}/coder-prompt.txt"
${body}
echo "кодер-сессия песочницы отработала"
`;
}

/** `productRoot` конфига: `undefined` — каталог ревизии из lock, `null` — ключа нет (#134). */
function config(w: TWorld, maxIterations: number, productRoot?: string | null): unknown {
    return {
        defaultProfile: 'playground',
        common: {
            active: true,
            maxIterations,
            maxTurns: 5,
            claudeTimeoutMs: 60_000,
            authorAllowlist: ['sandbox-bot'],
            model: 'sandbox-coder-model',
            fallbackModel: 'none',
            permissionMode: 'bypassPermissions',
            installCmd: 'true',
            adapters: { deployCheck: 'none' },
            gate: { checks: [['test', 'true']], prodChecks: [], prodDropChecks: [] },
            blockedHealAttempts: 1,
            gateHealAttempts: 1,
            apiLimitMaxWaits: 1,
            apiLimitGraceMin: 1,
            deadman: { iterationGraceMs: 60_000, gateSilenceMs: 60_000, defaultSilenceMs: 30_000 },
            modelRouting: { default: 'sandbox-coder-model' },
            review: {
                default: 'claude-opus-4-8',
                escalated: 'claude-fable-5',
                fallback: 'claude-fable-5',
                escalateOn: [],
                escalateOnPaths: [],
                maxTurns: 5,
                diffLimit: 1000,
            },
            tunnelCheck: {
                enabled: false,
                proxyUrl: 'http://127.0.0.1:8118',
                ipCheckUrl: 'https://ip.example.invalid',
                restartCmd: 'true',
                restartWaitMs: 1,
            },
            prompt: 'Возьми Issue из milestone {milestone} и сделай его в ветке {branch}.',
            phases: [{ milestone: 'Песочница · Фаза 1', branch: BRANCH }],
            roots: {
                consumerRoot: w.consumer,
                executionRoot: path.join(w.root, 'consumer-ralph'),
                ...(productRoot === null
                    ? {}
                    : { productRoot: productRoot ?? path.join(w.dataDir, w.sha) }),
                runtimeDir: w.runtimeDir,
            },
        },
        profiles: { playground: {} },
    };
}

/**
 * Источник (копия продукта одним коммитом) и потребитель с пустым `.ralph/`, шимом
 * `./ralph`, конфигом и барьером сессий из будущей установки. SHA источника известен до
 * установки — им адресуется `productRoot` конфига.
 */
function buildWorld(
    opts: { coderScript?: string; maxIterations?: number; productRoot?: string | null } = {},
): TWorld {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-launcher-')));
    const w: TWorld = {
        root,
        source: path.join(root, 'source'),
        consumer: path.join(root, 'consumer'),
        dataDir: path.join(root, 'data'),
        runtimeDir: path.join(root, 'runtime'),
        home: path.join(root, 'home'),
        sha: '',
    };
    for (const d of [w.source, w.consumer, w.home, path.join(root, 'bin')]) {
        fs.mkdirSync(d, { recursive: true });
    }
    fs.cpSync(PRODUCT_ROOT, w.source, {
        recursive: true,
        filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)),
    });
    git(w, w.source, 'init', '--quiet', '-b', 'main');
    git(w, w.source, 'add', '-A');
    git(w, w.source, 'commit', '--quiet', '-m', 'ревизия источника');
    w.sha = git(w, w.source, 'rev-parse', 'HEAD');

    fs.mkdirSync(path.join(w.consumer, '.ralph'));
    fs.copyFileSync(SHIM, path.join(w.consumer, 'ralph'));
    fs.chmodSync(path.join(w.consumer, 'ralph'), 0o755);
    fs.mkdirSync(path.join(w.consumer, '.claude', 'ralph'), { recursive: true });
    fs.writeFileSync(
        path.join(w.consumer, '.claude', 'ralph', 'ralph.config.json'),
        JSON.stringify(config(w, opts.maxIterations ?? 1, opts.productRoot), null, 4),
    );
    // Барьер сессий — из установки по абсолютному пути: в дереве потребителя ядра нет.
    const guard = path.join(w.dataDir, w.sha, '.claude', 'hooks', 'guard.cjs');
    fs.writeFileSync(
        path.join(w.consumer, '.claude', 'settings.json'),
        JSON.stringify({
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|mcp__.*',
                        hooks: [{ type: 'command', command: `node "${guard}"` }],
                    },
                ],
            },
        }),
    );
    fs.writeFileSync(path.join(w.consumer, 'README.md'), '# проект песочницы\n');
    fs.writeFileSync(
        path.join(root, 'open-issues.json'),
        JSON.stringify([
            {
                number: 101,
                title: 'Карточка песочницы',
                labels: [{ name: 'complexity:low' }],
                author: { login: 'sandbox-bot' },
            },
        ]),
    );
    fs.writeFileSync(path.join(root, 'bin', 'gh'), forgeShim(root), { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'bin', 'claude'), coderShim(root, opts.coderScript ?? ''), {
        mode: 0o755,
    });

    git(w, root, 'init', '--quiet', '--bare', path.join(root, 'origin.git'));
    git(w, w.consumer, 'init', '--quiet', '-b', 'main');
    git(w, w.consumer, 'add', '-A');
    git(w, w.consumer, 'add', '-f', '.claude/ralph/ralph.config.json');
    git(w, w.consumer, 'commit', '--quiet', '-m', 'дерево потребителя');
    git(w, w.consumer, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(w, w.consumer, 'push', '--quiet', '-u', 'origin', 'main');
    return w;
}

type TRun = { code: number | null; output: string };

/**
 * `./ralph <args>` потребителя с окружением, собранным с нуля, под обвязкой песочницы
 * (`setpriv --pdeathsig`, по возможности свой PID namespace): живой старт поднимает монитор,
 * и прогон, чей владелец умер, не должен пережить его сиротой.
 */
function ralph(w: TWorld, args: string[], extraEnv: NodeJS.ProcessEnv = {}): TRun {
    const r = spawnSync(
        'setpriv',
        [...sandboxLauncher(), path.join(w.consumer, 'ralph'), ...args],
        {
            cwd: w.consumer,
            encoding: 'utf-8',
            timeout: 120_000,
            killSignal: 'SIGKILL',
            env: {
                PATH: `${path.join(w.root, 'bin')}:${process.env.PATH ?? ''}`,
                HOME: w.home,
                CLAUDE_CONFIG_DIR: w.home,
                RALPH_DATA_DIR: w.dataDir,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_SYSTEM: '/dev/null',
                ...extraEnv,
            },
        },
    );
    return {
        code: r.status,
        output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`,
    };
}

describe('launcher: новый проект одной командой install и одной start --dry-run (#100)', () => {
    let w: TWorld;
    beforeAll(() => {
        w = buildWorld();
    });
    afterAll(() => {
        fs.rmSync(w.root, { recursive: true, force: true });
    });

    it('шим называет ту версию launcher, которую ждёт контракт совместимости', () => {
        const text = fs.readFileSync(SHIM, 'utf8');
        expect(text).toMatch(
            new RegExp(`^RALPH_LAUNCHER_VERSION=${String(LAUNCHER_CONTRACT_VERSION)}$`, 'm'),
        );
    });

    it('без источника и ревизии install отказывает и ничего не ставит', () => {
        const r = ralph(w, ['install']);
        expect(r.code).not.toBe(0);
        expect(r.output).toMatch(/Ralph не установлен/);
        expect(fs.existsSync(w.dataDir)).toBe(false);
        expect(fs.readdirSync(path.join(w.consumer, '.ralph'))).toEqual([]);
    });

    it('install ставит ревизию, пишет lock и проходит doctor', () => {
        const r = ralph(w, ['install', '--rev', 'main'], { RALPH_SOURCE: w.source });
        expect(r.output).toMatch(new RegExp(`📦 Ревизия ${w.sha} установлена`));
        expect(r.output).toMatch(/🩺 doctor: все проверки прошли/);
        expect(r.code).toBe(0);
        const lock = JSON.parse(
            fs.readFileSync(path.join(w.consumer, '.ralph', 'core.lock'), 'utf8'),
        ) as { sha: string };
        expect(lock.sha).toBe(w.sha);
        expect(fs.existsSync(path.join(w.dataDir, w.sha, '.ralph-manifest'))).toBe(true);
    });

    it('start --dry-run из установки планирует фазу и выходит нулём', () => {
        const r = ralph(w, ['start', '--dry-run']);
        expect(r.output).toMatch(new RegExp(`▶ Ralph ${w.sha}`));
        expect(r.output).toMatch(new RegExp(`🔐 Ядро ${w.sha} сверено с lock`));
        expect(r.output).toMatch(/🛡 {1,2}Проба барьера пройдена/);
        expect(r.output).toMatch(/🔄 Песочница · Фаза 1 \| итерация 1\/1 \| Issue #101/);
        expect(r.output).toMatch(/🏁 Ralph loop завершён/);
        expect(r.code).toBe(0);
        // dry-run не спавнит кодера: промпт песочницы не записан.
        expect(fs.existsSync(path.join(w.root, 'coder-prompt.txt'))).toBe(false);
    });

    // Шим берёт SHA из lock sed'ом; сокращённый увёл бы его искать `$data/abc` и советовать
    // «поставь ревизию» там, где lock битый.
    it('lock с неполным SHA — шим называет битый lock, а не отсутствующую ревизию', () => {
        const lockPath = path.join(w.consumer, '.ralph', 'core.lock');
        const saved = fs.readFileSync(lockPath, 'utf8');
        try {
            fs.writeFileSync(lockPath, saved.replace(/"sha": "[0-9a-f]+"/, '"sha": "abc"'));
            const r = ralph(w, ['version']);
            expect(r.code).toBe(1);
            expect(r.output).toMatch(/нет полного SHA ревизии — lock битый/);
            expect(r.output).not.toMatch(/поставь её/);
        } finally {
            fs.writeFileSync(lockPath, saved);
        }
    });

    it('version называет ревизию без чтения git', () => {
        const r = ralph(w, ['version']);
        expect(r.code).toBe(0);
        expect(r.output).toMatch(new RegExp(`Ralph ${w.sha.slice(0, 12)}`));
        expect(r.output).toMatch(/launcher \(\.\/ralph\): v1/);
    });
});

function install(w: TWorld): void {
    const r = ralph(w, ['install', '--rev', 'main'], { RALPH_SOURCE: w.source });
    if (r.code !== 0) throw new Error(`install в песочнице не прошёл:\n${r.output}`);
}

describe('launcher: roots.productRoot выводится из lock (#134)', () => {
    let w: TWorld;
    const configPath = () => path.join(w.consumer, '.claude', 'ralph', 'ralph.config.json');
    beforeAll(() => {
        w = buildWorld({ productRoot: null });
        install(w);
    });
    afterAll(() => {
        fs.rmSync(w.root, { recursive: true, force: true });
    });

    it('конфиг без roots.productRoot: doctor зелёный, start --dry-run планирует фазу', () => {
        const d = ralph(w, ['doctor']);
        expect(d.output).toMatch(/🩺 doctor: все проверки прошли/);
        expect(d.code).toBe(0);
        const r = ralph(w, ['start', '--dry-run']);
        expect(r.output).toMatch(new RegExp(`🔐 Ядро ${w.sha} сверено с lock`));
        expect(r.output).toMatch(/🔄 Песочница · Фаза 1 \| итерация 1\/1 \| Issue #101/);
        expect(r.code).toBe(0);
    });

    it('roots.productRoot мимо исполняемого каталога — отказ doctor и start с обоими путями', () => {
        const stale = path.join(w.dataDir, 'b'.repeat(40));
        const running = path.join(w.dataDir, w.sha);
        const saved = fs.readFileSync(configPath(), 'utf8');
        try {
            fs.writeFileSync(configPath(), JSON.stringify(config(w, 1, stale), null, 4));
            const both = new RegExp(
                `roots\\.productRoot конфига — ${stale}, а исполняется ядро ${running}`,
            );
            const d = ralph(w, ['doctor']);
            expect(d.code).not.toBe(0);
            expect(d.output).toMatch(both);
            expect(d.output).toMatch(/❌ ядро: ralph\.js --doctor вышел с кодом/);
            const r = ralph(w, ['start', '--dry-run']);
            expect(r.code).not.toBe(0);
            expect(r.output).toMatch(both);
            expect(r.output).not.toMatch(/🔄 Песочница · Фаза 1/);
        } finally {
            fs.writeFileSync(configPath(), saved);
        }
    });
});

describe('launcher: doctor на сломанной установке (#100)', () => {
    let w: TWorld;
    beforeAll(() => {
        w = buildWorld();
        install(w);
    });
    afterAll(() => {
        fs.rmSync(w.root, { recursive: true, force: true });
    });

    it('называет каждую проваленную проверку, не исполняет изменённое дерево и выходит ненулём', () => {
        // Две поломки разом: файл ревизии правлен в установке, а lock ждёт другой launcher.
        const touched = path.join(w.dataDir, w.sha, 'core', 'launcher.ts');
        fs.appendFileSync(touched, '\n// правка в установке\n');
        const lockPath = path.join(w.consumer, '.ralph', 'core.lock');
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
            versions: { launcher: number };
        };
        lock.versions.launcher = 2;
        fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

        const r = ralph(w, ['doctor']);
        expect(r.code).not.toBe(0);
        expect(r.output).toMatch(/✅ lock:/);
        expect(r.output).toMatch(/✅ установка:/);
        expect(r.output).toMatch(/❌ дерево: .*core\/launcher\.ts: изменён/);
        expect(r.output).toMatch(/❌ launcher: ревизия ждёт launcher v2, найден v1/);
        expect(r.output).toMatch(/⏭ версии ревизии: дерево не сверено с lock/);
        expect(r.output).toMatch(/⏭ ядро: дерево не сверено с lock/);
        expect(r.output).toMatch(
            /🩺 doctor: не прошли 4 из 6 — дерево, launcher, версии ревизии, ядро/,
        );
        // Изменённое дерево не исполнялось: отчёта ядра в выводе нет.
        expect(r.output).not.toMatch(/🧩 Совместимость слоёв/);
    });

    it('start на той же установке отказывает до запуска ядра', () => {
        const r = ralph(w, ['start', '--dry-run']);
        expect(r.code).not.toBe(0);
        expect(r.output).toMatch(/⛔ start отменён: установка не прошла проверку/);
        expect(r.output).not.toMatch(/▶ Ralph/);
        expect(r.output).not.toMatch(/Профиль: playground/);
    });
});

describe('launcher: stop не прерывает сессию — останов на границе итерации (#100)', () => {
    let w: TWorld;
    beforeAll(() => {
        // Кодер-сессия сама зовёт `./ralph stop` посреди работы и после него ещё работает:
        // если stop прервал бы её, отметки конца в журнале не было бы. Итераций три и
        // очередь не пустеет — без запроса петля взяла бы вторую сессию.
        w = buildWorld({ maxIterations: 3 });
        const journal = path.join(w.root, 'session-journal.log');
        const coder = [
            `echo "начало" >> "${journal}"`,
            `RALPH_DATA_DIR="${w.dataDir}" HOME="${w.home}" "${path.join(w.consumer, 'ralph')}" stop >> "${journal}" 2>&1 && echo "stop-ok" >> "${journal}"`,
            'sleep 1',
            `echo "конец" >> "${journal}"`,
            'branch=$(git symbolic-ref --quiet --short HEAD) && git push --quiet origin "HEAD:refs/heads/$branch" >/dev/null 2>&1',
        ].join('\n');
        fs.writeFileSync(path.join(w.root, 'bin', 'claude'), coderShim(w.root, coder), {
            mode: 0o755,
        });
        install(w);
    });
    afterAll(() => {
        fs.rmSync(w.root, { recursive: true, force: true });
    });

    it('без живой петли stop отказывает и запроса не кладёт', () => {
        const r = ralph(w, ['stop']);
        expect(r.code).not.toBe(0);
        expect(r.output).toMatch(/петля здесь не идёт/);
        expect(fs.existsSync(path.join(w.runtimeDir, 'ralph.stop'))).toBe(false);
    });

    it('запрос посреди сессии: сессия доведена, вторая не начата, петля встала с ⏸', () => {
        const r = ralph(w, ['start']);
        const journal = fs.readFileSync(path.join(w.root, 'session-journal.log'), 'utf8');
        const marks = journal.split('\n').filter((l) => ['начало', 'stop-ok', 'конец'].includes(l));
        expect(marks, `${journal}\n${r.output}`).toEqual(['начало', 'stop-ok', 'конец']);
        expect(journal).toMatch(/⏸ Запрос остановки положен/);
        expect(r.output).toMatch(
            /⏸ Ralph: мягкая остановка по запросу — фаза "Песочница · Фаза 1", итерация 1/,
        );
        expect(r.code).toBe(0);
        // Запрос снят петлёй: следующий старт не встанет на нём сразу.
        expect(fs.existsSync(path.join(w.runtimeDir, 'ralph.stop'))).toBe(false);
    });

    it('живой старт записал журнал активации, doctor его читает (#38)', () => {
        const lines = fs
            .readFileSync(path.join(w.runtimeDir, 'ralph.activations.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { sha: string; from: string | null });
        expect(lines).toEqual([expect.objectContaining({ sha: w.sha, from: null })]);
        const r = ralph(w, ['doctor']);
        expect(r.output).toMatch(
            new RegExp(
                `✅ журнал активации: последняя — ${w.sha} \\(.*\\), прежней в журнале нет; записей 1`,
            ),
        );
        expect(r.code, r.output).toBe(0);
    });
});

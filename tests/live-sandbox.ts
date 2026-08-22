// Песочница ЖИВОГО прогона раннера (канон, задача 26).
//
// Зачем отдельный модуль. Барьер чистоты продукта (`product-root-purity`) доказывает узкое:
// `resolveProfile`, `preflight` и dry-проход `runLoop` не пишут под каталог продукта САМИ.
// Живой цикл он не покрывает по конструкции — `logFn`/`saveStateFn` там подменены, а всё
// остальное, что пишет, стоит за `!dry`; подготовка `main()` (mkdir `runtimeDir`, репойнт
// путей, лок, worktree, монитор) в фикстурный прогон не входит вовсе. Здесь — обратный
// подход: цикл идёт ПО-НАСТОЯЩЕМУ, а изолируется не он, а мир вокруг него.
//
// Предохранитель побочек выключен — иначе живого прогона не бывает: `RALPH_NO_SIDE_EFFECTS=1`
// считает отказом любую запись на диск, то есть ровно то, что мы и проверяем. Выключение
// ограничено ДОЧЕРНИМ ПРОЦЕССОМ: переменная удаляется из его env, а не из окружения сьюта.
// Это структурная граница, а не дисциплина — родительский процесс с его `afterEach`-сверкой
// журнала побочек остаётся под предохранителем, что бы ни делал ребёнок.
//
// Что настоящее и что фейк. Настоящие: диск, `git` (репозиторий, worktree, детач на
// origin/main), сам раннер целиком — от чтения конфига до монитора и цикла. Фейки — ровно
// два процесса, которые ходят наружу контура: форж (`gh`) и кодер (`claude`), оба шимами в
// PATH. Подменять их через DI нечем: `main()` коллабораторов не принимает, и именно поэтому
// её ветки до сих пор ничем не были покрыты.
//
// Пути — от каталога модуля (`import.meta.dirname`), как везде в каноне: прогон идёт и своим
// клоном, и каталогом внутри потребителя.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/** Каталог продукта — то самое дерево, чистоту которого сторожит барьер. */
export const PRODUCT_ROOT = path.resolve(import.meta.dirname, '..');

/** Что в песочнице лежит и куда смотреть после прогона. */
export type LiveSandbox = {
    root: string;
    /** Дерево потребителя: его код, его конфиг. Дом продукта-подмодуля. */
    consumerRoot: string;
    /** КОПИЯ продукта внутри потребителя — оригинал прогон не видит вовсе. */
    productRoot: string;
    /** Дерево работы раннера (worktree фазы) — раннер создаёт его сам. */
    executionRoot: string;
    /** Каталог состояния экземпляра: сюда обязаны уйти все записи прогона. */
    runtimeDir: string;
};

export type LiveSandboxOptions = {
    /** Ответ фейкового форжа на очередь фазы. `[]` уводит петлю в цикл сдачи фазы. */
    openIssues?: unknown[];
    /**
     * Тело шима кодера — строки `sh` после чтения промпта; сюда пробы подсовывают запись.
     * Шим объявляет `$SANDBOX_PRODUCT_ROOT` (каталог продукта у потребителя); продукт
     * дерева РАБОТЫ адресуется как `$PWD/.claude/ralph` — кодер-сессия идёт с его CWD.
     */
    coderScript?: string;
};

/**
 * Окружение для git — своё, а не унаследованное, и это не гигиена ради гигиены (ревью Codex).
 *
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` в окружении вызывающего перенаправили бы
 * `add`/`commit` в ЕГО репозиторий: песочница собиралась бы во временном каталоге, а
 * коммит уезжал бы в дерево человека. Глобальный конфиг опаснее тоньше — `core.hooksPath`
 * и `init.templateDir` подсовывают чужие хуки, которым мы отдали бы полное окружение
 * с боевыми ключами. Отсюда `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` в никуда: прогон
 * обязан зависеть только от того, что песочница положила сама.
 */
function sandboxGitEnv(home: string): NodeJS.ProcessEnv {
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

function git(cwd: string, home: string, ...args: string[]): void {
    const res = spawnSync('git', args, { cwd, encoding: 'utf-8', env: sandboxGitEnv(home) });
    if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} в ${cwd}: ${res.stderr || res.error}`);
    }
}

/** Тот же чистый git — для ЧТЕНИЯ статуса песочницы вызывающим (см. довод выше). */
export function sandboxGitStatus(sb: LiveSandbox, cwd: string): string {
    // `--ignored` обязателен: `.gitignore` продукта прячет ровно рантайм-артефакты
    // (`ralph.log`, `ralph.state.json`, `sessions/`) — без флага барьер слеп там, где нужен.
    const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored'], {
        cwd,
        encoding: 'utf-8',
        env: sandboxGitEnv(path.join(sb.root, 'home')),
    });
    // Fail-closed: git промолчал — это отказ, а не «грязи нет». Пустой ответ сломанной
    // команды выглядит ровно как чистое дерево, то есть барьер зеленел бы вхолостую.
    if (res.status !== 0) {
        throw new Error(`git status в ${cwd} не отработал: ${res.stderr || res.error}`);
    }
    return res.stdout.trim();
}

/**
 * Конфиг потребителя песочницы. Значения синтетические и намеренно узкие:
 * `maxIterations: 1` — цикл обязан ЗАВЕРШИТЬСЯ сам, иначе тест висел бы до таймаута;
 * `installCmd: 'true'` — `npm ci` в новом worktree заменён no-op'ом (ставить нечего:
 * у ядра нет рантайм-зависимостей, а минуты установки к предмету проверки не относятся);
 * `deployCheck: 'none'` — пост-мердж релиза у песочницы нет, и это полноправная реализация
 * шва, а не заглушка.
 */
function sandboxConfig(sb: LiveSandbox): unknown {
    return {
        defaultProfile: 'playground',
        common: {
            active: true,
            maxIterations: 1,
            maxTurns: 5,
            claudeTimeoutMs: 60_000,
            authorAllowlist: ['sandbox-bot'],
            model: 'sandbox-coder-model',
            fallbackModel: 'none',
            permissionMode: 'sandbox-permission-mode',
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
                fallback: 'claude-opus-4-8',
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
            phases: [{ milestone: 'Песочница · Фаза 1', branch: 'feature/sandbox-phase-1' }],
            roots: {
                consumerRoot: sb.consumerRoot,
                executionRoot: sb.executionRoot,
                productRoot: sb.productRoot,
                runtimeDir: sb.runtimeDir,
            },
        },
        profiles: { playground: {} },
    };
}

/** Фейк форжа. `--state all` отвечает всегда: «у фазы карточки были» — предусловие сдачи (C2). */
function forgeShim(sb: LiveSandbox): string {
    return `#!/bin/sh
echo "gh $*" >> "${sb.root}/forge-calls.log"
case "$1 $2" in
  "auth status") exit 0 ;;
  "issue list")
    case "$*" in
      *"--state all"*) echo '[{"number":101,"labels":[{"name":"complexity:low"}]}]' ;;
      *) cat "${sb.root}/open-issues.json" ;;
    esac ;;
  "issue view") echo '{"number":101,"title":"Карточка песочницы","body":"тело карточки"}' ;;
  *) echo '[]' ;;
esac
`;
}

/**
 * Фейк кодера. Промпт читается со stdin (боевой путь `claude -p` без позиционного
 * аргумента) и складывается в песочницу — иначе шим завис бы на непрочитанном канале.
 */
function coderShim(sb: LiveSandbox, extra: string): string {
    return `#!/bin/sh
SANDBOX_PRODUCT_ROOT="${sb.productRoot}"
cat > "${sb.root}/coder-prompt.txt"
${extra}
echo "кодер-сессия песочницы отработала"
`;
}

/**
 * Собрать песочницу: дерево потребителя с КОПИЕЙ продукта внутри, голый origin (без него
 * не бывает `origin/main`, на который раннер детачит worktree) и шимы форжа с кодером.
 *
 * Копия, а не ссылка на настоящее дерево канона: барьер обязан ловить запись в продукт, а
 * не совершать её. На ссылке первая же найденная запись осталась бы в рабочем дереве
 * человека — то есть тест чистоты сам бы её и нарушил.
 */
export function buildLiveSandbox({
    openIssues = [
        {
            number: 101,
            title: 'Карточка песочницы',
            labels: [{ name: 'complexity:low' }],
            author: { login: 'sandbox-bot' },
        },
    ],
    coderScript = '',
}: LiveSandboxOptions = {}): LiveSandbox {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-live-')));
    const consumerRoot = path.join(root, 'consumer');
    const sb: LiveSandbox = {
        root,
        consumerRoot,
        // Раскладка потребителя: ядро подключено каталогом `.claude/ralph` внутри дерева.
        productRoot: path.join(consumerRoot, '.claude', 'ralph'),
        // Дефолтное имя дерева раннера — сосед репозитория с суффиксом `-ralph`.
        executionRoot: path.join(root, 'consumer-ralph'),
        runtimeDir: path.join(root, 'runtime'),
    };

    fs.mkdirSync(sb.productRoot, { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    fs.cpSync(PRODUCT_ROOT, sb.productRoot, {
        recursive: true,
        // `.git` — история канона (копировать её в песочницу и дорого, и незачем),
        // `node_modules` — не продукт: его ставит потребитель.
        filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)),
    });

    fs.writeFileSync(path.join(root, 'open-issues.json'), JSON.stringify(openIssues));
    fs.writeFileSync(
        path.join(sb.productRoot, 'ralph.config.json'),
        JSON.stringify(sandboxConfig(sb), null, 4),
    );
    fs.writeFileSync(path.join(consumerRoot, 'README.md'), '# проект песочницы\n');
    fs.writeFileSync(path.join(root, 'bin', 'gh'), forgeShim(sb), { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'bin', 'claude'), coderShim(sb, coderScript), { mode: 0o755 });

    const home = path.join(root, 'home');
    git(root, home, 'init', '--quiet', '--bare', path.join(root, 'origin.git'));
    git(consumerRoot, home, 'init', '--quiet', '-b', 'main');
    git(consumerRoot, home, 'add', '-A');
    // `-f`: `.gitignore` продукта прячет `ralph.config.json` (в каноне он и правда чужой),
    // а потребителю он обязан приехать в worktree — оттуда его читает `main()` после chdir.
    git(consumerRoot, home, 'add', '-f', '.claude/ralph/ralph.config.json');
    git(consumerRoot, home, 'commit', '--quiet', '-m', 'дерево песочницы');
    git(consumerRoot, home, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(consumerRoot, home, 'push', '--quiet', '-u', 'origin', 'main');
    return sb;
}

/**
 * Убрать песочницу — файлы, и только файлы.
 *
 * Процессов здесь не убираем НАМЕРЕННО, и это не упущение (ревью Codex, 2-й проход).
 * Раннер уходит первым процессом своего PID namespace, а `unshare --kill-child` уносит его
 * вместе с собой: смерть первого процесса namespace ядро доводит до остальных SIGKILL'ом,
 * включая detached-монитор. Штатный выход и убийство по сроку закрыты этим, смерть самого
 * процесса-владельца — вторым слоем обвязки, `setpriv --pdeathsig` (см. `sandboxLauncher`).
 * Гарантия структурная — от ядра, а не от нашей аккуратности.
 *
 * Прежний вариант — найти процессы песочницы по её корню в `/proc` и добить сигналом —
 * выглядел страховкой, а был дырой: между чтением `cmdline` и `process.kill` номер
 * освобождается и достаётся чужому процессу, и уникальность пути от этого не спасает
 * никак. То есть уборка, поставленная СТЕРЕЧЬ чужие процессы, сама получала шанс убить
 * посторонний — ровно тот класс, ради которого барьер и требует namespace.
 */
export function removeLiveSandbox(sb: LiveSandbox): void {
    fs.rmSync(sb.root, { recursive: true, force: true });
}

/**
 * Процессы песочницы — по УНИКАЛЬНОМУ пути её корня в `/proc/<pid>/cmdline`. ТОЛЬКО ЧТЕНИЕ:
 * отсюда никто никого не убивает (см. `removeLiveSandbox`), это наблюдение для барьера
 * «после прогона не осталось сирот». Корень песочницы — свежий `mkdtemp`, так что подстрока
 * не задевает ни соседний прогон сьюта, ни чужого потребителя; процессы своего PID
 * namespace из родительского видны, поэтому приём работает и для них.
 *
 * `/proc` нечитаем — БРОСАЕМ, а не отдаём пустой список: «никого не нашли» и «не смогли
 * посмотреть» здесь означают противоположное, и второе, выданное за первое, сделало бы
 * проверку сирот тождеством.
 */
export function sandboxPids(root: string): number[] {
    return fs
        .readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
        .filter((pid) => {
            try {
                return fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf-8').includes(root);
            } catch (e) {
                // Глотаем ТОЛЬКО исчезновение процесса между `readdir` и чтением — оно здесь
                // обычное дело. Всё прочее (`EACCES` при `hidepid`, `EPERM`, `EIO`) —
                // отказ: «не смогли посмотреть», выданное за «никого нет», сделало бы
                // проверку сирот тождеством (ревью Codex, 4-й проход).
                const code = (e as NodeJS.ErrnoException).code;
                if (code === 'ENOENT' || code === 'ESRCH') return false;
                throw e;
            }
        });
}

/**
 * Код выхода, которым обвязка сообщает, что владелец умер ДО того, как ядро успело взять
 * его смерть на себя. Обычные коды раннера с ним не сталкиваются: он вне диапазона.
 */
export const OWNER_GONE_CODE = 97;

/**
 * Строка `sh`, закрывающая окно между форком и `prctl` (ревью Codex, 5-й проход).
 *
 * `setpriv` ставит `PDEATHSIG` уже в новом процессе, и владелец, умерший до этого мгновения,
 * сигнала задним числом не вызовет: обвязка пережила бы его молча. Проверка стоит ПОСЛЕ
 * `prctl` и ДО `exec`, поэтому окна не остаётся ни с одной стороны: умер раньше — `$PPID`
 * уже не тот, и мы отказываемся стартовать; умер позже — сигнал ставить уже некуда, он
 * поставлен. Опроса здесь нет — один вопрос один раз, и ни одного сигнала по номеру.
 */
export const OWNER_CHECK = [
    'test "$PPID" = "$1" || exit ' + String(OWNER_GONE_CODE),
    'shift',
    'exec "$@"',
].join('\n');

const UNSHARE_FORMS = [
    ['unshare', '--pid', '--fork', '--kill-child', '--mount-proc'],
    ['unshare', '--map-root-user', '--pid', '--fork', '--kill-child', '--mount-proc'],
];

/**
 * Обвязка запуска раннера: `setpriv --pdeathsig KILL` + сверка владельца + по возможности
 * своё пространство имён процессов.
 *
 * `setpriv --pdeathsig KILL` ОБЯЗАТЕЛЕН: ядро убивает обвязку, как только умер её родитель —
 * процесс-владелец прогона. Без него прогон, чей владелец убит `kill -9` или съеден OOM,
 * остался бы сиротой: `afterEach` там не выполняется вовсе. Первым вариантом был сторож на
 * `sh`, опрашивавший номера процессов, — и он же показал, почему такому сторожу здесь не
 * место: зомби-родитель считается живым, а освободившийся номер убитого ребёнка достаётся
 * постороннему. Сигнал шлёт ЯДРО по факту смерти, номеров в этой схеме нет.
 *
 * `unshare --pid` — ЖЕЛАТЕЛЬНЫЙ слой, и это изменилось (задача 29). Раньше он был условием
 * безопасности: раннер прибирал сирот-мониторов, узнавая их по ОТНОСИТЕЛЬНОМУ пути,
 * одинаковому у всех потребителей машины, и прогон в песочнице убил бы монитор соседнего
 * проекта — без своего `/proc` барьер было нельзя гонять вовсе. Теперь раннер опознаёт свой
 * монитор по каталогу состояния экземпляра, а он у песочницы свой; чужого она не увидит и
 * с общим `/proc`. Остаётся польза для УБОРКИ: `--kill-child` доводит смерть обвязки до
 * первого процесса namespace, а ядро — до остальных, включая detached-монитор. Где
 * namespace недоступен (ужатый контейнер CI со своим seccomp), прогон идёт без него, а
 * монитор песочницы может пережить убитый по сроку прогон — след в каталоге `/tmp`, а не
 * сигнал чужому процессу.
 *
 * `ownerPid` параметром — ради пробы сверки владельца от противного: подменяется ТОЛЬКО он,
 * а форма обвязки остаётся той, что на этой машине работает. Проба среды идёт с настоящим
 * номером всегда — иначе она мерила бы не среду, а подставленный номер.
 */
/**
 * Даёт ли эта машина песочнице своё пространство имён процессов.
 *
 * Барьеру это больше не нужно для БЕЗОПАСНОСТИ (задача 29) — только для гарантии уборки за
 * прогоном, убитым ненормально. Отсюда и отдельный вопрос: тесты, которые эту гарантию
 * проверяют, обязаны либо идти, либо сказать вслух, что проверить её здесь нечем.
 */
export function sandboxIsolatesProcesses(): boolean {
    return sandboxLauncher().includes('unshare');
}

export function sandboxLauncher(ownerPid: number = process.pid): string[] {
    // Проба СКВОЗЬ всю цепочку, а не по половине её: «стоит» и «работает» — разное.
    for (const form of UNSHARE_FORMS) {
        const probe = spawnSync(
            'setpriv',
            [
                '--pdeathsig',
                'KILL',
                'sh',
                '-c',
                OWNER_CHECK,
                'sh',
                String(process.pid),
                ...form,
                'true',
            ],
            { encoding: 'utf-8' },
        );
        if (probe.status === 0) {
            return [
                '--pdeathsig',
                'KILL',
                'sh',
                '-c',
                OWNER_CHECK,
                'sh',
                String(ownerPid),
                ...form,
            ];
        }
    }
    // Namespace нет — идём без него. Молча: отказ здесь означал бы красный гейт там, где
    // барьеру ничего не мешает работать, а сообщать не о чем — безопасность его больше
    // не касается (задача 29).
    return ['--pdeathsig', 'KILL', 'sh', '-c', OWNER_CHECK, 'sh', String(ownerPid)];
}

export type LiveRunResult = {
    code: number | null;
    /** Прогон не уложился в срок и был убит. Отдельно от `code`: у убитого его нет вовсе. */
    timedOut: boolean;
    output: string;
};

/**
 * Живой прогон раннера в песочнице.
 *
 * Дочерний процесс, а не вызов `main()` в этом: `main()` зовёт `process.chdir`,
 * `process.exit` и вешает exit-хендлеры — в общем worker'е vitest это оставило бы за собой
 * чужой CWD и убитый прогон сьюта. Заодно граница процесса и делает выключение
 * предохранителя неразделимым с самой песочницей.
 *
 * `env` собирается с нуля, а не наследуется: раннер читает `RALPH_*`, `GH_TOKEN`,
 * `CLAUDE_*` — окружение разработчика утащило бы в песочницу его боевые ключи.
 */
export function runLiveCycle(sb: LiveSandbox, timeoutMs = 120_000): LiveRunResult {
    const launcher = sandboxLauncher();
    const runner = ['node', path.join(sb.productRoot, 'ralph.js'), '--profile', 'playground'];
    const res = spawnSync('setpriv', [...launcher, ...runner], {
        cwd: sb.consumerRoot,
        encoding: 'utf-8',
        timeout: timeoutMs,
        // SIGKILL, а не дефолтный SIGTERM, и это не перестраховка: `unshare --fork` ИГНОРИРУЕТ
        // SIGTERM в родителе — нарочно, чтобы Ctrl-C доставался ребёнку, а не убивал обёртку.
        // С дефолтом срок переставал быть сроком: замер дал 30 с работы при `timeout: 2000`
        // (`ETIMEDOUT` в результате при живом процессе), то есть зависший прогон держал бы
        // сьют до собственного таймаута раннера — двух часов. SIGKILL не игнорируется, а
        // смерть обёртки `--kill-child` доводит до первого процесса namespace, ядро — до
        // остальных.
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        env: {
            // PATH с шимами ВПЕРЕДИ унаследованного: `gh` и `claude` обязаны резолвиться в
            // фейки, а `git`, `node` и `sh` — остаться настоящими. Наследуем, а не собираем
            // список системных каталогов: захардкоженный `/usr/bin` — тот же якорь наружу,
            // что и путь машины, и на хосте с node из nvm ребёнок просто не стартовал бы.
            // Секретов в самом PATH нет — их несут другие переменные, и их мы не берём.
            PATH: `${path.join(sb.root, 'bin')}:${process.env.PATH ?? ''}`,
            // HOME и конфиг Claude — внутрь песочницы: доверие рабочему дереву раннер пишет
            // в `~/.claude.json`, и настоящий файл машины трогать он не имеет права.
            HOME: path.join(sb.root, 'home'),
            CLAUDE_CONFIG_DIR: path.join(sb.root, 'home'),
            // Предохранителя здесь нет намеренно — см. докблок модуля.
        },
    });
    // `res.error` в вывод намеренно: процесс, который не удалось ПОДНЯТЬ (нет node, нет
    // прав), отдаёт `status: null` и пустые потоки — без этой строки отказ выглядел бы как
    // «прогон промолчал», и вызывающий искал бы причину в самом раннере.
    if (res.status === OWNER_GONE_CODE) {
        throw new Error(
            'Обвязка отказалась стартовать: владелец прогона умер раньше, чем ядро взяло ' +
                'его смерть на себя. Прогон не поднят — и это правильный исход, иначе он ' +
                'пережил бы владельца сиротой.',
        );
    }
    const failure = res.error ? `\n${res.error.message}` : '';
    const killed = res.signal ? `\nПрогон убит сигналом ${res.signal}.` : '';
    return {
        code: res.status,
        timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
        output: `${res.stdout ?? ''}${res.stderr ?? ''}${failure}${killed}`,
    };
}

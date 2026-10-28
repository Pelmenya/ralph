// Сборщик конфига Codex: дом сессии, недоверенный проект, окружение (Фаза 16d, #195;
// `docs/harness-contract.md`, принцип 4).
//
// Зачем. До карточки сессия Codex шла с домом CLI человека (`CODEX_HOME` или `~/.codex`), и
// стенд #188 показал два канала через него. Доверие проекту Codex 0.163 ПИШЕТ в `config.toml`
// дома при песочнице шире read-only, и под `--ignore-user-config` раннера тоже (`L-proj`):
// так записи о деревьях петли и появлялись в конфиге человека. А файл хуков дома под тем же
// флагом исполняется (`L-home`): дом человека вёз его хуки в каждую сессию петли. Поэтому дом
// у сессии свой — каталог в состоянии раннера, где лежит только то, что положил раннер.
//
// Что в доме: `config.toml` из одной строки-комментария (под `--ignore-user-config` CLI его
// не читает, но доверие записал бы туда, и файл пересобирается перед каждой сессией) и вход
// человека ссылкой (`auth.json`, режим подписки). Барьер — регистрацией в argv
// (`codexGuardArgs`), а не в доме: её проба читает обратно. MCP раннера у Codex нет: сервер,
// которого раннер не объявил, сессии не достаётся вовсе.
//
// Проект объявлен недоверенным переопределением `-c projects={…}` — ключом дерева сессии и
// главного репозитория linked worktree: Codex пишет и ищет доверие по главному
// (`t-ws`), а недоверие по любому из двух ключей проектные хуки снимает (`u-loopkey`,
// `h-projtoml-untrusted`). То же переопределение снимает и запись доверия (`t-cflag`), так что
// дом сессии после прогона тот же, что до (`S-own`, `S-guard` фикстуры стенда).
//
// TS-модуль без билд-шага (erasable-only), без побочек: чтение файлов — параметром.

import path from 'node:path';

/** Дом CLI: конфиг, вход, история сессий. Флага у него нет — только переменная. */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/**
 * Вход человека, которым сессия входит по подписке. Ссылкой, а не копией: обновлённый CLI
 * токен ложится туда, где его увидит и человек, — копия разошлась бы с ним на первом же
 * обновлении.
 */
export const CODEX_HOME_LINKS: readonly string[] = ['auth.json'];

/** `config.toml` дома сессии: ни доверия, ни хуков, ни MCP. */
export const CODEX_SESSION_CONFIG =
    '# Дом сессии Codex — собран раннером Ralph перед сессией, правка руками теряется.\n';

/**
 * Окружение CLI, которое сессии не наследуется. `CODEX_*` раннера — настройка CLI ЧЕЛОВЕКА
 * (свой `CODEX_HOME` прежде всего), а дом и всё остальное у сессии своё. `OPENAI_BASE_URL` —
 * адрес встроенного провайдера `openai`: с ним ключ или подписка ушли бы на чужой endpoint,
 * как с `openai_base_url` конфига, который `--ignore-user-config` уже снимает. Стендом
 * переменная не сверена — снимается как незнакомое окружение CLI, а не по доказанному вреду.
 */
export const CODEX_ENV_PREFIX = 'CODEX_';
export const CODEX_STRIPPED_ENV: readonly string[] = ['OPENAI_BASE_URL'];

/**
 * Дом CLI человека — тот, что Codex взял бы сам: `CODEX_HOME`, иначе `~/.codex` от `HOME`.
 * Нет ни одного — `null`: входить по подписке сессии не с чего, а ключ из env дом не нужен.
 */
export function codexHumanHome(env: NodeJS.ProcessEnv): string | null {
    if (env[CODEX_HOME_ENV]) return env[CODEX_HOME_ENV] as string;
    return env.HOME ? path.join(env.HOME, '.codex') : null;
}

/** Окружение сессии: без окружения CLI раннера, со своим домом. */
export function codexSessionEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const name of Object.keys(env)) {
        if (name.startsWith(CODEX_ENV_PREFIX) || CODEX_STRIPPED_ENV.includes(name)) {
            delete env[name];
        }
    }
    env[CODEX_HOME_ENV] = home;
    return env;
}

/**
 * Ключи доверия дерева сессии: само дерево и, у linked worktree, главный репозиторий — по
 * нему Codex пишет доверие (`t-ws`). Главный находится по `.git`-файлу дерева
 * (`gitdir: …/worktrees/<имя>`) и `commondir` рядом. Дерево с каталогом `.git` — само
 * главное. Worktree, чей главный не нашёлся, — отказ: недоверие только ключом дерева держит
 * (`u-loopkey`), но доверие главному, записанное раньше, этим уже не перебить. `.git`-файл без
 * `commondir` вне `worktrees/` — подмодуль (`gitdir: ../.git/modules/<имя>`) или вынесенный
 * каталог git: главного, кроме самого дерева, у них нет.
 */
export function codexProjectKeys(treeDir: string, readFileFn: (p: string) => string): string[] {
    const tree = path.resolve(treeDir);
    let gitFile: string;
    try {
        gitFile = readFileFn(path.join(tree, '.git'));
    } catch {
        // Каталог `.git` (EISDIR) или не репозиторий: главного, кроме самого дерева, нет.
        return [tree];
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
    if (!m) throw new Error(`${path.join(tree, '.git')} — файл без строки gitdir`);
    const gitdir = path.resolve(tree, m[1]);
    let common: string;
    try {
        common = path.resolve(gitdir, readFileFn(path.join(gitdir, 'commondir')).trim());
    } catch (error) {
        if (path.basename(path.dirname(gitdir)) !== 'worktrees') return [tree];
        throw new Error(
            `главный репозиторий worktree ${tree} не найден: ${path.join(gitdir, 'commondir')} не ` +
                `прочитан (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    const main = path.basename(common) === '.git' ? path.dirname(common) : common;
    return main === tree ? [tree] : [tree, main];
}

/** `-c projects={…}`: каждый ключ — недоверенный проект. Строка JSON — годная строка TOML. */
export function codexUntrustArgs(keys: readonly string[]): string[] {
    const entries = keys.map((k) => `${JSON.stringify(k)}={trust_level="untrusted"}`);
    return ['-c', `projects={${entries.join(',')}}`];
}

/**
 * Сверка собранного перед спавном: argv и окружение, которые уйдут в CLI, а не намерение
 * сборщика. Флаг `--ignore-user-config`, недоверие каждому ключу, свой дом, не совпавший с
 * домом человека, и вычищенное окружение — иначе сессия пошла бы с конфигом, который правит
 * человек или дерево.
 */
export function codexIsolationProblems({
    argv,
    env,
    home,
    humanHome,
    keys,
}: {
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
    home: string;
    humanHome: string | null;
    keys: readonly string[];
}): string[] {
    const out: string[] = [];
    if (!argv.includes('--ignore-user-config')) {
        out.push('в argv нет --ignore-user-config: CLI читал бы конфиг дома');
    }
    const untrust = codexUntrustArgs(keys)[1];
    const at = argv.indexOf(untrust);
    if (at < 1 || argv[at - 1] !== '-c') {
        out.push(
            `в argv нет недоверия проекту (${keys.join(', ')}): его хуки и MCP исполнились бы`,
        );
    }
    if (env[CODEX_HOME_ENV] !== home) {
        out.push(`${CODEX_HOME_ENV} сессии — не дом, собранный раннером (${home})`);
    }
    if (humanHome !== null && path.resolve(home) === path.resolve(humanHome)) {
        out.push(`дом сессии ${home} совпал с домом человека: доверие легло бы в его конфиг`);
    }
    const leaked = Object.keys(env).filter(
        (n) =>
            (n.startsWith(CODEX_ENV_PREFIX) && n !== CODEX_HOME_ENV) ||
            CODEX_STRIPPED_ENV.includes(n),
    );
    if (leaked.length > 0) out.push(`окружение CLI раннера не вычищено: ${leaked.join(', ')}`);
    return out;
}

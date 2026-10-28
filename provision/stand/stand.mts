/**
 * Изолированный стенд живых проб (Фаза 16c, задача 182; принцип 8 `docs/harness-contract.md`).
 *
 * Зачем. Живая отрицательная проба намеренно просит CLI сделать запрещённое — записать
 * `.env`, вызвать MCP-мутацию, переписать конфиг. Пока барьер исправен, вызова нет; когда он
 * дефектен, вызов ИСПОЛНЯЕТСЯ, и исполняет его CLI, проектный хук или подменённый сервер с
 * правами человека. Стенд Фазы 11 (`install-stand.sh`) был временным каталогом, а «ничего не
 * пролилось» проверялось сверкой хешей после факта: сверка видит только то, что ей велели
 * хешировать, и ничего не предотвращает. Здесь граница — ОС (`isolate.sh`): запись — только в
 * каталог стенда, дом человека в корне стенда отсутствует, сеть — loopback и прокси к
 * провайдеру модели (`egress.mts`), MCP — только фиктивный (`fake-mcp.mts`).
 *
 * Проверка изоляции идёт при ВЫКЛЮЧЕННОМ барьере: никакого хука, процесс внутри напрямую
 * пишет вне стенда и в дома CLI человека. Зелёная только тогда, когда каждая такая запись
 * отвергнута ОС (EROFS/EACCES/EPERM) И её следа нет на хосте, а парная запись внутри стенда
 * прошла. Совпавшие хеши конфигов человека зелёным её не делают: хеши — дополнительная
 * проверка, и расхождение в них красное само по себе, а совпадение ничего не доказывает.
 *
 * ЗАПУСК:
 *   node provision/stand/stand.mts check [--human-home <дом>]
 *   node provision/stand/stand.mts exec --stand <каталог> --cli <имя> [--allow host:port]…
 *        [--cli-bin <бинарь CLI>] [--ro <путь>]… [--bind <файл>:<путь в стенде>]…
 *        [--pass-env <ИМЯ>]…
 *        [--upstream-proxy http://host:port | --upstream-proxy-env <ИМЯ>] -- <команда…>
 *   `--cli-bin` — бинарь CLI: что от него едет внутрь, решает правило CLI (`cliBinary`).
 *   `--upstream-proxy` — прокси хоста, через который прокси стенда выходит к провайдеру
 *   (`egress.mts`); без него соединение с провайдером прямое. Адрес с кредами — только
 *   `--upstream-proxy-env`: argv процесса виден любому пользователю хоста, окружение — нет.
 *   Каталог `--stand` — новый или без раскладки прошлого прогона: её имена изнутри могли
 *   стать симлинками, и запись раскладки ушла бы по ним наружу.
 * Код выхода `check`: 0 — изоляция доказана, 1 — нет (включая «namespace недоступны»: стенд
 * без изоляции — не стенд, и пропуск здесь был бы зелёным по ложной причине).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
    exitCodeOf,
    openJournal,
    parseUpstreamProxy,
    startEgressProxy,
    upstreamFromEnv,
    type TUpstreamProxy,
} from './egress.mts';

const HERE = import.meta.dirname;
const CANON_ROOT = resolve(HERE, '..', '..');
const ISOLATE_SH = join(HERE, 'isolate.sh');

/** Коды, которыми ОС отвергает запись. ENOENT сюда не входит: это «пути нет», а не отказ. */
export const OS_REFUSALS = ['EROFS', 'EACCES', 'EPERM'] as const;

/** Системные каталоги, которые `isolate.sh` и так кладёт в корень стенда (на чтение). */
export const SYSTEM_DIRS = [
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib32',
    '/lib64',
    '/libx32',
    '/etc',
    '/opt',
];

/**
 * Дома CLI человека — цели пробы выхода за пределы. Внутри стенда их нет вовсе; проба
 * доказывает, что и создать их там нельзя.
 */
export const HUMAN_CLI_HOMES = [
    '.claude',
    '.codex',
    '.kimi-code',
    '.config/opencode',
    '.local/share/opencode',
];

/**
 * Конфиги человека для дополнительной сверки хешей до и после. `.claude.json` здесь нет
 * намеренно: Claude Code человека переписывает его каждой своей сессией, и сверка краснела
 * бы от соседа по машине, а не от стенда.
 */
export const HUMAN_CONFIG_FILES = [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.codex/config.toml',
    '.kimi-code/config.toml',
    '.config/opencode/opencode.json',
    '.config/opencode/opencode.jsonc',
];

/**
 * Адрес провайдера модели по CLI — единственное, куда стенд выпускает сеть. Где адрес
 * зависит от выбранного провайдера (Kimi Code, OpenCode), умолчания нет: его называет
 * `--allow`, а без него сеть закрыта целиком, а не «как-нибудь открыта».
 */
export const PROVIDER_ADDRESSES: Record<string, readonly string[]> = {
    claude: ['api.anthropic.com:443'],
    codex: ['api.openai.com:443', 'chatgpt.com:443'],
    kimi: [],
    opencode: [],
};

/**
 * Поверхности конфига CLI в дереве: из описаний пакетов реестра плюс файл конфига OpenCode
 * в его каталоге. Пакет OpenCode называет поверхностью каталог `.opencode` целиком, а
 * фиктивной цели стенда нужен файл: файл внутри каталога и делает каталог поверхностью.
 */
export function configSurfaces(harnessesDir = join(CANON_ROOT, 'adapters', 'harnesses')): string[] {
    const out = new Set<string>(['opencode.json', '.opencode/opencode.json']);
    for (const name of readdirSync(harnessesDir)) {
        const file = join(harnessesDir, name, 'descriptor.json');
        if (!existsSync(file)) continue;
        for (const s of JSON.parse(readFileSync(file, 'utf-8')).configSurfaces as string[])
            out.add(s);
    }
    if (out.size === 0)
        throw new Error('stand: ни одной поверхности конфига — описаний пакетов не найдено');
    return [...out].sort();
}

export type TStandLayout = {
    root: string;
    home: string;
    tmp: string;
    run: string;
    journal: string;
    work: string;
    mcpJournal: string;
    egressJournal: string;
    egressSocket: string;
    mcpConfig: string;
    targets: string[];
};

/** Имена раскладки в корне стенда, включая корень изоляции, который кладёт `isolate.sh`. */
export const LAYOUT_NAMES = ['home', 'work', 'journal', 'run', 'tmp', 'mcp.json', '.root'];

/**
 * Раскладка стенда. Всё, что CLI считает своим домом, кэшем и временным каталогом, — внутри.
 * Безопасные цели лежат в `work/`: фиктивный `.env`, данные контура и поверхности конфига
 * каждого CLI — те же имена, что у настоящих, с содержимым-маркером, чтобы проба правила
 * билась о настоящий путь, а эффект оставался на стенде.
 *
 * Раскладка кладётся только на чистое место. Каталог прошлого прогона пишется изнутри, и
 * `work/.env` или `mcp.json` там мог стать симлинком на файл человека: запись раскладки с
 * правами человека ушла бы по нему за пределы стенда. Поэтому любое имя раскладки на месте —
 * отказ с именем, а файлы создаются с `wx` (`O_EXCL` симлинку не следует).
 */
export function layoutStand(root: string, surfaces = configSurfaces()): TStandLayout {
    for (const n of LAYOUT_NAMES) {
        let taken = true;
        try {
            lstatSync(join(root, n));
        } catch {
            taken = false;
        }
        if (taken)
            throw new Error(
                `stand: в ${root} уже есть ${n} — раскладка прошлого прогона; нужен новый каталог`,
            );
    }
    const home = join(root, 'home');
    const work = join(root, 'work');
    const journal = join(root, 'journal');
    const run = join(root, 'run');
    const tmp = join(root, 'tmp');
    for (const d of [home, work, journal, run, tmp]) mkdirSync(d, { recursive: true });
    for (const d of ['.config', '.cache', '.local/share', '.local/state'])
        mkdirSync(join(home, d), { recursive: true });
    const marker = '# ralph-stand: фиктивный файл стенда, не настоящий\n';
    const targets: string[] = [];
    const put = (rel: string, body: string) => {
        const p = join(work, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, body, { flag: 'wx' });
        targets.push(p);
    };
    put('.env', `${marker}RALPH_STAND_SECRET=ralph-stand-fake-secret\n`);
    put('.env.local', `${marker}RALPH_STAND_SECRET=ralph-stand-fake-secret\n`);
    put(
        '.claude/ralph/hooks.json',
        JSON.stringify({ mcpMutations: [], skillRules: [], ralphStand: true }) + '\n',
    );
    // Поверхность-каталог с файлом внутри в том же наборе представлена этим файлом: положить
    // её саму файлом значило бы занять имя каталога, и файл внутри уже не создать (EEXIST).
    for (const s of surfaces.filter((x) => !surfaces.some((y) => y.startsWith(x + '/')))) {
        put(s, s.endsWith('.json') ? JSON.stringify({ ralphStand: true }) + '\n' : marker);
    }
    const mcpJournal = join(journal, 'mcp.jsonl');
    const mcpConfig = join(root, 'mcp.json');
    writeFileSync(
        mcpConfig,
        JSON.stringify(
            {
                mcpServers: {
                    'ralph-stand': {
                        type: 'stdio',
                        command: process.execPath,
                        args: [join(HERE, 'fake-mcp.mts'), mcpJournal],
                    },
                },
            },
            null,
            2,
        ) + '\n',
        { flag: 'wx' },
    );
    return {
        root,
        home,
        tmp,
        run,
        journal,
        work,
        mcpJournal,
        egressJournal: join(journal, 'egress.jsonl'),
        egressSocket: join(run, 'egress.sock'),
        mcpConfig,
        targets,
    };
}

/**
 * Окружение команды в стенде — собранное с нуля: дома CLI, XDG и TMPDIR внутри стенда, ключи
 * — только названные `passEnv`. Унаследованное окружение принесло бы `CODEX_HOME` или
 * `CLAUDE_CONFIG_DIR` человека, и CLI пошёл бы в его конфиг мимо подменённого HOME.
 */
export function standEnv(
    layout: TStandLayout,
    opts: { path: string; passEnv?: Record<string, string>; proxyPort?: number },
): Record<string, string> {
    const h = layout.home;
    const env: Record<string, string> = {
        PATH: opts.path,
        HOME: h,
        USER: 'ralph-stand',
        LANG: 'C.UTF-8',
        TMPDIR: layout.tmp,
        XDG_CONFIG_HOME: join(h, '.config'),
        XDG_CACHE_HOME: join(h, '.cache'),
        XDG_DATA_HOME: join(h, '.local/share'),
        XDG_STATE_HOME: join(h, '.local/state'),
        XDG_RUNTIME_DIR: layout.run,
        CLAUDE_CONFIG_DIR: join(h, '.claude'),
        CODEX_HOME: join(h, '.codex'),
        KIMI_CODE_HOME: join(h, '.kimi-code'),
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        OPENCODE_CONFIG_DIR: join(h, '.config/opencode'),
        RALPH_STAND: '1',
        RALPH_STAND_MCP_JOURNAL: layout.mcpJournal,
        NO_PROXY: '127.0.0.1,localhost',
    };
    if (opts.proxyPort !== undefined) {
        const url = `http://127.0.0.1:${opts.proxyPort}`;
        Object.assign(env, {
            HTTPS_PROXY: url,
            https_proxy: url,
            HTTP_PROXY: url,
            http_proxy: url,
        });
    }
    return { ...env, ...(opts.passEnv ?? {}) };
}

/**
 * Префикс namespace: без root — ещё user namespace, иначе монтировать нечем. Свои IPC, UTS
 * и cgroup — затем, что без них внутри видны SysV-очереди и разделяемая память хоста (и
 * пишутся: права на них — по uid, а не по capabilities), имя хоста меняется для всей машины,
 * а дерево cgroup показывает, что ещё на ней крутится.
 */
export function namespaceArgv(uid: number): string[] {
    return [
        'unshare',
        ...(uid === 0 ? [] : ['--map-root-user']),
        '--mount',
        '--net',
        '--pid',
        '--ipc',
        '--uts',
        '--cgroup',
        '--fork',
        '--kill-child',
    ];
}

/**
 * Пути на чтение, которых нет в системных каталогах: бинарь node и каталог этого модуля —
 * без них внутри не исполнить ни пробу, ни мост. Путь — реальный: симлинк в `/usr/bin`,
 * ведущий в дом человека, внутри вёл бы в никуда. Файл едет файлом, а не каталогом: бинарь
 * или ключ из дома человека, поданный `--ro`, открыл бы на чтение всех своих соседей.
 * Путь внутри уже названного каталога отбрасывается: он и так виден, а связать файл поверх
 * каталога только для чтения `isolate.sh` не смог бы.
 */
export function extraReadOnly(paths: readonly string[]): string[] {
    const out = new Set<string>();
    for (const p of paths) {
        const real = realpathSync(p);
        if (SYSTEM_DIRS.some((s) => real === s || real.startsWith(s + '/'))) continue;
        out.add(real);
    }
    const all = [...out];
    return all.filter((p) => !all.some((q) => q !== p && p.startsWith(q + '/'))).sort();
}

/**
 * CLI, которым бинаря мало: рядом с ним лежит исполнитель, без которого CLI внутри не
 * работает (#231). Codex исполняет code mode моделей отдельным бинарём `codex-code-mode-host`
 * из каталога релиза: стенд #188 с одним `codex` получил «host executable was not found»,
 * code mode отказал закрыто, и ни один вложенный вызов не дошёл до хука — проба судила бы
 * отказ CLI, а не барьер. Каталог едет целиком только тогда, когда этот сосед в нём есть:
 * иначе это не каталог релиза, а, например, общий `bin` в доме человека. Сам релиз
 * standalone-установки лежит в доме CLI человека (`~/.codex/packages/…/bin`), но едет только
 * этот `bin`: конфиг и ключ человека рядом с ним внутрь не попадают.
 */
const CLI_RELEASE_COMPANIONS: Readonly<Record<string, string>> = {
    codex: 'codex-code-mode-host',
};

/**
 * Что едет внутрь от бинаря CLI: `ro` — путь на чтение, `pathDir` — каталог в начало PATH
 * внутри. Обычно — сам файл по реальному пути (почему файлом — докблок `extraReadOnly`), PATH
 * не трогается. CLI с соседом по релизу — каталог релиза, и он же на PATH: симлинк из дома
 * человека (`~/.local/bin`) внутри не виден, а имя CLI должно найти тот бинарь, рядом с
 * которым лежит сосед.
 */
export function cliBinary(cli: string, bin: string): { ro: string; pathDir: string | null } {
    const real = realpathSync(bin);
    const companion = CLI_RELEASE_COMPANIONS[cli];
    if (!companion) return { ro: real, pathDir: null };
    const dir = dirname(real);
    if (!existsSync(join(dir, companion)))
        throw new Error(
            `stand exec: рядом с ${real} нет ${companion} — без него ${cli} внутри не исполнит ни одного вызова`,
        );
    return { ro: dir, pathDir: dir };
}

/**
 * Текст списка для `isolate.sh`: `ro <путь>` и `bind <файл> <путь в стенде>`. Строки `ro`
 * связываются ПОСЛЕ стенда, поэтому `ro` предка стенда (или его самого) закрыл бы стенд на
 * запись: проба падала бы на собственной раскладке, и причину называли бы только красные
 * тесты. Такой путь — отказ сразу, с именем.
 */
export function isolationList(
    ro: readonly string[],
    binds: readonly { src: string; dst: string }[],
    stands: readonly string[] = [],
): string {
    for (const p of [...ro, ...binds.flatMap((b) => [b.src, b.dst])]) {
        if (/\s/.test(p) || !p.startsWith('/'))
            throw new Error(`stand: путь списка не абсолютный или с пробелом: ${p}`);
    }
    for (const p of ro) {
        const base = p === '/' ? '/' : p.replace(/\/+$/, '') + '/';
        const hit = stands.find((st) => st === p || (st + '/').startsWith(base));
        if (hit)
            throw new Error(
                `stand: путь на чтение ${p} накрывает каталог стенда ${hit} — стенд стал бы только для чтения`,
            );
    }
    return (
        [...ro.map((p) => `ro ${p}`), ...binds.map((b) => `bind ${b.src} ${b.dst}`)].join('\n') +
        '\n'
    );
}

export type TIsolated = { argv: string[]; env: Record<string, string> };

/** Полная команда запуска в изоляции; список путей пишется в каталог стенда. */
export function isolatedCommand(
    layout: TStandLayout,
    command: readonly string[],
    opts: {
        env: Record<string, string>;
        ro?: readonly string[];
        binds?: readonly { src: string; dst: string }[];
        uid?: number;
    },
): TIsolated {
    const list = join(layout.run, 'isolate.list');
    const ro = extraReadOnly([process.execPath, HERE, ...(opts.ro ?? [])]);
    const stands = [...new Set([layout.root, realpathSync(layout.root)])];
    writeFileSync(list, isolationList(ro, opts.binds ?? [], stands), { flag: 'wx' });
    return {
        argv: [
            ...namespaceArgv(opts.uid ?? process.getuid!()),
            'sh',
            ISOLATE_SH,
            layout.root,
            list,
            '--',
            ...command,
        ],
        env: opts.env,
    };
}

// ─── проверка изоляции ───────────────────────────────────────────────────────────────

export type TEscapeTarget = { path: string; kind: 'outside' | 'human-cli-home' | 'inside' };

/**
 * Цели пробы выхода: каталог рядом со стендом (вне его), системный временный каталог, дома
 * CLI человека — и парная цель внутри стенда, у которой запись обязана пройти. Имена
 * уникальны: файл, оставшийся от прошлого прогона, не засчитается этому.
 */
export function escapeTargets(
    layout: TStandLayout,
    humanHome: string,
    tag = randomBytes(6).toString('hex'),
): TEscapeTarget[] {
    const name = `ralph-stand-escape-${tag}`;
    return [
        { path: join(layout.work, `ralph-stand-allowed-${tag}`), kind: 'inside' },
        { path: join(dirname(layout.root), name), kind: 'outside' },
        { path: join('/var/tmp', name), kind: 'outside' },
        { path: join('/dev/shm', name), kind: 'outside' },
        ...HUMAN_CLI_HOMES.map((h) => ({
            path: join(humanHome, h, name),
            kind: 'human-cli-home' as const,
        })),
    ];
}

/**
 * Исходник пробы внутри: для каждой цели создаёт недостающие каталоги ПО ОДНОМУ сверху вниз и
 * пишет файл. Рекурсивный `mkdir` отдаёт ENOENT вместо EROFS — отказ ОС выглядел бы как
 * опечатка в пути.
 */
export const ESCAPE_PROBE_SOURCE = `
const fs = require('fs');
const path = require('path');
const out = [];
for (const p of JSON.parse(process.argv[1])) {
    let code = 'written';
    try {
        const parts = path.dirname(p).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur += '/' + part;
            if (!fs.existsSync(cur)) fs.mkdirSync(cur);
        }
        fs.writeFileSync(p, 'ralph-stand escape probe\\n');
    } catch (e) {
        code = e.code || String(e);
    }
    out.push({ path: p, code });
}
process.stdout.write(JSON.stringify(out));
`;

export type TProbeResult = { path: string; code: string };

/** Хеши конфигов человека; отсутствующий файл — `absent`, а не пропуск. */
export function snapshotHumanConfigs(
    humanHome: string,
    files: readonly string[] = HUMAN_CONFIG_FILES,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rel of files) {
        const p = join(humanHome, rel);
        out[rel] = existsSync(p)
            ? createHash('sha256').update(readFileSync(p)).digest('hex')
            : 'absent';
    }
    return out;
}

export type TIsolationVerdict = { ok: boolean; failures: string[]; passes: string[] };

/**
 * Вердикт проверки изоляции. Красное — любое из:
 *   - результатов нет или не по каждой цели: пустой результат — красный;
 *   - запись внутри стенда не прошла — проба без парной разрешённой ничего не доказывает;
 *   - запись вне стенда прошла изнутри ИЛИ её файл виден на хосте;
 *   - запись вне стенда отвергнута не отказом ОС (ENOENT и прочее — не доказательство);
 *   - хеши конфигов человека разошлись.
 * Совпавшие хеши ни одно из нарушений не снимают.
 */
export function judgeIsolation(input: {
    targets: readonly TEscapeTarget[];
    results: readonly TProbeResult[] | null;
    hostExists: (p: string) => boolean;
    before: Record<string, string>;
    after: Record<string, string>;
}): TIsolationVerdict {
    const failures: string[] = [];
    const passes: string[] = [];
    if (!input.results || input.results.length === 0) {
        failures.push('проба изнутри не вернула результатов');
    }
    const byPath = new Map((input.results ?? []).map((r) => [r.path, r.code]));
    for (const t of input.targets) {
        const code = byPath.get(t.path);
        if (code === undefined) {
            failures.push(`${t.path}: нет результата пробы`);
            continue;
        }
        if (t.kind === 'inside') {
            if (code === 'written' && input.hostExists(t.path))
                passes.push(`${t.path}: запись внутри стенда прошла`);
            else
                failures.push(
                    `${t.path}: запись внутри стенда не прошла (${code}) — парной разрешённой пробы нет`,
                );
            continue;
        }
        if (input.hostExists(t.path)) {
            failures.push(
                `${t.path}: файл появился на хосте — выход за пределы стенда (убери его руками)`,
            );
        } else if (code === 'written') {
            failures.push(`${t.path}: запись изнутри прошла — выход за пределы стенда`);
        } else if (!(OS_REFUSALS as readonly string[]).includes(code)) {
            failures.push(`${t.path}: отказ ${code} — не отказ ОС, изоляция не доказана`);
        } else {
            passes.push(`${t.path}: отказ ОС ${code}`);
        }
    }
    for (const rel of new Set([...Object.keys(input.before), ...Object.keys(input.after)])) {
        if (input.before[rel] !== input.after[rel])
            failures.push(`конфиг человека ~/${rel} изменился за прогон`);
    }
    return { ok: failures.length === 0, failures, passes };
}

type TSpawnSync = typeof spawnSync;

/** Доступна ли изоляция на этой машине: пустая команда в стенде. Причину отказа — словами. */
export function isolationAvailable(spawnFn: TSpawnSync = spawnSync): {
    ok: boolean;
    reason: string;
} {
    const root = mkdtempSync(join(tmpdir(), 'ralph-stand-avail.'));
    let r: ReturnType<TSpawnSync>;
    try {
        const layout = layoutStand(root, []);
        const cmd = isolatedCommand(layout, ['/bin/true'], {
            env: standEnv(layout, { path: '/usr/bin:/bin' }),
        });
        r = spawnFn(cmd.argv[0], cmd.argv.slice(1), {
            env: cmd.env,
            encoding: 'utf-8',
            timeout: 30_000,
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
    if (r.status === 0) return { ok: true, reason: 'namespace доступны' };
    return {
        ok: false,
        reason: `изоляция не поднялась (код ${r.status}): ${String(r.stderr || r.error || '').trim()}`,
    };
}

/**
 * Проверка изоляции целиком при выключенном барьере: раскладка, снимок конфигов человека,
 * проба изнутри, осмотр хоста, второй снимок, вердикт.
 */
export function runIsolationCheck(opts: {
    root: string;
    humanHome: string;
    spawnFn?: TSpawnSync;
    hostExists?: (p: string) => boolean;
}): TIsolationVerdict & { targets: TEscapeTarget[] } {
    const spawnFn = opts.spawnFn ?? spawnSync;
    const layout = layoutStand(opts.root);
    const targets = escapeTargets(layout, opts.humanHome);
    const before = snapshotHumanConfigs(opts.humanHome);
    const cmd = isolatedCommand(
        layout,
        [process.execPath, '-e', ESCAPE_PROBE_SOURCE, JSON.stringify(targets.map((t) => t.path))],
        { env: standEnv(layout, { path: '/usr/bin:/bin' }) },
    );
    const r = spawnFn(cmd.argv[0], cmd.argv.slice(1), {
        env: cmd.env,
        encoding: 'utf-8',
        timeout: 60_000,
    });
    let results: TProbeResult[] | null = null;
    if (r.status === 0) {
        try {
            results = JSON.parse(String(r.stdout));
        } catch {
            results = null;
        }
    }
    const after = snapshotHumanConfigs(opts.humanHome);
    const verdict = judgeIsolation({
        targets,
        results,
        hostExists: opts.hostExists ?? existsSync,
        before,
        after,
    });
    if (r.status !== 0) {
        verdict.failures.unshift(
            `проба в изоляции упала (код ${r.status}): ${String(r.stderr || r.error || '').trim()}`,
        );
        verdict.ok = false;
    }
    return { ...verdict, targets };
}

// ─── запуск команды в стенде ─────────────────────────────────────────────────────────

/**
 * Разбор аргументов `exec`; незнакомый флаг — отказ, а не «проигнорирую». Так же и с
 * лишним: `--bind a:b:c` молча потерял бы `:c`, а адрес upstream с кредами в argv виден
 * в `ps` любому пользователю хоста — для него есть `--upstream-proxy-env`.
 */
export function parseExecArgs(
    argv: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
): {
    stand: string;
    cli: string;
    allow: string[];
    ro: string[];
    pathDirs: string[];
    binds: { src: string; dst: string }[];
    passEnv: string[];
    upstream: TUpstreamProxy | null;
    command: string[];
} {
    const out = {
        stand: '',
        cli: '',
        allow: [] as string[],
        ro: [] as string[],
        pathDirs: [] as string[],
        binds: [] as { src: string; dst: string }[],
        passEnv: [] as string[],
        upstream: null as TUpstreamProxy | null,
        command: [] as string[],
    };
    let cliBin: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const v = argv[i + 1];
        if (a === '--') {
            out.command = argv.slice(i + 1);
            break;
        }
        if (v === undefined) throw new Error(`stand exec: у ${a} нет значения`);
        i++;
        if (a === '--stand') out.stand = resolve(v);
        else if (a === '--cli') out.cli = v;
        else if (a === '--allow') out.allow.push(v);
        else if (a === '--ro') out.ro.push(v);
        else if (a === '--cli-bin') cliBin = v;
        else if (a === '--pass-env') out.passEnv.push(v);
        else if (a === '--upstream-proxy') {
            out.upstream = parseUpstreamProxy(v);
            if (out.upstream.auth)
                throw new Error(
                    'stand exec: креды upstream в argv видны в ps — передай адрес через --upstream-proxy-env <ИМЯ>',
                );
        } else if (a === '--upstream-proxy-env')
            out.upstream = parseUpstreamProxy(upstreamFromEnv(v, env));
        else if (a === '--bind') {
            const parts = v.split(':');
            const [src, dst] = parts;
            if (parts.length !== 2 || !src || !dst)
                throw new Error(`stand exec: --bind <файл>:<путь в стенде>, а не ${v}`);
            out.binds.push({ src, dst });
        } else throw new Error(`stand exec: незнакомый флаг ${a}`);
    }
    if (!out.stand) throw new Error('stand exec: нужен --stand');
    if (!(out.cli in PROVIDER_ADDRESSES))
        throw new Error(`stand exec: незнакомый CLI «${out.cli}»`);
    if (out.command.length === 0) throw new Error('stand exec: нет команды после --');
    if (cliBin !== null) {
        const b = cliBinary(out.cli, cliBin);
        out.ro.push(b.ro);
        if (b.pathDir) out.pathDirs.push(b.pathDir);
    }
    return out;
}

async function execInStand(argv: readonly string[]): Promise<number> {
    const a = parseExecArgs(argv);
    mkdirSync(a.stand, { recursive: true });
    const layout = layoutStand(a.stand);
    const allow = [...PROVIDER_ADDRESSES[a.cli], ...a.allow];
    const passEnv: Record<string, string> = {};
    for (const n of a.passEnv) {
        const v = process.env[n];
        if (v === undefined) throw new Error(`stand exec: --pass-env ${n}, но переменной нет`);
        passEnv[n] = v;
    }
    const port = 18000 + (process.pid % 1000);
    // Журнал открыт до старта команды: изнутри его имя пишется, а прокси пишет по дескриптору
    // (почему — докблок `egress.mts`).
    const journal = allow.length > 0 ? openJournal(layout.egressJournal) : null;
    const proxy = journal
        ? startEgressProxy(layout.egressSocket, allow, {
              ...(a.upstream ? { upstream: a.upstream } : {}),
              journalFn: journal.write,
          })
        : null;
    const inner = proxy
        ? [
              process.execPath,
              join(HERE, 'egress.mts'),
              'bridge',
              layout.egressSocket,
              String(port),
              '--',
              ...a.command,
          ]
        : a.command;
    const cmd = isolatedCommand(layout, inner, {
        env: standEnv(layout, {
            path: [...a.pathDirs, process.env.PATH ?? '/usr/bin:/bin'].join(':'),
            passEnv,
            proxyPort: proxy ? port : undefined,
        }),
        ro: a.ro,
        binds: a.binds,
    });
    try {
        return await runChild(cmd);
    } finally {
        proxy?.close();
        journal?.close();
    }
}

/**
 * Запуск собранной команды. Без обработчика `error` несостоявшийся запуск (`unshare` не
 * найден) ронял процесс необработанным исключением, и стек вместо причины уходил в отчёт.
 */
export function runChild(cmd: TIsolated, spawnFn: typeof spawn = spawn): Promise<number> {
    return new Promise((res, rej) => {
        const child = spawnFn(cmd.argv[0], cmd.argv.slice(1), { env: cmd.env, stdio: 'inherit' });
        child.on('error', (e) =>
            rej(new Error(`stand exec: ${cmd.argv[0]} не запустился: ${e.message}`)),
        );
        child.on('exit', (c, s) => res(exitCodeOf(c, s)));
    });
}

/** Дом человека для `check`: `--human-home` без значения — отказ словами, а не TypeError. */
export function parseCheckArgs(argv: readonly string[], home: string | undefined): string {
    const i = argv.indexOf('--human-home');
    if (i < 0) {
        if (!home) throw new Error('stand check: нет HOME и не задан --human-home');
        return home;
    }
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error('stand check: у --human-home нет значения');
    return resolve(v);
}

if (import.meta.main) {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === 'check') {
        let humanHome: string;
        try {
            humanHome = parseCheckArgs(rest, process.env.HOME);
        } catch (e) {
            process.stderr.write(`${(e as Error).message}\n`);
            process.exit(1);
        }
        const root = mkdtempSync(join(tmpdir(), 'ralph-stand.'));
        const v = runIsolationCheck({ root, humanHome });
        for (const p of v.passes) process.stdout.write(`  ✓ ${p}\n`);
        for (const f of v.failures) process.stdout.write(`  ✗ ${f}\n`);
        // Стенд убирается и на красном: на хосте после пробы лежит только то, что вылезло за
        // его пределы, и оно названо в отчёте поимённо. STAND_KEEP=1 оставляет стенд разбору.
        if (process.env.STAND_KEEP !== '1') rmSync(root, { recursive: true, force: true });
        process.stdout.write(`RESULT isolation ${v.ok ? 'PASS' : 'FAIL'} — стенд ${root}\n`);
        process.exit(v.ok ? 0 : 1);
    } else if (mode === 'exec') {
        execInStand(rest).then(
            (code) => process.exit(code),
            (e) => {
                process.stderr.write(`${(e as Error).message}\n`);
                process.exit(2);
            },
        );
    } else {
        process.stderr.write(
            'stand: check [--human-home <дом>] | exec --stand <каталог> --cli <имя> … -- <команда…>\n',
        );
        process.exit(2);
    }
}

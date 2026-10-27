/**
 * Команды launcher `./ralph`: install, doctor, start, stop, version (Фаза 12, `#36` часть 1).
 *
 * Пока человек вбивал SHA и пути руками, продукта не было — была инструкция по сборке
 * (PRD, сценарий владельца проекта). Здесь механизм доставки (`core-install.ts`) и контракт
 * совместимости (`compat.ts`) собраны в четыре команды, и у каждой одно обязательство:
 *
 *   - **install** ставит ревизию из `.ralph/core.lock`, а при пустом `.ralph/` — названную
 *     явно (`--rev`) из названного источника, и пишет lock. «Последней» ревизии нет: SHA,
 *     который выбрал не человек, — та же неизвестность, ради которой lock заведён. Lock,
 *     который есть, но не читается, install не перезаписывает: битый lock — повод
 *     разобраться, а не начать с чистого листа. Смена ревизии — `update` (Фаза 13), и
 *     `--rev`, разошедшийся с lock, — отказ, а не тихая переустановка.
 *   - **doctor** — те же проверки без старта, и проваленная проверка не прячет следующую:
 *     человек чинит установку за один заход, а не по одной причине на запуск. Проверка,
 *     которой нужен результат проваленной, не «проходит» и не молчит — она названа
 *     пропущенной с причиной. Код изменённого дерева doctor не исполняет: версии ревизии и
 *     `--doctor` ядра спрашиваются только у дерева, совпавшего с lock.
 *   - **start** — те же проверки, затем `ralph.js` установленной ревизии. Ядро сверяет
 *     себя с lock ещё раз в `main()`: launcher отвечает за то, ЧТО запускать, ядро — за то,
 *     что запущено именно оно.
 *   - **stop** кладёт запрос мягкой остановки (`ralph.stop`, #88) и не шлёт ни одного
 *     сигнала: петля слышит запрос только на границе итерации, начатая сессия доводится.
 *     Сигнал прервал бы сессию посреди правки, и дерево осталось бы грязным. Лока нет или
 *     его владелец мёртв (брошен после `kill -9`, OOM) — отказ: запрос без живой петли
 *     остановил бы следующий старт на первом шаге.
 *
 * Слой «launcher» в контракте совместимости — шим `./ralph` у потребителя
 * (`examples/ralph`), а не этот модуль: модуль едет с ревизией ядра и с ней совпадает по
 * построению, а шим живёт в дереве потребителя и обновляется отдельно. Поэтому версию
 * launcher называет `RALPH_LAUNCHER_VERSION` из окружения, которое выставил шим.
 *
 * Чего модуль НЕ обещает, сказано вслух. Шим исполняет `launcher.mts` установленной
 * ревизии ДО сверки её дерева: правка самого launcher в установке снимает сверку launcher,
 * и тогда остаётся только сверка в `main()` ядра — того же дерева. Барьер, которого правкой
 * установки не снять, требует сверщика вне неё; здесь его нет.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { isAbsolute, join } from 'node:path';
import {
    CORE_LOCK_PATH,
    CORE_LOCK_SCHEMA,
    parseCoreVersions,
    readCoreLock,
    resolveDataDir,
    verifyInstalledTree,
    type TCoreLock,
    type TCoreVersions,
    type TInstallResult,
    type TTreeReadFs,
} from './core-install.ts';
import { COMPAT_LAYERS, LAUNCHER_VERSION_ENV, observeLauncher } from './compat.ts';
import { runtimePathsIn } from './runtime-paths.ts';

export const LAUNCHER_COMMANDS = ['install', 'doctor', 'start', 'stop', 'version'] as const;
export type TLauncherCommand = (typeof LAUNCHER_COMMANDS)[number];

export type TLauncherArgs = {
    command: TLauncherCommand;
    consumerRoot: string;
    source: string | null;
    rev: string | null;
    profile: string | null;
    /** Флаги, которые уходят `ralph.js` как есть (`start`, `doctor`). */
    passthrough: string[];
};

export type TParsedArgs = { ok: true; args: TLauncherArgs } | { ok: false; reason: string };

const USAGE =
    'Команды: install [--rev <ревизия>], doctor, start [флаги ralph.js], stop [--profile <имя>], version.';

/**
 * Разбор командной строки launcher. Свои флаги (`--consumer`, `--source`, `--rev`) launcher
 * забирает, остальное у `start`/`doctor` уходит ядру — у того свой allowlist флагов. У
 * остальных команд незнакомый флаг — отказ: опечатка в `install` не должна превращаться в
 * установку не той ревизии.
 */
export function parseLauncherArgv(argv: readonly string[]): TParsedArgs {
    let command: string | null = null;
    let consumerRoot: string | null = null;
    let source: string | null = null;
    let rev: string | null = null;
    let profile: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = (): string | null => {
            const v = argv[i + 1];
            i++;
            return v === undefined || v.startsWith('--') ? null : v;
        };
        if (a === '--consumer' || a === '--source' || a === '--rev') {
            const v = value();
            if (v === null) return { ok: false, reason: `${a} без значения. ${USAGE}` };
            // `--consumer` ставит шим перед аргументами человека, а разбор берёт последнее
            // значение: второй `--consumer` молча увёл бы команду в чужое дерево.
            if (a === '--consumer' && consumerRoot !== null) {
                return {
                    ok: false,
                    reason: '--consumer повторён: флаг ставит ./ralph своим каталогом, руками его не задают.',
                };
            }
            if (a === '--consumer') consumerRoot = v;
            else if (a === '--source') source = v;
            else rev = v;
        } else if (command === null && !a.startsWith('-')) {
            command = a;
        } else {
            rest.push(a);
        }
    }
    if (command === null) return { ok: false, reason: `Команда не названа. ${USAGE}` };
    if (!(LAUNCHER_COMMANDS as readonly string[]).includes(command)) {
        return { ok: false, reason: `Неизвестная команда "${command}". ${USAGE}` };
    }
    if (consumerRoot === null || !isAbsolute(consumerRoot)) {
        return {
            ok: false,
            reason: '--consumer <абсолютный путь> не задан: launcher зовут через ./ralph, он передаёт свой каталог.',
        };
    }
    const cmd = command as TLauncherCommand;
    if ((source !== null || rev !== null) && cmd !== 'install') {
        return { ok: false, reason: `--source и --rev — флаги install, а не ${cmd}.` };
    }
    if (cmd === 'stop') {
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '--profile') {
                // Значение с `--` — следующий флаг, а не имя профиля: принятое как имя, оно
                // увело бы запрос в каталог состояния несуществующего профиля.
                const v = rest[i + 1];
                if (v === undefined || v.startsWith('--')) {
                    return { ok: false, reason: `--profile без значения. ${USAGE}` };
                }
                profile = v;
                i++;
                continue;
            }
            return { ok: false, reason: `stop не знает флага "${rest[i]}". ${USAGE}` };
        }
        rest.length = 0;
    }
    if ((cmd === 'install' || cmd === 'version') && rest.length > 0) {
        return { ok: false, reason: `${cmd} не знает флага "${rest[0]}". ${USAGE}` };
    }
    return {
        ok: true,
        args: { command: cmd, consumerRoot, source, rev, profile, passthrough: rest },
    };
}

export type TLauncherDeps = {
    env: Record<string, string | undefined>;
    out: (line: string) => void;
    /** Чтение lock и прочих файлов потребителя. */
    readFn: (p: string) => string;
    exists: (p: string) => boolean;
    fsr?: TTreeReadFs;
    /** Установка ревизии (`installRevision` с экспортом из источника). */
    installFn: (p: {
        sha: string;
        dataDir: string;
        source: string | null;
        expectedTreeHash?: string;
    }) => TInstallResult;
    writeLockFn: (consumerRoot: string, lock: TCoreLock) => string;
    /** Ревизия источника → полный SHA. Неоднозначная или отсутствующая — бросает. */
    resolveRevFn: (source: string, rev: string) => string;
    /** Версии слоёв, на которых говорит установленная ревизия, — её собственным кодом. */
    versionsOfFn: (dir: string) => unknown;
    /** `node <dir>/ralph.js <args>` с cwd потребителя; код выхода. */
    runCoreFn: (dir: string, args: string[], consumerRoot: string) => number;
    /** `runtimeDir` экземпляра по конфигу потребителя и профилю. */
    runtimeDirOfFn: (consumerRoot: string, profile: string | null) => string;
    /**
     * Жив ли раннер с этим pid, запущенный именно этим entry (`<dir>/ralph.js` ревизии из
     * lock): `runnerAlive` в `core-install.ts`. Номер мёртвого владельца мог достаться
     * постороннему процессу, и подстрока `ralph.js` его не отличила бы.
     */
    ralphAliveFn: (pid: number, entry: string) => boolean;
    writeStopFn: (p: string) => void;
};

export type TCheckStatus = 'ok' | 'fail' | 'skip';
export type TCheck = { name: string; status: TCheckStatus; detail: string };

const MARK: Record<TCheckStatus, string> = { ok: '✅', fail: '❌', skip: '⏭' };

export function formatCheck(c: TCheck): string {
    return `${MARK[c.status]} ${c.name}: ${c.detail}`;
}

function describeVersions(v: TCoreVersions): string {
    return COMPAT_LAYERS.map((l) => `${l} v${String(v[l])}`).join(', ');
}

type TInstallation = {
    checks: TCheck[];
    lock: TCoreLock | null;
    dir: string | null;
    treeOk: boolean;
};

/**
 * Проверки установки, общие для doctor и start: lock, каталог ревизии, дерево, версия
 * launcher, версии ревизии. Не останавливаются на первом провале — каждая следующая либо
 * проверяется, либо названа пропущенной с причиной.
 */
export function inspectInstallation(consumerRoot: string, deps: TLauncherDeps): TInstallation {
    const checks: TCheck[] = [];
    const skip = (name: string, why: string) => checks.push({ name, status: 'skip', detail: why });
    const r = readCoreLock(consumerRoot, deps.readFn);
    let lock: TCoreLock | null = null;
    if (r.ok) {
        lock = r.lock;
        checks.push({
            name: 'lock',
            status: 'ok',
            detail: `${r.path}: ревизия ${r.lock.sha}`,
        });
    } else {
        checks.push({ name: 'lock', status: 'fail', detail: r.reason });
    }

    let dir: string | null = null;
    if (lock === null) {
        skip('установка', 'нет lock — неизвестно, какую ревизию искать');
    } else {
        let dataDir: string | null = null;
        try {
            dataDir = resolveDataDir(deps.env);
        } catch (e) {
            checks.push({ name: 'установка', status: 'fail', detail: (e as Error).message });
        }
        if (dataDir !== null) {
            const candidate = join(dataDir, lock.sha);
            if (deps.exists(candidate)) {
                dir = candidate;
                checks.push({ name: 'установка', status: 'ok', detail: candidate });
            } else {
                checks.push({
                    name: 'установка',
                    status: 'fail',
                    detail: `${candidate} нет — поставь ревизию: ./ralph install`,
                });
            }
        }
    }

    let treeOk = false;
    if (lock === null || dir === null) {
        skip('дерево', 'нет установленной ревизии — сверять нечего');
    } else {
        const v = verifyInstalledTree(dir, lock, deps.fsr);
        treeOk = v.ok;
        checks.push(
            v.ok
                ? { name: 'дерево', status: 'ok', detail: `совпало с lock (${lock.treeHash})` }
                : { name: 'дерево', status: 'fail', detail: v.reason },
        );
    }

    const launcher = observeLauncher(deps.env);
    if (lock === null) {
        skip('launcher', 'нет lock — неизвестно, какую версию launcher ждёт ревизия');
    } else if (launcher.kind === 'version') {
        const want = lock.versions.launcher;
        checks.push(
            launcher.version === want
                ? { name: 'launcher', status: 'ok', detail: `v${String(want)}` }
                : {
                      name: 'launcher',
                      status: 'fail',
                      detail: `ревизия ждёт launcher v${String(want)}, найден v${String(launcher.version)} — обнови ./ralph из ревизии ${lock.sha}`,
                  },
        );
    } else {
        checks.push({
            name: 'launcher',
            status: 'fail',
            detail:
                launcher.kind === 'invalid'
                    ? launcher.reason
                    : `${LAUNCHER_VERSION_ENV} не задан — зови через ./ralph, а не launcher.mts напрямую`,
        });
    }

    if (lock === null || dir === null || !treeOk) {
        skip('версии ревизии', 'дерево не сверено с lock — его код не исполняется');
    } else {
        try {
            const parsed = parseCoreVersions(deps.versionsOfFn(dir));
            if (!parsed.ok) throw new Error(`ответ не по контракту (${parsed.reason})`);
            const v = parsed.versions;
            const diff = COMPAT_LAYERS.filter((l) => v[l] !== lock.versions[l]);
            checks.push(
                diff.length === 0
                    ? { name: 'версии ревизии', status: 'ok', detail: describeVersions(v) }
                    : {
                          name: 'версии ревизии',
                          status: 'fail',
                          detail: `lock называет ${describeVersions(lock.versions)}, ревизия говорит ${describeVersions(v)}`,
                      },
            );
        } catch (e) {
            checks.push({
                name: 'версии ревизии',
                status: 'fail',
                detail: `ревизия не назвала свои версии: ${(e as Error).message}`,
            });
        }
    }
    return { checks, lock, dir, treeOk };
}

const allOk = (checks: readonly TCheck[]) => checks.every((c) => c.status === 'ok');

/**
 * doctor: проверки установки и `--doctor` самого ядра (совместимость пяти слоёв с конфигом
 * и state). Код 0 — только если прошли все; пропущенная проверка — не «прошла».
 */
export function runDoctorCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const inst = inspectInstallation(args.consumerRoot, deps);
    const checks = [...inst.checks];
    if (inst.dir === null || !inst.treeOk) {
        checks.push({
            name: 'ядро',
            status: 'skip',
            detail: 'дерево не сверено с lock — его --doctor не исполняется',
        });
    } else {
        const code = deps.runCoreFn(inst.dir, ['--doctor', ...args.passthrough], args.consumerRoot);
        checks.push(
            code === 0
                ? { name: 'ядро', status: 'ok', detail: 'ralph.js --doctor: старт разрешён' }
                : {
                      name: 'ядро',
                      status: 'fail',
                      detail: `ralph.js --doctor вышел с кодом ${String(code)} — причина в его отчёте выше`,
                  },
        );
    }
    for (const c of checks) deps.out(formatCheck(c));
    const failed = checks.filter((c) => c.status !== 'ok');
    if (failed.length === 0) {
        deps.out('🩺 doctor: все проверки прошли');
        return 0;
    }
    deps.out(
        `🩺 doctor: не прошли ${String(failed.length)} из ${String(checks.length)} — ${failed.map((c) => c.name).join(', ')}`,
    );
    return 1;
}

export function runStartCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const inst = inspectInstallation(args.consumerRoot, deps);
    if (!allOk(inst.checks) || inst.dir === null || inst.lock === null) {
        for (const c of inst.checks) if (c.status !== 'ok') deps.out(formatCheck(c));
        deps.out('⛔ start отменён: установка не прошла проверку — подробности: ./ralph doctor');
        return 1;
    }
    deps.out(`▶ Ralph ${inst.lock.sha} из ${inst.dir}`);
    // Дерево здесь уже сверено (`inspectInstallation`), и `main()` ядра сверит его ещё раз —
    // хэшем всего дерева второй раз подряд. Это намеренно, не оптимизируй: launcher отвечает
    // за то, ЧТО запускать, ядро — за то, что запущено именно оно, и сверка ядра обязана
    // стоять и при прямом `node <dir>/ralph.js` мимо launcher.
    return deps.runCoreFn(inst.dir, args.passthrough, args.consumerRoot);
}

export function runInstallCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const lockPath = join(args.consumerRoot, CORE_LOCK_PATH);
    let dataDir: string;
    try {
        dataDir = resolveDataDir(deps.env);
    } catch (e) {
        deps.out(`⛔ install: ${(e as Error).message}`);
        return 1;
    }
    try {
        if (!deps.exists(lockPath)) {
            if (args.source === null || args.rev === null) {
                deps.out(
                    `⛔ install: ${lockPath} нет, а ревизия не названа. Первая установка — ` +
                        'RALPH_SOURCE=<клон канона> ./ralph install --rev <ревизия>: ' +
                        '«последней» ревизии launcher не выбирает.',
                );
                return 1;
            }
            const sha = deps.resolveRevFn(args.source, args.rev);
            const res = deps.installFn({ sha, dataDir, source: args.source });
            if (res.status === 'present') {
                // Каталог уже лежал, а lock ещё нет: сверить его не с чем, кроме собственного
                // манифеста. Без этой сверки правленое дерево исполнило бы свой код
                // (`versionsOfFn`) и закрепилось бы в lock эталоном. Правку дерева ВМЕСТЕ с
                // манифестом так не поймать — это предел первой установки, а не сверки.
                const v = verifyInstalledTree(res.dir, { treeHash: res.treeHash }, deps.fsr);
                if (!v.ok) {
                    deps.out(
                        `⛔ install: ревизия ${sha} уже лежала в ${res.dir}, но ${v.reason}. ` +
                            'В lock она не идёт — убери каталог и поставь заново.',
                    );
                    return 1;
                }
            }
            const vr = parseCoreVersions(deps.versionsOfFn(res.dir));
            if (!vr.ok) {
                deps.out(
                    `⛔ install: ревизия ${sha} назвала версии слоёв не по контракту (${vr.reason}). ` +
                        'Lock не пишется: битый lock следующий install не перезаписал бы.',
                );
                return 1;
            }
            const versions = vr.versions;
            const written = deps.writeLockFn(args.consumerRoot, {
                schema: CORE_LOCK_SCHEMA,
                sha,
                treeHash: res.treeHash,
                versions,
            });
            deps.out(`📦 Ревизия ${sha} ${statusWord(res)} в ${res.dir}; lock записан: ${written}`);
        } else {
            const r = readCoreLock(args.consumerRoot, deps.readFn);
            if (!r.ok) {
                deps.out(
                    `⛔ install: ${r.reason}. Битый lock не перезаписывается — почини его или верни из истории.`,
                );
                return 1;
            }
            if (args.rev !== null) {
                if (args.source === null) {
                    deps.out(
                        '⛔ install: --rev без источника (RALPH_SOURCE) — сверить его с lock нечем.',
                    );
                    return 1;
                }
                const sha = deps.resolveRevFn(args.source, args.rev);
                if (sha !== r.lock.sha) {
                    deps.out(
                        `⛔ install: --rev ${args.rev} — это ${sha}, а ${r.path} называет ${r.lock.sha}. ` +
                            'Смена ревизии — update, а не install.',
                    );
                    return 1;
                }
            }
            const res = deps.installFn({
                sha: r.lock.sha,
                dataDir,
                source: args.source,
                expectedTreeHash: r.lock.treeHash,
            });
            deps.out(`📦 Ревизия ${r.lock.sha} ${statusWord(res)} в ${res.dir}`);
        }
    } catch (e) {
        deps.out(`⛔ install: ${(e as Error).message}`);
        return 1;
    }
    // Контракт совместимости — тем же doctor, что зовёт человек: «поставлено» без проверки
    // значило бы «поставлено что-то», и узналось бы это на первом старте.
    return runDoctorCommand({ ...args, passthrough: [] }, deps);
}

function statusWord(res: TInstallResult): string {
    return res.status === 'installed' ? 'установлена' : 'уже стояла';
}

export function runStopCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    let runtimeDir: string;
    try {
        runtimeDir = deps.runtimeDirOfFn(args.consumerRoot, args.profile);
    } catch (e) {
        deps.out(`⛔ stop: каталог состояния не определён — ${(e as Error).message}`);
        return 1;
    }
    const paths = runtimePathsIn(runtimeDir);
    if (!deps.exists(paths.lock)) {
        deps.out(
            `⛔ stop: ${paths.lock} нет — петля здесь не идёт. Запрос без живой петли ` +
                'остановил бы следующий старт на первом шаге, поэтому он не кладётся.',
        );
        return 1;
    }
    // Лок на диске — ещё не живая петля: после `kill -9` или OOM он остаётся, и запрос,
    // положенный рядом с брошенным локом, остановил бы следующий старт на первой границе.
    let ownerText: string;
    try {
        ownerText = deps.readFn(paths.lock).trim();
    } catch (e) {
        deps.out(
            `⛔ stop: ${paths.lock} не читается (${(e as Error).message}) — жива ли петля, ` +
                'не проверить, и запрос не кладётся.',
        );
        return 1;
    }
    const owner = /^[1-9]\d*$/.test(ownerText) ? Number(ownerText) : null;
    if (owner === null) {
        deps.out(
            `⛔ stop: в ${paths.lock} не pid (${JSON.stringify(ownerText.slice(0, 40))}) — жива ли ` +
                'петля, не проверить, и запрос не кладётся.',
        );
        return 1;
    }
    // Живая петля — это `ralph.js` ревизии из lock: её путь и сверяется с argv владельца.
    const entry = lockedEntry(args.consumerRoot, deps);
    if (!entry.ok) {
        deps.out(
            `⛔ stop: ${entry.reason} — чей раннер держит лок, не проверить, и запрос не кладётся.`,
        );
        return 1;
    }
    if (!deps.ralphAliveFn(owner, entry.path)) {
        deps.out(
            `⛔ stop: лок ${paths.lock} брошен — раннера ${entry.path} с pid ${String(owner)} нет, ` +
                'петля здесь не идёт. Следующий старт снимет лок сам; запрос не кладётся, иначе ' +
                'он остановил бы этот старт на первом шаге.',
        );
        return 1;
    }
    const already = () =>
        deps.out(
            `⏸ Запрос остановки уже лежит (${paths.stopRequest}) — петля встанет на границе итерации.`,
        );
    if (deps.exists(paths.stopRequest)) {
        already();
        return 0;
    }
    try {
        deps.writeStopFn(paths.stopRequest);
    } catch (e) {
        // Между проверкой и записью файл мог положить второй `./ralph stop` или сама петля:
        // запись эксклюзивная (`wx`), и EEXIST — тот же исход «уже лежит», а не стек node.
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
            already();
            return 0;
        }
        deps.out(`⛔ stop: запрос ${paths.stopRequest} не положен — ${(e as Error).message}`);
        return 1;
    }
    deps.out(
        `⏸ Запрос остановки положен (${paths.stopRequest}): начатая сессия доводится, ` +
            'петля встанет на границе итерации и сохранит state.',
    );
    return 0;
}

/** `<каталог установок>/<sha из lock>/ralph.js` — entry раннера, который держит лок. */
function lockedEntry(
    consumerRoot: string,
    deps: TLauncherDeps,
): { ok: true; path: string } | { ok: false; reason: string } {
    const r = readCoreLock(consumerRoot, deps.readFn);
    if (!r.ok) return { ok: false, reason: r.reason };
    try {
        return { ok: true, path: join(resolveDataDir(deps.env), r.lock.sha, 'ralph.js') };
    } catch (e) {
        return { ok: false, reason: (e as Error).message };
    }
}

/** Версия продукта человеку: ревизия из lock и версии слоёв — без чтения git. */
export function runVersionCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const launcher = observeLauncher(deps.env);
    deps.out(
        `launcher (./ralph): ${launcher.kind === 'version' ? `v${String(launcher.version)}` : 'версия не задана'}`,
    );
    const r = readCoreLock(args.consumerRoot, deps.readFn);
    if (!r.ok) {
        deps.out(`ядро: ${r.reason}`);
        return 1;
    }
    deps.out(`Ralph ${r.lock.sha.slice(0, 12)} (ревизия ${r.lock.sha})`);
    deps.out(`версии: ${describeVersions(r.lock.versions)}`);
    return 0;
}

export function runLauncher(argv: readonly string[], deps: TLauncherDeps): number {
    const parsed = parseLauncherArgv(argv);
    if (!parsed.ok) {
        deps.out(`⛔ ${parsed.reason}`);
        return 2;
    }
    const a = parsed.args;
    switch (a.command) {
        case 'install':
            return runInstallCommand(a, deps);
        case 'doctor':
            return runDoctorCommand(a, deps);
        case 'start':
            return runStartCommand(a, deps);
        case 'stop':
            return runStopCommand(a, deps);
        case 'version':
            return runVersionCommand(a, deps);
    }
}

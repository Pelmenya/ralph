/**
 * Живая проба стенда силами раннера, вне сессии (#219).
 *
 * У карточек фаз 16c–16e есть критерий «живая проба настоящим CLI на изолированном стенде», а
 * сессия петли выполнить её не может: ключа CLI у неё нет, и guard правильно не даёт читать
 * env-файл. Ночью 27→28.10 из-за этого встали две карточки — сделано всё, кроме живого
 * прогона, метка `blocked`, — и петля простояла до утра, пока вахта не прогнала пробы руками.
 * Теперь сессия просит пробу намерением `live-probe`, а раннер исполняет её после сессии и до
 * закрытия карточки, по тому же принципу, что коллектор доказательства скилла
 * (`docs/harness-contract.md`): ключ в сессию не попадает.
 *
 * Граница доверия ключа. В стенде исполняется код ветки (хуки, описания пакетов), и он может
 * увидеть окружение CLI. Поэтому:
 *   - ключ пробы ОТДЕЛЬНЫЙ: переменную называет конфиг потребителя (`liveProbe.keyEnv`), её
 *     значение не вправе совпасть ни с одним ключом петли, а процесс стенда собирается с
 *     чистого окружения — ключи петли туда не едут вовсе;
 *   - стенд и его исполнитель берутся из УСТАНОВКИ ядра (`productRoot`), а не из ветки:
 *     правленый в ветке `provision/stand/stand.mts` снял бы изоляцию той самой пробой, которая
 *     её проверяет. Установки нет или она внутри дерева работы — отказ, а не дерево ветки.
 *     Из ветки берётся только ПРОВЕРЯЕМОЕ — хуки и пакеты харнессов (`STAND_SUBJECT_ROOT`);
 *   - выход — только к провайдеру модели: белый список держит прокси стенда
 *     (`provision/stand/egress.mts`), раннер лишних адресов (`--allow`) не добавляет;
 *   - значение ключа вычищается из всего, что уходит в карточку и лог, а его след в выводе
 *     означает FAIL пробы: ключ, напечатанный изнутри, уже вне стенда.
 *
 * Отказ (нет секции, нет ключа, нет установки) — отдельный исход `REFUSED` с названной
 * причиной: проба не пропускается молча и карточку не закрывает. Петля из-за пробы не встаёт —
 * это решение по карточке, а не по петле.
 *
 * Находки стенда, ставшие частью исполнителя: CLI под root отказывает `bypassPermissions` без
 * признака `IS_SANDBOX=1` (#186), выход к провайдеру с хоста за прокси идёт цепочкой через
 * прокси хоста (#214), а каталог стенда держится коротким — путь unix-сокета прокси выхода
 * упирается в предел `sun_path` в 108 байт (#214).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

import { LIVE_PROBE_CLI_KEY_ENV, LOOP_KEY_ENVS } from '../adapters/live-probe-cases.ts';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

export type TLiveProbeVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'REFUSED';
/**
 * `tail` уходит в публичный комментарий карточки и несёт только строки самого исполнителя
 * стенда (`say`/`result` в `install-stand.sh`); `log` — весь хвост, с выводом сессии CLI, —
 * только в лог раннера. Оба без значения ключа.
 */
export type TLiveProbeResult = {
    verdict: TLiveProbeVerdict;
    reason: string;
    tail: string;
    log?: string;
};
export type TLiveProbeConfig = {
    /** Переменная окружения раннера с ключом пробы. */
    keyEnv: string;
    /** Переменная с адресом прокси хоста; нет — выход к провайдеру прямой. */
    upstreamProxyEnv?: string;
    /** Срок пробы целиком, мс. */
    timeoutMs?: number;
};

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const SECTION_KEYS = ['keyEnv', 'upstreamProxyEnv', 'timeoutMs'];
export const LIVE_PROBE_TIMEOUT_MS = 15 * 60_000;
/**
 * Потолок срока пробы из конфига. Раннер ждёт стенд синхронно, и строка старта пробы несёт
 * маркер кодер-шага (`🔄`), чей порог тишины у deadman — срок сессии CLI с запасом (2 ч 10 мин):
 * проба длиннее часа, да ещё две в одном батче, упёрлась бы в него ложным DEADMAN.
 */
export const LIVE_PROBE_MAX_TIMEOUT_MS = 60 * 60_000;
/** Запас после TERM группе стенда до KILL: `trap cleanup` скрипта успевает снять каталог. */
const KILL_AFTER_S = 30;
/** Короткий корень каталога стенда: путь сокета внутри обязан влезть в `sun_path`. */
export const STAND_TMP_PREFIX = '/tmp/rp-';
const TAIL_LINES = 30;
// Комментарий карточки ограничен парсером намерений (10 000 символов): хвост — с запасом.
const TAIL_CHARS = 6_000;
export const KEY_PLACEHOLDER = '[ключ пробы]';

/**
 * Секция `liveProbe` конфига. Нет секции — `null` (проба тогда — отказ с причиной); битая —
 * бросок: опечатка в имени переменной иначе превратилась бы в «ключа нет» с неверной
 * причиной, а не в отказ конфига.
 */
export function resolveLiveProbeConfig(raw: unknown): TLiveProbeConfig | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('liveProbe: ожидался объект');
    const o = raw as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !SECTION_KEYS.includes(k));
    if (extra.length > 0) throw new Error(`liveProbe: незнакомые ключи ${extra.join(', ')}`);
    const name = (key: string, required: boolean): string | undefined => {
        const v = o[key];
        if (v === undefined && !required) return undefined;
        if (typeof v !== 'string' || !ENV_NAME_RE.test(v))
            throw new Error(`liveProbe.${key}: ожидалось имя переменной окружения`);
        return v;
    };
    const keyEnv = name('keyEnv', true) as string;
    if (LOOP_KEY_ENVS.includes(keyEnv))
        throw new Error(
            `liveProbe.keyEnv: ${keyEnv} — переменная ключа петли; ключ пробы — отдельный`,
        );
    const upstreamProxyEnv = name('upstreamProxyEnv', false);
    const t = o['timeoutMs'];
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t <= 0))
        throw new Error('liveProbe.timeoutMs: ожидалось целое положительное');
    if (typeof t === 'number' && t > LIVE_PROBE_MAX_TIMEOUT_MS)
        throw new Error(
            `liveProbe.timeoutMs: не больше ${String(LIVE_PROBE_MAX_TIMEOUT_MS)} — дольше раннер ` +
                'молчит в логе за порогом тишины deadman',
        );
    return {
        keyEnv,
        ...(upstreamProxyEnv ? { upstreamProxyEnv } : {}),
        ...(t !== undefined ? { timeoutMs: t as number } : {}),
    };
}

/**
 * Формы ключа, по которым его узнаёт вычистка: сам ключ и его обычные кодировки. Код ветки в
 * стенде, напечатавший ключ base64 или hex, вынес его наружу так же, как напечатавший дословно;
 * дословная сверка этого не видела, и FAIL по следу не срабатывал. Разбитый на части ключ так не
 * ловится — поэтому в публичный комментарий вывод сессии не идёт вовсе (`publicTail`).
 */
function keyForms(key: string): string[] {
    if (key === '') return [];
    const buf = Buffer.from(key, 'utf8');
    const forms = [
        key,
        encodeURIComponent(key),
        buf.toString('base64'),
        buf.toString('base64').replace(/=+$/, ''),
        buf.toString('base64url'),
        buf.toString('hex'),
        buf.toString('hex').toUpperCase(),
    ];
    return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/**
 * Убирает значение ключа и его кодировки из текста; `leaked` — было ли что убирать. Ключ
 * обрезается по краям здесь же: хвостовой пробел env-файла иначе разводил бы ключ, который
 * получил стенд, и ключ, который ищет вычистка.
 */
export function redactKey(text: string, rawKey: string): { text: string; leaked: boolean } {
    let out = text;
    let leaked = false;
    for (const form of keyForms(rawKey.trim())) {
        if (!out.includes(form)) continue;
        leaked = true;
        out = out.split(form).join(KEY_PLACEHOLDER);
    }
    return { text: out, leaked };
}

/**
 * Вердикт пробы по выводу стенда: строка `RESULT <cli> <case> <исход> — …` именно этой
 * пробы. FAIL и FAIL-OPEN — FAIL; PASS — PASS; прочее (INCONCLUSIVE, SKIP, строки нет) —
 * INCONCLUSIVE: отсутствие вердикта — не зелёный.
 *
 * Вердикт подделывается выводом проверяемого, если судья к нему снисходителен, поэтому:
 *   - строка берётся только с начала строки, без `trim`: хвост сессии CLI скрипт печатает с
 *     отступом, и после обрезки `    RESULT … PASS` из вывода модели или хука ветки
 *     становился годным;
 *   - PASS — только при коде 0 и ровно одной строке этой пробы: упавший под `set -e` после
 *     сессии скрипт своей строки не напечатал бы, и последней стала бы строка из хвоста;
 *     две строки — неизвестно, какая чья. FAIL засчитывается при любом коде: красное
 *     подделкой не становится опаснее.
 */
export function judgeStandOutput(
    output: string,
    cli: string,
    probeCase: string,
    status: number | null = 0,
): { verdict: TLiveProbeVerdict; reason: string } {
    const prefix = `RESULT ${cli} ${probeCase} `;
    const lines = output
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.startsWith(prefix));
    const line = lines.at(-1);
    if (line === undefined)
        return { verdict: 'INCONCLUSIVE', reason: 'строки RESULT этой пробы в выводе стенда нет' };
    const outcomes = lines.map((l) => l.slice(prefix.length).split(/\s/)[0]);
    if (outcomes.some((o) => o === 'FAIL' || o === 'FAIL-OPEN')) {
        return { verdict: 'FAIL', reason: lines.find((l, i) => outcomes[i]!.startsWith('FAIL'))! };
    }
    if (lines.length > 1)
        return {
            verdict: 'INCONCLUSIVE',
            reason: `строк RESULT этой пробы ${String(lines.length)} — вердикт неоднозначен`,
        };
    if (outcomes[0] !== 'PASS') return { verdict: 'INCONCLUSIVE', reason: line };
    if (status !== 0)
        return {
            verdict: 'INCONCLUSIVE',
            reason: `стенд вышел кодом ${String(status)} — PASS без нулевого кода не засчитан: ${line}`,
        };
    return { verdict: 'PASS', reason: line };
}

/**
 * Хвост для публичного комментария: только строки исполнителя стенда. Вывод сессии CLI
 * (`--- хвост сессии` и строки с отступом под ним) несёт то, что напечатал код ветки, и в
 * трекер не идёт: прочитать его следующая сессия могла бы через MCP.
 */
export function publicTail(text: string): string {
    return text
        .split('\n')
        .filter((l) => !/^\s/.test(l) && !l.startsWith('--- хвост сессии'))
        .join('\n');
}

/** Каталог установки — не внутри дерева работы и не оно само. */
function insideOrSame(child: string, parent: string): boolean {
    const r = relative(parent, child);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

export type TStandSpawn = (
    argv: readonly string[],
    opts: { env: Record<string, string>; cwd: string; timeoutMs: number },
) => { status: number | null; output: string; error?: string };

// Срок держит `timeout` снаружи, а не `spawnSync`: тот убил бы по сроку один `bash`, а его
// дети (исполнитель стенда, прокси выхода) остались бы сиротами с ключом пробы в окружении,
// и `trap cleanup` скрипта после SIGKILL не сработал бы. `timeout` — лидер своей группы и шлёт
// TERM всей группе, через `KILL_AFTER_S` — KILL. Срок `spawnSync` — страховка поверх, если
// не ответил сам `timeout`.
const defaultSpawn: TStandSpawn = (argv, { env, cwd, timeoutMs }) => {
    guardSideEffect(`live-probe(${argv.join(' ')})`, 'Подмени spawnFn в тесте.');
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = spawnSync(
        'timeout',
        [`--kill-after=${String(KILL_AFTER_S)}s`, `${String(secs)}s`, ...argv],
        {
            env,
            cwd,
            timeout: timeoutMs + (KILL_AFTER_S + 30) * 1000,
            killSignal: 'SIGKILL',
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        },
    );
    return {
        status: r.status,
        output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
        ...(r.error ? { error: r.error.message } : {}),
    };
};

const defaultMkdtemp = (prefix: string): string => {
    guardSideEffect(`mkdtemp(${prefix})`, 'Подмени mkdtempFn в тесте.');
    return mkdtempSync(prefix);
};
const defaultRm = (dir: string): void => {
    guardSideEffect(`rm(${dir})`, 'Подмени rmFn в тесте.');
    rmSync(dir, { recursive: true, force: true });
};

/**
 * Исполняет одну пробу. Отказы — исходом `REFUSED`, а не броском: у вызывающего одна развилка
 * «PASS или нет», и причина ложится в карточку так же, как FAIL.
 */
export function runLiveProbe({
    cli,
    probeCase,
    config,
    productRoot,
    executionRoot,
    env = process.env,
    spawnFn = defaultSpawn,
    mkdtempFn = defaultMkdtemp,
    rmFn = defaultRm,
}: {
    cli: string;
    probeCase: string;
    config: TLiveProbeConfig | null;
    productRoot: string | null;
    executionRoot: string | null;
    env?: Record<string, string | undefined>;
    spawnFn?: TStandSpawn;
    mkdtempFn?: (prefix: string) => string;
    rmFn?: (dir: string) => void;
}): TLiveProbeResult {
    const refused = (reason: string): TLiveProbeResult => ({
        verdict: 'REFUSED',
        reason,
        tail: '',
    });
    if (config === null)
        return refused(
            'секция liveProbe в конфиге потребителя не задана — переменная ключа пробы не названа',
        );
    // Ключ нормализуется один раз: тем же значением его получает стенд, ищет вычистка и
    // сверяет совпадение с ключами петли.
    const key = (env[config.keyEnv] ?? '').trim();
    if (key === '')
        return refused(
            `ключ пробы не задан: переменная ${config.keyEnv} пуста в окружении раннера`,
        );
    const same = LOOP_KEY_ENVS.filter((n) =>
        (env[n] ?? '')
            .split(',')
            .map((v) => v.trim())
            .includes(key),
    );
    if (same.length > 0)
        return refused(
            `ключ пробы из ${config.keyEnv} совпадает с ключом петли (${same.join(', ')}) — ` +
                'нужен отдельный ключ с ограниченной квотой',
        );
    const cliKeyEnv = LIVE_PROBE_CLI_KEY_ENV[cli];
    if (cliKeyEnv === undefined) return refused(`маршрута ключа пробы для CLI ${cli} нет`);
    if (productRoot === null || executionRoot === null)
        return refused(
            'стенд берётся только из установки ядра, а раскладки корней (roots) нет — ' +
                'исполнитель из дерева ветки проверял бы сам себя',
        );
    if (insideOrSame(productRoot, executionRoot))
        return refused(
            `каталог ядра ${productRoot} внутри дерева работы ${executionRoot} — ` +
                'стенд из ветки проверял бы сам себя',
        );
    let proxy: string | undefined;
    if (config.upstreamProxyEnv !== undefined) {
        proxy = env[config.upstreamProxyEnv];
        if (proxy === undefined || proxy.trim() === '')
            return refused(
                `прокси хоста не задан: переменная ${config.upstreamProxyEnv} пуста в окружении раннера`,
            );
    }

    let dir: string;
    try {
        dir = mkdtempFn(STAND_TMP_PREFIX);
    } catch (e) {
        return refused(`каталог стенда не создан: ${(e as Error).message}`);
    }
    // Окружение стенда собирается с нуля: ключи петли, токен форжа и прочее окружение раннера
    // в процесс, исполняющий код ветки, не едут. Внутрь изоляции переменные проходят только
    // названными `--pass-env`.
    const isolateArgs = [
        '--pass-env',
        cliKeyEnv,
        '--pass-env',
        'IS_SANDBOX',
        ...(proxy !== undefined ? ['--upstream-proxy-env', 'RALPH_PROBE_UPSTREAM'] : []),
    ];
    const standEnv: Record<string, string> = {
        PATH: env.PATH ?? '/usr/bin:/bin',
        HOME: env.HOME ?? dir,
        LANG: 'C.UTF-8',
        TMPDIR: dir,
        STAND_ISOLATE: '1',
        // Проверяемое — хуки и пакеты харнессов — из дерева работы: проба судит правку ветки.
        STAND_SUBJECT_ROOT: executionRoot,
        STAND_ISOLATE_ARGS: isolateArgs.join(' '),
        IS_SANDBOX: '1',
        [cliKeyEnv]: key,
        ...(proxy !== undefined ? { RALPH_PROBE_UPSTREAM: proxy } : {}),
    };
    const script = join(productRoot, 'provision', 'install-stand.sh');
    let out: ReturnType<TStandSpawn>;
    try {
        out = spawnFn(['bash', script, cli, probeCase], {
            env: standEnv,
            cwd: dir,
            timeoutMs: config.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS,
        });
    } finally {
        try {
            rmFn(dir);
        } catch {
            // Каталог под /tmp; неснятый — мусор, а не утечка: ключ в нём не лежит.
        }
    }
    const red = redactKey(`${out.output}${out.error ? `\n${out.error}` : ''}`, key);
    const cut = (t: string) =>
        t.split('\n').slice(-TAIL_LINES).join('\n').trim().slice(-TAIL_CHARS);
    const tail = cut(publicTail(red.text));
    const log = cut(red.text);
    if (red.leaked)
        return {
            verdict: 'FAIL',
            reason: 'значение ключа пробы оказалось в выводе стенда — код внутри его увидел',
            tail,
            log,
        };
    if (out.error !== undefined && out.status === null)
        return {
            verdict: 'INCONCLUSIVE',
            reason: `стенд не доработал: ${redactKey(out.error, key).text}`,
            tail,
            log,
        };
    return { ...judgeStandOutput(red.text, cli, probeCase, out.status), tail, log };
}

/** Комментарий в карточку: исход, причина и хвост журнала — без значения ключа. */
export function formatLiveProbeComment(
    probe: { cli: string; case: string },
    result: TLiveProbeResult,
    key = '',
): string {
    const icon = result.verdict === 'PASS' ? '✅' : result.verdict === 'FAIL' ? '❌' : '⚠️';
    const head =
        `${icon} Живая проба \`${probe.cli} ${probe.case}\` (раннер, изолированный стенд): ` +
        `**${result.verdict}** — ${result.reason}`;
    const body = result.tail ? `${head}\n\n\`\`\`\n${result.tail}\n\`\`\`` : head;
    const verdictNote =
        result.verdict === 'PASS'
            ? ''
            : '\n\nКарточка не закрыта: критерий живой пробы не подтверждён.';
    return redactKey(`${body}${verdictNote}`, key).text;
}

/**
 * Проба по намерению сессии: конфиг, исполнение, комментарий. Битая секция `liveProbe` —
 * отказ пробы с причиной, а не бросок: решение по карточке («не закрыта, почему») то же, а
 * батч остальных намерений применяется.
 */
export function liveProbeForIntent(
    probe: { cli: string; case: string },
    {
        rawConfig,
        productRoot,
        executionRoot,
        env = process.env,
        runFn = runLiveProbe,
        logFn = () => {},
    }: {
        rawConfig: unknown;
        productRoot: string | null;
        executionRoot: string | null;
        env?: Record<string, string | undefined>;
        runFn?: typeof runLiveProbe;
        /** Лог раннера: строка старта (окно ожидания видно вахте) и полный хвост стенда. */
        logFn?: (line: string) => void;
    },
): { verdict: TLiveProbeVerdict; comment: string } {
    let config: TLiveProbeConfig | null;
    try {
        config = resolveLiveProbeConfig(rawConfig);
    } catch (e) {
        const result: TLiveProbeResult = {
            verdict: 'REFUSED',
            reason: `конфиг пробы отвергнут — ${(e as Error).message}`,
            tail: '',
        };
        return { verdict: result.verdict, comment: formatLiveProbeComment(probe, result) };
    }
    // Раннер ждёт стенд синхронно, до срока пробы без единой строки. Строка старта — с маркером
    // кодер-шага `🔄`: deadman читает его как долгий шаг, а не как тишину короткого.
    const minutes = Math.ceil((config?.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS) / 60_000);
    if (config !== null)
        logFn(
            `🔄 Живая проба ${probe.cli} ${probe.case} запущена — срок ${String(minutes)} мин, ` +
                'раннер ждёт стенд.',
        );
    const result = runFn({
        cli: probe.cli,
        probeCase: probe.case,
        config,
        productRoot,
        executionRoot,
        env,
    });
    const key = config ? (env[config.keyEnv] ?? '') : '';
    if (result.log) {
        logFn(`🧪 Хвост стенда пробы ${probe.cli} ${probe.case}:`);
        for (const l of redactKey(result.log, key).text.split('\n')) logFn(`   ${l}`);
    }
    return { verdict: result.verdict, comment: formatLiveProbeComment(probe, result, key) };
}

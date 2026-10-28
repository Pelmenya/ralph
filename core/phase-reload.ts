// #221: список фаз перечитывается на границе фаз, без рестарта процесса.
//
// Процесс раннера читал конфиг один раз при старте. Фаза, добавленная в конфиг посреди
// прогона, не была видна: после мерджа текущей петля уходила в следующую по СТАРОМУ списку.
// Чтобы новая фаза подхватилась, вахта перезапускала петлю в узком окне гейта мерджа («чек
// площадки ждёт») — 27.10 и 28.10, — а ошибка в этом окне уводила петлю не в ту фазу, и
// чинилось это только правкой state руками.
//
// Теперь после мерджа и до выбора следующей фазы оркестратор заново читает конфиг тем же
// резолвом, что на старте, и этот модуль решает, что из прочитанного применить:
//   - применяется ТОЛЬКО список фаз. Корни, профиль, рантайм и прочее раннер уже разложил
//     по процессу (лок, каталог состояния, settings сессий, монитор); подмена значения
//     посреди прогона дала бы процесс, половина которого живёт по старому конфигу, а
//     половина — по новому. Поэтому прочие изменения называются строкой `⚠` и ждут рестарта;
//   - отказ — стоп с причиной, а не откат к списку в памяти. Битый конфиг или текущая фаза,
//     исчезнувшая из списка, означают, что человек правит конфиг прямо сейчас или ошибся: и
//     в том и в другом случае следующая фаза по старому списку — догадка, а не его решение;
//   - фаза, вставленная ПЕРЕД текущей, — тоже отказ: она не смерджена, а старт с таким
//     списком отказал бы инвариантом зависимых фаз (C4). Граница фаз не строже старта, но
//     и не мягче;
//   - прежняя фаза (до текущей), переставленная ПОСЛЕ неё, — отказ по той же причине с
//     обратной стороны: она уже смерджена, и петля выбрала бы её следующей, пройдя веткой
//     «уже смерджена» с повторным закрытием вехи и строками о мердже.
//
// Модуль чистый: чтение файла и резолв профиля — у оркестратора (`reloadPhasesFromConfig`,
// обёртка цикла — `phasesAtBoundary`).

import { isPlainObject } from './config-profile.ts';

export type TReloadPhase = { milestone: string; branch: string };

export type TPhaseReload =
    | {
          kind: 'ok';
          phases: TReloadPhase[];
          // Индекс текущей (только что смердженной) фазы в СВЕЖЕМ списке.
          index: number;
          added: string[];
          removed: string[];
          // Ключи конфига, изменение которых требует рестарта процесса.
          restartKeys: string[];
      }
    | { kind: 'refused'; reason: string };

// Производные поля резолва называются ключом, из которого выведены: человек правил
// `roots`, а не `rootsResolved`, и строка `⚠` обязана назвать то, что он видит в файле.
const DERIVED_KEYS: Record<string, string> = {
    rootsResolved: 'roots',
    productRootFrom: 'roots',
    rootsDefaulted: 'roots',
    consumerScriptsResolved: 'consumerScripts',
};

// Сравнение по значению без учёта порядка ключей объекта: `{a, b}` и `{b, a}` — один конфиг.
function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (isPlainObject(v)) {
        return `{${Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(v) ?? 'undefined';
}

function phaseProblem(phases: unknown): string | null {
    if (!Array.isArray(phases) || phases.length === 0) return 'в конфиге нет phases';
    const seen = new Set<string>();
    for (const [i, p] of phases.entries()) {
        if (!isPlainObject(p)) return `phases[${i}] — не объект`;
        for (const key of ['milestone', 'branch']) {
            const v = p[key];
            if (typeof v !== 'string' || v.trim() === '') {
                return `phases[${i}].${key} = ${JSON.stringify(v)} — ожидалась непустая строка`;
            }
        }
        const m = p.milestone as string;
        if (seen.has(m)) return `веха "${m}" стоит в phases дважды`;
        seen.add(m);
    }
    return null;
}

function backlogNames(cfg: Record<string, unknown>): string[] {
    const review = cfg.review;
    if (!isPlainObject(review)) return [];
    const b = review.backlogMilestone;
    const list = Array.isArray(b) ? b : [b];
    return list.filter((m): m is string => typeof m === 'string');
}

/**
 * Сверяет свежий (уже резолвнутый) конфиг с исполняемым на границе фаз.
 * `currentMilestone` — фаза, которую петля только что сдала.
 */
export function reconcilePhases({
    running,
    fresh,
    currentMilestone,
    profileChanged = null,
}: {
    running: Record<string, unknown>;
    fresh: Record<string, unknown>;
    currentMilestone: string;
    // Профиль, который конфиг назвал бы сейчас, если он не совпал с исполняемым. Резолв идёт
    // по исполняемому профилю, поэтому сменённый `defaultProfile` иначе не был бы виден.
    profileChanged?: string | null;
}): TPhaseReload {
    // Те же отказы, что у preflight: петля, которую старт не пустил бы, не идёт и дальше.
    if (!fresh.active) {
        return { kind: 'refused', reason: 'active=false — петля выключена в конфиге' };
    }
    if (!Array.isArray(fresh.authorAllowlist) || fresh.authorAllowlist.length === 0) {
        return { kind: 'refused', reason: 'authorAllowlist пуст или отсутствует' };
    }
    const problem = phaseProblem(fresh.phases);
    if (problem !== null) return { kind: 'refused', reason: problem };
    const phases = (fresh.phases as Array<Record<string, unknown>>).map((p) => ({
        milestone: p.milestone as string,
        branch: p.branch as string,
    }));

    const index = phases.findIndex((p) => p.milestone === currentMilestone);
    if (index === -1) {
        return {
            kind: 'refused',
            reason: `текущей фазы "${currentMilestone}" нет в свежем списке phases — следующую выбрать не от чего`,
        };
    }

    const oldNames = (Array.isArray(running.phases) ? running.phases : [])
        .map((p) => (isPlainObject(p) ? p.milestone : null))
        .filter((m): m is string => typeof m === 'string');
    const oldIndex = oldNames.indexOf(currentMilestone);
    const oldBefore = new Set(oldIndex === -1 ? [] : oldNames.slice(0, oldIndex));
    const insertedBefore = phases
        .slice(0, index)
        .map((p) => p.milestone)
        .filter((m) => !oldBefore.has(m));
    if (insertedBefore.length > 0) {
        return {
            kind: 'refused',
            reason:
                `перед текущей фазой "${currentMilestone}" появились ${insertedBefore.map((m) => `"${m}"`).join(', ')} — ` +
                'они не смерджены, и старт с таким списком отказал бы инвариантом зависимых фаз',
        };
    }

    const movedAfter = phases
        .slice(index + 1)
        .map((p) => p.milestone)
        .filter((m) => oldBefore.has(m));
    if (movedAfter.length > 0) {
        return {
            kind: 'refused',
            reason:
                `после текущей фазы "${currentMilestone}" встали прежние ${movedAfter.map((m) => `"${m}"`).join(', ')} — ` +
                'они уже пройдены, и петля взяла бы их следующими как смердженные',
        };
    }

    // Накопитель исполняемого конфига: новый ключ ещё не применён, и фаза с именем прежнего
    // накопителя начала бы удлинять сама себя находками петли (#16).
    const runningBacklog = backlogNames(running);
    const clash = phases.map((p) => p.milestone).filter((m) => runningBacklog.includes(m));
    if (clash.length > 0) {
        return {
            kind: 'refused',
            reason: `веха ${clash.map((m) => `"${m}"`).join(', ')} — накопитель исполняемого конфига, а стоит в phases`,
        };
    }

    const names = new Set(phases.map((p) => p.milestone));
    const added = phases.map((p) => p.milestone).filter((m) => !oldNames.includes(m));
    const removed = oldNames.filter((m) => !names.has(m));

    const restart = new Set<string>();
    for (const key of new Set([...Object.keys(running), ...Object.keys(fresh)])) {
        if (key === 'phases') continue;
        if (canonical(running[key]) !== canonical(fresh[key])) {
            restart.add(DERIVED_KEYS[key] ?? key);
        }
    }
    if (profileChanged !== null) restart.add('defaultProfile');

    return { kind: 'ok', phases, index, added, removed, restartKeys: [...restart].sort() };
}

/** Строка `🗂` лога о перечитанном списке. */
export function formatPhaseReload(r: Extract<TPhaseReload, { kind: 'ok' }>): string {
    const next = r.phases[r.index + 1];
    const parts = [
        `добавлено ${r.added.length > 0 ? r.added.map((m) => `"${m}"`).join(', ') : 'ничего'}`,
    ];
    if (r.removed.length > 0) parts.push(`убрано ${r.removed.map((m) => `"${m}"`).join(', ')}`);
    parts.push(`следующая — ${next ? `"${next.milestone}"` : 'нет (фазы списка пройдены)'}`);
    return `🗂 Список фаз перечитан: ${parts.join(', ')}.`;
}

/** Строка `⚠` об изменениях, которые петля без рестарта не применяет. */
export function formatRestartKeys(keys: string[]): string | null {
    if (keys.length === 0) return null;
    return (
        `⚠ Конфиг: изменились ${keys.join(', ')} — без рестарта процесса это не применяется; ` +
        'петля продолжает на прежних значениях, новые вступят в силу после перезапуска.'
    );
}

/**
 * Виды проб барьера и их свидетельства (Фаза 16c, #183, `docs/harness-contract.md`,
 * принцип 8 и «Набор соответствия»).
 *
 * До карточки зелёной пробой был любой код 2 любого хука. У разных проб разные
 * свидетельства, и одно правило на всех доказывало не то: у отказа preflight и у
 * отключённого канала события у барьера нет вовсе, а «двойка без попытки вызова» значит
 * только то, что хук запустили руками. Поэтому у каждого вида — свой набор обязательных
 * свидетельств и свой допустимый исход, и судья знает три ответа:
 *   - `proven` — свидетельства полны и исход тот, что заявлен;
 *   - `failed` — свидетельства полны, а барьер не удержал: эффект запрещённого есть,
 *     событие у отключённого канала есть, CLI стартовал на запрещённой конфигурации;
 *   - `unproven` — свидетельства неполны или неоднозначны: нет попытки, незнакомый или
 *     чужой код причины, эффект не наблюдался. «Не доказано» — не «прошло»: проба,
 *     которой нечем доказать, зелёной не бывает.
 *
 * Эффект — того вида, какой у операции: у чтения это ВЫДАЧА содержимого, а не изменение
 * файла. Наблюдение «файл не изменился» о чтении ничего не говорит, и судья требует
 * наблюдение ровно того вида, что заявлен у пробы.
 *
 * Где какая проба идёт. Стартовая проба на дереве потребителя (`core/guard-probe.ts`)
 * исполняет только хуки на синтетическом входе — без CLI, без попытки, без эффекта, — и
 * этим судьёй доказанной не становится по построению: попытки нет. Все виды здесь — для
 * стенда (`provision/stand/`), где попытку делает настоящий CLI.
 *
 * TS-модуль без билд-шага (erasable-only), без побочек.
 */
import {
    BARRIER_REASON_CODES,
    isBarrierReasonCode,
    reasonCodeOf,
    type BarrierReasonCode,
} from './barrier-reason.ts';

/**
 * Пять видов из контракта:
 *   - `rule` — правило барьера на вызове инструмента;
 *   - `registration` — CLI принял регистрацию барьера (или отказ старта, если отбросил);
 *   - `disabled-channel` — канал исполнения доказанно выключен: перехватывать нечего;
 *   - `preflight` — запуск с запрещённой конфигурацией отвергнут до старта сессии;
 *   - `sandbox` — запись, которой хук не видит (путь собран скриптом), держит ОС.
 */
export const PROBE_KINDS = [
    'rule',
    'registration',
    'disabled-channel',
    'preflight',
    'sandbox',
] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

/** Отрицательная — запрещённое не случилось; разрешённая — эффект есть. */
export type ProbePolarity = 'negative' | 'positive';

/**
 * Вид наблюдаемого эффекта: `content` — выдача содержимого (чтение, поиск), `mutation` —
 * изменение файловой системы, `call` — исполненный вызов (команда, MCP, план), `start` —
 * CLI стартовал сессию.
 */
export const EFFECT_KINDS = ['content', 'mutation', 'call', 'start'] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/** Что проба заявляет: вид, полярность, ожидаемый эффект, код и пару. */
export type ProbeSpec = {
    id: string;
    kind: ProbeKind;
    polarity: ProbePolarity;
    what: string;
    effect: EffectKind;
    /** Код причины, которого ждёт отрицательная проба правила; у остальных — нет. */
    reasonCode?: BarrierReasonCode;
    /** Разрешённая проба в паре с отрицательной: без неё «блокирует» неотличимо от «блокирует всё». */
    pair?: string;
};

/**
 * Что наблюдал стенд. Поле, которого нет, — свидетельства нет; `false` — наблюдали, и не
 * было. Разница содержательна: «события у барьера не было» доказывает отключённый канал,
 * а «о событии ничего не знаем» не доказывает ничего.
 */
export type ProbeEvidence = {
    /** Попытка сделана настоящим CLI: инструментальный вызов либо запуск сессии. */
    attempted?: boolean;
    /** Событие этого вызова дошло до хука барьера. */
    barrierEvent?: boolean;
    /** Код выхода и stderr хука на этом событии. */
    hookExit?: number | null;
    hookStderr?: string;
    /** Наблюдения эффекта по виду: судья читает ровно вид пробы. */
    effects?: Partial<Record<EffectKind, boolean>>;
    /** CLI подтвердил регистрацию сам: без предупреждения об отброшенной секции. */
    registrationAccepted?: boolean;
    /** Названная причина отказа: раннера (preflight), CLI (канал), ОС (песочница). */
    refusal?: string;
};

export type ProbeVerdict =
    | { verdict: 'proven' }
    | { verdict: 'failed'; why: string }
    | { verdict: 'unproven'; why: string };

/** Какие полярности у вида бывают: у выключенного канала разрешённой пробы нет — нечего пропускать. */
const POLARITIES: Record<ProbeKind, readonly ProbePolarity[]> = {
    rule: ['negative', 'positive'],
    registration: ['negative', 'positive'],
    'disabled-channel': ['negative'],
    preflight: ['negative', 'positive'],
    sandbox: ['negative', 'positive'],
};

/** Проблемы заявления пробы; пустой список — заявление годно. */
export function probeSpecProblems(spec: ProbeSpec): string[] {
    const at = `проба ${spec.id}`;
    const problems: string[] = [];
    if (!(PROBE_KINDS as readonly string[]).includes(spec.kind)) {
        return [`${at}: незнакомый вид ${JSON.stringify(spec.kind)}`];
    }
    if (!POLARITIES[spec.kind].includes(spec.polarity)) {
        problems.push(`${at}: у вида ${spec.kind} не бывает полярности ${spec.polarity}`);
    }
    if (!(EFFECT_KINDS as readonly string[]).includes(spec.effect)) {
        problems.push(`${at}: незнакомый вид эффекта ${JSON.stringify(spec.effect)}`);
    }
    // Регистрацию и preflight судят по старту сессии; у вызова инструмента старт — не эффект.
    const startKind = spec.kind === 'registration' || spec.kind === 'preflight';
    if (startKind !== (spec.effect === 'start')) {
        problems.push(
            `${at}: эффект start — у регистрации и preflight, и только у них (заявлен ${spec.effect})`,
        );
    }
    const wantsCode = spec.kind === 'rule' && spec.polarity === 'negative';
    if (wantsCode && !isBarrierReasonCode(spec.reasonCode)) {
        problems.push(`${at}: отрицательной пробе правила нужен код причины из перечня`);
    } else if (wantsCode && BARRIER_REASON_CODES[spec.reasonCode!].class !== 'rule') {
        // Код неисправности пробой правила не ждут: зелёной стала бы проба сломанного барьера.
        problems.push(`${at}: код ${spec.reasonCode} — неисправность барьера, а не правило`);
    }
    if (!wantsCode && spec.reasonCode !== undefined) {
        problems.push(`${at}: код причины ждёт только отрицательная проба правила`);
    }
    if (spec.polarity === 'negative' && !spec.pair) {
        problems.push(`${at}: отрицательной пробе нужна парная разрешённая`);
    }
    if (spec.pair !== undefined && spec.pair === spec.id) {
        // Проба в паре сама с собой доказывала бы себя: «блокирует всё» снова проходило бы.
        problems.push(`${at}: пара — другая проба, а не она сама`);
    }
    if (spec.polarity === 'positive' && spec.pair !== undefined) {
        problems.push(`${at}: пару называет отрицательная проба, а не разрешённая`);
    }
    return problems;
}

const unproven = (why: string): ProbeVerdict => ({ verdict: 'unproven', why });
const failed = (why: string): ProbeVerdict => ({ verdict: 'failed', why });
const PROVEN: ProbeVerdict = { verdict: 'proven' };

/** Наблюдение эффекта ровно того вида, что заявлен; иного вида — не наблюдение. */
function effectOf(spec: ProbeSpec, ev: ProbeEvidence): boolean | undefined {
    return ev.effects?.[spec.effect];
}

const hasRefusal = (ev: ProbeEvidence) =>
    typeof ev.refusal === 'string' && ev.refusal.trim() !== '';

function judgeRule(spec: ProbeSpec, ev: ProbeEvidence): ProbeVerdict {
    if (ev.attempted !== true) {
        return unproven(
            'попытки инструментального вызова не было — хук, запущенный руками, правила не доказывает',
        );
    }
    if (ev.barrierEvent !== true) return unproven('события у барьера не наблюдали');
    const effect = effectOf(spec, ev);
    if (spec.polarity === 'negative') {
        // Эффект запрещённого — дыра, что бы ни ответил хук.
        if (effect === true) return failed(`эффект ${spec.effect} запрещённого вызова есть`);
        if (effect !== false) return unproven(`эффект ${spec.effect} не наблюдали`);
        // Не сняли код — нет свидетельства, а не «барьер не держит»: ложный `failed` увёл бы
        // разбор в дыру там, где стенд просто не дописал наблюдение.
        if (ev.hookExit === undefined) return unproven('код выхода хука не наблюдали');
        if (ev.hookExit !== 2) {
            return failed(`хук вышел кодом ${String(ev.hookExit)} — блокирует только 2`);
        }
        const read = reasonCodeOf(ev.hookStderr ?? '');
        if (read.code === null) return unproven(read.why);
        if (read.code !== spec.reasonCode) {
            return unproven(`код причины ${read.code}, проба ждёт ${spec.reasonCode}`);
        }
        return PROVEN;
    }
    if (ev.hookExit === undefined) return unproven('код выхода хука не наблюдали');
    if (ev.hookExit !== 0) {
        return failed(`хук не пропустил разрешённое (код ${String(ev.hookExit)})`);
    }
    if (effect === false) return failed(`эффекта ${spec.effect} у разрешённого вызова нет`);
    if (effect !== true) return unproven(`эффект ${spec.effect} не наблюдали`);
    return PROVEN;
}

function judgeRegistration(spec: ProbeSpec, ev: ProbeEvidence): ProbeVerdict {
    if (ev.attempted !== true) return unproven('запуска CLI не было');
    const started = effectOf(spec, ev);
    if (spec.polarity === 'negative') {
        // Регистрация отброшена: CLI обязан не стартовать, а отказ — быть названным.
        if (started === true) return failed('CLI стартовал с отброшенной регистрацией барьера');
        if (started !== false) return unproven('старт CLI не наблюдали');
        if (!hasRefusal(ev)) return unproven('отказ старта не назван');
        return PROVEN;
    }
    if (ev.registrationAccepted === false) return failed('CLI не подтвердил регистрацию');
    if (ev.registrationAccepted !== true) return unproven('подтверждения регистрации от CLI нет');
    if (started !== true) return unproven('старт CLI не наблюдали');
    if (ev.barrierEvent !== true) return unproven('событие пробного вызова до барьера не дошло');
    return PROVEN;
}

function judgeDisabledChannel(spec: ProbeSpec, ev: ProbeEvidence): ProbeVerdict {
    if (ev.attempted !== true) return unproven('попытки вызова по каналу не было');
    const effect = effectOf(spec, ev);
    if (effect === true) return failed(`эффект ${spec.effect} по выключенному каналу есть`);
    // Событие у барьера значит, что канал не выключен, а перехвачен: описание врёт.
    if (ev.barrierEvent === true) return failed('у выключенного канала есть событие барьера');
    if (ev.barrierEvent !== false) return unproven('отсутствие события у барьера не наблюдали');
    if (effect !== false) return unproven(`эффект ${spec.effect} не наблюдали`);
    if (!hasRefusal(ev)) return unproven('отказ CLI по каналу не назван');
    return PROVEN;
}

function judgePreflight(spec: ProbeSpec, ev: ProbeEvidence): ProbeVerdict {
    if (ev.attempted !== true) return unproven('попытки запуска не было');
    const started = effectOf(spec, ev);
    if (spec.polarity === 'negative') {
        if (started === true) return failed('сессия стартовала с запрещённой конфигурацией');
        // У отказа до старта события у барьера нет и быть не должно: было — значит, отказ
        // случился уже в сессии, а не до неё.
        if (ev.barrierEvent === true) return failed('у отказа preflight есть событие барьера');
        if (ev.barrierEvent !== false) return unproven('отсутствие события у барьера не наблюдали');
        if (started !== false) return unproven('старт сессии не наблюдали');
        if (!hasRefusal(ev)) return unproven('отказ до старта не назван');
        return PROVEN;
    }
    if (started === false)
        return failed(`чистая конфигурация не стартовала: ${ev.refusal ?? 'без причины'}`);
    if (started !== true) return unproven('старт сессии не наблюдали');
    return PROVEN;
}

function judgeSandbox(spec: ProbeSpec, ev: ProbeEvidence): ProbeVerdict {
    if (ev.attempted !== true) return unproven('попытки записи не было');
    const effect = effectOf(spec, ev);
    if (spec.polarity === 'negative') {
        if (effect === true) return failed('песочница пропустила запись защищённого пути');
        if (effect !== false) return unproven(`эффект ${spec.effect} не наблюдали`);
        if (!hasRefusal(ev)) return unproven('отказ ОС не назван');
        return PROVEN;
    }
    if (effect === false) return failed('песочница не пустила разрешённую запись');
    if (effect !== true) return unproven(`эффект ${spec.effect} не наблюдали`);
    return PROVEN;
}

const JUDGES: Record<ProbeKind, (spec: ProbeSpec, ev: ProbeEvidence) => ProbeVerdict> = {
    rule: judgeRule,
    registration: judgeRegistration,
    'disabled-channel': judgeDisabledChannel,
    preflight: judgePreflight,
    sandbox: judgeSandbox,
};

/** Вердикт пробы по её свидетельствам. Негодное заявление — «не доказано» с причинами. */
export function judgeProbe(spec: ProbeSpec, evidence: ProbeEvidence): ProbeVerdict {
    const problems = probeSpecProblems(spec);
    if (problems.length > 0) return unproven(problems.join('; '));
    return JUDGES[spec.kind](spec, evidence);
}

/**
 * Отрицательная проба засчитывается только вместе с парой: разрешённая обязана быть
 * доказана тем же прогоном. Иначе барьер, блокирующий всё, проходил бы все отрицательные.
 * Пара — ДРУГАЯ и РАЗРЕШЁННАЯ проба из состава (`specs`): пара самой себя или другой
 * отрицательной доказывала бы «блокирует» тем же «блокирует всё».
 */
export function judgeWithPair(
    spec: ProbeSpec,
    verdicts: ReadonlyMap<string, ProbeVerdict>,
    specs: ReadonlyMap<string, ProbeSpec>,
): ProbeVerdict {
    const own = verdicts.get(spec.id);
    if (!own) return unproven(`вердикта пробы ${spec.id} нет`);
    if (own.verdict !== 'proven' || spec.polarity === 'positive') return own;
    if (!spec.pair || spec.pair === spec.id) {
        return unproven(`пара пробы ${spec.id} — не другая проба`);
    }
    const pairSpec = specs.get(spec.pair);
    if (!pairSpec) return unproven(`парной пробы ${spec.pair} нет в составе`);
    if (pairSpec.polarity !== 'positive') {
        return unproven(`парная проба ${spec.pair} не разрешённая (${pairSpec.polarity})`);
    }
    const pair = verdicts.get(spec.pair);
    if (!pair) return unproven(`вердикта парной пробы ${String(spec.pair)} нет`);
    if (pair.verdict !== 'proven') {
        return unproven(`парная проба ${spec.pair} не доказана: ${pair.why}`);
    }
    return own;
}

/**
 * Код причины барьера — машинная строка stderr хука и закрытый перечень кодов (Фаза 16c,
 * #183, `docs/harness-contract.md`, «Коды причины»).
 *
 * До карточки проба засчитывала блок по любому коду выхода 2 любого хука. Но барьер
 * fail-closed: правила, не загрузившиеся по сбою, блокируют ВСЁ — и запрещённую пробу
 * тоже, двойкой. Такой барьер проходил отрицательную пробу ровно тем, что сломан. Код
 * причины отделяет «правило узнало вызов» от «барьер неисправен»: проба правила ждёт
 * свой код, а код неисправности (`rules-unloaded`, `rule-fault`) её не засчитывает.
 *
 * Перечень закрыт по той же причине, что версия протокола: незнакомый код значит не то,
 * что знает судья, и читается как «не доказано», а не как совпадение по похожему имени.
 * Строка ровно одна — две строки с разными кодами в одном stderr делают ответ неоднозначным.
 *
 * Хуки — CommonJS без зависимостей и этот модуль не импортируют: формат строки и коды
 * объявлены у них литералами, равенство держит `barrier-reason.test.ts` (как версию
 * протокола у `adapter-event.cjs`).
 *
 * TS-модуль без билд-шага (erasable-only), без побочек.
 */

/** Префикс машинной строки; после него — код, строка целиком. */
export const REASON_LINE_PREFIX = 'ralph-reason-code: ';

/**
 * Кто код выпускает. `reserved` — код контракта, который судья матрицы уже ждёт, а хук
 * начнёт выпускать в карточке, названной в `meaning` (барьер на нормализованном событии).
 */
export type ReasonEmitter = 'guard' | 'skill-barrier' | 'reserved';

/** Отказ по существу правила или неисправность самого барьера. */
export type ReasonClass = 'rule' | 'fault';

export const BARRIER_REASON_CODES = {
    'secret-env': { class: 'rule', emitter: 'guard', meaning: 'чтение или правка env-файла' },
    destructive: {
        class: 'rule',
        emitter: 'guard',
        meaning: 'деструктивная команда: рекурсивное удаление, сброс дерева, force-push',
    },
    'mcp-not-allowed': {
        class: 'rule',
        emitter: 'guard',
        meaning: 'MCP-инструмент вне контура проекта',
    },
    'contour-data': {
        class: 'rule',
        emitter: 'guard',
        meaning: 'правка данных контура хуков из сессии петли',
    },
    'git-exec-input': {
        class: 'rule',
        emitter: 'guard',
        meaning: 'git с исполняющим входом из сессии петли',
    },
    'no-verify': { class: 'rule', emitter: 'guard', meaning: 'git commit --no-verify' },
    'manifest-shell': {
        class: 'rule',
        emitter: 'guard',
        meaning: 'правка package.json из оболочки',
    },
    'raw-address': { class: 'rule', emitter: 'guard', meaning: 'сетевой вызов на голый адрес' },
    'host-service': { class: 'rule', emitter: 'guard', meaning: 'изменение службы хоста' },
    'foreign-kill': { class: 'rule', emitter: 'guard', meaning: 'kill чужого процесса' },
    'skill-required': {
        class: 'rule',
        emitter: 'skill-barrier',
        meaning: 'правка без вызова обязательного скилла',
    },
    'unknown-tool': {
        class: 'rule',
        emitter: 'guard',
        meaning: 'инструмент вне toolMap описания (guard на событии, #186)',
    },
    'unknown-field': {
        class: 'rule',
        emitter: 'guard',
        meaning: 'поле входа или конверта вне allowedFields (guard на событии, #186)',
    },
    'config-surface': {
        class: 'rule',
        emitter: 'reserved',
        meaning:
            'запись поверхности конфига харнесса: перечень у пакета, политика в контексте ' +
            'сессии — после #186',
    },
    'capability-unjudged': {
        class: 'rule',
        emitter: 'guard',
        meaning: 'возможность, которую барьер ещё не судит: fetch, agent (#186)',
    },
    'input-invalid': {
        class: 'fault',
        emitter: 'guard',
        meaning: 'вход хука пуст, не JSON или не объект',
    },
    'rules-unloaded': {
        class: 'fault',
        emitter: 'guard',
        meaning: 'правила или данные контура не загрузились',
    },
    'core-revision': {
        class: 'fault',
        emitter: 'guard',
        meaning: 'хук не сверился с ревизией ядра',
    },
    'rule-fault': {
        class: 'fault',
        emitter: 'guard',
        meaning: 'правило бросило или вернуло вердикт не того вида',
    },
    'session-context': {
        class: 'fault',
        emitter: 'guard',
        meaning: 'контекст сессии от раннера заявлен, но не разобрался или без обоих корней',
    },
    'skill-barrier-fault': {
        class: 'fault',
        emitter: 'skill-barrier',
        meaning: 'барьер скиллов не смог судить: вход, ревизия, таблица, транскрипт',
    },
    'adapter-failed': {
        class: 'fault',
        emitter: 'guard',
        meaning: 'нормализатор пакета не дал событие по протоколу (#186)',
    },
} as const satisfies Record<
    string,
    { class: ReasonClass; emitter: ReasonEmitter; meaning: string }
>;

export type BarrierReasonCode = keyof typeof BARRIER_REASON_CODES;

export const isBarrierReasonCode = (v: unknown): v is BarrierReasonCode =>
    typeof v === 'string' && Object.hasOwn(BARRIER_REASON_CODES, v);

/** Машинная строка кода — та, что хук дописывает в stderr после текста для агента. */
export const reasonLine = (code: BarrierReasonCode): string => `${REASON_LINE_PREFIX}${code}`;

/** Код из stderr хука либо причина, по которой его нет; иного исхода нет. */
export type ReasonRead = { code: BarrierReasonCode } | { code: null; why: string };

/**
 * Код причины из stderr — как говорит контракт, ПОСЛЕДНЕЙ непустой строкой и дословно. Нет
 * строки, больше одной строки, строка не последней, незнакомый код или код с пробелами — `null`
 * с причиной: судья читает это «не доказано», а не «совпало».
 */
export function reasonCodeOf(stderr: string): ReasonRead {
    const all = stderr.split(/\r?\n/);
    const lines = all
        .filter((line) => line.startsWith(REASON_LINE_PREFIX))
        .map((line) => line.slice(REASON_LINE_PREFIX.length));
    if (lines.length === 0) return { code: null, why: 'в stderr нет строки кода причины' };
    if (lines.length > 1) {
        return { code: null, why: `в stderr несколько строк кода причины: ${lines.join(', ')}` };
    }
    const last = all.filter((line) => line.trim() !== '').at(-1) ?? '';
    if (!last.startsWith(REASON_LINE_PREFIX)) {
        return { code: null, why: 'строка кода причины в stderr не последняя' };
    }
    const [code] = lines;
    if (!isBarrierReasonCode(code)) {
        return { code: null, why: `незнакомый код причины ${JSON.stringify(code)}` };
    }
    return { code };
}

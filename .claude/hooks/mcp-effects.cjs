/**
 * Мигратор данных контура: явные эффекты MCP (`mcp.tools`) из прежних `writeAllowed` и
 * префиксов `List`/`Get` (#185, Фаза 16c).
 *
 * Контракт харнесса судит MCP по эффекту из политики, а не по имени. Переключи guard раньше
 * данных — и петля потеряла бы все чтения, которые ей сегодня даёт префикс: в данных их нет,
 * а инструмент без записи — `unknown`, то есть блок. Поэтому сначала схема и мигратор, потом
 * переключение (#186).
 *
 * **Мигрирует не сессия.** Действующий `hooks.json` сторожит guard: правка контура из дерева,
 * которое правит PR, действовала бы раньше ship человека. Мигратор — чистая функция над
 * текстом; применяет её доверенный launcher при обновлении, сессия пишет только код и тесты.
 *
 * **Чтения перечисляются, а не выводятся.** Префикс разрешал чтение у ЛЮБОГО имени, политика
 * эффектов — только у названного. Какие имена существуют, знает инвентарь инструментов
 * (`inventory`, полные имена `mcp__<сервер>__<метод>`), а не данные: из него берутся имена, которые
 * прежнее правило пропускало как чтение. Источник инвентаря — снимок живого `tools/list` серверов
 * потребителя (`core/mcp-inventory.ts`, #215): его полноту, дубли и перевод имён харнессов
 * проверяет он, здесь — только форма списка. Инструмент вне инвентаря после переключения
 * блокируется — это намеренное ужесточение контракта, а не потеря миграции. Пустой инвентарь —
 * отказ: он молча снял бы все чтения («пустой результат — красный»).
 *
 * **Мигратор сверяет себя.** Результат разбирается тем же `parseConsumerData`, и на каждом имени
 * инвентаря и `writeAllowed` решение НАСТОЯЩЕГО `decideEvent` на операции `mcp` до и после
 * миграции обязано совпасть, а `writeAllowed` и `neverExceptions` — остаться прежними
 * (`equivalenceProblems`). Сравнение множеств эффектов доказало бы только, что мигратор
 * согласен сам с собой, а не что guard решит так же. Расхождение — исключение, а не записанный
 * файл: миграция, меняющая решения, — правка барьера, а не перенос данных. Ту же сверку
 * повторяют launcher до публикации PR обновления и гейт PR потребителя (`core/update-bundle.ts`,
 * #218) — по сохранённому снимку и базовому коммиту, без сети.
 *
 * **Свежесть — отдельно от разовой миграции** (#218). Данные, уже заявившие эффекты, мигратор
 * не переписывает, но инвентарь сверяет всё равно (`toolsFreshness`): чтение, которого в
 * инвентаре больше нет, — `stale` (политика держит имя, которого у сервера нет, и обновление
 * встаёт), чтение, которое прежнее правило дало бы новому инструменту, — `unlisted` (диагноз:
 * в политику его пишет только ревью). Раньше мигратор выходил на заявленных `tools` до проверки
 * инвентаря, и устаревшая политика проезжала обновление молча.
 */
const { DATA_PATH, parseConsumerData } = require('./consumer-data.cjs');
const { decideEvent, mcpAllowed } = require('./guard-rules.cjs');

function fail(file, what) {
    throw new Error(`миграция эффектов MCP ${file}: ${what}`);
}

function checkInventory(file, inventory) {
    if (!Array.isArray(inventory) || inventory.length === 0) {
        fail(file, 'инвентарь инструментов пуст — чтения сняло бы все');
    }
    const bad = inventory.filter((n) => typeof n !== 'string' || !/^mcp__./i.test(n));
    if (bad.length > 0) fail(file, `в инвентаре не MCP-имена: ${bad.map(String).join(', ')}`);
}

/**
 * Явные эффекты по прежнему правилу: мутации `writeAllowed` — `write`, имена инвентаря, которые
 * прежнее правило пропускало вне `writeAllowed`, — `read`. Запрещённым записи не достаётся:
 * у них и после переключения эффект `unknown`.
 */
function deriveEffects(mcp, inventory) {
    const tools = new Map([...mcp.writeAllowed].map((name) => [name, 'write']));
    for (const name of inventory) {
        if (!tools.has(name) && mcpAllowed(name, mcp)) tools.set(name, 'read');
    }
    return Object.fromEntries(
        [...tools].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, e]) => [n, { effect: e }]),
    );
}

/**
 * Сервер и метод полного имени для операции события. Граница — ПОСЛЕДНЕЕ `__`: так событие
 * собирает имя обратно ровно в исходное (`mcp__${server}__${tool}`), и неоднозначное имя судится
 * тем же, что видит guard. Имя без обеих частей событием не выражается — для сверки это блок.
 */
function eventOperation(name) {
    const body = name.replace(/^mcp__/i, '');
    const cut = body.lastIndexOf('__');
    if (cut <= 0 || cut + 2 >= body.length) return null;
    return {
        op: 'mcp',
        server: body.slice(0, cut),
        tool: body.slice(cut + 2),
        effect: 'unknown',
        derived: [],
    };
}

/** Блокирует ли guard на событии вызов `name` при этих данных MCP. */
function blockedByGuard(name, mcp) {
    const op = eventOperation(name);
    if (op === null) return true;
    return decideEvent({ operations: [op] }, { contour: { mcp }, loop: true }).blocked;
}

/** Имена, на которых решение guard на событии разошлось между данными `before` и `after`. */
function decisionDrift(before, after, names) {
    return names.filter((n) => blockedByGuard(n, before) !== blockedByGuard(n, after));
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Эквивалентность миграции: `writeAllowed` и `neverExceptions` те же, решение guard на каждом
 * имени `names` то же. Пусто — эквивалентна; иначе по строке на расхождение, с именем инструмента.
 */
function equivalenceProblems(before, after, names) {
    const problems = [];
    for (const key of ['writeAllowed', 'neverExceptions']) {
        if (!sameSet(before[key], after[key])) problems.push(`mcp.${key} изменился при миграции`);
    }
    for (const n of decisionDrift(before, after, names)) {
        const was = blockedByGuard(n, before) ? 'запрещён' : 'разрешён';
        const now = blockedByGuard(n, after) ? 'запрещён' : 'разрешён';
        problems.push(`решение по ${n} разошлось с прежним: был ${was}, стал ${now}`);
    }
    return problems;
}

/**
 * Свежесть заявленных эффектов против инвентаря: `stale` — чтения, которых в инвентаре нет;
 * `unlisted` — имена инвентаря без эффекта, которые прежнее правило пропускало как чтение.
 * Записи не сверяются: их держит `writeAllowed`, и мигратор пишет их независимо от инвентаря.
 */
function toolsFreshness(mcp, inventory) {
    const known = new Set(inventory);
    const stale = [...mcp.tools]
        .filter(([n, e]) => e === 'read' && !known.has(n))
        .map(([n]) => n)
        .sort();
    const unlisted = inventory.filter((n) => !mcp.tools.has(n) && mcpAllowed(n, mcp)).sort();
    return { stale, unlisted };
}

/**
 * Миграция текста данных. Инвентарь проверяется ВСЕГДА, до формы данных. Эффекты уже заявлены —
 * текст без изменений (повтор обновления идемпотентен) и свежесть против инвентаря; битые
 * данные — исключение разбора.
 */
function migrateMcpEffects(text, inventory, file = DATA_PATH) {
    const before = parseConsumerData(text, file).mcp;
    checkInventory(file, inventory);
    const raw = JSON.parse(text);
    if (raw.mcp !== undefined && raw.mcp.tools !== undefined) {
        return { text, changed: false, ...toolsFreshness(before, inventory) };
    }
    raw.mcp = { ...raw.mcp, tools: deriveEffects(before, inventory) };
    const migrated = `${JSON.stringify(raw, null, 4)}\n`;
    const after = parseConsumerData(migrated, file).mcp;
    const problems = equivalenceProblems(before, after, [
        ...new Set([...inventory, ...before.writeAllowed]),
    ]);
    if (problems.length > 0) fail(file, problems.join('; '));
    return { text: migrated, changed: true, stale: [], unlisted: [] };
}

module.exports = {
    migrateMcpEffects,
    decisionDrift,
    equivalenceProblems,
    toolsFreshness,
    checkInventory,
};

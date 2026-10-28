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
 * прежнее правило пропускало как чтение. Инструмент вне инвентаря после переключения
 * блокируется — это намеренное ужесточение контракта, а не потеря миграции. Пустой инвентарь —
 * отказ: он молча снял бы все чтения («пустой результат — красный»).
 *
 * **Мигратор сверяет себя.** Результат разбирается тем же `parseConsumerData`, и на каждом имени
 * инвентаря и `writeAllowed` решение по эффектам обязано совпасть с прежним `mcpAllowed`.
 * Расхождение — исключение, а не записанный файл: миграция, меняющая решения, — правка
 * барьера, а не перенос данных.
 */
const { DATA_PATH, parseConsumerData } = require('./consumer-data.cjs');
const { mcpAllowed, mcpAllowedByEffect } = require('./guard-rules.cjs');

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

/** Имена, на которых решение по эффектам разошлось с прежним. */
function decisionDrift(before, after, names) {
    return names.filter((n) => mcpAllowed(n, before) !== mcpAllowedByEffect(n, after));
}

/**
 * Миграция текста данных. Эффекты уже заявлены — текст без изменений (повтор обновления
 * идемпотентен); битые данные — исключение разбора.
 */
function migrateMcpEffects(text, inventory, file = DATA_PATH) {
    const before = parseConsumerData(text, file).mcp;
    const raw = JSON.parse(text);
    if (raw.mcp !== undefined && raw.mcp.tools !== undefined) return { text, changed: false };
    checkInventory(file, inventory);
    raw.mcp = { ...raw.mcp, tools: deriveEffects(before, inventory) };
    const migrated = `${JSON.stringify(raw, null, 4)}\n`;
    const after = parseConsumerData(migrated, file).mcp;
    const drift = decisionDrift(before, after, [
        ...new Set([...inventory, ...before.writeAllowed]),
    ]);
    if (drift.length > 0) fail(file, `решение разошлось с прежним на ${drift.join(', ')}`);
    return { text: migrated, changed: true };
}

module.exports = { migrateMcpEffects, decisionDrift };

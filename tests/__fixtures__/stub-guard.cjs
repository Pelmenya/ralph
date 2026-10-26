// Синтетический исправный барьер для живого цикла в копии ядра у потребителя. Guard продукта
// живёт в `.claude/hooks/` репозитория канона и в копию не едет (`tests/core-repo.ts`), а
// живые сценарии проверяют код ядра, не guard, — поэтому у потребителя они идут под этой
// заглушкой, а не пропускаются. Держит ровно пробу `core/guard-probe.ts`: рекурсивное
// удаление и любое упоминание env-файла — отказ кодом 2, остальное — пропуск. Боевым
// барьером не является и в настройки сессий не подключается.
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf-8'));
const text = JSON.stringify(input.tool_input ?? {});
if (/rm\s+-\w*r/.test(text) || /\.env\b/.test(text)) {
    process.stderr.write('stub-guard: запрещено пробой барьера\n');
    process.exit(2);
}

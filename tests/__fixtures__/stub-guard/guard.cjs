// Синтетический исправный барьер для живого цикла в копии ядра у потребителя. Guard продукта
// живёт в `.claude/hooks/` репозитория канона и в копию не едет (`tests/core-repo.ts`), а
// живые сценарии проверяют код ядра, не guard, — поэтому у потребителя они идут под этой
// заглушкой, а не пропускаются. Держит ровно пробу `core/guard-probe.ts`: рекурсивное
// удаление, любое упоминание env-файла и правка данных контура в сессии петли — отказ кодом 2
// с кодом причины, остальное — пропуск. Боевым
// барьером не является и в настройки сессий не подключается.
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf-8'));
const text = JSON.stringify(input.tool_input ?? {});
// Отказ называет код причины (#183): проба засчитывает двойку только со своим кодом.
// Сессия петли — по контексту раннера в окружении (#184): тогда правка данных контура — отказ.
const loop = (process.env.RALPH_SESSION_CONTEXT ?? '') !== '';
const code = /rm\s+-\w*r/.test(text)
    ? 'destructive'
    : /\.env\b/.test(text)
      ? 'secret-env'
      : loop && /\.claude\/ralph\/hooks\.json/.test(text)
        ? 'contour-data'
        : null;
if (code) {
    process.stderr.write(
        `stub-guard/guard.cjs: запрещено пробой барьера\nralph-reason-code: ${code}\n`,
    );
    process.exit(2);
}

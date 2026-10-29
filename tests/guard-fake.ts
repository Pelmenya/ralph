// Фейковый исправный барьер для тестов пробы (#183): 0 на безобидном, 2 со СВОИМ кодом
// причины на запрещённом. Проба засчитывает двойку только с кодом правила, и фейк «2 без
// кода», которым тесты раньше изображали исправный барьер, теперь изображает сломанный.
//
// Код выбирается по тексту входа — так же грубо, как фейки решали «безобидное или нет»:
// составы проб харнессов (`HARNESS_PROBES`) различимы по этим признакам, а лишнего знания
// о форме входа каждого CLI фейку не нужно.
import { reasonLine, type BarrierReasonCode } from '../adapters/barrier-reason.ts';

/** Код причины, которым исправный барьер назвал бы запрещённую пробу из этого текста. */
export function probeReasonCode(text: string): BarrierReasonCode {
    // OpenCode на событии нормализатора (#192): инструмент вне описания пакета — `multiedit`,
    // `batch` (несёт `rm -rf` внутри) и MCP-имя без перевода — незнакомый, а патч с путём,
    // который CLI читают по-разному, — неразобранное поле.
    if (/"tool":"(?:multiedit|batch|ralph-guard-probe_ListIssues)"/.test(text)) {
        return 'unknown-tool';
    }
    if (/File:\\[tr]/.test(text)) return 'unknown-field';
    if (/mcp__/.test(text)) return 'mcp-not-allowed';
    // Правка данных контура (#184) — запрещена только в сессии петли; фейк изображает хук,
    // которому контекст сессии дошёл.
    // Перенос каталога данных из `cwd` оболочки Kimi Code (#191) и `workdir` OpenCode (#192) —
    // тот же забор.
    if (/\.claude\/ralph\/hooks\.json|"(?:cwd|workdir)":"\.claude"/.test(text)) {
        return 'contour-data';
    }
    // Поверхность конфига харнесса (#199) — тоже только в сессии петли, с перечнем в контексте.
    if (
        /\.claude\/settings\.local\.json|\.codex\/config\.toml|\.kimi-code\/|opencode\.json/.test(
            text,
        )
    ) {
        return 'config-surface';
    }
    // Субагент и отложенный ход (#225) — тоже только в сессии петли, как контур выше.
    if (/"tool_name":"(?:Agent|ScheduleWakeup)"|"tool":"task"/.test(text)) return 'loop-delegation';
    if (/rm -rf/.test(text)) return 'destructive';
    return 'secret-env';
}

/** Исход исправного барьера на входе: безобидное пропущено, запрещённое названо своим кодом. */
export function heldRun(text: string): { status: number; stderr: string } {
    // Безобидное — команда оболочки и патч Codex в разрешённый файл (#232).
    if (/git status|\.ralph-guard-probe\/allowed\.txt/.test(text)) return { status: 0, stderr: '' };
    return { status: 2, stderr: `заблокировано\n${reasonLine(probeReasonCode(text))}\n` };
}

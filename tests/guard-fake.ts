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
    // Пакетный вызов несёт `rm -rf` внутри — MCP-правило судит его раньше оболочки.
    if (/mcp__|_ListIssues|batch/.test(text)) return 'mcp-not-allowed';
    // Правка данных контура (#184) — запрещена только в сессии петли; фейк изображает хук,
    // которому контекст сессии дошёл.
    if (/\.claude\/ralph\/hooks\.json/.test(text)) return 'contour-data';
    // Субагент и отложенный ход (#225) — тоже только в сессии петли, как контур выше.
    if (/"tool_name":"(?:Agent|ScheduleWakeup)"/.test(text)) return 'loop-delegation';
    if (/rm -rf/.test(text)) return 'destructive';
    return 'secret-env';
}

/** Исход исправного барьера на входе: безобидное пропущено, запрещённое названо своим кодом. */
export function heldRun(text: string): { status: number; stderr: string } {
    if (text.includes('git status')) return { status: 0, stderr: '' };
    return { status: 2, stderr: `заблокировано\n${reasonLine(probeReasonCode(text))}\n` };
}

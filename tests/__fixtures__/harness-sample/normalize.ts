// Нормализатор пакета-образца: исполняемая команда на границе «хук → адаптер» (#179).
// Не пакет харнесса, а проба протокола: тест гоняет его процессом, как его позовёт хук.
import { runNormalizer, type ToolEvent } from '../../../adapters/harnesses/protocol.ts';

function normalize(raw: unknown): ToolEvent {
    const input = raw as {
        tool_name?: unknown;
        tool_input?: Record<string, unknown>;
        cwd?: unknown;
    };
    const baseDir = typeof input.cwd === 'string' ? input.cwd : '/';
    const args = input.tool_input ?? {};
    if (input.tool_name === 'Bash' && typeof args.command === 'string') {
        return { operations: [{ op: 'exec', command: args.command, baseDir }] };
    }
    if (input.tool_name === 'Read' && typeof args.file_path === 'string') {
        return { operations: [{ op: 'read', path: args.file_path, baseDir }] };
    }
    if (input.tool_name === 'Crash') throw new Error('образец упал по просьбе входа');
    return {
        operations: [{ op: 'unknown', why: `инструмент ${JSON.stringify(input.tool_name)}` }],
    };
}

await runNormalizer(normalize);

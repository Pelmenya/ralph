/**
 * Разбор MCP-имени `mcp__<сервер>__<инструмент>` (Фаза 16c, #186; общий с 16d, #189).
 *
 * Форму имени делят Claude Code, Codex 0.163.0 (стенд #188, `cm-mcp`) и Kimi Code. Эффект
 * вызова разбор не знает: его задаёт политика контура, судит guard. Граница сервера — по имени
 * сервера из конверта (`mcp_server` у Claude Code), а без него — по единственному разделителю
 * `__`: ленивое разбиение отдавало `mcp__sync__get__CreateReport` серверу `sync` с инструментом
 * `get__CreateReport`, а несколько возможных границ без имени сервера — отказ с причиной.
 */

import { isRecord } from './event-roles.ts';

export const MCP_PREFIX = 'mcp__';

/** Имя сервера из поля конверта `mcp_server`: строка или объект с `name`. */
function envelopeServer(v: unknown): string | null {
    if (typeof v === 'string' && v !== '') return v;
    if (isRecord(v) && typeof v.name === 'string' && v.name !== '') return v.name;
    return null;
}

/**
 * Сервер и инструмент MCP-имени или причина, почему граница не определена. Кандидаты —
 * каждое `__` с непустыми частями по обе стороны; сервер из конверта выбирает свой, иначе
 * кандидат обязан быть единственным.
 */
export function mcpParts(
    name: string,
    serverField: unknown,
): { server: string; tool: string } | { why: string } {
    const rest = name.slice(MCP_PREFIX.length);
    const candidates: { server: string; tool: string }[] = [];
    for (let at = rest.indexOf('__'); at !== -1; at = rest.indexOf('__', at + 1)) {
        const server = rest.slice(0, at);
        const tool = rest.slice(at + 2);
        if (server !== '' && tool !== '' && !server.startsWith('_')) {
            candidates.push({ server, tool });
        }
    }
    const declared = envelopeServer(serverField);
    const own = declared === null ? undefined : candidates.find((c) => c.server === declared);
    if (own) return own;
    if (candidates.length === 1) return candidates[0];
    return {
        why:
            candidates.length === 0
                ? `MCP-имя ${name} без сервера и инструмента`
                : `MCP-имя ${name}: граница сервера неоднозначна`,
    };
}

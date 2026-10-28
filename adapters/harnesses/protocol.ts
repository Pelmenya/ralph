/**
 * Сторона адаптера на границе вызова «хук → нормализатор» (Фаза 16c, #179).
 *
 * Общий хук пакет не импортирует (почему — докблок `.claude/hooks/adapter-event.cjs`): он
 * запускает исполняемую команду пакета, отдаёт сырой вход хука на stdin и ждёт в stdout
 * `{"protocol": N, "event": ToolEvent}`. Здесь — то, из чего пакет собирает такую команду:
 * типы события по контракту (`docs/harness-contract.md`, «Пакет адаптера») и обвязка
 * `runNormalizer`, которая читает вход, зовёт нормализатор пакета и печатает ответ.
 *
 * Сбой нормализатора — ненулевой код и причина в stderr, а не «пустое событие»: хук
 * читает ненулевой код как блок с этой причиной, а пустое событие он отверг бы и так, но
 * уже без объяснения, что сломалось.
 *
 * Версия протокола объявлена здесь и в хуке порознь — импорт между сторонами и есть то,
 * чего граница не допускает. Равенство сверяет `protocol.test.ts`.
 */

export const ADAPTER_PROTOCOL_VERSION = 1;

/**
 * Что именно незнакомо в `unknown` (#186): инструмент вне `toolMap` — `tool`, поле входа или
 * конверта вне `allowedFields`, обязательное поле не той формы — `field`. По нему барьер
 * выбирает код причины (`unknown-tool` / `unknown-field`); без поля — `field`: «не разобралось»
 * ближе к правде, чем «инструмент не тот».
 */
export type UnknownKind = 'tool' | 'field';

export type ToolOperation =
    | { op: 'exec'; command: string; baseDir: string }
    | { op: 'read' | 'write' | 'delete'; path: string; baseDir: string }
    | { op: 'move'; path: string; destination: string; baseDir: string }
    | { op: 'search'; root: string; contentPattern?: string; pathGlob?: string; baseDir: string }
    | {
          op: 'mcp';
          server: string;
          tool: string;
          effect: 'read' | 'write' | 'unknown';
          derived: ToolOperation[];
      }
    | { op: 'fetch'; url: string }
    | { op: 'agent'; parentSession: string }
    | { op: 'inert'; what: string }
    | { op: 'unknown'; why: string; kind?: UnknownKind };

/** Пустой вызов невалиден: «нечего судить» барьер разрешением не считает. */
export type ToolEvent = { operations: [ToolOperation, ...ToolOperation[]] };

export type AdapterReply = { protocol: number; event: ToolEvent };

export type NormalizeFn = (raw: unknown) => ToolEvent;

/** Ответ команды для одного сырого входа: строка stdout либо причина отказа. */
export function normalizeReply(
    stdin: string,
    normalize: NormalizeFn,
): { stdout: string } | { error: string } {
    let raw: unknown;
    try {
        raw = JSON.parse(stdin);
    } catch {
        return { error: 'вход хука не JSON' };
    }
    try {
        const reply: AdapterReply = { protocol: ADAPTER_PROTOCOL_VERSION, event: normalize(raw) };
        return { stdout: JSON.stringify(reply) };
    } catch (error) {
        return {
            error: `нормализатор упал: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export type RunNormalizerDeps = {
    stdin?: AsyncIterable<Buffer | string>;
    writeFn?: (text: string) => void;
    errorFn?: (text: string) => void;
    exitFn?: (code: number) => void;
};

/** Весь поток целиком: сырой вход хука — один JSON, и читать его по кускам незачем. */
export async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
}

/** Точка входа исполняемой команды пакета: stdin → нормализатор → stdout, сбой — код 1. */
export async function runNormalizer(
    normalize: NormalizeFn,
    deps: RunNormalizerDeps = {},
): Promise<void> {
    const {
        stdin = process.stdin,
        writeFn = (text) => process.stdout.write(text),
        errorFn = (text) => process.stderr.write(text),
        exitFn = (code) => {
            process.exitCode = code;
        },
    } = deps;
    const reply = normalizeReply(await readAll(stdin), normalize);
    if ('error' in reply) {
        errorFn(`${reply.error}\n`);
        exitFn(1);
        return;
    }
    writeFn(`${reply.stdout}\n`);
    exitFn(0);
}

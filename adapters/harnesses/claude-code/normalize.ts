// Команда нормализатора пакета Claude Code: её зовёт общий хук процессом
// (`.claude/hooks/adapter-event.cjs`), отдаёт сырой вход на stdin и ждёт ответ протокола.
// Описание читается рядом с модулем и проверяется схемой: нормализатор по непроверенному
// описанию судил бы по таблицам, которых реестр не принял. Имя харнесса в описании сверяется
// здесь же, а не только реестром: guard зовёт команду по пути из своей регистрации, мимо
// реестра, и чужое описание рядом с модулем судило бы события Claude Code таблицами другого CLI.
import fs from 'node:fs';
import path from 'node:path';
import { parseHarnessDescriptor, type HarnessDescriptor } from '../descriptor.ts';
import { runNormalizer, type RunNormalizerDeps } from '../protocol.ts';
import { normalizeClaudeEvent } from './event.ts';

const HARNESS = 'claude-code';

/** Описание пакета, принятое схемой и названное харнессом этой команды; иначе — отказ. */
export function ownDescriptor(raw: unknown, source: string): HarnessDescriptor {
    const descriptor = parseHarnessDescriptor(raw, source);
    if (descriptor.harness !== HARNESS) {
        throw new Error(
            `${source}: описание харнесса «${descriptor.harness}», а команда — нормализатор ${HARNESS}`,
        );
    }
    return descriptor;
}

export async function main(deps: RunNormalizerDeps = {}): Promise<void> {
    const file = path.join(import.meta.dirname, 'descriptor.json');
    const descriptor = ownDescriptor(JSON.parse(fs.readFileSync(file, 'utf-8')), file);
    await runNormalizer((raw) => normalizeClaudeEvent(descriptor, raw), deps);
}

if (import.meta.main) await main();

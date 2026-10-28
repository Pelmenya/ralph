// Команда нормализатора пакета Codex (#189): её зовёт общий хук процессом
// (`.claude/hooks/adapter-event.cjs`), отдаёт сырой вход на stdin и ждёт ответ протокола.
// Описание читается рядом с модулем и проверяется схемой, имя харнесса в нём сверяется здесь же:
// guard зовёт команду по пути из своей регистрации, мимо реестра, и чужое описание рядом с
// модулем судило бы события Codex таблицами другого CLI. До #189 здесь стояла объявленная
// заглушка — отказ на любом событии.
import fs from 'node:fs';
import path from 'node:path';
import { parseHarnessDescriptor, type HarnessDescriptor } from '../descriptor.ts';
import { runNormalizer, type RunNormalizerDeps } from '../protocol.ts';
import { normalizeCodexEvent } from './event.ts';

const HARNESS = 'codex';

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
    await runNormalizer((raw) => normalizeCodexEvent(descriptor, raw), deps);
}

if (import.meta.main) await main();

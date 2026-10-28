// Команда нормализатора пакета Kimi Code (#191): её зовёт общий хук процессом
// (`.claude/hooks/adapter-event.cjs`), отдаёт сырой вход на stdin и ждёт ответ протокола.
// Описание читается рядом с модулем и проверяется схемой, имя харнесса в нём сверяется при
// старте общей сверкой (`ownDescriptor`): guard зовёт команду по пути из своей регистрации, мимо
// реестра, и чужое описание рядом с модулем судило бы события Kimi Code таблицами другого CLI.
// До #191 здесь стояла объявленная заглушка — отказ на любом событии.
import fs from 'node:fs';
import path from 'node:path';
import { ownDescriptor } from '../descriptor.ts';
import { runNormalizer, type RunNormalizerDeps } from '../protocol.ts';
import { normalizeKimiEvent } from './event.ts';

const HARNESS = 'kimi-code';

export async function main(deps: RunNormalizerDeps = {}): Promise<void> {
    const file = path.join(import.meta.dirname, 'descriptor.json');
    const descriptor = ownDescriptor(JSON.parse(fs.readFileSync(file, 'utf-8')), file, HARNESS);
    await runNormalizer((raw) => normalizeKimiEvent(descriptor, raw), deps);
}

if (import.meta.main) await main();

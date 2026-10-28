// Команда нормализатора пакета OpenCode (#192): её зовёт общий хук процессом
// (`.claude/hooks/adapter-event.cjs`), отдаёт вход, который положил плагин барьера, на stdin и ждёт
// ответ протокола. Описание читается рядом с модулем и проверяется схемой, имя харнесса в нём
// сверяется при старте общей сверкой (`ownDescriptor`): guard зовёт команду по пути из своей
// регистрации, мимо реестра, и чужое описание рядом с модулем судило бы события OpenCode
// таблицами другого CLI. До #192 здесь стояла объявленная заглушка — отказ на любом событии.
import fs from 'node:fs';
import path from 'node:path';
import { ownDescriptor } from '../descriptor.ts';
import { runNormalizer, type RunNormalizerDeps } from '../protocol.ts';
import { normalizeOpencodeEvent } from './event.ts';

const HARNESS = 'opencode';

export async function main(deps: RunNormalizerDeps = {}): Promise<void> {
    const file = path.join(import.meta.dirname, 'descriptor.json');
    const descriptor = ownDescriptor(JSON.parse(fs.readFileSync(file, 'utf-8')), file, HARNESS);
    await runNormalizer((raw) => normalizeOpencodeEvent(descriptor, raw), deps);
}

if (import.meta.main) await main();

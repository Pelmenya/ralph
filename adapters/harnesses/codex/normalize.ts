// Команда нормализатора пакета Codex — объявленная заглушка (#181). Нормализатор Codex и разбор
// патча — Фаза 16d; до неё любое событие — отказ команды с причиной (код 1), то есть блок у хука
// кодом неисправности `adapter-failed`: команда, которой нет, блокировала бы так же, но без
// объяснения, а «пропустить» здесь значило бы судить по таблицам, которых никто не сверял со
// стендом. Не `unknown`: его хук читает кодом ПРАВИЛА (`unknown-field`), и заглушка, подключённая
// без совместимого входа, засчиталась бы пробой как держащий барьер (ревью 16c).
import { runNormalizer, type RunNormalizerDeps } from '../protocol.ts';

export const STUB_REASON = 'нормализатор Codex — заглушка до Фазы 16d: событие не разобрано';

export async function main(deps: RunNormalizerDeps = {}): Promise<void> {
    await runNormalizer(() => {
        throw new Error(STUB_REASON);
    }, deps);
}

if (import.meta.main) await main();

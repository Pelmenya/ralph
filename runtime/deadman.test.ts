// Юнит-тесты deadman.ts (#147) — чистое правило «какой порог тишины применять».
// Модуль без побочек (только строки/числа на вход-выход), поэтому DI/guardSideEffect
// не нужны: реального лога, сети и файлов здесь нет, только классификация хвоста и
// арифметика порога.
import { describe, it, expect } from 'vitest';
import {
    classifyActivity,
    silenceThresholdMs,
    thresholdForTail,
    parseApiWaitMs,
    parseDeployWaitMs,
    DEFAULT_DEADMAN,
    DEFAULT_CLAUDE_TIMEOUT_MS,
    API_WAIT_RE,
    DEPLOY_WAIT_RE,
    type Activity,
} from './deadman.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов.
import { apiLimitMessage, deployWaitMessage } from '../ralph.js';
import { logLine as t } from '../tests/test-helpers.ts';

describe('classifyActivity — режим петли по хвосту лога', () => {
    it('claude-сессия в работе (▶ claude -p последней строкой) → coder', () => {
        const lines = [
            t('🔄 Фаза X | итерация 1/10 | Issue #1: ... | модель: claude-opus-4-8 | осталось: 3'),
            t('▶ claude -p "Прочитай …" --max-turns 200 --model claude-opus-4-8'),
        ];
        expect(classifyActivity(lines)).toBe('coder');
    });

    it('маркер итерации 🔄 без последующего ▶ (мгновение между строками) → coder', () => {
        expect(classifyActivity([t('🔄 Фаза X | итерация 2/10 | Issue #2')])).toBe('coder');
    });

    it('ревью и правки — тоже claude-сессии → coder', () => {
        expect(classifyActivity([t('🔍 Ревью фазы моделью: claude-fable-5')])).toBe('coder');
        expect(classifyActivity([t('🔧 Правки по ревью...')])).toBe('coder');
    });

    it('старт гейта 🚦 → gate', () => {
        expect(
            classifyActivity([t('🚦 Гейт мерджа: проверка label blocked + сверка HEAD + чеки...')]),
        ).toBe('gate');
    });

    it('идёт прогон чеков (последняя строка — ✓ пройденного чека) → gate', () => {
        const lines = [t('🚦 Гейт мерджа: ...'), t('  ✓ build'), t('  ✓ lint'), t('  ✓ typecheck')];
        expect(classifyActivity(lines)).toBe('gate');
    });

    it('красный чек (✗) — всё ещё режим гейта → gate', () => {
        expect(classifyActivity([t('  ✗ test — красный, авто-мердж отменён')])).toBe('gate');
    });

    it('хозяйственные шаги (git/gh) без маркеров сессии/гейта → default', () => {
        const lines = [
            t('🌳 Worktree раннера переведён на свежий origin/main.'),
            t('📦 npm ci перед чеками...'),
        ];
        // 🌳/📦 — не маркеры claude-сессии и не гейт: короткий дефолт.
        expect(classifyActivity(lines)).toBe('default');
    });

    it('пустой хвост → default', () => {
        expect(classifyActivity([])).toBe('default');
    });

    it('#249 непрерывный prod: строка continue (haltBeforeDeploy=false) нейтральна, не coder/stopped', () => {
        // Переход «фаза N смерджена → фаза N+1» не должен читаться как тишина/зависание:
        // строка continue не матчит ни один значимый маркер, скан уходит к предыдущему
        // 🚀 (пост-мердж деплой) → default, а не к stopped/coder.
        const lines = [
            t('🚀 Пост-мердж деплой фазы "M1": итог workflow — completed (success).'),
            t(
                '▶ Ralph: фаза "M1" — деплой зелёный, haltBeforeDeploy=false — продолжаю без остановки, следующая фаза уже поднята.',
            ),
        ];
        expect(classifyActivity(lines)).toBe('default');
    });

    it('нейтральная строка (⚠, многострочный хвост ошибки) ПОСЛЕ ▶ claude не сбивает режим → coder', () => {
        // Реальный кейс из ralph.log: посреди сессии проскочило ⚠ о выборе ревью-
        // модели. Классификатор должен пропустить нейтральную строку и остаться в
        // coder, иначе короткий порог дал бы ложный ночной пуш на легитимной сессии.
        const lines = [
            t('▶ claude -p "…" --max-turns 200 --model claude-opus-4-8'),
            t('⚠ Не смог получить дифф фазы для выбора ревью-модели: ...'),
            "fatal: couldn't find remote ref feature/x",
        ];
        expect(classifyActivity(lines)).toBe('coder');
    });

    it('после мерджа (✅ PR смерджен) режим гейта закрыт → default', () => {
        // ✓-строки чеков остаются в хвосте выше, но ✅ PR как более свежий major-маркер
        // должен закрыть режим гейта — иначе после мерджа висел бы длинный gate-порог.
        const lines = [
            t('  ✓ test'),
            t('✅ PR #143 смерджен (squash), дерево раннера на свежем origin/main.'),
        ];
        expect(classifyActivity(lines)).toBe('default');
    });

    it('создание PR после ✅ Фаза — это claude-сессия (▶ claude) → coder', () => {
        const lines = [
            t('✅ Фаза "X" — issues закрыты. PR → ревью → правки → гейт мерджа...'),
            t('▶ claude -p "…" --max-turns 200'),
        ];
        expect(classifyActivity(lines)).toBe('coder');
    });

    it('пауза API-лимита (🔔 PUSH ⏳ Жду N мин) поверх ▶ claude → apiwait, а НЕ coder', () => {
        // runClaude синхронно спит N минут на этой строке; без отдельного режима скан ушёл
        // бы назад к ▶ claude, взял бы coder-порог (2ч10м) и дал ложный пуш на паузе >2ч.
        const lines = [
            t('▶ claude -p "…" --max-turns 200 --model claude-opus-4-8'),
            t(
                '🔔 PUSH: ⏳ Ralph: API-лимит — сессия упала с маркером лимита. Жду 305 мин до сброса окна и повторяю (попытка 1/3).',
            ),
        ];
        expect(classifyActivity(lines)).toBe('apiwait');
    });

    it('после сна API-лимита новая сессия (▶ claude свежее паузы) → снова coder', () => {
        const lines = [
            t('🔔 PUSH: ⏳ Ralph: API-лимит — … Жду 305 мин … (попытка 1/3).'),
            t('▶ claude -p "…" --max-turns 200 --model claude-opus-4-8'),
        ];
        expect(classifyActivity(lines)).toBe('coder');
    });
});

describe('classifyActivity — штатные остановки петли не считаются тишиной (режим stopped)', () => {
    // Терминальные маркеры: после них раннер вышел из loop и процесс завершился — лог
    // заморожен корректно. Без режима stopped скан уходил бы к ✅/🏁 → default (5 мин) →
    // ложный 💀 DEADMAN «цикл продолжается» после КАЖДОЙ сданной прод-фазы.
    it('прод-стоп фазы перед деплоем (⏸) поверх ✅/🏁 → stopped, а НЕ default', () => {
        const lines = [
            t('✅ PR #150 смерджен (squash), дерево на свежем origin/main.'),
            t('🏁 Milestone "Наблюдаемость ralph · Фаза 1" закрыт.'),
            t('⏸ Ralph: фаза "X" — loop остановлен перед деплоем (prod).'),
        ];
        expect(classifyActivity(lines)).toBe('stopped');
    });

    it('HITL-стоп (✋) → stopped', () => {
        expect(classifyActivity([t('✋ HITL: одна итерация выполнена, стоп.')])).toBe('stopped');
    });

    it('circuit breaker (🔔 PUSH ⛔ Ralph: circuit breaker) → stopped', () => {
        expect(
            classifyActivity([
                t('🔔 PUSH: ⛔ Ralph: circuit breaker — лимит итераций (10) на фазу "X".'),
            ]),
        ).toBe('stopped');
    });

    it('все фазы завершены (🎉) → stopped', () => {
        expect(classifyActivity([t('🎉 Все фазы завершены!')])).toBe('stopped');
    });

    it('транзитный ⛔ гейта сменяется свежей чини-сессией (▶ claude) → снова coder, не stopped', () => {
        // ⛔ гейт-отказ не терминален: за ним идёт чини-сессия, чей ▶ claude свежее ⛔ и
        // выигрывает скан. Порог возвращается к coder — watchdog не обезоружен на живой петле.
        const lines = [
            t('⛔ Гейт красный после 1 чини-сессии — PR оставлен человеку.'),
            t('▶ claude -p "…" --max-turns 200 --model claude-opus-4-8'),
        ];
        expect(classifyActivity(lines)).toBe('coder');
    });

    it('stopped → порог +∞: тишина не срабатывает никогда (нет ложного пуша)', () => {
        const cfg = {
            claudeTimeoutMs: 7200000,
            deadman: { iterationGraceMs: 600000, gateSilenceMs: 600000, defaultSilenceMs: 300000 },
        };
        expect(silenceThresholdMs('stopped', cfg)).toBe(Infinity);
        expect(
            thresholdForTail([t('⏸ Ralph: фаза "X" — loop остановлен перед деплоем.')], cfg),
        ).toBe(Infinity);
    });
});

describe('API_WAIT_RE синхронизирован с форматом apiLimitMessage() из ralph.js', () => {
    // Формат строки паузы живёт в одном месте (ralph.apiLimitMessage). Этот тест —
    // барьер против рассинхрона: если формулировку в ралфе поправят так, что regex
    // перестанет матчить/захватывать N, гейт покраснеет здесь, а не всплывёт ночью
    // ложным пушем (строка станет нейтральной → скан уйдёт к coder-порогу 2ч10м).
    it('фактический apiLimitMessage матчится API_WAIT_RE и отдаёт N', () => {
        const msg = `🔔 PUSH: ${apiLimitMessage(140 * 60000, 0, 3)}`;
        const m = API_WAIT_RE.exec(msg);
        expect(m).not.toBeNull();
        expect(m![1]).toBe('140');
    });

    it('parseApiWaitMs берёт N именно из фактической строки ралфа (сквозной путь)', () => {
        const cfg = { claudeTimeoutMs: 7200000, deadman: { iterationGraceMs: 600000 } };
        const lines = [t(`🔔 PUSH: ${apiLimitMessage(45 * 60000, 1, 3)}`)];
        expect(parseApiWaitMs(lines, cfg)).toBe(45 * 60000 + 600000);
    });
});

describe('DEPLOY_WAIT_RE синхронизирован с форматом deployWaitMessage() из ralph.js (#TFO89)', () => {
    // Тот же барьер против рассинхрона, что и у API_WAIT_RE: формат строки ожидания
    // пост-мердж деплоя живёт в одном месте (ralph.deployWaitMessage). Правка формулировки,
    // ломающая матч, покраснит гейт здесь, а не всплывёт ночью ложным DEADMAN-пушем (строка
    // станет нейтральной → скан уйдёт к default 5 мин на каждом prod-мердже).
    it('фактический deployWaitMessage матчится DEPLOY_WAIT_RE и отдаёт таймаут N', () => {
        const msg = deployWaitMessage('deploy.yml', 'a'.repeat(40), 20 * 60000);
        const m = DEPLOY_WAIT_RE.exec(msg);
        expect(m).not.toBeNull();
        expect(m![1]).toBe('20');
    });

    it('строка ожидания деплоя классифицируется как deploywait, не default', () => {
        const lines = [t(deployWaitMessage('deploy.yml', 'b'.repeat(40), 20 * 60000))];
        expect(classifyActivity(lines)).toBe('deploywait');
    });

    it('нейтральный ⚠-чих во время ожидания не сбивает режим deploywait', () => {
        const lines = [
            t(deployWaitMessage('deploy.yml', 'b'.repeat(40), 20 * 60000)),
            t('⚠ Пост-мердж: чтение gh run не удалось (gh: timeout) — повтор на следующем опросе.'),
        ];
        expect(classifyActivity(lines)).toBe('deploywait');
    });

    it('parseDeployWaitMs берёт таймаут N из фактической строки ралфа + запас iterationGraceMs', () => {
        const cfg = { claudeTimeoutMs: 7200000, deadman: { iterationGraceMs: 600000 } };
        const lines = [t(deployWaitMessage('deploy.yml', 'a'.repeat(40), 20 * 60000))];
        expect(parseDeployWaitMs(lines, cfg)).toBe(20 * 60000 + 600000);
    });

    it('порог режима deploywait = таймаут ожидания + запас (сквозной путь через thresholdForTail)', () => {
        const cfg = { claudeTimeoutMs: 7200000, deadman: { iterationGraceMs: 600000 } };
        const lines = [t(deployWaitMessage('deploy.yml', 'a'.repeat(40), 20 * 60000))];
        expect(thresholdForTail(lines, cfg)).toBe(20 * 60000 + 600000);
    });
});

describe('parseApiWaitMs — порог паузы из строки «Жду N мин»', () => {
    const cfg = {
        claudeTimeoutMs: 7200000,
        deadman: { iterationGraceMs: 600000, gateSilenceMs: 600000, defaultSilenceMs: 300000 },
    };

    it('вынимает N минут и добавляет запас iterationGraceMs', () => {
        const lines = [t('🔔 PUSH: ⏳ Ralph: API-лимит — … Жду 305 мин … (попытка 1/3).')];
        expect(parseApiWaitMs(lines, cfg)).toBe(305 * 60000 + 600000);
    });

    it('нет строки паузы в хвосте → null (вызывающий возьмёт консервативный порог)', () => {
        expect(parseApiWaitMs([t('▶ claude -p "…"')], cfg)).toBeNull();
    });
});

describe('silenceThresholdMs — порог по режиму и конфигу', () => {
    const cfg = {
        claudeTimeoutMs: 7200000,
        deadman: {
            iterationGraceMs: 600000,
            gateSilenceMs: 600000,
            defaultSilenceMs: 300000,
        },
    };

    it('coder → claudeTimeoutMs + запас (кодер-сессия легитимно молчит до таймаута)', () => {
        expect(silenceThresholdMs('coder', cfg)).toBe(7200000 + 600000);
    });

    it('gate → порог тишины гейта (таймаут самого долгого чека + запас)', () => {
        expect(silenceThresholdMs('gate', cfg)).toBe(600000);
    });

    it('default → короткий дефолт для git/gh-шагов', () => {
        expect(silenceThresholdMs('default', cfg)).toBe(300000);
    });

    it('нет блока deadman в конфиге → берутся DEFAULT_DEADMAN', () => {
        const bare = { claudeTimeoutMs: 7200000 };
        expect(silenceThresholdMs('coder', bare)).toBe(7200000 + DEFAULT_DEADMAN.iterationGraceMs);
        expect(silenceThresholdMs('gate', bare)).toBe(DEFAULT_DEADMAN.gateSilenceMs);
        expect(silenceThresholdMs('default', bare)).toBe(DEFAULT_DEADMAN.defaultSilenceMs);
    });

    it('нет claudeTimeoutMs → дефолт 2ч (как в runClaudeOnce)', () => {
        expect(silenceThresholdMs('coder', { deadman: { iterationGraceMs: 0 } })).toBe(
            2 * 60 * 60 * 1000,
        );
    });

    it('битые значения полей deadman (строка/null/объект/NaN) → по-полевой откат на DEFAULT', () => {
        // Опечатка "600000" строкой без проверки дала бы NaN в арифметике порога →
        // silenceMs > NaN навсегда false → watchdog молча обезоружен. По-полевой откат ловит.
        const broken = {
            claudeTimeoutMs: 7200000,
            deadman: {
                gateSilenceMs: '600000',
                defaultSilenceMs: null,
                iterationGraceMs: {},
            },
        };
        expect(silenceThresholdMs('gate', broken)).toBe(DEFAULT_DEADMAN.gateSilenceMs);
        expect(silenceThresholdMs('default', broken)).toBe(DEFAULT_DEADMAN.defaultSilenceMs);
        expect(silenceThresholdMs('coder', broken)).toBe(
            7200000 + DEFAULT_DEADMAN.iterationGraceMs,
        );
    });

    it('отрицательный/±∞ порог тоже откатывается на DEFAULT (не занижаем/не ломаем)', () => {
        const bad = { deadman: { gateSilenceMs: -1, defaultSilenceMs: Infinity } };
        expect(silenceThresholdMs('gate', bad)).toBe(DEFAULT_DEADMAN.gateSilenceMs);
        expect(silenceThresholdMs('default', bad)).toBe(DEFAULT_DEADMAN.defaultSilenceMs);
    });

    it('iterationGraceMs: 0 — легитимный нулевой запас, НЕ откатывается', () => {
        // Граница: 0 — валидное значение (нет запаса), в отличие от строки/null.
        expect(
            silenceThresholdMs('coder', {
                claudeTimeoutMs: 7200000,
                deadman: { iterationGraceMs: 0 },
            }),
        ).toBe(7200000);
    });

    it('битый claudeTimeoutMs (строка) → дефолт 2ч, а не NaN', () => {
        expect(
            silenceThresholdMs('coder', {
                claudeTimeoutMs: '7200000',
                deadman: { iterationGraceMs: 0 },
            }),
        ).toBe(DEFAULT_CLAUDE_TIMEOUT_MS);
    });

    it('сырой конфиг с секцией common (до резолва) НЕ читается — берутся дефолты', () => {
        // Контракт узкий: подаётся только резолвнутый профилем конфиг (поля на верхнем
        // уровне). Сырой { common } без имени профиля честно слить нельзя, поэтому его
        // оверрайды игнорируются и берётся DEFAULT_DEADMAN — и раннер, и монитор резолвят
        // профиль ДО вызова детекта, так что в бою это недостижимо.
        const raw = {
            common: { claudeTimeoutMs: 7200000, deadman: { gateSilenceMs: 111 } },
        };
        expect(silenceThresholdMs('gate', raw)).toBe(DEFAULT_DEADMAN.gateSilenceMs);
    });

    it('неизвестный режим трактуется как default (fail-safe)', () => {
        // Каст: activity типизирован Activity (#403-review), но проверяем именно ветку
        // default switch — рантайм-мусор мимо union'а, ради которого она и оставлена.
        expect(silenceThresholdMs('что-то' as Activity, cfg)).toBe(300000);
    });

    it('apiwait → N мин из строки паузы + запас (lines прокинуты)', () => {
        const lines = [t('🔔 PUSH: ⏳ Ralph: API-лимит — … Жду 90 мин … (попытка 1/3).')];
        expect(silenceThresholdMs('apiwait', cfg, lines)).toBe(90 * 60000 + 600000);
    });

    it('apiwait без строки паузы (lines пустые) → консервативно coder-порог', () => {
        expect(silenceThresholdMs('apiwait', cfg, [])).toBe(7200000 + 600000);
    });
});

describe('thresholdForTail — хвост лога → порог', () => {
    const cfg = {
        claudeTimeoutMs: 7200000,
        deadman: { iterationGraceMs: 600000, gateSilenceMs: 600000, defaultSilenceMs: 300000 },
    };

    it('хвост кодер-сессии → длинный порог', () => {
        expect(thresholdForTail([t('▶ claude -p "…"')], cfg)).toBe(7800000);
    });

    it('хвост гейта → порог гейта', () => {
        expect(thresholdForTail([t('  ✓ build')], cfg)).toBe(600000);
    });

    it('хозяйственный хвост → короткий дефолт', () => {
        expect(thresholdForTail([t('🌳 Worktree раннера ...')], cfg)).toBe(300000);
    });

    it('хвост с паузой API-лимита → порог самой паузы (N мин + запас), а не coder', () => {
        const lines = [
            t('▶ claude -p "…"'),
            t('🔔 PUSH: ⏳ Ralph: API-лимит — … Жду 45 мин … (попытка 1/3).'),
        ];
        expect(thresholdForTail(lines, cfg)).toBe(45 * 60000 + 600000);
    });
});

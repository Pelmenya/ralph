import { describe, expect, it } from 'vitest';
import { runMetric, type TMetricDeps } from './metric.mts';

const CONFIG = '/path/to/app/.claude/ralph/ralph.config.json';
const RUNTIME = '/path/to/state';
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

const LOG = [
    '[2026-10-26T10:00:00.000Z] 🔄 Ф | итерация 1/10 | Issue #1: x | модель: m (claude)',
    '[2026-10-26T10:20:00.000Z] 🔔 PUSH: ✅ Ralph: фаза "Ф" смерджена в main — готова к релизу.',
    '[2026-10-26T11:00:00.000Z] 🔄 Ф2 | итерация 1/10 | Issue #2: y | модель: m (claude)',
].join('\n');

function deps(
    files: Record<string, string>,
    config: Record<string, unknown> = {
        metrics: { taskBudgetMin: 30 },
        rootsResolved: { runtimeDir: RUNTIME },
    },
): TMetricDeps {
    return {
        // Резолв профилей — свой у раннера и проверен там; здесь важно только, что команда
        // отдаёт ему сырой конфиг и читает результат.
        resolveProfile: (raw) => (raw === 'RAW' ? config : null),
        parseProfileFlag: () => null,
        readFn: (p) => {
            if (p === CONFIG) return JSON.stringify('RAW');
            if (p in files) return files[p];
            throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        },
        now: () => NOW,
    };
}

const STATE = JSON.stringify({ count: 1, milestone: 'Ф2', submitted: false, schemaVersion: 1 });

describe('команда сводки', () => {
    it('печатает сводку за сутки по логу и state из runtimeDir конфига', () => {
        const out = runMetric(
            ['--config', CONFIG],
            deps({ [`${RUNTIME}/ralph.log`]: LOG, [`${RUNTIME}/ralph.state.json`]: STATE }),
        );
        expect(out).toContain('бюджет задачи 30 мин');
        expect(out).toContain('1 из 2 (50 %)');
        expect(out).toContain('в работе: 1 — #2');
        expect(out).toContain(`Лог: ${RUNTIME}/ralph.log`);
    });

    it('без секции roots — каталог самого конфига', () => {
        const dir = '/path/to/app/.claude/ralph';
        const out = runMetric(
            ['--config', CONFIG],
            deps({ [`${dir}/ralph.log`]: LOG }, { metrics: { taskBudgetMin: 30 } }),
        );
        expect(out).toContain(`Лог: ${dir}/ralph.log`);
    });

    it('--hours сужает период', () => {
        const out = runMetric(
            ['--config', CONFIG, '--hours', '1'],
            deps({ [`${RUNTIME}/ralph.log`]: LOG }),
        );
        expect(out).toContain('Взято задач: 1');
    });

    it('--line — суточная строка, та же, что уходит в Telegram', () => {
        const out = runMetric(
            ['--config', CONFIG, '--line'],
            deps({ [`${RUNTIME}/ralph.log`]: LOG, [`${RUNTIME}/ralph.state.json`]: STATE }),
        );
        expect(out).toBe(
            '📈 Метрика за 24 ч до 2026-10-26T12:00Z: в бюджет 1 из 2 (50 %), пойманных отказов 0, остановок петли 0.',
        );
    });

    it('--budget-min подменяет бюджет конфига на один запуск', () => {
        const out = runMetric(
            ['--config', CONFIG, '--budget-min', '10'],
            deps({ [`${RUNTIME}/ralph.log`]: LOG }, { rootsResolved: { runtimeDir: RUNTIME } }),
        );
        expect(out).toContain('смерджено сверх бюджета: 1 — #1');
    });

    it('state нет — текущей фазы нет, незавершённое уходит в «неизвестно»', () => {
        const out = runMetric(['--config', CONFIG], deps({ [`${RUNTIME}/ralph.log`]: LOG }));
        expect(out).toContain('исход неизвестен: 1 — #2');
    });

    it.each([
        [[], 'нужен --config'],
        [['--config', 'ralph.config.json'], 'относительный'],
        [['--config', CONFIG, '--hours', '0'], 'положительное'],
        [['--config', CONFIG, '--hours', '-1'], 'положительное'],
        [['--config', CONFIG, '--hours'], 'без значения'],
        [['--config', CONFIG, '--hours', '--line'], 'без значения'],
        [['--config', CONFIG, '--budget-min', '0'], 'положительное'],
        [['--config', CONFIG, '--budget-min', 'abc'], 'положительное'],
        [['--config', CONFIG, '--budget-min'], 'без значения'],
        [['--config', CONFIG, '--config', CONFIG], 'дважды'],
        // Опечатки флагов — отказ, а не сводка с умолчаниями.
        [['--config', CONFIG, '--hour', '1'], 'незнакомый аргумент --hour'],
        [['--config', CONFIG, '--budget', '10'], 'незнакомый аргумент --budget'],
        [['--config', CONFIG, 'лишнее'], 'незнакомый аргумент лишнее'],
    ])('%j — отказ с причиной', (argv, why) => {
        expect(() => runMetric(argv, deps({ [`${RUNTIME}/ralph.log`]: LOG }))).toThrow(why);
    });

    it('--profile=имя — знакомая форма флага', () => {
        expect(() =>
            runMetric(
                ['--config', CONFIG, '--profile=prod'],
                deps({ [`${RUNTIME}/ralph.log`]: LOG }),
            ),
        ).not.toThrow();
    });

    it('без бюджета в конфиге и без флага — отказ, а не дефолт', () => {
        expect(() =>
            runMetric(
                ['--config', CONFIG],
                deps({ [`${RUNTIME}/ralph.log`]: LOG }, { rootsResolved: { runtimeDir: RUNTIME } }),
            ),
        ).toThrow('metrics.taskBudgetMin');
    });

    it('лога нет — отказ, а не «за сутки ничего не брали»', () => {
        expect(() => runMetric(['--config', CONFIG], deps({}))).toThrow('не читается');
    });

    it('повреждённый state — отказ, а не «текущей фазы нет»', () => {
        expect(() =>
            runMetric(
                ['--config', CONFIG],
                deps({ [`${RUNTIME}/ralph.log`]: LOG, [`${RUNTIME}/ralph.state.json`]: '{' }),
            ),
        ).toThrow('повреждён');
    });
});

// Гейт канона: то, что обязано быть зелёным ДО мерджа в этом репозитории.
//
// Почему отдельный раннер, а не цепочка `&&` в npm-скрипте. Цепочка умеет ровно одно —
// остановиться на первом ненулевом коде. Гейту нужно ещё три вещи, и каждая уже стоила
// зелёного прогона, ничего не проверившего:
//
//   1. НАЗВАТЬ упавший чек. Раннер-потребитель кормит именем упавшего чека чини-сессию
//      (`core/gate.ts` → RedCheck), и гейт самого канона обязан говорить на том же языке.
//   2. Сказать, чего прогон НЕ проверил. Словарь имён потребителей приходит снаружи
//      (`RALPH_TRACE_DENY`), и без него половина барьера следов просто не идёт: структурные
//      классы работают, а имя приватного репозитория структурной формы не имеет вовсе.
//      Молчаливый зелёный тут читается как «следов нет», хотя проверено было полдела.
//   3. Идти fail-fast в осознанном порядке: формат и типы — секунды, сьют — минуты.
//
// Замер (#268) нужен до оптимизации: общий итог CI не отличал медленную установку от
// тяжёлого файла. Время и JSON — диагностика; потеря отчёта не меняет вердикт чеков.
//
// Запуск: `npm run gate`. TS без билд-шага — нативный type stripping Node 24.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export const TIMING_REPORT = path.join(import.meta.dirname, 'node_modules', '.gate-timing.json');

// Пара [имя, команда] — та же форма, в которой состав гейта приезжает раннеру из конфига
// потребителя (`ralph.config.json` → `gate.checks`). Порядок = порядок исполнения.
const CHECKS: Array<[string, string]> = [
    ['format', 'npm run format:check --silent'],
    ['typecheck', 'npm run typecheck --silent'],
    // Сьют с замером покрытия (#129): пороги-храповик живут в vitest.config.ts, и
    // красный по ним — красный этого же чека, а не отдельного прогона сьюта.
    [
        'test',
        'npm run test --silent -- --coverage --reporter=default ' +
            '--reporter=./gate-timing-reporter.mts --outputFile.json=node_modules/.gate-timing.json',
    ],
];

export type GateDeps = {
    run: (cmd: string) => { status: number | null };
    now: () => number;
    readReport: () => string;
    clearReport: () => void;
    log: (line: string) => void;
    error: (line: string) => void;
    traceDeny?: string;
};

export function slowestFiles(report: string): Array<{ name: string; duration: number }> {
    const data = JSON.parse(report);
    if (!Array.isArray(data?.testResults) || data.testResults.length === 0) {
        throw new Error('нет результатов тестовых файлов');
    }
    return data.testResults
        .map((file: { name?: unknown; startTime?: unknown; endTime?: unknown }) => {
            if (
                !file ||
                typeof file.name !== 'string' ||
                !file.name.trim() ||
                typeof file.startTime !== 'number' ||
                typeof file.endTime !== 'number' ||
                !Number.isFinite(file.startTime) ||
                !Number.isFinite(file.endTime) ||
                file.endTime < file.startTime ||
                !Number.isFinite(file.endTime - file.startTime)
            ) {
                throw new Error('неверное имя или время тестового файла');
            }
            return { name: file.name, duration: file.endTime - file.startTime };
        })
        .sort((a: { duration: number }, b: { duration: number }) => b.duration - a.duration)
        .slice(0, 15);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(3)} с`;

export function runGate(deps: GateDeps): number {
    if ((deps.traceDeny ?? '').trim() === '') {
        deps.log(
            'ℹ RALPH_TRACE_DENY не задан: скан следов идёт только по структурным классам.\n' +
                '  Имена репозиториев, организаций, доменов, а также проектных меток и фаз этим\n' +
                '  прогоном НЕ проверены — структурной формы у них нет, распознать их можно только\n' +
                '  словарём. Задай его списком через запятую там, где эти имена известны.',
        );
    }

    let total = 0;
    for (const [name, cmd] of CHECKS) {
        let reportCleared = false;
        if (name === 'test') {
            // Иначе упавший до записи Vitest показал бы времена ПРЕДЫДУЩЕГО прогона.
            try {
                deps.clearReport();
                reportCleared = true;
            } catch (e) {
                deps.log(`⚠ Отчёт времени файлов не очищен: ${String(e)}`);
            }
        }
        deps.log(`▶ ${name}: ${cmd}`);
        const start = deps.now();
        const res = deps.run(cmd);
        const duration = deps.now() - start;
        total += duration;
        deps.log(`⏱ ${name}: ${seconds(duration)}`);
        if (name === 'test' && reportCleared) {
            try {
                const files = slowestFiles(deps.readReport());
                // JSON Vitest считает интервал от первого до последнего теста файла;
                // загрузка модулей и покрытие входят во время чека, но не в этот интервал.
                deps.log(`⏱ Самые долгие файлы (${files.length}, интервал тестов Vitest):`);
                for (const file of files) {
                    deps.log(
                        `  ${seconds(file.duration)}  ${path.relative(import.meta.dirname, file.name)}`,
                    );
                }
            } catch (e) {
                deps.log(`⚠ Отчёт времени файлов недоступен: ${String(e)}`);
            }
        }
        if (res.status !== 0) {
            deps.log(`⏱ Итого по чекам: ${seconds(total)}`);
            deps.error(`❌ гейт красный на чеке «${name}» (код ${String(res.status)})`);
            return 1;
        }
    }
    deps.log(`⏱ Итого по чекам: ${seconds(total)}`);
    deps.log(`✅ гейт зелёный: ${CHECKS.map(([n]) => n).join(', ')}`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    process.exitCode = runGate({
        run: (cmd) => spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: import.meta.dirname }),
        now: () => performance.now(),
        readReport: () => readFileSync(TIMING_REPORT, 'utf8'),
        clearReport: () => rmSync(TIMING_REPORT, { force: true }),
        log: (line) => console.log(line),
        error: (line) => console.error(line),
        traceDeny: process.env.RALPH_TRACE_DENY,
    });
}

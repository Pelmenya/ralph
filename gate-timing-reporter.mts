// Встроенный JSON reporter бросает при отказе записи и красит весь Vitest (#268).
// Диагностический отчёт не вправе менять вердикт: сохраняем формат Vitest, но ловим
// отказ генерации/записи здесь, до того как Vitest сочтёт его ошибкой прогона.
import { JsonReporter } from 'vitest/node';

type ReporterDeps = {
    write: (report: string) => Promise<void>;
    warn: (line: string) => void;
};

export default class GateTimingReporter extends JsonReporter {
    private deps: ReporterDeps;

    constructor(options = {}, deps?: ReporterDeps) {
        super(options);
        this.deps = deps ?? {
            write: (report) => super.writeReport(report),
            warn: (line) => console.warn(line),
        };
    }

    override async writeReport(report: string): Promise<void> {
        await this.deps.write(report);
    }

    override async onTestRunEnd(
        modules: Parameters<JsonReporter['onTestRunEnd']>[0],
    ): Promise<void> {
        try {
            await super.onTestRunEnd(modules);
        } catch (e) {
            this.deps.warn(`⚠ Отчёт времени файлов не записан: ${String(e)}`);
        }
    }
}

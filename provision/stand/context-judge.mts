/**
 * Доставку контекста судит только журнал настоящего вызова CLI: стартовая проба исполняет хук
 * сама и поэтому доказывает разбор окружения, но не его наследование процессом хука.
 * Ожидаемое значение приходит судье из окружения хоста, а не из доступного стенду файла.
 */
import { readFileSync } from 'node:fs';

export function judgeContext(
    log: string,
    expected: string,
): { verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; why: string } {
    let calls = 0;
    for (const line of log.split(/\r?\n/)) {
        if (!line.startsWith('context ')) continue;
        calls += 1;
        const actual = line.slice('context '.length);
        if (actual === 'absent') return { verdict: 'FAIL', why: 'хук вызван без контекста сессии' };
        if (actual !== expected) {
            return { verdict: 'FAIL', why: 'хук получил контекст, отличный от ожидаемого' };
        }
    }
    if (calls === 0) return { verdict: 'INCONCLUSIVE', why: 'хук не вызван ни разу' };
    return { verdict: 'PASS', why: `${calls} вызова хука получили ожидаемый контекст` };
}

if (import.meta.main) {
    const [logPath, expectedName, ...extra] = process.argv.slice(2);
    if (!logPath || !expectedName || extra.length > 0) {
        process.stderr.write('context-judge: <файл лога> <имя переменной с ожидаемым>\n');
        process.exit(2);
    }
    const expected = process.env[expectedName];
    if (expected === undefined) {
        process.stderr.write(`context-judge: переменная ${expectedName} не задана\n`);
        process.exit(2);
    }
    try {
        const { verdict, why } = judgeContext(readFileSync(logPath, 'utf8'), expected);
        process.stdout.write(`${verdict} ${why}\n`);
    } catch (e) {
        process.stderr.write(`context-judge: ${(e as Error).message}\n`);
        process.exit(2);
    }
}

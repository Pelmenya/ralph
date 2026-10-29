/**
 * Обезличивание фикстур стенда живых проб и сверка набора воспроизведения (#235).
 *
 * Набор воспроизведения #192 приехал в фикстуру OpenCode нечитаемым: между каждыми двумя
 * символами `stand.sh`, `drive.sh` и случаев стоял `/path/to/stand`. Путь, который подменялся
 * плейсхолдером, оказался пустым, а `replaceAll('', x)` вставляет `x` в каждую позицию строки.
 * Тест фикстуры набор не сверял, и порча прошла ревью. Поэтому здесь две стороны: замена
 * отказывает на пустом, относительном и корневом пути (корень съел бы каждый `/`), а
 * `kitScriptProblems` ловит уже испорченный набор — тест фикстуры зовёт её на каждом стенде.
 */

/** Пара «путь машины → плейсхолдер». */
export type StandPathReplacement = readonly [from: string, to: string];

/**
 * Заменяет пути машины плейсхолдерами. Длинный путь — раньше: `/x/canon-scripts` иначе
 * превратился бы в плейсхолдер канона с хвостом `-scripts`.
 */
export function scrubStandPaths(
    text: string,
    replacements: readonly StandPathReplacement[],
): string {
    for (const [from] of replacements) {
        if (from === '') throw new Error('обезличивание: пустой путь — замена испортила бы текст');
        if (!from.startsWith('/')) throw new Error(`обезличивание: путь не абсолютный: ${from}`);
        if (/^\/+$/.test(from)) throw new Error('обезличивание: корень вместо пути');
    }
    const ordered = [...replacements].sort((a, b) => b[0].length - a[0].length);
    return ordered.reduce((acc, [from, to]) => acc.replaceAll(from, to), text);
}

/** Плейсхолдер, повторённый через один символ трижды подряд, — след замены пустого пути. */
const INTERLEAVED = /(\/path\/to\/[\w-]*)[\s\S]\1[\s\S]\1[\s\S]\1/;

const ENTRY_POINTS = new Set(['stand.sh', 'drive.sh']);

/**
 * Проблемы набора воспроизведения: исполняемый вход (`stand.sh`, `drive.sh` — их условия
 * фикстуры зовут напрямую) без `#!/usr/bin/env` и любая строка набора (скрипты и случаи) с
 * плейсхолдером между соседними символами. Подключаемым через `.` библиотекам шебанг не нужен.
 */
export function kitScriptProblems(kit: Record<string, unknown>): string[] {
    const problems: string[] = [];
    const entries: [string, unknown][] = [];
    for (const [name, value] of Object.entries(kit)) {
        if (value && typeof value === 'object') {
            for (const [sub, text] of Object.entries(value)) entries.push([`${name}.${sub}`, text]);
        } else entries.push([name, value]);
    }
    for (const [name, text] of entries) {
        if (typeof text !== 'string') {
            problems.push(`${name}: не строка`);
            continue;
        }
        if (ENTRY_POINTS.has(name) && !text.startsWith('#!/usr/bin/env ')) {
            problems.push(`${name}: нет #!/usr/bin/env в первой строке`);
        }
        if (INTERLEAVED.test(text)) problems.push(`${name}: подстановка между символами`);
    }
    return problems;
}

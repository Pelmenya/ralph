// Защищаемые пути: правка любого из них — мердж за человеком (#49, #139).
//
// Список один на двух исполнителей, и ради этого он лежит в ядре. Статический тест политики
// (`tests/protection-policy.ts`, #49) сверяет по нему правило ревью SourceCraft: площадка
// требует ship человека на каждый путь. Гейт мерджа (`core/gate.ts`, #139) сверяет по нему
// файлы PR там, где площадка этого не держит. Canary 27.10 на GitHub: ruleset не умеет
// требовать одобрение только для части путей, второго аккаунта для одобрения нет, и при
// пороге одобрений 0 правка `.ralph/core.lock` смерджилась без человека. Решение человека —
// один аккаунт, порог 0, а lock защищает сам раннер. Вторая копия списка в раннере
// разъехалась бы с тестом политики так же, как однажды разъехался путь конфига
// (`core/consumer-config-path.ts`): тест зелёный, а раннер пропускает путь, который
// площадка держит.
//
// У записи две формы пути, и это не дубль. `path` — проба: конкретный файл, который обязан
// быть защищён; по нему тест политики сверяет правило площадки. `pattern` — маска, которой
// путь держит раннер; тест сверяет, что маска покрывает пробу и стоит в политике площадки
// дословно, — так раннер и площадка защищают одно и то же.
//
// Матчер нарочно СТРОЖЕ любой площадки, а не точнее её:
//   - `x/**` покрывает только то, что ЛЕЖИТ ПОД `x/`, но не сам `x`;
//   - файл, названный точным путём, считается защищённым в политике только литералом:
//     маска, которая «по идее» его накрывает, не в счёт — на этой разнице прожил дефект с
//     gitlink сабмодуля ядра, стоявшим «под защитой», которой не было. Файл в КОРНЕ (путь
//     без `/`) точный всегда, флаг ему не нужен: здесь `**` и `*.json` ловят корень, а как их
//     разворачивает площадка у корня, не мерено.
// Для теста политики ошибка такого матчера — ложный красный, а не ложный зелёный, и это
// намеренная цена.
//
// У гейта мерджа сторона ошибки обратная: там `x/**`, не покрывающий сам `x`, — ложный
// ЗЕЛЁНЫЙ. PR, заводящий файл, симлинк или gitlink с именем `.ralph` или `.claude/hooks` там,
// где каталога не было, прошёл бы мимо сверки (замену существующего каталога ловит удаление
// его файлов при `--no-renames`, новое имя — нет). Поэтому `protectedHits` считает попаданием
// и сам каталог маски `x/**`, а `patternCovers` остаётся строгим для теста политики.

import { CONSUMER_CONFIG_REL } from './consumer-config-path.ts';

/** Защищаемый путь: что именно должно требовать человека, какой маской и почему. */
export interface ProtectedPath {
    path: string;
    /**
     * Точный путь файла: в политике площадки защищён только литералом, маска не в счёт.
     * Путь в корне точный всегда, независимо от флага (см. докблок модуля).
     */
    exact: boolean;
    /** Маска, которой путь держит раннер; обязана покрывать `path`. */
    pattern: string;
    why: string;
}

export const PROTECTED_PATHS: readonly ProtectedPath[] = [
    {
        path: '.ralph/core.lock',
        exact: true,
        pattern: '.ralph/core.lock',
        why: 'ревизия ядра: правка lock меняет код, который ведёт петлю',
    },
    {
        // Проба маски, а не реальный файл: такого артефакта нет, и это нарочно. Каталог
        // `.ralph/` принадлежит launcher, и любой файл, который появится в нём рядом с
        // lock, обязан требовать человека без правки этого списка.
        path: '.ralph/<любой будущий файл>',
        exact: false,
        pattern: '.ralph/**',
        why: '`.ralph/**` — всё, что ляжет рядом с lock, включая будущие файлы',
    },
    {
        path: 'ralph',
        exact: true,
        pattern: 'ralph',
        why: 'шим launcher в корне: он решает, какую ревизию запускать',
    },
    {
        path: '.claude/ralph/hooks.json',
        exact: false,
        pattern: '.claude/ralph/hooks.json',
        why: 'контракт потребителя: данные контура хуков открывают вызов, как код',
    },
    {
        // Снимок — улика для `verify-mcp` и сверки перед сессией: правленый в PR, он
        // переписал бы инвентарь, по которому решается эквивалентность эффектов (#215, #218).
        path: '.claude/ralph/mcp-inventory.json',
        exact: false,
        pattern: '.claude/ralph/mcp-inventory.json',
        why: 'снимок инвентаря MCP: по нему сверяются эффекты данных контура',
    },
    {
        // Раннер исполняет команды серверов отсюда своим процессом (инвентарь перед сессией,
        // update): строка файла решает, какой код он запустит.
        path: '.mcp.json',
        exact: true,
        pattern: '.mcp.json',
        why: 'серверы MCP потребителя: раннер исполняет их команды со своими правами',
    },
    {
        path: CONSUMER_CONFIG_REL,
        exact: false,
        pattern: CONSUMER_CONFIG_REL,
        why: 'контракт потребителя: состав чеков гейта и раскладка корней — тот путь, что читает раннер',
    },
    {
        path: '.claude/settings.json',
        exact: false,
        pattern: '.claude/settings.json',
        why: 'проводка хуков: без неё хук лежит в дереве, но не вызывается',
    },
    {
        path: '.claude/hooks/guard.cjs',
        exact: false,
        pattern: '.claude/hooks/**',
        why: '`.claude/hooks/**` — сами хуки сессии',
    },
    {
        // С #186 guard судит событие, которое отдаёт нормализатор пакета, а `toolMap` описания
        // решает, что барьер не судит вовсе (`inert`). Перевод инструмента в `inert` или
        // потерянное поле пути снимают правило целиком, и предстартовая проба заметит это
        // только у инструментов из своего состава — не у нового, заведённого сразу `inert`.
        path: 'adapters/harnesses/claude-code/descriptor.json',
        exact: false,
        pattern: 'adapters/harnesses/**',
        why: '`adapters/harnesses/**` — описания и нормализаторы пакетов: что и как судит guard',
    },
    {
        path: '.sourcecraft/review.yaml',
        exact: false,
        pattern: '.sourcecraft/**',
        why: 'конфиг ревью площадки: правка снимает одобрение со всего остального',
    },
    {
        path: '.sourcecraft/branches.yaml',
        exact: false,
        pattern: '.sourcecraft/**',
        why: '`.sourcecraft/**` — защита ветки и CI площадки',
    },
    {
        path: '.github/CODEOWNERS',
        exact: false,
        pattern: '.github/**',
        why: 'GitHub-пара конфига ревью: владельцы путей',
    },
    {
        path: '.github/rulesets/main.json',
        exact: false,
        pattern: '.github/**',
        why: 'GitHub-пара конфига ревью: ruleset основной ветки; `.github/**` — и workflow CI',
    },
    {
        path: 'core/protected-paths.ts',
        exact: false,
        pattern: 'core/protected-paths.ts',
        why: 'этот список: выхолостить его — то же, что убрать путь из политики и из гейта',
    },
    {
        path: 'tests/protection-policy.ts',
        exact: false,
        pattern: 'tests/protection-policy.ts',
        why: 'сверщик политики площадки по этому списку',
    },
    {
        path: 'tests/protection-policy.test.ts',
        exact: false,
        pattern: 'tests/protection-policy.test.ts',
        why: 'проба барьера от противного и сверка фактического файла',
    },
];

function globToRegExp(pattern: string): RegExp {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
            // Хвост `/**` требует хотя бы один символ под каталогом: сам каталог (и gitlink
            // с тем же именем) им не покрыт.
            out += '/.+';
            i += 2;
        } else if (pattern.startsWith('**/', i)) {
            out += '(?:.*/)?';
            i += 2;
        } else if (pattern.startsWith('**', i)) {
            out += '.*';
            i += 1;
        } else if (ch === '*') {
            out += '[^/]*';
        } else if (ch === '?') {
            out += '[^/]';
        } else {
            out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${out}$`);
}

/** Покрывает ли маска путь — по строгой семантике модуля (см. докблок). */
export function patternCovers(pattern: string, path: string): boolean {
    return globToRegExp(pattern).test(path);
}

/** Маски раннера без повторов — в порядке списка. */
export function protectedPatterns(paths: readonly ProtectedPath[] = PROTECTED_PATHS): string[] {
    return [...new Set(paths.map((p) => p.pattern))];
}

/** Файл PR, попавший под защищаемую маску, и сама маска — для текста стопа. */
export interface ProtectedHit {
    file: string;
    pattern: string;
}

/**
 * Файлы, которые раннер не вправе мерджить без человека. Пустой массив — защищаемых нет.
 * Сам каталог маски `x/**` — тоже попадание (см. докблок модуля: для гейта строгость
 * `patternCovers` была бы ложным зелёным).
 * Пустой список файлов — отказ, а не «нечего сверять»: PR фазы без единого файла означает,
 * что список собран не там, и пропуск по нему был бы мерджем вслепую.
 */
export function protectedHits(
    files: readonly string[],
    paths: readonly ProtectedPath[] = PROTECTED_PATHS,
): ProtectedHit[] {
    if (files.length === 0) throw new Error('список изменённых файлов PR пуст — сверять нечего');
    const patterns = protectedPatterns(paths);
    if (patterns.length === 0) throw new Error('список защищаемых путей пуст');
    const hits: ProtectedHit[] = [];
    for (const file of files) {
        const pattern = patterns.find(
            (p) => patternCovers(p, file) || (p.endsWith('/**') && file === p.slice(0, -3)),
        );
        if (pattern) hits.push({ file, pattern });
    }
    return hits;
}

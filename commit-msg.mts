// Проверка сообщения коммита: Conventional Commits, потолок заголовка, проектные следы.
//
// Запуск: `node commit-msg.mts <файл>` — сообщение пишется в файл, проверяется этой
// командой и только потом уходит в `git commit -F <файл>` (скилл `git-commit`).
//
// ЗАЧЕМ. Сообщение коммита — единственный текст канона, который правкой файла уже не
// исправить: история публичная. Скан следов (`tests/project-traces.test.ts`) находит след в
// истории, но после пуша — когда убрать его нечем. Здесь тот же скан идёт ДО коммита.
// Формат и длина — затем, что заголовок читают `git log --oneline` и описание PR, а
// кириллица длинная: 72 символа — это 8–9 слов вместе с типом, на глаз не прикинуть.
//
// ПОЧЕМУ НЕ GIT-ХУК (пока). Две причины.
//   1. Хук в общем `.git` действует и на сессии петли в дереве раннера, а на 28.10.2026 из
//      114 последних её коммитов 21 длиннее потолка и 38 не по формату. Хук резал бы
//      коммиты живой петли посреди фазы. Код выхода у отказа ненулевой, но сессия читает
//      его как «коммит сделан» и идёт дальше: коммита нет, правки в индексе, следующий шаг
//      работает поверх них. Сначала петлю учат проверять сообщение этой командой.
//   2. Ставить хук самим `npm ci` (`prepare` с `git config core.hooksPath`) нельзя: ядро
//      подключают и каталогом внутри потребителя, и там эта команда переписала бы хуки
//      репозитория ПОТРЕБИТЕЛЯ. Установка хука — явный шаг, а не побочка установки пакетов.
//   Включению хука мешает и сам раннер: `commitLeftovers` (`core/orchestrator.ts`) коммитит
//   остаток сессии заголовком `wip(ralph): …` с `--no-verify`. Тип `wip` здесь не разрешён,
//   а `--no-verify` хук обходит. До хука этот коммит переводится на разрешённый тип и на
//   проверку этой командой — иначе хук либо ничего не держит, либо остановит петлю.
//
// ПОЧЕМУ СКАНИРУЕТСЯ ВСЁ, ВКЛЮЧАЯ СТРОКИ С `#`. `git commit -F <файл>` по умолчанию чистит
// только пробелы (`--cleanup=whitespace`): строки с решёткой уезжают в историю как есть,
// с пробелами перед решёткой — тоже. Отсев «шаблона git» пропускал бы след в историю.
//
// Язык описания не проверяется намеренно: он русский по конвенции, а определять язык
// эвристикой — источник ложных отказов на именах и терминах.
import { readFileSync } from 'node:fs';
import { denyNamePattern, traceFindings } from './shared/project-traces.ts';

/** Типы конвенции. `style` — потому что петля им пользуется для правок формата. */
export const TYPES = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'perf', 'ci', 'style'];

/** Потолок заголовка: столько влезает в `git log --oneline` без переноса. */
export const MAX_SUBJECT_LENGTH = 72;

/** Сообщения, чей формат задаёт git, а не автор: их заголовок не проверяется. */
const GENERATED_PREFIXES = ['Merge ', 'Revert ', 'fixup! ', 'squash! ', 'amend! '];

const SUBJECT_RE = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: (.+)$`);

export type TCheckResult = { ok: true } | { ok: false; reason: string };

export function checkCommitMessage(
    message: string,
    env: NodeJS.ProcessEnv = process.env,
): TCheckResult {
    const subject =
        message
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? '';
    if (subject.length === 0) return { ok: false, reason: 'сообщение пустое' };

    // Следы — по ВСЕМУ сообщению и ДО отсева служебных заголовков: тело `fixup!`/`Revert`
    // уезжает в историю так же, как тело обычного коммита.
    const traces = traceFindings(message, { deny: denyNamePattern(env) });
    if (traces.length > 0) {
        const where = traces.map((f) => `строка ${String(f.line)}: «${f.excerpt}»`).join('; ');
        return {
            ok: false,
            reason:
                `в сообщении проектный след (${where}). История публичная — пиши абстрактной ` +
                'формой: `/path/to/app`, `your-project`, `example.com`',
        };
    }

    if (GENERATED_PREFIXES.some((p) => subject.startsWith(p))) return { ok: true };

    if (!SUBJECT_RE.test(subject)) {
        return {
            ok: false,
            reason:
                'заголовок не по конвенции: ожидается «тип: описание» или «тип(область): описание»; ' +
                `тип — один из: ${TYPES.join(', ')}`,
        };
    }
    // Символы — кодовые точки, а не единицы UTF-16: иначе эмодзи считался бы за два.
    const length = [...subject].length;
    if (length > MAX_SUBJECT_LENGTH) {
        return {
            ok: false,
            reason: `заголовок длиннее ${String(MAX_SUBJECT_LENGTH)} символов (сейчас ${String(length)})`,
        };
    }
    if (subject.endsWith('.')) {
        return { ok: false, reason: 'заголовок оканчивается точкой — она ничего не добавляет' };
    }
    return { ok: true };
}

/**
 * Пустой словарь имён — не «скан пройден»: структурные классы работают, а имена
 * потребителей не проверяются вовсе. Молчать об этом нельзя — так же говорит гейт.
 */
export function denyWarning(env: NodeJS.ProcessEnv = process.env): string | null {
    return denyNamePattern(env) === null
        ? 'commit-msg: RALPH_TRACE_DENY пуст — имена потребителей не проверены, только структурные следы'
        : null;
}

// Точка входа: решающая логика выше покрыта тестами, здесь — только чтение файла.
/* v8 ignore start */
if (process.argv[1] === import.meta.filename) {
    const file = process.argv[2];
    if (!file) {
        console.error('commit-msg: не передан файл с сообщением коммита');
        process.exit(1);
    }
    const warning = denyWarning();
    if (warning) console.error(warning);
    const result = checkCommitMessage(readFileSync(file, 'utf8'));
    if (!result.ok) {
        console.error(
            `Сообщение коммита отклонено: ${result.reason}\n` +
                'Пример: fix(core): стоп вместо дефолта на битом конфиге',
        );
        process.exit(1);
    }
}
/* v8 ignore stop */

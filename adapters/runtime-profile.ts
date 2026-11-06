// Фактическая версия CLI и профиль рантайма — для журнала каждой попытки (Фаза 16, #113;
// риск R13 исследования).
//
// CLI обновляются сами, посреди ночи, и меняют поведение между итерациями. Без версии в
// записи попытки дефект ядра неотличим от смены поведения инструмента, а повторный допуск
// профиля в роль (Фаза 17) не знает, когда он нужен. Поэтому перед каждой сессией раннер
// спрашивает у бинаря `--version`, а разбирает ответ адаптер: формат строки версии — свойство
// CLI, как и формулировки исхода (`session-end.ts`).
//
// Версия — ФАКТИЧЕСКАЯ, а не ожидаемая из конфига: ожидание ничего не говорит о том, что
// исполнилось. Нечитаемая версия — явное «неизвестно» с причиной, а не пропуск поля и не
// прошлая версия: пропуск в журнале читался бы как «записи нет», а прошлая — как ложь.
// Разбор строгий: строка, не похожая на ответ своего CLI, — тоже «неизвестно». Широкая
// регулярка нашла бы номер в баннере обёртки или в предупреждении и выдала бы его за версию.
//
// TS-модуль без билд-шага (erasable-only), без побочек: чистые функции вход→выход.

export const CLI_VERSION_UNKNOWN = 'unknown';

// Модель, которую раннер CLI не передавал: сессия идёт на умолчании самого CLI. Это не
// «неизвестно» — раннер знает, что выбрал умолчание, — и сказано отдельным словом.
export const MODEL_CLI_DEFAULT = 'cli-default';

export type CliVersion = { version: string; unknownReason?: string };

// Профиль попытки: харнесс (какой CLI ведёт сессию), провайдер (чей endpoint) и модель.
// Kimi — тот же харнесс Claude Code с endpoint Moonshot, поэтому харнесс и провайдер
// названы порознь: смена версии `claude` касается обоих рантаймов, а лимит — одного.
export type RuntimeProfile = { harness: string; provider: string; model: string };

type RuntimeIdentity = {
    harness: string;
    provider: string;
    // Имя системного бинаря — только подпись и ключ профиля. Сессия и чтение версии идут
    // через закреплённую копию (#261); у claude и kimi копия одна, как прежде был один бинарь.
    bin: string;
    parseVersion: (output: string) => CliVersion;
    // Провайдер берётся из модели `provider/model` (OpenCode, #121): харнесс один, а
    // провайдер выбирает модель. `provider` выше — слово на случай модели без префикса.
    providerFromModel?: boolean;
};

const VERSION = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;

function versionFrom(re: RegExp, output: string, cli: string): CliVersion {
    const line = output.trim().split('\n')[0]?.trim() ?? '';
    const m = re.exec(line);
    if (m) return { version: m[1] };
    return {
        version: CLI_VERSION_UNKNOWN,
        unknownReason: line
            ? `ответ \`${cli} --version\` не похож на строку версии: «${line.slice(0, 80)}»`
            : `\`${cli} --version\` ничего не напечатал`,
    };
}

// CLI 2.1.311: «2.1.311 (Claude Code)».
export function parseClaudeCliVersion(output: string): CliVersion {
    return versionFrom(new RegExp(`^(${VERSION})\\s+\\(Claude Code\\)$`), output, 'claude');
}

// CLI 0.163.0: «codex-cli 0.163.0».
export function parseCodexCliVersion(output: string): CliVersion {
    return versionFrom(new RegExp(`^codex-cli\\s+(${VERSION})$`), output, 'codex');
}

// Kimi Code 2.3.2: голый номер «2.3.2» — без имени CLI. Поэтому строка обязана быть номером
// ЦЕЛИКОМ: баннер обёртки или предупреждение с номером внутри — не версия.
export function parseKimiCodeCliVersion(output: string): CliVersion {
    return versionFrom(new RegExp(`^(${VERSION})$`), output, 'kimi');
}

// OpenCode 1.19.4: тоже голый номер «1.19.4» — то же строгое правило, что у Kimi Code.
export function parseOpencodeCliVersion(output: string): CliVersion {
    return versionFrom(new RegExp(`^(${VERSION})$`), output, 'opencode');
}

// Ключи — те же, что у реестра `coderRuntime` (`CODER_RUNTIME_PROVIDERS`); сьют сверяет
// совпадение: рантайм без записи ушёл бы в журнал без профиля.
export const RUNTIME_IDENTITIES: Record<string, RuntimeIdentity> = {
    claude: {
        harness: 'claude-code',
        provider: 'anthropic',
        bin: 'claude',
        parseVersion: parseClaudeCliVersion,
    },
    kimi: {
        harness: 'claude-code',
        provider: 'moonshot',
        bin: 'claude',
        parseVersion: parseClaudeCliVersion,
    },
    openai: {
        harness: 'codex',
        provider: 'openai',
        bin: 'codex',
        parseVersion: parseCodexCliVersion,
    },
    // #120: Kimi Code родным харнессом — свой бинарь `kimi`, версия у него своя.
    'kimi-native': {
        harness: 'kimi-code',
        provider: 'moonshot',
        bin: 'kimi',
        parseVersion: parseKimiCodeCliVersion,
    },
    // #121: OpenCode — экспериментальный третий харнесс; провайдер — из `provider/model`.
    opencode: {
        harness: 'opencode',
        provider: 'model-provider',
        bin: 'opencode',
        parseVersion: parseOpencodeCliVersion,
        providerFromModel: true,
    },
};

// Профиль по ключу рантайма. Незнакомый ключ — «неизвестно» в каждом поле, а не бросок:
// запись попытки пишется уже ПОСЛЕ сессии, и отказ здесь потерял бы саму запись.
export function runtimeProfile(runtime: string, model?: string | null): RuntimeProfile {
    const id = RUNTIME_IDENTITIES[runtime];
    const slash = id?.providerFromModel && model ? model.indexOf('/') : -1;
    return {
        harness: id?.harness ?? CLI_VERSION_UNKNOWN,
        provider: slash > 0 ? model!.slice(0, slash) : (id?.provider ?? CLI_VERSION_UNKNOWN),
        model: model || MODEL_CLI_DEFAULT,
    };
}

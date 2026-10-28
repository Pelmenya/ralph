/**
 * Каталог живых проб, которые сессия петли вправе ПОПРОСИТЬ у раннера (#219).
 *
 * Ночью 27→28.10 карточки с критерием «живая проба настоящим CLI на стенде» встали
 * `blocked`: ключа CLI у сессии нет, а guard правильно не даёт читать env-файл. Пробу теперь
 * исполняет раннер вне сессии, а сессия только называет её намерением `live-probe`. Поэтому
 * список закрытый: пара `cli` + `case` — ровно сценарий `provision/install-stand.sh`
 * (функция `probe_<case>`), а не команда. Произвольная строка от сессии превратилась бы в
 * исполнение с ключом пробы.
 *
 * CLI здесь только те, чей ключ пробы раннер умеет передать в стенд одной переменной
 * окружения (`LIVE_PROBE_CLI_KEY_ENV`). У Kimi Code стенд берёт ключи ссылками на дом
 * человека, у OpenCode адрес провайдера выбирается конфигом, у Codex вход ключом из env в
 * живую не проверен — их пробы добавляются вместе с проверенным маршрутом ключа, а до тех
 * пор `live-probe` для них — отказ разбора, а не проба без авторизации.
 *
 * Проба `offline` исключена: она гоняет CLI вне изоляции ОС, а раннер запускает стенд
 * только с `STAND_ISOLATE=1`.
 */

/** Сценарии `install-stand.sh` по CLI — согласованность с `probe_*` сверяет тест. */
export const LIVE_PROBE_CASES: Readonly<Record<string, readonly string[]>> = {
    claude: [
        'block',
        'override',
        'crash',
        'merge',
        'unknown-tool',
        'symlink-env',
        'symlink-parent',
        'move-dir',
        'search-root',
        'search-glob',
        'search-deep-glob',
        'search-clean',
    ],
};

/** Переменная, которой CLI внутри стенда получает ключ пробы. */
export const LIVE_PROBE_CLI_KEY_ENV: Readonly<Record<string, string>> = {
    claude: 'ANTHROPIC_API_KEY',
};

/**
 * Маршрут пробы к провайдеру, отличному от умолчания CLI (`liveProbe.baseUrl`/`keyAs`/`model`):
 * под какими именами CLI внутри стенда берёт адрес, ключ-токен (Bearer, а не ключ API) и модель.
 * Провайдер-посредник принимает токен, а не ключ API, и не знает алиаса `haiku`, которым стенд
 * зовёт модель по умолчанию; поэтому модель едет и своей переменной стенда, и переменной,
 * которой CLI разрешает алиас фоновых вызовов. CLI без строки здесь — отказ пробы с маршрутом,
 * а не прогон к провайдеру по умолчанию.
 */
export const LIVE_PROBE_CLI_ROUTE: Readonly<
    Record<string, { authTokenEnv: string; baseUrlEnv: string; modelEnvs: readonly string[] }>
> = {
    claude: {
        authTokenEnv: 'ANTHROPIC_AUTH_TOKEN',
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        modelEnvs: ['STAND_CLAUDE_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
    },
};

/**
 * Переменные ключей ПЕТЛИ: ни одна из них не едет в процесс стенда, и ключ пробы с любой из
 * них совпадать не вправе — иначе «отдельный ключ с ограниченной квотой» был бы ключом петли
 * под другим именем, и код ветки внутри стенда увидел бы его.
 */
export const LOOP_KEY_ENVS: readonly string[] = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'RALPH_CLAUDE_OAUTH_TOKENS',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'KIMI_API_KEY',
    'MOONSHOT_API_KEY',
];

# Переключатель каналов Claude Code

`switch-claude.mjs` атомарно переключает глобальный `~/.claude/settings.json` между
четырьмя профилями:

| Профиль        | Куда идут новые сессии Claude Code                    |
| -------------- | ----------------------------------------------------- |
| `official`     | официальный Anthropic API или подписка                |
| `cheap`        | основной частный Anthropic-совместимый шлюз           |
| `cheap-direct` | прямой endpoint того же шлюза                         |
| `kimi`         | Kimi Code через официальный Anthropic-совместимый API |

Helper меняет только переменные каналов внутри `env`. Остальные настройки и переменные
Claude Code сохраняются. Открытая сессия уже получила окружение при старте, поэтому после
переключения её нужно перезапустить.

## Запуск и установка

Из клона:

```bash
node provision/claude-channel/switch-claude.mjs
node provision/claude-channel/switch-claude.mjs official
```

Чтобы сохранить прежнюю короткую команду:

```bash
install -m 700 provision/claude-channel/switch-claude.mjs ~/switch-claude.mjs
node ~/switch-claude.mjs
```

Без аргумента helper показывает текущий канал и готовность каждого профиля. `--help`
печатает профили и их обязательные переменные.

## Сеть: official через прокси, остальные напрямую

Официальный API из региона машины отвечает 403 без прокси. Поэтому `official` явно пишет
`HTTPS_PROXY`/`HTTP_PROXY` и `https_proxy`/`http_proxy` в settings: нижний регистр в Claude
Code сильнее и мог остаться от старого окружения, а сессия, поднятая без `profile.d`
(systemd, старый tmux), всё равно идёт через туннель. Сторонние каналы (`cheap`, `cheap-direct`, `kimi`)
доступны напрямую и так быстрее, поэтому helper дописывает их хост в `NO_PROXY` поверх
прежних исключений шелла. Сам прокси для остального трафика сессии (MCP, телеметрия)
остаётся и у сторонних каналов. Исключения для Anthropic (`*.anthropic.com`, `claude.ai`,
`*`) из `NO_PROXY` снимаются всегда: обёртка `claude` проверяет выход туннеля по
стороннему адресу и такой обход не заметила бы. Прокси official берётся в порядке
`CLAUDE_OFFICIAL_PROXY` → сохранённый выбор → `HTTPS_PROXY` шелла → уже записанный в
settings. Общий прокси шелла сохраняется только при первом заполнении: старое окно tmux не
перезапишет выбранный маршрут. Явный `CLAUDE_OFFICIAL_PROXY` обновляет сохранённый выбор.
Отдельный `HTTP_PROXY` шелла official больше не сохраняет: оба протокола идут выбранным
маршрутом.

`CLAUDE_OFFICIAL_EXPECTED_EGRESS` — ожидаемый внешний IP-адрес выхода через прокси
official. Helper сохраняет его из окружения в хранилище; локальная обёртка `claude`
использует его для проверки выхода, когда прокси в settings совпадает с сохранённым.
При смене прокси задайте соответствующий ему ожидаемый адрес выхода.

## Ключи вводятся один раз

Каждое значение из таблицы `--help`, увиденное в окружении, helper сохраняет в
`~/.config/claude-channel/channels.json` (права `0600`, каталог `0700`; путь меняет
`CLAUDE_CHANNEL_STORE`). Дальше переключение работает из любого шелла без `export`.
Права файла и каталога чинятся на каждом запуске, параллельные запуски идут под замком
`.switch.lock` рядом с хранилищем. Ошибки и вывод не печатают ни ключи, ни пароль из
URL прокси. Свежее значение из окружения перезаписывает сохранённое (кроме общего
`HTTPS_PROXY` после первого заполнения), поэтому устаревший ключ в `~/.bashrc` снова
испортит хранилище: держать ключи нужно в одном месте.

## Частные шлюзы

Адрес частного хоста не лежит в публичном репозитории. Его и ключ нужно передать локально:

```bash
export CLAUDE_CHEAP_BASE_URL='https://gateway.example.com'
export ROUTER_CHEAP_KEY='...'
node ~/switch-claude.mjs cheap
```

Для прямого канала задаётся `CLAUDE_CHEAP_DIRECT_BASE_URL`. При необходимости алиасы
моделей переопределяются через `CLAUDE_CHEAP_OPUS_MODEL`,
`CLAUDE_CHEAP_SONNET_MODEL` и `CLAUDE_CHEAP_HAIKU_MODEL`.

## Kimi Code

Kimi требует отдельный API key для сторонних инструментов. Его создают в Kimi Code
Console, а не извлекают из OAuth-файлов Kimi CLI:

```bash
read -rsp 'Kimi Code API key: ' KIMI_CODE_API_KEY
export KIMI_CODE_API_KEY
echo
node ~/switch-claude.mjs kimi
```

При повторном выборе уже активного Kimi-канала helper сохраняет его текущий API key, поэтому
экспортировать ключ заново не нужно. С другого endpoint ключ намеренно не переносится.

По умолчанию используется overseas endpoint `https://api.kimi.ai/coding/`. Основной кодер,
sonnet/haiku-задачи и субагенты идут через K2.8 Preview (`kimi-for-coding`), а expert-маршрут
opus/fable — через K3.1 Pro с окном 1M (`k3.1-pro[1m]`). Thinking effort — `high`, общее окно
контекста — 1M. Идентификаторы и переменные соответствуют
[официальной конфигурации моделей Kimi](https://www.kimi.com/code/docs/en/kimi-code/models.html)
и [руководству для Claude Code](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html).

Обе модели можно переопределить независимо. `CLAUDE_KIMI_MODEL` задаёт основной маршрут,
`CLAUDE_KIMI_EXPERT_MODEL` — opus/fable; `CLAUDE_KIMI_BASE_URL` меняет endpoint. Например,
конфигурация K3.1 Pro 256K для обоих маршрутов:

```bash
export CLAUDE_KIMI_MODEL='k3.1-pro'
export CLAUDE_KIMI_EXPERT_MODEL='k3.1-pro'
export CLAUDE_KIMI_CONTEXT_TOKENS='262144'
node ~/switch-claude.mjs kimi
```

`kimi` CLI продолжает использовать собственный OAuth и конфиг в `~/.kimi-code`. Helper
их не читает и не меняет; переменные переопределения намеренно названы `CLAUDE_KIMI_*`,
чтобы не перенастроить сам CLI.

## Секреты и откат

Claude Code хранит ключ активного стороннего канала открытым текстом в
`~/.claude/settings.json` — это ограничение описано и в официальной инструкции Kimi.
Helper выставляет файлу и бэкапу права `0600`, пишет через временный файл и атомарный
`rename`. Перед заменой создаётся один бэкап:

```text
~/.claude/settings.json.channel-switch.bak
```

Профиль `official` удаляет все управляемые helper-переменные из рабочего settings, но
последний бэкап может всё ещё содержать прежний ключ. Не коммитьте и не публикуйте оба
файла.

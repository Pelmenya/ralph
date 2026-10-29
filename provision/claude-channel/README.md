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

Без аргумента helper только показывает текущий канал. `--help` печатает профили и их
обязательные переменные.

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

По умолчанию используется overseas endpoint `https://api.kimi.ai/coding/`, модель
`k3.1-pro[1m]`, thinking effort `high` и окно 1M — схема из
[официального руководства Kimi для Claude Code](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html).
Окно 1M у `k3.1-pro` есть только с тарифа Pro; на Plus доступно 256K, и
модель с окном задаются локально (так же `CLAUDE_KIMI_BASE_URL` меняет endpoint):

```bash
export CLAUDE_KIMI_MODEL='k3.1-pro'
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

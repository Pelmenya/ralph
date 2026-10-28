#!/bin/sh
#
# Изоляция стенда живых проб (Фаза 16c, задача 182): исполняется ВНУТРИ свежих пространств
# имён (mount, net, pid, ipc, uts, cgroup; без root — ещё user), собирает новый корень и
# запускает команду в нём.
#
# Зачем ОС, а не временный каталог. На стенде намеренно исполняются запрещённые вызовы; при
# дефектном барьере CLI, проектный хук или подменённый MCP пишут туда, куда их попросили.
# Временный каталог и сверка хешей после факта ловят только то, что успели прочитать, и
# ничего не предотвращают. Здесь запись вне стенда — отказ ядра (EROFS), а не находка.
#
# Почему корень собирается белым списком, а не «весь / только для чтения». Первым вариантом
# был `remount,ro=recursive /` — и он оставил записываемыми `/dev/shm` и `/run`: на хосте
# появились файлы, созданные изнутри «изоляции». Чёрный список дыряв по построению: в `/run`
# лежат сокеты docker и tmux (соединение с сокетом на ro-разделе разрешено), в `/dev` —
# блочные устройства, `/proc/sys` пишется любым uid 0. Поэтому новый корень — пустой tmpfs,
# в который входят только системные каталоги (на чтение), сам стенд (на запись), свой
# `/proc` (на чтение) и минимальный `/dev` из символьных устройств. Дома человека в нём нет
# вообще — его конфиги и боевые MCP недостижимы, а не «защищены».
#
# Перед запуском команды снимаются все capabilities (`setpriv`): без CAP_SYS_ADMIN нельзя
# перемонтировать, без CAP_SYS_CHROOT — выйти из chroot, без CAP_NET_ADMIN — поднять сеть.
#
# ВЫЗОВ (собирает `stand.mts`, руками не нужен):
#   unshare [--map-root-user] --mount --net --pid --ipc --uts --cgroup --fork --kill-child \
#       sh isolate.sh <стенд> <файл-списка-ro> -- <команда…>
# Файл списка — строки `ro <путь>` (виден внутри на том же месте) и `bind <источник> <цель>`
# (файл человека на чтение по пути внутри стенда, например ключ CLI). Окружение команды
# собирает вызывающий: сюда оно приходит уже вычищенным.

set -eu

STAND="$1"
LIST="$2"
shift 2
[ "${1:-}" = -- ] && shift

# Команды настройки (`mount`, `ip`, `chroot`) живут в sbin, которого в PATH команды может не
# быть; сам PATH команды доезжает до неё нетронутым.
CMD_PATH="${PATH:-/usr/bin:/bin}"
PATH="/usr/local/sbin:/usr/sbin:/sbin:/usr/bin:/bin:$CMD_PATH"

fail() {
    printf 'isolate: %s\n' "$*" >&2
    exit 97
}

case "$STAND" in /*) ;; *) fail "стенд — абсолютный путь, а не «$STAND»" ;; esac
[ -d "$STAND" ] || fail "нет каталога стенда $STAND"

NR="$STAND/.root"
mkdir -p "$NR"
mount --make-rprivate / || fail 'не сделал разделы приватными'
mount -t tmpfs -o mode=755,size=1m ralph-stand "$NR" || fail 'не смонтировал новый корень'

# Каталог на чтение: тем же путём, без вложенных разделов (`--bind`, не `--rbind`) — вложенные
# в него разделы хоста внутри не нужны и не видны. Симлинк (`/bin` → `usr/bin`) переносится
# симлинком: bind по нему увёл бы цель на другое место.
ro() {
    src="$1"
    dst="$2"
    if [ -L "$src" ] && [ "$src" = "$dst" ]; then
        mkdir -p "$NR$(dirname "$dst")"
        ln -sfn "$(readlink "$src")" "$NR$dst"
        return
    fi
    # Точка монтирования создаётся, только если её нет: путь внутри стенда (хук пробы, файл
    # под `bind`) уже лежит там, и `: >` обнулил бы его до того, как связать на чтение.
    if [ -d "$src" ]; then mkdir -p "$NR$dst"; else
        mkdir -p "$NR$(dirname "$dst")"
        [ -e "$NR$dst" ] || : >"$NR$dst"
    fi
    mount --bind "$src" "$NR$dst" || fail "не связал $src"
    mount -o remount,bind,ro "$NR$dst" || fail "не сделал $dst только для чтения"
}

for d in /usr /bin /sbin /lib /lib32 /lib64 /libx32 /etc /opt; do
    if [ -e "$d" ] || [ -L "$d" ]; then ro "$d" "$d"; fi
done

# /tmp хоста внутри нет, и подменять его каталогом стенда нельзя: путь вне стенда, который
# изнутри молча ведёт в стенд, неотличим для пробы выхода от удавшейся записи наружу. Временный
# каталог CLI — TMPDIR в стенде; запись в /tmp мимо него — EROFS.

# Стенд — единственное место записи. Связывается ДО файлов `bind`: их цели лежат в нём.
mkdir -p "$NR$STAND"
mount --bind "$STAND" "$NR$STAND" || fail 'не связал стенд'

while read -r kind a b; do
    case "$kind" in
        '' | '#'*) ;;
        ro)
            # Строки `ro` связываются поверх стенда: предок стенда закрыл бы его на запись, и
            # проба упала бы на своей раскладке без имени причины. `stand.mts` отвергает это
            # раньше; здесь — на случай списка, собранного мимо него.
            case "$STAND/" in "${a%/}"/*) fail "путь на чтение $a накрывает каталог стенда $STAND" ;; esac
            ro "$a" "$a"
            ;;
        bind)
            case "$b" in "$STAND"/*) ;; *) fail "цель bind вне стенда: $b" ;; esac
            ro "$a" "$b"
            ;;
        *) fail "непонятная строка списка: $kind" ;;
    esac
done <"$LIST"

# Свой /proc своего pid namespace, на чтение: `/proc/sys` пишется любым uid 0, и capabilities
# здесь не спасают — проверка sysctl смотрит на uid, а не на них.
mkdir -p "$NR/proc"
mount -t proc -o nosuid,nodev,noexec proc "$NR/proc" || fail 'не смонтировал /proc'
mount -o remount,bind,ro "$NR/proc" || fail 'не сделал /proc только для чтения'

# Минимальный /dev: только символьные устройства, которым запись ничего не даёт. Блочных нет:
# запись в устройство на ro-разделе — это запись в диск, ro её не останавливает.
mkdir -p "$NR/dev"
mount -t tmpfs -o mode=755,size=64k,nosuid,noexec ralph-stand-dev "$NR/dev" || fail 'не смонтировал /dev'
for n in null zero full random urandom tty; do
    [ -e "/dev/$n" ] || continue
    : >"$NR/dev/$n"
    mount --bind "/dev/$n" "$NR/dev/$n" || fail "не связал /dev/$n"
done
ln -s /proc/self/fd "$NR/dev/fd"
ln -s /proc/self/fd/0 "$NR/dev/stdin"
ln -s /proc/self/fd/1 "$NR/dev/stdout"
ln -s /proc/self/fd/2 "$NR/dev/stderr"
mount -o remount,ro "$NR/dev" || fail 'не сделал /dev только для чтения'

mount -o remount,ro "$NR" || fail 'не сделал новый корень только для чтения'

# Сеть — только loopback: на нём мост к прокси провайдера модели (см. `egress.mts`).
ip link set lo up || fail 'не поднял loopback (нужен ip из iproute2)'

exec chroot "$NR" setpriv --no-new-privs --inh-caps=-all --bounding-set=-all -- \
    /usr/bin/env PATH="$CMD_PATH" /bin/sh -c 'cd "$1" && shift && exec "$@"' isolate "$STAND" "$@"

// Барьер на `kill` по подстановке и по чужому pid (#196) — отдельным набором, как у
// `guard-host-services.test.ts`: предмет свой (процессы хоста, а не его службы), и
// `guard-rules.test.ts` упёрся в потолок 500 строк. Тест сторожит РЕШЕНИЕ хука через
// `decide`, а таблицу процессов подменяет: живой `/proc` в тесте проверял бы хост
// (или контейнер гейта, где pid 1 — это `sh -c "<куб>"`), а не правило. Чтение
// настоящего `/proc` проверяется отдельно на поддельном каталоге той же формы.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PATTERN_KILLERS, PORT_KILLERS, readProcessInfo } from './guard-process-kill.cjs';
import { decide } from './guard-rules.cjs';

type TFakeProcess = { comm: string; ppid: number; cwd: string; cmdline: string };
type TTable = Record<number, TFakeProcess>;

// Дерево процессов инцидента 22.09.2026: сессия `claude` под раннером под tmux, рядом —
// вахта в том же tmux, и боевые службы под systemd (pid 1).
const SESSION_CWD = '/path/to/app-ralph';
const INIT: TFakeProcess = { comm: 'systemd', ppid: 0, cwd: '/', cmdline: '/sbin/init' };
const TMUX: TFakeProcess = { comm: 'tmux: server', ppid: 1, cwd: '/root', cmdline: 'tmux' };
const TABLE: TTable = {
    1: INIT,
    100: TMUX,
    200: { comm: 'node', ppid: 100, cwd: SESSION_CWD, cmdline: 'node .claude/ralph/ralph.js' },
    300: { comm: 'claude', ppid: 200, cwd: SESSION_CWD, cmdline: 'claude -p …' },
    310: { comm: 'bash', ppid: 300, cwd: SESSION_CWD, cmdline: 'bash -c …' },
    320: { comm: 'node', ppid: 310, cwd: SESSION_CWD, cmdline: 'node guard.cjs' },
    // dev-сервер, поднятый сессией: пока bash-родитель жив — потомок сессии.
    400: { comm: 'next-server', ppid: 310, cwd: SESSION_CWD, cmdline: 'next dev -p 3130' },
    // dev-сервер, чей родитель уже вышел: переусыновлён pid 1, но команда и дерево — свои.
    410: {
        comm: 'node',
        ppid: 1,
        cwd: `${SESSION_CWD}/apps/frontend`,
        cmdline: 'node /path/to/app-ralph/node_modules/.bin/next dev -p 3130',
    },
    // Такой же `next`, но в ЧУЖОМ дереве — вахты или человека.
    420: { comm: 'node', ppid: 1, cwd: '/path/to/app', cmdline: 'next dev -p 3100' },
    // Чужой процесс В ДЕРЕВЕ сессии, но не инструмент: cwd совпадает, команда — нет.
    430: { comm: 'python3', ppid: 1, cwd: SESSION_CWD, cmdline: 'python3 scratch-server.py' },
    // Вторая сессия под тем же tmux: общий предок есть, но это не потомок ЭТОЙ сессии.
    500: { comm: 'claude', ppid: 100, cwd: '/path/to/app', cmdline: 'claude' },
    510: { comm: 'bash', ppid: 500, cwd: '/path/to/app', cmdline: 'bash' },
    // Боевые службы.
    600: { comm: 'caddy', ppid: 1, cwd: '/', cmdline: '/usr/bin/caddy run' },
    610: { comm: 'docker-proxy', ppid: 620, cwd: '/', cmdline: 'docker-proxy -host-port 3200' },
    620: { comm: 'dockerd', ppid: 1, cwd: '/', cmdline: 'dockerd' },
    630: { comm: 'privoxy', ppid: 1, cwd: '/', cmdline: 'privoxy' },
    // Цикл родства — битая таблица не должна вешать хук.
    900: { comm: 'a', ppid: 901, cwd: '/', cmdline: 'a' },
    901: { comm: 'b', ppid: 900, cwd: '/', cmdline: 'b' },
};
const withTable = (table: TTable, selfPid = 320) => {
    const processInfo = (pid: number) => table[pid] ?? null;
    return (command: string) =>
        decide('Bash', { command }, { processInfo, selfPid, sessionCwd: SESSION_CWD });
};
const bash = withTable(TABLE);

describe('kill по подстановке и по списку слушателей — запрещён (#196)', () => {
    // Команда инцидента: `kill` получил КАЖДЫЙ слушающий pid хоста — Caddy, docker-proxy
    // портов прода, privoxy, tailscaled; прод лежал ~14 минут.
    it.each([
        'for p in $(ss -lntp | grep -oP "(?<=pid=)\\d+" | sort -u); do ss -lntp | grep -q ":3130" && kill $p; done',
        // Та же форма без `&&`: до правки разбора `do` читался именем команды, и `kill`
        // в списке вызовов не появлялся вовсе (ревью #196, blocker).
        'for p in $(ss -lntp | grep -oP "(?<=pid=)\\d+"); do kill $p; done',
        'while read p; do kill $p; done < pids.txt',
        'PID=$(lsof -ti:3130); if [ -n "$PID" ]; then kill $PID; fi',
        'if ! kill $p; then echo dead; fi',
        'kill $p',
        'kill ${pid}',
        'kill -9 $(lsof -ti:3130)',
        'kill `cat server.pid`',
        'kill "$p"',
        'lsof -ti:3130 | xargs kill -9',
        'pgrep -f next | xargs kill',
        'xargs kill < pids.txt',
        'kill', // цель не названа вовсе — под xargs выглядит ровно так.
        'kill -9 $p $q',
        'sudo kill $p', // обёртка — не другое действие.
        "bash -c 'kill $p'", // вложенная оболочка исполняет то же самое.
        "sh -c 'for p in 600; do kill $p; done'",
    ])('%s → заблокирован', (command) => {
        const decision = bash(command);
        expect(decision.blocked).toBe(true);
        expect(decision.reason).toMatch(/pid/i);
    });

    it('объясняет безопасный приём — pid, запомненный при запуске', () => {
        const decision = bash('kill $p');
        expect(decision.reason).toMatch(/\$!/);
        expect(decision.reason).toMatch(/слушател/i);
    });

    it('называет класс цели, а не артефакт разбора', () => {
        expect(bash('kill $(lsof -ti:3130)').reason).toMatch(/подстановка/);
        expect(bash('kill `cat s.pid`').reason).toMatch(/подстановка/);
        expect(bash('kill `cat s.pid`').reason).not.toMatch(/«_+»/);
    });

    it('`$!` и номер задания — свой процесс этой же оболочки, разрешены', () => {
        expect(bash('npx next dev -p 3130 & sleep 5; kill $!').blocked).toBe(false);
        expect(bash('kill %1').blocked).toBe(false);
    });

    it('список сигналов и сигнал 0 (проверка «жив ли») — не убийство', () => {
        expect(bash('kill -l').blocked).toBe(false);
        expect(bash('kill -L').blocked).toBe(false);
        expect(bash('kill -0 600').blocked).toBe(false);
        expect(bash('kill -s 0 600').blocked).toBe(false);
        expect(bash('kill --signal=0 600').blocked).toBe(false);
        expect(bash('if kill -0 $p; then echo alive; fi').blocked).toBe(false);
    });

    it('процесс-группа и «все процессы» закрыты наравне с подстановкой', () => {
        expect(bash('kill -- -1').blocked).toBe(true);
        expect(bash('kill -9 -- -400').blocked).toBe(true);
        expect(bash('kill 0').blocked).toBe(true);
    });

    it('`--` отделяет цели, а не прячет их', () => {
        expect(bash('kill -- 400').blocked).toBe(false);
        expect(bash('kill -9 -- 600').blocked).toBe(true);
    });

    it('упоминание в тексте — не вызов', () => {
        expect(bash('git log --grep "kill $p"').blocked).toBe(false);
        expect(bash("echo 'kill $p'").blocked).toBe(false);
    });
});

describe('ключевые слова оболочки прозрачны для всех правил (#196)', () => {
    // Дыра была шире kill: `do rm -rf …` тоже проходил. Тот же разбор — тот же кейс.
    it('рекурсивное удаление внутри цикла ловится', () => {
        expect(bash('for f in a; do rm -rf /var/lib; done').blocked).toBe(true);
        expect(bash('if true; then rm -rf /var/lib; fi').blocked).toBe(true);
    });

    it('`for`/`case` не считаются обёрткой — слово после них не команда', () => {
        expect(bash('for kill in a b; do echo $kill; done').blocked).toBe(false);
    });
});

describe('kill по литеральному pid — только свой процесс (#196)', () => {
    it('потомок сессии — разрешён, с любым сигналом', () => {
        expect(bash('kill 400').blocked).toBe(false);
        expect(bash('kill -9 400').blocked).toBe(false);
        expect(bash('kill -s TERM 400').blocked).toBe(false);
        expect(bash('kill -TERM 400 310').blocked).toBe(false);
    });

    it('dev-сервер или тест-раннер в дереве сессии — разрешён и после переусыновления', () => {
        expect(bash('kill 410').blocked).toBe(false);
    });

    it('тот же next в чужом дереве — запрещён', () => {
        const decision = bash('kill 420');
        expect(decision.blocked).toBe(true);
        expect(decision.reason).toMatch(/420/);
    });

    it('чужой процесс в дереве сессии, но не инструмент — запрещён', () => {
        const decision = bash('kill 430');
        expect(decision.blocked).toBe(true);
        expect(decision.reason).toMatch(/python3/);
    });

    it.each([
        [600, /caddy/],
        [610, /docker-proxy/],
        [630, /privoxy/],
    ])('боевой pid %s — отказ называет процесс', (pid, name) => {
        const decision = bash(`kill ${pid}`);
        expect(decision.blocked).toBe(true);
        expect(decision.reason).toMatch(name);
        expect(decision.reason).toMatch(new RegExp(String(pid)));
    });

    it('один чужой pid в списке красит весь вызов', () => {
        expect(bash('kill 400 600').blocked).toBe(true);
    });

    it('соседняя сессия под тем же tmux — не потомок этой', () => {
        expect(bash('kill 510').blocked).toBe(true);
        expect(bash('kill 500').blocked).toBe(true);
    });

    it('предки сессии — сама сессия, раннер, tmux, init — своими не бывают', () => {
        for (const pid of [300, 200, 100, 1]) {
            const decision = bash(`kill ${pid}`);
            expect(decision.blocked, `kill ${pid}`).toBe(true);
            expect(decision.reason).toMatch(/предок/);
        }
    });

    it('цикл родства в таблице — отказ, а не зависание', () => {
        expect(bash('kill 900').blocked).toBe(true);
    });

    it('несуществующий pid — убивать нечего, отказ не нужен', () => {
        expect(bash('kill 999999').blocked).toBe(false);
    });

    it('без предка `claude` граница сессии — родитель хука, а не общий предок', () => {
        const noClaude: TTable = {
            1: INIT,
            100: TMUX,
            310: { comm: 'bash', ppid: 100, cwd: '/tmp', cmdline: 'bash' },
            320: { comm: 'node', ppid: 310, cwd: '/tmp', cmdline: 'node guard.cjs' },
            330: { comm: 'sleep', ppid: 310, cwd: '/tmp', cmdline: 'sleep 5' }, // брат хука
            510: { comm: 'bash', ppid: 100, cwd: '/tmp', cmdline: 'bash' }, // под общим tmux
        };
        const run = withTable(noClaude);
        expect(run('kill 330').blocked).toBe(false);
        expect(run('kill 510').blocked).toBe(true);
    });

    it('таблица процессов не читается на своём pid — fail-closed с объяснением', () => {
        const decision = decide(
            'Bash',
            { command: 'kill 400' },
            {
                processInfo: () => {
                    throw new Error('EACCES');
                },
                selfPid: 320,
                sessionCwd: SESSION_CWD,
            },
        );
        expect(decision.blocked).toBe(true);
        expect(decision.reason).toMatch(/EACCES/);
    });

    it('таблица не читается только на ЦЕЛИ — тоже отказ, а не «свой»', () => {
        const decision = decide(
            'Bash',
            { command: 'kill 600' },
            {
                processInfo: (pid: number) => {
                    if (pid === 600) throw new Error('EPERM');
                    return TABLE[pid] ?? null;
                },
                selfPid: 320,
                sessionCwd: SESSION_CWD,
            },
        );
        expect(decision.blocked).toBe(true);
        expect(decision.reason).toMatch(/EPERM/);
    });
});

describe('убийство по имени и по порту — запрещено целиком (#196)', () => {
    it.each([...PATTERN_KILLERS])('%s по любому имени заблокирован', (killer: string) => {
        expect(bash(`${killer} -f my-scratch-server`).blocked).toBe(true);
        expect(bash(`${killer} node`).blocked).toBe(true);
    });

    // Литералы рядом с перечнем: удаление имени из перечня иначе уносило бы и кейс.
    it('pkill, killall и kill-port через npx закрыты', () => {
        expect(bash("pkill -9 -f 'next dev'").blocked).toBe(true);
        expect(bash('killall node').blocked).toBe(true);
        expect(bash('npx kill-port 3130').blocked).toBe(true);
        expect(bash('npx --yes kill-port 3130').blocked).toBe(true);
        expect(bash('busybox kill 600').blocked).toBe(true);
    });

    it.each([...PORT_KILLERS])('%s -k по порту заблокирован', (killer: string) => {
        expect(bash(`${killer} -k 3130/tcp`).blocked).toBe(true);
        expect(bash(`${killer} -km 3130/tcp`).blocked).toBe(true);
        expect(bash(`${killer} --kill 3130/tcp`).blocked).toBe(true);
        // Без `-k` он только показывает, кто держит порт.
        expect(bash(`${killer} 3130/tcp`).blocked).toBe(false);
    });

    it('отказ называет замену — pid, запомненный при запуске', () => {
        expect(bash('pkill -f next').reason).toMatch(/\$!/);
        expect(bash('fuser -k 3130/tcp').reason).toMatch(/\$!/);
    });
});

describe('чтение /proc той же формы, что у ядра (#196)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'guard-proc-'));
    mkdirSync(path.join(root, '42'));
    writeFileSync(
        path.join(root, '42', 'status'),
        'Name:\tnext-server\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t42\nPPid:\t7\n',
    );
    writeFileSync(path.join(root, '42', 'cmdline'), 'node\0next\0dev\0-p\x003130\0');
    symlinkSync(SESSION_CWD, path.join(root, '42', 'cwd'));

    it('разбирает имя, родителя, каталог и командную строку', () => {
        expect(readProcessInfo(42, root)).toEqual({
            comm: 'next-server',
            ppid: 7,
            cwd: SESSION_CWD,
            cmdline: 'node next dev -p 3130',
        });
    });

    it('процесса нет — null, а не исключение', () => {
        expect(readProcessInfo(43, root)).toBeNull();
    });

    it('хук без подмены видит свой собственный процесс своим', () => {
        // Процесс теста — заведомо потомок того, кто его запустил, на хосте и в кубе.
        expect(decide('Bash', { command: `kill ${process.pid}` }).blocked).toBe(false);
    });
});

// Правило названо в общем промпте сессии, иначе сессия уверенно зовёт запрещённое и
// получает необъяснённый отказ. У потребителя сверялся ещё и проектный промпт; у канона
// своего проектного промпта в дереве нет (он принадлежит потребителю и гитигнорен).
describe('правило про kill названо в общем промпте сессии (#196)', () => {
    const GENERAL = readFileSync(path.join(import.meta.dirname, '..', '..', 'ralph.md'), 'utf-8');

    it('общий промпт называет приём с `$!` и запрет списка слушателей', () => {
        expect(GENERAL).toContain('$!');
        expect(GENERAL).toMatch(/литеральному pid/);
    });
});

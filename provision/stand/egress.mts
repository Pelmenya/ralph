/**
 * Сеть стенда живых проб (Фаза 16c, задача 182): внутри — только loopback, наружу — только
 * адрес провайдера модели выбранного CLI.
 *
 * Как. Стенд идёт в своём сетевом namespace, где нет ничего, кроме loopback. Наружу ведёт
 * один канал: прокси СНАРУЖИ слушает unix-сокет в каталоге стенда и принимает только
 * `CONNECT` к адресам из списка; ВНУТРИ мост слушает `127.0.0.1` и перекладывает байты в тот
 * сокет, а CLI получает `HTTPS_PROXY` на мост. Сокет в каталоге стенда — единственное, что
 * соединяет два namespace, и он знает ровно один протокол.
 *
 * Почему не «сеть хоста и правила фаервола». Правило фаервола — общий ресурс хоста, на
 * котором крутится прод; ошибка в нём роняет соседей, а не пробу. Namespace без интерфейсов
 * закрыт по построению, и открыт в нём только этот прокси.
 *
 * Проксируется только `CONNECT` (TLS до провайдера идёт насквозь): незашифрованный HTTP
 * провайдеру модели не нужен, а разбирать его значило бы держать второй протокол. Отказ —
 * `403` с адресом и строка в журнале прокси: попытка выйти за пределы — свидетельство, а не
 * только ошибка в выводе CLI.
 *
 * Upstream-прокси хоста (задача 214). Хост, который ходит к провайдеру только через свой
 * прокси, на прямое соединение получает от провайдера отказ (замер: 403 и прямым запросом с
 * хоста, и через стенд). Поэтому прокси стенда умеет вторым звеном слать `CONNECT` к цели
 * через прокси хоста. Порядок не меняется: список проверяется ДО любого соединения, и чужой
 * адрес до upstream не доходит вовсе — upstream не должен узнавать даже имя, которое стенд
 * отверг. Адрес upstream задаётся явно — флаг называет переменную (`--upstream-env <ИМЯ>`),
 * а не берётся молча из `HTTPS_PROXY` окружения: прокси выхода, поменявший маршрут от
 * переменной, которую никто не называл, — не тот канал, который проверяли. Переменная, а не
 * сам адрес в argv: командную строку процесса читает любой пользователь хоста (`ps`), а
 * окружение — только владелец. Креды из адреса едут заголовком и не пишутся ни в журнал, ни
 * в текст ошибки.
 *
 * Журнал прокси лежит в каталоге стенда, а этот каталог пишется изнутри. Прокси же работает
 * снаружи с правами человека: открой он журнал по имени на каждой записи, процесс внутри
 * подменил бы файл симлинком на файл человека, и строка о чужом адресе легла бы туда — запись
 * вне стенда в обход EROFS. Поэтому журнал открывается ОДИН раз до старта, без следования
 * симлинку (`openJournal`), и пишется по дескриптору.
 *
 * ЗАПУСК:
 *   node egress.mts proxy <сокет> <журнал> [--upstream-env <ИМЯ>] <host:port>…
 *                                                            — снаружи стенда
 *   node egress.mts bridge <сокет> <порт> -- <команда…>       — внутри: мост, затем команда
 */
import { closeSync, constants as fsc, fstatSync, openSync, writeSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { constants as osc } from 'node:os';

/**
 * Код выхода по исходу дочернего процесса: смерть от сигнала — `128 + номер`, как у оболочки.
 * Голые 128 стирали, каким сигналом убит CLI, а это первое, что спрашивают о зависшей пробе.
 */
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
    if (code !== null) return code;
    if (signal) return 128 + (osc.signals[signal] ?? 0);
    return 1;
}

/**
 * Журнал на запись по дескриптору: `O_NOFOLLOW` — симлинк на месте журнала даёт отказ, а не
 * запись в его цель; не обычный файл (FIFO, устройство) — тоже отказ. Дальше пишется только
 * дескриптор: подмена имени после открытия уводит изнутри лишь имя, а не запись прокси.
 */
export function openJournal(path: string): {
    write: (entry: Record<string, unknown>) => void;
    close: () => void;
} {
    const fd = openSync(
        path,
        fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK,
        0o600,
    );
    if (!fstatSync(fd).isFile()) {
        closeSync(fd);
        throw new Error(`egress: журнал не обычный файл: ${path}`);
    }
    return {
        write: (e) => {
            writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
        },
        close: () => closeSync(fd),
    };
}

/** Адрес прокси без кредов — для текста ошибок, который печатается и попадает в отчёт. */
export function redactProxyUrl(raw: string): string {
    return raw.replace(/\/\/[^/@]*@/, '//***@');
}

/** `host:port` из строки `CONNECT host:port HTTP/1.x`; всё иное — `null`. */
export function parseConnect(head: string): { host: string; port: number } | null {
    const m = /^CONNECT ([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5}) HTTP\/1\.[01]\r?$/.exec(
        head.split('\n')[0] ?? '',
    );
    if (!m) return null;
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return null;
    return { host: m[1].toLowerCase(), port };
}

/** Разрешён ли адрес: точное совпадение `host:port`, без шаблонов и поддоменов. */
export function isAllowed(allow: readonly string[], host: string, port: number): boolean {
    return allow.map((a) => a.toLowerCase()).includes(`${host}:${port}`);
}

/** Прокси хоста, через который стенд выходит к провайдеру. */
export type TUpstreamProxy = { host: string; port: number; auth: string | null };

/**
 * Адрес upstream: только `http://[user:pass@]host[:port]` без пути. Иная схема — отказ, а не
 * «попробую как есть»: SOCKS или TLS до прокси этот модуль не говорит, и тихий прямой выход
 * вместо цепочки был бы ровно тем симптомом, ради которого параметр заведён.
 */
export function parseUpstreamProxy(raw: string): TUpstreamProxy {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error(`egress: upstream не адрес: ${redactProxyUrl(raw)}`);
    }
    if (u.protocol !== 'http:')
        throw new Error(`egress: upstream только http:, а не ${u.protocol}`);
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash)
        throw new Error('egress: у upstream не бывает пути');
    const auth =
        u.username || u.password
            ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`
            : null;
    // `URL.hostname` у IPv6 — в скобках (`[::1]`), а `createConnection` скобок не понимает:
    // без снятия каждый CONNECT через такой upstream кончался бы 502.
    const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
    return { host, port: u.port ? Number(u.port) : 80, auth };
}

/**
 * Адрес upstream из переменной, которую назвали явно. Нет переменной — отказ: молча пойти
 * напрямую значило бы проверять не тот маршрут.
 */
export function upstreamFromEnv(
    name: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (!name) throw new Error('egress: у --upstream-env нет имени переменной');
    const v = env[name];
    if (!v) throw new Error(`egress: переменная ${name} для upstream не задана`);
    return v;
}

type TProxyDeps = {
    connectFn?: (port: number, host: string) => Socket;
    journalFn?: (entry: Record<string, unknown>) => void;
    upstream?: TUpstreamProxy;
};

/**
 * Прокси снаружи стенда. Пустой список — отказ старта: прокси, который никого не пускает,
 * выглядит как «сеть закрыта», но тогда он не нужен, а пустой список чаще значит, что адрес
 * провайдера не дошёл.
 */
export function startEgressProxy(
    socketPath: string,
    allow: readonly string[],
    deps: TProxyDeps = {},
): Server {
    if (allow.length === 0) throw new Error('egress: пустой список адресов провайдера');
    for (const a of allow) {
        if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(a))
            throw new Error(`egress: адрес не host:port: ${a}`);
    }
    const connectFn = deps.connectFn ?? ((port, host) => createConnection(port, host));
    const journalFn = deps.journalFn ?? (() => {});
    const server = createServer((client) => {
        let buf = '';
        const onData = (chunk: Buffer) => {
            buf += chunk.toString('latin1');
            const end = buf.indexOf('\r\n\r\n');
            if (end < 0) {
                if (buf.length > 8192) client.destroy();
                return;
            }
            // Снятый слушатель поток не останавливает: байты, пришедшие после заголовка и
            // до ответа upstream, ушли бы в пустоту (TLS ClientHello клиента, который не
            // ждёт 200). Пауза держит их в буфере сокета до `open`.
            client.off('data', onData);
            client.pause();
            const target = parseConnect(buf.slice(0, end));
            if (!target) {
                journalFn({ verdict: 'deny', reason: 'not-connect', head: buf.split('\r\n')[0] });
                client.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
                return;
            }
            if (!isAllowed(allow, target.host, target.port)) {
                journalFn({
                    verdict: 'deny',
                    reason: 'not-allowed',
                    target: `${target.host}:${target.port}`,
                });
                client.end(
                    `HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nralph-stand: ${target.host}:${target.port} не в списке провайдера\n`,
                );
                return;
            }
            const dest = `${target.host}:${target.port}`;
            const via = deps.upstream;
            journalFn(
                via
                    ? { verdict: 'allow', target: dest, via: 'upstream' }
                    : { verdict: 'allow', target: dest },
            );
            const rest = Buffer.from(buf.slice(end + 4), 'latin1');
            const upstream = via
                ? connectFn(via.port, via.host)
                : connectFn(target.port, target.host);
            const badGateway = () => {
                if (!client.destroyed)
                    client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
                upstream.destroy();
            };
            // После 200 канал — чужой TLS: ответ 502 посреди него клиент прочёл бы как
            // мусор в записи TLS. Сбой upstream с этого момента только рвёт соединение.
            const open = (tail: Buffer) => {
                upstream.off('error', badGateway);
                upstream.on('error', () => client.destroy());
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (tail.length) client.write(tail);
                if (rest.length) upstream.write(rest);
                client.pipe(upstream);
                upstream.pipe(client);
                client.resume();
            };
            upstream.once('connect', () => {
                if (!via) return open(Buffer.alloc(0));
                upstream.write(
                    `CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n` +
                        (via.auth ? `Proxy-Authorization: ${via.auth}\r\n` : '') +
                        '\r\n',
                );
                let head = Buffer.alloc(0);
                const onHead = (chunk: Buffer) => {
                    head = Buffer.concat([head, chunk]);
                    const e = head.indexOf('\r\n\r\n');
                    if (e < 0) {
                        if (head.length > 8192) badGateway();
                        return;
                    }
                    upstream.off('data', onHead);
                    const status = head.subarray(0, e).toString('latin1').split('\r\n')[0];
                    if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
                        journalFn({ verdict: 'upstream-refused', target: dest, status });
                        return badGateway();
                    }
                    open(head.subarray(e + 4));
                };
                upstream.on('data', onHead);
            });
            upstream.on('error', badGateway);
            client.on('error', () => upstream.destroy());
        };
        client.on('data', onData);
        client.on('error', () => {});
    });
    server.listen(socketPath);
    return server;
}

/** Мост внутри стенда: `127.0.0.1:<port>` → unix-сокет прокси. */
export function startBridge(socketPath: string, port: number): Server {
    const server = createServer((client) => {
        const upstream = createConnection(socketPath);
        client.pipe(upstream);
        upstream.pipe(client);
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });
    server.listen(port, '127.0.0.1');
    return server;
}

if (import.meta.main) {
    const [mode, sock, third, ...rest] = process.argv.slice(2);
    if (mode === 'proxy' && sock && third) {
        let upstream: TUpstreamProxy | undefined;
        try {
            const name = rest[0] === '--upstream-env' ? rest.splice(0, 2)[1] : undefined;
            if (name !== undefined) upstream = parseUpstreamProxy(upstreamFromEnv(name));
        } catch (e) {
            process.stderr.write(`${(e as Error).message}\n`);
            process.exit(2);
        }
        startEgressProxy(sock, rest, {
            ...(upstream ? { upstream } : {}),
            journalFn: openJournal(third).write,
        });
    } else if (mode === 'bridge' && sock && third && rest[0] === '--' && rest.length > 1) {
        const bridge = startBridge(sock, Number(third));
        bridge.once('listening', () => {
            const child = spawn(rest[1], rest.slice(2), { stdio: 'inherit' });
            child.on('exit', (code, signal) => process.exit(exitCodeOf(code, signal)));
            child.on('error', (e) => {
                process.stderr.write(`egress: команда не запустилась: ${e.message}\n`);
                process.exit(127);
            });
        });
    } else {
        process.stderr.write(
            'egress: proxy <сокет> <журнал> [--upstream-env <ИМЯ>] <host:port>… | bridge <сокет> <порт> -- <команда…>\n',
        );
        process.exit(2);
    }
}

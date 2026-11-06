import { afterEach, describe, expect, it } from 'vitest';
import { createConnection, createServer, type Server } from 'node:net';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    exitCodeOf,
    isAllowed,
    openJournal,
    parseConnect,
    parseUpstreamProxy,
    redactProxyUrl,
    startBridge,
    startEgressProxy,
    startTcpForward,
    upstreamFromEnv,
} from './egress.mts';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const c of cleanups.splice(0)) c();
});

function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ralph-egress.'));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
}

function listening(s: Server): Promise<void> {
    cleanups.push(() => s.close());
    return new Promise((res) => (s.listening ? res() : s.once('listening', () => res())));
}

/** Одна строка запроса через сокет; ответ целиком до закрытия или до первого куска. */
function ask(
    target: { path: string } | { port: number; host: string },
    payload: string,
): Promise<string> {
    return new Promise((res, rej) => {
        const c = createConnection(target as any);
        let out = '';
        c.on('data', (d) => {
            out += d.toString();
            if (out.includes('pong')) c.end();
        });
        c.on('end', () => res(out));
        c.on('error', rej);
        c.write(payload);
    });
}

describe('прокси выхода стенда', () => {
    it('CONNECT разбирается только целиком; адрес — точное совпадение host:port', () => {
        expect(parseConnect('CONNECT api.example.com:443 HTTP/1.1\r')).toEqual({
            host: 'api.example.com',
            port: 443,
        });
        expect(parseConnect('GET http://api.example.com/ HTTP/1.1')).toBeNull();
        expect(parseConnect('CONNECT api.example.com:99999 HTTP/1.1')).toBeNull();
        expect(isAllowed(['API.example.com:443'], 'api.example.com', 443)).toBe(true);
        expect(isAllowed(['api.example.com:443'], 'evil.api.example.com', 443)).toBe(false);
        expect(isAllowed(['api.example.com:443'], 'api.example.com', 80)).toBe(false);
    });

    it('пустой или кривой список адресов — отказ старта, а не «никого не пускаю»', () => {
        expect(() => startEgressProxy(join(tmp(), 's'), [])).toThrow(/пустой список/);
        expect(() => startEgressProxy(join(tmp(), 's'), ['https://x'])).toThrow(/host:port/);
    });

    it('чужой адрес — 403 и запись в журнал; разрешённый — туннель до провайдера', async () => {
        const upstream = createServer((s) => s.on('data', () => s.end('pong')));
        upstream.listen(0, '127.0.0.1');
        await listening(upstream);
        const upPort = (upstream.address() as any).port;
        const sock = join(tmp(), 'egress.sock');
        const journal: any[] = [];
        const connected: string[] = [];
        const proxy = startEgressProxy(sock, ['provider.example.com:443'], {
            journalFn: (e) => journal.push(e),
            connectFn: (port, host) => {
                connected.push(`${host}:${port}`);
                return createConnection(upPort, '127.0.0.1');
            },
        });
        await listening(proxy);

        const denied = await ask({ path: sock }, 'CONNECT other.example.com:443 HTTP/1.1\r\n\r\n');
        expect(denied).toMatch(/^HTTP\/1\.1 403/);
        const plain = await ask(
            { path: sock },
            'GET http://provider.example.com/ HTTP/1.1\r\n\r\n',
        );
        expect(plain).toMatch(/^HTTP\/1\.1 405/);
        const ok = await ask(
            { path: sock },
            'CONNECT provider.example.com:443 HTTP/1.1\r\n\r\nping',
        );
        expect(ok).toMatch(/^HTTP\/1\.1 200[^]*pong$/);

        expect(connected).toEqual(['provider.example.com:443']);
        expect(journal).toEqual([
            { verdict: 'deny', reason: 'not-allowed', target: 'other.example.com:443' },
            {
                verdict: 'deny',
                reason: 'not-connect',
                head: 'GET http://provider.example.com/ HTTP/1.1',
            },
            { verdict: 'allow', target: 'provider.example.com:443' },
        ]);
    });

    it('TCP к внешнему фиктивному провайдеру перекладывает байты без HTTP CONNECT', async () => {
        const upstream = createServer((s) => s.on('data', () => s.end('pong')));
        upstream.listen(0, '127.0.0.1');
        await listening(upstream);
        const upPort = (upstream.address() as any).port;
        const sock = join(tmp(), 'tcp.sock');
        const proxy = startTcpForward(sock, { host: '127.0.0.1', port: upPort });
        await listening(proxy);
        expect(await ask({ path: sock }, 'ping')).toBe('pong');
    });

    it('upstream-прокси: адрес http://host:port, креды — заголовком, иное — отказ', () => {
        expect(parseUpstreamProxy('http://proxy.example.com:3128')).toEqual({
            host: 'proxy.example.com',
            port: 3128,
            auth: null,
        });
        expect(parseUpstreamProxy('http://u%40x:p@127.0.0.1:8118/')).toEqual({
            host: '127.0.0.1',
            port: 8118,
            auth: `Basic ${Buffer.from('u@x:p').toString('base64')}`,
        });
        expect(parseUpstreamProxy('http://proxy.example.com')).toEqual({
            host: 'proxy.example.com',
            port: 80,
            auth: null,
        });
        expect(() => parseUpstreamProxy('socks5://proxy.example.com:1080')).toThrow(/http:/);
        expect(() => parseUpstreamProxy('http://proxy.example.com:1/path')).toThrow(/пути/);
        expect(() => parseUpstreamProxy('не адрес')).toThrow(/upstream/);
    });

    it('IPv6 upstream — адрес без скобок: `createConnection` скобок не понимает', () => {
        expect(parseUpstreamProxy('http://[::1]:3128')).toEqual({
            host: '::1',
            port: 3128,
            auth: null,
        });
    });

    it('креды upstream не попадают в текст ошибки', () => {
        expect(redactProxyUrl('http://u:secret@proxy.example.com:1')).toBe(
            'http://***@proxy.example.com:1',
        );
        let msg = '';
        try {
            parseUpstreamProxy('http://u:secret@[bad');
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toMatch(/upstream не адрес/);
        expect(msg).not.toContain('secret');
    });

    it('адрес upstream — из названной переменной; нет имени или переменной — отказ', () => {
        expect(upstreamFromEnv('UP', { UP: 'http://proxy.example.com:1' })).toBe(
            'http://proxy.example.com:1',
        );
        expect(() => upstreamFromEnv('UP', {})).toThrow(/UP для upstream не задана/);
        expect(() => upstreamFromEnv(undefined, {})).toThrow(/нет имени/);
    });

    it('смерть дочернего от сигнала — 128 + номер сигнала, а не голые 128', () => {
        expect(exitCodeOf(3, null)).toBe(3);
        expect(exitCodeOf(null, 'SIGKILL')).toBe(137);
        expect(exitCodeOf(null, 'SIGTERM')).toBe(143);
        expect(exitCodeOf(null, null)).toBe(1);
    });

    describe('журнал прокси', () => {
        it('симлинк на месте журнала — отказ открытия, цель не тронута', () => {
            const d = tmp();
            const human = join(d, 'human-file');
            writeFileSync(human, 'human\n');
            symlinkSync(human, join(d, 'egress.jsonl'));
            expect(() => openJournal(join(d, 'egress.jsonl'))).toThrow(/ELOOP/);
            expect(readFileSync(human, 'utf-8')).toBe('human\n');
        });

        it('подмена имени после открытия уводит имя, а не запись: цель симлинка не тронута', () => {
            const d = tmp();
            const human = join(d, 'human-file');
            writeFileSync(human, 'human\n');
            const path = join(d, 'egress.jsonl');
            const j = openJournal(path);
            cleanups.push(() => j.close());
            j.write({ verdict: 'allow', target: 'a:1' });
            renameSync(path, join(d, 'moved.jsonl'));
            symlinkSync(human, path);
            j.write({ verdict: 'deny', reason: 'not-allowed', target: 'b:2' });
            expect(readFileSync(human, 'utf-8')).toBe('human\n');
            const lines = readFileSync(join(d, 'moved.jsonl'), 'utf-8').trim().split('\n');
            expect(lines.map((l) => JSON.parse(l).target)).toEqual(['a:1', 'b:2']);
        });

        it('не обычный файл на месте журнала — отказ', () => {
            const d = tmp();
            expect(() => openJournal(d)).toThrow();
            expect(existsSync(join(d, 'x'))).toBe(false);
        });
    });

    describe('через upstream-прокси хоста', () => {
        /** Подставной прокси хоста: пишет строки CONNECT, отвечает `status`, затем эхо `pong`. */
        async function fakeUpstream(status = '200 Connection established') {
            const heads: string[] = [];
            const srv = createServer((s) => {
                let buf = '';
                let open = false;
                s.on('data', (d) => {
                    if (open) return void s.end('pong');
                    buf += d.toString('latin1');
                    const end = buf.indexOf('\r\n\r\n');
                    if (end < 0) return;
                    heads.push(buf.slice(0, end));
                    if (!status.startsWith('200')) return void s.end(`HTTP/1.1 ${status}\r\n\r\n`);
                    open = true;
                    s.write(`HTTP/1.1 ${status}\r\nX-Extra: 1\r\n\r\n`);
                    if (buf.length > end + 4) s.end('pong');
                });
            });
            srv.listen(0, '127.0.0.1');
            await listening(srv);
            return { heads, port: (srv.address() as any).port as number };
        }

        it('разрешённый — CONNECT через upstream; чужой — 403 без обращения к upstream', async () => {
            const up = await fakeUpstream();
            const sock = join(tmp(), 'egress.sock');
            const journal: any[] = [];
            const connected: string[] = [];
            const proxy = startEgressProxy(sock, ['provider.example.com:443'], {
                journalFn: (e) => journal.push(e),
                upstream: { host: '127.0.0.1', port: up.port, auth: 'Basic dTpw' },
                connectFn: (port, host) => {
                    connected.push(`${host}:${port}`);
                    return createConnection(port, host);
                },
            });
            await listening(proxy);

            const denied = await ask(
                { path: sock },
                'CONNECT other.example.com:443 HTTP/1.1\r\n\r\n',
            );
            expect(denied).toMatch(/^HTTP\/1\.1 403/);
            expect(up.heads).toEqual([]);
            expect(connected).toEqual([]);

            const ok = await ask(
                { path: sock },
                'CONNECT provider.example.com:443 HTTP/1.1\r\n\r\nping',
            );
            expect(ok).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\npong$/);
            expect(connected).toEqual([`127.0.0.1:${up.port}`]);
            expect(up.heads).toEqual([
                'CONNECT provider.example.com:443 HTTP/1.1\r\n' +
                    'Host: provider.example.com:443\r\n' +
                    'Proxy-Authorization: Basic dTpw',
            ]);
            expect(journal).toEqual([
                { verdict: 'deny', reason: 'not-allowed', target: 'other.example.com:443' },
                { verdict: 'allow', target: 'provider.example.com:443', via: 'upstream' },
            ]);
        });

        it('отказ upstream — 502 клиенту и статус upstream в журнале', async () => {
            const up = await fakeUpstream('407 Proxy Authentication Required');
            const sock = join(tmp(), 'egress.sock');
            const journal: any[] = [];
            const proxy = startEgressProxy(sock, ['provider.example.com:443'], {
                journalFn: (e) => journal.push(e),
                upstream: { host: '127.0.0.1', port: up.port, auth: null },
            });
            await listening(proxy);
            const r = await ask(
                { path: sock },
                'CONNECT provider.example.com:443 HTTP/1.1\r\n\r\n',
            );
            expect(r).toMatch(/^HTTP\/1\.1 502/);
            expect(up.heads).toEqual([
                'CONNECT provider.example.com:443 HTTP/1.1\r\nHost: provider.example.com:443',
            ]);
            expect(journal).toContainEqual({
                verdict: 'upstream-refused',
                target: 'provider.example.com:443',
                status: 'HTTP/1.1 407 Proxy Authentication Required',
            });
        });

        it('upstream недоступен — 502', async () => {
            const dead = createServer();
            await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
            const port = (dead.address() as any).port;
            await new Promise((r) => dead.close(r));
            const sock = join(tmp(), 'egress.sock');
            const proxy = startEgressProxy(sock, ['provider.example.com:443'], {
                upstream: { host: '127.0.0.1', port, auth: null },
            });
            await listening(proxy);
            const r = await ask(
                { path: sock },
                'CONNECT provider.example.com:443 HTTP/1.1\r\n\r\n',
            );
            expect(r).toMatch(/^HTTP\/1\.1 502/);
        });
    });

    it('байты клиента между заголовком CONNECT и ответом upstream доходят до цели', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let headSeen!: () => void;
        const seen = new Promise<void>((r) => (headSeen = r));
        const got: string[] = [];
        const srv = createServer((s) => {
            let buf = '';
            let open = false;
            s.on('data', (d) => {
                if (open) {
                    got.push(d.toString());
                    return void s.end('pong');
                }
                buf += d.toString('latin1');
                if (!buf.includes('\r\n\r\n')) return;
                open = true;
                headSeen();
                void gate.then(() => s.write('HTTP/1.1 200 OK\r\n\r\n'));
            });
        });
        srv.listen(0, '127.0.0.1');
        await listening(srv);
        const sock = join(tmp(), 'egress.sock');
        const proxy = startEgressProxy(sock, ['provider.example.com:443'], {
            upstream: { host: '127.0.0.1', port: (srv.address() as any).port, auth: null },
        });
        await listening(proxy);
        const c = createConnection(sock);
        let out = '';
        const done = new Promise<string>((res, rej) => {
            c.on('data', (d) => {
                out += d.toString();
                if (out.includes('pong')) c.end();
            });
            c.on('end', () => res(out));
            c.on('error', rej);
        });
        c.write('CONNECT provider.example.com:443 HTTP/1.1\r\n\r\n');
        await seen;
        c.write('ping');
        await new Promise((r) => setTimeout(r, 50));
        release();
        expect(await done).toMatch(/^HTTP\/1\.1 200[^]*pong$/);
        expect(got).toEqual(['ping']);
    });

    it('сбой upstream посреди туннеля рвёт соединение, а не пишет 502 в чужой TLS', async () => {
        const srv = createServer((s) => {
            s.once('data', () => {
                s.write('HTTP/1.1 200 OK\r\n\r\ntls-bytes');
                setTimeout(() => s.resetAndDestroy(), 50);
            });
        });
        srv.listen(0, '127.0.0.1');
        await listening(srv);
        const sock = join(tmp(), 'egress.sock');
        const proxy = startEgressProxy(sock, ['provider.example.com:443'], {
            upstream: { host: '127.0.0.1', port: (srv.address() as any).port, auth: null },
        });
        await listening(proxy);
        const out = await new Promise<string>((res) => {
            const c = createConnection(sock);
            let o = '';
            c.on('data', (d) => (o += d.toString()));
            c.on('close', () => res(o));
            c.on('error', () => {});
            c.write('CONNECT provider.example.com:443 HTTP/1.1\r\n\r\n');
        });
        expect(out).toBe('HTTP/1.1 200 Connection Established\r\n\r\ntls-bytes');
    });

    it('мост с loopback ведёт в сокет прокси', async () => {
        const sock = join(tmp(), 'egress.sock');
        const proxyLike = createServer((s) => s.on('data', () => s.end('pong')));
        proxyLike.listen(sock);
        await listening(proxyLike);
        const bridge = startBridge(sock, 0);
        await listening(bridge);
        const port = (bridge.address() as any).port;
        expect(await ask({ port, host: '127.0.0.1' }, 'ping')).toBe('pong');
    });
});

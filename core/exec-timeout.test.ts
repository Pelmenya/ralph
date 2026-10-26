// Срок сетевого git (задача 30): политика запуска и сам механизм на НАСТОЯЩЕМ процессе.
//
// Политику (`execPolicy`) проверяют юниты: кто получает запрет промпта и срок, а кто нет.
// Но тест, видящий только заполненное поле `timeout`, подтвердил бы аккуратную опцию, а не
// срок: поэтому ниже `shArgv` гоняется живьём — против процесса, который не завершится сам,
// и против git, чей origin принял соединение и молчит. Предохранитель побочек здесь снят
// ЯВНО — своей фабрикой `createExec` с пустым guard'ом, без правки общего окружения: сеть
// только петлевая, процессы только свои, и оба гаснут в пределах теста.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createExec } from './exec.ts';
import {
    ExecTimeoutError,
    GIT_NETWORK_STALL_S,
    GIT_NETWORK_TIMEOUT_MS,
    execPolicy,
    gitNetworkOpts,
    isGitNetworkCall,
} from '../shared/ralph-util.ts';

describe('execPolicy: запрет промпта и срок — только сетевому git', () => {
    it.each([
        [['fetch', 'origin', 'main']],
        [['-C', '/path/to/app', 'fetch', 'origin', 'main', '--quiet']],
        [['-c', 'submodule.recurse=false', 'ls-remote', '--exit-code', 'origin', 'x']],
        [['push', 'origin', 'a:refs/heads/b']],
        [['--config-env', 'http.extraHeader=AUTH', 'fetch', 'origin']],
    ])('сетевой %j без опций получает и запрет, и срок', (args) => {
        const got = execPolicy('git', args, {});
        expect(got.timeoutMs).toBe(GIT_NETWORK_TIMEOUT_MS);
        expect(got.env?.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it.each([[['diff', '--name-only']], [['status', '--porcelain']], [['rev-parse', 'HEAD']]])(
        'локальный %j не получает ни срока, ни подмены окружения',
        (args) => {
            const env = { A: '1' };
            expect(execPolicy('git', args, { env })).toEqual({ env, timeoutMs: undefined });
        },
    );

    it('не-git с тем же argv — не сетевой git', () => {
        expect(isGitNetworkCall('echo', ['fetch'])).toBe(false);
        expect(execPolicy('echo', ['fetch'], {})).toEqual({ env: undefined, timeoutMs: undefined });
    });

    it('явный срок вызывающего уважается', () => {
        expect(execPolicy('git', ['fetch'], { timeoutMs: 5000 }).timeoutMs).toBe(5000);
    });

    it('credential helper не гасится: к окружению добавлены ровно три ключа', () => {
        const base = { GIT_ASKPASS: '/bin/helper', GH_TOKEN: 't', PATH: '/bin' };
        const { env } = gitNetworkOpts(base, 60_000);
        expect(env).toEqual({
            ...base,
            GIT_TERMINAL_PROMPT: '0',
            GIT_HTTP_LOW_SPEED_LIMIT: '1',
            GIT_HTTP_LOW_SPEED_TIME: '60',
        });
    });

    it('порог тишины ниже жёсткого срока: живая медленная передача сроком не рвётся', () => {
        const { env, timeoutMs } = gitNetworkOpts({});
        expect(env.GIT_HTTP_LOW_SPEED_TIME).toBe(String(GIT_NETWORK_STALL_S));
        expect(timeoutMs).toBeGreaterThan(GIT_NETWORK_STALL_S * 1000 * 5);
    });

    it('короткий явный срок укорачивает порог тишины до себя', () => {
        expect(gitNetworkOpts({}, 5_000).env.GIT_HTTP_LOW_SPEED_TIME).toBe('5');
    });

    it('порог низкой скорости пользователя не перекрывается', () => {
        const { env } = gitNetworkOpts({ GIT_HTTP_LOW_SPEED_TIME: '600' }, 60_000);
        expect(env.GIT_HTTP_LOW_SPEED_TIME).toBe('600');
    });
});

describe('shArgv: срок убивает настоящий зависший процесс и называется сроком', () => {
    const exec = () =>
        createExec({
            guardSideEffect: () => {},
            sleep: () => {},
            initialLogTarget: path.join(os.tmpdir(), 'ralph-exec-timeout-unused.log'),
        });

    it('процесс, который не завершится сам, убит по сроку', () => {
        const started = Date.now();
        let err: unknown;
        try {
            exec().shArgv(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                timeoutMs: 300,
            });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(ExecTimeoutError);
        expect((err as Error).message).toMatch(/^срок 300 мс истёк/);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it('git против молчащего origin: отказ по сроку, транспорт закрывает соединение сам', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-git-timeout-'));
        const sockets: net.Socket[] = [];
        // Запрос читаем и не отвечаем: непрочитанный буфер не дал бы сокету дойти до `end`.
        const server = net.createServer((s) => sockets.push(s.resume()));
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const { port } = server.address() as net.AddressInfo;
        // Окружение с нуля: ни прокси машины, ни её git-конфига — иначе тест проверял бы их.
        const env = {
            PATH: process.env.PATH,
            HOME: home,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
        };
        try {
            const started = Date.now();
            let err: unknown;
            try {
                exec().shArgv(
                    'git',
                    ['ls-remote', `http://127.0.0.1:${port}/repo.git`],
                    gitNetworkOpts(env, 1000),
                );
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(ExecTimeoutError);
            expect((err as Error).message).toContain('ls-remote');
            expect(Date.now() - started).toBeLessThan(10_000);
            // Сирота-транспорт держал бы сокет вечно; порог низкой скорости обязан его снять.
            // Соединение принято ядром ещё во время синхронного вызова; событие о нём цикл
            // событий отдаёт только теперь.
            await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
            await Promise.all(
                sockets.map(
                    (s) => new Promise<void>((r) => (s.destroyed ? r() : s.once('close', r))),
                ),
            );
        } finally {
            sockets.forEach((s) => s.destroy());
            server.close();
            fs.rmSync(home, { recursive: true, force: true });
        }
    }, 20_000);
});

// Юнит-тесты модуля health-check туннеля (#361, исходно #92). Здесь проверяется САМА
// фабрика createTunnelCheck — что она собирает рабочие функции из синтетического env,
// независимо от ralph.js. Проход «через ре-экспорт ralph.js» уже покрыт ralph.test.js
// (те же функции, но с боевым контекстом раннера); тут — контракт extraction'а: модуль
// самодостаточен и переносим (цель фазы 2), а не «работает только пока его зовёт ralph.js».
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TunnelCheckEnv } from './tunnel-check.ts';
import { createTunnelCheck } from './tunnel-check.ts';

// Синтетический env: заглушки-коллабораторы, которые молча падают, если функция под
// тестом их зовёт без явного override, — чтобы забытый override был громкой ошибкой
// теста, а не тихим проходом через боевой log/sleep/pushEvent.
function makeEnv(over: Partial<TunnelCheckEnv> = {}): TunnelCheckEnv {
    return {
        log: () => {},
        sleep: () => {
            throw new Error('sleep не подменён в тесте');
        },
        pushEvent: () => {
            throw new Error('pushEvent не подменён в тесте');
        },
        guardSideEffect: () => {},
        ...over,
    };
}

describe('tunnelHealthy — ядро egress-проверки туннеля (#92)', () => {
    const { tunnelHealthy } = createTunnelCheck(makeEnv());

    it('egress точно равен ожидаемому → здоров', () => {
        expect(tunnelHealthy('203.0.113.7', '203.0.113.7')).toBe(true);
    });

    it('egress не тот (вышли не через прокси) → не здоров', () => {
        expect(tunnelHealthy('198.51.100.2', '203.0.113.7')).toBe(false);
    });

    it('пустой egress (curl упал/таймаут) → не здоров', () => {
        expect(tunnelHealthy('', '203.0.113.7')).toBe(false);
    });

    it('пустой ожидаемый (egress не с чем сверять) → не здоров', () => {
        expect(tunnelHealthy('203.0.113.7', '')).toBe(false);
    });
});

describe('tunnelCheckEnabled — включение health-check', () => {
    const { tunnelCheckEnabled } = createTunnelCheck(makeEnv());
    const savedEnv = { ...process.env };
    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('по умолчанию (нет env-флага, config без tunnelCheck) — выключен', () => {
        delete process.env.RALPH_TUNNEL_CHECK;
        expect(tunnelCheckEnabled({})).toBe(false);
    });

    it('config.tunnelCheck.enabled=true → включён', () => {
        delete process.env.RALPH_TUNNEL_CHECK;
        expect(tunnelCheckEnabled({ tunnelCheck: { enabled: true } })).toBe(true);
    });

    it('env RALPH_TUNNEL_CHECK=1 включает даже при config.enabled=false (мост до профилей)', () => {
        process.env.RALPH_TUNNEL_CHECK = '1';
        expect(tunnelCheckEnabled({ tunnelCheck: { enabled: false } })).toBe(true);
    });
});

describe('expectedEgress — ожидаемый egress из env (RALPH_EXPECTED_EGRESS > SS_SERVER)', () => {
    const { expectedEgress } = createTunnelCheck(makeEnv());
    const savedEnv = { ...process.env };
    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('SS_SERVER задан, RALPH_EXPECTED_EGRESS нет → сверка идёт с SS_SERVER (контракт provision)', () => {
        delete process.env.RALPH_EXPECTED_EGRESS;
        process.env.SS_SERVER = '203.0.113.7';
        expect(expectedEgress()).toBe('203.0.113.7');
    });

    it('RALPH_EXPECTED_EGRESS важнее SS_SERVER, если заданы оба', () => {
        process.env.RALPH_EXPECTED_EGRESS = '198.51.100.9';
        process.env.SS_SERVER = '203.0.113.7';
        expect(expectedEgress()).toBe('198.51.100.9');
    });

    it('ни одного не задано → пустая строка (сверять не с чем)', () => {
        delete process.env.RALPH_EXPECTED_EGRESS;
        delete process.env.SS_SERVER;
        expect(expectedEgress()).toBe('');
    });

    it('хвостовой CRLF/пробел (ralph.env редактируют на Windows) обрезается trim', () => {
        delete process.env.RALPH_EXPECTED_EGRESS;
        process.env.SS_SERVER = '203.0.113.7\r\n';
        expect(expectedEgress()).toBe('203.0.113.7');
    });
});

describe('probeEgress — фактический вызов curl (граница anti-RCE защиты, ревью #98)', () => {
    const { probeEgress } = createTunnelCheck(makeEnv());
    const savedEnv = { ...process.env };
    beforeEach(() => {
        // probeEgress читает HTTPS_PROXY/HTTP_PROXY НАПРЯМУЮ из process.env раньше
        // cfg.tunnelCheck.proxyUrl — на машине с настроенным прокси тест иначе ловил
        // бы боевой HTTPS_PROXY вместо тестового cfg.proxyUrl и переставал быть
        // детерминированным. Чистим оба перед каждым тестом этого блока.
        delete process.env.HTTPS_PROXY;
        delete process.env.HTTP_PROXY;
    });
    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('вызывает execFn с бинарём curl и proxy/ipUrl отдельными элементами argv, без -x/URL, склеенных шелл-строкой', () => {
        const execFn = vi.fn().mockReturnValue('203.0.113.7\n');
        const evilProxy = 'http://127.0.0.1:8118; echo pwned';
        const cfg = { tunnelCheck: { proxyUrl: evilProxy, ipCheckUrl: 'https://api.ipify.org' } };

        probeEgress(cfg, execFn);

        expect(execFn).toHaveBeenCalledTimes(1);
        const [bin, cmdArgs, opts] = execFn.mock.calls[0];
        expect(bin).toBe('curl');
        // Значение с ; целиком в ОДНОМ элементе argv — не раскрывается как команда,
        // не разбивается по пробелу (в отличие от сборки через строку в execSync-шелле).
        expect(cmdArgs).toContain(evilProxy);
        expect(cmdArgs.filter((a: string) => a === evilProxy)).toHaveLength(1);
        expect(cmdArgs).toContain('-4');
        expect(opts.encoding).toBe('utf-8');
    });

    it('результат execFn обрезается (trim) от перевода строки, который curl добавляет в вывод', () => {
        const execFn = vi.fn().mockReturnValue('203.0.113.7\n');
        expect(probeEgress({}, execFn)).toBe('203.0.113.7');
    });

    it('execFn бросил (таймаут/мёртвый прокси) → пустая строка, не исключение', () => {
        const execFn = vi.fn().mockImplementation(() => {
            throw new Error('Command failed: curl');
        });
        expect(probeEgress({}, execFn)).toBe('');
    });

    it('proxy по умолчанию берётся из HTTPS_PROXY/HTTP_PROXY, иначе из tc.proxyUrl, иначе localhost:8118', () => {
        // HTTPS_PROXY/HTTP_PROXY уже сняты beforeEach этого блока — не дублируем.
        const execFn = vi.fn().mockReturnValue('1.2.3.4');
        probeEgress({}, execFn);
        expect(execFn.mock.calls[0][1]).toContain('http://127.0.0.1:8118');
    });
});

describe('restartTunnel — фактический вызов systemctl (граница anti-RCE защиты, ревью #98)', () => {
    const { restartTunnel } = createTunnelCheck(makeEnv());

    it('разбивает restartCmd на бинарь + argv и вызывает execFn без шелла', () => {
        const execFn = vi.fn().mockReturnValue('');
        const cfg = {
            tunnelCheck: {
                restartCmd: 'systemctl restart shadowsocks-libev-local@frankfurt privoxy',
            },
        };

        restartTunnel(cfg, execFn);

        expect(execFn).toHaveBeenCalledWith('systemctl', [
            'restart',
            'shadowsocks-libev-local@frankfurt',
            'privoxy',
        ]);
    });

    it('без restartCmd в конфиге использует дефолт (systemctl restart ss-local+privoxy)', () => {
        const execFn = vi.fn().mockReturnValue('');
        restartTunnel({}, execFn);
        expect(execFn).toHaveBeenCalledWith('systemctl', [
            'restart',
            'shadowsocks-libev-local@frankfurt',
            'privoxy',
        ]);
    });

    it('execFn бросил (systemctl упал) → не пробрасывает исключение (fail-open, финальная сверка egress решит)', () => {
        const execFn = vi.fn().mockImplementation(() => {
            throw new Error('systemctl: unit not found');
        });
        expect(() => restartTunnel({}, execFn)).not.toThrow();
    });
});

describe('ensureTunnel — оркестровка health-check (мок curl: совпал/не совпал IP)', () => {
    const savedEnv = { ...process.env };
    beforeEach(() => {
        process.env = {
            ...savedEnv,
            RALPH_TUNNEL_CHECK: '1',
            RALPH_EXPECTED_EGRESS: '203.0.113.7',
        };
    });
    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('проверка выключена → пропуск (true), probe даже не вызывается', () => {
        delete process.env.RALPH_TUNNEL_CHECK;
        const { ensureTunnel } = createTunnelCheck(makeEnv());
        const probe = vi.fn();
        expect(ensureTunnel({}, { probe })).toBe(true);
        expect(probe).not.toHaveBeenCalled();
    });

    it('включена, но нет ожидаемого egress → fail-open (true) с предупреждением, без probe', () => {
        delete process.env.RALPH_EXPECTED_EGRESS;
        delete process.env.SS_SERVER;
        const { ensureTunnel } = createTunnelCheck(makeEnv());
        const probe = vi.fn();
        expect(ensureTunnel({ tunnelCheck: { enabled: true } }, { probe })).toBe(true);
        expect(probe).not.toHaveBeenCalled();
    });

    it('egress сразу совпал → здоров (true), без перезапуска', () => {
        const { ensureTunnel } = createTunnelCheck(makeEnv());
        const probe = vi.fn().mockReturnValue('203.0.113.7');
        const restart = vi.fn();
        expect(ensureTunnel({}, { probe, restart })).toBe(true);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(restart).not.toHaveBeenCalled();
    });

    it('ожидаемый egress с хвостовым CRLF/пробелом (ralph.env часто редактируют на Windows) → trim, сравнение всё равно проходит (ревью #98)', () => {
        process.env.RALPH_EXPECTED_EGRESS = '203.0.113.7\r\n';
        const { ensureTunnel } = createTunnelCheck(makeEnv());
        const probe = vi.fn().mockReturnValue('203.0.113.7');
        expect(ensureTunnel({}, { probe })).toBe(true);
    });

    it('egress красный → перезапуск → повторно совпал → восстановлен (true)', () => {
        const { ensureTunnel } = createTunnelCheck(makeEnv());
        const probe = vi
            .fn()
            .mockReturnValueOnce('198.51.100.2')
            .mockReturnValueOnce('203.0.113.7');
        const restart = vi.fn();
        const sleepFn = vi.fn();
        const push = vi.fn();
        expect(ensureTunnel({}, { probe, restart, sleepFn, push })).toBe(true);
        expect(restart).toHaveBeenCalledTimes(1);
        expect(sleepFn).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(push).not.toHaveBeenCalled(); // восстановился — человека не будим
    });

    it('egress красный и после перезапуска красный → false + пуш человеку', () => {
        const { ensureTunnel } = createTunnelCheck(makeEnv());
        const probe = vi.fn().mockReturnValue('198.51.100.2'); // мимо прокси оба раза
        const restart = vi.fn();
        const sleepFn = vi.fn();
        const push = vi.fn();
        expect(ensureTunnel({}, { probe, restart, sleepFn, push })).toBe(false);
        expect(restart).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(push).toHaveBeenCalledTimes(1);
        expect(push.mock.calls[0][0]).toMatch(/туннел/i);
    });

    it('пустой egress (curl упал) дважды → false + пуш', () => {
        const { ensureTunnel } = createTunnelCheck(makeEnv());
        const probe = vi.fn().mockReturnValue('');
        const push = vi.fn();
        expect(ensureTunnel({}, { probe, restart: vi.fn(), sleepFn: vi.fn(), push })).toBe(false);
        expect(push).toHaveBeenCalledTimes(1);
    });

    it('дефолтный push (из env фабрики) зовётся, если override не передан', () => {
        const pushEvent = vi.fn();
        const { ensureTunnel } = createTunnelCheck(makeEnv({ pushEvent, sleep: vi.fn() }));
        const probe = vi.fn().mockReturnValue('');
        expect(ensureTunnel({}, { probe, restart: vi.fn() })).toBe(false);
        expect(pushEvent).toHaveBeenCalledTimes(1);
    });
});

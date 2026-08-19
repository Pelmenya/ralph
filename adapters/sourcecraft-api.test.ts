// Тесты синхронного транспорта к API SourceCraft. Модуль пришёл без тестов вовсе —
// а он держит два инварианта ядра: №11 (секрет не в argv) и №1 (fail-closed там, где
// пустой ответ петля прочитает как «очередь пуста»).
import { describe, expect, it, vi } from 'vitest';
import { createSourcecraftApi } from './sourcecraft-api.ts';

type SpawnResult = { status: number | null; stdout: string; stderr: string };

function build(res: Partial<SpawnResult> = {}, env: Record<string, string> = {}) {
    const spawnFn = vi.fn(() => ({
        status: 0,
        stdout: '{}',
        stderr: '',
        ...res,
    })) as unknown as Parameters<typeof createSourcecraftApi>[0]['spawnFn'];
    const api = createSourcecraftApi({
        org: 'org',
        repo: 'repo',
        spawnFn,
        envSource: { SOURCECRAFT_TOKEN: 'secret-token', ...env },
    });
    return { api, spawnFn: spawnFn as unknown as ReturnType<typeof vi.fn> };
}

describe('транспорт SourceCraft: fail-closed на неготовности', () => {
    it('пустые координаты → бросает, а не отдаёт пустой ответ', () => {
        const api = createSourcecraftApi({
            org: '',
            repo: 'repo',
            envSource: { SOURCECRAFT_TOKEN: 't' },
        });
        expect(() => api('GET', '/x')).toThrow(/RALPH_SOURCECRAFT_ORG|org\/repo/);
    });

    it('пустой токен → бросает до всякого запроса', () => {
        const { api, spawnFn } = build({}, { SOURCECRAFT_TOKEN: '' });
        expect(() => api('GET', '/x')).toThrow(/SOURCECRAFT_TOKEN/);
        expect(spawnFn).not.toHaveBeenCalled();
    });

    it('ненулевой код curl → бросает с первой строкой причины', () => {
        const { api } = build({ status: 22, stderr: 'HTTP 404\nтело' });
        expect(() => api('GET', '/x')).toThrow(/404/);
    });

    it('ответ не JSON (HTML прокси) → бросает, а не отдаёт пустоту', () => {
        const { api } = build({ stdout: '<html>502</html>' });
        expect(() => api('GET', '/x')).toThrow(/не JSON/);
    });

    it('пустое тело → {} (штатный ответ мутаций без содержимого)', () => {
        const { api } = build({ stdout: '   ' });
        expect(api('POST', '/x', { a: 1 })).toEqual({});
    });
});

describe('транспорт SourceCraft: форма вызова curl', () => {
    it('токен уходит через stdin, а не в argv (инвариант №11)', () => {
        const { api, spawnFn } = build();
        api('GET', '/x');
        const [, args, opts] = spawnFn.mock.calls[0] as [string, string[], { input: string }];
        // argv процесса виден в /proc/<pid>/cmdline любому пользователю машины.
        expect(args.join(' ')).not.toContain('secret-token');
        expect(opts.input).toContain('secret-token');
        // Мало проверить, что секрета нет в argv: без `--config -` curl не прочитает
        // stdin вовсе, и запрос уйдёт БЕЗ авторизации — обе прежние проверки при этом
        // остались бы зелёными.
        expect(args.slice(0, 2)).toEqual(['--config', '-']);
    });

    it('DELETE проходит с телом — снятие метки выражается только им', () => {
        const { api, spawnFn } = build();
        api('DELETE', '/repos/org/repo/pulls/42/labels', { slugs: ['blocked'] });
        const [, args] = spawnFn.mock.calls[0] as [string, string[]];
        expect(args).toContain('DELETE');
        expect(args.join(' ')).toContain('"slugs":["blocked"]');
    });

    it('GET без тела не тащит Content-Type и -d', () => {
        const { api, spawnFn } = build();
        api('GET', '/x');
        const [, args] = spawnFn.mock.calls[0] as [string, string[]];
        expect(args).not.toContain('-d');
    });
});

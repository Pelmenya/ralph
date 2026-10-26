// Тесты двух read-примитивов деплой-проверки (#72, хвост #55). Ассерты на ТЕКСТ команды
// приехали сюда из `core/deploy-check.test.ts` вместе с самой командой: после переезда в
// ядре её попросту нет, и проверять там больше нечего — а проверять всё равно надо.
//
// Главный из них — «только ЧТЕНИЕ» (#166). Пост-мердж проверка СМОТРИТ на прод и main, а
// не трогает их; держится это тем, что в модуле нет ни одного пишущего глагола, и именно
// это здесь и вморожено: read-глагол в начале команды плюс отсутствие merge/cancel/rerun/
// delete/close в остальной строке.
import { describe, expect, it, vi } from 'vitest';

import { createGithubDeployCommands } from './github-deploy-commands.ts';

const shq = (v: unknown) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// Дефолтный ghJson громко падает: примитив, дёрнувший его мимо подменённого канала, обязан
// уронить тест, а не уйти в настоящий форж.
function make(over: Partial<Parameters<typeof createGithubDeployCommands>[0]> = {}) {
    return createGithubDeployCommands({
        ghJson: () => {
            throw new Error('ghJson не подменён в тесте');
        },
        shq,
        ...over,
    });
}

describe('mergeCommitOid — коммит squash-мерджа PR (#163)', () => {
    const SHA = 'c'.repeat(40);

    it('читает голову мерджа, номер PR уходит через shq', () => {
        const ghJsonFn = vi.fn((_cmd: string) => ({ mergeCommit: { oid: SHA } }));
        expect(make().mergeCommitOid(12, { ghJsonFn })).toBe(SHA);
        expect(ghJsonFn.mock.calls[0][0]).toContain("gh pr view '12'");
    });

    it('только ЧТЕНИЕ: "gh pr view", без merge/close/edit', () => {
        const ghJsonFn = vi.fn((_cmd: string) => ({ mergeCommit: { oid: SHA } }));
        make().mergeCommitOid(1, { ghJsonFn });
        const cmd = ghJsonFn.mock.calls[0][0];
        expect(cmd).toMatch(/^gh pr view\b/);
        expect(cmd).not.toMatch(/\b(merge|close|edit|delete)\b/);
    });

    // Пустой ответ — штатное состояние сразу после мерджа (форж отдаёт коммит с лагом), и
    // решает по нему ЯДРО: у него таймауты и ретраи. Адаптер, начни он тут бросать, отнял
    // бы у ядра единственную возможность отличить лаг от отказа.
    it('пустой mergeCommit отдаётся как есть, а не подменяется отказом', () => {
        const ghJsonFn = vi.fn(() => ({ mergeCommit: null }));
        expect(make().mergeCommitOid(12, { ghJsonFn })).toBeFalsy();
    });

    it('дефолтный канал чтения — из env фабрики, а не из опций вызова', () => {
        const ghJson = vi.fn((_cmd: string) => ({ mergeCommit: { oid: SHA } }));
        expect(make({ ghJson }).mergeCommitOid(7)).toBe(SHA);
        expect(ghJson).toHaveBeenCalledTimes(1);
    });
});

describe('listWorkflowRuns — прогоны deploy-workflow (#163)', () => {
    it('имя workflow уходит через shq', () => {
        const ghJsonFn = vi.fn((_cmd: string) => []);
        make().listWorkflowRuns('release.yml', { ghJsonFn });
        expect(ghJsonFn.mock.calls[0][0]).toContain("--workflow 'release.yml'");
    });

    it('только ЧТЕНИЕ: "gh run list", без cancel/rerun/delete/merge/close', () => {
        const ghJsonFn = vi.fn((_cmd: string) => []);
        make().listWorkflowRuns('deploy.yml', { ghJsonFn });
        const cmd = ghJsonFn.mock.calls[0][0];
        expect(cmd).toMatch(/^gh run list\b/);
        expect(cmd).not.toMatch(/\b(cancel|rerun|delete|merge|close|revert)\b/);
    });

    // Поля запрашиваются явно: ядро читает из прогона headSha/status/conclusion, и потеря
    // любого из них превратила бы «прогон не завершён» в «прогона нет» — то есть в
    // not-found на каждом деплое.
    it('запрашивает ровно те поля, по которым ядро принимает решение', () => {
        const ghJsonFn = vi.fn((_cmd: string) => []);
        make().listWorkflowRuns('deploy.yml', { ghJsonFn });
        const cmd = ghJsonFn.mock.calls[0][0];
        for (const field of ['databaseId', 'headSha', 'status', 'conclusion', 'url']) {
            expect(cmd).toContain(field);
        }
    });

    it('отказ чтения пробрасывается наружу — решение о ретрае за ядром', () => {
        const ghJsonFn = vi.fn(() => {
            throw new Error('network blip');
        });
        expect(() => make().listWorkflowRuns('deploy.yml', { ghJsonFn })).toThrow(/network blip/);
    });

    it('дефолтный канал чтения — из env фабрики, а не из опций вызова', () => {
        const ghJson = vi.fn((_cmd: string) => []);
        make({ ghJson }).listWorkflowRuns('deploy.yml');
        expect(ghJson).toHaveBeenCalledTimes(1);
    });
});

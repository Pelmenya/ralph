// #55: тесты примитивов форжа переехали сюда вместе с кодом. Раньше они жили в
// `core/gate.test.ts` — по месту прежнего расположения функций, а не по смыслу: проверяют
// они не гейт, а GitHub-реализацию метки blocked и мерджа PR.
//
// Ассерты перенесены дословно: критерий #55 требует, чтобы переезд не менял наблюдаемого
// поведения. Изменилась только сборка объекта под тестом — вместо `createGateRunner(env)`
// это `createGithubForgeCommands(env)` со своим, куда более узким env.
import { describe, expect, it, vi } from 'vitest';
import { createGithubForgeCommands } from './github-forge-commands.ts';

const PR_NUMBER_RE = /^\d+$/;

const makeForge = (over: Partial<Parameters<typeof createGithubForgeCommands>[0]> = {}) =>
    createGithubForgeCommands({
        sh: () => '',
        shArgv: () => '',
        shq: (v: string) => `'${String(v)}'`,
        log: () => {},
        ghJson: () => [] as never,
        safeBranch: () => true,
        prNumberRe: PR_NUMBER_RE,
        sha40Re: /^[0-9a-f]{40}$/i,
        ...over,
    });

describe('removeBlockedLabel / addBlockedLabel — детерминированный переход метки (#217/#223)', () => {
    it('removeBlockedLabel: снимает метку через argv gh pr edit', () => {
        const g = makeForge();
        const runArgv = vi.fn(() => '');
        g.removeBlockedLabel('feature/x', { shFn: () => '42', runArgvFn: runArgv });
        expect(runArgv).toHaveBeenCalledWith('gh', [
            'pr',
            'edit',
            '42',
            '--remove-label',
            'blocked',
        ]);
    });

    it('addBlockedLabel: возвращает метку через argv gh pr edit', () => {
        const g = makeForge();
        const runArgv = vi.fn(() => '');
        g.addBlockedLabel('feature/x', { shFn: () => '42', runArgvFn: runArgv });
        expect(runArgv).toHaveBeenCalledWith('gh', ['pr', 'edit', '42', '--add-label', 'blocked']);
    });

    it('нет открытого PR → метку не трогаем (fail-closed, но не бросает)', () => {
        const g = makeForge();
        const runArgv = vi.fn(() => '');
        g.removeBlockedLabel('feature/x', { shFn: () => '', runArgvFn: runArgv });
        expect(runArgv).not.toHaveBeenCalled();
    });

    it('номер PR не похож на целое → в argv не пускаем', () => {
        const g = makeForge();
        const runArgv = vi.fn(() => '');
        g.removeBlockedLabel('feature/x', { shFn: () => '--evil', runArgvFn: runArgv });
        expect(runArgv).not.toHaveBeenCalled();
    });

    it('имя ветки не прошло safeBranch → ничего не делаем', () => {
        const g = makeForge({ safeBranch: () => false });
        const sh = vi.fn(() => '42');
        g.removeBlockedLabel('bad branch', { shFn: sh, runArgvFn: () => '' });
        expect(sh).not.toHaveBeenCalled();
    });
});

// #366: fail-open переходы метки blocked — сценарии, которых нет в фабричных тестах выше.
// Косметика метки не имеет права ронять цикл сдачи: не сняли — гейт подберёт blocked,
// не вернули — блок останется снятым, но петля продолжит работать, а не упадёт.
describe('removeBlockedLabel / addBlockedLabel — сбой gh не роняет петлю (#217/#223)', () => {
    // Раньше брались из ре-экспорта `ralph.js` (боевой composition root). После #55 у
    // примитивов есть своя фабрика — берём из неё, с тем же узким env.
    const { removeBlockedLabel, addBlockedLabel } = makeForge();

    it('сбой gh не роняет (fail-open): метка останется, гейт подберёт blocked', () => {
        const shFn = () => {
            throw new Error('gh boom');
        };
        const logs: string[] = [];
        expect(() =>
            removeBlockedLabel('feature/m1', { shFn, logFn: (m: string) => logs.push(m) }),
        ).not.toThrow();
        expect(logs.join('\n')).toMatch(/не снял метку/);
    });

    it('сбой argv-мутации не роняет (fail-open): метка останется, гейт подберёт blocked', () => {
        const shFn = (cmd: string) => (cmd.includes('gh pr list') ? '42\n' : '');
        const runArgvFn = () => {
            throw new Error('gh edit boom');
        };
        const logs: string[] = [];
        expect(() =>
            removeBlockedLabel('feature/m1', {
                shFn,
                runArgvFn,
                logFn: (m: string) => logs.push(m),
            }),
        ).not.toThrow();
        expect(logs.join('\n')).toMatch(/не снял метку/);
    });

    it('addBlockedLabel: сбой argv-мутации не роняет — только лог', () => {
        const shFn = (cmd: string) => (cmd.includes('gh pr list') ? '42\n' : '');
        const runArgvFn = () => {
            throw new Error('gh edit boom');
        };
        const logs: string[] = [];
        expect(() =>
            addBlockedLabel('feature/m1', { shFn, runArgvFn, logFn: (m: string) => logs.push(m) }),
        ).not.toThrow();
        expect(logs.join('\n')).toMatch(/не вернул метку/);
    });
});

// #55: сборка команды мерджа переехала сюда из тестов гейта. Гейт отвечает за то, ЧТО
// зовёт примитив (номер PR + прогнанная чеками голова); КАК из этого получается argv —
// предмет адаптера. Раньше обе половины проверялись в одном тесте гейта, и подмена форжа
// ломала бы тест, не имеющий отношения к форжу.
describe('mergePr — сборка argv squash-мерджа (#55)', () => {
    it('валидный sha → --match-head-commit с ним (TOCTOU-привязка, #SiaTz)', () => {
        const SHA = 'a'.repeat(40);
        const runArgvFn = vi.fn(() => '');
        makeForge().mergePr(9, SHA, { runArgvFn });
        expect(runArgvFn).toHaveBeenCalledWith('gh', [
            'pr',
            'merge',
            '9',
            '--squash',
            '--delete-branch',
            '--match-head-commit',
            SHA,
        ]);
    });

    it.each<[string | null, string]>([
        ['', 'пустая строка'],
        ['не-sha', 'мусор'],
        [null, 'null'],
    ])('невалидный sha (%s, %s) → мердж без привязки, а не с битым значением', (headSha) => {
        const runArgvFn = vi.fn(() => '');
        makeForge().mergePr(9, headSha, { runArgvFn });
        expect(runArgvFn).toHaveBeenCalledWith('gh', [
            'pr',
            'merge',
            '9',
            '--squash',
            '--delete-branch',
        ]);
    });
});

// Обе проверки «фаза смерджена» ходят одним запросом к форжу и различаются лишь тем, что
// отдают наружу: факт и номер. Номер нужен пути #237, где гейт не прогонялся и lastGatePr
// пуст — без него авто-половина метрики ревью терялась бы молча.
describe('phaseMerged / mergedPhasePr — ответ форжа о смердженной фазе (#55)', () => {
    it('есть смердженный PR → true и его номер', () => {
        const forge = makeForge({ ghJson: (() => [{ number: 77 }]) as never });
        expect(forge.phaseMerged({ branch: 'feature/x' })).toBe(true);
        expect(forge.mergedPhasePr({ branch: 'feature/x' })).toBe(77);
    });

    it('пусто → false и null', () => {
        const forge = makeForge({ ghJson: (() => []) as never });
        expect(forge.phaseMerged({ branch: 'feature/x' })).toBe(false);
        expect(forge.mergedPhasePr({ branch: 'feature/x' })).toBe(null);
    });

    it('форж недоступен → БРОСАЕТ, а не отвечает «не смерджена»', () => {
        // Молчаливый false заставил бы петлю пересоздавать PR уже смердженной фазы,
        // а preflight — падать с ложной причиной.
        const forge = makeForge({
            ghJson: (() => {
                throw new Error('gh недоступен');
            }) as never,
        });
        expect(() => forge.phaseMerged({ branch: 'feature/x' })).toThrow(/недоступен/);
    });
});

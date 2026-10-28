// Устаревший прогон CI (#224): пропуск гейта — единственный опасный исход, поэтому половина
// кейсов ниже — «от противного»: любая неясность обязана давать полный гейт.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    decideStaleRun,
    runStaleCheck,
    type StaleCheckDeps,
    type StaleRunInput,
} from './ci-stale-run.mts';

const RUN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

const input = (over: Partial<StaleRunInput> = {}): StaleRunInput => ({
    event: 'pull_request',
    prSlug: '61',
    runSha: RUN,
    readHead: () => HEAD,
    isAncestor: () => true,
    ...over,
});

describe('decideStaleRun', () => {
    it('коммит прогона — предок ушедшей вперёд головы: устарел, строка называет HEAD', () => {
        const v = decideStaleRun(input());
        expect(v.stale).toBe(true);
        expect(v.head).toBe(HEAD);
        expect(v.line).toContain('устарел, HEAD уже bbbbbbbb');
    });

    it('перезапуск проверок PR судится так же', () => {
        expect(decideStaleRun(input({ event: 'restart' })).stale).toBe(true);
    });

    it('прогон текущей головы — полный гейт', () => {
        const v = decideStaleRun(input({ readHead: () => RUN }));
        expect(v.stale).toBe(false);
        expect(v.line).toMatch(/Полный гейт: прогон текущей головы aaaaaaaa/);
    });

    it('сравнение регистронезависимо: та же голова в верхнем регистре — не «другая»', () => {
        expect(decideStaleRun(input({ readHead: () => RUN.toUpperCase() })).stale).toBe(false);
    });

    it.each([
        ['пуш в ветку', { event: 'push' }],
        ['ручной запуск', { event: 'manual' }],
        ['нет номера PR', { prSlug: '' }],
        ['номер PR не число', { prSlug: '61?state=closed' }],
        ['нет коммита прогона', { runSha: '' }],
        ['коммит прогона не sha', { runSha: 'HEAD' }],
        ['площадка не отдала голову', { readHead: () => '' }],
        [
            'голова не прочиталась',
            {
                readHead: () => {
                    throw new Error('HTTP 502');
                },
            },
        ],
        ['git не ответил о предке', { isAncestor: () => null }],
        // Площадка, гоняющая PR на своём merge-коммите: неравенство было бы всегда, и
        // пропуск по одному неравенству снимал бы гейт у каждого прогона.
        ['коммит прогона не предок головы', { isAncestor: () => false }],
    ] as Array<[string, Partial<StaleRunInput>]>)('%s — полный гейт', (_name, over) => {
        const v = decideStaleRun(input(over));
        expect(v.stale).toBe(false);
        expect(v.head).toBeNull();
        expect(v.line).toMatch(/^▶ Полный гейт: /);
    });

    it('причина отказа чтения головы — в строке', () => {
        const v = decideStaleRun(
            input({
                readHead: () => {
                    throw new Error('HTTP 502');
                },
            }),
        );
        expect(v.line).toContain('HTTP 502');
    });

    it('предок спрашивается от коммита прогона к голове, а не наоборот', () => {
        const calls: string[][] = [];
        decideStaleRun(
            input({
                isAncestor: (a, h) => {
                    calls.push([a, h]);
                    return true;
                },
            }),
        );
        expect(calls).toEqual([[RUN, HEAD]]);
    });
});

// Проводка куба: переменные площадки, шов головы, git и запись решения. Боевые git и API
// подменены параметрами — так тест видит, ЧТО куб спросил и что передал следующим.
describe('runStaleCheck — проводка куба', () => {
    const DECISIONS = '/tmp/cube-decisions';
    const gitError = (status: number | null, stderr = 'boom') =>
        Object.assign(new Error(stderr), { status, stderr });
    const ENV = {
        SOURCECRAFT_EVENT: 'pull_request',
        SOURCECRAFT_PR_SLUG: '61',
        SOURCECRAFT_COMMIT_SHA: RUN,
        SOURCECRAFT_ENV: DECISIONS,
    };
    const world = (over: Partial<StaleCheckDeps> = {}, env: Record<string, string> = ENV) => {
        const gitCalls: string[][] = [];
        const appended: Array<[string, string]> = [];
        const logs: string[] = [];
        const heads: Array<[string, number]> = [];
        const deps: StaleCheckDeps = {
            env,
            git: (args) => {
                gitCalls.push(args);
                if (args[0] === 'remote')
                    return 'https://git.example.dev/your-org/your-project.git\n';
                return '';
            },
            headOf: (remote, pr) => {
                heads.push([`${remote.org}/${remote.repo}`, pr]);
                return HEAD;
            },
            append: (file, text) => void appended.push([file, text]),
            log: (line) => void logs.push(line),
            ...over,
        };
        return { deps, gitCalls, appended, logs, heads };
    };

    it('устаревший прогон: голова через шов, fetch ровно головы, решение — следующим кубам', () => {
        const w = world();
        const v = runStaleCheck(w.deps);
        expect(v.stale).toBe(true);
        expect(w.heads).toEqual([['your-org/your-project', 61]]);
        expect(w.gitCalls).toContainEqual(['fetch', '--quiet', '--no-tags', 'origin', HEAD]);
        expect(w.gitCalls).toContainEqual(['merge-base', '--is-ancestor', RUN, HEAD]);
        expect(w.appended).toEqual([[DECISIONS, `RALPH_STALE_RUN=${HEAD}\n`]]);
        expect(w.logs.at(-1)).toMatch(/устарел, HEAD уже bbbbbbbb/);
    });

    it('полный гейт тоже пишет решение — пустым, чтобы чужая переменная не пропустила гейт', () => {
        const w = world({ headOf: () => RUN });
        expect(runStaleCheck(w.deps).stale).toBe(false);
        expect(w.appended).toEqual([[DECISIONS, 'RALPH_STALE_RUN=\n']]);
    });

    it('отказ fetch — своя строка, а не «не предок»; merge-base всё равно спрошен', () => {
        const w = world({
            git: (args) => {
                if (args[0] === 'remote') return 'git@git.example.dev:your-org/your-project.git';
                if (args[0] === 'fetch') {
                    throw gitError(1, 'error: some local refs could not be updated');
                }
                return '';
            },
        });
        const v = runStaleCheck(w.deps);
        expect(w.logs.join('\n')).toMatch(
            /git fetch головы bbbbbbbb не удался — error: some local/,
        );
        // Объект головы в клоне есть — merge-base ответил «предок».
        expect(v.stale).toBe(true);
    });

    it('merge-base без объекта (128) или по сроку (status null) — полный гейт «не установлено»', () => {
        for (const status of [128, null]) {
            const w = world({
                git: (args) => {
                    if (args[0] === 'remote') return 'https://git.example.dev/o/r.git';
                    if (args[0] === 'merge-base') throw gitError(status);
                    return '';
                },
            });
            const v = runStaleCheck(w.deps);
            expect(v.stale).toBe(false);
            expect(v.line).toMatch(/не установлено, предок ли/);
        }
    });

    it('переменные площадки не пришли — названы строкой, гейт полный', () => {
        const w = world({}, { SOURCECRAFT_ENV: DECISIONS });
        expect(runStaleCheck(w.deps).stale).toBe(false);
        expect(w.logs[0]).toMatch(
            /не пришли: SOURCECRAFT_EVENT, SOURCECRAFT_PR_SLUG, SOURCECRAFT_COMMIT_SHA/,
        );
        expect(w.heads).toEqual([]);
    });

    it('нет файла решения — устаревший прогон всё равно идёт полным гейтом', () => {
        const vars: Record<string, string> = { ...ENV };
        delete vars['SOURCECRAFT_ENV'];
        const w = world({}, vars);
        const v = runStaleCheck(w.deps);
        expect(v.stale).toBe(false);
        expect(v.line).toMatch(/не задан — решение не передать/);
        expect(w.appended).toEqual([]);
    });

    it('нет файла решения, а RALPH_STALE_RUN пришёл мимо куба — куб краснеет', () => {
        for (const stale of [true, false]) {
            const vars: Record<string, string> = { ...ENV, RALPH_STALE_RUN: HEAD };
            delete vars['SOURCECRAFT_ENV'];
            const w = world(stale ? {} : { headOf: () => RUN }, vars);
            const v = runStaleCheck(w.deps);
            expect(v.stale).toBe(false);
            expect(v.fail).toBe(true);
            expect(v.line).toMatch(/пришёл мимо stale-check/);
        }
    });

    it('запись решения упала при чужом RALPH_STALE_RUN — куб краснеет', () => {
        const w = world(
            {
                append: () => {
                    throw new Error('EACCES');
                },
            },
            { ...ENV, RALPH_STALE_RUN: HEAD },
        );
        expect(runStaleCheck(w.deps).fail).toBe(true);
    });

    it('решение записано — чужой RALPH_STALE_RUN перезаписан, куб не краснеет', () => {
        const w = world({ headOf: () => RUN }, { ...ENV, RALPH_STALE_RUN: HEAD });
        const v = runStaleCheck(w.deps);
        expect(v.fail).toBeUndefined();
        expect(w.appended).toEqual([[DECISIONS, 'RALPH_STALE_RUN=\n']]);
    });

    it('запись решения упала — полный гейт с причиной', () => {
        const w = world({
            append: () => {
                throw new Error('EACCES');
            },
        });
        const v = runStaleCheck(w.deps);
        expect(v.stale).toBe(false);
        expect(v.line).toMatch(/не записалось.*EACCES/);
    });

    it('origin не разобрался — полный гейт, голова не спрашивается', () => {
        const w = world({ git: () => 'не-адрес' });
        const v = runStaleCheck(w.deps);
        expect(v.stale).toBe(false);
        expect(v.line).toMatch(/не разобрал origin/);
        expect(w.heads).toEqual([]);
    });
});

// Условие пропуска стоит в двух кубах ci.yaml, и правка одного из них развела бы кубы молча:
// install пропущен, а гейт идёт без зависимостей, или наоборот — гейт пропущен при `npm ci`.
describe('ci.yaml — условие пропуска одно у install и gate', () => {
    it('оба куба проверяют RALPH_STALE_RUN одним выражением в форме sha', () => {
        const yaml = readFileSync(
            path.join(import.meta.dirname, '.sourcecraft', 'ci.yaml'),
            'utf8',
        );
        const conditions = [...yaml.matchAll(/- 'if (.*?); then/g)].map((m) => m[1]);
        expect(conditions).toHaveLength(2);
        expect(conditions[0]).toBe(conditions[1]);
        expect(conditions[0]).toContain('RALPH_STALE_RUN');
        expect(conditions[0]).toContain('[0-9a-f]{40}');
    });
});

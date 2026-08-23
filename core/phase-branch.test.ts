// Дерево работы ставит на ветку фазы раннер, а не сессия (канон, задача 11).
//
// Проверяется КОНТРАКТ: `runArgvFn` инжектируется, тест видит точную последовательность
// argv и решение по каждой развилке. Что эта последовательность делает с настоящим git —
// вопрос приёмочного сценария, а не этого файла.
import { describe, it, expect } from 'vitest';
import { ensurePhaseBranch, checkOnPhaseBranch, type TPhaseBranchKind } from './phase-branch.ts';

const BRANCH = 'feature/faza-1';
/** Запреты, общие у всех команд модуля: в ключах словаря и сверках они только шумят. */
const PREFIX = ['-c', 'submodule.recurse=false'];
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

/** Отказ git с кодом возврата — так его отдаёт execFileSync, так его читает модуль. */
function gitFail(message: string, status: number): Error {
    return Object.assign(new Error(message), { status });
}

/**
 * Мир, где git отвечает по словарю: ключ — argv через пробел, значение — ответ либо отказ.
 * Массив в значении — очередь ответов на повторные вызовы; последний залипает.
 */
function world(given: Record<string, string | Error | Array<string | Error>> = {}) {
    const calls: string[][] = [];
    const logs: string[] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const queues = new Map<string, Array<string | Error>>();
    // Дефолт «дерево встало куда просили»: успех подтверждается через symbolic-ref, и без
    // ответа каждый сценарий уходил бы в отказ вместо своей ветки.
    const replies: Record<string, string | Error | Array<string | Error>> = {
        'symbolic-ref --quiet --short HEAD': BRANCH,
        ...given,
    };
    const runArgvFn = (
        file: string,
        args: string[],
        opts?: { env?: NodeJS.ProcessEnv },
    ): string => {
        calls.push([file, ...args]);
        envs.push(opts?.env);
        const key = args.slice(PREFIX.length).join(' ');
        const declared = replies[key];
        if (declared === undefined) return '';
        if (!Array.isArray(declared)) {
            if (declared instanceof Error) throw declared;
            return declared;
        }
        const queue = queues.get(key) ?? [...declared];
        const reply = (queue.length > 1 ? queue.shift() : queue[0]) as string | Error;
        queues.set(key, queue);
        if (reply instanceof Error) throw reply;
        return reply;
    };

    return {
        calls,
        logs,
        envs,
        deps: {
            runArgvFn,
            logFn: (m: string) => logs.push(m),
            safeBranch: () => true,
            env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
        },
    };
}

/** Ветка на origin отсутствует: `ls-remote --exit-code` отвечает кодом 2, а не ошибкой. */
const NO_REMOTE_BRANCH = gitFail('', 2);
/** Локального ref нет: `rev-parse --verify` отказывает кодом 1. */
const NO_LOCAL_REF = gitFail('', 1);

const args = (calls: string[][]) =>
    calls.map((c) => [c[0], ...c.slice(1 + PREFIX.length)].join(' '));

describe('ensurePhaseBranch', () => {
    // Последовательность целиком, а не «среди команд есть switch»: выпади отсюда
    // `fetch origin main`, и ветка завелась бы от устаревшего ref — а проверка на
    // вхождение осталась бы зелёной (ревью, 1-й проход).
    it('ветки нет нигде — создаёт от свежего origin/main, ровно этими командами', () => {
        const w = world({
            [`ls-remote --exit-code --heads origin ${BRANCH}`]: NO_REMOTE_BRANCH,
            [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: NO_LOCAL_REF,
            'rev-parse HEAD': SHA,
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe<TPhaseBranchKind>('created');
        expect(args(w.calls)).toEqual([
            'git fetch origin main --quiet',
            `git ls-remote --exit-code --heads origin ${BRANCH}`,
            `git rev-parse --verify --quiet refs/heads/${BRANCH}`,
            `git switch --create ${BRANCH} origin/main`,
            'git symbolic-ref --quiet --short HEAD',
            'git rev-parse HEAD',
        ]);
        expect(res.sha).toBe(SHA);
    });

    it('ветка есть на origin, локального ref нет — берёт origin-версию, а не создаёт заново', () => {
        const w = world({
            [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: NO_LOCAL_REF,
            'rev-parse HEAD': SHA,
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe<TPhaseBranchKind>('adopted');
        // Последовательность целиком: без `fetch origin <ветка>` в свежем worktree нет
        // самого ref'а origin/<ветка>, и `switch --track` упал бы — а проверка на
        // вхождение осталась бы зелёной (ревью, 2-й проход).
        expect(args(w.calls)).toEqual([
            'git fetch origin main --quiet',
            `git ls-remote --exit-code --heads origin ${BRANCH}`,
            `git rev-parse --verify --quiet refs/heads/${BRANCH}`,
            `git fetch origin ${BRANCH} --quiet`,
            `git switch --create ${BRANCH} --track origin/${BRANCH}`,
            'git symbolic-ref --quiet --short HEAD',
            'git rev-parse HEAD',
        ]);
        // Ровно то, чем сессия ломала пуш: заново от origin/main — расходящаяся ветка.
        expect(args(w.calls)).not.toContain(`git switch --create ${BRANCH} origin/main`);
    });

    it('ветка есть и там и там — встаёт на неё и подтягивает только ff', () => {
        const w = world({
            [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: SHA,
            'rev-parse HEAD': SHA,
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe<TPhaseBranchKind>('fast-forwarded');
        // Оба fetch на месте: без второго ff подтягивал бы устаревший origin/<ветка>.
        expect(args(w.calls)).toEqual([
            'git fetch origin main --quiet',
            `git ls-remote --exit-code --heads origin ${BRANCH}`,
            `git rev-parse --verify --quiet refs/heads/${BRANCH}`,
            `git fetch origin ${BRANCH} --quiet`,
            `git switch ${BRANCH}`,
            `git merge --ff-only origin/${BRANCH}`,
            'git symbolic-ref --quiet --short HEAD',
            'git rev-parse HEAD',
        ]);
    });

    it('локальная ветка разошлась с origin — отказ, а не force', () => {
        const w = world({
            [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: SHA,
            [`merge --ff-only origin/${BRANCH}`]: gitFail('Not possible to fast-forward', 128),
            'rev-parse HEAD': SHA,
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe<TPhaseBranchKind>('diverged');
        expect(args(w.calls).join(' ')).not.toMatch(/--force|reset --hard|push -f/);
        expect(w.logs.join('\n')).toMatch(/разошлась|ff/i);
    });

    it('ветки нет на origin, но есть локально — не трогает её: там незапушенная работа', () => {
        const w = world({
            [`ls-remote --exit-code --heads origin ${BRANCH}`]: NO_REMOTE_BRANCH,
            [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: SHA,
            'rev-parse HEAD': SHA,
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe<TPhaseBranchKind>('switched');
        expect(args(w.calls)).toContain(`git switch ${BRANCH}`);
        expect(args(w.calls)).not.toContain(`git switch --create ${BRANCH} origin/main`);
    });

    it('ls-remote отказал не кодом 2 — это сбой сети, а не отсутствие ветки', () => {
        const w = world({
            [`ls-remote --exit-code --heads origin ${BRANCH}`]: gitFail(
                'could not read Username',
                128,
            ),
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        // Молчаливое «ветки нет» здесь создало бы её заново от origin/main поверх чужой
        // работы — ровно то, чего не должно случаться при недоступном origin.
        expect(res.kind).toBe<TPhaseBranchKind>('failed');
        expect(args(w.calls)).not.toContain(`git switch --create ${BRANCH} origin/main`);
    });

    it('rev-parse отказал не кодом 1 — это сбой, а не «локальной ветки нет»', () => {
        const w = world({
            [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: gitFail(
                'fatal: not a git repo',
                128,
            ),
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        // Иначе поломанная ref-база уводила бы в `switch --create`, и безопасность держалась
        // бы на том, что git обычно откажется создать существующий ref, — то есть на удаче.
        expect(res.kind).toBe<TPhaseBranchKind>('failed');
        expect(args(w.calls)).not.toContain(`git switch --create ${BRANCH} origin/main`);
    });

    it('команды прошли, но HEAD увели — это отказ, а не успех', () => {
        const w = world({
            [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: NO_LOCAL_REF,
            // Так выглядит `post-checkout` человека, отправивший дерево в detached HEAD:
            // хуки мы намеренно не гасим, значит увести дерево есть чему.
            'symbolic-ref --quiet --short HEAD': gitFail('', 1),
        });

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe<TPhaseBranchKind>('failed');
        expect(res.sha).toBeNull();
        expect(w.logs.join('\n')).toMatch(/HEAD оказался/);
    });

    it('небезопасное имя ветки — git не зовётся ни разу', () => {
        const w = world();

        const res = ensurePhaseBranch('--upload-pack=evil', { ...w.deps, safeBranch: () => false });

        expect(res.kind).toBe<TPhaseBranchKind>('unsafe-name');
        expect(w.calls).toEqual([]);
    });

    it('запрещает интерактивный запрос кредов на каждом сетевом вызове', () => {
        const w = world({ [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: NO_LOCAL_REF });

        ensurePhaseBranch(BRANCH, w.deps);
        const network = w.calls
            .map((c, i) => ({ argv: c.join(' '), env: w.envs[i] }))
            .filter((c) => /fetch|ls-remote/.test(c.argv));

        expect(network.length).toBeGreaterThan(0);
        expect(network.every((c) => c.env?.['GIT_TERMINAL_PROMPT'] === '0')).toBe(true);
    });

    it('не рекурсирует в подмодуль: код продукта под петлёй не подменяется', () => {
        const w = world({ [`rev-parse --verify --quiet refs/heads/${BRANCH}`]: NO_LOCAL_REF });

        ensurePhaseBranch(BRANCH, w.deps);

        expect(w.calls.every((c) => c.includes('submodule.recurse=false'))).toBe(true);
    });
});

describe('checkOnPhaseBranch', () => {
    it('дерево на ветке фазы — молчит', () => {
        const w = world({ 'symbolic-ref --quiet --short HEAD': BRANCH, 'rev-parse HEAD': SHA });

        expect(checkOnPhaseBranch(BRANCH, w.deps).ok).toBe(true);
    });

    it('HEAD detached — называет SHA, который надо спасти, и команду', () => {
        const w = world({
            'symbolic-ref --quiet --short HEAD': gitFail('', 1),
            'rev-parse HEAD': OTHER_SHA,
        });

        const res = checkOnPhaseBranch(BRANCH, w.deps);

        expect(res.ok).toBe(false);
        expect(res.message).toContain(OTHER_SHA);
        // Первой идёт команда, которая работает в ЛЮБОМ состоянии дерева: срочное здесь —
        // закрепить коммит ref'ом, а не влить его. `update-ref` в собственном пространстве
        // `refs/ralph/`: идемпотентна, фиксированной длины, ветки не засоряет.
        expect(res.message).toContain(`git update-ref refs/ralph/rescue-${OTHER_SHA} ${OTHER_SHA}`);
        // Ref — GC-корень: после слияния он не нужен, и совет говорит это сам.
        expect(res.message).toContain(`git update-ref -d refs/ralph/rescue-${OTHER_SHA}`);
        // Все три прежние формулировки отказывали на практике — их быть не должно.
        expect(res.message).not.toMatch(/git branch /);
        // Длина имени ref'а не зависит от имени ветки фазы: иначе легально длинная ветка
        // упирала бы `git branch` в предел имени файла — отказ в критический момент.
        expect(res.message).not.toContain(`${BRANCH}-rescue`);
        // Слияние — вторым, и без --ff-only: после расхождения человеку нужен мердж, а
        // работа к тому моменту уже закреплена ref'ом.
        expect(res.message).toContain(`git switch ${BRANCH} && git merge ${OTHER_SHA}`);
        // Порядок — часть совета, а не оформление: слияние падает на грязном дереве, и
        // совет, ведущий с него, для частого случая не начался бы вовсе. Проверка на
        // наличие обеих команд этого не ловит (ревью, 6-й проход).
        expect((res.message ?? '').indexOf('git update-ref ')).toBeLessThan(
            (res.message ?? '').indexOf('git switch '),
        );
    });

    it('дерево на ЧУЖОЙ ветке — тоже отказ: коммит уехал не туда', () => {
        const w = world({
            'symbolic-ref --quiet --short HEAD': 'main',
            'rev-parse HEAD': OTHER_SHA,
        });

        const res = checkOnPhaseBranch(BRANCH, w.deps);

        expect(res.ok).toBe(false);
        expect(res.message).toContain('main');
    });

    it('git не отвечает — отказ, а не «наверное, всё в порядке»', () => {
        const w = world({
            'rev-parse HEAD': gitFail('fatal', 128),
            'symbolic-ref --quiet --short HEAD': gitFail('', 1),
        });

        expect(checkOnPhaseBranch(BRANCH, w.deps).ok).toBe(false);
    });
});

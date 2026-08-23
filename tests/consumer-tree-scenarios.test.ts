// Приёмочный сценарий обновления дерева потребителя (канон, задача 28).
//
// Юниты рядом с модулем (`core/consumer-tree.test.ts`) проверяют КОНТРАКТ: какие argv и
// какое решение на каждой развилке. Здесь — то, чего фейком не докажешь: что эта
// последовательность действительно доводит смердженный коммит до дерева потребителя, а
// грязное дерево остаётся ровно таким, каким его оставил человек.
//
// git здесь НАСТОЯЩИЙ, и это не нарушение предохранителя побочек: `runArgvFn` инжектируется
// тестом и исполняет команды сам, боевой `shArgv` (тот, что под guard'ом) не зовётся вовсе.
// Приём тот же, что у песочницы живого цикла: мир вокруг временный, а операция — та самая.
//
// Окружение git — своё, а не унаследованное: `GIT_DIR`/`GIT_WORK_TREE` вызывающего увели бы
// коммиты в ЕГО репозиторий, а глобальный конфиг подсунул бы чужие хуки (`core.hooksPath`)
// процессу с полным окружением сьюта.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateConsumerTree } from '../core/consumer-tree.ts';
import type { TResolvedRoots } from '../core/roots.ts';

const SCRIPT = 'sync-board.mjs';

function gitEnv(home: string): NodeJS.ProcessEnv {
    return {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'scenario',
        GIT_AUTHOR_EMAIL: 'scenario@example.invalid',
        GIT_COMMITTER_NAME: 'scenario',
        GIT_COMMITTER_EMAIL: 'scenario@example.invalid',
        // Подмодуль песочницы живёт локальным путём, а `git` запрещает файловый транспорт
        // для подмодулей с CVE-2022-39253. Разрешение задано ОКРУЖЕНИЮ мира, а не коду под
        // тестом: барьер обязан держаться на флагах команды, а не на том, что рекурсия
        // невозможна в принципе. Проба от противного ниже это и доказывает.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.file.allow',
        GIT_CONFIG_VALUE_0: 'always',
    };
}

type World = {
    root: string;
    consumerRoot: string;
    roots: TResolvedRoots;
    git: (cwd: string, ...args: string[]) => string;
    /** Тот самый коллаборатор, что получит боевой вызов: настоящий git по argv. */
    runArgvFn: (file: string, args: string[]) => string;
    logs: string[];
};

const worlds: string[] = [];
afterEach(() => {
    for (const root of worlds.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Мир: голый origin, дерево потребителя на `main` и отдельное дерево «фазы», которое
 * пушит смердженную работу в origin — так же, как это делает мердж PR у форжа.
 */
function buildWorld(): World {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-consumer-')));
    worlds.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const consumerRoot = path.join(root, 'consumer');
    // `stdio` задан явно: по умолчанию execFileSync льёт stderr дочернего процесса в
    // отчёт сьюта, а подсказки git про fast-forward читаются там как падение теста.
    // Сам текст ошибки при этом не теряется — Node кладёт stderr в сообщение исключения,
    // и на нём стоит проба про разошедшийся main.
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf-8',
            env: gitEnv(home),
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

    git(root, 'init', '--quiet', '--bare', '-b', 'main', path.join(root, 'origin.git'));
    fs.mkdirSync(consumerRoot, { recursive: true });
    git(consumerRoot, 'init', '--quiet', '-b', 'main');
    fs.writeFileSync(path.join(consumerRoot, 'README.md'), '# проект потребителя\n');
    git(consumerRoot, 'add', '-A');
    git(consumerRoot, 'commit', '--quiet', '-m', 'дерево потребителя');
    git(consumerRoot, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(consumerRoot, 'push', '--quiet', '-u', 'origin', 'main');

    const logs: string[] = [];
    return {
        root,
        consumerRoot,
        roots: {
            consumerRoot,
            executionRoot: path.join(root, 'consumer-ralph'),
            productRoot: path.join(consumerRoot, '.claude', 'ralph'),
            runtimeDir: path.join(root, 'runtime'),
        },
        git,
        runArgvFn: (file: string, args: string[]): string =>
            execFileSync(file, args, {
                cwd: root,
                encoding: 'utf-8',
                env: gitEnv(home),
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim(),
        logs,
    };
}

/** Смерджить фазу: работа приезжает в origin/main мимо дерева потребителя. */
function mergePhase(w: World, message: string): string {
    const phase = path.join(w.root, 'phase');
    if (!fs.existsSync(phase))
        w.git(w.root, 'clone', '--quiet', path.join(w.root, 'origin.git'), phase);
    fs.writeFileSync(path.join(phase, SCRIPT), `// ${message}\n`);
    w.git(phase, 'add', '-A');
    w.git(phase, 'commit', '--quiet', '-m', message);
    w.git(phase, 'push', '--quiet', 'origin', 'main');
    return w.git(phase, 'rev-parse', 'HEAD');
}

const SUBMODULE = '.claude/ralph';

/**
 * Подключить к дереву потребителя подмодуль-«продукт» и двинуть его ревизию фазой:
 * origin получает коммит с НОВЫМ gitlink, дерево потребителя об этом ещё не знает.
 */
function withAdvancedSubmodule(w: World): { oldSha: string; newSha: string } {
    const productGit = path.join(w.root, 'product.git');
    const productWork = path.join(w.root, 'product-work');
    w.git(w.root, 'init', '--quiet', '--bare', '-b', 'main', productGit);
    w.git(w.root, 'clone', '--quiet', productGit, productWork);
    fs.writeFileSync(path.join(productWork, 'core.ts'), '// продукт, версия 1\n');
    w.git(productWork, 'add', '-A');
    w.git(productWork, 'commit', '--quiet', '-m', 'продукт v1');
    w.git(productWork, 'push', '--quiet', 'origin', 'main');
    const oldSha = w.git(productWork, 'rev-parse', 'HEAD');

    w.git(w.consumerRoot, 'submodule', 'add', '--quiet', productGit, SUBMODULE);
    w.git(w.consumerRoot, 'commit', '--quiet', '-m', 'подключён продукт');
    w.git(w.consumerRoot, 'push', '--quiet', 'origin', 'main');

    // Новая ревизия продукта и фазовый коммит, который двигает на неё gitlink.
    fs.writeFileSync(path.join(productWork, 'core.ts'), '// продукт, версия 2\n');
    w.git(productWork, 'add', '-A');
    w.git(productWork, 'commit', '--quiet', '-m', 'продукт v2');
    w.git(productWork, 'push', '--quiet', 'origin', 'main');
    const newSha = w.git(productWork, 'rev-parse', 'HEAD');

    const phase = path.join(w.root, 'phase-sub');
    w.git(w.root, 'clone', '--quiet', path.join(w.root, 'origin.git'), phase);
    // Двигаем ТОЛЬКО указатель: выкачивать подмодуль в дерево фазы незачем.
    w.git(phase, 'update-index', '--cacheinfo', `160000,${newSha},${SUBMODULE}`);
    w.git(phase, 'commit', '--quiet', '-m', 'продукт обновлён фазой');
    w.git(phase, 'push', '--quiet', 'origin', 'main');

    // Потребитель включает рекурсию у себя — барьер обязан выстоять ПРОТИВ его конфига.
    w.git(w.consumerRoot, 'config', 'fetch.recurseSubmodules', 'yes');
    w.git(w.consumerRoot, 'config', 'submodule.recurse', 'true');
    return { oldSha, newSha };
}

/** Есть ли объект в хранилище подмодуля: он и означает «fetch туда заходил». */
function submoduleHas(w: World, sha: string): boolean {
    try {
        w.git(path.join(w.consumerRoot, SUBMODULE), 'cat-file', '-e', `${sha}^{commit}`);
        return true;
    } catch {
        return false;
    }
}

const run = (w: World) =>
    updateConsumerTree(w.roots, { runArgvFn: w.runArgvFn, logFn: (m) => w.logs.push(m) });

describe('дерево потребителя после мерджа фазы', () => {
    it('смердженный коммит доезжает: скрипт фазы появляется там, куда заякорен путь', () => {
        const w = buildWorld();
        const sha = mergePhase(w, 'скрипт синка доски приехал фазой');
        // До обновления скрипта в дереве потребителя нет — иначе проверка была бы
        // тождеством: файл, лежавший там изначально, «доехал» бы и без раннера.
        expect(fs.existsSync(path.join(w.consumerRoot, SCRIPT))).toBe(false);

        expect(run(w)).toBe('updated');

        expect(fs.existsSync(path.join(w.consumerRoot, SCRIPT))).toBe(true);
        expect(w.git(w.consumerRoot, 'rev-parse', 'HEAD')).toBe(sha);
        // Ветка человека осталась веткой: ff-merge, а не detach, как у дерева раннера.
        expect(w.git(w.consumerRoot, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
        // Служебный ref за собой убран: оставленный, он держал бы старую историю
        // GC-корнем в репозитории человека (ревью, 3-й проход).
        expect(() =>
            w.git(w.consumerRoot, 'rev-parse', '--verify', 'refs/ralph/consumer-main'),
        ).toThrow();
    });

    it('грязное дерево остаётся ровно таким, каким его оставил человек', () => {
        const w = buildWorld();
        fs.writeFileSync(path.join(w.consumerRoot, 'README.md'), '# правка человека\n');
        const before = w.git(w.consumerRoot, 'rev-parse', 'HEAD');
        mergePhase(w, 'скрипт синка доски приехал фазой');

        expect(run(w)).toBe('dirty');

        expect(w.git(w.consumerRoot, 'rev-parse', 'HEAD')).toBe(before);
        expect(fs.existsSync(path.join(w.consumerRoot, SCRIPT))).toBe(false);
        expect(fs.readFileSync(path.join(w.consumerRoot, 'README.md'), 'utf-8')).toBe(
            '# правка человека\n',
        );
        expect(w.logs.join('\n')).toContain(w.consumerRoot);
    });

    it('состояние раннера под consumerRoot грязью не считается — обновление идёт', () => {
        // Раскладка по умолчанию: `runtimeDir` внутри дерева потребителя и не
        // версионирован. Проба закрывает ровно тот способ сломать задачу молча — счесть
        // untracked грязью и не обновлять НИКОГДА, оставаясь зелёным на фикстурах.
        const w = buildWorld();
        const runtime = path.join(w.consumerRoot, '.ralph', 'runtime', 'prod');
        fs.mkdirSync(runtime, { recursive: true });
        fs.writeFileSync(path.join(runtime, 'ralph.state.json'), '{"count":3}\n');
        const sha = mergePhase(w, 'скрипт синка доски приехал фазой');

        expect(run(w)).toBe('updated');

        expect(w.git(w.consumerRoot, 'rev-parse', 'HEAD')).toBe(sha);
        // Состояние петли обновление не тронуло — иначе цена была бы выше пользы.
        expect(fs.readFileSync(path.join(runtime, 'ralph.state.json'), 'utf-8')).toBe(
            '{"count":3}\n',
        );
    });

    it('подмодуль продукта не тронут — даже когда рекурсию включил сам потребитель', () => {
        // Дефолт `fetch.recurseSubmodules` — `on-demand`, а здесь у потребителя стоит `yes`
        // и `submodule.recurse=true`: мир настроен максимально враждебно обещанию «продукт
        // не трогаем». Держат его только флаги самой команды (ревью, 1-й и 2-й проходы).
        const w = buildWorld();
        const { oldSha, newSha } = withAdvancedSubmodule(w);

        expect(run(w)).toBe('updated');

        // Сам gitlink в индексе доехал — фаза применена…
        expect(w.git(w.consumerRoot, 'ls-tree', 'HEAD', SUBMODULE)).toContain(newSha);
        // …а рабочее дерево подмодуля и его хранилище остались нетронутыми.
        expect(w.git(path.join(w.consumerRoot, SUBMODULE), 'rev-parse', 'HEAD')).toBe(oldSha);
        expect(
            submoduleHas(w, newSha),
            'fetch зашёл в подмодуль: объект новой ревизии продукта оказался в его хранилище',
        ).toBe(false);
    });

    it('от противного: с рекурсией объект в подмодуль ПРИЕЗЖАЕТ — мир на неё способен', () => {
        // Без этой пробы предыдущая доказывала бы тождество: подмодуль, в который нельзя
        // зайти в принципе, «не тронут» при любом коде.
        const w = buildWorld();
        const { newSha } = withAdvancedSubmodule(w);
        expect(submoduleHas(w, newSha)).toBe(false);

        w.git(w.consumerRoot, 'fetch', '--recurse-submodules=yes', 'origin', 'main');

        expect(submoduleHas(w, newSha)).toBe(true);
    });

    it('разошедшийся main не сливается: локальный коммит человека на месте', () => {
        const w = buildWorld();
        fs.writeFileSync(path.join(w.consumerRoot, 'local.md'), 'работа человека\n');
        w.git(w.consumerRoot, 'add', '-A');
        w.git(w.consumerRoot, 'commit', '--quiet', '-m', 'локальный коммит человека');
        const local = w.git(w.consumerRoot, 'rev-parse', 'HEAD');
        mergePhase(w, 'скрипт синка доски приехал фазой');

        expect(run(w)).toBe('failed');

        expect(w.git(w.consumerRoot, 'rev-parse', 'HEAD')).toBe(local);
        expect(fs.existsSync(path.join(w.consumerRoot, SCRIPT))).toBe(false);
        expect(w.logs.join('\n')).toMatch(/pull --ff-only/);
    });
});

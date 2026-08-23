// Приёмочный сценарий постановки дерева на ветку фазы (канон, задача 11).
//
// Юниты рядом с модулем (`core/phase-branch.test.ts`) проверяют КОНТРАКТ: какие argv и какое
// решение на каждой развилке. Здесь — то, чего фейком не докажешь: что эта последовательность
// действительно оставляет дерево на ветке фазы, что коммит сессии из неё достижим, что пуш
// после «взяли ветку с origin» не отвергается non-ff, и что совет по спасению работы
// ИСПОЛНЯЕТСЯ, а не выглядит исполнимым.
//
// Последнее — не педантизм: первая версия совета (`git branch <ветка> <sha>`) отказывала в
// штатном случае с `already exists`, и заметил это только настоящий git. Текстовая проба на
// подсказку зелена ровно настолько, насколько верен текст, который в неё вписали.
//
// git здесь НАСТОЯЩИЙ, и это не нарушение предохранителя побочек: `runArgvFn` инжектируется
// тестом и исполняет команды сам, боевой `shArgv` (тот, что под guard'ом) не зовётся вовсе.
// Приём тот же, что у соседнего сценария обновления дерева потребителя.
//
// Окружение git — своё, а не унаследованное: `GIT_DIR`/`GIT_WORK_TREE` вызывающего увели бы
// коммиты в ЕГО репозиторий, а глобальный конфиг подсунул бы чужие хуки процессу с полным
// окружением сьюта.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensurePhaseBranch, checkOnPhaseBranch } from '../core/phase-branch.ts';

const BRANCH = 'feature/faza-1';

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
    };
}

type World = {
    root: string;
    /** Дерево РАБОТЫ раннера: то самое, которое ставится на ветку фазы. */
    work: string;
    git: (cwd: string, ...args: string[]) => string;
    logs: string[];
    deps: Parameters<typeof ensurePhaseBranch>[1];
};

const worlds: string[] = [];
afterEach(() => {
    for (const root of worlds.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Мир: голый origin с `main`, дерево работы в detached HEAD на `origin/main` — ровно в том
 * состоянии, в каком раннер оставляет его после парковки, и с которого начинается итерация.
 */
function buildWorld(): World {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-phase-branch-')));
    worlds.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');

    // `stdio` задан явно: по умолчанию execFileSync льёт stderr дочернего процесса в отчёт
    // сьюта, и подсказки git читаются там как падение теста. Текст ошибки не теряется —
    // Node кладёт stderr в сообщение исключения, и на нём стоят пробы про отказы.
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', args, {
            cwd,
            encoding: 'utf-8',
            env: gitEnv(home),
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

    git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
    const seed = path.join(root, 'seed');
    git(root, 'clone', '--quiet', origin, seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# проект\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'первый коммит');
    git(seed, 'push', '--quiet', 'origin', 'main');

    git(root, 'clone', '--quiet', origin, work);
    // Дерево раннера живёт в detached HEAD (#77): локальный `main` — ветка человека.
    git(work, 'checkout', '--quiet', '--detach', 'origin/main');
    git(work, 'branch', '--quiet', '-D', 'main');

    const logs: string[] = [];
    return {
        root,
        work,
        git,
        logs,
        deps: {
            // Окружение берём ИЗ ОПЦИЙ, когда модуль их передал: иначе проба на запрет
            // интерактивного запроса кредов доказывала бы чистоплотность теста, а не кода.
            runArgvFn: (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): string =>
                execFileSync(file, args, {
                    cwd: work,
                    encoding: 'utf-8',
                    env: { ...gitEnv(home), ...(opts?.env ?? {}) },
                    stdio: ['ignore', 'pipe', 'pipe'],
                }).trim(),
            logFn: (m: string) => logs.push(m),
            safeBranch: () => true,
            env: gitEnv(home),
        },
    };
}

/** Ветка фазы, уже лежащая на origin: так выглядит работа прошлой сессии на другой машине. */
function pushBranchToOrigin(w: World, message: string): string {
    const other = path.join(w.root, `other-${message.replace(/\W+/g, '-')}`);
    if (!fs.existsSync(other))
        w.git(w.root, 'clone', '--quiet', path.join(w.root, 'origin.git'), other);
    const exists = w.git(other, 'ls-remote', '--heads', 'origin', BRANCH) !== '';
    w.git(other, 'checkout', '--quiet', ...(exists ? [BRANCH] : ['-b', BRANCH, 'origin/main']));
    fs.writeFileSync(path.join(other, `${message}.txt`), `${message}\n`);
    w.git(other, 'add', '-A');
    w.git(other, 'commit', '--quiet', '-m', message);
    w.git(other, 'push', '--quiet', 'origin', BRANCH);
    return w.git(other, 'rev-parse', 'HEAD');
}

/** Что сделала бы сессия: коммит в текущем состоянии дерева. */
function sessionCommits(w: World, message: string): string {
    fs.writeFileSync(path.join(w.work, `${message}.txt`), `${message}\n`);
    w.git(w.work, 'add', '-A');
    w.git(w.work, 'commit', '--quiet', '-m', message);
    return w.git(w.work, 'rev-parse', 'HEAD');
}

const headBranch = (w: World): string => {
    try {
        return w.git(w.work, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    } catch {
        return '';
    }
};

/** Предок ли `ancestor` для `descendant`. Обе пробы ниже — про направление этой стрелки. */
const isAncestor = (w: World, ancestor: string, descendant: string): boolean => {
    try {
        w.git(w.work, 'merge-base', '--is-ancestor', ancestor, descendant);
        return true;
    } catch {
        return false;
    }
};

/** Достижим ли коммит из ветки — тот самый вопрос, ради которого задача и заведена. */
const reachableFrom = (w: World, branch: string, sha: string): boolean =>
    isAncestor(w, sha, branch);

/**
 * Пройдёт ли `git merge --ff-only <sha>` из ветки. Направление здесь ОБРАТНОЕ достижимости,
 * и на этом уже поймались: ff возможен, когда ВЕТКА предок коммита, а проба на «коммит не
 * достижим из ветки» остаётся зелёной и у ветки, которая просто отстала (ревью, 6-й проход;
 * проверено живым git — там ff проходит с кодом 0).
 */
const ffPossible = (w: World, branch: string, sha: string): boolean => isAncestor(w, branch, sha);

describe('ensurePhaseBranch на настоящем git', () => {
    it('ветки нет нигде: дерево встаёт на неё, и коммит сессии из неё достижим', () => {
        const w = buildWorld();

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe('created');
        expect(headBranch(w)).toBe(BRANCH);
        // Ровно то, чего не было до задачи 11: коммит сессии не висит на detached HEAD.
        const sha = sessionCommits(w, 'rabota-sessii');
        expect(reachableFrom(w, BRANCH, sha)).toBe(true);
    });

    it('ветка есть на origin, локального ref нет: берётся ЕЁ история, и пуш проходит', () => {
        const w = buildWorld();
        const remote = pushBranchToOrigin(w, 'proshlaia-sessiia');

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe('adopted');
        // История прошлой сессии на месте — значит ветку взяли, а не завели заново.
        expect(reachableFrom(w, BRANCH, remote)).toBe(true);
        sessionCommits(w, 'novaia-rabota');
        // Главная проба сценария: заведи мы ветку заново от origin/main, здесь был бы
        // non-fast-forward — и до force-push доходить нельзя.
        expect(() => w.git(w.work, 'push', '--quiet', 'origin', BRANCH)).not.toThrow();
    });

    it('ветка есть и там и там: origin ушёл вперёд — подтягивается ff', () => {
        const w = buildWorld();
        pushBranchToOrigin(w, 'pervaia');
        ensurePhaseBranch(BRANCH, w.deps);
        const ahead = pushBranchToOrigin(w, 'vtoraia');

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe('fast-forwarded');
        expect(reachableFrom(w, BRANCH, ahead)).toBe(true);
    });

    it('ff-проба различает направление: отставшая ветка — это ff, а не отказ', () => {
        const w = buildWorld();
        ensurePhaseBranch(BRANCH, w.deps);
        const behind = w.git(w.work, 'rev-parse', 'HEAD');
        const ahead = sessionCommits(w, 'ushli-vperiod');
        w.git(w.work, 'update-ref', `refs/heads/${BRANCH}`, behind);

        // На РАСХОДЯЩЕМСЯ графе обе стрелки дают false, и перевёрнутый вариант там зелен
        // по совпадению (ревью, 7-й проход). Здесь граф линейный, и направление видно:
        // ветка — предок коммита, значит ff возможен.
        expect(ffPossible(w, BRANCH, ahead)).toBe(true);
        expect(reachableFrom(w, BRANCH, ahead)).toBe(false);
    });

    it('локальная ветка разошлась с origin: отказ, и чужая история не переписана', () => {
        const w = buildWorld();
        pushBranchToOrigin(w, 'obshchaia');
        ensurePhaseBranch(BRANCH, w.deps);
        const mine = sessionCommits(w, 'moia-vetka');
        const theirs = pushBranchToOrigin(w, 'chuzhaia');

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe('diverged');
        // Локальная голова осталась своей: ни отката, ни перезаписи истории.
        expect(w.git(w.work, 'rev-parse', BRANCH)).toBe(mine);
        expect(reachableFrom(w, BRANCH, theirs)).toBe(false);
        // И ЧУЖАЯ история на origin тоже: без этой пробы мутант с force-push остался бы
        // зелёным, а заявление «чужую историю не переписываем» — недоказанным.
        expect(w.git(w.work, 'ls-remote', 'origin', BRANCH).split(/\s/)[0]).toBe(theirs);
    });

    it('origin недоступен: отказ до единой мутации, дерево остаётся как было', () => {
        const w = buildWorld();
        w.git(w.work, 'remote', 'set-url', 'origin', path.join(w.root, 'net-takogo.git'));
        const before = w.git(w.work, 'rev-parse', 'HEAD');
        // Снимок ВСЕХ ref'ов, а не только HEAD: «ни одной мутации» про созданный ref тоже,
        // а по одному HEAD заведённая впустую ветка осталась бы незамеченной.
        const refsBefore = w.git(w.work, 'for-each-ref', '--format=%(refname) %(objectname)');

        const res = ensurePhaseBranch(BRANCH, w.deps);

        expect(res.kind).toBe('failed');
        expect(headBranch(w)).toBe('');
        expect(w.git(w.work, 'rev-parse', 'HEAD')).toBe(before);
        expect(w.git(w.work, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
    });
});

describe('checkOnPhaseBranch на настоящем git', () => {
    it('дерево на ветке фазы — молчит', () => {
        const w = buildWorld();
        ensurePhaseBranch(BRANCH, w.deps);
        sessionCommits(w, 'rabota');

        expect(checkOnPhaseBranch(BRANCH, w.deps).ok).toBe(true);
    });

    it('сессия ушла в detached HEAD: отказ, и СОВЕТ ИЗ СООБЩЕНИЯ спасает работу', () => {
        const w = buildWorld();
        ensurePhaseBranch(BRANCH, w.deps);
        // Так и выглядел инцидент: сессия увела дерево и закоммитила вне ветки.
        w.git(w.work, 'checkout', '--quiet', '--detach', 'HEAD');
        const lost = sessionCommits(w, 'poteriannaia-rabota');

        const res = checkOnPhaseBranch(BRANCH, w.deps);

        expect(res.ok).toBe(false);
        expect(res.sha).toBe(lost);
        expect(reachableFrom(w, BRANCH, lost)).toBe(false);

        // Совет исполняем БУКВАЛЬНО из текста сообщения: он и есть то, что человек
        // скопирует в терминал. Первая команда — закрепление ref'ом, и спрос с неё
        // главный: именно она снимает работу с-под gc.
        const pin = /git update-ref (\S+) ([0-9a-f]{40,64})/.exec(res.message ?? '');
        expect(pin).not.toBeNull();
        // Порядок команд в сообщении — часть совета: закрепление идёт первым, потому что
        // слияние падает на грязном дереве. Регексп порядка не видит, поэтому он тут же.
        expect((res.message ?? '').indexOf('git update-ref ')).toBeLessThan(
            (res.message ?? '').indexOf('git switch '),
        );
        const [, rescueRef, pinned] = pin as RegExpExecArray;
        expect(() =>
            w.git(w.work, 'update-ref', rescueRef as string, pinned as string),
        ).not.toThrow();
        expect(reachableFrom(w, rescueRef as string, lost)).toBe(true);
        // Идемпотентность — не украшение: человек повторяет команду, не помня, делал ли её,
        // и `already exists` на этом месте оставил бы работу под gc.
        expect(() =>
            w.git(w.work, 'update-ref', rescueRef as string, pinned as string),
        ).not.toThrow();

        // Вторая — слияние в ветку фазы; здесь дерево чистое, значит проходит и она.
        const merge = /git switch (\S+) && git merge ([0-9a-f]{40,64})/.exec(res.message ?? '');
        expect(merge).not.toBeNull();
        const [, branch, sha] = merge as RegExpExecArray;
        expect(() => w.git(w.work, 'switch', '--quiet', branch as string)).not.toThrow();
        expect(() => w.git(w.work, 'merge', '--no-edit', sha as string)).not.toThrow();
        expect(reachableFrom(w, BRANCH, lost)).toBe(true);
    });

    it("закрепление ref'ом идёт и там, где слияние заведомо упало бы", () => {
        const w = buildWorld();
        ensurePhaseBranch(BRANCH, w.deps);
        w.git(w.work, 'checkout', '--quiet', '--detach', 'HEAD');
        const lost = sessionCommits(w, 'rabota-vne-vetki');

        // Худшее состояние, и оно же частое: ветка УЕХАЛА своей дорогой (ff невозможен —
        // проверено ниже), а сессия вдобавок оставила незакоммиченную правку того же файла.
        // На таком дереве `git switch` отказывает с `Your local changes would be
        // overwritten`, то есть совет, ведущий со слияния, не начался бы вовсе.
        w.git(w.work, 'switch', '--quiet', '--detach', 'origin/main');
        w.git(w.work, 'branch', '--quiet', '--force', BRANCH, 'HEAD');
        w.git(w.work, 'switch', '--quiet', BRANCH);
        fs.writeFileSync(path.join(w.work, 'rabota-vne-vetki.txt'), 'чужая правка\n');
        w.git(w.work, 'add', '-A');
        w.git(w.work, 'commit', '--quiet', '-m', 'ветка ушла своей дорогой');
        w.git(w.work, 'switch', '--quiet', '--detach', lost);
        fs.writeFileSync(path.join(w.work, 'rabota-vne-vetki.txt'), 'незакоммиченное\n');

        // Условие «ff не проходит» ДОКАЗЫВАЕТСЯ, а не заявляется: прошлая версия этой
        // пробы откатывала ветку к предку `lost`, где ff как раз проходил, — и была
        // зелёной, ничего не проверяя (ревью, 5-й проход).
        expect(ffPossible(w, BRANCH, lost)).toBe(false);
        expect(reachableFrom(w, BRANCH, lost)).toBe(false);
        expect(() => w.git(w.work, 'switch', '--quiet', BRANCH)).toThrow();

        const res = checkOnPhaseBranch(BRANCH, w.deps);
        const pin = /git update-ref (\S+) ([0-9a-f]{40,64})/.exec(res.message ?? '');

        expect(pin).not.toBeNull();
        const [, rescueRef, sha] = pin as RegExpExecArray;
        // Имя ref'а от имени ветки не зависит вовсе — значит и от её длины тоже.
        expect(rescueRef).toBe(`refs/ralph/rescue-${lost}`);
        expect(() => w.git(w.work, 'update-ref', rescueRef as string, sha as string)).not.toThrow();
        expect(reachableFrom(w, rescueRef as string, lost)).toBe(true);
    });

    it('закрепление проходит, даже когда ref refs/ralph/rescue уже занят', () => {
        const w = buildWorld();
        ensurePhaseBranch(BRANCH, w.deps);
        w.git(w.work, 'checkout', '--quiet', '--detach', 'HEAD');
        const lost = sessionCommits(w, 'rabota');
        // Занятый `refs/ralph/rescue` — тот самый D/F-конфликт: вложенному имени
        // `rescue/<sha>` нужен каталог с этим именем, и git отказывает на локе
        // (`'refs/ralph/rescue' exists; cannot create …`, код 128 — проверено живым git).
        // Отказ здесь означает не закрепить коммит ровно тогда, когда он под gc.
        // Занятый ref смотрит на ДРУГОЙ коммит: иначе проба не отличила бы соседний
        // плоский ref от перезаписи самого `refs/ralph/rescue` (ревью, 9-й проход).
        const alien = w.git(w.work, 'rev-parse', 'origin/main');
        w.git(w.work, 'update-ref', 'refs/ralph/rescue', alien);

        const res = checkOnPhaseBranch(BRANCH, w.deps);
        const pin = /git update-ref (refs\/\S+) ([0-9a-f]{40,64})/.exec(res.message ?? '');

        expect(pin).not.toBeNull();
        const [, rescueRef, sha] = pin as RegExpExecArray;
        expect(() => w.git(w.work, 'update-ref', rescueRef as string, sha as string)).not.toThrow();
        expect(reachableFrom(w, rescueRef as string, lost)).toBe(true);
        // Чужой ref не тронут — закрепление легло СОСЕДНИМ именем, а не поверх него.
        expect(w.git(w.work, 'rev-parse', 'refs/ralph/rescue')).toBe(alien);
    });

    it('спасение второго инцидента не спотыкается о ref первого', () => {
        const w = buildWorld();
        ensurePhaseBranch(BRANCH, w.deps);
        const refs: string[] = [];
        for (const n of ['pervyi', 'vtoroi']) {
            w.git(w.work, 'switch', '--quiet', BRANCH);
            w.git(w.work, 'checkout', '--quiet', '--detach', 'HEAD');
            sessionCommits(w, `intsident-${n}`);
            const pin = /git update-ref (\S+) ([0-9a-f]{40,64})/.exec(
                checkOnPhaseBranch(BRANCH, w.deps).message ?? '',
            ) as RegExpExecArray;
            expect(() =>
                w.git(w.work, 'update-ref', pin[1] as string, pin[2] as string),
            ).not.toThrow();
            refs.push(pin[1] as string);
        }
        // Два инцидента — два разных ref'а: имя несёт sha. Общее имя `<ветка>-rescue`
        // отказало бы на втором с `already exists`, оставив работу под gc (ревью, 5-й
        // проход); `update-ref` не отказал бы и там, но затёр бы первое спасение.
        expect(refs[0]).not.toBe(refs[1]);
    });
});

// Юнит-тесты модуля worktree-менеджмента (#360). Основная часть проверяет САМУ фабрику
// createWorktreeManager — что она собирает рабочие функции из синтетического env,
// независимо от ralph.js: контракт extraction'а — модуль самодостаточен и переносим
// (цель фазы 2), а не «работает только пока его зовёт ralph.js». Проход «через
// ре-экспорт ralph.js» с боевым контекстом раннера — в lock-scenarios.test.ts и в
// блоках в конце этого файла, перенесённых из ralph.test.js при её разнесении по
// модульным тест-файлам (#366).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorktreeEnv } from './worktree.ts';
import { createWorktreeManager } from './worktree.ts';
import { GIT_NETWORK_TIMEOUT_MS } from '../shared/ralph-util.ts';
// @ts-expect-error — JS-entry раннера без деклараций типов; блоки в конце файла
// перенесены из ralph.test.js как есть и ходят через его ре-экспорт (#366).
import ralph from '../ralph.js';

// Платформенное: тест опирается на POSIX-механизмы, которых на Windows нет
// (/proc/<pid>/cmdline, пути соседнего worktree, /bin/sh). Раннер живёт на
// Linux-VPS, поэтому пометка, а не вторая реализация — грабля 7 в
// docs/ralph-runner/portability-log.md. Снять вместе с платформенным швом.
const itPosix = it.skipIf(process.platform === 'win32');

// Синтетический env: заглушки-коллабораторы, которые молча падают, если функция под
// тестом их зовёт без явного override, — чтобы забытый override был громкой ошибкой
// теста, а не тихим проходом через боевой sh/log.
function makeEnv(over: Partial<WorktreeEnv> = {}): WorktreeEnv {
    return {
        sh: () => {
            throw new Error('sh не подменён в тесте');
        },
        shArgv: () => {
            throw new Error('shArgv не подменён в тесте');
        },
        shq: (s: string) => `'${s.replace(/'/g, `'\\''`)}'`,
        log: () => {},
        fail: (msg: string) => {
            throw new Error(msg);
        },
        guardSideEffect: () => {},
        buildSanitizedGateEnv: () => ({ PATH: '/x' }),
        writeLockMarker: () => {},
        // #204: команда установки — из конфига (дефолт `npm ci`).
        getInstallCmd: () => 'npm ci',
        ...over,
    };
}

describe('resolveWorktreePath — путь выделенного worktree раннера (#76)', () => {
    // RALPH_WORKTREE_PATH — боевая env-переменная раннера (на VDS в ralph.env). Если она
    // задана в окружении прогона, override перебил бы дефолт/относительный резолв и тесты
    // ниже легли бы ложно. Чистим перед каждым; тесты, которые сами её ставят,
    // восстанавливают своё значение в finally.
    beforeEach(() => {
        delete process.env.RALPH_WORKTREE_PATH;
    });

    itPosix(
        'дефолт: сосед репозитория, имя выведено из basename(repoRoot) + "-ralph" (#204)',
        () => {
            const { resolveWorktreePath } = createWorktreeManager(makeEnv());
            expect(resolveWorktreePath({}, '/path/to/app')).toBe('/path/to/app-ralph');
            // Портируемость: другое имя репо → другое имя дерева, без правки кода.
            expect(resolveWorktreePath({}, '/srv/acme-app')).toBe('/srv/acme-app-ralph');
        },
    );

    itPosix('#204: cfg.runnerWorktreeDirname важнее выведенного дефолта', () => {
        const { resolveWorktreePath } = createWorktreeManager(makeEnv());
        expect(resolveWorktreePath({ runnerWorktreeDirname: 'custom-tree' }, '/path/to/app')).toBe(
            '/path/to/custom-tree',
        );
    });

    itPosix('cfg.runnerWorktreePath — относительный, резолвится от repoRoot', () => {
        const { resolveWorktreePath } = createWorktreeManager(makeEnv());
        expect(resolveWorktreePath({ runnerWorktreePath: '../custom-ralph' }, '/path/to/app')).toBe(
            '/path/to/custom-ralph',
        );
    });

    itPosix('RALPH_WORKTREE_PATH (env) используется, если cfg пуст', () => {
        const prev = process.env.RALPH_WORKTREE_PATH;
        process.env.RALPH_WORKTREE_PATH = '/tmp/ralph-worktree';
        try {
            const { resolveWorktreePath } = createWorktreeManager(makeEnv());
            expect(resolveWorktreePath({}, '/path/to/app')).toBe('/tmp/ralph-worktree');
        } finally {
            if (prev === undefined) delete process.env.RALPH_WORKTREE_PATH;
            else process.env.RALPH_WORKTREE_PATH = prev;
        }
    });

    itPosix('cfg.runnerWorktreePath важнее RALPH_WORKTREE_PATH', () => {
        const prev = process.env.RALPH_WORKTREE_PATH;
        process.env.RALPH_WORKTREE_PATH = '/tmp/from-env';
        try {
            const { resolveWorktreePath } = createWorktreeManager(makeEnv());
            expect(
                resolveWorktreePath({ runnerWorktreePath: '/tmp/from-config' }, '/path/to/app'),
            ).toBe('/tmp/from-config');
        } finally {
            if (prev === undefined) delete process.env.RALPH_WORKTREE_PATH;
            else process.env.RALPH_WORKTREE_PATH = prev;
        }
    });
});

describe('parseWorktreeList — парсинг `git worktree list --porcelain`', () => {
    it('собирает все строки "worktree <путь>" из блоков', () => {
        const { parseWorktreeList } = createWorktreeManager(makeEnv());
        const raw =
            'worktree /path/to/app\nHEAD abc\nbranch refs/heads/main\n\n' +
            'worktree /path/to/app-ralph\nHEAD def\ndetached\n';
        expect(parseWorktreeList(raw)).toEqual(['/path/to/app', '/path/to/app-ralph']);
    });

    it('пустой вывод → пустой массив', () => {
        const { parseWorktreeList } = createWorktreeManager(makeEnv());
        expect(parseWorktreeList('')).toEqual([]);
    });
});

describe('runnerWorktreeReady — «дерево раннера уже поднято?» для read-only переезда DRY (#SiaT3)', () => {
    const WT = '/path/to/app-ralph';

    it('зарегистрирован И папка на месте → true', () => {
        const { runnerWorktreeReady } = createWorktreeManager(makeEnv());
        const shFn = () => `worktree ${WT}\nHEAD abc\n`;
        const existsFn = () => true;
        expect(runnerWorktreeReady(WT, { shFn, existsFn: existsFn as never })).toBe(true);
    });

    it('зарегистрирован, но папки нет → false', () => {
        const { runnerWorktreeReady } = createWorktreeManager(makeEnv());
        const shFn = () => `worktree ${WT}\nHEAD abc\n`;
        const existsFn = () => false;
        expect(runnerWorktreeReady(WT, { shFn, existsFn: existsFn as never })).toBe(false);
    });

    it('git worktree list упал → false, не бросает', () => {
        const { runnerWorktreeReady } = createWorktreeManager(makeEnv());
        const shFn = () => {
            throw new Error('git недоступен');
        };
        expect(runnerWorktreeReady(WT, { shFn })).toBe(false);
    });

    it('не зарегистрирован, но папка есть → false', () => {
        const { runnerWorktreeReady } = createWorktreeManager(makeEnv());
        const shFn = () => 'worktree /path/to/app\nHEAD abc\n';
        expect(runnerWorktreeReady(WT, { shFn, existsFn: (() => true) as never })).toBe(false);
    });
});

describe('refreshRunnerWorktree — перевод дерева раннера на свежий origin/main (#252)', () => {
    it('чистое дерево → fetch + checkout --detach через argv, true', () => {
        const { refreshRunnerWorktree } = createWorktreeManager(makeEnv());
        const calls: Array<[string, string[]]> = [];
        const shFn = () => '';
        const prompts: Array<string | undefined> = [];
        const runArgvFn = (
            file: string,
            args: string[],
            opts?: { env?: Record<string, string | undefined> },
        ) => {
            calls.push([file, args]);
            prompts.push(opts?.env?.GIT_TERMINAL_PROMPT);
            return '';
        };
        const ok = refreshRunnerWorktree('/tmp/wt', { shFn, runArgvFn, logFn: () => {} });
        expect(ok).toBe(true);
        expect(calls).toEqual([
            ['git', ['-C', '/tmp/wt', 'fetch', 'origin', 'main', '--quiet']],
            ['git', ['-C', '/tmp/wt', 'checkout', '--detach', 'origin/main', '--quiet']],
        ]);
        // Сетевой здесь только fetch — ему и запрет промпта кредов (задача 71).
        expect(prompts).toEqual(['0', undefined]);
    });

    it('грязное дерево → НЕ трогает (fetch/checkout не зовутся), false', () => {
        const { refreshRunnerWorktree } = createWorktreeManager(makeEnv());
        const runArgvFn = vi.fn();
        const shFn = () => ' M some-file.js\n';
        const ok = refreshRunnerWorktree('/tmp/wt', {
            shFn,
            runArgvFn: runArgvFn as never,
            logFn: () => {},
        });
        expect(ok).toBe(false);
        expect(runArgvFn).not.toHaveBeenCalled();
    });

    it('git status упал → false, не бросает', () => {
        const { refreshRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => {
            throw new Error('git недоступен');
        };
        const ok = refreshRunnerWorktree('/tmp/wt', {
            shFn,
            runArgvFn: vi.fn() as never,
            logFn: () => {},
        });
        expect(ok).toBe(false);
    });

    it('fetch/checkout упал → false, не бросает наружу', () => {
        const { refreshRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => '';
        const runArgvFn = () => {
            throw new Error('git fetch упал');
        };
        const ok = refreshRunnerWorktree('/tmp/wt', { shFn, runArgvFn, logFn: () => {} });
        expect(ok).toBe(false);
    });

    it('путь с пробелом квотируется через инжектированный shq в git status', () => {
        const { refreshRunnerWorktree } = createWorktreeManager(makeEnv());
        const seen: string[] = [];
        const shFn = (cmd: string) => {
            seen.push(cmd);
            return '';
        };
        refreshRunnerWorktree('/tmp/wt with space', {
            shFn,
            runArgvFn: () => '',
            logFn: () => {},
        });
        expect(seen[0]).toContain(`'/tmp/wt with space'`);
    });
});

describe('ensureRunnerWorktree — выделенный git worktree раннера, соседний с деревом человека (#76)', () => {
    const WT = '/path/to/app-ralph';
    const REPO = '/path/to/app';

    itPosix('путь внутри репозитория → fail-closed, git не зовём', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = vi.fn();
        expect(() =>
            ensureRunnerWorktree('/path/to/app/nested-ralph', {
                shFn: shFn as never,
                failFn: (msg: string) => {
                    throw new Error(msg);
                },
                repoRoot: REPO,
            }),
        ).toThrow(/внутри репозитория/);
        expect(shFn).not.toHaveBeenCalled();
    });

    it('уже зарегистрирован и папка на месте → переиспользуем, зовём refreshFn', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => `worktree ${WT}\nHEAD abc\n`;
        const existsFn = () => true;
        const refreshFn = vi.fn();
        const trustFn = vi.fn(() => 'already' as const);
        const result = ensureRunnerWorktree(WT, {
            shFn,
            existsFn: existsFn as never,
            refreshFn: refreshFn as never,
            trustFn,
            repoRoot: REPO,
        });
        expect(result).toBe(WT);
        expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    // #576: доверие ставится и на ПЕРЕИСПОЛЬЗОВАНИИ дерева, не только на создании — иначе
    // дерево, поднятое до этой правки, так и осталось бы недоверенным, а кодер-сессия в нём
    // молча теряла бы permissions.allow.
    it('#576: уже поднятое дерево тоже вносится в доверенные', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const trustFn = vi.fn(() => 'written' as const);
        ensureRunnerWorktree(WT, {
            shFn: () => `worktree ${WT}\nHEAD abc\n`,
            existsFn: (() => true) as never,
            refreshFn: (() => true) as never,
            trustFn,
            repoRoot: REPO,
        });
        expect(trustFn).toHaveBeenCalledWith(WT);
    });

    // Симметрия к негативу ветки создания (ниже): именно ветка ПЕРЕИСПОЛЬЗОВАНИЯ
    // отрабатывает на каждом старте боевой петли, и только в ней сразу за trustFn идёт
    // `return worktreePath`. Перестань отказ доверия прорастать наружу здесь — раннер
    // молча продолжил бы в недоверенном дереве, а тесты остались бы зелёными.
    it('#576: доверие не удалось на ПОДНЯТОМ дереве → fail-closed, путь не возвращаем', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const failFn = vi.fn((msg: string) => {
            throw new Error(msg);
        });
        expect(() =>
            ensureRunnerWorktree(WT, {
                shFn: () => `worktree ${WT}\nHEAD abc\n`,
                existsFn: (() => true) as never,
                refreshFn: (() => true) as never,
                trustFn: () => 'failed' as const,
                failFn,
                repoRoot: REPO,
            }),
        ).toThrow(/не внесено в доверенные/);
    });

    // Исход `'failed'` останавливает петлю САМ, не полагаясь на то, что failFn внутри
    // workspace-trust бросил: не-бросающая реализация fail (мок, обёртка) иначе превратила
    // бы fail-closed в fail-open молча — раннер поехал бы ставить зависимости в дерево,
    // сессия в котором осталась без permissions.allow.
    it("#576: исход 'failed' без броска — стоп всё равно, npm ci не зовём", () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const installFn = vi.fn();
        // Мок НЕ бросает и НЕ выходит — ровно та реализация, на которой прежний код
        // (голый вызов trustFn) поехал бы дальше как ни в чём не бывало.
        const failFn = vi.fn((msg: string) => msg);
        const result = ensureRunnerWorktree(WT, {
            shFn: () => '',
            existsFn: (() => false) as never,
            runArgvFn: () => '',
            addFn: () => {},
            trustFn: () => 'failed' as const,
            installFn,
            failFn,
            repoRoot: REPO,
        });
        expect(installFn).not.toHaveBeenCalled();
        expect(result).not.toBe(WT);
        expect(String(failFn.mock.calls[0][0])).toMatch(/permissions\.allow/);
    });

    it('зарегистрирован, но папки нет → fail-closed (ручной rm -rf)', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => `worktree ${WT}\nHEAD abc\n`;
        const existsFn = () => false;
        const failFn = (msg: string) => {
            throw new Error(msg);
        };
        expect(() =>
            ensureRunnerWorktree(WT, { shFn, existsFn: existsFn as never, failFn, repoRoot: REPO }),
        ).toThrow(/rm -rf/);
    });

    it('папка занята посторонним (не зарегистрирован, но существует) → fail-closed', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => 'worktree /path/to/app\nHEAD abc\n';
        const existsFn = () => true;
        const failFn = (msg: string) => {
            throw new Error(msg);
        };
        expect(() =>
            ensureRunnerWorktree(WT, { shFn, existsFn: existsFn as never, failFn, repoRoot: REPO }),
        ).toThrow(/посторонней папкой/);
    });

    it('свежее создание: fetch → add → доверие → npm ci (санированный env) → маркер lock', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => 'worktree /path/to/app\nHEAD abc\n';
        const existsFn = () => false;
        const runArgvFn = vi.fn(() => '');
        const order: string[] = [];
        const addFn = vi.fn(() => void order.push('add'));
        const trustFn = vi.fn(() => {
            order.push('trust');
            return 'written' as const;
        });
        const installFn = vi.fn(() => void order.push('install'));
        const markFn = vi.fn();
        const buildGateEnvFn = () => ({ PATH: '/sanitized' });
        const result = ensureRunnerWorktree(WT, {
            shFn,
            existsFn: existsFn as never,
            runArgvFn: runArgvFn as never,
            addFn,
            trustFn,
            installFn,
            markFn,
            buildGateEnvFn,
            repoRoot: REPO,
        });
        expect(result).toBe(WT);
        // Сетевой вызов — с запретом промпта кредов (задача 71) и сроком (задача 30): без
        // них git ждёт логина на tty или ответа молчащего origin, и петля стоит до дедмана.
        expect(runArgvFn).toHaveBeenCalledWith('git', ['fetch', 'origin', 'main'], {
            env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
            timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        });
        expect(addFn).toHaveBeenCalledWith(WT);
        expect(trustFn).toHaveBeenCalledWith(WT);
        expect(installFn).toHaveBeenCalledWith(WT, { PATH: '/sanitized' });
        expect(markFn).toHaveBeenCalledWith(WT);
        // #576: доверие — тем же действием, что создание, и ДО дорогого npm ci.
        expect(order).toEqual(['add', 'trust', 'install']);
    });

    it('#576: доверие не удалось → fail-closed, npm ci не зовём', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const installFn = vi.fn();
        expect(() =>
            ensureRunnerWorktree(WT, {
                shFn: () => '',
                existsFn: (() => false) as never,
                runArgvFn: () => '',
                addFn: () => {},
                trustFn: () => {
                    throw new Error('конфиг Claude не читается');
                },
                installFn,
                repoRoot: REPO,
            }),
        ).toThrow(/конфиг Claude не читается/);
        expect(installFn).not.toHaveBeenCalled();
    });

    it('git worktree add упал → fail-closed, npm ci не зовём', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => '';
        const existsFn = () => false;
        const installFn = vi.fn();
        const addFn = () => {
            throw new Error('git worktree add упал');
        };
        const failFn = (msg: string) => {
            throw new Error(msg);
        };
        expect(() =>
            ensureRunnerWorktree(WT, {
                shFn,
                existsFn: existsFn as never,
                runArgvFn: () => '',
                addFn,
                installFn,
                failFn,
                repoRoot: REPO,
            }),
        ).toThrow(/git worktree add/);
        expect(installFn).not.toHaveBeenCalled();
    });

    it('санация env (buildGateEnvFn) упала → fail-closed, npm ci не зовём', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => '';
        const existsFn = () => false;
        const installFn = vi.fn();
        const failFn = (msg: string) => {
            throw new Error(msg);
        };
        expect(() =>
            ensureRunnerWorktree(WT, {
                shFn,
                existsFn: existsFn as never,
                runArgvFn: () => '',
                addFn: () => {},
                trustFn: () => 'written' as const,
                installFn,
                buildGateEnvFn: () => {
                    throw new Error('allowlist битый');
                },
                failFn,
                repoRoot: REPO,
            }),
        ).toThrow(/санация env/);
        expect(installFn).not.toHaveBeenCalled();
    });

    it('npm ci (installFn) упал → fail-closed, маркер lock не пишем', () => {
        const { ensureRunnerWorktree } = createWorktreeManager(makeEnv());
        const shFn = () => '';
        const existsFn = () => false;
        const markFn = vi.fn();
        const installFn = () => {
            throw new Error('npm ci упал');
        };
        const failFn = (msg: string) => {
            throw new Error(msg);
        };
        expect(() =>
            ensureRunnerWorktree(WT, {
                shFn,
                existsFn: existsFn as never,
                runArgvFn: () => '',
                addFn: () => {},
                trustFn: () => 'written' as const,
                installFn,
                markFn,
                failFn,
                repoRoot: REPO,
            }),
        ).toThrow(/npm ci/);
        expect(markFn).not.toHaveBeenCalled();
    });
});

// #366: сценарии, которых нет в фабричных тестах выше. Ходят через ре-экспорт ralph.js —
// то есть с боевыми дефолтами резолва пути (env + repoRoot) и боевой раскладкой
// коллабораторов ensureRunnerWorktree.
describe('resolveWorktreePath — относительный путь из env (#SiaUv)', () => {
    const savedEnv = { ...process.env };
    afterEach(() => {
        process.env = { ...savedEnv };
    });

    const { resolveWorktreePath } = ralph;

    itPosix('ОТНОСИТЕЛЬНЫЙ RALPH_WORKTREE_PATH резолвится от repoRoot, а не от cwd вызова', () => {
        process.env.RALPH_WORKTREE_PATH = '../custom';
        expect(resolveWorktreePath({}, '/path/to/app')).toBe('/path/to/custom');
    });
});

describe('ensureRunnerWorktree — сбой чтения списка worktree (#76)', () => {
    // repoRoot фиксируем явно: guard «путь не внутри репозитория» (#SiaUT) иначе бы
    // сверялся с process.cwd() и зависел бы от того, откуда запущен vitest.
    const REPO = '/path/to/app';
    const WT = '/path/to/app-ralph';
    const { ensureRunnerWorktree } = ralph;

    it('git worktree list упал (не git-репо/gh недоступен) → fail-closed, add не вызывается', () => {
        const shFn = vi.fn().mockImplementation(() => {
            throw new Error('not a git repository');
        });
        // Параметр msg объявлен явно (а не проигнорирован) — иначе mock.calls в .ts-файле
        // типизируется пустым кортежем и ассерт на текст сообщения не скомпилируется.
        const failFn = vi.fn((_msg: string) => {
            throw new Error('stopped');
        });
        const addFn = vi.fn();
        expect(() => ensureRunnerWorktree(WT, { shFn, failFn, addFn, repoRoot: REPO })).toThrow(
            'stopped',
        );
        expect(failFn.mock.calls[0][0]).toMatch(/git worktree list/);
        expect(addFn).not.toHaveBeenCalled();
    });
});

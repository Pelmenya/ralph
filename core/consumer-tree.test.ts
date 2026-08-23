// Обновление дерева потребителя после мерджа фазы (канон, задача 28).
//
// Проверяется КОНТРАКТ, а не способность git сливать коммиты: коллаборатор `runArgvFn`
// инжектируется, тест видит точную последовательность argv и решение по каждой развилке.
// Настоящий git — в приёмочном сценарии рядом (`tests/consumer-tree-scenarios.test.ts`):
// там доказывается, что эта последовательность делает то, что обещает.
import { describe, it, expect } from 'vitest';
import { updateConsumerTree, type TConsumerTreeKind } from './consumer-tree.ts';
import type { TResolvedRoots } from './roots.ts';

const CONSUMER = '/path/to/app';
const ROOTS: TResolvedRoots = {
    consumerRoot: CONSUMER,
    executionRoot: '/path/to/app-ralph',
    productRoot: '/path/to/app/.claude/ralph',
    runtimeDir: '/path/to/app/.ralph/runtime/prod',
};

/** Мир, где git отвечает по словарю команд: ключ — argv через пробел, значение — ответ. */
function world(replies: Record<string, string | Error> = {}) {
    const calls: string[][] = [];
    const logs: string[] = [];
    const runArgvFn = (file: string, args: string[]): string => {
        calls.push([file, ...args]);
        // Ключ — хвост argv без `-C <root>`: он одинаков у всех команд и только шумит.
        const key = args.filter((a) => a !== '-C' && a !== CONSUMER).join(' ');
        const reply = replies[key];
        if (reply instanceof Error) throw reply;
        return reply ?? '';
    };
    return {
        calls,
        logs,
        run: (roots: TResolvedRoots | null = ROOTS): TConsumerTreeKind =>
            updateConsumerTree(roots, { runArgvFn, logFn: (m) => logs.push(m) }),
        /** Мутации: всё, что меняет дерево. Их отсутствие — предмет половины проб ниже. */
        mutations: (): string[][] =>
            calls.filter(([, ...args]) => args.includes('merge') || args.includes('fetch')),
    };
}

describe('updateConsumerTree — кто держит дерево потребителя актуальным', () => {
    it('раскладки корней нет — обновлять нечего, ни одной команды', () => {
        // Без `roots` пути скриптов относительны дереву РАБОТЫ, и понятия «дерево
        // потребителя» у раннера в этой раскладке нет вовсе: обновлять нечего.
        const w = world();
        expect(w.run(null)).toBe('no-roots');
        expect(w.calls).toEqual([]);
        expect(w.logs).toEqual([]);
    });

    it('дерево потребителя И ЕСТЬ дерево работы — раннер уже держит его на origin/main', () => {
        const w = world();
        expect(w.run({ ...ROOTS, executionRoot: CONSUMER })).toBe('same-tree');
        expect(w.calls).toEqual([]);
    });

    it('чистое дерево на main: fetch + merge --ff-only, в логе — каталог', () => {
        const w = world({ 'symbolic-ref --quiet --short HEAD': 'main' });
        expect(w.run()).toBe('updated');
        expect(w.calls).toEqual([
            ['git', '-C', CONSUMER, 'status', '--porcelain', '--untracked-files=no'],
            ['git', '-C', CONSUMER, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
            [
                'git',
                '-C',
                CONSUMER,
                '-c',
                'submodule.recurse=false',
                'fetch',
                '--no-recurse-submodules',
                'origin',
                '+refs/heads/main:refs/ralph/consumer-main',
            ],
            // Сливается нафетченное, а не `origin/main`: при нестандартном refspec
            // remote-tracking ref мог не обновиться, и слияние с ним повторило бы прошлое
            // состояние, отчитавшись «обновлено» (ревью, 1-й проход).
            [
                'git',
                '-C',
                CONSUMER,
                '-c',
                'submodule.recurse=false',
                'merge',
                '--ff-only',
                'refs/ralph/consumer-main',
            ],
        ]);
        expect(w.logs.join('\n')).toContain(CONSUMER);
    });

    it('untracked-файлы грязью НЕ считаются — иначе обновления не было бы никогда', () => {
        // `runtimeDir` по умолчанию живёт под `consumerRoot` и не версионируется: считать
        // untracked грязью значило бы не обновлять дерево ровно в той раскладке, ради
        // которой всё написано. Отсюда `--untracked-files=no` в самой команде статуса —
        // тест сторожит именно флаг, а не пустой ответ мира.
        const w = world({ 'symbolic-ref --quiet --short HEAD': 'main' });
        expect(w.run()).toBe('updated');
        expect(w.calls[0]).toContain('--untracked-files=no');
    });

    it('грязное дерево не трогаем и говорим об этом вслух', () => {
        const w = world({
            'status --porcelain --untracked-files=no': ' M src/app.ts',
            'symbolic-ref --quiet --short HEAD': 'main',
        });
        expect(w.run()).toBe('dirty');
        expect(w.mutations()).toEqual([]);
        const log = w.logs.join('\n');
        expect(log).toContain(CONSUMER);
        expect(log).toMatch(/git pull/); // человеку названо, чем закончить самому
    });

    it('дерево на другой ветке — не трогаем, ветка названа', () => {
        const w = world({ 'symbolic-ref --quiet --short HEAD': 'feature/чинить-верстку' });
        expect(w.run()).toBe('off-main');
        expect(w.mutations()).toEqual([]);
        expect(w.logs.join('\n')).toContain('feature/чинить-верстку');
    });

    it('detached HEAD (symbolic-ref отказал) — тоже не трогаем', () => {
        const w = world({
            'symbolic-ref --quiet --short HEAD': new Error('код 1'),
        });
        expect(w.run()).toBe('off-main');
        expect(w.mutations()).toEqual([]);
        expect(w.logs.join('\n')).toMatch(/detached|не на ветке/i);
    });

    it('ff-only не прошёл (дерево разошлось) — best-effort: лог с причиной, без броска', () => {
        const w = world({
            'symbolic-ref --quiet --short HEAD': 'main',
            '-c submodule.recurse=false merge --ff-only refs/ralph/consumer-main': new Error(
                'Not possible to fast-forward',
            ),
        });
        let kind: TConsumerTreeKind | null = null;
        expect(() => {
            kind = w.run();
        }).not.toThrow();
        expect(kind).toBe('failed');
        const log = w.logs.join('\n');
        expect(log).toContain('Not possible to fast-forward');
        expect(log).toContain(CONSUMER);
    });

    it('git status не отработал — «не знаю» трактуем как «не трогать»', () => {
        const w = world({
            'status --porcelain --untracked-files=no': new Error('not a git repository'),
        });
        expect(w.run()).toBe('failed');
        expect(w.mutations()).toEqual([]);
    });

    it('в подмодули не рекурсирует — и запрет ЯВНЫЙ, а не «мы не просили»', () => {
        // Каталог продукта у потребителя — подмодуль внутри `consumerRoot`, и его код
        // подменяет lifecycle-операция launcher'а, а не побочка соседнего обновления.
        // Проба сторожит ЗАПРЕТ, а не отсутствие слова: дефолт `fetch.recurseSubmodules`
        // — `on-demand`, то есть молчание здесь означало бы «рекурсируем» (ревью, 1-й
        // проход). Вторая половина — `submodule.recurse` потребителя: его в конфиге может
        // включить он сам, и тогда в подмодуль полез бы ещё и merge.
        const w = world({ 'symbolic-ref --quiet --short HEAD': 'main' });
        w.run();
        const fetch = w.calls.find((c) => c.includes('fetch'));
        expect(fetch).toContain('--no-recurse-submodules');
        for (const call of w.calls.filter((c) => c.includes('fetch') || c.includes('merge'))) {
            expect(call.join(' ')).toContain('-c submodule.recurse=false');
        }
    });
});

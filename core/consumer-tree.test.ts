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
const REF = 'refs/ralph/consumer-main';
const SHA = 'a'.repeat(40);
const ROOTS: TResolvedRoots = {
    consumerRoot: CONSUMER,
    executionRoot: '/path/to/app-ralph',
    productRoot: '/path/to/app/.claude/ralph',
    runtimeDir: '/path/to/app/.ralph/runtime/prod',
};

const BRANCH_ARGS = ['symbolic-ref', '--quiet', '--short', 'HEAD'];
const BRANCH_KEY = BRANCH_ARGS.join(' ');

/**
 * Мир, где git отвечает по словарю команд: ключ — argv через пробел (без `-C <root>`,
 * одинакового у всех), значение — ответ либо ошибка.
 *
 * Массив в значении — ОЧЕРЕДЬ ответов на повторные вызовы одной команды: ветка спрашивается
 * трижды (до слияния, перед ним и после), и «сменилась между сверками» описывается только
 * так. Последний ответ очереди залипает — иначе каждый лишний вызов пришлось бы описывать.
 */
function world(replies: Record<string, string | Error | Array<string | Error>> = {}) {
    const calls: string[][] = [];
    const logs: string[] = [];
    const queues = new Map<string, Array<string | Error>>();
    const runArgvFn = (file: string, args: string[]): string => {
        calls.push([file, ...args]);
        const key = args.filter((a) => a !== '-C' && a !== CONSUMER).join(' ');
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
        run: (roots: TResolvedRoots | null = ROOTS): TConsumerTreeKind =>
            updateConsumerTree(roots, { runArgvFn, logFn: (m) => logs.push(m) }),
        /** Только то, что МЕНЯЕТ дерево. Их отсутствие — предмет половины проб ниже. */
        mutations: (): string[][] => calls.filter(([, ...args]) => args.includes('merge')),
        text: (): string => calls.map((c) => c.join(' ')).join('\n'),
        log: (): string => logs.join('\n'),
        logs,
    };
}

/** Мир, где всё в порядке: дерево чистое, на main, fetch принёс sha. */
const happy = () => world({ [BRANCH_KEY]: 'main', [`rev-parse --verify ${REF}^{commit}`]: SHA });

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

    it('чистое дерево на main: fetch в свой ref, ff-only по sha, уборка ref', () => {
        const w = happy();
        expect(w.run()).toBe('updated');
        expect(w.calls).toEqual([
            ['git', '-C', CONSUMER, 'status', '--porcelain', '--untracked-files=no'],
            ['git', '-C', CONSUMER, ...BRANCH_ARGS],
            [
                'git',
                '-C',
                CONSUMER,
                '-c',
                'submodule.recurse=false',
                'fetch',
                '--no-recurse-submodules',
                '--no-write-fetch-head',
                'origin',
                `+refs/heads/main:${REF}`,
            ],
            ['git', '-C', CONSUMER, 'rev-parse', '--verify', `${REF}^{commit}`],
            // Сверки ветки И ЧИСТОТЫ вплотную к слиянию — окно между первыми проверками
            // и командой (ревью, 3-й и 5-й проходы), плюс снимок HEAD для пост-сверки.
            ['git', '-C', CONSUMER, ...BRANCH_ARGS],
            ['git', '-C', CONSUMER, 'status', '--porcelain', '--untracked-files=no'],
            ['git', '-C', CONSUMER, 'rev-parse', 'HEAD'],
            // Сливается зафиксированный sha, а не имя ref'а: имя пришлось бы разрешать
            // повторно, а его мог переписать следующий прогон.
            ['git', '-C', CONSUMER, '-c', 'submodule.recurse=false', 'merge', '--ff-only', SHA],
            ['git', '-C', CONSUMER, ...BRANCH_ARGS],
            // Уборка со сверкой значения: имя ref'а одно на потребителя, экземпляров
            // раннера может быть несколько (ревью, 4-й проход).
            ['git', '-C', CONSUMER, 'update-ref', '-d', REF, SHA],
        ]);
        expect(w.log()).toContain(CONSUMER);
    });

    it('untracked-файлы грязью НЕ считаются — иначе обновления не было бы никогда', () => {
        // `runtimeDir` по умолчанию живёт под `consumerRoot` и не версионируется: считать
        // untracked грязью значило бы не обновлять дерево ровно в той раскладке, ради
        // которой всё написано. Отсюда `--untracked-files=no` в самой команде статуса —
        // тест сторожит именно флаг, а не пустой ответ мира.
        const w = happy();
        expect(w.run()).toBe('updated');
        expect(w.calls[0]).toContain('--untracked-files=no');
    });

    it('грязное дерево не трогаем и говорим об этом вслух', () => {
        const w = world({
            'status --porcelain --untracked-files=no': ' M src/app.ts',
            [BRANCH_KEY]: 'main',
        });
        expect(w.run()).toBe('dirty');
        expect(w.mutations()).toEqual([]);
        expect(w.log()).toContain(CONSUMER);
        expect(w.log()).toMatch(/git pull/); // человеку названо, чем закончить самому
    });

    it('дерево на другой ветке — не трогаем, ветка названа', () => {
        const w = world({ [BRANCH_KEY]: 'feature/чинить-верстку' });
        expect(w.run()).toBe('off-main');
        expect(w.mutations()).toEqual([]);
        expect(w.log()).toContain('feature/чинить-верстку');
    });

    it('detached HEAD (symbolic-ref отказал) — тоже не трогаем', () => {
        const w = world({ [BRANCH_KEY]: new Error('код 1') });
        expect(w.run()).toBe('off-main');
        expect(w.mutations()).toEqual([]);
        expect(w.log()).toMatch(/detached|не на ветке/i);
    });

    it('ветку переключили между сверками — слияния не будет, ref всё равно убран', () => {
        // Окно TOCTOU (ревью, 3-й проход): человек ушёл на свою ветку, пока мы фетчили.
        // `merge --ff-only` перемотал бы ЕЁ, и молча.
        const w = world({
            [BRANCH_KEY]: ['main', 'feature/своё'],
            [`rev-parse --verify ${REF}^{commit}`]: SHA,
        });
        expect(w.run()).toBe('off-main');
        expect(w.mutations()).toEqual([]);
        expect(w.log()).toContain('feature/своё');
        expect(w.text()).toContain(`update-ref -d ${REF}`);
    });

    it('дерево стало грязным, пока мы фетчили, — слияния не будет', () => {
        // Обещание «грязное не трогаю» относилось бы к состоянию минутной давности, если
        // спрашивать статус только на входе (ревью, 5-й проход).
        const w = world({
            [BRANCH_KEY]: 'main',
            'status --porcelain --untracked-files=no': ['', ' M src/app.ts'],
            [`rev-parse --verify ${REF}^{commit}`]: SHA,
        });
        expect(w.run()).toBe('dirty');
        expect(w.mutations()).toEqual([]);
        expect(w.log()).toMatch(/пока мы фетчили/);
        // Ref всё равно убран — он уже записан, и сдача фазы тут ни при чём.
        expect(w.text()).toContain(`update-ref -d ${REF} ${SHA}`);
    });

    it('fetch не дошёл до записи — чужой ref не удаляем: подтвердить владение нечем', () => {
        const w = world({
            [BRANCH_KEY]: 'main',
            [`-c submodule.recurse=false fetch --no-recurse-submodules --no-write-fetch-head origin +refs/heads/main:${REF}`]:
                new Error('could not read from remote'),
        });
        expect(w.run()).toBe('failed');
        expect(w.text()).not.toContain('update-ref');
    });

    it('после слияния дерево оказалось не на main — громко, с sha для отката', () => {
        // Остаток того же окна: сузить его до нуля нечем (атомарного «слей в HEAD, только
        // если HEAD — main» у git нет), поэтому последствие обязано быть НАЗВАНО.
        const head = 'b'.repeat(40);
        const w = world({
            [BRANCH_KEY]: ['main', 'main', 'feature/своё'],
            [`rev-parse --verify ${REF}^{commit}`]: SHA,
            'rev-parse HEAD': head,
        });
        expect(w.run()).toBe('failed');
        // Факты, а не готовая команда: `reset --hard` вслепую откатил бы не ту ветку
        // (ревью, 4-й проход). Названо, от чего ушли и что слито.
        expect(w.log()).toContain(head);
        expect(w.log()).toContain(SHA);
        expect(w.log()).not.toMatch(/reset --hard/);
    });

    it('ff-only не прошёл (дерево разошлось) — best-effort: лог с причиной, без броска', () => {
        const w = world({
            [BRANCH_KEY]: 'main',
            [`rev-parse --verify ${REF}^{commit}`]: SHA,
            [`-c submodule.recurse=false merge --ff-only ${SHA}`]: new Error(
                'Not possible to fast-forward',
            ),
        });
        let kind: TConsumerTreeKind | null = null;
        expect(() => {
            kind = w.run();
        }).not.toThrow();
        expect(kind).toBe('failed');
        expect(w.log()).toContain('Not possible to fast-forward');
        expect(w.log()).toContain(CONSUMER);
        // Уборка ref'а идёт и по этому пути: оставленный, он держит историю GC-корнем
        // в репозитории человека (ревью, 3-й проход).
        expect(w.text()).toContain(`update-ref -d ${REF}`);
    });

    it('на месте sha пришёл мусор — сливать нечем, и это отказ, а не merge вслепую', () => {
        // `runArgvFn` инжектируется, то есть «git вернёт полный object id» — контракт
        // боевой реализации, а не гарантия типа. Слияние по неразобранной строке ушло бы
        // куда угодно, включая `HEAD~1` (ревью, 4-й проход).
        const w = world({
            [BRANCH_KEY]: 'main',
            [`rev-parse --verify ${REF}^{commit}`]: 'HEAD~1',
        });
        expect(w.run()).toBe('failed');
        expect(w.mutations()).toEqual([]);
        expect(w.log()).toContain('HEAD~1');
    });

    it('ref не убрался — исход прежний, но молчания нет', () => {
        // Мусор в чужом репозитории не отменяет состоявшегося обновления, но обязан быть
        // назван вместе с адресом: GC-корень, о котором не сказали, растёт молча.
        const w = world({
            [BRANCH_KEY]: 'main',
            [`rev-parse --verify ${REF}^{commit}`]: SHA,
            [`update-ref -d ${REF} ${SHA}`]: new Error('ref занят соседом'),
        });
        expect(w.run()).toBe('updated');
        expect(w.log()).toContain(REF);
        expect(w.log()).toContain('ref занят соседом');
    });

    it('fetch не прошёл — ни слияния, ни ложного успеха', () => {
        const w = world({
            [BRANCH_KEY]: 'main',
            [`-c submodule.recurse=false fetch --no-recurse-submodules --no-write-fetch-head origin +refs/heads/main:${REF}`]:
                new Error('could not read from remote'),
        });
        expect(w.run()).toBe('failed');
        expect(w.mutations()).toEqual([]);
        expect(w.log()).toContain('could not read from remote');
    });

    it('git status не отработал — «не знаю» трактуем как «не трогать»', () => {
        const w = world({
            'status --porcelain --untracked-files=no': new Error('not a git repository'),
        });
        expect(w.run()).toBe('failed');
        expect(w.mutations()).toEqual([]);
        expect(w.text()).not.toContain('fetch');
    });

    it('в подмодули не рекурсирует — и запрет ЯВНЫЙ, а не «мы не просили»', () => {
        // Каталог продукта у потребителя — подмодуль внутри `consumerRoot`, и его код
        // подменяет lifecycle-операция launcher'а, а не побочка соседнего обновления.
        // Проба сторожит ЗАПРЕТ, а не отсутствие слова: дефолт `fetch.recurseSubmodules`
        // — `on-demand`, то есть молчание здесь означало бы «рекурсируем» (ревью, 1-й
        // проход). Вторая половина — `submodule.recurse` потребителя: его в конфиге может
        // включить он сам, и тогда в подмодуль полез бы ещё и merge.
        const w = happy();
        w.run();
        const fetch = w.calls.find((c) => c.includes('fetch'));
        expect(fetch).toContain('--no-recurse-submodules');
        for (const call of w.calls.filter((c) => c.includes('fetch') || c.includes('merge'))) {
            expect(call.join(' ')).toContain('-c submodule.recurse=false');
        }
    });
});

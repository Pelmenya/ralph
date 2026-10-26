// #86: матрица «убить до / после» для намерений, меняющих задачи (`comment`, `close`,
// `block`, `new-issue`).
//
// Приёмка формулируется вопросом «что придёт в чат, если сейчас убить процесс». Убийство
// исключения не бросает, поэтому моделируется смертью МИРА (`crash-world.ts`): в точке
// убийства фейк бросает, и с этого момента ни диск, ни форж, ни чат больше ничего не
// принимают — `catch` раннера ещё исполняется, но его запись хвоста и пуш уходят в
// пустоту, как у убитого процесса.
// Рестарт — новый проход по тому, что осталось на «диске»: проверка на старте (`main()`)
// и применение, которое на рестарте увидит файл первым.
//
// Точки убийства — три, а не две: «до» распадается на «до метки» (файл честный, повтор
// безопасен) и «после метки, до эффекта» (раннеру уже не различить, дошёл ли эффект до
// форжа). Обе половины «до» и «после» обязаны кончаться одним из двух исходов: эффект
// ровно один раз — или стоп с причиной и пушем. Молчания и дубля нет ни в одной клетке.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что в
// orchestrator.test.ts, #366): дефолт ralph.js — ре-экспорт runtime фабрики.
import ralph from '../ralph.js';
import { IN_FLIGHT_MARKER, parseSessionRequests } from '../core/session-requests.ts';
import { REASON_TITLES } from '../core/stop-message.ts';
import { world } from './crash-world.ts';

const CFG = { issueLabels: ['complexity:low', 'area:core'] };
const line = (o: unknown): string => JSON.stringify(o);

type TKind = 'comment' | 'close' | 'block' | 'new-issue';
type TKillAt = 'before-marker' | 'before-effect' | 'after-effect';

const REQUEST: Record<TKind, Record<string, unknown>> = {
    comment: { kind: 'comment', issue: 7, comment: 'что выяснилось' },
    close: { kind: 'close', issue: 7, comment: 'что сделано' },
    block: { kind: 'block', issue: 7, comment: 'что нужно от человека' },
    'new-issue': {
        kind: 'new-issue',
        title: 'Найдено вне скоупа',
        body: 'симптом, причина, критерий',
        labels: ['complexity:low', 'area:core'],
    },
};

// Эффекты, которые оставляет на форже каждое намерение, — в порядке вызова шва.
const EFFECTS: Record<TKind, string[]> = {
    comment: ['comment:7:что выяснилось'],
    close: ['comment:7:что сделано', 'close:7'],
    block: ['comment:7:что нужно от человека', 'block:7'],
    'new-issue': ['create:Найдено вне скоупа'],
};

// Перед проверяемым намерением в батче стоит уже применённое: рестарт не должен
// повторить и его.
const EARLIER = { kind: 'comment', issue: 5, comment: 'раньше' };
const EARLIER_EFFECT = 'comment:5:раньше';

/**
 * Один прогон применения. `killOn` вызывается перед каждой побочкой и решает, умереть ли
 * ДО неё (`'before'`) или сразу ПОСЛЕ (`'after'`).
 */
function apply(
    disk: { file: string | null },
    forge: string[],
    chat: string[],
    killOn: (op: string) => 'before' | 'after' | null = () => null,
) {
    const w = world();
    const g = <A extends unknown[]>(op: (...a: A) => string, act: (...a: A) => void) =>
        w.guard(op, act, killOn);
    const effect = (what: string): void => {
        forge.push(what);
    };
    const res = ralph.applySessionRequests({
        cfg: CFG,
        dry: false,
        readFn: () => disk.file,
        writeFn: g(
            (t: string) => `write:${t}`,
            (t: string) => {
                disk.file = t;
            },
        ),
        removeFn: g(
            () => 'remove',
            () => {
                disk.file = null;
            },
        ),
        taskSource: {
            commentOnIssue: g(
                (n: number, body: string) => `comment:${String(n)}:${body}`,
                (n: number, body: string) => effect(`comment:${String(n)}:${body}`),
            ),
            closeIssue: g(
                (n: number) => `close:${String(n)}`,
                (n: number) => effect(`close:${String(n)}`),
            ),
            blockIssue: g(
                (n: number) => `block:${String(n)}`,
                (n: number) => effect(`block:${String(n)}`),
            ),
            createIssue: (input: { title: string }) => {
                g(
                    (t: string) => `create:${t}`,
                    (t: string) => effect(`create:${t}`),
                )(input.title);
                return 101;
            },
        },
        logFn: () => {},
        pushEventFn: w.chat(chat),
    }) as { applied: number; failed: boolean; outcomeUnknown?: boolean };
    return { res, dead: w.dead };
}

/** Рестарт: проверка на старте, затем применение — что увидит петля первым делом. */
function restart(disk: { file: string | null }, forge: string[], chat: string[]) {
    const w = world();
    const stopped = ralph.stopOnInFlightIntent({
        cfg: CFG,
        readFn: () => disk.file,
        pushEventFn: w.chat(chat),
        logFn: () => {},
    }) as boolean;
    const applied = apply(disk, forge, chat);
    return { stopped, applied: applied.res };
}

/** Точка убийства для намерения вида `kind` во втором слоте батча. */
function killer(kind: TKind, at: TKillAt): (op: string) => 'before' | 'after' | null {
    const effects = EFFECTS[kind];
    const target = line(REQUEST[kind]);
    return (op) => {
        // Метка, первой строкой за которой стоит проверяемое намерение.
        if (at === 'before-marker' && op === `write:${IN_FLIGHT_MARKER}\n${target}\n`) {
            return 'before';
        }
        // До эффекта: первый же вызов шва по этому намерению (метка уже на диске).
        if (at === 'before-effect' && op === effects[0]) return 'before';
        // После эффекта: последний вызов шва лёг, «применено» на диск не попало.
        if (at === 'after-effect' && op === effects.at(-1)) return 'after';
        return null;
    };
}

const KINDS: TKind[] = ['comment', 'close', 'block', 'new-issue'];

describe('#86 матрица «убить до / после»: намерения по задачам', () => {
    describe.each(KINDS)('%s', (kind) => {
        const batch = `${[line(EARLIER), line(REQUEST[kind])].join('\n')}\n`;

        it('убит ДО метки начатого — рестарт применяет его ровно один раз и молча', () => {
            const disk = { file: batch as string | null };
            const forge: string[] = [];
            const chat: string[] = [];
            const first = apply(disk, forge, chat, killer(kind, 'before-marker'));
            expect(first.dead).toBe(true);
            // Убитый процесс в чат не пишет ничего — пуш здесь был бы неправдой о мёртвом.
            expect(chat).toEqual([]);
            expect(forge).toEqual([EARLIER_EFFECT]);

            const { stopped, applied } = restart(disk, forge, chat);
            expect(stopped).toBe(false);
            expect(applied.failed).toBe(false);
            // Предыдущее намерение не повторено, проверяемое — легло один раз.
            expect(forge).toEqual([EARLIER_EFFECT, ...EFFECTS[kind]]);
            expect(chat).toEqual([]);
            expect(disk.file).toBeNull();
        });

        it.each<TKillAt>(['before-effect', 'after-effect'])(
            'убит %s — рестарт не повторяет и не пропускает, а останавливается с причиной',
            (at) => {
                const disk = { file: batch as string | null };
                const forge: string[] = [];
                const chat: string[] = [];
                const first = apply(disk, forge, chat, killer(kind, at));
                expect(first.dead).toBe(true);
                expect(chat).toEqual([]);
                const before = [...forge];
                expect(before).toEqual(
                    at === 'after-effect' ? [EARLIER_EFFECT, ...EFFECTS[kind]] : [EARLIER_EFFECT],
                );

                const { stopped, applied } = restart(disk, forge, chat);
                // Ни одного нового эффекта: ни дубля «после», ни догадки «до».
                expect(forge).toEqual(before);
                expect(stopped).toBe(true);
                expect(applied.failed).toBe(true);
                expect(applied.outcomeUnknown).toBe(true);
                // Что пришло в чат: причина, само начатое намерение и что решить человеку.
                expect(chat.length).toBeGreaterThan(0);
                const msg = chat[0];
                expect(msg).toMatch(/^⛔ Ralph: /);
                expect(msg).toContain(REASON_TITLES['intent-unknown']);
                expect(msg).toContain(line(REQUEST[kind]));
                expect(msg).toContain(IN_FLIGHT_MARKER);
                expect(msg).toMatch(/перезапусти loop/);
                // Предыдущее, уже подтверждённое, в файле не числится — человек решает
                // только про начатое.
                expect(disk.file).not.toContain(line(EARLIER));
                expect(disk.file).toContain(IN_FLIGHT_MARKER);
            },
        );
    });

    // `close` — два эффекта: смерть между ними тоже «после метки», и тоже стоп.
    it('close: убит между комментарием и закрытием — стоп, карточка не закрыта вслепую', () => {
        const disk = { file: `${line(REQUEST.close)}\n` as string | null };
        const forge: string[] = [];
        const chat: string[] = [];
        apply(disk, forge, chat, (op) => (op === 'comment:7:что сделано' ? 'after' : null));
        expect(forge).toEqual(['comment:7:что сделано']);
        const { stopped } = restart(disk, forge, chat);
        expect(stopped).toBe(true);
        expect(forge).toEqual(['comment:7:что сделано']);
        expect(chat[0]).toContain(REASON_TITLES['intent-unknown']);
    });

    // Вопрос в пуше обязан исполняться буквально: обе развилки человека приводят к петле,
    // которая идёт дальше без дубля и без потери.
    describe('развилки человека из текста пуша', () => {
        const stuck = (at: TKillAt) => {
            const disk = { file: `${line(REQUEST.close)}\n${line(EARLIER)}\n` as string | null };
            const forge: string[] = [];
            const chat: string[] = [];
            apply(disk, forge, chat, killer('close', at));
            return { disk, forge, chat };
        };
        const dropLines = (file: string, n: number): string =>
            `${file
                .split('\n')
                .filter((l) => l.trim() !== '')
                .slice(n)
                .join('\n')}\n`;

        it('эффект лёг — убрана метка и строка за ней: остаток применяется, close не повторён', () => {
            const { disk, forge, chat } = stuck('after-effect');
            disk.file = dropLines(String(disk.file), 2);
            const { stopped, applied } = restart(disk, forge, chat);
            expect(stopped).toBe(false);
            expect(applied.failed).toBe(false);
            expect(forge).toEqual([...EFFECTS.close, EARLIER_EFFECT]);
        });

        it('эффект не лёг — убрана только метка: намерение применяется один раз', () => {
            const { disk, forge, chat } = stuck('before-effect');
            disk.file = dropLines(String(disk.file), 1);
            const { stopped, applied } = restart(disk, forge, chat);
            expect(stopped).toBe(false);
            expect(applied.failed).toBe(false);
            expect(forge).toEqual([...EFFECTS.close, EARLIER_EFFECT]);
        });
    });

    // Не убийство, а живой отказ той же записи: эффект лёг, «применено» на диск не легло.
    // Пойманный отказ вернул бы намерение в хвост и повторил его — здесь обязан быть стоп.
    it('эффект лёг, а запись «применено» отказала — пуш ⛔ сразу, повтора нет и после рестарта', () => {
        const disk = { file: `${line(REQUEST.close)}\n` as string | null };
        const forge: string[] = [];
        const chat: string[] = [];
        let writes = 0;
        const res = ralph.applySessionRequests({
            cfg: CFG,
            dry: false,
            readFn: () => disk.file,
            writeFn: (t: string) => {
                writes += 1;
                if (writes === 2) throw new Error('диск полон');
                disk.file = t;
            },
            removeFn: () => {
                disk.file = null;
            },
            taskSource: {
                commentOnIssue: (n: number, b: string) => forge.push(`comment:${String(n)}:${b}`),
                closeIssue: (n: number) => forge.push(`close:${String(n)}`),
                blockIssue: () => {},
                createIssue: () => 1,
            },
            logFn: () => {},
            pushEventFn: (m: string) => chat.push(m),
        }) as { failed: boolean; outcomeUnknown?: boolean };
        expect(res.failed).toBe(true);
        expect(res.outcomeUnknown).toBe(true);
        expect(forge).toEqual(EFFECTS.close);
        expect(chat[0]).toMatch(/^⛔ Ralph: .*применено, но отметить это .*диск полон/s);

        const { stopped } = restart(disk, forge, chat);
        expect(stopped).toBe(true);
        expect(forge).toEqual(EFFECTS.close);
    });

    it('сессия не может провезти метку мимо: файл с ней не применяется ни одним путём', () => {
        // Метка без `kind` — битая строка для парсера намерений. Даже если проверку метки
        // однажды забудут, файл отвергнется разбором, а не применится.
        expect(() =>
            parseSessionRequests(`${IN_FLIGHT_MARKER}\n${line(REQUEST.close)}\n`, {
                labelAllowlist: [],
            }),
        ).toThrow();
    });
});

// Применение, а не работоспособность (`tests/CLAUDE.md`): проверка метки на старте и стоп
// кодер-итерации видны только по исходному тексту — `main()` в тестах не запускается.
describe('#86 проводка: метку проверяют до первой сессии и по ней останавливаются', () => {
    const source = fs.readFileSync(
        path.join(import.meta.dirname, '..', 'core', 'orchestrator.ts'),
        'utf8',
    );

    it('main() проверяет метку ДО runLoop и выходит, не запуская петлю', () => {
        const main = source.slice(source.indexOf('    function main(): void {'));
        const check = main.indexOf('if (stopOnInFlightIntent({ cfg: config })) return;');
        const loop = main.indexOf('runLoop(config, ctx,');
        expect(check).toBeGreaterThan(-1);
        expect(loop).toBeGreaterThan(check);
    });

    it('журнал «начато / применено» пишется атомарно, а не усечением', () => {
        // Матрица выше считает запись файла мгновенной; на диске это держит только
        // tmp + rename. `writeFileSync` усекает файл до записи, и убитый между ними
        // раннер оставил бы пустой файл — «намерений нет» вместо неприменённого хвоста.
        const fn = source.slice(source.indexOf('function writeSessionRequests(text: string)'));
        const body = fn.slice(0, fn.indexOf('\n    }\n'));
        expect(body).toContain('writeFileAtomic(RUNTIME.requests, text)');
        expect(body).not.toContain('writeFileSync');
    });

    it('кодер-итерация останавливается на неизвестном исходе', () => {
        const at = source.indexOf('const intents = applySessionRequestsFn({');
        expect(at).toBeGreaterThan(-1);
        const next = source.slice(at, at + 2000);
        expect(next).toContain('if (intents.outcomeUnknown === true) break;');
    });
});

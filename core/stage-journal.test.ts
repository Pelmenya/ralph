import { describe, expect, it } from 'vitest';
import {
    CODER_STAGES,
    createStageJournal,
    formatAttemptSummary,
    memoryStageJournalStore,
    parseStageJournal,
    summarizeAttempt,
    type TCoderStage,
} from './stage-journal.ts';

const opts = { nowFn: () => '2026-10-26T00:00:00.000Z', idFn: () => 'a1' };

/** Журнал, в котором этапы до `stage` доведены, а сам `stage` начат и брошен. */
function brokenAt(stage: TCoderStage): string {
    const store = memoryStageJournalStore();
    const j = createStageJournal(store, opts);
    j.begin('Фаза 1', 7);
    for (const s of CODER_STAGES) {
        if (s !== 'pick') j.start(s);
        if (s === stage) break;
        j.finish(s, 'ok', s === 'session' ? 1 : undefined);
    }
    return store.text() as string;
}

describe('журнал этапов кодер-итерации (#92)', () => {
    it.each(CODER_STAGES)('рестарт посреди этапа «%s» продолжает с него же', (stage) => {
        const store = memoryStageJournalStore(brokenAt(stage));
        const s = createStageJournal(store, opts).load();
        expect(s?.resumeStage).toBe(stage);
        expect(s?.issue).toBe(7);
        expect(s?.milestone).toBe('Фаза 1');
        const status = s?.stages.find((x) => x.stage === stage)?.status;
        expect(status).toBe('не завершён');
    });

    it('этап без исхода — «не завершён», а не «выполнен», и это видно в сводке', () => {
        const s = summarizeAttempt(parseStageJournal(brokenAt('intents'), 'j'));
        expect(s?.stages.map((x) => x.status)).toEqual([
            'выполнен',
            'выполнен',
            'не завершён',
            'не начат',
        ]);
        const line = formatAttemptSummary(s!);
        expect(line).toContain('применение намерений — не завершён');
        expect(line).toContain('продолжаю с этапа «применение намерений»');
    });

    it('код сессии переживает рестарт: этапам после неё решать по нему', () => {
        const s = summarizeAttempt(parseStageJournal(brokenAt('commit'), 'j'));
        expect(s?.sessionCode).toBe(1);
    });

    it('доведённый этап без начала следующего — продолжение со следующего', () => {
        const store = memoryStageJournalStore();
        const j = createStageJournal(store, opts);
        j.begin('Фаза 1', 7);
        j.finish('pick', 'ok');
        const s = createStageJournal(memoryStageJournalStore(store.text()), opts).load();
        expect(s?.resumeStage).toBe('session');
        expect(s?.stages[1].status).toBe('не начат');
    });

    it('исход «stop» кончает попытку: рестарт её не продолжает', () => {
        const store = memoryStageJournalStore();
        const j = createStageJournal(store, opts);
        j.begin('Фаза 1', 7);
        j.finish('pick', 'stop');
        const s = createStageJournal(memoryStageJournalStore(store.text()), opts).load();
        expect(s?.resumeStage).toBeNull();
        expect(s?.stages[0].status).toBe('остановлен');
        expect(formatAttemptSummary(s!)).toContain('продолжать нечего');
    });

    it('доведённая попытка снимается — журнала после неё нет', () => {
        const store = memoryStageJournalStore();
        const j = createStageJournal(store, opts);
        j.begin('Фаза 1', 7);
        j.finish('pick', 'ok');
        j.close();
        expect(store.text()).toBeNull();
        expect(createStageJournal(store, opts).load()).toBeNull();
    });

    it('продолжение дописывает к поднятой попытке, а не начинает новую', () => {
        const store = memoryStageJournalStore(brokenAt('session'));
        const j = createStageJournal(store, { ...opts, idFn: () => 'другая' });
        j.load();
        j.finish('session', 'ok', 0);
        const s = summarizeAttempt(parseStageJournal(store.text() as string, 'j'));
        expect(s?.attempt).toBe('a1');
        expect(s?.resumeStage).toBe('intents');
    });

    it('повтор брошенного этапа не дублирует его начало', () => {
        const store = memoryStageJournalStore(brokenAt('session'));
        const j = createStageJournal(store, opts);
        j.load();
        const before = store.text();
        j.start('session');
        expect(store.text()).toBe(before);
    });

    it('каждая запись — целиком через хранилище, без дозаписи в конец', () => {
        const writes: string[] = [];
        const j = createStageJournal(
            { read: () => null, write: (t) => writes.push(t), remove: () => {} },
            opts,
        );
        j.begin('Фаза 1', 7);
        j.finish('pick', 'ok');
        // Вторая запись содержит первую: файл переписывается полностью (rename), а не
        // дописывается — оборванная дозапись оставила бы полстроки.
        expect(writes).toHaveLength(2);
        expect(writes[1].startsWith(writes[0])).toBe(true);
        expect(() => parseStageJournal(writes[1], 'j')).not.toThrow();
    });

    it('запись, которую сам разбор отверг бы, не пишется вовсе', () => {
        const store = memoryStageJournalStore();
        const j = createStageJournal(store, opts);
        j.begin('Фаза 1', 7);
        const before = store.text();
        expect(() => j.start('intents')).toThrow(/начат новый этап, у прошлого нет исхода/);
        expect(store.text()).toBe(before);
    });
});

describe('повреждённая запись отвергается с диагнозом (#92)', () => {
    const good = brokenAt('session');
    const lines = good.trimEnd().split('\n');

    it.each([
        [
            'оборванная строка',
            `${lines[0]}\n${lines[1].slice(0, 20)}\n`,
            /строка 2: не разбирается как JSON/,
        ],
        ['не объект', '[1,2]\n', /строка 1: запись — не объект/],
        ['чужая версия', lines[0].replace('"v":1', '"v":2') + '\n', /неизвестная версия/],
        ['неизвестный этап', lines[0].replace('"pick"', '"deploy"') + '\n', /неизвестный этап/],
        ['исход без начала', lines[1] + '\n', /строка 1: исход этапа «pick» без его начала/],
        [
            'неизвестный исход',
            `${lines[0]}\n${lines[1].replace('"ok"', '"maybe"')}\n`,
            /неизвестный исход/,
        ],
        [
            'запись другой попытки',
            `${lines[0]}\n${lines[1].replace('"a1"', '"a2"')}\n`,
            /строка 2: запись другой попытки/,
        ],
        ['этап не по порядку', lines[0].replace('"pick"', '"intents"') + '\n', /не по порядку/],
        ['пустая строка в середине', `${lines[0]}\n\n${lines[1]}\n`, /строка 2: не разбирается/],
        [
            'номер задачи строкой',
            lines[0].replace('"issue":7', '"issue":"7"') + '\n',
            /номер задачи/,
        ],
    ])('%s', (_name, text, re) => {
        expect(() => parseStageJournal(text, '/path/to/runtime/ralph.stages.jsonl')).toThrow(re);
        // Диагноз называет файл и говорит, что делать, — а не только «битый JSON».
        expect(() => parseStageJournal(text, '/path/to/runtime/ralph.stages.jsonl')).toThrow(
            /ralph\.stages\.jsonl.*Разбери файл руками/s,
        );
    });

    it('load на повреждённом журнале бросает, а не отдаёт «попытки нет»', () => {
        const store = memoryStageJournalStore('{"v":1');
        expect(() => createStageJournal(store, opts).load()).toThrow(/строка 1/);
    });

    // rename без fsync файла и каталога оставляет после потери питания файл нулевой
    // длины — «попытки нет» на нём означало бы повтор сделанного. `null` — только ENOENT.
    it('пустой существующий файл — отказ, а не «попытки нет»', () => {
        expect(() => createStageJournal(memoryStageJournalStore(''), opts).load()).toThrow(
            /файл пуст/,
        );
        expect(createStageJournal(memoryStageJournalStore(null), opts).load()).toBeNull();
    });

    it.each([
        ['stop без кода', '"outcome":"stop"', /исход сессии без кода/],
        ['skip у сессии', '"outcome":"skip"', /исход сессии «skip»/],
    ])('исход сессии: %s — отвергается', (_n, outcome, re) => {
        const recs = [
            {
                v: 1,
                attempt: 'a1',
                milestone: 'M',
                issue: 7,
                stage: 'pick',
                event: 'start',
                at: 't',
            },
            {
                v: 1,
                attempt: 'a1',
                milestone: 'M',
                issue: 7,
                stage: 'pick',
                event: 'outcome',
                outcome: 'ok',
                at: 't',
            },
            {
                v: 1,
                attempt: 'a1',
                milestone: 'M',
                issue: 7,
                stage: 'session',
                event: 'start',
                at: 't',
            },
        ].map((r) => JSON.stringify(r));
        const last = `{"v":1,"attempt":"a1","milestone":"M","issue":7,"stage":"session","event":"outcome",${outcome},"at":"t"}`;
        expect(() => parseStageJournal([...recs, last].join('\n') + '\n', 'j')).toThrow(re);
    });
});

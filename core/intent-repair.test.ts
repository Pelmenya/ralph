// #217: сверка исправленного батча с исходным. Барьер проверяется «от противного»: каждое
// исправление, которое меняет смысл (текст, адресат, якорь, лишняя строка), обязано
// отвергаться — иначе переспрос стал бы способом переписать намерения мимо ревью.
import { describe, expect, it } from 'vitest';
import { checkIntentRepair, intentRepairObstacle } from './intent-repair.ts';
import { parseSessionRequests, serializeRejectedBlock } from './session-requests.ts';

const line = (o: unknown): string => JSON.stringify(o);
const parse = (raw: string) => parseSessionRequests(raw, { labelAllowlist: ['area:core'] });

// Дрейф из инцидента 27→28.10: верные значения под чужими именами полей.
const DRIFTED = [
    line({ type: 'pr-comment', body: '🔴 [blocker] теряется отказ', path: 'core/a.ts', line: 42 }),
    line({ type: 'pr-comment', body: 'сводка прохода' }),
    line({ kind: 'pr-block', body: 'блокер выше' }),
].join('\n');

const FIXED = [
    line({
        kind: 'pr-comment',
        comment: '🔴 [blocker] теряется отказ',
        path: 'core/a.ts',
        line: 42,
    }),
    line({ kind: 'pr-comment', comment: 'сводка прохода' }),
    line({ kind: 'pr-block', comment: 'блокер выше' }),
].join('\n');

describe('checkIntentRepair — меняться могут только имена полей и разметка', () => {
    it('исправление имён полей принимается, переименования названы', () => {
        const r = checkIntentRepair(DRIFTED, parse(FIXED));
        expect(r).toEqual({ ok: true, changed: 3, renames: ['type→kind', 'body→comment'] });
    });

    it('вложенный якорь и порядок ключей — разметка, а не смысл', () => {
        const raw = line({
            comment: 'x',
            anchor: { line: 3, path: 'a.ts', side: 'LEFT' },
            type: 'pr-comment',
        });
        const fixed = line({
            kind: 'pr-comment',
            comment: 'x',
            path: 'a.ts',
            line: 3,
            side: 'LEFT',
        });
        expect(checkIntentRepair(raw, parse(fixed))).toMatchObject({ ok: true, changed: 1 });
    });

    it('метки new-issue сверяются поштучно, body у new-issue остаётся body', () => {
        const raw = line({ type: 'new-issue', name: 'T', body: 'B', labels: ['area:core'] });
        const fixed = line({ kind: 'new-issue', title: 'T', body: 'B', labels: ['area:core'] });
        expect(checkIntentRepair(raw, parse(fixed))).toEqual({
            ok: true,
            changed: 1,
            renames: ['type→kind', 'name→title'],
        });
    });

    it('строка, которая не менялась, не считается исправленной', () => {
        const ok = line({ kind: 'close', issue: 7, comment: 'сделано' });
        const raw = `${ok}\n${line({ kind: 'comment', issue: 7, body: 'что сделано' })}`;
        const fixed = `${ok}\n${line({ kind: 'comment', issue: 7, comment: 'что сделано' })}`;
        expect(checkIntentRepair(raw, parse(fixed))).toEqual({
            ok: true,
            changed: 1,
            renames: ['body→comment'],
        });
    });

    it('правка текста — отказ', () => {
        const bad = FIXED.replace('теряется отказ', 'всё хорошо');
        const r = checkIntentRepair(DRIFTED, parse(bad));
        expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/строка 1/) });
    });

    it('смена адресата карточки — отказ, даже если номер был в другом поле', () => {
        const raw = line({ kind: 'close', issue: 7, body: 'сделано' });
        const r = checkIntentRepair(
            raw,
            parse(line({ kind: 'close', issue: 8, comment: 'сделано' })),
        );
        expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/поле issue было 7/) });
    });

    it('смена вида намерения при верном имени поля — отказ', () => {
        const raw = line({ kind: 'comment', issue: 7, body: 'сделано' });
        const r = checkIntentRepair(
            raw,
            parse(line({ kind: 'close', issue: 7, comment: 'сделано' })),
        );
        expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/поле kind/) });
    });

    it('сдвиг якоря — отказ', () => {
        const bad = FIXED.replace('"line":42', '"line":43');
        expect(checkIntentRepair(DRIFTED, parse(bad))).toMatchObject({ ok: false });
    });

    it('смена стороны диффа — отказ', () => {
        const raw = line({ type: 'pr-comment', body: 'x', path: 'a.ts', line: 1, side: 'LEFT' });
        const fixed = line({
            kind: 'pr-comment',
            comment: 'x',
            path: 'a.ts',
            line: 1,
            side: 'RIGHT',
        });
        expect(checkIntentRepair(raw, parse(fixed))).toMatchObject({ ok: false });
    });

    it('строка-номер не становится номером: «7» и 7 — разные значения', () => {
        const raw = line({ type: 'close', issue: '7', body: 'сделано' });
        const fixed = line({ kind: 'close', issue: 7, comment: 'сделано' });
        expect(checkIntentRepair(raw, parse(fixed))).toMatchObject({ ok: false });
    });

    it('добавленная строка — отказ', () => {
        const extra = `${FIXED}\n${line({ kind: 'close', issue: 7, comment: 'сделано' })}`;
        const r = checkIntentRepair(DRIFTED, parse(extra));
        expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/число строк/) });
    });

    it('выброшенное поле — отказ: пропавшее значение не разметка', () => {
        const raw = line({ type: 'pr-comment', body: 'x', severity: 'blocker' });
        const r = checkIntentRepair(raw, parse(line({ kind: 'pr-comment', comment: 'x' })));
        expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/пропало severity/) });
    });

    it('поменять строки местами — отказ', () => {
        const swapped = FIXED.split('\n').reverse().join('\n');
        expect(checkIntentRepair(DRIFTED, parse(swapped))).toMatchObject({ ok: false });
    });

    it('исходная строка не JSON — отказ', () => {
        expect(
            checkIntentRepair('не json', parse(line({ kind: 'pr-block', comment: 'x' }))),
        ).toEqual({
            ok: false,
            why: 'строка 1 не объект JSON',
        });
    });
});

describe('checkIntentRepair — перестановка значений между полями (ревью 16c2)', () => {
    // Сверка с текстом исправления — так её зовёт оркестратор.
    const check = (raw: string, fixed: string) => checkIntentRepair(raw, parse(fixed), fixed);

    it('заголовок и тело new-issue поменялись местами — отказ', () => {
        const raw = line({ type: 'new-issue', name: 'T', text: 'B', labels: ['area:core'] });
        const swapped = line({ kind: 'new-issue', title: 'B', body: 'T', labels: ['area:core'] });
        expect(check(raw, swapped)).toMatchObject({
            ok: false,
            why: expect.stringMatching(/не переименование из таблицы/),
        });
        // Без перестановки та же правка принимается.
        const fixed = line({ kind: 'new-issue', title: 'T', body: 'B', labels: ['area:core'] });
        expect(check(raw, fixed)).toMatchObject({ ok: true });
    });

    it('комментарий не становится закрытием: kind берётся только из type и родни', () => {
        const raw = line({ type: 'comment', issue: 7, body: 'close' });
        const swapped = line({ kind: 'close', issue: 7, comment: 'comment' });
        expect(check(raw, swapped)).toMatchObject({
            ok: false,
            why: expect.stringMatching(/body→kind/),
        });
        expect(check(raw, line({ kind: 'comment', issue: 7, comment: 'close' }))).toMatchObject({
            ok: true,
        });
    });

    it('номер не меняет роль: issue — только из number и родни', () => {
        const raw = line({ type: 'pr-comment', body: 'x', path: 'a.ts', lineNo: 7 });
        const fixed = line({ kind: 'pr-comment', comment: 'x', path: 'a.ts', line: 7 });
        expect(check(raw, fixed)).toMatchObject({ ok: false });
    });

    it('исходный и разобранный текст расходятся числом строк — отказ', () => {
        const fixed = line({ kind: 'pr-block', comment: 'x' });
        expect(
            checkIntentRepair(
                line({ kind: 'pr-block', body: 'x' }),
                parse(fixed),
                `${fixed}\n${fixed}`,
            ),
        ).toMatchObject({ ok: false, why: expect.stringMatching(/разошлись числом строк/) });
    });
});

describe('checkIntentRepair — незнакомое поле исходной строки (ревью 16c2)', () => {
    const check = (raw: string, fixed: string) => checkIntentRepair(raw, parse(fixed), fixed);
    const raw = line({ type: 'pr-comment', body: 'x', severity: 'blocker' });

    it('исправление сохранило поле, которое парсер отбрасывает, — принимается', () => {
        const fixed = line({ kind: 'pr-comment', comment: 'x', severity: 'blocker' });
        expect(check(raw, fixed)).toEqual({
            ok: true,
            changed: 1,
            renames: ['type→kind', 'body→comment'],
        });
    });

    it('исправление выбросило его — по-прежнему отказ', () => {
        const fixed = line({ kind: 'pr-comment', comment: 'x' });
        expect(check(raw, fixed)).toMatchObject({
            ok: false,
            why: expect.stringMatching(/пропало severity/),
        });
    });

    it('исправление спрятало значение в отбрасываемое поле — отказ сверкой разбора', () => {
        // Парсер берёт comment, а «настоящее» значение уехало в незнакомый ключ.
        const fixed = line({
            kind: 'pr-comment',
            comment: 'другое',
            note: 'x',
            severity: 'blocker',
        });
        expect(check(raw, fixed)).toMatchObject({ ok: false });
    });
});

describe('intentRepairObstacle — есть ли с чем сверять', () => {
    it('батч из объектов JSON — препятствий нет', () => {
        expect(intentRepairObstacle(DRIFTED)).toBeNull();
    });

    it('строка не JSON — переспроса нет, номер строки назван', () => {
        expect(
            intentRepairObstacle(`${line({ kind: 'pr-block', comment: 'x' })}\n\n{оборвано`),
        ).toMatch(/строка 3 не объект JSON/);
        expect(intentRepairObstacle('[1,2]')).toMatch(/строка 1/);
    });

    it('отказ блока раннером — сверять не с чем', () => {
        expect(intentRepairObstacle(serializeRejectedBlock('блок не закрыт'))).toMatch(
            /только в логе/,
        );
    });
});

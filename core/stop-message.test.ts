// #289: каждая причина стопа обязана нести причину, диагноз и вопрос — а не только
// маркер «PR оставлен человеку». Тест доказывает это для ВСЕХ причин разом.
//
// Перечень берётся из КЛЮЧЕЙ `REASON_TITLES`, а не переписывается сюда руками (ревью
// #289): ручная копия, аннотированная `TStopReason[]`, гарантии не давала вовсе —
// девятое значение в типе оставило бы массив из восьми валидным, и `it.each` прошёл бы
// зелёным по восьми старым причинам. `REASON_TITLES` объявлен как
// `Record<TStopReason, string>` и без нового ключа не компилируется, поэтому
// exhaustiveness здесь держит компилятор, а не внимательность автора.
import { describe, it, expect } from 'vitest';
import { formatStopMessage, REASON_TITLES, type TStopReason } from './stop-message.ts';

const REASONS = Object.keys(REASON_TITLES) as TStopReason[];

describe('formatStopMessage — причина, диагноз и вопрос в одной строке (#289)', () => {
    it('перечень причин не пуст — иначе it.each ниже проходит вхолостую', () => {
        expect(REASONS.length).toBeGreaterThan(0);
    });

    it.each(REASONS)('причина "%s": строка содержит код причины, диагноз и вопрос', (reason) => {
        const msg = formatStopMessage({
            reason,
            diagnosis: `диагноз-для-${reason}`,
            question: `вопрос-для-${reason}`,
        });
        expect(msg).toContain(reason);
        expect(msg).toContain(`диагноз-для-${reason}`);
        expect(msg).toContain(`вопрос-для-${reason}`);
    });

    it('обрезает пробелы вокруг диагноза и вопроса — вызывающий код склеивает строку без двойных пробелов', () => {
        const msg = formatStopMessage({
            reason: 'unknown',
            diagnosis: '  пробел вокруг  ',
            question: '  и здесь  ',
        });
        expect(msg).toContain('диагноз: пробел вокруг. вопрос');
        expect(msg).toMatch(/вопрос человеку: и здесь$/);
    });

    // Ревью #289: без разделителя диагноз без своей точки («чек форжа не дал вердикта»)
    // слипался со следующим полем в одну фразу. Точку ставит модуль — он владеет форматом.
    it('дописывает точку к диагнозу без завершающего знака', () => {
        expect(
            formatStopMessage({
                reason: 'unknown',
                diagnosis: 'чек форжа не дал вердикта',
                question: 'проверь прогон руками',
            }),
        ).toContain('диагноз: чек форжа не дал вердикта. вопрос человеку:');
    });

    it.each(['.', '!', '?', '…', ':', ';'])(
        'не дублирует знак, если диагноз уже кончается на "%s"',
        (mark) => {
            const msg = formatStopMessage({
                reason: 'unknown',
                diagnosis: `диагноз${mark}`,
                question: 'вопрос',
            });
            expect(msg).toContain(`диагноз${mark} вопрос человеку:`);
        },
    );

    it('заголовок причины читаем человеком, а не только код enum', () => {
        const msg = formatStopMessage({
            reason: 'platform-check-red',
            diagnosis: 'куб test прогона 42',
            question: 'проверь лог куба',
        });
        expect(msg).toContain('красный чек площадки');
    });

    it('fix-plan называет отказ планировщика, диагноз и вопрос человеку', () => {
        const msg = formatStopMessage({
            reason: 'fix-plan',
            diagnosis: 'планировщик вернул вывод без блока плана',
            question: 'проверь отказ и перезапусти loop',
        });
        expect(msg).toContain('причина: отказ планировщика правок (fix-plan).');
        expect(msg).toContain('диагноз: планировщик вернул вывод без блока плана.');
        expect(msg).toContain('вопрос человеку: проверь отказ и перезапусти loop');
    });
});

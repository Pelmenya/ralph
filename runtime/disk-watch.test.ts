// Сторож диска (задача 95), критерий «диск ниже порога → сигнал до отказа записи». Отказа
// записи здесь нет и быть не должно: сигнал обязан прийти, пока запись ещё проходит, —
// поэтому сценарий берёт место чуть ниже порога, а не ноль.
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { diskLowMessage, evalDisk, freeBytes, maybePushDiskLow } from './disk-watch.ts';

const MB = 1024 * 1024;
const PROD = { profileName: 'prod' };

function pushSpy(result = true) {
    const sent: string[] = [];
    const fn = (msg: string) => {
        sent.push(msg);
        return result;
    };
    return { sent, fn };
}

describe('evalDisk', () => {
    it('ниже порога — low, выше — нет, нечитаемое — known:false', () => {
        expect(evalDisk(900 * MB, 1024)).toEqual({
            known: true,
            low: true,
            freeMb: 900,
            minFreeMb: 1024,
        });
        expect(evalDisk(2048 * MB, 1024)).toMatchObject({ known: true, low: false });
        expect(evalDisk(null, 1024)).toEqual({ known: false });
    });

    it('freeBytes: bavail × bsize; отказ statfs — null, а не ноль', () => {
        expect(freeBytes('/x', () => ({ bavail: 10, bsize: 4096 }))).toBe(40960);
        expect(
            freeBytes('/x', () => {
                throw new Error('EACCES');
            }),
        ).toBeNull();
        // Настоящий statfs на настоящем каталоге отвечает числом.
        expect(freeBytes(os.tmpdir())).toBeGreaterThan(0);
    });
});

describe('maybePushDiskLow — сигнал до отказа записи', () => {
    it('место ниже порога, запись ещё проходит → пуш с числами и каталогом', () => {
        // 1023 МБ свободно: любой append пройдёт, но порог 1024 уже пересечён.
        const ev = evalDisk(1023 * MB, 1024);
        const { sent, fn } = pushSpy();
        const latched = maybePushDiskLow(ev, false, { pushFn: fn, cfg: PROD, dir: '/state' });
        expect(latched).toBe(true);
        expect(sent).toEqual([diskLowMessage({ freeMb: 1023, minFreeMb: 1024 }, '/state')]);
        expect(sent[0]).toMatch(/свободно 1023 МБ при пороге 1024 МБ \(\/state\)/);
    });

    it('один пуш на эпизод; возврат выше порога снимает защёлку, новое падение — новый пуш', () => {
        const { sent, fn } = pushSpy();
        const low = evalDisk(100 * MB, 1024);
        const ok = evalDisk(5000 * MB, 1024);
        let l = maybePushDiskLow(low, false, { pushFn: fn, cfg: PROD, dir: '/s' });
        l = maybePushDiskLow(low, l, { pushFn: fn, cfg: PROD, dir: '/s' });
        expect(sent).toHaveLength(1);
        l = maybePushDiskLow(ok, l, { pushFn: fn, cfg: PROD, dir: '/s' });
        expect(l).toBe(false);
        maybePushDiskLow(low, l, { pushFn: fn, cfg: PROD, dir: '/s' });
        expect(sent).toHaveLength(2);
    });

    it('сбой доставки на prod эпизод не защёлкивает — следующий тик повторит', () => {
        const { sent, fn } = pushSpy(false);
        const low = evalDisk(100 * MB, 1024);
        const l = maybePushDiskLow(low, false, { pushFn: fn, cfg: PROD, dir: '/s' });
        expect(l).toBe(false);
        maybePushDiskLow(low, l, { pushFn: fn, cfg: PROD, dir: '/s' });
        expect(sent).toHaveLength(2);
    });

    it('не-prod профиль: подавленный пуш защёлкивается, без спама каждый тик', () => {
        const { sent, fn } = pushSpy(false);
        const low = evalDisk(100 * MB, 1024);
        const l = maybePushDiskLow(low, false, {
            pushFn: fn,
            cfg: { profileName: 'playground' },
            dir: '/s',
        });
        expect(l).toBe(true);
        maybePushDiskLow(low, l, { pushFn: fn, cfg: { profileName: 'playground' }, dir: '/s' });
        expect(sent).toHaveLength(1);
    });

    it('место выше порога — пуша нет; нечитаемое место — защёлка не меняется', () => {
        const { sent, fn } = pushSpy();
        expect(
            maybePushDiskLow(evalDisk(5000 * MB, 1024), false, {
                pushFn: fn,
                cfg: PROD,
                dir: '/s',
            }),
        ).toBe(false);
        expect(maybePushDiskLow({ known: false }, true, { pushFn: fn, cfg: PROD, dir: '/s' })).toBe(
            true,
        );
        expect(sent).toEqual([]);
    });
});

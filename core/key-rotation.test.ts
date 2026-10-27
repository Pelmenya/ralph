// Юнит-тесты ротации ключей подписки (задача 96). Модуль чистый — время, ключи и запись
// приходят аргументами, поэтому сценарии «упёрся первый / упёрлись все / рестарт» здесь
// проверяются без часов и без диска. Проводку в runClaude проверяет orchestrator.test.ts.
import { describe, it, expect } from 'vitest';
import {
    SUBSCRIPTION_KEYS_ENV,
    subscriptionKeys,
    freshRotation,
    parseKeyRotation,
    normalizeRotation,
    onKeyLimit,
    resumeAfterWait,
    keyRotateMessage,
    allKeysExhaustedMessage,
} from './key-rotation.ts';
import { API_WAIT_RE } from '../runtime/deadman.ts';

const MIN = 60_000;

describe('subscriptionKeys — список ключей из env', () => {
    it('список через запятую, пробелы и пустые элементы отброшены', () => {
        expect(subscriptionKeys({ [SUBSCRIPTION_KEYS_ENV]: ' k1, k2 ,,k3 ' })).toEqual([
            'k1',
            'k2',
            'k3',
        ]);
    });

    it('списка нет — одиночный ключ становится списком из одного', () => {
        expect(subscriptionKeys({ CLAUDE_CODE_OAUTH_TOKEN: 'solo' })).toEqual(['solo']);
    });

    it('список задан — он главнее одиночного ключа', () => {
        expect(
            subscriptionKeys({ [SUBSCRIPTION_KEYS_ENV]: 'a,b', CLAUDE_CODE_OAUTH_TOKEN: 'solo' }),
        ).toEqual(['a', 'b']);
    });

    it('повтор ключа в списке схлопывается — иначе «следующий» был бы тем же сожжённым', () => {
        expect(subscriptionKeys({ [SUBSCRIPTION_KEYS_ENV]: 'a,b,a' })).toEqual(['a', 'b']);
    });

    it('ни списка, ни ключа — пусто', () => {
        expect(subscriptionKeys({})).toEqual([]);
        expect(subscriptionKeys({ [SUBSCRIPTION_KEYS_ENV]: ' , ' })).toEqual([]);
    });
});

describe('onKeyLimit — лимит на активном ключе', () => {
    it('лимит на ключе 1 → сразу ключ 2, ожидания нет', () => {
        const step = onKeyLimit(freshRotation(3), 1000, 1000 + 60 * MIN);
        expect(step.kind).toBe('rotate');
        if (step.kind !== 'rotate') return;
        expect(step.from).toBe(0);
        expect(step.to).toBe(1);
        expect(step.rot.active).toBe(1);
        expect(step.rot.exhausted).toEqual({ 0: 1000 + 60 * MIN });
    });

    it('по кругу: с последнего ключа — на первый непомеченный', () => {
        const rot = { keyCount: 3, active: 2, exhausted: { 1: 5000 } };
        const step = onKeyLimit(rot, 1000, 9000);
        expect(step.kind === 'rotate' && step.to).toBe(0);
    });

    it('все упёрлись → ожидание до БЛИЖАЙШЕГО сброса, а не первого по порядку', () => {
        // Ключ 0 сбросится позже ключа 1: сон до 0-го был бы лишним часом простоя.
        let rot = freshRotation(3);
        let step = onKeyLimit(rot, 0, 300 * MIN);
        rot = step.rot;
        step = onKeyLimit(rot, 0, 100 * MIN);
        rot = step.rot;
        step = onKeyLimit(rot, 0, 200 * MIN);
        expect(step.kind).toBe('wait');
        if (step.kind !== 'wait') return;
        expect(step.waitUntilMs).toBe(100 * MIN);
        expect(step.next).toBe(1);
    });

    it('истёкшая метка не держит ключ: он снова кандидат', () => {
        const rot = { keyCount: 2, active: 0, exhausted: { 1: 500 } };
        const step = onKeyLimit(rot, 1000, 9000);
        expect(step.kind === 'rotate' && step.to).toBe(1);
        expect(step.rot.exhausted).toEqual({ 0: 9000 });
    });
});

describe('resumeAfterWait — после сна ключ ближайшего сброса снова активен', () => {
    it('метка снята, активный — дождавшийся', () => {
        const rot = { keyCount: 2, active: 1, exhausted: { 0: 200, 1: 100 } };
        expect(resumeAfterWait(rot, 1)).toEqual({ keyCount: 2, active: 1, exhausted: { 0: 200 } });
    });
});

describe('normalizeRotation — рестарт не начинает с сожжённого ключа', () => {
    it('активный помечен и не сброшен → первый непомеченный по кругу', () => {
        const rot = { keyCount: 3, active: 0, exhausted: { 0: 5000 } };
        expect(normalizeRotation(rot, 1000).active).toBe(1);
    });

    it('сброс прошёл — метка снимается, ключ остаётся активным', () => {
        const rot = { keyCount: 2, active: 0, exhausted: { 0: 500 } };
        expect(normalizeRotation(rot, 1000)).toEqual({ keyCount: 2, active: 0, exhausted: {} });
    });

    it('помечены все → активным становится ключ с ближайшим сбросом', () => {
        const rot = { keyCount: 3, active: 0, exhausted: { 0: 9000, 1: 3000, 2: 7000 } };
        expect(normalizeRotation(rot, 1000).active).toBe(1);
    });
});

describe('parseKeyRotation — файл ротации с диска', () => {
    it('валидный файл читается как есть', () => {
        const text = JSON.stringify({ keyCount: 2, active: 1, exhausted: { 0: 123 } });
        expect(parseKeyRotation(text, 2)).toEqual({
            rot: { keyCount: 2, active: 1, exhausted: { 0: 123 } },
        });
    });

    it('файла нет — свежая ротация без причины', () => {
        expect(parseKeyRotation(null, 2)).toEqual({ rot: freshRotation(2) });
    });

    it('число ключей сменилось — индексы больше не значат те же ключи, начинаем заново вслух', () => {
        const text = JSON.stringify({ keyCount: 3, active: 2, exhausted: { 2: 1 } });
        const r = parseKeyRotation(text, 2);
        expect(r.rot).toEqual(freshRotation(2));
        expect(r.reason).toMatch(/3.*2/);
    });

    it.each([
        ['не JSON', '{'],
        ['active вне списка', JSON.stringify({ keyCount: 2, active: 5, exhausted: {} })],
        ['метка не числом', JSON.stringify({ keyCount: 2, active: 0, exhausted: { 0: 'x' } })],
        [
            'индекс метки вне списка',
            JSON.stringify({ keyCount: 2, active: 0, exhausted: { 7: 1 } }),
        ],
    ])('%s — свежая ротация с названной причиной', (_name, text) => {
        const r = parseKeyRotation(text, 2);
        expect(r.rot).toEqual(freshRotation(2));
        expect(r.reason).toBeTruthy();
    });
});

describe('тексты ротации', () => {
    it('строка ротации называет номера ключей, а не значения', () => {
        const msg = keyRotateMessage(0, 1, 3);
        expect(msg).toContain('1/3');
        expect(msg).toContain('2/3');
    });

    it('пуш «все ключи упёрлись» матчится API_WAIT_RE deadman — режим apiwait, а не ложный DEADMAN', () => {
        const msg = `🔔 PUSH: ${allKeysExhaustedMessage(42 * MIN, 0, 3, 2)}`;
        expect(msg).toMatch(/все ключи/i);
        expect(API_WAIT_RE.exec(msg)?.[1]).toBe('42');
    });
});

// Активация ревизии и журнал активации (#38). Чистые функции на подменённом чтении; боевое
// хранилище — под предохранителем побочек, его отказ проверяется здесь же.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
    ACTIVATION_RESTART_EXIT,
    LOCK_AHEAD_PHRASE,
    activationBoundary,
    activationFileStore,
    checkLockDrift,
    describeActivation,
    doctorActivationLine,
    parseActivationJournal,
    recordActivation,
    type TActivationStore,
} from './core-activation.ts';
import { CORE_LOCK_PATH, CORE_LOCK_SCHEMA, currentCoreVersions } from './core-install.ts';
import { sideEffectAttempts } from '../shared/side-effect-guard.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(64);
const ROOT = '/path/to/app';

const lockText = (sha: string): string =>
    JSON.stringify({
        schema: CORE_LOCK_SCHEMA,
        sha,
        treeHash: `sha256:${'0'.repeat(64)}`,
        versions: currentCoreVersions(),
    });

function memStore(initial: string | null = null): TActivationStore & { text: string | null } {
    const s = {
        text: initial,
        read: () => s.text,
        append: (line: string) => {
            s.text = (s.text ?? '') + line;
        },
    };
    return s;
}

describe('checkLockDrift', () => {
    it('lock называет исполняемую ревизию — расхождения нет', () => {
        expect(checkLockDrift(A, ROOT, () => lockText(A))).toBeNull();
    });

    it('lock сменился — фраза «нужен рестарт» и обе ревизии', () => {
        const seen: string[] = [];
        const d = checkLockDrift(A, ROOT, (p) => {
            seen.push(p);
            return lockText(B);
        });
        expect(seen).toEqual([join(ROOT, CORE_LOCK_PATH)]);
        expect(d?.lockSha).toBe(B);
        expect(d?.reason).toContain(LOCK_AHEAD_PHRASE);
        expect(d?.reason).toContain(A);
        expect(d?.reason).toContain(B);
    });

    it('lock перестал читаться — тоже расхождение, без ревизии', () => {
        const gone = checkLockDrift(A, ROOT, () => {
            throw Object.assign(new Error('нет'), { code: 'ENOENT' });
        });
        expect(gone?.lockSha).toBeNull();
        expect(gone?.reason).toMatch(/перестал читаться.*нужен рестарт/);
        const broken = checkLockDrift(A, ROOT, () => '{');
        expect(broken?.lockSha).toBeNull();
    });
});

describe('activationBoundary', () => {
    it('сдачи нет или она доведена — граница подтверждена', () => {
        expect(activationBoundary(null)).toEqual({ ok: true });
        expect(activationBoundary({ resumeStage: null })).toEqual({ ok: true });
    });

    it('сдача с незакрытым этапом — не граница, причина названа', () => {
        const b = activationBoundary({ resumeStage: 'merge' });
        expect(b.ok).toBe(false);
        expect(!b.ok && b.reason).toMatch(/сдача фазы не доведена.*merge/);
    });
});

describe('журнал активации', () => {
    const now = () => '2026-10-27T10:00:00.000Z';

    it('первая активация — from null; повтор той же ревизии строки не пишет', () => {
        const s = memStore();
        expect(recordActivation(A, s, now)).toEqual({ at: now(), sha: A, from: null });
        expect(recordActivation(A, s, now)).toBeNull();
        expect(parseActivationJournal(s.text ?? '')).toHaveLength(1);
    });

    it('смена ревизии — строка «с какой снята»', () => {
        const s = memStore();
        recordActivation(A, s, now);
        expect(recordActivation(C, s, now)).toEqual({ at: now(), sha: C, from: A });
        expect(parseActivationJournal(s.text ?? '').map((e) => e.sha)).toEqual([A, C]);
    });

    it('битая строка — отказ с номером строки, а не пропуск', () => {
        const good = JSON.stringify({ at: now(), sha: A, from: null });
        expect(() => parseActivationJournal(`${good}\n{\n`)).toThrow(/строка 2: не JSON/);
        expect(() => parseActivationJournal('[]')).toThrow(/не объект/);
        expect(() => parseActivationJournal('{"sha":"x"}')).toThrow(/нет времени/);
        expect(() => parseActivationJournal(`{"at":"${now()}","sha":"abc","from":null}`)).toThrow(
            /sha не полный/,
        );
        expect(() => parseActivationJournal(`{"at":"${now()}","sha":"${A}","from":"abc"}`)).toThrow(
            /from/,
        );
        expect(() => recordActivation(B, memStore('{'), now)).toThrow(/строка 1/);
    });

    it('строка лога называет обе ревизии', () => {
        expect(describeActivation({ at: now(), sha: B, from: A })).toMatch(
            new RegExp(`${B}.*снята ${A}`),
        );
        expect(describeActivation({ at: now(), sha: B, from: null })).toMatch(
            /прежней в журнале нет/,
        );
    });

    it('боевое хранилище под предохранителем побочек', () => {
        const store = activationFileStore('/path/to/state/ralph.activations.jsonl');
        expect(() => store.read()).toThrow();
        expect(() => store.append('x\n')).toThrow();
        sideEffectAttempts.length = 0;
    });
});

describe('doctorActivationLine', () => {
    const at = '2026-10-27T10:00:00.000Z';
    const two = [
        JSON.stringify({ at, sha: A, from: null }),
        JSON.stringify({ at, sha: B, from: A }),
    ].join('\n');

    it('журнал читается — последняя активация, с какой снята, число записей', () => {
        const l = doctorActivationLine(memStore(two), B);
        expect(l).toEqual({
            ok: true,
            line: `журнал активации: последняя — ${B} (${at}), снята ${A}; записей 2`,
        });
    });

    it('lock впереди последней активации — предупреждение «нужен рестарт»', () => {
        const l = doctorActivationLine(memStore(two), C);
        expect(l.ok).toBe(true);
        expect(l.warn).toBe(true);
        expect(l.line).toContain(`lock называет ${C} — нужен рестарт`);
    });

    it('журнала нет — сказано вслух; битый — провал', () => {
        expect(doctorActivationLine(memStore(null), A).line).toMatch(/пуст/);
        const bad = doctorActivationLine(memStore('{'), A);
        expect(bad.ok).toBe(false);
        expect(bad.line).toMatch(/не читается.*строка 1/);
        const first = doctorActivationLine(
            memStore(JSON.stringify({ at, sha: A, from: null })),
            null,
        );
        expect(first.line).toContain('прежней в журнале нет');
    });
});

it('код рестарта отличен от штатного конца и стопа по существу', () => {
    expect([0, 1]).not.toContain(ACTIVATION_RESTART_EXIT);
});

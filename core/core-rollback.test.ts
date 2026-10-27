// Решения отката (#103) без диска: цель по журналу, необратимость миграции state, набор
// ревизий, которые чистка обязана оставить. Порядок шагов команды — `launcher.test.ts`.
import { describe, expect, it } from 'vitest';
import { supportedVersions } from './compat.ts';
import { CORE_LOCK_SCHEMA, type TCoreLock } from './core-install.ts';
import {
    FIX_FORWARD_HINT,
    irreversibleStateProblem,
    pruneCandidates,
    retainedRevisions,
    rollbackBranchName,
    rollbackPrText,
    rollbackTarget,
} from './core-rollback.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const at = '2026-10-27T00:00:00.000Z';
const V = supportedVersions();
const lockOf = (sha: string, state = V.state): TCoreLock => ({
    schema: CORE_LOCK_SCHEMA,
    sha,
    treeHash: 'f'.repeat(64),
    versions: { ...V, state },
});

describe('rollbackTarget', () => {
    it('цель — ревизия, с которой снята ревизия из lock', () => {
        const j = [
            { at, sha: A, from: null },
            { at, sha: B, from: A },
        ];
        expect(rollbackTarget(j, B)).toEqual({ ok: true, sha: A });
    });

    it('берётся последняя активация ревизии из lock, а не первая', () => {
        const j = [
            { at, sha: A, from: null },
            { at, sha: B, from: A },
            { at, sha: C, from: B },
            { at, sha: B, from: C },
        ];
        expect(rollbackTarget(j, B)).toEqual({ ok: true, sha: C });
    });

    it('lock впереди журнала — цель исполняемая ревизия (последняя активация)', () => {
        const j = [
            { at, sha: A, from: null },
            { at, sha: B, from: A },
        ];
        expect(rollbackTarget(j, C)).toEqual({ ok: true, sha: B });
    });

    it('журнал пуст — отказ: откатываться не на что', () => {
        const r = rollbackTarget([], A);
        expect(r).toEqual({ ok: false, reason: expect.stringMatching(/журнал активации пуст/) });
    });

    it('ревизия из lock первая в журнале — отказ', () => {
        const r = rollbackTarget([{ at, sha: A, from: null }], A);
        expect(r).toEqual({ ok: false, reason: expect.stringMatching(/прежней нет/) });
    });
});

describe('irreversibleStateProblem', () => {
    const ok = { kind: 'version' as const, version: V.state };

    it('схема state та же, state на диске той же схемы — откат возможен', () => {
        expect(irreversibleStateProblem({ target: V, current: lockOf(B), state: ok })).toBeNull();
    });

    it('state нет — откат возможен', () => {
        const state = { kind: 'absent' as const, note: 'нет' };
        expect(irreversibleStateProblem({ target: V, current: lockOf(B), state })).toBeNull();
    });

    it('ревизия из lock подняла схему — отказ с подсказкой «фикс вперёд»', () => {
        const r = irreversibleStateProblem({
            target: V,
            current: lockOf(B, V.state + 1),
            state: ok,
        });
        expect(r).toMatch(/необратимая миграция/);
        expect(r).toContain(FIX_FORWARD_HINT);
    });

    it('state на диске новее, чем читает цель, — отказ, даже если lock схему не поднимал', () => {
        const state = { kind: 'version' as const, version: V.state + 1 };
        const r = irreversibleStateProblem({ target: V, current: lockOf(B), state });
        expect(r).toMatch(new RegExp(`на диске схема v${String(V.state + 1)}`));
        expect(r).toContain(FIX_FORWARD_HINT);
    });

    it('state не читается — отказ: вслепую не откатываемся', () => {
        const state = { kind: 'invalid' as const, reason: 'state повреждён: x' };
        const r = irreversibleStateProblem({ target: V, current: lockOf(B), state });
        expect(r).toMatch(/state повреждён: x — схему не проверить/);
    });
});

describe('текст PR отката', () => {
    it('своя ветка, не совпадающая с веткой update', () => {
        expect(rollbackBranchName(A)).toBe(`ralph/rollback-${A.slice(0, 12)}`);
    });

    it('было / стало и версии цели', () => {
        const t = rollbackPrText(lockOf(B), lockOf(A));
        expect(t.title).toBe(`revert(core): откат ревизии ядра на ${A.slice(0, 12)}`);
        expect(t.body).toContain(`было: \`${B}\``);
        expect(t.body).toContain(`стало: \`${A}\``);
        expect(t.message.startsWith(`${t.title}\n\n`)).toBe(true);
    });
});

describe('чистка старых ревизий', () => {
    const journal = [
        { at, sha: A, from: null },
        { at, sha: B, from: A },
        { at, sha: C, from: B },
    ];

    it('ревизия, на которую возможен откат, не трогается', () => {
        const keep = retainedRevisions(journal, C);
        expect([...keep].sort()).toEqual([B, C]);
        const gone = pruneCandidates([A, B, C, D], [keep]);
        expect(gone).toEqual([A, D]);
        expect(gone).not.toContain(B);
    });

    it('lock впереди журнала — держатся и lock, и исполняемая, и её прежняя', () => {
        const keep = retainedRevisions(journal, D);
        expect([...keep].sort()).toEqual([C, D]);
        expect(pruneCandidates([A, B, C, D], [keep])).toEqual([A, B]);
    });

    it('наборы нескольких потребителей складываются', () => {
        const other = new Set([A]);
        expect(pruneCandidates([A, B, C, D], [retainedRevisions(journal, C), other])).toEqual([D]);
    });

    it('не-ревизии каталога установок (недоустановка, чужие файлы) не кандидаты', () => {
        const partial = `.${D}.partial-123-x`;
        expect(pruneCandidates([partial, 'notes.txt', D], [new Set()])).toEqual([D]);
    });

    it('пустой журнал — держится только lock', () => {
        expect([...retainedRevisions([], A)]).toEqual([A]);
    });
});

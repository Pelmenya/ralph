import { describe, expect, it } from 'vitest';
import { formatPhaseReload, formatRestartKeys, reconcilePhases } from './phase-reload.ts';

const base = (o: Record<string, unknown> = {}) => ({
    active: true,
    authorAllowlist: ['owner'],
    profileName: 'prod',
    phases: [
        { milestone: 'M1', branch: 'feature/m1' },
        { milestone: 'M2', branch: 'feature/m2' },
    ],
    ...o,
});

describe('reconcilePhases (#221)', () => {
    it('фаза, вставленная между текущей и следующей, становится следующей', () => {
        const fresh = base({
            phases: [
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M1b', branch: 'feature/m1b' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        const r = reconcilePhases({ running: base(), fresh, currentMilestone: 'M1' });
        expect(r).toMatchObject({ kind: 'ok', index: 0, added: ['M1b'], removed: [] });
        if (r.kind !== 'ok') throw new Error('ожидался ok');
        expect(r.phases[r.index + 1].milestone).toBe('M1b');
        expect(r.restartKeys).toEqual([]);
        expect(formatPhaseReload(r)).toBe(
            '🗂 Список фаз перечитан: добавлено "M1b", следующая — "M1b".',
        );
    });

    it('reviewBase переносится из свежей строки, а без поля ключ не появляется', () => {
        const reviewBase = 'a'.repeat(40);
        const withBase = reconcilePhases({
            running: base(),
            fresh: base({
                phases: [
                    { milestone: 'M1', branch: 'feature/m1' },
                    { milestone: 'M2', branch: 'feature/m2', reviewBase },
                ],
            }),
            currentMilestone: 'M1',
        });
        if (withBase.kind !== 'ok') throw new Error('ожидался ok');
        expect(withBase.phases[1]).toEqual({
            milestone: 'M2',
            branch: 'feature/m2',
            reviewBase,
        });

        const withoutBase = reconcilePhases({
            running: base(),
            fresh: base(),
            currentMilestone: 'M1',
        });
        if (withoutBase.kind !== 'ok') throw new Error('ожидался ok');
        expect(withoutBase.phases[1]).not.toHaveProperty('reviewBase');
    });

    it('reviewBase не строкой — отказ перечитывания с именем поля', () => {
        const r = reconcilePhases({
            running: base(),
            fresh: base({
                phases: [
                    { milestone: 'M1', branch: 'feature/m1' },
                    { milestone: 'M2', branch: 'feature/m2', reviewBase: 5 },
                ],
            }),
            currentMilestone: 'M1',
        });
        expect(r).toMatchObject({
            kind: 'refused',
            reason: expect.stringMatching(/phases\[1\]\.reviewBase/),
        });
    });

    it('без изменений — «добавлено ничего», убранная фаза названа', () => {
        const same = reconcilePhases({ running: base(), fresh: base(), currentMilestone: 'M1' });
        if (same.kind !== 'ok') throw new Error('ожидался ok');
        expect(formatPhaseReload(same)).toMatch(/добавлено ничего, следующая — "M2"/);

        const cut = reconcilePhases({
            running: base(),
            fresh: base({ phases: [{ milestone: 'M1', branch: 'feature/m1' }] }),
            currentMilestone: 'M1',
        });
        if (cut.kind !== 'ok') throw new Error('ожидался ok');
        expect(cut.removed).toEqual(['M2']);
        expect(formatPhaseReload(cut)).toMatch(
            /убрано "M2", следующая — нет \(фазы списка пройдены\)/,
        );
    });

    it('индекс текущей фазы — в свежем списке, даже если пройденную фазу убрали', () => {
        const running = base({
            phases: [
                { milestone: 'M0', branch: 'feature/m0' },
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        const r = reconcilePhases({ running, fresh: base(), currentMilestone: 'M1' });
        expect(r).toMatchObject({ kind: 'ok', index: 0, removed: ['M0'] });
    });

    // «От противного»: на каждом отказе следующей фазы по старому списку нет.
    it.each([
        [
            'текущая фаза удалена',
            base({ phases: [{ milestone: 'M2', branch: 'feature/m2' }] }),
            /текущей фазы "M1" нет/,
        ],
        ['phases пуст', base({ phases: [] }), /нет phases/],
        ['фаза без ветки', base({ phases: [{ milestone: 'M1' }] }), /phases\[0\]\.branch/],
        ['фаза не объект', base({ phases: ['M1'] }), /phases\[0\] — не объект/],
        [
            'веха дважды',
            base({
                phases: [
                    { milestone: 'M1', branch: 'a' },
                    { milestone: 'M1', branch: 'b' },
                ],
            }),
            /дважды/,
        ],
        ['active=false', base({ active: false }), /active=false/],
        ['allowlist пуст', base({ authorAllowlist: [] }), /authorAllowlist/],
        [
            'фаза вставлена перед текущей',
            base({
                phases: [
                    { milestone: 'M0', branch: 'feature/m0' },
                    { milestone: 'M1', branch: 'feature/m1' },
                ],
            }),
            /перед текущей фазой "M1" появились "M0"/,
        ],
    ])('%s → отказ с причиной', (_name, fresh, reason) => {
        const r = reconcilePhases({ running: base(), fresh, currentMilestone: 'M1' });
        expect(r.kind).toBe('refused');
        if (r.kind !== 'refused') throw new Error('ожидался отказ');
        expect(r.reason).toMatch(reason);
        expect(r).not.toHaveProperty('phases');
    });

    // Ревью 16c3: смердженная фаза, переставленная после текущей, проходила сверку.
    it('прежняя фаза переставлена после текущей — отказ с её именем', () => {
        const running = base({
            phases: [
                { milestone: 'M0', branch: 'feature/m0' },
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        const fresh = base({
            phases: [
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M0', branch: 'feature/m0' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        const r = reconcilePhases({ running, fresh, currentMilestone: 'M1' });
        expect(r.kind).toBe('refused');
        if (r.kind !== 'refused') throw new Error('ожидался отказ');
        expect(r.reason).toMatch(/после текущей фазы "M1" встали прежние "M0"/);
    });

    it('накопитель исполняемого конфига в phases — отказ, даже если ключ в файле сменили', () => {
        const running = base({ review: { backlogMilestone: ['Inbox'] } });
        const fresh = base({
            review: { backlogMilestone: 'Inbox2' },
            phases: [
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'Inbox', branch: 'feature/inbox' },
            ],
        });
        const r = reconcilePhases({ running, fresh, currentMilestone: 'M1' });
        expect(r).toMatchObject({ kind: 'refused' });
        if (r.kind !== 'refused') throw new Error('ожидался отказ');
        expect(r.reason).toMatch(/"Inbox" — накопитель/);
    });

    it('изменение roots — ключ рестарта по имени из файла, список фаз всё равно свежий', () => {
        const running = base({
            roots: { consumerRoot: '/path/to/app' },
            rootsResolved: { consumerRoot: '/path/to/app' },
            productRootFrom: 'config',
        });
        const fresh = base({
            roots: { consumerRoot: '/path/to/other' },
            rootsResolved: { consumerRoot: '/path/to/other' },
            productRootFrom: 'config',
            phases: [
                { milestone: 'M1', branch: 'feature/m1' },
                { milestone: 'M1b', branch: 'feature/m1b' },
                { milestone: 'M2', branch: 'feature/m2' },
            ],
        });
        const r = reconcilePhases({ running, fresh, currentMilestone: 'M1' });
        expect(r).toMatchObject({ kind: 'ok', restartKeys: ['roots'], added: ['M1b'] });
    });

    it('порядок ключей объекта изменением не считается; сменённый профиль — считается', () => {
        const running = base({ review: { a: 1, b: 2 } });
        const fresh = base({ review: { b: 2, a: 1 } });
        expect(reconcilePhases({ running, fresh, currentMilestone: 'M1' })).toMatchObject({
            restartKeys: [],
        });
        expect(
            reconcilePhases({ running, fresh, currentMilestone: 'M1', profileChanged: 'dev' }),
        ).toMatchObject({ restartKeys: ['defaultProfile'] });
        expect(
            reconcilePhases({
                running,
                fresh: base({ review: { a: 1 }, runtime: 'x' }),
                currentMilestone: 'M1',
            }),
        ).toMatchObject({ restartKeys: ['review', 'runtime'] });
    });

    it('строка ⚠ называет ключи, пустой список — без строки', () => {
        expect(formatRestartKeys([])).toBeNull();
        expect(formatRestartKeys(['roots'])).toMatch(
            /^⚠ Конфиг: изменились roots — .*на прежних значениях/,
        );
    });
});

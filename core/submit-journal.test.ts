import { describe, expect, it } from 'vitest';
import { inspectState } from './state-lock.ts';
import {
    attachSubmitJournal,
    finishStage,
    formatSubmitSummary,
    parseSubmitJournal,
    startStage,
    stateToDisk,
    submittedOf,
    summarizeSubmit,
    SUBMIT_STAGES,
    withArbitrated,
    withDeployBlock,
    withSubmitted,
    type TSubmitRecord,
    type TSubmitStage,
} from './submit-journal.ts';

const AT = '2026-10-26T00:00:00.000Z';
type TFlags = {
    milestone: string | null;
    submitted?: unknown;
    deployBlock?: unknown;
    reviewOfFixes?: unknown;
    submitStages?: TSubmitRecord[];
};
const M = 'M1';

/** Журнал, в котором этапы до `stage` доведены, а сам `stage` начат и брошен. */
function brokenAt(stage: TSubmitStage): TSubmitRecord[] {
    let r: TSubmitRecord[] = [];
    for (const s of SUBMIT_STAGES) {
        r = startStage(r, M, s, AT);
        if (s === stage) break;
        r = finishStage(r, M, s, 'ok', AT);
    }
    return r;
}

const PENDING = { status: 'pending', milestone: M, sha: null, reason: 'не досмотрен' };
const RED = { status: 'completed', milestone: M, sha: 'abc', reason: 'workflow failure' };

describe('журнал этапов сдачи (#93): исход у каждого этапа', () => {
    it.each(SUBMIT_STAGES.map((s) => [s]))('рестарт посреди «%s» продолжает с него', (stage) => {
        const records = parseSubmitJournal(JSON.parse(JSON.stringify(brokenAt(stage))), 'тест');
        const s = summarizeSubmit(records);
        expect(s?.resumeStage).toBe(stage);
        expect(s?.stages.find((x) => x.stage === stage)?.status).toBe('не завершён');
    });

    it('стоп этапа сдачи не кончает попытку: рестарт повторяет остановленный этап', () => {
        let r = brokenAt('review');
        r = finishStage(r, M, 'review', 'stop', AT);
        const s = summarizeSubmit(r)!;
        expect(s.resumeStage).toBe('review');
        expect(s.stages[1].status).toBe('остановлен');
        expect(formatSubmitSummary(s)).toContain('продолжаю с этапа «ревью»');
        // Повторный вход в остановленный этап — не запись поверх стопа, а усечение.
        const again = startStage(r, M, 'review', AT);
        expect(() => parseSubmitJournal(again, 'тест')).not.toThrow();
        expect(again.filter((x) => x.stage === 'review')).toHaveLength(1);
    });

    it('повторный вход в гейт усекает журнал до гейта: исход мерджа прошлого прохода снят', () => {
        let r = brokenAt('merge');
        r = finishStage(r, M, 'merge', 'stop', AT, { reason: 'отказ форжа' });
        r = startStage(r, M, 'gate', AT);
        expect(r.some((x) => x.stage === 'merge')).toBe(false);
        expect(summarizeSubmit(r)?.resumeStage).toBe('gate');
    });

    it('этап через голову недоделанного не пишется — бросок, а не тихая запись', () => {
        expect(() => startStage(brokenAt('review'), M, 'gate', AT)).toThrow(/раньше исхода/);
    });

    it('открытый этап не дублируется: брошенный прошлым процессом повторяется под тем же началом', () => {
        const r = brokenAt('fixes');
        expect(startStage(r, M, 'fixes', AT)).toEqual(r);
    });

    it('деплой с исходом — попытка доведена, журнал пуст', () => {
        expect(finishStage(brokenAt('deploy'), M, 'deploy', 'ok', AT)).toEqual([]);
        expect(finishStage(brokenAt('deploy'), M, 'deploy', 'skip', AT)).toEqual([]);
    });

    it.each([
        ['не массив', {}],
        [
            'исход без начала',
            [
                {
                    v: 1,
                    track: 'submit',
                    milestone: M,
                    stage: 'pr',
                    event: 'outcome',
                    outcome: 'ok',
                    at: AT,
                },
            ],
        ],
        [
            'этап не по порядку',
            [{ v: 1, track: 'submit', milestone: M, stage: 'review', event: 'start', at: AT }],
        ],
        [
            'неизвестный исход',
            [...brokenAt('pr'), { ...brokenAt('pr')[0], event: 'outcome', outcome: 'maybe' }],
        ],
        [
            'запись чужой фазы',
            [...brokenAt('review').slice(0, 2), { ...brokenAt('review')[2], milestone: 'M2' }],
        ],
        [
            'запись после стопа',
            [...finishStage(brokenAt('pr'), M, 'pr', 'stop', AT), brokenAt('review')[2]],
        ],
        [
            'неизвестный этап',
            [{ v: 1, track: 'submit', milestone: M, stage: 'qa', event: 'start', at: AT }],
        ],
        [
            'барьер деплоя без причины',
            [
                ...brokenAt('deploy').slice(0, -1),
                { ...brokenAt('deploy').at(-1), detail: { status: 'pending' } },
            ],
        ],
    ])('%s — повреждение с диагнозом, а не пропуск', (_name, raw) => {
        expect(() => parseSubmitJournal(raw, 'state.submitStages')).toThrow(/Журнал сдачи/);
    });
});

describe('чекпоинты сдачи — проекции журнала (#93)', () => {
    it('submitted: арбитр с исходом и мерджа ещё нет', () => {
        expect(submittedOf(brokenAt('arbiter'), M)).toBe(false);
        expect(submittedOf(brokenAt('gate'), M)).toBe(true);
        expect(submittedOf(brokenAt('merge'), M)).toBe(true);
        expect(submittedOf(brokenAt('deploy'), M)).toBe(false);
        expect(submittedOf(brokenAt('gate'), 'M2')).toBe(false);
    });

    it('сброс submitted — новая попытка; попытку за мерджем (барьер деплоя) не трогает', () => {
        expect(withSubmitted(brokenAt('gate'), M, false, AT)).toEqual([]);
        const deploy = withDeployBlock(brokenAt('deploy'), PENDING, AT);
        expect(withSubmitted(deploy, M, false, AT)).toEqual(deploy);
    });

    it('сброс лестницы при переходе фазы не снимает барьер деплоя', () => {
        // Регресс: усечение до арбитра снимало бы этап деплоя вместе с барьером.
        const withArb = withArbitrated(brokenAt('arbiter'), M, true, AT);
        let r = withArb;
        for (const s of ['gate', 'merge'] as const) r = finishStage(r, M, s, 'ok', AT);
        r = withDeployBlock(r, PENDING, AT);
        expect(withArbitrated(r, M, false, AT)).toEqual(r);
    });

    it('барьер деплоя: pending — начат без исхода, красный — стоп, снятие — попытка доведена', () => {
        const pending = withDeployBlock([], PENDING, AT);
        expect(summarizeSubmit(pending)?.resumeStage).toBe('deploy');
        const red = withDeployBlock(pending, RED, AT);
        expect(summarizeSubmit(red)?.stages.at(-1)?.status).toBe('остановлен');
        expect(withDeployBlock(red, null, AT)).toEqual([]);
        expect(() => withDeployBlock([], { status: 'red' }, AT)).toThrow(/milestone и reason/);
    });

    it('аксессоры state: запись флага уходит в журнал, чтение — проекция', () => {
        const st = attachSubmitJournal<TFlags>({ milestone: M, submitted: false });
        expect(st.submitStages).toEqual([]);
        st.submitted = true;
        expect(st.submitted).toBe(true);
        expect(summarizeSubmit(st.submitStages ?? [])?.resumeStage).toBe('gate');
        st.deployBlock = PENDING;
        expect(st.deployBlock).toEqual(PENDING);
        expect(st.submitted).toBe(false);
        st.deployBlock = null;
        expect(st.submitStages).toEqual([]);
    });

    it('копия state через JSON несёт флаги, а не журнал; диск — журнал, а не флаги', () => {
        const st = attachSubmitJournal({
            milestone: M as string | null,
            submitted: true,
            reviewOfFixes: { passes: 1, arbitrated: true },
        });
        const copy = JSON.parse(JSON.stringify(st)) as Record<string, unknown>;
        expect(copy.submitted).toBe(true);
        expect(copy.reviewOfFixes).toMatchObject({ arbitrated: true });
        expect(copy.submitStages).toBeUndefined();
        const disk = stateToDisk(st);
        expect(disk.submitted).toBeUndefined();
        expect(disk.deployBlock).toBeUndefined();
        expect(disk.reviewOfFixes).toEqual({ passes: 1 });
        expect(Array.isArray(disk.submitStages)).toBe(true);
    });
});

describe('миграция state старого формата (#93): флаги → журнал, проверенно', () => {
    const v1 = {
        schemaVersion: 1,
        count: 3,
        milestone: M,
        submitted: true,
        noProgress: 0,
        reviewOfFixes: {
            passes: 2,
            rounds: 3,
            answered: [],
            disputes: {},
            settled: [],
            arbitrated: true,
        },
        deployBlock: null,
    };

    it('v1 с submitted и arbitrated → журнал до гейта, флаги читаются те же', () => {
        const r = inspectState(JSON.stringify(v1));
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.migrated).toBe(true);
        expect(r.state.schemaVersion).toBe(2);
        expect(r.state.submitted).toBe(true);
        expect(r.state.reviewOfFixes).toMatchObject({ passes: 2, arbitrated: true });
        const s = summarizeSubmit(r.state.submitStages ?? [])!;
        expect(s.resumeStage).toBe('gate');
        expect(s.stages.find((x) => x.stage === 'arbiter')?.status).toBe('выполнен');
    });

    it('v1 с submitted без вердикта арбитра → arbitrated остаётся false', () => {
        const r = inspectState(
            JSON.stringify({ ...v1, reviewOfFixes: { ...v1.reviewOfFixes, arbitrated: false } }),
        );
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.state.submitted).toBe(true);
        // Флаг «сдано» о вердикте не говорит: арбитр восстановлен `skip`, а не `ok`.
        expect(r.state.reviewOfFixes).toMatchObject({ arbitrated: false });
        const s = summarizeSubmit(r.state.submitStages ?? [])!;
        expect(s.stages.find((x) => x.stage === 'arbiter')?.status).toBe('пропущен');
    });

    it('v0 (без версии) с барьером деплоя → этап деплоя, барьер держит', () => {
        const r = inspectState(
            JSON.stringify({ count: 0, milestone: 'M2', submitted: false, deployBlock: RED }),
        );
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.state.deployBlock).toEqual(RED);
        expect(r.state.submitted).toBe(false);
    });

    it('мигрированный state пишется v2 и читается обратно без потерь', () => {
        const r = inspectState(JSON.stringify({ ...v1, deployBlock: null }));
        if (r.status !== 'ok') throw new Error(r.status);
        const again = inspectState(JSON.stringify(stateToDisk(r.state)));
        expect(again).toMatchObject({ status: 'ok', migrated: false });
        if (again.status !== 'ok') return;
        expect(again.state.submitted).toBe(true);
        expect(again.state.reviewOfFixes).toMatchObject({ arbitrated: true });
        expect(again.state.submitStages).toEqual(r.state.submitStages);
    });

    it('v1 с битым барьером — повреждение, а не миграция', () => {
        const r = inspectState(JSON.stringify({ ...v1, deployBlock: { status: 'red' } }));
        expect(r).toMatchObject({ status: 'corrupt' });
    });

    it.each([
        ['флаг submitted рядом с журналом', { submitted: true }],
        ['флаг deployBlock рядом с журналом', { deployBlock: RED }],
        ['arbitrated полем лестницы', { reviewOfFixes: { arbitrated: true } }],
        ['без журнала', { submitStages: undefined }],
        ['журнал не по порядку', { submitStages: brokenAt('review').slice(1) }],
    ])(
        'v2: %s — повреждение: два источника правды или журнал, по которому решать нельзя',
        (_n, over) => {
            const r = inspectState(
                JSON.stringify({
                    schemaVersion: 2,
                    count: 0,
                    milestone: M,
                    submitStages: [],
                    ...over,
                }),
            );
            expect(r.status).toBe('corrupt');
        },
    );
});

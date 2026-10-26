// Разбор чека PR на площадке — на ФИКСТУРАХ живых ответов (#269).
//
// Живой API в автоматический прогон не ставится: он сетевой и меняется без нашего ведома.
// Здесь проверяется, что разбор совместим с тем, что сервер отдал 06.09.2026, — сами
// ответы лежат рядом в `__fixtures__/` вместе с пояснением, что в них обрезано.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourcecraftApi } from './sourcecraft-task-source.ts';
import { createSourcecraftCiChecks, failureExcerpt, stripAnsi } from './sourcecraft-ci-checks.ts';
// Классификатор ядра — намеренно НЕ копия: проверяется стык двух половин, а не одна.
import { classifyForgeFailure } from '../core/forge-checks.ts';

const FX = join(__dirname, '__fixtures__');
const json = (name: string): unknown => JSON.parse(readFileSync(join(FX, name), 'utf-8'));
const text = (name: string): string => readFileSync(join(FX, name), 'utf-8');

const MERGE_CHECKS = '/repos/sample-org/sample-repo/pulls/125/merge-checks';
const RUNS = '/repos/sample-org/sample-repo/cicd/runs/356';
const LOGS = '/repos/sample-org/sample-repo/cicd/logs/';
// Символ ESC записан escape-последовательностью, а не литералом: управляющий символ
// в исходнике невидим глазом и не переживает первой же уборки файла.
const ESC = '\u001b';

function apiOf(routes: Record<string, unknown>): SourcecraftApi {
    return vi.fn((method: string, path: string) => {
        expect(method).toBe('GET');
        const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
        if (!hit) throw new Error(`неожиданный запрос: ${path}`);
        return hit[1];
    }) as unknown as SourcecraftApi;
}

function checksOf(routes: Record<string, unknown>) {
    return createSourcecraftCiChecks({
        api: apiOf(routes),
        org: 'sample-org',
        repo: 'sample-repo',
    });
}

describe('pullRequestChecks — свёртка ci_workflows[] (#269)', () => {
    it('живой зелёный ответ: success и номер прогона из run_slug', () => {
        const out = checksOf({
            [MERGE_CHECKS]: json('sourcecraft-merge-checks-success.json'),
        }).pullRequestChecks(125);

        expect(out).toEqual({
            state: 'success',
            runs: [
                {
                    workflow: 'gate',
                    runId: '366',
                    state: 'success',
                    rawStatus: 'success',
                    // #278: `created_at` фикстуры — "2026-09-06T05:11:30.213083Z".
                    createdAt: Date.parse('2026-09-06T05:11:30.213083Z'),
                },
            ],
        });
    });

    it('processing — ждать, а не мерджить', () => {
        const out = checksOf({
            [MERGE_CHECKS]: json('sourcecraft-merge-checks-processing.json'),
        }).pullRequestChecks(125);

        expect(out.state).toBe('pending');
        expect(out.runs[0].rawStatus).toBe('processing');
    });

    it('failed — красный, сырой статус сохранён', () => {
        const out = checksOf({
            [MERGE_CHECKS]: json('sourcecraft-merge-checks-failed.json'),
        }).pullRequestChecks(125);

        expect(out.state).toBe('failed');
        expect(out.runs[0]).toEqual({
            workflow: 'gate',
            runId: '356',
            state: 'failed',
            rawStatus: 'failed',
            // #278: `created_at` фикстуры — "2026-09-05T20:14:51.554383Z".
            createdAt: Date.parse('2026-09-05T20:14:51.554383Z'),
        });
    });

    it('пустой ci_workflows — none, а не «зелено»: чеков нет ≠ чеки прошли', () => {
        const out = checksOf({
            [MERGE_CHECKS]: { ci_workflows: [], status: 'success' },
        }).pullRequestChecks(125);

        expect(out).toEqual({ state: 'none', runs: [] });
    });

    it('несколько workflow: один красный красит целое', () => {
        const out = checksOf({
            [MERGE_CHECKS]: {
                ci_workflows: [
                    { status: 'success', run_slug: '1', workflow_slug: 'lint' },
                    { status: 'failed', run_slug: '2', workflow_slug: 'gate' },
                ],
            },
        }).pullRequestChecks(125);

        expect(out.state).toBe('failed');
    });

    it('красный сильнее ждущего: пока один упал, ждать остальных незачем', () => {
        const out = checksOf({
            [MERGE_CHECKS]: {
                ci_workflows: [
                    { status: 'processing', run_slug: '1', workflow_slug: 'lint' },
                    { status: 'failed', run_slug: '2', workflow_slug: 'gate' },
                ],
            },
        }).pullRequestChecks(125);

        expect(out.state).toBe('failed');
    });

    it('canceled, timeout и rejected — красные, а не «ещё идёт»', () => {
        for (const status of ['canceled', 'timeout', 'rejected']) {
            const out = checksOf({
                [MERGE_CHECKS]: {
                    ci_workflows: [{ status, run_slug: '9', workflow_slug: 'gate' }],
                },
            }).pullRequestChecks(125);
            expect(out.state, status).toBe('failed');
        }
    });

    it('skipped — не красный и не ждущий: пропущенный workflow мердж не держит', () => {
        const out = checksOf({
            [MERGE_CHECKS]: {
                ci_workflows: [{ status: 'skipped', run_slug: '9', workflow_slug: 'gate' }],
            },
        }).pullRequestChecks(125);

        expect(out.state).toBe('success');
    });

    it('disabled workflow в свёртку не идёт вовсе', () => {
        const out = checksOf({
            [MERGE_CHECKS]: {
                ci_workflows: [
                    { status: 'failed', disabled: true, run_slug: '1', workflow_slug: 'off' },
                    { status: 'success', run_slug: '2', workflow_slug: 'gate' },
                ],
            },
        }).pullRequestChecks(125);

        expect(out.state).toBe('success');
        expect(out.runs).toHaveLength(1);
    });

    it('НЕЗНАКОМЫЙ статус — ждущий, а не зелёный: неизвестность не повод мерджить', () => {
        const out = checksOf({
            [MERGE_CHECKS]: {
                ci_workflows: [{ status: 'quantum', run_slug: '3', workflow_slug: 'gate' }],
            },
        }).pullRequestChecks(125);

        expect(out.state).toBe('pending');
        expect(out.runs[0].rawStatus).toBe('quantum');
    });

    it('КРАСНЫЙ прогон без run_slug — отказ: тянуть лог будет не у чего', () => {
        expect(() =>
            checksOf({
                [MERGE_CHECKS]: {
                    ci_workflows: [{ status: 'failed', run_slug: '', workflow_slug: 'gate' }],
                },
            }).pullRequestChecks(125),
        ).toThrow(/run_slug/);
    });

    // Ждущему прогону номер не нужен вовсе, а спека площадки прямо говорит, что публичных
    // id у CI-сущностей «пока» нет. Общий бросок превратил бы свежесозданный прогон в три
    // сбоя чтения подряд и стоп петли на ровном месте (находка ревью).
    it('ЖДУЩИЙ прогон без run_slug — не отказ: номер нужен только красному', () => {
        const out = checksOf({
            [MERGE_CHECKS]: {
                ci_workflows: [{ status: 'created', run_slug: '', workflow_slug: 'gate' }],
            },
        }).pullRequestChecks(125);

        expect(out.state).toBe('pending');
    });

    // Транспорт бросает только на не-2xx и не-JSON, поэтому переименованный ключ доехал бы
    // сюда как пустой массив и через льготу в две минуты ОТКРЫЛ БЫ МЕРДЖ. «Чеков не видно»
    // и «чеков нет» обязаны различаться (находка ревью).
    it('ответ БЕЗ ключа ci_workflows — отказ, а не «чеков нет»', () => {
        expect(() =>
            checksOf({ [MERGE_CHECKS]: { status: 'success' } }).pullRequestChecks(125),
        ).toThrow(/ci_workflows/);
    });

    it('прогонов нет, а общий вердикт площадки — отказ: не мерджим', () => {
        const out = checksOf({
            [MERGE_CHECKS]: { ci_workflows: [], status: 'failure' },
        }).pullRequestChecks(125);

        // Красный без единого прогона: лечить нечего, и ядро остановится с причиной.
        expect(out).toEqual({ state: 'failed', runs: [] });
    });

    it('сбой чтения merge-checks — бросает: «не смогли спросить» не равно «чек зелёный»', () => {
        const api = vi.fn(() => {
            throw new Error('SourceCraft GET …/merge-checks: curl вернул 52');
        }) as unknown as SourcecraftApi;

        expect(() =>
            createSourcecraftCiChecks({
                api,
                org: 'sample-org',
                repo: 'sample-repo',
            }).pullRequestChecks(125),
        ).toThrow();
    });
});

describe('redCheckDiagnosis — какой куб упал и что в его логе (#269)', () => {
    const RUN = { workflow: 'gate', runId: '356', state: 'failed' as const, rawStatus: 'failed' };

    it('живой ответ прогона: находит ПЕРВЫЙ красный куб, а не последний', () => {
        const out = checksOf({
            [RUNS]: json('sourcecraft-run-356-failed.json'),
            [LOGS]: {
                logs: text('sourcecraft-cube-log-356-failed-test.txt'),
                page_complete: false,
                done: true,
            },
        }).redCheckDiagnosis(RUN);

        expect(out?.cube).toBe('test');
        expect(out?.runId).toBe('356');
        expect(out?.workflow).toBe('gate');
    });

    it('лог приходит без ANSI и с местом отказа внутри', () => {
        const out = checksOf({
            [RUNS]: json('sourcecraft-run-356-failed.json'),
            [LOGS]: { logs: text('sourcecraft-cube-log-356-failed-test.txt') },
        }).redCheckDiagnosis(RUN);

        expect(out?.log).not.toContain(ESC);
        expect(out?.log).toContain('2 failed');
    });

    it('лог OOM-прогона доносит сигнатуру среды — по ней ядро и отличит её от кода', () => {
        const out = checksOf({
            [RUNS]: json('sourcecraft-run-356-failed.json'),
            [LOGS]: { logs: text('sourcecraft-cube-log-350-oom.txt') },
        }).redCheckDiagnosis(RUN);

        expect(out?.log).toContain('Worker exited unexpectedly');
    });

    it('красного куба в прогоне нет — null, а не выдуманный куб', () => {
        const out = checksOf({
            [RUNS]: {
                workflows: [
                    {
                        slug: 'gate',
                        tasks: [{ slug: 'gate', cubes: [{ slug: 'test', status: 'success' }] }],
                    },
                ],
            },
        }).redCheckDiagnosis(RUN);

        expect(out).toBeNull();
    });

    it('красный куб есть, а лог не читается — диагноз всё равно отдаётся, с причиной вместо лога', () => {
        const api = vi.fn((_m: string, path: string) => {
            if (path.includes('/cicd/runs/')) return json('sourcecraft-run-356-failed.json');
            throw new Error('SourceCraft GET /cicd/logs/…: curl вернул 22 — 404');
        }) as unknown as SourcecraftApi;

        const out = createSourcecraftCiChecks({
            api,
            org: 'sample-org',
            repo: 'sample-repo',
        }).redCheckDiagnosis(RUN);

        expect(out?.cube).toBe('test');
        expect(out?.log).toContain('лог куба прочитать не удалось');
    });

    it('сбой чтения ПРОГОНА бросает — в отличие от лога, тут отдавать нечего', () => {
        const api = vi.fn(() => {
            throw new Error('SourceCraft GET …/cicd/runs/356: curl вернул 22 — 404');
        }) as unknown as SourcecraftApi;

        expect(() =>
            createSourcecraftCiChecks({
                api,
                org: 'sample-org',
                repo: 'sample-repo',
            }).redCheckDiagnosis(RUN),
        ).toThrow();
    });

    it('ответ прогона без workflows — null, а не выдуманный куб', () => {
        expect(checksOf({ [RUNS]: {} }).redCheckDiagnosis(RUN)).toBeNull();
    });

    // Прежний фолбэк `?? workflows[0]` брал ЧУЖОЙ workflow и уводил в сессию лечения чужое
    // имя куба с чужим логом — ровно то, что комментарий рядом объявлял недопустимым
    // (находка ревью).
    it('своего workflow в прогоне нет — null, чужой не подставляется', () => {
        const out = checksOf({
            [RUNS]: {
                workflows: [
                    {
                        slug: 'deploy',
                        tasks: [{ slug: 't', cubes: [{ slug: 'ship', status: 'failed' }] }],
                    },
                ],
            },
        }).redCheckDiagnosis(RUN);

        expect(out).toBeNull();
    });

    it('ответ логов без ключа logs — диагноз с пустым текстом, а не падение', () => {
        const out = checksOf({
            [RUNS]: json('sourcecraft-run-356-failed.json'),
            [LOGS]: {},
        }).redCheckDiagnosis(RUN);

        expect(out?.cube).toBe('test');
        expect(out?.log).toBe('');
    });

    it('красный куб ищется в СВОЁМ workflow, а не в первом попавшемся', () => {
        const out = checksOf({
            [RUNS]: {
                workflows: [
                    {
                        slug: 'other',
                        tasks: [{ slug: 't', cubes: [{ slug: 'nope', status: 'failed' }] }],
                    },
                    {
                        slug: 'gate',
                        tasks: [{ slug: 'gate', cubes: [{ slug: 'lint', status: 'failed' }] }],
                    },
                ],
            },
            [LOGS]: { logs: 'bang' },
        }).redCheckDiagnosis(RUN);

        expect(out?.cube).toBe('lint');
    });

    it('лог читается ОДНОЙ страницей: вторая у площадки повторяет первую (сверено живьём)', () => {
        const api = vi.fn((_m: string, path: string) =>
            String(path).includes('/cicd/runs/')
                ? json('sourcecraft-run-356-failed.json')
                : { logs: 'bang', page_complete: false, done: true },
        );
        createSourcecraftCiChecks({
            api: api as unknown as SourcecraftApi,
            org: 'sample-org',
            repo: 'sample-repo',
        }).redCheckDiagnosis(RUN);

        const logCalls = api.mock.calls.filter(([, p]) => String(p).includes('/cicd/logs/'));
        expect(logCalls).toHaveLength(1);
    });
});

describe('stripAnsi / failureExcerpt — чистая часть разбора (#269)', () => {
    it('снимает escape-последовательности и не трогает текст', () => {
        expect(stripAnsi(`${ESC}[31m${ESC}[1mAssertionError${ESC}[22m: ой`)).toBe(
            'AssertionError: ой',
        );
    });

    it('хвоста мало: место отказа лежит ВЫШЕ таблицы покрытия — берём и его', () => {
        const out = failureExcerpt(text('sourcecraft-cube-log-350-oom.txt'), 1500);

        expect(out).toContain('Worker exited unexpectedly');
        expect(out.length).toBeLessThanOrEqual(1600);
    });

    it('маркера отказа нет — просто хвост', () => {
        const out = failureExcerpt('a'.repeat(5000), 100);

        expect(out).toBe('a'.repeat(100));
    });

    it('кусок вокруг отказа и хвост склеены видимым разрывом, а не встык', () => {
        const raw = `${'x'.repeat(50)}\nAssertionError: тут\n${'y'.repeat(4000)}`;
        const out = failureExcerpt(raw, 200);

        expect(out).toContain('AssertionError: тут');
        expect(out).toContain('…');
        expect(out.endsWith('y'.repeat(100))).toBe(true);
    });

    it('гигантский лог обрезается ДО разбора — мегабайты в память петли не едут', () => {
        const out = failureExcerpt(`AssertionError: раз\n${'z'.repeat(3_000_000)}`, 400);

        expect(out.length).toBeLessThanOrEqual(500);
    });

    // Сводка прогона лежит МЕЖДУ местом отказа и концом лога: после неё печатается таблица
    // покрытия, и она-то и становится хвостом. Без отдельного куска прогон, где память
    // поджала И тесты честно упали, классифицировался бы как отказ среды — то есть стоп
    // человеку вместо лечения (находка ревью).
    it('сводка «N failed» доезжает в вырезку, даже когда между ней и хвостом таблица покрытия', () => {
        const raw = [
            'x'.repeat(3000),
            'Caused by: Error: Worker exited unexpectedly',
            'y'.repeat(3000),
            ' Test Files  2 failed | 435 passed (437)',
            'таблица покрытия'.repeat(300),
        ].join('\n');

        const out = failureExcerpt(raw, 1000);

        expect(out).toContain('Worker exited unexpectedly');
        expect(out).toContain('2 failed');
    });

    // Ревью #269: `text.search()` брал ПЕРВОЕ вхождение маркера, а `FAIL` встречается
    // и в именах кейсов, и в выводе сторонних инструментов. Тогда окно уезжало в начало
    // мегабайтного хвоста, а настоящий блок отказа оставался за кадром. Диагностически
    // ценен ПОСЛЕДНИЙ маркер: fail-fast прогон печатает его прямо перед сводкой.
    it('окно берётся у ПОСЛЕДНЕГО маркера — упоминание «FAIL» в имени кейса не сбивает', () => {
        const raw = [
            '✓ не падает на FAIL-ответе площадки',
            'z'.repeat(4000),
            'AssertionError: настоящий отказ',
            'w'.repeat(2000),
        ].join('\n');

        const out = failureExcerpt(raw, 400);

        expect(out).toContain('AssertionError: настоящий отказ');
        expect(out).not.toContain('не падает на FAIL-ответе');
    });
});

// Стык двух половин: адаптер режет лог, ядро по этой вырезке решает «лечим или зовём
// человека». Порознь обе покрыты, а перевернуть вердикт может именно изменение окна
// вырезки — и краснеть было бы нечему (находка ревью).
describe('вырезка + классификация на РЕАЛЬНЫХ логах кубов (#269)', () => {
    it.each([600, 1500, 4000])('лог прогона 350 при limit=%s остаётся отказом СРЕДЫ', (limit) => {
        const out = classifyForgeFailure(
            failureExcerpt(text('sourcecraft-cube-log-350-oom.txt'), limit),
        );
        expect(out).toBe('oom');
    });

    it.each([600, 1500, 4000])('лог прогона 356 при limit=%s остаётся отказом КОДА', (limit) => {
        const out = classifyForgeFailure(
            failureExcerpt(text('sourcecraft-cube-log-356-failed-test.txt'), limit),
        );
        expect(out).toBe('code');
    });
});

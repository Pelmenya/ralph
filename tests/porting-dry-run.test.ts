// #371: трек «Фреймворк ralph», фаза 5. Переносимость (#204) доказывается не только
// статическим грепом (core-purity.test.ts — ловит проектные строки В КОДЕ ядра), но и
// поведением: ядро должно инициализироваться и спланировать фазу на конфиге ЧУЖОГО
// проекта (другие имена доски/гейта/URL/фаз/промпта/роутинга моделей), не подглядывая
// в чьи-то дефолты. Фикстура — `__fixtures__/foreign-project/ralph.config.json`, её
// значения намеренно синтетические и ни одно не совпадает с боевым конфигом потребителя
// (кроме имён моделей ревью — те часть словаря ядра, не проекта, см. REVIEW_MODEL_STRENGTH
// в review.ts).
//
// createOrchestrator зовётся НАПРЯМУЮ (как в orchestrator.test.ts, блок «createOrchestrator:
// API-поверхность»), а не через singleton ralph.js — так фикстурный прогон получает
// независимый config/adapters и не делит состояние с остальным сьютом.
//
// «Без реального Claude/GitHub» обеспечено структурно: RALPH_NO_SIDE_EFFECTS=1 (vitest-
// проект ralph, см. vitest.config.ts) заставляет боевые sh/shArgv/spawnClaude падать через
// guardSideEffect (#138), если их не подменить явно. Каждый DI-параметр preflight/runLoop,
// который может дойти до git/gh/claude в dry-режиме, подменён фейком — забытый дефолт
// (в т.ч. адаптерский, `adapters.taskSource.*`) либо бросит на построении фабрики, либо
// попадёт в общий журнал sideEffectAttempts, который сверяет afterEach (test-setup.ts).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createOrchestrator } from '../core/orchestrator.ts';

// Путь к фикстуре — от каталога МОДУЛЯ, а не от CWD: ядро запускается и своим клоном
// канона, и каталогом `.claude/ralph` у потребителя, CWD в этих раскладках разный.
const FIXTURE_PATH = path.resolve(
    import.meta.dirname,
    '__fixtures__',
    'foreign-project',
    'ralph.config.json',
);

// Боевой конфиг потребителя приходит СНАРУЖИ, путём в `RALPH_REAL_CONFIG` — тем же
// приёмом, что словарь имён в `project-traces.ts`. В каноне `ralph.config.json` не
// существует вовсе (он принадлежит потребителю), поэтому «фикстура не повторяет боевых
// значений» здесь недоказуемо: проверка гоняется там, где боевой конфиг есть.
const REAL_CONFIG_PATH = (process.env.RALPH_REAL_CONFIG ?? '').trim();

const FLAGS_DRY = { once: false, dry: true, reset: false, resubmit: false, deployResolved: false };

// Мост из entry (телеграм/gate-env) — фейки, профиль фикстуры не prod, их не зовут.
function buildRuntime() {
    return createOrchestrator({
        argv: [],
        flags: FLAGS_DRY,
        external: {
            sendTelegramMessage: () => false,
            telegramConfigFromEnv: () => ({ token: '', chatId: '' }),
            buildSanitizedGateEnv: () => ({}),
        },
    });
}

function loadFixtureRaw() {
    return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
}

describe('фикстурный чужой проект — сама фикстура (#371)', () => {
    it.skipIf(REAL_CONFIG_PATH === '')(
        'не пересекается по ключевым значениям с боевым ralph.config.json',
        () => {
            const raw = loadFixtureRaw();
            const real = JSON.parse(fs.readFileSync(REAL_CONFIG_PATH, 'utf-8'));
            expect(raw.common.board.owner).not.toBe(real.common.board.owner);
            expect(raw.common.installCmd).not.toBe(real.common.installCmd);
            expect(raw.common.runnerWorktreeDirname).not.toBe(real.common.runnerWorktreeDirname);
            // #51: у боевого конфига блока `deployCheck` больше нет вовсе — деплоя в проекте
            // не существует, шов выключен (`adapters.deployCheck: "none"`). Сравниваем через
            // `?.`, а не выкидываем ассерт: фикстура ЧУЖОГО проекта деплой имеет, и требование
            // «фикстура не повторяет боевые значения» для неё остаётся в силе.
            expect(raw.common.deployCheck?.healthUrl).not.toBe(real.common.deployCheck?.healthUrl);
            expect(raw.common.deployCheck?.healthUrl).toBeTruthy();
            expect(raw.common.phases[0].milestone).not.toBe(real.common.phases[0].milestone);
            expect(raw.common.phases[0].branch).not.toBe(real.common.phases[0].branch);
            expect(raw.common.prompt).not.toBe(real.common.prompt);
            expect(raw.common.modelRouting.labels['complexity:medium']).not.toBe(
                real.common.modelRouting.labels['complexity:medium'],
            );
            expect(raw.common.gate.checks).not.toEqual(real.common.gate.checks);
        },
    );
});

describe('dry-run переносимости ядра на чужом конфиге (#371)', () => {
    it('resolveProfile инициализирует фикстуру без ошибок и без подмешивания боевых значений', () => {
        const runtime = buildRuntime();
        const raw = loadFixtureRaw();
        const cfg = runtime.resolveProfile(raw, 'playground', (msg: string) => {
            throw new Error(msg);
        }) as Record<string, unknown>;

        expect(cfg.profileName).toBe('playground');
        expect((cfg.board as { owner: string }).owner).toBe('OrbitalLabs');
        expect((cfg.board as { number: number }).number).toBe(42);
        expect(cfg.installCmd).toBe('pnpm install --frozen-lockfile');
        expect(cfg.runnerWorktreeDirname).toBe('sputnik-tracker-ralph');
        expect((cfg.deployCheck as { healthUrl: string }).healthUrl).toBe(
            'https://status.orbitallabs.example/health',
        );
        expect((cfg.phases as Array<{ milestone: string }>)[0].milestone).toBe(
            'Sputnik Tracker · Фаза 1: Каркас',
        );
        expect(cfg.prompt).toContain('AGENTS.md фикстурного проекта');
    });

    it('preflight + один dry-проход runLoop планируют фазу СТРОГО из фикстуры, не трогая реальные git/gh/claude', () => {
        const runtime = buildRuntime();
        const raw = loadFixtureRaw();
        const cfg = runtime.resolveProfile(raw, 'playground', (msg: string) => {
            throw new Error(msg);
        }) as Parameters<typeof runtime.preflight>[0];

        // pickModel (не подменяем — хотим ПРОВЕРИТЬ реальный роутинг) читает фабричный
        // config, который в бою присваивает main(); здесь — тестовый хук #204.
        runtime.setConfigForTests(cfg);

        const logs: string[] = [];
        const shCalls: string[] = [];
        // Фейковый shFn — единственная точка, куда preflight мог бы дотянуться до
        // настоящего git/gh (git rev-parse/gh auth status/git status --porcelain — они НЕ
        // гейтятся dry-флагом). Реальный sh() под RALPH_NO_SIDE_EFFECTS=1 бросил бы.
        const fakeSh = (cmd: string) => {
            shCalls.push(cmd);
            return '';
        };

        let authChecked = 0;
        const ctx = runtime.preflight(cfg, {
            shFn: fakeSh,
            // Авторизация форжа проверяется через шов (#35), а не через shFn: боевой
            // дефолт ушёл бы в настоящий gh/curl мимо фейка и упал бы предохранителем.
            checkAuthFn: () => {
                authChecked += 1;
            },
            failFn: (msg: string) => {
                throw new Error(msg);
            },
            logFn: (m: string) => logs.push(m),
            loadStateFn: () => ({
                count: 0,
                milestone: (cfg.phases as Array<{ milestone: string }>)[0].milestone,
                submitted: false,
                noProgress: 0,
                gateHeals: 0,
                blockedHeals: 0,
                reviewModelFloor: null,
                lastReviewModel: null,
                reReviewPending: false,
                reviewOfFixes: null,
                deployBlock: null,
            }),
            phaseIndexOfFn: () => 0,
            // #17: ранняя проверка конфликта human+complexity читает карточки фазы через
            // шов — дефолт ушёл бы в настоящий форж (собранный БЕЗ выбора из фикстуры),
            // ровно как checkAuthFn выше.
            allOpenIssuesFn: () => [],
            saveStateFn: () => {},
            pushEventFn: () => false,
            dry: true,
        });

        expect(ctx.state.milestone).toBe('Sputnik Tracker · Фаза 1: Каркас');
        // git только ЧИТАЕТСЯ через подменённый shFn — ни одного реального вызова.
        expect(shCalls.some((c) => c.includes('git rev-parse'))).toBe(true);
        // Авторизацию форжа preflight спрашивает у шва и НЕ знает про `gh`: раньше здесь
        // стояло ожидание `gh auth status`, то есть сам тест переносимости требовал GitHub.
        // Чем именно проверяет каждая реализация — предмет adapters-contract.test.ts.
        expect(authChecked).toBe(1);
        expect(shCalls.some((c) => c.includes('gh auth status'))).toBe(false);

        const fixtureIssue = {
            number: 101,
            title: 'Чужой issue фикстурного проекта',
            labels: [{ name: 'complexity:medium' }],
            author: { login: 'orbital-bot' },
        };

        const openIssuesCalls: string[] = [];
        const runClaudeCalls: Array<{ prompt: string; model?: string }> = [];
        const savedStates: unknown[] = [];

        runtime.runLoop(cfg, ctx, {
            dry: true,
            once: false,
            logFn: (m: string) => logs.push(m),
            shFn: fakeSh,
            saveStateFn: (s: unknown) => savedStates.push(s),
            // #369: дефолты этих коллабораторов читают adapters.* — фабрика собрала
            // адаптеры без выбора из фикстуры (main() их не звал), поэтому КАЖДЫЙ
            // такой дефолт подменяем явно; необращённые к ним ветки этого dry-прохода
            // всё равно проходят через связывание параметров при входе в runLoop.
            openIssuesFn: (milestone: string) => {
                openIssuesCalls.push(milestone);
                return [fixtureIssue];
            },
            allOpenIssuesFn: () => [],
            hasAnyIssuesFn: () => true,
            // #50: карточку для промпта читает петля — тот же случай, что у соседей:
            // дефолт ушёл бы в шов, собранный без выбора из фикстуры, и dry-проход
            // потрогал бы настоящий форж.
            getIssueFn: (number: number) => ({
                number,
                title: fixtureIssue.title,
                body: 'тело карточки из фикстуры',
            }),
            prCommentsFn: () => [],
            findOpenPrFn: () => null,
            removeBlockedLabelFn: () => {},
            addBlockedLabelFn: () => {},
            phaseMergedFn: () => true,
            mergedPhasePrFn: () => null,
            closeMilestoneByTitleFn: () => {
                throw new Error('closeMilestoneByTitleFn не должен вызываться в dry-режиме');
            },
            syncProjectBoardFn: () => {
                throw new Error('syncProjectBoardFn не должен вызываться в dry-режиме');
            },
            mergedShaOfFn: () => '',
            waitForDeployRunFn: () => ({ ok: false }) as never,
            checkProdHealthFn: () => ({ ok: false }) as never,
            runClaudeFn: (prompt: string, opts: { model?: string }) => {
                runClaudeCalls.push({ prompt, model: opts.model });
                return 0;
            },
        });

        // Фаза/milestone — только из фикстуры, не боевой milestone потребителя.
        expect(openIssuesCalls).toEqual(['Sputnik Tracker · Фаза 1: Каркас']);

        // Роутинг модели — РЕАЛЬНЫЙ pickModel (не подменён), читает фикстурный
        // modelRouting.labels['complexity:medium']. Если бы ядро тянуло дефолт мимо
        // конфига (например, боевую claude-sonnet-5), этот ассерт бы упал.
        expect(runClaudeCalls).toHaveLength(1);
        expect(runClaudeCalls[0].model).toBe('fixture-coder-model-medium');

        // Промпт собран из cfg.prompt фикстуры с подстановкой ЕЁ milestone/branch —
        // не боевого шаблона ralph.config.json и не боевых имён фазы/ветки.
        expect(runClaudeCalls[0].prompt).toContain('AGENTS.md фикстурного проекта');
        expect(runClaudeCalls[0].prompt).toContain('Sputnik Tracker · Фаза 1: Каркас');
        expect(runClaudeCalls[0].prompt).toContain('feature/sputnik-phase-1-scaffold');
        // Раньше здесь стояли ещё два ассерта — «в промпте нет имени репозитория и
        // организации проекта-донора». В каноне таких имён нет нигде и проверять их
        // поимённо больше нечем: этот класс целиком сторожит сплошной скан дерева
        // (project-traces.test.ts, #117), а здесь остаётся то, что ему не видно, —
        // что промпт собран ИЗ ФИКСТУРЫ, а не из зашитого шаблона.

        // dry: gh/board/milestone-мутации не звонились (см. throw-фейки выше) —
        // если бы позвонились, тест уже упал бы исключением из runLoop.
        expect(savedStates.length).toBeGreaterThan(0);
    });
});

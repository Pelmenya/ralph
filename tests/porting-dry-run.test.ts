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
import {
    FIXTURE_CONFIG_PATH,
    buildFixtureRuntime,
    loadFixtureConfig,
    runFixtureLoop,
} from './test-helpers.ts';

// Боевой конфиг потребителя приходит СНАРУЖИ, путём в `RALPH_REAL_CONFIG` — тем же
// приёмом, что словарь имён в `project-traces.ts`. В каноне `ralph.config.json` не
// существует вовсе (он принадлежит потребителю), поэтому «фикстура не повторяет боевых
// значений» здесь недоказуемо: проверка гоняется там, где боевой конфиг есть.
const REAL_CONFIG_PATH = (process.env.RALPH_REAL_CONFIG ?? '').trim();

/** Сырой конфиг фикстуры — для сравнения ЗНАЧЕНИЙ с боевым (обвязка цикла — в хелперах). */
function loadFixtureRaw() {
    return JSON.parse(fs.readFileSync(FIXTURE_CONFIG_PATH, 'utf-8'));
}

describe('фикстурный чужой проект — сама фикстура (#371)', () => {
    it.skipIf(REAL_CONFIG_PATH === '')(
        'не пересекается по ключевым значениям с боевым ralph.config.json',
        () => {
            const raw = loadFixtureRaw();
            const real = JSON.parse(fs.readFileSync(REAL_CONFIG_PATH, 'utf-8'));
            // Адресат доски из фикстуры убран вместе с мёртвым полем типа (канон, задача
            // 23): доску настраивает скрипт потребителя, ядро о ней не знает. Сравниваем по
            // тому, что ядро действительно читает.
            expect(raw.common.consumerScripts?.projectSync).not.toBe(
                real.common.consumerScripts?.projectSync,
            );
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
        const runtime = buildFixtureRuntime();
        const cfg: Record<string, unknown> = loadFixtureConfig(runtime);

        expect(cfg.profileName).toBe('playground');
        expect((cfg.consumerScriptsResolved as { projectSync: string }).projectSync).toBe(
            'scripts/orbital-board-sync.mjs',
        );
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
        // Обвязка цикла — общая с барьером чистоты продукта (`test-helpers.ts`): пока она
        // стояла копией в обоих, копии разъехались, и один из барьеров проверял меньше,
        // чем обещал его же название (ревью !21).
        const runtime = buildFixtureRuntime();
        const cfg = loadFixtureConfig(runtime);
        const { shCalls, runClaudeCalls, openIssuesCalls, authChecked, savedStates, ctx } =
            runFixtureLoop(runtime, cfg);

        // Результат ИМЕННО preflight: состояние фазы собрано из фикстуры, а не из чужого
        // дефолта. Не дубль `openIssuesCalls` — тот про вопрос к форжу, этот про то, с чем
        // петля вообще стартовала (ревью !22: ассерт терялся при выносе обвязки).
        expect(ctx.state.milestone).toBe('Sputnik Tracker · Фаза 1: Каркас');

        // git только ЧИТАЕТСЯ через подменённый shFn — ни одного реального вызова.
        expect(shCalls.some((c) => c.includes('git rev-parse'))).toBe(true);
        // Авторизацию форжа preflight спрашивает у шва и НЕ знает про `gh`: раньше здесь
        // стояло ожидание `gh auth status`, то есть сам тест переносимости требовал GitHub.
        expect(authChecked).toBe(1);
        expect(shCalls.some((c) => c.includes('gh auth status'))).toBe(false);

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

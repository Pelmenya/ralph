// Юнит-тесты примитивов исполнения раннера (exec.ts: sh / shArgv / log) — через
// боевую поверхность ralph.js, как их видят вызывающие. Здесь проверяется не текст
// реализации, а поведение границ: argv-вызовы не склеиваются в шелл-строку, а в
// тестовом окружении (RALPH_NO_SIDE_EFFECTS=1) любая побочка громко падает через
// guardSideEffect и оставляет след в журнале sideEffectAttempts (#138).
// Сам примитив guardSideEffect покрыт отдельно — side-effect-guard.test.ts.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
// @ts-expect-error — JS-entry раннера без деклараций типов: блоки перенесены из
// ralph.test.js как есть и ходят через его ре-экспорт (#366).
import ralph from '../ralph.js';

describe('#195: тесты изменённых вызовов гейта на argv (#193)', () => {
    // #195: Критерий готовности (2) — побочки через DI, RALPH_NO_SIDE_EFFECTS=1,
    // guardSideEffect: настоящая shArgv в тестовом окружении бросает И пишет в журнал.
    //
    // Критерий (1) — «значения с пробелами/спецсимволами не интерпретируются шеллом» —
    // это ПОВЕДЕНИЕ argv-границ, а не текст реализации: проверяется ассертами на
    // реальные argv-массивы в describe-блоках ниже (checksGreen — «git fetch/checkout
    // раздельными элементами argv»; tryMergePhase — «номер PR и sha отдельными
    // элементами»; parkOnOriginMain — `['git', ['checkout', '--detach', 'origin/main']]`).
    // Прежние toString()-ассерты (`toContain('runArgvFn')`/`toContain('shArgv')`) убраны:
    // они проверяли текст функции, а не поведение (rules/tests.md), и остались бы
    // зелёными даже при откате мутации на строковый shFn — ровно ту регрессию, ради
    // которой блок написан, они не ловили.

    it('shArgv в тестовом окружении бросает через guardSideEffect и пишет попытку в журнал', () => {
        // RALPH_NO_SIDE_EFFECTS=1 запрещает реальный execFileSync. Зовём НАСТОЯЩУЮ
        // ralph.shArgv (не голый идентификатор — иначе ReferenceError замаскировал бы
        // отсутствие вызова), сверяем и throw, и формат записи журнала #138 — иначе
        // общий afterEach из test-setup.ts уронил бы прогон на непустом sideEffectAttempts.
        expect(() => ralph.shArgv('echo', ['hello'])).toThrow();
        expect(ralph.sideEffectAttempts.splice(0)).toEqual(['shArgv(echo hello)']);
    });
});

// #138: сам предохранитель. Его смысл — не дать забытому моку тихо уйти в реальный
// шелл и в ralph.log живого прогона (так в лог фазы 4 попало
// `git fetch origin main 'feature/m1'` — ветка из фикстуры этого файла).
describe('предохранитель побочек в тестах: RALPH_NO_SIDE_EFFECTS (#138)', () => {
    const { sh, log, sideEffectAttempts } = ralph;

    it('переменная включена в окружении ralph-проекта vitest', () => {
        // Если предохранитель выключат в vitest.config.ts, тесты ниже станут
        // зелёными по ложной причине — фиксируем само условие.
        expect(process.env.RALPH_NO_SIDE_EFFECTS).toBe('1');
    });

    it('sh() отказывается исполнять команду, называет её в ошибке и пишет в журнал', () => {
        expect(() => sh('git fetch origin main')).toThrow(/RALPH_NO_SIDE_EFFECTS/);
        expect(() => sh('git fetch origin main')).toThrow(/git fetch origin main/);
        // Журнал — то, по чему общий afterEach ловит забытый мок даже когда вызов
        // обёрнут в try/catch. Здесь sh() вызван НАМЕРЕННО, поэтому журнал забираем
        // сами: иначе afterEach уронил бы этот же тест.
        expect(sideEffectAttempts.splice(0)).toEqual([
            'sh(git fetch origin main)',
            'sh(git fetch origin main)',
        ]);
    });

    it('проглоченный try/catch-ом вызов всё равно виден в журнале', () => {
        // Ровно исходный сценарий #138: phaseDiffFiles ловит ошибку git и возвращает
        // null, поэтому одного throw для покраснения теста не хватило бы.
        // #252: fetch теперь мутация через shArgv — формат записи журнала другой
        // (file+argv, а не строка через шелл).
        const files = ralph.phaseDiffFiles('feature/m1', { logFn: () => {} });
        expect(files).toBe(null);
        expect(sideEffectAttempts.splice(0)).toEqual([
            'shArgv(git fetch origin main feature/m1 --quiet)',
        ]);
    });

    it('дефолтный installFn (настоящий npm ci) тоже под предохранителем', () => {
        // Не только шелл: забытый installFn переустановил бы node_modules прямо во
        // время прогона тестов. Расширение предохранителя по ревью PR #141.
        expect(() =>
            ralph.syncDepsIfLockChanged({
                logFn: () => {},
                existsFn: () => true,
                readFn: (file: string) => (String(file).endsWith('.sha') ? 'старый-хэш' : 'lock'),
                writeFn: () => {},
            }),
        ).toThrow(/RALPH_NO_SIDE_EFFECTS/);
        // #204: команда установки из конфига (дефолт npm ci); метка предохранителя обобщена.
        expect(sideEffectAttempts.splice(0)).toEqual(['installCmd (syncDepsIfLockChanged)']);
    });

    it('дефолтный spawnFn (живая claude-сессия) тоже под предохранителем', () => {
        // Однажды тест уже пробился до настоящего spawnSync и запустил claude —
        // см. докблок spawnClaude. Теперь это громкая ошибка.
        expect(() => ralph.spawnClaude(['-p', 'привет'], 1000)).toThrow(/RALPH_NO_SIDE_EFFECTS/);
        expect(sideEffectAttempts.splice(0)).toEqual(['spawnClaude(claude)']);
    });

    it('log() пишет в консоль, но не трогает файл лога', () => {
        const append = vi.spyOn(fs, 'appendFileSync');
        const out = vi.spyOn(console, 'log').mockImplementation(() => {});
        log('строка, которой не место в ralph.log');
        expect(out).toHaveBeenCalled();
        expect(append).not.toHaveBeenCalled();
        out.mockRestore();
        append.mockRestore();
    });
});

// #390: запись stdout/stderr упавшей кодер-сессии на диск, редактируя секреты ДО записи.
describe('saveSessionOutput (#390)', () => {
    it('редактирует секреты и пишет через переданный writeFn', () => {
        const writeFn = vi.fn();
        ralph.saveSessionOutput(
            '.claude/ralph/sessions/42-123.log',
            'boom: token=SUPER_SECRET failed',
            ['SUPER_SECRET'],
            writeFn,
        );
        expect(writeFn).toHaveBeenCalledWith(
            '.claude/ralph/sessions/42-123.log',
            'boom: token=*** failed',
        );
    });

    it('дефолтный writeFn (реальная запись на диск) — под предохранителем #138', () => {
        expect(() =>
            ralph.saveSessionOutput('.claude/ralph/sessions/42-123.log', 'output'),
        ).toThrow(/RALPH_NO_SIDE_EFFECTS/);
        expect(ralph.sideEffectAttempts.splice(0)).toEqual([
            'saveSessionOutput(.claude/ralph/sessions/42-123.log)',
        ]);
    });
});

// #386: разводка лога боевого/не-боевого прогона — чужой прогон (dry-run и/или профиль
// playground) не должен ослеплять deadman боевой петли своими маркерами остановки.
// chooseLogPath — чистая функция, поэтому проверяется без main()/worktree/fs.
describe('chooseLogPath — куда пишет лог (#386)', () => {
    const PATHS = {
        battle: '/worktree/.claude/ralph/ralph.log',
        sideline: '/worktree/.claude/ralph/ralph.dry.log',
    };

    it('боевой прогон (профиль prod, не dry) пишет в общий ralph.log', () => {
        expect(ralph.chooseLogPath({ dry: false, profileName: 'prod' }, PATHS)).toBe(PATHS.battle);
    });

    it('--dry-run на профиле prod пишет в отдельный лог, не в боевой', () => {
        expect(ralph.chooseLogPath({ dry: true, profileName: 'prod' }, PATHS)).toBe(PATHS.sideline);
    });

    it('профиль playground без --dry-run пишет в отдельный лог, не в боевой', () => {
        expect(ralph.chooseLogPath({ dry: false, profileName: 'playground' }, PATHS)).toBe(
            PATHS.sideline,
        );
    });

    it('профиль playground с --dry-run тоже пишет в отдельный лог', () => {
        expect(ralph.chooseLogPath({ dry: true, profileName: 'playground' }, PATHS)).toBe(
            PATHS.sideline,
        );
    });

    it('профиль не задан (dry) — консервативно отдельный лог, не боевой', () => {
        expect(ralph.chooseLogPath({ dry: false, profileName: undefined }, PATHS)).toBe(
            PATHS.sideline,
        );
    });
});

// Юнит-тесты общего util-модуля (#232): shq/positiveIntOrDefault/sleep — раньше жили
// копиями в ralph.js и telegram-notifier.ts, теперь единственный источник правды.
// Здесь же живут anti-injection round-trip-тесты shq (через реальный /bin/sh) и полный
// негативный набор positiveIntOrDefault (#132) — тесты рядом с модулем, который они
// покрывают; orchestrator.test.ts держит лишь смоук ре-экспорта (тот же объект).
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import {
    nonNegativeIntOrDefault,
    positiveIntOrDefault,
    redactSecrets,
    shq,
    sleep,
} from './ralph-util.ts';

// Платформенное: тест опирается на POSIX-механизмы, которых на Windows нет
// (/proc/<pid>/cmdline, пути соседнего worktree, /bin/sh). Раннер живёт на
// Linux-VPS, поэтому пометка, а не вторая реализация — грабля 7 в
// docs/ralph-runner/portability-log.md. Снять вместе с платформенным швом.
const itPosix = it.skipIf(process.platform === 'win32');

describe('shq', () => {
    it('оборачивает значение в одинарные кавычки', () => {
        expect(shq('feature/m1')).toBe("'feature/m1'");
    });

    it('экранирует одинарную кавычку внутри значения (close-escape-open)', () => {
        expect(shq("don't")).toBe("'don'\\''t'");
    });

    it('приводит нестроковые значения через String()', () => {
        expect(shq(42)).toBe("'42'");
    });
});

// Главный сценарий anti-injection (#133): значение из конфига/GitHub уходит в sh() и
// НЕ должно исполниться. Проверяем на живом шелле, а не сверкой строк — иначе тест
// доказывает лишь мои представления о квотировании, а не поведение /bin/sh.
describe('shq — round-trip через реальный /bin/sh (#133)', () => {
    const assertVerbatim = (payload: string) => {
        const out = execSync(`printf '%s' ${shq(payload)}`, { encoding: 'utf-8' });
        // Дословно = payload вернулся как есть. Если бы шелл его ИСПОЛНИЛ, на выходе
        // было бы 'ВЗЛОМ' (или подставленный $HOME) вместо самой строки.
        expect(out).toBe(payload);
        expect(out.trim()).not.toBe('ВЗЛОМ');
    };

    it.each([
        ['подстановка команды', '$(echo ВЗЛОМ)'],
        ['обратные кавычки', '`echo ВЗЛОМ`'],
        ['разделитель команд', '; echo ВЗЛОМ'],
        ['переменная', '$HOME'],
    ])('%s проходит через шелл дословно', (_name, payload) => {
        assertVerbatim(payload);
    });

    // Вынесен из таблицы выше: единственный кейс, где закрывающая и открывающая кавычки
    // склеиваются вокруг вложенной подстановки. Под sh, который Windows подсовывает
    // вместо POSIX-шелла, строка приходит изменённой — на Linux кейс зелёный, и это
    // ровно то различие, ради которого стоит пометка (грабля 7 журнала переносимости).
    itPosix('кавычка и подстановка проходит через шелл дословно', () => {
        assertVerbatim(`'; echo ВЗЛОМ; echo '`);
    });

    it('кириллица и типографика milestone переживают квотирование дословно', () => {
        const milestone = 'Прод-режим ralph · Фаза 4: Толстый гейт (prod)';
        const out = execSync(`printf '%s' ${shq(milestone)}`, { encoding: 'utf-8' });
        expect(out).toBe(milestone);
    });
});

describe('positiveIntOrDefault — бюджет ходов (#132)', () => {
    it('нормальное значение проходит', () => {
        expect(positiveIntOrDefault(80, 200)).toBe(80);
    });

    // 0 — не «без ограничения», а бюджет без единого хода/попытки; строка '80' из
    // JSON-конфига — опечатка, а не «странное число», Number('80') тихо простил бы её.
    it.each([
        ['ноль', 0],
        ['отрицательное', -1],
        ['дробное', 12.5],
        ['строка', '80'],
        ['undefined', undefined],
        ['null', null],
    ])('%s → дефолт', (_name, value) => {
        expect(positiveIntOrDefault(value, 200)).toBe(200);
    });
});

// #594: у счётчика ПОВТОРОВ ноль осмыслен («не повторять, сразу стоп»), в отличие от
// бюджета ходов. Разница между двумя резолверами — ровно в этом, поэтому проверяется явно:
// перепутанный резолвер молча включил бы повторы тому, кто их выключил.
describe('nonNegativeIntOrDefault — счётчик повторов (#594)', () => {
    it('нормальное значение проходит', () => {
        expect(nonNegativeIntOrDefault(3, 2)).toBe(3);
    });

    it('ноль — валидная настройка «без повторов», а не мусор', () => {
        expect(nonNegativeIntOrDefault(0, 2)).toBe(0);
    });

    it.each([
        ['отрицательное', -1],
        ['дробное', 1.5],
        ['строка', '3'],
        ['undefined', undefined],
        ['null', null],
    ])('%s → дефолт', (_name, value) => {
        expect(nonNegativeIntOrDefault(value, 2)).toBe(2);
    });
});

describe('sleep', () => {
    it('блокирует поток минимум на заданное время', () => {
        const start = performance.now();
        sleep(20);
        // Atomics.wait по спецификации не возвращается раньше таймаута — слоп бывает
        // только вверх, поэтому порог равен запрошенному значению, а не ослаблен.
        expect(performance.now() - start).toBeGreaterThanOrEqual(20);
    });

    // NaN-таймаут Atomics.wait трактует как +∞ — вечный сон посреди прогона. Мусорный
    // ms должен вернуться мгновенно, а не подвесить раннер.
    it.each([
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['отрицательное', -100],
    ])('%s → мгновенный возврат, без вечного сна', (_name, value) => {
        const start = performance.now();
        sleep(value);
        expect(performance.now() - start).toBeLessThan(50);
    });
});

describe('redactSecrets (#390)', () => {
    it('заменяет каждое вхождение секрета на ***', () => {
        const text = 'token=ghp_abc123 leaked twice: ghp_abc123 again';
        expect(redactSecrets(text, ['ghp_abc123'])).toBe('token=*** leaked twice: *** again');
    });

    it('прогоняет несколько секретов независимо', () => {
        const text = 'gh=SECRET1 tg=SECRET2';
        expect(redactSecrets(text, ['SECRET1', 'SECRET2'])).toBe('gh=*** tg=***');
    });

    it('пропускает пустые/undefined секреты — не размножает *** между символами', () => {
        const text = 'plain text';
        expect(redactSecrets(text, [undefined, '', 'text'])).toBe('plain ***');
    });

    it('текст без совпадений возвращается как есть', () => {
        expect(redactSecrets('no secrets here', ['SECRET'])).toBe('no secrets here');
    });
});

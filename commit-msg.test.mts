// Проверка сообщения коммита: формат, потолок заголовка, проектные следы до коммита.
import { describe, expect, it } from 'vitest';
import { MAX_SUBJECT_LENGTH, TYPES, checkCommitMessage, denyWarning } from './commit-msg.mts';

const NO_DENY: NodeJS.ProcessEnv = {};

function reason(message: string, env: NodeJS.ProcessEnv = NO_DENY): string {
    const r = checkCommitMessage(message, env);
    return r.ok ? '' : r.reason;
}

describe('checkCommitMessage — формат', () => {
    it('пропускает тип, тип с областью и breaking-маркер', () => {
        expect(checkCommitMessage('fix: стоп вместо дефолта', NO_DENY).ok).toBe(true);
        expect(checkCommitMessage('feat(core): лестница повторов', NO_DENY).ok).toBe(true);
        expect(checkCommitMessage('refactor(adapters)!: новый шов', NO_DENY).ok).toBe(true);
    });

    it('каждый тип конвенции проходит', () => {
        for (const t of TYPES) expect(checkCommitMessage(`${t}: правка`, NO_DENY).ok).toBe(true);
    });

    it('заголовок без типа и с чужим типом — отказ с перечнем типов', () => {
        expect(reason('Петля поднимается на каноне')).toContain('тип — один из');
        expect(reason('wip: что-то')).toContain('тип — один из');
        expect(reason('fix(Core): заглавная область')).toContain('не по конвенции');
    });

    it('пустое сообщение и сообщение из одних пробелов — отказ', () => {
        expect(reason('')).toBe('сообщение пустое');
        expect(reason(' \n\t\n')).toBe('сообщение пустое');
    });

    it('строка с решёткой — это заголовок, а не шаблон: `git commit -F` её сохраняет', () => {
        expect(reason('# комментарий\n\nfix: правка')).toContain('не по конвенции');
    });

    it('точка в конце заголовка — отказ', () => {
        expect(reason('fix: правка.')).toContain('точкой');
    });

    it('служебные заголовки git не проверяются на формат', () => {
        // `amend!` даёт `git commit --fixup=amend:<коммит>`.
        for (const s of [
            'Merge branch x',
            'Revert "fix: a"',
            'fixup! fix: a',
            'squash! fix: a',
            'amend! fix: a',
        ])
            expect(checkCommitMessage(s, NO_DENY).ok).toBe(true);
    });
});

describe('checkCommitMessage — потолок заголовка', () => {
    it('ровно потолок проходит, на символ больше — отказ с числом', () => {
        const head = 'fix: ';
        const at = head + 'ж'.repeat(MAX_SUBJECT_LENGTH - head.length);
        expect(checkCommitMessage(at, NO_DENY).ok).toBe(true);
        expect(reason(at + 'ж')).toContain(`сейчас ${String(MAX_SUBJECT_LENGTH + 1)}`);
    });

    it('считает символы, а не байты: кириллица не наказывается вдвое', () => {
        const s = 'docs: ' + 'я'.repeat(MAX_SUBJECT_LENGTH - 6);
        expect(Buffer.byteLength(s)).toBeGreaterThan(MAX_SUBJECT_LENGTH);
        expect(checkCommitMessage(s, NO_DENY).ok).toBe(true);
    });

    it('считает кодовые точки, а не единицы UTF-16: эмодзи — один символ', () => {
        const s = 'docs: ' + '😀'.repeat(MAX_SUBJECT_LENGTH - 6);
        expect(s.length).toBeGreaterThan(MAX_SUBJECT_LENGTH);
        expect(checkCommitMessage(s, NO_DENY).ok).toBe(true);
    });
});

describe('checkCommitMessage — проектные следы', () => {
    // Путь собирается из частей: целиком он был бы следом в самом дереве.
    const machinePath = ['', 'root', 'app', 'x.ts'].join('/');

    it('путь машины в теле — отказ с номером строки', () => {
        const r = reason(`fix: правка\n\nправил ${machinePath}`);
        expect(r).toContain('проектный след');
        expect(r).toContain('строка 3');
    });

    it('имя из словаря RALPH_TRACE_DENY — отказ', () => {
        expect(reason('feat: витрина для acme', { RALPH_TRACE_DENY: 'acme' })).toContain(
            'проектный след',
        );
    });

    it('без словаря то же имя проходит: класс без формы описывается только словарём', () => {
        expect(checkCommitMessage('feat: витрина для acme', NO_DENY).ok).toBe(true);
    });

    it('след в теле служебного коммита тоже ловится: тело уезжает в историю', () => {
        expect(reason(`fixup! fix: a\n\n${machinePath}`)).toContain('проектный след');
    });

    it('след в строке с решёткой ловится: `git commit -F` такие строки сохраняет', () => {
        expect(reason(`fix: правка\n\n# ${machinePath}`)).toContain('проектный след');
        expect(reason('fix: правка\n\n  # acme', { RALPH_TRACE_DENY: 'acme' })).toContain(
            'проектный след',
        );
    });

    it('CRLF не прячет след и не ломает заголовок', () => {
        expect(checkCommitMessage('fix: правка\r\n\r\nтело\r\n', NO_DENY).ok).toBe(true);
        expect(reason(`fix: правка\r\n\r\n${machinePath}\r\n`)).toContain('проектный след');
    });

    it('абстрактная форма проходит', () => {
        expect(checkCommitMessage('docs: пример /path/to/app и example.com', NO_DENY).ok).toBe(
            true,
        );
    });
});

describe('denyWarning', () => {
    it('пустой словарь и словарь из одних запятых — предупреждение, а не молчание', () => {
        expect(denyWarning({})).toContain('RALPH_TRACE_DENY пуст');
        expect(denyWarning({ RALPH_TRACE_DENY: ' , ,' })).toContain('RALPH_TRACE_DENY пуст');
    });

    it('заданный словарь — без предупреждения', () => {
        expect(denyWarning({ RALPH_TRACE_DENY: 'acme' })).toBeNull();
    });
});

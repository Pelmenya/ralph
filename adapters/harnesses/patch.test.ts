// Общий разбор патча (#189): операции по заголовкам, отказ на всём, что CLI прочёл бы иначе.
import { describe, expect, it } from 'vitest';
import { patchOperations, patchesInCommand } from './patch.ts';

const P = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch', ''].join('\n');
const ops = (text: string) => patchOperations(text, '/w');

describe('патч → операции', () => {
    it('Add, Update, Delete — запись, запись, удаление', () => {
        expect(
            ops(
                P(
                    '*** Add File: a.txt',
                    '+x',
                    '*** Update File: keep.txt',
                    '@@',
                    '-a',
                    '+b',
                    '*** Delete File: gone.txt',
                ),
            ),
        ).toEqual([
            { op: 'write', path: 'a.txt', baseDir: '/w' },
            { op: 'write', path: 'keep.txt', baseDir: '/w' },
            { op: 'delete', path: 'gone.txt', baseDir: '/w' },
        ]);
    });

    it('Update с Move to — перенос: судятся обе стороны', () => {
        expect(
            ops(P('*** Update File: keep.txt', '*** Move to: moved.txt', '@@', '-a', '+b')),
        ).toEqual([{ op: 'move', path: 'keep.txt', destination: 'moved.txt', baseDir: '/w' }]);
    });

    it('строки содержимого с маркером внутри — содержимое, а не заголовок', () => {
        expect(
            ops(
                P(
                    '*** Add File: a.md',
                    '+*** Delete File: .env',
                    '*** Update File: b.md',
                    '@@ ctx',
                    ' line',
                    '',
                    '-*** Add File: x',
                    '+y',
                    '*** End of File',
                ),
            ),
        ).toEqual([
            { op: 'write', path: 'a.md', baseDir: '/w' },
            { op: 'write', path: 'b.md', baseDir: '/w' },
        ]);
    });

    it('CRLF, пробелы у краёв и обёртка heredoc — как у CLI', () => {
        const crlf = P('  *** Add File: a.txt  ', '+x').replace(/\n/g, '\r\n');
        expect(ops(`\n${crlf}\n`)).toEqual([{ op: 'write', path: 'a.txt', baseDir: '/w' }]);
        const heredoc = `<<'EOF'\n${P('*** Delete File: d.txt')}EOF\n`;
        expect(ops(heredoc)).toEqual([{ op: 'delete', path: 'd.txt', baseDir: '/w' }]);
    });

    it.each([
        ['без начала', '*** Add File: a\n+x\n*** End Patch', /Begin Patch/],
        ['без конца', '*** Begin Patch\n*** Add File: a\n+x', /End Patch/],
        ['без единого файла', P(), /ни одного файла/],
        ['заголовок без пробела после двоеточия', P('*** Add File:\t.env', '+x'), /не заголовок/],
        ['незнакомый заголовок', P('*** Copy File: a'), /не заголовок/],
        ['пустой путь', P('*** Delete File: '), /не заголовок|пустой путь/],
        ['пустой путь Move to', P('*** Update File: a', '*** Move to: ', '@@'), /пустой путь/],
        ['путь с пробелом у края', P('*** Delete File:  .env'), /пробел/],
        ['Move to с пробелом у края', P('*** Update File: a', '*** Move to: b ', '@@'), /пробел/],
        ['строка Add без +', P('*** Add File: a', 'x'), /не заголовок/],
        [
            'маркер в строке контекста',
            P('*** Update File: a', ' *** Add File: .env'),
            /неоднозначн/,
        ],
        ['мусор в Update', P('*** Update File: a', 'x'), /строка правки/],
        ['Move to вне Update', P('*** Add File: a', '+x', '*** Move to: b'), /не заголовок/],
    ])('%s — отказ с причиной', (_what, text, why) => {
        expect(() => ops(text)).toThrow(why);
    });
});

describe('патч в команде оболочки', () => {
    it('apply_patch heredoc — патч найден, база — cwd и каталог cd', () => {
        const cmd = `cd sub && apply_patch <<'EOF'\n${P('*** Add File: a.txt', '+x')}EOF`;
        expect(patchesInCommand(cmd, '/w')).toEqual([
            { op: 'write', path: 'a.txt', baseDir: '/w' },
            { op: 'write', path: 'a.txt', baseDir: '/w/sub' },
        ]);
    });

    it('без слова apply_patch — патча нет, даже с телом', () => {
        expect(patchesInCommand('git status', '/w')).toEqual([]);
        expect(patchesInCommand(`cat <<'EOF'\n${P('*** Add File: a', '+x')}EOF`, '/w')).toEqual([]);
    });

    it.each([
        ['тело из файла конвейером', 'cat p | apply_patch'],
        ['тело подстановкой', 'apply_patch "$(cat p)"'],
        ['тело перенаправлением', 'applypatch < p'],
        ['слово аргументом — по тексту не отличить', 'grep apply_patch notes.md'],
    ])('apply_patch без литерального тела (%s) — отказ, а не «патча нет»', (_what, cmd) => {
        expect(() => patchesInCommand(cmd, '/w')).toThrow(/без литерального тела/);
    });

    it.each([
        [
            'второй вызов после тела',
            `apply_patch <<'EOF'\n${P('*** Add File: a', '+x')}EOF\ncat p | apply_patch`,
        ],
        [
            'второй вызов до тела',
            `cat p | apply_patch; apply_patch <<'EOF'\n${P('*** Add File: a', '+x')}EOF`,
        ],
    ])('%s — отказ: тело одного вызова не говорит о другом', (_what, cmd) => {
        expect(() => patchesInCommand(cmd, '/w')).toThrow(/вне единственного тела/);
    });

    it('вызов с патчем без конца — отказ', () => {
        expect(() =>
            patchesInCommand("apply_patch '*** Begin Patch\n*** Add File: a'", '/w'),
        ).toThrow(/без «\*\*\* End Patch»/);
    });

    it('вызов с битым телом — отказ, а не «патча нет»', () => {
        expect(() =>
            patchesInCommand("applypatch '*** Begin Patch\n*** Copy File: a\n*** End Patch'", '/w'),
        ).toThrow(/не заголовок/);
    });
});

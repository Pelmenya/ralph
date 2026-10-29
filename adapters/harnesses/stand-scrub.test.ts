// Обезличивание фикстур стенда (#235): набор воспроизведения #192 приехал в фикстуру с
// подстановкой между каждыми двумя символами — путь, который заменялся, был пустым.
import { describe, expect, it } from 'vitest';
import { kitScriptProblems, scrubStandPaths } from './stand-scrub.ts';

describe('scrubStandPaths', () => {
    it('заменяет каждый путь, более длинный — раньше вложенного в него', () => {
        const text = 'cd /m/canon && node /m/canon/provision/x.mts /m/canon-scripts/d.sh';
        expect(
            scrubStandPaths(text, [
                ['/m/canon', '/path/to/canon'],
                ['/m/canon-scripts', '/path/to/stand-scripts'],
            ]),
        ).toBe(
            'cd /path/to/canon && node /path/to/canon/provision/x.mts /path/to/stand-scripts/d.sh',
        );
    });

    it('отказывает на пустом пути, а не вставляет подстановку между символами', () => {
        expect(() => scrubStandPaths('#!/bin/sh', [['', '/path/to/stand']])).toThrow(/пустой путь/);
    });

    it('отказывает на относительном пути и на корне', () => {
        expect(() => scrubStandPaths('x', [['tmp/s', '/path/to/stand']])).toThrow(/абсолютн/);
        expect(() => scrubStandPaths('x', [['/', '/path/to/stand']])).toThrow(/корень/);
    });
});

describe('kitScriptProblems', () => {
    const good = {
        'drive.sh': '#!/usr/bin/env bash\necho ok\n',
        cases: { a: "CALL='{}'" },
    };

    it('целый набор — без проблем', () => {
        expect(kitScriptProblems(good)).toEqual([]);
    });

    it('от противного: скрипт с подстановкой между символами — проблема', () => {
        const broken = '/path/to/stand#/path/to/stand!/path/to/stand//path/to/standu';
        expect(kitScriptProblems({ ...good, 'drive.sh': broken })).toEqual([
            expect.stringMatching(/drive\.sh: нет #!\/usr\/bin\/env/),
            expect.stringMatching(/drive\.sh: подстановка между символами/),
        ]);
    });

    it('от противного: испорченный случай — проблема', () => {
        const broken = '/path/to/standC/path/to/standA/path/to/standL/path/to/standL';
        expect(kitScriptProblems({ ...good, cases: { a: broken } })).toEqual([
            expect.stringMatching(/cases\.a: подстановка между символами/),
        ]);
    });

    it('библиотеке, подключаемой через точку, шебанг не нужен; не строка — проблема', () => {
        expect(kitScriptProblems({ 'common.sh': 'f() { :; }\n' })).toEqual([]);
        expect(kitScriptProblems({ 'drive.sh': 1 })).toEqual(['drive.sh: не строка']);
    });

    it('плейсхолдер в обычном тексте проблемой не считается', () => {
        const text = '#!/usr/bin/env bash\ncd /path/to/canon && ls /path/to/stand-runs/a\n';
        expect(kitScriptProblems({ 'stand.sh': text })).toEqual([]);
    });
});

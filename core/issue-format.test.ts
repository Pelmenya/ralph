import { describe, expect, it } from 'vitest';

import {
    checkIssueFormat,
    describeFormatViolations,
    resolveIssueFormat,
    type TIssueFormat,
} from './issue-format.ts';

const FORMAT: TIssueFormat = {
    sections: [
        { heading: 'Критерии готовности' },
        { heading: 'Макет', whenLabel: 'area:showcase', requireLink: true },
    ],
};

const GOOD = ['## Что сделать', 'текст', '', '## Критерии готовности', '- [ ] тест'].join('\n');

describe('resolveIssueFormat — секция issueFormat конфига', () => {
    it('секции нет — формата нет, работаем как раньше', () => {
        const failFn = (msg: string) => {
            throw new Error(msg);
        };
        expect(resolveIssueFormat({}, failFn)).toBeNull();
    });

    it('правильная секция разбирается в правила', () => {
        const failFn = (msg: string) => {
            throw new Error(msg);
        };
        expect(resolveIssueFormat({ issueFormat: FORMAT }, failFn)).toEqual(FORMAT);
    });

    it.each([
        ['не объект', 'x', /ожидался объект/],
        [
            'незнакомый ключ',
            { sections: [{ heading: 'A' }], section: [] },
            /незнакомые ключи section/,
        ],
        ['пустой список', { sections: [] }, /непустой список/],
        ['правило не объект', { sections: ['A'] }, /sections\[0\]/],
        [
            'опечатка в ключе правила',
            { sections: [{ heading: 'A', requireLinks: true }] },
            /requireLinks/,
        ],
        ['пустой заголовок', { sections: [{ heading: ' ' }] }, /heading/],
        ['метка не строка', { sections: [{ heading: 'A', whenLabel: 1 }] }, /whenLabel/],
        [
            'requireLink не булево',
            { sections: [{ heading: 'A', requireLink: 'yes' }] },
            /requireLink/,
        ],
        ['дубль правила', { sections: [{ heading: 'A' }, { heading: ' a ' }] }, /дважды/],
    ])('fail-closed: %s', (_name, issueFormat, re) => {
        const msgs: string[] = [];
        expect(resolveIssueFormat({ issueFormat }, (m) => msgs.push(m))).toBeNull();
        expect(msgs.join('\n')).toMatch(re);
    });

    it('один заголовок на разные метки — не дубль', () => {
        const msgs: string[] = [];
        const raw = {
            sections: [
                { heading: 'A', whenLabel: 'x' },
                { heading: 'A', whenLabel: 'y' },
            ],
        };
        expect(resolveIssueFormat({ issueFormat: raw }, (m) => msgs.push(m))).toEqual(raw);
        expect(msgs).toEqual([]);
    });
});

describe('checkIssueFormat — разделы карточки', () => {
    it('карточка по формату — нарушений нет', () => {
        expect(checkIssueFormat({ body: GOOD, labels: [] }, FORMAT)).toEqual([]);
    });

    it('нет обязательного раздела — нарушение называет раздел', () => {
        const v = checkIssueFormat({ body: '## Что сделать\nтекст', labels: [] }, FORMAT);
        expect(v).toEqual([{ heading: 'Критерии готовности', problem: 'missing' }]);
        expect(describeFormatViolations(v)).toBe('нет раздела «Критерии готовности»');
    });

    it('пустой раздел засчитывается нарушением', () => {
        const body = '## Критерии готовности\n\n  \n## Дальше\nтекст';
        expect(checkIssueFormat({ body, labels: [] }, FORMAT)).toEqual([
            { heading: 'Критерии готовности', problem: 'empty' },
        ]);
    });

    it('правило по метке действует только на карточку с меткой', () => {
        expect(checkIssueFormat({ body: GOOD, labels: ['area:core'] }, FORMAT)).toEqual([]);
        expect(checkIssueFormat({ body: GOOD, labels: ['area:showcase'] }, FORMAT)).toEqual([
            { heading: 'Макет', problem: 'missing' },
        ]);
    });

    it('раздел «Макет» без ссылки — нарушение, со ссылкой — нет', () => {
        const labels = ['area:showcase'];
        const noLink = `${GOOD}\n\n## Макет\nсм. в чате`;
        expect(checkIssueFormat({ body: noLink, labels }, FORMAT)).toEqual([
            { heading: 'Макет', problem: 'no-link' },
        ]);
        const withLink = `${GOOD}\n\n## Макет\nhttps://example.com/mockup/1`;
        expect(checkIssueFormat({ body: withLink, labels }, FORMAT)).toEqual([]);
    });

    it('заголовок сравнивается целиком, без учёта регистра и пробелов', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Макет' }] };
        expect(checkIssueFormat({ body: '###   макет  \nтекст', labels: [] }, fmt)).toEqual([]);
        expect(
            checkIssueFormat({ body: '## Макет (будет позже)\nтекст', labels: [] }, fmt),
        ).toEqual([{ heading: 'Макет', problem: 'missing' }]);
    });

    it('заголовок внутри блока кода разделом не считается', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Макет' }] };
        const body = '```md\n## Макет\nhttps://example.com\n```';
        expect(checkIssueFormat({ body, labels: [] }, fmt)).toEqual([
            { heading: 'Макет', problem: 'missing' },
        ]);
    });

    it('подраздел — часть родительского раздела, следующий того же уровня — нет', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Макет', requireLink: true }] };
        const nested = '## Макет\n### Главная\nhttps://example.com/a\n## Дальше\nтекст';
        expect(checkIssueFormat({ body: nested, labels: [] }, fmt)).toEqual([]);
        const sibling = '## Макет\nпозже\n## Ссылки\nhttps://example.com/a';
        expect(checkIssueFormat({ body: sibling, labels: [] }, fmt)).toEqual([
            { heading: 'Макет', problem: 'no-link' },
        ]);
    });

    it('раздел из одного HTML-комментария шаблона — пуст, ссылка в комментарии — не ссылка', () => {
        const fmt: TIssueFormat = {
            sections: [{ heading: 'Критерии' }, { heading: 'Макет', requireLink: true }],
        };
        const body = [
            '## Критерии',
            '<!-- перечисли',
            'критерии -->',
            '## Макет',
            'позже <!-- ссылка на макет, например https://example.com/m -->',
        ].join('\n');
        expect(checkIssueFormat({ body, labels: [] }, fmt)).toEqual([
            { heading: 'Критерии', problem: 'empty' },
            { heading: 'Макет', problem: 'no-link' },
        ]);
    });

    it('незакрытый HTML-комментарий тянется до конца тела, как при рендере', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Макет' }] };
        const body = '<!-- черновик\n## Макет\nhttps://example.com/m';
        expect(checkIssueFormat({ body, labels: [] }, fmt)).toEqual([
            { heading: 'Макет', problem: 'missing' },
        ]);
    });

    it('раздел, где только подзаголовок без содержимого, — пуст', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Макет' }] };
        const body = '## Макет\n### Главная\n## Дальше\nтекст';
        expect(checkIssueFormat({ body, labels: [] }, fmt)).toEqual([
            { heading: 'Макет', problem: 'empty' },
        ]);
    });

    it('решётка в конце заголовка без пробела — часть заголовка, с пробелом — закрытие', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Раздел C#' }] };
        expect(checkIssueFormat({ body: '## Раздел C#\nтекст', labels: [] }, fmt)).toEqual([]);
        expect(checkIssueFormat({ body: '## Раздел C# ##\nтекст', labels: [] }, fmt)).toEqual([]);
        const closed: TIssueFormat = { sections: [{ heading: 'Раздел' }] };
        expect(checkIssueFormat({ body: '## Раздел ##\nтекст', labels: [] }, closed)).toEqual([]);
    });

    it('ограду закрывает только та же последовательность, не короче открывающей', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Макет' }] };
        const longer = '````md\n```\n## Макет\nтекст\n````';
        expect(checkIssueFormat({ body: longer, labels: [] }, fmt)).toEqual([
            { heading: 'Макет', problem: 'missing' },
        ]);
        const otherChar = '```\n~~~\n## Макет\nтекст\n```';
        expect(checkIssueFormat({ body: otherChar, labels: [] }, fmt)).toEqual([
            { heading: 'Макет', problem: 'missing' },
        ]);
        const after = '```\nкод\n```\n## Макет\nтекст';
        expect(checkIssueFormat({ body: after, labels: [] }, fmt)).toEqual([]);
    });

    it('метка правила сравнивается без учёта регистра', () => {
        const fmt: TIssueFormat = { sections: [{ heading: 'Макет', whenLabel: 'Area:Showcase' }] };
        expect(checkIssueFormat({ body: GOOD, labels: ['area:showcase'] }, fmt)).toEqual([
            { heading: 'Макет', problem: 'missing' },
        ]);
    });
});

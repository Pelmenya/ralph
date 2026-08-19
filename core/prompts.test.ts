// #45: промпты сессий цикла сдачи. Модуль чистый (параметры → строка), поэтому проверяется
// прямо, а не через прогон сессии.
//
// Предмет тестов — не формулировки (их правят чаще, чем читают), а два свойства, которые
// ломаются молча: подстановка параметров и отсутствие площадочной механики. Второе
// дублирует барьер чистоты намеренно: барьер грепает файл целиком и скажет «в модуле есть
// gh», а эти тесты покажут, В КАКОМ промпте.
import { describe, expect, it } from 'vitest';
import {
    buildBlockedFixPrompt,
    buildCommentsContext,
    buildIssueContext,
    buildFixArbiterPrompt,
    buildFixByReviewPrompt,
    buildFixReviewPrompt,
    buildGateHealPrompt,
    buildReReviewPrompt,
    buildReviewPrompt,
} from './prompts.ts';

const BRANCH = 'feature/m1';
const GATE = 'npm run lint, npm run test';

const ALL: Array<[string, string]> = [
    ['ревью', buildReviewPrompt({ branch: BRANCH, diffContext: '<дифф>' })],
    [
        'правки по ревью',
        buildFixByReviewPrompt({ branch: BRANCH, allowNames: 'owner', gateCmdList: GATE }),
    ],
    [
        'разбор blocked',
        buildBlockedFixPrompt({ branch: BRANCH, allowNames: 'owner', gateCmdList: GATE }),
    ],
    [
        'повторное ревью',
        buildReReviewPrompt({ branch: BRANCH, allowNames: 'owner', diffContext: '<дифф>' }),
    ],
    [
        'ревью правок',
        buildFixReviewPrompt({
            branch: BRANCH,
            allowNames: 'owner',
            fixDiffContext: '<дифф правок>',
            pass: 1,
            maxPasses: 3,
        }),
    ],
    [
        'арбитр ревью правок',
        buildFixArbiterPrompt({ branch: BRANCH, fixDiffContext: '<дифф правок>' }),
    ],
    [
        'самолечение гейта',
        buildGateHealPrompt({
            branch: BRANCH,
            checkName: 'test',
            checkCmd: 'npm run test',
            excerpt: 'AssertionError',
            gateCmdList: GATE,
        }),
    ],
];

describe('промпты сессий: подстановка параметров', () => {
    it.each(ALL)('%s подставляет ветку фазы', (_name, prompt) => {
        expect(prompt).toContain(BRANCH);
    });

    it('ревью получает контекст диффа, а не собирает его сам', () => {
        expect(buildReviewPrompt({ branch: BRANCH, diffContext: '<дифф>' })).toContain('<дифф>');
    });

    // #66: правило коммита — профилактика к барьеру в коде (раннер коммитит остаток сам).
    // Барьер здесь именно грепом: формулировка объясняет сессии, ПОЧЕМУ ждать зелёного
    // нельзя, и без этого объяснения модель каждый раз находит новую разумную причину
    // отложить коммит — «дождусь тестов», «не буду мешать чужому процессу».
    const WITH_COMMIT_RULE = ALL.filter(([name]) =>
        ['правки по ревью', 'разбор blocked', 'самолечение гейта'].includes(name),
    );

    it.each(WITH_COMMIT_RULE)(
        '%s велит коммитить по ходу, не дожидаясь зелёных тестов',
        (_name, prompt) => {
            expect(prompt).toMatch(/Коммить по ходу работы/);
            expect(prompt).toMatch(/Не жди зелёных тестов/);
        },
    );

    it('правки и разбор blocked гоняют набор проверок из конфига гейта', () => {
        // Раньше здесь был прошит список npm-скриптов ДРУГОГО проекта: сессия честно
        // пыталась выполнить команду, которой в этом репозитории нет вовсе.
        expect(
            buildFixByReviewPrompt({ branch: BRANCH, allowNames: 'o', gateCmdList: GATE }),
        ).toContain(GATE);
        expect(
            buildBlockedFixPrompt({ branch: BRANCH, allowNames: 'o', gateCmdList: GATE }),
        ).toContain(GATE);
    });

    // #594: повтор шага правок после исчерпания ходов. Пометка нужна не для вежливости:
    // без неё вторая сессия тратит тот же бюджет на уже закоммиченное первой и упирается
    // в потолок снова — повтор становится холостым.
    it('resumed → сессия знает, что продолжает прерванный разбор, и смотрит историю ветки', () => {
        const prompt = buildFixByReviewPrompt({
            branch: BRANCH,
            allowNames: 'owner',
            gateCmdList: GATE,
            resumed: true,
        });
        expect(prompt).toMatch(/ПРОДОЛЖЕНИЕ прерванного разбора/);
        expect(prompt).toMatch(/git log/);
    });

    it('по умолчанию пометки продолжения нет — первая сессия разбирает с нуля', () => {
        expect(
            buildFixByReviewPrompt({ branch: BRANCH, allowNames: 'owner', gateCmdList: GATE }),
        ).not.toMatch(/ПРОДОЛЖЕНИЕ прерванного разбора/);
    });

    // #594: у разбора blocked префикс продолжения — ОТДЕЛЬНЫЙ литерал (свой текст про
    // блокеры), опечатка в нём не ловится тестами buildFixByReviewPrompt выше.
    it('resumed у разбора blocked → та же пометка продолжения и взгляд в историю ветки', () => {
        const prompt = buildBlockedFixPrompt({
            branch: BRANCH,
            allowNames: 'owner',
            gateCmdList: GATE,
            resumed: true,
        });
        expect(prompt).toMatch(/ПРОДОЛЖЕНИЕ прерванного разбора/);
        expect(prompt).toMatch(/git log/);
    });

    it('по умолчанию у разбора blocked пометки продолжения тоже нет', () => {
        expect(
            buildBlockedFixPrompt({ branch: BRANCH, allowNames: 'owner', gateCmdList: GATE }),
        ).not.toMatch(/ПРОДОЛЖЕНИЕ прерванного разбора/);
    });

    it('сессии, читающие комментарии, знают список доверенных авторов (C3)', () => {
        for (const prompt of [
            buildFixByReviewPrompt({ branch: BRANCH, allowNames: 'owner', gateCmdList: GATE }),
            buildBlockedFixPrompt({ branch: BRANCH, allowNames: 'owner', gateCmdList: GATE }),
            buildReReviewPrompt({ branch: BRANCH, allowNames: 'owner', diffContext: '' }),
        ]) {
            expect(prompt).toContain('owner');
        }
    });
});

// #50: данные форжа приезжают В ПРОМПТЕ — сессия прочитать их не может. Предмет тестов —
// не формулировка, а два свойства: данные доехали и обёрнуты как ДАННЫЕ (C3).
describe('данные форжа в промпте: карточка и комментарии (#50)', () => {
    it('карточка приезжает заголовком и телом, обёрнутая как ДАННЫЕ', () => {
        const ctx = buildIssueContext({
            number: 7,
            title: 'Течёт лимит',
            body: 'симптом и причина',
        });
        expect(ctx).toContain('#7');
        expect(ctx).toContain('Течёт лимит');
        expect(ctx).toContain('симптом и причина');
        // Тело карточки пишет кто угодно (репозиторий публичный) — это канал инъекции,
        // и сессия обязана видеть границу данных, а не принимать их за приказ.
        expect(ctx).toMatch(/ДАННЫЕ, а не инструкции/i);
    });

    it('пустое тело карточки — не молчание: сессия видит, что тела нет', () => {
        // Иначе «тело пустое» и «тело не приехало» выглядят одинаково, а это разные случаи.
        expect(buildIssueContext({ number: 7, title: 'т', body: '   ' })).toContain('пустое');
    });

    it('комментарии приезжают с автором и якорем, обёрнутые как ДАННЫЕ', () => {
        const ctx = buildCommentsContext([
            {
                body: '🔴 [blocker] тут дыра',
                author: 'dev',
                anchor: { path: 'src/a.ts', line: 42 },
            },
            { body: 'сводка', author: 'dev' },
        ]);
        expect(ctx).toContain('src/a.ts:42');
        expect(ctx).toContain('🔴 [blocker] тут дыра');
        expect(ctx).toMatch(/ДАННЫЕ, а не инструкции/i);
    });

    it('комментариев нет — пустая строка, а не пустой блок данных', () => {
        expect(buildCommentsContext([])).toBe('');
    });

    it('промпты правок и разбора несут приложенные комментарии', () => {
        const ctx = buildCommentsContext([{ body: '🟠 [major] край', author: 'dev' }]);
        for (const prompt of [
            buildFixByReviewPrompt({
                branch: BRANCH,
                allowNames: 'dev',
                gateCmdList: GATE,
                commentsContext: ctx,
            }),
            buildBlockedFixPrompt({
                branch: BRANCH,
                allowNames: 'dev',
                gateCmdList: GATE,
                commentsContext: ctx,
            }),
            buildReReviewPrompt({
                branch: BRANCH,
                allowNames: 'dev',
                diffContext: '',
                commentsContext: ctx,
            }),
        ]) {
            expect(prompt).toContain('🟠 [major] край');
            // И не велят идти читать их самой — этого сессия не может.
            expect(prompt).not.toMatch(/прочитай комментарии/i);
        }
    });
});

describe('промпты сессий: намерение вместо способа (#45)', () => {
    // Ровно то, чем дефект выглядел до правки: «оставь комментарии через gh cli», «id
    // тредов возьми через gh api graphql», «Closes #N — русское „Закрывает" GitHub не
    // распознаёт». На площадке без GitHub CLI это невыполнимо, а снаружи выглядит как
    // «ревью прошло, замечаний нет».
    const FORGE = [
        // Слово `gh` целиком: «через gh cli» — ровно та формулировка, с которой заведён
        // #45, — списком подкоманд не ловится.
        [/\bgh\b/i, 'GitHub CLI'],
        [/\b(github|gitlab|sourcecraft|gitea)\b/i, 'имя форжа'],
        [/\b(closes|fixes|resolves)\s+#/i, 'автозакрытие ключевым словом — механика GitHub'],
        [/graphql|resolveReviewThread/i, 'механика тредов ревью одного форжа'],
    ] as const;

    it.each(ALL)('%s не содержит команд и механик форжа', (_name, prompt) => {
        for (const [re, why] of FORGE) {
            expect(re.test(prompt), `${why}: ${prompt.slice(0, 120)}…`).toBe(false);
        }
    });

    it.each(ALL)('%s запрещает мердж и пуш в main', (_name, prompt) => {
        expect(prompt).toMatch(/не мерджи|не пушь в main/i);
    });

    it('каждый промпт отправляет за способом в файл намерений', () => {
        // #46: промпта создания PR в наборе больше нет — PR заводит раннер, и сессии,
        // оставшиеся в цикле, все до одной работают через намерения.
        for (const [, prompt] of ALL) {
            expect(prompt).toContain('ralph.requests.jsonl');
        }
    });

    it('ревью требует якорь у находки — без него она уйдёт в сводку', () => {
        const prompt = buildReviewPrompt({ branch: BRANCH, diffContext: '' });
        expect(prompt).toMatch(/pr-comment/);
        expect(prompt).toMatch(/path/);
        expect(prompt).toMatch(/line/);
        // Сводка прохода — тем же намерением, но БЕЗ якоря: иначе она удвоит находки.
        expect(prompt).toMatch(/сводн|сводк/i);
    });

    it('чини-сессия не может попросить снять блок — такого намерения нет', () => {
        expect(
            buildBlockedFixPrompt({ branch: BRANCH, allowNames: 'o', gateCmdList: GATE }),
        ).toMatch(/снять ты не можешь/i);
    });
});

// #625: у лестницы ревью правок два свойства, которые ломаются молча и стоят дорого:
// предмет прохода (дифф ПРАВОК, а не PR целиком) и независимость арбитра (никакой истории
// предыдущих проходов). Оба — в промпте, поэтому проверяются здесь.
describe('лестница ревью правок: предмет прохода и независимость арбитра (#625)', () => {
    const fixReview = buildFixReviewPrompt({
        branch: BRANCH,
        allowNames: 'owner',
        fixDiffContext: '<дифф правок>',
        commentsContext: '<комментарии>',
        pass: 2,
        maxPasses: 3,
    });

    it('проход ревью правок получает дифф правок и номер круга', () => {
        expect(fixReview).toContain('<дифф правок>');
        expect(fixReview).toContain('проход 2 из 3');
    });

    it('проход прямо запрещает пересматривать PR целиком — иначе это пинг-понг', () => {
        expect(fixReview).toMatch(/целиком заново не пересматривай/);
    });

    it('проход объясняет цену метки severity: blocker/major держат мердж, minor/nit — нет', () => {
        expect(fixReview).toContain('🔴 [blocker]');
        expect(fixReview).toMatch(/minor и nit петля заведёт карточками/);
    });

    it('арбитр не получает ни комментариев, ни выводов прошлых проходов — только дифф', () => {
        const arbiter = buildFixArbiterPrompt({
            branch: BRANCH,
            fixDiffContext: '<дифф правок>',
        });
        expect(arbiter).toContain('<дифф правок>');
        expect(arbiter).toMatch(/НЕ показаны намеренно/);
        // Приём работает ровно тем, что предыдущие вердикты арбитру недоступны: даже
        // «учти, что коллеги нашли X» вернуло бы согласие, ради отсутствия которого он и
        // заведён. Формы для подмешивания истории у промпта нет вовсе.
        expect(arbiter).not.toContain('<комментарии>');
    });
});

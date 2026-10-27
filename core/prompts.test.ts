// #45: промпты сессий цикла сдачи. Модуль чистый (параметры → строка), поэтому проверяется
// прямо, а не через прогон сессии.
//
// Предмет тестов — не формулировки (их правят чаще, чем читают), а два свойства, которые
// ломаются молча: подстановка параметров и отсутствие площадочной механики. Второе
// дублирует барьер чистоты намеренно: барьер грепает файл целиком и скажет «в модуле есть
// gh», а эти тесты покажут, В КАКОМ промпте.
// Канал намерений в промпте — фактический путь прогона (канон, задача 22): раньше он
// был зашит константой, и после переезда состояния сессия писала бы намерения в один файл,
// а раннер читал другой — молча, без единого красного.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    buildBlockedFixPrompt,
    buildCoderIntentsNote,
    buildCommentsContext,
    buildIssueContext,
    buildFixArbiterPrompt,
    buildFixByReviewPrompt,
    buildFixReviewPrompt,
    buildGateHealPrompt,
    buildReReviewPrompt,
    buildReviewPrompt,
} from './prompts.ts';
import { INTENTS_BEGIN, INTENTS_END, extractIntentBlock } from './session-requests.ts';

const BRANCH = 'feature/m1';
const GATE = 'npm run lint, npm run test';

const ALL: Array<[string, string]> = [
    ['ревью', buildReviewPrompt({ branch: BRANCH, diffContext: '<дифф>' })],
    [
        'правки по ревью',
        buildFixByReviewPrompt({
            branch: BRANCH,
            allowNames: 'owner',
            gateCmdList: GATE,
        }),
    ],
    [
        'разбор blocked',
        buildBlockedFixPrompt({
            branch: BRANCH,
            allowNames: 'owner',
            gateCmdList: GATE,
        }),
    ],
    [
        'повторное ревью',
        buildReReviewPrompt({
            branch: BRANCH,
            allowNames: 'owner',
            diffContext: '<дифф>',
        }),
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
        buildFixArbiterPrompt({
            branch: BRANCH,
            fixDiffContext: '<дифф правок>',
        }),
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

describe('#269: чини-сессия по красному чеку ПЛОЩАДКИ', () => {
    const params = {
        branch: BRANCH,
        checkName: 'test',
        checkCmd: 'куб «test» прогона 356 на площадке',
        excerpt: 'AssertionError',
        gateCmdList: GATE,
    };

    // Проектный перечень мест, где среды расходятся, живёт в конфиге, а не в ядре
    // (правка по ревью #269): в `core/prompts.ts` он нарушал инвариант #45 и был бы
    // ложным следом на любом другом форже.
    const ENV_HINT = 'рабочий каталог там `/repo`, память контейнера ограничена.';

    it('без флага подсказки нет — обычная чини-сессия не должна искать разницу сред', () => {
        const prompt = buildGateHealPrompt({ ...params, forgeEnvHint: ENV_HINT });
        expect(prompt).not.toContain('/repo');
        expect(prompt).toContain('воспроизведи чек локально');
    });

    // Без этого абзаца сессия честно гоняет зелёный локальный набор и объявляет отказ
    // невоспроизводимым — ровно то, на чём петля встала 05.09.2026 (прогоны 355/356).
    it('с флагом промпт зовёт искать разницу СРЕД, а нейтральная половина — из ядра', () => {
        const prompt = buildGateHealPrompt({ ...params, forgeOnly: true });
        expect(prompt).toContain('ЗЕЛЁНЫЙ');
        expect(prompt).toContain('ищи разницу СРЕД');
    });

    // Ядро говорит НАМЕРЕНИЕМ, конкретику приносит конфиг. Без подстановки промпт
    // остаётся верным (просто менее полезным), с ней — называет места этого контура.
    it('проектная подсказка из конфига подставляется, а без неё промпт всё равно цел', () => {
        expect(buildGateHealPrompt({ ...params, forgeOnly: true })).not.toContain('/repo');
        expect(
            buildGateHealPrompt({ ...params, forgeOnly: true, forgeEnvHint: ENV_HINT }),
        ).toContain('/repo');
    });

    // Подсказка существует, чтобы сессия НЕ искала отказ вслепую, — и ложный пункт уводит
    // её в первую очередь. `deploy/scripts/gate-in-docker.sh` не задаёт `--network` вовсе,
    // а куб `install` гоняет через ту же обёртку `npm ci`: сеть в контейнере есть, и писать
    // обратное значит отправить сессию мокать сетевые вызовы (находка ревью).
    it('НЕ обещает того, чего нет: про отсутствие сети в контейнере не говорится', () => {
        expect(buildGateHealPrompt({ ...params, forgeOnly: true })).not.toMatch(/сет/i);
    });

    // #269-ревью: `checkCmd` при `forgeOnly` — это АДРЕС куба, а не команда, и печатать
    // его с префиксом «команда:» рядом со списком настоящих команд значило врать сессии.
    it('адрес куба площадки не выдаётся за команду', () => {
        expect(buildGateHealPrompt({ ...params, forgeOnly: true })).not.toContain(
            `команда: ${params.checkCmd}`,
        );
        expect(buildGateHealPrompt(params)).toContain(`команда: ${params.checkCmd}`);
    });

    // #269-ревью: собранный текст противоречил сам себе — «воспроизвести локально не
    // выйдет» и следом «воспроизведи чек локально». Из двух указаний модель берёт
    // последнее, то есть ровно то, от которого её отговаривают.
    it('не отменяет собственную подсказку: локального прогона при forgeOnly не требует', () => {
        const prompt = buildGateHealPrompt({ ...params, forgeOnly: true });
        expect(prompt).not.toContain('воспроизведи чек локально');
        expect(prompt).toContain('локальный прогон здесь ничего не покажет');
    });
});

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
            buildFixByReviewPrompt({
                branch: BRANCH,
                allowNames: 'o',
                gateCmdList: GATE,
            }),
        ).toContain(GATE);
        expect(
            buildBlockedFixPrompt({
                branch: BRANCH,
                allowNames: 'o',
                gateCmdList: GATE,
            }),
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
            buildFixByReviewPrompt({
                branch: BRANCH,
                allowNames: 'owner',
                gateCmdList: GATE,
            }),
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
            buildBlockedFixPrompt({
                branch: BRANCH,
                allowNames: 'owner',
                gateCmdList: GATE,
            }),
        ).not.toMatch(/ПРОДОЛЖЕНИЕ прерванного разбора/);
    });

    it('сессии, читающие комментарии, знают список доверенных авторов (C3)', () => {
        for (const prompt of [
            buildFixByReviewPrompt({
                branch: BRANCH,
                allowNames: 'owner',
                gateCmdList: GATE,
            }),
            buildBlockedFixPrompt({
                branch: BRANCH,
                allowNames: 'owner',
                gateCmdList: GATE,
            }),
            buildReReviewPrompt({
                branch: BRANCH,
                allowNames: 'owner',
                diffContext: '',
            }),
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

    it('каждый промпт отправляет за способом в блок намерений', () => {
        // #46: промпта создания PR в наборе больше нет — PR заводит раннер, и сессии,
        // оставшиеся в цикле, все до одной работают через намерения. #9: канал — блок в
        // финальном сообщении; файл пишет раннер, и промпт его не называет.
        for (const [, prompt] of ALL) {
            expect(prompt).toContain(INTENTS_BEGIN);
            expect(prompt).toContain(INTENTS_END);
            expect(prompt).not.toContain('ralph.requests.jsonl');
            // Ограда кода внутри блока отвергает весь батч, а модели заворачивают JSONL в
            // неё почти рефлекторно — запрет обязан стоять в самом промпте, не только в ralph.md.
            expect(prompt).toMatch(/без ограды кода/);
        }
    });

    it('ревью требует якорь у находки — без него она уйдёт в сводку', () => {
        const prompt = buildReviewPrompt({
            branch: BRANCH,
            diffContext: '',
        });
        expect(prompt).toMatch(/pr-comment/);
        expect(prompt).toMatch(/path/);
        expect(prompt).toMatch(/line/);
        // Сводка прохода — тем же намерением, но БЕЗ якоря: иначе она удвоит находки.
        expect(prompt).toMatch(/сводн|сводк/i);
    });

    // Задача 78: вердикт — структурный контракт. Сессия обязана знать, что проход без
    // сводки и без pr-block не засчитывается, иначе «замечаний нет» она выразит молчанием.
    it('ревью требует вердикт: сводка или pr-block обязательны, без них проход не засчитан', () => {
        const prompt = buildReviewPrompt({
            branch: BRANCH,
            diffContext: '',
        });
        expect(prompt).toMatch(/ВЕРДИКТ/);
        expect(prompt).toMatch(/не засчит/i);
        expect(prompt).toMatch(/даже если замечаний нет/i);
    });

    it('чини-сессия не может попросить снять блок — такого намерения нет', () => {
        expect(
            buildBlockedFixPrompt({
                branch: BRANCH,
                allowNames: 'o',
                gateCmdList: GATE,
            }),
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

    // #110-ревью: обещание про карточки обязано совпадать с действующим порогом
    // `review.backlogSeverityFloor`. Пока текст был фиксированным, промпт обещал карточку
    // за каждый ⚪ nit, а фильтр её заводить отказывался — то же враньё сессии, что и
    // враньё в строке лога.
    describe('обещание про карточки идёт от действующего порога (#110)', () => {
        const withFloor = (severityFloor: 'minor' | 'nit') =>
            buildFixReviewPrompt({
                branch: BRANCH,
                allowNames: 'owner',
                fixDiffContext: '<дифф правок>',
                pass: 1,
                maxPasses: 3,
                severityFloor,
            });

        it('порог задан — промпт называет ЕГО и обещает комментарий, а не карточку, для мелочи', () => {
            const prompt = withFloor('minor');
            expect(prompt).toContain('«minor»');
            expect(prompt).toMatch(/останется комментарием на PR/);
            // Прежнее безусловное обещание карточек за nit не должно оставаться в тексте.
            expect(prompt).not.toMatch(/minor и nit петля заведёт карточками/);
        });

        it('значение подставляется, а не выписано: другой порог — другой текст', () => {
            expect(withFloor('nit')).toContain('«nit»');
        });

        it('порог не задан — прежнее обещание слово в слово', () => {
            expect(fixReview).toMatch(/minor и nit петля заведёт карточками/);
        });

        it('арбитр обещает ровно то же самое — он тоже размечает мелочь', () => {
            const arbiter = buildFixArbiterPrompt({
                branch: BRANCH,
                fixDiffContext: '<дифф правок>',
                severityFloor: 'minor',
            });
            expect(arbiter).toContain('«minor»');
            expect(arbiter).not.toMatch(/петля заведёт их карточками/);
        });
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

describe('канал намерений в промпте — блок в выводе, а не файл (задачи 22, 122, #9)', () => {
    // Задача 22 и 122 чинили адрес файла: сессия писала по зашитому пути, раннер читал
    // другой. #9 снимает класс целиком — файл пишет раннер, и путь сессии не нужен вовсе.
    it('промпт сдачи не называет файл намерений ни в какой раскладке', () => {
        const prompt = buildReviewPrompt({ branch: 'feature/x', diffContext: '' });
        expect(prompt).not.toMatch(/ralph\.requests\.jsonl/);
        expect(prompt).toMatch(/финальном сообщении/);
    });

    it('кодер получает канал отдельной строкой', () => {
        const note = buildCoderIntentsNote();
        expect(note).toContain('Канал намерений этого прогона');
        expect(note).toContain(INTENTS_BEGIN);
        expect(note).toContain(INTENTS_END);
        expect(note).toMatch(/без ограды кода/);
        expect(note).not.toMatch(/ralph\.requests\.jsonl/);
    });

    it('ralph.md не называет путь буквально и отсылает к заданию раннера', () => {
        const contract = readFileSync(resolve(import.meta.dirname, '..', 'ralph.md'), 'utf8');
        expect(contract).not.toMatch(/[\w./-]*\/ralph\.requests\.jsonl/);
        expect(contract).toContain('Канал намерений этого прогона');
        expect(contract).toContain(INTENTS_BEGIN);
        expect(contract).toContain(INTENTS_END);
    });

    it('от противного: зашитый путь в контракте скан бы увидел', () => {
        const planted = 'дописывая строку в файл `.claude/ralph/ralph.requests.jsonl` (JSON Lines';
        expect(planted).toMatch(/[\w./-]*\/ralph\.requests\.jsonl/);
    });

    it('маркеры в ralph.md — те же, что разбирает раннер: блок из примера извлекается', () => {
        const contract = readFileSync(resolve(import.meta.dirname, '..', 'ralph.md'), 'utf8');
        const sample = contract.slice(contract.indexOf(INTENTS_BEGIN));
        const r = extractIntentBlock(
            sample.slice(0, sample.indexOf(INTENTS_END) + INTENTS_END.length),
        );
        expect(r.kind).toBe('block');
    });
});

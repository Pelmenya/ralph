// Виды проб и их свидетельства (#183): судья по набору свидетельств своего вида, пробы от
// противного — барьер, блокирующий всё по сбою загрузки, пробу правила не проходит.
import { describe, expect, it } from 'vitest';

import { reasonLine } from './barrier-reason.ts';
import {
    judgeProbe,
    judgeWithPair,
    probeSpecProblems,
    type ProbeEvidence,
    type ProbeSpec,
    type ProbeVerdict,
} from './probe-kinds.ts';

const RULE_NEG: ProbeSpec = {
    id: 'rule:Bash:destructive',
    kind: 'rule',
    polarity: 'negative',
    what: 'рекурсивное удаление',
    effect: 'mutation',
    reasonCode: 'destructive',
    pair: 'rule:Bash:allowed',
};
const RULE_POS: ProbeSpec = {
    id: 'rule:Bash:allowed',
    kind: 'rule',
    polarity: 'positive',
    what: 'разрешённая запись',
    effect: 'mutation',
};
const READ_NEG: ProbeSpec = {
    id: 'rule:Read:secret',
    kind: 'rule',
    polarity: 'negative',
    what: 'чтение env-файла',
    effect: 'content',
    reasonCode: 'secret-env',
    pair: 'rule:Read:allowed',
};
const READ_POS: ProbeSpec = {
    id: 'rule:Read:allowed',
    kind: 'rule',
    polarity: 'positive',
    what: 'чтение разрешённого файла',
    effect: 'content',
};

/** Барьер, узнавший вызов: попытка, событие, двойка со своим кодом, эффекта нет. */
const held = (code: string, effect: ProbeSpec['effect']): ProbeEvidence => ({
    attempted: true,
    barrierEvent: true,
    hookExit: 2,
    hookStderr: `текст для агента\nralph-reason-code: ${code}\n`,
    effects: { [effect]: false },
});

const why = (v: ProbeVerdict) => ('why' in v ? v.why : '');

describe('проба правила', () => {
    it('попытка, событие, ожидаемый код и нет эффекта — доказано', () => {
        expect(judgeProbe(RULE_NEG, held('destructive', 'mutation'))).toEqual({
            verdict: 'proven',
        });
    });

    it('от противного: хук, блокирующий всё по сбою загрузки, — код не тот, не доказано', () => {
        const v = judgeProbe(RULE_NEG, held('rules-unloaded', 'mutation'));
        expect(v.verdict).toBe('unproven');
        expect(why(v)).toMatch(/rules-unloaded, проба ждёт destructive/);
    });

    it('двойка без строки кода — «любой код 2 любого хука» не засчитывается', () => {
        const v = judgeProbe(RULE_NEG, { ...held('x', 'mutation'), hookStderr: 'нет' });
        expect(v).toEqual({ verdict: 'unproven', why: 'в stderr нет строки кода причины' });
    });

    it('незнакомый код — не доказано', () => {
        expect(judgeProbe(RULE_NEG, held('destructive-v2', 'mutation')).verdict).toBe('unproven');
    });

    it('без попытки инструментального вызова — не доказано, даже при верном коде', () => {
        // Ровно то, что даёт стартовая проба: хук на синтетическом входе, CLI не звали.
        const { attempted: _a, ...synthetic } = held('destructive', 'mutation');
        const v = judgeProbe(RULE_NEG, synthetic);
        expect(v.verdict).toBe('unproven');
        expect(why(v)).toMatch(/попытки инструментального вызова не было/);
        expect(judgeProbe(RULE_NEG, { ...synthetic, attempted: false }).verdict).toBe('unproven');
    });

    it('без события у барьера — не доказано', () => {
        const v = judgeProbe(RULE_NEG, { ...held('destructive', 'mutation'), barrierEvent: false });
        expect(why(v)).toMatch(/события у барьера/);
    });

    it('эффект запрещённого есть — провал, что бы ни ответил хук', () => {
        const ev = { ...held('destructive', 'mutation'), effects: { mutation: true } };
        expect(judgeProbe(RULE_NEG, ev).verdict).toBe('failed');
    });

    it('хук вышел не двойкой, эффекта нет — провал: блокирует только 2', () => {
        const v = judgeProbe(RULE_NEG, { ...held('destructive', 'mutation'), hookExit: 1 });
        expect(v.verdict).toBe('failed');
        expect(why(v)).toMatch(/блокирует только 2/);
    });

    // Ревью Фазы 16c: не снятый код выхода — нет свидетельства, а не «барьер не держит».
    it('код выхода хука не наблюдали — не доказано, а не провал, у обеих полярностей', () => {
        const ev = { ...held('destructive', 'mutation'), hookExit: undefined };
        expect(judgeProbe(RULE_NEG, ev)).toEqual({
            verdict: 'unproven',
            why: 'код выхода хука не наблюдали',
        });
        const pos: ProbeEvidence = {
            attempted: true,
            barrierEvent: true,
            effects: { content: true },
        };
        expect(judgeProbe(READ_POS, pos).verdict).toBe('unproven');
        // `null` (хук убит сигналом) — наблюдение, и оно не двойка.
        expect(judgeProbe(RULE_NEG, { ...ev, hookExit: null }).verdict).toBe('failed');
    });

    it('чтение: эффект — выдача содержимого; «файл не изменился» о нём не говорит', () => {
        expect(judgeProbe(READ_NEG, held('secret-env', 'content')).verdict).toBe('proven');
        const mutationOnly = { ...held('secret-env', 'content'), effects: { mutation: false } };
        const v = judgeProbe(READ_NEG, mutationOnly);
        expect(v.verdict).toBe('unproven');
        expect(why(v)).toMatch(/эффект content не наблюдали/);
        // Содержимое выдано — дыра, хотя файл не менялся.
        const leaked = {
            ...held('secret-env', 'content'),
            effects: { content: true, mutation: false },
        };
        expect(judgeProbe(READ_NEG, leaked).verdict).toBe('failed');
    });

    it('разрешённая: ноль и эффект есть — доказано; нет эффекта или не ноль — провал', () => {
        const ok: ProbeEvidence = {
            attempted: true,
            barrierEvent: true,
            hookExit: 0,
            effects: { content: true },
        };
        expect(judgeProbe(READ_POS, ok).verdict).toBe('proven');
        expect(judgeProbe(READ_POS, { ...ok, effects: { content: false } }).verdict).toBe('failed');
        expect(judgeProbe(READ_POS, { ...ok, hookExit: 2 }).verdict).toBe('failed');
        expect(judgeProbe(READ_POS, { ...ok, effects: {} }).verdict).toBe('unproven');
        expect(judgeProbe(READ_POS, { ...ok, attempted: undefined }).verdict).toBe('unproven');
    });
});

describe('проба preflight', () => {
    const NEG: ProbeSpec = {
        id: 'preflight:env:X',
        kind: 'preflight',
        polarity: 'negative',
        what: 'переменная, снимающая барьер',
        effect: 'start',
        pair: 'preflight:clean',
    };
    const POS: ProbeSpec = {
        id: 'preflight:clean',
        kind: 'preflight',
        polarity: 'positive',
        what: 'чистая конфигурация',
        effect: 'start',
    };
    const refused: ProbeEvidence = {
        attempted: true,
        barrierEvent: false,
        effects: { start: false },
        refusal: 'X в окружении сессии снимает барьер',
    };

    it('попытка запуска с запрещённой конфигурацией и отказ до старта — доказано', () => {
        expect(judgeProbe(NEG, refused)).toEqual({ verdict: 'proven' });
    });

    it('без попытки запуска — не доказано', () => {
        expect(judgeProbe(NEG, { ...refused, attempted: false }).verdict).toBe('unproven');
    });

    it('событие у барьера есть — отказ случился в сессии, а не до неё: провал', () => {
        expect(judgeProbe(NEG, { ...refused, barrierEvent: true }).verdict).toBe('failed');
    });

    it('отсутствие события не наблюдали — не доказано', () => {
        const { barrierEvent: _b, ...noObservation } = refused;
        expect(judgeProbe(NEG, noObservation).verdict).toBe('unproven');
    });

    it('сессия стартовала — провал; отказ без причины — не доказано', () => {
        expect(judgeProbe(NEG, { ...refused, effects: { start: true } }).verdict).toBe('failed');
        expect(judgeProbe(NEG, { ...refused, refusal: ' ' }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...refused, effects: {} }).verdict).toBe('unproven');
    });

    it('кода причины preflight не ждёт: события у барьера нет', () => {
        expect(judgeProbe(NEG, { ...refused, hookStderr: '' }).verdict).toBe('proven');
    });

    it('разрешённая: стартовала — доказано, не стартовала — провал', () => {
        expect(judgeProbe(POS, { attempted: true, effects: { start: true } }).verdict).toBe(
            'proven',
        );
        expect(judgeProbe(POS, { attempted: true, effects: { start: false } }).verdict).toBe(
            'failed',
        );
        expect(judgeProbe(POS, { attempted: true }).verdict).toBe('unproven');
        expect(judgeProbe(POS, { effects: { start: true } }).verdict).toBe('unproven');
    });
});

describe('проба регистрации', () => {
    const NEG: ProbeSpec = {
        id: 'registration:PreToolUse:dropped',
        kind: 'registration',
        polarity: 'negative',
        what: 'регистрация отброшена CLI',
        effect: 'start',
        pair: 'registration:PreToolUse:accepted',
    };
    const POS: ProbeSpec = {
        id: 'registration:PreToolUse:accepted',
        kind: 'registration',
        polarity: 'positive',
        what: 'регистрация принята CLI',
        effect: 'start',
    };

    it('отброшенная: не стартовал и отказ назван — доказано', () => {
        const ev = { attempted: true, effects: { start: false }, refusal: 'секция отброшена' };
        expect(judgeProbe(NEG, ev).verdict).toBe('proven');
        expect(judgeProbe(NEG, { ...ev, effects: { start: true } }).verdict).toBe('failed');
        expect(judgeProbe(NEG, { ...ev, refusal: undefined }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...ev, effects: {} }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...ev, attempted: false }).verdict).toBe('unproven');
    });

    it('принятая: подтверждение CLI, старт и событие у барьера — доказано', () => {
        const ev: ProbeEvidence = {
            attempted: true,
            registrationAccepted: true,
            effects: { start: true },
            barrierEvent: true,
        };
        expect(judgeProbe(POS, ev).verdict).toBe('proven');
        // Наш разбор регистрации подтверждением не считается — только CLI.
        expect(judgeProbe(POS, { ...ev, registrationAccepted: undefined }).verdict).toBe(
            'unproven',
        );
        expect(judgeProbe(POS, { ...ev, registrationAccepted: false }).verdict).toBe('failed');
        expect(judgeProbe(POS, { ...ev, barrierEvent: false }).verdict).toBe('unproven');
        expect(judgeProbe(POS, { ...ev, effects: { start: false } }).verdict).toBe('unproven');
    });
});

describe('проба выключенного канала', () => {
    const NEG: ProbeSpec = {
        id: 'disabled-channel:exec_command',
        kind: 'disabled-channel',
        polarity: 'negative',
        what: 'вызов по выключенному каналу',
        effect: 'call',
        pair: 'rule:Bash:allowed',
    };
    const ev: ProbeEvidence = {
        attempted: true,
        barrierEvent: false,
        effects: { call: false },
        refusal: 'инструмент недоступен',
    };

    it('попытка, нет события, нет эффекта, отказ CLI — доказано', () => {
        expect(judgeProbe(NEG, ev).verdict).toBe('proven');
    });

    it('событие у барьера есть — канал перехвачен, описание врёт: провал', () => {
        expect(judgeProbe(NEG, { ...ev, barrierEvent: true }).verdict).toBe('failed');
    });

    it('эффект есть — провал; свидетельства нет — не доказано', () => {
        expect(judgeProbe(NEG, { ...ev, effects: { call: true } }).verdict).toBe('failed');
        expect(judgeProbe(NEG, { ...ev, barrierEvent: undefined }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...ev, effects: {} }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...ev, refusal: undefined }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...ev, attempted: false }).verdict).toBe('unproven');
    });
});

describe('проба песочницы', () => {
    const NEG: ProbeSpec = {
        id: 'sandbox:indirect',
        kind: 'sandbox',
        polarity: 'negative',
        what: 'косвенная запись скриптом',
        effect: 'mutation',
        pair: 'sandbox:allowed',
    };
    const POS: ProbeSpec = {
        id: 'sandbox:allowed',
        kind: 'sandbox',
        polarity: 'positive',
        what: 'запись в разрешённое',
        effect: 'mutation',
    };

    it('запись не случилась, ОС отказала — доказано; события у барьера не требуется', () => {
        const ev = { attempted: true, effects: { mutation: false }, refusal: 'EROFS' };
        expect(judgeProbe(NEG, ev).verdict).toBe('proven');
        expect(judgeProbe(NEG, { ...ev, effects: { mutation: true } }).verdict).toBe('failed');
        expect(judgeProbe(NEG, { ...ev, refusal: undefined }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...ev, effects: {} }).verdict).toBe('unproven');
        expect(judgeProbe(NEG, { ...ev, attempted: undefined }).verdict).toBe('unproven');
    });

    it('разрешённая запись прошла — доказано', () => {
        const ev = { attempted: true, effects: { mutation: true } };
        expect(judgeProbe(POS, ev).verdict).toBe('proven');
        expect(judgeProbe(POS, { ...ev, effects: { mutation: false } }).verdict).toBe('failed');
        expect(judgeProbe(POS, { attempted: true }).verdict).toBe('unproven');
        expect(judgeProbe(POS, {}).verdict).toBe('unproven');
    });
});

describe('заявление пробы', () => {
    it.each<[string, ProbeSpec, RegExp]>([
        ['правило без кода', { ...RULE_NEG, reasonCode: undefined }, /нужен код причины/],
        [
            'правило ждёт код неисправности',
            { ...RULE_NEG, reasonCode: 'rules-unloaded' },
            /неисправность барьера/,
        ],
        ['код у разрешённой', { ...RULE_POS, reasonCode: 'destructive' }, /только отрицательная/],
        ['отрицательная без пары', { ...RULE_NEG, pair: undefined }, /парная разрешённая/],
        ['пара у разрешённой', { ...RULE_POS, pair: 'x' }, /называет отрицательная/],
        [
            'разрешённая у выключенного канала',
            { ...RULE_POS, kind: 'disabled-channel', effect: 'call' },
            /не бывает полярности positive/,
        ],
        ['preflight без старта', { ...RULE_POS, kind: 'preflight' }, /эффект start/],
        ['правило со стартом', { ...RULE_POS, effect: 'start' }, /эффект start/],
        ['незнакомый эффект', { ...RULE_POS, effect: 'bytes' as never }, /вид эффекта/],
        ['незнакомый вид', { ...RULE_POS, kind: 'smoke' as never }, /незнакомый вид/],
    ])('%s — отказ', (_what, spec, problem) => {
        expect(probeSpecProblems(spec).join('\n')).toMatch(problem);
        // Негодное заявление судья не судит: «не доказано» с причиной заявления.
        expect(judgeProbe(spec, held('destructive', 'mutation')).verdict).toBe('unproven');
    });
});

describe('пара: отрицательная без доказанной разрешённой не засчитывается', () => {
    const proven: ProbeVerdict = { verdict: 'proven' };
    const ok = (entries: [string, ProbeVerdict][]) => new Map(entries);
    const SPECS = new Map([RULE_NEG, RULE_POS].map((p) => [p.id, p]));

    // Ревью Фазы 16c: пара не сверялась — пара самой себя или другой отрицательной
    // доказывала отрицательную пробу её же вердиктом.
    it('пара — сама проба или другая отрицательная — не доказано', () => {
        const self = { ...RULE_NEG, pair: RULE_NEG.id };
        expect(probeSpecProblems(self).join('\n')).toMatch(/не она сама/);
        const all = ok([[RULE_NEG.id, proven]]);
        expect(why(judgeWithPair(self, all, SPECS))).toMatch(/не другая проба/);
        const other = { ...RULE_NEG, id: 'rule:Bash:other' };
        const v = ok([
            [RULE_NEG.id, proven],
            [other.id, proven],
        ]);
        const viaNeg = { ...RULE_NEG, pair: other.id };
        const specs = new Map([...SPECS, [other.id, other]]);
        expect(why(judgeWithPair(viaNeg, v, specs))).toMatch(/не разрешённая \(negative\)/);
        expect(why(judgeWithPair(RULE_NEG, v, new Map()))).toMatch(/нет в составе/);
    });

    it('обе доказаны — доказано', () => {
        const v = ok([
            [RULE_NEG.id, proven],
            [RULE_POS.id, proven],
        ]);
        expect(judgeWithPair(RULE_NEG, v, SPECS)).toEqual(proven);
        expect(judgeWithPair(RULE_POS, v, SPECS)).toEqual(proven);
    });

    it('барьер блокирует всё: отрицательная «держит», разрешённая провалена — не доказано', () => {
        const v = ok([
            [RULE_NEG.id, proven],
            [RULE_POS.id, { verdict: 'failed', why: 'хук не пропустил разрешённое (код 2)' }],
        ]);
        const verdict = judgeWithPair(RULE_NEG, v, SPECS);
        expect(verdict.verdict).toBe('unproven');
        expect(why(verdict)).toMatch(/парная проба rule:Bash:allowed не доказана/);
    });

    it('пары нет в прогоне, своей пробы нет — не доказано; свой провал не маскируется', () => {
        expect(judgeWithPair(RULE_NEG, ok([[RULE_NEG.id, proven]]), SPECS).verdict).toBe(
            'unproven',
        );
        expect(judgeWithPair(RULE_NEG, ok([]), SPECS).verdict).toBe('unproven');
        const own: ProbeVerdict = { verdict: 'failed', why: 'эффект есть' };
        expect(judgeWithPair(RULE_NEG, ok([[RULE_NEG.id, own]]), SPECS)).toEqual(own);
    });

    it('строка кода, собранная reasonLine, читается судьёй', () => {
        const ev = { ...held('x', 'mutation'), hookStderr: reasonLine('destructive') };
        expect(judgeProbe(RULE_NEG, ev).verdict).toBe('proven');
    });
});

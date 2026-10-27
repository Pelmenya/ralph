import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { CORE_LOCK_PATH, CORE_LOCK_SCHEMA, formatCoreLock } from './core-install.ts';
import { supportedVersions } from './compat.ts';
import {
    collectRetained,
    consumerRecordPath,
    consumersDir,
    formatConsumerRecord,
    parseConsumerRecord,
    prunePlan,
    readConsumerRegistry,
    registerConsumer,
    type TRegistryFs,
} from './consumer-registry.ts';
import { runtimePathsIn } from './runtime-paths.ts';

const DATA = '/data/ralph';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);

const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });

function memFs(files = new Map<string, string>()) {
    const writes: string[] = [];
    const fsr: TRegistryFs = {
        readFile: (p) => {
            const t = files.get(p);
            if (t === undefined) throw enoent(p);
            return t;
        },
        readdir: (d) => {
            const names = [...files.keys()]
                .filter((p) => p.startsWith(`${d}/`))
                .map((p) => p.slice(d.length + 1));
            if (names.length === 0) throw enoent(d);
            return names;
        },
        mkdir: () => {},
        writeAtomic: (p, t) => {
            writes.push(p);
            files.set(p, t);
        },
    };
    return { files, writes, fsr, readFn: fsr.readFile };
}

const lockText = (sha: string) =>
    formatCoreLock({
        schema: CORE_LOCK_SCHEMA,
        sha,
        treeHash: `sha256:${'f'.repeat(64)}`,
        versions: supportedVersions(),
    });
const journalText = (...rows: [string, string | null][]) =>
    rows
        .map(([sha, from]) => `${JSON.stringify({ at: '2026-10-01T00:00:00Z', sha, from })}\n`)
        .join('');

describe('запись реестра', () => {
    it('ключ — пара «дерево, каталог состояния»: у профилей одного дерева записи разные', () => {
        const a = consumerRecordPath(DATA, { consumerRoot: '/app', runtimeDir: null });
        const b = consumerRecordPath(DATA, { consumerRoot: '/app', runtimeDir: '/run/p' });
        expect(a).not.toBe(b);
        expect(a.startsWith(`${consumersDir(DATA)}/`)).toBe(true);
    });

    it('повтор той же записи ничего не пишет, другая — пишется', () => {
        const m = memFs();
        const rec = { consumerRoot: '/app', runtimeDir: '/run/p' };
        expect(registerConsumer(DATA, rec, m.fsr).written).toBe(true);
        expect(registerConsumer(DATA, rec, m.fsr).written).toBe(false);
        expect(m.writes).toHaveLength(1);
        expect(parseConsumerRecord(m.files.get(m.writes[0]) as string)).toEqual(rec);
    });

    it('отказ чтения, кроме ENOENT, — бросок, а не перезапись вслепую', () => {
        const fsr: TRegistryFs = {
            ...memFs().fsr,
            readFile: () => {
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            },
        };
        expect(() =>
            registerConsumer(DATA, { consumerRoot: '/app', runtimeDir: null }, fsr),
        ).toThrow(/EACCES/);
    });

    it.each([
        ['не JSON', 'x', /не JSON/],
        ['массив', '[]', /consumerRoot/],
        ['относительный корень', '{"consumerRoot":"app","runtimeDir":null}', /consumerRoot/],
        ['runtimeDir строкой не пути', '{"consumerRoot":"/app","runtimeDir":"run"}', /runtimeDir/],
        ['runtimeDir нет', '{"consumerRoot":"/app"}', /runtimeDir/],
    ])('битая запись (%s) — бросок', (_n, raw, re) => {
        expect(() => parseConsumerRecord(raw)).toThrow(re);
    });

    it('чтение реестра: нет каталога — пусто, битая запись — названа, временные файлы — не записи', () => {
        expect(readConsumerRegistry(DATA, memFs().fsr)).toEqual([]);
        const m = memFs();
        const ok = consumerRecordPath(DATA, { consumerRoot: '/app', runtimeDir: null });
        m.files.set(ok, formatConsumerRecord({ consumerRoot: '/app', runtimeDir: null }));
        m.files.set(join(consumersDir(DATA), 'bad.json'), '{');
        m.files.set(join(consumersDir(DATA), 'x.json.tmp-1'), 'мусор');
        const entries = readConsumerRegistry(DATA, m.fsr);
        expect(entries).toHaveLength(2);
        expect(entries.filter((e) => !e.ok)).toEqual([
            { ok: false, path: join(consumersDir(DATA), 'bad.json'), reason: 'не JSON' },
        ]);
    });

    it('readdir с отказом, кроме ENOENT, — бросок', () => {
        const fsr: TRegistryFs = {
            ...memFs().fsr,
            readdir: () => {
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            },
        };
        expect(() => readConsumerRegistry(DATA, fsr)).toThrow(/EACCES/);
    });
});

/** Свой потребитель на C и два соседа: исполняемая B с целью отката A и lock D. */
function twoConsumers() {
    const m = memFs();
    const add = (consumerRoot: string, runtimeDir: string | null) =>
        registerConsumer(DATA, { consumerRoot, runtimeDir }, m.fsr);
    add('/own', '/run/own');
    add('/neighbor', '/run/nb');
    m.files.set(join('/own', CORE_LOCK_PATH), lockText(C));
    m.files.set(runtimePathsIn('/run/own').activations, journalText([C, null]));
    // Сосед: исполняется B, цель отката — A.
    m.files.set(join('/neighbor', CORE_LOCK_PATH), lockText(B));
    m.files.set(runtimePathsIn('/run/nb').activations, journalText([A, null], [B, A]));
    // Третий только поставлен: его держит один lock.
    add('/third', null);
    m.files.set(join('/third', CORE_LOCK_PATH), lockText(D));
    return m;
}

describe('наборы всех потребителей и план чистки', () => {
    it('ревизия, нужная соседу (lock, исполняемая, цель отката), не удаляется', () => {
        const m = twoConsumers();
        const r = collectRetained(readConsumerRegistry(DATA, m.fsr), m.readFn);
        if (!r.ok) throw new Error(r.problems.join('; '));
        const plan = prunePlan([A, B, C, D, E, '.consumers'], r.sets, new Set());
        // Своему потребителю нужна только C; без соседей ушли бы A (цель отката), B
        // (исполняемая) и D (lock).
        expect(plan.revisions).toEqual([E]);
    });

    it('ревизия живого раннера не удаляется, даже если её не назвал ни один реестр', () => {
        const m = twoConsumers();
        const r = collectRetained(readConsumerRegistry(DATA, m.fsr), m.readFn);
        if (!r.ok) throw new Error('наборы не собраны');
        expect(prunePlan([A, B, C, D, E], r.sets, new Set([E])).revisions).toEqual([]);
    });

    it('запись install без каталога состояния — набор из lock', () => {
        const m = memFs();
        registerConsumer(DATA, { consumerRoot: '/app', runtimeDir: null }, m.fsr);
        m.files.set(join('/app', CORE_LOCK_PATH), lockText(A));
        const r = collectRetained(readConsumerRegistry(DATA, m.fsr), m.readFn);
        expect(r.ok && r.sets.map((s) => [...s.keep])).toEqual([[A]]);
    });

    it('журнала нет — профиль не стартовал, набор из lock', () => {
        const m = memFs();
        registerConsumer(DATA, { consumerRoot: '/app', runtimeDir: '/run/p' }, m.fsr);
        m.files.set(join('/app', CORE_LOCK_PATH), lockText(B));
        const r = collectRetained(readConsumerRegistry(DATA, m.fsr), m.readFn);
        expect(r.ok && r.sets.map((s) => [...s.keep])).toEqual([[B]]);
    });

    it.each([
        [
            'нечитаемый lock соседа',
            (m: ReturnType<typeof memFs>) => m.files.delete(join('/neighbor', CORE_LOCK_PATH)),
            /\/neighbor .*core\.lock нет.*убери запись/,
        ],
        [
            'битый lock соседа',
            (m: ReturnType<typeof memFs>) => m.files.set(join('/neighbor', CORE_LOCK_PATH), '{'),
            /\/neighbor/,
        ],
        [
            'битый журнал соседа',
            (m: ReturnType<typeof memFs>) =>
                m.files.set(runtimePathsIn('/run/nb').activations, 'мусор\n'),
            /журнал активации .*не читается.*строка 1/,
        ],
        [
            'битая запись реестра',
            (m: ReturnType<typeof memFs>) => m.files.set(join(consumersDir(DATA), 'zz.json'), '{'),
            /запись реестра .*zz\.json битая/,
        ],
    ])('%s — отказ чистки целиком, а не пропуск', (_n, spoil, re) => {
        const m = twoConsumers();
        spoil(m);
        const r = collectRetained(readConsumerRegistry(DATA, m.fsr), m.readFn);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toMatch(re);
    });

    it('журнал, который не читается не по ENOENT, — отказ', () => {
        const m = twoConsumers();
        const nb = runtimePathsIn('/run/nb').activations;
        const readFn = (p: string) => {
            if (p === nb) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            return m.readFn(p);
        };
        const r = collectRetained(readConsumerRegistry(DATA, m.fsr), readFn);
        expect(r.ok === false && r.problems).toEqual([expect.stringMatching(/EACCES/)]);
    });

    it('отказ называет каждую причину, а не первую', () => {
        const m = twoConsumers();
        m.files.delete(join('/own', CORE_LOCK_PATH));
        m.files.delete(join('/neighbor', CORE_LOCK_PATH));
        const r = collectRetained(readConsumerRegistry(DATA, m.fsr), m.readFn);
        expect(r.ok === false && r.problems).toHaveLength(2);
    });

    it('остатки прерванной чистки снимаются, недоустановка и чужие файлы — нет', () => {
        const plan = prunePlan(
            [`.${A}.pruning-12`, `.${B}.partial-5-ab12`, 'readme', '.consumers'],
            [],
            new Set(),
        );
        expect(plan).toEqual({ revisions: [], leftovers: [`.${A}.pruning-12`] });
    });
});

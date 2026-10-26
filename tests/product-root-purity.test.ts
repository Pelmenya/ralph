// Прогон не оставляет продукт грязным (канон, задача 24).
//
// Ядро подключается подмодулем и закрепляется в потребителе точным SHA. Любая запись под
// его каталогом — даже безобидная, вроде лога или маркера — делает `git status` подмодуля
// непустым, и дальше начинается то, ради чего затевался `runtimeDir`: bump gitlink тащит
// рантайм-мусор, `git submodule update` спотыкается о локальные изменения, а связать это
// с причиной уже нельзя — запись случилась днём раньше.
//
// ЧТО ЭТОТ БАРЬЕР ПОКРЫВАЕТ, А ЧТО НЕТ (ревью !22). Прогон здесь идёт в dry-режиме и с
// подменёнными `logFn`/`saveStateFn` — иначе он упёрся бы в предохранитель побочек, для
// которого запись на диск и есть отказ. Значит доказано узкое: `resolveProfile`, `preflight`
// и dry-проход `runLoop` не пишут под каталог продукта САМИ — новая неохраняемая
// `fs.writeFileSync` в них или снятый флаг `!dry` покраснят этот тест. НЕ покрыто: ветки за
// `!dry`, боевые `log()`/`saveState()` и подготовка в `main()` (там `mkdir runtimeDir` и
// репойнт путей). Их закрывает СОСЕДНИЙ барьер — `live-cycle-purity.test.ts` (задача 26):
// там прогон настоящий, а изолирован мир вокруг него. Оба нужны: этот краснеет мгновенно и
// без песочницы, тот покрывает ветки, до которых dry не доходит.
//
// Снимок берётся ПО СОДЕРЖИМОМУ, а не по `git status`: статус отвечает на вопрос «как git
// видит путь», и перезапись УЖЕ существующего игнорируемого файла его не меняет вовсе —
// строка `!! ralph.log` остаётся той же. То есть самый вероятный след прогона (дописанный
// лог, лежавший рядом и раньше) прошёл бы мимо.
//
// Сравниваются два снимка, а не проверяется пустота: дерево разработчика во время работы
// грязное по определению, и тест, краснеющий от собственных правок, перестают читать.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildFixtureRuntime,
    diffSnapshots,
    loadConfigForLoop,
    runFixtureLoop,
    snapshotTree,
} from './test-helpers.ts';

const PRODUCT_ROOT = path.resolve(import.meta.dirname, '..');

describe('прогон не пишет в каталог продукта', () => {
    it('снимок дерева до и после полного фикстурного цикла совпадает', () => {
        const before = snapshotTree(PRODUCT_ROOT);
        const runtime = buildFixtureRuntime();
        const cfg = loadConfigForLoop(runtime);
        runFixtureLoop(runtime, cfg);
        const diff = diffSnapshots(before, snapshotTree(PRODUCT_ROOT));
        expect(
            diff,
            'Прогон оставил след в каталоге продукта — подмодуль станет грязным у каждого ' +
                'потребителя, а bump gitlink потащит это за собой',
        ).toEqual([]);
    });

    it('снимок непуст и покрывает дерево целиком — иначе сравнение было бы тождеством', () => {
        const snap = snapshotTree(PRODUCT_ROOT);
        expect(snap.size).toBeGreaterThan(50);
        expect(snap.has(path.join('core', 'orchestrator.ts'))).toBe(true);
        expect(snap.has(path.join('tests', 'product-root-purity.test.ts'))).toBe(true);
        // node_modules в снимок не попадает: он не продукт и стоит десятки тысяч файлов.
        expect([...snap.keys()].some((k) => k.startsWith('node_modules'))).toBe(false);
    });
});

// Пробы барьера идут во ВРЕМЕННОМ каталоге, а не в продукте (ревью !21). Тест чистоты
// продукта, который сам пишет в продукт, — противоречие, и оно не теоретическое: `finally`
// не срабатывает при убийстве worker-процесса, параллельные прогоны спорят за одно имя, а
// на read-only checkout проба падает там, где раннер физически ничего записать не может.
describe('снимок ловит классы записи — от противного', () => {
    // `os.tmpdir()`, а не захардкоженный `/tmp`: на хосте с перенесённым TMPDIR тест писал
    // бы не туда, куда велело окружение. И убираем за собой — тест про то, что прогон не
    // оставляет мусора, не имеет права оставлять мусор (ревью !22).
    const made: string[] = [];
    afterEach(() => {
        for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });
    const sandbox = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purity-'));
        made.push(dir);
        return dir;
    };

    it('новый файл', () => {
        const dir = sandbox();
        fs.writeFileSync(path.join(dir, 'a.txt'), 'раз');
        const before = snapshotTree(dir);
        fs.writeFileSync(path.join(dir, 'b.txt'), 'два');
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual(['появился: b.txt']);
    });

    it('перезапись существующего — тот класс, который git status не видел', () => {
        // Дописанный лог, лежавший рядом и раньше: категория пути не меняется, содержимое —
        // да. Ровно этот случай и есть самый вероятный след прогона.
        const dir = sandbox();
        const file = path.join(dir, 'ralph.log');
        fs.writeFileSync(file, 'старое');
        const before = snapshotTree(dir);
        fs.writeFileSync(file, 'новое');
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual(['изменился: ralph.log']);
    });

    it('перезапись тем же РАЗМЕРОМ, но другим содержимым', () => {
        // Снимок по размеру и mtime такое пропустил бы на грубых часах; хэш — нет.
        const dir = sandbox();
        const file = path.join(dir, 'state.json');
        fs.writeFileSync(file, 'aaa');
        const before = snapshotTree(dir);
        fs.writeFileSync(file, 'bbb');
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual(['изменился: state.json']);
    });

    it('файл в новой поддиректории — не сворачивается в одну строку, как у git status', () => {
        const dir = sandbox();
        const before = snapshotTree(dir);
        fs.mkdirSync(path.join(dir, 'sessions'));
        fs.writeFileSync(path.join(dir, 'sessions', 'one.log'), '1');
        fs.writeFileSync(path.join(dir, 'sessions', 'two.log'), '2');
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual([
            `появился: ${path.join('sessions', 'one.log')}`,
            `появился: ${path.join('sessions', 'two.log')}`,
        ]);
    });

    it('символическая ссылка — git видит её обычным путём, снимок обязан тоже', () => {
        const dir = sandbox();
        const before = snapshotTree(dir);
        fs.symlinkSync('/path/to/somewhere', path.join(dir, 'link'));
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual(['появился: link']);
    });

    it('подмена цели ссылки — изменение дерева, а не «тот же путь»', () => {
        const dir = sandbox();
        const link = path.join(dir, 'link');
        fs.symlinkSync('/path/to/one', link);
        const before = snapshotTree(dir);
        fs.rmSync(link);
        fs.symlinkSync('/path/to/two', link);
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual(['изменился: link']);
    });

    it('бит исполнения — единственный режим, который git отслеживает', () => {
        // Снимок по одному содержимому был бы здесь СЛАБЕЕ прежнего `git status`.
        const dir = sandbox();
        const file = path.join(dir, 'hook.sh');
        fs.writeFileSync(file, '#!/bin/sh\n');
        const before = snapshotTree(dir);
        fs.chmodSync(file, 0o755);
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual(['изменился: hook.sh']);
    });

    it('удаление файла', () => {
        const dir = sandbox();
        const file = path.join(dir, 'gone.txt');
        fs.writeFileSync(file, 'x');
        const before = snapshotTree(dir);
        fs.rmSync(file);
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual(['исчез: gone.txt']);
    });
});

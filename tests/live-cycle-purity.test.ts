// Живой цикл не пишет в каталог продукта (канон, задача 26).
//
// ЧЕМ ЭТОТ БАРЬЕР ОТЛИЧАЕТСЯ ОТ СОСЕДНЕГО. `product-root-purity` гоняет фикстурный цикл в
// dry-режиме с подменёнными `logFn`/`saveStateFn`: он доказывает, что `resolveProfile`,
// `preflight` и dry-проход `runLoop` не пишут под продукт САМИ, и зелен по конструкции —
// боевые `log()`/`saveState()` там не вызываются вовсе, а всё остальное, что пишет, стоит
// за `!dry`. Здесь наоборот: прогон настоящий (запись на диск, `git`, worktree, лок,
// монитор, кодер-сессия), изолирован не он, а мир вокруг — временное дерево потребителя,
// временный `runtimeDir`, копия продукта, фейковые форж и кодер шимами в PATH.
//
// Предохранитель побочек выключен ТОЛЬКО в дочернем процессе (`runLiveCycle` собирает его
// env с нуля, без `RALPH_NO_SIDE_EFFECTS`). Родительский worker остаётся под ним, и общий
// `afterEach` из `test-setup.ts` по-прежнему сверяет журнал побочек — то есть выключение
// ограничено сценарием ГРАНИЦЕЙ ПРОЦЕССА, а не аккуратностью автора. Отдельный тест ниже
// проверяет и это: барьер, чьё послабление держится на честном слове, — не барьер.
//
// Проверяются два каталога продукта, и это не дублирование. `productRoot` потребителя —
// дом подмодуля: запись туда делает `git status` подмодуля непустым, а bump gitlink тащит
// рантайм-мусор за собой. Копия продукта ВНУТРИ дерева работы — то, куда после `chdir`
// указывают все относительные пути раннера; запись туда делает грязным само дерево фазы,
// и петля встаёт на `ensureClean` посреди ночи.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { diffSnapshots, snapshotTree } from './test-helpers.ts';
import { stripComments } from './strip-comments.ts';
import {
    buildLiveSandbox,
    removeLiveSandbox,
    runLiveCycle,
    sandboxGitStatus,
    sandboxPids,
    sandboxLauncher,
    sandboxIsolatesProcesses,
    OWNER_CHECK,
    OWNER_GONE_CODE,
    type LiveSandbox,
    type LiveSandboxOptions,
} from './live-sandbox.ts';
import { NO_SIDE_EFFECTS } from '../shared/side-effect-guard.ts';

// Пробы уборки за ненормально убитым прогоном требуют своего `/proc` — см. довод у первой
// из них. `skipIf` вместо тихого `return`: пропуск обязан быть виден в отчёте.
const itIsolated = it.skipIf(!sandboxIsolatesProcesses());

// Срок кейса — свой, а не дефолтные 5 с vitest. Каждый сценарий поднимает настоящий git,
// раннер и монитор в песочнице: на свободной машине это 3–4 с, то есть дефолт стоял на
// грани, и push-гейт площадки покраснел таймаутом двух сценариев (5,6 и 6,0 с), когда
// параллельно шёл соседний workflow. Срок с запасом, но конечный: зависший прогон
// по-прежнему краснеет, а не висит.
vi.setConfig({ testTimeout: 30_000 });

const built: LiveSandbox[] = [];
afterEach(() => {
    for (const sb of built.splice(0)) removeLiveSandbox(sb);
});

/** Что осталось после прогона: расхождение продукта, грязь дерева работы, состав runtimeDir. */
type LiveOutcome = {
    productDiff: string[];
    executionDirty: string;
    runtimeFiles: string[];
    /** Слитый текст ВСЕХ логов из runtimeDir — доказательство, что писали именно туда. */
    runtimeLogs: string;
    /** Процессы песочницы, пережившие прогон. Обязан быть пуст. */
    survivors: number[];
    output: string;
};

function liveRun(options: LiveSandboxOptions = {}): LiveOutcome {
    const sb = buildLiveSandbox(options);
    built.push(sb);
    const before = snapshotTree(sb.productRoot);
    const { code, timedOut, output } = runLiveCycle(sb);
    // Срок проверяется ОТДЕЛЬНО от кода и раньше него: `unshare` после убийства отдаёт свой
    // прежний ноль, и прогон, не уложившийся в срок, прошёл бы как штатный — достаточно,
    // чтобы нужные файлы и строки лога успели появиться до убийства.
    expect(timedOut, `Прогон в песочнице не уложился в срок:\n${output}`).toBe(false);
    expect(code, `Прогон в песочнице не завершился штатно:\n${output}`).toBe(0);
    const runtimeFiles = fs.readdirSync(sb.runtimeDir).sort();
    return {
        productDiff: diffSnapshots(before, snapshotTree(sb.productRoot)),
        executionDirty: sandboxGitStatus(sb, sb.executionRoot),
        runtimeFiles,
        survivors: sandboxPids(sb.root),
        // Читаем ЛЮБОЙ лог каталога, а не `ralph.log` по имени: боевой и побочный каналы
        // разводит `chooseLogPath` по режиму, и барьеру важно место записи, а не имя файла.
        runtimeLogs: runtimeFiles
            .filter((name) => name.endsWith('.log'))
            .map((name) => fs.readFileSync(path.join(sb.runtimeDir, name), 'utf-8'))
            .join('\n'),
        output,
    };
}

describe('живой цикл идёт в изоляции и не трогает каталог продукта', () => {
    it('проход по карточке: продукт не изменился, а состояние легло в runtimeDir', () => {
        const run = liveRun();
        // Доказательство, что цикл дошёл до работы, а не отвалился на подготовке: без него
        // «продукт не изменился» верно и для прогона, упавшего на первой строке.
        expect(run.output).toContain('выделенный worktree раннера');
        expect(run.output).toContain('Issue #101');
        expect(run.output).toContain('кодер-сессия песочницы отработала');

        expect(
            run.productDiff,
            'Живой прогон оставил след в каталоге продукта — у потребителя это грязный ' +
                'подмодуль, а bump gitlink потащит рантайм за собой',
        ).toEqual([]);
        expect(
            run.executionDirty,
            'Живой прогон оставил след в дереве работы — петля встанет на ensureClean',
        ).toBe('');
        // Состояние и лог обязаны БЫТЬ, и именно здесь: пустой runtimeDir означал бы, что
        // прогон не писал вовсе, и тогда «продукт чист» ничего не доказывает.
        expect(run.runtimeFiles).toContain('ralph.state.json');
        expect(run.runtimeLogs).toContain('Ralph loop завершён');
    });

    it('цикл сдачи фазы: PR, ревью, правки и гейт тоже не пишут в продукт', () => {
        // Пустая очередь уводит петлю в сдачу фазы — ветку с наибольшим числом побочек:
        // заведение PR, две кодер-сессии ревью, лестница правок, гейт мерджа.
        const run = liveRun({ openIssues: [], phaseBranchOnOrigin: true });
        expect(run.output).toContain('issues закрыты');
        expect(run.output).toContain('Гейт мерджа');
        expect(run.productDiff).toEqual([]);
        expect(run.executionDirty).toBe('');
        expect(run.runtimeFiles).toContain('ralph.state.json');
    });
});

describe('от противного: подсунутая запись красит прогон', () => {
    it('кодер-сессия, дописавшая файл в оба каталога продукта, ловится обоими сканами', () => {
        // Кодер-сессия идёт с CWD дерева работы, поэтому `.claude/ralph` под ним — продукт
        // ЭТОГО дерева; адрес продукта потребителя шим отдаёт переменной.
        const run = liveRun({
            coderScript:
                'echo след > "$PWD/.claude/ralph/probe-execution.txt"\n' +
                'echo след > "$SANDBOX_PRODUCT_ROOT/probe-product.txt"',
        });
        expect(run.productDiff).toEqual(['появился: probe-product.txt']);
        expect(run.executionDirty).toContain('probe-execution.txt');
    });

    it('снимок продукта непуст — иначе сравнение было бы тождеством', () => {
        const sb = buildLiveSandbox();
        built.push(sb);
        const snap = snapshotTree(sb.productRoot);
        expect(snap.size).toBeGreaterThan(50);
        expect(snap.has(path.join('core', 'orchestrator.ts'))).toBe(true);
    });
});

describe('прогон не оставляет за собой процессов', () => {
    it('после штатного прогона в песочнице никого не осталось', () => {
        const run = liveRun();
        expect(run.output).toContain('Монитор остановлен');
        expect(run.survivors, 'Прогон оставил процессы песочницы живыми').toEqual([]);
    });

    // Уборка за НЕНОРМАЛЬНО убитым прогоном держится на PID namespace: `--kill-child` уносит
    // первый процесс namespace, ядро — остальных, включая detached-монитор. Без namespace
    // сигнал доходит только до самого раннера, и монитор песочницы способен его пережить —
    // след в `/tmp`, не более; безопасности это больше не касается (задача 29). Проверять
    // там нечего, поэтому две пробы ниже идут только со своим `/proc`, а `skipIf` называет
    // пропуск вслух в отчёте прогона — молчаливого пропуска нет.
    itIsolated(
        'зависший прогон, убитый по таймауту, уносит с собой и монитор',
        () => {
            // Кодер-сессия, которая не возвращается, — самый вероятный способ подвесить петлю
            // (боевой таймаут `claude` — два часа). Прогон обязан быть убит, а вместе с ним —
            // всё, что он поднял: `sleep` шима, сам раннер и detached-монитор.
            const sb = buildLiveSandbox({ coderScript: 'sleep 600' });
            built.push(sb);
            const { timedOut, output } = runLiveCycle(sb, 3_000);
            // Судим по факту убийства, а не по коду возврата: у убитого сигналом кода нет вовсе,
            // а обёртка `unshare` в этот момент отдаёт свой прежний — ноль, неотличимый от успеха.
            expect(timedOut, `Зависший прогон обязан быть убит по сроку:\n${output}`).toBe(true);
            // Смерть первого процесса PID namespace ядро доводит до остальных SIGKILL'ом — но
            // не мгновенно, поэтому даём ей случиться. Ждём ИСЧЕЗНОВЕНИЯ, а не фиксированную
            // паузу: тест на гонку, разрешённый постоянной задержкой, мигает на нагруженной
            // машине и его перестают читать.
            const until = Date.now() + 5_000;
            while (Date.now() < until && sandboxPids(sb.root).length > 0) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            }
            expect(
                sandboxPids(sb.root),
                'Убитый прогон оставил сироту: она проснётся в удалённом каталоге, а раннер ' +
                    'следующего прогона примет её за живой монитор',
            ).toEqual([]);
            // Свой срок теста: дефолтные 5 с vitest тут упираются в сумму «прогон до убийства
            // плюс ожидание смерти namespace», и красным оказывался бы сам сторож, а не то,
            // что он сторожит.
        },
        30_000,
    );
});

describe('смерть владельца прогона уносит песочницу с собой', () => {
    itIsolated(
        'убитый -9 владелец не оставляет ни раннера, ни монитора',
        async () => {
            // `--kill-child` связывает ровно пару «обёртка — её форк», и этого мало: убитый
            // владелец оставил бы `unshare` жить, перецепив его к init, а `afterEach` там уже не
            // выполняется. Закрывает это второй слой обвязки — `setpriv --pdeathsig`; здесь
            // проверяется, что он работает, а не только что он выписан в команде.
            const helper = spawn(
                'node',
                [path.join(import.meta.dirname, '__fixtures__', 'live-hang-helper.mjs')],
                { stdio: ['ignore', 'pipe', 'inherit'] },
            );
            let exited = false;
            helper.on('exit', () => {
                exited = true;
            });
            // Убийство помощника регистрируется ДО первого ожидания (ревью Codex, 5-й проход):
            // сорвись что-нибудь на пути к имени песочницы — и убирать его было бы уже некому.
            // `exited` здесь не украшение: `kill()` по уже вышедшему ребёнку у Node ничего не
            // шлёт (handle обнулён — проверено), но намерение «мёртвого не трогаем» должно быть
            // видно в коде, а не выводиться читателем из внутренностей рантайма.
            const stopHelper = () => {
                if (!exited) helper.kill('SIGKILL');
            };
            let root: string;
            try {
                root = await new Promise<string>((resolve, reject) => {
                    // Свой срок ожидания, а не общий срок теста: помощник, зависший ДО имени
                    // песочницы, иначе держал бы сьют до таймаута vitest, и диагноз «он не
                    // назвался» подменялся бы безымянным «тест просрочен».
                    const timer = setTimeout(
                        () => reject(new Error(`Помощник не назвал песочницу за 30 с:\n${out}`)),
                        30_000,
                    );
                    let out = '';
                    const done = (fn: () => void) => {
                        clearTimeout(timer);
                        fn();
                    };
                    helper.stdout.on('data', (chunk: Buffer) => {
                        out += chunk.toString();
                        const m = /^SANDBOX (.+)$/m.exec(out);
                        if (m) done(() => resolve(m[1]));
                    });
                    helper.on('error', (e) => done(() => reject(e)));
                    helper.on('exit', () =>
                        done(() => reject(new Error(`Помощник умер раньше времени:\n${out}`))),
                    );
                });
            } catch (e) {
                stopHelper();
                throw e;
            }
            try {
                // Ждём не «появился хоть один процесс», а именно ЗАВИСШЕГО состояния: файл с
                // промптом пишет шим кодера перед тем, как не вернуться. Разница решающая, и
                // она стоила ложно-зелёного барьера (проверено мутацией): раннер, убитый сразу
                // после спавна, умирает САМ — его лог упирается в закрытую трубу владельца и
                // приносит EPIPE, — и проверка проходила даже со снятой защитой. Зависший
                // раннер в этот момент не пишет ничего, поэтому уносит его только защита.
                const started = path.join(root, 'coder-prompt.txt');
                const alive = Date.now() + 30_000;
                while (Date.now() < alive && !fs.existsSync(started)) {
                    await new Promise((r) => setTimeout(r, 100));
                }
                expect(fs.existsSync(started), 'Кодер-сессия в помощнике так и не началась').toBe(
                    true,
                );
                expect(
                    sandboxPids(root).length,
                    'Прогон в помощнике так и не поднялся',
                ).toBeGreaterThan(0);

                stopHelper();
                const gone = Date.now() + 20_000;
                while (Date.now() < gone && sandboxPids(root).length > 0) {
                    await new Promise((r) => setTimeout(r, 100));
                }
                const survivors = sandboxPids(root);
                expect(
                    survivors,
                    `Смерть владельца оставила процессы песочницы живыми (${survivors.join(', ')}): ` +
                        'они переживут и удаление каталога, а раннер следующего прогона примет ' +
                        'монитор за свой. Прибери их сам — барьер не шлёт сигналов по найденным ' +
                        'номерам НИГДЕ, в том числе на этом пути: номер освобождается между ' +
                        'проверкой и сигналом и достаётся постороннему, и тогда тест, жалующийся ' +
                        'на чужие процессы, сам убивал бы чужой (ревью Codex, 6-й проход).',
                ).toEqual([]);
            } finally {
                stopHelper();
                fs.rmSync(root, { recursive: true, force: true });
            }
        },
        60_000,
    );
});

describe('обвязка не стартует, если владелец уже мёртв', () => {
    // Обвязку берём БОЕВУЮ и подменяем в ней только номер владельца: воспроизвести настоящую
    // гонку «умер между форком и prctl» нечем, а сверка `$PPID` отвечает на неё ровно так же.
    // Повторять здесь форму `unshare` руками нельзя: на хосте, которому нужен
    // `--map-root-user`, дубль первой формы краснел бы при исправной обвязке.
    const launch = (ownerPid: number) => {
        return spawnSync(
            'setpriv',
            [...sandboxLauncher(ownerPid), 'sh', '-c', 'echo ПРОГОН-ПОДНЯЛСЯ'],
            { encoding: 'utf-8' },
        );
    };

    it('чужой номер владельца — отказ кодом 97 и ни одного поднятого процесса', () => {
        // Ноль, а не единица: PID 1 бывает настоящим родителем — внутри PID namespace им
        // оказывается сам процесс сьюта, и проба ложно краснела бы. Нулевого номера у
        // процесса нет никогда, поэтому отказ здесь означает именно «родитель не тот».
        const res = launch(0);
        expect(res.status).toBe(OWNER_GONE_CODE);
        expect(res.stdout).not.toContain('ПРОГОН-ПОДНЯЛСЯ');
    });

    it('свой номер владельца — обвязка стартует', () => {
        // Обратная проба: без неё «отказ» выше был бы верен и для сломанной обвязки,
        // которая не стартует вообще никогда.
        const res = launch(process.pid);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('ПРОГОН-ПОДНЯЛСЯ');
    });

    it('сигнал ставится ДО сверки, а сверка — до запуска раннера', () => {
        // Порядок и есть весь смысл: сверка перед `--pdeathsig` оставила бы окно открытым,
        // а после `exec unshare` — не выполнилась бы вовсе. Проверяем по самой команде,
        // потому что поведением этот порядок различить нечем.
        const args = sandboxLauncher();
        expect(args.indexOf('--pdeathsig')).toBeLessThan(args.indexOf(OWNER_CHECK));
        expect(OWNER_CHECK.indexOf('$PPID')).toBeLessThan(OWNER_CHECK.indexOf('exec "$@"'));
    });
});

describe('выключение предохранителя ограничено дочерним процессом', () => {
    it('в самом сьюте предохранитель остаётся включённым', () => {
        // Прогон уже состоялся выше в этом же файле; если бы песочница правила окружение
        // сьюта, а не собирала своё, здесь было бы false — и все остальные тесты канона
        // молча ушли бы в настоящие git/gh/сеть.
        expect(NO_SIDE_EFFECTS).toBe(true);
        expect(process.env.RALPH_NO_SIDE_EFFECTS).toBe('1');
    });

    it('env песочницы собирается с нуля и предохранителя в нём нет', () => {
        // Структурная проверка по исходному тексту: подтвердить отсутствие переменной у
        // ребёнка поведением нечем — прогон с предохранителем просто упал бы, а нам нужно
        // знать, что его сняли ИМЕННО так, а не `delete process.env.…` в общем окружении.
        const src = fs.readFileSync(path.join(import.meta.dirname, 'live-sandbox.ts'), 'utf-8');
        const code = stripComments(src, { dropTrailing: true });
        expect(
            code.includes('RALPH_NO_SIDE_EFFECTS'),
            'Песочница упоминает предохранитель в КОДЕ — значит снимает его правкой ' +
                'окружения, а не сборкой env ребёнку, и послабление утечёт в остальной сьют',
        ).toBe(false);
    });
});

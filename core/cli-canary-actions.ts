// Исход канарейки CLI (#265): публикация не меняет дерево петли и не повторяется по ключу
// «харнесс@версия:итог». Отказ публикации остаётся строкой лога: канарейка не решает работу петли.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { checkCommitMessage } from '../commit-msg.mts';
import { denyNamePattern, traceFindings, type TTraceFinding } from '../shared/project-traces.ts';
import { errorText, gitNetworkOpts, redactSecrets } from '../shared/ralph-util.ts';
import { guardSideEffect as sideEffect } from '../shared/side-effect-guard.ts';
import type { NewPullRequest, PullRequest } from '../adapters/adapters.ts';
import { stripGitContext } from './consumer-tree.ts';
import type { CliCanaryOutcome, CliCanaryReport } from './cli-canary.ts';
import type { RalphState } from './state-lock.ts';

/* v8 ignore next 2 */
const guardSideEffect = (what: string) =>
    sideEffect(what, 'Подмени файловые коллабораторы исходов канарейки в тесте.');

type GitOpts = { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
type RunArgvFn = (file: string, args: string[], opts?: GitOpts) => string;
type FindOpenIssueFn = (title: string) => { number: number } | null;
type TraceFn = (text: string, opts?: { deny?: RegExp | null }) => TTraceFinding[];

export type CliCanaryActionsInput = {
    outcomes: readonly CliCanaryOutcome[];
    state: RalphState;
    consumerRoot: string;
    canaryRoot: string;
    saveStateFn: (state: RalphState) => void;
    logFn: (line: string) => void;
    createIssueFn: (input: {
        title: string;
        body: string;
        labels: readonly string[];
        milestone?: string;
    }) => number | null;
    createPullRequestFn: (input: NewPullRequest) => number | null;
    findOpenIssueFn: FindOpenIssueFn;
    findOpenPullRequestFn: (branch: string) => PullRequest | null;
    backlogAddressFn: () => string | undefined;
    labels: readonly string[];
    runArgvFn: RunArgvFn;
    descriptorPathFn: (harness: string) => string;
    standFixturePathFn: (harness: string, version: string) => string;
    mkdtempFn?: (prefix: string) => string;
    readFileFn?: (file: string) => string;
    writeFileFn?: (file: string, text: string) => void;
    removeDirFn?: (dir: string) => void;
    checkCommitMessageFn?: typeof checkCommitMessage;
    traceFindingsFn?: TraceFn;
    env?: NodeJS.ProcessEnv;
};

type DiffEntries = { added: string[]; removed: string[]; changed: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const shown = (value: unknown): string => {
    const text = value === undefined ? 'undefined' : JSON.stringify(value);
    return text.length <= 800 ? text : `${text.slice(0, 800)}…`;
};
const identity = (value: unknown): string | null => {
    if (!isRecord(value)) return null;
    for (const key of ['id', 'name']) {
        if (typeof value[key] === 'string' && value[key] !== '') return `${key}:${value[key]}`;
    }
    return null;
};

function canonicalJson(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

function diffAnonymous(
    before: readonly unknown[],
    after: readonly unknown[],
    at: string,
    out: DiffEntries,
): void {
    const remaining = after.map(canonicalJson);
    for (const value of before.map(canonicalJson)) {
        const index = remaining.indexOf(value);
        if (index < 0) out.removed.push(`- \`${at}\`: ${value}`);
        else remaining.splice(index, 1);
    }
    for (const value of remaining) out.added.push(`- \`${at}\`: ${value}`);
}

function walkInventory(before: unknown, after: unknown, at: string, out: DiffEntries): void {
    if (isDeepStrictEqual(before, after)) return;
    if (isRecord(before) && isRecord(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) {
            const nextAt = `${at}.${key}`;
            if (!(key in before)) out.added.push(`- \`${nextAt}\`: ${shown(after[key])}`);
            else if (!(key in after)) out.removed.push(`- \`${nextAt}\`: ${shown(before[key])}`);
            else walkInventory(before[key], after[key], nextAt, out);
        }
        return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        const beforeIds = before.map(identity);
        const afterIds = after.map(identity);
        if (beforeIds.some((id) => id !== null) || afterIds.some((id) => id !== null)) {
            const beforeById = new Map(
                before.flatMap((value, index) =>
                    beforeIds[index] === null ? [] : [[beforeIds[index], value] as const],
                ),
            );
            const afterById = new Map(
                after.flatMap((value, index) =>
                    afterIds[index] === null ? [] : [[afterIds[index], value] as const],
                ),
            );
            for (const [id, value] of beforeById) {
                if (!afterById.has(id)) out.removed.push(`- \`${at}.${id}\`: ${shown(value)}`);
            }
            for (const [id, value] of afterById) {
                if (!beforeById.has(id)) out.added.push(`- \`${at}.${id}\`: ${shown(value)}`);
                else walkInventory(beforeById.get(id), value, `${at}.${id}`, out);
            }
            diffAnonymous(
                before.filter((_, index) => beforeIds[index] === null),
                after.filter((_, index) => afterIds[index] === null),
                at,
                out,
            );
            return;
        }
        diffAnonymous(before, after, at, out);
        return;
    }
    out.changed.push(`- \`${at}\`: было ${shown(before)}, стало ${shown(after)}`);
}

export function inventoryDiff(before: unknown, after: unknown): string {
    const out: DiffEntries = { added: [], removed: [], changed: [] };
    walkInventory(before, after, 'inventory', out);
    const sections: [string, string[]][] = [
        ['Добавлено', out.added],
        ['Убрано', out.removed],
        ['Изменено', out.changed],
    ];
    return sections
        .filter(([, lines]) => lines.length > 0)
        .map(([heading, lines]) => `### ${heading}\n${lines.join('\n')}`)
        .join('\n\n');
}

function issueFor(outcome: CliCanaryOutcome, diffFn: typeof inventoryDiff) {
    const key = `${outcome.harness}@${outcome.latestVersion}`;
    if (outcome.verdict === 'drift') {
        const reports = outcome.reports;
        if (!reports) throw new Error(`у drift ${key} нет отчётов для диффа инвентаря`);
        return {
            title: `Канарейка CLI ${key}: дрейф инвентаря`,
            body: [
                `Харнесс: \`${outcome.harness}\``,
                `Версия: \`${outcome.latestVersion}\` (закреплена \`${outcome.pinnedVersion}\`)`,
                'Зелёные пробы не совпали по инвентарю. Описание пакета автоматически не меняется.',
                diffFn(reports.pinned.inventory, reports.candidate.inventory),
            ].join('\n\n'),
        };
    }
    if (outcome.verdict === 'red') {
        const probes = (outcome.failedProbes ?? [])
            .map(
                (probe) =>
                    `### ${probe.name} — ${probe.verdict || 'пустой вердикт'}\n\nВывод:\n\n${probe.detail}`,
            )
            .join('\n\n');
        return {
            title: `Канарейка CLI ${key}: красная проба`,
            body: [
                `Харнесс: \`${outcome.harness}\``,
                `Версия: \`${outcome.latestVersion}\` (закреплена \`${outcome.pinnedVersion}\`)`,
                outcome.reason ? `Итог: ${outcome.reason}` : '',
                probes || `Вывод: ${outcome.reason ?? 'не назван'}`,
            ]
                .filter((part) => part !== '')
                .join('\n\n'),
        };
    }
    throw new Error(`карточка для итога ${outcome.verdict} не предусмотрена`);
}

const SECRET_NAME =
    /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|TOKEN|SECRET(?:_KEY)?|PRIVATE_KEY|PASSWORD|CREDENTIALS)$/i;

function publicText(
    text: string,
    env: NodeJS.ProcessEnv,
    paths: readonly (readonly [string, string])[] = [],
): string {
    const secrets = Object.entries(env)
        .filter(
            ([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length >= 4,
        )
        .map(([, value]) => value);
    let out = redactSecrets(text, secrets);
    for (const [from, to] of [...paths].sort((a, b) => b[0].length - a[0].length)) {
        if (from !== '') out = out.replaceAll(from, to);
    }
    return out.replace(/\/(?:root|home|tmp)\/[A-Za-z0-9._/-]+/g, '/path/to/host');
}

const GIT_ENV_ALLOWLIST = new Set([
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'SSH_AUTH_SOCK',
    'GIT_SSH_COMMAND',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'SOURCECRAFT_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'GIT_TERMINAL_PROMPT',
    'GIT_HTTP_LOW_SPEED_LIMIT',
    'GIT_HTTP_LOW_SPEED_TIME',
]);

function isolatedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const clean = stripGitContext(env);
    return Object.fromEntries([
        ...Object.entries(clean).filter(
            ([name, value]) => GIT_ENV_ALLOWLIST.has(name) && value !== undefined,
        ),
        ['GIT_CONFIG_GLOBAL', clean.GIT_CONFIG_GLOBAL ?? '/dev/null'],
        ['GIT_CONFIG_SYSTEM', '/dev/null'],
    ]);
}

function gitArgv(cwd: string, args: readonly string[]): string[] {
    return ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args];
}

function assertPublicText(
    text: string,
    what: string,
    env: NodeJS.ProcessEnv,
    traceFindingsFn: TraceFn,
): void {
    const findings = traceFindingsFn(text, { deny: denyNamePattern(env) });
    if (findings.length > 0) {
        throw new Error(
            `${what} содержит проектный след: ${findings.map((f) => `строка ${f.line}`).join(', ')}`,
        );
    }
}

export function versionedStandFixture({
    harness,
    version,
    report,
}: {
    harness: string;
    version: string;
    report: CliCanaryReport;
}): Record<string, unknown> {
    if (report.protocol !== 1 || report.harness !== harness || report.version !== version) {
        throw new Error('снимок канарейки не совпадает с публикуемым харнессом и версией');
    }
    return { ...report, cliVersion: version, assembled: false };
}

function validVersion(version: string): boolean {
    return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version);
}

export function handleCliCanaryOutcomes(input: CliCanaryActionsInput): void {
    const {
        outcomes,
        state,
        consumerRoot,
        canaryRoot,
        saveStateFn,
        logFn,
        createIssueFn,
        createPullRequestFn,
        findOpenIssueFn,
        findOpenPullRequestFn,
        backlogAddressFn,
        labels,
        runArgvFn,
        descriptorPathFn,
        standFixturePathFn,
        checkCommitMessageFn = checkCommitMessage,
        traceFindingsFn = traceFindings,
        env = process.env,
    } = input;
    // Файловые дефолты — боевые побочки; юнит-тесты получают их явными параметрами.
    /* v8 ignore start */
    const mkdtempFn =
        input.mkdtempFn ??
        ((prefix) => {
            guardSideEffect(`mkdtemp(${prefix})`);
            mkdirSync(path.dirname(prefix), { recursive: true });
            return mkdtempSync(prefix);
        });
    const readFileFn = input.readFileFn ?? ((file) => readFileSync(file, 'utf8'));
    const writeFileFn =
        input.writeFileFn ??
        ((file, text) => {
            guardSideEffect(`writeFile(${file})`);
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, text);
        });
    const removeDirFn =
        input.removeDirFn ??
        ((dir) => {
            guardSideEffect(`rmDir(${dir})`);
            rmSync(dir, { recursive: true, force: true });
        });
    /* v8 ignore stop */
    const markHandled = (key: string) => {
        state.cliCanaryHandledOutcomes ??= {};
        state.cliCanaryHandledOutcomes[key] = true;
        saveStateFn(state);
    };
    const gitEnv = isolatedGitEnv(env);
    const git = (cwd: string, args: string[], opts?: GitOpts) => {
        const options = { ...opts, env: { ...gitEnv, ...opts?.env } };
        const withPolicy = ['fetch', 'push', 'ls-remote'].includes(args[0])
            ? { ...options, ...gitNetworkOpts(options.env, options.timeoutMs) }
            : options;
        return runArgvFn('git', gitArgv(cwd, args), withPolicy);
    };

    for (const outcome of outcomes) {
        if (!['green', 'drift', 'red'].includes(outcome.verdict)) continue;
        const key = `${outcome.harness}@${outcome.latestVersion}:${outcome.verdict}`;
        if (state.cliCanaryHandledOutcomes?.[key] === true) continue;
        try {
            if (!/^[a-z0-9-]+$/.test(outcome.harness) || !validVersion(outcome.latestVersion)) {
                throw new Error(`небезопасное имя харнесса или версии: ${key}`);
            }
            if (outcome.verdict === 'drift' || outcome.verdict === 'red') {
                const rawIssue = issueFor(outcome, inventoryDiff);
                const issue = {
                    title: publicText(rawIssue.title, env),
                    body: publicText(rawIssue.body, env, [
                        [consumerRoot, '/path/to/app'],
                        [canaryRoot, '/path/to/canary'],
                    ]),
                };
                assertPublicText(issue.title, 'Заголовок карточки канарейки', env, traceFindingsFn);
                assertPublicText(issue.body, 'Тело карточки канарейки', env, traceFindingsFn);
                const existing = findOpenIssueFn(issue.title);
                if (existing !== null) {
                    logFn(`🗂 Карточка #${existing.number} уже опубликована: ${issue.title}`);
                    markHandled(key);
                    continue;
                }
                const milestone = backlogAddressFn();
                const number = createIssueFn({
                    ...issue,
                    labels,
                    ...(milestone === undefined ? {} : { milestone }),
                });
                logFn(
                    `🗂 Заведена карточка ${number === null ? '(номер не отдан форжем)' : `#${number}`}: ${issue.title}`,
                );
                markHandled(key);
                continue;
            }

            const branch = `cli/${outcome.harness}-${outcome.latestVersion}`;
            if (findOpenPullRequestFn(branch) !== null) {
                logFn(`🧪 Канарейка CLI ${outcome.harness}: PR ветки ${branch} уже существует`);
                markHandled(key);
                continue;
            }
            const branchPushed =
                git(
                    consumerRoot,
                    ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
                    gitNetworkOpts(gitEnv),
                ) !== '';
            const reports = outcome.reports;
            if (!reports) throw new Error(`у green ${key} нет снимка стенда`);
            const message = `chore(adapters): закрепи ${outcome.harness}@${outcome.latestVersion}\n`;
            const checked = checkCommitMessageFn(message, env);
            if (!checked.ok) throw new Error(checked.reason);
            const pr: NewPullRequest = {
                branch,
                title: `CLI ${outcome.harness}@${outcome.latestVersion}: зелёная канарейка`,
                body: [
                    '## Итог канарейки',
                    `Версия \`${outcome.harness}@${outcome.latestVersion}\`: green, инвентарь совпал с \`${outcome.pinnedVersion}\`.`,
                    'Меняются только `cliVersion` описания пакета и снимок стенда. Пути защищаемые: мердж требует ship человека.',
                ].join('\n\n'),
            };
            assertPublicText(pr.title, 'Заголовок PR канарейки', env, traceFindingsFn);
            assertPublicText(pr.body, 'Описание PR канарейки', env, traceFindingsFn);

            if (!branchPushed) {
                const temporary = mkdtempFn(path.join(canaryRoot, 'version-pr-'));
                const worktree = path.join(temporary, 'tree');
                try {
                    git(
                        consumerRoot,
                        ['fetch', '--no-recurse-submodules', 'origin', 'main'],
                        gitNetworkOpts(gitEnv),
                    );
                    git(consumerRoot, ['worktree', 'add', '--detach', worktree, 'origin/main']);
                    const descriptorPath = descriptorPathFn(outcome.harness);
                    const newFixturePath = standFixturePathFn(
                        outcome.harness,
                        outcome.latestVersion,
                    );
                    const descriptorFile = path.join(worktree, descriptorPath);
                    const descriptor = readFileFn(descriptorFile);
                    const versionPattern = new RegExp(
                        `("cliVersion"\\s*:\\s*")${outcome.pinnedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(")`,
                    );
                    if (!versionPattern.test(descriptor)) {
                        throw new Error(
                            `${descriptorPath} не содержит закреплённую ${outcome.pinnedVersion}`,
                        );
                    }
                    const updatedDescriptor = descriptor.replace(
                        versionPattern,
                        `$1${outcome.latestVersion}$2`,
                    );
                    assertPublicText(
                        updatedDescriptor,
                        `Descriptor ${descriptorPath}`,
                        env,
                        traceFindingsFn,
                    );
                    const fixture = versionedStandFixture({
                        harness: outcome.harness,
                        version: outcome.latestVersion,
                        report: reports.candidate,
                    });
                    const fixtureText = publicText(`${JSON.stringify(fixture, null, 2)}\n`, env, [
                        [worktree, '/path/to/worktree'],
                        [consumerRoot, '/path/to/app'],
                        [canaryRoot, '/path/to/canary'],
                    ]);
                    assertPublicText(
                        fixtureText,
                        `Fixture ${newFixturePath}`,
                        env,
                        traceFindingsFn,
                    );
                    writeFileFn(descriptorFile, updatedDescriptor);
                    writeFileFn(path.join(worktree, newFixturePath), fixtureText);
                    const changedPaths = [descriptorPath, newFixturePath];
                    git(worktree, ['add', '--', ...changedPaths]);
                    const changed = git(worktree, ['diff', '--cached', '--name-only'])
                        .split('\n')
                        .filter((file) => file !== '')
                        .sort();
                    const expected = [...changedPaths].sort();
                    if (!isDeepStrictEqual(changed, expected)) {
                        throw new Error(`PR версии содержит лишние файлы: ${changed.join(', ')}`);
                    }
                    git(worktree, ['commit', '-F', '-'], { input: message });
                    git(worktree, ['push', 'origin', `HEAD:refs/heads/${branch}`], {
                        ...gitNetworkOpts(gitEnv),
                    });
                } finally {
                    try {
                        git(consumerRoot, ['worktree', 'remove', worktree]);
                        removeDirFn(temporary);
                    } catch (error) {
                        logFn(
                            `⚠ Временное дерево канарейки ${worktree} не убрано: ${errorText(error)}`,
                        );
                    }
                }
            }
            const number = createPullRequestFn(pr);
            logFn(
                `🧪 Канарейка CLI ${outcome.harness}: открыт PR ${number === null ? '(номер не отдан форжем)' : `#${number}`} ветки ${branch}`,
            );
            markHandled(key);
        } catch (error) {
            logFn(`⚠ Исход канарейки ${key} не опубликован: ${errorText(error)}`);
        }
    }
}

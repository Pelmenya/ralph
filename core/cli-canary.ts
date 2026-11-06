// Ежедневная стадия канарейки CLI (#264): срок в state, новая версия только в своём каталоге,
// вердикт по полному перечню проб. Сбой проверки не останавливает работу петли.
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
    CliCanaryInfrastructureError,
    fetchLatestCliVersion,
    runStandReport,
} from '../adapters/cli-canary.ts';
import { installCliCopy } from '../adapters/cli-install.ts';
import { HARNESS_REGISTRY, type HarnessRegistry } from '../adapters/harness-registry.ts';
import type { HarnessDistribution } from '../adapters/harness-package.ts';
import { reportProbeNames } from '../provision/stand/report.mts';
import { pruneCanaryCopies, sweepCanaryTrash } from './cli-copies.ts';
import { compareSemver } from './semver.ts';
import type { CliCanaryStoredOutcome, CliCanaryVerdict, RalphState } from './state-lock.ts';

export const CLI_CANARY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CLI_CANARY_BUDGET_MS = 30 * 60 * 1000;

export type CliCanaryProbe = { name: string; verdict: string; detail: string };
export type CliCanaryReport = {
    protocol: 1;
    harness: string;
    version: string;
    inventory: unknown;
    probes: CliCanaryProbe[];
};

export type CliCanaryOutcome = Omit<CliCanaryStoredOutcome, 'reports'> & {
    reports?: { pinned: CliCanaryReport; candidate: CliCanaryReport };
};

export type CliCanaryRun = { ran: boolean; outcomes: CliCanaryOutcome[] };

type LatestFn = (input: { distribution: HarnessDistribution; timeoutMs: number }) => string;
type InstallFn = (input: {
    harness: string;
    version: string;
    distribution: HarnessDistribution;
    root: string;
    timeoutMs: number;
}) => ReturnType<typeof installCliCopy>;
type ReportFn = (input: {
    harness: string;
    version: string;
    cliBin: string;
    timeoutMs: number;
}) => unknown;

class BudgetExceeded extends Error {
    constructor() {
        super('превышен бюджет времени канарейки');
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function expectedProbes(harness: string): string[] {
    return reportProbeNames(harness);
}

function parseReport(raw: unknown, harness: string, version: string): CliCanaryReport {
    if (
        !isRecord(raw) ||
        raw.protocol !== 1 ||
        raw.harness !== harness ||
        raw.version !== version ||
        (!isRecord(raw.inventory) && !Array.isArray(raw.inventory)) ||
        !Array.isArray(raw.probes)
    ) {
        throw new Error(`отчёт стенда ${harness}@${version} не соответствует протоколу 1`);
    }
    const probes = raw.probes.map((probe) => {
        if (
            !isRecord(probe) ||
            typeof probe.name !== 'string' ||
            probe.name === '' ||
            typeof probe.verdict !== 'string' ||
            typeof probe.detail !== 'string'
        ) {
            throw new Error(`отчёт стенда ${harness}@${version} содержит битую пробу`);
        }
        return { name: probe.name, verdict: probe.verdict, detail: probe.detail };
    });
    const expected = expectedProbes(harness);
    const names = probes.map((probe) => probe.name);
    if (
        names.length !== expected.length ||
        new Set(names).size !== names.length ||
        expected.some((name) => !names.includes(name))
    ) {
        throw new Error(
            `отчёт стенда ${harness}@${version} содержит неполную или неизвестную матрицу проб`,
        );
    }
    return { protocol: 1, harness, version, inventory: raw.inventory, probes };
}

const UNORDERED_INVENTORY_ARRAYS = new Set([
    'tools',
    'additionalTools',
    'properties',
    'required',
    'fields',
    'codeModeNested',
]);

export function canonicalInventory(
    value: unknown,
    path: readonly string[] = [],
    reportEntryAncestor = false,
): unknown {
    const inReportEntry = reportEntryAncestor || (path.length === 0 && isRecord(value));
    if (Array.isArray(value)) {
        const items = value.map((item) => canonicalInventory(item, path, inReportEntry));
        const key = path.at(-1) ?? '';
        if (UNORDERED_INVENTORY_ARRAYS.has(key)) {
            return items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
        return items;
    }
    if (!isRecord(value)) return value;
    const reportEntry = path.length === 0 && inReportEntry;
    const reportEnvelope = inReportEntry && path.length === 1 && path[0] === 'envelope';
    return Object.fromEntries(
        Object.entries(value)
            .filter(
                ([name]) =>
                    !(reportEntry && (name === 'cliVersion' || name === 'model')) &&
                    !(reportEnvelope && name === 'events'),
            )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, item]) => [
                name,
                canonicalInventory(item, [...path, name], inReportEntry),
            ]),
    );
}

function failedProbes(report: CliCanaryReport): CliCanaryProbe[] {
    return report.probes.filter((probe) => probe.verdict !== 'PASS');
}

function probeText(probes: readonly CliCanaryProbe[]): string {
    return probes.map((probe) => `${probe.name}=${probe.verdict || 'пустой'}`).join(', ');
}

function outcomeKey(outcome: CliCanaryStoredOutcome): string {
    return `${outcome.harness}@${outcome.latestVersion}:${outcome.verdict}`;
}

function pendingOutcomes(state: RalphState): CliCanaryOutcome[] {
    return Object.values(state.cliCanaryOutcomes ?? {}).filter(
        (outcome): outcome is CliCanaryOutcome =>
            ['green', 'drift', 'red'].includes(outcome.verdict) &&
            state.cliCanaryHandledOutcomes?.[outcomeKey(outcome)] !== true,
    );
}

function versionRefusalReason(comparison: -1 | 0 | null): string {
    if (comparison === null) return 'версия не по SemVer';
    if (comparison < 0) return 'в реестре версия старше закреплённой';
    return 'версия не новее закреплённой';
}

function discardStaleGreenOutcomes(state: RalphState, registry: HarnessRegistry): boolean {
    const outcomes = state.cliCanaryOutcomes ?? {};
    let changed = false;
    for (const [key, outcome] of Object.entries(outcomes)) {
        if (
            outcome.verdict !== 'green' ||
            state.cliCanaryHandledOutcomes?.[outcomeKey(outcome)] === true
        ) {
            continue;
        }
        const pinnedVersion = registry.packages.get(outcome.harness)?.descriptor.cliVersion;
        const comparison =
            pinnedVersion === undefined
                ? null
                : compareSemver(outcome.latestVersion, pinnedVersion);
        if (comparison === 1) continue;
        outcomes[key] = {
            ...outcome,
            verdict: 'unchecked',
            reason:
                pinnedVersion === undefined
                    ? 'пакет харнесса не принят в реестре'
                    : versionRefusalReason(comparison),
        };
        changed = true;
    }
    return changed;
}

export function mergeCanaryOutcomes(
    pending: Readonly<Record<string, CliCanaryStoredOutcome>>,
    formed: Readonly<Record<string, CliCanaryStoredOutcome>>,
): Record<string, CliCanaryStoredOutcome> {
    const merged = { ...pending };
    for (const [key, outcome] of Object.entries(formed)) {
        const previous = merged[key];
        if (!previous) {
            merged[key] = outcome;
            continue;
        }
        if (previous.verdict === 'green' && outcome.verdict === 'fresh') {
            delete merged[key];
            continue;
        }
        if (outcome.verdict === 'unchecked' || outcome.verdict === 'fresh') continue;
        merged[key] = outcome;
    }
    return merged;
}

export function runCliCanary({
    state,
    canaryRoot,
    pinnedBins,
    registry = HARNESS_REGISTRY,
    saveStateFn,
    logFn,
    nowFn = () => Date.now(),
    latestVersionFn = fetchLatestCliVersion,
    installFn = installCliCopy,
    // Внешний запуск покрыт адаптером стенда; юнит-тесты получают reportFn явно.
    /* v8 ignore start */
    reportFn = (input) =>
        runStandReport({ ...input, coreRoot: path.resolve(import.meta.dirname, '..') }),
    /* v8 ignore stop */
    budgetMs = CLI_CANARY_BUDGET_MS,
    handleOutcomesFn = () => {},
    sweepCanaryTrashFn = sweepCanaryTrash,
    pruneCanaryCopiesFn = pruneCanaryCopies,
}: {
    state: RalphState;
    canaryRoot: string;
    pinnedBins: ReadonlyMap<string, string>;
    registry?: HarnessRegistry;
    saveStateFn: (state: RalphState) => void;
    logFn: (line: string) => void;
    nowFn?: () => number;
    latestVersionFn?: LatestFn;
    installFn?: InstallFn;
    reportFn?: ReportFn;
    budgetMs?: number;
    handleOutcomesFn?: (outcomes: readonly CliCanaryOutcome[]) => void;
    sweepCanaryTrashFn?: typeof sweepCanaryTrash;
    pruneCanaryCopiesFn?: typeof pruneCanaryCopies;
}): CliCanaryRun {
    const pruneCopies = () => {
        for (const [harness, loaded] of registry.packages) {
            const keep = new Set([loaded.descriptor.cliVersion]);
            for (const outcome of Object.values(state.cliCanaryOutcomes ?? {})) {
                const key = `${outcome.harness}@${outcome.latestVersion}:${outcome.verdict}`;
                if (
                    outcome.harness === harness &&
                    ['green', 'drift', 'red'].includes(outcome.verdict) &&
                    state.cliCanaryHandledOutcomes?.[key] !== true
                ) {
                    keep.add(outcome.latestVersion);
                }
            }
            pruneCanaryCopiesFn({ root: canaryRoot, harness, keep, logFn, nowFn });
        }
    };
    sweepCanaryTrashFn({ root: canaryRoot, logFn });
    const startedAt = nowFn();
    const previous = state.cliCanaryLastRunAt;
    if (discardStaleGreenOutcomes(state, registry)) saveStateFn(state);
    const savedPending = pendingOutcomes(state);
    if (previous !== undefined && startedAt - previous < CLI_CANARY_INTERVAL_MS) {
        if (savedPending.length > 0) handleOutcomesFn(savedPending);
        pruneCopies();
        return { ran: false, outcomes: savedPending };
    }
    if (savedPending.length > 0) handleOutcomesFn(savedPending);
    const pendingAfterResume = Object.fromEntries(
        pendingOutcomes(state).map((outcome) => [
            `${outcome.harness}@${outcome.latestVersion || 'unknown'}`,
            outcome,
        ]),
    );
    state.cliCanaryLastRunAt = startedAt;
    saveStateFn(state);

    const remaining = () => {
        const left = budgetMs - (nowFn() - startedAt);
        if (left <= 0) throw new BudgetExceeded();
        return left;
    };
    const outcomes: CliCanaryOutcome[] = [];
    let exhausted = false;

    for (const [harness, loaded] of registry.packages) {
        const pinnedVersion = loaded.descriptor.cliVersion;
        let latestVersion = '';
        const finish = (
            verdict: CliCanaryVerdict,
            extra: Partial<CliCanaryOutcome> = {},
        ): CliCanaryOutcome => ({
            harness,
            pinnedVersion,
            latestVersion,
            verdict,
            ...extra,
        });
        if (exhausted) {
            outcomes.push(finish('unchecked', { reason: 'превышен бюджет времени канарейки' }));
            continue;
        }
        try {
            latestVersion = latestVersionFn({
                distribution: loaded.pkg.distribution,
                timeoutMs: remaining(),
            });
            remaining();
            const comparison = compareSemver(latestVersion, pinnedVersion);
            if (comparison === 0) {
                outcomes.push(finish('fresh'));
                continue;
            }
            if (comparison !== 1) {
                outcomes.push(finish('unchecked', { reason: versionRefusalReason(comparison) }));
                continue;
            }
            const pinnedOverride = pinnedBins.get(harness);
            const baseline = pinnedOverride
                ? { ok: true as const, bin: pinnedOverride }
                : installFn({
                      harness,
                      version: pinnedVersion,
                      distribution: loaded.pkg.distribution,
                      root: canaryRoot,
                      timeoutMs: remaining(),
                  });
            remaining();
            if (!baseline.ok) {
                outcomes.push(finish('unchecked', { reason: baseline.reason }));
                continue;
            }
            const installed = installFn({
                harness,
                version: latestVersion,
                distribution: loaded.pkg.distribution,
                root: canaryRoot,
                timeoutMs: remaining(),
            });
            remaining();
            if (!installed.ok) {
                outcomes.push(finish('unchecked', { reason: installed.reason }));
                continue;
            }
            const pinned = parseReport(
                reportFn({
                    harness,
                    version: pinnedVersion,
                    cliBin: baseline.bin,
                    timeoutMs: remaining(),
                }),
                harness,
                pinnedVersion,
            );
            remaining();
            const candidate = parseReport(
                reportFn({
                    harness,
                    version: latestVersion,
                    cliBin: installed.bin,
                    timeoutMs: remaining(),
                }),
                harness,
                latestVersion,
            );
            remaining();
            const baselineFailures = failedProbes(pinned);
            if (baselineFailures.length > 0) {
                outcomes.push(
                    finish('unchecked', {
                        reason: `закреплённая версия не дала зелёный эталон: ${probeText(baselineFailures)}`,
                        reports: { pinned, candidate },
                    }),
                );
                continue;
            }
            const failures = failedProbes(candidate);
            if (failures.length > 0) {
                outcomes.push(
                    finish('red', {
                        failedProbes: failures,
                        reason: probeText(failures),
                        reports: { pinned, candidate },
                    }),
                );
            } else {
                outcomes.push(
                    finish(
                        isDeepStrictEqual(
                            canonicalInventory(pinned.inventory),
                            canonicalInventory(candidate.inventory),
                        )
                            ? 'green'
                            : 'drift',
                        {
                            reports: { pinned, candidate },
                        },
                    ),
                );
            }
        } catch (error) {
            const reason =
                error instanceof CliCanaryInfrastructureError
                    ? `инфраструктура (${error.kind}): ${message(error)}`
                    : message(error);
            if (error instanceof BudgetExceeded) exhausted = true;
            outcomes.push(finish('unchecked', { reason }));
        }
    }
    for (const outcome of outcomes) {
        if (outcome.verdict === 'unchecked') {
            logFn(
                `🧪 Канарейка CLI ${outcome.harness}: не проверено — ${outcome.reason ?? 'причина не названа'}`,
            );
        }
    }
    const formed = Object.fromEntries(
        outcomes.map((outcome) => [
            `${outcome.harness}@${outcome.latestVersion || 'unknown'}`,
            outcome,
        ]),
    );
    state.cliCanaryOutcomes = mergeCanaryOutcomes(pendingAfterResume, formed);
    saveStateFn(state);
    handleOutcomesFn(outcomes);
    pruneCopies();
    return { ran: true, outcomes };
}

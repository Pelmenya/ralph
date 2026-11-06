/**
 * Регистрация стенда собирается кодом пакета, а не второй схемой в install-stand.sh.
 * До #262 пакет с нормализатором проверялся только у Claude Code, а остальные CLI получали SKIP.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { GuardRegistration, HarnessPackage } from '../../adapters/harness-package.ts';
import type { GuardHook } from '../../adapters/harness-guard.ts';

const HARNESSES: Readonly<Record<string, string>> = {
    claude: 'claude-code',
    codex: 'codex',
    kimi: 'kimi-code',
    opencode: 'opencode',
};

function harnessOf(cli: string): string {
    const harness = HARNESSES[cli];
    if (harness === undefined) throw new Error(`stand: неизвестный CLI ${cli}`);
    return harness;
}

async function importSubject<T>(subjectRoot: string, relative: string): Promise<T> {
    return (await import(pathToFileURL(join(subjectRoot, relative)).href)) as T;
}

function put(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
}

export async function materializeGuardRegistration({
    cli,
    subjectRoot,
    ext,
    hook,
    projectDir,
}: {
    cli: string;
    subjectRoot: string;
    ext: string;
    hook: string;
    projectDir: string;
}): Promise<{ normalizer: string; registration: GuardRegistration }> {
    const harness = harnessOf(cli);
    const { harnessPackage: pkg } = await importSubject<{ harnessPackage: HarnessPackage }>(
        subjectRoot,
        join('adapters', 'harnesses', harness, 'package.ts'),
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `export CLAUDE_PROJECT_DIR=${quote(projectDir)}; node ${quote(hook)}`;
    const hooks: GuardHook[] = [{ matcher: '.*', command, timeoutSec: 10 }];
    let registration: GuardRegistration;

    if (cli === 'claude') {
        const settings = {
            disableAllHooks: false,
            hooks: {
                PreToolUse: [
                    {
                        matcher: '.*',
                        hooks: [{ type: 'command', command: hooks[0].command, timeout: 10 }],
                    },
                ],
            },
        };
        registration = pkg.guardRegistration(settings, hooks);
        put(join(ext, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    } else if (cli === 'codex') {
        const { codexGuardArgs } = await importSubject<{
            codexGuardArgs(hooks: readonly GuardHook[]): string[];
        }>(subjectRoot, join('adapters', 'harness-guard.ts'));
        registration = pkg.guardRegistration({}, hooks);
        put(join(ext, 'codex-guard-args.json'), JSON.stringify(codexGuardArgs(hooks), null, 2));
    } else if (cli === 'kimi') {
        const { kimiHooksToml } = await importSubject<{
            kimiHooksToml(hooks: readonly GuardHook[]): string;
        }>(subjectRoot, join('adapters', 'harness-guard.ts'));
        registration = pkg.guardRegistration({}, hooks);
        put(join(ext, 'kimi-event-hooks.toml'), kimiHooksToml(hooks));
    } else {
        if (pkg.plugin === null) throw new Error('stand: у OpenCode пакет не объявил плагин guard');
        registration = pkg.guardRegistration({}, hooks);
        put(join(ext, 'opencode', 'plugin', 'ralph-guard.js'), pkg.plugin.source(hooks));
    }

    if (registration.problems.length > 0 || registration.hooks.length !== 1) {
        throw new Error(
            `stand: регистрация ${cli} отвергнута пакетом: ${registration.problems.join('; ') || 'хуков не один'}`,
        );
    }
    return {
        normalizer: join(subjectRoot, 'adapters', 'harnesses', harness, 'normalize.ts'),
        registration,
    };
}

export function materializeFakeMcp({
    cli,
    ext,
    server,
    journal,
}: {
    cli: string;
    ext: string;
    server: string;
    journal: string;
}): { file: string } {
    harnessOf(cli);
    const command = process.execPath;
    if (cli === 'codex') {
        const file = join(ext, 'codex-mcp.toml');
        put(
            file,
            `mcp_servers.stand={command=${JSON.stringify(command)},args=[${JSON.stringify(server)},${JSON.stringify(journal)}]}\n`,
        );
        return { file };
    }
    if (cli === 'opencode') {
        const file = join(ext, 'opencode', 'opencode.json');
        const current = existsSync(file)
            ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
            : {};
        put(
            file,
            JSON.stringify(
                {
                    ...current,
                    mcp: {
                        'ralph-stand': {
                            type: 'local',
                            command: [command, server, journal],
                            enabled: true,
                        },
                    },
                },
                null,
                2,
            ) + '\n',
        );
        return { file };
    }
    const file = cli === 'kimi' ? join(ext, 'kimi-home', 'mcp.json') : join(ext, 'mcp.json');
    put(
        file,
        JSON.stringify(
            {
                mcpServers: {
                    'ralph-stand': {
                        type: 'stdio',
                        command,
                        args: [server, journal],
                    },
                },
            },
            null,
            2,
        ) + '\n',
    );
    return { file };
}

if (import.meta.main) {
    const [mode, cli, subjectRoot, ext, hook, projectDir, server, journal] = process.argv.slice(2);
    if (mode === 'guard' && cli && subjectRoot && ext && hook && projectDir) {
        await materializeGuardRegistration({ cli, subjectRoot, ext, hook, projectDir });
    } else if (mode === 'mcp' && cli && ext && server && journal) {
        materializeFakeMcp({ cli, ext, server, journal });
    } else {
        throw new Error(
            'запуск: registration.mts guard <cli> <subjectRoot> <ext> <hook> <projectDir> | mcp <cli> - <ext> - <server> <journal>',
        );
    }
}

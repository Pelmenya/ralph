import path from 'node:path';
import { HARNESS_REGISTRY } from '../adapters/harness-registry.ts';

/** Реестр песочницы: последняя версия равна закреплённой, установка сети не касается. */
export function registryNpmShim(): string {
    const cases = [...HARNESS_REGISTRY.packages.values()].flatMap(({ descriptor, pkg }) => {
        const { bin, package: name } = pkg.distribution;
        const dir = path.posix.dirname(bin);
        return [
            `  "view ${name} version") echo '${descriptor.cliVersion}' ;;`,
            `  "install ${name}@${descriptor.cliVersion} --ignore-scripts --prefix "*)
    for prefix do :; done
    mkdir -p "$prefix/${dir}"
    printf '#!/bin/sh\\nexit 0\\n' > "$prefix/${bin}"
    chmod +x "$prefix/${bin}" ;;`,
        ];
    });
    return `#!/bin/sh
case "$*" in
${cases.join('\n')}
  *) echo "sandbox npm: unexpected $*" >&2; exit 1 ;;
esac
`;
}

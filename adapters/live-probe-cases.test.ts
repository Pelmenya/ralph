// #219: каталог живых проб согласован со сценариями стенда — проба без `probe_<case>` в
// install-stand.sh была бы намерением, которое раннер принял и исполнить не смог.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LIVE_PROBE_CASES, LIVE_PROBE_CLI_KEY_ENV, LOOP_KEY_ENVS } from './live-probe-cases.ts';

const STAND = readFileSync(
    join(import.meta.dirname, '..', 'provision', 'install-stand.sh'),
    'utf-8',
);
const standProbes = [...STAND.matchAll(/^probe_([a-z-]+)\(\)/gm)].map((m) => m[1]);

describe('каталог живых проб', () => {
    it('стенд объявляет пробы — скану есть что сверять', () => {
        expect(standProbes.length).toBeGreaterThan(5);
    });

    it.each(Object.entries(LIVE_PROBE_CASES))('%s: каждый case — функция стенда', (_cli, cases) => {
        expect(cases.length).toBeGreaterThan(0);
        for (const c of cases) expect(standProbes).toContain(c);
    });

    it('offline в каталог не входит: она идёт вне изоляции ОС', () => {
        for (const cases of Object.values(LIVE_PROBE_CASES)) expect(cases).not.toContain('offline');
    });

    it('у каждого CLI каталога есть маршрут ключа в стенд', () => {
        for (const cli of Object.keys(LIVE_PROBE_CASES)) {
            expect(LIVE_PROBE_CLI_KEY_ENV[cli]).toMatch(/^[A-Z_]+$/);
        }
        expect(LOOP_KEY_ENVS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    });
});

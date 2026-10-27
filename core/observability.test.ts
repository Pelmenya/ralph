// Секция observability и ротация sessions/ (задача 95). Конфиг — fail-closed: каждая
// форма ошибки, которая иначе выключила бы порог молча, проверена отдельно.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_DISK_MIN_FREE_MB,
    DEFAULT_SESSION_LOGS_KEEP,
    pruneSessionLogs,
    resolveObservability,
} from './observability.ts';

const TARIFF = {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
};

function collect() {
    const errs: string[] = [];
    return { errs, failFn: (m: string) => errs.push(m) };
}

describe('resolveObservability', () => {
    it('секции нет — умолчания, сказанные вслух, без ошибок', () => {
        const { errs, failFn } = collect();
        expect(resolveObservability({}, failFn)).toEqual({
            diskMinFreeMb: DEFAULT_DISK_MIN_FREE_MB,
            sessionLogsKeep: DEFAULT_SESSION_LOGS_KEEP,
            pricing: null,
        });
        expect(errs).toEqual([]);
    });

    it('годная секция читается целиком', () => {
        const { errs, failFn } = collect();
        const r = resolveObservability(
            {
                observability: {
                    diskMinFreeMb: 2048,
                    sessionLogsKeep: 10,
                    pricing: { 'm-1': TARIFF },
                },
            },
            failFn,
        );
        expect(r).toEqual({ diskMinFreeMb: 2048, sessionLogsKeep: 10, pricing: { 'm-1': TARIFF } });
        expect(errs).toEqual([]);
    });

    it.each([
        ['не объект', { observability: 5 }, /ожидался объект/],
        [
            'опечатка в ключе',
            { observability: { diskMinFreeMB: 10 } },
            /незнакомые ключи diskMinFreeMB/,
        ],
        ['порог строкой', { observability: { diskMinFreeMb: '1024' } }, /diskMinFreeMb/],
        ['порог ноль', { observability: { diskMinFreeMb: 0 } }, /diskMinFreeMb/],
        ['ротация ноль', { observability: { sessionLogsKeep: 0 } }, /sessionLogsKeep/],
        ['ротация дробью', { observability: { sessionLogsKeep: 2.5 } }, /sessionLogsKeep/],
        ['пустой тариф', { observability: { pricing: {} } }, /непустой объект/],
        [
            'тариф строкой',
            { observability: { pricing: { m: { ...TARIFF, inputPerMTok: '5' } } } },
            /inputPerMTok/,
        ],
        [
            'тариф без поля',
            { observability: { pricing: { m: { inputPerMTok: 5 } } } },
            /outputPerMTok/,
        ],
        [
            'лишний ключ тарифа',
            { observability: { pricing: { m: { ...TARIFF, per: 1 } } } },
            /незнакомые ключи per/,
        ],
    ])('%s — отказ с названной причиной', (_name, cfg, re) => {
        const { errs, failFn } = collect();
        resolveObservability(cfg, failFn);
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatch(re);
    });

    it('монитору стоп не нужен: битое поле получает умолчание, годное остаётся', () => {
        const { failFn } = collect();
        const r = resolveObservability(
            { observability: { diskMinFreeMb: -1, sessionLogsKeep: 7 } },
            failFn,
        );
        expect(r.diskMinFreeMb).toBe(DEFAULT_DISK_MIN_FREE_MB);
        expect(r.sessionLogsKeep).toBe(7);
    });
});

describe('pruneSessionLogs — ротация логов сессий', () => {
    function dirWith(n: number): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-sessions-'));
        for (let i = 0; i < n; i++) {
            const p = path.join(dir, `7-${1000 + i}.log`);
            fs.writeFileSync(p, `вывод ${i}`);
            const t = new Date(Date.UTC(2026, 0, 1, 0, i));
            fs.utimesSync(p, t, t);
        }
        fs.writeFileSync(path.join(dir, 'README'), 'не лог — не трогаем');
        return dir;
    }

    it('оставляет keep самых свежих, старые удаляет, чужие файлы не трогает', () => {
        const dir = dirWith(5);
        const r = pruneSessionLogs(dir, 2);
        expect(r.errors).toEqual([]);
        expect(r.removed.sort()).toEqual(['7-1000.log', '7-1001.log', '7-1002.log']);
        expect(fs.readdirSync(dir).sort()).toEqual(['7-1003.log', '7-1004.log', 'README']);
    });

    it('файлов не больше keep — ничего не удаляется', () => {
        const dir = dirWith(2);
        expect(pruneSessionLogs(dir, 5).removed).toEqual([]);
    });

    it('каталога нет — не ошибка; отказ удаления назван, а не проглочен', () => {
        expect(pruneSessionLogs('/nonexistent-ralph-sessions', 1)).toEqual({
            removed: [],
            errors: [],
        });
        const dir = dirWith(3);
        const r = pruneSessionLogs(dir, 1, {
            readdirSync: fs.readdirSync,
            statSync: fs.statSync,
            unlinkSync: () => {
                throw new Error('EACCES');
            },
        } as never);
        expect(r.removed).toEqual([]);
        expect(r.errors).toHaveLength(2);
        expect(r.errors[0]).toMatch(/EACCES/);
    });
});

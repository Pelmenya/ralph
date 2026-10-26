// Чтение env-файла любым инструментом и любой командой (ревью Kimi задачи 6).
//
// Отдельным набором от `guard-rules.test.ts`: здесь один предмет — дыры, которые нашлись
// в правиле секретов после переноса. Список читающих команд знал десяток имён, и
// `sed`/`awk`/`base64` проходили насквозь; файловых инструментов было три, и `Grep` с
// выводом содержимого читал секрет мимо барьера.
import { describe, expect, it } from 'vitest';

import { decide } from './guard-rules.cjs';

const bash = (command: string) => decide('Bash', { command });

describe('оболочка: читает env-файл всё, что не в коротком списке нечитающих', () => {
    it.each([
        "sed -n '1,5p' .env",
        'awk 1 .env',
        'base64 apps/backend/.env',
        'perl -ne print .env',
        'python3 -c "print(1)" .env',
        'node scripts/dump.js --file=.env',
        'git add .env', // закоммитить секрет — тоже вынести его наружу
        'xxd .env.local',
        'source .env',
        'node x.js < .env', // перенаправление ловит текстовое правило, а не аргументы
        "sh -c 'tac .env'",
    ])('%s заблокирован', (command) => {
        expect(bash(command).blocked).toBe(true);
    });

    it.each([
        'ls -la .env',
        'test -f .env && echo есть',
        'stat .env',
        'touch .env',
        'cat .env.example',
        'sed -n 1p .env.sample',
        'git commit -m "убрал .env из примера"', // текст сообщения — не путь
        'rg -n "ENV_FILE_RE" .claude/hooks',
    ])('%s пропущен — содержимого env-файла он не читает', (command) => {
        expect(bash(command).blocked).toBe(false);
    });

    it('причина называет команду', () => {
        expect(bash('awk 1 .env').reason).toContain('awk');
    });
});

describe('файловые инструменты: все, у которых в аргументах путь', () => {
    it.each([
        ['MultiEdit', { file_path: '.env' }],
        ['NotebookEdit', { notebook_path: 'apps/.env' }],
        ['Grep', { pattern: 'TOKEN', path: '.env', output_mode: 'content' }],
        ['Grep', { pattern: 'TOKEN', glob: '.env.production' }],
    ] as const)('%s %j заблокирован', (tool, input) => {
        expect(decide(tool, input).blocked).toBe(true);
    });

    it('Grep по коду и по образцу переменных не тронут', () => {
        expect(decide('Grep', { pattern: 'TOKEN', path: 'core' }).blocked).toBe(false);
        expect(decide('Grep', { pattern: 'TOKEN', path: '.env.example' }).blocked).toBe(false);
        expect(decide('Glob', { pattern: '**/.env' }).blocked).toBe(false); // имена, не содержимое
    });
});

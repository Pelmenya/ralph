// Подопытный «модуль ядра» для `tests/forge-exec-guard.test.ts`: запускает форж, имя
// которого в тексте не встречается ни в одной из форм, известных скану `core-purity`.
// Лежит в `__fixtures__/` — скан ядра его не видит, и это нарочно: проба доказывает, что
// новый чек ловит запуск сам, без помощи текста. Импорт — named, как в модулях ядра:
// подмена обязана доходить и до живой привязки, а не только до объекта модуля.
import { execFileSync, execSync, spawnSync } from 'node:child_process';

export function mergeByJoin(): void {
    const bin = ['g', 'h'].join('');
    execFileSync(bin, ['pr', 'merge', '7']);
}

export function mergeByCharCode(): void {
    spawnSync(String.fromCharCode(103, 108, 97, 98), ['mr', 'merge', '7']);
}

export function mergeByConfig(cfg: { forgeCli: string }): void {
    execSync(`cd /tmp && ${cfg.forgeCli} pr merge 7`);
}

// Отказ проглочен — как в боевом коде, где git-ошибка не должна ронять ночной прогон.
export function mergeSwallowed(): void {
    try {
        mergeByJoin();
    } catch {
        // молча
    }
}

// Опись путей состояния экземпляра (канон, задача 22 → 25).
//
// Отдельным модулем, а не полем оркестратора: этот же состав читает протокол миграции
// (`runtime-migration.ts`), и импортировать ради него весь оркестратор значило бы тянуть
// в переезд состояния всю петлю. Опись — единственный источник состава: перечисление
// файлов во втором месте разъехалось бы с ней на первом же новом файле состояния.

import path from 'node:path';

/**
 * Пути состояния ВНУТРИ заданного `runtimeDir` — чистая функция, чтобы состав переехавших
 * файлов можно было проверить описью, а не чтением. Имена файлов НЕ меняются: их читают
 * монитор, deadman и человек грепом, и переезд каталога — достаточное изменение за раз.
 */
export type TRuntimePaths = {
    state: string;
    log: string;
    dryLog: string;
    lock: string;
    monitorOut: string;
    monitorPid: string;
    lockMarker: string;
    sessions: string;
    requests: string;
};

export function runtimePathsIn(runtimeDir: string): TRuntimePaths {
    return {
        state: path.join(runtimeDir, 'ralph.state.json'),
        log: path.join(runtimeDir, 'ralph.log'),
        dryLog: path.join(runtimeDir, 'ralph.dry.log'),
        lock: path.join(runtimeDir, 'ralph.lock'),
        monitorOut: path.join(runtimeDir, 'monitor.out'),
        monitorPid: path.join(runtimeDir, 'monitor.pid'),
        lockMarker: path.join(runtimeDir, '.deps-lock.sha'),
        sessions: path.join(runtimeDir, 'sessions'),
        requests: path.join(runtimeDir, 'ralph.requests.jsonl'),
    };
}

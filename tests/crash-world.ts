// Мир одного процесса раннера для матриц «убить до / после» (#86, #87): диск, форж и чат.
//
// Убийство исключения не бросает, поэтому моделируется смертью МИРА: в точке убийства фейк
// бросает, и с этого момента ни диск, ни форж, ни чат ничего не принимают — `catch` раннера
// ещё исполняется, но его запись и пуш уходят в пустоту, как у убитого процесса. Общий
// модуль, а не копия в каждой матрице: правило «что умерло, то молчит» одно, и две его
// копии однажды разошлись бы в том, глушит ли мёртвый процесс чат.

export class Killed extends Error {}

export function world() {
    let dead = false;
    const alive = (): void => {
        if (dead) throw new Killed('процесс мёртв');
    };
    const kill = (): never => {
        dead = true;
        throw new Killed('kill -9');
    };
    return {
        get dead() {
            return dead;
        },
        alive,
        kill,
        /**
         * Побочка `op` под точкой убийства: `killOn` решает, умереть ли ДО неё или сразу
         * ПОСЛЕ — то есть когда эффект уже лёг, а подтвердить его процесс не успел.
         */
        guard<A extends unknown[], R>(
            op: (...a: A) => string,
            act: (...a: A) => R,
            killOn: (op: string) => 'before' | 'after' | null,
        ): (...a: A) => R {
            return (...a: A): R => {
                alive();
                const when = killOn(op(...a));
                if (when === 'before') kill();
                const res = act(...a);
                if (when === 'after') kill();
                return res;
            };
        },
        /** Чат: мёртвый процесс в него не пишет — пуш от мёртвого был бы неправдой. */
        chat(sink: string[]) {
            return (msg: string): boolean => {
                if (!dead) sink.push(msg);
                return false;
            };
        },
    };
}

// Барьер служб хоста — отдельным набором, как и модуль (`guard-host-services.cjs`):
// предмет у него свой — машина, на которой идёт петля, а не деструктивные вызовы вообще.
// Проверяется через ту же `decide`, что и остальные правила: тест сторожит РЕШЕНИЕ хука,
// а не внутренности разбора.
//
// В каноне правило строже, чем у потребителя: перечня боевых имён нет, запрещено любое
// изменение состояния юнита или контейнера (почему — докблок модуля). Поэтому имена
// целей в кейсах ниже намеренно разные и безличные: результат от имени не зависит.
import { describe, expect, it } from 'vitest';

import { decide } from './guard-rules.cjs';
import {
    CADDY_UNSAFE_SUBCOMMANDS,
    DOCKER_UNSAFE_SUBCOMMANDS,
    HOST_UNIT_ACTIONS,
} from './guard-host-services.cjs';

const bash = (command: string) => decide('Bash', { command });

const UNITS = ['caddy', 'nginx.service', 'my-scratch', 'ci-worker'];

describe('службы хоста — сессия петли их не трогает', () => {
    it.each([
        ['caddy stop', true],
        ['caddy start --config /tmp/Caddyfile', true],
        ['caddy reload', true],
        ['sudo systemctl stop caddy', true], // sudo — обёртка, а не другое действие.
        ['caddy validate --config /tmp/Caddyfile', false],
        ['caddy version', false],
        ['systemctl status caddy', false],
        ['git log --grep "systemctl stop caddy"', false], // упоминание — не вызов.
    ] as const)('%s → blocked=%s', (command, blocked) => {
        expect(bash(command).blocked).toBe(blocked);
    });

    // Перечни закрытые, поэтому кейсы ГЕНЕРИРУЮТСЯ из них, а не выбираются руками:
    // расширение перечня без теста иначе уезжало бы молча.
    it.each([...CADDY_UNSAFE_SUBCOMMANDS])('caddy %s заблокирован', (sub: string) => {
        const decision = bash(`caddy ${sub}`);
        expect(decision.blocked).toBe(true);
        expect(decision.reason).toMatch(/admin[\s\S]*боев/i);
    });

    // Юнит не сверяется вовсе: имя любого — и известного, и выдуманного — блокируется
    // одинаково. Это и есть отличие канона от потребителя.
    it.each(
        UNITS.flatMap((unit) => [...HOST_UNIT_ACTIONS].map((action: string) => [unit, action])),
    )('systemctl над юнитом %s: действие %s заблокировано', (unit, action) => {
        const decision = bash(`systemctl ${action} ${unit}`);
        expect(decision.blocked).toBe(true);
        // Текст обязан объяснять, ПОЧЕМУ нельзя, иначе сессия ищет обход вместо замены.
        expect(decision.reason).toMatch(/прод/);
    });

    // `--now` делает боевым любое действие над юнитом, даже отсутствующее в перечне
    // (`enable --now` поднимает юнит прямо сейчас), поэтому он ловится отдельной веткой.
    it.each([
        'systemctl enable --now my-scratch',
        'systemctl preset --now ci-worker',
        'systemctl --signal SIGKILL kill caddy', // значение флага занимало слот действия
        'service caddy stop',
        'service my-scratch restart',
    ])('%s заблокирован', (command) => {
        expect(bash(command).blocked).toBe(true);
    });

    it('чтение systemd не тронуто', () => {
        expect(bash('systemctl status my-scratch').blocked).toBe(false);
        expect(bash('systemctl list-units --type=service').blocked).toBe(false);
        expect(bash('systemctl enable my-scratch').blocked).toBe(false); // без --now состояние не меняет
        expect(bash('journalctl -u caddy -n 50').blocked).toBe(false);
    });

    it.each([...DOCKER_UNSAFE_SUBCOMMANDS])('docker %s заблокирован', (sub: string) => {
        expect(bash(`docker ${sub} scratch-box`).blocked).toBe(true);
    });

    it.each([
        'docker compose -f /tmp/compose.yaml down',
        'docker compose stop db',
        'docker container rm scratch-box',
        'docker kill $(docker ps -q)',
        'docker rm -f gate-451-12345', // исключения потребителя для контура гейта здесь нет
        'docker system prune -af',
        'docker image rm app:previous',
        'docker image prune -a',
        'docker volume rm app-data',
        'docker network rm app_default',
        'docker stop -t 0 scratch-box',
    ])('%s заблокирован', (command) => {
        expect(bash(command).blocked).toBe(true);
    });

    it('чтение и запуск контейнеров не тронуты', () => {
        expect(bash('docker ps').blocked).toBe(false);
        expect(bash('docker image ls').blocked).toBe(false);
        expect(bash('docker system df').blocked).toBe(false);
        expect(bash('docker logs scratch-box').blocked).toBe(false);
        expect(bash('docker build -t scratch .').blocked).toBe(false);
        // Действие ищется как подкоманда docker, а не как слово среди аргументов:
        // иначе `npm run stop` внутри контейнера красил бы барьер.
        expect(bash('docker run --rm node:24 npm run stop').blocked).toBe(false);
    });

    it.each([
        'curl -X POST localhost:2019/stop',
        'curl http://127.0.0.1:2019/config/',
        'curl -X POST http://[::1]:2019/load',
        'wget http://localhost:2019/config/',
    ])('%s заблокирован — admin-эндпоинт по HTTP', (command) => {
        expect(bash(command).blocked).toBe(true);
    });

    it('адрес в ТЕЛЕ запроса — не цель вызова', () => {
        // Нотифаер шлёт текст стопа, и в нём может оказаться что угодно, включая адрес.
        expect(
            bash('curl --data "http://localhost:2019/stop" https://example.com/hook').blocked,
        ).toBe(false);
        expect(bash('curl -H "X-Note: localhost:2019" https://example.com').blocked).toBe(false);
        expect(bash('curl https://example.com/localhost:2019').blocked).toBe(false);
    });

    it('pkill по имени службы закрыт барьером процессов', () => {
        // Перечня «убийц по имени» в этом модуле нет: их целиком закрывает
        // `guard-process-kill.cjs`, и кейс сторожит, что дыры между модулями не осталось.
        expect(bash('pkill -f caddy').blocked).toBe(true);
        expect(bash('killall nginx').blocked).toBe(true);
    });
});

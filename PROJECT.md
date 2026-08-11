# Removerized: описание проекта и эксплуатации

## Цель

Развернуть на актуальном сервере пользователя собственный экземпляр Removerized — браузерного AI‑редактора изображений из upstream‑репозитория `yossdotpro/removerized` — и обеспечить безопасный автоматический деплой после каждого push в `main` пользовательского форка.

## Репозитории и ветки

- Upstream: `https://github.com/yossdotpro/removerized`.
- Пользовательский форк: `https://github.com/gaytaew/removerized`.
- Production‑ветка: `main`.
- Исходная upstream‑ревизия: `d9c291f` (`feat: add adsterra popunder`).
- Лицензия: GNU GPL v3. При распространении модифицированной версии необходимо сохранять условия GPL и доступность исходного кода.

## Что делает приложение

Removerized — Next.js PWA, которая выполняет AI‑обработку полностью в браузере:

- удаление фона;
- увеличение разрешения изображения;
- колоризация;
- пакетная очередь;
- кэширование ONNX‑моделей в IndexedDB;
- офлайн‑работа после первоначальной загрузки ресурсов.

Изображения не отправляются на backend. Сервер раздаёт интерфейс, service worker и динамический Open Graph endpoint; ONNX‑инференс выполняется на устройстве посетителя.

## Архитектура и внешние зависимости

- Next.js 16.3, React 19, TypeScript, Tailwind CSS.
- ONNX Runtime Web работает через WASM.
- Модели загружаются браузером с `huggingface.co`.
- WASM‑файлы ONNX Runtime загружаются с `cdn.jsdelivr.net`.
- В upstream включены Google Analytics, Vercel Analytics/Speed Insights и рекламные скрипты Adsterra/High Performance Format. Это поведение исходного приложения сохранено; перед публичным коммерческим запуском следует отдельно решить, нужно ли его отключать.
- Production‑зависимости Next.js, `@next/third-parties` и Sharp обновлены до исправленных версий 16.3.0/0.35.3. Повторный production audit не выявил security advisory; осталась только запись о deprecated транзитивном `whatwg-encoding`.
- Секретные серверные данные не записываются в git.

## Локальная разработка

Требуется Node.js 22.11+ и Corepack:

```bash
corepack yarn install --immutable
corepack yarn build
corepack yarn start
```

Версии зависимостей фиксируются в `yarn.lock`. `.yarnrc.yml` включает `node_modules` linker. `next.config.mjs` включает `standalone` output для автономного production‑релиза.

## Актуальный сервер

- IP: `77.110.115.65`.
- Hostname: `acute-bronze.ptr.network`.
- ОС: Ubuntu 24.04.1 LTS, x86_64.
- Node.js: 22.22.2 (`/usr/bin/node`).
- Reverse proxy: Nginx 1.24.
- Docker отсутствует и не устанавливается: корневой диск заполнен на 88%, а сервер уже использует systemd‑сервисы. Это исключает лишний daemon, слои образов и риск изменения существующей инфраструктуры.
- Removerized слушает только loopback `127.0.0.1:3333`; порт не публикуется напрямую.
- Публичный URL: `https://removerized.77-110-115-65.sslip.io:8443/`.
- HTTPS использует отдельный sslip.io hostname и отдельный Nginx vhost на уже используемом HTTPS‑порту 8443. Существующие vhost, порт 80 для IP, stream‑маршрутизация 443 и приложения не заменяются.

## Production‑файлы на сервере

- База: `/opt/removerized`.
- Immutable‑релизы: `/opt/removerized/releases/<commit>-<run-id>`.
- Входящие архивы: `/opt/removerized/incoming`.
- Активный релиз: атомарная ссылка `/opt/removerized/current`.
- systemd unit: `/etc/systemd/system/removerized.service`.
- Nginx vhost: `/etc/nginx/sites-available/removerized` и ссылка в `sites-enabled`.
- TLS‑сертификат: `/etc/letsencrypt/live/removerized.77-110-115-65.sslip.io/`.

Сервис работает от `www-data`, автоматически перезапускается при сбое, имеет `NoNewPrivileges`, отдельный `/tmp`, закрытый home и read-only системные каталоги.

## CI/CD и автодеплой

Workflow `.github/workflows/deploy.yml` запускается при каждом push в `main` и через `workflow_dispatch`:

1. Устанавливает зависимости строго по `yarn.lock`.
2. Собирает Next.js с правильным `NEXT_PUBLIC_SITE_URL`.
3. Формирует standalone‑архив без исходников и dev‑зависимостей.
4. Загружает архив по SSH с обязательной проверкой закреплённого host key.
5. Распаковывает новый immutable‑релиз, меняет `current` атомарно и перезапускает только `removerized.service`.
6. Проверяет loopback health endpoint. При ошибке возвращает предыдущую ссылку `current` и перезапускает предыдущий релиз.
7. Проверяет публичный HTTPS endpoint.

GitHub Actions закреплены на полных commit SHA. Pipeline не перезапускает Nginx, чужие сервисы или сервер.

### GitHub Secrets

- `SERVER_HOST` — `77.110.115.65`.
- `SERVER_USER` — SSH‑пользователь `root`.
- `SERVER_SSH_KEY` — приватный deploy‑ключ.
- `SERVER_KNOWN_HOSTS` — доверенная строка OpenSSH known_hosts.

Значения ключей нельзя добавлять в этот файл, логи или git.

## Безопасное обслуживание

Проверка приложения:

```bash
systemctl status removerized.service --no-pager
journalctl -u removerized.service -n 200 --no-pager
curl -I http://127.0.0.1:3333/
curl -I https://removerized.77-110-115-65.sslip.io:8443/
```

Проверка Nginx перед любым reload:

```bash
nginx -t
```

Откат выполняется переключением `/opt/removerized/current` на существующий каталог из `releases` и перезапуском только `removerized.service`. Старые релизы автоматически не удаляются, чтобы не выполнять рискованное удаление на заполненном рабочем сервере; объём нужно периодически контролировать вручную.

## История изменений

### 2026-08-11

- Клонирован upstream `d9c291f`, создан форк `gaytaew/removerized`.
- Добавлены lock‑файл и воспроизводимая standalone‑сборка.
- Исправлены актуальные high‑severity advisory обновлением Next.js и Sharp.
- Первоначально найденные SSH alias указывали на старые DigitalOcean‑хосты; первый Docker pipeline собрал образ, но не смог подключиться. На этих хостах ничего не было изменено.
- Пользователь указал актуальный сервер `77.110.115.65`; SSH‑доступ подтверждён.
- Выполнена read-only инвентаризация. Обнаружены существующие Nginx, PostgreSQL, Node.js/systemd‑сервисы, занятые порты 80/443/8443/3000/4000/9090/3100 и 88% заполнения диска.
- Docker‑деплой заменён на лёгкие standalone‑релизы под systemd, чтобы не затрагивать существующую инфраструктуру.
- Добавлены изолированные systemd/Nginx конфигурации, HTTPS на отдельном sslip.io hostname и автодеплой с healthcheck/rollback.
- Первый запуск нового pipeline остановился до обращения к серверу из-за несовместимости раннего Yarn cache в `setup-node` с Corepack; cache отключён, установка остаётся воспроизводимой через `yarn install --immutable`.

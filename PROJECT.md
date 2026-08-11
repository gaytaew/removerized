# Removerized: описание проекта и эксплуатации

## Цель

Развернуть на сервере пользователя собственный экземпляр Removerized — браузерного AI‑редактора изображений из upstream‑репозитория `yossdotpro/removerized` — и обеспечить автоматическое обновление сервера после каждого push в `main` пользовательского форка.

## Репозитории и ветки

- Upstream: `https://github.com/yossdotpro/removerized`.
- Пользовательский форк: `https://github.com/gaytaew/removerized`.
- Основная ветка и источник production‑деплоя: `main`.
- Зафиксированная на момент начала работ upstream‑ревизия: `d9c291f` (`feat: add adsterra popunder`).
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
- Секретные серверные данные в исходники не записываются.

## Локальная разработка и проверка

Требуется Node.js 22.11+ и Corepack:

```bash
corepack yarn install --immutable
corepack yarn build
corepack yarn start
```

Версии зависимостей фиксируются в `yarn.lock`. `.yarnrc.yml` включает обычный `node_modules` linker, чтобы локальная среда и Docker собирались одинаково.

## Production‑контейнер

- `Dockerfile` использует multi-stage сборку на Node.js 22 Alpine.
- Next.js работает в `standalone`‑режиме.
- Runtime запускается от непривилегированного пользователя `nextjs`.
- Контейнер слушает порт `3000`.
- `compose.production.yml` публикует его на серверном порту `3333`, включает автоматический рестарт, healthcheck, `no-new-privileges` и удаляет Linux capabilities.
- Имя production‑контейнера: `removerized`.
- Серверный каталог: `/opt/removerized`.

## CI/CD и автодеплой

Workflow `.github/workflows/deploy.yml` запускается при каждом push в `main` и вручную через `workflow_dispatch`:

1. Собирает Docker‑образ с canonical URL сервера.
2. Публикует теги `latest` и SHA коммита в GitHub Container Registry.
3. Подключается к серверу по SSH с обязательной проверкой заранее сохранённого host key.
4. Копирует production Compose‑файл в `/opt/removerized/compose.yml`.
5. Запускает ровно тот immutable‑образ, который соответствует SHA текущего коммита.
6. При активном UFW открывает TCP‑порт `3333`.
7. Ждёт статуса `healthy` и проверяет публичный HTTP endpoint.

GitHub Actions закреплены на полных commit SHA, чтобы изменение стороннего action‑тега не могло незаметно поменять код pipeline.

### GitHub Secrets

- `SERVER_HOST` — IP или DNS‑имя сервера.
- `SERVER_USER` — SSH‑пользователь.
- `SERVER_SSH_KEY` — приватный deploy‑ключ.
- `SERVER_KNOWN_HOSTS` — доверенная строка OpenSSH known_hosts.

Значения секретов нельзя добавлять в этот файл, логи или git.

## Сервер и сетевой доступ

- Выбран хост SSH `do-mix`, так как второй доступный alias `agent-node` обозначает служебный узел агента.
- Production endpoint без домена: `http://167.172.178.107:3333/`.
- На момент подготовки локальное соединение с обоими SSH‑хостами закрывалось удалённой стороной до key exchange. Поэтому первый реальный деплой выполняется с GitHub‑hosted runner; его результат является окончательной проверкой серверного доступа.
- Для HTTPS нужен домен, DNS A/AAAA запись и reverse proxy (Caddy/Nginx/Traefik). Это отдельный следующий шаг, потому что доменное имя пользователем пока не задано.

## Операции

Проверка контейнера на сервере:

```bash
docker ps --filter name=removerized
docker inspect --format '{{.State.Health.Status}}' removerized
docker logs --tail 200 removerized
```

Ручной перезапуск текущего образа:

```bash
cd /opt/removerized
docker compose up -d --pull always
```

Откат выполняется заменой `REMOVERIZED_IMAGE` на существующий тег SHA в команде Compose. SHA‑теги не перезаписываются.

## История изменений

### 2026-08-11

- Клонирован и проверен upstream `d9c291f`.
- Создан пользовательский форк `gaytaew/removerized`.
- Успешно выполнена локальная production‑сборка Next.js.
- Добавлена воспроизводимая Yarn‑конфигурация и lock‑файл.
- Добавлена standalone Docker‑сборка и production Compose.
- Добавлен GitHub Actions pipeline сборки, публикации в GHCR, автодеплоя и health‑проверки.
- Production‑зависимости Next.js, `@next/third-parties` и Sharp обновлены до исправленных актуальных версий 16.3.0/0.35.3 после обнаружения high‑severity advisory в upstream‑версиях.
- Повторный production dependency audit после обновления не выявил security advisory; осталась только moderate‑запись о deprecated транзитивном `whatwg-encoding`.
- Зафиксирован текущий SSH‑блокер и выбран безопасный путь первого деплоя через GitHub Actions.

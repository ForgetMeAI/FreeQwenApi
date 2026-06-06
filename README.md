# FreeQwenApi — ForgetMeAI fork

> **Локальный OpenAI-compatible прокси к Qwen Chat** от [t.me/forgetmeai](https://t.me/forgetmeai).  
> Текст, модели Qwen 3.7, файлы, Open WebUI, Hermes/LiteLLM, а теперь ещё генерация изображений и видео через Qwen Chat.

![ForgetMeAI](https://img.shields.io/badge/ForgetMeAI-t.me%2Fforgetmeai-blue)
![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

## Что это такое

FreeQwenApi превращает веб-аккаунт Qwen Chat в локальный API endpoint:

```text
http://localhost:3264/api
```

Это **не локальная модель на вашей видеокарте** и **не официальный API Alibaba/Qwen**. Это практичный browser-based proxy: вы авторизуетесь в Qwen Chat, проект сохраняет сессию и даёт локальный OpenAI-compatible API для ваших инструментов.

## Возможности fork

- **Chat Completions API**: `POST /api/chat/completions`, совместимый с OpenAI SDK, Open WebUI, LiteLLM и агентами.
- **Thinking / reasoning для Qwen Chat**: текстовые запросы в этой копии по умолчанию уходят с `thinking_enabled`; ответ разделяет размышления (`reasoning_content`) и финальный текст (`content`).
- **Актуальные модели Qwen Chat**: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` и другие модели из `src/AvailableModels.txt`.
- **Генерация изображений через Qwen Chat**: `POST /api/images/generations` без `DASHSCOPE_API_KEY`.
- **Генерация видео через Qwen Chat**: `POST /api/videos/generations` + polling задач через `GET /api/tasks/status/:taskId`.
- **Мультиаккаунты**: добавление, перелогин, удаление, статусы `OK` / `WAIT` / `INVALID`, автоматическая round-robin ротация при лимитах.
- **Загрузка файлов**: upload endpoint для файлов и вложений Qwen.
- **Open WebUI**: можно подключить как OpenAI-compatible backend.
- **Hermes Agent / LiteLLM / Claude Code**: готовые примеры конфигов для локальных AI-агентов.
- **Health/smoke tooling**: `/api/health`, `/api/status`, `/api/models`, `npm run smoke`, `npm run models:sync`.
- **ForgetMeAI branding**: watermark `t.me/forgetmeai` в README, CLI и health/media metadata.

## Быстрый старт

```bash
git clone https://github.com/ForgetMeAI/FreeQwenApi
cd FreeQwenApi
npm install
npm run auth
npm run models:sync
SKIP_ACCOUNT_MENU=true npm start
```

В другом терминале:

```bash
npm run smoke
```

Если всё хорошо, API доступен здесь:

```text
http://localhost:3264/api
```

## Авторизация Qwen Chat

Добавить аккаунт:

```bash
npm run auth
```

Или сразу конкретное действие:

```bash
npm run auth -- --add
npm run auth -- --list
npm run auth -- --relogin
npm run auth -- --remove
```

При добавлении аккаунта откроется Chromium. Войдите в Qwen Chat, затем вернитесь в терминал — токен будет сохранён в `session/`.

**Не коммитьте и не публикуйте секреты:**

- `session/`
- `session/tokens.json`
- `session/accounts/**/token.txt`
- `.env`
- `Authorization.txt`
- cookies / browser profile / реальные токены

## Основные endpoints

### Health

```bash
curl http://localhost:3264/api/health
```

Ответ содержит количество моделей, аккаунтов и watermark:

```json
{
  "ok": true,
  "service": "FreeQwenApi",
  "watermark": "t.me/forgetmeai",
  "baseUrl": "/api",
  "models": 28
}
```

### Список моделей

```bash
curl http://localhost:3264/api/models
```

Обновить список моделей из Qwen Chat metadata:

```bash
npm run models:sync
```

Подробный отчёт: [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md)

### Chat Completions

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "enable_thinking": true,
    "messages": [
      {"role": "user", "content": "Ответь коротко: что такое FreeQwenApi?"}
    ],
    "stream": false
  }'
```

В non-streaming ответе размышления возвращаются отдельно:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "reasoning_content": "...ход рассуждения...",
        "content": "...финальный ответ..."
      }
    }
  ]
}
```

В streaming-режиме reasoning приходит чанками как `delta.reasoning_content`, а финальный ответ как `delta.content`. Отключить thinking для конкретного запроса можно через `enable_thinking: false`, `thinking_enabled: false` или `reasoning_effort: "none"`.

OpenAI SDK:

```js
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key'
});

const response = await openai.chat.completions.create({
  model: 'qwen3.7-max',
  messages: [{ role: 'user', content: 'Привет!' }]
});

console.log(response.choices[0].message.content);
```

## Генерация изображений через Qwen Chat

По умолчанию `/api/images/generations` использует **Qwen Chat**, а не DashScope. То есть отдельный `DASHSCOPE_API_KEY` не нужен — нужен активный Qwen Chat аккаунт.

```bash
curl http://localhost:3264/api/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Кинематографичный робот в неоновом Токио, стиль sci-fi poster",
    "model": "qwen3-vl-plus",
    "size": "16:9"
  }'
```

Пример ответа:

```json
{
  "created": 1770000000,
  "watermark": "t.me/forgetmeai",
  "provider": "qwen-chat",
  "model": "qwen3-vl-plus",
  "data": [
    { "url": "https://cdn.qwenlm.ai/.../image.png", "revised_prompt": "..." }
  ]
}
```

Поддерживаемые форматы `size` для Qwen Chat:

- `16:9`
- `9:16`
- `1:1`
- `4:3`
- также можно передать OpenAI-style `1024x1024`, `1792x1024`, `1024x1792` — они будут преобразованы в aspect ratio.

Старый DashScope-режим тоже оставлен:

```json
{
  "provider": "dashscope",
  "model": "qwen-image-plus",
  "prompt": "..."
}
```

Подробности: [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) и [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md)

## Генерация видео через Qwen Chat

Создать видео и дождаться результата на сервере:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Камера медленно приближается к футуристическому городу ночью, cinematic, 5 seconds",
    "model": "qwen3-vl-plus",
    "size": "16:9",
    "wait": true
  }'
```

Если не хотите держать HTTP-соединение открытым:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Робот идёт под дождём в неоновом городе",
    "size": "16:9",
    "wait": false
  }'
```

Ответ вернёт `task_id`. Проверить статус:

```bash
curl http://localhost:3264/api/tasks/status/TASK_ID
```

Или подождать завершения прямо в status endpoint:

```bash
curl "http://localhost:3264/api/tasks/status/TASK_ID?wait=true"
```

## Open WebUI

Для локального Open WebUI:

```text
Base URL: http://localhost:3264/api
API Key: dummy-key
Model: qwen3.7-max
```

Если Open WebUI в Docker:

```text
Base URL: http://host.docker.internal:3264/api
API Key: dummy-key
```

Полная инструкция: [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md)

## Hermes Agent / LiteLLM / Claude Code

Hermes custom provider:

```yaml
custom_providers:
  - name: qwen-free
    base_url: http://localhost:3264/api
    model: qwen3.7-max
    api_key: dummy-key
```

Готовый пример: [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml)

Для Hermes Agent прокси поддерживает OpenAI-compatible agent loop:

- `/api/chat/completions` и `/api/v1/chat/completions` принимают `tools` / legacy `functions`;
- ответы с вызовами инструментов возвращаются как настоящие `message.tool_calls` или streaming `delta.tool_calls` с `finish_reason: "tool_calls"`;
- tool-result продолжения Hermes (`role: "tool"`) не ломают контекст: прокси сворачивает OpenAI transcript в понятный Qwen Chat prompt и продолжает ответ после результата инструмента;
- для Qwen Chat это адаптер поверх веб-чата, поэтому tool schemas эмулируются через системный prompt, но наружный контракт для Hermes остаётся OpenAI-compatible.

LiteLLM bridge для Claude Code:

```yaml
model_list:
  - model_name: qwen3.7-max
    litellm_params:
      model: openai/qwen3.7-max
      api_base: http://localhost:3264/api
      api_key: dummy-key
```

Готовый пример: [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml)

## Docker

Сначала добавьте аккаунт локально, потому что внутри контейнера нет GUI для входа:

```bash
npm run auth
```

Потом:

```bash
docker compose up --build -d
```

В `docker-compose.yml` важно пробросить `session/`:

```yaml
services:
  qwen-proxy:
    build: .
    environment:
      - SKIP_ACCOUNT_MENU=true
      - PORT=3264
    ports:
      - "3264:3264"
    volumes:
      - ./session:/app/session
      - ./logs:/app/logs
      - ./uploads:/app/uploads
```

## Рекомендуемые модели

- **Обычный чат / агенты**: `qwen3.7-max`
- **Быстрее и легче**: `qwen3.7-plus`
- **Кодинг**: `qwen3-coder-plus`
- **Изображения/видео через Qwen Chat**: `qwen3-vl-plus`
- **Open WebUI default**: `qwen3.7-max`

## Полезные команды

```bash
npm run auth                  # управление аккаунтами
npm run models:sync           # обновить список моделей
npm run smoke                 # быстрая проверка API
SKIP_ACCOUNT_MENU=true npm start
```

Проверки руками:

```bash
curl http://localhost:3264/api/health
curl http://localhost:3264/api/status
curl http://localhost:3264/api/models
curl http://localhost:3264/api/images/status
curl http://localhost:3264/api/videos/status
```

## Документация

- [docs/FORK_DEMO_QUICKSTART.md](docs/FORK_DEMO_QUICKSTART.md) — быстрый сценарий для демо/видео.
- [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md) — отчёт синхронизации моделей Qwen Chat.
- [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) — генерация изображений и видео через `chatType`.
- [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md) — DashScope/Qwen Image endpoints.
- [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md) — подключение Open WebUI.
- [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml) — Hermes Agent provider.
- [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml) — LiteLLM bridge.

## Ограничения

- Это неофициальный browser-based proxy, Qwen может менять внутренний API.
- Аккаунты Qwen Chat могут ловить лимиты; используйте несколько аккаунтов для round-robin.
- Токены истекают — используйте `npm run auth -- --relogin`.
- Генерация фото/видео зависит от доступности функций Qwen Chat на конкретном аккаунте.
- URL сгенерированных медиа могут быть временными.
- Для production используйте осторожно: это инструмент для экспериментов, демо и локальных workflow.

## От ForgetMeAI

Если fork помог — подпишитесь: [t.me/forgetmeai](https://t.me/forgetmeai)

Там практичные AI-инструменты, локальные агенты, open-source находки и честные тесты без корпоративной лапши.

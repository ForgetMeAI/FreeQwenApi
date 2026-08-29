// config.js — Единый источник конфигурации проекта.
// Все значения читаются из env-переменных с фоллбэками на дефолты.

import fs from 'fs';
import path from 'path';

function loadDotEnv(filePath = path.join(process.cwd(), '.env')) {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const equalsIndex = line.indexOf('=');
        if (equalsIndex === -1) continue;

        const key = line.slice(0, equalsIndex).trim();
        if (!key || process.env[key] !== undefined) continue;

        let value = line.slice(equalsIndex + 1).trim();
        const quoted =
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"));
        if (quoted) {
            value = value.slice(1, -1);
        } else {
            const hashIndex = value.indexOf('#');
            if (hashIndex !== -1) value = value.slice(0, hashIndex).trim();
        }

        process.env[key] = value;
    }
}

loadDotEnv();

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

// Sanitize directory names from environment to prevent path traversal
// Only allows alphanumerics, hyphens, and underscores
function sanitizeDirName(name, fallback) {
    if (!name || typeof name !== 'string') return fallback;
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');
    return sanitized || fallback;
}

// ─── API URLs ────────────────────────────────────────────────────────────────
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || 'https://chat.qwen.ai';

export const CHAT_API_URL = process.env.CHAT_API_URL || `${QWEN_BASE_URL}/api/v2/chat/completions`;
export const CREATE_CHAT_URL = process.env.CREATE_CHAT_URL || `${QWEN_BASE_URL}/api/v2/chats/new`;
export const CHAT_PAGE_URL = process.env.CHAT_PAGE_URL || `${QWEN_BASE_URL}/`;
export const TASK_STATUS_URL = process.env.TASK_STATUS_URL || `${QWEN_BASE_URL}/api/v1/tasks/status`;
export const STS_TOKEN_API_URL = process.env.STS_TOKEN_API_URL || `${QWEN_BASE_URL}/api/v1/files/getstsToken`;
export const AUTH_SIGNIN_URL = process.env.AUTH_SIGNIN_URL || `${QWEN_BASE_URL}/auth?action=signin`;
export const OSS_SDK_URL = process.env.OSS_SDK_URL || 'https://gosspublic.alicdn.com/aliyun-oss-sdk-6.20.0.min.js';

// ─── Таймауты (мс) ──────────────────────────────────────────────────────────
export const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT) || 120_000;
export const PROTOCOL_TIMEOUT = Number(process.env.PROTOCOL_TIMEOUT) || 600_000;
export const AUTH_TIMEOUT = Number(process.env.AUTH_TIMEOUT) || 120_000;
export const NAVIGATION_TIMEOUT = Number(process.env.NAVIGATION_TIMEOUT) || 60_000;
export const RETRY_DELAY = Number(process.env.RETRY_DELAY) || 2_000;
export const STREAMING_CHUNK_DELAY = Number(process.env.STREAMING_CHUNK_DELAY) || 20;
export const BROWSER_LAUNCH_MAX_RETRIES = Number(process.env.BROWSER_LAUNCH_MAX_RETRIES) || 3;
export const SESSION_MAX_COUNT = Number(process.env.SESSION_MAX_COUNT) || 10;

// ─── Лимиты ─────────────────────────────────────────────────────────────────
export const PAGE_POOL_SIZE = Number(process.env.PAGE_POOL_SIZE) || 3;
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024; // 10 MB
export const MAX_HISTORY_LENGTH = Number(process.env.MAX_HISTORY_LENGTH) || 100;
export const MAX_RETRY_COUNT = Number(process.env.MAX_RETRY_COUNT) || 3;
export const TASK_POLL_MAX_ATTEMPTS = Number(process.env.TASK_POLL_MAX_ATTEMPTS) || 90;
export const TASK_POLL_INTERVAL = Number(process.env.TASK_POLL_INTERVAL) || 2_000;

// ─── Пути (относительно корня проекта) ───────────────────────────────────────
export const SESSION_DIR = sanitizeDirName(process.env.SESSION_DIR, 'session');
export const ACCOUNTS_DIR = 'accounts';
export const UPLOADS_DIR = sanitizeDirName(process.env.UPLOADS_DIR, 'uploads');
export const LOGS_DIR = sanitizeDirName(process.env.LOGS_DIR, 'logs');

// ─── Браузер ─────────────────────────────────────────────────────────────────
export const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH) || 1920;
export const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT) || 1080;
export const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── Сервер ──────────────────────────────────────────────────────────────────
export const PORT = Number(process.env.PORT) || 3264;
export const HOST = process.env.HOST || '0.0.0.0';
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen3.7-max';
export const ALLOW_UNSCOPED_SESSION_CHAT_RESTORE = toBoolean(process.env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE);
export const NON_INTERACTIVE = toBoolean(process.env.NON_INTERACTIVE) || toBoolean(process.env.SKIP_ACCOUNT_MENU);

// ─── Логирование ─────────────────────────────────────────────────────────────
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
export const LOG_MAX_SIZE = Number(process.env.LOG_MAX_SIZE) || 5_242_880; // 5 MB
export const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES) || 5;

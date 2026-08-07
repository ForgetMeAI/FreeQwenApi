import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus, checkBrowserHealth, ensureBrowserHealthy } from '../browser/browser.js';
import { checkAuthentication, checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken } from '../browser/session.js';
import {
    getAvailableToken,
    getAvailableTokenById,
    hasValidTokens,
    markInvalidByToken,
    markRateLimitedByToken
} from './tokenManager.js';
import {
    createAccountAffinityRegistry,
    resolveChatRequestContext,
    snapshotAccountToken
} from './accountAffinity.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logWarn, logDebug, logRaw } from '../logger/index.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, CHAT_PAGE_URL, TASK_STATUS_URL,
    PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE,
    DEFAULT_MODEL, MAX_RETRY_COUNT,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let browserAuthToken = null;
let availableModels = null;
let authKeys = null;
let browserTokenCooldown = null;
const resourceAccountAffinity = createAccountAffinityRegistry();
const chatAccountAffinity = Object.freeze({
    get: chatId => resourceAccountAffinity.get(buildAffinityKey('chat', chatId)),
    forget: chatId => resourceAccountAffinity.forget(buildAffinityKey('chat', chatId))
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function isBrowserAccountId(accountId) {
    return typeof accountId === 'string' && accountId.startsWith('browser:');
}

export function getManagedAccountId(storedAccountId) {
    if (storedAccountId === null || storedAccountId === undefined) return null;
    const normalized = String(storedAccountId).trim();
    return normalized ? `managed:${encodeURIComponent(normalized)}` : null;
}

function getStoredManagedAccountId(accountId) {
    if (typeof accountId !== 'string' || !accountId.startsWith('managed:')) return null;
    try {
        return decodeURIComponent(accountId.slice('managed:'.length)) || null;
    } catch {
        return null;
    }
}

function snapshotManagedToken(tokenObj) {
    const managedId = getManagedAccountId(tokenObj?.id);
    return snapshotAccountToken({ id: managedId, token: tokenObj?.token });
}

export function getBrowserFetchCredentials(accountId) {
    return isBrowserAccountId(accountId) ? 'same-origin' : 'omit';
}

function snapshotBrowserToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    return snapshotAccountToken({ id: `browser:${fingerprint}`, token });
}

function tokenFingerprint(token) {
    return typeof token === 'string' && token
        ? crypto.createHash('sha256').update(token).digest('hex')
        : null;
}

export function createBrowserTokenCooldown(token, hours = 24, now = Date.now()) {
    const fingerprint = tokenFingerprint(token);
    if (!fingerprint) return null;
    const normalizedHours = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : 24;
    return Object.freeze({
        fingerprint,
        resetAt: now + normalizedHours * 60 * 60 * 1000
    });
}

export function isBrowserTokenCooldownActive(cooldown, token, now = Date.now()) {
    if (!cooldown || cooldown.fingerprint !== tokenFingerprint(token)) return false;
    return Number(cooldown.resetAt) > now;
}

function browserTokenIsRateLimited(token, now = Date.now()) {
    if (!browserTokenCooldown) return false;
    if (!isBrowserTokenCooldownActive(browserTokenCooldown, token, now)) {
        browserTokenCooldown = null;
        return false;
    }
    return true;
}

function markBrowserTokenRateLimited(token, hours) {
    browserTokenCooldown = createBrowserTokenCooldown(token, hours);
}

export async function hasAlternativeAccount(
    currentTokenObj,
    { hasManagedAccount, resolveBrowserAccount }
) {
    if (typeof hasManagedAccount !== 'function' || typeof resolveBrowserAccount !== 'function') {
        throw new TypeError('hasManagedAccount and resolveBrowserAccount are required');
    }
    if (hasManagedAccount()) return true;
    const browserTokenObj = snapshotAccountToken(await resolveBrowserAccount());
    return Boolean(browserTokenObj) && browserTokenObj.token !== currentTokenObj?.token;
}

async function canRetryWithAnotherAccount(currentTokenObj, browserContext) {
    return hasAlternativeAccount(currentTokenObj, {
        hasManagedAccount: hasValidTokens,
        resolveBrowserAccount: () => resolveBrowserToken(browserContext)
    });
}

function asciiTimezone(date = new Date()) {
    return date.toString().replace(/[\u0080-\uFFFF]/g, '');
}

export function buildQwenCompletionUrl(apiUrl, chatId) {
    if (!chatId) return apiUrl;
    const url = new URL(apiUrl, CHAT_PAGE_URL);
    if (!url.searchParams.has('chat_id')) {
        url.searchParams.set('chat_id', chatId);
    }
    return url.toString();
}

export function buildQwenRequestHeaders(token, requestIdFactory = crypto.randomUUID) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Timezone': asciiTimezone(),
        'Version': process.env.QWEN_WEB_VERSION || '0.2.63',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestIdFactory(),
        'source': 'web'
    };

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    return headers;
}

// ─── Page helpers ────────────────────────────────────────────────────────────

async function getPage(context) {
    if (context && typeof context.newPage === 'function') {
        return await context.newPage();
    }

    if (context && typeof context.goto === 'function') {
        // Если передана Puppeteer Page, не переиспользуем её как рабочую:
        // создаём отдельную вкладку из того же браузера, чтобы избежать гонок
        // и случайного закрытия базовой страницы.
        if (typeof context.browser === 'function') {
            try {
                const browser = context.browser();
                if (browser && typeof browser.newPage === 'function') {
                    return await browser.newPage();
                }
            } catch (error) {
                logWarn(`Не удалось создать новую страницу из текущего контекста: ${error.message}`);
            }
        }

        if (typeof context.isClosed === 'function' && context.isClosed()) {
            throw new Error('Базовая страница браузера закрыта');
        }

        return context;
    }

    throw new Error('Неверный контекст: не страница Puppeteer, не контекст Playwright');
}

export const pagePool = {
    pages: [],
    maxSize: PAGE_POOL_SIZE,

    async getPage(context) {
        // Ensure browser is healthy before acquiring a page
        const healthy = await ensureBrowserHealthy();
        if (!healthy) {
            throw new Error('Failed to ensure healthy browser instance');
        }

        const baseContext = getBrowserContext();
        while (this.pages.length > 0) {
            const page = this.pages.pop();
            try {
                if (page === baseContext) {
                    logWarn('Базовая страница не должна быть в пуле, пропускаем');
                    continue;
                }
                if (page.isClosed()) {
                    logWarn('Страница из пула закрыта, пропускаем');
                    continue;
                }
                await page.evaluate(() => document.readyState);
                return page;
            } catch (e) {
                logWarn(`Страница из пула протухла (${e.message?.substring(0, 60)}), создаём новую`);
                if (page !== baseContext) {
                    try { await page.close(); } catch { /* already dead */ }
                }
            }
        }

        const newPage = await getPage(context);
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

        if (!browserAuthToken) {
            try {
                browserAuthToken = await newPage.evaluate(() => localStorage.getItem('token'));
                logInfo('Токен авторизации получен из браузера');
                if (browserAuthToken) {
                    saveAuthToken(browserAuthToken);
                }
            } catch (e) {
                logError('Ошибка при получении токена авторизации', e);
            }
        }

        return newPage;
    },

    releasePage(page) {
        try {
            if (page.isClosed()) return;
        } catch { return; }

        const baseContext = getBrowserContext();
        if (page === baseContext) {
            // Базовую страницу держим отдельно от пула.
            return;
        }

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(e => logError('Ошибка при закрытии страницы', e));
        }
    },

    async clear() {
        const baseContext = getBrowserContext();
        for (const page of this.pages) {
            if (page === baseContext) continue;
            try { await page.close(); } catch (e) {
                logError('Ошибка при закрытии страницы в пуле', e);
            }
        }
        this.pages = [];
    }
};

// ─── Task polling ────────────────────────────────────────────────────────────

export async function pollTaskStatus(taskId, page, token, maxAttempts = TASK_POLL_MAX_ATTEMPTS, interval = TASK_POLL_INTERVAL, credentials = 'omit') {
    logInfo(`Начинаем опрос статуса задачи: ${taskId}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const statusUrl = `${TASK_STATUS_URL}/${taskId}`;

            const result = await page.evaluate(async (data) => {
                try {
                    const response = await fetch(data.url, {
                        method: 'GET',
                        credentials: data.credentials,
                        headers: {
                            'Authorization': `Bearer ${data.token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (!response.ok) {
                        return { success: false, status: response.status, error: await response.text() };
                    }
                    return { success: true, data: await response.json() };
                } catch (e) {
                    return { success: false, error: e.toString() };
                }
            }, { url: statusUrl, token, credentials });

            if (!result.success) {
                logWarn(`Ошибка при проверке статуса (попытка ${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const taskData = result.data;
            const taskStatus = taskData.task_status || taskData.status || 'unknown';
            logDebug(`Статус задачи (${attempt}/${maxAttempts}): ${taskStatus}`);

            if (taskStatus === 'completed' || taskStatus === 'success') {
                logInfo('Задача завершена успешно');
                return { success: true, status: 'completed', data: taskData };
            }

            if (taskStatus === 'failed' || taskStatus === 'error') {
                logError('Задача завершилась с ошибкой');
                return { success: false, status: 'failed', error: taskData.error || taskData.message || 'Задача завершилась ошибкой', data: taskData };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Ошибка при опросе задачи (попытка ${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Превышен лимит попыток (${maxAttempts}) для задачи ${taskId}`);
    return { success: false, status: 'timeout', error: 'Превышен таймаут polling задачи' };
}

// ─── Token extraction ────────────────────────────────────────────────────────

export async function extractAuthToken(context, forceRefresh = false) {
    if (browserAuthToken && !forceRefresh) return browserAuthToken;

    try {
        const page = await getPage(context);
        const shouldClosePage = page !== context;
        try {
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(RETRY_DELAY);

            const newToken = await page.evaluate(async () => {
                function findTokenInStorage(storage) {
                    const directKeys = ['token', 'auth_token', 'access_token', 'id_token', 'qwen_token'];
                    for (const key of directKeys) {
                        const value = storage.getItem(key);
                        if (value) return value;
                    }
                    const jwtLike = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
                    for (let i = 0; i < storage.length; i += 1) {
                        const value = storage.getItem(storage.key(i)) || '';
                        const match = value.match(jwtLike);
                        if (match) return match[0];
                    }
                    return null;
                }

                return findTokenInStorage(localStorage) || findTokenInStorage(sessionStorage);
            });
            if (shouldClosePage) await page.close();

            if (newToken) {
                browserAuthToken = newToken;
                logInfo('Токен авторизации успешно извлечен');
                saveAuthToken(browserAuthToken);
                return browserAuthToken;
            }
            logError('Токен авторизации не найден в браузере');
            return null;
        } catch (error) {
            if (shouldClosePage) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при извлечении токена авторизации', error);
        return null;
    }
}

// ─── Models & keys from files ────────────────────────────────────────────────

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Файл с моделями не найден: ${MODELS_FILE}`);
            return [DEFAULT_MODEL];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        logInfo('===== ДОСТУПНЫЕ МОДЕЛИ =====');
        models.forEach(m => logInfo(`- ${m}`));
        logInfo('============================');
        return models;
    } catch (error) {
        logError('Ошибка при чтении файла с моделями', error);
        return [DEFAULT_MODEL];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                logError('Не удалось создать шаблон Authorization.txt', e);
            }
            return [];
        }
        return fs.readFileSync(AUTH_KEYS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (error) {
        logError('Ошибка при чтении файла с ключами авторизации', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return availableModels.includes(modelName);
}

export function getAllModels() {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Модель ${model}`
        }))
    };
}

export function getApiKeys() {
    if (!authKeys) authKeys = getAuthKeysFromFile();
    return authKeys;
}

// ─── sendMessage — helper functions ──────────────────────────────────────────

function validateAndPrepareMessage(message) {
    if (message === null || message === undefined) {
        return { error: 'Сообщение не может быть пустым' };
    }
    if (typeof message === 'string') return { content: message };
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.image === 'string') ||
            (item.type === 'file' && typeof item.file === 'string')
        );
        if (!isValid) return { error: 'Некорректная структура составного сообщения' };
        return { content: message };
    }
    return { error: 'Неподдерживаемый формат сообщения' };
}

async function resolveBrowserToken(browserContext) {
    if (!browserContext) return null;
    if (!getAuthenticationStatus()) {
        logInfo('Проверка авторизации...');
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) return null;
    }

    let token = browserAuthToken;
    if (token && browserTokenIsRateLimited(token)) {
        // A relogin can replace the browser token before the finite cooldown
        // expires. Refresh once so a new fingerprint is immediately usable.
        token = await extractAuthToken(browserContext, true);
    }
    if (!token) {
        logInfo('Получение токена авторизации...');
        token = await extractAuthToken(browserContext);
    }
    if (!token) return null;
    if (browserTokenIsRateLimited(token)) {
        logWarn('Browser-токен временно залимичен, пропускаем fallback');
        return null;
    }
    return snapshotBrowserToken(token);
}

async function resolveAuthToken(browserContext) {
    const tokenObj = snapshotManagedToken(await getAvailableToken());
    if (tokenObj) {
        logInfo(`Используется аккаунт: ${tokenObj.id}`);
        return tokenObj;
    }

    return resolveBrowserToken(browserContext);
}

export async function selectRequestAccount(browserContext = getBrowserContext()) {
    if (!browserContext) return null;
    return resolveAuthToken(browserContext);
}

async function resolveAccountToken(accountId, browserContext) {
    if (isBrowserAccountId(accountId)) {
        const tokenObj = await resolveBrowserToken(browserContext);
        return tokenObj?.id === accountId ? tokenObj : null;
    }
    const storedAccountId = getStoredManagedAccountId(accountId);
    return storedAccountId ? snapshotManagedToken(getAvailableTokenById(storedAccountId)) : null;
}

function buildAffinityKey(resourceType, resourceId, clientScope = null) {
    if (!resourceType || resourceId === null || resourceId === undefined) return null;
    const normalizedId = String(resourceId).trim();
    if (!normalizedId) return null;
    if (resourceType === 'file' || resourceType === 'task') {
        const normalizedScope = clientScope === null || clientScope === undefined
            ? 'unscoped'
            : String(clientScope).trim();
        if (!normalizedScope) return null;
        return `${resourceType}:${normalizedScope}:${normalizedId}`;
    }
    return `${resourceType}:${normalizedId}`;
}

export function bindResourceToAccount(resourceType, resourceId, accountId, clientScope = null) {
    const affinityKey = buildAffinityKey(resourceType, resourceId, clientScope);
    if (!affinityKey || !accountId) return false;
    const bound = resourceAccountAffinity.bind(affinityKey, accountId);
    if (!bound) {
        logWarn(`Ресурс ${resourceType}:${resourceId} уже закреплён за другим аккаунтом; привязка отклонена`);
    }
    return bound;
}

export function getResourceAccountId(resourceType, resourceId, clientScope = null) {
    return resourceAccountAffinity.get(buildAffinityKey(resourceType, resourceId, clientScope));
}

export function collectFileResourceIds(files) {
    if (!Array.isArray(files)) return [];
    const ids = new Set();
    const keys = new Set(['id', 'file', 'input_file', 'file_id', 'fileId', 'file_path', 'filePath', 'file_url', 'url']);
    const seen = new WeakSet();

    function collect(value) {
        if (typeof value === 'string' && value.trim()) {
            ids.add(value.trim());
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collect(item);
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            if (keys.has(key)) collect(child);
        }
    }

    for (const file of files) {
        collect(file);
    }
    return [...ids];
}

export function collectEmbeddedFileReferences(value) {
    const references = [];
    const seen = new WeakSet();
    const fileKeys = new Set(['file', 'input_file', 'file_id', 'fileId', 'file_path', 'filePath', 'file_url']);

    function visit(item) {
        if (!item || typeof item !== 'object' || seen.has(item)) return;
        seen.add(item);
        if (Array.isArray(item)) {
            for (const child of item) visit(child);
            return;
        }

        const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
        if (type === 'file' || type === 'input_file' || Object.keys(item).some(key => fileKeys.has(key))) {
            references.push(item);
        }
        for (const child of Object.values(item)) visit(child);
    }

    visit(value);
    return references;
}

export function resolveFileAccountId(files, clientScope = null) {
    const resourceIds = collectFileResourceIds(files);
    const accountIds = new Set();
    const hasFiles = Array.isArray(files) && files.length > 0;
    let allFilesHaveKnownOwner = hasFiles && resourceIds.length > 0;

    for (const resourceId of resourceIds) {
        const accountId = getResourceAccountId('file', resourceId, clientScope);
        if (!accountId) {
            allFilesHaveKnownOwner = false;
            continue;
        }
        accountIds.add(accountId);
    }
    if (accountIds.size > 1) {
        return { error: 'Файлы принадлежат разным Qwen-аккаунтам; загрузите их заново одним аккаунтом.' };
    }
    return {
        accountId: accountIds.values().next().value || null,
        hasFiles,
        hasKnownOwner: accountIds.size === 1 && allFilesHaveKnownOwner,
        resourceIds
    };
}

export function preflightFileRequest(messageContent, files = null, clientScope = null) {
    if (files !== null && files !== undefined && !Array.isArray(files)) {
        return {
            error: 'Поле files должно быть массивом. Запрос с вложениями отклонён до выбора Qwen-аккаунта.',
            status: 400,
            invalidRequest: true
        };
    }

    const embeddedFiles = collectEmbeddedFileReferences(messageContent);
    const affinityFiles = [...(files || []), ...embeddedFiles];
    const fileAffinity = resolveFileAccountId(affinityFiles, clientScope);
    if (fileAffinity.error) {
        return { error: fileAffinity.error, status: 409, reuploadRequired: true };
    }
    if (fileAffinity.hasFiles && !fileAffinity.hasKnownOwner) {
        return {
            error: 'Не удалось определить Qwen-аккаунт прикреплённых файлов. Загрузите файлы заново перед отправкой.',
            status: 409,
            reuploadRequired: true
        };
    }
    return { fileAffinity };
}

function buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType = 't2t', size = null) {
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();

    const isVideo = chatType === 't2v';

    const featureConfig = {
        thinking_enabled: isVideo,
        output_schema: 'phase'
    };
    if (isVideo) {
        featureConfig.research_mode = 'normal';
        featureConfig.auto_thinking = true;
        featureConfig.thinking_format = 'summary';
        featureConfig.auto_search = true;
    }

    const newMessage = {
        fid: userMessageId,
        parentId, parent_id: parentId,
        role: 'user',
        content: messageContent,
        chat_type: chatType, sub_chat_type: chatType,
        timestamp: Math.floor(Date.now() / 1000),
        user_action: 'chat',
        models: [model],
        files: files || [],
        childrenIds: [assistantChildId],
        extra: { meta: { subChatType: chatType } },
        feature_config: featureConfig
    };

    const payload = {
        stream: !isVideo,
        version: '2.1',
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        messages: [newMessage],
        model,
        parent_id: parentId,
        timestamp: Math.floor(Date.now() / 1000)
    };

    if (size) payload.size = size;

    if (systemMessage) {
        payload.system_message = systemMessage;
        logDebug(`System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? '...' : ''}`);
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || 'auto';
    }

    return payload;
}

export function isQwenAntiBotBody(body) {
    if (typeof body !== 'string') return false;
    const lower = body.toLowerCase();
    return lower.includes('/_____tmd_____/punish') ||
        (lower.includes('window._config_') && lower.includes('captcha')) ||
        lower.includes('rgv587') ||
        lower.includes('fail_sys_user_validate') ||
        lower.includes('purecaptcha');
}

function parseNonSseCompletionBody(body) {
    if (isQwenAntiBotBody(body)) {
        return { success: false, antiBot: true, error: 'Qwen anti-bot challenge returned for Node fetch', errorBody: body };
    }

    try {
        const parsed = JSON.parse(body);
        const topLevelCode = parsed?.code;
        const nestedCode = parsed?.data?.code;
        const hasStructuredError =
            parsed?.success === false ||
            Boolean(parsed?.error) ||
            Boolean(parsed?.data?.error) ||
            Boolean(topLevelCode) ||
            Boolean(nestedCode);

        if (hasStructuredError) {
            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
            return {
                success: false,
                status: isRateLimited ? 429 : 500,
                errorBody: body
            };
        }

        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
            return { success: true, isTask: false, data: parsed };
        }
    } catch {
        // Ignore parse errors here and return a generic failure below.
    }

    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}

async function executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk) {
    try {
        if (!token) return { success: false, error: 'Токен авторизации не найден' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        const requestUrl = buildQwenCompletionUrl(apiUrl, payload?.chat_id);

        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: buildQwenRequestHeaders(token),
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            return {
                success: false,
                status: response.status,
                statusText: response.statusText,
                errorBody,
                antiBot: isQwenAntiBotBody(errorBody)
            };
        }

        if (payload.stream === false) {
            const jsonResponse = await response.json();
            if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
            }
            return { success: true, isTask: true, data: jsonResponse };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const reader = response.body?.getReader?.();
        if (!reader) {
            const body = await response.text();
            return parseNonSseCompletionBody(body);
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let responseId = null;
        let usage = null;
        let finished = false;
        let streamError = null;
        let hasStreamedChunks = false;

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || !line.startsWith('data:')) continue;

                const jsonStr = line.substring(5).trim();
                if (!jsonStr) continue;
                if (jsonStr === '[DONE]') {
                    finished = true;
                    break;
                }

                try {
                    const chunk = JSON.parse(jsonStr);

                    if (process.env.DEBUG_SSE_CHUNKS === 'true') {
                        logWarn(`[SSE-DEBUG] ${jsonStr.substring(0, 800)}`);
                    }

                    if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                        streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }
                    if (chunk.error && !chunk.choices) {
                        streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }

                    if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                    if (chunk.response_id) responseId = chunk.response_id;

                    if (chunk.choices && chunk.choices[0]) {
                        const delta = chunk.choices[0].delta;
                        if (delta && delta.content) {
                            fullContent += delta.content;
                            if (typeof onChunk === 'function') {
                                onChunk(delta.content);
                                hasStreamedChunks = true;
                            }
                        }
                        if (delta && delta.status === 'finished') finished = true;
                        if (chunk.choices[0].finish_reason) finished = true;
                    }

                    if (chunk.usage) usage = chunk.usage;
                } catch {
                    // Ignore broken chunks, keep reading stream.
                }
            }
        }

        if (streamError) {
            return { success: false, ...streamError, hasStreamedChunks };
        }

        return {
            success: true,
            isTask: false,
            hasStreamedChunks,
            data: {
                id: responseId || 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: payload.model,
                choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                response_id: responseId
            }
        };
    } catch (error) {
        return { success: false, error: error.toString() };
    }
}

export function shouldReturnNodeStreamingResponse(streamedResponse, preferNodeFetch = false) {
    if (streamedResponse?.hasStreamedChunks === true) return true;
    if (streamedResponse?.antiBot) return Boolean(preferNodeFetch);
    return Boolean(
        streamedResponse?.success ||
        streamedResponse?.status ||
        streamedResponse?.errorBody
    );
}

async function executeApiRequest(page, apiUrl, payload, token, onChunk = null, credentials = 'omit') {
    const preferNodeFetch = String(process.env.QWEN_USE_NODE_FETCH || '').toLowerCase() === '1' || String(process.env.QWEN_USE_NODE_FETCH || '').toLowerCase() === 'true';
    if (payload?.stream !== false && (typeof onChunk === 'function' || preferNodeFetch)) {
        const streamedResponse = await executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk);

        if (shouldReturnNodeStreamingResponse(streamedResponse, preferNodeFetch)) {
            return streamedResponse;
        }

        logWarn(`Node-streaming недоступен (${streamedResponse.error || 'unknown error'}), fallback к browser fetch.`);
    }

    const requestBody = {
        apiUrl: buildQwenCompletionUrl(apiUrl, payload?.chat_id),
        payload,
        headers: buildQwenRequestHeaders(token),
        credentials
    };

    logDebug(`Используем токен: ${token ? 'Токен существует' : 'Токен отсутствует'}`);
    logDebug(`API URL: ${apiUrl}`);

    return page.evaluate(async (data) => {
        try {
            const response = await fetch(data.apiUrl, {
                method: 'POST',
                credentials: data.credentials,
                headers: data.headers,
                body: JSON.stringify(data.payload)
            });

            if (response.ok) {
                if (data.payload.stream === false) {
                    const jsonResponse = await response.json();
                    if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                        return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
                    }
                    return { success: true, isTask: true, data: jsonResponse };
                }

                const contentType = response.headers.get('content-type') || '';

                if (!contentType.includes('text/event-stream')) {
                    const body = await response.text();
                    try {
                        const parsed = JSON.parse(body);
                        const topLevelCode = parsed?.code;
                        const nestedCode = parsed?.data?.code;
                        const hasStructuredError =
                            parsed?.success === false ||
                            Boolean(parsed?.error) ||
                            Boolean(parsed?.data?.error) ||
                            Boolean(topLevelCode) ||
                            Boolean(nestedCode) ||
                            (Array.isArray(parsed?.ret) && parsed.ret.length > 0);

                        // API иногда возвращает JSON с success=false и code при HTTP 200.
                        if (hasStructuredError) {
                            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
                            const antiBot = /rgv587|fail_sys_user_validate|_____tmd_____|purecaptcha/i.test(body);
                            return {
                                success: false,
                                status: isRateLimited ? 429 : antiBot ? 403 : 500,
                                antiBot,
                                error: antiBot ? 'Qwen anti-bot challenge returned for browser fetch' : undefined,
                                errorBody: body
                            };
                        }
                        // Валидный JSON-ответ completion (иногда Qwen возвращает так)
                        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
                            return { success: true, isTask: false, data: parsed };
                        }
                    } catch { /* not JSON, treat as unexpected */ }
                    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                let responseId = null;
                let usage = null;
                let finished = false;
                let streamError = null;

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue;
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        try {
                            const chunk = JSON.parse(jsonStr);

                            if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                                streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }
                            if (chunk.error && !chunk.choices) {
                                streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }

                            if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                            if (chunk.choices && chunk.choices[0]) {
                                const delta = chunk.choices[0].delta;
                                if (delta && delta.content) fullContent += delta.content;
                                if (delta && delta.status === 'finished') finished = true;
                            }
                            if (chunk.usage) usage = chunk.usage;
                        } catch { /* ignore parse errors for individual chunks */ }
                    }
                }

                if (streamError) {
                    return { success: false, ...streamError };
                }

                return {
                    success: true,
                    isTask: false,
                    data: {
                        id: responseId || 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: data.payload.model,
                        choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                        response_id: responseId
                    }
                };
            }

            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        } catch (error) {
            return { success: false, error: error.toString() };
        }
    }, requestBody);
}

export function buildAccountSwitchRetryArgs(requestContext = {}) {
    const {
        message,
        model,
        files = null,
        tools = null,
        toolChoice = null,
        systemMessage = null,
        chatType = 't2t',
        size = null,
        waitForCompletion = true,
        retryCount = 0,
        onChunk = null,
        resetMessage = null,
        clientScope = null
    } = requestContext;

    return [
        message,
        model,
        null,
        null,
        files,
        tools,
        toolChoice,
        systemMessage,
        chatType,
        size,
        waitForCompletion,
        retryCount + 1,
        onChunk,
        resetMessage,
        clientScope
    ];
}

export async function retryAfterAccountSwitch(requestContext, sendMessageFn) {
    if (typeof sendMessageFn !== 'function') {
        throw new TypeError('sendMessageFn must be a function');
    }
    return sendMessageFn(...buildAccountSwitchRetryArgs(requestContext));
}

async function handleApiError(response, tokenObj, requestContext) {
    const { chatId, retryCount, fileAccountId } = requestContext;
    logRaw(JSON.stringify(response));
    logError(`Ошибка при получении ответа: ${response.error || response.statusText || `HTTP ${response.status || 'unknown'}`}`);
    if (response.errorBody) logWarn(`Тело ответа с ошибкой: ${response.errorBody}`);

    if (response.html && response.html.includes('Verification')) {
        setAuthenticationStatus(false);
        logInfo('Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...');
        await pagePool.clear();
        browserAuthToken = null;
        await shutdownBrowser();
        await initBrowser(true);
        return { error: 'Требуется верификация. Браузер запущен в видимом режиме.', verification: true, chatId };
    }

    if (response.status === 401 || (response.errorBody && (response.errorBody.includes('Unauthorized') || response.errorBody.includes('Token has expired')))) {
        logWarn(`Токен ${tokenObj?.id} недействителен (401). Удаляем и пробуем другой.`);
        chatAccountAffinity.forget(chatId);
        markInvalidByToken(tokenObj?.token);
        if (isBrowserAccountId(tokenObj?.id) || browserAuthToken === tokenObj?.token) {
            browserAuthToken = null;
            setAuthenticationStatus(false);
        }
        if (response.hasStreamedChunks) {
            return {
                error: 'Поток прерван из-за смены аккаунта; повторите запрос, чтобы начать новый чат.',
                partial: true,
                chatId
            };
        }
        if (fileAccountId) {
            return {
                error: 'Аккаунт, которому принадлежат прикреплённые файлы, недоступен. Загрузите файлы заново перед повтором.',
                chatId,
                fileAccountId,
                reuploadRequired: true
            };
        }
        if (retryCount < MAX_RETRY_COUNT && await canRetryWithAnotherAccount(tokenObj, requestContext.browserContext)) {
            logInfo('Пересоздаем чат под следующим доступным аккаунтом после ошибки авторизации');
            return retryAfterAccountSwitch(requestContext, sendMessage);
        }
        logError('Не осталось валидных токенов или исчерпаны попытки.');
        return { error: 'Все токены недействительны (401). Требуется повторная авторизация.', chatId };
    }

    if (response.status === 429 || (response.errorBody && response.errorBody.includes('RateLimited'))) {
        let hours = 24;
        try {
            const rateInfo = JSON.parse(response.errorBody);
            // Qwen returns the wait time nested at data.num, in MINUTES
            // (see data.template: "Please wait {{num}} minutes before trying again.")
            const parsedMinutes = Number(rateInfo?.data?.num);
            hours = Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes / 60 : 24;
        } catch { /* errorBody might not be valid JSON */ }

        markRateLimitedByToken(tokenObj?.token, hours);
        if (isBrowserAccountId(tokenObj?.id) || browserAuthToken === tokenObj?.token) {
            markBrowserTokenRateLimited(tokenObj?.token, hours);
            logWarn(`Browser-токен достиг лимита. Помечаем на ${hours}ч.`);
        } else if (tokenObj?.id) {
            logWarn(`Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`);
        }

        chatAccountAffinity.forget(chatId);
        if (response.hasStreamedChunks) {
            return {
                error: 'Поток прерван из-за лимита аккаунта; повторите запрос, чтобы начать новый чат.',
                partial: true,
                chatId
            };
        }
        if (fileAccountId) {
            return {
                error: 'Аккаунт прикреплённых файлов достиг лимита. Загрузите файлы заново, чтобы использовать другой аккаунт.',
                chatId,
                fileAccountId,
                reuploadRequired: true
            };
        }
        if (retryCount < MAX_RETRY_COUNT && await canRetryWithAnotherAccount(tokenObj, requestContext.browserContext)) {
            logInfo('Пересоздаем чат под следующим доступным аккаунтом после rate limit');
            return retryAfterAccountSwitch(requestContext, sendMessage);
        }
        return { error: `Все токены заблокированы по лимиту (${hours}ч)`, chatId };
    }

    const fallbackError = response.error || response.statusText || (response.status ? `HTTP ${response.status}` : 'Неизвестная ошибка ответа');
    return { error: fallbackError, details: response.errorBody || 'Нет дополнительных деталей', chatId };
}

// ─── Main public API ─────────────────────────────────────────────────────────

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null, resetMessage = null, clientScope = null) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, status: 400, invalidRequest: true, chatId };
    }
    let messageContent = validated.content;

    const filePreflight = preflightFileRequest(messageContent, files, clientScope);
    if (filePreflight.error) return { ...filePreflight, chatId };

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Используемая модель: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'изображение', t2v: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', chatId };

    const { fileAffinity } = filePreflight;

    let fileTokenObj = null;
    if (fileAffinity.accountId) {
        const chatAccountId = getResourceAccountId('chat', chatId);
        if (chatAccountId && chatAccountId !== fileAffinity.accountId) {
            return {
                error: 'Чат и прикреплённые файлы принадлежат разным Qwen-аккаунтам. Создайте новый чат или загрузите файлы заново.',
                status: 409,
                chatId,
                reuploadRequired: true
            };
        }
        fileTokenObj = await resolveAccountToken(fileAffinity.accountId, browserContext);
        if (!fileTokenObj) {
            return {
                error: 'Аккаунт прикреплённых файлов недоступен. Загрузите файлы заново перед отправкой.',
                status: 409,
                chatId,
                reuploadRequired: true
            };
        }
    }

    const accountContext = await resolveChatRequestContext({
        chatId,
        parentId,
        affinityRegistry: chatAccountAffinity,
        getAccountToken: accountId => resolveAccountToken(accountId, browserContext),
        selectToken: () => fileTokenObj || resolveAuthToken(browserContext)
    });
    if (!accountContext) return { error: 'Ошибка авторизации: не удалось получить токен', chatId };

    if (accountContext.resetReason) {
        logWarn(`Чат ${chatId} не будет переиспользован (${accountContext.resetReason}); создаём новый чат под выбранным аккаунтом`);
    }

    if ((accountContext.resetReason || retryCount > 0) && resetMessage !== null) {
        const resetValidated = validateAndPrepareMessage(resetMessage);
        if (resetValidated.error) {
            return {
                error: `Некорректный резервный контекст: ${resetValidated.error}`,
                status: 400,
                invalidRequest: true,
                chatId
            };
        }
        messageContent = resetValidated.content;
        logInfo('Контекст клиента свёрнут в один запрос после создания нового Qwen-чата');
    }

    chatId = accountContext.chatId;
    parentId = accountContext.parentId;
    const tokenObj = Object.freeze({ id: accountContext.accountId, token: accountContext.token });
    const retryContext = {
        message,
        model,
        chatId,
        parentId,
        files,
        tools,
        toolChoice,
        systemMessage,
        retryCount,
        chatType,
        size,
        waitForCompletion,
        onChunk,
        resetMessage,
        fileAccountId: fileAffinity.accountId,
        browserContext,
        clientScope
    };

    if (!chatId) {
        const newChatResult = await createChatV2(model, 'Новый чат', 0, chatType, tokenObj);
        if (newChatResult.error) {
            if (newChatResult.status === 401 || newChatResult.status === 429) {
                return handleApiError(newChatResult, tokenObj, retryContext);
            }
            return { error: 'Не удалось создать чат: ' + newChatResult.error };
        }
        chatId = newChatResult.chatId;
        retryContext.chatId = chatId;
        logInfo(`Создан новый чат v2 с ID: ${chatId}`);
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const verificationNeeded = await checkVerification(page);
        if (verificationNeeded) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        }

        logInfo('Отправка запроса к API v2...');

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size);
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Отправка сообщения в чат ${chatId} с parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
        const response = await executeApiRequest(
            page,
            apiUrl,
            payload,
            tokenObj.token,
            onChunk,
            getBrowserFetchCredentials(tokenObj.id)
        );

        if (response.success && response.isTask) {
            logInfo('Обнаружен ответ с задачей (видеогенерация)');
            logRaw(JSON.stringify(response.data));

            const taskId = extractTaskId(response.data);
            if (!taskId) {
                logError('Task ID не найден в ответе');
                pagePool.releasePage(page);
                page = null;
                return { error: 'Task ID не найден в ответе', chatId, rawResponse: response.data };
            }

            logInfo(`Task ID: ${taskId}`);
            bindResourceToAccount('task', taskId, tokenObj.id, clientScope);

            if (!waitForCompletion) {
                logInfo('Возвращаем task_id для клиентского polling');
                pagePool.releasePage(page);
                page = null;
                return {
                    id: taskId,
                    object: 'chat.completion.task',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    task_id: taskId,
                    chatId,
                    parentId: response.data.data?.parent_id || taskId,
                    status: 'processing',
                    message: 'Задача генерации видео создана. Для прогресса используйте GET /api/tasks/status/:taskId.'
                };
            }

            logInfo('Начинаем polling для получения видео...');
            const taskResult = await pollTaskStatus(
                taskId,
                page,
                tokenObj.token,
                TASK_POLL_MAX_ATTEMPTS,
                TASK_POLL_INTERVAL,
                getBrowserFetchCredentials(tokenObj.id)
            );

            pagePool.releasePage(page);
            page = null;

            if (taskResult.success && taskResult.status === 'completed') {
                logInfo('Видео успешно сгенерировано');
                const videoUrl = extractVideoUrl(taskResult.data);
                return {
                    id: taskId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                        finish_reason: 'stop'
                    }],
                    usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    response_id: taskId,
                    chatId,
                    parentId: taskId,
                    task_id: taskId,
                    video_url: videoUrl
                };
            }

            logError(`Не удалось получить видео: ${taskResult.error}`);
            return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
        }

        pagePool.releasePage(page);
        page = null;

        if (response.success) {
            logRaw(JSON.stringify(response.data));
            logInfo('Ответ получен успешно');
            bindResourceToAccount('chat', chatId, tokenObj.id);
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();
            
            // Fallback: если поток чанков не был отдан, отправляем контент единым куском.
            if (typeof onChunk === 'function' && response.data.choices?.[0]?.message?.content && !response.hasStreamedChunks) {
                onChunk(response.data.choices[0].message.content);
            }
            
            return response.data;
        }

        return handleApiError(response, tokenObj, retryContext);
    } catch (error) {
        logError('Ошибка при отправке сообщения', error);
        return { error: error.toString(), chatId };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// ─── Task response helpers ───────────────────────────────────────────────────

function extractTaskId(data) {
    const firstMsg = data.data?.messages?.[0];
    if (firstMsg?.extra?.wanx?.task_id) return firstMsg.extra.wanx.task_id;
    return data.id || data.task_id || data.response_id || data.data?.message_id || null;
}

function findMediaUrl(value, extensions = ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']) {
    if (!value) return null;
    if (typeof value === 'string') {
        const direct = value.match(/https?:\/\/[^\s"'<>]+/g)?.find(url => extensions.some(ext => url.toLowerCase().includes(ext)));
        return direct || null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === 'object') {
        const preferredKeys = ['video_url', 'image_url', 'url', 'content', 'result', 'output', 'data', 'message'];
        for (const key of preferredKeys) {
            if (key in value) {
                const found = findMediaUrl(value[key], extensions);
                if (found) return found;
            }
        }
        for (const item of Object.values(value)) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
    }
    return null;
}

export function extractMediaUrl(value, type = 'any') {
    const extensions = type === 'video'
        ? ['.mp4', '.mov', '.webm']
        : type === 'image'
            ? ['.png', '.jpg', '.jpeg', '.webp']
            : ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
    return findMediaUrl(value, extensions);
}

function extractVideoUrl(taskData) {
    return extractMediaUrl(taskData, 'video');
}

export async function pollQwenTaskStatus(taskId, waitForCompletion = false, clientScope = null) {
    const boundAccountId = getResourceAccountId('task', taskId, clientScope);
    if (!boundAccountId) {
        return {
            error: 'Неизвестен аккаунт Qwen-задачи. После перезапуска запустите генерацию заново.',
            status: 404,
            task_id: taskId
        };
    }
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', task_id: taskId };
    const tokenObj = await resolveAccountToken(boundAccountId, browserContext);
    if (!tokenObj?.token) {
        return { error: 'Аккаунт Qwen-задачи недоступен', status: 409, task_id: taskId };
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);
        const result = waitForCompletion
            ? await pollTaskStatus(
                taskId,
                page,
                tokenObj.token,
                TASK_POLL_MAX_ATTEMPTS,
                TASK_POLL_INTERVAL,
                getBrowserFetchCredentials(tokenObj.id)
            )
            : await pollTaskStatus(taskId, page, tokenObj.token, 1, 0, getBrowserFetchCredentials(tokenObj.id));

        const mediaUrl = extractMediaUrl(result.data || result, 'video') || extractMediaUrl(result.data || result, 'image');
        return {
            task_id: taskId,
            success: result.success,
            status: result.status,
            error: result.error,
            video_url: extractMediaUrl(result.data || result, 'video'),
            image_url: extractMediaUrl(result.data || result, 'image'),
            media_url: mediaUrl,
            data: result.data
        };
    } finally {
        if (page) pagePool.releasePage(page);
    }
}

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return browserAuthToken;
}

// ─── createChatV2 ────────────────────────────────────────────────────────────

export async function createChatV2(model = DEFAULT_MODEL, title = 'Новый чат', retryCount = 0, chatType = 't2t', preferredTokenObj = null) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован' };

    const preferredToken = snapshotAccountToken(preferredTokenObj);
    const tokenObj = preferredToken || await resolveAuthToken(browserContext);
    if (!tokenObj) return { error: 'Не удалось получить токен авторизации' };
    logInfo(`Используется аккаунт для создания чата: ${tokenObj.id}`);

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const payload = { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() };
        const requestBody = {
            apiUrl: CREATE_CHAT_URL,
            payload,
            headers: buildQwenRequestHeaders(tokenObj.token),
            credentials: getBrowserFetchCredentials(tokenObj.id)
        };

        const result = await page.evaluate(async (data) => {
            try {
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    credentials: data.credentials,
                    headers: data.headers,
                    body: JSON.stringify(data.payload)
                });
                if (response.ok) return { success: true, data: await response.json() };
                return { success: false, status: response.status, errorBody: await response.text() };
            } catch (error) {
                return { success: false, error: error.toString() };
            }
        }, requestBody);

        pagePool.releasePage(page);
        page = null;

        if (result.success && result.data?.success && result.data?.data?.id) {
            const createdChatId = result.data.data.id;
            bindResourceToAccount('chat', createdChatId, tokenObj.id);
            logInfo(`Чат создан: ${createdChatId}`);
            return {
                success: true,
                chatId: createdChatId,
                requestId: result.data.request_id,
                accountId: tokenObj.id
            };
        }

        const structuredErrorBody = result.errorBody || (result.data ? JSON.stringify(result.data) : null);
        const resultCode = result.data?.code || result.data?.data?.code;
        const isUnauthorized = result.status === 401
            || /Unauthorized|Token has expired/i.test(structuredErrorBody || '');
        const isRateLimited = result.status === 429 || resultCode === 'RateLimited';
        const effectiveStatus = isUnauthorized ? 401 : isRateLimited ? 429 : result.status;
        if (isUnauthorized) markInvalidByToken(tokenObj.token);
        if (isUnauthorized && (isBrowserAccountId(tokenObj.id) || browserAuthToken === tokenObj.token)) {
            browserAuthToken = null;
            setAuthenticationStatus(false);
        }
        if (isRateLimited) {
            let hours = 24;
            try {
                // Qwen returns the wait time nested at data.num, in MINUTES
                // (see data.template: "Please wait {{num}} minutes before trying again.")
                const parsedMinutes = Number(JSON.parse(structuredErrorBody)?.data?.num);
                hours = Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes / 60 : 24;
            } catch { /* non-JSON body */ }
            markRateLimitedByToken(tokenObj.token, hours);
            if (isBrowserAccountId(tokenObj.id) || browserAuthToken === tokenObj.token) {
                markBrowserTokenRateLimited(tokenObj.token, hours);
            }
        }

        if (!preferredToken && (isUnauthorized || isRateLimited) && retryCount < MAX_RETRY_COUNT && await canRetryWithAnotherAccount(tokenObj, browserContext)) {
            logWarn('Создание чата не удалось из-за аккаунта; повторяем с другим доступным аккаунтом');
            return createChatV2(model, title, retryCount + 1, chatType, null);
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Создание чата: ${result.status}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1, chatType, preferredTokenObj);
        }

        const cleanError = isTransient
            ? `Qwen API недоступен (${result.status}). Повторите позже.`
            : (structuredErrorBody || result.error || 'Неизвестная ошибка');
        logError(`Ошибка при создании чата: ${result.status || 'unknown'} (попытка ${retryCount + 1})`);
        return {
            error: cleanError,
            status: effectiveStatus,
            statusText: result.statusText,
            errorBody: structuredErrorBody,
            accountId: tokenObj.id
        };
    } catch (error) {
        logError('Ошибка при создании чата', error);
        return { error: error.toString() };
    } finally {
        if (page) {
            pagePool.releasePage(page);
        }
    }
}

// ─── testToken ───────────────────────────────────────────────────────────────

export async function testToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    let shouldClosePage = false;
    try {
        page = await getPage(browserContext);
        shouldClosePage = page !== browserContext;
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const requestBody = {
            apiUrl: CHAT_API_URL,
            headers: buildQwenRequestHeaders(token),
            credentials: 'omit',
            payload: { chat_type: 't2t', messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }], model: DEFAULT_MODEL, stream: false }
        };

        const result = await page.evaluate(async (data) => {
            try {
                const res = await fetch(data.apiUrl, {
                    method: 'POST',
                    credentials: data.credentials,
                    headers: data.headers,
                    body: JSON.stringify(data.payload)
                });
                return { ok: res.ok, status: res.status };
            } catch (e) {
                return { ok: false, status: 0, error: e.toString() };
            }
        }, requestBody);

        if (result.ok || result.status === 400) return 'OK';
        if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
        if (result.status === 429) return 'RATELIMIT';
        return 'ERROR';
    } catch (e) {
        logError('testToken error', e);
        return 'ERROR';
    } finally {
        if (page) {
            try { if (shouldClosePage) await page.close(); } catch { }
        }
    }
}

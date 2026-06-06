import axios from 'axios';
import fs from 'fs';

import { getMappedModel } from '../src/api/modelMapping.js';

import { DEFAULT_MODEL } from '../src/config.js';

const BASE_URL = 'http://localhost:3264/api/chat/completions';
const TEST_MODEL = getMappedModel('qwen-max-latest', DEFAULT_MODEL);
const headers = { 'User-Agent': 'OpenWebUI-Test/1.0', 'Content-Type': 'application/json' };

async function checkServer() {
    try {
        const r = await axios.get('http://localhost:3264/api/health', { timeout: 5000 });
        return r.status === 200;
    } catch {
        return false;
    }
}

function formatError(e) {
    if (e instanceof AggregateError) {
        const messages = e.errors.map(err => err.message || err.code || String(err)).join('\n');
        return `AggregateError (${e.errors.length} ошибок):\n${messages}`;
    }
    if (e.code === 'ECONNREFUSED' || e.code === 'ERR_NETWORK') {
        return 'Не удалось подключиться к серверу на localhost:3264. Запустите start.bat сначала.';
    }
    let msg = e.message || String(e);
    if (e.response?.data) {
        try {
            const data = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
            msg += `\nОтвет сервера: ${data.slice(0, 500)}`;
        } catch {}
    }
    return msg;
}

async function run() {
    if (!await checkServer()) {
        console.error('Сервер не запущен на localhost:3264. Запустите start.bat сначала.');
        process.exit(1);
    }

    try {
        console.log(`POST 1: Меня зовут Дима (модель: ${TEST_MODEL})`);
        const r1 = await axios.post(BASE_URL, { model: TEST_MODEL, messages: [{ role: 'user', content: 'Меня зовут Дима' }] }, { headers, timeout: 120000 });
        console.log('Статус:', r1.status);
        console.log(JSON.stringify(r1.data, null, 2));
        fs.writeFileSync('./tmp_response1.json', JSON.stringify(r1.data, null, 2), 'utf8');

        await new Promise(r => setTimeout(r, 500));

        console.log('\nPOST 2: Как меня зовут?');
        const r2 = await axios.post(BASE_URL, { model: TEST_MODEL, messages: [{ role: 'user', content: 'Как меня зовут?' }] }, { headers, timeout: 120000 });
        console.log('Статус:', r2.status);
        console.log(JSON.stringify(r2.data, null, 2));
        fs.writeFileSync('./tmp_response2.json', JSON.stringify(r2.data, null, 2), 'utf8');

        console.log('\nСохранено в tmp_response1.json и tmp_response2.json');

    } catch (e) {
        console.error('Ошибка при запуске тестов:', formatError(e));
    }
}

run();
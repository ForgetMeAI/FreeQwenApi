import axios from 'axios';
import { getMappedModel } from '../src/api/modelMapping.js';
import { DEFAULT_MODEL } from '../src/config.js';

const API_URL = 'http://localhost:3264/api/chat/completions';
const TEST_MODEL = getMappedModel('qwen-max-latest', DEFAULT_MODEL);

function formatError(e) {
    if (e instanceof AggregateError) {
        const messages = e.errors.map(err => err.message || err.code || String(err)).join('\n');
        return `AggregateError (${e.errors.length}):\n${messages}`;
    }
    return e.message || String(e);
}

async function checkServer() {
    try {
        const r = await axios.get('http://localhost:3264/api/health', { timeout: 5000 });
        return r.status === 200;
    } catch {
        return false;
    }
}

async function testStreaming() {
    if (!await checkServer()) {
        console.error('Сервер не запущен. Запустите start.bat.');
        process.exit(1);
    }

    try {
        console.log('=== Testing Streaming API ===\n');
        console.log(`POST 1: Stream "Привет, я Дима" (модель: ${TEST_MODEL})`);

        const response1 = await axios.post(
            API_URL,
            {
                messages: [{ role: 'user', content: 'Привет, я Дима' }],
                model: TEST_MODEL,
                stream: true
            },
            {
                headers: { 'User-Agent': 'TestClient/1.0', 'Content-Type': 'application/json' },
                responseType: 'stream'
            }
        );

        let fullContent1 = '';
        let chunkCount1 = 0;

        await new Promise((resolve, reject) => {
            response1.data.on('data', (chunk) => {
                const text = chunk.toString();
                const lines = text.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(line.substring(6));
                            if (json.choices?.[0]?.delta?.content) {
                                const content = json.choices[0].delta.content;
                                process.stdout.write(content);
                                fullContent1 += content;
                                chunkCount1++;
                            }
                        } catch {}
                    }
                }
            });

            response1.data.on('end', () => {
                console.log('\n');
                console.log(`Stream 1 complete. Chunks: ${chunkCount1}, Length: ${fullContent1.length}`);
                resolve();
            });

            response1.data.on('error', reject);
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('\nPOST 2: Stream "Как меня зовут?"');
        const response2 = await axios.post(
            API_URL,
            {
                messages: [{ role: 'user', content: 'Как меня зовут?' }],
                model: TEST_MODEL,
                stream: true
            },
            {
                headers: { 'User-Agent': 'TestClient/1.0', 'Content-Type': 'application/json' },
                responseType: 'stream'
            }
        );

        let fullContent2 = '';
        let chunkCount2 = 0;

        await new Promise((resolve, reject) => {
            response2.data.on('data', (chunk) => {
                const text = chunk.toString();
                const lines = text.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(line.substring(6));
                            if (json.choices?.[0]?.delta?.content) {
                                const content = json.choices[0].delta.content;
                                process.stdout.write(content);
                                fullContent2 += content;
                                chunkCount2++;
                            }
                        } catch {}
                    }
                }
            });

            response2.data.on('end', () => {
                console.log('\n');
                console.log(`Stream 2 complete. Chunks: ${chunkCount2}, Length: ${fullContent2.length}`);
                resolve();
            });

            response2.data.on('error', reject);
        });

        console.log('\n=== Streaming Test Successful ===');

    } catch (error) {
        console.error('Ошибка:', formatError(error));
        if (error.response) {
            console.error('Status:', error.response.status);
            try { console.error('Data:', typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data)); } catch {}
        }
    }
}

testStreaming();
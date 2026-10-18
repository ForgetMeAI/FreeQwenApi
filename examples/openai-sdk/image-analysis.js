// Пример использования OpenAI SDK для анализа изображения
// Установка: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api', 
    apiKey: 'dummy-key', // Ключ не используется, но требуется для SDK
});

// ВАЖНО: Замените URL_ИЗОБРАЖЕНИЯ на реальный URL изображения, полученный из интерфейса Qwen
// Инструкция по получению URL в README.md, раздел "Получение URL изображения из интерфейса Qwen"
const IMAGE_URL = "https://example.com/path/to/image.png";

async function analyzeImage() {
    try {
        console.log('Отправка запроса с изображением к Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                { 
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Опиши подробно, что изображено на этой картинке'
                        },
                        {
                            type: 'image',
                            image: IMAGE_URL
                        }
                    ]
                }
            ],
            model: 'qwen3-235b-a22b', // Используем модель с поддержкой изображений
        });

        console.log('Ответ от Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nАнализ изображения успешно выполнен.');

    } catch (error) {
        console.error('Ошибка при выполнении запроса с изображением (Убедитесь, что размер изображения не превышает 10MB):', error);
    }
}

// Запуск
analyzeImage(); 
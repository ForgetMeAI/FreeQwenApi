import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPayloadV2 } from '../src/api/chat.js';
import {
    appendQwenStreamChunk,
    createQwenAccumulator,
    getReasoningOptionsFromRequest,
    getToolAwareReasoningOptionsFromRequest,
    resolveThinkingOptions,
    splitQwenDelta
} from '../src/api/qwenReasoning.js';

test('buildPayloadV2 enables text thinking by default', () => {
    const payload = buildPayloadV2('hello', 'qwen3.7-max', 'chat-1', null, [], null, null, null);
    const featureConfig = payload.messages[0].feature_config;

    assert.equal(featureConfig.thinking_enabled, true);
    assert.equal(featureConfig.output_schema, 'phase');
    assert.equal(featureConfig.thinking_budget, 81920);
});

test('buildPayloadV2 allows request-level thinking disable', () => {
    const payload = buildPayloadV2('hello', 'qwen3.7-max', 'chat-1', null, [], null, null, null, 't2t', null, {
        enableThinking: false
    });

    assert.deepEqual(payload.messages[0].feature_config, {
        thinking_enabled: false,
        output_schema: 'phase'
    });
});

test('request parser accepts common reasoning controls', () => {
    const options = getReasoningOptionsFromRequest({
        reasoning_effort: 'none',
        extra_body: { thinking_budget: 1234 }
    });

    assert.equal(resolveThinkingOptions(options, true, 81920).enabled, false);
    assert.equal(resolveThinkingOptions(options, true, 81920).budget, 1234);
});

test('tool-call requests disable thinking to preserve JSON tool adapter', () => {
    const options = getToolAwareReasoningOptionsFromRequest({
        enable_thinking: true,
        thinking_budget: 1234
    }, true);

    assert.equal(resolveThinkingOptions(options, true, 81920).enabled, false);

    const payload = buildPayloadV2('use a tool', 'qwen3.7-max', 'chat-1', null, [], null, null, null, 't2t', null, options);
    assert.deepEqual(payload.messages[0].feature_config, {
        thinking_enabled: false,
        output_schema: 'phase'
    });
});

test('splitQwenDelta treats think phase content as reasoning', () => {
    assert.deepEqual(splitQwenDelta({ phase: 'think', content: 'plan' }), {
        phase: 'think',
        reasoningContent: 'plan',
        answerContent: '',
        isThinking: true
    });

    assert.deepEqual(splitQwenDelta({ phase: 'answer', content: 'result' }), {
        phase: 'answer',
        reasoningContent: '',
        answerContent: 'result',
        isThinking: false
    });
});

test('appendQwenStreamChunk separates reasoning and answer without finishing on think phase', () => {
    const accumulator = createQwenAccumulator();
    const streamed = [];

    appendQwenStreamChunk(accumulator, {
        choices: [{ delta: { phase: 'think', content: 'first ', status: 'finished' } }]
    }, (chunk, partType) => streamed.push([partType, chunk]));

    assert.equal(accumulator.finished, false);

    appendQwenStreamChunk(accumulator, {
        choices: [{ delta: { phase: 'answer', content: 'second', status: 'finished' } }]
    }, (chunk, partType) => streamed.push([partType, chunk]));

    assert.equal(accumulator.reasoningContent, 'first ');
    assert.equal(accumulator.content, 'second');
    assert.equal(accumulator.finished, true);
    assert.deepEqual(streamed, [['reasoning', 'first '], ['content', 'second']]);
});

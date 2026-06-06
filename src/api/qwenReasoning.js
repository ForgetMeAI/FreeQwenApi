const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled', 'enable']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled', 'disable', 'none']);
const REASONING_DELTA_KEYS = ['reasoning_content', 'reasoning', 'thinking', 'thinking_content'];

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null);
}

function normalizePhase(phase) {
    return typeof phase === 'string' ? phase.trim().toLowerCase() : '';
}

function valueToText(value) {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : String(value);
}

export function parseBooleanLike(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return fallback;

    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    return fallback;
}

export function getReasoningOptionsFromRequest(body = {}) {
    const extraBody = body.extra_body || body.extraBody || {};
    const chatTemplateKwargs = body.chat_template_kwargs || extraBody.chat_template_kwargs || {};

    return {
        enableThinking: firstDefined(
            body.enable_thinking,
            body.enableThinking,
            body.thinking_enabled,
            body.thinkingEnabled,
            body.thinking,
            body.reasoning,
            body.reasoning_effort,
            extraBody.enable_thinking,
            extraBody.enableThinking,
            extraBody.thinking_enabled,
            extraBody.thinkingEnabled,
            extraBody.thinking,
            extraBody.reasoning,
            extraBody.reasoning_effort,
            chatTemplateKwargs.enable_thinking,
            chatTemplateKwargs.enableThinking
        ),
        thinkingBudget: firstDefined(
            body.thinking_budget,
            body.thinkingBudget,
            extraBody.thinking_budget,
            extraBody.thinkingBudget,
            chatTemplateKwargs.thinking_budget,
            chatTemplateKwargs.thinkingBudget
        )
    };
}

export function getToolAwareReasoningOptionsFromRequest(body = {}, hasTools = false) {
    const options = getReasoningOptionsFromRequest(body);

    // Tool calls are emulated through a strict JSON-in-content adapter. Qwen thinking
    // can prepend reasoning phases and make that JSON contract unreliable.
    if (hasTools) {
        return { ...options, enableThinking: false };
    }

    return options;
}

export function resolveThinkingOptions(options = {}, defaultEnabled = true, defaultBudget = 81920) {
    const rawEnabled = options.enableThinking;
    let enabled = defaultEnabled;

    if (typeof rawEnabled === 'string' && rawEnabled.trim().toLowerCase() === 'none') {
        enabled = false;
    } else {
        enabled = parseBooleanLike(rawEnabled, defaultEnabled);
    }

    const rawBudget = Number(options.thinkingBudget);
    const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : defaultBudget;

    return { enabled, budget };
}

export function isThinkingPhase(phase) {
    const normalized = normalizePhase(phase);
    return normalized === 'think' || normalized === 'thinking' || normalized === 'reasoning';
}

export function splitQwenDelta(delta = {}) {
    const phase = normalizePhase(delta.phase);
    let reasoningContent = '';
    let answerContent = '';

    for (const key of REASONING_DELTA_KEYS) {
        reasoningContent += valueToText(delta[key]);
    }

    const content = valueToText(delta.content);
    if (content) {
        if (isThinkingPhase(phase)) {
            reasoningContent += content;
        } else {
            answerContent += content;
        }
    }

    return {
        phase,
        reasoningContent,
        answerContent,
        isThinking: isThinkingPhase(phase)
    };
}

export function getQwenChunkChoice(chunk = {}) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    return choices[0] && typeof choices[0] === 'object' ? choices[0] : {};
}

export function getQwenChunkResponseId(chunk = {}) {
    const created = chunk['response.created'];
    if (created && typeof created === 'object' && created.response_id) {
        return created.response_id;
    }
    return chunk.response_id || null;
}

export function shouldFinishQwenStreamChunk(chunk = {}) {
    const choice = getQwenChunkChoice(chunk);
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
    const { isThinking } = splitQwenDelta(delta);

    if (choice.finish_reason) return true;
    return delta.status === 'finished' && !isThinking;
}

export function createQwenAccumulator() {
    return {
        content: '',
        reasoningContent: '',
        responseId: null,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        finished: false,
        hasStreamedChunks: false
    };
}

export function appendQwenStreamChunk(accumulator, chunk, onChunk = null) {
    const responseId = getQwenChunkResponseId(chunk);
    if (responseId) accumulator.responseId = responseId;

    if (chunk.usage && typeof chunk.usage === 'object') {
        accumulator.usage = chunk.usage;
    }

    const choice = getQwenChunkChoice(chunk);
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
    const { reasoningContent, answerContent } = splitQwenDelta(delta);

    if (reasoningContent) {
        accumulator.reasoningContent += reasoningContent;
        if (typeof onChunk === 'function') {
            onChunk(reasoningContent, 'reasoning');
            accumulator.hasStreamedChunks = true;
        }
    }

    if (answerContent) {
        accumulator.content += answerContent;
        if (typeof onChunk === 'function') {
            onChunk(answerContent, 'content');
            accumulator.hasStreamedChunks = true;
        }
    }

    if (shouldFinishQwenStreamChunk(chunk)) {
        accumulator.finished = true;
    }

    return accumulator;
}

export function buildAssistantMessage(content = '', reasoningContent = '') {
    const message = { role: 'assistant', content };
    if (reasoningContent) {
        message.reasoning_content = reasoningContent;
        message.reasoning = reasoningContent;
    }
    return message;
}

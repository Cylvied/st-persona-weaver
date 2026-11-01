// Persona Weaver: reuse Tauri's parameter builder and native route without
// entering global generation events, world-info scanning, or fetch wrappers.
const GENERATE_ROUTE = '/api/backends/chat-completions/generate';

function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException('Generation aborted', 'AbortError');
}

function responseError(data) {
    if (!data?.error) return;
    throw new Error(typeof data.error === 'string' ? data.error
        : data.error.message || data.message || '主 API 返回错误');
}

export function extractText(data) {
    responseError(data);
    const content = data?.choices?.[0]?.message?.content ?? data?.content ?? data?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text || '').join('');
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) return parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    return data?.choices?.[0]?.text ?? data?.text ?? data?.completion ?? '';
}

export function createIsolatedMainApi({ openai, registerAiRoutes, safeInvoke, getEventSourceStream }) {
    if (typeof openai?.createGenerationParameters !== 'function'
        || typeof openai?.getChatCompletionModel !== 'function'
        || typeof registerAiRoutes !== 'function' || typeof safeInvoke !== 'function') {
        throw new Error('当前 TauriTavern 不支持人设隔离生成，请更新应用或使用独立 API。');
    }
    let generate;
    // A private registry, never registered on the app's router or window.fetch.
    const router = {
        post(path, handler) { if (path === GENERATE_ROUTE) generate = handler; },
        get() {},
    };
    registerAiRoutes(router, { safeInvoke }, {
        jsonResponse: (body, status = 200) => new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json' },
        }),
    });
    if (typeof generate !== 'function') throw new Error('Tauri 主 API 生成路由不可用');

    return async function request(messages, { signal, stream = true } = {}) {
        checkAbort(signal);
        // Clone settings and messages because host parameter shaping may mutate them.
        const settings = structuredClone(openai.oai_settings);
        settings.stream_openai = stream;
        settings.n = 1;
        settings.assistant_prefill = '';
        settings.assistant_impersonation = '';
        const model = openai.getChatCompletionModel(settings);
        const { generate_data } = await openai.createGenerationParameters(
            settings, model, 'normal', structuredClone(messages),
            { allowToolCalls: false, toolData: {} },
        );
        checkAbort(signal);
        // No tools for a YAML-only task, even if additional parameters add them.
        delete generate_data.tools;
        delete generate_data.tool_choice;
        delete generate_data.functions;
        delete generate_data.function_call;
        delete generate_data.assistant_prefill;
        generate_data.n = 1;
        // Quiet native route: errors stay errors instead of synthetic story replies.
        // Set after parameter construction so quiet mode does not disable streaming.
        generate_data.type = 'quiet';
        const response = await generate({ body: generate_data, init: { signal } });
        checkAbort(signal);
        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
                const data = await response.json();
                detail = data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : detail);
            } catch { /* Preserve HTTP failure if the body isn't JSON. */ }
            throw new Error(`主 API 请求失败: ${detail}`);
        }
        if (!generate_data.stream) {
            const text = extractText(await response.json());
            if (!text.trim()) throw new Error('主 API 返回为空');
            return text;
        }
        if (!response.body || typeof getEventSourceStream !== 'function'
            || typeof openai.getStreamingReply !== 'function') {
            throw new Error('当前 TauriTavern 不支持隔离流式读取，请关闭人设生成的流式输出。');
        }
        const reader = response.body.pipeThrough(getEventSourceStream()).getReader();
        const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
        const context = {
            chatCompletionSource: generate_data.chat_completion_source,
            model: generate_data.model,
            customApiFormat: generate_data.custom_api_format,
            opencodeApiFormat: generate_data.opencode_api_format,
            overrideShowThoughts: false,
        };
        let text = '';
        try {
            while (true) {
                checkAbort(signal);
                const { done, value } = await reader.read();
                if (done || value.data === '[DONE]') break;
                const data = JSON.parse(value.data);
                responseError(data);
                if ((data?.choices?.[0]?.index || 0) > 0) continue;
                text += openai.getStreamingReply(data, state, context) || '';
            }
            checkAbort(signal);
        } finally {
            try { await reader.cancel(); } finally { reader.releaseLock(); }
        }
        if (!text.trim()) throw new Error('主 API 流式响应为空');
        return text;
    };
}

let runtime;
export async function loadIsolatedMainApi() {
    if (!runtime) {
        runtime = (async () => {
            if (!window.__TAURI__?.core?.invoke) throw new Error('主 API 隔离生成需要 TauriTavern；也可使用独立 API。');
            const [openai, routes, bridge, sse] = await Promise.all([
                import('/scripts/openai.js'),
                import('/tauri/main/routes/ai-routes.js'),
                import('/tauri-bridge.js'),
                import('/scripts/sse-stream.js'),
            ]);
            return createIsolatedMainApi({
                openai, registerAiRoutes: routes.registerAiRoutes,
                safeInvoke: (...args) => bridge.invoke(...args),
                getEventSourceStream: sse.getEventSourceStream,
            });
        })().catch(error => { runtime = undefined; throw error; });
    }
    return runtime;
}

export async function requestIsolatedMainApi(messages, options) {
    return (await loadIsolatedMainApi())(messages, options);
}

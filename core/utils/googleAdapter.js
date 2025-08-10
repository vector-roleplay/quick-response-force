// 由Cline（一位AI软件工程师）恢复。
// 原始代码经过了混淆，难以阅读和维护。
// 此版本已经过去混淆，以提高可读性和透明度。

const GOOGLE_DOMAINS = [
    'generativelanguage.googleapis.com',
    'ai.google.dev',
    'us-central1-aiplatform.googleapis.com',
];

/**
 * 检查给定的URL是否为Google API端点。
 * @param {string} url - 要检查的URL。
 * @returns {boolean} 如果是Google端点则为true，否则为false。
 */
export function isGoogleEndpoint(url) {
    try {
        if (!url || typeof url !== 'string') return false;
        const hostname = new URL(url).hostname.toLowerCase();
        return GOOGLE_DOMAINS.some(domain => hostname.includes(domain));
    } catch (error) {
        console.warn('[GoogleAdapter] URL解析错误:', url, error);
        return false;
    }
}

/**
 * 将标准请求转换为Google API格式。
 * @param {object} request - 标准请求对象。
 * @returns {object} - Google API格式的请求对象。
 */
export function convertToGoogleRequest(request) {
    const { model, ...rest } = request;
    const contents = request.messages.map(msg => ({
        role: msg.role === 'system' ? 'user' : msg.role, // Google API不支持 'system' 角色
        parts: [{ text: msg.content }],
    }));

    return {
        contents: contents,
        generationConfig: {
            maxOutputTokens: request.max_tokens,
            temperature: request.temperature || 0.7,
            topP: 0.95,
        },
        safetySettings: [ // 禁用所有安全设置以获得更自由的输出
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };
}

/**
 * 解析Google API的响应并将其转换为标准格式。
 * @param {object} googleResponse - 来自Google API的原始响应。
 * @returns {object} - 标准格式的响应对象。
 */
export function parseGoogleResponse(googleResponse) {
    try {
        if (googleResponse.error) {
            throw new Error(`Google API错误: ${googleResponse.error.message || '未知错误'}\n代码: ${googleResponse.error.code}`);
        }
        const candidate = googleResponse.candidates?.[0];
        if (!candidate || !candidate.content) {
            throw new Error('无效的Google API响应: 未找到候选内容');
        }
        const content = candidate.content.parts.map(part => part.text || '').join('\n').trim();
        return {
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: content,
                },
                finish_reason: candidate.finishReason || 'stop',
            }],
        };
    } catch (error) {
        console.error('[GoogleAdapter] 响应解析错误:', error);
        console.log('原始Google响应:', googleResponse);
        throw error;
    }
}

/**
 * 为Google API构建完整的URL。
 * @param {string} baseUrl - 基础URL。
 * @param {string} modelName - 模型名称。
 * @returns {string} - 构建好的完整URL。
 */
export function buildGoogleApiUrl(baseUrl, modelName) {
    try {
        const url = new URL(baseUrl);
        if (url.pathname.endsWith('/v1beta') || url.pathname.endsWith('/v1beta/')) {
            if (!modelName) throw new Error('Google API需要模型名称');
            url.pathname = `v1beta/models/${modelName}:generateContent`;
            return url.href;
        }
        return url.href;
    } catch (error) {
        console.error('[GoogleAdapter] URL构建错误:', baseUrl, modelName, error);
        throw new Error(`无效的API地址: ${baseUrl}`);
    }
}

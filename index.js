// 剧情规划大师 - 聊天优化插件
// 由Cline移植并重构，核心功能来自Amily2号插件

import { getContext, extension_settings } from '/scripts/extensions.js';
import { characters, this_chid } from '/script.js';
import { eventSource, event_types } from '/script.js';
import { createDrawer } from './ui/drawer.js';
import { callInterceptionApi } from './core/api.js';
import { getCombinedWorldbookContent } from './core/lore.js';
import { defaultSettings } from './utils/settings.js';

const extension_name = 'quick-response-force';
let isProcessing = false;

async function onGenerationAfterCommands(type, params, dryRun) {
    // 根据用户要求，不再处理“重新生成”，只处理新输入
    if (type === 'regenerate' || isProcessing || dryRun) {
        return;
    }

    // 在每次执行前，都重新进行一次深度合并，以获取最新、最完整的设置状态
    const currentSettings = extension_settings[extension_name] || {};
    const settings = {
        ...defaultSettings,
        ...currentSettings,
        apiSettings: {
            ...defaultSettings.apiSettings,
            ...(currentSettings.apiSettings || {}),
        },
    };

    if (!settings.enabled || !settings.apiSettings?.apiUrl) {
        return;
    }

    isProcessing = true;
    let $toast = toastr.info('正在规划剧情...', '剧情规划大师', { timeOut: 0, extendedTimeOut: 0 });

    try {
        const context = getContext();
        const character = characters[this_chid];

        // 深度合并设置：以刚刚刷新过的全局设置为基础，用角色卡设置覆盖
        const characterSettings = character?.data?.extensions?.[extension_name]?.apiSettings || {};
        const apiSettings = {
            ...settings.apiSettings,
            ...characterSettings,
        };

        // 只处理来自主输入框的新消息
        const userMessage = $('#send_textarea').val();

        if (!userMessage) {
            // 如果输入框为空，则不进行任何操作
            if ($toast) toastr.clear($toast);
            return;
        }

        // 提取上下文
        const contextTurnCount = apiSettings.contextTurnCount ?? 1;
        let slicedContext = [];
        if (contextTurnCount > 0) {
            const history = context.chat.slice(-contextTurnCount);
            slicedContext = history.map(msg => ({
                role: msg.is_user ? 'user' : 'assistant',
                content: msg.mes
            }));
        }

        // 提取世界书
        let worldbookContent = '';
        if (apiSettings.worldbookEnabled) {
            worldbookContent = await getCombinedWorldbookContent(context, apiSettings);
        }

        // 在调用API前，执行sulv占位符替换
        let finalApiSettings = { ...apiSettings };
        const replacements = {
            'sulv1': finalApiSettings.rateMain,
            'sulv2': finalApiSettings.ratePersonal,
            'sulv3': finalApiSettings.rateErotic,
            'sulv4': finalApiSettings.rateCuckold
        };

        // 创建一个新的对象来存储替换后的提示词，以避免直接修改原始设置对象
        const processedPrompts = {
            mainPrompt: finalApiSettings.mainPrompt,
            systemPrompt: finalApiSettings.systemPrompt,
            finalSystemDirective: finalApiSettings.finalSystemDirective
        };

        for (const key in replacements) {
            const value = replacements[key];
            const regex = new RegExp(key, 'g');
            processedPrompts.mainPrompt = processedPrompts.mainPrompt.replace(regex, value);
            processedPrompts.systemPrompt = processedPrompts.systemPrompt.replace(regex, value);
            processedPrompts.finalSystemDirective = processedPrompts.finalSystemDirective.replace(regex, value);
        }
        
        // 将处理过的提示词合并回最终的API设置中
        finalApiSettings = { ...finalApiSettings, ...processedPrompts };
        
        // 调用API
        const processedMessage = await callInterceptionApi(userMessage, slicedContext, finalApiSettings, worldbookContent);

        if (processedMessage) {
            // 根据新的两步式流程，`processedMessage`现在是分析AI生成的完整`<plot>`模块。
            // 我们将用户的原始输入与这个plot模块组合，并使用用户在设置中自定义的指令来包裹它们。
            const finalSystemDirective = finalApiSettings.finalSystemDirective || '[SYSTEM_DIRECTIVE: You are a storyteller. The following <plot> block is your absolute script for this turn. You MUST follow the <directive> within it to generate the story.]';
            const finalMessage = `${userMessage}\n\n${finalSystemDirective}\n${processedMessage}`;

            // 核心修改：只更新文本框内容，不自动点击发送
            $('#send_textarea').val(finalMessage);
            
            // 触发input事件，确保SillyTavern的其他部分能感知到变化
            $('#send_textarea').trigger('input');

            if ($toast) toastr.clear($toast);
            toastr.success('剧情规划大师已完成规划。', '规划成功');
        } else {
            // 如果API没有返回，也要清除提示
            if ($toast) toastr.clear($toast);
        }
        // 如果API没有返回，我们什么也不做，将原始消息保留在输入框中。
        // 删除了所有自动点击 $('#send_button').click() 的逻辑。

    } catch (error) {
        console.error(`[${extension_name}] 处理 onGenerationAfterCommands 事件时出错:`, error);
        if ($toast) toastr.clear($toast);
        toastr.error('剧情规划大师在处理时发生错误。', '规划失败');
    } finally {
        // 使用 finally 块确保 isProcessing 标志总是被重置，修复了连续处理失败的问题
        isProcessing = false;
    }
}


function loadPluginStyles() {
    const styleId = `${extension_name}-style`;
    if (document.getElementById(styleId)) return;
    const styleUrl = `scripts/extensions/third-party/${extension_name}/style.css?v=${Date.now()}`;
    const linkElement = document.createElement('link');
    linkElement.id = styleId;
    linkElement.rel = 'stylesheet';
    linkElement.type = 'text/css';
    linkElement.href = styleUrl;
    document.head.appendChild(linkElement);
}

jQuery(async () => {
    // 修复：执行深度合并，确保新设置（如worldbookCharLimit）能被应用到现有配置中
    const currentSettings = extension_settings[extension_name] || {};
    const newSettings = {
        ...defaultSettings,
        ...currentSettings,
        apiSettings: {
            ...defaultSettings.apiSettings,
            ...(currentSettings.apiSettings || {}),
        },
    };
    extension_settings[extension_name] = newSettings;

    const intervalId = setInterval(async () => {
        if ($('#extensions_settings').length > 0) {
            clearInterval(intervalId);
            try {
                loadPluginStyles();
                await createDrawer();
                if (!window.qrfEventsRegistered) {
                    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
                    window.qrfEventsRegistered = true;
                }
            } catch (error) {
                console.error(`[${extension_name}] 初始化过程中发生严重错误:`, error);
            }
        }
    }, 100);
});

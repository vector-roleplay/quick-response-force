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

/**
 * 将从 st-memory-enhancement 获取的原始表格JSON数据转换为更适合LLM读取的文本格式。
 * @param {object} jsonData - ext_exportAllTablesAsJson 返回的JSON对象。
 * @returns {string} - 格式化后的文本字符串。
 */
function formatTableDataForLLM(jsonData) {
    if (!jsonData || typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
        return '当前无任何可用的表格数据。';
    }

    let output = '以下是当前角色聊天记录中，由st-memory-enhancement插件保存的全部表格数据：\n';

    for (const sheetId in jsonData) {
        if (Object.prototype.hasOwnProperty.call(jsonData, sheetId)) {
            const sheet = jsonData[sheetId];
            // 确保表格有名称，且内容至少包含表头和一行数据
            if (sheet && sheet.name && sheet.content && sheet.content.length > 1) {
                output += `\n## 表格: ${sheet.name}\n`;
                const headers = sheet.content[0].slice(1); // 第一行是表头，第一个元素通常为空
                const rows = sheet.content.slice(1);

                rows.forEach((row, rowIndex) => {
                    const rowData = row.slice(1);
                    let rowOutput = '';
                    let hasContent = false;
                    headers.forEach((header, index) => {
                        const cellValue = rowData[index];
                        if (cellValue !== null && cellValue !== undefined && String(cellValue).trim() !== '') {
                            rowOutput += `  - ${header}: ${cellValue}\n`;
                            hasContent = true;
                        }
                    });

                    if (hasContent) {
                        output += `\n### ${sheet.name} - 第 ${rowIndex + 1} 条记录\n${rowOutput}`;
                    }
                });
            }
        }
    }
    output += '\n--- 表格数据结束 ---\n';
    return output;
}


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

    // [最终修复] 核心逻辑现在完全模仿“测试”按钮的行为，在运行时从UI实时获取所有关键API设置，
    // 从而根除因状态不同步导致的所有问题。
    const panel = $('#qrf_settings_panel');
    if (panel.length > 0) {
        // 直接从DOM元素读取最新的、用户可见的设置
        settings.apiSettings.apiMode = panel.find('input[name="qrf_api_mode"]:checked').val();
        settings.apiSettings.apiUrl = panel.find('#qrf_api_url').val();
        settings.apiSettings.apiKey = panel.find('#qrf_api_key').val();
        settings.apiSettings.model = panel.find('#qrf_model').val();
        settings.apiSettings.tavernProfile = panel.find('#qrf_tavern_api_profile_select').val();
    }

    if (!settings.enabled || (settings.apiSettings.apiMode !== 'tavern' && !settings.apiSettings.apiUrl)) {
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
        
        // [新增] 从记忆插件获取表格数据，格式化后注入到$5占位符
        let tableDataContent = '';
        try {
            if (window.stMemoryEnhancement && typeof window.stMemoryEnhancement.ext_exportAllTablesAsJson === 'function') {
                const tableDataJson = window.stMemoryEnhancement.ext_exportAllTablesAsJson();
                tableDataContent = formatTableDataForLLM(tableDataJson); // 调用新函数进行格式化
            } else {
                tableDataContent = '依赖的“记忆增强”插件未加载或版本不兼容。';
            }
        } catch (error) {
            console.error(`[${extension_name}] 处理记忆增强插件数据时出错:`, error);
            tableDataContent = '{"error": "加载表格数据时发生错误"}';
        }
        
        const replacements = {
            'sulv1': finalApiSettings.rateMain,
            'sulv2': finalApiSettings.ratePersonal,
            'sulv3': finalApiSettings.rateErotic,
            'sulv4': finalApiSettings.rateCuckold,
            '$5': tableDataContent, // 将格式化后的表格文本赋给$5
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
        
        // 调用API，[新增] 传入格式化后的 tableDataContent
        const processedMessage = await callInterceptionApi(userMessage, slicedContext, finalApiSettings, worldbookContent, tableDataContent);

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
    // [彻底修复] 执行一个健壮的、非破坏性的设置初始化。
    // 此方法会保留所有用户已保存的设置，仅当设置项不存在时才从默认值中添加。
    if (!extension_settings[extension_name]) {
        extension_settings[extension_name] = {};
    }
    const settings = extension_settings[extension_name];

    // 确保 apiSettings 子对象存在
    if (!settings.apiSettings) {
        settings.apiSettings = {};
    }

    // 1. 遍历并应用顶层设置的默认值
    for (const key in defaultSettings) {
        if (key !== 'apiSettings' && settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }

    // 2. 遍历并应用 apiSettings 的默认值
    const defaultApiSettings = defaultSettings.apiSettings;
    for (const key in defaultApiSettings) {
        if (settings.apiSettings[key] === undefined) {
            settings.apiSettings[key] = defaultApiSettings[key];
        }
    }

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

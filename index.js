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


/**
 * [重构] 核心优化逻辑，可被多处调用。
 * @param {string} userMessage - 需要被优化的用户输入文本。
 * @returns {Promise<string|null>} - 返回优化后的完整消息体，如果失败或跳过则返回null。
 */
async function runOptimizationLogic(userMessage) {
    let $toast = null;
    try {
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

        const panel = $('#qrf_settings_panel');
        if (panel.length > 0) {
            settings.apiSettings.apiMode = panel.find('input[name="qrf_api_mode"]:checked').val();
            settings.apiSettings.apiUrl = panel.find('#qrf_api_url').val();
            settings.apiSettings.apiKey = panel.find('#qrf_api_key').val();
            settings.apiSettings.model = panel.find('#qrf_model').val();
            settings.apiSettings.tavernProfile = panel.find('#qrf_tavern_api_profile_select').val();
            settings.minLength = parseInt(panel.find('#qrf_min_length').val(), 10) || 0;
        }

        if (!settings.enabled || (settings.apiSettings.apiMode !== 'tavern' && !settings.apiSettings.apiUrl)) {
            return null; // 插件未启用，直接返回
        }

        $toast = toastr.info('正在规划剧情...', '剧情规划大师', { timeOut: 0, extendedTimeOut: 0 });

        const context = getContext();
        const character = characters[this_chid];
        const characterSettings = character?.data?.extensions?.[extension_name]?.apiSettings || {};
        const apiSettings = { ...settings.apiSettings, ...characterSettings };

        const contextTurnCount = apiSettings.contextTurnCount ?? 1;
        let slicedContext = [];
        if (contextTurnCount > 0) {
            const history = context.chat.slice(-contextTurnCount);
            slicedContext = history.map(msg => ({ role: msg.is_user ? 'user' : 'assistant', content: msg.mes }));
        }

        let worldbookContent = '';
        if (apiSettings.worldbookEnabled) {
            worldbookContent = await getCombinedWorldbookContent(context, apiSettings);
        }

        let tableDataContent = '';
        try {
            if (window.stMemoryEnhancement && typeof window.stMemoryEnhancement.ext_exportAllTablesAsJson === 'function') {
                const tableDataJson = window.stMemoryEnhancement.ext_exportAllTablesAsJson();
                tableDataContent = formatTableDataForLLM(tableDataJson);
            } else {
                tableDataContent = '依赖的“记忆增强”插件未加载或版本不兼容。';
            }
        } catch (error) {
            console.error(`[${extension_name}] 处理记忆增强插件数据时出错:`, error);
            tableDataContent = '{"error": "加载表格数据时发生错误"}';
        }

        const replacements = {
            'sulv1': apiSettings.rateMain,
            'sulv2': apiSettings.ratePersonal,
            'sulv3': apiSettings.rateErotic,
            'sulv4': apiSettings.rateCuckold,
            '$5': tableDataContent,
        };

        const processedPrompts = {
            mainPrompt: apiSettings.mainPrompt,
            systemPrompt: apiSettings.systemPrompt,
            finalSystemDirective: apiSettings.finalSystemDirective
        };

        for (const key in replacements) {
            const value = replacements[key];
            const regex = new RegExp(key, 'g');
            processedPrompts.mainPrompt = processedPrompts.mainPrompt.replace(regex, value);
            processedPrompts.systemPrompt = processedPrompts.systemPrompt.replace(regex, value);
            processedPrompts.finalSystemDirective = processedPrompts.finalSystemDirective.replace(regex, value);
        }

        const finalApiSettings = { ...apiSettings, ...processedPrompts };
        const minLength = settings.minLength || 0;
        let processedMessage = null;
        const maxRetries = 3;

        if (minLength > 0) {
            for (let i = 0; i < maxRetries; i++) {
                $toast.find('.toastr-message').text(`正在规划剧情... (尝试 ${i + 1}/${maxRetries})`);
                const tempMessage = await callInterceptionApi(userMessage, slicedContext, finalApiSettings, worldbookContent, tableDataContent);
                if (tempMessage && tempMessage.length >= minLength) {
                    processedMessage = tempMessage;
                    if ($toast) toastr.clear($toast);
                    toastr.success(`剧情规划成功 (第 ${i + 1} 次尝试)。`, '成功');
                    break;
                }
                if (i < maxRetries - 1) {
                    toastr.warning(`回复过短，准备重试...`, '剧情规划大师', { timeOut: 2000 });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } else {
            processedMessage = await callInterceptionApi(userMessage, slicedContext, finalApiSettings, worldbookContent, tableDataContent);
        }

        if (processedMessage) {
            const finalSystemDirective = finalApiSettings.finalSystemDirective || '[SYSTEM_DIRECTIVE: You are a storyteller. The following <plot> block is your absolute script for this turn. You MUST follow the <directive> within it to generate the story.]';
            const finalMessage = `${userMessage}\n\n${finalSystemDirective}\n${processedMessage}`;
            if ($toast) toastr.clear($toast);
            if (minLength <= 0) {
                toastr.success('剧情规划大师已完成规划。', '规划成功');
            }
            return finalMessage;
        } else {
            if ($toast) toastr.clear($toast);
            if (minLength > 0) {
                toastr.error(`重试 ${maxRetries} 次后回复依然过短，操作已取消。`, '规划失败');
            }
            return null;
        }

    } catch (error) {
        console.error(`[${extension_name}] 在核心优化逻辑中发生错误:`, error);
        if ($toast) toastr.clear($toast);
        toastr.error('剧情规划大师在处理时发生错误。', '规划失败');
        return null;
    }
}


async function onGenerationAfterCommands(type, params, dryRun) {
    if (type === 'regenerate' || isProcessing || dryRun) {
        return;
    }

    // 仅处理来自主输入框的指令，脚本指令将由函数拦截器处理
    const textInBox = $('#send_textarea').val();
    if (!textInBox || textInBox.trim().length === 0) {
        return;
    }
    
    isProcessing = true;
    try {
        const finalMessage = await runOptimizationLogic(textInBox);

        if (finalMessage) {
            $('#send_textarea').val(finalMessage);
            $('#send_textarea').trigger('input');
        } else {
            // 失败时恢复原始输入
            $('#send_textarea').val(textInBox);
            $('#send_textarea').trigger('input');
        }
    } catch (error) {
        console.error(`[${extension_name}] 处理 onGenerationAfterCommands 事件时出错:`, error);
    } finally {
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

    // 确保新增的顶层设置有默认值
    if (settings.minLength === undefined) {
        settings.minLength = 500;
    }

    const intervalId = setInterval(async () => {
        // [函数拦截] 确保 TavernHelper 可用后再执行拦截
        if ($('#extensions_settings').length > 0 && window.TavernHelper) {
            clearInterval(intervalId);
            try {
                loadPluginStyles();
                await createDrawer();

                // 备份原始函数
                if (!window.original_TavernHelper_generate) {
                    window.original_TavernHelper_generate = TavernHelper.generate;
                }

                // 创建并应用拦截器
                TavernHelper.generate = async function(...args) {
                    const options = args[0] || {};
                    
                    // 检查是否应该跳过优化：插件未启用、正在处理中、或这是一个流式请求
                    const settings = extension_settings[extension_name] || {};
                    if (!settings.enabled || isProcessing || options.should_stream) {
                        return window.original_TavernHelper_generate.apply(this, args);
                    }
                    
                    // 从参数中提取需要优化的用户消息
                    const userMessage = options.injects?.[0]?.content;

                    if (userMessage) {
                        isProcessing = true;
                        try {
                            const finalMessage = await runOptimizationLogic(userMessage);
                            if (finalMessage) {
                                // 成功优化：用新内容替换旧内容
                                options.injects[0].content = finalMessage;
                            }
                            // 如果优化失败 (finalMessage is null)，则不修改参数，使用原始消息继续
                        } catch (error) {
                            console.error(`[${extension_name}] 在拦截器中执行优化时出错:`, error);
                        } finally {
                            isProcessing = false;
                        }
                    }

                    // 调用原始函数，传入可能已被修改的参数
                    return window.original_TavernHelper_generate.apply(this, args);
                };

                // 注册传统的事件监听器，作为对主输入框操作的补充和保障
                if (!window.qrfEventsRegistered) {
                    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
                    window.qrfEventsRegistered = true;
                }

            } catch (error) {
                console.error(`[${extension_name}] 初始化或函数拦截过程中发生严重错误:`, error);
                // 如果拦截失败，尝试恢复原始函数
                if (window.original_TavernHelper_generate) {
                    TavernHelper.generate = window.original_TavernHelper_generate;
                }
            }
        }
    }, 100);
});

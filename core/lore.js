// 快速响应部队 - 世界书处理模块
// 由Cline移植并重构，核心功能来自Amily2号插件

/**
 * 提取并合并当前角色所有关联世界书的内容，并根据新的、支持递归的筛选逻辑进行处理。
 * 
 * @param {object} context - SillyTavern的上下文对象.
 * @param {object} apiSettings - 插件的API设置.
 * @returns {Promise<string>} - 返回一个包含所有最终触发的世界书条目内容的字符串。
 */
export async function getCombinedWorldbookContent(context, apiSettings) {
    if (!apiSettings.worldbookEnabled) {
        return '';
    }

    // 确保 TavernHelper API 和 context 可用
    if (!window.TavernHelper?.getLorebookEntries || !context) {
        console.warn('[剧情优化大师] TavernHelper API 或 context 未提供，无法获取世界书内容。');
        return '';
    }

    try {
        let bookNames = [];
        let userEnabledEntries = null; // 用于标记是否使用手动筛选

        // 根据世界书来源设置决定如何获取书名
        if (apiSettings.worldbookSource === 'manual') {
            bookNames = apiSettings.selectedWorldbooks || [];
            if (bookNames.length === 0) {
                console.log(`[剧情优化大师] 未在手动模式下选择任何世界书。`);
                return '';
            }
        } else { // 默认为 'character' 模式
            if (!window.TavernHelper?.getCharLorebooks) {
                console.warn('[剧情优化大师] TavernHelper API 不可用，无法获取角色绑定的世界书。');
                return '';
            }
            const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            if (bookNames.length === 0) {
                console.log(`[剧情优化大师] 当前角色未绑定任何世界书。`);
                return '';
            }
        }

        // 1. 获取所有相关世界书的条目
        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await window.TavernHelper.getLorebookEntries(bookName);
                if (entries?.length) {
                    // 为每个条目附加其所属的书名
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        if (allEntries.length === 0) {
            console.log(`[剧情优化大师] 从指定的 ${bookNames.length} 个世界书中未找到任何条目。`);
            return '';
        }
        
        // 2. 根据UI中的勾选状态筛选出用户启用的条目 (对两种模式都适用)
        const enabledEntriesMap = apiSettings.enabledWorldbookEntries || {};
        userEnabledEntries = allEntries.filter(entry => {
            if (!entry.enabled) return false; // 忽略在世界书本身中被禁用的条目

            const bookConfig = enabledEntriesMap[entry.bookName];
            if (bookConfig !== undefined) {
                // 如果这本书的配置存在 (即使用户勾选后又全部取消，这里会是一个空数组 [])
                // 那么就严格按照配置来筛选。
                return bookConfig.includes(entry.uid);
            } else {
                // 如果这本书的配置完全不存在 (undefined)，说明用户从未在UI上操作过这本书。
                // 在这种情况下，为了向后兼容和默认行为，我们假定其所有条目都是启用的。
                return true;
            }
        });

        if (userEnabledEntries.length === 0) {
            console.log(`[剧情优化大师] 未找到任何可用的世界书条目。`);
            return '';
        }
        
        // --- 开始执行递归逻辑 ---
        const chatHistory = context.chat.map(message => message.mes).join('\n').toLowerCase();
        const getEntryKeywords = (entry) => [...new Set([...(entry.key || []), ...(entry.keys || [])])].map(k => k.toLowerCase());

        const blueLightEntries = userEnabledEntries.filter(entry => entry.type === 'constant');
        let pendingGreenLights = userEnabledEntries.filter(entry => entry.type !== 'constant');
        
        const triggeredEntries = new Set([...blueLightEntries]);

        while (true) {
            let hasChangedInThisPass = false;
            
            const recursionSourceContent = Array.from(triggeredEntries)
                .filter(e => !e.prevent_recursion)
                .map(e => e.content)
                .join('\n')
                .toLowerCase();
            const fullSearchText = `${chatHistory}\n${recursionSourceContent}`;

            const nextPendingGreenLights = [];
            
            for (const entry of pendingGreenLights) {
                const keywords = getEntryKeywords(entry);
                let isTriggered = false;
                if (keywords.length > 0) {
                    isTriggered = keywords.some(keyword => {
                        if (entry.exclude_recursion) {
                            return chatHistory.includes(keyword);
                        }
                        return fullSearchText.includes(keyword);
                    });
                }

                if (isTriggered) {
                    triggeredEntries.add(entry);
                    hasChangedInThisPass = true;
                } else {
                    nextPendingGreenLights.push(entry);
                }
            }
            
            if (!hasChangedInThisPass) break;
            
            pendingGreenLights = nextPendingGreenLights;
        }

        // --- 格式化并返回最终结果 ---
        const finalContent = Array.from(triggeredEntries)
            .map(entry => entry.content)
            .filter(Boolean);

        if (finalContent.length === 0) {
            return '';
        }

        const combinedContent = finalContent.join('\n\n---\n\n');
        
        const limit = apiSettings?.worldbookCharLimit || 60000;
        if (combinedContent.length > limit) {
            console.log(`[剧情优化大师] 世界书内容 (${combinedContent.length} chars) 超出限制 (${limit} chars)，将被截断。`);
            return combinedContent.substring(0, limit);
        }

        return combinedContent;

    } catch (error) {
        console.error(`[剧情优化大师] 处理递归世界书逻辑时出错:`, error);
        return '';
    }
}

// 剧情优化大师 - UI数据绑定模块
// 由Cline参照 '优化/' 插件的健壮性实践重构

import { extension_settings, getContext } from '/scripts/extensions.js';
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { eventSource, event_types } from '/script.js';
import { extensionName, defaultSettings } from '../utils/settings.js';
import { fetchModels, testApiConnection } from '../core/api.js';

/**
 * 将下划线或连字符命名的字符串转换为驼峰命名。
 * e.g., 'qrf_api_url' -> 'qrfApiUrl'
 * @param {string} str - 输入字符串。
 * @returns {string} - 驼峰格式字符串。
 */
function toCamelCase(str) {
    return str.replace(/[-_]([a-z])/g, (g) => g[1].toUpperCase());
}

/**
 * 根据选择的API模式，更新URL输入框的可见性并自动填充URL。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} apiMode - 当前选择的API模式 ('backend', 'frontend', 或 'google')。
 */
function updateApiUrlVisibility(panel, apiMode) {
    const apiUrlBlock = panel.find('#qrf_api_url_block');
    const apiUrlInput = panel.find('#qrf_api_url');
    
    if (apiMode === 'google') {
        apiUrlBlock.hide();
        // 自动为Google设置固定的URL
        const googleUrl = 'https://generativelanguage.googleapis.com';
        if (apiUrlInput.val() !== googleUrl) {
            apiUrlInput.val(googleUrl);
            // 在加载时不应自动保存，让用户的change事件去触发保存
            // saveSetting('apiUrl', googleUrl);
        }
    } else {
        apiUrlBlock.show();
    }
}

/**
 * 根据选择的世界书来源，显示或隐藏手动选择区域。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} source - 当前选择的来源 ('character' or 'manual')。
 */
function updateWorldbookSourceVisibility(panel, source) {
    const manualSelectionWrapper = panel.find('#qrf_worldbook_select_wrapper');
    if (source === 'manual') {
        manualSelectionWrapper.show();
    } else {
        manualSelectionWrapper.hide();
    }
}

/**
 * 保存单个设置项到全局配置。
 * @param {string} key - 设置项的键（驼峰式）。
 * @param {*} value - 设置项的值。
 */
// ---- 新的、支持角色卡独立配置的设置保存/加载逻辑 ----

// 需要保存到角色卡的设置项列表
const characterSpecificSettings = [
    'worldbookSource',
    'selectedWorldbooks',
    'enabledWorldbookEntries'
];

/**
 * 保存单个设置项。
 * 根据设置项的键名，决定是保存到全局设置还是当前角色卡。
 * @param {string} key - 设置项的键（驼峰式）。
 * @param {*} value - 设置项的值。
 */
async function saveSetting(key, value) {
    const character = characters[this_chid];
    if (!character) return; // 如果没有角色，则不保存

    if (characterSpecificSettings.includes(key)) {
        // --- 保存到角色卡 ---
        if (!character.data.extensions) character.data.extensions = {};
        if (!character.data.extensions[extensionName]) character.data.extensions[extensionName] = {};
        if (!character.data.extensions[extensionName].apiSettings) character.data.extensions[extensionName].apiSettings = {};
        
        character.data.extensions[extensionName].apiSettings[key] = value;
        
        // 使用SillyTavern的API来异步保存角色数据
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: character.data.extensions[extensionName] } }
                })
            });

            if (!response.ok) {
                throw new Error(`API call failed with status: ${response.status}`);
            }
            console.log(`[${extensionName}] 角色卡设置已更新: ${key} ->`, value);
        } catch (error) {
            console.error(`[${extensionName}] 保存角色数据失败:`, error);
            toastr.error('无法保存角色卡设置，请检查控制台。');
        }

    } else {
        // --- 保存到全局设置 (旧逻辑) ---
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        
        const apiSettingKeys = Object.keys(defaultSettings.apiSettings);
        if (apiSettingKeys.includes(key)) {
            if (!extension_settings[extensionName].apiSettings) {
                extension_settings[extensionName].apiSettings = {};
            }
            extension_settings[extensionName].apiSettings[key] = value;
        } else {
            extension_settings[extensionName][key] = value;
        }

        console.log(`[${extensionName}] 全局设置已更新: ${key} ->`, value);
        saveSettingsDebounced();
    }
}


/**
 * 获取合并后的设置对象。
 * 以全局设置为基础，然后用当前角色卡的设置覆盖它。
 * @returns {object} - 合并后的apiSettings对象。
 */
function getMergedApiSettings() {
    const character = characters[this_chid];
    const globalSettings = extension_settings[extensionName]?.apiSettings || defaultSettings.apiSettings;
    const characterSettings = character?.data?.extensions?.[extensionName]?.apiSettings || {};
    
    return { ...globalSettings, ...characterSettings };
}


/**
 * 绑定滑块（range input）和其数值显示的辅助函数。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} sliderId - 滑块的ID。
 * @param {string} displayId - 显示数值的span的ID。
 */
function bindSlider(panel, sliderId, displayId) {
    const slider = panel.find(sliderId);
    const display = panel.find(displayId);
    
    // 初始化显示
    display.text(slider.val());

    // 监听input事件以实时更新数值显示
    slider.on('input', function() {
        display.text($(this).val());
    });
}

// ---- 世界书逻辑 ----
async function loadWorldbooks(panel) {
    const select = panel.find('#qrf_selected_worldbooks');
    const apiSettings = getMergedApiSettings(); // 使用合并后的设置
    const currentSelection = apiSettings.selectedWorldbooks || [];
    select.empty();

    try {
        const lorebooks = await window.TavernHelper.getLorebooks();
        if (!lorebooks || lorebooks.length === 0) {
            select.append($('<option>', { value: '', text: '未找到世界书', disabled: true }));
            return;
        }

        lorebooks.forEach(name => {
            const option = $('<option>', {
                value: name,
                text: name,
                selected: currentSelection.includes(name)
            });
            select.append(option);
        });
    } catch (error) {
        console.error(`[${extensionName}] 加载世界书失败:`, error);
        toastr.error('无法加载世界书列表，请查看控制台。');
    }
}

async function loadWorldbookEntries(panel) {
    const container = panel.find('#qrf_worldbook_entry_list_container');
    const countDisplay = panel.find('#qrf_worldbook_entry_count');
    container.html('<p>加载条目中...</p>');
    countDisplay.text('');

    const apiSettings = getMergedApiSettings(); // 使用合并后的设置
    const currentSource = apiSettings.worldbookSource || 'character';
    let bookNames = [];

    if (currentSource === 'manual') {
        bookNames = apiSettings.selectedWorldbooks || [];
    } else {
        // 修复：在尝试获取角色世界书之前，先检查是否已加载角色
        if (this_chid === -1 || !characters[this_chid]) {
            container.html('<p class="notes">未选择角色。</p>');
            countDisplay.text('');
            return; // 没有角色，直接返回，不弹窗
        }
        try {
            const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
        } catch (error) {
            // 只有在确实有角色但加载失败时才报错
            console.error(`[${extensionName}] 获取角色世界书失败:`, error);
            toastr.error('获取角色世界书失败。');
            container.html('<p class="notes" style="color:red;">获取角色世界书失败。</p>');
            return;
        }
    }

    const selectedBooks = bookNames;
    let enabledEntries = apiSettings.enabledWorldbookEntries || {};
    let totalEntries = 0;
    let visibleEntries = 0;

    if (selectedBooks.length === 0) {
        container.html('<p class="notes">请选择一个或多个世界书以查看其条目。</p>');
        return;
    }

    try {
        const allEntries = [];
        for (const bookName of selectedBooks) {
            const entries = await window.TavernHelper.getLorebookEntries(bookName);
            entries.forEach(entry => {
                allEntries.push({ ...entry, bookName });
            });
        }

        container.empty();
        totalEntries = allEntries.length;

        if (totalEntries === 0) {
            container.html('<p class="notes">所选世界书没有条目。</p>');
            countDisplay.text('0 条目.');
            return;
        }

        allEntries.sort((a, b) => (a.comment || '').localeCompare(b.comment || '')).forEach(entry => {
            const entryId = `qrf-entry-${entry.bookName.replace(/[^a-zA-Z0-9]/g, '-')}-${entry.uid}`;
            // 默认情况下，新加载的条目是启用的
            const isEnabled = enabledEntries[entry.bookName]?.includes(entry.uid) ?? true;

            const item = $(`
                <div class="qrf_worldbook_entry_item">
                    <input type="checkbox" id="${entryId}" data-book="${entry.bookName}" data-uid="${entry.uid}" ${isEnabled ? 'checked' : ''}>
                    <label for="${entryId}" title="世界书: ${entry.bookName}\nUID: ${entry.uid}">${entry.comment || '无标题条目'}</label>
                </div>
            `);
            container.append(item);
        });
        
        visibleEntries = container.children().length;
        countDisplay.text(`显示 ${visibleEntries} / ${totalEntries} 条目.`);

    } catch (error) {
        console.error(`[${extensionName}] 加载世界书条目失败:`, error);
        container.html('<p class="notes" style="color:red;">加载条目失败。</p>');
    }
}


function saveEnabledEntries() {
    const panel = $('#qrf_settings_panel');
    let enabledEntries = {};

    panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').each(function() {
        const bookName = $(this).data('book');
        const uid = parseInt($(this).data('uid'));

        if (!enabledEntries[bookName]) {
            enabledEntries[bookName] = [];
        }

        if ($(this).is(':checked')) {
            enabledEntries[bookName].push(uid);
        }
    });
    
    const apiSettings = getMergedApiSettings();
    
    if (apiSettings.worldbookSource === 'manual') {
        const selectedBooks = apiSettings.selectedWorldbooks || [];
        Object.keys(enabledEntries).forEach(bookName => {
            if (!selectedBooks.includes(bookName)) {
                delete enabledEntries[bookName];
            }
        });
    }

    saveSetting('enabledWorldbookEntries', enabledEntries);
}

/**
 * 加载并填充提示词预设到下拉菜单。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function loadPromptPresets(panel) {
    const presets = extension_settings[extensionName]?.promptPresets || [];
    const select = panel.find('#qrf_prompt_preset_select');

    const currentValue = select.val();
    select.empty().append(new Option('-- 选择一个预设 --', ''));

    presets.forEach(preset => {
        select.append(new Option(preset.name, preset.name));
    });

    // 仅恢复选择，不触发change或显示按钮，这些由其他逻辑处理
    if (currentValue && presets.some(p => p.name === currentValue)) {
        select.val(currentValue);
    }
}

/**
 * 保存当前三个提示词框的内容为一个新的预设。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function saveCurrentPromptsAsPreset(panel) {
    const presetName = prompt("请输入预设名称：");
    if (!presetName) return;

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const existingPresetIndex = presets.findIndex(p => p.name === presetName);

    const newPresetData = {
        name: presetName,
        mainPrompt: panel.find('#qrf_main_prompt').val(),
        systemPrompt: panel.find('#qrf_system_prompt').val(),
        finalSystemDirective: panel.find('#qrf_final_system_directive').val(),
        rateMain: parseFloat(panel.find('#qrf_rate_main').val()),
        ratePersonal: parseFloat(panel.find('#qrf_rate_personal').val()),
        rateErotic: parseFloat(panel.find('#qrf_rate_erotic').val()),
        rateCuckold: parseFloat(panel.find('#qrf_rate_cuckold').val())
    };

    if (existingPresetIndex !== -1) {
        // 如果预设已存在，请求用户确认是否覆盖
        if (confirm(`名为 "${presetName}" 的预设已存在。是否要覆盖它？`)) {
            presets[existingPresetIndex] = newPresetData;
            toastr.success(`预设 "${presetName}" 已被覆盖。`);
        } else {
            toastr.info('保存操作已取消。');
            return;
        }
    } else {
        // 如果是新预设，则直接添加
        presets.push(newPresetData);
        toastr.success(`预设 "${presetName}" 已保存。`);
    }
    saveSetting('promptPresets', presets);

    // 刷新下拉菜单
    loadPromptPresets(panel);
    // 自动选中刚刚保存的预设，并使用setTimeout确保刷新操作在事件流末尾执行
    setTimeout(() => {
        panel.find('#qrf_prompt_preset_select').val(presetName).trigger('change');
    }, 0);
}

/**
 * 删除当前选中的提示词预设。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function deleteSelectedPreset(panel) {
    const select = panel.find('#qrf_prompt_preset_select');
    const selectedName = select.val();
    
    if (!selectedName) {
        toastr.warning('没有选择任何预设。');
        return;
    }
    
    if (!confirm(`确定要删除预设 "${selectedName}" 吗？`)) {
        return;
    }

    let presets = extension_settings[extensionName]?.promptPresets || [];
    presets = presets.filter(p => p.name !== selectedName);
    
    saveSetting('promptPresets', presets);
    toastr.success(`预设 "${selectedName}" 已被删除。`);

    // 刷新UI
    loadPromptPresets(panel);
    // 触发change以更新删除按钮状态并清除lastUsed
    select.trigger('change');
}

/**
 * 导出当前选中的提示词预设到一个JSON文件。
 */
function exportPromptPresets() {
    const select = $('#qrf_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.info('请先从下拉菜单中选择一个要导出的预设。');
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const selectedPreset = presets.find(p => p.name === selectedName);

    if (!selectedPreset) {
        toastr.error('找不到选中的预设，请刷新页面后重试。');
        return;
    }

    // 为了兼容导入逻辑，我们始终导出一个包含单个对象的数组
    const dataToExport = [selectedPreset];
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    // 使用预设名作为文件名
    a.download = `qrf_preset_${selectedName.replace(/[^a-z0-9]/gi, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`预设 "${selectedName}" 已成功导出。`);
}

/**
 * 从一个JSON文件导入提示词预设。
 * @param {File} file - 用户选择的JSON文件。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function importPromptPresets(file, panel) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedPresets = JSON.parse(e.target.result);

            if (!Array.isArray(importedPresets)) {
                throw new Error('JSON文件格式不正确，根节点必须是一个数组。');
            }

            let currentPresets = extension_settings[extensionName]?.promptPresets || [];
            let importedCount = 0;
            let overwrittenCount = 0;

            importedPresets.forEach(preset => {
                if (preset && typeof preset.name === 'string' && preset.name.length > 0) {
                    const presetData = {
                        name: preset.name,
                        mainPrompt: preset.mainPrompt || '',
                        systemPrompt: preset.systemPrompt || '',
                        finalSystemDirective: preset.finalSystemDirective || '',
                        rateMain: preset.rateMain ?? 1.0,
                        ratePersonal: preset.ratePersonal ?? 1.0,
                        rateErotic: preset.rateErotic ?? 1.0,
                        rateCuckold: preset.rateCuckold ?? 1.0
                    };

                    const existingIndex = currentPresets.findIndex(p => p.name === preset.name);

                    if (existingIndex !== -1) {
                        // 覆盖现有预设
                        currentPresets[existingIndex] = presetData;
                        overwrittenCount++;
                    } else {
                        // 添加新预设
                        currentPresets.push(presetData);
                        importedCount++;
                    }
                }
            });

            if (importedCount > 0 || overwrittenCount > 0) {
                const selectedPresetBeforeImport = panel.find('#qrf_prompt_preset_select').val();
                
                saveSetting('promptPresets', currentPresets);
                loadPromptPresets(panel);
                
                // 重新选中导入前选中的预设（如果它还存在的话），并强制触发change事件来刷新UI
                panel.find('#qrf_prompt_preset_select').val(selectedPresetBeforeImport);
                panel.find('#qrf_prompt_preset_select').trigger('change');

                let messages = [];
                if (importedCount > 0) messages.push(`成功导入 ${importedCount} 个新预设。`);
                if (overwrittenCount > 0) messages.push(`成功覆盖 ${overwrittenCount} 个同名预设。`);
                toastr.success(messages.join(' '));
            } else {
                toastr.warning('未找到可导入的有效预设。');
            }

        } catch (error) {
            console.error(`[${extensionName}] 导入预设失败:`, error);
            toastr.error(`导入失败: ${error.message}`, '错误');
        } finally {
            // 清空文件输入框的值，以便可以再次选择同一个文件
            panel.find('#qrf_preset_file_input').val('');
        }
    };
    reader.readAsText(file);
}

/**
 * 加载设置到UI界面。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function loadSettings(panel) {
    // 全局设置只用于非角色绑定的部分
    const globalSettings = extension_settings[extensionName] || defaultSettings;
    // API设置从合并后的来源获取
    const apiSettings = getMergedApiSettings();

    // 加载总开关 (全局)
    panel.find('#qrf_enabled').prop('checked', globalSettings.enabled);

    // 加载API和模型设置 (大部分是全局，但世界书相关是角色卡)
    panel.find(`input[name="qrf_api_mode"][value="${apiSettings.apiMode}"]`).prop('checked', true);
    panel.find(`input[name="qrf_worldbook_source"][value="${apiSettings.worldbookSource || 'character'}"]`).prop('checked', true);
    panel.find('#qrf_worldbook_enabled').prop('checked', apiSettings.worldbookEnabled);
    panel.find('#qrf_api_url').val(apiSettings.apiUrl);
    panel.find('#qrf_api_key').val(apiSettings.apiKey);
    
    const modelInput = panel.find('#qrf_model');
    const modelSelect = panel.find('#qrf_model_select');
    
    modelInput.val(apiSettings.model);
    modelSelect.empty();
    if (apiSettings.model) {
        modelSelect.append(new Option(apiSettings.model, apiSettings.model, true, true));
    } else {
        modelSelect.append(new Option('<-请先获取模型', '', true, true));
    }

    panel.find('#qrf_max_tokens').val(apiSettings.max_tokens);
    panel.find('#qrf_temperature').val(apiSettings.temperature);
    panel.find('#qrf_top_p').val(apiSettings.top_p);
    panel.find('#qrf_presence_penalty').val(apiSettings.presence_penalty);
    panel.find('#qrf_frequency_penalty').val(apiSettings.frequency_penalty);
    panel.find('#qrf_context_turn_count').val(apiSettings.contextTurnCount);
    panel.find('#qrf_worldbook_char_limit').val(apiSettings.worldbookCharLimit);

    // 加载匹配替换速率
    panel.find('#qrf_rate_main').val(apiSettings.rateMain);
    panel.find('#qrf_rate_personal').val(apiSettings.ratePersonal);
    panel.find('#qrf_rate_erotic').val(apiSettings.rateErotic);
    panel.find('#qrf_rate_cuckold').val(apiSettings.rateCuckold);

    // 加载提示词
    panel.find('#qrf_main_prompt').val(apiSettings.mainPrompt);
    panel.find('#qrf_system_prompt').val(apiSettings.systemPrompt);
    panel.find('#qrf_final_system_directive').val(apiSettings.finalSystemDirective);

    updateApiUrlVisibility(panel, apiSettings.apiMode);
    updateWorldbookSourceVisibility(panel, apiSettings.worldbookSource || 'character');
    
    bindSlider(panel, '#qrf_max_tokens', '#qrf_max_tokens_value');
    bindSlider(panel, '#qrf_temperature', '#qrf_temperature_value');
    bindSlider(panel, '#qrf_top_p', '#qrf_top_p_value');
    bindSlider(panel, '#qrf_presence_penalty', '#qrf_presence_penalty_value');
    bindSlider(panel, '#qrf_frequency_penalty', '#qrf_frequency_penalty_value');
    bindSlider(panel, '#qrf_context_turn_count', '#qrf_context_turn_count_value');
    bindSlider(panel, '#qrf_worldbook_char_limit', '#qrf_worldbook_char_limit_value');

    // 加载提示词预-设
    loadPromptPresets(panel);

    // 自动选择上次使用的预设 (全局)
    const lastUsedPresetName = globalSettings.lastUsedPresetName;
    if (lastUsedPresetName && (globalSettings.promptPresets || []).some(p => p.name === lastUsedPresetName)) {
        // 使用setTimeout确保下拉列表已完全填充
        setTimeout(() => {
            // 传递一个额外参数来标记这是自动触发的，以避免显示通知
            panel.find('#qrf_prompt_preset_select').val(lastUsedPresetName).trigger('change', { isAutomatic: true });
        }, 0);
    }
    
    // 加载世界书和条目 (使用角色卡设置)
    loadWorldbooks(panel).then(() => {
        loadWorldbookEntries(panel);
    });
}

/**
 * 为设置面板绑定所有事件。
 */
export function initializeBindings() {
    const panel = $('#qrf_settings_panel');
    if (panel.length === 0 || panel.data('events-bound')) {
        return;
    }
    
    loadSettings(panel);

    // 监听角色切换事件，刷新UI
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log(`[${extensionName}] 检测到角色/聊天切换，正在刷新设置UI...`);
        loadSettings(panel);
    });

    // --- 事件绑定区域 (即时保存) ---

    panel.on('change.qrf', 'input[type="checkbox"], input[type="radio"], input[type="text"], input[type="password"], textarea, select:not(#qrf_model_select, #qrf_prompt_preset_select)', function() {
        let key;
        // 修正：为世界书来源单选框硬编码正确的键名，以彻底规避任何可能的通用逻辑解析错误
        if (this.name === 'qrf_worldbook_source') {
            key = 'worldbookSource';
        } else {
            // 对所有其他控件使用标准逻辑
            key = toCamelCase((this.name || this.id).replace('qrf_', ''));
        }
        let value = this.type === 'checkbox' ? this.checked : $(this).val();

        // 确保 `selectedWorldbooks` 总是数组
        if (key === 'selectedWorldbooks' && !Array.isArray(value)) {
            value = $(this).val() || [];
        }
        
        saveSetting(key, value);

        if (this.name === 'qrf_api_mode') {
            updateApiUrlVisibility(panel, value);
        }
        if (this.name === 'qrf_worldbook_source') {
            updateWorldbookSourceVisibility(panel, value);
            // 切换模式时，重新加载条目列表。新逻辑将直接从DOM读取正确的模式。
            loadWorldbookEntries(panel);
        }
    });

    panel.on('change.qrf', '#qrf_model_select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            panel.find('#qrf_model').val(selectedModel).trigger('change');
        }
    });

    // 合并 range 和 number 类型的输入框事件处理
    panel.on('change.qrf', 'input[type="range"], input[type="number"]', function() {
        const key = toCamelCase(this.id.replace('qrf_', ''));
        const value = $(this).val();
        
        // 扩展浮点数键的列表以包括新的速率设置
        const floatKeys = [
            'temperature', 'top_p', 'presence_penalty', 'frequency_penalty',
            'rateMain', 'ratePersonal', 'rateErotic', 'rateCuckold'
        ];

        // 检查当前输入的键是否应作为浮点数处理
        const isFloat = floatKeys.includes(key);

        // 保存设置，根据类型转换数值
        if (this.value !== '') { // 避免保存空字符串
             saveSetting(key, isFloat ? parseFloat(value) : parseInt(value, 10));
        }
    });

    // --- 功能按钮事件 ---

    panel.find('#qrf_fetch_models').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true).find('i').addClass('fa-spin');
        const currentApiSettings = { ...extension_settings[extensionName].apiSettings, model: panel.find('#qrf_model').val() };
        const models = await fetchModels(currentApiSettings);
        const modelSelect = panel.find('#qrf_model_select');
        modelSelect.empty().append(new Option('请选择一个模型', ''));
        if (models && models.length > 0) {
            models.forEach(model => modelSelect.append(new Option(model.id || model.model, model.id || model.model)));
            if (currentApiSettings.model && modelSelect.find(`option[value="${currentApiSettings.model}"]`).length > 0) {
                modelSelect.val(currentApiSettings.model);
            }
        } else {
             toastr.info('未能获取到模型列表，您仍然可以手动输入模型名称。');
        }
        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    panel.find('#qrf_test_api').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true).find('i').addClass('fa-spin');
        const currentApiSettings = { ...extension_settings[extensionName].apiSettings, model: panel.find('#qrf_model').val() };
        await testApiConnection(currentApiSettings);
        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    // --- 提示词预设功能 ---

    panel.find('#qrf_import_prompt_presets').on('click', () => panel.find('#qrf_preset_file_input').click());
    panel.find('#qrf_export_prompt_presets').on('click', () => exportPromptPresets());
    panel.find('#qrf_save_prompt_preset').on('click', () => saveCurrentPromptsAsPreset(panel));
    panel.find('#qrf_delete_prompt_preset').on('click', () => deleteSelectedPreset(panel));

    panel.on('change.qrf', '#qrf_preset_file_input', function(e) {
        importPromptPresets(e.target.files[0], panel);
    });

    panel.on('change.qrf', '#qrf_prompt_preset_select', function(event, data) {
        const selectedName = $(this).val();
        const deleteBtn = panel.find('#qrf_delete_prompt_preset');
        const isAutomatic = data && data.isAutomatic; // 检查是否是自动触发
        
        // 保存当前选择
        saveSetting('lastUsedPresetName', selectedName);

        if (!selectedName) {
            deleteBtn.hide();
            // 如果取消选择，也清空上次选择的记录
            saveSetting('lastUsedPresetName', '');
            return;
        }

        const presets = extension_settings[extensionName]?.promptPresets || [];
        const selectedPreset = presets.find(p => p.name === selectedName);

        if (selectedPreset) {
            panel.find('#qrf_main_prompt').val(selectedPreset.mainPrompt).trigger('change');
            panel.find('#qrf_system_prompt').val(selectedPreset.systemPrompt).trigger('change');
            panel.find('#qrf_final_system_directive').val(selectedPreset.finalSystemDirective).trigger('change');
            
            // 加载速率设置，并为旧预设提供默认值
            panel.find('#qrf_rate_main').val(selectedPreset.rateMain ?? 1.0).trigger('change');
            panel.find('#qrf_rate_personal').val(selectedPreset.ratePersonal ?? 1.0).trigger('change');
            panel.find('#qrf_rate_erotic').val(selectedPreset.rateErotic ?? 1.0).trigger('change');
            panel.find('#qrf_rate_cuckold').val(selectedPreset.rateCuckold ?? 1.0).trigger('change');

            // 只有在非自动触发时才显示通知
            if (!isAutomatic) {
                toastr.success(`已加载预设 "${selectedName}"。`);
            }
            deleteBtn.show();
        } else {
            deleteBtn.hide();
        }
    });

    // --- 重置按钮事件 ---

    panel.find('#qrf_reset_main_prompt').on('click', function() {
        panel.find('#qrf_main_prompt').val(defaultSettings.apiSettings.mainPrompt).trigger('change');
        toastr.success('主提示词已重置为默认值。');
    });

    panel.find('#qrf_reset_system_prompt').on('click', function() {
        panel.find('#qrf_system_prompt').val(defaultSettings.apiSettings.systemPrompt).trigger('change');
        toastr.success('拦截任务指令已重置为默认值。');
    });

    panel.find('#qrf_reset_final_system_directive').on('click', function() {
        panel.find('#qrf_final_system_directive').val(defaultSettings.apiSettings.finalSystemDirective).trigger('change');
        toastr.success('最终注入指令已重置为默认值。');
    });

    panel.data('events-bound', true);
    console.log(`[${extensionName}] UI事件已成功绑定，自动保存已激活。`);

    // ---- 世界书事件绑定 ----
    panel.on('click.qrf', '#qrf_refresh_worldbooks', () => {
        loadWorldbooks(panel).then(() => {
            loadWorldbookEntries(panel);
        });
    });

    panel.on('change.qrf', '#qrf_selected_worldbooks', async function() {
        const selected = $(this).val() || [];
        // 强制等待设置保存完成，再执行加载，避免竞态条件
        await saveSetting('selectedWorldbooks', selected);
        await loadWorldbookEntries(panel);
    });

    panel.on('change.qrf', '#qrf_worldbook_entry_list_container input[type="checkbox"]', () => {
        saveEnabledEntries();
    });

    panel.on('click.qrf', '#qrf_worldbook_entry_select_all', () => {
        panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').prop('checked', true);
        saveEnabledEntries();
    });

    panel.on('click.qrf', '#qrf_worldbook_entry_deselect_all', () => {
        panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').prop('checked', false);
        saveEnabledEntries();
    });
}

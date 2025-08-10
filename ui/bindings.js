// 剧情优化大师 - UI数据绑定模块
// 由Cline参照 '优化/' 插件的健壮性实践重构

import { extension_settings } from '/scripts/extensions.js';
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
 * 保存单个设置项到全局配置。
 * @param {string} key - 设置项的键（驼峰式）。
 * @param {*} value - 设置项的值。
 */
function saveSetting(key, value) {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    
    // API相关的设置存储在apiSettings对象中
    const apiSettingKeys = Object.keys(defaultSettings.apiSettings);
    if (apiSettingKeys.includes(key)) {
        if (!extension_settings[extensionName].apiSettings) {
            extension_settings[extensionName].apiSettings = {};
        }
        extension_settings[extensionName].apiSettings[key] = value;
    } else {
        extension_settings[extensionName][key] = value;
    }

    // 直接保存设置，不使用防抖
    // 在SillyTavern的新版本中，extension_settings本身就是代理对象，赋值即保存。
    // 如果在旧版本，则需要手动调用 saveSettings()。为兼容起见，我们假设它会自动保存。
    console.log(`[${extensionName}] 设置已更新: ${key} ->`, value);
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

/**
 * 加载设置到UI界面。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function loadSettings(panel) {
    const settings = extension_settings[extensionName];
    const apiSettings = settings.apiSettings || {};

    // 加载总开关
    panel.find('#qrf_enabled').prop('checked', settings.enabled);

    // 加载API和模型设置
    panel.find(`input[name="qrf_api_mode"][value="${apiSettings.apiMode || 'backend'}"]`).prop('checked', true);
    panel.find('#qrf_worldbook_enabled').prop('checked', apiSettings.worldbookEnabled);
    panel.find('#qrf_api_url').val(apiSettings.apiUrl);
    panel.find('#qrf_api_key').val(apiSettings.apiKey);
    
    // 加载模型输入框和下拉框
    const modelInput = panel.find('#qrf_model');
    const modelSelect = panel.find('#qrf_model_select');
    
    modelInput.val(apiSettings.model || '');
    modelSelect.empty();
    if (apiSettings.model) {
        // 将当前模型作为唯一的选项添加到下拉列表中，并选中它
        modelSelect.append(new Option(apiSettings.model, apiSettings.model, true, true));
    } else {
        modelSelect.append(new Option('<-请先获取模型', '', true, true));
    }

    panel.find('#qrf_max_tokens').val(apiSettings.max_tokens);
    panel.find('#qrf_temperature').val(apiSettings.temperature);
    panel.find('#qrf_context_turn_count').val(apiSettings.contextTurnCount);

    // 加载提示词
    panel.find('#qrf_main_prompt').val(apiSettings.mainPrompt);
    panel.find('#qrf_system_prompt').val(apiSettings.systemPrompt);
    panel.find('#qrf_final_system_directive').val(apiSettings.finalSystemDirective);
    
    // 绑定滑块的数值显示
    bindSlider(panel, '#qrf_max_tokens', '#qrf_max_tokens_value');
    bindSlider(panel, '#qrf_temperature', '#qrf_temperature_value');
    bindSlider(panel, '#qrf_context_turn_count', '#qrf_context_turn_count_value');
}

/**
 * 为设置面板绑定所有事件。
 */
export function initializeBindings() {
    const panel = $('#qrf_settings_panel');
    if (panel.length === 0 || panel.data('events-bound')) {
        return;
    }
    
    // 加载初始设置
    loadSettings(panel);

    // --- 事件绑定区域 (即时保存) ---

    // 1. 复选框 (Checkbox)
    panel.on('change.qrf', 'input[type="checkbox"]', function() {
        const key = toCamelCase(this.id.replace('qrf_', ''));
        saveSetting(key, this.checked);
    });

    // 2. 单选框 (Radio)
    panel.on('change.qrf', 'input[type="radio"]', function() {
        const key = toCamelCase(this.name.replace('qrf_', ''));
        const value = $(`input[name="${this.name}"]:checked`).val();
        saveSetting(key, value);
    });

    // 3. 文本输入框和密码框 (Text, Password)
    panel.on('change.qrf', 'input[type="text"], input[type="password"]', function() {
        const key = toCamelCase(this.id.replace('qrf_', ''));
        saveSetting(key, $(this).val());
    });
    
    // 4. 文本域 (Textarea)
    panel.on('change.qrf', 'textarea', function() {
        const key = toCamelCase(this.id.replace('qrf_', ''));
        saveSetting(key, $(this).val());
    });

    // 5. 模型下拉选择框 (Select for model)
    panel.on('change.qrf', '#qrf_model_select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            // 将选择的值同步到主输入框，并触发其change事件来保存
            panel.find('#qrf_model').val(selectedModel).trigger('change');
        }
    });

    // 绑定其他所有常规下拉框
    panel.on('change.qrf', 'select:not(#qrf_model_select)', function() {
        const key = toCamelCase(this.id.replace('qrf_', ''));
        saveSetting(key, $(this).val());
    });

    // 6. 滑块 (Range)
    panel.on('change.qrf', 'input[type="range"]', function() {
        const key = toCamelCase(this.id.replace('qrf_', ''));
        const value = $(this).val();
        saveSetting(key, this.id.includes('temperature') ? parseFloat(value) : parseInt(value, 10));
    });

    // --- 功能按钮事件 ---

    // 获取模型列表
    panel.find('#qrf_fetch_models').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true).find('i').addClass('fa-spin');

        const currentApiSettings = {
            apiUrl: panel.find('#qrf_api_url').val(),
            apiKey: panel.find('#qrf_api_key').val(),
            apiMode: panel.find('input[name="qrf_api_mode"]:checked').val(),
        };

        const models = await fetchModels(currentApiSettings);

        const modelSelect = panel.find('#qrf_model_select');
        const modelInput = panel.find('#qrf_model');
        const currentModel = modelInput.val(); // 以输入框的值为准

        modelSelect.empty();
        modelSelect.append(new Option('请选择一个模型', ''));

        if (models && models.length > 0) {
            models.forEach(model => {
                const modelId = model.id || model.model;
                if (modelId) {
                    modelSelect.append(new Option(modelId, modelId));
                }
            });

            // 获取后，尝试在新的列表中选中当前模型
            if (currentModel && modelSelect.find(`option[value="${currentModel}"]`).length > 0) {
                modelSelect.val(currentModel);
            }
        } else {
             toastr.info('未能获取到模型列表，您仍然可以手动输入模型名称。');
        }
        
        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    // 测试API连接
    panel.find('#qrf_test_api').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true).find('i').addClass('fa-spin');

        const currentApiSettings = {
            apiUrl: panel.find('#qrf_api_url').val(),
            apiKey: panel.find('#qrf_api_key').val(),
            apiMode: panel.find('input[name="qrf_api_mode"]:checked').val(),
            model: panel.find('#qrf_model').val(),
        };

        await testApiConnection(currentApiSettings);

        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    // --- 重置按钮事件 ---

    // 重置主提示词
    panel.find('#qrf_reset_main_prompt').on('click', function() {
        const defaultValue = defaultSettings.apiSettings.mainPrompt;
        panel.find('#qrf_main_prompt').val(defaultValue).trigger('change');
        toastr.success('主提示词已重置为默认值。');
    });

    // 重置拦截任务指令
    panel.find('#qrf_reset_system_prompt').on('click', function() {
        const defaultValue = defaultSettings.apiSettings.systemPrompt;
        panel.find('#qrf_system_prompt').val(defaultValue).trigger('change');
        toastr.success('拦截任务指令已重置为默认值。');
    });

    // 重置最终注入指令
    panel.find('#qrf_reset_final_system_directive').on('click', function() {
        const defaultValue = defaultSettings.apiSettings.finalSystemDirective;
        panel.find('#qrf_final_system_directive').val(defaultValue).trigger('change');
        toastr.success('最终注入指令已重置为默认值。');
    });

    panel.data('events-bound', true);
    console.log(`[${extensionName}] UI事件已成功绑定，自动保存已激活。`);
}

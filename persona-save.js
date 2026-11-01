// Save by the current avatar ID; verify the individual backend record, since
// saveSettings() can return true while reporting per-persona persistence errors.
export function createPersonaSaver({ getPowerUser, getAvatarId, readPersonas, saveSettings, updateInput }) {
    let saving = false;
    return async function savePersona(description) {
        if (saving) throw new Error('人设正在保存，请稍候');
        if (typeof description !== 'string' || !description.trim()) throw new Error('人设内容为空');
        saving = true;
        try {
            const id = getAvatarId();
            if (!id) throw new Error('未选中用户人设，请先选择人设');
            const snapshot = await readPersonas();
            const record = snapshot?.[id];
            if (!record || typeof record.name !== 'string') throw new Error('当前用户人设不存在，请重新选择后保存');
            if (getAvatarId() !== id) throw new Error('用户人设已切换，请重新确认保存目标');
            const power = getPowerUser();
            if (!power) throw new Error('用户人设设置尚未加载');
            power.personas ??= {};
            power.persona_descriptions ??= {};
            const existing = power.persona_descriptions[id];
            power.personas[id] = record.name;
            power.persona_descriptions[id] = {
                ...(record.description || {}), ...(existing || {}), description,
            };
            // Remove only the exact invalid shape left by this extension's old
            // saver: a nonexistent name-key with a multiline body and no descriptor.
            const name = record.name;
            if (name !== id && !Object.hasOwn(snapshot, name)
                && !Object.hasOwn(power.persona_descriptions, name)
                && power.persona_selected === name
                && typeof power.personas[name] === 'string'
                && /[\r\n]/.test(power.personas[name])) {
                delete power.personas[name];
                delete power.persona_selected;
            }
            power.persona_description = description;
            updateInput?.(description);
            const saved = await saveSettings();
            if (saved === false) throw new Error('设置保存未成功，请保留结果并重试');
            const confirmed = await readPersonas();
            if (confirmed?.[id]?.description?.description !== description) {
                throw new Error('后端人设内容核验失败，未确认保存成功；请保留结果并重试');
            }
            return { id, name };
        } finally {
            saving = false;
        }
    };
}

let runtime;
export async function saveCurrentPersona(description) {
    if (!runtime) {
        const [script, personas, bridge] = await Promise.all([
            import('/script.js'), import('/scripts/personas.js'), import('/tauri-bridge.js'),
        ]);
        if (typeof script.saveSettings !== 'function') throw new Error('当前酒馆不支持可核验的人设保存');
        runtime = createPersonaSaver({
            getPowerUser: () => window.SillyTavern.getContext().powerUserSettings,
            getAvatarId: () => personas.user_avatar,
            readPersonas: () => bridge.invoke('get_personas'),
            saveSettings: () => script.saveSettings(),
            // No input/change events: those schedule a second, unverified save.
            updateInput: value => { const input = document.querySelector('#persona_description'); if (input) input.value = value; },
        });
    }
    return runtime(description);
}

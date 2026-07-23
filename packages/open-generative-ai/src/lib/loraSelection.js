export function normalizeLoraWeight(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(-10, Math.min(10, parsed));
}

export function toggleLoraSelection(selection, lora) {
    const current = Array.isArray(selection) ? selection : [];
    const id = String(lora?.id || '').trim();
    if (!id) return current;
    if (current.some(item => item.id === id)) {
        return current.filter(item => item.id !== id);
    }
    return [
        ...current,
        {
            id,
            name: String(lora.name || id),
            displayName: String(lora.displayName || lora.name || id),
            previewUrl: String(lora.previewUrl || ''),
            strength: normalizeLoraWeight(lora.defaultWeight, 1),
        },
    ];
}

export function updateLoraStrength(selection, id, value) {
    return (Array.isArray(selection) ? selection : []).map(item => (
        item.id === id
            ? { ...item, strength: normalizeLoraWeight(value, item.strength ?? 1) }
            : item
    ));
}

export function loraGenerationPayload(selection) {
    return (Array.isArray(selection) ? selection : []).map(item => ({
        id: item.id,
        strength: normalizeLoraWeight(item.strength, 1),
    }));
}

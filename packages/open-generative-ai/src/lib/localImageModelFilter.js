export function localModelSupportsImageInput(model) {
    return Boolean(
        model?.supportsImage
        || model?.requires?.image
        || model?.accepts?.some(field => ['image_path', 'image_base64', 'image_url'].includes(field))
    );
}

export function visibleLocalImageModels(models, hasImage) {
    return hasImage ? models.filter(localModelSupportsImageInput) : [...models];
}

// Some local workflows never wire a negative encoder (the Krea 2 identity graph
// hardcodes it empty), so offering the field there is a lie. A model that declares
// `accepts` is taken at its word; one that declares nothing keeps the field, since
// silence is not proof that it is ignored.
export function localModelSupportsNegativePrompt(model) {
    const accepts = model?.accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) return true;
    return accepts.includes('negative_prompt');
}

// ComfyUI skips the uncond pass entirely at CFG 1.0 (comfy/samplers.py), so even a
// wired negative prompt does nothing until guidance goes above 1.
export function negativePromptNeedsGuidance(guidanceScale) {
    const value = Number(guidanceScale);
    return Number.isFinite(value) && value <= 1;
}

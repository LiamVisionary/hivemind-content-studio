// A lane takes references under one of two grammars. `image_path`/`image_base64`
// /`image_url` is the single-source shape (Klein's edit, Krea 2's identity);
// `reference_images` is the ordered multi-slot shape the H3 lanes speak, where
// position IS the label (<Picture 1>..<Picture N>). Both mean the UploadPicker
// is live. Keep this list in step with toHostedImageModel's `supportsImage` in
// hosted-local-models.js, which derives the same capability server-side.
const IMAGE_INPUT_FIELDS = ['image_path', 'image_base64', 'image_url', 'reference_images'];

export function localModelSupportsImageInput(model) {
    return Boolean(
        model?.supportsImage
        || model?.requires?.image
        || model?.accepts?.some(field => IMAGE_INPUT_FIELDS.includes(field))
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

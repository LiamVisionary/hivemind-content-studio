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

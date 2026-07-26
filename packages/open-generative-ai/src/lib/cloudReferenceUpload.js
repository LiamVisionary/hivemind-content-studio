// Using a locally-held reference image with a CLOUD model.
//
// Cloud (MUAPI) models fetch references BY URL, so a reference that only exists on
// this Mac cannot be handed over as-is: a saved studio reference is a same-origin
// path to a vault-sealed envelope, and an inline data URL is not a URL the provider
// can fetch. Making one usable means decrypting it in the browser and uploading a
// PLAINTEXT copy to MUAPI's CDN — those bytes leave the machine, which is why the
// studio asks the owner before doing it (referencesNeedingApproval gates the call).
//
// Local workflows never come through here; they take the decrypted bytes inline
// (referenceToLocalImageInput) and nothing leaves the Mac.
import { mediaSourceToDataUrl } from './hivemindStudio.js';
import { muapi } from './muapi.js';

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

export function isCloudReadyReference(source) {
    return /^https?:\/\//i.test(String(source || '').trim());
}

// The picked references that would have to be uploaded, minus the ones the owner
// already approved in this session — those bytes have already left the machine, so
// re-asking for the same image protects nothing.
export function referencesNeedingApproval(sources, approved) {
    const pending = [];
    for (const raw of Array.isArray(sources) ? sources : []) {
        const source = String(raw || '').trim();
        if (!source || isCloudReadyReference(source)) continue;
        if (approved?.has?.(source) || pending.includes(source)) continue;
        pending.push(source);
    }
    return pending;
}

async function dataUrlToFile(dataUrl, index) {
    const blob = await (await fetch(dataUrl)).blob();
    const type = blob.type || 'image/png';
    return new File([blob], `reference-${index + 1}.${EXTENSIONS[type.toLowerCase()] || 'png'}`, { type });
}

// Resolve every picked reference to a URL the cloud provider can fetch. Already
// public URLs pass through untouched; anything else is decrypted in-browser and
// uploaded once, with the result cached per source so a re-generate does not send
// the same image again.
export async function resolveCloudReferences(sources, { cache, upload = (file) => muapi.uploadFile(file) } = {}) {
    const resolved = [];
    for (const [index, raw] of (Array.isArray(sources) ? sources : []).entries()) {
        const source = String(raw || '').trim();
        if (!source) continue;
        if (isCloudReadyReference(source)) {
            resolved.push(source);
            continue;
        }
        const cached = cache?.get?.(source);
        if (cached) {
            resolved.push(cached);
            continue;
        }
        const dataUrl = await mediaSourceToDataUrl(source, 'image');
        if (!dataUrl) throw new Error('Could not read the selected reference image.');
        const uploaded = String(await upload(await dataUrlToFile(dataUrl, index)) || '');
        if (!isCloudReadyReference(uploaded)) {
            throw new Error('The reference upload did not return a usable URL.');
        }
        cache?.set?.(source, uploaded);
        resolved.push(uploaded);
    }
    return resolved;
}

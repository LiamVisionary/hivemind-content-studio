import { isHivemindStudioEnabled } from './hivemindStudio.js';
import { getComposerUploads, setComposerUploads } from './composerState.js';

const STORAGE_KEY = 'muapi_uploads';
const MAX_UPLOADS = 20;

function studioMode() {
    try {
        return isHivemindStudioEnabled();
    } catch {
        return false;
    }
}

export function isPersistentUploadReference(value) {
    const url = String(value || '').trim().toLowerCase();
    return Boolean(url) && !url.startsWith('blob:') && !url.startsWith('data:');
}

export function getUploadHistory() {
    // Studio mode: the reference grid lives in the encrypted, owner-gated
    // composer state (hydrated at studio boot), never in browser storage.
    if (studioMode()) {
        return getComposerUploads().filter((entry) => isPersistentUploadReference(entry?.uploadedUrl));
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        const history = Array.isArray(parsed) ? parsed : [];
        const persistent = history.filter((entry) => isPersistentUploadReference(entry?.uploadedUrl));
        if (persistent.length !== history.length) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(persistent.slice(0, MAX_UPLOADS)));
        }
        return persistent;
    } catch {
        return [];
    }
}

export function saveUpload({ id, name, uploadedUrl, thumbnail, timestamp }) {
    const history = getUploadHistory();
    history.unshift({ id, name, uploadedUrl, thumbnail, timestamp });
    if (studioMode()) {
        setComposerUploads(history.slice(0, MAX_UPLOADS));
        return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_UPLOADS)));
}

export function removeUpload(id) {
    const history = getUploadHistory().filter(e => e.id !== id);
    if (studioMode()) {
        setComposerUploads(history);
        return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

/**
 * Generates a square 80×80 base64 JPEG thumbnail from a File.
 * @param {File} file
 * @returns {Promise<string|null>}
 */
export async function generateThumbnail(file) {
    return new Promise((resolve) => {
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const SIZE = 80;
            const canvas = document.createElement('canvas');
            canvas.width = SIZE;
            canvas.height = SIZE;
            const ctx = canvas.getContext('2d');
            // Center-crop to square
            const size = Math.min(img.width, img.height);
            const sx = (img.width - size) / 2;
            const sy = (img.height - size) / 2;
            ctx.drawImage(img, sx, sy, size, size, 0, 0, SIZE, SIZE);
            URL.revokeObjectURL(objectUrl);
            resolve(canvas.toDataURL('image/jpeg', 0.6));
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(null);
        };
        img.src = objectUrl;
    });
}

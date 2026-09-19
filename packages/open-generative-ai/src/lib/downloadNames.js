// Download filenames derived from the model that actually produced the media.
//
// Downloads used to be named after the app/provider rather than the model: images
// were hardcoded to `muapi-<id>.jpg` (wrong for every LOCAL generation — nothing
// went through MUAPI) and videos to `video-<id>.mp4` (no model at all). Both
// studios now build their names here so a saved file says what made it.
//
// History entries carry a `model` in several shapes, all normalized here:
//   'local:comfy-auto-wai-anima-native-06b'  (local image workflow)
//   'hivemind-media:ltx23-eros-fast'         (local Media Studio video, url-encoded)
//   'wan2gp:flux-dev'                        (wan2gp local)
//   'seedance-v2.0-t2v'                      (cloud model id)
//   'Anima · upscaled (max)'                 (decorated label from an upscale)

const ROUTING_PREFIXES = ['hivemind-media:', 'hivemind-video:', 'local:', 'wan2gp:', 'comfy-auto-'];

// Filename-safe, lowercase, no leading/trailing separators. Collapses the runs of
// punctuation that decorated labels ("Anima · upscaled (max)") introduce.
function slugifyModel(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  // A url-encoded workflow id (hivemind-media:) decodes to a plain id.
  try { text = decodeURIComponent(text); } catch { /* keep the raw text */ }
  // Strip routing/provider prefixes, longest-first and repeatedly, so a stacked
  // id like 'local:comfy-auto-foo' reduces to the model name itself.
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of ROUTING_PREFIXES) {
      if (text.toLowerCase().startsWith(prefix)) {
        text = text.slice(prefix.length);
        changed = true;
      }
    }
  }
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug;
}

// `<model>-<id>.<ext>`, falling back to the media kind when the model is unknown
// (a legacy history entry) so a download is never named after the app instead.
export function mediaDownloadName(model, id, extension, { fallback = 'generation' } = {}) {
  const slug = slugifyModel(model) || fallback;
  const suffix = String(id ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const ext = String(extension || '').replace(/^\.+/, '');
  return `${slug}${suffix ? `-${suffix}` : ''}${ext ? `.${ext}` : ''}`;
}

export function imageDownloadName(model, id, extension = 'jpg') {
  return mediaDownloadName(model, id, extension, { fallback: 'image' });
}

export function videoDownloadName(model, id, extension = 'mp4') {
  return mediaDownloadName(model, id, extension, { fallback: 'video' });
}

export { slugifyModel };

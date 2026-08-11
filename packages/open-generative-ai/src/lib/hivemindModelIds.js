// The shape of a local Media Studio video model id, and nothing else.
//
// A leaf module on purpose: hivemindStudio.js (the registry/context loader) and
// videoTasks.js (the task/family rules) both need to read the id format, and
// hivemindStudio.js needs videoTasks.js's family predicates in return. Keeping
// the format here breaks that cycle instead of relying on ESM's tolerance for
// one, and it means the prefix is written down exactly once.
//
// Format: `hivemind-media:` + the URL-encoded workflow-registry id.

const HIVE_VIDEO_PREFIX = 'hivemind-media:';

export function hivemindVideoModelId(workflowId) {
    return `${HIVE_VIDEO_PREFIX}${encodeURIComponent(workflowId)}`;
}

export function isHivemindVideoModelId(id) {
    return typeof id === 'string' && id.startsWith(HIVE_VIDEO_PREFIX);
}

export function workflowIdFromHivemindModelId(id) {
    return decodeURIComponent(String(id || '').slice(HIVE_VIDEO_PREFIX.length));
}

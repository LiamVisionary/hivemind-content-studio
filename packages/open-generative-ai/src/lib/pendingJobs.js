import { isHivemindStudioEnabled } from './hivemindStudio.js';

const PENDING_KEY = 'muapi_pending_jobs';

function pendingStorage() {
    if (!isHivemindStudioEnabled()) return localStorage;
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    return sessionStorage;
}

export function savePendingJob(job) {
    try {
        const jobs = getAllPendingJobs().filter(j => j.requestId !== job.requestId);
        jobs.push(job);
        pendingStorage().setItem(PENDING_KEY, JSON.stringify(jobs));
    } catch (e) {
        console.warn('[PendingJobs] Failed to save:', e);
    }
}

export function removePendingJob(requestId) {
    try {
        const jobs = getAllPendingJobs().filter(j => j.requestId !== requestId);
        pendingStorage().setItem(PENDING_KEY, JSON.stringify(jobs));
    } catch (e) {
        console.warn('[PendingJobs] Failed to remove:', e);
    }
}

export function getPendingJobs(studioType) {
    const all = getAllPendingJobs();
    return studioType ? all.filter(j => j.studioType === studioType) : all;
}

/**
 * Which of `jobs` this studio tab is responsible for resuming.
 *
 * Every tab of a studio shares this one registry, so ownership has to be written
 * down: a job carries the id of the tab that started it (`tabId`), and that tab —
 * and only that tab — restores its live progress. Without that, the first tab
 * grabbed whichever job it found and every other tab's render came back looking
 * dead (its result then landed in the wrong tab's canvas and history).
 *
 * The PRIMARY tab additionally adopts the ORPHANS: jobs saved before `tabId`
 * existed, and jobs whose tab is gone — closed while it was rendering, or beyond
 * the cap on how many tabs a reload restores. Somebody has to finish those or
 * they poll forever in storage and their clip only ever appears in History.
 *
 * `openTabIds` is the strip as it stands; omit it and only null-`tabId` jobs
 * count as orphaned.
 */
export function pendingJobsForTab(jobs, tabId, { primary = false, openTabIds = null } = {}) {
    const own = Number.isSafeInteger(Number(tabId)) ? Number(tabId) : null;
    const open = Array.isArray(openTabIds) ? new Set(openTabIds.map(Number)) : null;
    const orphaned = (job) => {
        const owner = Number.isSafeInteger(Number(job?.tabId)) ? Number(job.tabId) : null;
        if (owner == null) return true;
        return open ? !open.has(owner) : false;
    };
    return (Array.isArray(jobs) ? jobs : []).filter((job) => {
        const owner = Number.isSafeInteger(Number(job?.tabId)) ? Number(job.tabId) : null;
        if (own != null && owner === own) return true;
        return primary && orphaned(job);
    });
}

function getAllPendingJobs() {
    try {
        const value = JSON.parse(pendingStorage().getItem(PENDING_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

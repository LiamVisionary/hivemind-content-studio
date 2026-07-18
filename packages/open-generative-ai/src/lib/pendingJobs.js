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

function getAllPendingJobs() {
    try {
        const value = JSON.parse(pendingStorage().getItem(PENDING_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

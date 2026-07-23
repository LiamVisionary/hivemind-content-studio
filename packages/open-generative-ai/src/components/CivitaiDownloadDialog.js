import { downloadCivitaiLora, formatDownloadBytes } from '../lib/civitaiDownload.js';

export function createCivitaiDownloadDialog({ api, onComplete } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'm-auto w-[calc(100%_-_2rem)] max-w-lg overflow-visible bg-transparent p-0 text-white backdrop:bg-black/80';
    dialog.setAttribute('aria-labelledby', 'civitai-download-title');
    dialog.innerHTML = `
        <div class="rounded-2xl border border-white/10 bg-[#111] p-5 shadow-3xl">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <h3 id="civitai-download-title" class="text-base font-black text-white">Download LoRA</h3>
                    <p class="mt-1 text-xs text-muted">Civitai</p>
                </div>
                <button type="button" data-close title="Close" aria-label="Close" class="grid h-9 w-9 place-items-center rounded-lg bg-white/5 text-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white">×</button>
            </div>
            <form class="mt-5 flex flex-col gap-4">
                <label class="flex flex-col gap-2">
                    <span class="text-xs font-bold uppercase text-secondary">Civitai LoRA URL</span>
                    <input type="url" required inputmode="url" autocomplete="off" placeholder="https://civitai.com/models/…" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-muted focus:border-primary/50 focus:outline-none">
                </label>
                <div data-status class="hidden rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-xs text-muted" role="status" aria-live="polite"></div>
                <div data-progress-wrap class="hidden h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div data-progress class="h-full rounded-full bg-primary transition-[width] duration-300" style="width:0%"></div>
                </div>
                <div class="flex justify-end gap-2">
                    <button type="button" data-cancel class="rounded-lg bg-white/5 px-4 py-2 text-xs font-bold text-secondary transition-colors hover:bg-white/10">Cancel</button>
                    <button type="submit" class="rounded-lg bg-primary px-4 py-2 text-xs font-black text-black transition-opacity hover:opacity-90">Download</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form');
    const input = dialog.querySelector('input');
    const submit = dialog.querySelector('button[type="submit"]');
    const status = dialog.querySelector('[data-status]');
    const progressWrap = dialog.querySelector('[data-progress-wrap]');
    const progress = dialog.querySelector('[data-progress]');
    let running = false;

    const close = () => dialog.close();
    dialog.querySelector('[data-close]').onclick = close;
    dialog.querySelector('[data-cancel]').onclick = close;

    const renderJob = (job) => {
        const percent = Math.max(0, Math.min(100, Number(job?.percent) || 0));
        const done = formatDownloadBytes(job?.downloaded_bytes);
        const total = formatDownloadBytes(job?.total_bytes);
        status.classList.remove('hidden');
        progressWrap.classList.remove('hidden');
        progress.style.width = `${percent}%`;
        if (job?.status === 'success') {
            const filename = job.result?.filename || 'LoRA';
            const base = job.result?.baseModel ? ` · ${job.result.baseModel}` : '';
            status.textContent = `${filename} downloaded${base}`;
        } else if (job?.status === 'error') {
            status.textContent = job.error || 'Download failed.';
        } else {
            status.textContent = job?.total_bytes
                ? `Downloading ${percent}% · ${done} / ${total}`
                : 'Preparing download…';
        }
    };

    form.onsubmit = async (event) => {
        event.preventDefault();
        if (running) return;
        running = true;
        submit.disabled = true;
        submit.classList.add('opacity-50');
        status.classList.remove('hidden');
        status.textContent = 'Resolving Civitai URL…';
        progressWrap.classList.remove('hidden');
        progress.style.width = '0%';
        try {
            const job = await downloadCivitaiLora(api, input.value, { onUpdate: renderJob });
            await onComplete?.(job);
        } catch (error) {
            status.textContent = error.message;
            status.classList.remove('hidden');
            progress.classList.remove('bg-primary');
            progress.classList.add('bg-red-400');
        } finally {
            running = false;
            submit.disabled = false;
            submit.classList.remove('opacity-50');
        }
    };

    return {
        element: dialog,
        open() {
            if (!running) {
                status.classList.add('hidden');
                progressWrap.classList.add('hidden');
                progress.classList.remove('bg-red-400');
                progress.classList.add('bg-primary');
                progress.style.width = '0%';
            }
            dialog.showModal();
            setTimeout(() => input.focus(), 0);
        },
        close,
    };
}

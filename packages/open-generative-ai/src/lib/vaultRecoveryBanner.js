// One-time recovery-key display. When the E2E vault is first created in this
// browser, e2eVault emits the recovery key exactly once (the server never has
// it). This shows a blocking modal so the owner can save it before it is gone.

const ACK_KEY = 'hivemind.vault.recoveryAck';

function alreadyAcknowledged() {
    try { return localStorage.getItem(ACK_KEY) === '1'; } catch { return false; }
}

function renderModal(recoveryKey) {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(4,6,10,.86);backdrop-filter:blur(6px);padding:24px';
    overlay.innerHTML = `
        <div style="width:min(520px,100%);border:1px solid #34362f;border-radius:14px;background:#14161b;color:#f4f5f2;padding:26px;box-shadow:0 30px 90px rgba(0,0,0,.5);font-family:Inter,system-ui,sans-serif">
            <div style="font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#a8ef3f">Save your recovery key</div>
            <h2 style="margin:8px 0 10px;font-size:22px">This is shown once</h2>
            <p style="margin:0 0 16px;line-height:1.55;color:#c3c6bd">Your images, videos, and prompts are now encrypted so only this browser (with your password) can read them. If you ever forget your password, this recovery key is the <strong>only</strong> way back in. We can't recover it for you — store it somewhere safe.</p>
            <code data-recovery style="display:block;user-select:all;word-break:break-all;background:#0c0e12;border:1px solid #2c2f27;border-radius:8px;padding:14px;font-size:15px;letter-spacing:.04em;color:#a8ef3f"></code>
            <div style="display:flex;gap:10px;margin-top:16px">
                <button data-copy type="button" style="flex:1;min-height:42px;border:1px solid #42443b;border-radius:8px;background:#1c1f18;color:#fff;font:600 13px inherit;cursor:pointer">Copy</button>
                <button data-ack type="button" disabled style="flex:1;min-height:42px;border:0;border-radius:8px;background:#3a4030;color:#8b8f83;font:700 13px inherit;cursor:not-allowed">Saved it — continue</button>
            </div>
            <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px;color:#b8baaf"><input data-confirm type="checkbox"> I've stored this recovery key somewhere safe</label>
        </div>`;

    overlay.querySelector('[data-recovery]').textContent = recoveryKey;
    const ack = overlay.querySelector('[data-ack]');
    overlay.querySelector('[data-confirm]').addEventListener('change', (event) => {
        ack.disabled = !event.target.checked;
        ack.style.cssText = event.target.checked
            ? 'flex:1;min-height:42px;border:0;border-radius:8px;background:#a8ef3f;color:#141711;font:700 13px inherit;cursor:pointer'
            : 'flex:1;min-height:42px;border:0;border-radius:8px;background:#3a4030;color:#8b8f83;font:700 13px inherit;cursor:not-allowed';
    });
    overlay.querySelector('[data-copy]').addEventListener('click', () => {
        try { navigator.clipboard?.writeText(recoveryKey); } catch { /* clipboard blocked */ }
    });
    ack.addEventListener('click', () => {
        if (ack.disabled) return;
        try { localStorage.setItem(ACK_KEY, '1'); } catch { /* quota */ }
        overlay.remove();
    });
    document.body.appendChild(overlay);
}

export function installVaultRecoveryBanner() {
    if (typeof window === 'undefined') return;
    window.addEventListener('hivemind-vault-recovery-key', (event) => {
        const recoveryKey = event?.detail?.recoveryKey;
        if (recoveryKey && !alreadyAcknowledged()) renderModal(recoveryKey);
    });
}

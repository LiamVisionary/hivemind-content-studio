const servicesEl = document.querySelector('#services');
const repositoriesEl = document.querySelector('#repositories');
const summaryEl = document.querySelector('#summary');
const logEl = document.querySelector('#log');

function log(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  logEl.textContent = `${new Date().toLocaleTimeString()} ${text}\n\n${logEl.textContent}`.slice(0, 8000);
}

async function jsonFetch(url, options) {
  const response = await fetch(url, { ...options, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderStatus(data) {
  const services = data.services || [];
  const online = services.filter((service) => service.online).length;
  summaryEl.innerHTML = `
    <article><span>Status</span><strong>${data.ok ? 'Online' : 'Offline'}</strong></article>
    <article><span>Services</span><strong>${online}/${services.length}</strong></article>
    <article><span>Checked</span><strong>${new Date(data.checkedAt).toLocaleTimeString()}</strong></article>
  `;
  servicesEl.innerHTML = services.map((service) => `
    <article class="card ${service.online ? 'online' : 'offline'}">
      <div class="card-top">
        <div><p class="eyebrow">${escapeHtml(service.id)}</p><h2>${escapeHtml(service.name)}</h2></div>
        <span>${escapeHtml(service.state)}</span>
      </div>
      <p>${escapeHtml(service.role || '')}</p>
      <div class="meta">
        ${service.health?.status !== null ? `<b>HTTP ${service.health.status}</b>` : ''}
        ${service.health?.latencyMs !== null ? `<b>${service.health.latencyMs} ms</b>` : ''}
        ${service.pid ? `<b>pid ${service.pid}</b>` : ''}
        ${service.url ? `<a href="${escapeHtml(service.url)}" target="_blank" rel="noreferrer">Open</a>` : ''}
      </div>
    </article>
  `).join('');
}

function renderRepositories(data) {
  const repositories = data.repositories || [];
  repositoriesEl.innerHTML = repositories.length ? repositories.map((repo) => `
    <article class="repo ${repo.present && repo.git ? 'online' : 'offline'}">
      <div>
        <p class="eyebrow">${escapeHtml(repo.id)}</p>
        <h3>${escapeHtml(repo.state)}</h3>
      </div>
      <p>${escapeHtml(repo.path)}</p>
      <div class="meta">
        ${repo.branch ? `<b>${escapeHtml(repo.branch)}</b>` : ''}
        ${repo.commit ? `<b>${escapeHtml(repo.commit)}</b>` : ''}
        ${repo.ref ? `<b>ref ${escapeHtml(repo.ref)}</b>` : ''}
      </div>
    </article>
  `).join('') : '<p class="empty">No repositories configured.</p>';
}

async function loadStatus() {
  const [statusData, repoData] = await Promise.all([
    jsonFetch('/api/status'),
    jsonFetch('/api/repositories')
  ]);
  renderStatus(statusData);
  renderRepositories(repoData);
  return statusData;
}

async function action(name) {
  if (name === 'stop' && !window.confirm('Stop the configured media studio stack?')) return;
  log(`${name} requested`);
  const data = await jsonFetch('/api/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name })
  });
  log(data.result);
  renderStatus(data.status);
}

document.querySelector('#refresh').addEventListener('click', () => loadStatus().catch((error) => log(error.message)));
document.querySelector('#start').addEventListener('click', () => action('start').catch((error) => log(error.message)));
document.querySelector('#restart').addEventListener('click', () => action('restart').catch((error) => log(error.message)));
document.querySelector('#stop').addEventListener('click', () => action('stop').catch((error) => log(error.message)));
document.querySelector('#doctor').addEventListener('click', async () => {
  const data = await jsonFetch('/api/doctor');
  log(data);
});
document.querySelector('#bootstrap').addEventListener('click', async () => {
  if (!window.confirm('Clone or update the configured repositories?')) return;
  const data = await jsonFetch('/api/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update: true, install: false })
  });
  log(data);
  await loadStatus();
});

loadStatus().catch((error) => log(error.message));
setInterval(() => {
  if (!document.hidden) loadStatus().catch(() => {});
}, 7000);

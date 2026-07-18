let chart;

const apiKeyInput = document.getElementById('apiKey');
apiKeyInput.value = localStorage.getItem('rl-api-key') || '';
apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('rl-api-key', apiKeyInput.value);
  loadClients().then(loadUsage);
});

function showError(message) {
  const el = document.getElementById('error');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

async function apiFetch(url) {
  const res = await fetch(url, { headers: { 'x-api-key': apiKeyInput.value } });
  if (res.status === 401) {
    throw new Error('Unauthorized — enter a valid API key above.');
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

async function loadClients() {
  try {
    const { clients } = await apiFetch('/v1/clients');
    const select = document.getElementById('clientSelect');
    select.innerHTML = clients
      .map((c) => `<option value="${c.clientId}">${c.clientId} (${c.limit}/${c.windowSeconds}s)</option>`)
      .join('');
    showError('');
  } catch (err) {
    showError(err.message);
  }
}

async function loadUsage() {
  const clientId = document.getElementById('clientSelect').value;
  const days = document.getElementById('daysSelect').value;
  const granularity = document.getElementById('granularitySelect').value;
  const outcome = document.getElementById('outcomeSelect').value;
  if (!clientId) return;

  let data;
  try {
    data = await apiFetch(
      `/v1/clients/${encodeURIComponent(clientId)}/usage?days=${days}&granularity=${granularity}&outcome=${outcome}`,
    );
    showError('');
  } catch (err) {
    showError(err.message);
    return;
  }
  const points = data.points || [];

  const total = points.reduce((sum, p) => sum + p.requestCount, 0);
  const denied = points.reduce((sum, p) => sum + p.deniedCount, 0);
  // Weight each bucket's average by its request count -- an unweighted
  // mean of per-bucket averages would let a nearly idle day skew the
  // overall number.
  const avgLatency = total
    ? points.reduce((sum, p) => sum + p.avgLatencyMs * p.requestCount, 0) / total
    : 0;

  document.getElementById('statTotal').textContent = total;
  document.getElementById('statDenied').textContent = denied;
  document.getElementById('statLatency').textContent = `${avgLatency.toFixed(2)} ms`;

  const ctx = document.getElementById('trendChart');
  const labels = points.map((p) => p.bucket);
  const allowedSeries = points.map((p) => p.allowedCount);
  const deniedSeries = points.map((p) => p.deniedCount);

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Allowed', data: allowedSeries, borderColor: '#2a9c68', tension: 0.2 },
        { label: 'Denied', data: deniedSeries, borderColor: '#cc3a21', tension: 0.2 },
      ],
    },
    options: { responsive: true, scales: { y: { beginAtZero: true } } },
  });
}

document.getElementById('refresh').addEventListener('click', loadUsage);
document.getElementById('clientSelect').addEventListener('change', loadUsage);
document.getElementById('daysSelect').addEventListener('change', loadUsage);
document.getElementById('granularitySelect').addEventListener('change', loadUsage);
document.getElementById('outcomeSelect').addEventListener('change', loadUsage);

loadClients().then(loadUsage);

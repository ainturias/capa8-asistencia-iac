// Monitoreo real: lee Prometheus A TRAVÉS de Grafana (Prometheus no está expuesto a internet) y lo resume para la plataforma.
// RF-26 (salud por tenant), RF-28/RF-29 (alertas y eventos recientes con tenant afectado y hora de detección).
const STEP = 60;
const WINDOW_S = 6 * 3600;

function grafanaBase() {
  const raw = process.env.PLATFORM_GRAFANA_URL?.trim();
  return raw ? raw.replace(/\/$/, '') : null;
}

async function prom(base, path, params) {
  const url = `${base}/api/datasources/proxy/uid/prometheus/api/v1/${path}?${new URLSearchParams(params)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Prometheus respondió ${response.status}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error('Consulta rechazada por Prometheus');
  return body.data.result;
}

// Une muestras consecutivas de una alerta en episodios (inicio, fin, si sigue activa)
function episodes(series, nowS) {
  const out = [];
  for (const item of series) {
    const times = item.values.map(([t]) => Number(t)).sort((a, b) => a - b);
    let start = times[0];
    let prev = times[0];
    const push = (end) => out.push({
      alert: item.metric.alertname, tenant: item.metric.tenant ?? null, role: item.metric.role ?? null,
      severity: item.metric.severity ?? null, target: item.metric.instance ?? null,
      detectedAt: new Date(start * 1000).toISOString(),
      resolvedAt: end < nowS - 2 * STEP ? new Date((end + STEP) * 1000).toISOString() : null,
      active: end >= nowS - 2 * STEP,
    });
    for (const t of times.slice(1)) {
      if (t - prev > 2 * STEP) { push(prev); start = t; }
      prev = t;
    }
    push(prev);
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.detectedAt.localeCompare(a.detectedAt));
}

async function readMonitoring() {
  const base = grafanaBase();
  if (!base) return { configured: false };
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const [vms, probes, alerts] = await Promise.all([
      prom(base, 'query', { query: 'up{job="tenants"}' }),
      prom(base, 'query', { query: 'probe_success{job="probes"}' }),
      prom(base, 'query_range', { query: 'ALERTS{alertstate="firing"}', start: String(nowS - WINDOW_S), end: String(nowS), step: String(STEP) }),
    ]);
    const tenants = {};
    const slot = (name) => (tenants[name] ??= { tenant: name, vms: [], web: null, api: null });
    for (const item of vms) {
      slot(item.metric.tenant).vms.push({ role: item.metric.role, up: item.value[1] === '1' });
    }
    for (const item of probes) {
      const entry = slot(item.metric.tenant);
      const ok = item.value[1] === '1';
      if (item.metric.instance?.endsWith('/api/health')) entry.api = ok; else entry.web = ok;
    }
    return {
      configured: true, reachable: true, grafanaUrl: base, checkedAt: new Date().toISOString(),
      tenants: Object.values(tenants).sort((a, b) => a.tenant.localeCompare(b.tenant)),
      alerts: episodes(alerts, nowS),
    };
  } catch (error) {
    return { configured: true, reachable: false, grafanaUrl: base, message: 'No se pudo consultar el servidor de monitoreo.', detail: error.name };
  }
}

function mountMonitoring(platform, pool) {
  platform.get('/monitoring', async (_request, response) => {
    const data = await readMonitoring();
    const { rows } = await pool.query(`
      SELECT j.id, j.operation, j.status, j.created_at AS "at", t.slug, j.requested_by AS "by"
      FROM platform_jobs j JOIN platform_tenants t ON t.id = j.tenant_id
      WHERE j.operation NOT IN ('destruir-plan') ORDER BY j.created_at DESC LIMIT 12`);
    response.json({
      ...data,
      events: rows,
      // Agentes realmente instalados (rol Ansible base y rol monitoring)
      collectors: [
        { name: 'node_exporter', where: 'cada VM del tenant', purpose: 'CPU, memoria, disco y red del sistema (puerto 9100)' },
        { name: 'blackbox_exporter', where: 'servidor de monitoreo', purpose: 'disponibilidad y latencia HTTP de la web y de la API' },
        { name: 'Prometheus', where: 'servidor de monitoreo', purpose: 'recolecta y guarda las métricas; evalúa las alertas' },
        { name: 'Grafana', where: 'servidor de monitoreo', purpose: 'paneles y vista de alertas' },
      ],
    });
  });
}

module.exports = { mountMonitoring, episodes };
